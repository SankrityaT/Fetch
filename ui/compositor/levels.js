// Auto level: the take's own exposure, measured once.
//
// The compositor's treatment stretches every frame between the same two numbers, so
// they cannot be measured while drawing: a pass that read the frame it is drawing, or
// the ones before it, would make a frame's look depend on when it was drawn, and no
// pass here may do that (PASSES.md). This runs in the main process, once per take and
// edit, and hands the plan two constants.
//
// Keyframes only, at 64x36 grey: a few dozen honest samples of the whole take for
// about the cost of a demux, where decoding every frame of a long 4K take is not
// something an editor can do on a look change.

const { spawn } = require('child_process')
const proc = require('../../processor')

// The darkest and the lightest 0.4 percent of what was sampled are a cursor, a white
// toast or a black corner, not the picture's ends
const TAIL = 0.004

/**
 * measure(src, { start, end, crop, width, height, viewport, screen, timeout }) resolves { lo, hi } in
 * 0..1, the black and white points to stretch between, or null when there is nothing
 * worth stretching or the take could not be read. Never rejects, and always settles: a
 * take with no levels simply draws without them.
 */
function measure(src, { start = 0, end = 0, crop = null, width = 0, height = 0, viewport = null, screen = null, timeout = 20000 } = {}) {
  return new Promise(resolve => {
    const vf = []
    if (crop && crop.w > 0 && crop.h > 0 && width && height) {
      // the crop the export will use, in the pixels plan.prepare takes (Plan.cropPx): on a
      // device take that is held to the glass, so no row of the Simulator's black ring is
      // read into the black point
      const px = require('./plan').cropPx(crop, width, height, { viewport, screen })
      if (px.w > 1 && px.h > 1) vf.push(`crop=${px.w}:${px.h}:${px.x}:${px.y}`)
    }
    vf.push('scale=64:36:flags=bilinear', 'format=gray')
    const args = ['-v', 'error', '-skip_frame', 'nokey']
    if (start > 0) args.push('-ss', String(start))
    args.push('-i', src)
    if (end > start) args.push('-t', String(end - start))
    args.push('-vf', vf.join(','), '-fps_mode', 'passthrough', '-frames:v', '400', '-f', 'rawvideo', '-')
    let p
    try { p = spawn(proc.FFMPEG, args) } catch { return resolve(null) }
    const hist = new Float64Array(256)
    let n = 0, done = false, timer = null
    const finish = r => { if (done) return; done = true; clearTimeout(timer); try { p.kill('SIGKILL') } catch {}; resolve(r) }
    // a take ffmpeg has something to say about (a decode error a keyframe) fills the
    // pipe and stops the child dead if nobody reads it, and prepare.js waits on this
    p.stderr.on('data', () => {})
    p.stderr.on('error', () => {})
    p.stdout.on('data', b => { for (const v of b) hist[v]++; n += b.length })
    p.stdout.on('error', () => {})
    p.on('error', () => finish(null))
    p.on('close', () => finish(points(hist, n)))
    // and a take it cannot read at all is a look change that never lands: the histogram
    // so far, or nothing, rather than an export that waits forever
    timer = setTimeout(() => finish(points(hist, n)), timeout)
    if (timer.unref) timer.unref()
  })
}

// Where the picture actually starts and ends, in 0..255
function points(hist, n) {
  if (n < 2048) return null                       // one small frame is not a take
  const want = n * TAIL
  let lo = 0, hi = 255, acc = 0
  for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= want) { lo = i; break } }
  acc = 0
  for (let i = 255; i >= 0; i--) { acc += hist[i]; if (acc >= want) { hi = i; break } }
  // The two refusals read the picture's own ends, before the caps below: capped first,
  // every take came back at least 106 apart and the flat one was never left alone.
  if (lo < 6 && hi > 249) return null             // already fills the range
  if (hi - lo < 48) return null                   // a flat take, or a title card: leave it
  // Never lift more than a quarter of the range and never pull the white point below
  // two thirds: an evenly exposed take stretched hard looks like a different recording
  // rather than a corrected one.
  return { lo: Math.min(lo, 64) / 255, hi: Math.max(hi, 170) / 255 }
}

// Colours are counted in buckets of 16 a channel, not one per value: a screen's flat
// fills arrive with a codec's worth of drift over them, and counting exact pixels would
// split one button's blue across a dozen values and let a grey win a vote it lost.
// Each bucket answers with the mean of what landed in it, so the colour handed back is
// the one that was on screen rather than the corner of the step it fell in.
const STEP = 16
const LEVELS = 256 / STEP
const BUCKETS = LEVELS ** 3
const bucketOf = (r, g, b) => (((r / STEP) | 0) * LEVELS + ((g / STEP) | 0)) * LEVELS + ((b / STEP) | 0)

/**
 * palette(src, { start, end, crop, width, height, viewport, screen, timeout }) resolves
 * { bg, ink, accent, mean }: the first three as '#rrggbb' strings, the ground the
 * product is drawn on, what is written on that ground, and the product's own colour,
 * which is null when the take has no saturated colour in it at all. `mean` is the whole
 * take's own luma in 0..1, which is a different question from its ground: the blurred
 * ground the compositor can draw is an average of the take and not the colour most of
 * it is, and a take whose ground is a white page and whose product is a dark chart
 * answers the two apart. Resolves null when the take could not be read. Never rejects.
 *
 * A second pass over the same keyframes, rather than a widening of measure's: measure
 * runs on every look change and every export, and grey is a third of the bytes and all
 * exposure needs. A product's colours are asked for once, when it is first seen, so the
 * cheaper pass stays cheap.
 */
function palette(src, { start = 0, end = 0, crop = null, width = 0, height = 0, viewport = null, screen = null, timeout = 20000 } = {}) {
  return new Promise(resolve => {
    const vf = []
    if (crop && crop.w > 0 && crop.h > 0 && width && height) {
      // the same crop the export will draw, for the same reason measure takes it: the
      // Simulator's black ring is not this take's background
      const px = require('./plan').cropPx(crop, width, height, { viewport, screen })
      if (px.w > 1 && px.h > 1) vf.push(`crop=${px.w}:${px.h}:${px.x}:${px.y}`)
    }
    vf.push('scale=64:36:flags=bilinear', 'format=rgb24')
    const args = ['-v', 'error', '-skip_frame', 'nokey']
    if (start > 0) args.push('-ss', String(start))
    args.push('-i', src)
    if (end > start) args.push('-t', String(end - start))
    args.push('-vf', vf.join(','), '-fps_mode', 'passthrough', '-frames:v', '400', '-f', 'rawvideo', '-')
    let p
    try { p = spawn(proc.FFMPEG, args) } catch { return resolve(null) }
    const count = new Float64Array(BUCKETS)
    const sum = new Float64Array(BUCKETS * 3)
    let n = 0, done = false, timer = null
    // rgb24 is three bytes a pixel and a chunk ends wherever the pipe filled, so the odd
    // pixel straddles two of them: its first bytes have to wait here for the rest
    let phase = 0, pr = 0, pg = 0
    const finish = r => { if (done) return; done = true; clearTimeout(timer); try { p.kill('SIGKILL') } catch {}; resolve(r) }
    // the same deaf reader measure keeps, and for the same reason: a child whose stderr
    // nobody drains stops at the pipe and never closes
    p.stderr.on('data', () => {})
    p.stderr.on('error', () => {})
    p.stdout.on('data', b => {
      for (const v of b) {
        if (phase === 0) { pr = v; phase = 1; continue }
        if (phase === 1) { pg = v; phase = 2; continue }
        phase = 0
        const i = bucketOf(pr, pg, v)
        count[i]++
        sum[i * 3] += pr; sum[i * 3 + 1] += pg; sum[i * 3 + 2] += v
        n++
      }
    })
    p.stdout.on('error', () => {})
    p.on('error', () => finish(null))
    p.on('close', () => finish(colours(count, sum, n)))
    timer = setTimeout(() => finish(colours(count, sum, n)), timeout)
    if (timer.unref) timer.unref()
  })
}

// The three colours, out of the buckets that were voted for, and the take's own level
function colours(count, sum, n) {
  if (n < 2048) return null                       // one small frame is not a take
  // The mean is of every pixel that was read, before the vote and before the tail is
  // left out: the compositor's blurred ground is that average and nothing else, so a
  // toast or a cursor belongs in it exactly as much as it belongs in the picture. The
  // weights are the ones the frame pass uses on the same sRGB values, not the
  // linearised ones below, because what is being answered is how light the ground it
  // draws will be and not how two colours read against each other.
  let mr = 0, mg = 0, mb = 0
  for (let i = 0; i < BUCKETS; i++) { mr += sum[i * 3]; mg += sum[i * 3 + 1]; mb += sum[i * 3 + 2] }
  const mean = (0.2126 * mr + 0.7152 * mg + 0.0722 * mb) / (255 * n)
  // A colour has to hold the same 0.4 percent measure gives the picture's ends before it
  // counts: below that it is a cursor, a toast, or the fringe of one antialiased edge,
  // and none of those is what the product is painted in.
  const want = n * TAIL
  const seen = []
  let top = -1
  for (let i = 0; i < BUCKETS; i++) {
    const c = count[i]
    if (c < want) continue
    seen.push({ c, col: [sum[i * 3] / c, sum[i * 3 + 1] / c, sum[i * 3 + 2] / c] })
    if (top < 0 || c > seen[top].c) top = seen.length - 1
  }
  if (!seen.length) return null
  const bg = seen[top].col
  // Most contrast, by what the eye does with it rather than by distance in rgb, or a
  // saturated blue reads as further from white than the mid grey that actually is
  let ink = bg, far = -1
  for (const s of seen) { const r = contrast(s.col, bg); if (r > far) { far = r; ink = s.col } }
  // A take that is one flat colour has no ink in it, and saying so is the honest answer.
  // It used to hand back the ground again, which reads as a real second colour and is
  // not one: whatever consumed it put the ground's own colour where the lettering goes.
  // WCAG's floor for large text is the bar for "there is genuinely something written
  // here", and the degenerate case sits at exactly 1.
  const inked = far >= 3
  let accent = null, best = -1
  for (const s of seen) {
    const hi = Math.max(s.col[0], s.col[1], s.col[2]), lo = Math.min(s.col[0], s.col[1], s.col[2])
    const sat = hi > 0 ? (hi - lo) / hi : 0
    // a near-black corner and a barely warm grey both measure as tinted; neither is a
    // colour anybody chose, so an accent has to be bright as well as saturated
    if (sat < 0.35 || hi < 64) continue
    // Weighed by how much of the picture it covers, not by saturation alone. Saturation
    // alone picked a colour on four tenths of a percent of the frame over the one on
    // thirteen percent of it, because the fringe happened to measure 1.000 where the
    // real one measured 0.996. An accent is a colour the product is painted in, and a
    // colour nothing is painted in is a fringe however pure it measures.
    const weight = sat * (s.c / n)
    if (weight > best) { best = weight; accent = s.col }
  }
  return { bg: hex(bg), ink: inked ? hex(ink) : null, accent: accent ? hex(accent) : null, mean }
}

const luma = c => {
  const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2])
}
const contrast = (a, b) => {
  const x = luma(a), y = luma(b)
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}
const hex = c => '#' + c.map(v => Math.round(v).toString(16).padStart(2, '0')).join('')

module.exports = { measure, palette }
