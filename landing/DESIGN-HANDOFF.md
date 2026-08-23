# Fetch: landing page design handoff

Everything here is lifted straight from the shipping app, so the site and the product
cannot drift apart. `BRAND.md` in the repo root is the full design system; this is the
subset a landing page needs.

## What is in this folder

| file | use |
|---|---|
| `css/fetch-tokens.css` | The app's actual CSS custom properties, byte-identical to `ui/tokens.css`. Never edit it. |
| `css/fetch-web.css` | Overrides for the three token rules written for an Electron window, not a page. Load it second. |
| `assets/fonts.css` | The `@font-face` block. `fetch-tokens.css` imports this, which is why it sits one level up from `css/`. |
| `assets/fonts/` | All four families, 10 woff2 files, self-hosted. No Google Fonts request. |
| `assets/mascot/` | 17 stills of Biscuit |
| `assets/mascot/motion/` | 4 alpha motion clips, each with a matching `-poster.png` |
| `assets/sprite.svg` | 78 Phosphor icons as an SVG sprite (`<use href="sprite.svg#i-record-fill">`) |
| `assets/fetch-icon-1024.png` | App icon, for the hero and favicon. Product Hunt wants 240x240, so downscale it. |
| `preview.html` | Smoke test, not a design. Proves the whole chain resolves. `cd landing && python3 -m http.server 8000`, then open `/preview.html`. |

Drop-in, and keep this layout. `fetch-tokens.css` imports `../assets/fonts.css`,
so the stylesheet has to sit one directory below `assets/` or the fonts 404.

```
site/
  index.html
  css/fetch-tokens.css
  css/fetch-web.css
  assets/...
```

```html
<link rel="stylesheet" href="./css/fetch-tokens.css">
<link rel="stylesheet" href="./css/fetch-web.css">
```

## Positioning

> Record it. Fetch it. Ship it.

A macOS screen recorder and editor that runs entirely on your machine. The one-line
pitch is **"Loom without the subscription, and without the upload."**

The category is uniformly cool violet (Loom, Screen Studio) or pure black (Mosaic).
Fetch is deliberately **warm**: retriever gold on a warm near-black. If the page looks
like it could be Loom's, it is wrong.

## Colour

Never use pure `#000` or pure `#fff`. The blacks are warm and the white is off-white.

| token | hex | use |
|---|---|---|
| `--ink-0` | `#0A0908` | page background |
| `--ink-1` | `#1A1714` | cards, panels |
| `--ink-2` | `#241F1B` | raised surfaces, inputs |
| `--ink-3` | `#37302B` | hairlines and borders |
| `--fur-1` | `#F0A93C` | **primary accent**, Biscuit's coat |
| `--fur-0` | `#FFD9A0` | gold tint, hover wash |
| `--fur-2` | `#C97F1E` | pressed, deep gold |
| `--rec` | `#FF4438` | the record state and nothing else, ever |
| `--text-0` | `#FBFAF8` | primary text |
| `--text-1` | `#BDB5AC` | secondary text |
| `--text-2` | `#8E857C` | tertiary, timecodes |

Gold means intent: primary action, selection, focus. Red is reserved exclusively for
recording. That discipline is what makes a record button unmissable, and it is the
single easiest way to make the page feel like the product.

## Type

- **Bricolage Grotesque 800** for display: headlines, big numbers. Tracking `-0.03em`.
- **Geist 400 to 700** for all body and UI text.
- **Instrument Serif italic** for exactly one accented word per screen, never more.
  The app's hero does this: "What are we recording *today*?"
- **Geist Mono** for timecodes, durations, file sizes, anything that must not reflow.

Sizes: 11, 12, 13, 15, 18, 24, 32, 48. Nothing in between. On a marketing page you will
want larger display sizes than the app uses; scale the display face up freely, but keep
body text on the same ramp.

## Shape, elevation and motion

- Radii: 10 small, 14 cards, 20 panels and modals, 999 for every pill and icon button.
- Elevation is done with **light, not shadow**: a 1px `--ink-3` hairline plus
  `inset 0 1px 0 rgba(255,255,255,.04)`. One real shadow only, on modals.
- 8px spacing grid. Card padding never below 14px, never mismatched top and bottom.
- Motion: 120ms hovers, 200ms panels, 320ms modals. Entrances
  `cubic-bezier(.2,.8,.2,1)`, exits `cubic-bezier(.4,0,1,1)`. Respect
  `prefers-reduced-motion`.

## Biscuit

A golden retriever, and the emotional narrator of the product rather than a logo in a
corner. He reacts to state:

| state | asset |
|---|---|
| idle, ready | `idle.png`, or `motion/sleeping.webm` for a resting hero |
| recording starts | `motion/fetch-away.webm` (the sprinter's crouch, then he bolts) |
| recording | `recording.png`, `excited.png` |
| thinking, processing | `thinking.png`, `motion/thinking.webm` |
| exporting | `motion/exporting.webm`, or `running.png` (both carry the film strip) |
| done | `done.png`, `celebrating.png`, `sit-film.png` |
| error | `sad.png` |

`running.png` has a film strip in his mouth, so it reads as delivering the export,
not as recording. Do not use it for the record state.

Rules: never photorealistic, never 3D, never in human clothes. He is a flat
illustration on the gold ramp, soft shading, no outline. He does not speak in first
person.

Use the stills in `assets/mascot/` for the logo mark too, at any size. There is no
separate vector wordmark or vector head. A second geometric mark used to exist and was
deleted for drifting into a different-looking dog. See `BRAND.md`.

The motion clips are **VP9 WebM with alpha**. They composite over any background in a
browser. Three things to know.

**The alpha is real, and ffmpeg lies about it by default.** ffmpeg's built-in VP9
decoder ignores WebM alpha and reports `yuv420p`, so do not "fix" the clips based on
that. Force the libvpx decoder and it tells the truth:

```bash
ffprobe -v error -c:v libvpx-vp9 -show_entries stream=pix_fmt -of default=nw=1 sleeping.webm
# pix_fmt=yuva420p
ffprobe -v error -show_entries stream_tags=alpha_mode -of default=nw=1 sleeping.webm
# TAG:alpha_mode=1
```

**Safari does not support VP9 alpha**, so every `<video>` needs a poster. The four
`-poster.png` files are the real first frame of each clip, extracted through the
libvpx decoder, so they carry the same transparency and line up exactly with frame 0.

```html
<video class="biscuit-clip" autoplay loop muted playsinline
       src="./assets/mascot/motion/sleeping.webm"
       poster="./assets/mascot/motion/sleeping-poster.png"></video>
```

**They are small.** 480x270 at the largest, 420x236 for `thinking`. That is fine at
hero-inset or section-accent size, and soft if you scale one to full width on a 2x
display. Budget them at roughly 240 to 400 CSS pixels wide.

| clip | size | length | poster |
|---|---|---|---|
| `sleeping.webm` | 460x258 | 4s loop | `sleeping-poster.png` |
| `thinking.webm` | 420x236 | 4s loop | `thinking-poster.png` |
| `exporting.webm` | 480x270 | 10s loop | `exporting-poster.png` |
| `fetch-away.webm` | 480x270 | 4s | `fetch-away-poster.png` |

One gap worth knowing before you plan the hero. `assets/MOTION-MOMENTS.md` designs
`fetch-away` as half of a pair with a **fetch-back** clip, and calls fetch-back "the
payoff, the most watched, and the one that explains the product." Fetch-back was never
generated. So `fetch-away` is currently the weaker half of a missing pair. Either
commission fetch-back, or use `sleeping` or `exporting` as the hero clip, both of which
stand alone.

## Voice

Plain, short, a little warm. Never cutesy-baby, never corporate.

- Good: "Nothing recorded yet." / "Grabbing your screen..." / "Saved to Desktop."
- Bad: "Woof! Biscuit couldn't find any videos! :(" / "Operation completed successfully."

**No em dashes anywhere.** Use a comma, a colon, a full stop, or parentheses.

## Copy that is already true

Use these as-is. Every one describes something the app actually does.

- "Record your screen, your camera and your voice. Edit it. Ship it. No subscription."
- "Move the camera bubble after you record." (the camera is captured to its own file,
  not burned into the screen, so it can be repositioned and resized in the editor)
- "Transcribed on your Mac, in seconds. Nothing is uploaded."
- "It zooms where you click, on its own."
- "Your recordings never leave your machine."

## The one screenshot rule

`LAUNCH-SHOTLIST.md` in the repo root lists the shots worth capturing. The single most
persuasive frame is the editor: timeline with the video and audio lanes, transcript
panel on the right, camera bubble on the canvas. It shows in one image that this is a
real editor and not a toy recorder.
