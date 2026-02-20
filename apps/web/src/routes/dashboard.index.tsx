import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  Copy,
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
        <DialogTitle>Create hook</DialogTitle>
        <DialogDescription>
          Create a new webhook endpoint. A unique URL will be generated
          automatically.
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
            toast.success("Copied webhook URL");
          }}
        >
          <Copy />
          Copy webhook URL
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

interface Endpoint {
  description: string | null;
  enabled: boolean;
  forwardUrl: string | null;
  id: string;
  name: string;
  slug: string;
}

function DashboardIndex() {
  const endpointsQuery = useQuery(orpc.endpoints.list.queryOptions());
  const [createOpen, setCreateOpen] = useState(false);

  const isLoading = endpointsQuery.isLoading;
  const isEmpty = !isLoading && endpointsQuery.data?.length === 0;
  const hasEndpoints = !isLoading && (endpointsQuery.data?.length ?? 0) > 0;

  return (
    <div className="flex flex-1 flex-col overflow-hidden p-6">
      {/* Page header */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="font-semibold text-[22px] leading-[28px] tracking-tight">
            Hooks
          </h1>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Manage your webhook endpoints and view incoming events.
          </p>
        </div>
        <Dialog onOpenChange={setCreateOpen} open={createOpen}>
          <DialogTrigger
            render={
              <Button>
                <Plus data-icon="inline-start" />
                New hook
              </Button>
            }
          />
          <CreateEndpointDialog onClose={() => setCreateOpen(false)} />
        </Dialog>
      </div>

      {/* Loading */}
      {isLoading ? (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : null}

      {/* Empty state */}
      {isEmpty ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3">
          <Webhook className="size-8 text-muted-foreground" />
          <p className="text-[13px] text-muted-foreground">
            No hooks yet. Create one to start receiving webhooks.
          </p>
          <Dialog onOpenChange={setCreateOpen} open={createOpen}>
            <DialogTrigger
              render={
                <Button>
                  <Plus data-icon="inline-start" />
                  Create hook
                </Button>
              }
            />
            <CreateEndpointDialog onClose={() => setCreateOpen(false)} />
          </Dialog>
        </div>
      ) : null}

      {/* Data table */}
      {hasEndpoints ? (
        <div className="flex-1 overflow-auto rounded-[14px] bg-card shadow-[0_1px_2px_rgba(0,0,0,.06)] ring-1 ring-border">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="sticky top-0 bg-card">Name</TableHead>
                <TableHead className="sticky top-0 bg-card">Slug</TableHead>
                <TableHead className="sticky top-0 bg-card">Status</TableHead>
                <TableHead className="sticky top-0 bg-card">
                  Forward URL
                </TableHead>
                <TableHead className="sticky top-0 w-10 bg-card" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {endpointsQuery.data?.map((ep) => {
                const endpoint = ep as Endpoint;
                return (
                  <TableRow
                    className="group h-[44px] cursor-pointer"
                    key={endpoint.id}
                  >
                    <TableCell>
                      <Link
                        className="font-medium text-[13px] hover:text-cyan"
                        params={{ endpointId: endpoint.id }}
                        to="/dashboard/endpoints/$endpointId"
                      >
                        {endpoint.name}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <code className="rounded-[6px] bg-muted px-1.5 py-0.5 font-mono text-muted-foreground text-xs">
                        /hooks/{endpoint.slug}
                      </code>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={endpoint.enabled ? "success" : "secondary"}
                      >
                        {endpoint.enabled ? "Active" : "Disabled"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {endpoint.forwardUrl ? (
                        <span className="truncate font-mono text-muted-foreground text-xs">
                          {endpoint.forwardUrl}
                        </span>
                      ) : (
                        <span className="text-muted-foreground/50 text-xs">
                          --
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <EndpointActions
                        endpointId={endpoint.id}
                        endpointName={endpoint.name}
                        slug={endpoint.slug}
                      />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      ) : null}
    </div>
  );
}
