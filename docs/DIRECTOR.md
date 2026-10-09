# The director, the camera and the editor

A product demo is a film. Fetch today is a very good camera with a styling panel
bolted to it, and styling is not editing. This is the spec for the other two thirds.

## The thesis

Three agents, one craft each, and they hand over artifacts rather than opinions.

**The director** reads the code, not the screen. It decides what is worth filming and
in what order, and it writes a shoot plan that can be executed by something that has
never seen the product.

**The camera** executes the plan. It drives the app, films each scene, and reports what
it actually got, including what it failed to get.

**The editor** cuts the footage into a film, in the product's own design language. It
does not apply a look. It makes a decision per moment.

A fourth agent, **the critic**, watches the result and says what is wrong with it. The
editor fixes. That loop is what separates a cut from a first draft.

The whole thing runs over MCP, so any coding agent is the director.

---

## 1. The director

### What it reads

The codebase, and nothing else. Not the running app, not a screenshot. A demo made by
looking at the screen can only show what happens to be on the screen; a demo made by
reading the code can show what the product is *for*.

Concretely, for each candidate scene it is looking for four things:

| | |
|---|---|
| **the claim** | what this feature asserts about the product |
| **the proof** | the moment on screen that makes the claim true |
| **the route** | how to get there from a cold launch, as executable steps |
| **the cost** | what has to be true first (a signed-in user, a seeded database, a running backend) |

A feature with no proof is a scene that will be boring. A feature with no route is a
scene that cannot be shot. Both are findings, and the director says so rather than
filming something adjacent.

### The artifact: a shoot plan

```jsonc
{
  "product": "Riché",
  "claim": "a chip in the object proves the object is real",
  "runtime": 45,                      // seconds the director is budgeting
  "preconditions": [
    { "what": "a seeded collection", "how": "--ui-demo-seed", "verified": false },
    { "what": "the backend", "how": "supabase start", "verified": false }
  ],
  "scenes": [
    {
      "id": "S1",
      "name": "what you own",
      "claim": "the things you own are already proven",
      "proof": "two passports, each with a green Authentic chip",
      "route": [
        { "do": "launch", "args": { "bundle": "com.levente.riche" } },
        { "do": "expect", "args": { "text": "Collection" } }
      ],
      "shot": "establish",
      "hold": 2.5
    },
    {
      "id": "S4",
      "name": "the chip answers",
      "claim": "the proof is live, not printed",
      "proof": "Challenging the chip. Keep holding.",
      "route": [
        { "do": "tap", "args": { "text": "Tag A" } },
        { "do": "expect", "args": { "text": "Challenging the chip" } }
      ],
      "shot": "proof",
      "hold": 3.0
    }
  ]
}
```

Two things make this different from a list of steps.

**`expect` is part of the route.** Every step says what should be true after it. A route
without expectations is a script that cannot tell success from failure, which is the
thing that made every shoot so far unreliable. `expect` is how the camera knows it
arrived, and how it knows to give up.

**`proof` is written before the shoot.** The director commits, in words, to the frame
that justifies the scene. The critic later checks the film against exactly that
sentence. A scene whose proof never appeared on screen is a scene that failed, however
pretty the footage.

### Verifying the plan without shooting it

`preconditions[].verified` is the director's own dry run. Before a single frame, it
checks the things that would waste a take: is the backend reachable, does the demo flag
exist in the source, is there a built app. A plan that cannot be satisfied is reported
as a plan, not discovered thirty seconds into a recording.

---

## 2. The camera

Mostly built. What the plan changes is that it executes a route rather than a script.

```
for each scene:
    mark the scene on the take's clock
    for each step in route:
        do it
        look, until `expect` is true or the patience runs out
    if an expectation never came true:
        record the scene as failed, keep shooting the rest
```

Three rules worth stating because breaking them is what goes wrong:

**Look before every action, never across one.** A reference to something on screen is
only valid on the picture it was read from. Hold one across a sheet presenting and it
names something else.

**Prefer the tightest thing that matches.** Reads come back nested: a panel holds a card
holds a button, and the panel's text contains the button's. The smallest match is the
one meant.

**A failed scene is data.** It does not abort the shoot and it does not get quietly
dropped. The editor needs to know that S3 is missing, and the director needs to know its
route was wrong.

### What the camera hands over

The take, plus a shoot report: which scenes landed, which did not and at which step,
and the span of each on the take's clock.

---

## 3. The design system

This is the part that makes the editor's output look like the product instead of like
Fetch, and it is a first class object, not a preset.

```jsonc
{
  "product": "Riché",
  "type":    { "face": "SF Pro", "mono": "SF Mono", "scale": 1.0, "case": "sentence" },
  "colour":  { "ground": "#020202", "ink": "#FAFAFA", "accent": null,
               "semantic": { "good": "#34C759", "bad": "#FF3B30", "wait": "#FF9F0A" } },
  "shape":   { "radius": 14, "hairline": 1, "density": "roomy" },
  "register": "calm certainty",
  "forbid":  ["a decorative accent colour", "tracked caps outside a brand line"],
  "from":    { "colour": "sampled", "type": "repo", "register": "docs/DESIGN.md" }
}
```

Three things about this.

**It is derived, then owned.** Fetch can sample the ground, the ink and the accent off
the footage, and read the faces the repo ships. That gets most of it. The rest, the
register and the prohibitions, comes from the product's own design doc if it has one,
and from the person if it does not. `from` records which, because a sampled guess and a
stated rule should not be weighed the same.

**`accent: null` is a real value.** Riché's own design doc says "no brand accent colour"
and the sampler independently agreed, because the vivid things on screen covered a
fraction of a percent of the frame. An editor that invents an accent for a product that
has deliberately refused one has misunderstood it.

**`forbid` is the most useful field.** Taste is mostly knowing what not to do. A product
that never uses tracked caps outside a brand line should not get a tracked caps callout
because the editor thought it looked nice.

Everything the editor draws, every callout, every title, every emphasis, is drawn from
this object. Not from Fetch's house style.

---

## 4. The editor

### The problem with dials

Today an editor agent is handed 74 fields and told to be tasteful. That is not a
vocabulary, it is a cockpit. Nobody composes in a cockpit. The output looks configured
because it was configured.

### The primitive: a shot

A shot is an intention with a known good rendering. The agent chooses the intention. A
human with taste decided, once, how each one is rendered.

| shot | what it is for | how it is drawn |
|---|---|---|
| `establish` | this is the thing | the whole frame, still, held long enough to read |
| `approach` | we are going somewhere | a slow move toward the subject, settling, never arriving abruptly |
| `detail` | this, specifically | the subject fills the frame, everything else falls away |
| `proof` | the claim is true | the frame holds on the evidence, with the evidence lifted |
| `handoff` | and now this | the move from one subject to the next, carrying direction |
| `beat` | let that land | a held pause, earned, never more than one in a row |

That is the whole vocabulary. Six words. An editor agent composing in six words with
real intent will beat one setting 74 numbers, because the six carry judgement and the
74 carry none.

Each shot takes a subject and a duration and nothing else:

```jsonc
{ "scene": "S4", "shot": "proof", "subject": "Challenging the chip", "hold": 3.0 }
```

`subject` is a thing on screen, named in words, resolved to a box at that moment. Never
a coordinate. The editor says what it means; the system finds it.

### What the shot library owns

The parts an agent should not be improvising:

- **easing**. A push that starts hard reads as a jolt. The library eases in and settles.
- **depth**. How far `detail` goes is a function of the subject's size, not a number
  somebody picked.
- **floor and ceiling**. A move too small reads as a mistake. Too big reads as panic.
- **the frame's integrity**. A device being filmed stays whole. A move that would push
  part of the product out of frame is clamped, because a phone with its top cut off is
  not a style.
- **content first**. On a composition with a drawn device, the magnification happens to
  the screen inside the glass. The device does not scale. This is the single most
  important rule in the library and the one most easily got wrong.

### Rhythm

The editor's second job, and the one that actually separates a film from a screen
recording.

- Every scene gets a length from what it has to say, not from how long the camera ran.
- Nothing holds after it has been understood. The test is whether a second viewer would
  have moved on.
- Two long scenes do not sit together. Neither do two short ones.
- The last scene may breathe. The first may not.

Dead time is not trimmed at the end as a cleanup pass. It never gets in, because every
scene is cut to its shot.

### Transitions, chosen by relationship

Not by preference. The relationship between two scenes decides:

| from → to | transition |
|---|---|
| same screen, new state | cut |
| new context | a short dissolve |
| the second is inside the first | match, the move continues through the join |
| a deliberate change of subject | a beat, then cut |

### The artifact: an edit decision list

```jsonc
{
  "film": "Riché · is it real",
  "system": "<design system id>",
  "sequence": [
    { "scene": "S1", "shot": "establish", "hold": 2.5, "then": "cut" },
    { "scene": "S2", "shot": "approach", "subject": "Verify",            "hold": 2.0, "then": "match" },
    { "scene": "S3", "shot": "detail",   "subject": "Tag A",             "hold": 2.2, "then": "cut" },
    { "scene": "S4", "shot": "proof",    "subject": "Challenging the chip", "hold": 3.0,
      "say": "a live challenge, not a printed checkmark" }
  ]
}
```

Readable, arguable, diffable. A person can look at this and say "S2 is too long" without
opening a timeline. That is the point.

---

## 5. The critic

The editor cannot see. It should not be the one to say whether its cut works.

The critic watches the rendered film and answers, per scene, against the director's own
words:

- **Did the proof appear?** The director wrote the sentence. Is that frame in the film?
- **Can it be read?** Is the text large enough at this output size, is the contrast real.
- **Does the eye know where to go?** Is there one subject or three.
- **Is it the right length?** Did it hold after it was understood.
- **Is it in the product's language?** Faces, colours, radius, register, and nothing on
  the forbid list.

Each finding names a scene and a fix in the edit decision list. The editor applies them
and re-renders. Two passes, then stop, because a third is usually the critic arguing
with itself.

The one rule: **the critic looks at pixels.** A rubric over a document can tell you a
zoom exists. It cannot tell you the zoom cut the phone in half. Everything genuinely
wrong in this product so far was found by rendering a frame and looking at it.

---

## 6. The ceiling

The shot library is deliberately small, and a small vocabulary has a ceiling. Kinetic
type, a chart that draws itself, a layout that is not a device on a ground: none of
that is expressible in six shots and should not be.

So the edit decision list is also an export format. It carries scenes with times,
subjects with boxes, a transcript with word times, and the design system. That is
everything a composition in a real animation runtime needs. When a film wants more than
the six shots, it leaves through that door rather than growing a seventh.

Own the capture and the direction. Hand off the ceiling.

---

## 7. Build order

Each step is useful alone, and each one is provable by producing a film that is better
than the one before it.

1. **`expect` in the route.** Nothing else matters if the shoot is unreliable. One
   primitive: do a thing, then look until the screen says you arrived.
2. **The design system object.** Derived from sampling and the repo, stored per product,
   editable. Nothing draws from Fetch's house style once this exists.
3. **The shot library.** Six shots, rendered well, with the content-first rule and the
   frame-integrity clamp. This is where the taste goes and it should be authored
   slowly.
4. **The edit decision list.** The editor's output becomes this instead of field
   assignments.
5. **The critic.** Pixels, per scene, against the director's own sentence.
6. **The shoot plan.** Last, because by then the other five have taught us what a plan
   has to contain.

## What is already true

Worth saying plainly so this reads as an extension rather than a rewrite. Fetch can
already drive a device and look at it without changing it, mark scenes on a take's clock
while shooting, sample a product's ground, ink and accent off its own footage, find the
faces its repo ships, remember a decision per product, resolve a thing named in words to
a box on screen, and draw with preview and export agreeing to one or two levels.

What it cannot do is decide what to film, compose in anything other than dials, or look
at its own work. That is this document.
