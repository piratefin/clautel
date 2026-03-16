# Clautel

Use [Claude Code](https://github.com/anthropics/claude-code) from your phone via Telegram.

Run one lightweight process on your dev machine. It connects to Telegram via long polling — no server, no public URL, no ngrok. You get a **manager bot** to add/remove project bots, and a **worker bot** per project that gives you full Claude Code access on mobile.

## Install

```bash
npm install -g clautel
```

### Installing a local / patched build

If you changed the source and want to install that build on this machine or another (Mac/Linux):
Build, create a tarball, copy it to the target machine, then install globally:

```bash
npm run build
npm pack
# Copy the generated clautel-2.2.0.tgz to the other machine, then there:
npm install -g ./clautel-2.2.0.tgz
```
Then `clautel` is on your PATH. You can skip copying `node_modules`; `npm install` on the target will fetch dependencies.

## Setup

**1. Create a manager bot** — go to [@BotFather](https://t.me/botfather) → `/newbot` → copy the token.

**2. Get your Telegram user ID** — message [@userinfobot](https://t.me/userinfobot) → copy the number.

**3. Configure and start:**

```bash
clautel setup
clautel start
```

## Usage

DM your manager bot to manage project bots:

| Command | Description |
|---|---|
| `/add TOKEN /path/to/repo` | Attach a new worker bot to a project |
| `/bots` | List active bots |
| `/remove @botname` | Stop and remove a bot |
| `/subscribe` | Get a license or upgrade |
| `/subscription` | View license, billing & cancel |
| `/feedback` | Send feedback or report an issue |
| `/cancel` | Cancel current operation |

Then DM each worker bot directly to use Claude Code:

| Command | Description |
|---|---|
| Send any message | Talk to Claude Code |
| Send a photo/document | Include as context |
| `/model` | Switch model (Opus / Sonnet / Haiku) |
| `/cost` | Show token usage for the session |
| `/session` | Get session ID to continue in CLI |
| `/resume` | Resume a CLI session in Telegram |
| `/preview` | Start dev server and open live preview |
| `/preview <port>` | Open tunnel to a running server |
| `/close` | Close active preview tunnel |
| `/new` | Start a fresh session |
| `/cancel` | Abort current operation |
| `/feedback` | Send feedback or report an issue |

### Live Preview

Preview your dev server on your phone with a public URL — powered by [ngrok](https://ngrok.com).

| Command | Description |
|---|---|
| `/preview` | Claude starts the dev server and opens an ngrok tunnel |
| `/preview <port>` | Open a tunnel to an already-running server |
| `/close` | Close an active preview tunnel |

When you run `/preview` without a port, Claude will automatically start the dev server, set up ngrok, and share the public URL. You can also pass a port directly (e.g. `/preview 3000`) to tunnel an existing server instantly.

You'll be prompted for a free ngrok auth token on first use, or you can set it up during `clautel setup`.

### Session Continuity

Switch seamlessly between CLI and Telegram:

```bash
# Start in CLI, continue on Telegram
claude                        # work on your laptop
# then in Telegram: /resume   # pick it up on your phone

# Start on Telegram, continue in CLI
# in Telegram: /session       # get the session ID
claude --resume <session-id>  # continue in your terminal
```

Conversation history is shown when resuming, so you can pick up where you left off.

## CLI

```bash
clautel setup              # configure token, user ID, and license
clautel start              # start daemon in background
clautel stop               # stop daemon
clautel status             # check if running
clautel logs               # tail logs (Ctrl+C to exit)
clautel activate <key>     # activate a license key
clautel deactivate         # free this machine's activation slot
clautel license            # show current license status
clautel install-service    # install as macOS launchd service
clautel uninstall-service  # remove the launchd service
```

## Updating

```bash
npm install -g clautel@latest
clautel stop && clautel start
```

## Architecture

```
┌─────────────┐      ┌──────────────┐      ┌──────────────────┐
│  Telegram    │◄────►│  Manager Bot │      │  Anthropic API   │
│  (your phone)│      │  (add/remove)│      │  (Claude)        │
└─────────────┘      └──────┬───────┘      └────────▲─────────┘
                            │                        │
                     ┌──────▼───────┐        ┌───────┴────────┐
                     │  Daemon      │───────►│  Claude Agent   │
                     │  (daemon.ts) │        │  SDK (query)    │
                     └──────┬───────┘        └────────────────┘
                            │
                ┌───────────┼───────────┐
                ▼           ▼           ▼
         ┌──────────┐┌──────────┐┌──────────┐
         │ Worker 1 ││ Worker 2 ││ Worker N │
         │ (repo A) ││ (repo B) ││ (repo N) │
         └──────────┘└──────────┘└──────────┘
```

- **Daemon** — single background process, manages bots and license
- **Manager bot** — Telegram bot to add/remove project workers
- **Worker bots** — one per project directory, full Claude Code access
- **License client** — validates against `license.clautel.com` (Ed25519 signed tokens)

## Data Flow

| Connection | Destination | What's sent |
|---|---|---|
| Telegram Bot API | `api.telegram.org` | Messages, photos, documents (long polling) |
| Anthropic API | Via Claude Agent SDK | Your prompts + project files (as needed by Claude) |
| License proxy | `license.clautel.com` | License key + hashed instance ID |
| ngrok (optional) | `ngrok.com` | Dev server tunnel (only when you use `/preview`) |

No telemetry, no analytics, no tracking. The daemon only contacts the services listed above.

## Security & Transparency

This project is source-available. You can audit every line of code that runs on your machine.

- See [SECURITY.md](SECURITY.md) for full details on network connections, local storage, and how to verify
- All local files stored in `~/.clautel/` with `0600` permissions
- Verify network connections yourself: `lsof -i -P | grep node` while the daemon runs
- License validation uses Ed25519 signed tokens — the private key lives in Cloudflare secrets, not in this repo

## Requirements

- Node.js >= 18
- [Claude Code](https://github.com/anthropics/claude-code) installed and authenticated on the machine running the daemon

## License

MIT. See [LICENSE](LICENSE) for full terms.

## Contributing

Contributions are welcome! Here's how to get started:

```bash
git clone https://github.com/AnasNadeem/clautel.git
cd clautel
npm install
npm run build
npm test          # all 55 tests should pass
```

To run locally during development:

```bash
npm run dev       # watch mode with auto-restart
```

Then open a PR against `main`. See [CONTRIBUTING.md](CONTRIBUTING.md) for code style, project structure, and full guidelines.
