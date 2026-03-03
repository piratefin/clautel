# Security

## Network Connections

| Destination | What's sent | Source file |
|---|---|---|
| `api.telegram.org` | Messages, photos, documents via long polling + bot token in URL path | `worker.ts`, `manager.ts`, `cli.ts` |
| `license.clautel.com` | License key + hashed instance ID (SHA-256 of hostname\|platform\|arch\|ownerId) | `license.ts` |
| Anthropic API | Prompts + project files (via Claude Agent SDK) | `claude.ts` |
| `ngrok.com` | Local port tunnel (only when user runs `/preview`) | `tunnel.ts` |

No telemetry, no analytics, no tracking. All outbound URLs are hardcoded — no dynamic endpoint construction from user input.

## What Data Is Sent Where

- **Telegram**: Your messages, photos, documents. Bot token authenticates requests.
- **License proxy**: Only `license_key` + `instance_id` (a 16-char hash). No message content, no usage data, no IP logging.
- **Anthropic**: Whatever Claude needs to answer your prompt (handled by the Claude Agent SDK, same as CLI `claude` usage).
- **ngrok**: Only the TCP tunnel to your local port. User-initiated only.

## Local File Storage

Everything lives in `~/.clautel/` (directory mode `0700`):

| File | Contents | Permissions |
|---|---|---|
| `config.json` | Bot token, owner ID, ngrok token, Anthropic API key | `0600` |
| `license.json` | License key, instance ID, validation state, HMAC checksum | `0600` |
| `bots.json` | Worker bot configs (token, username, working dir) | `0600` |
| `.integrity-key` | Random 64-byte HMAC key (generated on first run) | `0600` |
| `signed-token.json` | Cached Ed25519-signed license token for offline fallback | `0600` |
| `daemon.pid` | Process ID of running daemon | default |
| `state-{botId}.json` | Chat session IDs, token counts, model selection | `0600` |
| `app.log` | Daemon logs (rotated at 5 MB, keeps 3 rotations) | default |

Temporary files (downloaded photos/documents) go to `os.tmpdir()/clautel-{botId}/` and are cleaned up after each query.

## How to Verify

- All source code is in `src/`. The `dist/` folder is unobfuscated compiled JS.
- Run `lsof -i -P | grep node` while the daemon runs to confirm network connections match the table above.
- `grep -r "fetch(" src/` to see every outbound HTTP call.
- `grep -r "process.env" src/` to see every environment variable read.

## Audit Findings

Overall: **no critical vulnerabilities found**.

- **No hardcoded secrets** — only the Ed25519 public key (expected, used to verify server signatures)
- **No command injection** — `spawn()` uses array args, no user input reaches shell
- **No path traversal** — session IDs validated as strict UUID regex, all paths use `path.join()`
- **Input validated** — bot tokens, UUIDs, ports, file sizes all checked before use
- **Authorization** — every bot command checks `TELEGRAM_OWNER_ID` before processing

Minor items (low risk):
- Temp files written without explicit `0600` mode (inherit from OS tmpdir)
- launchd plist is world-readable on macOS (but contains no secrets — only PATH and HOME)
- Error messages in logs could theoretically contain API response details (logs are in user's home dir only)

## Reporting Vulnerabilities

Email: anas5678go@gmail.com — please include steps to reproduce.
