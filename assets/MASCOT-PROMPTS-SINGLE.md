# Biscuit: one image at a time

The sheet prompt worked, but generating twelve faces in one image cost detail and made
each head a slightly different size. These are single-image prompts. Each one is
self-contained and copy-paste ready.

## How to run these

1. Attach **`assets/mascot/biscuit-base.png`** as a reference image every single time.
2. Paste one prompt below, unmodified.
3. Generate at **1024x1024**.
4. Extract with the lift tool, which strips whatever background the model adds:
   ```sh
   /tmp/Lift ~/Downloads/generated.png assets/mascot single happy
   ```
5. Normalise to 512:
   ```sh
   ./vendor/ffmpeg -y -i assets/mascot/happy.png -vf "scale=512:512:flags=lanczos" /tmp/n.png && mv /tmp/n.png assets/mascot/happy.png
   ```

Do not change the wording between runs. Small edits are what cause the character to drift.

---

## The line that goes on every prompt

Append this to each of the prompts below, verbatim:

> Match the attached reference image exactly: same golden retriever puppy, same head
> shape, same ear length and placement, same muzzle width, same eye size and spacing,
> same colour palette. Flat vector illustration with soft cel shading, no outlines.
> Head and chest only, front facing, centred, filling about 80 percent of a square frame.
> Plain flat background in a single solid colour. No text, no logo, no watermark, no
> border, no props unless the prompt names one. Change only what the prompt describes.

---

## The twelve expressions

**idle**
> The puppy with a calm, attentive, neutral expression. Both eyes open and looking
> straight ahead, ears hanging relaxed, mouth closed in a soft gentle curve.

**happy**
> The puppy grinning with both eyes closed into upward curved arcs, an open smiling
> mouth with a small pink tongue showing, ears lifted slightly, and soft rosy blush
> circles on both cheeks.

**excited**
> The puppy wide eyed and alert. Both eyes fully round and large with bright white
> catchlights, ears perked upward and angled outward, mouth open in a happy grin with
> the tip of a pink tongue showing.

**recording**
> The puppy mid pant with real energy. Mouth open wide, a long pink tongue hanging down
> out of the mouth, ears swept back as if moving, eyes bright and slightly narrowed with
> excitement.

**thinking**
> The puppy with its whole head tilted about twenty degrees to one side, eyes glancing
> upward and to the side in thought, mouth a small closed flat line, one ear slightly
> higher than the other.

**done**
> The puppy looking proud and pleased, carrying a small dark film strip in its mouth,
> held horizontally. The film strip is a black rounded rectangle with small gold
> sprocket squares along its top and bottom edges. Eyes open and warm.

**sad**
> The puppy looking apologetic. Ears drooping lower than usual, eyes large and lowered
> with the upper lids partly closed, eyebrows angled up in the middle, mouth a small
> downturned curve. Sorry, not crying, no tears.

**sleeping**
> The puppy asleep sitting up. Both eyes closed as two calm flat curves, ears fully
> relaxed and hanging, mouth closed and content, with one small golden letter Z floating
> in the air near the top right of the frame.

**wink**
> The puppy winking. One eye closed into a cheerful upward arc, the other eye wide open
> with a bright catchlight, mouth curved into a confident half smile, one ear raised
> slightly higher than the other.

**focused**
> The puppy concentrating hard. Eyes narrowed with determination, two short angled
> eyebrow strokes tilted inward above the eyes, mouth a straight serious line, ears
> alert and forward.

**celebrating**
> The puppy mid celebration. Mouth wide open in a joyful bark, both eyes closed as happy
> arcs, ears flying upward, with a few small gold confetti pieces scattered in the air
> around the head.

**curious**
> The puppy looking puzzled and interested. Head straight on, one ear standing up and
> the other hanging down, eyes wide and round, mouth a small open circle as if saying oh.

---

## Two things still missing

**App icon** (the app icon is currently a placeholder emoji, this replaces it)
> Match the attached reference puppy exactly. A macOS application icon: the puppy's head
> and shoulders, centred, on a rounded square tile with a warm amber to deep brown
> diagonal gradient background. The head fills about 70 percent of the tile. Soft inner
> glow behind the head. Clean, iconic, readable when small. 1024x1024, no text.

**Landing hero**
> Match the attached reference puppy exactly, but full body this time. The puppy
> running energetically to the left in a side view, all four legs mid stride, ears and
> tail trailing behind, carrying a black film strip with gold sprocket holes in its
> mouth. Two small motion streaks trail behind the tail. Plain flat background.
> Wide 16:9 frame with the puppy on the left third.

---

## Checking each one before you keep it

Put the new file next to `biscuit-base.png` and compare:

1. Ear length and width unchanged
2. Muzzle the same width relative to the head
3. Eye spacing unchanged
4. Same golds, no invented tints
5. Head fills a similar share of the frame

If any of these drift, regenerate rather than fixing by hand. One odd face in a set of
twelve is more noticeable than you would think, because the app swaps between them in
place.
