# Fetch

> Record it. Fetch it. Ship it.

A macOS screen recorder and video editor. Screen, system audio, mic and a floating
camera bubble, then trim, cut, caption, zoom and export, all on-device.

Built because Loom costs $20/month.

## What it does

- **Record** a display or a single window, with system audio, mic, and a draggable
  circular camera bubble
- **Move the bubble after the fact.** The camera records to its own file rather than
  being burned into the screen capture, so it can be repositioned and resized in the editor
- **Transcribe on-device** (FluidAudio / Parakeet): a 2-minute recording transcribes in about 1.4s on an M5 Pro, edit the cues,
  and burn captions in
- **Auto-zoom** on the places your pointer settles, from a cursor track sampled during the take
- **Backdrops**, output shapes, crop, trim, a cut tool, and a second audio track
- **Export** to MP4, WebM, GIF, and audio-only formats

Your recordings, transcripts and exports never leave your machine: there is no
account, no cloud processing and nothing to sign into. The app talks to the network
for exactly two things, both switchable off in Settings: checking for updates, and a
once-a-day ping that counts the install (a random id, the app version, the macOS
version, and nothing else).

## Layout

| path | what it is |
|---|---|
| `main.js` | Electron main: windows, tray, hotkeys, capture sources, IPC |
| `processor.js` | The ffmpeg engine. Every export, transcode, probe and analysis |
| `ui/` | Renderer. `app.js` (shell, record, library), `editor.js` (the editor), plus self-installing modules |
| `CamBubble.swift` | The native camera bubble. Chromium cannot open the camera on some Macs, so this is AVFoundation |
| `WindowList.swift` | Window enumeration via ScreenCaptureKit, which sees windows `desktopCapturer` misses |
| `assets/` | Mascot art, motion clips, icon sprite, fonts |
| `BRAND.md` | Design system: colour, type, spacing, motion, component rules |

## Running it

```bash
npm install
npx electron .
```

`vendor/ffmpeg` is **not** in the repo: it is a ~50MB build and shipping a prebuilt
GPL binary in-tree is a licensing headache. Put an ffmpeg binary there before running:

```bash
mkdir -p vendor && cp "$(which ffmpeg)" vendor/ffmpeg
```

It needs libass, freetype, fontconfig and libvpx-vp9 for captions and WebM output.
`brew install ffmpeg` covers all of those.

`Transcribe.app` (the FluidAudio CLI wrapped as an app bundle) is also untracked.
Without it, everything except transcription works.

## Building a signed release

```bash
./build.sh        # compiles the Swift helpers, assembles and signs dist/Fetch.app + Fetch.dmg
./notarize.sh     # submits both to Apple, staples, verifies
```

`build.sh` signs with `Developer ID Application: Sankritya Thakur (J94T84BVCP)` and a
hardened runtime. Notarisation credentials are read from a keychain profile; store them once:

```bash
xcrun notarytool store-credentials fetch-notary \
  --apple-id <apple-id-email> --team-id J94T84BVCP --password <app-specific-password>
```

The app-specific password comes from appleid.apple.com under Sign-In and Security.

## A couple of things that will bite you

- Ad-hoc signing pins the TCC designated requirement to the cdhash, so macOS re-prompts
  for camera and mic on **every rebuild**. Developer ID signing gives a team-based
  requirement that survives rebuilds.
- The camera consent dialog shows the `.app` **folder name**, ignoring `CFBundleName`
  and `CFBundleDisplayName`. That is why the bubble bundle is named `Fetch.app`.
- VP9 with alpha needs `-auto-alt-ref 0`, and ffmpeg's own VP9 decoder ignores WebM
  alpha, so verify alpha clips in Chromium, not with ffmpeg.
- libass sizes captions against the script's PlayRes (about 288 lines), not video pixels.
