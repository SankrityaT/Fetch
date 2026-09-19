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
  direct record action is the first chip until a setup exists; then the setup card's
  red Start is the one record control, and the chip steps aside.
  Window first: a take records the window of the app in front (behind Fetch, or past
  the terminal an agent runs in), never the whole screen unless someone asks for it.
- Chat pane (Cmd J): spawns the person's own Claude Code or Codex with the Fetch MCP
  server attached. Streams every tool call as a row with its duration. Remembers the
  conversation (`--resume` on the session id). `@` tags a recording by exact path.
  A microphone dictates, transcribed locally.
  A model picker lists every model the installed CLIs can run (Codex's own catalogue,
  Claude Code's model ids), grouped by CLI, searchable, with the effort levels each
  model accepts. It starts on the person's own CLI default and remembers their pick.
- Editor: beats strip named from speech, zoom track (`Z1 2.0x`), marks track
  (redact, lift, spotlight, step), trim, cuts, text, captions, look, camera, audio, voiceover.
  A lasso in the transport, off until it is armed, draws a rectangle over the stage at
  the moment the person is paused on; while they drag it snaps to the real element under
  it, found by the same Elements pass `find_on_screen` uses, and stays exactly as drawn
  when there is nothing there. On release it becomes a gold chip in the chat composer,
  `R1`, carrying the moment, the box in the recording's own pixels and a JPEG of that
  area alone, and the message tells the agent to work on exactly that. The lasso writes
  nothing to the edit document: it points, the agent makes the mark, and the Undo button
  already there takes it back.
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
- Every take is named when it ends, window or display, from the app in front for most
  of it (sampled every 2 s, `WindowList --front`); for a browser, the product in the tab
  (`songscription-library.vercel.app` is Songscription), not the browser. A browser's own
  pages are named by their kind, never their title: Aside's built-in chats are "Aside · Chats",
  so a private chat title never becomes a folder name. A take with
  speech is then renamed "Product · What happens" by the person's own agent CLI (Claude
  Code on Haiku, else Codex), given only the app, the window title and the first 80
  words, transcribed on device. Setting: "Name recordings with your agent", on when one
  is connected. Only names Fetch gave are ever replaced (`.fetch/<stem>.name.json`
  records them); a typed name, or one an agent passed to `record_start`, never is. The
  Library offers "Name these recordings" for older takes, with Undo.
- Delete trashes the whole folder. Takes from before this stay loose on the Desktop
  and keep working, with `-edit` exports beside them.

**The edit document** (`ui/fetchdoc.js`)
- One canonical description of an edit, written to `.fetch/<stem>.fetchdoc.json`.
- Clips, not trim plus cuts, are the model, so pieces can be named.
- Ids from a per-document counter, never reused: `C` clips, `Z` zooms, `T` texts,
  `S` subtitles, `B` beats, `M` marks.
- Version 2: `look` holds the whole Look spec and `audio` the sound (denoise, loudness,
  gain, music). Version 1 files migrate on read, forever; v1 fields sent by an agent
  (`backdrop`, `outAspect`, `capStyle`, `look.gain`...) are moved to their v2 place.

**Looks** (`ui/look-schema.js`, `ui/look.js`). Every setting of how a video looks is one
field in one table: type, range, default, label, a line of doc. The inspector (Look tab,
`ui/inspector.js`), validation and the agent docs are generated from it. Sections:
frame, device, background, treatment, grain, motion, camera, cursor, captions,
typography, focus. Seven presets ship in `ui/looks/` (Fetch, Clean, Studio, Film, Noir,
Paper, Mono print); "Save look" keeps a person's own in `userData/looks/`. A preset
restyles and keeps the shape, captions, motion and cursor. Fields the ffmpeg renderer
does not draw yet are stored, hidden from the inspector, and named in `look_warnings`.
That flag has not caught up with M4: the Treatment and grain fields the compositor now
draws still carry it, so the inspector hides them and `look_warnings` calls them undrawn
while every MP4 export draws them. The flag has to become "the classic renderer cannot
draw this", said only where that renderer is the one running.
Output keeps the take's shape; a chosen shape is filled by the background, and with no
background by a soft blur of the take, never black bars. Browser chrome is a setting:
for a take whose agent reported the page's viewport, `frame.chrome: remove` crops to the
page exactly. A framed take is never masked tighter than the window's own corner.
Look changes are undo steps like any other edit.

**The compositor** (`ui/compositor/`, passes in `PASSES.md`). A WebGL2 renderer that
draws the editor's stage and the export from one plan (`plan.js`), so the stage is the
file's pixels: background, corners, shadow, zooms (with motion blur, `treatment.motionBlur`),
fades, cuts, the camera bubble, and since M3 everything placed on the take: the Mac's
pointer lifted out, redactions, blurs, spotlights, lifts, steps, the agent's cursor with
its ripples and Biscuit's badge, captions with the spoken word and frosted glass, title
cards, lower thirds and labels. Since M4 it draws the whole Treatment section as well:
the take's own exposure evened out (its black and white points measured once per take by
`levels.js` and held to the take, never to the background a look chose), brightness,
contrast, saturation, a tint laid over with the luminance put back, haze, a softened
frame, bloom and halation off one bright pass, chromatic aberration at the corners, a
vignette that falls off with the ground behind it, film grain over the top and a dither
under everything. With the backgrounds those need: a mesh gradient, the photo set in
`assets/backdrops/`, and either defocus behind the take, a Gaussian or a hexagonal
aperture (`treatment.bokeh`). Every wide effect works at a reduced size off mip levels,
which is what keeps the whole stack inside the speed gate.
Since M5 the grade is held to the recording and not to the frame: the ground keeps the
colour the look asked for (a warm near-black stays warm, a paper ground stays paper),
and the step badges, the agent's cursor and the captions keep theirs, because they are
Fetch speaking over the recording rather than part of it. The take's edge is a contract
too: its outermost pixels stand at least 24 levels of luma off the ground beside them,
met by a shadow wide enough to be felt and narrow enough to resolve inside the gutter, a
blur ground that holds near the take's own mean rather than pressed into a deep field,
and a warm hairline where neither is enough. That is what keeps the promise about black
bars true on a light product: a 20 px gutter beside a white page reads as bleed, never
as a bar. A blur redaction and an unframed caption are drawn shapes now, a plate with a
corner and a hairline and a plate of the caption's own glass, rather than a smudge.
It is the default renderer:
every MP4 or MOV export runs
it in a hidden window (`ui/render-host.js`, `render.html`), several times real time, with
the sound rendered by ffmpeg alongside, and `preview_frame` draws with it too. GIF and
WebM, auto zoom without explicit zooms, and a take the compositor cannot read go to the
classic ffmpeg renderer. Activity and the MCP export result name the engine that drew each
file (`gl` or `classic`, and why). What only the take's pixels say (a lift's element and
its corners, a step's card corner, the Mac's pointer and clean patches, the cursor's rests,
toasts under the captions) is worked out once by `ui/compositor/prepare.js` and shared by
the stage and the export. A lift raises the element's real pixels 3 to 6 percent over a
key and a contact shadow while the page steps back (blurred, dimmed by multiplication,
less by the piece than far from it); it starts when its element is on screen, and a zoom
it rides is re-framed so the raised card, its badges and some air all fit, a card at the
frame's edge coming up a little inward. Sample and hold is exact: an output frame shows
the last frame the take wrote at or before its moment, across cuts.
`FETCH_ENGINE=classic|gl` forces one.

**MCP tools** (`mcp/index.js`), 26: `get_look_schema`, `list_looks`, `apply_look`, `save_look`, `record_start`, `record_stop`, `record_status`, `pointer`,
`list_windows`, `list_displays`, `list_recordings`, `probe`, `transcribe`,
`list_beats`, `get_edit`, `apply_edit`, `export`, `rename_recording`,
`remove_dead_air`, `enhance_audio`, `get_settings`, `set_settings`, `delete_recording`,
`get_frame`, `find_on_screen`, `preview_frame`. `get_frame` returns the image itself.
`find_on_screen` reads a frame on device (Vision, `Elements.swift`) and returns its
text, chips, buttons and cards as E1, E2... with boxes, ranked against the person's
words ("the black chip"), plus the frame with them numbered; zooms and marks take that
box, and Fetch picks the scale that frames it (`ui/targets.js`). Panels and card grids come back too (found from their hairline edges), each element says which one it is `in`, and a new lift or spotlight replaces any it lands on and is held to the part of its span where its element is on screen (a card that opens mid-sentence is not lifted before it opens); a lift needs room: one at or near the frame edge, or on a pane whose content is cut off at its foot, is refused, naming the card or grid inside it to lift instead (`find_on_screen` marks these `no_lift`; a spotlight is offered only when nothing inside can stand for it). Re-aiming a zoom lists under `alongside` the lifts and spotlights still playing with it, so one an earlier turn added unasked is named or removed. `apply_edit` stops taking an
agent's aim on trust, in code rather than in a description (principle 4): a zoom given
only a centre point is put on the element under that point, never on a bare line of text,
and fitted to it; a zoom carrying a box is framed by that box whatever scale came beside
it, and the result says what the scale became and why; a lift with no box is refused,
naming the two ways to give it one; and an area the person lassoed is aimed at as `R1`,
re-read in the crop the edit is in and held to the same lift rules as any other box. Every
applied edit comes back with one frame of itself to look at. `preview_frame` draws
frames of the edit exactly as export will, several in one call; `apply_edit` lists under `check` when to look at what it placed (just after it lands, and its middle), so an agent checks where a zoom landed before it reports. Marks merge by id: one an agent leaves out stays (an edit adding a lift once dropped the blurs hiding a name), only `remove: [ids]` deletes, and the result names every id an edit took out. A lift's box is grown to the element's own hairline at export and framed evenly, so its border comes up whole. Every 1.0 option is reachable: trim and cuts as clips, crop and aspect, texts with any
installed font, caption style and position, zooms, backdrops, camera, denoise, loudness,
gain, fades, music (an added track, or one of three beds made in `tools/make-beds.js`, `look.music`, ducked under the voice), redaction, lift, spotlight and numbered steps. The pipeline runs with the
window closed. Settings that decide what may be recorded, and telemetry, are refused
to agents in code.

**The agent's own cursor** (`ui/pointer.js`). An agent's take is recorded without the
Mac's pointer, which belongs to the person at the desk. The agent reports where its
pointer is with `pointer` as it acts (fractions of the window, page pixels plus the
viewport, or screen points); each report is stamped on the take's video clock and saved
as `.fetch/<stem>.pointer.json`. The cursor is Fetch's own, never the system's: a
near-black macOS arrow with a crisp light edge, about 30 px tall at 1080, carrying a
round Biscuit badge (`idle.png` cropped to the head, `assets/mascot/badge.png`), named
"Biscuit" for a moment at each click. The export draws it gliding between the points,
pressing with a gold ripple on clicks, before any zoom so zooms magnify it. The badge
shows only for about 0.6 s either side of a click; a rest that would cover words is moved
to the nearest clear ground (a gutter between cards, the blank side of a row), and a rest
a zoom has cut away is drawn just inside the zoomed view. While the take records, the same cursor is shown live over
the recorded window (`agent-cursor.html`: click-through, never focused, kept out of
every capture) and goes when the take stops. Nothing moves the person's mouse. Its clicks
are what auto-zoom follows. The track is `pointer` in the edit document, so it can be
supplied or corrected afterwards.

**Not built**, and not to be claimed: driving apps (Fetch records, other tools drive),
arrows, loupes, multi-device frames, reading the project's source code.

## Strategic principles

1. **Local is the product, not a feature.** No upload, and no key or token for anything
   core. Recordings are files in `~/Movies/Fetch`, one folder per take. Say this plainly
   wherever an agent touches the machine. The single exception is principle 8.
2. **The competition cannot record a real machine.** Clueso drives a cloud browser, web
   apps only, and wants your staging login. a competitor drives the iOS Simulator.
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
   Keychain. Work handed to the person's own agent CLI (the chat pane, naming takes)
   goes out on their plan, not Fetch's, and is labelled where it happens: naming sends
   the app, the window title and the first 80 words, and its setting says so. Anything
   else that would need the network needs the same treatment or should not ship.

## Brand

Biscuit, a golden retriever puppy, is the mascot and the consent surface: when an agent
drives the machine, you always see the dog. He speaks first person only in onboarding,
where he is introducing himself. Everywhere else, and in anything a model reads, the
voice is plain and he is not mentioned.

Warm, not cool. The whole category is violet (Loom, Screen Studio) or pure black
(Mosaic), and the agent-tool category is bright and airy (a competitor). Fetch is retriever
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
- **a competitor.** Light, airy, cream, photographic. Excellent work and the bar for craft,
  but copying its palette would make Fetch look like a a competitor clone. Take the
  structural ideas (stable ids, audit log, provenance, carve-out copy), not the skin.
  Do not take its read-only timeline: a competitor locks editing because it has no editor,
  and Fetch does. Attribution in the activity log solves the same problem without
  removing hand editing.
- **Generic dev-tool dark.** Blue-grey, monospace everywhere, dense tables. Fetch is
  warm and roomy.
- **Consumer AI slop.** Gradient text, glass cards, sparkle icons on everything.
