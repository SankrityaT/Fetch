// The GL harness's renderer side (test/gl/page.html): draws single frames of a plan
// through both source paths, the editor's (a <video>, seeked into the source frame the
// plan picks) and the export's (that frame decoded by ffmpeg as NV12), and hands the
// pixels back. Driven by test/gl/harness.js with executeJavaScript.
'use strict'
const fs = require('fs')
const path = require('path')
const Plan = require('../../ui/compositor/plan')
const { Compositor } = require('../../ui/compositor/gl')
const { framePts, decodeArgs, FfmpegSource } = require('../../ui/compositor/sources')
const { loadImage, camSquare, loadAssets } = require('../../ui/compositor')

const ptsCache = new Map()
async function ptsOf(ffmpeg, file) {
  if (!ptsCache.has(file)) ptsCache.set(file, await framePts(ffmpeg, file))
  return ptsCache.get(file)
}

// One source frame by index as NV12, through the export's own decode
async function nv12Frame(ffmpeg, file, i, spec, camD) {
  const pts = await ptsOf(ffmpeg, file)
  const map = { pick: Int32Array.from([i]), runs: [[i, i]] }
  const sq = camD ? camSquare(pts.size, camD) : null
  const crop = sq ? sq.crop : spec.crop, cover = sq ? sq.cover : null
  const w = sq ? sq.side : crop.w, h = sq ? sq.side : crop.h
  const src = new FfmpegSource(ffmpeg, decodeArgs(file, pts, map.runs, { crop, cover, hw: true }), map, w, h)
  try {
    const f = await src.frameAt(0)
    if (!f) throw new Error('no frame ' + i)
    return { data: new Uint8Array(f.data), w, h, lines: pts.size ? pts.size[1] : h }
  } finally { src.close() }
}

const videos = new Map()
async function video(file) {
  if (videos.has(file)) return videos.get(file)
  const v = document.createElement('video')
  v.muted = true; v.playsInline = true; v.preload = 'auto'
  v.style.cssText = 'position:fixed;left:0;top:0;width:160px;height:100px;opacity:0;pointer-events:none'
  v.src = 'file://' + encodeURI(file)
  document.body.appendChild(v)
  await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(v.error) })
  videos.set(file, v)
  return v
}
// Seek into the middle of source frame i (from the sample table): seeking to a frame's
// exact start can show the one before it (M0, "What M2 must do differently" 3)
async function seekFrame(v, pts, i) {
  const t = i + 1 < pts.length ? (pts[i] + pts[i + 1]) / 2 : pts[i] + 0.004
  await new Promise(res => {
    let done = false
    const fin = () => { if (!done) { done = true; res() } }
    v.requestVideoFrameCallback(fin)
    setTimeout(fin, 3000)
    v.currentTime = t
  })
}

let comp = null
function compositor(W, H) {
  if (!comp) comp = new Compositor(W, H, { preserve: true })
  comp.resize(W, H)
  return comp
}

/**
 * Render output frame n of a plan through one path. Returns the RGBA frame.
 *   job { ffmpeg, src, opts, meta, ctx, n, path: 'nv12' | 'video' }
 */
async function renderFrame(job) {
  const spec = Plan.prepare(job.opts, job.meta, job.ctx || {})
  // goldens are kept 640 wide, drawn the way the editor's stage draws below export size
  const k = job.width ? Math.min(1, job.width / spec.W) : 1
  const c = compositor(spec.W * k, spec.H * k)
  if (spec.bg.kind === 'image') c.setImage(spec.bg.file, await loadImage(spec.bg.file))
  await loadAssets(c, spec)
  const pts = await ptsOf(job.ffmpeg, job.src)
  const map = Plan.screenFrames(spec, pts)
  const n = Math.min(spec.frames - 1, job.n)
  const i = map.pick[n]
  let cropUV = [0, 0, 1, 1]
  // one source frame by index into the content slot, through whichever path this is
  const upload = async (idx) => {
    if (job.path === 'video') {
      const v = await video(job.src)
      await seekFrame(v, pts, idx)
      c.uploadImage('content', v, v.videoWidth, v.videoHeight)
      const s = spec.src
      cropUV = [spec.crop.x / s.w, spec.crop.y / s.h, spec.crop.w / s.w, spec.crop.h / s.h]
    } else {
      const f = await nv12Frame(job.ffmpeg, job.src, idx, spec)
      c.uploadNV12('content', f.data, f.w, f.h, spec.src.h)
    }
  }
  await upload(i)
  let cam = false, camUV = [0, 0, 1, 1]
  if (spec.cam) {
    const cpts = await ptsOf(job.ffmpeg, spec.cam.file)
    const cm = Plan.cameraFrames(spec, cpts)
    const ci = cm.pick[n]
    if (ci >= 0) {
      cam = true
      if (job.path === 'video') {
        const v = await video(spec.cam.file)
        await seekFrame(v, cpts, ci)
        c.uploadImage('cam', v, v.videoWidth, v.videoHeight)
        const a = v.videoWidth / v.videoHeight
        camUV = a > 1 ? [(1 - 1 / a) / 2, 0, 1 / a, 1] : [0, (1 - a) / 2, 1, a]
      } else {
        const f = await nv12Frame(job.ffmpeg, spec.cam.file, ci, spec, spec.cam.d)
        c.uploadNV12('cam', f.data, f.w, f.h, f.lines)
      }
    }
  }
  const fp = Plan.framePlan(spec, n / spec.fps)
  // a frame inside a dissolve is drawn once per side, both sides through this path
  const xi = fp.mix > 0 ? Plan.crossFrames(spec, pts).pick[n] : -1
  // job.seed holds the frame index the ground's tooth, the film grain and the dither are
  // seeded by, so a run of frames can be compared with only the move between them
  const sn = job.seed != null ? job.seed : n
  if (xi >= 0 && !job.oneSide) {
    c.render(spec, fp, { n: sn, cropUV, cam, camUV, side: 'a' })
    await upload(xi)
    c.render(spec, fp, { n: sn, cropUV, cam, camUV, side: 'b' })
  } else {
    c.render(spec, fp, { n: sn, cropUV, cam, camUV })
  }
  return { W: c.W, H: c.H, px: c.readRGBA(), i, i2: xi, mix: +fp.mix.toFixed(4), taps: fp.taps }
}

// PNG in and out, through a 2D canvas
async function writePNG(file, rgba, W, H) {
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H
  cv.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, W * H * 4), W, H), 0, 0)
  const blob = await new Promise(r => cv.toBlob(r, 'image/png'))
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, Buffer.from(await blob.arrayBuffer()))
}
async function readPNG(file) {
  const img = await loadImage(file)
  const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height
  const g = cv.getContext('2d'); g.drawImage(img, 0, 0)
  return { W: img.width, H: img.height, px: g.getImageData(0, 0, img.width, img.height).data }
}

function diff(a, b, W) {
  let max = 0, sum = 0, over2 = 0, n = 0, at = 0
  for (let k = 0; k < a.length; k += 4) for (let ch = 0; ch < 3; ch++) {
    const d = Math.abs(a[k + ch] - b[k + ch]); if (d > max) { max = d; at = k / 4 } sum += d; if (d > 2) over2++; n++
  }
  return { max, mean: +(sum / n).toFixed(4), over2: +(over2 / n * 100).toFixed(3), ...(W ? { at: [at % W, Math.floor(at / W)] } : {}) }
}

// Preview path against export path for the same frame
window.parity = async (job) => {
  const a = await renderFrame({ ...job, path: 'nv12' }), ax = Uint8Array.from(a.px)
  const b = await renderFrame({ ...job, path: 'video' })
  return { ...diff(ax, b.px, a.W), i: a.i, size: `${a.W}x${a.H}` }
}

// A golden: written on first run, compared after
window.golden = async (job, file, update) => {
  const a = await renderFrame({ ...job, path: 'nv12' })
  if (update || !fs.existsSync(file)) { await writePNG(file, a.px, a.W, a.H); return { written: true, size: `${a.W}x${a.H}`, taps: a.taps } }
  const g = await readPNG(file)
  if (g.W !== a.W || g.H !== a.H) return { max: 255, mean: 255, over2: 100, sizeChanged: true }
  return { ...diff(a.px, g.px), taps: a.taps }
}

// A frame drawn again after others equals the first time: no frame depends on another
window.stateless = async (job, others) => {
  const first = Uint8Array.from((await renderFrame({ ...job, path: 'nv12' })).px)
  for (const n of others) await renderFrame({ ...job, n, path: 'nv12' })
  const again = (await renderFrame({ ...job, path: 'nv12' })).px
  return diff(first, again)
}

// One frame, then the same frame with one field of the look changed: what a field
// actually moves on screen. Holds a preset to its word, so a field it declares and no
// pass draws fails here instead of quietly doing nothing.
window.moved = async (job, variants) => {
  const a = await renderFrame({ ...job, path: 'nv12' }), ax = Uint8Array.from(a.px)
  const out = []
  for (const v of variants) {
    const b = await renderFrame({ ...v, path: 'nv12' })
    out.push(b.W !== a.W || b.H !== a.H ? { max: 255, mean: 255, over2: 100, size: `${b.W}x${b.H}` } : diff(ax, b.px, a.W))
  }
  return out
}

/**
 * A run of frames of one plan, each drawn alone, measured against a reference frame:
 * the mean absolute difference per channel, the frame's own mean luma, and what the
 * plan said (mix, the two source picks). A still cannot say whether a move is monotone,
 * and this is the cheapest thing that can.
 */
window.march = async (job, ns, refN) => {
  const job2 = { ...job, seed: 0 }
  const ref = Uint8Array.from((await renderFrame({ ...job2, n: refN, path: 'nv12' })).px)
  const out = []
  for (const n of ns) {
    const a = await renderFrame({ ...job2, n, path: 'nv12' })
    let sum = 0, lum = 0, k = 0
    for (let p = 0; p < ref.length; p += 4) {
      sum += Math.abs(a.px[p] - ref[p]) + Math.abs(a.px[p + 1] - ref[p + 1]) + Math.abs(a.px[p + 2] - ref[p + 2])
      lum += 0.2126 * a.px[p] + 0.7152 * a.px[p + 1] + 0.0722 * a.px[p + 2]
      k++
    }
    out.push({ n, diff: +(sum / (k * 3)).toFixed(3), luma: +(lum / k).toFixed(3), mix: a.mix, i: a.i, i2: a.i2 })
  }
  return out
}

/**
 * A run of frames drawn in order, then the same frames drawn again in the order given.
 * Motion is a function of the output time alone, so the two runs have to be the same
 * pixels: it is what lets the export render out of order and the stage scrub straight
 * to the middle of a move. `stateless` is one frame of this claim; this is a whole
 * sequence of it, which is where a move that remembered anything would show.
 * The seed is the frame's own index, as in an export, so the grain travels with it.
 */
window.permute = async (job, ns, order) => {
  const first = new Map()
  for (const n of ns) first.set(n, Uint8Array.from((await renderFrame({ ...job, n, path: 'nv12' })).px))
  const out = []
  for (const n of order) {
    const a = await renderFrame({ ...job, n, path: 'nv12' })
    out.push({ n, ...diff(first.get(n), a.px) })
  }
  return out
}

/**
 * A frame inside a dissolve, drawn with no far side to mix in: the stage has none while
 * its second <video> is still seeking, and a still has none when that decode comes back
 * empty. It has to be the near side drawn alone. The compositor keeps its targets
 * between frames, so what a draw that wrote nothing would hand back is the frame before,
 * and this draws a different frame before it each time to say which of the two arrived.
 */
window.oneSided = async (job, before) => {
  const prev = Uint8Array.from((await renderFrame({ ...job, n: before, path: 'nv12' })).px)
  const a = Uint8Array.from((await renderFrame({ ...job, path: 'nv12', oneSide: true })).px)
  await renderFrame({ ...job, n: before + 40, path: 'nv12' })
  const b = (await renderFrame({ ...job, path: 'nv12', oneSide: true })).px
  const both = await renderFrame({ ...job, path: 'nv12' })
  return { same: diff(a, b), stale: diff(a, prev), mixed: diff(a, both.px), mix: both.mix }
}

// Write a frame to look at
window.shot = async (job, file) => {
  const a = await renderFrame({ ...job, path: job.path || 'nv12' })
  await writePNG(file, a.px, a.W, a.H)
  return { size: `${a.W}x${a.H}`, i: a.i, taps: a.taps }
}

require('electron').ipcRenderer.send('page:ready')
