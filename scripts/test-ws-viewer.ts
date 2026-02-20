/**
 * End-to-end test for the viewer WebSocket flow.
 *
 * Tests:
 * 1. Sign in
 * 2. Connect as viewer via WebSocket
 * 3. Connect as machine via WebSocket (viewer should see machine-status: online)
 * 4. Send a webhook (viewer should see the webhook event forwarded + delivery result)
 * 5. Disconnect machine (viewer should see machine-status: offline)
 *
 * Usage:
 *   bun run scripts/test-ws-viewer.ts [email] [password]
 *
 * Server must be running on localhost:3002.
 */

const SERVER_URL = "http://localhost:3002";

const email = process.argv[2] ?? "wstest@test.com";
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

function rpcFetch(path: string, input: unknown): Promise<Response> {
  return fetch(`${SERVER_URL}/rpc/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: authCookies },
    body: JSON.stringify({ json: input }),
  });
}

async function rpc(path: string, input: unknown): Promise<unknown> {
  const res = await rpcFetch(path, input);
  if (!res.ok) {
    const text = await res.text();
    fail(`RPC ${path} failed: ${res.status} ${text}`);
  }
  const data = (await res.json()) as { json?: unknown };
  return data.json ?? data;
}

function connectWS(
  slug: string,
  role: "machine" | "viewer",
  machineId?: string,
  machineName?: string
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const wsUrl = new URL(
      `${SERVER_URL.replace("http", "ws")}/hooks/${slug}/ws`
    );
    wsUrl.searchParams.set("role", role);
    if (machineId) {
      wsUrl.searchParams.set("machineId", machineId);
    }
    if (machineName) {
      wsUrl.searchParams.set("machineName", machineName);
    }

    const ws = new WebSocket(wsUrl.toString(), {
      headers: { Cookie: authCookies },
    } as unknown as string);

    const timeout = setTimeout(() => {
      reject(new Error(`WebSocket ${role} connection timed out`));
    }, 10_000);

    ws.addEventListener("open", () => {
      clearTimeout(timeout);
      log("WS", `Connected as ${role}`);
      resolve(ws);
    });

    ws.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error(`WebSocket ${role} error`));
    });
  });
}

interface WsMessage {
  type: string;
  [key: string]: unknown;
}

function collectMessages(ws: WebSocket): WsMessage[] {
  const messages: WsMessage[] = [];
  ws.addEventListener("message", (event) => {
    const data = typeof event.data === "string" ? event.data : "";
    try {
      const parsed = JSON.parse(data) as WsMessage;
      messages.push(parsed);
      log(
        "VIEWER",
        `Received: ${parsed.type} ${JSON.stringify(parsed).slice(0, 100)}`
      );
    } catch {
      log("VIEWER", `Non-JSON: ${data}`);
    }
  });
  return messages;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=".repeat(60));
  console.log("  TunnelHook — Viewer WebSocket E2E Test");
  console.log("=".repeat(60));
  console.log();

  // Step 1: Sign in
  log("AUTH", `Signing in as ${email}...`);
  const signInRes = await fetch(`${SERVER_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
    redirect: "manual",
  });

  if (!signInRes.ok) {
    fail(`Sign-in failed: ${signInRes.status} ${await signInRes.text()}`);
  }

  const cookies =
    (
      signInRes.headers as unknown as { getSetCookie?: () => string[] }
    ).getSetCookie?.() ?? [];
  authCookies =
    cookies.length > 0
      ? cookies.map((c: string) => c.split(";")[0]).join("; ")
      : "";

  if (!authCookies) {
    fail("No cookies");
  }
  log("AUTH", "Signed in");

  // Step 2: Get or create endpoint
  const list = (await rpc("endpoints/list", {})) as Array<{
    id: string;
    slug: string;
  }>;
  const ep = list[0];
  if (!ep) {
    fail("No endpoints found — run test-ws-machine.ts first");
  }
  log("ENDPOINT", `Using endpoint: ${ep.slug}`);

  // Step 3: Register a fresh machine
  const machineName = `viewer-test-${Date.now()}`;
  const machine = (await rpc("machines/register", {
    endpointId: ep.id,
    name: machineName,
    forwardUrl: "http://localhost:9999/viewer-test",
  })) as { id: string; name: string; forwardUrl: string };
  log("MACHINE", `Registered: ${machine.name} (${machine.id})`);

  // Step 4: Connect as viewer
  const viewerWs = await connectWS(ep.slug, "viewer");
  const viewerMessages = collectMessages(viewerWs);
  await new Promise((r) => setTimeout(r, 300));

  // Step 5: Connect as machine (viewer should see machine-status: online)
  const machineWs = await connectWS(
    ep.slug,
    "machine",
    machine.id,
    machine.name
  );
  await new Promise((r) => setTimeout(r, 500));

  const onlineMsg = viewerMessages.find(
    (m) => m.type === "machine-status" && m.status === "online"
  );
  if (!onlineMsg) {
    fail("Viewer did not receive machine-status: online");
  }
  log("CHECK", "Viewer received machine-status: online");

  // Step 6: Send webhook (viewer should see delivery-result after machine reports)
  // Set up machine message handler first
  const machineReported = new Promise<void>((resolve) => {
    machineWs.addEventListener("message", (event) => {
      const data = typeof event.data === "string" ? event.data : "";
      let parsed: WsMessage;
      try {
        parsed = JSON.parse(data);
      } catch {
        return;
      }

      if (parsed.type !== "webhook") {
        return;
      }
      log(
        "MACHINE",
        `Received webhook, reporting delivery for ${parsed.deliveryId}`
      );

      // Report success
      machineWs.send(
        JSON.stringify({
          type: "delivery-report",
          eventId: parsed.eventId,
          deliveryId: parsed.deliveryId,
          status: "delivered",
          responseStatus: 200,
          responseBody: '{"viewer_test": true}',
          error: null,
          duration: 42,
        })
      );
      resolve();
    });
  });

  log("WEBHOOK", "Sending webhook...");
  const hookRes = await fetch(`${SERVER_URL}/hooks/${ep.slug}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ viewer: "test" }),
  });
  const hookData = (await hookRes.json()) as { eventId: string };
  log("WEBHOOK", `Event: ${hookData.eventId}`);

  // Wait for machine to receive and report
  await machineReported;
  log("CHECK", "Machine received and reported delivery");

  // Give viewer time to receive delivery-result
  await new Promise((r) => setTimeout(r, 500));

  const deliveryResult = viewerMessages.find(
    (m) => m.type === "delivery-result"
  );
  if (!deliveryResult) {
    fail("Viewer did not receive delivery-result");
  }
  log(
    "CHECK",
    `Viewer received delivery-result: status=${deliveryResult.status}`
  );

  // Step 7: Disconnect machine (viewer should see machine-status: offline)
  machineWs.close();
  await new Promise((r) => setTimeout(r, 500));

  const offlineMsg = viewerMessages.find(
    (m) => m.type === "machine-status" && m.status === "offline"
  );
  if (!offlineMsg) {
    fail("Viewer did not receive machine-status: offline");
  }
  log("CHECK", "Viewer received machine-status: offline");

  // Cleanup
  viewerWs.close();
  try {
    await rpc("machines/delete", { id: machine.id });
    log("CLEANUP", "Deleted test machine");
  } catch {
    log("CLEANUP", "Warning: failed to delete test machine");
  }

  pass("Viewer WebSocket flow verified end-to-end!");
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
