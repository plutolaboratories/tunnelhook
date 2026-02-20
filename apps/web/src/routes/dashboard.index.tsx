import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  Copy,
  ExternalLink,
  Loader2,
  MoreHorizontal,
  Plus,
  Trash2,
  Webhook,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { client, orpc, queryClient } from "@/utils/orpc";

export const Route = createFileRoute("/dashboard/")({
  component: DashboardIndex,
});

function CreateEndpointDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [forwardUrl, setForwardUrl] = useState("");

  const createMutation = useMutation({
    mutationFn: () =>
      client.endpoints.create({
        name,
        description: description || undefined,
        forwardUrl: forwardUrl || undefined,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: orpc.endpoints.list.queryOptions().queryKey,
      });
      toast.success("Endpoint created");
      onClose();
    },
    onError: (error) => {
      toast.error(`Failed to create endpoint: ${error.message}`);
    },
  });

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Create Endpoint</DialogTitle>
        <DialogDescription>
          Create a new webhook endpoint. You'll get a unique URL to receive
          webhooks.
        </DialogDescription>
      </DialogHeader>
      <form
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          createMutation.mutate();
        }}
      >
        <div className="grid gap-1.5">
          <Label htmlFor="ep-name">Name</Label>
          <Input
            id="ep-name"
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Stripe Production"
            required
            value={name}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="ep-desc">Description (optional)</Label>
          <Input
            id="ep-desc"
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What this endpoint is for"
            value={description}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="ep-forward">Forward URL (optional)</Label>
          <Input
            id="ep-forward"
            onChange={(e) => setForwardUrl(e.target.value)}
            placeholder="https://example.com/webhook"
            type="url"
            value={forwardUrl}
          />
        </div>
        <DialogFooter>
          <Button
            disabled={!name.trim() || createMutation.isPending}
            size="sm"
            type="submit"
          >
            {createMutation.isPending ? (
              <Loader2 className="animate-spin" data-icon="inline-start" />
            ) : null}
            Create
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

function EndpointActions({
  endpointId,
  slug,
  endpointName,
}: {
  endpointId: string;
  slug: string;
  endpointName: string;
}) {
  const deleteMutation = useMutation({
    mutationFn: () => client.endpoints.delete({ id: endpointId }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: orpc.endpoints.list.queryOptions().queryKey,
      });
      toast.success(`Deleted "${endpointName}"`);
    },
    onError: (error) => {
      toast.error(`Failed to delete: ${error.message}`);
    },
  });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button size="icon-xs" variant="ghost">
            <MoreHorizontal />
            <span className="sr-only">Actions</span>
          </Button>
        }
      />
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onSelect={() => {
            const url = `${window.location.protocol}//${window.location.host}/hooks/${slug}`;
            navigator.clipboard.writeText(url);
            toast.success("Webhook URL copied to clipboard");
          }}
        >
          <Copy />
          Copy Webhook URL
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => deleteMutation.mutate()}
          variant="destructive"
        >
          <Trash2 />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function EmptyState({
  createOpen,
  setCreateOpen,
}: {
  createOpen: boolean;
  setCreateOpen: (open: boolean) => void;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center justify-center py-16">
        <Webhook className="mb-3 size-8 text-muted-foreground" />
        <p className="mb-1 font-medium text-sm">No endpoints yet</p>
        <p className="mb-4 text-muted-foreground text-xs">
          Create your first webhook endpoint to start receiving events.
        </p>
        <Dialog onOpenChange={setCreateOpen} open={createOpen}>
          <DialogTrigger
            render={
              <Button size="sm">
                <Plus data-icon="inline-start" />
                Create Endpoint
              </Button>
            }
          />
          <CreateEndpointDialog onClose={() => setCreateOpen(false)} />
        </Dialog>
      </CardContent>
    </Card>
  );
}

interface Endpoint {
  description: string | null;
  enabled: boolean;
  forwardUrl: string | null;
  id: string;
  name: string;
  slug: string;
}

function EndpointCard({ ep }: { ep: Endpoint }) {
  return (
    <Card className="transition-colors hover:bg-muted/50" size="sm">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Link
            className="contents"
            params={{ endpointId: ep.id }}
            to="/dashboard/endpoints/$endpointId"
          >
            <CardTitle className="hover:underline">{ep.name}</CardTitle>
          </Link>
          <Badge
            className="text-[10px]"
            variant={ep.enabled ? "default" : "secondary"}
          >
            {ep.enabled ? "Active" : "Disabled"}
          </Badge>
        </div>
        <CardDescription>
          {ep.description || `Slug: ${ep.slug}`}
        </CardDescription>
        <div className="col-start-2 row-span-2 row-start-1 self-start justify-self-end">
          <EndpointActions
            endpointId={ep.id}
            endpointName={ep.name}
            slug={ep.slug}
          />
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground text-xs">URL:</span>
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
              /hooks/{ep.slug}
            </code>
          </div>
          {ep.forwardUrl ? (
            <div className="flex items-center gap-1.5">
              <ExternalLink className="size-3 text-muted-foreground" />
              <span className="truncate text-[11px] text-muted-foreground">
                {ep.forwardUrl}
              </span>
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

function DashboardIndex() {
  const endpointsQuery = useQuery(orpc.endpoints.list.queryOptions());
  const [createOpen, setCreateOpen] = useState(false);

  const isLoading = endpointsQuery.isLoading;
  const isEmpty = !isLoading && endpointsQuery.data?.length === 0;
  const hasEndpoints = !isLoading && (endpointsQuery.data?.length ?? 0) > 0;

  return (
    <div className="mx-auto w-full max-w-5xl p-4">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="font-medium text-lg">Endpoints</h1>
          <p className="text-muted-foreground text-xs">
            Manage your webhook endpoints and view incoming events.
          </p>
        </div>
        <Dialog onOpenChange={setCreateOpen} open={createOpen}>
          <DialogTrigger
            render={
              <Button size="sm">
                <Plus data-icon="inline-start" />
                New Endpoint
              </Button>
            }
          />
          <CreateEndpointDialog onClose={() => setCreateOpen(false)} />
        </Dialog>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : null}

      {isEmpty ? (
        <EmptyState createOpen={createOpen} setCreateOpen={setCreateOpen} />
      ) : null}

      {hasEndpoints ? (
        <div className="grid gap-2">
          {endpointsQuery.data?.map((ep) => (
            <EndpointCard ep={ep as Endpoint} key={ep.id} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
