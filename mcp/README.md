# @fetch-app/mcp

Drive [Fetch](https://github.com/SankrityaT/Fetch), the macOS screen recorder, from
any MCP client. Record the screen, transcribe on-device, get a file path back.

You stay logged into whatever you already pay for. This server never sees a model, an
API key or a token.

## Requirements

- macOS 13 or later
- Fetch installed in `/Applications`, opened once so screen recording is granted

## Install

Easiest: open Fetch and use the **Connect** screen in onboarding. It detects which
clients you have, writes the right config for each one, and reads it back to confirm.
For Codex it also raises `tool_timeout_sec`, which otherwise cuts off any recording
longer than a minute.

To wire it up by hand, point your client at the copy that ships inside the app:

```bash
NODE=$(command -v node)
SHIM=/Applications/Fetch.app/Contents/Resources/app/mcp/index.js

claude mcp add --scope user fetch -- "$NODE" "$SHIM"
codex  mcp add fetch -- "$NODE" "$SHIM"
```

Cursor, Cline and Windsurf take the same stdio command under `mcpServers`. Zed uses
`context_servers` instead.

**Codex users installing by hand:** `tool_timeout_sec` defaults to 60 seconds, so a
recording longer than that is cut off mid-call. Set it yourself:

```toml
[mcp_servers.fetch]
tool_timeout_sec = 900
command = "/usr/local/bin/node"
args = ["/Applications/Fetch.app/Contents/Resources/app/mcp/index.js"]
```

Use an absolute path to `node`. Your client does not inherit a login shell's `PATH`,
so a bare `node` will not resolve for nvm installs.

## Driving something, then recording it

Fetch records. It does not drive a browser or a simulator, because mature tools
already do: Playwright MCP for the web, `xcrun simctl` for the iOS Simulator, a shell
command for anything else. The agent composes them.

```
list_windows({ app: "Chrome" })   ->  find the window the driver just opened
record_start({ window: "12049" }) ->  record that window, not the whole screen
```

**Run the driver headed.** Playwright defaults to headless, and a headless browser has
no window on screen, so there is nothing for any screen recorder to capture. Started
headless it will silently produce a recording of your desktop with no browser in it.
Launch Playwright MCP with `--headed`, or set `"headless": false` in its config.

The iOS Simulator is an ordinary window, so it needs nothing special:

```
list_windows({ app: "Simulator" })
record_start({ window: "<id>" })
```

## Tools

| tool | what it does |
|---|---|
| `record_start` | Starts recording a display or a single window. Returns when the file exists. |
| `record_stop` | Stops the current recording. |
| `record_status` | Whether Fetch is recording. |
| `list_windows` | Windows open on screen, with the id `record_start` takes. Filter with `app`. |
| `list_displays` | Displays attached, with the id `record_start` takes. |
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
