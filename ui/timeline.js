// Time in an edit: which parts of the take survive, where a moment of the take lands
// in the output, and the way back.
//
// This used to live inside processor.js next to the ffmpeg graph, so the only clock
// was the one the export built. The editor preview and the new compositor need the
// same answers without ffmpeg, and "output frame n shows source time t" has to agree
// to the frame between all of them, so it is here, pure, with its own tests
// (test/timeline.test.js).
//
// Source time is seconds into the recorded take. Output time is seconds into the
// finished video, after the trim, the cuts and the rate each surviving piece runs at.

/**
 * The ranges of [from, to] that survive once `cuts` are removed, in order. Cuts are
 * merged where they overlap, a cut under 20 ms is ignored and a kept sliver under
 * 50 ms is dropped, so a hand-dragged cut never leaves a one-frame flash.
 */
function keepRanges(cuts, from, to) {
  const merged = (cuts || [])
    .map(c => [Math.max(from, +c[0]), Math.min(to, +c[1])])
    .filter(([a, b]) => b - a > 0.02)
    .sort((a, b) => a[0] - b[0])
    .reduce((acc, cur) => {
      const last = acc[acc.length - 1]
      if (last && cur[0] <= last[1]) { last[1] = Math.max(last[1], cur[1]); return acc }
      acc.push(cur); return acc
    }, [])
  const keep = []
  let t = from
  for (const [a, b] of merged) { if (a - t > 0.05) keep.push([t, a]); t = b }
  if (to - t > 0.05) keep.push([t, to])
  return keep
}

// ── rate ────────────────────────────────────────────────────────────────
//
// A kept range is [a, b] at the take's own rate, [a, b, r] held at one rate, or
// [a, b, r0, r1] for a ramp. Rate is source seconds spent per output second, so 2
// is twice as fast and 0.5 is half. A range that runs at 1 is written [a, b] and
// nothing downstream can tell this code was ever here, which is why every document
// written before speed existed still reads out byte for byte what it did.
//
// A ramp's rate runs linearly in OUTPUT seconds, not in source seconds, and that
// choice is the whole reason a ramp stays a closed form. With r(tau) = r0 + m*tau,
// the source time it has reached integrates to a quadratic, s = a + r0*tau +
// m*tau^2/2, whose inverse is one square root. The other choice, linear in source,
// integrates to a logarithm and reads its own inverse as an exponential, and neither
// is worse arithmetic so much as worse to reason about at a boundary. It also hands
// back the length for free: over a segment the mean rate is exactly (r0 + r1) / 2,
// so a ramp's output span is 2 * (b - a) / (r0 + r1), and at r0 === r1 that is the
// plain (b - a) / r the constant case already wanted.
//
// Nothing here accumulates: every answer is solved from the range and the time. That
// is the same rule the passes keep, and it is what lets srcTime invert exactly.
const RATE_MIN = 0.1, RATE_MAX = 20
const rateEnds = seg => {
  const r0 = seg.length > 2 && +seg[2] > 0 ? +seg[2] : 1
  return [r0, seg.length > 3 && +seg[3] > 0 ? +seg[3] : r0]
}
// How many output seconds a kept range is worth
function outSpan(seg) {
  const [r0, r1] = rateEnds(seg)
  return 2 * (seg[1] - seg[0]) / (r0 + r1)
}
// The source time a range has reached tau output seconds in, and the rate there
function srcIn(seg, tau) {
  const [a, b] = seg, [r0, r1] = rateEnds(seg)
  if (r0 === r1) return a + tau * r0
  const m = (r1 - r0) / outSpan(seg)
  return a + r0 * tau + m * tau * tau / 2
}
function rateIn(seg, tau) {
  const [r0, r1] = rateEnds(seg)
  if (r0 === r1) return r0
  return r0 + (r1 - r0) / outSpan(seg) * tau
}
// and the way back: the output seconds a range has spent to reach source time s
function outIn(seg, s) {
  const [a] = seg, [r0, r1] = rateEnds(seg)
  const d = Math.max(0, s - a)
  if (r0 === r1) return d / r0
  const m = (r1 - r0) / outSpan(seg)
  return (Math.sqrt(Math.max(0, r0 * r0 + 2 * m * d)) - r0) / m
}
// A sub-range of a ramp is a ramp. Rate is linear in output time and output time is
// only shifted by the cut, so the piece keeps the rates it actually had at its ends
// and its own closed form is the parent's, restricted.
function slice(seg, a, b) {
  const [r0, r1] = rateEnds(seg)
  if (r0 === r1) return r0 === 1 ? [a, b] : [a, b, r0]
  return [a, b, rateIn(seg, outIn(seg, a)), rateIn(seg, outIn(seg, b))]
}

/**
 * Hand the rates the clips asked for to the ranges the cuts left. `rates` is source
 * spans, [a, b, r0, r1] like a kept range; a kept range with none is left alone and
 * stays a bare pair.
 *
 * A range is split wherever the rate changes inside it, and it has to be: two clips
 * that meet with no gap between them leave no cut, so the whole run comes back as one
 * range, and the second clip's speed would be thrown away. Splitting means kept ranges
 * can now be adjacent, which they never were before, and the one thing downstream that
 * cared is the cut transition, which is between pieces the edit actually separated
 * (plan.js, cutPoints, skips a boundary with no gap behind it).
 */
function applyRates(keep, rates) {
  if (!rates || !rates.length) return keep
  const spans = rates.filter(r => r && r[1] > r[0]).sort((x, y) => x[0] - y[0])
  const out = []
  for (const k of keep) {
    const [a, b] = k
    let t = a
    for (const seg of spans) {
      const lo = Math.max(t, seg[0]), hi = Math.min(b, seg[1])
      if (hi - lo <= 1e-9) continue
      if (lo - t > 1e-9) out.push([t, lo])
      out.push(slice(seg, lo, hi))
      t = hi
    }
    if (b - t > 1e-9) out.push(t === a ? k : [t, b])
  }
  return out
}

/**
 * A range cut into pieces short enough that one rate describes each of them.
 *
 * The picture does not need this: setpts takes the ramp's closed form whole. The
 * sound does, because ffmpeg's atempo is one number and has no sliding form, so a
 * ramp's audio is a staircase however it is written. `step` is the longest an output
 * piece may be, and at a fifth of a second the worst a burst lands from where the
 * picture puts it is a few milliseconds, well under the twenty or so the ear reads as
 * out of sync. Each piece is the parent's own map restricted, so the pieces add up to
 * exactly the parent's length and nothing accumulates across them.
 */
const RATE_STEP = 0.2
function rateSteps(seg, step = RATE_STEP) {
  const [r0, r1] = rateEnds(seg)
  const T = outSpan(seg)
  const n = r0 === r1 ? 1 : Math.max(1, Math.min(256, Math.ceil(T / step)))
  if (n === 1) return [seg]
  const out = []
  for (let i = 0; i < n; i++) {
    const a = i === 0 ? seg[0] : srcIn(seg, T * i / n)
    const b = i === n - 1 ? seg[1] : srcIn(seg, T * (i + 1) / n)
    out.push(slice(seg, a, b))
  }
  return out
}

/**
 * Kept ranges cut again at source times of someone else's choosing, so a setting that
 * changes partway through a range can be applied to each piece on its own. A time in a
 * gap, or on an end, changes nothing.
 *
 * Rates split their own ranges as they are applied (applyRates). Sound needs the same
 * knife for a reason of its own: two clips meeting with no gap leave no cut, so the
 * whole run comes back as one range, and a clip asking to be louder would lift its
 * neighbour with it. Each piece is the parent's own map restricted (slice), so the
 * pieces are exactly as long as the range they came from and a ramp survives the cut.
 */
function splitAt(keep, times) {
  const pts = (times || []).map(Number).filter(n => Number.isFinite(n)).sort((a, b) => a - b)
  if (!pts.length) return keep || []
  const out = []
  for (const seg of keep || []) {
    let t = seg[0]
    for (const p of pts) {
      if (p <= t + 1e-9 || p >= seg[1] - 1e-9) continue
      out.push(slice(seg, t, p))
      t = p
    }
    out.push(t === seg[0] ? seg : slice(seg, t, seg[1]))
  }
  return out
}

/**
 * Source time to output time, as a function. A moment inside a cut lands where the
 * cut closed (the start of the next kept range). clock.kept(t) says whether t survives
 * at all: a click inside a cut has to be dropped, not snapped, or a zoom lands on
 * something no longer on screen. clock.keep is the ranges it was built from.
 *
 * `rates` is what the clips asked for (Fetchdoc.trimFromClips); left out, every range
 * runs at 1 and this is the function it always was.
 */
function outClock(cuts, start, end, rates) {
  const cut = (cuts && cuts.length) ? keepRanges(cuts, start, end) : [[start, end]]
  const keep = applyRates(cut, rates)
  const clock = t => {
    let acc = 0
    for (const seg of keep) {
      if (t < seg[0]) return acc
      if (t <= seg[1]) return acc + outIn(seg, t)
      acc += outSpan(seg)
    }
    return acc
  }
  clock.kept = t => keep.some(seg => t >= seg[0] && t <= seg[1])
  clock.keep = keep
  // The rate a source moment plays at, for anything measuring per output second
  clock.rate = t => {
    for (const seg of keep) if (t >= seg[0] && t <= seg[1]) return rateIn(seg, outIn(seg, t))
    return 1
  }
  return clock
}

/**
 * Output time back to source time: the inverse of outClock on kept ranges, so
 * srcTime(keep, clock(t)) === t for any t that survives. A time past the end holds
 * the last kept moment.
 */
function srcTime(keep, tOut) {
  let acc = 0
  const t = Math.max(0, +tOut || 0)
  for (const seg of keep || []) {
    const len = outSpan(seg)
    if (t <= acc + len) return Math.min(seg[1], srcIn(seg, t - acc))
    acc += len
  }
  const last = (keep || [])[keep.length - 1]
  return last ? last[1] : t
}

// Length of the output a set of kept ranges makes
const outLength = keep => (keep || []).reduce((n, seg) => n + outSpan(seg), 0)

/**
 * The rate at an OUTPUT time: source seconds per output second. What the shutter and
 * the sound both have to ask, because both of them measure per output second and the
 * document says rate per piece of the take.
 */
function rateAt(keep, tOut) {
  let acc = 0
  const t = Math.max(0, +tOut || 0)
  for (const seg of keep || []) {
    const len = outSpan(seg)
    if (t <= acc + len) return rateIn(seg, t - acc)
    acc += len
  }
  const last = (keep || [])[(keep || []).length - 1]
  return last ? rateEnds(last)[1] : 1
}

/**
 * The rate a take's own frames arrive at, in fps, read from their presentation times;
 * 0 when there are too few of them to say.
 *
 * Not the average. ScreenCaptureKit writes a frame only when the screen changes, so a
 * take's average is its display's refresh less everything that stood still, and the
 * average is all ffmpeg reports: of this person's four takes one steps at 1/60 the
 * whole way through and reads 26, because the page it is of stands still for half its
 * length and the gaps that leaves run to a second each. The cadence is the rate most
 * of its frames actually arrive at, the median of the gaps between them: a handful of
 * long stills cannot drag it down and a handful of stray short gaps cannot lift it.
 * All four of those takes read 60.00, and a take that really does deliver every other
 * 60 Hz frame reads 30, which is the rate it should go out at.
 */
function takeFps(pts) {
  if (!pts || pts.length < 24) return 0
  const d = []
  for (let i = 1; i < pts.length; i++) { const x = pts[i] - pts[i - 1]; if (x > 1e-4) d.push(x) }
  if (d.length < 20) return 0
  d.sort((a, b) => a - b)
  return 1 / d[d.length >> 1]
}

// The export's frame rate: 60 where the take's screen runs at 45 fps or more, else 30,
// and every frame is resampled onto it (frameAt, sample and hold).
//
// There is no third option. A native take is variable rate by nature: its frames land
// 15 to 20 ms apart on the container's own 600 Hz clock, with whole frames missing
// wherever nothing moved, so no output rate makes sample and hold clean. Writing a
// take's 57.88 fps average as 57.88 takes the repeats in the file from 128 to 86 and
// the repeats on the 60 Hz screen it is played on from 128 to 204, since the player
// has to resample it a second time, and throws 86 captured frames away doing it
// (.context/survey/m5-timing.md). So the rate is snapped to one a player runs at 1:1,
// and which of the two is read off the take's cadence rather than off an average a
// still screen drags down.
const cadence = meta => (meta && +meta.cadence > 0 ? +meta.cadence : ((meta && +meta.fps) || 30))
const outFps = meta => (cadence(meta) >= 45 ? 60 : 30)

/**
 * Which source frame output frame n shows, sample and hold: the last source frame at
 * or before n / fps on the output clock, mapped back through the cuts. `frames` is the
 * take's presentation times in seconds, sorted; without them the source time itself.
 */
function frameAt(keep, fps, n, frames) {
  const s = srcTime(keep, n / fps)
  if (!frames || !frames.length) return s
  let lo = 0, hi = frames.length - 1
  if (s < frames[0]) return frames[0]
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (frames[mid] <= s + 1e-6) lo = mid; else hi = mid - 1
  }
  return frames[lo]
}

/**
 * The camera take's time showing screen (source) time s, or null before the camera
 * had started. The camera starts a moment after the screen (skew) and keeps rolling
 * through pauses the screen take leaves out (gaps, in epoch ms on the camera clock).
 */
function camTime(cam, s) {
  if (!cam) return null
  const camStart = cam.camStartedAt, scrStart = cam.screenStartedAt
  const skew = (camStart && scrStart) ? (scrStart - camStart) / 1000 : 0
  const gaps = (cam.gaps || [])
    .filter(g => Array.isArray(g) && g.length === 2 && camStart)
    .map(([a, b]) => [(a - camStart) / 1000, (b - camStart) / 1000])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0])
  // the camera's own clock with the gaps taken out
  let c = s + skew
  if (c < 0) return null
  for (const [a, b] of gaps) {
    if (c < a) break
    c += b - a
  }
  return c
}

module.exports = { keepRanges, outClock, srcTime, outLength, outFps, takeFps, frameAt, camTime,
  applyRates, outSpan, srcIn, outIn, rateIn, rateEnds, rateAt, rateSteps, splitAt, RATE_MIN, RATE_MAX }
