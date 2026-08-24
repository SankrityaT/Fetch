# Fetch: context for the Product Hunt launch

This file exists to bootstrap a **fresh chat** that has never seen the codebase. Read it
top to bottom and you will have everything needed to do Product Hunt research, write the
launch content, and advise on submission strategy.

**What that chat needs to produce:** competitor and category research, the PH listing
copy (name, tagline, description, first comment, topics), gallery and thumbnail
direction, and submission tips (timing, hunter strategy, comment cadence, ship-day plan).

---

## 1. The product

**Fetch.** A macOS screen recorder and video editor. Everything runs on-device.

> Record it. Fetch it. Ship it.

Origin story, useful because it is true and it sells: it started as a five-minute hack
to record a hackathon demo video, because paying $20/month for Loom for one video was
absurd. It turned into a full product.

### What it actually does

- Records a **display or a single window**, with system audio, mic, and a floating
  circular camera bubble
- **The camera bubble can be moved and resized after recording.** The camera is captured
  to its own file and composited at export rather than burned into the screen pixels.
  This is the Screen Studio-class feature and the strongest single differentiator
- **On-device transcription** (FluidAudio / Parakeet): a 2-minute recording transcribes in about 1.4s on an M5 Pro. Editable
  cues, burn-in captions with full styling, dragged captions land where you put them
- **Auto-zoom**, driven by a cursor track sampled during the take. Do not write
  "zooms where you click" anywhere: `cursor-click` is registered in `main.js` and
  never sent, so `data.clicks` is always empty and `zoomMoments` always uses its
  dwell fallback. What it actually does is zoom where the pointer moved a long way
  and then settled, which is a fine thing to say and happens to be true
- Backdrops (6 built-in gradients, plus any image you drop in) and output shapes
  (9:16, 1:1, 16:9) for social crops. Note for copy: the gradients ship, the
  10 designed backdrop images have not been generated yet, so do not promise artwork
- Trim, crop, a cut tool, text layers, a second audio track that can be mixed or replace
- Export to MP4, WebM, GIF and audio-only
- Folders, rename, in-app player, autosave and crash recovery, onboarding
- Auto-update: the client is built, but the feed it reads does not exist yet. See
  section 5. Do not put "automatic updates" in the listing until it does

**Your recordings never leave your machine. There is no account and no cloud
processing.** That is the privacy angle and it stays literally true: recording,
editing, transcription and export all happen on-device.

Be precise in copy, because two network calls do exist and both are off-switchable:
an update check, and a once-a-day anonymous install count (a random id, the app
version, the macOS version). Claim "your recordings never leave your machine", which
is true. Do not claim "no server" or "zero network", which is not.

### Pricing position

Not yet decided. The obvious wedge is one-time or free versus Loom's $20/month
subscription. Worth researching what Screen Studio's one-time pricing has done for it.

## 2. Competitors

| product | pricing | angle |
|---|---|---|
| **Loom** | ~$20/mo | The incumbent. Cloud-first, link-sharing, team features |
| **Screen Studio** | one-time, roughly $89 to $229 | The quality bar. Automatic zoom and beautiful motion |
| **Mosaic** | YC-backed | Newer editor, clean design language |
| **CleanShot X** | one-time ~$29 | Screenshots first, recording second |
| **Descript** | subscription | Transcript-driven editing, much heavier |

Fetch's honest position: **Screen Studio's polish, Loom's simplicity, no subscription,
and nothing leaves your Mac.** Research should pressure-test that claim and find the
sharpest framing.

## 3. Brand

- **Mascot: Biscuit**, a golden retriever, the emotional narrator of the app. He reacts
  to state: sleeping on the idle screen, running with a film reel while exporting,
  head-tilt while thinking.
- **Warm gold `#F0A93C` on warm near-black `#0A0908`.** The whole category is cool
  violet or pure black, so warm is the deliberate anti-Loom signal.
- Type: Bricolage Grotesque for display, Geist for UI, one italic Instrument Serif word
  per screen, Geist Mono for numbers.
- Voice: plain, short, a little warm. Never cutesy-baby, never corporate.
- **Hard rule: no em dashes anywhere.** Not in copy, not in docs. Commas, colons, full
  stops or parentheses.

Full system in `BRAND.md`. Landing page kit in `landing/`, including the real design
tokens, all fonts, 17 mascot stills, 4 alpha motion clips and a 78-icon sprite.

## 4. Technical facts worth using in copy

These are real and specific, which is what makes launch copy credible:

- The camera bubble is a **native Swift/AVFoundation app**, because Chromium cannot open
  the camera on some Macs. It is excluded from the screen capture via
  `NSWindow.sharingType = .none` and composited at export
- Window enumeration uses **ScreenCaptureKit**, which finds windows that Electron's
  `desktopCapturer` never lists
- Transcription is **Parakeet running locally**: a 2-minute recording transcribes in about 1.4s on an M5 Pro. Measured 79-88x
  realtime on speech-dense audio and up to 368x on sparse audio, because the work
  scales with how much speech there is, not how long the clip is. Quote the concrete
  number, not a realtime multiple
- ffmpeg 9 is bundled, with libass, freetype, fontconfig and libvpx-vp9
- Signed with Developer ID, hardened runtime, notarised

## 5. Launch status

- Code: **pushed to `github.com/SankrityaT/Fetch`** (currently **private**, decide
  whether to make it public for the launch)
- Build: `./build.sh` produces a signed `dist/Fetch.app` and a roughly 144MB
  `dist/Fetch.dmg`. `dist/` is gitignored, so that size is from a previous local build
- Notarisation: **still open, and it blocks launch.** The `fetch-notary` keychain
  profile does not exist on this machine (verified: `notarytool history` returns
  "No Keychain password item found"). It needs an app-specific password from
  appleid.apple.com, stored once via `xcrun notarytool store-credentials fetch-notary`.
  Until then Gatekeeper reports "Unnotarized Developer ID" and every downloader gets a
  scare dialog. Nothing about the launch copy fixes that, only running the command does
- Developer ID cert verified present and valid: `notAfter=Jul 27 02:10:36 2031 GMT`
- Distribution: no website yet. The landing page is being built from `landing/`,
  which is now self-contained: drop the folder on a host and it renders
- Auto-update is **broken, and it is a launch-day problem.** `ui/updater.js` reads
  `https://raw.githubusercontent.com/SankrityaT/fetch/main/latest.json`. That returns
  404 today for two stacked reasons: the repo is private, so `raw.githubusercontent.com`
  serves nothing, and `latest.json` does not exist in the repo anyway. Verified both,
  and both spellings of the repo name. The client handles the 404 without crashing, it
  just shows "Could not check for updates" to every user, forever. The consequence is
  that a day-one bug cannot be shipped to day-two users. Fix is either publish the repo
  and commit `latest.json`, or repoint `MANIFEST_URL` at the landing page host, which is
  the better answer since it decouples updates from the repo decision entirely
- No `LICENSE` file, and no third-party attribution shipped with the app. The bundled
  ffmpeg is a GPL build (libass pulls it into GPL, not LGPL). Distributing that inside a
  paid closed-source app carries obligations: ship ffmpeg's licence text and a written
  offer for its source. Worth getting a real answer on before charging money, and worth
  settling before anyone asks in the PH comments
- `LAUNCH-SHOTLIST.md` lists the screenshots and clips worth capturing for the gallery

## 6. Open questions for the launch chat

1. Pricing: free, one-time, or freemium? What does the comparable set suggest?
2. Public repo or closed source? Open source is a strong PH signal but this is a
   product they may want to charge for. Note two things that were not known when this
   list was written: the history is 7 commits from 2026-08-19 with no secrets in it
   (scanned), so "exposing the history" is not the risk it sounds like, and the
   auto-updater currently depends on the repo being public, which should be decoupled
   rather than used as an argument either way
3. Hunter: self-hunt or find one? Current thinking is unresolved
4. Launch day and time (PH resets at 12:01am PT), and which day of the week
5. Gallery order: what is the first frame someone sees?
6. Does the "no subscription, nothing uploaded" angle lead, or does "move the camera
   after you record" lead? Both are strong, only one can be the tagline

## 7. Assets available right now

- App icon at 1024px, `landing/assets/fetch-icon-1024.png`. Product Hunt's thumbnail
  is 240x240, so downscale it rather than shipping a 970KB PNG
- Mascot: 17 stills, and 4 alpha motion clips in `landing/assets/mascot/motion/`, each
  with a matching `-poster.png` for Safari, which cannot decode VP9 alpha
- The clips are small, 480x270 at most. Section accents, not full-bleed heroes
- `assets/MOTION-MOMENTS.md` designs a **fetch-back** clip and calls it "the payoff,
  the most watched, and the one that explains the product." It was never generated.
  `fetch-away` is the other half of that pair and is weaker alone. If the launch video
  or hero wants the money shot, that clip is the thing to commission
- Real product screenshots can be captured on demand from the running app
- The editor screenshot is the most persuasive single frame: timeline lanes, transcript
  panel, camera bubble on canvas, all visibly a real editor
