import { DurableObject } from "cloudflare:workers";

/**
 * WebSocket message types sent from the server (DO) to clients.
 */
export interface WebhookEventMessage {
  body: string | null;
  contentType: string | null;
  createdAt: string;
  /** The delivery ID for this specific machine */
  deliveryId: string;
  /** The event ID — used to correlate delivery reports */
  eventId: string;
  headers: string;
  method: string;
  query: string | null;
  sourceIp: string | null;
  type: "webhook";
}

export interface DeliveryResultMessage {
  deliveryId: string;
  duration: number | null;
  error: string | null;
  eventId: string;
  machineId: string;
  machineName: string;
  responseBody: string | null;
  responseStatus: number | null;
  status: "delivered" | "failed";
  type: "delivery-result";
}

export interface MachineStatusMessage {
  machineId: string;
  machineName: string;
  status: "online" | "offline";
  type: "machine-status";
}

export type ServerMessage =
  | WebhookEventMessage
  | DeliveryResultMessage
  | MachineStatusMessage;

/**
 * WebSocket message types sent from clients to the DO.
 */
export interface ClientDeliveryReport {
  deliveryId: string;
  duration: number | null;
  error: string | null;
  eventId: string;
  responseBody: string | null;
  responseStatus: number | null;
  status: "delivered" | "failed";
  type: "delivery-report";
}

/**
 * Attachment stored on each WebSocket via serializeAttachment/deserializeAttachment.
 */
interface WsAttachment {
  machineId?: string;
  machineName?: string;
  role: "machine" | "viewer";
  userId: string;
}

/**
 * EndpointDO — one Durable Object per webhook endpoint.
 *
 * Manages WebSocket connections from:
 * - machines: CLI/TUI clients that receive webhook events and forward locally
 * - viewers: web dashboard clients that watch deliveries in real-time
 *
 * Uses the WebSocket Hibernation API for cost efficiency.
 */
export class EndpointDO extends DurableObject {
  /**
   * HTTP fetch handler — used for:
   * 1. WebSocket upgrade requests from machines and viewers
   * 2. POST /broadcast — called by the Worker to fan out a webhook event
   */
  override fetch(request: Request): Promise<Response> | Response {
    const url = new URL(request.url);

    if (url.pathname === "/websocket") {
      return this.handleWebSocketUpgrade(request);
    }

    if (url.pathname === "/broadcast" && request.method === "POST") {
      return this.handleBroadcast(request);
    }

    return new Response("Not Found", { status: 404 });
  }

  /**
   * Upgrade an HTTP request to a WebSocket connection.
   * Query params:
   *   - role: "machine" | "viewer"
   *   - machineId: (for machines) the machine's DB ID
   *   - machineName: (for machines) the machine's name
   *   - userId: the authenticated user's ID
   */
  private handleWebSocketUpgrade(request: Request): Response {
    const url = new URL(request.url);
    const role = url.searchParams.get("role") as "machine" | "viewer";
    const machineId = url.searchParams.get("machineId") ?? undefined;
    const machineName = url.searchParams.get("machineName") ?? undefined;
    const userId = url.searchParams.get("userId") ?? "";

    if (!(role && userId)) {
      return new Response("Missing role or userId", { status: 400 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    const attachment: WsAttachment = {
      role,
      machineId,
      machineName,
      userId,
    };

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(attachment);

    // Notify all viewers that a new machine came online
    if (role === "machine" && machineId && machineName) {
      const statusMsg: MachineStatusMessage = {
        type: "machine-status",
        machineId,
        machineName,
        status: "online",
      };
      this.broadcastToViewers(JSON.stringify(statusMsg));
    }

    // Send the new viewer a snapshot of all currently connected machines
    if (role === "viewer") {
      for (const ws of this.getMachineWebSockets()) {
        const att = ws.deserializeAttachment() as WsAttachment | null;
        if (att?.machineId && att?.machineName) {
          const statusMsg: MachineStatusMessage = {
            type: "machine-status",
            machineId: att.machineId,
            machineName: att.machineName,
            status: "online",
          };
          server.send(JSON.stringify(statusMsg));
        }
      }
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Called by the Worker when a webhook event is captured.
   * Fans it out to all connected machines.
   */
  private async handleBroadcast(request: Request): Promise<Response> {
    const payload = (await request.json()) as {
      body: string | null;
      contentType: string | null;
      createdAt: string;
      /** Pre-created delivery records: machineId -> deliveryId */
      deliveries: Record<string, string>;
      eventId: string;
      headers: string;
      method: string;
      query: string | null;
      sourceIp: string | null;
    };

    const machines = this.getMachineWebSockets();

    for (const ws of machines) {
      const attachment = ws.deserializeAttachment() as WsAttachment;
      if (!attachment.machineId) {
        continue;
      }

      const deliveryId = payload.deliveries[attachment.machineId];
      if (!deliveryId) {
        continue;
      }

      const msg: WebhookEventMessage = {
        type: "webhook",
        eventId: payload.eventId,
        deliveryId,
        method: payload.method,
        headers: payload.headers,
        body: payload.body,
        query: payload.query,
        contentType: payload.contentType,
        sourceIp: payload.sourceIp,
        createdAt: payload.createdAt,
      };

      try {
        ws.send(JSON.stringify(msg));
      } catch {
        // WebSocket is dead, will be cleaned up by webSocketClose
      }
    }

    return Response.json({ sent: machines.length });
  }

  /**
   * Hibernation API: called when a WebSocket sends a message.
   */
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== "string") {
      return;
    }

    let parsed: ClientDeliveryReport;
    try {
      parsed = JSON.parse(message) as ClientDeliveryReport;
    } catch {
      return;
    }

    if (parsed.type === "delivery-report") {
      const attachment = ws.deserializeAttachment() as WsAttachment;

      // Broadcast the delivery result to all viewers
      const resultMsg: DeliveryResultMessage = {
        type: "delivery-result",
        eventId: parsed.eventId,
        deliveryId: parsed.deliveryId,
        machineId: attachment.machineId ?? "",
        machineName: attachment.machineName ?? "",
        status: parsed.status,
        responseStatus: parsed.responseStatus,
        responseBody: parsed.responseBody,
        error: parsed.error,
        duration: parsed.duration,
      };
      this.broadcastToViewers(JSON.stringify(resultMsg));

      // Also broadcast to other machines so they see the full picture
      this.broadcastToMachines(JSON.stringify(resultMsg), ws);
    }
  }

  /**
   * Hibernation API: called when a WebSocket is closed.
   */
  webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    _wasClean: boolean
  ): void {
    const attachment = ws.deserializeAttachment() as WsAttachment | null;

    if (attachment?.role === "machine" && attachment.machineId) {
      const statusMsg: MachineStatusMessage = {
        type: "machine-status",
        machineId: attachment.machineId,
        machineName: attachment.machineName ?? "",
        status: "offline",
      };
      this.broadcastToViewers(JSON.stringify(statusMsg));
    }

    ws.close(code, reason);
  }

  /**
   * Hibernation API: called on WebSocket error.
   */
  webSocketError(ws: WebSocket, _error: unknown): void {
    const attachment = ws.deserializeAttachment() as WsAttachment | null;

    if (attachment?.role === "machine" && attachment.machineId) {
      const statusMsg: MachineStatusMessage = {
        type: "machine-status",
        machineId: attachment.machineId,
        machineName: attachment.machineName ?? "",
        status: "offline",
      };
      this.broadcastToViewers(JSON.stringify(statusMsg));
    }

    ws.close(1011, "WebSocket error");
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private getMachineWebSockets(): WebSocket[] {
    return this.ctx.getWebSockets().filter((ws) => {
      const attachment = ws.deserializeAttachment() as WsAttachment | null;
      return attachment?.role === "machine";
    });
  }

  private getViewerWebSockets(): WebSocket[] {
    return this.ctx.getWebSockets().filter((ws) => {
      const attachment = ws.deserializeAttachment() as WsAttachment | null;
      return attachment?.role === "viewer";
    });
  }

  private broadcastToViewers(message: string): void {
    for (const ws of this.getViewerWebSockets()) {
      try {
        ws.send(message);
      } catch {
        // Dead socket, will be cleaned up
      }
    }
  }

  private broadcastToMachines(message: string, except?: WebSocket): void {
    for (const ws of this.getMachineWebSockets()) {
      if (ws === except) {
        continue;
      }
      try {
        ws.send(message);
      } catch {
        // Dead socket, will be cleaned up
      }
    }
  }

  /**
   * Returns the list of currently connected machine IDs.
   * Called via RPC from the Worker.
   */
  getConnectedMachines(): Array<{ machineId: string; machineName: string }> {
    const machines: Array<{ machineId: string; machineName: string }> = [];
    for (const ws of this.getMachineWebSockets()) {
      const attachment = ws.deserializeAttachment() as WsAttachment | null;
      if (attachment?.machineId && attachment.machineName) {
        machines.push({
          machineId: attachment.machineId,
          machineName: attachment.machineName,
        });
      }
    }
    return machines;
  }
}
