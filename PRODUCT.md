# Fetch

**register: product** · **version: 2.0**

An agent-native workspace for recording and shipping real software, on macOS. You, or an
agent you already pay for, record your actual screen, find the moment by what was said,
zoom into it and export the clip. Everything runs on the machine except one clearly
labelled optional feature.

Electron shell, native Swift helpers, ScreenCaptureKit capture, ffmpeg export,
on-device transcription, an MCP server. GPL-3.0, public.

## What 2.0 is, in one paragraph

1.x was a good local screen recorder in a category that is already lost. 2.0 treats the
recorder as the primitive and builds the workspace an agent needs around it: a single
edit document where every object has a stable id, a timeline named from the transcript,
an MCP surface that can do everything the window can, an in-app chat running on the
person's own Claude Code or Codex plan, and an activity log that says who did what. The
agent drives; the person watches, steers and can undo.

## The thesis

**The transcript is the spine.** Fetch transcribes on device and keeps word-level
timings, so the timeline is named from what was said and an agent can find a moment by
its words. Competitors that record a simulator or a cloud browser have no audio to build
this from. Every surface should lean on it.

## Users

Two, and the same person is often both.

**The person recording.** Ships software, records demos, walkthroughs and bug repros.
Has recorded the same flow four times because the fifth take is the one without an
"um". Wants captions without paying a subscription and without uploading anything.

**Their agent.** Claude Code, Codex, Cursor. Drives Fetch over MCP from a terminal in
another window. Cannot see the screen, so everything it needs must be discoverable
through tools and returned as ids and paths rather than pixels or payloads.

Designing for only the first produces a nice recorder nobody needs. Designing for only
the second produces a daemon nobody trusts. Every surface has to serve both, and where
they conflict, the human wins, because it is their screen.

## Product purpose

Let an agent record, cut, zoom and caption real software on a real Mac, and let the
person whose Mac it is see exactly what happened and undo it.

## What exists

Kept in step with `landing/DESIGN-HANDOFF.md`, which is the public-facing version.

**Surfaces**
- Record screen: Biscuit, "What are we recording today?", a composer, chips. The
  direct record action is always the first chip.
- Chat pane (Cmd J): spawns the person's own Claude Code or Codex with the Fetch MCP
  server attached. Streams every tool call as a row with its duration. Remembers the
  conversation (`--resume` on the session id). `@` tags a recording by exact path.
  A microphone dictates, transcribed locally.
  A model picker lists every model the installed CLIs can run (Codex's own catalogue,
  Claude Code's model ids), grouped by CLI, searchable, with the effort levels each
  model accepts. It starts on the person's own CLI default and remembers their pick.
- Editor: beats strip named from speech, zoom track (`Z1 2.0x`), marks track
  (redact, spotlight, step), trim, cuts, text, captions, look, camera, audio, voiceover.
- Library: masonry, each tile the real shape of its take.
- Activity: every action on the machine, attributed. No vendor mark means a person.
- Settings: Recording access (never-record list), Connect, voiceover account.

**The take folder**
- Each take gets its own folder, `~/Movies/Fetch/<Take>/` unless the save folder is
  changed. The deliverable sits on top as `<Take>.mp4` (or `.gif`, `.webm`...) and every
  export overwrites it; the raw take and working versions (dead-air cuts, cleaned audio)
  live in `Original/`, sidecars hidden in `.fetch/` as before. Nothing lands on the Desktop.
- One rename (`processor.renameTake`) moves the folder, the raw take, its working
  versions, the deliverable and every sidecar together, "Name 2" when taken. The
  Library, the editor and `rename_recording` all use it.
- Delete trashes the whole folder. Takes from before this stay loose on the Desktop
  and keep working, with `-edit` exports beside them.

**The edit document** (`ui/fetchdoc.js`)
- One canonical description of an edit, written to `.fetch/<stem>.fetchdoc.json`.
- Clips, not trim plus cuts, are the model, so pieces can be named.
- Ids from a per-document counter, never reused: `C` clips, `Z` zooms, `T` texts,
  `S` subtitles, `B` beats, `M` marks.
- The nine values that used to live only as slider positions now persist in `look`.

**MCP tools** (`mcp/index.js`), 19: `record_start`, `record_stop`, `record_status`,
`list_windows`, `list_displays`, `list_recordings`, `probe`, `transcribe`,
`list_beats`, `get_edit`, `apply_edit`, `export`, `rename_recording`,
`remove_dead_air`, `enhance_audio`, `get_settings`, `set_settings`, `delete_recording`,
`get_frame`. `get_frame` returns the image itself, so an agent places a zoom or a
redaction by what it sees, not by guessing coordinates. Every 1.0 option is reachable: trim and cuts as clips, crop and aspect, texts with any
installed font, caption style and position, zooms, backdrops, camera, denoise, loudness,
gain, fades, music, redaction, spotlight and numbered steps. The pipeline runs with the
window closed. Settings that decide what may be recorded, and telemetry, are refused
to agents in code.

**Not built**, and not to be claimed: driving apps (Fetch records, other tools drive),
arrows, loupes, "lift one row", multi-device frames, reading the project's source code.

## Strategic principles

1. **Local is the product, not a feature.** No upload, and no key or token for anything
   core. Recordings are files in `~/Movies/Fetch`, one folder per take. Say this plainly
   wherever an agent touches the machine. The single exception is principle 8.
2. **The competition cannot record a real machine.** Clueso drives a cloud browser, web
   apps only, and wants your staging login. Moonjar drives the iOS Simulator.
   HyperFrames renders its own HTML. Fetch records any real window: native apps,
   terminals, editors, browsers. Every surface should make that concrete rather than
   claimed.
3. **Fetch records, it does not drive.** Playwright drives browsers (headed, or there is
   no window to record), Lore Pilot drives native apps, `simctl` drives the Simulator.
   Composition, not reimplementation. Lore Pilot stays private; do not pull its code
   into this GPL repo.
4. **Policy is enforced in code, never in a tool description.** A rule written into an
   MCP description is prompt prose, and prompt prose is a suggestion. Access rules live
   in the bridge, before the work starts.
5. **Agent actions must be legible and reversible.** If a human cannot see what the
   agent did and get back to where they were, the autonomy is a liability.
6. **Return ids and paths, never payloads.** A window list with base64 icons is 600KB of
   an agent's context. The same list without them is 3.5KB.
7. **Everything the window can do, the MCP can do.** A feature that exists only in the
   GUI is a feature an agent cannot use. Ship both or neither.
8. **The network is one labelled exception.** Voiceover through ElevenLabs is the only
   thing that leaves the machine. It says so where it is used, and its key lives in the
   Keychain. Anything else that would need the network needs the same treatment or
   should not ship.

## Brand

Biscuit, a golden retriever puppy, is the mascot and the consent surface: when an agent
drives the machine, you always see the dog. He speaks first person only in onboarding,
where he is introducing himself. Everywhere else, and in anything a model reads, the
voice is plain and he is not mentioned.

Warm, not cool. The whole category is violet (Loom, Screen Studio) or pure black
(Mosaic), and the agent-tool category is bright and airy (Moonjar). Fetch is retriever
gold on a warm near-black. If a surface could belong to Loom, it is wrong.

## Tone

Plain, short, a little warm. Never cutesy-baby, never corporate.

- Good: "Nothing recorded yet." / "Saved to your Fetch folder." / "Never records 1Password."
- Bad: "Woof! Biscuit couldn't find any videos! :(" / "Operation completed successfully."

Errors say what happened and what to do, in one line, without blame.

Trust is built from **named exclusions, not adjectives**. "Private" means nothing.
"Never records 1Password, Messages, Mail or System Settings" means something.

**No em dashes.** Not in UI copy, not in docs, not in code comments.

## Anti-references

- **Loom / Screen Studio.** Cool violet, subscription, cloud. The colour alone is a fail.
- **Moonjar.** Light, airy, cream, photographic. Excellent work and the bar for craft,
  but copying its palette would make Fetch look like a Moonjar clone. Take the
  structural ideas (stable ids, audit log, provenance, carve-out copy), not the skin.
  Do not take its read-only timeline: Moonjar locks editing because it has no editor,
  and Fetch does. Attribution in the activity log solves the same problem without
  removing hand editing.
- **Generic dev-tool dark.** Blue-grey, monospace everywhere, dense tables. Fetch is
  warm and roomy.
- **Consumer AI slop.** Gradient text, glass cards, sparkle icons on everything.
