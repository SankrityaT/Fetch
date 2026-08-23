# Motion moments

Places where a moving Biscuit earns its keep, and the prompts to make them.

The rule: motion where the user is **already waiting**, or at a moment that carries a
beat. Animation during a wait feels like company. Animation in front of a button is an
obstacle.

## The one worth building first

The brand mechanic is the name. A dog **fetches**: it runs off, and it comes back with
the thing. That is two clips, and together they wrap the entire recording:

- You press record, and Biscuit **sprints out of frame**. He has gone to get it.
- You press stop, and Biscuit **runs back in carrying the tape** and drops it at your feet.

Nothing else in the app explains what Fetch is as fast as those two clips do. Build them
before anything else, including the export loop.

---

## Everything worth animating

Three tiers, because most of these do not need generated video and it would be a waste to
make twenty clips.

### Tier 1: generated video (5 clips)

Real waits and real beats. These are the only ones worth Flow credits.

| moment | clip | length |
|---|---|---|
| **Recording starts** | Biscuit sprints out of frame to the right | 1.5s, one shot |
| **Recording stops** | Biscuit runs back in with the tape, skids, drops it | 2s, one shot |
| **Exporting** | Biscuit runs in place carrying the tape | 3s, loop |
| **Transcribing** | head tilt, ear flick, thinking | 2.5s, loop |
| **Idle for a long time** | asleep, slow breathing, ear twitch | 4s, loop |

### Tier 2: frame swaps, no generation needed

These use the twelve expression PNGs already in `assets/mascot/`. Cheap, instant, and
they add more life per unit of effort than any video.

| moment | how |
|---|---|
| **Blinking** | swap `idle` to `sleeping` for 120ms every 6 to 9 seconds, randomised |
| Hover the record button | `idle` to `excited` while hovered |
| Countdown 3, 2, 1 | `excited`, `focused`, `recording`, one per beat |
| Paused | `thinking`, and back to `recording` on resume |
| Permission granted in onboarding | flash `happy` for 600ms per grant |
| Folder created | `happy` |
| Delete confirm | `sad` (already wired) |
| Export failed | `sad` |
| No cursor track for auto zoom | `curious` |
| Camera busy | `curious` |
| First ever recording saved | `celebrating` |

Blinking alone is worth more than it sounds. A face that never blinks reads as a sticker.
A face that blinks reads as present.

### Tier 3: CSS only, no assets

| moment | motion |
|---|---|
| Record button at rest | slow pulsing ring, 2.4s, the only red thing in the app |
| Recording border | the gentle breathe already built |
| Toggle switches | knob overshoots by 2px and settles |
| Camera bubble while dragging | squashes about 4 percent along the drag axis |
| Library cards | lift 2px on hover, already built |
| Job progress bar | slow shimmer while running |
| Timeline playhead | snaps, never eases, so scrubbing feels tight |
| Wizard step change | the horizontal slide already built |
| First export completes | small gold confetti burst from the button |
| Toasts | rise and settle, already built |

---

Build the export one first. It is the longest wait and the most watched.

---

## Prompt 1: the still image

This is the keyframe. Generate it first, keep it, then feed it to Flow as the starting
frame. Attach `assets/mascot/running.png` as a reference.

> Match the attached reference image exactly: the same golden retriever puppy, same head
> shape, same ear length, same muzzle, same eye size, same golden coat colours. Flat
> vector illustration with soft cel shading and no outlines.
>
> Full body side view, facing left, running at full stride with all four legs off the
> ground, ears and tail streaming backwards. In its mouth it carries a black film strip:
> a dark rounded rectangle with small gold square sprocket holes along the top and bottom
> edges, held horizontally.
>
> The entire background is one flat uniform solid colour, pure magenta #FF00FF, with no
> gradient, no texture, no shadow, no ground plane and no contact shadow under the paws.
> The puppy does not touch the edges of the frame. Centred, occupying about 70 percent of
> the width.
>
> 16:9, 1920x1080. No text, no logo, no watermark, no motion blur, no speed lines.

The magenta is deliberate. It is nowhere in the character's palette, so it keys out
cleanly and leaves clean edges.

## Prompt 2: the video

Feed the still above into Google Flow as the first frame, then use this:

> Animate the puppy running in place with a smooth, looping four-beat gallop cycle. The
> legs cycle through the full stride, the ears and tail bounce and trail with the motion,
> and the body rises and falls very slightly with each stride. The film strip stays firmly
> in the mouth and sways gently.
>
> The camera does not move. The puppy stays exactly centred in the frame and does not
> travel across it. The background stays a completely flat, unchanging, uniform pure
> magenta with no gradient, no lighting change, no shadow and no particles appearing at
> any point.
>
> The art style stays flat 2D vector animation throughout, matching the first frame. No
> shift toward 3D, no added realism, no added fur detail, no depth of field, no film grain.
> The first and last frames should match so the clip loops seamlessly.
>
> 3 seconds, 24 fps, 1920x1080.

The three things that usually go wrong, and why each line above exists: the camera drifts,
the background gains a gradient which ruins the key, and the style creeps toward 3D
partway through.

## Turning it into something the app can use

Flow returns an mp4 with a solid background. Key it out and produce a WebM with a real
alpha channel, which is what the UI needs to sit it over a panel:

```sh
./vendor/ffmpeg -i biscuit-export.mp4 \
  -vf "colorkey=0xFF00FF:0.30:0.12,despill=type=green:mix=0.3,format=yuva420p,scale=640:-2" \
  -c:v libvpx-vp9 -pix_fmt yuva420p -b:v 0 -crf 32 -an \
  assets/mascot/motion/exporting.webm
```

Check the result over the actual panel colour, not over white:

```sh
./vendor/ffmpeg -f lavfi -i color=c=0x1A1714:s=640x360 -i assets/mascot/motion/exporting.webm \
  -filter_complex "[0][1]overlay=shortest=1" -frames:v 1 /tmp/keycheck.png
```

If the edges show a magenta fringe, raise the `colorkey` similarity from 0.30 toward 0.40.
If parts of the dog vanish, lower it.

In the UI it is just a looping video element:

```html
<video src="./assets/mascot/motion/exporting.webm" autoplay loop muted playsinline></video>
```

Keep each clip under about 400KB. These ship inside the app and load on a wait screen,
so a heavy file defeats the point.

## Fallback

Every motion moment must degrade to the matching still PNG. If the WebM is missing or
fails to decode, show `assets/mascot/running.png` instead. A wait screen that renders
nothing is worse than a wait screen that does not move.

---

# The other four clips

Same method every time: generate the still, then feed it to Flow as the first frame.
Attach `assets/mascot/running.png` as a reference for the running ones and
`assets/mascot/idle.png` for the still ones. Keep the magenta background: it is nowhere
in Biscuit's palette, so it keys cleanly.

Shared background line, put it in every still prompt:

> The entire background is one flat uniform solid colour, pure magenta #FF00FF, with no
> gradient, no texture, no shadow, no ground plane and no contact shadow. 16:9, 1920x1080.
> No text, no logo, no watermark, no motion blur, no speed lines.

Shared stability line, put it in every video prompt:

> The camera does not move. The background stays completely flat, unchanging, uniform pure
> magenta with no gradient, no lighting change, no shadow and no particles at any point.
> The art style stays flat 2D vector animation throughout, matching the first frame, with
> no drift toward 3D, no added realism, no added fur detail, no depth of field and no
> film grain.

## 1. Fetch away, when recording starts

**Still**
> Match the attached reference puppy exactly. Full body side view facing right, crouched
> low in a sprinter's start with the front legs bent, hindquarters raised, ears forward,
> eyes locked ahead with an eager expression. Nothing in its mouth. Positioned in the
> left third of the frame. [background line]

**Video**
> The puppy launches forward from the crouch and sprints to the right, accelerating out of
> the right edge of the frame, ears and tail streaming behind. By the final half second the
> frame is completely empty magenta. Do not bring the puppy back. [stability line]
> 1.5 seconds, 24 fps, 1920x1080.

## 2. Fetch back, when recording stops

This is the payoff clip. Worth generating twice and picking the better one.

**Still**
> Match the attached reference puppy exactly. Full body side view facing left, running at
> full stride with all four legs off the ground, ears and tail streaming backwards,
> carrying a black film strip in its mouth: a dark rounded rectangle with small gold square
> sprocket holes along the top and bottom edges, held horizontally. Positioned in the right
> third of the frame, as if it has just entered from the right. [background line]

**Video**
> The puppy runs in from the right, decelerates as it reaches the centre of the frame,
> plants its front paws in a small skid, then lowers its head and gently sets the film
> strip down. It finishes sitting upright behind the film strip, tail wagging once, looking
> pleased and straight ahead. The film strip stays flat and still on the ground for the
> last half second. [stability line]
> 2.5 seconds, 24 fps, 1920x1080.

## 3. Thinking, while transcribing

**Still**
> Match the attached reference puppy exactly. Head and chest only, front facing, head
> tilted about twenty degrees to one side, eyes glancing upward in thought, mouth a small
> closed line, one ear slightly higher than the other. Centred. [background line]

**Video**
> The puppy tilts its head slowly to the opposite side and back again in a calm, curious
> loop. One ear flicks once. It blinks twice at an unhurried pace. The body stays still,
> only the head and ears move. The first and last frames match exactly so the clip loops
> seamlessly. [stability line]
> 2.5 seconds, 24 fps, 1920x1080.

## 4. Asleep, after a long idle

**Still**
> Match the attached reference puppy exactly. Full body curled up asleep on its side,
> head resting on its front paws, eyes closed as two calm flat curves, ears relaxed and
> hanging, tail curled around the body. Centred. [background line]

**Video**
> The puppy breathes slowly and evenly: the ribcage rises and falls with a gentle, regular
> rhythm. One ear twitches once, roughly two thirds of the way through. Nothing else moves.
> No waking up, no eye opening, no head lifting. The first and last frames match exactly so
> the clip loops seamlessly. [stability line]
> 4 seconds, 24 fps, 1920x1080.

---

## Order to build them

1. **Fetch back** (2). The payoff, the most watched, and the one that explains the product.
2. **Fetch away** (1). Its other half. Weak on its own, strong as a pair.
3. **Exporting** loop (the prompt further up). The longest wait.
4. **Thinking** (3). Second longest wait.
5. **Asleep** (4). Pure delight, zero utility, build it last and never cut it.

Tier 2 and Tier 3 need no generation at all. I can build those from the twelve expression
PNGs you already have plus CSS, and blinking alone will do more for how alive Biscuit
feels than any single video clip.
