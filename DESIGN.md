# Fetch: design system

Derived from `BRAND.md` and `ui/tokens.css`, which remain the source of truth. Use the
CSS custom properties, never raw hex.

## Theme

Dark, and the scene forces it. Someone at their desk at night, the app open beside the
window they are recording, a red capture border around the screen. A light UI beside a
dark editor timeline would glare, and every frame of their own product sits inside this
window, so the chrome has to recede behind the content. Warm near-black, never grey.

## Color strategy

**Restrained.** Tinted neutrals carry the surface, retriever gold is the single accent
and stays under 10%. Gold means "this is the thing to act on" and nothing else. Spend it
on the primary action and the active state, never on decoration.

Never `#000` or `#fff`. Every neutral is warmed toward the fur hue.

| Role | Token | Use |
|---|---|---|
| Ground | `--ink-0` `#0A0908` | App background |
| Raised | `--ink-1` `#1A1714` | Cards, panels, inputs |
| Inset | `--ink-2` `#241F1B` | Tiles, wells, switch tracks |
| Hairline | `--ink-3` `#37302B` | Every border, via `--edge` |
| Accent | `--fur-1` `#F0A93C` | Primary action, active state |
| Recording | `--rec` `#FF4438` | Capture only. Never decorative. |
| Allowed | `--good` `#4ADE80` | Granted, connected, on |
| Caution | `--warn` `#FBBF24` | Needs attention, not failure |
| Text | `--text-0/1/2` | Primary, secondary, tertiary |

## Type

Four families, all self-hosted: `--font-display` Bricolage Grotesque 800 for headings,
`--font-ui` Geist for everything, `--font-serif` Instrument Serif italic for a single
accent word per headline, `--font-mono` Geist Mono for ids, paths and durations.

Scale is discrete: 11, 12, 13, 15, 18, 24, 32, 48. **Nothing between these steps.**
Hierarchy comes from scale plus weight, never from colour alone. Body copy caps at
65–75ch.

The serif accent is one word, once per screen. Two is a pattern and the pattern is
cheaper than the effect.

## Space and shape

8px grid, 4px for optical nudges only. Radii carry meaning:

- **10** thumbnail insets, tooltips, compact rows
- **14** cards, tiles, popovers
- **20** primary panels
- **26** cards and modals, since 2.0 (`--r-xl`)
- **999** pills: buttons, chips, badges, segmented controls
- **full circle** icon-only controls and small avatars, the geometry Biscuit is built from

A card's inner padding is never below 14px and never mismatched top to bottom.

## Elevation

Rewritten for 2.0. The old rule was "light, not shadow", with a 1px hairline on almost
every surface and one shadow in the whole app. It made every panel a box drawn on a flat
plane. Depth now comes from three things, in this order:

1. **Tone.** A raised surface is lighter than the one below it. Does the most work, costs
   nothing.
2. **Shadow**, only for things that genuinely float, and wide rather than tight: on a
   near-black ground a small shadow is invisible.
   - `--shadow-1` resting card
   - `--shadow-2` docked panel or raised well
   - `--shadow-3` floating over content: popovers, menus, mention lists
   - `--shadow-modal` modals
3. **Light.** `--sheen`, a 1px inset highlight along the top edge.

`--edge-soft` (4.5% white) replaces `--edge` wherever tone already separates. A full
`--edge` hairline is for where two surfaces of the same tone genuinely meet.

**Ground.** One very faint warm pool in opposite corners (`body` in `tokens.css`). Never
centred: centred, it sits behind the content column and washes out the contrast the
shadows exist to create.

**Blur** (`--blur-over`) only on layers that sit over content and must stay legible
while it shows through. Today that is exactly two: the chat pane and the titlebar.
Anything else wanting blur is decoration and is refused.

## Motion

`--ease-in` `cubic-bezier(.2,.8,.2,1)` for entering, `--ease-out` for leaving. Durations
120 / 200 / 320ms. Never animate layout properties. No bounce, no elastic. Respect
`prefers-reduced-motion`.

## Icons

Phosphor, via `assets/icons/sprite.svg`, `<use href="...#i-name">`. Filled variants for
active or recording states, regular otherwise.

## Component rules

1. Every control is custom. No default `<button>`, `<select>` or `<input type=range>`
   appearance survives.
2. Four visible states on everything interactive: rest, hover, active, focus-visible
   (2px gold ring, 2px offset). Disabled is 35% opacity and `cursor: default`.
3. **Nothing is only colour-coded.** State also changes icon, weight or label. A green
   dot alone is a failure.
4. Empty states get Biscuit, one line, and one action. Never a bare sentence.
5. Destructive actions are never adjacent to primary actions.
6. Cards are not the default answer. Nested cards are always wrong.

## Agent-facing surfaces

Every object an agent can name is drawn with its id visible, not on hover: beats as
`B2` on the strip, zooms as `Z1 2.0x` on their track. The id is the handle, and a handle
you cannot see is not one.

Anything an agent can change has extra obligations, because the person did not do it:

- **Stable short ids.** Every referenceable object gets one (`C1`, `Z2`, `W3`). Ids are
  the nouns natural language needs, they render in `--font-mono`, and the same id
  appears in the UI, the history and the agent's tool call.
- **Both can edit; the log says who.** An earlier draft made agent-driven surfaces
  read-only, copying a competitor. That was wrong for Fetch: a competitor locks its timeline
  because it has no editor, and Fetch's editor is an advantage. Divergence is handled by
  one edit document both write to, and by the activity log attributing every change.
- **Attribute every change.** Agent name, vendor mark, timestamp, duration, outcome.
  Rows with no agent mark were done by a human.
- **Vendor marks keep their own background.** Claude and Zed are bare glyphs and sit on a
  Fetch tile. Codex, Cursor and Windsurf ship their own background and become the tile.
  See `assets/agents/`.
