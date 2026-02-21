const SERVER_URL = process.env.E2E_SERVER_URL ?? "http://localhost:3002";
const TEST_PASSWORD = process.env.E2E_TEST_PASSWORD ?? "Password123!";

export {};

interface EndpointRecord {
  id: string;
  slug: string;
}

interface MachineRecord {
  id: string;
  name: string;
}

interface WebhookResponse {
  eventId: string;
}

interface WebhookMessage {
  deliveryId: string;
  eventId: string;
  type: "webhook";
}

interface DeliveryResultMessage {
  eventId: string;
  status: "delivered" | "failed";
  type: "delivery-result";
}

interface MachineStatusMessage {
  machineId: string;
  status: "online" | "offline";
  type: "machine-status";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function ensureEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(
      `${message}. Expected: ${String(expected)}, actual: ${String(actual)}`
    );
  }
}

function cookieHeaderFromResponse(response: Response): string {
  const setCookies =
    (
      response.headers as unknown as {
        getSetCookie?: () => string[];
      }
    ).getSetCookie?.() ?? [];

  return setCookies.map((cookie) => cookie.split(";")[0]).join("; ");
}

async function createAuthenticatedSession(prefix: string): Promise<string> {
  const suffix = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const email = `${prefix}-${suffix}@example.com`;

  const signUpBody = JSON.stringify({
    email,
    name: `${prefix}-${suffix}`,
    password: TEST_PASSWORD,
  });

  let lastSignUpError: string | null = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const signUpResponse = await fetch(`${SERVER_URL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: signUpBody,
      redirect: "manual",
    });

    if (signUpResponse.ok) {
      const signUpCookies = cookieHeaderFromResponse(signUpResponse);
      if (signUpCookies) {
        return signUpCookies;
      }
      break;
    }

    const signUpErrorBody = await signUpResponse.text();
    lastSignUpError = `${signUpResponse.status} ${signUpErrorBody}`;
    await sleep(500);
  }

  const signInResponse = await fetch(`${SERVER_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email,
      password: TEST_PASSWORD,
    }),
    redirect: "manual",
  });

  if (!signInResponse.ok) {
    const signInErrorBody = await signInResponse.text();
    throw new Error(
      `Auth failed for ${email}. sign-up: ${lastSignUpError ?? "no response"}, sign-in: ${signInResponse.status} ${signInErrorBody}`
    );
  }

  const signInCookies = cookieHeaderFromResponse(signInResponse);
  ensure(signInCookies.length > 0, "Sign-in should return auth cookies");
  return signInCookies;
}

async function rpc<T>(
  path: string,
  input: unknown,
  cookies: string
): Promise<T> {
  const response = await fetch(`${SERVER_URL}/rpc/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookies,
    },
    body: JSON.stringify({ json: input }),
  });

  const payload = (await response.json()) as { json?: T };

  if (!response.ok) {
    throw new Error(
      `RPC ${path} failed with ${response.status}: ${JSON.stringify(payload)}`
    );
  }

  return payload.json ?? (payload as T);
}

function connectWebSocket(params: {
  cookies: string;
  machineId?: string;
  machineName?: string;
  role: "machine" | "viewer";
  slug: string;
}): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const wsUrl = new URL(
      `${SERVER_URL.replace("http", "ws")}/hooks/${params.slug}/ws`
    );
    wsUrl.searchParams.set("role", params.role);

    if (params.machineId) {
      wsUrl.searchParams.set("machineId", params.machineId);
    }
    if (params.machineName) {
      wsUrl.searchParams.set("machineName", params.machineName);
    }

    const ws = new WebSocket(wsUrl.toString(), {
      headers: {
        Cookie: params.cookies,
      },
    } as unknown as string);

    const timeout = setTimeout(() => {
      reject(new Error(`Timed out connecting ${params.role} websocket`));
    }, 10_000);

    ws.addEventListener("open", () => {
      clearTimeout(timeout);
      resolve(ws);
    });

    ws.addEventListener(
      "error",
      () => {
        clearTimeout(timeout);
        reject(new Error(`WebSocket error while connecting ${params.role}`));
      },
      { once: true }
    );
  });
}

function waitForWsMessage<T>(
  ws: WebSocket,
  matcher: (message: Record<string, unknown>) => boolean,
  timeoutMs = 15_000
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for websocket message"));
    }, timeoutMs);

    const onMessage = (event: MessageEvent) => {
      const rawMessage = typeof event.data === "string" ? event.data : "";
      if (!rawMessage) {
        return;
      }

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(rawMessage) as Record<string, unknown>;
      } catch {
        return;
      }

      if (!matcher(parsed)) {
        return;
      }

      cleanup();
      resolve(parsed as T);
    };

    const onError = () => {
      cleanup();
      reject(new Error("WebSocket closed before expected message"));
    };

    const cleanup = () => {
      clearTimeout(timeout);
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("close", onError);
      ws.removeEventListener("error", onError);
    };

    ws.addEventListener("message", onMessage);
    ws.addEventListener("close", onError, { once: true });
    ws.addEventListener("error", onError, { once: true });
  });
}

async function sendWebhook(
  slug: string,
  payload: unknown
): Promise<WebhookResponse> {
  const response = await fetch(`${SERVER_URL}/hooks/${slug}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  ensureEqual(response.status, 202, "Webhook endpoint should return 202");
  return (await response.json()) as WebhookResponse;
}

async function waitForDeliveryPersisted(
  eventId: string,
  cookies: string
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const deliveries = await rpc<Array<{ status: string }>>(
      "deliveries/listByEvent",
      {
        eventId,
      },
      cookies
    );

    if (deliveries.some((delivery) => delivery.status === "delivered")) {
      return;
    }

    await sleep(250);
  }

  throw new Error("Delivery was not persisted as delivered");
}

async function runMachineFlowTest(): Promise<void> {
  const cookies = await createAuthenticatedSession("machine-e2e");

  const endpoint = await rpc<EndpointRecord>(
    "endpoints/create",
    {
      name: "Machine E2E Endpoint",
      slug: `machine-e2e-${Date.now()}`,
    },
    cookies
  );

  const machine = await rpc<MachineRecord>(
    "machines/register",
    {
      endpointId: endpoint.id,
      forwardUrl: "http://localhost:9999/machine-e2e",
      name: `machine-e2e-${Date.now()}`,
    },
    cookies
  );

  const machineWs = await connectWebSocket({
    cookies,
    machineId: machine.id,
    machineName: machine.name,
    role: "machine",
    slug: endpoint.slug,
  });

  const webhookMessagePromise = waitForWsMessage<WebhookMessage>(
    machineWs,
    (message) => message.type === "webhook"
  );

  const webhookResponse = await sendWebhook(endpoint.slug, {
    event: "machine.e2e",
    timestamp: Date.now(),
  });

  const webhookMessage = await webhookMessagePromise;

  ensureEqual(
    webhookMessage.eventId,
    webhookResponse.eventId,
    "Machine should receive the event it triggered"
  );
  ensure(
    webhookMessage.deliveryId.length > 0,
    "Machine should receive a delivery ID"
  );

  machineWs.send(
    JSON.stringify({
      type: "delivery-report",
      eventId: webhookMessage.eventId,
      deliveryId: webhookMessage.deliveryId,
      status: "delivered",
      responseStatus: 200,
      responseBody: '{"ok":true}',
      error: null,
      duration: 35,
    })
  );

  await rpc(
    "machines/reportDelivery",
    {
      deliveryId: webhookMessage.deliveryId,
      status: "delivered",
      responseStatus: 200,
      responseBody: '{"ok":true}',
      error: null,
      duration: 35,
    },
    cookies
  );

  await waitForDeliveryPersisted(webhookMessage.eventId, cookies);

  machineWs.close();
  await rpc("machines/delete", { id: machine.id }, cookies);
  await rpc("endpoints/delete", { id: endpoint.id }, cookies);
}

async function runViewerFlowTest(): Promise<void> {
  const cookies = await createAuthenticatedSession("viewer-e2e");

  const endpoint = await rpc<EndpointRecord>(
    "endpoints/create",
    {
      name: "Viewer E2E Endpoint",
      slug: `viewer-e2e-${Date.now()}`,
    },
    cookies
  );

  const machine = await rpc<MachineRecord>(
    "machines/register",
    {
      endpointId: endpoint.id,
      forwardUrl: "http://localhost:9999/viewer-e2e",
      name: `viewer-machine-${Date.now()}`,
    },
    cookies
  );

  const viewerWs = await connectWebSocket({
    cookies,
    role: "viewer",
    slug: endpoint.slug,
  });

  const machineWs = await connectWebSocket({
    cookies,
    machineId: machine.id,
    machineName: machine.name,
    role: "machine",
    slug: endpoint.slug,
  });

  const onlineStatus = await waitForWsMessage<MachineStatusMessage>(
    viewerWs,
    (message) =>
      message.type === "machine-status" &&
      message.status === "online" &&
      message.machineId === machine.id
  );

  ensureEqual(
    onlineStatus.machineId,
    machine.id,
    "Viewer should receive machine online state"
  );

  const machineWebhookPromise = waitForWsMessage<WebhookMessage>(
    machineWs,
    (message) => message.type === "webhook"
  );

  const webhookResponse = await sendWebhook(endpoint.slug, {
    event: "viewer.e2e",
    timestamp: Date.now(),
  });

  const machineWebhook = await machineWebhookPromise;
  ensureEqual(
    machineWebhook.eventId,
    webhookResponse.eventId,
    "Machine should receive viewer test webhook"
  );

  machineWs.send(
    JSON.stringify({
      type: "delivery-report",
      eventId: machineWebhook.eventId,
      deliveryId: machineWebhook.deliveryId,
      status: "delivered",
      responseStatus: 200,
      responseBody: '{"viewer":true}',
      error: null,
      duration: 42,
    })
  );

  const deliveryResult = await waitForWsMessage<DeliveryResultMessage>(
    viewerWs,
    (message) =>
      message.type === "delivery-result" &&
      message.status === "delivered" &&
      message.eventId === webhookResponse.eventId
  );

  ensureEqual(
    deliveryResult.eventId,
    webhookResponse.eventId,
    "Viewer should receive delivery result for webhook"
  );

  machineWs.close();

  const offlineStatus = await waitForWsMessage<MachineStatusMessage>(
    viewerWs,
    (message) =>
      message.type === "machine-status" &&
      message.status === "offline" &&
      message.machineId === machine.id
  );

  ensureEqual(
    offlineStatus.machineId,
    machine.id,
    "Viewer should receive machine offline state"
  );

  viewerWs.close();
  await rpc("machines/delete", { id: machine.id }, cookies);
  await rpc("endpoints/delete", { id: endpoint.id }, cookies);
}

async function runE2eIntegrationTests(): Promise<void> {
  await runMachineFlowTest();
  await runViewerFlowTest();
}

await runE2eIntegrationTests();
