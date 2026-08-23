# Fetch: Product Hunt launch shot list

Grounded in the actual code as of this build. Every claim below traces back to a
specific file. Where something is real but not proven by the automated test
suite, it is marked accordingly rather than sold as tested.

---

## 1. Positioning

Fetch is a native macOS screen recorder with its editor and export pipeline built
in, not bolted on. It records a screen or a single window, a camera bubble, the
microphone and system audio (`main.js`, `ui/app.js`), then hands the take straight
to an on-device editor (`ui/editor.js`) that trims, crops, removes dead air,
denoises and normalises audio, burns captions transcribed entirely on-device, adds
text layers, frames the clip against a soft backdrop, and exports to MP4, MOV,
WebM, GIF or an audio-only file. All of it runs through one bundled static ffmpeg
binary (`processor.js`) with no network calls and no uploads. It is for people who
record product demos, bug reports, tutorials and social clips on a Mac and want
the trim-caption-export loop to happen without leaving the app, without a cloud
processing queue, and without their footage going anywhere they didn't put it.
Biscuit, the golden retriever mascot, is the app's only personality: he reacts to
state (idle, recording, thinking, done, sad) instead of the UI narrating at you.

---

## 2. Feature inventory

| Feature | File(s) | Status |
|---|---|---|
| Screen recording (full display, via `getDisplayMedia`) | `main.js`, `ui/app.js` | built |
| Window recording (single app window) | `main.js` (`WindowList` helper), `ui/setup.js` | partial — `main.js` comments note macOS's own window enumeration "returns almost nothing," so this depends on a bundled Swift helper binary as a workaround |
| System audio (loopback) + microphone mixing | `ui/app.js` `buildStream()` | built |
| Camera bubble (draggable, resizable, native overlay) | `main.js`, `CamBubble.swift`, `ui/setup.js` | built — `main.js` has a silent reload-retry loop for when another app holds the camera |
| Mic level meter + device pickers in setup | `ui/setup.js` | built |
| 3-2-1 countdown before recording | `ui/app.js` | built |
| Global hotkeys (⇧⌘R start/stop, ⇧⌘P pause) | `main.js` | built |
| Recording HUD (timer, pause/stop, excluded from capture) | `main.js`, `hud.html` | built |
| Recording border (shows captured display, excluded from capture) | `main.js`, `border.html` | built |
| Tray icon + menu | `main.js` | built |
| Cursor + click tracking during recording (feeds auto zoom) | `main.js` (`cursor-track`, `cursor-click`) | built |
| Library: list, group takes with their exports, thumbnails | `ui/app.js`, `processor.js` `listRecordings/describe` | built |
| Import any ffmpeg-readable file into the library | `main.js`, `processor.js` `importFile` | verified — `test/formats.test.js` |
| Reveal in Finder / delete to Trash (with sidecar cleanup) | `ui/app.js` | built |
| Auto thumbnail generation | `processor.js` `thumbnail` | verified — `test/engine.test.js` |
| Convert to another container/format from the Library | `processor.js` `convert` | verified — `test/formats.test.js` (all formats) |
| Trim | `processor.js` `trim` | verified — `test/engine.test.js` |
| Remove dead air (silence detect + cut, video+audio synced) | `processor.js` `removeSilence` | verified — `test/engine.test.js` (ground-truth clip) |
| Enhance audio: denoise, loudness normalise, gain | `processor.js` `enhanceAudio` | verified — `test/engine.test.js` |
| Crop with aspect presets (free, 16:9, 9:16, 1:1, 4:3) | `ui/editor.js`, `processor.js` `applyEdit` | verified — `test/engine.test.js` |
| Resize on export (original, 1080p, 720p) | `processor.js` `applyEdit`/`convert` | verified — `test/engine.test.js` |
| Text overlays (multi-layer, font, colour, size, position, timing, background pill) | `ui/editor.js`, `processor.js` `applyEdit` | verified — `test/engine.test.js` (incl. quotes/`%`/`:` in text) |
| Fade in/out (video and audio) | `processor.js` `applyEdit` | verified — exercised in `test/engine.test.js`'s combined export |
| On-device transcription (Parakeet TDT via bundled `Transcribe.app`) | `processor.js` `transcribe` | built — not covered by the JS test suite; depends on a compiled native binary |
| Editable transcript, click-to-seek cues | `ui/editor.js` `renderCues` | built |
| Burn captions into video (font, size, colour, position, box/outline) | `processor.js` `burnCaptions`/`applyEdit` | built |
| Auto zoom (pushes in on clicks/dwell points) | `processor.js` `autoZoomFilter`, `ui/editor.js` | built, and only works on recordings **made by Fetch**: it reads a `.cursor.json` sidecar written during capture. The code explicitly excludes window recordings ("a window recording has a different origin"), and imported files never have this sidecar. |
| Framed "backdrop" look (rounded corners, shadow, inset) | `processor.js` `backdropChain` | built |
| 6 built-in gradient backdrops (Dusk, Ember, Mint, Violet, Slate, Ink) | `processor.js` `BACKDROPS` | built |
| Custom image backdrops (drop a jpg/png in `assets/backdrops/`) | `processor.js` `imageBackdrops` | partial — the mechanism works, but the 10 backdrop images described in `assets/backdrops/PROMPTS.md` have not been generated yet; the folder currently holds only prompt text and a README |
| GIF export | `processor.js` `toGif` | verified — `test/engine.test.js`, `test/formats.test.js` |
| Waveform for the editor timeline | `processor.js` `waveform` | verified — `test/engine.test.js` |
| Cancel an in-progress export job | `processor.js` `cancel` | verified — `test/engine.test.js` |
| Multi-format export (MP4, MOV, WebM, GIF, M4A, MP3, WAV) | `processor.js` `FORMATS` | verified — `test/formats.test.js` across every format, both via `convert()` and the full editor export |
| Dev capture harness (`FETCH_EVAL`, `FETCH_SHOT`, `FETCH_OPEN`, `FETCH_EXPORT`) | `main.js` | built — this is how the developer stages and checks the UI today |

---

## 3. The hero shot

**The Look tab, mid-edit, with the framed backdrop applied.**

This is the one frame that proves Fetch is not just "another screen recorder": a
real captured clip, inset with rounded corners and a soft shadow, floating on the
warm gold "Dusk" gradient rather than the cool violet every competitor uses, with
a caption burned in and a text overlay on the stage. It reads as premium at
thumbnail size and it is instantly not-Loom.

**Stage it exactly like this:**
1. Record or open a short clip with clear on-screen content (a code editor or a
   product UI works better than a blank desktop).
2. `openInEditor('/path/to/recording-XXXX.webm')` (or click a clip in the
   Library), then open the **Look** tab.
3. Pick the **Dusk** backdrop, leave inset around 8% and corner radius around 26
   (the defaults), so the video sits inset with visibly rounded corners.
4. Switch to the **Text** tab, add one short overlay ("Fetch 100%" or similar),
   centred near the top, white text, background pill on.
5. Switch to **Captions**, run Transcribe once beforehand so the transcript is
   already there. Toggle "Burn into video" on so a caption line shows over the
   footage.
6. Frame the screenshot so the stage (video + backdrop) fills most of it, with a
   sliver of the gold-accented inspector visible on the right so it reads as "the
   app," not just an exported clip.
7. Via the dev harness: `FETCH_EVAL="openInEditor('/Users/you/Desktop/recording-XXXX.webm')" FETCH_SHOT=/tmp/hero.png FETCH_SHOT_DELAY=6000 npx electron .`
   (bump the delay if the Look tab and backdrop need manual clicking first, or
   drive it fully with a longer `FETCH_EVAL` script that also sets `ed.backdrop`
   and calls `paintBackdrop()`).

---

## 4. Shot list

1. **Record hero, idle** — still.
   Launch the app fresh (or `FETCH_SHOT=/tmp/1.png FETCH_SHOT_DELAY=2000 npx electron .`).
   Capture the Record view before any setup: Biscuit idle, the headline "What are
   we recording today?", and the gold "Set up recording" button.
   *Caption: "One click, and Biscuit is watching your screen."*

2. **Setup wizard, source step** — still.
   `FETCH_EVAL="openSetup()" FETCH_SHOT=/tmp/2.png FETCH_SHOT_DELAY=2500 npx electron .`
   Shows the live screen thumbnails with the "Live" badge and the stepper
   (Source → Camera → Audio) across the top.
   *Caption: "Pick a screen or a single window. See it before you hit record."*

3. **Setup wizard, camera step** — still.
   From the wizard, click Next once to land on the camera step. Shows the 3D
   "slab" with the nine placement slots and the floating bubble preview.
   *Caption: "Drag your face anywhere. It stays put while you record."*

4. **Setup wizard, audio step** — still.
   Click Next again. Shows the mic level meter actually moving (say something
   while capturing) plus the mic/system-audio toggles.
   *Caption: "Your voice, your speakers, or both."*

5. **Countdown into recording** — clip, 4-5s.
   Click "Start recording," let the 3-2-1 countdown play, and let it resolve into
   the HUD bar appearing at the bottom of the screen.
   *Caption: "Three, two, one. Go."*

6. **Recording in progress** — still.
   Mid-recording, capture the full display: the breathing gold border around the
   screen edge, the HUD pill with a live timer, and the camera bubble in its
   corner. This has to be a real screen capture of the desktop, not the app
   window, since the border and HUD are separate always-on-top windows.
   *Caption: "You always know what's being captured, and what isn't."*

7. **"Got it" modal** — still.
   Stop the recording. Capture the post-recording modal: Biscuit in the "done"
   pose, file size and Desktop confirmation, and the two big choices, "Export it"
   and "Enhance & edit."
   *Caption: "Saved to your Desktop before you've even decided what's next."*

8. **Library, grouped takes** — still.
   `show('library')` or click the Library tab. Record 2-3 clips beforehand and
   export a couple of variants so the grid shows the "N versions" gold badge and
   the CC badge on a captioned clip.
   *Caption: "Every take, every export, grouped together. Nothing scattered."*

9. **Editor, trim on the waveform** — clip, 5-6s.
   Open a clip in the editor, Trim tab active. Drag the in/out handles on the
   waveform timeline and let the playhead move.
   *Caption: "Scrub the waveform, set your in and out points."*

10. **Remove dead air** — still (or short clip catching the toast).
    Trim tab, click "Remove dead air." Capture the toast that reads "Cut 43%, 4
    segments kept" (numbers will vary with real footage).
    *Caption: "Cuts the silence. Keeps the good parts, in sync."*

11. **Captions, on-device transcript** — still.
    Captions tab, after running Transcribe. Show the cue list with editable
    lines and the "Burn into video" toggle.
    *Caption: "Transcribed on your Mac. Nothing leaves it."*

12. **Text overlay, live on stage** — still.
    Text tab, a layer selected and visibly draggable on the video canvas, with
    the font/colour/alignment controls open in the inspector.
    *Caption: "Drop in a headline, drag it where it belongs."*

13. **Export modal** — clip, 6-8s.
    Click Export, show format/quality/resolution chips being picked, then the
    progress bar filling, ending on the "Exported · N MB" toast.
    *Caption: "MP4, MOV, WebM, GIF, or audio only. Pick one and go."*

14. **Convert from the Library** — still.
    Library view, click the export icon on a card to open the quick-convert
    modal with all seven format tiles visible.
    *Caption: "Need a different format later? One click, no re-recording."*

---

## 5. The 60 second demo video

All beats use features that exist in the code today. No voiceover assumed;
on-screen captions carry it, in brand voice.

| Time | Beat |
|---|---|
| 0:00–0:05 | Cold open on the Record hero: Biscuit idle, headline on screen. Caption card: "Record it. Fetch it. Ship it." |
| 0:05–0:11 | Fast cuts through the setup wizard: pick a screen, place the camera bubble on the slab, toggle mic + system audio. |
| 0:11–0:17 | Countdown (3-2-1), HUD and border appear, brief clip of real screen activity with the camera bubble visible in the corner. |
| 0:17–0:22 | Stop recording, "Got it" modal appears, click "Enhance & edit." |
| 0:22–0:28 | Editor opens: drag the trim handles on the waveform timeline. |
| 0:28–0:33 | Click "Remove dead air," toast confirms the cut percentage. |
| 0:33–0:39 | Captions tab: click Transcribe (pre-warmed so it's fast), cues populate, toggle "Burn into video." |
| 0:39–0:45 | Text tab: drag a headline onto the stage. Look tab: apply the Dusk backdrop, video reflows with rounded corners and shadow. |
| 0:45–0:52 | Export modal: pick MP4, balanced, 1080p. Progress bar fills. |
| 0:52–0:57 | "Exported" toast, Finder reveal showing the finished file next to the original take. |
| 0:57–1:00 | Biscuit in the "done" pose holding the file. Closing card: "Fetch. Record it. Fetch it. Ship it." |

---

## 6. Copy bank

**Tagline**
Record it. Fetch it. Ship it.

**Subheadlines**
- Screen recording that stays on your Mac. Nothing uploaded, nothing waiting.
- Trim, caption and frame your clips without leaving the app.
- One dog. One click. A finished video.

**Feature blurbs**
1. Record: screen, camera and mic, set up once and go.
2. Captions: transcribed on-device. Nothing leaves your Mac.
3. Remove dead air: cuts silent gaps and re-joins the clip, automatically.
4. Auto zoom: pushes in where you clicked, on recordings Fetch made.
5. Framed look: rounded corners and a soft backdrop, done for you.
6. Export anywhere: MP4, MOV, WebM, GIF, or audio only. Pick a format and go.

---

## 7. What not to show

- **Window picker edge cases.** `main.js` comments say macOS's own window
  enumeration "returns almost nothing," so window listing runs through a bundled
  helper binary as a workaround. Pre-load the window list before recording the
  demo rather than capturing it live and hoping it populates in time.
- **A wedged camera.** `main.js` has a silent retry loop that reloads the camera
  view every 9 seconds if another app is holding the device. Don't record a demo
  with a frozen or black bubble; close any other app that might have the camera
  open first.
- **Auto zoom on the wrong source.** It only works on a genuine Fetch full-screen
  recording (it needs the `.cursor.json` sidecar written during capture, and the
  code explicitly skips window recordings because the coordinate origin
  differs). Never demo it on an imported file or a window capture.
- **A big backdrop image library.** Only 6 procedural gradient backdrops exist
  today (Dusk, Ember, Mint, Violet, Slate, Ink). The 10 photographic/illustrated
  backdrops described in `assets/backdrops/PROMPTS.md` have not been generated
  yet. Don't show or promise a large backdrop gallery.
- **Long GIFs.** `toGif` caps at 30 seconds and uses a 128-colour palette. Fine
  for a quick reaction clip, visibly rough for anything longer or high-motion.
- **A cold first transcription.** The first Transcribe click downloads the
  Parakeet model and reports download progress instead of a transcript. Run it
  once before recording so the demo shows a fast, finished transcript.
- **System permission dialogs.** macOS's own screen recording, microphone and
  camera prompts break the visual continuity and reveal the underlying OS.
  Grant every permission before recording any capture footage.
