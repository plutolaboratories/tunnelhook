interface ChangelogEntry {
  changes: string[];
  date: string;
  type: "minor" | "patch";
  version: string;
}

export const changelog: ChangelogEntry[] = [
  {
    version: "0.1.2",
    date: "2026-02-19",
    type: "patch",
    changes: [
      "Password masking in TUI and CLI modes",
      "WebSocket reconnection with exponential backoff (1s\u201330s cap)",
      "Secure session file permissions (0o600 file, 0o700 directory)",
      "SSRF header stripping before forwarding (20 sensitive/hop-by-hop headers)",
    ],
  },
  {
    version: "0.1.1",
    date: "2026-02-18",
    type: "patch",
    changes: [
      "Configure custom domains for production deployment",
      "Fix endpoint DO binding and WebSocket connectivity",
    ],
  },
  {
    version: "0.1.0",
    date: "2026-02-17",
    type: "minor",
    changes: [
      "Initial release of tunnelhook CLI/TUI",
      "Three CLI modes: interactive TUI, --endpoint flag, and --endpoint --forward flag",
      "WebSocket-based real-time webhook event streaming",
      "Session persistence with auto-login",
      "Machine auto-naming with human-readable identifiers",
      "Local webhook forwarding with delivery result reporting",
    ],
  },
];

export type { ChangelogEntry };
