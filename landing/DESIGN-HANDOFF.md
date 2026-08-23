# Fetch: landing page design handoff

Everything here is lifted straight from the shipping app, so the site and the product
cannot drift apart. `BRAND.md` in the repo root is the full design system; this is the
subset a landing page needs.

## What is in this folder

| file | use |
|---|---|
| `fetch-tokens.css` | The app's actual CSS custom properties. Drop it in and use the variables. |
| `assets/fonts/` | All four faces, woff2, self-hosted. No Google Fonts request. |
| `assets/mascot/` | 17 stills of Biscuit plus 4 alpha motion clips |
| `assets/sprite.svg` | 78 Phosphor icons as an SVG sprite (`<use href="sprite.svg#i-record-fill">`) |
| `assets/fetch-icon-1024.png` | App icon, for the hero, favicon and the Product Hunt thumbnail |

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
| recording | `recording.png`, `running.png` |
| thinking, processing | `thinking.png`, `motion/thinking.webm` |
| exporting | `motion/exporting.webm` (running with the film reel) |
| done | `done.png`, `celebrating.png`, `sit-film.png` |
| error | `sad.png` |

He is a soft, illustrated golden retriever puppy: rounded shapes, warm gold coat, cream
chest and muzzle, large dark eyes, long floppy ears. Shaded, but never 3D, never
photorealistic, never in human clothes, and he does not speak in first person.

`idle.png` is the logo. It is the app icon, the titlebar mark and the hero, so use it
as the site's mark and favicon too. There is exactly one Biscuit: do not draw or
generate a second, simplified version for small sizes, crop this one to the head.

The motion clips are **VP9 WebM with alpha**. They composite over any background in a
browser. Two gotchas: ffmpeg reports them as `yuv420p` with no alpha because its VP9
decoder ignores WebM alpha, so do not "fix" them based on what ffmpeg says. And Safari
does not support VP9 alpha, so pair each `<video>` with a PNG poster fallback.

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
