import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { env } from "@tunnelhook/env/web";
import {
  ArrowLeft,
  Circle,
  Copy,
  Loader2,
  Monitor,
  Pause,
  Play,
  Plus,
  Settings,
  Trash2,
  Wifi,
  WifiOff,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { client, orpc, queryClient } from "@/utils/orpc";

export const Route = createFileRoute("/dashboard/endpoints/$endpointId")({
  component: EndpointDetail,
});

/* ──────────────────────── Types ──────────────────────── */

interface WebhookEvent {
  body: string | null;
  contentType: string | null;
  createdAt: string;
  endpointId: string;
  headers: string;
  id: string;
  method: string;
  query: string | null;
  sourceIp: string | null;
}

interface DeliveryResult {
  deliveryId: string;
  duration: number | null;
  error: string | null;
  eventId: string;
  machineId: string;
  machineName: string;
  responseBody: string | null;
  responseStatus: number | null;
  status: "delivered" | "failed" | "pending";
}

interface ConnectedMachine {
  machineId: string;
  machineName: string;
  online: boolean;
}

/** Message types from the DO (must match endpoint-do.ts ServerMessage) */
type ServerMessage =
  | {
      body: string | null;
      contentType: string | null;
      createdAt: string;
      deliveryId: string;
      eventId: string;
      headers: string;
      method: string;
      query: string | null;
      sourceIp: string | null;
      type: "webhook";
    }
  | {
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
  | {
      machineId: string;
      machineName: string;
      status: "online" | "offline";
      type: "machine-status";
    };

const METHOD_COLORS: Record<string, string> = {
  DELETE: "text-red-400",
  GET: "text-green-400",
  HEAD: "text-purple-400",
  OPTIONS: "text-gray-400",
  PATCH: "text-orange-400",
  POST: "text-blue-400",
  PUT: "text-yellow-400",
};

const HTTP_PROTOCOL_RE = /^http/;

const STATUS_COLORS: Record<string, string> = {
  delivered: "text-green-400",
  failed: "text-red-400",
  pending: "text-yellow-400",
};

/* ──────────────────────── WebSocket Viewer Hook ──────────────────────── */

function useViewerWebSocket(slug: string | undefined, endpointId: string) {
  const [connected, setConnected] = useState(false);
  const [events, setEvents] = useState<WebhookEvent[]>([]);
  const [deliveries, setDeliveries] = useState<Map<string, DeliveryResult[]>>(
    new Map()
  );
  const [machines, setMachines] = useState<Map<string, ConnectedMachine>>(
    new Map()
  );
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  const connect = useCallback(() => {
    if (!slug) {
      return;
    }

    const wsUrl = `${env.VITE_SERVER_URL.replace(HTTP_PROTOCOL_RE, "ws")}/hooks/${slug}/ws?role=viewer`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
    };

    ws.onmessage = (msgEvent) => {
      try {
        const msg = JSON.parse(msgEvent.data) as ServerMessage;

        if (msg.type === "webhook" && !pausedRef.current) {
          const ev: WebhookEvent = {
            id: msg.eventId,
            endpointId,
            method: msg.method,
            headers: msg.headers,
            body: msg.body,
            query: msg.query,
            sourceIp: msg.sourceIp,
            contentType: msg.contentType,
            createdAt: msg.createdAt,
          };
          setEvents((prev) => [ev, ...prev]);
        }

        if (msg.type === "delivery-result") {
          const result: DeliveryResult = {
            deliveryId: msg.deliveryId,
            eventId: msg.eventId,
            machineId: msg.machineId,
            machineName: msg.machineName,
            status: msg.status,
            responseStatus: msg.responseStatus,
            responseBody: msg.responseBody,
            error: msg.error,
            duration: msg.duration,
          };
          setDeliveries((prev) => {
            const next = new Map(prev);
            const existing = next.get(msg.eventId) ?? [];
            // Replace if same deliveryId, otherwise append
            const idx = existing.findIndex(
              (d) => d.deliveryId === msg.deliveryId
            );
            if (idx >= 0) {
              existing[idx] = result;
            } else {
              existing.push(result);
            }
            next.set(msg.eventId, [...existing]);
            return next;
          });
        }

        if (msg.type === "machine-status") {
          setMachines((prev) => {
            const next = new Map(prev);
            if (msg.status === "online") {
              next.set(msg.machineId, {
                machineId: msg.machineId,
                machineName: msg.machineName,
                online: true,
              });
            } else {
              const existing = next.get(msg.machineId);
              if (existing) {
                next.set(msg.machineId, { ...existing, online: false });
              }
            }
            return next;
          });
        }
      } catch {
        // Ignore parse errors
      }
    };

    ws.onclose = () => {
      setConnected(false);
      wsRef.current = null;
      // Reconnect after 3s
      reconnectTimeoutRef.current = setTimeout(() => {
        connect();
      }, 3000);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, [slug, endpointId]);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [connect]);

  const clearEvents = useCallback(() => {
    setEvents([]);
    setDeliveries(new Map());
  }, []);

  return {
    connected,
    events,
    deliveries,
    machines,
    paused,
    setPaused,
    clearEvents,
  };
}

/* ──────────────────────── SSE Fallback Hook ──────────────────────── */

function useSSEEvents(slug: string | undefined) {
  const [events, setEvents] = useState<WebhookEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  useEffect(() => {
    if (!slug) {
      return;
    }

    const url = `${env.VITE_SERVER_URL}/hooks/${slug}/events`;
    const eventSource = new EventSource(url);

    eventSource.onopen = () => {
      setConnected(true);
    };

    eventSource.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data);
        if (data.type === "connected") {
          setConnected(true);
        } else if (data.type === "event" && !pausedRef.current) {
          setEvents((prev) => [data.event as WebhookEvent, ...prev]);
        }
      } catch {
        // Ignore parse errors
      }
    };

    eventSource.onerror = () => {
      setConnected(false);
    };

    return () => {
      eventSource.close();
    };
  }, [slug]);

  const clearEvents = useCallback(() => {
    setEvents([]);
  }, []);

  return { events, connected, paused, setPaused, clearEvents };
}

/* ──────────────────────── Merge Events ──────────────────────── */

function useMergedEvents(
  liveEvents: WebhookEvent[],
  historicalItems: Array<{
    body: string | null;
    contentType: string | null;
    createdAt: Date | string;
    endpointId: string;
    headers: string;
    id: string;
    method: string;
    query: string | null;
    sourceIp: string | null;
  }>
): WebhookEvent[] {
  return useMemo(() => {
    const seen = new Set<string>();
    const merged: WebhookEvent[] = [];

    for (const ev of liveEvents) {
      if (!seen.has(ev.id)) {
        seen.add(ev.id);
        merged.push(ev);
      }
    }

    for (const ev of historicalItems) {
      if (!seen.has(ev.id)) {
        seen.add(ev.id);
        merged.push({
          ...ev,
          createdAt:
            ev.createdAt instanceof Date
              ? ev.createdAt.toISOString()
              : String(ev.createdAt),
        });
      }
    }

    return merged;
  }, [liveEvents, historicalItems]);
}

/* ──────────────────────── Sub-components ──────────────────────── */

function EndpointHeader({
  name,
  description,
  enabled,
  wsConnected,
  onEdit,
  onDelete,
}: {
  name: string;
  description: string | null;
  enabled: boolean;
  wsConnected: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="mb-4 flex items-start justify-between">
      <div className="flex items-center gap-3">
        <Link to="/dashboard">
          <Button size="icon-sm" variant="ghost">
            <ArrowLeft />
          </Button>
        </Link>
        <div>
          <div className="flex items-center gap-2">
            <h1 className="font-medium text-lg">{name}</h1>
            <Badge
              className="text-[10px]"
              variant={enabled ? "default" : "secondary"}
            >
              {enabled ? "Active" : "Disabled"}
            </Badge>
            <ConnectionIndicator connected={wsConnected} label="WS" />
          </div>
          {description ? (
            <p className="text-muted-foreground text-xs">{description}</p>
          ) : null}
        </div>
      </div>
      <div className="flex items-center gap-1">
        <Button onClick={onEdit} size="icon-sm" variant="ghost">
          <Settings />
          <span className="sr-only">Settings</span>
        </Button>
        <Button onClick={onDelete} size="icon-sm" variant="ghost">
          <Trash2 />
          <span className="sr-only">Delete</span>
        </Button>
      </div>
    </div>
  );
}

function ConnectionIndicator({
  connected,
  label,
}: {
  connected: boolean;
  label?: string;
}) {
  const colorClass = connected
    ? "fill-green-400 text-green-400"
    : "fill-muted-foreground text-muted-foreground";
  return (
    <div className="flex items-center gap-1">
      <Circle className={`size-2 ${colorClass}`} />
      <span className="text-[10px] text-muted-foreground">
        {label ? `${label}: ` : ""}
        {connected ? "Connected" : "Disconnected"}
      </span>
    </div>
  );
}

function WebhookUrlCard({ webhookUrl }: { webhookUrl: string }) {
  return (
    <Card className="mb-4" size="sm">
      <CardContent className="flex items-center gap-2">
        <span className="shrink-0 text-muted-foreground text-xs">
          Webhook URL:
        </span>
        <code className="flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-[11px]">
          {webhookUrl}
        </code>
        <Button
          onClick={() => {
            navigator.clipboard.writeText(webhookUrl);
            toast.success("URL copied to clipboard");
          }}
          size="icon-xs"
          variant="ghost"
        >
          <Copy />
        </Button>
      </CardContent>
    </Card>
  );
}

/* ──── Machines Panel ──── */

function MachinesPanel({
  registeredMachines,
  connectedMachines,
  endpointId,
  isLoading,
}: {
  registeredMachines: Array<{
    id: string;
    name: string;
    forwardUrl: string;
    status: string;
    lastSeenAt: Date | string | null;
  }>;
  connectedMachines: Map<string, ConnectedMachine>;
  endpointId: string;
  isLoading: boolean;
}) {
  const [registerOpen, setRegisterOpen] = useState(false);

  // Merge registered machine data with live online/offline status
  const machineList = useMemo(() => {
    return registeredMachines.map((m) => {
      const live = connectedMachines.get(m.id);
      return {
        ...m,
        online: live?.online ?? false,
      };
    });
  }, [registeredMachines, connectedMachines]);

  const onlineCount = machineList.filter((m) => m.online).length;

  return (
    <Card className="mb-4" size="sm">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Monitor className="size-3.5" />
            Machines
            <Badge className="text-[10px]" variant="outline">
              {onlineCount}/{machineList.length} online
            </Badge>
          </CardTitle>
          <Button
            onClick={() => setRegisterOpen(true)}
            size="icon-xs"
            variant="ghost"
          >
            <Plus />
            <span className="sr-only">Register machine</span>
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <MachineListContent isLoading={isLoading} machineList={machineList} />
      </CardContent>
      {registerOpen ? (
        <RegisterMachineDialog
          endpointId={endpointId}
          onOpenChange={setRegisterOpen}
          open={registerOpen}
        />
      ) : null}
    </Card>
  );
}

function MachineListContent({
  isLoading,
  machineList,
}: {
  isLoading: boolean;
  machineList: Array<{
    id: string;
    name: string;
    forwardUrl: string;
    online: boolean;
    lastSeenAt: Date | string | null;
  }>;
}) {
  if (isLoading) {
    return (
      <div className="flex justify-center py-3">
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (machineList.length === 0) {
    return (
      <p className="py-2 text-center text-muted-foreground text-xs">
        No machines registered. Connect a machine via the TUI to start receiving
        webhooks.
      </p>
    );
  }

  return (
    <div className="grid gap-1">
      {machineList.map((m) => (
        <MachineRow key={m.id} machine={m} />
      ))}
    </div>
  );
}

function MachineRow({
  machine,
}: {
  machine: {
    id: string;
    name: string;
    forwardUrl: string;
    online: boolean;
    lastSeenAt: Date | string | null;
  };
}) {
  return (
    <div className="flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-muted/50">
      <Tooltip>
        <TooltipTrigger>
          {machine.online ? (
            <Wifi className="size-3 text-green-400" />
          ) : (
            <WifiOff className="size-3 text-muted-foreground" />
          )}
        </TooltipTrigger>
        <TooltipContent>{machine.online ? "Online" : "Offline"}</TooltipContent>
      </Tooltip>
      <span className="font-medium">{machine.name}</span>
      <span className="flex-1 truncate font-mono text-[10px] text-muted-foreground">
        {machine.forwardUrl}
      </span>
    </div>
  );
}

function RegisterMachineDialog({
  endpointId,
  open,
  onOpenChange,
}: {
  endpointId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [name, setName] = useState("");
  const [forwardUrl, setForwardUrl] = useState("http://localhost:3000");

  const registerMutation = useMutation({
    mutationFn: () =>
      client.machines.register({
        endpointId,
        name,
        forwardUrl,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: orpc.machines.list.queryOptions({
          input: { endpointId },
        }).queryKey,
      });
      toast.success("Machine registered");
      onOpenChange(false);
    },
    onError: (error) => {
      toast.error(`Failed to register: ${error.message}`);
    },
  });

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Register Machine</DialogTitle>
          <DialogDescription>
            Register a new machine that can receive and forward webhooks from
            this endpoint.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            registerMutation.mutate();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="machine-name">Name</Label>
            <Input
              id="machine-name"
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. My Laptop"
              required
              value={name}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="machine-url">Forward URL</Label>
            <Input
              id="machine-url"
              onChange={(e) => setForwardUrl(e.target.value)}
              placeholder="http://localhost:3000/webhook"
              required
              type="url"
              value={forwardUrl}
            />
          </div>
          <DialogFooter>
            <Button
              disabled={
                !(name.trim() && forwardUrl.trim()) ||
                registerMutation.isPending
              }
              size="sm"
              type="submit"
            >
              {registerMutation.isPending ? (
                <Loader2 className="animate-spin" data-icon="inline-start" />
              ) : null}
              Register
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ──── Events List ──── */

function EventsList({
  events,
  selectedEventId,
  onSelectEvent,
  paused,
  onTogglePause,
  onClearEvents,
  deliveries,
}: {
  events: WebhookEvent[];
  selectedEventId: string | null;
  onSelectEvent: (id: string) => void;
  paused: boolean;
  onTogglePause: () => void;
  onClearEvents: () => void;
  deliveries: Map<string, DeliveryResult[]>;
}) {
  return (
    <div className="flex w-80 shrink-0 flex-col">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="font-medium text-sm">Events ({events.length})</h2>
        <div className="flex items-center gap-1">
          <Button
            onClick={onTogglePause}
            size="icon-xs"
            title={paused ? "Resume live updates" : "Pause live updates"}
            variant="ghost"
          >
            {paused ? <Play /> : <Pause />}
          </Button>
          <Button
            onClick={onClearEvents}
            size="icon-xs"
            title="Clear all events"
            variant="ghost"
          >
            <Trash2 />
          </Button>
        </div>
      </div>
      <ScrollArea className="flex-1">
        {events.length === 0 ? (
          <EventsEmptyState />
        ) : (
          <div className="grid gap-1">
            {events.map((ev) => (
              <EventRow
                deliveryCount={deliveries.get(ev.id)?.length ?? 0}
                event={ev}
                isSelected={selectedEventId === ev.id}
                key={ev.id}
                onSelect={onSelectEvent}
              />
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

function EventsEmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground text-xs">
      <p>No events yet.</p>
      <p className="mt-1">Send a request to your webhook URL to see it here.</p>
    </div>
  );
}

function EventRow({
  event,
  isSelected,
  onSelect,
  deliveryCount,
}: {
  event: WebhookEvent;
  isSelected: boolean;
  onSelect: (id: string) => void;
  deliveryCount: number;
}) {
  const selectedClass = isSelected ? "bg-muted" : "hover:bg-muted/50";
  return (
    <button
      className={`flex items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors ${selectedClass}`}
      onClick={() => onSelect(event.id)}
      type="button"
    >
      <span
        className={`font-medium font-mono text-[11px] ${METHOD_COLORS[event.method] ?? "text-foreground"}`}
      >
        {event.method}
      </span>
      <span className="flex-1 truncate font-mono text-[10px] text-muted-foreground">
        {event.id.slice(0, 8)}
      </span>
      {deliveryCount > 0 ? (
        <Badge className="px-1 py-0 text-[9px]" variant="outline">
          {deliveryCount}
        </Badge>
      ) : null}
      <span className="text-[10px] text-muted-foreground">
        {formatTime(event.createdAt)}
      </span>
    </button>
  );
}

/* ──── Event Detail ──── */

function EventDetail({
  event,
  liveDeliveries,
  eventId,
}: {
  event: WebhookEvent;
  liveDeliveries: DeliveryResult[];
  eventId: string;
}) {
  let parsedHeaders: Record<string, string> = {};
  try {
    parsedHeaders = JSON.parse(event.headers);
  } catch {
    // Ignore
  }

  let formattedBody = event.body ?? "";
  try {
    if (formattedBody) {
      formattedBody = JSON.stringify(JSON.parse(formattedBody), null, 2);
    }
  } catch {
    // Not JSON, keep as-is
  }

  // Fetch historical deliveries for this event
  const deliveriesQuery = useQuery(
    orpc.deliveries.listByEvent.queryOptions({
      input: { eventId },
    })
  );

  // Merge live deliveries with historical ones
  const mergedDeliveries = useMemo(() => {
    const seen = new Set<string>();
    const result: DeliveryResult[] = [];

    // Live deliveries take precedence (most recent data)
    for (const d of liveDeliveries) {
      if (!seen.has(d.deliveryId)) {
        seen.add(d.deliveryId);
        result.push(d);
      }
    }

    // Add historical deliveries not yet seen
    for (const d of deliveriesQuery.data ?? []) {
      if (!seen.has(d.id)) {
        seen.add(d.id);
        result.push({
          deliveryId: d.id,
          eventId: d.eventId,
          machineId: d.machineId,
          machineName: d.machineName ?? "Unknown",
          status: d.status as "delivered" | "failed" | "pending",
          responseStatus: d.responseStatus,
          responseBody: d.responseBody,
          error: d.error,
          duration: d.duration,
        });
      }
    }

    return result;
  }, [liveDeliveries, deliveriesQuery.data]);

  return (
    <div className="flex flex-col gap-3">
      <EventDetailHeader event={event} />
      <EventMetadata event={event} />
      <Tabs defaultValue="body">
        <TabsList variant="line">
          <TabsTrigger value="body">Body</TabsTrigger>
          <TabsTrigger value="headers">
            Headers ({Object.keys(parsedHeaders).length})
          </TabsTrigger>
          <TabsTrigger value="deliveries">
            Deliveries ({mergedDeliveries.length})
          </TabsTrigger>
        </TabsList>
        <TabsContent value="body">
          <Card className="mt-2" size="sm">
            <CardContent>
              {formattedBody ? (
                <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-[11px]">
                  {formattedBody}
                </pre>
              ) : (
                <p className="text-muted-foreground text-xs italic">No body</p>
              )}
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="headers">
          <Card className="mt-2" size="sm">
            <CardContent>
              <div className="grid gap-1">
                {Object.entries(parsedHeaders).map(([key, value]) => (
                  <div className="flex gap-2 font-mono text-[11px]" key={key}>
                    <span className="shrink-0 text-muted-foreground">
                      {key}:
                    </span>
                    <span className="break-all">{value}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="deliveries">
          <DeliveriesTab
            deliveries={mergedDeliveries}
            isLoading={deliveriesQuery.isLoading}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function EventDetailHeader({ event }: { event: WebhookEvent }) {
  return (
    <div className="flex items-center gap-3">
      <Badge
        className={METHOD_COLORS[event.method] ?? "text-foreground"}
        variant="outline"
      >
        {event.method}
      </Badge>
      <span className="font-mono text-[11px] text-muted-foreground">
        {event.id}
      </span>
      <span className="text-[10px] text-muted-foreground">
        {formatTimeFull(event.createdAt)}
      </span>
    </div>
  );
}

function EventMetadata({ event }: { event: WebhookEvent }) {
  return (
    <div className="flex gap-4 text-xs">
      {event.contentType ? (
        <div>
          <span className="text-muted-foreground">Content-Type: </span>
          <span className="font-mono">{event.contentType}</span>
        </div>
      ) : null}
      {event.sourceIp ? (
        <div>
          <span className="text-muted-foreground">Source IP: </span>
          <span className="font-mono">{event.sourceIp}</span>
        </div>
      ) : null}
      {event.query ? (
        <div>
          <span className="text-muted-foreground">Query: </span>
          <span className="font-mono">{event.query}</span>
        </div>
      ) : null}
    </div>
  );
}

/* ──── Deliveries Tab ──── */

function DeliveriesTab({
  deliveries,
  isLoading,
}: {
  deliveries: DeliveryResult[];
  isLoading: boolean;
}) {
  const [selectedDelivery, setSelectedDelivery] =
    useState<DeliveryResult | null>(null);

  if (isLoading) {
    return (
      <div className="flex justify-center py-6">
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (deliveries.length === 0) {
    return (
      <Card className="mt-2" size="sm">
        <CardContent>
          <p className="py-4 text-center text-muted-foreground text-xs">
            No deliveries yet. Connect a machine to receive webhook deliveries.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="mt-2 grid gap-2">
      <div className="grid gap-1">
        {deliveries.map((d) => (
          <button
            className={`flex items-center gap-3 rounded px-3 py-2 text-left text-xs transition-colors ${
              selectedDelivery?.deliveryId === d.deliveryId
                ? "bg-muted"
                : "hover:bg-muted/50"
            }`}
            key={d.deliveryId}
            onClick={() =>
              setSelectedDelivery(
                selectedDelivery?.deliveryId === d.deliveryId ? null : d
              )
            }
            type="button"
          >
            <StatusDot status={d.status} />
            <span className="font-medium">{d.machineName}</span>
            <span
              className={`font-mono text-[11px] ${STATUS_COLORS[d.status]}`}
            >
              {d.status}
            </span>
            {d.responseStatus ? (
              <Badge className="text-[10px]" variant="outline">
                {d.responseStatus}
              </Badge>
            ) : null}
            {d.duration !== null ? (
              <span className="text-[10px] text-muted-foreground">
                {d.duration}ms
              </span>
            ) : null}
            <span className="flex-1" />
            <span className="font-mono text-[10px] text-muted-foreground">
              {d.deliveryId.slice(0, 8)}
            </span>
          </button>
        ))}
      </div>

      {selectedDelivery ? <DeliveryDetail delivery={selectedDelivery} /> : null}
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  let color = "bg-yellow-400";
  if (status === "delivered") {
    color = "bg-green-400";
  } else if (status === "failed") {
    color = "bg-red-400";
  }
  return <span className={`inline-block size-2 rounded-full ${color}`} />;
}

function DeliveryDetail({ delivery }: { delivery: DeliveryResult }) {
  let formattedBody = delivery.responseBody ?? "";
  try {
    if (formattedBody) {
      formattedBody = JSON.stringify(JSON.parse(formattedBody), null, 2);
    }
  } catch {
    // Not JSON
  }

  return (
    <Card size="sm">
      <CardHeader className="pb-2">
        <CardTitle className="text-xs">
          Delivery to {delivery.machineName}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid gap-2 text-xs">
          <div className="flex gap-4">
            <div>
              <span className="text-muted-foreground">Status: </span>
              <span className={`font-medium ${STATUS_COLORS[delivery.status]}`}>
                {delivery.status}
              </span>
            </div>
            {delivery.responseStatus ? (
              <div>
                <span className="text-muted-foreground">HTTP: </span>
                <span className="font-mono">{delivery.responseStatus}</span>
              </div>
            ) : null}
            {delivery.duration !== null ? (
              <div>
                <span className="text-muted-foreground">Duration: </span>
                <span className="font-mono">{delivery.duration}ms</span>
              </div>
            ) : null}
          </div>

          {delivery.error ? (
            <div>
              <span className="text-muted-foreground">Error: </span>
              <span className="text-red-400">{delivery.error}</span>
            </div>
          ) : null}

          {formattedBody ? (
            <div>
              <span className="mb-1 block text-muted-foreground">
                Response Body:
              </span>
              <pre className="overflow-x-auto rounded bg-muted p-2 font-mono text-[11px]">
                {formattedBody}
              </pre>
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

/* ──── Edit Endpoint Dialog ──── */

interface EndpointData {
  description: string | null;
  enabled: boolean;
  forwardUrl: string | null;
  id: string;
  name: string;
  slug: string;
}

function EditEndpointDialog({
  endpoint,
  open,
  onOpenChange,
}: {
  endpoint: EndpointData;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [name, setName] = useState(endpoint.name);
  const [description, setDescription] = useState(endpoint.description ?? "");
  const [forwardUrl, setForwardUrl] = useState(endpoint.forwardUrl ?? "");
  const [enabled, setEnabled] = useState(endpoint.enabled);

  const updateMutation = useMutation({
    mutationFn: () =>
      client.endpoints.update({
        id: endpoint.id,
        name,
        description: description || undefined,
        forwardUrl: forwardUrl || null,
        enabled,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: orpc.endpoints.get.queryOptions({
          input: { id: endpoint.id },
        }).queryKey,
      });
      queryClient.invalidateQueries({
        queryKey: orpc.endpoints.list.queryOptions().queryKey,
      });
      toast.success("Endpoint updated");
      onOpenChange(false);
    },
    onError: (error) => {
      toast.error(`Failed to update: ${error.message}`);
    },
  });

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit Endpoint</DialogTitle>
          <DialogDescription>
            Update your endpoint configuration.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            updateMutation.mutate();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="edit-name">Name</Label>
            <Input
              id="edit-name"
              onChange={(e) => setName(e.target.value)}
              required
              value={name}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="edit-desc">Description</Label>
            <Input
              id="edit-desc"
              onChange={(e) => setDescription(e.target.value)}
              value={description}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="edit-forward">Forward URL</Label>
            <Input
              id="edit-forward"
              onChange={(e) => setForwardUrl(e.target.value)}
              placeholder="https://example.com/webhook"
              type="url"
              value={forwardUrl}
            />
          </div>
          <div className="flex items-center gap-2">
            <input
              checked={enabled}
              className="accent-primary"
              id="edit-enabled"
              onChange={(e) => setEnabled(e.target.checked)}
              type="checkbox"
            />
            <Label htmlFor="edit-enabled">Enabled</Label>
          </div>
          <DialogFooter>
            <Button
              disabled={!name.trim() || updateMutation.isPending}
              size="sm"
              type="submit"
            >
              {updateMutation.isPending ? (
                <Loader2 className="animate-spin" data-icon="inline-start" />
              ) : null}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ──────────────────────── Main component ──────────────────────── */

function EndpointDetail() {
  const { endpointId } = Route.useParams();
  const navigate = useNavigate();
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);

  const endpointQuery = useQuery(
    orpc.endpoints.get.queryOptions({ input: { id: endpointId } })
  );

  const eventsQuery = useQuery(
    orpc.events.list.queryOptions({
      input: { endpointId, limit: 50 },
    })
  );

  const machinesQuery = useQuery(
    orpc.machines.list.queryOptions({
      input: { endpointId },
    })
  );

  const ep = endpointQuery.data;

  // Primary: WebSocket viewer connection for real-time data
  const {
    connected: wsConnected,
    events: wsEvents,
    deliveries: wsDeliveries,
    machines: wsMachines,
    paused,
    setPaused,
    clearEvents: clearWsEvents,
  } = useViewerWebSocket(ep?.slug, endpointId);

  // Fallback: SSE for events when WebSocket isn't available (also captures events not sent to viewers)
  const { events: sseEvents, connected: sseConnected } = useSSEEvents(ep?.slug);

  // Merge all event sources
  const historicalEvents = eventsQuery.data?.items ?? [];
  const allLiveEvents = useMemo(() => {
    const seen = new Set<string>();
    const merged: WebhookEvent[] = [];
    for (const ev of wsEvents) {
      if (!seen.has(ev.id)) {
        seen.add(ev.id);
        merged.push(ev);
      }
    }
    for (const ev of sseEvents) {
      if (!seen.has(ev.id)) {
        seen.add(ev.id);
        merged.push(ev);
      }
    }
    return merged;
  }, [wsEvents, sseEvents]);

  const mergedEvents = useMergedEvents(allLiveEvents, historicalEvents);

  const selectedEvent = selectedEventId
    ? mergedEvents.find((e) => e.id === selectedEventId)
    : null;

  const connected = wsConnected || sseConnected;

  const deleteMutation = useMutation({
    mutationFn: () => client.endpoints.delete({ id: endpointId }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: orpc.endpoints.list.queryOptions().queryKey,
      });
      toast.success("Endpoint deleted");
      navigate({ to: "/dashboard" });
    },
    onError: (error) => {
      toast.error(`Failed to delete: ${error.message}`);
    },
  });

  const clearEventsMutation = useMutation({
    mutationFn: () => client.events.clear({ endpointId }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: orpc.events.list.queryOptions({
          input: { endpointId, limit: 50 },
        }).queryKey,
      });
      clearWsEvents();
      toast.success("Events cleared");
    },
    onError: (error) => {
      toast.error(`Failed to clear events: ${error.message}`);
    },
  });

  if (endpointQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!ep) {
    return (
      <div className="mx-auto max-w-5xl p-4">
        <p className="text-muted-foreground">Endpoint not found.</p>
        <Link className="mt-2 text-primary text-xs underline" to="/dashboard">
          Back to dashboard
        </Link>
      </div>
    );
  }

  const webhookUrl = `${env.VITE_SERVER_URL}/hooks/${ep.slug}`;

  return (
    <div className="mx-auto flex h-full w-full max-w-7xl flex-col p-4">
      <EndpointHeader
        description={ep.description}
        enabled={ep.enabled}
        name={ep.name}
        onDelete={() => deleteMutation.mutate()}
        onEdit={() => setEditOpen(true)}
        wsConnected={connected}
      />

      <WebhookUrlCard webhookUrl={webhookUrl} />

      <MachinesPanel
        connectedMachines={wsMachines}
        endpointId={endpointId}
        isLoading={machinesQuery.isLoading}
        registeredMachines={(machinesQuery.data ?? []).map((m) => ({
          id: m.id,
          name: m.name,
          forwardUrl: m.forwardUrl,
          status: m.status,
          lastSeenAt: m.lastSeenAt,
        }))}
      />

      <div className="flex min-h-0 flex-1 gap-4">
        <EventsList
          deliveries={wsDeliveries}
          events={mergedEvents}
          onClearEvents={() => clearEventsMutation.mutate()}
          onSelectEvent={setSelectedEventId}
          onTogglePause={() => setPaused(!paused)}
          paused={paused}
          selectedEventId={selectedEventId}
        />

        <Separator orientation="vertical" />

        <div className="flex min-w-0 flex-1 flex-col">
          {selectedEvent ? (
            <EventDetail
              event={selectedEvent}
              eventId={selectedEvent.id}
              liveDeliveries={wsDeliveries.get(selectedEvent.id) ?? []}
            />
          ) : (
            <div className="flex flex-1 items-center justify-center text-muted-foreground text-xs">
              Select an event to view details
            </div>
          )}
        </div>
      </div>

      {editOpen ? (
        <EditEndpointDialog
          endpoint={ep as EndpointData}
          onOpenChange={setEditOpen}
          open={editOpen}
        />
      ) : null}
    </div>
  );
}

/* ──────────────────────── Utilities ──────────────────────── */

function formatTime(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    return date.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return "";
  }
}

function formatTimeFull(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    return date.toLocaleString();
  } catch {
    return "";
  }
}
