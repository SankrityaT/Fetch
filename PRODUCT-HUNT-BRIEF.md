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
- **On-device transcription** (FluidAudio / Parakeet, roughly 116x realtime). Editable
  cues, burn-in captions with full styling, dragged captions land where you put them
- **Auto-zoom on cursor clicks**, driven by a cursor track sampled during the take
- Backdrops and output shapes (9:16, 1:1, 16:9) for social crops
- Trim, crop, a cut tool, text layers, a second audio track that can be mixed or replace
- Export to MP4, WebM, GIF and audio-only
- Folders, rename, in-app player, autosave and crash recovery, onboarding, auto-update

**Nothing is uploaded. There is no account. There is no server.** That is the privacy
angle and it is literally true: there is no backend at all.

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
- Transcription is **Parakeet running locally**, roughly 116x realtime
- ffmpeg 9 is bundled, with libass, freetype, fontconfig and libvpx-vp9
- Signed with Developer ID, hardened runtime, notarised

## 5. Launch status

- Code: **pushed to `github.com/SankrityaT/Fetch`** (currently **private**, decide
  whether to make it public for the launch)
- Build: `./build.sh` produces a signed `dist/Fetch.app` and a 144MB `dist/Fetch.dmg`.
  Developer ID cert is valid to July 2031
- Notarisation: **the one open item.** Needs an app-specific password stored via
  `xcrun notarytool store-credentials fetch-notary`. Until then Gatekeeper reports
  "Unnotarized Developer ID" and users get a warning
- Distribution: no website yet. The landing page is being built from `landing/`
- `LAUNCH-SHOTLIST.md` lists the screenshots and clips worth capturing for the gallery

## 6. Open questions for the launch chat

1. Pricing: free, one-time, or freemium? What does the comparable set suggest?
2. Public repo or closed source? Open source is a strong PH signal but this is a
   product they may want to charge for
3. Hunter: self-hunt or find one? Current thinking is unresolved
4. Launch day and time (PH resets at 12:01am PT), and which day of the week
5. Gallery order: what is the first frame someone sees?
6. Does the "no subscription, nothing uploaded" angle lead, or does "move the camera
   after you record" lead? Both are strong, only one can be the tagline

## 7. Assets available right now

- App icon at 1024px, `landing/assets/fetch-icon-1024.png`
- Mascot: 17 stills, 4 alpha motion clips (VP9 WebM, needs a PNG poster for Safari)
- Real product screenshots can be captured on demand from the running app
- The editor screenshot is the most persuasive single frame: timeline lanes, transcript
  panel, camera bubble on canvas, all visibly a real editor
