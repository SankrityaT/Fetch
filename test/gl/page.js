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
  if (job.path === 'video') {
    const v = await video(job.src)
    await seekFrame(v, pts, i)
    c.uploadImage('content', v, v.videoWidth, v.videoHeight)
    const s = spec.src
    cropUV = [spec.crop.x / s.w, spec.crop.y / s.h, spec.crop.w / s.w, spec.crop.h / s.h]
  } else {
    const f = await nv12Frame(job.ffmpeg, job.src, i, spec)
    c.uploadNV12('content', f.data, f.w, f.h, spec.src.h)
  }
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
  c.render(spec, fp, { n, cropUV, cam, camUV })
  return { W: c.W, H: c.H, px: c.readRGBA(), i, taps: fp.taps }
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

// Write a frame to look at
window.shot = async (job, file) => {
  const a = await renderFrame({ ...job, path: job.path || 'nv12' })
  await writePNG(file, a.px, a.W, a.H)
  return { size: `${a.W}x${a.H}`, i: a.i, taps: a.taps }
}

require('electron').ipcRenderer.send('page:ready')
