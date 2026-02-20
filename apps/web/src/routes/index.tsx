import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowRight, Webhook } from "lucide-react";
import { useEffect } from "react";

import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";

export const Route = createFileRoute("/")({
  component: HomeComponent,
});

function HomeComponent() {
  const navigate = useNavigate();
  const { data: session, isPending } = authClient.useSession();

  useEffect(() => {
    if (!isPending && session) {
      navigate({ to: "/dashboard" });
    }
  }, [isPending, session, navigate]);

  if (isPending) {
    return (
      <div className="flex h-svh items-center justify-center">
        <div className="size-5 animate-spin rounded-full border-2 border-muted border-t-cyan" />
      </div>
    );
  }

  return (
    <div className="flex h-svh flex-col">
      <header className="flex items-center justify-between px-6 py-4">
        <div className="flex items-center gap-2">
          <Webhook className="size-5 text-cyan" />
          <span className="font-semibold text-[15px] tracking-tight">
            tunnelhook
          </span>
        </div>
        <Link to="/login">
          <Button size="sm" variant="outline">
            Sign in
          </Button>
        </Link>
      </header>

      <main className="flex flex-1 flex-col items-center justify-center gap-6 px-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="flex size-12 items-center justify-center rounded-[14px] bg-cyan-subtle">
            <Webhook className="size-6 text-cyan" />
          </div>
          <h1 className="font-semibold text-[22px] leading-[28px] tracking-tight">
            Webhook relay for local development
          </h1>
          <p className="max-w-md text-[13px] text-muted-foreground leading-[18px]">
            Receive webhooks on a public URL and tunnel them to your local
            machine. Inspect payloads, track deliveries, and replay events.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Link to="/login">
            <Button>
              Get started
              <ArrowRight className="size-4" data-icon="inline-end" />
            </Button>
          </Link>
        </div>
        <div className="mt-4 rounded-full bg-muted px-3 py-1">
          <code className="font-mono text-muted-foreground text-xs">
            npx tunnelhook my-hook --forward http://localhost:3000
          </code>
        </div>
      </main>

      <footer className="px-6 py-4 text-center text-muted-foreground text-xs">
        Open source webhook infrastructure
      </footer>
    </div>
  );
}
