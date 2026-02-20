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
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
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
  DELETE: "text-red-500",
  GET: "text-emerald-600",
  HEAD: "text-purple-500",
  OPTIONS: "text-muted-foreground",
  PATCH: "text-orange-500",
  POST: "text-blue-500",
  PUT: "text-amber-500",
};

const HTTP_PROTOCOL_RE = /^http/;

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

function EndpointPageHeader({
  name,
  slug,
  webhookUrl,
  connected,
  onEdit,
  onDelete,
}: {
  name: string;
  slug: string;
  webhookUrl: string;
  connected: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex items-center justify-between border-border border-b px-6 py-4">
      <div className="flex items-center gap-3">
        <Link to="/dashboard">
          <Button size="icon-sm" variant="ghost">
            <ArrowLeft />
          </Button>
        </Link>
        <div className="flex items-center gap-3">
          <h1 className="font-semibold text-[18px] tracking-tight">{name}</h1>
          <div className="flex items-center gap-1.5">
            <Circle
              className={cn(
                "size-2",
                connected
                  ? "fill-cyan text-cyan"
                  : "fill-muted-foreground text-muted-foreground"
              )}
            />
            <span className="text-[11px] text-muted-foreground">
              {connected ? "Connected" : "Disconnected"}
            </span>
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2">
        {/* Webhook URL pill */}
        <button
          className="flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 font-mono text-muted-foreground text-xs transition-colors duration-120 hover:bg-muted/80"
          onClick={() => {
            navigator.clipboard.writeText(webhookUrl);
            toast.success("Copied webhook URL");
          }}
          type="button"
        >
          /hooks/{slug}
          <Copy className="size-3" />
        </button>
        <Button onClick={onEdit} size="icon-sm" variant="ghost">
          <Settings />
        </Button>
        <Button onClick={onDelete} size="icon-sm" variant="ghost">
          <Trash2 />
        </Button>
      </div>
    </div>
  );
}

/* ──── Route Lines (Machine → Target) ──── */

function RouteLines({
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

  const machineList = useMemo(() => {
    return registeredMachines.map((m) => {
      const live = connectedMachines.get(m.id);
      return { ...m, online: live?.online ?? false };
    });
  }, [registeredMachines, connectedMachines]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center border-border border-b px-6 py-4">
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (machineList.length === 0) {
    return (
      <div className="flex items-center justify-between border-border border-b px-6 py-3">
        <p className="text-[13px] text-muted-foreground">
          No machines connected. Use the CLI to start receiving webhooks.
        </p>
        <Button
          onClick={() => setRegisterOpen(true)}
          size="sm"
          variant="outline"
        >
          <Plus className="size-3.5" data-icon="inline-start" />
          Add machine
        </Button>
        {registerOpen ? (
          <RegisterMachineDialog
            endpointId={endpointId}
            onOpenChange={setRegisterOpen}
            open={registerOpen}
          />
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 border-border border-b px-6 py-3">
      <Monitor className="size-4 text-muted-foreground" />
      <div className="flex flex-wrap items-center gap-2">
        {machineList.map((m) => (
          <div className="flex items-center gap-2" key={m.id}>
            {/* Machine chip */}
            <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 font-medium text-xs">
              <Circle
                className={cn(
                  "size-[6px]",
                  m.online
                    ? "fill-cyan text-cyan"
                    : "fill-muted-foreground text-muted-foreground"
                )}
              />
              {m.name}
            </span>
            {/* Dotted line */}
            <span className="inline-block w-8 border-border border-t border-dashed" />
            {/* Target pill */}
            <Tooltip>
              <TooltipTrigger>
                <span className="inline-flex max-w-[200px] items-center gap-1 truncate rounded-full bg-muted px-2.5 py-1 font-mono text-[11px] text-muted-foreground">
                  {m.forwardUrl}
                </span>
              </TooltipTrigger>
              <TooltipContent>{m.forwardUrl}</TooltipContent>
            </Tooltip>
          </div>
        ))}
      </div>
      <Button
        className="ml-auto"
        onClick={() => setRegisterOpen(true)}
        size="icon-xs"
        variant="ghost"
      >
        <Plus />
      </Button>
      {registerOpen ? (
        <RegisterMachineDialog
          endpointId={endpointId}
          onOpenChange={setRegisterOpen}
          open={registerOpen}
        />
      ) : null}
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
          <DialogTitle>Register machine</DialogTitle>
          <DialogDescription>
            Add a machine to forward webhooks from this endpoint.
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

/* ──── Events Table ──── */

function EventsTable({
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
  onSelectEvent: (id: string | null) => void;
  paused: boolean;
  onTogglePause: () => void;
  onClearEvents: () => void;
  deliveries: Map<string, DeliveryResult[]>;
}) {
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-6 py-3">
        <h2 className="font-semibold text-[14px]">
          Events
          <span className="ml-1.5 font-normal text-muted-foreground">
            {events.length}
          </span>
        </h2>
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger>
              <Button onClick={onTogglePause} size="icon-xs" variant="ghost">
                {paused ? <Play /> : <Pause />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {paused ? "Resume live updates" : "Pause live updates"}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger>
              <Button onClick={onClearEvents} size="icon-xs" variant="ghost">
                <Trash2 />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Clear events</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto px-6">
        {events.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center py-16 text-center">
            <p className="text-[13px] text-muted-foreground">
              No events yet. Send a request to your webhook URL.
            </p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-[70px]">Method</TableHead>
                <TableHead>ID</TableHead>
                <TableHead>Deliveries</TableHead>
                <TableHead className="text-right">Time</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.map((ev) => {
                const evDeliveries = deliveries.get(ev.id) ?? [];
                const isSelected = selectedEventId === ev.id;
                return (
                  <TableRow
                    className={cn(
                      "h-[44px] cursor-pointer transition-colors duration-120",
                      isSelected && "bg-accent"
                    )}
                    key={ev.id}
                    onClick={() => onSelectEvent(isSelected ? null : ev.id)}
                  >
                    <TableCell>
                      <span
                        className={cn(
                          "font-mono font-semibold text-xs",
                          METHOD_COLORS[ev.method] ?? "text-foreground"
                        )}
                      >
                        {ev.method}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className="font-mono text-muted-foreground text-xs">
                        {ev.id.slice(0, 8)}
                      </span>
                    </TableCell>
                    <TableCell>
                      {evDeliveries.length > 0 ? (
                        <div className="flex items-center gap-1">
                          {evDeliveries.map((d) => (
                            <DeliveryStatusDot
                              key={d.deliveryId}
                              status={d.status}
                            />
                          ))}
                        </div>
                      ) : (
                        <span className="text-muted-foreground/50 text-xs">
                          --
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <span className="text-muted-foreground text-xs">
                        {formatTime(ev.createdAt)}
                      </span>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}

function DeliveryStatusDot({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "inline-block size-2 rounded-full",
        status === "delivered" && "bg-success",
        status === "failed" && "bg-destructive",
        status === "pending" && "bg-warning"
      )}
    />
  );
}

/* ──── Inspector Drawer ──── */

function InspectorDrawer({
  event,
  liveDeliveries,
  onClose,
}: {
  event: WebhookEvent;
  liveDeliveries: DeliveryResult[];
  onClose: () => void;
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
    // Not JSON
  }

  const deliveriesQuery = useQuery(
    orpc.deliveries.listByEvent.queryOptions({
      input: { eventId: event.id },
    })
  );

  const mergedDeliveries = useMemo(() => {
    const seen = new Set<string>();
    const result: DeliveryResult[] = [];
    for (const d of liveDeliveries) {
      if (!seen.has(d.deliveryId)) {
        seen.add(d.deliveryId);
        result.push(d);
      }
    }
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
    <div className="flex w-[560px] shrink-0 flex-col border-border border-l bg-card shadow-[-12px_0_30px_rgba(0,0,0,.06)]">
      {/* Drawer header */}
      <div className="flex items-center justify-between border-border border-b px-5 py-3">
        <div className="flex items-center gap-3">
          <Badge
            className={cn(
              "font-mono",
              METHOD_COLORS[event.method] ?? "text-foreground"
            )}
            variant="outline"
          >
            {event.method}
          </Badge>
          <span className="font-mono text-muted-foreground text-xs">
            {event.id.slice(0, 12)}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            onClick={() => {
              navigator.clipboard.writeText(event.id);
              toast.success("Copied event ID");
            }}
            size="icon-xs"
            variant="ghost"
          >
            <Copy />
          </Button>
          <Button onClick={onClose} size="icon-xs" variant="ghost">
            <X />
          </Button>
        </div>
      </div>

      {/* Drawer content */}
      <ScrollArea className="flex-1">
        <div className="p-5">
          {/* Summary */}
          <div className="mb-4 grid grid-cols-2 gap-3 text-[13px]">
            {event.contentType ? (
              <div>
                <span className="text-muted-foreground">Content-Type</span>
                <p className="mt-0.5 font-mono text-xs">{event.contentType}</p>
              </div>
            ) : null}
            {event.sourceIp ? (
              <div>
                <span className="text-muted-foreground">Source IP</span>
                <p className="mt-0.5 font-mono text-xs">{event.sourceIp}</p>
              </div>
            ) : null}
            <div>
              <span className="text-muted-foreground">Received</span>
              <p className="mt-0.5 text-xs">
                {formatTimeFull(event.createdAt)}
              </p>
            </div>
            {event.query ? (
              <div>
                <span className="text-muted-foreground">Query</span>
                <p className="mt-0.5 font-mono text-xs">{event.query}</p>
              </div>
            ) : null}
          </div>

          {/* Tabs */}
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
              <div className="mt-3">
                {formattedBody ? (
                  <pre className="overflow-x-auto rounded-[10px] bg-muted p-3 font-mono text-xs leading-relaxed">
                    {formattedBody}
                  </pre>
                ) : (
                  <p className="py-4 text-[13px] text-muted-foreground italic">
                    No body
                  </p>
                )}
              </div>
            </TabsContent>

            <TabsContent value="headers">
              <div className="mt-3 rounded-[10px] bg-muted p-3">
                <div className="grid gap-1.5">
                  {Object.entries(parsedHeaders).map(([key, value]) => (
                    <div className="flex gap-2 font-mono text-xs" key={key}>
                      <span className="shrink-0 text-muted-foreground">
                        {key}:
                      </span>
                      <span className="break-all">{value}</span>
                    </div>
                  ))}
                </div>
              </div>
            </TabsContent>

            <TabsContent value="deliveries">
              <div className="mt-3">
                <DeliveriesPanel
                  deliveries={mergedDeliveries}
                  isLoading={deliveriesQuery.isLoading}
                />
              </div>
            </TabsContent>
          </Tabs>
        </div>
      </ScrollArea>
    </div>
  );
}

/* ──── Deliveries Panel ──── */

const deliveryStatusVariant: Record<
  string,
  "success" | "destructive" | "warning"
> = {
  delivered: "success",
  failed: "destructive",
};

function DeliveriesPanel({
  deliveries,
  isLoading,
}: {
  deliveries: DeliveryResult[];
  isLoading: boolean;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (isLoading) {
    return (
      <div className="flex justify-center py-6">
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (deliveries.length === 0) {
    return (
      <p className="py-4 text-center text-[13px] text-muted-foreground">
        No deliveries yet. Connect a machine to receive webhooks.
      </p>
    );
  }

  return (
    <div className="grid gap-2">
      {deliveries.map((d) => {
        const isExpanded = expandedId === d.deliveryId;
        return (
          <div key={d.deliveryId}>
            <button
              className={cn(
                "flex w-full items-center gap-3 rounded-[10px] px-3 py-2.5 text-left text-[13px] transition-colors duration-120",
                isExpanded ? "bg-muted" : "hover:bg-muted/50"
              )}
              onClick={() => setExpandedId(isExpanded ? null : d.deliveryId)}
              type="button"
            >
              <DeliveryStatusDot status={d.status} />
              <span className="font-medium">{d.machineName}</span>
              <Badge variant={deliveryStatusVariant[d.status] ?? "warning"}>
                {d.status}
              </Badge>
              {d.responseStatus ? (
                <span className="font-mono text-muted-foreground text-xs">
                  {d.responseStatus}
                </span>
              ) : null}
              {d.duration !== null ? (
                <span className="text-muted-foreground text-xs">
                  {d.duration}ms
                </span>
              ) : null}
              <span className="flex-1" />
              <span className="font-mono text-[11px] text-muted-foreground">
                {d.deliveryId.slice(0, 8)}
              </span>
            </button>

            {isExpanded ? <DeliveryExpandedDetail delivery={d} /> : null}
          </div>
        );
      })}
    </div>
  );
}

function DeliveryExpandedDetail({ delivery }: { delivery: DeliveryResult }) {
  let formattedBody = delivery.responseBody ?? "";
  try {
    if (formattedBody) {
      formattedBody = JSON.stringify(JSON.parse(formattedBody), null, 2);
    }
  } catch {
    // Not JSON
  }

  return (
    <div className="mt-1 ml-5 grid gap-2 border-border border-l-2 pl-4 text-[13px]">
      {delivery.error ? (
        <div>
          <span className="text-muted-foreground">Error: </span>
          <span className="text-destructive">{delivery.error}</span>
        </div>
      ) : null}
      {formattedBody ? (
        <div>
          <span className="mb-1 block text-muted-foreground">
            Response body
          </span>
          <pre className="overflow-x-auto rounded-[10px] bg-muted p-2 font-mono text-xs">
            {formattedBody}
          </pre>
        </div>
      ) : null}
    </div>
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
          <DialogTitle>Edit hook</DialogTitle>
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
              className="accent-cyan"
              id="edit-enabled"
              onChange={(e) => setEnabled(e.target.checked)}
              type="checkbox"
            />
            <Label htmlFor="edit-enabled">Enabled</Label>
          </div>
          <DialogFooter>
            <Button
              disabled={!name.trim() || updateMutation.isPending}
              type="submit"
            >
              {updateMutation.isPending ? (
                <Loader2 className="animate-spin" data-icon="inline-start" />
              ) : null}
              Save changes
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ──────────────────────── Main Component ──────────────────────── */

function EndpointDetail() {
  const { endpointId } = Route.useParams();
  const navigate = useNavigate();
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

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

  const {
    connected: wsConnected,
    events: wsEvents,
    deliveries: wsDeliveries,
    machines: wsMachines,
    paused,
    setPaused,
    clearEvents: clearWsEvents,
  } = useViewerWebSocket(ep?.slug, endpointId);

  const historicalEvents = eventsQuery.data?.items ?? [];

  const mergedEvents = useMergedEvents(wsEvents, historicalEvents);

  const selectedEvent = selectedEventId
    ? mergedEvents.find((e) => e.id === selectedEventId)
    : null;

  const connected = wsConnected;

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
      <div className="flex flex-1 items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!ep) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2">
        <p className="text-[13px] text-muted-foreground">Endpoint not found.</p>
        <Link
          className="text-[13px] text-cyan underline underline-offset-4"
          to="/dashboard"
        >
          Back to hooks
        </Link>
      </div>
    );
  }

  const webhookUrl = `${env.VITE_SERVER_URL}/hooks/${ep.slug}`;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Page header */}
      <EndpointPageHeader
        connected={connected}
        name={ep.name}
        onDelete={() => setDeleteConfirmOpen(true)}
        onEdit={() => setEditOpen(true)}
        slug={ep.slug}
        webhookUrl={webhookUrl}
      />

      {/* Route lines */}
      <RouteLines
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

      {/* Content: events table + inspector drawer */}
      <div className="flex min-h-0 flex-1">
        <EventsTable
          deliveries={wsDeliveries}
          events={mergedEvents}
          onClearEvents={() => clearEventsMutation.mutate()}
          onSelectEvent={setSelectedEventId}
          onTogglePause={() => setPaused(!paused)}
          paused={paused}
          selectedEventId={selectedEventId}
        />

        {/* Inspector drawer */}
        {selectedEvent ? (
          <InspectorDrawer
            event={selectedEvent}
            liveDeliveries={wsDeliveries.get(selectedEvent.id) ?? []}
            onClose={() => setSelectedEventId(null)}
          />
        ) : null}
      </div>

      {/* Edit dialog */}
      {editOpen ? (
        <EditEndpointDialog
          endpoint={ep as EndpointData}
          onOpenChange={setEditOpen}
          open={editOpen}
        />
      ) : null}

      {/* Delete confirmation dialog */}
      <Dialog onOpenChange={setDeleteConfirmOpen} open={deleteConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete endpoint?</DialogTitle>
            <DialogDescription>
              This action cannot be undone. All events and deliveries for this
              endpoint will be permanently deleted.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              onClick={() => setDeleteConfirmOpen(false)}
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              onClick={() => {
                deleteMutation.mutate();
                setDeleteConfirmOpen(false);
              }}
              variant="destructive"
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
