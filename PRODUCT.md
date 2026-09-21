# Fetch

**register: product** · **version: 2.0**

An agent-native workspace for recording and shipping real software, on macOS. You, or an
agent you already pay for, record your actual screen or capture one frame of it, find the
moment by what was said, zoom into it and export the clip or the picture. Everything runs
on the machine except one clearly labelled optional feature.

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
  An attached image goes to the model as an image, since the pane allows Fetch's tools
  and nothing that opens a file, and a capture Fetch made goes both ways: the picture to
  look at and the path to work on. It is a PNG, so it used to go as a picture alone, and
  the agent could see the person's own screenshot and not style it. A capture is known by
  where it lives (`<Take>/Original/`) or by its shot document; anything else is a picture.
  A microphone dictates, transcribed locally.
  A model picker lists every model the installed CLIs can run (Codex's own catalogue,
  Claude Code's model ids), grouped by CLI, searchable, with the effort levels each
  model accepts. It starts on the person's own CLI default and remembers their pick.
  The standing doctrine (the loop, the aiming rules, the house voice) goes once per
  conversation as a system prompt rather than on every message: Claude Code takes
  `--append-system-prompt`, and Codex, which has no such flag, gets it on the message that
  opens the thread, after which its own resume carries it. The per-turn header fell from
  about 580 words to about 50, which is the open take, its counts, the job and where the plan
  stands, and the lassoed areas. The pane draws the plan rather than trusting prose: a strip
  reading `Plan 4 of 6`, a row per step with a check on what is closed and gold on what is
  next, the distance line verbatim from the same measurement the agent read, and a verdict row
  carrying `review`'s own summary. The trust line is now true on both engines: Claude Code
  gets Fetch's tools and nothing else, and Codex, which has no flag that drops its shell, runs
  read only with the Fetch server alone and the composer says so instead of claiming otherwise.
  A claim that is true for one of two engines is worse than no claim.
- Editor: beats strip named from speech, zoom track (`Z1 2.0x`), marks track
  (redact, lift, spotlight, step, loupe), trim, cuts, speed, text, captions, look, camera,
  audio, voiceover.
  Every object on those two tracks is now the person's to make, move, retime, re-aim and
  delete by hand, from a "Zooms and marks" tab: drag a pill by either end to retime it or by
  its middle to move it whole, snapping to the trim, the playhead, the beats, the cuts and
  every other object; drag a mark on the stage by its middle or its eight handles; draw a box
  anywhere over the stage to re-aim one. A zoom is never nudged by its window: its gesture is
  a fresh box over what it should frame, and that box goes through `Targets.boxZoom` exactly
  as an agent's does, so both hands write the same zoom. The rules (minimum span, minimum box,
  the neighbour a zoom may not be dragged over, the free gap) are pure, in `ui/trackedit.js`.
  Until this, a redaction in the wrong place could only be undone whole or asked for again,
  which for the one control where a miss ships something private was the sharpest hole in the
  product.
  A lasso in the transport, off until it is armed, draws a rectangle over the stage at
  the moment the person is paused on; while they drag it snaps to the real element under
  it, found by the same Elements pass `find_on_screen` uses, and stays exactly as drawn
  when there is nothing there. On release it becomes a gold chip in the chat composer,
  `R1`, carrying the moment, the box in the recording's own pixels and a JPEG of that
  area alone, and the message tells the agent to work on exactly that. The lasso writes
  nothing to the edit document: it points, the agent makes the mark, and the Undo button
  already there takes it back.
- Library: masonry, each tile the real shape of its take, grouped by day, filtered by
  kind (shots or takes), by platform (Mac, Phone, Tablet, Web: a shape, never a make),
  by folder and by a search over the name. An information button on any card says its
  kind and platform, what is on disk, when it was captured, when it was last exported
  and which folders hold it. The kind is read off what was captured and never off what
  was exported, so styling a shot never makes it a take. Provenance: what an item was
  styled, cut or copied from, what was made out of it, and the original one click away
  from the row that names it. Duplicate writes it, a rename repoints it from both ends,
  and a source that was trashed keeps its row and loses its click. It is kept in
  `collections.json` beside the folders, and an item that carries its own `from` wins
  over it.
- Shot editor: the same editor, the same stage, the same compositor, with the clock
  taken off it. Crop, Zooms and marks, and Look; a Styled and Original switch where the
  play button was, Space to peek at the capture, and one Export PNG button, since a
  still has no length, no quality and no resolution to ask about. The Look tab drops its
  Captions section on a shot, for the reason the Text tab is gone: captions are drawn
  from the words spoken in a take, a capture has none, and six dials whose values are
  stored and never drawn are worse than no dials. Motion keeps its dials and gains a
  line saying the fades, the arrival, the loop and the shutter are off in one frame and
  come back when the look is used on a recording.
- Activity: every action on the machine, attributed. No vendor mark means a person.
- Settings: Recording access (never-record list), Connect, voiceover account.

**The take folder**
- Each take gets its own folder, `~/Movies/Fetch/<Take>/` unless the save folder is
  changed. The deliverable sits on top as `<Take>.mp4` (or `.gif`, `.webm`...) and every
  export overwrites it; the raw take and working versions (dead-air cuts, cleaned audio)
  live in `Original/`, sidecars hidden in `.fetch/` as before. Nothing lands on the Desktop.
- One rename (`processor.renameTake`) moves the folder, the raw take, its working
  versions, the deliverable and every sidecar together, "Name 2" when taken. The
  Library, the editor and `rename_recording` all use it. Every sidecar means the job file
  as well (`.job.json`): left behind, a rename took the brief, the plan and every closed
  step with it and the next `apply_edit` came back saying there was no brief.
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

**Screenshots** (`Shot.swift`, `ui/shot.js`, `.fetch/<stem>.fetchshot.json`). A screenshot
is a take of one frame, and that sentence is the whole design. `Shot.swift` is
`Recorder.swift` asked for one frame: the same framework, the same content filter, the
same never-record list applied before a pixel is read, the same folder, so the raw capture
sits in `Original/` and is never touched again. A window arrives shaped like the window,
on transparency, with its own corners cut out of the picture and no macOS drop shadow in
it, because the compositor already draws a key and a contact shadow and a second baked one
cannot be lifted back out.
The never-record list reaches the helper by app name as well as by window id, and the
helper matches the names itself against every window ScreenCaptureKit can see. The list
of windows Fetch draws for a person is filtered to be readable (nothing under 140 by 120,
one row per app, title and size), and a list built for reading must never be what decides
which pixels are written: a password manager's small quick-access panel is not in it, and
under the old id-only exclusion it was captured to disk while the result still reported
that it had been left out. Fetch's own window is hidden for the moment a display or
region capture takes, the way a take hides it, because Fetch is in the helper's skip set
and so can never be named in an exclusion list either.
A capture an agent asks for is its own question. The dialog says screenshot rather than
record, says the frame is written now and that nothing keeps running, and the "until
Fetch quits" answer is remembered against the kind as well as the target: allowing
screenshots of a browser does not also allow recordings of it, and the other way round.
**A capture that cannot work fails usefully rather than stalling.** There are two dialogs
behind one symptom. macOS owns Screen Recording, and reading shareable content without the
grant raises a system prompt only a person at this Mac can answer. **Who asked decides what
happens to that prompt**, and it is carried all the way to the helper (`Shot --by`), which
is the only process that can raise it. An agent cannot answer a prompt, so for an agent the
grant is preflighted (`CGPreflightScreenCaptureAccess`, which reads and never asks) in
`takeShot` before anything is spawned and again in the helper before a pixel is read:
`not-determined`, `denied` or `restricted` is a refusal with the pane to open and the restart
to make, and an unreadable state is allowed, since refusing a capture that would have worked
on a measurement nobody could take is worse. A person is never refused on that reading at
all. Preflight is a boolean and Electron's screen status is backed by it, so a Mac that has
never been asked reads as `denied` and is indistinguishable from one that said no; refusing
the person on it deleted the first-run prompt and named a switch in a pane Fetch was not yet
listed in. They go through, the helper does not preflight for them, and the read raises the
system's own prompt or comes back with a refusal that names the pane and the restart. The
grant is never requested on the person's behalf anywhere.
Fetch's own question is the other one, and on
the shipping `ask` default every agent capture raises it. It had no deadline at all, so an
unattended agent waited on it forever. It is bounded at a minute now: a person who is here
answers in seconds, and a minute of silence means nobody is, so the call refuses with the
same sentence `takeShot` gives. The alert stays parent-less, which is load bearing: given a
window to sit on, macOS makes it a sheet, and a sheet on a window created hidden is queued
by AppKit until that window is shown, so the person is never asked, the deadline always
wins, and every agent capture is refused a minute after it was made. A question nobody can
see is a worse failure than the hang it was meant to fix. An answer arriving after the
deadline lands on a promise nobody holds: that call already refused and captures nothing on
a late yes.
A person's own capture is named from what it captured, the way a take is named from the
app in front (`naming.shotName`), so a shot lands as "Songscription · Library" rather
than as `shot-1758...`; that name is Fetch's, recorded in `.fetch/<stem>.name.json`, and
is fair game for a later improvement, while a name someone typed never is.
A shot is its own document rather than an edit with one frame. Half of `ui/fetchdoc.js` is
a clock (clips, cues, beats, zooms, the pointer track, speed ramps, per-clip sound, fades,
the loop), and a document holding all of that at its defaults lies about itself: the first
agent to read one back would reasonably set `speedAudio` on a PNG. What the two documents
share is the look, whole and unconverted, validated by the same `ui/look.js` against the
same table, so `shot.look = doc.look` is simply true and a preset saved off a recording
lands on a capture. A shot stores even the fields one frame cannot mean, and pins them only
at the moment it projects (`Shot.STILL_PINS`: the two fades, the arrival, the loop, the cut
transition, the travel-driven shutter), so a look with a two second fade crosses onto a
screenshot and back with the fade still on it.
**A still carries type**, which is the difference between a screenshot on a background and
a finished asset. A hero, a docs picture and a store listing are all a capture with a line
of type on it, and for one round a shot refused `texts` by name alongside clips, zooms and
captions. Nine of those ten are about a clock and a headline is not one of them, so `texts`
is off the refusal list and the shot document carries it with no `start` and no `end`, the
way it already carried marks. A text says what it is rather than when it is: `headline` (the
big line, with `subtitle` as the quieter line under it), `caption` (a line under the image,
held to a 66 character measure), `label` (a short line on a plate pinned to a point) and
`callout` (the same plate with a leader and a ring drawn onto the point it names). A label
and a callout take `at: {x, y}` in the take's own fractions, the coordinates a mark is
placed in, so `element: 'E12'` from `find_on_screen` aims type exactly as it aims a lift:
the bridge turns the element's box into the point at its middle, and aiming stays one rule
rather than two. The type never lies over the product. The room is settled from the output
frame before anything is placed, out of the slack the picture's own shape already leaves, and
the take is refitted into what is left: measured, 127 px of type over 69 px of air costs the
picture 58 px and no more. **Clear of the whole of the product**, which where a look draws a
frame means the frame: a drawn device takes the box the layout gave the picture and hands
back the screen inside it, so type measured off the screen sat its descenders on the bezel
and at `typography.headlineSize` 0.026 sat the whole line inside the title bar, and a caption
ran across a laptop's foot. It is placed against the box it was given room out of, which is
the same argument the caption band already made. The column over a picture is the picture's
own width and not the picture plus both of its margins, and since the picture's width is what
the type left it, the two are settled by measuring, refitting, and measuring once more
against the width that came out. A headline too long for its column wraps and then steps down
a size rather than running past it, and so does a pinned label: given more words than two
lines hold it steps down and only at the floor ends in an ellipsis, rather than dropping its
last words silently. A look with no ground is the capture edge to edge and has
nowhere for type to stand that is not the product, so the type is not drawn and `apply_edit`
says so and names a preset that gives the capture a ground. A title card is not one of these:
it was a title card before any of this and stays one wherever there is no ground to hold a
headline, and both sides of that question now ask it of the same clock, so a card running the
whole of a trimmed edit is drawn rather than reserved nothing and then stripped. Nothing about this is a flag for
stills: a clip can carry a headline too, and it holds the room it was given for the whole plan.
**There is no second renderer.** A shot is lent a clock four seconds long whose every frame
is the same picture, and the frame drawn is the middle one, where every arrival in the
shared planner has landed and nothing has begun to leave. So the mark planner, the focus
timing, the badge easing and all fifteen passes are handed a thing that runs, and not one
of them forks. `Shot.toRenderSpec` and `Shot.toExportOpts` return the same key sets
`Fetchdoc`'s do, asserted key by key in the tests, and reach `Plan.prepare` through the one
door: the only difference anywhere is that a recording's content texture arrives as NV12
out of ffmpeg and a capture arrives through `uploadImage` with its crop carried in
`cropUV`, which is the path the editor's own stage already takes with its `<video>`.
Measured: a shot drawn at 2x is the 1x picture to a mean of 0.83 levels and at 3x to 0.81,
the 2 px gold keyline is 2, 4 and 6 px at the three sizes with no part-gold pixel at the
start of a run, and inside a redaction nothing is finer than the mark's own cell at any
size, so a screenshot at 3x carries no more of what was hidden than one at 1x.
`scale: native`, the default, is the capture at its own size: the multiple of the plan that
puts one output pixel under each captured one, snapped to 1x, 2x or 3x when it is within 5
percent of one and held between the plan's own size and 3x, against the GPU's own texture
ceiling read off the live context. Measured on a 2880 px capture in a 16:9 studio frame,
3558x2002 at one capture pixel per output pixel, where the old never-enlarge rule shipped
1920x1080 and threw 46 percent of the capture away: at that density the capture's own text
keeps 172 of its 213 levels of contrast and two edges in five are gone. A screenshot is read
close, at 100 percent, on a display with two or three pixels to the point, so the honest
number is not a size but a density, capture pixels per output pixel, and `export` reports it
beside the multiple. PNG is the default as a
measurement and not a preference: a still draws flat fields, one pixel hairlines and small
text, and JPEG rings along exactly those edges (0.18 MB against 1.40, differing by a mean
of 1.08 levels), so it stays for the case it wins and is not the default. The alpha channel
is pinned to 255 in the sink, because PNG is the one deliverable that could carry a hole
out of the app.
**More than one capture in one picture** (`opts.group`, up to three). A group of one is a
take, and the ordinary path is that list with one entry in it, which is why every existing
golden is byte for byte what it was. A member after the first reads the picture so far as
its ground, ping-ponged between two targets, so its shadow falls on the member behind it
and the edge floor stands one capture off another, for free rather than by being kept in
step. No pass reads the previous frame: a member reads the previous member of the same
frame, in the same draw. The layout is in millimetres until the last step, believing a
stated width, then a stated density, then the capture's own scale, because a point is not
the same size on a desk as in a hand: laid out in points a handset comes out five times too
large and the group reads as a toy beside a building. Real relative size is a rule and not a
dial, since the moment one member can be made bigger the group stops being a photograph.
One ground, one softbox in absolute pixels, one grade over the finished frame, one camera:
two vanishing points is two cameras, and two cameras is the thing this exists to stop
looking like.

**The edit document** (`ui/fetchdoc.js`)
- One canonical description of an edit, written to `.fetch/<stem>.fetchdoc.json`.
- Clips, not trim plus cuts, are the model, so pieces can be named.
- Ids from a per-document counter, never reused: `C` clips, `Z` zooms, `T` texts,
  `S` subtitles, `B` beats, `M` marks.
- Version 2: `look` holds the whole Look spec and `audio` the sound (denoise, loudness,
  gain, music). Version 1 files migrate on read, forever; v1 fields sent by an agent
  (`backdrop`, `outAspect`, `capStyle`, `look.gain`...) are moved to their v2 place.
- A clip carries a `rate`: source seconds spent per output second, `4` for a typing montage,
  `0.5` for a slow look, `[1, 4]` for a ramp into one. It is one change of the time map and
  nothing else: `Timeline.outClock` accumulates `(b - a) / rate` and `srcTime` inverts it in
  closed form, so `srcTime(clock(t))` is `t` exactly rather than nearly, and everything
  time-indexed downstream (zooms, marks, texts, cues, the pointer track, the camera) follows
  for free because there is one clock. A ramp runs linear in output time, which integrates to
  a quadratic whose inverse is one square root and whose mean rate is `(r0 + r1) / 2`, so the
  length comes back for free. Absent, `1` or `[1, 1]` is written back as nothing at all, so a
  document made before speed existed hands the clock no rates and gets the graph it always
  got. A sped-up piece is silent by default (`audio.speedAudio`), since the reason to speed a
  stretch up is that nothing is being said over it; `keep` chains `atempo` per segment, each
  pinned with `apad`/`atrim` to its own output span so the error is one segment's rounding and
  never accumulates, and a ramp's audio is a staircase of at most 0.2 output seconds a step.
  Measured through a 24 second take: 0.08 ms of drift at the segment boundaries and no growth,
  and every source moment in the picture within 8.1 ms of where the clock puts it. The editor
  plays at the rate too: the stage maps source time forward for the picture, but the take's own
  `<video>` is what runs the clock, so its `playbackRate` is set from the rate at the moment
  being played and it is muted exactly where the export mutes it. Otherwise pressing play in a
  sped region showed one video and the file was another, which is the preview-equals-export
  rule pointed at the person instead of at the agent.

**Looks** (`ui/look-schema.js`, `ui/look.js`). Every setting of how a video looks is one
field in one table: type, range, default, label, a line of doc. The inspector (Look tab,
`ui/inspector.js`), validation and the agent docs are generated from it. Sections:
frame, device, background, treatment, grain, motion, camera, cursor, captions,
typography, focus, keys. `motion.loop` is the one field that changes how a frame is seeded
rather than how it looks: grain, the ground's tooth and the dither take the frame's place
inside the loop, which is still a function of that frame's own time, so a preview playing the
clip round again draws the frames the file holds. The `keys` section draws the keystrokes of
a take, and **Fetch does not capture the keyboard**: reading it needs an event tap and the
Input Monitoring permission, which is a different promise to a person than watching the screen
they pointed Fetch at, so it is its own round and its own word from them. What exists is the
drawing side, built against the shape that capture will write, with the rule that matters
already in it: a character is drawn only where the capture vouched for it, so a run nobody
vouched for reads as typing and never as the letters, and a take with no key track draws
nothing and the tool result says why. Seven presets ship in `ui/looks/` (Fetch, Clean, Studio, Film, Noir,
Paper, Mono print); "Save look" keeps a person's own in `userData/looks/`. A preset
restyles and keeps the shape, captions, motion and cursor, and each one carries a `for:` line
naming the take it suits (Clean is a dark app or a terminal, Mono print a white SaaS page),
which `list_looks` returns and `review` reads, so choosing a look stops being a guess at a
name. Whether a field is drawn is a question about the engine rather than a flag about a
release: the compositor draws every field in the schema and is the renderer for MP4 and MOV,
so the Look tab offers all of them and `look_warnings` says nothing. It draws WebM and GIF
now too, so what is left for the classic ffmpeg renderer is a sound file and a still frame,
which leave out the fields marked `classic: false`, and there the warning names them and the
output that caused it. Five fields nothing draws yet
(`frame.scale`, `frame.offsetX`, `frame.offsetY`, `cursor.smoothing`, `typography.titleFont`)
are named whatever runs. The inspector shows what the engine drawing the stage draws, 61 of 68
fields with the three subtlest behind an Advanced disclosure, which is 44 controls a person
could not reach at all before.
Output keeps the take's shape; a chosen shape is filled by the background, and with no
background by a soft blur of the take, never black bars. Browser chrome is a setting:
for a take whose agent reported the page's viewport, `frame.chrome: remove` crops to the
page exactly. A framed take is never masked tighter than the window's own corner.
Look changes are undo steps like any other edit.

**The compositor** (`ui/compositor/`, passes in `PASSES.md`). A WebGL2 renderer that
draws the editor's stage and the export from one plan (`plan.js`), so the stage is the
file's pixels: background, corners, shadow, zooms (on the quintic ease `motion.zoomEase`
names, with motion blur read off that ease's own velocity and the shutter at the film
standard 180 degrees, `treatment.motionBlur`),
fades, cuts, the camera bubble, and since M3 everything placed on the take: the Mac's
pointer lifted out, redactions, blurs, spotlights, lifts, steps, the agent's cursor with
its ripples and Biscuit's badge, captions with the spoken word and frosted glass, title
cards, lower thirds and labels. It draws what happens at a cut and at the two ends of a
take, which nothing drew before: `motion.reveal` brings the take up into its frame over
a third of a second and settles it back out at the end (only where the look puts
something behind it, since a take that fills the frame has nowhere to arrive from), and
`motion.cutTransition` is a cross dissolve made of the frames the cut removed, a dip
through the look's own ground, or a push that lands the next piece tight and lets it
settle. The default is a hard cut and stays one: dead air removal is the commonest cut
in the product, its two sides are the same shot a moment apart, and there a dissolve is
invisible and a dip only announces an edit meant not to be noticed
(`.context/survey/motion-cuts.md`). A dissolve is the one thing in the product that
shows material the edit took out, so it keeps what the edit hides: each of its two sides
reads the marks from its own side of the boundary, and where something starts or stops
being hidden inside the frames it would show, the window shortens or the cut stays hard
(`.context/survey/motion-verify.md`). What the camera does between those cuts is held to
the same rule as the cuts themselves: the ease-back in the middle of a long pan never
pulls the window wider than the frame, the shutter never spans a cut, a lift or a
spotlight riding a zoom takes that zoom's own ramp whichever ease the look names, and
the camera bubble arrives, leaves and dips with the take it lies on rather than sitting
lit over bare ground. Since M4 it draws the whole Treatment section as well:
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
corner and a hairline and a plate of the caption's own glass, rather than a smudge: the
caption on a plate draws no blurred cloud of its glyphs at all, so nothing it puts on
the product reaches past the plate's own bounds, and the words and what shades them move
together when the caption dodges live content. A caption arrives and leaves rather than
blinking, and where the phrase is too short to hold both ends the pair is cut to fit it,
on the stage and in the subtitles the classic renderer writes alike, so the shortest
phrase in a take still comes all the way up and still fades away.
The ground is a surface rather than one number across 1920x1080: it carries three levels
of tooth whatever luma the look chose (and less of it on a stage drawn below the file's
size, because that is what the file's own tooth becomes there) and the app's own two
faint warm pools in the corners `tokens.css` puts them in. Under a look with film grain
the tooth stands down to what that grain leaves on the picture, because the roll is in
front of the whole frame and a wall grainier than the plate hanging on it is a mat; and
the grain itself is renewed at the take's own rate up to 30 times a second, so a look
grains the same at 30 fps and at 60 the way its cell already makes it grain the same at
720p and at 4K. The grade's shoulder and toe
arrive carrying the slope the picture had rather than flat, so a contrast no longer
compresses a white page's row separators into the page; the vignette dial is how many
fall-offs rather than a share of one; and the take's hairline goes to the one warm end
the plan picked and delivers what that tone can carry, because a line that changed ends
under a lift swung thirty levels on a level of the picture.
Since M5 it also draws the frame round the take and the take's own plane. A device
(`device.kind`, and `frame.chrome: clean`, which is the browser one on its own) is a
browser, a plain window, a laptop or a phone, drawn from rectangles, radii and two
tones: generic by construction, nothing traced, no wordmark, a window's three dots in
the shell's own tone rather than one desktop's three colours.
**A drawn frame claims only what it can back up**, which is one idea said twice. It does
not claim to be the window's chrome when the window brought its own: a shot knows what it
was a capture of (`captured.kind`, written onto the document by `take_shot`, which computed
it all along and threw it away), and round a window or display capture with nothing cropped
off its top the shell's top bezel is the same as its sides and no bar is drawn at all, so
the picture has one title bar and it is the real one. Measured: 13 px of top over 13 px of
side, against 69 over 12 once the capture's own bar is cropped away, and the capture is
drawn larger for the bar that is not there, 880 px against 824. No recording can reach that
one branch, since a take carries no `captured` at all. And it does not draw an address field
with nothing to put in it: the bar takes `device.title`, puts it in the field where it is
shaped like a host, centres it the way a window's title is centred where it is not, and
where there is neither draws no field and falls back to a title bar's height, which is byte
for byte a window frame. That half is not a still's, and should not be: a browser's bar is
taller than a window's for exactly one reason, which is the field standing in it, so a
recording with a browser frame and no address gets the shorter bar too. Every browser golden
in the suite carried a host-shaped title, which is how that escaped them, and there is one
now (`device-browser-bare`) that does not. **And a window title is not an address.** A bare
host and a filename are the same shape, and filenames are the commonest window titles there
are: `README.md`, `notes.txt`, `index.html` and `build.sh` all matched a run of dotted
labels ending in letters, so the frame invented an address out of a document. A scheme or a
path says address outright; anything else has to be a host that does not end in the name of
a file format. Fetch records no address and never invents one. That
browser is the one frame drawn in place of a real one, so it is drawn only where the
real one could be cropped away: on a take that never recorded where the page sits,
`frame.chrome: clean` draws nothing and says why, rather than standing Fetch's bar above
the recording's own tabs. The device
takes the place the layout gave the take and hands back what is left, so the margins and
the shadow stay where they were and only the take gets smaller, and its two edges are a
pair of tones a range apart, which is how it keeps the take's edge contract without
measuring anything. It takes that place for the captions too: a burned caption sits in
the band under the take, which is where it sat before there was a device, and not on the
shell. Its shell is graphite on a dark ground and bone on a light one, read off a photo
backdrop's own decoded mean the way the take's hairline is, since four of the five
photos we ship are dark. `frame.tilt` turns the whole of it in perspective, a plane a camera
turns rather than a skew, with the mask and the shadow following because they are worked
out on that plane. And a `loupe` mark magnifies a small area into an inset beside it,
for the detail too small to read and too small to zoom to without losing the context it
sits in; it reads the frame after the redactions and the blurs, so what the edit hides
stays hidden at magnification, and it is sized and placed inside what the zoom it rides
shows, so the inset never hangs off the side of the window.
It is the default renderer:
every MP4 or MOV export runs
it in a hidden window (`ui/render-host.js`, `render.html`), several times real time, with
the sound rendered by ffmpeg alongside, and `preview_frame` draws with it too.
What the encoder is told matters as much as what is drawn: at `balanced`, the quality the
Export dialog opens on, x264's early skip probe was writing a byte copy of the previous
macroblock for 99 percent of the ground on every frame, so a still ground was a frozen
picture in the file whatever the compositor drew. The rate factor was never the decision, the
preset was: at `veryfast` there is no rate-distortion mode decision at all, so the probe is
the whole of it. `balanced` now runs at `fast` with the same grain tuning `high` has, at CRF
23 untouched, for 22 to 36 percent more file and a slightly better picture, and the ground
renews on every delivered frame.
 A take the
compositor cannot read goes to the classic ffmpeg renderer. GIF and WebM come off the same
drawn frames as an MP4 and differ only at the encoder: a GIF is drawn at a rate its own
centisecond clock can hold, so every frame is held the same time rather than one in three
being held 11 percent longer, and without the ground's tooth or the film's grain, which a
256 colour palette cannot carry and which cost five times the file. Picking a GIF's colours
is a function of all its frames at once, so the palette pass is at the sink and not in the
compositor, where every pass is a function of one. Auto zoom
is drawn here too, from the moments `prepare.js` hands over whole. Activity and the MCP export result name the engine that drew each
file (`gl` or `classic`, and why). What only the take's pixels say (a lift's element and
its corners, a step's card corner, the Mac's pointer and clean patches, the cursor's rests,
whether the bottom of the frame is any place for a caption at all: a toast arrived there,
or the product's own content is simply there and the top is clear, judged through the
window the frame pass will draw and not the edit's raw zoom, since a lift re-frames the
zoom it rides) is worked out once by `ui/compositor/prepare.js` and shared by
the stage and the export. A lift raises the element's real pixels 3 to 6 percent over a
key and a contact shadow while the page steps back (blurred, dimmed by multiplication,
less by the piece than far from it); it starts when its element is on screen, and a zoom
it rides is re-framed so the raised card, its badges and some air all fit, a card at the
frame's edge coming up a little inward. Sample and hold is exact: an output frame shows
the last frame the take wrote at or before its moment, across cuts.
`FETCH_ENGINE=classic|gl` forces one. The same module draws a finished screenshot
(`renderShot`), and every place a frame becomes a file is one sink (`writeStill`), so a
preview frame, a contact sheet cell and an exported PNG of one plan are the same file in
the same format. What is left for the classic ffmpeg renderer is a sound file and a
preview still taken off its own path.

**MCP tools** (`mcp/index.js`), 39: `get_look_schema`, `list_looks`, `apply_look`, `save_look`, `record_start`, `record_stop`, `record_status`, `record_pause`, `take_shot`, `pointer`,
`list_windows`, `list_displays`, `list_recordings`, `probe`, `transcribe`,
`list_beats`, `get_edit`, `apply_edit`, `direct`, `review`, `fit_to_length`, `revert_my_edit`,
`ask`, `propose`, `can_loop`,
`export`, `rename_recording`,
`remove_dead_air`, `enhance_audio`, `get_settings`, `set_settings`, `delete_recording`,
`get_frame`, `find_on_screen`, `preview_frame`, `contact_sheet`, `list_voices`, `voiceover`, `remember`.
`test/tools.test.js` is what keeps that list one list: every op the bridge answers has a tool
on it, every tool drives an op that exists, and the names the in-app pane allows are the names
the server registers, both directions. `record.pause` sat in the bridge for months with no
tool on it, so the app could hold a take and no agent could, and a feature no agent can reach
is a feature that does not exist. **Screenshots cost the surface one tool.** `take_shot` is
the only thing a capture needed of its own, because capturing one frame is a different act
from recording and everything after it is not: `get_edit`, `apply_edit`, `apply_look`,
`save_look`, `find_on_screen`, `preview_frame`, `contact_sheet`, `get_frame`, `direct`,
`review`, `revert_my_edit`, `export`, `probe`, `list_recordings`, `rename_recording` and
`delete_recording` all take a shot's path where they take a recording's, and
`test/tools.test.js` fails if a second op named for stills ever appears beside
`shot.take`. A shot goes through the same element resolution a recording does, so
`element: 'E7'` from `find_on_screen` and `element: 'R1'` from the person's own lasso aim
at part of a screenshot exactly as they aim at part of a take, and a lift with nothing to
raise is refused with the same sentence. An element id aims a `label` or a `callout` too:
the bridge turns the box into the point at its middle, so type is aimed by the one rule
everything else is aimed by. **No tool asks a still for a moment it does not have.** `at`
was required on `get_frame`, `find_on_screen` and `preview_frame` while all three
descriptions said a shot ignores it, so a client that believed the description got a
validation error and one that did not invented a number: it is optional on all three and
defaults to the start. `apply_look` takes `step` like every other change tool, so applying
a look closes a plan step instead of costing a `direct` call that does nothing else, and on
a recording it now returns the plan and the distance beside the look. `take_shot` hands back
a picture of what it captured, since it is the one tool that makes the only artefact in the
job and it was the one tool that made an agent call something else to see its own work. The
tools that are questions about time
(`fit_to_length`, `remove_dead_air`, `enhance_audio`, `transcribe`, `list_beats`,
`can_loop`, `voiceover`) refuse a capture by name and say what to call instead, because a
refusal that only says no costs the agent a turn and the person a wait. `preview_frame` on
a shot is that shot's export drawn narrow, from the same plan through the same renderer, so
what an agent checks and what ships differ in pixel count and nothing else. **`review` on a
shot is a rubric about a picture**, and it used to be the edit rubric run on a take of one
frame, which on one frame passes every rule it has: it answered "ready, 10" for a bare
capture on a gradient and, word for word and to the same ten, for a picture with two title
bars, a blank address field and a lift covering the whole page. A checker that always says
ten is worse than none, and this project has learned that once already. `review()` routes on
the document, since a shot says what it is, and judges it off the same plan the compositor
draws it from, so the judge and the renderer cannot disagree about where anything is
(0.23 ms a call, no pixel read, every rule something the document can prove). Fifteen rules:
what the brief called private left uncovered or only softened, the shape, a group on a look
with no ground, a mark the picture does not draw, a device frame over a capture that already
carries its own chrome, a shell cut the wrong way for what is in it, a lift raising a
fragment or the whole page, two of them on one place, a capture with nothing said about it,
room round the frame, a blank address bar, the ground against the capture's own exposure,
and how many of the capture's own pixels the box it was given can carry.
Four of them are measured in the one unit that makes them true. **A blur is judged in sigma
against a stroke of type**, in the capture's own pixels, and never against the box it
covers: a box is why a 576 px decorative blur at sigma 60 was called weak, and blocking,
while a 38 px blur over an account row at sigma 5 passed, which is the wrong answer on both.
A strong blur is no longer a finding at all just because the brief named something private
somewhere in the picture; what is named is a blur a word survives, with two ways out, a
redaction or more blur. **What says not to look at something does not say what to look at**:
`subject` counts the marks that point, so a capture whose only mark is a redaction is still
the screenshot with a margin round it the rule exists to name, and was answering ten for
exactly the case it was written for. **The shape judged is the shape that ships**, the
plan's own frame rather than the capture's crop: under `frame.aspect: auto` a 1920x1080
capture goes out 1920x1170, so a blocking rule was clearing a file that was never 16:9 in
the same result whose `measured.picture` said so. And **on a group the chrome question is
asked of each member**, because each carries its own capture and its own `device`, and
answered where it is asked: the fix rebuilds the group with the offending member bare, the
shape `device-fit` already uses. Offered as `apply_look` it changed nothing, since a member's
shell is built from the member and not from the look, and the finding came back byte for
byte forever. `settle()` is one
function for both documents, so a picture and a recording cannot drift into two ideas of
what ten means, and every finding carries a call that can be made as it stands, proved by
applying all of them in order and asserting the score went up and no redaction came off.
The nine rules about a clock come back under `not_judged`, always present and each with its
reason, rather than telling an agent a screenshot is twenty-six seconds short. The server also says **how to work** before anything calls
it: `mcp/index.js` sets MCP's `instructions` to what Fetch is, the six line loop the in-app
agent is handed word for word (see the job below), aim at a box and never at a coordinate,
read the state that comes back rather than calling again to find it, write down what is still
true next week, decide rather than ask except in the one narrow case `ask` is for, and never
an em dash. It is the shape of a job and nothing about any one tool,
because what a tool takes and gives back belongs in that tool's own description where it
cannot fall out of step with the tool. For a whole round that loop reached the pane's agent
and nobody else, so Claude Code, Codex, Cursor and Zed each worked it out or did not.
`test/tools.test.js` holds the instructions to `EditAssist`'s own `LOOP` line for line, and
fails if they name a tool this server does not register. `get_frame` returns the image itself.
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
gain, fades, music (an added track, or one of three beds made in `tools/make-beds.js`, `look.music`, ducked under the voice), redaction, lift, spotlight, loupe, numbered steps and arrows (a gold arrow that stands outside the box it aims at and points at the middle of its nearest edge, so the thing is never under it; it is sized and sided against what the zoom shows at its own hold, so a half second push somewhere else in its life never shrinks it and a box outside the window gets no arrow rather than one pointing at unrelated content). The camera bubble takes `keys` as well as a corner: where it is, how big it is and what shape it is over the take, a span like `{start: 12, end: 20.4, size: 0.1}` saying "small while the lift is up" and putting it back after, and the editor carries that track through a round trip rather than dropping it on the way back in. `export` writes m4a, mp3 and wav as well as MP4, MOV, WebM and GIF, since the edited sound on its own is a deliverable somebody wants, and it names its quality with the three words the person sees in the Export dialog rather than three of its own. The pipeline runs with the
window closed. Settings that decide what may be recorded, and telemetry, are refused
to agents in code.

**The three tools that are not about a field.** `can_loop` answers whether a clip plays round
again with no visible jump, and names what is stopping it: a fade, the take rising into place,
a zoom still moving at the last frame, a caption mid-phrase, a mark or a cursor somewhere else
at the end, each with the fix. It is answered off the plan before anything is drawn, because
every pass draws from the plan and the frame's own time, and it hands back the take's own time
at both ends for the half no plan can answer, whether the recording itself comes back to where
it began. `export` runs it too where the look asks for a loop, on the file the person now has.
`ask` and `propose` are the two that wait on a person: a fork put as buttons in the chat, and a
change shown with Apply and Discard before it lands. The bar for both is damage rather than
doubt, said in their descriptions and in the server's instructions, because an agent that asks
about everything is worse than one that decides: a default they can see and undo beats a
question. Neither can hang a turn. A window nobody can see comes back at once as unattended, a
backstop clock runs two seconds behind the pane's own, the end of a turn settles whatever is
left, and every branch of both carries a `do_next`, since a result that says only "nobody
answered" gets asked again a second later. Nothing is written until Apply, so Discard leaves
nothing behind by construction rather than by cleanup. The frame on the card is drawn off the
document Apply itself builds, elements resolved and zooms aimed, or the person would be
approving a picture of a change that is not the change; and the card says Applied the moment it
is clicked, so an apply that then refuses sends one later word that corrects it rather than
leaving a thread that says a document was written that was not.
Sound is per clip now as well as per take: a clip takes `audio {gain, denoise, mute}` and
anything it leaves out is the take's own, so one passage said a metre off the mic is lifted
without the keyboard coming up with it, and `probe` with `loudness` measures every clip in the
same unit the target is in and names the decibels to write. A clip asking for more than Fetch
lifts one clip by is a stretch recorded too quietly to fix with a number, and the result says
so rather than handing back a bigger one. A clip's level is a difference from the take's own
rather than the whole of it, because the take's gain sits after loudness normalisation and a
piece runs before it: applied whole, the normaliser measured the lifted sound and took the
take's own lift straight back out, so setting one clip quietly cancelled the take. And a level
that is not its neighbour's arrives as a twenty millisecond ramp rather than a step, since the
step between two abutting clips is the click a person hears in an otherwise clean join: both
sides of the ramp are the same audio, so it is the level moving and not two moments mixed, and
measured on a steady tone the join is the same size step as the material either side of it.

**A job an agent can finish.** Twenty-six tools and sixty-three look fields still could not
answer "make this a 60 second demo for my landing page", because nothing in the product knew
what a job was: the agent started blind, had no target, kept no plan, measured nothing and
could not recover. Five things now exist and they are the round, in the order a turn uses
them. `contact_sheet` is sight: up to 24 frames of the finished output in one picture, evenly
spaced, drawn by the compositor exactly as the export draws them, each with its output time
burned into its corner and its source second returned beside it. It exists because the best
work in this product is motion, an ease that lands and settles, a dissolve, the travel blur
under a zoom, and every bit of that is invisible in a single frame and obvious in a row of
them. `direct` is the target and the plan: a brief (`what`, `seconds`, `aspect`, `where`,
`audience`, `must_keep`, `must_hide`) and up to twelve steps `P1..Pn`, kept in `.fetch/<stem>.job.json`
beside the take and deliberately not in the edit, because the job is about the work and has to
survive the undo of the edit it produced. `what` is what the thing is in the person's own words, and on a still it is nearly the whole
brief, since one frame has no length for the rest of it to measure. It was accepted by the
schema and thrown away on write for a round, which left the picture rubric building its own
`find_on_screen` fixes with no query in them, so the loop it opened could not be closed by
any call the agent made.
`fit_to_length` hits a number from the transcript:
the fillers first, since nobody can hear a cut "um", then the longest pauses, then whole beats
ranked by speech density, and never half a beat. All three passes cut around the work rather
than through it: a title card over the head silence and a closing URL card over the tail
silence used to be taken whole by the pause pass and reported afterwards under `orphans`, which
is exactly the damage a checker is supposed to prevent. It writes `clips` on the edit rather than a
new file, and when the next cut would take the edit further under the target than it is over,
it stops and names what that cut would have cost rather than butchering a take to win an
argument with arithmetic. Asked for **more** than the take holds it cuts nothing and slows the
moments the edit is already dwelling on instead, a zoom holding or a card up with nobody
talking over it, one gentle rate for all of them and never past half speed or over speech. Half
speed is a promise about the rate the viewer sees rather than about the factor, so a hold the
person already set to 0.8x is taken to 0.5x and no further, which keeps `reach` a number the
tool can actually arrive at. `stretch.reach` is the longest that edit can honestly be, and past it it refuses and says to
record more. A stretch is one change to the time map, so every zoom, mark and caption keeps
the footage it was placed on. `review` is the house rubric measured rather than asked for:
rules over the document, the brief and the beats, ranked blocking, should and note, each item
carrying the exact call that fixes it and the times to look at. It is safe to follow, which it
was not: no clips list it hands over costs the edit its own work (a card, a lift, a step, a
loupe, an arrow, a `must_keep` phrase, which is matched against the cues joined across their
neighbours so a phrase said over a cue boundary is held and one nobody said is named), at most
one item retimes the edit so two fixes can never undo each other, it shares
`Director.tolerance` so one number has one judge, a silence a card or a fade is covering is not
dead air to be cut, and every cut it sizes is sized in the seconds the finished video spends
rather than in the seconds the recording ran, so a speed region no longer walks the edit under
the number it just promised. An edit too short for its brief is answered with
`fit_to_length { seconds: target }`, which slows only what is already holding, rather than with
a rate over the narration. A finding the agent judged and wrote down
(`review { declined: ['dead-air'] }`, the reason in `direct`'s note) stops holding the verdict
at "nearly" for ever, and that is as far as it goes: a blocking item declined drops to `should`
and stays on the list, and a missing redaction does not move at all, because an agent that
could turn "not ready" into "ready" on its own say-so is marking its own paper. It scores out
of ten. `revert_my_edit` is the
recovery of last resort, the same code path as the person's own undo of an agent change, so a
zoom they dragged since stays dragged. The loop is held together by what comes back rather
than by what descriptions ask for: every `apply_edit` and every `export` carries `plan` (what
is left, and `apply_edit { step: 'P3' }` closes one) and `distance` (the length and shape
against the brief), and a take with no brief carries the nudge to write one instead. `export`
runs `review` and hands its blocking list back with the file, and its score. The export still
happens: refusing one on somebody's own machine is rude, and being unable to say "done"
without having been shown the list is enough.

**What is still true next week** (`ui/memory.js`, `remember`). A brief lives in the job file
and dies with the job. Everything else the person says about themselves and their software
used to die with the conversation, so "new chat" wiped it and the agent asked the same four
questions every week. Three drawers, because facts have three lifetimes: `G` for the person
across every product, `F` for one product across every take (both in `<userData>/memory.json`),
`N` for one recording, in that take's own sidecar so a rename carries it and a delete trashes
it. Ids are the handle, the way `Z1` and `P2` are, and the letter says which drawer to name in
`forget F3`. It refuses three things and keeps everything else: a secret, found by the shape of
the value and never by the word beside it, handed back as the same sentence with the value
taken out for you to send again; passing chatter, including a brief, which belongs in
`.job.json` and would otherwise be two records of one decision that can disagree; and something
already in there, which supersedes rather than doubles: half the content words shared is a
restatement, and so is a second sentence naming the same thing, so "it is called Lyricly now"
replaces "the product is called Songscription" instead of leaving recall printing a dead name
as a current fact. Nothing is summarised and nothing ages
out on a clock: a fact is superseded or evicted when its drawer fills, weakest first, and a
pinned one outlives an unpinned one. Every call returns the memory block as the next
conversation will see it, so the agent reads what its own write did rather than the word
"saved". It is read as well as written: the block opens every in-app conversation under its own
heading in the system prompt, and `direct` and `apply_edit` carry it back beside `plan` and
`distance`, so an outside client that never saw that prompt still knows what it was told last
week.

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
capturing the keyboard, reading the project's source code, a fourth capture in one
picture, a mark that spans two of them, and per-member tilt (each device angled its own
way is two cameras, and a group that wants two angles wants two pictures). Version
history is not built either: restoring an earlier version of an item needs the edit
document to keep its own past, and that is the editor's side of the house.

## Strategic principles

1. **Local is the product, not a feature.** No upload, and no key or token for anything
   core. Recordings are files in `~/Movies/Fetch`, one folder per take. Say this plainly
   wherever an agent touches the machine. The single exception is principle 8.
2. **The competition cannot record a real machine.** One drives a cloud browser, web
   apps only, and wants your staging login. Another drives the iOS Simulator.
   another renders its own HTML. Fetch records any real window: native apps,
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
   Keychain. An agent can ask for one (`list_voices`, `voiceover`, which speaks the take's own
   captions back when it is given no script and sets the result as the edit's audio track),
   and it reaches the same account the person connected by hand: the key is never an argument,
   only the script is sent, and no agent can connect an account for somebody. Work handed to the person's own agent CLI (the chat pane, naming takes)
   goes out on their plan, not Fetch's, and is labelled where it happens: naming sends
   the app, the window title and the first 80 words, and its setting says so. Anything
   else that would need the network needs the same treatment or should not ship.

## Brand

Biscuit, a golden retriever puppy, is the mascot and the consent surface: when an agent
drives the machine, you always see the dog. He speaks first person only in onboarding,
where he is introducing himself. Everywhere else, and in anything a model reads, the
voice is plain and he is not mentioned.

Warm, not cool. The whole category is violet or pure black, and the agent-tool
category is bright and airy. Fetch is retriever gold on a warm near-black. If a
surface could belong to one of them, it is wrong.

## Tone

Plain, short, a little warm. Never cutesy-baby, never corporate.

- Good: "Nothing recorded yet." / "Saved to your Fetch folder." / "Never records 1Password."
- Bad: "Woof! Biscuit couldn't find any videos! :(" / "Operation completed successfully."

Errors say what happened and what to do, in one line, without blame.

Trust is built from **named exclusions, not adjectives**. "Private" means nothing.
"Never records 1Password, Messages, Mail or System Settings" means something.

**No em dashes.** Not in UI copy, not in docs, not in code comments.

## Anti-references

- **The subscription recorders.** Cool violet, subscription, cloud. The colour alone is a fail.
- **The light agent-tool look.** Airy, cream, photographic. Good work and a real bar
  for craft, but copying that palette would make Fetch look like a clone of it. Take the
  structural ideas (stable ids, audit log, provenance, carve-out copy), not the skin.
  Do not take the read-only timeline: those tools lock editing because they have no
  editor, and Fetch does. Attribution in the activity log solves the same problem
  without removing hand editing.
- **Generic dev-tool dark.** Blue-grey, monospace everywhere, dense tables. Fetch is
  warm and roomy.
- **Consumer AI slop.** Gradient text, glass cards, sparkle icons on everything.
