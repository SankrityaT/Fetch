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
// finished video, after the trim and the cuts.

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

/**
 * Source time to output time, as a function. A moment inside a cut lands where the
 * cut closed (the start of the next kept range). clock.kept(t) says whether t survives
 * at all: a click inside a cut has to be dropped, not snapped, or a zoom lands on
 * something no longer on screen. clock.keep is the ranges it was built from.
 */
function outClock(cuts, start, end) {
  const keep = (cuts && cuts.length) ? keepRanges(cuts, start, end) : [[start, end]]
  const clock = t => {
    let acc = 0
    for (const [a, b] of keep) {
      if (t < a) return acc
      if (t <= b) return acc + (t - a)
      acc += b - a
    }
    return acc
  }
  clock.kept = t => keep.some(([a, b]) => t >= a && t <= b)
  clock.keep = keep
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
  for (const [a, b] of keep || []) {
    const len = b - a
    if (t <= acc + len) return a + (t - acc)
    acc += len
  }
  const last = (keep || [])[keep.length - 1]
  return last ? last[1] : t
}

// Length of the output a set of kept ranges makes
const outLength = keep => (keep || []).reduce((n, [a, b]) => n + (b - a), 0)

// The export's frame rate: 60 for a take recorded at 45 fps or more, else 30. A native
// take is variable rate (ScreenCaptureKit writes a frame only when the screen changes),
// so the rate is decided here and every frame is resampled onto it.
const outFps = meta => (((meta && meta.fps) || 30) >= 45 ? 60 : 30)

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

module.exports = { keepRanges, outClock, srcTime, outLength, outFps, frameAt, camTime }
