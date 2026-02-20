import { auth } from "@tunnelhook/auth";
import { db } from "@tunnelhook/db";
import { delivery, endpoint, event, machine } from "@tunnelhook/db/schema";
import { env } from "@tunnelhook/env/server";
import { and, eq } from "drizzle-orm";
import type { Context } from "hono";

import type { EndpointDO } from "./endpoint-do";

interface EventPayload {
  body: string | null;
  contentType: string | null;
  createdAt: Date;
  endpointId: string;
  headers: string;
  id: string;
  method: string;
  query: string | null;
  sourceIp: string | null;
}

/**
 * In-memory subscriber map for SSE connections.
 * Key: endpoint ID, Value: Set of SSE writer functions.
 */
const subscribers = new Map<string, Set<(event: EventPayload) => void>>();

/** Notify all SSE subscribers for a given endpoint */
function notifySubscribers(endpointId: string, payload: EventPayload): void {
  const subs = subscribers.get(endpointId);
  if (!subs) {
    return;
  }
  for (const callback of subs) {
    try {
      callback(payload);
    } catch {
      // Subscriber errored, will be cleaned up on disconnect
    }
  }
}

/** Subscribe to events for an endpoint. Returns an unsubscribe function. */
export function subscribe(
  endpointId: string,
  callback: (event: EventPayload) => void
): () => void {
  if (!subscribers.has(endpointId)) {
    subscribers.set(endpointId, new Set());
  }
  const subs = subscribers.get(endpointId);
  subs?.add(callback);

  return () => {
    subs?.delete(callback);
    if (subs?.size === 0) {
      subscribers.delete(endpointId);
    }
  };
}

/**
 * Helper to get the Durable Object stub for an endpoint.
 */
function getEndpointDO(endpointId: string): DurableObjectStub<EndpointDO> {
  const doId = env.ENDPOINT_DO.idFromName(endpointId);
  return env.ENDPOINT_DO.get(doId) as DurableObjectStub<EndpointDO>;
}

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
 * Handle incoming webhook requests at POST/GET/PUT/PATCH/DELETE /hooks/:slug
 * Captures the full request, stores it, broadcasts to connected machines via DO,
 * optionally forwards via static forwardUrl, and notifies SSE subscribers.
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

  const payload: EventPayload = {
    id,
    endpointId: ep.id,
    method,
    headers: JSON.stringify(headers),
    body,
    query,
    sourceIp,
    contentType,
    createdAt: now,
  };

  // Notify SSE subscribers (legacy)
  notifySubscribers(ep.id, payload);

  // Broadcast to connected machines via Durable Object
  try {
    await broadcastToMachines({
      endpointId: ep.id,
      eventId: id,
      method,
      headers: JSON.stringify(headers),
      body,
      query,
      sourceIp,
      contentType,
      createdAt: now.toISOString(),
    });
  } catch (err) {
    console.error("Failed to broadcast to DO:", err);
  }

  // Optionally forward the webhook via static forwardUrl
  if (ep.forwardUrl) {
    const startTime = Date.now();
    try {
      const forwardResponse = await fetch(ep.forwardUrl, {
        method,
        headers: {
          ...headers,
          host: new URL(ep.forwardUrl).host,
          "x-tunnelhook-event-id": id,
          "x-tunnelhook-endpoint-id": ep.id,
        },
        body: method !== "GET" && method !== "HEAD" ? body : undefined,
      });

      const duration = Date.now() - startTime;
      await db
        .update(event)
        .set({
          forwardStatus: forwardResponse.status,
          forwardDuration: duration,
        })
        .where(eq(event.id, id));
    } catch (err) {
      const duration = Date.now() - startTime;
      await db
        .update(event)
        .set({
          forwardError: err instanceof Error ? err.message : "Unknown error",
          forwardDuration: duration,
        })
        .where(eq(event.id, id));
    }
  }

  return c.json({
    success: true,
    eventId: id,
    endpointId: ep.id,
  });
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

/**
 * SSE endpoint for subscribing to real-time webhook events.
 * GET /hooks/:slug/events
 */
export async function handleSSE(c: Context): Promise<Response> {
  const slug = c.req.param("slug");

  const ep = await db.query.endpoint.findFirst({
    where: eq(endpoint.slug, slug),
  });

  if (!ep) {
    return c.json({ error: "Endpoint not found" }, 404);
  }

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();

      // Send initial connection message
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({ type: "connected", endpointId: ep.id })}\n\n`
        )
      );

      // Keep-alive interval
      const keepAlive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch {
          clearInterval(keepAlive);
        }
      }, 15_000);

      // Subscribe to events for this endpoint
      const unsubscribe = subscribe(ep.id, (event) => {
        try {
          const data = JSON.stringify({ type: "event", event });
          controller.enqueue(encoder.encode(`data: ${data}\n\n`));
        } catch {
          // Stream closed
        }
      });

      // Cleanup when stream is cancelled
      c.req.raw.signal.addEventListener("abort", () => {
        clearInterval(keepAlive);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // Already closed
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
