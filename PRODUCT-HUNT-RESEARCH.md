# Fetch on Product Hunt: what the numbers actually say

`PRODUCT-HUNT-BRIEF.md` is the input to this. This is the output: the comparable
set, the 2026 bar, an honest read on the odds, and answers to the six questions the
brief left open.

Researched August 2026. Every number below has a source at the bottom.

---

## 1. The comparable set

Two products in exactly this category have launched, and both cleared the bar.

| product | launch | upvotes | what they had going in |
|---|---|---|---|
| **Cap** | Nov 2024 | **739** | open source, ~18k GitHub stars, a following before launch day |
| **Screen Studio** | late 2022 | **881** | the founder's own audience, already the quality bar in the category |
| **Screen Studio 3.0** | Feb 2025 | **1,713** | a *relaunch* to thousands of existing paying customers |

Read that table for what it does not say. Neither product won on the strength of the
product alone. Cap arrived with a repo people already starred. Screen Studio's biggest
number is a relaunch to an existing base. Screen Studio 3.0 is not a first launch and
should not be used as a target.

One more data point worth more than the upvotes. Screen Studio's founder said publicly
that a normal sales day beat his Product Hunt launch day for revenue. **Product Hunt is
a credibility and backlink event in this category, not a revenue event.** Plan for
distribution, not for a payday.

## 2. The bar in 2026

- **#1 of the day, non-AI category: roughly 500 to 700 upvotes.**
- #1 in the AI category: 800 to 1,200. AI is now the most competitive bucket.
- 49% of all launches are AI, and 60%+ of top-five products have an AI component.
- The algorithm changed. Raw upvote count matters less. Comments, maker replies and
  time on page matter more. Account age is weighted, so new accounts upvoting count
  for little, and artificial velocity is actively punished.
- The practical target is **200+ upvotes and 30+ comments in the first six hours**,
  because that window sets the initial ranking.

## 3. Honest odds

**If Fetch launched this month: top 10 to 20, somewhere around 150 to 350 upvotes.**

Not because the product is weak. It is not: an editor with on-device transcription,
click-driven auto zoom, movable camera and no backend is genuinely competitive with
both comparables. The problem is that upvotes come from an audience, and right now
there is no audience to draw on.

What Fetch does not have that both comparables did:

- a public repo with stars (currently private, 0 stars)
- a mailing list or waitlist
- a following built in public
- a live website
- anything downloadable

**With four to six weeks of preparation: top 3 is realistic, #1 is possible on a
lighter day.** The gap is entirely distribution, and distribution is the part that
takes calendar time rather than effort.

## 4. Blockers, ranked by how much damage they do

**1. The app is not notarised. This is the one that matters.**
Verified again today: `notarytool history --keychain-profile fetch-notary` returns "No
Keychain password item found". Every single person who downloads on launch day gets
"Apple could not verify this app is free of malware". On a Mac app launch, in front of
an audience that is unusually security-aware, that is the whole game. It converts your
best traffic day of the year into a comment thread about a scary dialog.

It is roughly thirty minutes of work and **only you can do it**, because it needs an
app-specific password from appleid.apple.com. Nothing else on this list should be
touched until this is done.

**2. There is nothing to download.** No `dist/` build exists, and the site has two
buttons pointing at a `#download` anchor with no matching section.

**3. Auto-update is broken.** It reads `latest.json` from a private repo, so it 404s.
A day-one bug cannot reach day-two users. See `PRODUCT-HUNT-BRIEF.md` section 5.

**4. Pricing is undecided.** The first comment on any launch in this category is "how
much?". Not having an answer reads as not being ready.

**5. No audience.** This is the actual determinant of the number, and the slowest to
fix. Everything above is a day of work. This is weeks.

## 5. The six open questions, answered

**1. Pricing: free, one-time, or freemium?**
One-time. The comparable set is unambiguous: Screen Studio $89 to $229 one-time,
CleanShot X ~$29 one-time, both healthy businesses. Loom's subscription is the thing
you are positioning against, so a subscription undercuts the entire pitch. Cap went
open source plus paid cloud, which only works if you want to run a cloud, and the whole
point of Fetch is that there is no server. Suggested: one price, one-time, somewhere
between CleanShot and Screen Studio, with a free tier limited by export length rather
than by features, so the editor sells itself.

**2. Public repo or closed source?**
Open it, but not for the reason you think. Cap's 18k stars were a distribution asset
before they were a philosophy. A public repo gives you something to build an audience
*with* during the four to six weeks of prep. It also makes every claim in the privacy
section independently checkable, which is the strongest thing Fetch has.
Caveats already noted: no LICENSE file exists, and the bundled ffmpeg is a GPL build,
so settle licensing before flipping the switch, not after.

**3. Hunter: self-hunt or find one?**
**Self-hunt.** This one is now settled by the platform. Product Hunt retired the
hunter's notification boost and has confirmed there is no algorithmic advantage to a
third-party hunter. Most successful launches now are self-hunted, and self-hunting lets
you reply to every comment yourself, which is what the 2026 algorithm actually rewards.
Only worth chasing a hunter if you find one with 5,000+ followers specifically in Mac
developer tooling.

**4. Launch day and time?**
12:01am PT, and pick the day by what you want. Tuesday and Wednesday have the most
traffic and the most competition. **Thursday** is the sweet spot without a big
pre-launch list. Weekend makes the badge easy and the traffic worthless. Given the goal
here is credibility and backlinks rather than a one-day spike, take Thursday.

**5. Gallery order: what is the first frame?**
The editor, with the timeline and the inspector visible. It answers "is this a real
tool or a toy" in one frame, which is the only question a scroller is asking. Second
frame the camera bubble being moved, because that is the thing no competitor does.
Privacy third. The mascot last: charming, but it does not qualify the product.

**6. Which angle is the tagline?**
Neither, on its own. "Move the camera after you record" is a feature, and it only lands
for people who have already felt that specific pain. "No subscription, nothing
uploaded" is the position, and it is what makes someone stop.

There is a third framing the research suggests and the brief did not consider. In a
feed where half of all launches are AI and most of them ship your screen to somebody's
cloud, **Fetch has an AI story that runs the other way**: Parakeet on the Neural
Engine, transcription that never leaves the machine. That is contrarian rather than
me-too, and it is true.

Suggested tagline: *a screen recorder with an editor and on-device transcription, that
has no server at all*. Then pick non-AI topics on the submission, so you face the 500
to 700 bar rather than the 800 to 1,200 one, while still getting the AI story in the
copy.

## 6. What to actually do

**Before anything else:** notarise. It is the only item here that is both fatal and
entirely in your hands.

**Then, in order:** build and ship a DMG, put the site up with a real download, repoint
the update feed at the site host, decide the price, sort the LICENSE and the ffmpeg
question, make the repo public.

**Then spend four to six weeks on the only thing that moves the number:** build in
public, get the repo in front of people, collect emails on the site, and be somewhere
Mac developers already are. Launch when you have a few hundred people who would
actually show up, not before.

The product is ready enough to win. The launch is not, and no amount of listing copy
substitutes for that.

---

## Sources

- Cap on Product Hunt: https://www.producthunt.com/products/cap-3
- Cap repo and stars: https://github.com/CapSoftware/cap
- Screen Studio 3.0 launch: https://www.producthunt.com/posts/screen-studio-3-0
- Screen Studio founder on launch-day revenue: https://x.com/pie6k/status/1610782639841226752
- 2026 ranking and upvote thresholds: https://poindeo.com/blog/product-hunt-upvote-ranking
- 2026 algorithm changes: https://blazonagency.com/post/product-hunt-algorithm-2026-software-launch
- AI category saturation and thresholds: https://www.tooljunction.io/guides/product-hunt-launch-checklist-2026
- Hunter vs maker in 2026: https://poindeo.com/blog/product-hunt-hunter-vs-maker
- Launch day guidance: https://getlaunchlist.com/blog/how-to-launch-on-product-hunt-2026
