import {
  createFileRoute,
  Link,
  Outlet,
  redirect,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import { LogOut, Monitor, ScrollText, Webhook } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/dashboard")({
  component: DashboardLayout,
  beforeLoad: async () => {
    const session = await authClient.getSession();
    if (!session.data) {
      redirect({
        to: "/login",
        throw: true,
      });
    }
    return { session };
  },
});

interface NavItem {
  disabled?: boolean;
  exact: boolean;
  icon: typeof Webhook;
  label: string;
  to: string;
}

const NAV_ITEMS: NavItem[] = [
  { to: "/dashboard", label: "Hooks", icon: Webhook, exact: true },
  {
    to: "/dashboard",
    label: "Machines",
    icon: Monitor,
    exact: false,
    disabled: true,
  },
  {
    to: "/dashboard/changelog",
    label: "Changelog",
    icon: ScrollText,
    exact: false,
  },
];

function DashboardLayout() {
  const navigate = useNavigate();
  const { data: session } = authClient.useSession();
  const routerState = useRouterState();
  const currentPath = routerState.location.pathname;

  return (
    <div className="flex h-svh overflow-hidden bg-background">
      {/* ── Sidebar ── */}
      <aside className="flex w-60 shrink-0 flex-col border-border border-r bg-card">
        {/* Logo */}
        <div className="flex h-14 items-center gap-2 px-5">
          <Webhook className="size-[18px] text-cyan" />
          <span className="font-semibold text-[15px] tracking-tight">
            tunnelhook
          </span>
        </div>

        {/* Nav */}
        <nav className="flex flex-1 flex-col gap-0.5 px-3 pt-2">
          {NAV_ITEMS.map((item) => {
            const isActive = item.exact
              ? currentPath === item.to || currentPath === `${item.to}/`
              : currentPath.startsWith(item.to) && !item.exact;

            if (item.disabled) {
              return (
                <span
                  className="flex cursor-not-allowed items-center gap-2.5 rounded-[10px] px-3 py-2 text-[13px] text-muted-foreground/50"
                  key={item.label}
                >
                  <item.icon className="size-4" />
                  {item.label}
                  <span className="ml-auto rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    Soon
                  </span>
                </span>
              );
            }

            return (
              <Link
                className={cn(
                  "flex items-center gap-2.5 rounded-[10px] px-3 py-2 font-medium text-[13px] transition-colors duration-120",
                  isActive
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
                key={item.label}
                to={item.to}
              >
                <item.icon className="size-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>

        {/* User area */}
        <div className="border-border border-t p-3">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <button
                  className="flex w-full items-center gap-2.5 rounded-[10px] px-3 py-2 text-left text-[13px] transition-colors duration-120 hover:bg-muted"
                  type="button"
                >
                  <div className="flex size-7 items-center justify-center rounded-full bg-muted font-medium text-xs">
                    {session?.user?.name?.charAt(0).toUpperCase() ?? "?"}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-[13px]">
                      {session?.user?.name ?? "User"}
                    </p>
                    <p className="truncate text-[11px] text-muted-foreground">
                      {session?.user?.email ?? ""}
                    </p>
                  </div>
                </button>
              }
            />
            <DropdownMenuContent align="start" className="w-56">
              <DropdownMenuLabel>Account</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => {
                  authClient.signOut({
                    fetchOptions: {
                      onSuccess: () => {
                        navigate({ to: "/" });
                      },
                    },
                  });
                }}
                variant="destructive"
              >
                <LogOut className="size-4" />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </aside>

      {/* ── Main content ── */}
      <main className="flex flex-1 flex-col overflow-hidden">
        <Outlet />
      </main>
    </div>
  );
}
