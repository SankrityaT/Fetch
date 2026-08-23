# Biscuit: mascot prompt kit

How this works: generate **the base sheet once**, keep that image, then create every
expression by passing the base back in as a reference image. Text prompts alone will
drift; a reference image is what keeps the same dog across twelve poses.

Order: base sheet, then expressions, then landing art.

---

## 0. Style lock

Paste this block verbatim into every prompt. Do not paraphrase it between generations,
because small wording changes are what make the character drift.

> Flat vector illustration, geometric construction from circles and rounded rectangles.
> Golden retriever puppy face. Two-tone gold coat: main fill #F0A93C, shadow and ears
> #C97F1E, cream muzzle #FFE9C9, forehead blaze #FFE0AE, nose and eyes near-black #2A211B.
> Clean flat fills with at most one soft vertical gradient on the head. No outlines, no
> line art, no cel shading, no gradients on the muzzle. Symmetrical, front facing, head
> and shoulders only unless stated. Chunky friendly proportions, head roughly 70% of the
> frame. Rendered as if it were an SVG icon: crisp edges, no texture, no noise, no grain.
> Transparent background. Centred in a square frame. No text, no logo, no watermark,
> no border, no shadow under the character.

**Negative prompt** (for tools that take one):

> photorealistic, 3d render, realistic fur, hair strands, cel shading, outlines, sketch,
> watercolour, drop shadow, background, gradient background, text, letters, watermark,
> signature, multiple characters, human clothes, hats, collars, accessories, side profile,
> three-quarter view, cropped ears, extra limbs, uncanny eyes

---

## 1. Base sheet (generate this first)

> [STYLE LOCK]
> A character sheet of a single golden retriever puppy face, neutral friendly expression.
> Ears hang down on both sides of the head, rounded and slightly wider at the bottom.
> Large round eyes with a single small white catchlight in the upper left of each eye.
> Small rounded triangular nose centred on the cream muzzle, short vertical line beneath it.
> Mouth closed in a soft, barely-there curve. Both eyes open, looking straight at the viewer.
> This is the canonical reference for a mascot used across an app.

Keep the best result as `biscuit-base.png`. Everything below references it.

---

## 2. Expressions

Each one: attach `biscuit-base.png` as a reference, then use the style lock plus the line
given. Always add: *"Same character, same proportions, same palette as the reference image.
Change only the expression."*

| # | file | prompt line | used for |
|---|---|---|---|
| 1 | `idle` | Calm and attentive. Ears relaxed, eyes open and level, mouth a soft closed curve. | app at rest, empty states |
| 2 | `happy` | Eyes closed into two upward arcs, wide open smile, ears lifted slightly, small rosy blush circles on both cheeks. | camera step, confirmations |
| 3 | `excited` | Eyes wide and round with large catchlights, ears perked up and angled outward, tiny pink tongue tip showing at the bottom of the mouth. | setup start, hero |
| 4 | `recording` | Mouth open in a happy pant with a pink tongue hanging out and down, ears swept back, eyes bright and slightly narrowed. | while recording |
| 5 | `thinking` | Whole head tilted about fifteen degrees to one side, eyes glancing upward, mouth a small flat line. | processing, exporting |
| 6 | `done` | Proud, eyes open and warm, holding a small dark rounded rectangle in the mouth like a film strip with two gold sprocket squares on each short edge. | export finished |
| 7 | `sad` | Ears drooping lower than usual, eyes lowered with the upper lids slightly closed, mouth an inverted soft curve. Apologetic, not crying. | errors |
| 8 | `sleeping` | Eyes closed as two flat gentle curves, ears fully relaxed, mouth closed, one small "z" shape floating near the top right of the frame in gold #F0A93C. | idle for a long time |
| 9 | `wink` | One eye closed as an upward arc, the other open with a catchlight, mouth a confident half smile, one ear slightly raised. | shared, copied link |
| 10 | `focused` | Eyes narrowed with determination, eyebrows implied by two short gold strokes angled inward, mouth a straight line. | trimming, editing |
| 11 | `celebrating` | Mouth wide open in joy, eyes closed as arcs, three tiny gold confetti shapes scattered around the head, ears flying upward. | first recording, milestone |
| 12 | `curious` | Head straight, ears asymmetric with one up and one down, eyes wide, mouth a tiny circle. | tooltips, onboarding hints |

---

## 3. Landing page art

Bigger scenes. Same style lock, but drop the "head and shoulders only" restriction where noted.

**Hero**

> [STYLE LOCK, ignoring the head-and-shoulders restriction]
> Full body golden retriever puppy sitting upright, front facing, tail curled around one
> side and visible behind the body. In the mouth, a small dark rounded rectangle shaped
> like a film strip with gold sprocket squares. Body built from simple rounded shapes,
> four short legs, chest slightly wider than the hips. Friendly proud posture.

**Running with the recording**

> [STYLE LOCK, ignoring the head-and-shoulders restriction]
> Full body golden retriever puppy running to the left in a flat side view, all four legs
> mid-stride, ears trailing behind, tongue out. Carrying a dark rounded rectangle film
> strip in the mouth. Two small gold speed lines trailing behind the tail.

**Sitting beside a screen**

> [STYLE LOCK, ignoring the head-and-shoulders restriction]
> Full body golden retriever puppy sitting beside a simple dark rounded rectangle screen
> shape that is taller than the dog's head. The dog looks toward the screen. Screen is
> flat #191512 with a thin #37302B border and a small gold circle in one corner. Nothing
> displayed on the screen.

---

## 3b. Extracting what you generated

Generated sheets arrive with a background baked in. `Lift.swift` cuts the subjects out
locally using Vision's foreground instance mask, the same subject lifting Preview uses.
No service, no manual masking.

```sh
swiftc -O Lift.swift -o /tmp/Lift

# one subject on a transparent or plain background
/tmp/Lift base.png assets/mascot single biscuit-base

# a sheet laid out in a grid: slices, lifts each cell, names them in reading order
/tmp/Lift sheet.png assets/mascot grid 3 4 \
  idle happy excited recording thinking done sad sleeping wink focused celebrating curious

# a loose sheet: Vision finds each subject on its own
/tmp/Lift poses.png assets/mascot instances
```

Every export is trimmed to its visible pixels, then re-centred on a square canvas with a
6% margin, so expressions can be swapped without the head jumping. Normalise them all to
one size afterwards:

```sh
for f in assets/mascot/*.png; do
  ./vendor/ffmpeg -y -i "$f" -vf "scale=512:512:flags=lanczos" "/tmp/n.png" && mv /tmp/n.png "$f"
done
```

Check the result on a **dark** background. Background bleed and soft alpha edges are
invisible on white and obvious on black.

## 4. Export settings

- 1024×1024 PNG with alpha for expressions, 1600×1200 for landing scenes
- No upscaling: regenerate at size instead
- Trim transparent margins, then re-centre on a square canvas so every expression shares
  one optical centre. If they do not share a centre, swapping expressions will make the
  head jump.
- Keep the flat PNGs in `assets/mascot/`. They are used everywhere at 48px and above:
  the hero, the wizard, empty states and the post-recording prompt.
- Below 48px the painted art turns to mush. The menu bar icons are drawn from the SVG
  geometry by `make_tray.swift`. `assets/mascot/idle.png` is authoritative for the
  titlebar mark. This was measured, not assumed: at 22pt the painted head is noticeably
  noisier than the drawn one.

## 5. Consistency checklist

Before accepting a generation, check all five. Any miss means regenerate rather than fix
by hand, or the set will not sit together.

1. Ear length and width match the base
2. Muzzle is the same width relative to the head
3. Eye spacing has not narrowed or widened
4. Palette is exactly the five hex values, no invented tints
5. Background is genuinely transparent, not white
