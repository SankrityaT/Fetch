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
**Decided: free.** Which is a bigger decision than it looks, because it removes the
only real argument against open sourcing, and open sourcing is the distribution engine.
See section 7. Free also sharpens the position: not "cheaper than Loom" but "no
account, no server, no price". Nothing to compare on.

**2. Public repo or closed source?**
**Open it.** With the product free, there is no longer a case against it, and the case
for it is the entire audience plan in section 7. It also makes every claim in the
privacy section independently checkable, which is the strongest asset Fetch has and is
worth nothing while the repo is private.
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

## 6. Where the audience actually comes from

The assumption worth correcting: Product Hunt is not where an audience gets built. It
is where one gets spent. The ranking is decided by velocity in the first six hours,
and that velocity comes from people who already know you. Launch without them and you
place, quietly, and the day is over.

**Cap is the proof, and the sequence is the opposite of what it looks like.**

| when | what | result |
|---|---|---|
| April 2024 | **Show HN** | **#1 on Hacker News**, thousands of users, trending on GitHub, **5,000+ stars** |
| November 2024 | Product Hunt | 739 upvotes |

**Seven months apart.** Cap built the audience on Hacker News and spent it on Product
Hunt. By November it was cashing in a following that already existed. Fetch is
currently at the April step, not the November one.

### Why Hacker News is the right room for this specific product

Hacker News favours open source, self-hosted, local-first, developer tools, and things
you can try immediately. Fetch is all five. The measured returns:

- A front-page Show HN brings **5,000 to 30,000 visitors in 24 hours**.
- Open-source projects convert at roughly **1.4 GitHub stars per HN upvote** within 48
  hours. A 300-point post is around 400 stars, which is a real audience.
- Post Tuesday, Wednesday or Thursday, 8 to 11am ET.

And Fetch has more genuinely interesting engineering than most Show HN posts, which is
the currency there. Not the feature list, the decisions:

- **There is no server.** One outbound URL in the entire codebase, an update check.
  Nothing else. That claim is worth nothing while the repo is private and a lot the
  moment anyone can grep it.
- **On-device transcription.** Parakeet on the Neural Engine, roughly 116x realtime.
- **The camera bubble is native Swift because Chromium cannot open the camera on some
  Macs**, and it is excluded from its own capture with `NSWindow.sharingType = .none`.
- **Window enumeration uses ScreenCaptureKit** because Electron's `desktopCapturer`
  silently misses windows.
- ffmpeg with libass, VP9 alpha, and the surrounding pile of sharp edges.

One warning. Hacker News is harsher than Product Hunt and it will find the Electron
part. The honest answer is already in the codebase and it is a good one: Fetch drops to
native Swift precisely where Chromium could not do the job. Lead with that rather than
waiting to be asked.

### The other rooms, in order of how much they are worth

1. **Show HN.** The main event. Everything above.
2. **r/macapps.** Free Mac apps do well there. Check the current self-promotion rules
   before posting rather than trusting this file, they change.
3. **Write the engineering up.** The `sharingType` trick and the ScreenCaptureKit
   discovery are each a post, and each is a second bite at Hacker News that is not a
   launch post.
4. **Product Hunt, four to eight weeks later**, converting whatever the above built.

## 7. What to actually do, in order

1. **Notarise.** Fatal, and only you can do it.
2. Build and ship a DMG. Put the site up with a real download on it.
3. Repoint the update feed at the site host so it stops depending on the repo.
4. Add a LICENSE and settle the bundled GPL ffmpeg question.
5. **Make the repo public.**
6. **Show HN.** This is the audience event.
7. r/macapps, then the engineering write-ups.
8. **Product Hunt**, four to eight weeks after step 6, when there are a few hundred
   people who would actually turn up.

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
- Cap's Show HN and early traction: https://cap.so/about
- Show HN traffic and stars-per-upvote: https://business.daily.dev/resources/hacker-news-marketing-developer-tools-show-hn-launch-day-sustained-coverage/
- Hacker News launch guidance: https://www.markepear.dev/blog/dev-tool-hacker-news-launch
