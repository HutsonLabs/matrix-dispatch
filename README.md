# matrix-dispatch

Bridge Matrix to your CLI tools — and the other direction too.

`matrix-dispatch` runs a Matrix bot that pipes incoming room messages to a
configured CLI (Claude, Gemini, Aider, Codex, anything that takes a prompt
and prints a response) and posts the reply back. The same binary also
exposes a one-shot `send` subcommand for outbound notifications and a
stdio MCP server so Claude Code can drive your Matrix account directly —
all sharing one bot account, one config file, one set of credentials.

```
                    ┌──────────────────────────────────────┐
                    │              matrix-dispatch         │
                    │                                      │
   Matrix room ────►│ daemon  ──► CLI (claude, gemini, …) ─┼──► reply
                    │                                      │
   shell script ───►│ send    ──────────────────────────── │──► Matrix
                                                                  
   Claude Code ◄──► │ mcp     ──────────────────────────── │──► Matrix
                    └──────────────────────────────────────┘
```

## Three modes

### 1. Daemon (default)

Long-lived bot that listens on Matrix and dispatches messages to a CLI
provider. Auto-joins rooms on invite, auto-ignores other configured bots,
threads conversations via per-room session IDs, splits long replies, and
renders markdown responses to HTML formatted bodies.

```bash
matrix-dispatch                       # uses ./dispatch.json
matrix-dispatch /path/to/config.json  # explicit config
```

The daemon is also runnable as a launchd login service on macOS — see
[Run as a service](#run-as-a-service) below.

### 2. `send` — one-shot notifications

Send a single Matrix message from a shell script, CI job, or interactive
terminal. Reuses the daemon's bot credentials from `dispatch.json` so you
don't need a second access token. REST-only — no `/sync`, no race against
a running daemon for the same account.

```bash
# To a user (DM lookup via m.direct, with fallback to 2-member-room scan)
matrix-dispatch send --to @user:matrix.example.com --message "deploy ok"

# To a room alias
matrix-dispatch send -r '#ops:matrix.example.com' -m "build green" --notice

# Body from stdin
echo "$summary" | matrix-dispatch send -t @user:matrix.example.com
```

Flags: `--bot`, `--room`/`--to`, `--message` (or stdin), `--notice` (sends
`m.notice` instead of `m.text`), `--plain` (skip markdown→HTML), `--config`.

### 3. `mcp` — stdio MCP server for Claude Code

Exposes 6 Matrix tools to any MCP client. Reuses the same bot credentials
as `send` and the daemon; REST-only so it doesn't fight the daemon for
sync state.

| Tool | What it does |
|---|---|
| `matrix_send_message` | Send `m.text` (markdown→HTML) to a room/alias/DM |
| `matrix_send_notice`  | Send `m.notice` (non-highlighted) |
| `matrix_read_messages`| Fetch recent message events (newest first) |
| `matrix_list_rooms`   | List rooms the bot is joined to |
| `matrix_create_room`  | Create a new room |
| `matrix_invite_user`  | Invite a user to a room |

Register with Claude Code at user scope so every project gets the tools:

```bash
claude mcp add-json -s user matrix '{
  "command": "node",
  "args": ["/absolute/path/to/matrix-dispatch/dist/index.js", "mcp"]
}'
claude mcp get matrix   # → Status: ✓ Connected
```

## Quick start

### 1. Build

```bash
git clone https://github.com/HutsonLabs/matrix-dispatch.git
cd matrix-dispatch
bun install     # or: npm install
bun run build   # → dist/
```

### 2. Get a bot access token

You'll need a Matrix account for the bot. On a self-hosted Synapse:

```bash
docker compose exec synapse register_new_matrix_user \
  -c /data/homeserver.yaml --no-ssl \
  -u dispatch-bot -p bot_password \
  http://localhost:8008

curl -s -X POST https://matrix.example.com/_matrix/client/v3/login \
  -H "Content-Type: application/json" \
  -d '{"type":"m.login.password","user":"dispatch-bot","password":"bot_password"}' \
  | jq -r '.access_token'
```

Element, matrix.org, or any other homeserver works the same way — just
make sure registration is open or you have admin access.

### 3. Configure

Copy `dispatch.example.json` → `dispatch.json` and fill in real values
(the file is gitignored). Minimum:

```json
{
  "providers": {
    "claude": {
      "name": "claude",
      "command": "claude",
      "baseArgs": ["-p", "--output-format", "json", "--dangerously-skip-permissions"],
      "messageFlag": "positional",
      "resumeFlag": "--resume",
      "outputFormat": "json",
      "responsePath": "result",
      "sessionIdPath": "session_id",
      "cwd": "/path/to/your/work/dir",
      "timeout": 600000
    }
  },
  "bots": [
    {
      "name": "myassistant",
      "provider": "claude",
      "matrixUserId": "@dispatch-bot:matrix.example.com",
      "matrixAccessToken": "syt_…",
      "matrixHomeserver": "https://matrix.example.com",
      "rooms": [],
      "ignoreSenders": []
    }
  ]
}
```

`rooms: []` listens in every joined room. `triggerPrefix: "!myassistant"`
filters to messages with that prefix. Multiple bots can share one provider
or use distinct configs — each bot auto-ignores the others.

### 4. Run

```bash
./dist/index.js                      # daemon
./dist/index.js send -t @… -m "hi"   # one-shot
./dist/index.js mcp                  # stdio MCP server
```

## Run as a service

Two install paths on macOS:

**Scripted (recommended).** `scripts/launchd.sh` renders
`src/launchd.plist.template` with your repo path + home dir, drops the
plist into `~/Library/LaunchAgents/`, and loads it:

```bash
scripts/launchd.sh install
scripts/launchd.sh status
scripts/launchd.sh logs       # tail stdout/stderr
scripts/launchd.sh restart
scripts/launchd.sh uninstall
```

The label defaults to `local.matrix-dispatch`; override with
`MATRIX_DISPATCH_LABEL`.

**Manual.** `com.matrix.example.plist` is a reference plist — copy it,
edit the placeholders (`/PATH/TO/matrix-dispatch`, `YOUR_USERNAME`,
`Label`), drop into `~/Library/LaunchAgents/`, and `launchctl load` it.

## Configuration reference

### `providers.<name>`

| Field | Description |
|---|---|
| `name` | Match the key (used internally) |
| `command` | The CLI binary |
| `baseArgs` | Args applied to every invocation |
| `messageFlag` | `positional` (append message), `stdin` (pipe), or a flag name like `--message` |
| `resumeFlag` | Flag for resuming a session, e.g. `--resume` |
| `outputFormat` | `text` \| `json` \| `stream-json` |
| `responsePath` | JSON path to extract the response (`result`, `choices.0.message.content`, …) |
| `sessionIdPath` | JSON path to extract the session ID for threading |
| `cwd` | Working directory for the CLI process |
| `timeout` | Max execution time in ms |
| `env` | Extra env vars |

`src/providers.ts` ships presets for `claude`, `gemini`, `aider`, and
`codex`. Anything in your `providers.<name>` block merges over the preset.

### `bots[]`

| Field | Description |
|---|---|
| `name` | Bot's display name |
| `provider` | Which provider key to use |
| `matrixUserId` | `@bot:server` |
| `matrixAccessToken` | The bot's access token |
| `matrixHomeserver` | `https://matrix.example.com` |
| `rooms` | Allow-list of room IDs (empty = all joined rooms) |
| `triggerPrefix` | e.g. `"!myassistant"`; omit for always-on |
| `ignoreSenders` | User IDs to silently drop messages from |
| `extraArgs` | Extra args appended to every CLI invocation for this bot |
| `providerOverrides` | Per-bot overrides on the provider config |

### Environment fallback

If no config file is found, matrix-dispatch falls back to env vars for a
single-bot setup:

```
MATRIX_HOMESERVER=https://matrix.example.com
MATRIX_ACCESS_TOKEN=syt_…
MATRIX_USER_ID=@dispatch-bot:matrix.example.com
DISPATCH_PROVIDER=claude   # default
DISPATCH_ROOMS=!abc:server,!def:server   # comma-separated; empty = all
DISPATCH_PREFIX=!myassistant
DISPATCH_CWD=/path/to/work/dir
```

The config-file lookup order is `./dispatch.json`,
`~/.config/matrix-dispatch/config.json`, `~/.matrix-dispatch.json`, and
`dispatch.json` next to the installed binary (so `send` and `mcp` modes
work from any cwd without plumbing a config path).

## DM addressing

`send` and the MCP tools accept three target forms:

| Form | Resolution |
|---|---|
| `!roomId:server` | Used as-is |
| `#alias:server` | `GET /directory/room/:alias` → room ID |
| `@user:server` | Looked up in `m.direct` account data; if absent, falls back to scanning 2-member joined rooms; on success, writes back to `m.direct` so subsequent lookups are fast |

The `m.direct` fallback is what makes the `--to @user:server` form work
even when the DM was opened in a client that doesn't write the
account-data entry.

## Why one binary for all three modes?

A Matrix account has one access token. If a long-lived daemon owns
`/sync` for that account and a separate process tries to sync with the
same token, you get split-brain on receipts and presence. By keeping
`send` and `mcp` REST-only — every operation is a single authenticated
HTTP call — the auxiliary modes can run alongside the daemon without
fighting it for sync state.

## Development

```bash
bun run dev        # tsc --watch
bun run typecheck  # tsc --noEmit
bun run build      # tsc → dist/
```

Source layout:

| File | What |
|---|---|
| `src/index.ts` | CLI dispatcher (daemon / send / mcp) |
| `src/matrix-bot.ts` | Daemon bot — matrix-js-sdk, room handling, CLI dispatch |
| `src/cli-runner.ts` | Spawn-and-collect for CLI providers |
| `src/providers.ts` | Built-in provider presets |
| `src/session-store.ts` | Per-room session ID persistence (JSON file) |
| `src/matrix-client.ts` | Thin REST-only Matrix client (shared by send + mcp) |
| `src/send-cmd.ts` | `send` subcommand |
| `src/mcp-cmd.ts` | `mcp` subcommand |
| `src/config.ts` / `src/types.ts` | Config loader and types |

## License

MIT — see `package.json`.
