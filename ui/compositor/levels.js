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

module.exports = { measure }
