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
- **20** primary panels and modals
- **999** pills: buttons, chips, badges, segmented controls
- **full circle** icon-only controls and small avatars, the geometry Biscuit is built from

A card's inner padding is never below 14px and never mismatched top to bottom.

## Elevation

**Light, not shadow.** A 1px `--ink-3` hairline plus `--sheen`, an inset top highlight at
4% white. Exactly one real shadow exists, on modals (`--shadow-modal`). Anything else
casting a shadow is wrong.

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

Anything an agent can change has extra obligations, because the person did not do it:

- **Stable short ids.** Every referenceable object gets one (`C1`, `Z2`, `W3`). Ids are
  the nouns natural language needs, they render in `--font-mono`, and the same id
  appears in the UI, the history and the agent's tool call.
- **Agent-controlled surfaces are read-only.** If an agent owns a surface, the human does
  not drag it. Show a lock, say "Agent-controlled", and give a worked example of what to
  say instead. Divergent state makes history a lie.
- **Attribute every change.** Agent name, vendor mark, timestamp, duration, outcome.
  Rows with no agent mark were done by a human.
- **Vendor marks keep their own background.** Claude and Zed are bare glyphs and sit on a
  Fetch tile. Codex, Cursor and Windsurf ship their own background and become the tile.
  See `assets/agents/`.
