# tunnelhook

A CLI tool for receiving and forwarding webhooks to your local development server.

## Requirements

- [Bun](https://bun.sh) runtime (v1.0.0+)

## Install

```bash
bun add -g tunnelhook
```

## Usage

### Login

```bash
tunnelhook login
```

### Forward webhooks

```bash
tunnelhook <slug> --forward <url>
```

For example:

```bash
tunnelhook stripe-dev --forward http://localhost:3000/webhook
```

This will:
1. Create the endpoint `stripe-dev` if it doesn't exist
2. Register your machine as a listener
3. Forward any incoming webhooks to `http://localhost:3000/webhook`

Your webhook URL will be:
```
https://tunnelhook-server-shkumbinhasani.shkumbinhasani20001439.workers.dev/hooks/stripe-dev
```

### Interactive mode

```bash
tunnelhook
```

Opens the full TUI with endpoint selection, machine setup, and live monitoring.

### Options

- `--forward <url>` -- Local URL to forward webhooks to
- `--machine <name>` -- Custom machine name (defaults to hostname)

### Environment

- `TUNNELHOOK_SERVER_URL` -- Override the server URL (defaults to production)

## License

MIT
