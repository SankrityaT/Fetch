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
this from: a framebuffer capture is a file with no audio track at all, so beats,
captions, `fit_to_length` and finding the moment by its words are all dead on it. Fetch
records the window instead, and **system audio is on by default for a simulator take**,
so the take has a track and the spine survives. That default is the sentence's other half:
with it off, recording the window was the framebuffer capture's silent file with a boot in
front of it, and three tool descriptions said otherwise. A simulated app is its own host
audio process, and a process of exactly that shape was captured and transcribed word for
word. Its own sound through the speakers at a level is not measured, because measuring it
means making a sound on somebody's Mac and that refusal outranks the measurement. So the
claim to make is that Fetch records the window and keeps the sound with it, not that the
device's own audio has been watched landing.

**The scope of that sound is everything the Mac plays while the take runs**, and every
surface says so: the tool descriptions, the result, and the question the person answers,
which names their music and a call. It used to be narrower. A window take's sound left out
every app that had a window when the take started, by naming those apps in the capture's
filter. That filter is what took macOS's screen capture service down: replayd crashed 25
times between Sep 18 and Sep 21, every one a use after free in its audio input callback,
because a filter that names apps (or asks to leave the recorder's own process out) has
replayd watch those processes and rebuild its audio queue whenever one changes state, and a
buffer in flight lands on the capture it just freed. Each crash took screen capture away from
the whole Mac, the system's own screenshots included, for up to 20 minutes. So no capture
names an app any more, only one stream ever captures sound, and the streams stop one at a
time, sound first, each awaited, with any failure written down (`Recorder.swift`). A Stop that
lands while a capture is still starting waits for the start to answer (up to 10 s) and stops
what it opened, rather than exiting under it. A window that drops out of capture is started
again once, when it is back on screen, and never at all when the service itself went away:
a start straight after replayd fell over is what keeps it down. The narrow
scope is back through a Core Audio process tap in the recorder itself (`Recorder.swift`
`SoundPlan`, `AppSound`), which coreaudiod serves and replayd never sees: a window take hears
its app and the processes it started or answers for, a simulator take hears that device's own
processes. It is used only on macOS 14.4 or later, only where the person has already given
Fetch System Audio Recording (a take never asks for it), and only where the target is not a
guess; anywhere else the take hears the whole Mac. The permission is asked for in one place:
the person turning on **Only the recorded app's sound** in Settings, which reads the permission
without asking and, when they turn it on, has the recorder ask (`Recorder --audio-access
request`). An agent's simulator take names its device to the recorder (`--sound-device`), so
the tap hears that device with two booted. With two booted, CoreSimulator's shared audio
service could carry the other device's sound, so such a take hears the whole Mac and says so
rather than claim the device alone. The tap reads its own buffers past any input the output
device has (a headset's microphone), and drops a buffer that is not its shape rather than read
the wrong sound as the app's. The recorder reports the scope on every take, `record_start`
says the scope it started with, and `record_stop` says it off the finished take's report:
`audio.scope` is `app`, `device` or `mac`, and `audio.heard` says it in words, with the reason
when it is the whole Mac. The tap is built and checked without recording anything, and is
**not yet proven on a live take**. The person's approval says **with sound**, and a
yes to a silent take is not a yes to one with it. The default rides only on Fetch's own
recorder; where the Mac falls back to the browser capture, a take whose sound was only the
default is recorded silent and the result says why: the default is the recorder's, and the
browser capture is only given sound somebody asked for. The default stays on now that the
recorder hears the whole Mac too, because the sound is the reason to record the window and an
agent's take never starts without the person's yes, which says **with sound** and names their
music and a call. A person who would rather not turns System audio off in Settings, and a
simulator take keeps that.

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
  conversation (`--resume` on the session id). `@` tags a recording by exact path, or a
  project from Conductor, Orca or Claude Code by its path, its branch and a line of what it
  is (see **Projects** below).
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
- The sample (`ui/sample.js`, `assets/sample/`, the `sample` tool): "Try the sample" in the
  Library bar, there even when the library is empty, opens two takes and a screenshot Fetch
  made itself of a product made up for it, laid out as real takes in a scratch folder of their
  own, so every tool and every export works on them and an export lands inside the sample. The
  person's own folders, provenance and view are set aside in memory and put back as they were,
  `collections.json` is not written while it is open, the sample is only ever deleted where it
  carries its own marker, and leaving compares a fingerprint of their save folder, their
  settings, the Library's own files, what Fetch remembers (`memory.json`) and the activity log
  with the one taken on the way in, so "untouched" is measured rather than said. The chat's own
  transcript is not in it: what they say while trying the sample is their conversation.
  `main.js` holds where the sample is (`sample-root`), so the Library's grid and an agent's
  `list_recordings` both list the sample and nothing else while it is open. What an agent
  remembers while it is open is kept in the sample and deleted with it, unless it names one of
  the person's own takes or a product that is not the sample's. The activity log marks its rows
  as the sample's and drops them on leaving. Leaving stops an agent's export of a sample take
  before the folder goes, and a folder a late export remade is cleared by the next open rather
  than refused. The takes have no speech, so the transcript, the beats and the captions have
  nothing to show on them.
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
are named whatever runs. The inspector shows what the engine drawing the stage draws, 62 of 69
fields with the three subtlest behind an Advanced disclosure, which is 44 controls a person
could not reach at all before.
Output keeps the take's shape; a chosen shape is filled by the background, and with no
background by a soft blur of the take, never black bars. Capture chrome is a setting:
for a take whose agent reported the page's viewport, and for a take of a simulator, whose
device screen rectangle Fetch writes onto the document itself, `frame.chrome: remove`
crops to the content exactly, which is what keeps a device's own drawn outline out of a
deliverable. A framed take is never masked tighter than the window's own corner.
Look changes are undo steps like any other edit.

**The compositor** (`ui/compositor/`, passes in `PASSES.md`). A WebGL2 renderer that
draws the editor's stage and the export from one plan (`plan.js`), so the stage is the
file's pixels: background, corners, shadow, zooms (on the quintic ease `motion.zoomEase`
names, with motion blur read off that ease's own velocity and the shutter at the film
standard 180 degrees, `treatment.motionBlur`),
fades, cuts, the camera bubble, and since M3 everything placed on the take: the Mac's
pointer lifted out, redactions, blurs, spotlights, lifts, steps, the agent's cursor with
its ripples and Biscuit's badge (or, where the take was of a device, the touch disc that
replaces the arrow: 44 of that device's own points across, appearing where a tap landed and
gone between taps, with no badge and no name tag on it, because a finger does not sign its
work), captions with the spoken word and frosted glass, title
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

**MCP tools** (`mcp/index.js`), 45: `get_look_schema`, `list_looks`, `apply_look`, `save_look`, `record_start`, `record_stop`, `record_status`, `record_pause`, `take_shot`, `pointer`,
`list_windows`, `list_displays`, `list_recordings`, `list_projects`, `get_project`, `simulator`, `probe`, `transcribe`,
`list_beats`, `get_edit`, `apply_edit`, `direct`, `review`, `fit_to_length`, `revert_my_edit`, `versions`,
`ask`, `propose`, `can_loop`,
`export`, `rename_recording`,
`remove_dead_air`, `enhance_audio`, `get_settings`, `set_settings`, `delete_recording`,
`get_frame`, `find_on_screen`, `preview_frame`, `contact_sheet`, `list_voices`, `voiceover`, `remember`,
`guidelines`, `sample`.
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
box, and Fetch picks the scale that frames it (`ui/targets.js`). Every action that uses an id
re-checks it, at the moment it acts, against what it was minted for (`ui/guard.js`), and refuses
when the element in front of it does not match; an id the matcher carried onto something else
is renumbered before any list shows it, never shown on the wrong thing. Panels and card grids come back too (found from their hairline edges), each element says which one it is `in`, and a new lift or spotlight replaces any it lands on and is held to the part of its span where its element is on screen (a card that opens mid-sentence is not lifted before it opens); a lift needs room: one at or near the frame edge, or on a pane whose content is cut off at its foot, is refused, naming the card or grid inside it to lift instead (`find_on_screen` marks these `no_lift`; a spotlight is offered only when nothing inside can stand for it). Re-aiming a zoom lists under `alongside` the lifts and spotlights still playing with it, so one an earlier turn added unasked is named or removed. `apply_edit` stops taking an
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
`audience`, `must_keep`, `must_hide`, `device`, `app`, `size`) and up to twelve steps `P1..Pn`, kept in `.fetch/<stem>.job.json`
beside the take and deliberately not in the edit, because the job is about the work and has to
survive the undo of the edit it produced. A brief naming a `device` is a job whose shape is
already known, so the plan comes back laid out with the call every step is, the tool's own name
and the arguments the brief has answered, which is how `export 1080p` stops being refused for an
enum nobody was shown. That job is also directed **before** there is anything to direct, since
which device to boot and how long the deliverable runs are decided before `record_start`: with no
`path` the job waits in `userData` and `record_stop` moves it onto the take it turned out to be
about. A `size` with a length window fills in `seconds` from `ui/sizes.js`, so a job aimed at a
store preview has its length from the first call rather than from the export that refuses it. `what` is what the thing is in the person's own words, and on a still it is nearly the whole
brief, since one frame has no length for the rest of it to measure. It was accepted by the
schema and thrown away on write for a round, which left the picture rubric building its own
`find_on_screen` fixes with no query in them, so the loop it opened could not be closed by
any call the agent made.
`fit_to_length` hits a number from the transcript:
the fillers first, since nobody can hear a cut "um", then the longest pauses, then whole beats
ranked by speech density, and never half a beat. **A take with nobody talking on it is fit on
its taps instead.** An app's onboarding makes no sound, so transcribing it returns silence and
the tool used to send an agent to `transcribe` and back for ever; a tap is a moment somebody
meant, and the 0.35 s before it and the 1.2 s after are the press and the screen answering, so
those runs are that take's spine exactly as speech runs are a narrated one's. The cheap cuts may
not go through a tap either: a cut through one leaves half a disc. All three passes cut around the work rather
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

**A product's rules, read before anything is done** (`ui/guidelines.js`, `guidelines`). The
facts that decide work before it starts get sections of their own: what the product is called
and how it is said, who a demo of it is for, what must never be on screen, how its screenshots
look, and the words it avoids with what it says instead. A rule is a product fact in the same
file under the same `F` ids and the same refusals, so a secret is refused here as it is there.
The person's own words are in force at once: written in the **Product guidelines** card in
Settings, where they also say yes or no to an agent's drafts and remove a rule, or relayed by an
agent and confirmed by the person in a question Fetch asks with the words in front of them. What
an agent drafts from the product itself (its screens, its help pages, its code) is a draft, in
no briefing and failing nothing, until the person has been shown it word for word (`show`,
which hands back a seal) and said yes (`adopt` with that seal, and any rewording they made on
the way in). Nothing an agent sends is taken as the person's yes on its own: the seal only
proves the words did not change after they were shown, so the bridge asks the person before a
rule sent as theirs goes into force (unconfirmed, it is kept as a draft) and before an adopt
(unconfirmed, it is refused), and a `remember` never settles a draft, whatever it says. A draft that would change a rule in
force sits beside it and takes its id on yes, so an id an agent holds never starts meaning
something else. The rules reach the agent before it acts: they open the memory block, under
their own budget, in the in-app system prompt and on `direct`, `apply_edit`, `apply_look`,
`take_shot` and `record_start`, and the server's instructions tell an outside agent to read them
before it plans, captures or styles anything. They are checked by machine as well as read, where
the work is (`ui/agent-bridge.js` `rulesCheck`, over `ui/guidelines.js` `check` and `gate`): the
words it avoids, how its name is written, how its pictures look, and what must never be on screen,
held to every frame an Elements pass has read off the take, the agent's and Fetch's own. `take_shot`
reads the new picture once where there is a never-rule to hold it to and hands the findings back
with the capture; `review` returns them under `guidelines` beside the rubric, each with the call
that fixes it; and `export` holds the edit to them before a frame is drawn, and refuses a video or
a PNG that shows what a never-rule keeps off screen and is not under a redaction, naming the
redaction by element id. A rule that could not be checked (a frame nobody read, a person's name,
which has no shape) comes back under `unchecked` and is never said to have passed, and refuses
nothing. `find_on_screen` still names a label a never-rule keeps off screen the moment the agent
looks, and `review` still holds the verdict at nearly on the words the product avoids (`rule-words`)
until they are fixed or declined. Rules belong
to one product, always named; a rule with no product is refused rather than filed for everyone.

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

**A simulator is a thing Fetch knows** (`ui/simulator.js`, `ui/simctl.js`, `simulator`).
A Simulator window was a window with a name that happened to match; it is now a window
with a machine inside it. `ui/simulator.js` joins the three reads the command line
already answers to the window list and to the device type's own `profile.plist`, which is
the only place the native framebuffer size exists, and hands back one record a device:
which device, its screen in pixels and points, and, where anything has captured its
window and the measurement passed, the rectangle the glass occupies inside that window and
`density`, the captured pixels per pixel the device really has. A measurement that came back
the wrong shape reports neither: a density off a dark splash read 0.15. `list_windows` carries that block on any
simulator window, so nothing has to match on an app name.

**That rectangle is measured and never worked out.** Fitting the screen's aspect inside
the window assumes the window is the glass, and it is not: Simulator's floating toolbar
is 52 points tall whatever the window scale, with a clear gap and a drawn bezel under it,
so the glass is a different fraction of every window and moves again the moment somebody
drags a corner. Measured against three booted devices on this Mac, the fit was 12 percent
out on a phone with a notch and 19 percent out on one with a home button, which sent a tap
aimed 60 points down the screen nearly 90 points above the glass and left the Mac's own
toolbar inside a crop that promised to remove it. `measureGlass` reads the rectangle off a
capture of the window instead, by the structure every one of those captures has: a clear
band under the toolbar, then the device, then the black ring the screen sits inside. The
1320 x 2868 phone measures a viewport of `{0.0554, 0.0896, 0.8892, 0.8929}` and a density
of **0.53**, not the 0.60 the arithmetic claimed. The measurement is kept against the
window's own size, so moving the window changes nothing and resizing it throws it away.
A later read that fails, or finds a rectangle that is not the screen's shape (a dark app
painted to its edge, a splash, the boot logo), never replaces one that passed for the same
size, and `record_stop` writes the newest rectangle that passed during the take rather than
only the one `record_start` got. The shape test is held to the measurement's own rounding,
two pixels a side, since a fixed 0.15 percent turned a correct rectangle down on a third of
window sizes and on most 1x displays. The captures it is read off are scratch files in the
temporary folder, never a shot in the person's library. **A device nothing has measured has
no rectangle at all**: `list` says so in words,
a tap refuses rather than landing somewhere nobody pointed, and the look keeps the whole
window rather than cropping to a guess.

**The surface is one tool and four extensions.** `simulator` takes an action: `list`,
`ready` (boot, open the window in the background, install, launch, set the status bar,
switch the appearance, measure the glass, and name every one of those in words), `go` (a
deep link, which lands on the same screen every time where a run of taps does not), `tap`,
and `restore`. `record_start` and `take_shot` take `simulator` where they take `window`,
measure the glass off a capture of it, and write that rectangle onto the document, which
is what makes the crop, the drawn phone and the touch mark's coordinates fall out for
free. **A simulator take carries the device's sound by default**, which is the whole
reason Fetch records the window rather than the device's framebuffer, and `record_stop`
reads the written file and says whether a track actually landed, and whether it sits at the
noise floor, rather than leaving `transcribe` to break the news. `export` takes `size`, a pair of integers from one table
(`ui/sizes.js`), never an aspect, because a store file one pixel out is rejected: on a
shot a still size, and on a recording an **app preview**, which is also 15 to 30 seconds,
30 frames a second or under, H.264, and 500 MB or under. Everything that does not hold is
named before a frame is drawn, frames are dropped and never invented (60 halves onto the
cap exactly, and the rate is read off the take's cadence rather than the header's average),
the sound is one stereo AAC track at 256 kbps and 48 kHz (silence of that shape on a take
with none), and the family is the one the take records, so an iPhone take asked into the
iPad size is refused by name. Whether the capture would be enlarged is judged at the share
of the picture the look actually draws it at, and a refusal names the `frame.padding` that
puts it at its own pixels, the one fix an agent can make without the person's hands, and
the same refusal names the length when that does not hold either, rather than keeping it for
a second call. The picture is H.264 High Profile Level 4.0 at a constant 11 Mbps, inside
the page's 10 to 12, and the take is drawn at exactly the box the gate judged
(`plan.box`), not where the look's padding would have put it. A drawn phone grows round
that box, and where it would run off the picture (a share of 0.95 put it past all four
edges) it is fitted inside the box instead, a smaller take and never a cut shell. The
glass's measured corner rides with the viewport into the edit and the still alike, so the
screen is masked at the device's own radius and no crescent of Simulator bezel shows in
its corners. The crop starts on the glass's own pixels: it used to round its start down to
even, two pixels onto Simulator's black ring on the top and the left, and now rounds it up
onto the glass. The classic renderer and the levels read cut the same pixels
(`Plan.cropPx`), so a GIF and the black point see no ring either. A plain export of a device
take is masked at that corner too: with nothing behind it the corner is black, which is what
the ring was there. A take recorded before the corner was stored has it read off one of its
own frames when it is drawn (`ui/compositor/prepare.js`, the middle frame, then a quarter
and three quarters if the screen is dark there), within a few pixels of the stored rectangle
(`ui/simulator.js measureCorner`). The glass is what is joined to the glass: in each corner,
the lit pixels joined through lit pixels to the square's two inner sides, so the bezel's grey
highlight, which the old walk took for glass on a recording and read as 0.0535 against a true
0.1578, is never counted. A reading is refused, never guessed, when fewer than two corners
agree, when ring shows inside the circle, or when it falls outside the band round the screen's
own radius where that is known. An `export` writes that corner onto the edit's viewport only
once it has passed that check (two corners agree, no ring shows inside it, and it sits within
the band round the screen's own radius where that is known). A stored corner outside that band
is dropped where the document is read (`ui/fetchdoc.js cleanViewport`), so every reader, the
person's own export, the editor and review as well as an agent, draws as if there were none and
reads it again. On a screen whose radius is not known (every iPad), a stored corner is checked
against one frame of the take and gives way to the reading where the two disagree. The
document gets the checked reading in its place, or no corner where the reading is refused, so a
wrong number is never kept for every export after it. **The picture is the
length**: the sound is padded to the edit, never the other way round. The written file is
measured again afterwards, frames counted off the file, and the result's `seconds` is that
count, so nothing is called a store file that is not one: a file short of its edit is not
kept, and one outside the rate band is not called the store file. Measured on the judged
take, a 28 s edit exported through the real `export` op: before, 23.93 s at 0.46 Mbps
with `seconds: 28` at the top of the result; now 28.00 s at 11.02 Mbps, the take drawn at
99, 212, 689 x 1497 of 886 x 1920 on every frame measured, and the plan's export step
closed by the file. `pointer` gains nothing: the take's target decides the mark, so an
agent reporting a tap on a device gets a finger without knowing there is a setting.

**Each simulator argument takes one kind of identifier, and says which.** `device` a UDID
or a name, `app` the absolute path to a built `.app` (installed, then launched by the
bundle id its own Info.plist declares), `bundle` a bundle id already on the device, `url`
a link with a scheme, `element` an E or R id. The judged job's one wasted call was a
bundle id that `direct` had written into `app`, refused only after the person had said yes
and the device had booted. Now the director sends the brief's app to the argument that
takes its form, and the bridge reads the form of every identifier before anything is asked
or spawned: where it is certain (a bundle id is never an absolute path) the value is moved
and the result says so under `moved`, and where it is not the refusal names the argument it
belongs in. A device not found that looks like a bundle id or a window id says so.

**A take's sound is on its picture's clock, and the result says where it sits.** A window
take's sound comes from a second capture that was opened after the picture's, so a
simulator take started its sound 2.3 s late, and every reader that takes a track from its
first sample moved it 2.3 s early. The recorder now opens the sound first, queues it rather
than dropping it while the file is busy, and writes silence into every stretch the capture
sent nothing, from the first frame to Stop, so a sample's place in the file is its place in
time. The written position is the sum of what was written, not each buffer's own stamp,
so a sound clock running slow or fast against the host clock is corrected as it builds, with
silence when the file falls behind and the head of a buffer let go when it runs ahead:
generated at 2000 ppm either way, a click stays within 4 ms of its frame where it was 14 ms
out at 7 s and growing. Takes already on disk have their late start put back by every export,
transcript, waveform and conversion (a wav from a 2.3 s-lead take had its 3 s click at
0.7 s). `record_stop` and `probe` carry `sync`: where the file's first sound frame is, where
its last one ends against the picture, how much was filled with silence and how much was let
go, in numbers and one sentence, and the recorder's own account on `record_stop`. `in_sync`
is true only when the end was measured and lands with the picture: the judged take's sound
ends 1.71 s early because the recorder of the time dropped 20 ms at a time inside the take,
and no export can put that back, so it says `in_sync: false` and says to record again or
narrate with voiceover. A window take's sound stream that stops with an error part way is
let go and never reopened (a capture that just failed is not started again), and the
recorder fills the file to Stop with silence, so its track ends with the picture and nothing
downstream would notice. The recorder's own account does: `sync.silent_end_ms` on
`record_stop` says how much of the end is silence, and the sentence says the sound stopped
arriving that long before Stop.

**The named job is five calls plus the loop's three.** `ready`, `record_start`, a tap a
screen, `record_stop`, `export`, and the `direct`, `fit_to_length` and `review` every job
in this product takes. On a stock Simulator window at its default size the glass is about
0.53 of the device's own pixels, so an app preview is an enlargement and `export` refuses
it with the `apply_look` padding that fixes it: one call more, or none where the person set
Pixel Accurate first. Judged against a real device it took nineteen, so the calls that
were only there to find things out have been given to the calls that already knew: `ready`
and every `tap` hand back the elements on the glass and the ids the next tap takes, a
brief can be directed before the take exists and lands on it at `record_stop`, which closes
the steps that made the take and names the take in the calls after them, a plan for
a device job carries the call each step is, and `fit_to_length` cuts a take with nobody
talking on it on its taps instead of refusing it for having no transcript.

**A tap aims at a box, never at a coordinate**, which is the rule the rest of the product
already enforces and the one place pixels beat a tree: `find_on_screen` works on canvas,
on games and on custom drawn UI where a label does not exist. The element's box is read
back through the edit's crop and the glass rectangle into the device's own points, and
the same call reports the touch onto the pointer track, so an injected tap and the mark
drawn for it are one number rather than two that agree by habit. A point sent by hand is
taken where nothing on screen can be named, and comes back marked hand aimed.

**The same control keeps the same id.** Ids used to be positions, E1, E2... in reading
order on each picture, so in the judged job `ready` listed Sign in with Apple as E18,
`record_start` took its own picture of the unchanged screen with one tooltip gone above it
and listed it as E17, and the tap sent with E18 was refused. Now each picture of a device
is handed that device's last list, and `ui/targets.js` keeps an id wherever it is sure the
element is the same one (the same words, the same sort of thing, the same size, and where the
rest of the screen says it should be) and numbers everything else past every id the run has
handed out. Where it is has to agree with the rest of the screen: a word that moved is kept
only when the words around it moved with it, and never when it passed rows that stayed where
they were, so a row's Delete that shows on Carol's row after it showed on Alice's is a new id
and the one held for Alice's is refused. So an id held from an earlier screen of the device
names the same control on the newest one, or is refused as not there. A control repeated down
a list (a Delete per row) takes its identity from its own row's words and nothing else, so when
a row is deleted its Delete's id goes with it and never passes to the next row's; before, the
rows closing up under a title that stayed put carried every Delete's id one row up. A row with
no words of its own is never carried at all: rows that all read "Untitled", a cart of "Milk", a
grid of bare thumbnails, or rows named only by their place ("Step 1", a price, a time). Delete
the first of twenty and the next scrolls in, or delete Step 1 and Step 2 is renamed, and the
same count sits in the same places, so the id dies and the agent looks again. A heading replaced
in place (the recipe's name became the next recipe's over the same toolbar) is another screen,
and nothing on it is carried; a name that changes under a taller nav title is a swapped heading
too. A card, panel or grid keeps its id only by its words, numbers aside, and only when no
other pane on the picture reads the same: cards that all read "Untitled Edit Delete" or "Step N"
are never carried, and a panel is never carried by its place alone. The things it cannot tell apart are a control with the same
words, size and place on a screen the device navigated to (a Done in the same corner), two
controls that each appear once on a one-row screen whose label changed below a heading that
stayed, which vouch for each other, and an item's name set below the top quarter (under a hero
picture); all are carried as the same controls, and only the guard below, at the moment of
acting, catches the last two. A second
`find_on_screen` of the same moment keeps its ids the same way, and a search of an older
picture in the run is numbered on from the run, and moves the run's count on, without becoming
the screen the next picture is matched against. A tap is only ever aimed on the device's newest
screen: an id sent with the path of an older picture in the run is looked up there, and refused
when it is not on it. The bridge checks that each pass really carried on rather than starting at E1
again (a list that handed out nothing is no proof), and where one did not, the run starts over
and a bare id is trusted only on the newest pass, as before. An id sent with no `path` is read
off the device's newest screen while that screen is the newest `find_on_screen` pass, or while
the newest pass was another picture in the same run; an id off any other picture needs its
`path`, because it was numbered on that picture and can name something else on the device. A
screen is only handed back from a capture the same call made. `processor.js findOnScreen`
passes the earlier list through, and keeps the shown list in reading order rather than by the
number in each id.

**An id is checked as it is used, not only when it is carried** (`ui/guard.js`, wired in
`ui/agent-bridge.js`). The matcher above guesses which element on a new picture an old id named,
and two rounds of patching it case by case each found another case: a panel (a card holding Edit
and Delete) carried by its place alone, so moving Pancakes to the top of a recipe list made every
card id name a different recipe, and a detail screen whose taller nav title stayed carrying
"Delete recipe" to the next recipe. So the matcher is no longer what keeps the promise. Every list
an Elements pass hands back, the agent's and Fetch's own, is recorded in a ledger before it is
ranked or drawn (the processor runs the bridge's hook), which writes down what each id is: its
words, its kind and size, the card it sits in and that card's name, its row, its place among
things that read the same, and the loose words of the screen round it. Anything the matcher
handed an old id that it does not match takes a new id, the old one is spent, and
`find_on_screen`, `ready` and every tap say which under `ids_retired`. Then, at the moment of
acting, every place an id becomes an action goes through one door (`resolveElement`) that holds
the element in front of it to what the id was minted for and refuses anything that does not
match or cannot be told, in a sentence that says to look again: a simulator tap, every zoom,
every kind of mark (lift, spotlight, loupe, arrow, redaction, blur, step), and every label and
callout pinned to an element, on a recording and on a shot, and the proposal card's frame. The
box it hands back is the judged element's own.

What the guard holds an id to, after a round spent attacking it: a label's words as they are
spelt (a verb may change form in place, "Delete" to "Deleting...", on a screen otherwise the
same, but "Ann" is not "Anne" and "Note" is not "Notes"); a row's words exactly, with no new
naming word ("Shakshuka" is not "Green shakshuka") and its numbered words figures and all
("Order 1044  Wed" is not "Order 1045  Wed"); a card's first line's figures ("Maya Chen 1043"
is not "1042"); and the screen's own words of any size, beside a time or in a small subtitle,
where a name replaced in place, or a heading's number ("Invoice 1042" to "Invoice 1043"), means
another item. Two rows that would each pass for an id's row refuse it.

A tap is judged on a picture of the device taken after the person's yes and just before the
touch, never on the list the agent holds, which can be a whole Allow dialog old: a sync that
pushed every row down one while the dialog was open moves the finger with the row, and a device
that cannot be read then is not tapped by id. An id off a still or a recording is refused once
the device has handed back a screen of its own, since the order lists were searched in says
nothing about when their pictures were taken. On a recording an id aims only inside the span it
was read in, give or take a second: the recipe at y 0.27 at 2 s is another recipe at 8 s, so a
redaction at 7 to 9 s with an id from 2 s is refused with the moment to read. Every id the agent
was handed stays on the list it came in however many searches later, and an id its run ever
handed out is never looked up in a pass Fetch ran for itself, which numbers from E1; what
Fetch's own passes found reaches the agent by its words and box (a zoom's snap, a never-rule's
fix), never by an id. `test/tools.test.js` holds the bridge to this the way it holds the tool lists to each
other: only the door turns an id into a box, the door calls the guard before it returns one,
every Elements pass is handed the hook, and every tool that takes an element id drives an op
that reaches the door, so an op added later cannot quietly skip it. On one recording an id is
never handed out twice: a search of another moment numbers past every id the recording has
handed out rather than from E1, so an id held from the first search still aims at what it named
there, and a matcher mistake costs one `find_on_screen` instead of the wrong row's data. What is
left: an R id is an area the person drew, and aims at that area rather than at an element; a
tap costs one more picture of the device; a screen still moving at the instant of the touch
(mid scroll) can move between that picture and the finger; and a label renamed in place to
another form of itself ("Bake" to "Baked") on a screen otherwise unchanged is taken for the
same control, since no picture can say otherwise.

**What it refuses, permanently.** The device framebuffer capture, which writes pixels
that never passed the never-record check and makes a file with no audio track. A region
of the device screen, which is judged as a display and gives frozen pixels when something
covers it. Creating, cloning, erasing, deleting, upgrading and uninstalling, refused to
everyone including the person through an agent, because a device is theirs to destroy at
a command line. Bringing anything to the front, moving this Mac's mouse, pressing its
keyboard, and making a sound. **Booting, installing, launching, opening a link and
tapping each need the person's word**, which Fetch asks them for in a dialog and mints
itself: an agent that can set its own consent flag has no consent rule at all, so
`consent` is not an argument on any tool. `neverRecordDevices` is a never list by UDID
beside the one by app name, human only, because a simulator is one app hosting anything
and "not that phone" cannot be said in app names. Anything Fetch changes on a device is
written down before it changes it and put back on stop, on failure, and on the next
launch if Fetch died mid take, so nobody's simulator is left reading 9:41.

**Not built**, and not to be claimed: driving apps (Fetch records, other tools drive),
a touch injector for the Simulator (a private input path that breaks with each Xcode, and
somebody else's engineering project), an accessibility tree driver (Fetch aims at pixels,
which exist on canvas, in games and in custom drawn UI where a tree does not), a swipe
trail, a long press or a pinch, the locale and device matrix batch runner, and a
simulator as a member of a group shot,
capturing the keyboard, reading the project's source code, a fourth capture in one
picture, a mark that spans two of them, and per-member tilt (each device angled its own
way is two cameras, and a group that wants two angles wants two pictures).

**Version history** (`ui/history.js`, `versions`). Session undo dies with the window and
`revert_my_edit` only knows an agent's own last burst, so neither could answer "what did
this look like on Tuesday, before the agent re-cut it". Every settled state of a take's or
a shot's edit is a version in an append-only sidecar beside it
(`.fetch/<stem>.history.jsonl`), with a stable id (`V12`), who made it (an agent by name,
or the person) and one line of what changed in the ids the timeline draws. **A restore is
a new version on top**: nothing is rewound, so everything ahead of it stays and can itself
be restored, and the id counter only moves forward. The person reaches it from the History
button beside Undo (Cmd+Y): look at a version on the stage, then Restore or Back to now.
An agent reaches the same log through `versions`: `list`, `look` (what restoring it would
change, its edit, and a frame drawn by the export's renderer, with nothing changed) and
`restore`, whose result names the call that takes it back. Kept: everything from the last
week, the last of each day for three months, the last of each week after that. The first
version and the newest are kept always. Every restore and the person's own state just before
an agent took over are kept whatever their age for the week, then one a day and one a week
like the rest, and they are the last to go at the cap. The cap is 1,000 versions or 16 MB a
take: one author's bursts (versions within five minutes) collapse to their last state first,
then the oldest versions go; the size bound is measured line by line and never thins inside
the week past the bursts, since a week of corrections is what a history is for. The history
is a sidecar, so a rename carries it and the Trash takes it with its take, and a line that
did not reach the disk is not a version: the change rides into the next one, written whole.
A restore brings back the files a version used where they still are, follows the ones a
rename moved, and says so where a file is gone or was rewritten in place since (voiceover
writes one track per take). While the person looks at an old version, anything that reads
the edit (`get_edit`, the chat, a rename) reads the edit as it stands, not the stage, and a
look or a restore waits while an agent's change is landing.

**Keyboard, and a brake.** Fetch has a real menu bar with the Mac's own keys (Cmd+1 to 4
for the four screens, Cmd+F for search, Cmd+Y for history, Cmd+, for Settings). **Esc
stops an agent that is driving, whatever has focus**: while one of its calls runs, a chat
turn runs or its take rolls, and for three seconds after, Esc is Fetch's, and pressing it
cancels the chat turn, stops an agent's take (kept, not discarded), stops every export an
agent has queued or running (the file that was there stays as it was), withdraws every "until
Fetch quits" yes, and refuses every later call with a sentence telling the agent to stop and
ask, until the person lets it continue. A yes clicked on a dialog after Esc does not act, and
a take whose start was already on its way is stopped the moment it goes live. **The trade**:
in that stretch Esc is taken from the app in front, a terminal agent's own interrupt key
included, and the pill says so ("Esc in any app stops it here"). Between calls, while an
agent thinks, Esc goes back to the app in front so a terminal's Esc still reaches its agent,
but the brake stays armed for as long as the agent is connected (until its socket closes or
five quiet minutes): the pill's Stop, Agent > Stop, the tray and Esc in Fetch's own window
all stop it then. A message to the in-app chat lets only the chat's own agent go on (its
shim names itself with `--chat`); a stopped terminal agent waits for Let it continue. Stopping
the chat turn is bounded: the CLI is asked to stop, told to two seconds later, and the turn is
ended by Fetch two seconds after that whether or not the process has gone, so the pane is
free again in under five seconds even when the CLI is sitting on a tool call.
An export an agent asked for can also be stopped by the agent's own client: `export` hands the
app a key for the work, and a cancelled call, or one the server gave up waiting on, sends
`job.cancel` with it, so the export stops where it runs and the call answers that it was
stopped and nothing was written. A client whose connection closes takes its exports with it.
Stopping is measured, not only answered: `npm run test:gl` stops an agent's export through
the queue on both renderers and checks that its encoder was found while it ran and is gone
within a second, that no scratch or partial file is left, that the deliverable is byte for
byte what was there before, and that the queue's lane is given back.
Cmd+. and the Stop button on the working pill do the same,
and an Esc in Fetch's own window is caught ahead of every other handler, which covers the case
of macOS not handing a bare Esc to a global shortcut (proven through the registered callback,
never by pressing a key).

## Projects: from @ to the window worth recording

"@majuro record a demo of the lasso" is the person naming a folder of their own code, and
Fetch records windows. The person's words for the need were that they could not tell it what
to record because they could not attach the path. So a project is a thing Fetch knows, and
nobody pastes a path or a window id.

- **The index** (`ui/projects.js`) lists every project the person's coding tools know:
  Conductor workspaces and repos (its folders, and its database read only, a handful of named
  columns and never notes or prompts), Orca's projects and workspaces, and Claude Code's
  project folders, decoded against the disk because a dash in a real folder name makes the
  folder name ambiguous. One folder two tools know is one project. Each carries a name, a short
  `handle` (what `@` completes to), its path, branch and remote, and one or two sentences from
  its README, PRODUCT.md, CLAUDE.md or AGENTS.md. Nothing named like a secret is ever opened,
  checked on the path as asked and on the real path with every symlink resolved, and a
  worktree's gitdir or commondir that leads outside the project or a real git folder is not
  followed. A first paragraph that talks about a password, token, key or secret is dropped
  whole, and key-shaped runs, URLs with a user, password or query, and a remote's user,
  password and query are cut. Claude Code's folders are listed and never read (they hold
  conversations). What is read goes only to the model of the chat the person tags a project
  in, or of an agent the person said yes to, and the chat's log keeps a tag's name, path,
  source and branch, never the description. Built on a worker, kept 30 s.
- **The finder** (`ui/project-windows.js`) says what runs from a project now and which window
  a take of it would be: its own app (an executable inside the folder, or built there by Xcode,
  or running with it as its working directory), its app on a simulator, or a browser window
  showing its dev server. A window title that says the project's name is never evidence, since
  a terminal and an editor say it all day. It refuses to pick between two equals, names the
  Fetch doing the recording and never picks it (it hides its own window during a take), and
  says when the window it found is not on screen. When nothing runs it says what would start
  it; Fetch starts nothing.
- **The turn.** A tagged project, or an `@name` typed straight through that answers to exactly
  one project, reaches the agent on that turn with where it is, what it is in its own words,
  what runs from it right now and the call that records it (`main.js` chat-send,
  `agentBridge.projectTurn`, `EditAssist.projectLines`). That read is the one await in front of
  a turn, bounded at 8 s, and a Stop during it starts nothing. The standing doctrine says to
  record a project by naming it and never to ask the person for a path or a window id.
- **The tools.** `record_start` and `take_shot` take `project` (a name, handle, id or path)
  and find its window at the moment of the call. When nothing suitable is running, or the
  window is off screen, they refuse with the finder's own sentence and start nothing, rather
  than record the app in front. A name must be exact: a near miss is refused with the closest
  names. The window found is put to the person's yes by the app Fetch read it as. The window
  list used to skip every app named Electron, so a dev build was invisible to `list_windows`;
  it now skips the Fetch that ran it by pid, and gives each window's `pid`. `list_projects`
  lists them lean (names, paths, branches), and `get_project` says one whole: what it is,
  what runs from it and why, its product and its rules, and its Library folder. Fetch's own
  chat calls these freely, since its `@` is the person handing a project over; any other
  agent connected to Fetch is asked about first (a native question, a yes that can hold until
  Fetch quits, silence is a no), and that includes naming a project to `record_start` or
  `take_shot`.
- **Rules and folder.** A project's takes and shots are named product first (`Fetch · majuro`),
  so the rules and facts kept for that product follow the file the way they follow any take.
  The product is one the person already keeps rules for when the project answers to it, else
  the remote's repository name, else the handle. `guidelines` takes `project` as well. A take or
  shot of a project is filed in a Library folder named for it, through the Library in the
  window; this build's Library has no call to file into a folder by name yet, so the result says
  `filed: false` and why, until `ui/library.js` exports `fileInto`.

Not yet proven live: a take started from `@majuro` end to end. On the Mac this was built on,
the only thing running from majuro is the development Fetch itself, which the finder names and
refuses (it cannot record itself); recording it takes the installed Fetch.

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
   no window to record), Lore Pilot drives native apps, and the command line that ships
   with Xcode boots, installs, launches and deep links a simulator. Composition, not
   reimplementation: Fetch builds the argv, reads the exit code and says a sentence, and
   a line of Fetch code that reimplements one of those verbs is wrong and should be
   deleted in review. That command line has no tap, no swipe and no type, forty two
   subcommands and no gesture of any kind, so a touch is driven by a tool the person
   installed or it is refused in words. Lore Pilot stays private; do not pull its code
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
