# Moonjar parity

Checked against https://moonjar.ai and https://moonjar.ai/features on 2026-09-18.
Moonjar is a screenshot-first agentic mockup studio that also records and cuts. Fetch
is recording-first. This lists every capability on their features page and where Fetch
stands. "Have" means built and verified in the running app, not just written.

Legend: **have** · **building** (in the current workflow) · **gap** (planned, with the
batch it lands in) · **won't** (and why).

## 01 Agents and chat

| Moonjar | Fetch |
|---|---|
| Built-in chat, watch updates live | **have** (Cmd J, streaming tool rows, result cards) |
| Runs on your Claude Code / Codex plan, no key | **have** |
| @ tags for items and collections | **have** for recordings; collections **gap, batch C** |
| Pick agent and model per message | **have** (model picker, effort) |
| Agent activity log with durations and logos | **have** (Activity view) |
| Works in the background without taking focus | **have** (quiet agent takes, no focus steal) |
| Product guidelines, written from the codebase and applied to all agent work | **gap, batch D** |

## 02 Capture

| Moonjar | Fetch |
|---|---|
| Drives the iOS Simulator, clean 9:41 status bar | Fetch records any window incl. Simulator; one-call status bar cleanup **gap, batch D** |
| Recording with a moments (click/tap) timeline | beats from speech **have**; click markers on the timeline **gap, batch B** |
| Originals never modified | **have** (take folder, Original/) |
| Screenshots of a sheet/window | **gap, batch A** (stills are Moonjar's core; Fetch has video only) |
| Works without taking focus, respects app permissions | **have** (never-record list, Ask mode, background takes) |

## 03 Style

| Moonjar | Fetch |
|---|---|
| Style in plain English | **have** for video via chat and apply_edit; stills **batch A** |
| Style card documenting device, background, grain, lift | **gap, batch A** (item info panel) |
| Lift a row or card with soft shadow | **gap, batch B** (video and stills) |
| Style toggle, styled vs original | **gap, batch B** (editor toggle) |
| Glass loupe on a small element | **gap, batch B** |
| Annotations: numbered steps, arrows, outlines, labels, blur/pixelate | steps, labels, blur, pixelate **have/building**; arrows, outlines **gap, batch B** |
| Multi-device composition (iPhone in front of MacBook) | **gap, batch B** (device frames: MacBook, iPhone, browser window; two-device composition) |
| Background library (photo, tilt, dissolve, painted) | blurred-video, gradients, your own image **have**; photo set and grain / dither / motion blur **gap, batch B** |
| Collage layouts | **gap, batch C** (stills first) |

## 04 Record and cut

| Moonjar | Fetch |
|---|---|
| Beats, named segments | **have** (from speech, which Moonjar cannot do) |
| Beat focus, dim the rest, preview follows | partial **have**; **batch B** |
| Cursor control: bigger, smoothed, hidden, moved, added | agent cursor **building**; person takes rendered from cursor data (size, smoothing, hide) **gap, batch B** |
| Multi-track timeline (clips, zooms, highlights, captions, markers) | **have** |
| Tap/click visualisation | agent clicks **building**; person clicks **gap, batch B** |
| Motion lift and push-in | zoom **have**; lift **batch B** |
| MP4 export | **have** (plus WebM, MOV, GIF, audio) |

## 05 Organize and find

| Moonjar | Fetch |
|---|---|
| Gallery, day-grouped, unsquashed | masonry, unsquashed **have**; day grouping **batch C** |
| Product folders with Help Center / Changelog subfolders | take folders **have**; product grouping **batch C** |
| Sort and filter | partial **have**; complete **batch C** |
| Context menu: duplicate, copy path, reveal, delete | partial; complete **batch C** |
| Item info: source, usage, size, dates, tags | **gap, batch C** |
| Full edit history, restore any version | undo of agent edits **building**; timestamped versions **batch C** |

## 06 Make it yours

| Moonjar | Fetch |
|---|---|
| Inspiration gallery with the requests behind each | **gap, batch D** |
| Motion settings: Full, Calm, Still | reduced-motion respected; explicit setting **batch C** |
| App icon themes | **won't** for launch (cosmetic) |
| Shortcuts: Cmd K search, Cmd J chat, Cmd 1-2, Esc stop | Cmd J **have**; Cmd K, Cmd 1-4, Esc stop **batch C** |
| Demo mode with a sample library | **gap, batch C** |

## Automation (their landing page)

"Never manually update your Help Center / Changelog / Marketing Assets." Fetch's
equivalent: an agent re-records and re-exports the clip or still for a flow when the
product changes, with export presets per destination (help center 16:9, X, vertical,
GIF for docs). **Batch D.** Publishing into third-party doc sites is **won't** for launch
(needs their APIs); Fetch produces the assets.

## Where Fetch is ahead

Real Mac apps and any window (Moonjar drives the Simulator); transcript spine (beats and
captions from speech); on-device transcription; voiceover; camera bubble; a real editor a
person can also use; policy enforced in code (never-record list, Ask mode, agents cannot
change consent settings); local, one folder per take.

## Batches

- **A. Stills.** Screenshot capture (window, display, a frame of a recording) and the
  same style engine for stills, exported as PNG; MCP `screenshot` and still export; stills
  in the Library, tags and chat.
- **B. Effects.** Lift, loupe, arrows, outlines, device frames and two-device composition,
  backdrop grain / dither / motion blur and a small photo set, person-take cursor control
  and click ripples, click markers on the timeline, beat focus, styled/original toggle.
- **C. Organize.** Versions with restore, product grouping, day groups, filters, context
  menu, info panel, Cmd K / Cmd 1-4 / Esc, motion setting, demo mode, collections as tags.
- **D. Agents.** Product guidelines (read-only access to a chosen project folder to write
  them), Simulator status bar, destination presets, inspiration gallery.
