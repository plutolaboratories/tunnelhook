#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { createCliRenderer } from "@opentui/core";
import {
  createRoot,
  useKeyboard,
  useRenderer,
  useTerminalDimensions,
} from "@opentui/react";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { AppRouterClient } from "@tunnelhook/api/routers/index";
import { useCallback, useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SERVER_URL =
  process.env.TUNNELHOOK_SERVER_URL ?? "https://api.tunnelhook.com";
const WS_URL = SERVER_URL.replace(/^http/, "ws");

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

interface CliArgs {
  /** "login" subcommand */
  command: "login" | "listen" | "interactive";
  /** --forward / -f URL */
  forwardUrl?: string;
  /** --machine / -m name override */
  machineName?: string;
  /** Endpoint slug (positional arg for listen mode) */
  slug?: string;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    return { command: "interactive" };
  }

  if (args[0] === "login") {
    return { command: "login" };
  }

  // tunnelhook <slug> --forward <url> [--machine <name>]
  const slug = args[0];
  let forwardUrl: string | undefined;
  let machineName: string | undefined;

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if ((arg === "--forward" || arg === "-f") && args[i + 1]) {
      forwardUrl = args[i + 1];
      i++;
    } else if ((arg === "--machine" || arg === "-m") && args[i + 1]) {
      machineName = args[i + 1];
      i++;
    }
  }

  if (!forwardUrl) {
    console.error(
      "Usage: tunnelhook <endpoint-slug> --forward <url> [--machine <name>]"
    );
    console.error("       tunnelhook login");
    console.error("       tunnelhook              (interactive mode)");
    process.exit(1);
  }

  return { command: "listen", slug, forwardUrl, machineName };
}

const cliArgs = parseArgs();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Endpoint {
  createdAt: string;
  description: string | null;
  enabled: boolean;
  forwardUrl: string | null;
  id: string;
  name: string;
  slug: string;
}

interface Machine {
  endpointId: string;
  forwardUrl: string;
  id: string;
  name: string;
  status: string;
}

interface WebhookEvent {
  body: string | null;
  contentType: string | null;
  createdAt: string;
  deliveryId?: string;
  endpointId?: string;
  eventId?: string;
  headers: string;
  id?: string;
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
  status: "delivered" | "failed";
}

type Screen =
  | "login"
  | "endpoints"
  | "machine-setup"
  | "monitor"
  | "event-detail";

// ---------------------------------------------------------------------------
// Session persistence (~/.tunnelhook/session.json)
// ---------------------------------------------------------------------------

const CONFIG_DIR = join(homedir(), ".tunnelhook");
const SESSION_FILE = join(CONFIG_DIR, "session.json");

interface SessionData {
  cookies: string;
  serverUrl: string;
}

function loadSession(): string | null {
  try {
    if (!existsSync(SESSION_FILE)) {
      return null;
    }
    const raw = readFileSync(SESSION_FILE, "utf-8");
    const data = JSON.parse(raw) as SessionData;
    // Only use session if it matches the current server URL
    if (data.serverUrl === SERVER_URL && data.cookies) {
      return data.cookies;
    }
    return null;
  } catch {
    return null;
  }
}

function saveSession(cookies: string): void {
  try {
    if (!existsSync(CONFIG_DIR)) {
      mkdirSync(CONFIG_DIR, { recursive: true });
    }
    const data: SessionData = { cookies, serverUrl: SERVER_URL };
    writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2), "utf-8");
  } catch {
    // Non-critical — session just won't persist
  }
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

let authCookies: string | null = loadSession();

async function signIn(
  email: string,
  password: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await fetch(`${SERVER_URL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
      redirect: "manual",
    });

    if (!res.ok) {
      return { success: false, error: "Invalid credentials" };
    }

    const cookies = res.headers.getSetCookie?.() ?? [];
    if (cookies.length > 0) {
      authCookies = cookies.map((c: string) => c.split(";")[0]).join("; ");
      saveSession(authCookies);
    }

    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Network error",
    };
  }
}

/** Validate the current session is still active by calling the auth session endpoint. */
async function validateSession(): Promise<boolean> {
  if (!authCookies) {
    return false;
  }
  try {
    const res = await fetch(`${SERVER_URL}/api/auth/get-session`, {
      headers: { Cookie: authCookies },
    });
    if (!res.ok) {
      return false;
    }
    const data = (await res.json()) as { session?: unknown };
    return Boolean(data.session);
  } catch {
    return false;
  }
}

function getAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  if (authCookies) {
    headers.Cookie = authCookies;
  }
  return headers;
}

// ---------------------------------------------------------------------------
// oRPC client
// ---------------------------------------------------------------------------

const link = new RPCLink({
  url: `${SERVER_URL}/rpc`,
  headers: () => getAuthHeaders(),
});

const rpcClient: AppRouterClient = createORPCClient(link);

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function fetchEndpoints(): Promise<Endpoint[]> {
  const result = await rpcClient.endpoints.list({});
  return result as unknown as Endpoint[];
}

async function fetchMachines(endpointId: string): Promise<Machine[]> {
  const result = await rpcClient.machines.list({ endpointId });
  return result as unknown as Machine[];
}

async function registerMachine(
  endpointId: string,
  name: string,
  forwardUrl: string
): Promise<Machine> {
  const result = await rpcClient.machines.register({
    endpointId,
    name,
    forwardUrl,
  });
  return result as unknown as Machine;
}

async function createEndpointApi(
  name: string,
  forwardUrl?: string
): Promise<Endpoint> {
  const result = await rpcClient.endpoints.create({
    name,
    forwardUrl: forwardUrl || undefined,
  });
  return result as unknown as Endpoint;
}

async function reportDeliveryResult(params: {
  deliveryId: string;
  duration: number | null;
  error: string | null;
  responseBody: string | null;
  responseStatus: number | null;
  status: "delivered" | "failed";
}): Promise<void> {
  await rpcClient.machines.reportDelivery(params);
}

// ---------------------------------------------------------------------------
// Machine resolution (find or create a machine for direct CLI mode)
// ---------------------------------------------------------------------------

const LOCAL_SUFFIX_RE = /\.local$/;

function getMachineName(): string {
  return hostname().replace(LOCAL_SUFFIX_RE, "");
}

async function findEndpointBySlug(slug: string): Promise<Endpoint> {
  const endpoints = await fetchEndpoints();
  const found = endpoints.find((ep) => ep.slug === slug);
  if (found) {
    return found;
  }

  // Auto-create the endpoint when it doesn't exist yet
  const created = await rpcClient.endpoints.create({ name: slug, slug });
  return created as unknown as Endpoint;
}

const MACHINE_NAME_SUFFIX_RE = /^(.+)-(\d+)$/;

async function findOrCreateMachine(
  endpointId: string,
  forwardUrl: string,
  nameOverride?: string
): Promise<Machine> {
  const baseName = nameOverride ?? getMachineName();
  const machines = await fetchMachines(endpointId);

  // Find an existing offline machine with this base name (or base-N variant)
  // that we can reuse, so we don't leak machine records.
  const ownMachines = machines.filter((m) => {
    if (m.name === baseName) {
      return true;
    }
    const match = MACHINE_NAME_SUFFIX_RE.exec(m.name);
    return match?.[1] === baseName;
  });

  const offlineMachine = ownMachines.find((m) => m.status === "offline");
  if (offlineMachine) {
    // Reuse an offline machine, updating forward URL if needed
    if (offlineMachine.forwardUrl !== forwardUrl) {
      const updated = await rpcClient.machines.update({
        id: offlineMachine.id,
        forwardUrl,
      });
      return updated as unknown as Machine;
    }
    return offlineMachine;
  }

  // All existing machines with this name are online — create a new one
  // with an incremented suffix: MacBook-Pro-2, MacBook-Pro-3, etc.
  let nextName = baseName;
  if (ownMachines.length > 0) {
    nextName = `${baseName}-${ownMachines.length + 1}`;
  }

  return registerMachine(endpointId, nextName, forwardUrl);
}

// ---------------------------------------------------------------------------
// CLI command handlers (non-interactive)
// ---------------------------------------------------------------------------

async function handleLoginCommand(): Promise<never> {
  const readline = await import("node:readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const ask = (q: string): Promise<string> =>
    new Promise((resolve) => rl.question(q, resolve));

  console.log("tunnelhook login");
  console.log(`Server: ${SERVER_URL}\n`);

  const email = await ask("Email: ");
  const password = await ask("Password: ");
  rl.close();

  console.log("\nSigning in...");
  const result = await signIn(email, password);

  if (result.success) {
    console.log(
      "Logged in successfully. Session saved to ~/.tunnelhook/session.json"
    );
  } else {
    console.error(`Login failed: ${result.error ?? "Unknown error"}`);
    process.exit(1);
  }

  process.exit(0);
}

async function handleListenCommand(
  slug: string,
  forwardUrl: string,
  machineNameOverride?: string
): Promise<{ endpoint: Endpoint; machine: Machine }> {
  // Validate session
  const valid = await validateSession();
  if (!valid) {
    console.error(
      "Not logged in or session expired. Run `tunnelhook login` first."
    );
    process.exit(1);
  }

  // Resolve endpoint
  const endpoint = await findEndpointBySlug(slug);

  // Find or create machine
  const machine = await findOrCreateMachine(
    endpoint.id,
    forwardUrl,
    machineNameOverride
  );

  return { endpoint, machine };
}

// ---------------------------------------------------------------------------
// WebSocket helpers
// ---------------------------------------------------------------------------

interface WebhookMessage {
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

interface DeliveryResultMessage {
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

interface MachineStatusMessage {
  machineId: string;
  machineName: string;
  status: "online" | "offline";
  type: "machine-status";
}

type ServerMessage =
  | WebhookMessage
  | DeliveryResultMessage
  | MachineStatusMessage;

/**
 * Forward a webhook to a local URL and return the result.
 */
async function forwardWebhookLocally(
  forwardUrl: string,
  msg: WebhookMessage
): Promise<{
  duration: number;
  error: string | null;
  responseBody: string | null;
  responseStatus: number | null;
  status: "delivered" | "failed";
}> {
  const startTime = Date.now();
  try {
    let parsedHeaders: Record<string, string> = {};
    try {
      parsedHeaders = JSON.parse(msg.headers) as Record<string, string>;
    } catch {
      // Use empty headers
    }

    // Remove host header to avoid conflicts
    const { host: _host, ...forwardHeaders } = parsedHeaders;

    const res = await fetch(forwardUrl, {
      method: msg.method,
      headers: {
        ...forwardHeaders,
        host: new URL(forwardUrl).host,
        "x-tunnelhook-event-id": msg.eventId,
        "x-tunnelhook-delivery-id": msg.deliveryId,
      },
      body:
        msg.method !== "GET" && msg.method !== "HEAD" ? msg.body : undefined,
    });

    const duration = Date.now() - startTime;
    let responseBody: string | null = null;
    try {
      responseBody = await res.text();
      if (responseBody.length > 10_000) {
        responseBody = responseBody.slice(0, 10_000);
      }
    } catch {
      // No response body
    }

    return {
      status: res.ok ? "delivered" : "failed",
      responseStatus: res.status,
      responseBody,
      error: null,
      duration,
    };
  } catch (err) {
    const duration = Date.now() - startTime;
    return {
      status: "failed",
      responseStatus: null,
      responseBody: null,
      error: err instanceof Error ? err.message : "Unknown error",
      duration,
    };
  }
}

// ---------------------------------------------------------------------------
// Color theme
// ---------------------------------------------------------------------------

const COLORS = {
  bg: "#0d1117",
  panel: "#161b22",
  border: "#30363d",
  text: "#c9d1d9",
  textDim: "#8b949e",
  accent: "#58a6ff",
  accentBright: "#79c0ff",
  green: "#3fb950",
  red: "#f85149",
  yellow: "#d29922",
  purple: "#bc8cff",
};

const METHOD_COLORS: Record<string, string> = {
  GET: "#3fb950",
  POST: "#58a6ff",
  PUT: "#d29922",
  PATCH: "#d29922",
  DELETE: "#f85149",
};

function methodColor(method: string): string {
  return METHOD_COLORS[method.toUpperCase()] ?? COLORS.text;
}

function statusColor(status: number | null): string {
  if (status === null) {
    return COLORS.textDim;
  }
  if (status >= 200 && status < 300) {
    return COLORS.green;
  }
  if (status >= 300 && status < 400) {
    return COLORS.yellow;
  }
  return COLORS.red;
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

function StatusBar({
  screen,
  endpointName,
}: {
  screen: Screen;
  endpointName?: string;
}) {
  const breadcrumbMap: Record<Screen, string> = {
    login: "Login",
    endpoints: "Endpoints",
    "machine-setup": `${endpointName ?? "..."} > Machine Setup`,
    monitor: `${endpointName ?? "..."} > Live Monitor`,
    "event-detail": `${endpointName ?? "..."} > Detail`,
  };
  const breadcrumb = breadcrumbMap[screen];

  return (
    <box
      backgroundColor={COLORS.accent}
      flexDirection="row"
      height={1}
      justifyContent="space-between"
      paddingX={1}
    >
      <text fg="#ffffff">
        <strong>tunnelhook</strong>
      </text>
      <text fg="#ffffff">{breadcrumb}</text>
      <text fg="#ffffff">
        {screen === "login" ? "Enter:submit Tab:switch" : "q:quit esc:back"}
      </text>
    </box>
  );
}

function HelpBar({ screen }: { screen: Screen }) {
  const hints: Record<Screen, string> = {
    login: "Tab: switch fields  Enter: submit",
    endpoints: "j/k: navigate  Enter: select  n: new  r: refresh  q: quit",
    "machine-setup": "j/k: navigate  Enter: select  n: new machine  esc: back",
    monitor: "j/k: navigate  Enter: detail  esc: back  q: quit",
    "event-detail":
      "1: body  2: headers  3: deliveries  Tab: switch  esc: back",
  };

  return (
    <box
      backgroundColor={COLORS.panel}
      flexDirection="row"
      gap={2}
      height={1}
      paddingX={1}
    >
      <text fg={COLORS.textDim}>{hints[screen]}</text>
    </box>
  );
}

// ---------------------------------------------------------------------------
// Login Screen
// ---------------------------------------------------------------------------

function LoginScreen({ onLogin }: { onLogin: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [focusField, setFocusField] = useState<"email" | "password">("email");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = useCallback(() => {
    if (loading) {
      return;
    }
    setLoading(true);
    setError(null);
    signIn(email, password).then((result) => {
      setLoading(false);
      if (result.success) {
        onLogin();
      } else {
        setError(result.error ?? "Login failed");
      }
    });
  }, [email, password, loading, onLogin]);

  useKeyboard((key) => {
    if (key.name === "tab") {
      setFocusField((prev: "email" | "password") =>
        prev === "email" ? "password" : "email"
      );
    }
    if ((key.name === "enter" || key.name === "return") && !loading) {
      handleSubmit();
    }
  });

  return (
    <box
      alignItems="center"
      backgroundColor={COLORS.bg}
      flexGrow={1}
      justifyContent="center"
    >
      <box
        backgroundColor={COLORS.panel}
        border
        borderColor={COLORS.border}
        borderStyle="rounded"
        padding={2}
        width={50}
      >
        <box flexDirection="column" gap={1}>
          <ascii-font color={COLORS.accent} font="tiny" text="tunnelhook" />
          <text fg={COLORS.textDim}>
            Sign in to manage your webhook endpoints
          </text>

          <box height={1} />

          <text fg={COLORS.text}>Email</text>
          <input
            backgroundColor={COLORS.bg}
            focused={focusField === "email"}
            focusedBackgroundColor="#1c2128"
            onChange={setEmail}
            placeholder="you@example.com"
            textColor={COLORS.text}
            value={email}
            width={40}
          />

          <text fg={COLORS.text}>Password</text>
          <input
            backgroundColor={COLORS.bg}
            focused={focusField === "password"}
            focusedBackgroundColor="#1c2128"
            onChange={setPassword}
            placeholder="password"
            textColor={COLORS.text}
            value={password}
            width={40}
          />

          {error ? <text fg={COLORS.red}>{error}</text> : null}
          {loading ? (
            <text fg={COLORS.yellow}>Signing in...</text>
          ) : (
            <text fg={COLORS.textDim}>
              Press Enter to sign in, Tab to switch fields
            </text>
          )}
        </box>
      </box>
    </box>
  );
}

// ---------------------------------------------------------------------------
// Endpoints List Screen
// ---------------------------------------------------------------------------

function EndpointsScreen({
  onSelect,
  onQuit,
}: {
  onSelect: (ep: Endpoint) => void;
  onQuit: () => void;
}) {
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  const loadEndpoints = useCallback(() => {
    setLoading(true);
    fetchEndpoints()
      .then((eps: Endpoint[]) => {
        setEndpoints(eps);
        setError(null);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadEndpoints();
  }, [loadEndpoints]);

  const handleCreatingKey = useCallback(
    (key: { name: string }) => {
      if (key.name === "escape") {
        setCreating(false);
        setNewName("");
      }
      if ((key.name === "enter" || key.name === "return") && newName.trim()) {
        createEndpointApi(newName.trim())
          .then(() => {
            setCreating(false);
            setNewName("");
            loadEndpoints();
          })
          .catch((err: Error) => setError(err.message));
      }
    },
    [newName, loadEndpoints]
  );

  const isEnter = (name: string) => name === "enter" || name === "return";

  useKeyboard((key) => {
    if (creating) {
      handleCreatingKey(key);
      return;
    }

    if (key.name === "q" || (key.ctrl && key.name === "c")) {
      onQuit();
      return;
    }

    if (key.name === "j" || key.name === "down") {
      setSelectedIndex((idx: number) =>
        Math.min(endpoints.length - 1, idx + 1)
      );
    }
    if (key.name === "k" || key.name === "up") {
      setSelectedIndex((idx: number) => Math.max(0, idx - 1));
    }
    if (isEnter(key.name) && endpoints[selectedIndex]) {
      onSelect(endpoints[selectedIndex]);
    }
    if (key.name === "n") {
      setCreating(true);
    }
    if (key.name === "r") {
      loadEndpoints();
    }
  });

  const { height } = useTerminalDimensions();

  return (
    <box backgroundColor={COLORS.bg} flexDirection="column" flexGrow={1}>
      <box flexDirection="row" gap={2} height={3} paddingX={1} paddingY={1}>
        <text fg={COLORS.text}>
          <strong>Webhook Endpoints</strong>
        </text>
        <text fg={COLORS.textDim}>({endpoints.length} total)</text>
        {loading ? <text fg={COLORS.yellow}>loading...</text> : null}
      </box>

      {creating ? (
        <box flexDirection="row" gap={1} height={3} paddingX={1}>
          <text fg={COLORS.accent}>New endpoint name:</text>
          <input
            backgroundColor={COLORS.bg}
            focused
            focusedBackgroundColor="#1c2128"
            onChange={setNewName}
            placeholder="My Webhook"
            textColor={COLORS.text}
            value={newName}
            width={30}
          />
          <text fg={COLORS.textDim}>(enter to create, esc to cancel)</text>
        </box>
      ) : null}

      {error ? (
        <box height={1} paddingX={1}>
          <text fg={COLORS.red}>Error: {error}</text>
        </box>
      ) : null}

      <scrollbox focused={!creating} height={height - 8}>
        {endpoints.map((ep: Endpoint, idx: number) => (
          <box
            alignItems="center"
            backgroundColor={idx === selectedIndex ? "#1c2128" : "transparent"}
            flexDirection="row"
            gap={2}
            height={3}
            key={ep.id}
            paddingX={2}
            paddingY={0}
          >
            <text
              fg={idx === selectedIndex ? COLORS.accent : COLORS.text}
              width={3}
            >
              {idx === selectedIndex ? " > " : "   "}
            </text>
            <box flexDirection="column" flexGrow={1}>
              <text
                fg={idx === selectedIndex ? COLORS.accentBright : COLORS.text}
              >
                <strong>{ep.name}</strong>
              </text>
              <text fg={COLORS.textDim}>
                {SERVER_URL}/hooks/{ep.slug}
              </text>
            </box>
            <text fg={ep.enabled ? COLORS.green : COLORS.red}>
              {ep.enabled ? "active" : "disabled"}
            </text>
          </box>
        ))}
        {endpoints.length === 0 && !loading ? (
          <box paddingX={2} paddingY={1}>
            <text fg={COLORS.textDim}>
              No endpoints yet. Press 'n' to create one.
            </text>
          </box>
        ) : null}
      </scrollbox>
    </box>
  );
}

// ---------------------------------------------------------------------------
// Machine Setup Screen
// ---------------------------------------------------------------------------

function MachineSetupScreen({
  endpoint: ep,
  onConnect,
  onBack,
  onQuit,
}: {
  endpoint: Endpoint;
  onConnect: (machine: Machine) => void;
  onBack: () => void;
  onQuit: () => void;
}) {
  const [machines, setMachines] = useState<Machine[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newUrl, setNewUrl] = useState("http://localhost:3000/webhook");
  const [createFocus, setCreateFocus] = useState<"name" | "url">("name");
  const [error, setError] = useState<string | null>(null);

  const loadMachines = useCallback(() => {
    setLoading(true);
    fetchMachines(ep.id)
      .then((ms: Machine[]) => {
        setMachines(ms);
        setError(null);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [ep.id]);

  useEffect(() => {
    loadMachines();
  }, [loadMachines]);

  const handleCreateSubmit = useCallback(() => {
    if (!(newName.trim() && newUrl.trim())) {
      return;
    }
    setError(null);
    registerMachine(ep.id, newName.trim(), newUrl.trim())
      .then((m: Machine) => {
        setCreating(false);
        setNewName("");
        setNewUrl("http://localhost:3000/webhook");
        onConnect(m);
      })
      .catch((err: Error) => setError(err.message));
  }, [ep.id, newName, newUrl, onConnect]);

  const isEnter = (name: string) => name === "enter" || name === "return";

  useKeyboard((key) => {
    if (creating) {
      if (key.name === "escape") {
        setCreating(false);
        setNewName("");
        setNewUrl("http://localhost:3000/webhook");
        return;
      }
      if (key.name === "tab") {
        setCreateFocus((prev) => (prev === "name" ? "url" : "name"));
        return;
      }
      if (isEnter(key.name)) {
        handleCreateSubmit();
        return;
      }
      return;
    }

    if (key.name === "q" || (key.ctrl && key.name === "c")) {
      onQuit();
      return;
    }
    if (key.name === "escape") {
      onBack();
      return;
    }

    if (key.name === "j" || key.name === "down") {
      setSelectedIndex((idx: number) => Math.min(machines.length - 1, idx + 1));
    }
    if (key.name === "k" || key.name === "up") {
      setSelectedIndex((idx: number) => Math.max(0, idx - 1));
    }
    if (isEnter(key.name) && machines[selectedIndex]) {
      onConnect(machines[selectedIndex]);
    }
    if (key.name === "n") {
      setCreating(true);
    }
  });

  const { height } = useTerminalDimensions();

  return (
    <box backgroundColor={COLORS.bg} flexDirection="column" flexGrow={1}>
      <box
        border
        borderColor={COLORS.border}
        flexDirection="column"
        height={4}
        paddingX={1}
      >
        <text fg={COLORS.text}>
          <strong>Select or create a machine for: {ep.name}</strong>
        </text>
        <text fg={COLORS.textDim}>
          Machines forward webhooks to a local URL on your computer
        </text>
      </box>

      {creating ? (
        <box
          border
          borderColor={COLORS.accent}
          flexDirection="column"
          gap={1}
          marginX={1}
          marginY={1}
          padding={1}
        >
          <text fg={COLORS.accent}>
            <strong>Register New Machine</strong>
          </text>
          <text fg={COLORS.text}>Machine Name</text>
          <input
            backgroundColor={COLORS.bg}
            focused={createFocus === "name"}
            focusedBackgroundColor="#1c2128"
            onChange={setNewName}
            placeholder="My MacBook"
            textColor={COLORS.text}
            value={newName}
            width={40}
          />
          <text fg={COLORS.text}>Forward URL</text>
          <input
            backgroundColor={COLORS.bg}
            focused={createFocus === "url"}
            focusedBackgroundColor="#1c2128"
            onChange={setNewUrl}
            placeholder="http://localhost:3000/webhook"
            textColor={COLORS.text}
            value={newUrl}
            width={50}
          />
          {error ? <text fg={COLORS.red}>{error}</text> : null}
          <text fg={COLORS.textDim}>
            Enter: create and connect | Tab: switch fields | Esc: cancel
          </text>
        </box>
      ) : null}

      <scrollbox focused={!creating} height={height - (creating ? 18 : 8)}>
        {machines.map((m: Machine, idx: number) => (
          <box
            alignItems="center"
            backgroundColor={idx === selectedIndex ? "#1c2128" : "transparent"}
            flexDirection="row"
            gap={2}
            height={3}
            key={m.id}
            paddingX={2}
          >
            <text
              fg={idx === selectedIndex ? COLORS.accent : COLORS.text}
              width={3}
            >
              {idx === selectedIndex ? " > " : "   "}
            </text>
            <box flexDirection="column" flexGrow={1}>
              <text
                fg={idx === selectedIndex ? COLORS.accentBright : COLORS.text}
              >
                <strong>{m.name}</strong>
              </text>
              <text fg={COLORS.textDim}>{m.forwardUrl}</text>
            </box>
            <text fg={m.status === "online" ? COLORS.green : COLORS.textDim}>
              {m.status}
            </text>
          </box>
        ))}
        {machines.length === 0 && !loading ? (
          <box paddingX={2} paddingY={1}>
            <text fg={COLORS.textDim}>
              No machines registered. Press 'n' to create one.
            </text>
          </box>
        ) : null}
        {loading ? (
          <box paddingX={2} paddingY={1}>
            <text fg={COLORS.yellow}>Loading machines...</text>
          </box>
        ) : null}
      </scrollbox>
    </box>
  );
}

// ---------------------------------------------------------------------------
// Live Monitor Screen (WebSocket machine connection)
// ---------------------------------------------------------------------------

interface MonitorEvent {
  deliveryId: string;
  deliveryResult?: DeliveryResult;
  event: WebhookEvent;
  eventId: string;
}

function MonitorScreen({
  endpoint: ep,
  machine: mach,
  onBack,
  onSelectEvent,
  onQuit,
}: {
  endpoint: Endpoint;
  machine: Machine;
  onBack: () => void;
  onSelectEvent: (evt: MonitorEvent) => void;
  onQuit: () => void;
}) {
  const [events, setEvents] = useState<MonitorEvent[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [connected, setConnected] = useState(false);
  const [wsStatus, setWsStatus] = useState<string>("connecting...");
  const wsRef = useRef<WebSocket | null>(null);

  // Connect to WebSocket as a machine
  useEffect(() => {
    const wsUrl = `${WS_URL}/hooks/${ep.slug}/ws?role=machine&machineId=${mach.id}&machineName=${encodeURIComponent(mach.name)}`;

    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl, {
        headers: getAuthHeaders(),
      } as unknown as string[]);
    } catch {
      setWsStatus("failed to create WebSocket");
      return;
    }

    wsRef.current = ws;

    ws.addEventListener("open", () => {
      setConnected(true);
      setWsStatus("connected");
    });

    ws.addEventListener("message", (msgEvent) => {
      const data = msgEvent.data;
      if (typeof data !== "string") {
        return;
      }

      let parsed: ServerMessage;
      try {
        parsed = JSON.parse(data) as ServerMessage;
      } catch {
        return;
      }

      if (parsed.type === "webhook") {
        const webhookMsg = parsed as WebhookMessage;
        const monitorEvent: MonitorEvent = {
          eventId: webhookMsg.eventId,
          deliveryId: webhookMsg.deliveryId,
          event: {
            method: webhookMsg.method,
            headers: webhookMsg.headers,
            body: webhookMsg.body,
            query: webhookMsg.query,
            contentType: webhookMsg.contentType,
            sourceIp: webhookMsg.sourceIp,
            createdAt: webhookMsg.createdAt,
          },
        };

        setEvents((prev) => [monitorEvent, ...prev]);

        // Forward locally and report back
        forwardWebhookLocally(mach.forwardUrl, webhookMsg).then((result) => {
          // Send delivery report back via WebSocket
          const report = {
            type: "delivery-report" as const,
            eventId: webhookMsg.eventId,
            deliveryId: webhookMsg.deliveryId,
            status: result.status,
            responseStatus: result.responseStatus,
            responseBody: result.responseBody,
            error: result.error,
            duration: result.duration,
          };

          try {
            ws.send(JSON.stringify(report));
          } catch {
            // WebSocket closed
          }

          // Also persist via oRPC
          reportDeliveryResult({
            deliveryId: webhookMsg.deliveryId,
            status: result.status,
            responseStatus: result.responseStatus,
            responseBody: result.responseBody,
            error: result.error,
            duration: result.duration,
          }).catch(() => {
            // Non-critical — delivery result already sent via WS
          });

          // Update local state with delivery result
          setEvents((prev) =>
            prev.map((e) =>
              e.deliveryId === webhookMsg.deliveryId
                ? {
                    ...e,
                    deliveryResult: {
                      deliveryId: webhookMsg.deliveryId,
                      eventId: webhookMsg.eventId,
                      machineId: mach.id,
                      machineName: mach.name,
                      status: result.status,
                      responseStatus: result.responseStatus,
                      responseBody: result.responseBody,
                      error: result.error,
                      duration: result.duration,
                    },
                  }
                : e
            )
          );
        });
      }

      if (parsed.type === "delivery-result") {
        // Delivery result from another machine — update if we have the event
        const resultMsg = parsed as DeliveryResultMessage;
        setEvents((prev) =>
          prev.map((e) =>
            e.eventId === resultMsg.eventId && !e.deliveryResult
              ? {
                  ...e,
                  deliveryResult: {
                    deliveryId: resultMsg.deliveryId,
                    eventId: resultMsg.eventId,
                    machineId: resultMsg.machineId,
                    machineName: resultMsg.machineName,
                    status: resultMsg.status,
                    responseStatus: resultMsg.responseStatus,
                    responseBody: resultMsg.responseBody,
                    error: resultMsg.error,
                    duration: resultMsg.duration,
                  },
                }
              : e
          )
        );
      }
    });

    ws.addEventListener("close", () => {
      setConnected(false);
      setWsStatus("disconnected");
    });

    ws.addEventListener("error", () => {
      setWsStatus("connection error");
    });

    return () => {
      ws.close();
    };
  }, [ep.slug, mach.id, mach.name, mach.forwardUrl]);

  useKeyboard((key) => {
    if (key.name === "q" || (key.ctrl && key.name === "c")) {
      onQuit();
      return;
    }
    if (key.name === "escape") {
      onBack();
      return;
    }
    if (key.name === "j" || key.name === "down") {
      setSelectedIndex((idx: number) => Math.min(events.length - 1, idx + 1));
    }
    if (key.name === "k" || key.name === "up") {
      setSelectedIndex((idx: number) => Math.max(0, idx - 1));
    }
    if (
      (key.name === "enter" || key.name === "return") &&
      events[selectedIndex]
    ) {
      onSelectEvent(events[selectedIndex]);
    }
  });

  const { width, height } = useTerminalDimensions();
  const webhookUrl = `${SERVER_URL}/hooks/${ep.slug}`;

  return (
    <box backgroundColor={COLORS.bg} flexDirection="column" flexGrow={1}>
      {/* Header */}
      <box
        border
        borderColor={COLORS.border}
        flexDirection="column"
        height={6}
        paddingX={1}
        paddingY={1}
      >
        <box flexDirection="row" gap={2}>
          <text fg={COLORS.text}>
            <strong>{ep.name}</strong>
          </text>
          <text fg={connected ? COLORS.green : COLORS.yellow}>
            [ {wsStatus} ]
          </text>
        </box>
        <text fg={COLORS.accent}>{webhookUrl}</text>
        <box flexDirection="row" gap={2}>
          <text fg={COLORS.textDim}>
            Machine: <span fg={COLORS.purple}>{mach.name}</span>
          </text>
          <text fg={COLORS.textDim}>
            Forward: <span fg={COLORS.accent}>{mach.forwardUrl}</span>
          </text>
        </box>
        <text fg={COLORS.textDim}>
          {events.length} events received this session
        </text>
      </box>

      {/* Events list */}
      <scrollbox focused height={height - 10}>
        {events.map((me: MonitorEvent, idx: number) => {
          const time = new Date(me.event.createdAt).toLocaleTimeString();
          const dr = me.deliveryResult;

          let statusText = "pending";
          let statusFg = COLORS.yellow;
          if (dr) {
            statusText =
              dr.status === "delivered"
                ? `${String(dr.responseStatus ?? "?")} ${dr.duration ?? "?"}ms`
                : `failed${dr.error ? `: ${dr.error.slice(0, 30)}` : ""}`;
            statusFg =
              dr.status === "delivered"
                ? statusColor(dr.responseStatus)
                : COLORS.red;
          }

          let bodyPreview = "";
          if (me.event.body) {
            try {
              const parsed = JSON.parse(me.event.body);
              bodyPreview = JSON.stringify(parsed).slice(
                0,
                Math.max(0, width - 60)
              );
            } catch {
              bodyPreview = me.event.body.slice(0, Math.max(0, width - 60));
            }
          }

          return (
            <box
              alignItems="center"
              backgroundColor={
                idx === selectedIndex ? "#1c2128" : "transparent"
              }
              flexDirection="row"
              gap={1}
              height={2}
              key={me.deliveryId}
              paddingX={2}
            >
              <text
                fg={idx === selectedIndex ? COLORS.accent : COLORS.textDim}
                width={3}
              >
                {idx === selectedIndex ? " > " : "   "}
              </text>
              <text fg={methodColor(me.event.method)} width={7}>
                <strong>{me.event.method.padEnd(6)}</strong>
              </text>
              <text fg={COLORS.textDim} width={10}>
                {time}
              </text>
              <text fg={statusFg} width={20}>
                {statusText}
              </text>
              <text fg={COLORS.text}>{bodyPreview || "(no body)"}</text>
            </box>
          );
        })}
        {events.length === 0 ? (
          <box padding={2}>
            <text fg={COLORS.textDim}>
              Waiting for webhooks... Send a request to: {webhookUrl}
            </text>
          </box>
        ) : null}
      </scrollbox>
    </box>
  );
}

// ---------------------------------------------------------------------------
// Event Detail Screen
// ---------------------------------------------------------------------------

function EventDetailScreen({
  monitorEvent,
  onBack,
  onQuit,
}: {
  monitorEvent: MonitorEvent;
  onBack: () => void;
  onQuit: () => void;
}) {
  const [tab, setTab] = useState<"body" | "headers" | "delivery">("body");
  const evt = monitorEvent.event;
  const dr = monitorEvent.deliveryResult;

  useKeyboard((key) => {
    if (key.name === "q" || (key.ctrl && key.name === "c")) {
      onQuit();
      return;
    }
    if (key.name === "escape") {
      onBack();
      return;
    }
    if (key.name === "1") {
      setTab("body");
    }
    if (key.name === "2") {
      setTab("headers");
    }
    if (key.name === "3") {
      setTab("delivery");
    }
    if (key.name === "tab") {
      setTab((prev) => {
        if (prev === "body") {
          return "headers";
        }
        if (prev === "headers") {
          return "delivery";
        }
        return "body";
      });
    }
  });

  const time = new Date(evt.createdAt).toLocaleString();
  let formattedBody = evt.body ?? "(no body)";
  try {
    if (evt.body) {
      formattedBody = JSON.stringify(JSON.parse(evt.body), null, 2);
    }
  } catch {
    // Use raw body
  }

  let formattedHeaders = "{}";
  try {
    formattedHeaders = JSON.stringify(JSON.parse(evt.headers), null, 2);
  } catch {
    formattedHeaders = evt.headers;
  }

  let deliveryContent = "No delivery result yet (pending)";
  if (dr) {
    const deliveryInfo = {
      deliveryId: dr.deliveryId,
      status: dr.status,
      machineId: dr.machineId,
      machineName: dr.machineName,
      responseStatus: dr.responseStatus,
      duration: dr.duration ? `${dr.duration}ms` : null,
      error: dr.error,
      responseBody: dr.responseBody,
    };
    deliveryContent = JSON.stringify(deliveryInfo, null, 2);
  }

  let content: string;
  if (tab === "body") {
    content = formattedBody;
  } else if (tab === "headers") {
    content = formattedHeaders;
  } else {
    content = deliveryContent;
  }

  const { height } = useTerminalDimensions();

  return (
    <box backgroundColor={COLORS.bg} flexDirection="column" flexGrow={1}>
      {/* Meta info */}
      <box
        border
        borderColor={COLORS.border}
        flexDirection="column"
        height={5}
        paddingX={1}
        paddingY={1}
      >
        <box flexDirection="row" gap={2}>
          <text fg={methodColor(evt.method)}>
            <strong>{evt.method}</strong>
          </text>
          <text fg={COLORS.text}>{monitorEvent.eventId}</text>
          {dr ? (
            <text fg={dr.status === "delivered" ? COLORS.green : COLORS.red}>
              {dr.status} {dr.responseStatus ?? ""}{" "}
              {dr.duration ? `${dr.duration}ms` : ""}
            </text>
          ) : (
            <text fg={COLORS.yellow}>pending</text>
          )}
        </box>
        <box flexDirection="row" gap={2}>
          <text fg={COLORS.textDim}>{time}</text>
          <text fg={COLORS.textDim}>
            {evt.contentType ?? "no content-type"}
          </text>
          {evt.sourceIp ? (
            <text fg={COLORS.textDim}>from {evt.sourceIp}</text>
          ) : null}
        </box>
        <box flexDirection="row" gap={2}>
          <text fg={tab === "body" ? COLORS.accent : COLORS.textDim}>
            [1] Body
          </text>
          <text fg={tab === "headers" ? COLORS.accent : COLORS.textDim}>
            [2] Headers
          </text>
          <text fg={tab === "delivery" ? COLORS.accent : COLORS.textDim}>
            [3] Delivery
          </text>
        </box>
      </box>

      {/* Content */}
      <scrollbox focused height={height - 9}>
        <box padding={1}>
          {content.split("\n").map((line: string, idx: number) => (
            <box flexDirection="row" key={`line-${String(idx)}`}>
              <text fg={COLORS.textDim} width={5}>
                {String(idx + 1).padStart(4)}
              </text>
              <text fg={COLORS.text}>{line}</text>
            </box>
          ))}
        </box>
      </scrollbox>
    </box>
  );
}

// ---------------------------------------------------------------------------
// App root
// ---------------------------------------------------------------------------

interface AppProps {
  /** Pre-resolved endpoint for direct CLI mode */
  initialEndpoint?: Endpoint;
  /** Pre-resolved machine for direct CLI mode */
  initialMachine?: Machine;
}

function getStartScreen(hasDirectMode: boolean): Screen {
  if (hasDirectMode) {
    return "monitor";
  }
  if (authCookies) {
    return "endpoints";
  }
  return "login";
}

function App({ initialEndpoint, initialMachine }: AppProps) {
  const renderer = useRenderer();

  // If we have initial endpoint + machine, skip straight to monitor
  const hasDirectMode = Boolean(initialEndpoint && initialMachine);
  const startScreen = getStartScreen(hasDirectMode);

  const [screen, setScreen] = useState<Screen>(startScreen);
  const [selectedEndpoint, setSelectedEndpoint] = useState<Endpoint | null>(
    initialEndpoint ?? null
  );
  const [selectedMachine, setSelectedMachine] = useState<Machine | null>(
    initialMachine ?? null
  );
  const [selectedEvent, setSelectedEvent] = useState<MonitorEvent | null>(null);
  const [sessionChecked, setSessionChecked] = useState(hasDirectMode);

  // On interactive mode, validate session before showing endpoints
  useEffect(() => {
    if (hasDirectMode || sessionChecked) {
      return;
    }
    if (!authCookies) {
      setSessionChecked(true);
      return;
    }
    validateSession().then((valid) => {
      if (valid) {
        setScreen("endpoints");
      } else {
        authCookies = null;
        setScreen("login");
      }
      setSessionChecked(true);
    });
  }, [hasDirectMode, sessionChecked]);

  const handleQuit = useCallback(() => {
    renderer.destroy();
  }, [renderer]);

  return (
    <box backgroundColor={COLORS.bg} flexDirection="column" flexGrow={1}>
      <StatusBar endpointName={selectedEndpoint?.name} screen={screen} />

      {screen === "login" ? (
        <LoginScreen onLogin={() => setScreen("endpoints")} />
      ) : null}

      {screen === "endpoints" ? (
        <EndpointsScreen
          onQuit={handleQuit}
          onSelect={(ep: Endpoint) => {
            setSelectedEndpoint(ep);
            setScreen("machine-setup");
          }}
        />
      ) : null}

      {screen === "machine-setup" && selectedEndpoint ? (
        <MachineSetupScreen
          endpoint={selectedEndpoint}
          onBack={() => {
            setScreen("endpoints");
            setSelectedEndpoint(null);
          }}
          onConnect={(m: Machine) => {
            setSelectedMachine(m);
            setScreen("monitor");
          }}
          onQuit={handleQuit}
        />
      ) : null}

      {screen === "monitor" && selectedEndpoint && selectedMachine ? (
        <MonitorScreen
          endpoint={selectedEndpoint}
          machine={selectedMachine}
          onBack={() => {
            // In direct mode, quit instead of going back
            if (hasDirectMode) {
              handleQuit();
              return;
            }
            setScreen("machine-setup");
            setSelectedMachine(null);
          }}
          onQuit={handleQuit}
          onSelectEvent={(evt: MonitorEvent) => {
            setSelectedEvent(evt);
            setScreen("event-detail");
          }}
        />
      ) : null}

      {screen === "event-detail" && selectedEvent ? (
        <EventDetailScreen
          monitorEvent={selectedEvent}
          onBack={() => {
            setScreen("monitor");
            setSelectedEvent(null);
          }}
          onQuit={handleQuit}
        />
      ) : null}

      <HelpBar screen={screen} />
    </box>
  );
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

if (cliArgs.command === "login") {
  await handleLoginCommand();
} else if (cliArgs.command === "listen" && cliArgs.slug && cliArgs.forwardUrl) {
  // Direct mode: resolve endpoint + machine, then launch TUI at monitor screen
  const { endpoint, machine } = await handleListenCommand(
    cliArgs.slug,
    cliArgs.forwardUrl,
    cliArgs.machineName
  );

  console.log(
    `Forwarding ${SERVER_URL}/hooks/${endpoint.slug} -> ${machine.forwardUrl}`
  );
  console.log(`Machine: ${machine.name} (${machine.id})\n`);

  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  createRoot(renderer).render(
    <App initialEndpoint={endpoint} initialMachine={machine} />
  );
} else {
  // Interactive TUI mode
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  createRoot(renderer).render(<App />);
}
