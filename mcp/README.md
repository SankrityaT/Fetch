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

**Zooms on a driven take are yours to place.** Auto-zoom follows the real pointer:
where it clicked, and where it came to rest. Playwright's `page.mouse` and `click()`
send input straight into the page over CDP, so the pointer on screen never moves and
Fetch records no clicks. `get_edit` says so: `pointer.autoZoomSpots` is 0 and
`pointer.note` explains why. Put zooms in with `apply_edit` instead, at the times you
clicked and the places you clicked on (`get_frame` shows where those are). Takes where
a person, or a driver that moves the real pointer, did the clicking zoom on their own.

The iOS Simulator is an ordinary window, so it needs nothing special:

```
list_windows({ app: "Simulator" })
record_start({ window: "<id>" })
```

## Tools

| tool | what it does |
|---|---|
| `record_start` | Starts recording a display or a single window. Returns when the file exists. |
| `record_stop` | Stops the current recording. Returns the raw take's path, inside its own take folder. |
| `record_status` | Whether Fetch is recording. |
| `list_windows` | Windows open on screen, with the id `record_start` takes. Filter with `app`. |
| `list_displays` | Displays attached, with the id `record_start` takes. |
| `list_recordings` | The Library's takes, newest first, one entry per take: the raw take's path, plus the deliverable and any working versions. |
| `probe` | Duration, resolution, frame rate, audio tracks. |
| `transcribe` | On-device transcript, writes a `.srt` beside the file. |
| `list_beats` | Named spans from what was said, each with a `B` id, to find a moment by its words. |
| `get_edit` | The recording's edit: clips, zooms, texts, captions, marks, look, crop, camera, audio, and the fonts and backdrops on offer. |
| `apply_edit` | Change any part of the edit. Only the fields sent change; lists replace as a whole. |
| `export` | Render the edit to the take's deliverable, through the same queue as the app. |
| `rename_recording` | Rename a take: its folder, files, transcript, camera take and edit move together. |
| `get_frame` | One frame as an image (and a JPEG path), to see what is on screen before placing a zoom or a redaction. |
| `remove_dead_air` | Cut silent gaps into a new file beside the original. |
| `enhance_audio` | Denoise and level the voice into a new file beside the original. |
| `get_settings` / `set_settings` | Save folder, camera, mic, system audio, countdown and the rest. |
| `delete_recording` | Move a take folder (or one working version) to the Trash. Put Back works. |

`set_settings` cannot change Recording access, the never-record list, allowed apps or
telemetry. The refusal is in the app (`ui/record-policy.js`), not in a description an
agent could ignore, and a request that includes any of them is refused as a whole.

Tools return paths and counts rather than payloads. `get_frame` is the one exception,
because the image is what was asked for; it is capped at 1280 wide, about 30KB. `transcribe` gives you the
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

## Where recordings go

Each take gets a folder of its own, under `~/Movies/Fetch` unless the save folder is
changed in Settings:

```
~/Movies/Fetch/Linear · Triage an issue/
  Linear · Triage an issue.mp4         the deliverable; every export overwrites it
  Original/
    Linear · Triage an issue.mov       the raw take, the path to edit
    Linear · Triage an issue-cut.mp4   working versions, such as remove_dead_air
    .fetch/                            transcript, beats, camera take, edit (hidden)
```

`record_stop` returns the raw take in `Original/`; pass that path to the editing tools.
`export` returns the deliverable. Recordings made before take folders stay on the
Desktop and keep working, with exports written beside them as `-edit` copies.

Nothing is uploaded. Recordings are files on your Mac.
