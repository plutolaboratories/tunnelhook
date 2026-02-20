/**
 * End-to-end test script for the WebSocket machine flow.
 *
 * Tests:
 * 1. Sign in
 * 2. Create an endpoint (or use existing)
 * 3. Register a machine
 * 4. Connect as machine via WebSocket
 * 5. Send a webhook
 * 6. Verify machine receives the webhook event via WebSocket
 * 7. Forward locally (simulated) and report delivery result
 * 8. Verify delivery is persisted in D1
 *
 * Usage:
 *   bun run scripts/test-ws-machine.ts [email] [password]
 *
 * Defaults to test@test.com / password123 if no args provided.
 * Server must be running on localhost:3002.
 */

const SERVER_URL = "http://localhost:3002";

const email = process.argv[2] ?? "test@test.com";
const password = process.argv[3] ?? "password123";

let authCookies = "";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(label: string, ...args: unknown[]): void {
  const time = new Date().toISOString().slice(11, 23);
  console.log(`[${time}] [${label}]`, ...args);
}

function fail(message: string): never {
  console.error(`\nFAIL: ${message}\n`);
  process.exit(1);
}

function pass(message: string): void {
  console.log(`\nPASS: ${message}\n`);
}

function fetchAuth(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: {
      ...((init?.headers as Record<string, string>) ?? {}),
      ...(authCookies ? { Cookie: authCookies } : {}),
    },
  });
}

async function rpc(path: string, input: unknown): Promise<unknown> {
  const res = await fetchAuth(`${SERVER_URL}/rpc/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ json: input }),
  });
  if (!res.ok) {
    const text = await res.text();
    fail(`RPC ${path} failed: ${res.status} ${text}`);
  }
  const data = (await res.json()) as { json?: unknown };
  return data.json ?? data;
}

// ---------------------------------------------------------------------------
// Step 1: Sign in
// ---------------------------------------------------------------------------

async function signIn(): Promise<void> {
  log("AUTH", `Signing in as ${email}...`);
  const res = await fetch(`${SERVER_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
    redirect: "manual",
  });

  if (!res.ok) {
    fail(`Sign-in failed: ${res.status} ${await res.text()}`);
  }

  const cookies =
    (
      res.headers as unknown as { getSetCookie?: () => string[] }
    ).getSetCookie?.() ?? [];
  if (cookies.length > 0) {
    authCookies = cookies.map((c: string) => c.split(";")[0]).join("; ");
  }

  if (!authCookies) {
    fail("No cookies returned from sign-in");
  }

  log("AUTH", "Signed in successfully");
}

// ---------------------------------------------------------------------------
// Step 2: Create endpoint
// ---------------------------------------------------------------------------

async function getOrCreateEndpoint(): Promise<{
  id: string;
  slug: string;
  name: string;
}> {
  log("ENDPOINT", "Listing endpoints...");
  const list = (await rpc("endpoints/list", {})) as Array<{
    id: string;
    slug: string;
    name: string;
  }>;

  // Use existing or create new
  const ep = list[0];
  if (ep) {
    log("ENDPOINT", `Using existing endpoint: ${ep.name} (${ep.slug})`);
    return ep;
  }

  log("ENDPOINT", "Creating new endpoint...");
  const created = (await rpc("endpoints/create", {
    name: "ws-test-endpoint",
    slug: `ws-test-${Date.now()}`,
  })) as { id: string; slug: string; name: string };
  log("ENDPOINT", `Created: ${created.name} (${created.slug})`);
  return created;
}

// ---------------------------------------------------------------------------
// Step 3: Register machine
// ---------------------------------------------------------------------------

async function registerMachine(
  endpointId: string
): Promise<{ id: string; name: string; forwardUrl: string }> {
  const machineName = `test-machine-${Date.now()}`;
  const forwardUrl = "http://localhost:9999/test-webhook";

  log("MACHINE", `Registering machine: ${machineName}`);
  const m = (await rpc("machines/register", {
    endpointId,
    name: machineName,
    forwardUrl,
  })) as { id: string; name: string; forwardUrl: string };

  log("MACHINE", `Registered: ${m.name} (${m.id})`);
  return m;
}

// ---------------------------------------------------------------------------
// Step 4: Connect as machine via WebSocket
// ---------------------------------------------------------------------------

function connectMachineWS(
  slug: string,
  machineId: string,
  machineName: string
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const wsUrl = new URL(
      `${SERVER_URL.replace("http", "ws")}/hooks/${slug}/ws`
    );
    wsUrl.searchParams.set("role", "machine");
    wsUrl.searchParams.set("machineId", machineId);
    wsUrl.searchParams.set("machineName", machineName);

    log("WS", `Connecting to ${wsUrl.toString()}`);

    // Bun's WebSocket constructor supports a headers option as the second arg
    const ws = new WebSocket(wsUrl.toString(), {
      headers: {
        Cookie: authCookies,
      },
    } as unknown as string);

    const timeout = setTimeout(() => {
      reject(new Error("WebSocket connection timed out"));
    }, 10_000);

    ws.addEventListener("open", () => {
      clearTimeout(timeout);
      log("WS", "Connected as machine");
      resolve(ws);
    });

    ws.addEventListener("error", (event) => {
      clearTimeout(timeout);
      reject(new Error(`WebSocket error: ${event}`));
    });
  });
}

// ---------------------------------------------------------------------------
// Step 5: Send webhook
// ---------------------------------------------------------------------------

async function sendWebhook(slug: string): Promise<string> {
  const payload = {
    event: "test.webhook",
    data: { message: "Hello from test script", timestamp: Date.now() },
  };

  log("WEBHOOK", `Sending POST to /hooks/${slug}`);
  const res = await fetch(`${SERVER_URL}/hooks/${slug}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    fail(`Webhook failed: ${res.status} ${await res.text()}`);
  }

  const result = (await res.json()) as { eventId: string };
  log("WEBHOOK", `Event created: ${result.eventId}`);
  return result.eventId;
}

// ---------------------------------------------------------------------------
// Step 6 & 7: Wait for webhook via WS and report delivery
// ---------------------------------------------------------------------------

interface ParsedWsMessage {
  body?: string | null;
  deliveryId?: string;
  eventId?: string;
  method?: string;
  type: string;
  [key: string]: unknown;
}

async function handleWebhookMessage(
  ws: WebSocket,
  parsed: ParsedWsMessage,
  machineForwardUrl: string
): Promise<void> {
  log("WS", `Received webhook event: ${parsed.eventId}`);
  log("WS", `  Method: ${parsed.method}`);
  log("WS", `  DeliveryId: ${parsed.deliveryId}`);
  log("WS", `  Body: ${parsed.body?.slice(0, 100) ?? "(null)"}`);

  // Simulate local forwarding
  log("FORWARD", `Simulating forward to ${machineForwardUrl}`);
  const startTime = Date.now();
  await new Promise((r) => setTimeout(r, 50));
  const duration = Date.now() - startTime;

  // Report delivery result back via WebSocket
  const report = {
    type: "delivery-report",
    eventId: parsed.eventId,
    deliveryId: parsed.deliveryId,
    status: "delivered",
    responseStatus: 200,
    responseBody: '{"ok": true}',
    error: null,
    duration,
  };

  log("REPORT", `Sending delivery report for ${parsed.deliveryId}`);
  ws.send(JSON.stringify(report));

  // Also persist via oRPC (the TUI does both)
  try {
    await rpc("machines/reportDelivery", {
      deliveryId: parsed.deliveryId,
      status: "delivered",
      responseStatus: 200,
      responseBody: '{"ok": true}',
      error: null,
      duration,
    });
    log("REPORT", "Delivery result persisted via oRPC");
  } catch (err) {
    log(
      "REPORT",
      `Warning: failed to persist via oRPC: ${err instanceof Error ? err.message : err}`
    );
  }
}

function waitForWebhookAndReport(
  ws: WebSocket,
  machineForwardUrl: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for webhook event via WebSocket"));
    }, 15_000);

    ws.addEventListener("message", (event) => {
      const data = typeof event.data === "string" ? event.data : "";
      let parsed: ParsedWsMessage;
      try {
        parsed = JSON.parse(data);
      } catch {
        log("WS", `Non-JSON message: ${data}`);
        return;
      }

      log("WS", `Received message type: ${parsed.type}`);

      if (parsed.type !== "webhook") {
        return;
      }

      clearTimeout(timeout);

      const eventId = parsed.eventId ?? "";

      handleWebhookMessage(ws, parsed, machineForwardUrl)
        .then(() => resolve(eventId))
        .catch(reject);
    });
  });
}

// ---------------------------------------------------------------------------
// Step 8: Verify delivery in DB
// ---------------------------------------------------------------------------

async function verifyDelivery(eventId: string): Promise<void> {
  // Brief delay for DB writes to settle
  await new Promise((r) => setTimeout(r, 500));

  log("VERIFY", `Checking deliveries for event ${eventId}`);
  const deliveries = (await rpc("deliveries/listByEvent", {
    eventId,
  })) as Array<{
    id: string;
    status: string;
    responseStatus: number | null;
    duration: number | null;
    machineName: string | null;
  }>;

  if (deliveries.length === 0) {
    fail("No deliveries found for event");
  }

  log("VERIFY", `Found ${deliveries.length} delivery(ies):`);
  for (const d of deliveries) {
    log(
      "VERIFY",
      `  - ${d.id}: status=${d.status}, responseStatus=${d.responseStatus}, duration=${d.duration}ms, machine=${d.machineName}`
    );
  }

  const delivered = deliveries.find((d) => d.status === "delivered");
  if (!delivered) {
    fail("No delivery with status 'delivered' found");
  }

  pass("Full WebSocket machine flow verified end-to-end!");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=".repeat(60));
  console.log("  TunnelHook — WebSocket Machine E2E Test");
  console.log("=".repeat(60));
  console.log();

  try {
    await signIn();
    const endpoint = await getOrCreateEndpoint();
    const machine = await registerMachine(endpoint.id);

    const ws = await connectMachineWS(endpoint.slug, machine.id, machine.name);

    // Give WS time to fully register in DO
    await new Promise((r) => setTimeout(r, 500));

    // Set up the message listener BEFORE sending the webhook,
    // because the DO broadcast happens synchronously within the webhook request
    // and the WS message may arrive before sendWebhook() returns.
    const receivedPromise = waitForWebhookAndReport(ws, machine.forwardUrl);
    const eventId = await sendWebhook(endpoint.slug);
    const receivedEventId = await receivedPromise;

    if (receivedEventId !== eventId) {
      fail(`Event ID mismatch: sent ${eventId}, received ${receivedEventId}`);
    }

    // Verify the delivery was persisted
    await verifyDelivery(eventId);

    // Clean up
    ws.close();

    // Cleanup: delete the test machine
    try {
      await rpc("machines/delete", { id: machine.id });
      log("CLEANUP", `Deleted test machine ${machine.id}`);
    } catch {
      log("CLEANUP", "Warning: failed to delete test machine");
    }
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

main();
