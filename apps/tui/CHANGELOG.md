# tunnelhook

## 0.1.2

### Patch Changes

- Security hardening and reliability improvements
  - Password masking in TUI and CLI modes
  - WebSocket reconnection with exponential backoff (1s-30s cap)
  - Secure session file permissions (0o600 file, 0o700 directory)
  - SSRF header stripping before forwarding (20 sensitive/hop-by-hop headers)

## 0.1.1

### Patch Changes

- Configure custom domains for production deployment
- Fix endpoint DO binding and WebSocket connectivity

## 0.1.0

### Minor Changes

- Initial release of tunnelhook CLI/TUI
- Three CLI modes: interactive TUI, `--endpoint` flag, and `--endpoint --forward` flag
- WebSocket-based real-time webhook event streaming
- Session persistence with auto-login
- Machine auto-naming with human-readable identifiers
- Local webhook forwarding with delivery result reporting
