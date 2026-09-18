# @fetch-app/mcp

Drive [Fetch](https://github.com/SankrityaT/Fetch), the macOS screen recorder, from
any MCP client. Record the screen, transcribe on-device, get a file path back.

You stay logged into whatever you already pay for. This server never sees a model, an
API key or a token.

## Requirements

- macOS 13 or later
- Fetch installed in `/Applications`, opened once so screen recording is granted

## Install

```bash
claude mcp add --scope user fetch -- npx -y @fetch-app/mcp
codex  mcp add fetch -- npx -y @fetch-app/mcp
```

Cursor, Cline, Zed and Windsurf take the same stdio command. Zed uses
`context_servers` rather than `mcpServers`.

**Codex users:** raise `tool_timeout_sec` in `~/.codex/config.toml`. It defaults to 60
seconds, and a recording longer than that will be cut off mid-call.

```toml
[mcp_servers.fetch]
command = "npx"
args = ["-y", "@fetch-app/mcp"]
tool_timeout_sec = 900
```

## Tools

| tool | what it does |
|---|---|
| `record_start` | Starts recording a display or a single window. Returns when the file exists. |
| `record_stop` | Stops the current recording. |
| `record_status` | Whether Fetch is recording. |
| `list_recordings` | Known recordings, newest first, with paths. |
| `probe` | Duration, resolution, frame rate, audio tracks. |
| `transcribe` | On-device transcript, writes a `.srt` beside the file. |

Tools return paths and counts rather than payloads. `transcribe` gives you the
subtitle path and word count; pass `include_text` only when the transcript itself is
needed, since a long one is thousands of tokens of context.

## How it works, and why

The work happens inside the Fetch app. This process only translates MCP into the app's
local socket protocol, for two reasons.

**Permissions.** macOS attributes screen-recording permission to the responsible
process. If this server captured the screen itself, you would have to grant *your
agent's CLI* screen recording. Going through the app keeps the permission on Fetch,
where you granted it.

**You can see it happening.** An agent recording your screen should be obvious. Fetch
shows its recording border, the floating toolbar and the mascot, exactly as it does
when you press record yourself. That is deliberate, and it is why this does not drive
the recorder directly.

If Fetch is not running it is launched through LaunchServices, again so that Fetch is
the responsible process rather than a child of your agent.

Nothing is uploaded. Recordings are files on your Desktop.
