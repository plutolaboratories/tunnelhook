import { auth } from "@tunnelhook/auth";
import { db } from "@tunnelhook/db";
import { delivery, endpoint, event, machine } from "@tunnelhook/db/schema";
import { env } from "@tunnelhook/env/server";
import { and, eq } from "drizzle-orm";
import type { Context } from "hono";

import type { EndpointDO } from "./endpoint-do";

const HEADERS_TO_STRIP = new Set([
  // Sensitive headers that could leak credentials
  "authorization",
  "cookie",
  "set-cookie",
  // Hop-by-hop headers
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "proxy-authorization",
  "proxy-connection",
  // Cloudflare-specific internal headers
  "cf-connecting-ip",
  "cf-ray",
  "cf-ipcountry",
  "cf-visitor",
  "cf-worker",
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-real-ip",
]);

interface BroadcastParams {
  body: string | null;
  contentType: string | null;
  createdAt: string;
  endpointId: string;
  eventId: string;
  headers: string;
  method: string;
  query: string | null;
  sourceIp: string | null;
}

/**
 * Helper to get the Durable Object stub for an endpoint.
 */
function getEndpointDO(endpointId: string): DurableObjectStub<EndpointDO> {
  const doId = env.ENDPOINT_DO.idFromName(endpointId);
  return env.ENDPOINT_DO.get(doId) as DurableObjectStub<EndpointDO>;
}

/**
 * Create delivery records and broadcast an event to connected machines via DO.
 */
async function broadcastToMachines(params: BroadcastParams): Promise<void> {
  const machines = await db.query.machine.findMany({
    where: eq(machine.endpointId, params.endpointId),
  });

  if (machines.length === 0) {
    return;
  }

  // Create delivery records for each machine (status: pending)
  const deliveryRecords = machines.map((m) => ({
    id: crypto.randomUUID(),
    machineId: m.id,
  }));

  // Batch insert delivery records
  await db.insert(delivery).values(
    deliveryRecords.map((d) => ({
      id: d.id,
      eventId: params.eventId,
      machineId: d.machineId,
      status: "pending" as const,
    }))
  );

  // Build the deliveries map: machineId -> deliveryId
  const deliveriesMap: Record<string, string> = {};
  for (const d of deliveryRecords) {
    deliveriesMap[d.machineId] = d.id;
  }

  // Call the DO to fan out the event to connected machines
  const stub = getEndpointDO(params.endpointId);
  const doResponse = await stub.fetch(
    new Request("http://do/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        eventId: params.eventId,
        method: params.method,
        headers: params.headers,
        body: params.body,
        query: params.query,
        sourceIp: params.sourceIp,
        contentType: params.contentType,
        createdAt: params.createdAt,
        deliveries: deliveriesMap,
      }),
    })
  );

  if (!doResponse.ok) {
    console.error(
      `DO broadcast failed: ${doResponse.status} ${await doResponse.text()}`
    );
  }
}

/**
 * Deferred processing: broadcast event to machines and optionally forward to a static URL.
 * Runs inside `waitUntil` so it does not block the webhook response.
 */
async function processBroadcastAndForward(
  ep: { id: string; forwardUrl: string | null },
  eventData: {
    id: string;
    method: string;
    headers: Record<string, string>;
    body: string | null;
    query: string | null;
    sourceIp: string | null;
    contentType: string | null;
    createdAt: string;
  }
): Promise<void> {
  try {
    await broadcastToMachines({
      endpointId: ep.id,
      eventId: eventData.id,
      method: eventData.method,
      headers: JSON.stringify(eventData.headers),
      body: eventData.body,
      query: eventData.query,
      sourceIp: eventData.sourceIp,
      contentType: eventData.contentType,
      createdAt: eventData.createdAt,
    });
  } catch (err) {
    console.error("Failed to broadcast to DO:", err);
  }

  if (ep.forwardUrl) {
    const startTime = Date.now();
    try {
      const forwardHeaders: Record<string, string> = {};
      for (const [key, value] of Object.entries(eventData.headers)) {
        if (!HEADERS_TO_STRIP.has(key.toLowerCase())) {
          forwardHeaders[key] = value;
        }
      }

      const forwardResponse = await fetch(ep.forwardUrl, {
        method: eventData.method,
        headers: {
          ...forwardHeaders,
          host: new URL(ep.forwardUrl).host,
          "x-tunnelhook-event-id": eventData.id,
          "x-tunnelhook-endpoint-id": ep.id,
        },
        body:
          eventData.method !== "GET" && eventData.method !== "HEAD"
            ? eventData.body
            : undefined,
      });

      const duration = Date.now() - startTime;
      await db
        .update(event)
        .set({
          forwardStatus: forwardResponse.status,
          forwardDuration: duration,
        })
        .where(eq(event.id, eventData.id));
    } catch (err) {
      const duration = Date.now() - startTime;
      await db
        .update(event)
        .set({
          forwardError: err instanceof Error ? err.message : "Unknown error",
          forwardDuration: duration,
        })
        .where(eq(event.id, eventData.id));
    }
  }
}

/**
 * Handle incoming webhook requests at POST/GET/PUT/PATCH/DELETE /hooks/:slug
 * Captures the full request, stores it, broadcasts to connected machines via DO,
 * and optionally forwards via static forwardUrl.
 */
export async function handleWebhook(c: Context): Promise<Response> {
  const slug = c.req.param("slug");

  const ep = await db.query.endpoint.findFirst({
    where: eq(endpoint.slug, slug),
  });

  if (!ep) {
    return c.json({ error: "Endpoint not found" }, 404);
  }

  if (!ep.enabled) {
    return c.json({ error: "Endpoint is disabled" }, 403);
  }

  // Capture request data
  const method = c.req.method;
  const headers = Object.fromEntries(c.req.raw.headers.entries());
  const contentType = c.req.header("content-type") ?? null;
  const url = new URL(c.req.url);
  const query = url.search || null;
  const sourceIp =
    c.req.header("x-forwarded-for") ?? c.req.header("cf-connecting-ip") ?? null;

  let body: string | null = null;
  try {
    body = await c.req.text();
  } catch {
    // No body
  }

  const id = crypto.randomUUID();
  const now = new Date();

  // Store the event
  await db.insert(event).values({
    id,
    endpointId: ep.id,
    method,
    headers: JSON.stringify(headers),
    body,
    query,
    sourceIp,
    contentType,
  });

  // Defer broadcast and forward operations to run after response is sent
  c.executionCtx.waitUntil(
    processBroadcastAndForward(ep, {
      id,
      method,
      headers,
      body,
      query,
      sourceIp,
      contentType,
      createdAt: now.toISOString(),
    })
  );

  // Return immediately — processing continues in the background
  return c.json(
    {
      success: true,
      eventId: id,
      endpointId: ep.id,
    },
    202
  );
}

/**
 * Handle WebSocket upgrade requests for machines and viewers.
 * GET /hooks/:slug/ws?role=machine|viewer&machineId=X&machineName=Y
 *
 * Authentication is done via session cookies (same as the rest of the app).
 * For machine connections, a machine record must already exist in D1.
 */
export async function handleWebSocketUpgrade(c: Context): Promise<Response> {
  const slug = c.req.param("slug");

  // Look up the endpoint
  const ep = await db.query.endpoint.findFirst({
    where: eq(endpoint.slug, slug),
  });

  if (!ep) {
    return c.json({ error: "Endpoint not found" }, 404);
  }

  // Authenticate the user via Better-Auth session
  const session = await auth.api.getSession({
    headers: c.req.raw.headers,
  });

  if (!session?.user) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  // Verify the user owns this endpoint
  if (ep.userId !== session.user.id) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const role = c.req.query("role") as "machine" | "viewer" | undefined;
  if (role !== "machine" && role !== "viewer") {
    return c.json({ error: "Missing or invalid role query parameter" }, 400);
  }

  let machineId: string | undefined;
  let machineName: string | undefined;

  if (role === "machine") {
    machineId = c.req.query("machineId");
    machineName = c.req.query("machineName");

    if (!machineId) {
      return c.json({ error: "machineId is required for machine role" }, 400);
    }

    // Verify this machine exists and belongs to this endpoint + user
    const m = await db.query.machine.findFirst({
      where: and(
        eq(machine.id, machineId),
        eq(machine.endpointId, ep.id),
        eq(machine.userId, session.user.id)
      ),
    });

    if (!m) {
      return c.json({ error: "Machine not found" }, 404);
    }

    machineName = machineName ?? m.name;

    // Update machine status to online
    await db
      .update(machine)
      .set({ status: "online", lastSeenAt: new Date() })
      .where(eq(machine.id, machineId));
  }

  // Forward the upgrade request to the Durable Object
  const stub = getEndpointDO(ep.id);

  const doUrl = new URL("http://do/websocket");
  doUrl.searchParams.set("role", role);
  doUrl.searchParams.set("userId", session.user.id);
  if (machineId) {
    doUrl.searchParams.set("machineId", machineId);
  }
  if (machineName) {
    doUrl.searchParams.set("machineName", machineName);
  }

  // Pass through the Upgrade header so the DO knows to upgrade
  return stub.fetch(doUrl.toString(), {
    headers: {
      Upgrade: "websocket",
    },
  });
}
