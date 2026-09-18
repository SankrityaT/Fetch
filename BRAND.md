# Fetch: brand and design system

> Record it. Fetch it. Ship it.

## The name

**Fetch.** A dog fetches. `fetch()` gets you the thing. You hit record, and it brings
back a finished video. One syllable, verb-first, and it reads as both warm and technical,
which is exactly the split we want: a cute face on a serious tool.

Runners-up, kept for reference: Retriever (too long), Rover (taken, dog-sitting),
Biscuit (kept, it became the mascot's name), Sniff (off-putting).

## The mascot

**Biscuit**, a golden retriever. He is not a logo that sits in a corner. He is the app's
emotional narrator. He reacts to state, and that is the whole personality mechanic:

| app state | Biscuit |
|---|---|
| idle / ready | sitting, alert, ears up, tail mid-wag |
| counting down | crouched, ready to bolt |
| recording | running, ears back, tongue out |
| processing / exporting | head tilt, thinking |
| done | tail up, holding the file in his mouth |
| error | ears down, apologetic |

He is drawn as a soft, illustrated golden retriever puppy: rounded shapes, warm gold
coat with a cream chest and muzzle, large dark eyes, long floppy ears. Shaded, but
never rendered as 3D, never photorealistic, and never in human clothes.

He speaks in first person in exactly one place: onboarding, where he is introducing
himself and asking for things. "Point me at the agent you already use" is a dog
asking on his own behalf; "Fetch supports the following clients" is a changelog.
Everywhere else, and in anything a model reads rather than a person, he is described
in the third person or not mentioned at all. MCP tool descriptions in particular stay
literal, because that text is what an agent uses to choose a tool and personality
there costs accuracy.

The single source of truth is `assets/mascot/`: `idle.png` is the face of the product
and appears in the titlebar, the hero, the app icon and the menu bar. The other 16
stills are the same puppy in the states above, and the four clips in
`assets/mascot/motion/` are the same character in motion.

There was briefly a second, flat geometric Biscuit built from circles and rounded
rectangles. Two mascots meant two brands, so it is gone. If a mark is ever needed
below about 20px, crop `idle.png` to the head rather than drawing a new dog.

## Voice

Plain, short, a little warm. Never cutesy-baby, never corporate.

- Good: "Nothing recorded yet." / "Grabbing your screen…" / "Saved to Desktop."
- Bad: "Woof! Biscuit couldn't find any videos! :(" / "Operation completed successfully."

**No em dashes.** Not in UI copy, not in docs, not in code comments. Use a comma, a
colon, a full stop, or parentheses. This applies to everything written for or about Fetch.

Errors say what happened and what to do, in one line, no blame:
"That file has no audio track, so there is nothing to clean up."

## Color

The category is uniformly cool violet (Loom, Screen Studio) or pure black (Mosaic).
We go **warm**: retriever gold on a warm near-black. Instantly not-Loom.

| token | value | use |
|---|---|---|
| `--ink-0` | `#0A0908` | app background (warm black, never #000) |
| `--ink-1` | `#1A1714` | panels, cards |
| `--ink-2` | `#241F1B` | raised surfaces, inputs |
| `--ink-3` | `#37302B` | hairlines, borders |
| `--ink-4` | `#524941` | disabled, dividers |
| `--fur-0` | `#FFD9A0` | gold tint, hover wash |
| `--fur-1` | `#F0A93C` | **primary accent**, Biscuit's coat |
| `--fur-2` | `#C97F1E` | pressed / deep gold |
| `--rec` | `#FF4438` | record only. Nothing else is ever this red. |
| `--good` | `#4ADE80` | success |
| `--warn` | `#FBBF24` | warning |
| `--text-0` | `#FBFAF8` | primary text |
| `--text-1` | `#BDB5AC` | secondary |
| `--text-2` | `#8E857C` | tertiary, timecodes |

These are the post-contrast-pass values. The first pass sat too close to the background
and secondary text was unreadable; surfaces and secondary text were both lifted.

Gold is for *intent* (primary action, selection, focus). Red is **exclusively** the record
state. That discipline is what makes the record button unmissable.

## Type

Four faces, bundled locally (`assets/fonts/`) so the app renders identically offline.

- **Bricolage Grotesque 800** for display. Headlines, empty states, big numbers. It has
  actual character; Inter does not.
- **Geist 400/500/600/700** for all UI text. Neutral, excellent at 11 to 14px.
- **Instrument Serif italic**, one accent per screen maximum. Used the way Mosaic uses
  it: a single italic word inside a sans headline.
- **Geist Mono** for timecodes, durations, file sizes, anything that must not reflow.

Scale (px): 11, 12, 13, 15, 18, 24, 32, 48. Nothing in between.
Display tracking is tight (-0.03em); 11 to 12px UI text is loose (+0.01em).

## Space & shape

8px base grid; 4px allowed for optical nudges only.
Radii: 10 (thumbnail insets, tooltips, compact list rows), 14 (cards, tiles, popovers),
20 (primary cards, panels, modals), 999 (pills: buttons, chips, badges, tags, segmented
controls). Square icon-only controls and small icon avatars go all the way to a full
circle instead of sitting at a small fixed radius, the same geometry Biscuit is built
from.
A card's inner padding is never smaller than 14px, and never mismatched top/bottom.

Elevation changed in 2.0: depth comes from tone first, then wide soft shadows on
things that genuinely float, then a 1px top highlight. Hairlines are the exception now,
not the default. The full rule and the shadow scale live in `DESIGN.md`, Elevation.

## Motion

Fast, physical, never bouncy-cute.
- 120ms for hovers and state, 200ms for panels, 320ms for modals.
- Easing `cubic-bezier(.2,.8,.2,1)` for entrances, `cubic-bezier(.4,0,1,1)` for exits.
- Only Biscuit is allowed a springy animation, and only on state change.
- Everything respects `prefers-reduced-motion`.

## Icons

Phosphor, bundled as a local sprite (`assets/icons/sprite.svg`). Regular weight for UI
at 16 to 20px; Fill weight for active/selected states and anything ≥32px. Icons are never
smaller than 14px and never recolored outside the palette.

## Component rules

1. Every control is custom. No default `<button>`, `<select>`, `<input type=range>`
   appearance survives. All are restyled from scratch.
2. Every interactive element has four visible states: rest, hover, active, focus-visible
   (2px gold ring, 2px offset). Disabled is 35% opacity and `cursor: default`.
3. Nothing is only-color-coded; state also changes icon, weight, or label.
4. Empty states are never a bare sentence. They get Biscuit, one line, and one action.
5. Destructive actions are never adjacent to primary actions.

## Talking about agents

2.0 puts an agent in the product, so the voice needs rules for it.

- **The agent is theirs, not ours.** "Runs on your Claude plan", "your Codex", never
  "Fetch AI" or "our assistant". Fetch does not have a model.
- **Say what it will not do, by name.** "Fetch's tools only. No shell, no files, no
  network." A list of exclusions earns more trust than any adjective.
- **Name the one exception where it happens.** Voiceover is the only feature that uses
  the internet. Its panel says exactly what is sent (the script) and what is not (the
  recording, the audio, the filenames). No other copy gets to be vague about the network.
- **Attribution is plain.** In the activity log the agent's name, or "You". Never
  "the AI", never "automatically".
- **Ids are nouns.** `B2`, `Z1`, `C3` appear in copy exactly as on screen, in mono. Do not
  explain them; they explain themselves the first time someone sees one next to its span.
