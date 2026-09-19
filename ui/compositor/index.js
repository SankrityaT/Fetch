// The export loop, run in the hidden render window (ui/render-window.js): decode the
// frames the plan needs, draw each output frame with the compositor, pack it to NV12,
// read it back without stalling and hand it to the encoder. Sound is not here: the
// host renders it with ffmpeg alongside and muxes the two (ui/render-host.js).
'use strict'
const Plan = require('./plan')
const { Compositor, Readback } = require('./gl')
const { framePts, decodeArgs, FfmpegSource } = require('./sources')
const { encodeArgs, Nv12PipeSink, WebCodecsSink } = require('./sinks')

const even = n => Math.max(2, 2 * Math.round(n / 2))

// Yield to the event loop without timers or rAF: a hidden window throttles those, a
// MessageChannel runs at full speed (M0, exit criterion 4)
const channel = new MessageChannel()
const waiting = []
channel.port1.onmessage = () => { const r = waiting.shift(); if (r) r() }
const yieldNow = () => new Promise(r => { waiting.push(r); channel.port2.postMessage(0) })

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('could not read the background image ' + file))
    img.src = 'file://' + encodeURI(file).replace(/#/g, '%23').replace(/\?/g, '%3F')
  })
}

/**
 * How big to decode the take. Decoding is cheap next to what it saves when a 5K take
 * goes to a 1080 frame, and scale_vt does it on the GPU before the download; a take
 * already near the size the deepest zoom needs is decoded as it is.
 */
function decodeSize(spec) {
  const deepest = Math.max(1, ...spec.zooms.map(z => +z.scale || 1))
  const need = spec.rect.w / spec.inner.w * deepest
  const c = spec.crop
  if (c.w <= need * 1.5) return { scale: null, crop: c, w: c.w, h: c.h }
  const k = need * 1.15 / c.w
  const sw = even(spec.src.w * k), sh = even(spec.src.h * k)
  const crop = { x: even(Math.floor(c.x * k)), y: even(Math.floor(c.y * k)), w: even(c.w * k), h: even(c.h * k) }
  crop.x = Math.min(crop.x, sw - crop.w); crop.y = Math.min(crop.y, sh - crop.h)
  return { scale: [sw, sh], crop, w: crop.w, h: crop.h }
}

/**
 * The camera as decoded: its centre square at its own size, so the bubble is sampled
 * by the GPU the way the editor samples the camera's <video>; shrunk by ffmpeg only
 * when it is far bigger than the bubble.
 */
function camSquare(size, d) {
  const [w, h] = size || [640, 480]
  const s = Math.min(w, h) & ~1
  const crop = { x: ((w - s) >> 1) & ~1, y: ((h - s) >> 1) & ~1, w: s, h: s }
  const cover = s > 3 * d ? even(2 * d) : null
  return { crop, cover, side: cover || s }
}

/**
 * Render the picture of one export to job.out (video only).
 *   job    { spec, src, out, ffmpeg, quality }
 *   hooks  { progress(frame, total), pid(pid), cancelled() -> bool }
 */
async function renderVideo(job, hooks = {}) {
  const { spec, ffmpeg } = job
  const t0 = performance.now()
  const pid = hooks.pid || (() => {})
  const pts = await framePts(ffmpeg, job.src)
  if (!pts.length) throw new Error('the recording has no video frames')
  const map = Plan.screenFrames(spec, pts)
  const size = decodeSize(spec)
  const open = hw => new FfmpegSource(ffmpeg, decodeArgs(job.src, pts, map.runs, { crop: size.crop, scale: size.scale, hw }),
    map, size.w, size.h, { onPid: pid })
  let screen = open(true)

  let cam = null, camLines = 1080
  if (spec.cam) {
    try {
      const cpts = await framePts(ffmpeg, spec.cam.file)
      const cmap = Plan.cameraFrames(spec, cpts)
      const c = camSquare(cpts.size, spec.cam.d)
      camLines = cpts.size ? cpts.size[1] : 1080
      cam = new FfmpegSource(ffmpeg, decodeArgs(spec.cam.file, cpts, cmap.runs, { crop: c.crop, cover: c.cover, hw: true }), cmap, c.side, c.side, { onPid: pid })
    } catch (e) { console.warn('camera left out: ' + e.message) }
  }

  const comp = new Compositor(spec.W, spec.H)
  if (spec.bg.kind === 'image') {
    try { comp.setImage(spec.bg.file, await loadImage(spec.bg.file)) } catch (e) { console.warn(e.message) }
  }
  // The encoder: packed NV12 read back into ffmpeg's x264, as the classic export encodes
  // (sinks.js says why); VideoToolbox (sink 'vt') or Chromium's encoder on the canvas
  // (sink 'webcodecs') when asked, for measuring
  const q = job.quality || 'balanced'
  const webcodecs = job.sink === 'webcodecs' && await WebCodecsSink.supported(spec.W, spec.H, spec.fps)
  const rb = webcodecs ? null : new Readback(comp, 3)
  const sink = webcodecs
    ? await new WebCodecsSink(ffmpeg, job.out, comp.canvas, spec.W, spec.H, spec.fps, { quality: q, onPid: pid }).open()
    : new Nv12PipeSink(ffmpeg, encodeArgs(job.out, spec.W, spec.H, spec.fps, { quality: q, W4: comp.packed.w * 4, codec: job.sink === 'vt' ? 'vt' : 'x264' }), rb.bytes, { onPid: pid })
  const stats = { frames: spec.frames, uploads: 0, camUploads: 0, decodeRetry: false, sink: webcodecs ? 'webcodecs' : job.sink === 'vt' ? 'vt' : 'x264' }
  // where the time goes, in ms over the whole export: waiting on the decode, uploading
  // and drawing, waiting on the readback and the encoder
  const ms = { decode: 0, draw: 0, encode: 0 }
  let lastTick = 0
  const drain = async () => {
    const t = performance.now()
    const buf = sink.buffer(); await rb.collect(buf, yieldNow); await sink.write(buf)
    ms.encode += performance.now() - t
  }
  try {
    for (let n = 0; n < spec.frames; n++) {
      if (hooks.cancelled && hooks.cancelled()) throw Object.assign(new Error('cancelled'), { cancelled: true })
      const fp = Plan.framePlan(spec, n / spec.fps)
      let f
      const t1 = performance.now()
      try { f = await screen.frameAt(n) } catch (e) {
        // A decode that fails before its first frame gets one retry in software:
        // VideoToolbox refuses a few codecs and sizes
        if (n > 0 || stats.decodeRetry) throw e
        stats.decodeRetry = true; screen.close(); screen = open(false); f = await screen.frameAt(n)
      }
      let camOn = false, cf = null
      if (cam) cf = await cam.frameAt(n)
      const t2 = performance.now()
      ms.decode += t2 - t1
      if (f && f.changed) { comp.uploadNV12('content', f.data, f.w, f.h, spec.src.h); stats.uploads++ }
      if (cam) {
        if (cf) { if (cf.changed) { comp.uploadNV12('cam', cf.data, cf.w, cf.h, camLines); stats.camUploads++ } camOn = true }
      }
      if (!comp.render(spec, fp, { n, cam: camOn })) throw new Error('no frame of the recording to draw')
      if (webcodecs) {
        comp.present()
        const t3 = performance.now()
        ms.draw += t3 - t2
        await sink.encode(n)
        ms.encode += performance.now() - t3
      } else {
        comp.pack()
        ms.draw += performance.now() - t2
        if (rb.full) await drain()
        rb.issue(n)
      }
      const now = performance.now()
      if (hooks.progress && now - lastTick > 200) { lastTick = now; hooks.progress(n, spec.frames) }
      // let the decode workers' messages in
      if ((n & 7) === 7) await yieldNow()
    }
    while (rb && rb.pending) await drain()
    await sink.end()
  } catch (e) {
    sink.kill()
    throw e
  } finally {
    screen.close(); if (cam) cam.close()
    if (rb) rb.destroy()
    comp.destroy()
  }
  stats.ms = Math.round(performance.now() - t0)
  stats.fps = +(spec.frames / (stats.ms / 1000)).toFixed(1)
  stats.decode = size.scale ? `${size.w}x${size.h} (scaled)` : `${size.w}x${size.h}`
  stats.stages = Object.fromEntries(Object.entries(ms).map(([k, v]) => [k, Math.round(v)]))
  return stats
}

module.exports = { renderVideo, decodeSize, camSquare, yieldNow, loadImage }
