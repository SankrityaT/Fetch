// The export loop, run in the hidden render window (ui/render-window.js): decode the
// frames the plan needs, draw each output frame with the compositor, pack it to NV12,
// read it back without stalling and hand it to the encoder. Sound is not here: the
// host renders it with ffmpeg alongside and muxes the two (ui/render-host.js).
'use strict'
const Plan = require('./plan')
const { Compositor, Readback, SLOTS } = require('./gl')
const { framePts, decodeArgs, FfmpegSource } = require('./sources')
const { encodeArgs, Nv12PipeSink, WebCodecsSink, writeStill } = require('./sinks')
const path = require('path')

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
 * The pictures a plan draws from files: the clean patches over the Mac's resting
 * pointer and Biscuit's badge. Loaded once per compositor; one that cannot be read is
 * left out (its patch falls back to the fill around it). Returns how many it loaded.
 */
async function loadAssets(comp, spec) {
  let n = 0
  const files = new Set()
  for (const e of (spec.marks && spec.marks.erase) || []) if (e.plate && e.plate.file) files.add(e.plate.file)
  await Promise.all([...files].filter(f => !comp.images.has(f)).map(f => loadImage(f)
    .then(img => { comp.setImage(f, img, true); n++ }).catch(e => console.warn(e.message))))
  // A touch take draws no badge: the disc is the mark and the finger does not sign its
  // work, so the picture is decoded and uploaded for nothing.
  if (spec.marks && spec.marks.pointer && !spec.marks.pointer.touch && !comp.imgEls.has('badge')) {
    const { BADGE } = require('../pointer')
    const file = [path.join(process.resourcesPath || '', 'app', BADGE.file), path.join(__dirname, '..', '..', BADGE.file)].find(f => require('fs').existsSync(f))
    if (file) { try { comp.imgEls.set('badge', await loadImage(file)); n++ } catch (e) { console.warn(e.message) } }
  }
  return n
}

/**
 * How big to decode the take. Decoding is cheap next to what it saves when a 5K take
 * goes to a 1080 frame, and scale_vt does it on the GPU before the download; a take
 * already near the size the deepest zoom needs is decoded as it is. share is how much
 * of the plan's own size the frame is drawn at, so a GIF at 640 wide does not pay to
 * decode 1080p and throw four fifths of it away.
 */
function decodeSize(spec, share = 1) {
  const deepest = Math.max(1, ...spec.zooms.map(z => +z.scale || 1))
  const need = spec.rect.w * share / spec.inner.w * deepest
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
 * What a GIF is drawn from. A GIF holds at most 256 colours, and neither the ground's
 * tooth nor the film's grain survives that: what a texture of one or two levels becomes
 * after quantising is a different dither pattern on every pixel of every frame, and a
 * frame that differs everywhere is a frame the GIF writer has to write out whole. The
 * texture is invisible in the file and multiplies it, so a GIF is drawn without it, and
 * the last pass's own dither goes for the same reason. Nothing else about the plan moves:
 * the frame, the device, the lift, the grade and the easing are all still drawn.
 */
const forGif = spec => ({ ...spec, grain: null, tooth: 0, dither: false })

/**
 * Render the picture of one export to job.out (video only).
 *   job    { spec, src, out, ffmpeg, quality, format, width }
 *   hooks  { progress(frame, total), pid(pid), cancelled() -> bool }
 * format is the container (mp4, mov, webm, gif); width draws the plan smaller than its
 * own size, which is how a GIF is delivered at 640 wide.
 */
async function renderVideo(job, hooks = {}) {
  const { spec, ffmpeg } = job
  const format = job.format || 'mp4'
  const draw = format === 'gif' ? forGif(spec) : spec
  // The plan is one plan at one size; a smaller frame is the same plan drawn at a share
  // of it (gl.js scales every placement by W / spec.W), as a contact sheet's stills are.
  const k = job.width ? Math.min(1, job.width / spec.W) : 1
  const outW = even(spec.W * k), outH = even(spec.H * k)
  const t0 = performance.now()
  const pid = hooks.pid || (() => {})
  const pts = await framePts(ffmpeg, job.src)
  if (!pts.length) throw new Error('the recording has no video frames')
  const map = Plan.screenFrames(spec, pts)
  const size = decodeSize(spec, k)
  const open = (m, hw) => new FfmpegSource(ffmpeg, decodeArgs(job.src, pts, m.runs, { crop: size.crop, scale: size.scale, hw }),
    m, size.w, size.h, { onPid: pid })
  let screen = open(map, true)
  // The other side of every dissolved cut: a second read of the same file, a few frames
  // at each boundary and nothing in between (plan.crossFrames), so the whole cost of a
  // crossfade is those frames decoded and those frames drawn twice.
  const xmap = spec.cut && spec.cut.kind === 'crossfade' ? Plan.crossFrames(spec, pts) : null
  let cross = xmap && xmap.runs.length ? open(xmap, true) : null

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

  const comp = new Compositor(outW, outH)
  if (spec.bg.kind === 'image') {
    try { comp.setImage(spec.bg.file, await loadImage(spec.bg.file)) } catch (e) { console.warn(e.message) }
  }
  await loadAssets(comp, spec)
  // The encoder: packed NV12 read back into ffmpeg, which is where the container's own
  // codec lives (sinks.js: x264 for MP4 and MOV, VP9 for WebM, a palette pass for GIF).
  // Same drawn frames either way. VideoToolbox (sink 'vt') or Chromium's encoder on the
  // canvas (sink 'webcodecs') when asked, for measuring; both are H.264 alone.
  const q = job.quality || 'balanced'
  const h264 = format === 'mp4' || format === 'mov'
  const webcodecs = h264 && job.sink === 'webcodecs' && await WebCodecsSink.supported(outW, outH, spec.fps)
  const rb = webcodecs ? null : new Readback(comp, 3)
  const codec = h264 && job.sink === 'vt' ? 'vt' : 'x264'
  const sink = webcodecs
    ? await new WebCodecsSink(ffmpeg, job.out, comp.canvas, outW, outH, spec.fps, { quality: q, onPid: pid }).open()
    : new Nv12PipeSink(ffmpeg, encodeArgs(job.out, outW, outH, spec.fps, { quality: q, W4: comp.packed.w * 4, codec, format }), rb.bytes, { onPid: pid })
  let stale = false
  const stats = { frames: spec.frames, format, size: `${outW}x${outH}`, uploads: 0, camUploads: 0, dissolved: 0, decodeRetry: false,
    sink: webcodecs ? 'webcodecs' : format === 'gif' ? 'gif' : format === 'webm' ? 'vp9' : codec }
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
      const fp = Plan.framePlan(draw, n / spec.fps)
      let f
      const t1 = performance.now()
      try { f = await screen.frameAt(n) } catch (e) {
        // A decode that fails before its first frame gets one retry in software:
        // VideoToolbox refuses a few codecs and sizes
        if (n > 0 || stats.decodeRetry) throw e
        stats.decodeRetry = true; screen.close(); screen = open(map, false); f = await screen.frameAt(n)
        // the far side of every dissolve reads the same file with the same decoder, so
        // it comes back in software too rather than dying at the first crossfade
        if (cross) { cross.close(); cross = open(xmap, false) }
      }
      let camOn = false, cf = null
      if (cam) cf = await cam.frameAt(n)
      const t2 = performance.now()
      ms.decode += t2 - t1
      // the slot holds the far side of the last dissolve, so this frame uploads again
      // even where the take's own frame did not change
      if (f && (f.changed || stale)) { comp.uploadNV12('content', f.data, f.w, f.h, spec.src.h); stats.uploads++; stale = false }
      if (cam) {
        if (cf) { if (cf.changed) { comp.uploadNV12('cam', cf.data, cf.w, cf.h, camLines); stats.camUploads++ } camOn = true }
      }
      let xf = null
      if (cross && fp.mix > 0) {
        try { xf = await cross.frameAt(n) } catch (e) {
          // and its own one-shot fallback, since the first dissolve can be a long way
          // into a take that opened and decoded happily up to here
          if (stats.decodeRetry) throw e
          stats.decodeRetry = true; cross.close(); cross = open(xmap, false); xf = await cross.frameAt(n)
        }
      }
      if (!comp.render(draw, fp, { n, cam: camOn, side: xf ? 'a' : null })) throw new Error('no frame of the recording to draw')
      if (xf) {
        comp.uploadNV12('content', xf.data, xf.w, xf.h, spec.src.h); stats.uploads++; stale = true
        comp.render(draw, fp, { n, cam: camOn, side: 'b' })
        stats.dissolved++
      }
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
    screen.close(); if (cross) cross.close(); if (cam) cam.close()
    if (rb) rb.destroy()
    comp.destroy()
  }
  stats.ms = Math.round(performance.now() - t0)
  stats.fps = +(spec.frames / (stats.ms / 1000)).toFixed(1)
  stats.decode = size.scale ? `${size.w}x${size.h} (scaled)` : `${size.w}x${size.h}`
  stats.stages = Object.fromEntries(Object.entries(ms).map(([k, v]) => [k, Math.round(v)]))
  return stats
}

// ---- a still -------------------------------------------------------------
// A screenshot is a take of one frame. Everything below draws it with the passes that
// draw a frame of video, off the same plan, in the same compositor: there is no second
// renderer and no second look pipeline, and the only thing that differs from an export
// is where the content texture comes from. A recording arrives as NV12 out of ffmpeg; a
// captured picture arrives the way the editor's own <video> arrives, through
// uploadImage with the crop carried in cropUV. Both land in the same slot and every
// pass after that is the pass an export runs.

// What a shot is drawn at. A plan is one plan at one size (1920 wide, or 1280 at 720),
// and a bigger still is that same plan drawn at a multiple of it: gl.js scales every
// placement by W / spec.W, so twice the pixels is the same picture drawn larger and not
// a second layout. Nothing here is enlarged into its pixels, so the multiple does not
// have to be a whole number any more than a preview's width does.
//
// Scale means something else here than it does for a clip. For video an output size is a
// choice about a player and a file, and 1920 is the answer for nearly everyone. For a
// still it is the whole of what the picture is worth: a screenshot is read close, at 100
// percent, on a display with two or three pixels to the point. A plan is 1920 wide
// whatever the capture was, so a 2x or 3x capture drawn into it is not a smaller picture,
// it is the small text and the hairlines gone, permanently, in the deliverable.
//
// So the default is the capture at its own size, exactly: the multiple that makes one
// output pixel out of one captured pixel, whatever number that is. The named sizes stay
// for a caller who wants a round one, and they are what a person means by 1x, 2x and 3x:
//
//   1x  1920 wide. A thumbnail, a changelog, or a capture that was never dense.
//   2x  3840 wide. Where a 2x capture of an ordinary window lands about 1:1 (a 1710
//       point window is 3420 pixels and the take's box inside a framed 2x plan is about
//       2900 of them).
//   3x  5760 wide. A 5K or 6K capture at 1:1, and the size an app store asks for.
//
// 3x is also the ceiling for the default, before the GPU's own. Past it the file grows
// faster than anybody's use for it, and the only thing that asks for more is one very
// dense capture drawn small inside a group, where 1:1 on that member was never the point
// of the picture.
const SHOT_SCALES = [1, 2, 3]

// When an exact multiple is snapped to a named one. Measured on a 3420 px capture through
// the plain plan: 5 percent of minifying costs the capture's own text 3 of its 213 levels
// of contrast and none of its edges, which nobody can see, where 1x on that capture (2.07
// of them to each output pixel) costs 48 levels and half its edges. So inside 5 percent a
// round number is worth having, and outside it the exact one is.
const SHOT_SOFT = 0.05

/**
 * What a shot is drawn at, as a multiple of the plan's own size. 'native' (the default)
 * is the capture at 1:1: the take's box is rect.w plan pixels wide and the capture has
 * crop.w to fill it with, so that ratio is the multiple, snapped to a named size when it
 * is within a few percent of one and held between 1 (the plan's own size, which is what
 * Fetch's own furniture is drawn for) and 3. A caller who asks gets a named size.
 *
 * max is the GPU's texture ceiling, read off the live context by the caller, so a machine
 * with a small one gets a smaller still rather than a failed draw.
 */
function shotScale(spec, want = 'native', max = 16384) {
  const top = SHOT_SCALES[SHOT_SCALES.length - 1]
  const ratio = shotDensity(spec)
  const native = SHOT_SCALES.find(k => Math.abs(ratio / k - 1) <= SHOT_SOFT) || ratio
  const asked = want === 'native' || want == null ? native : Math.round(+want) || native
  const cap = max / Math.max(spec.W, spec.H)
  return Math.max(1, Math.min(top, asked, cap))
}

/**
 * How many capture pixels the plan asks each of its own pixels to carry, across the
 * take's own box. 1 is the capture at its own size; over 1 is capture being thrown away.
 * Divided by the scale, it is what the finished file actually did with the capture.
 *
 * A group is as dense as its densest member, not its least dense. k multiplies the whole
 * plan, so it cannot change how far one member is stretched against another: the layout
 * is in millimetres and a low density capture is enlarged at every k alike. All the
 * choice decides is how many pixels the set is given, and the member with the most to
 * give is the one that decides it.
 */
function shotDensity(spec) {
  const dens = b => (b.rect && b.rect.w > 0 ? b.crop.w / b.rect.w : 1)
  return spec.group && spec.group.length ? Math.max(...spec.group.map(dens)) : dens(spec)
}

/**
 * One finished screenshot: the plan drawn once, at full size, and written as a picture.
 *   job  { spec, image, out, format, quality, scale, width, at }
 * image is the captured picture, and the plan must have been made from its own size.
 * scale is 1, 2, 3 or 'native' (the default); width instead draws the plan at an exact
 * pixel width, which is how a thumbnail and the harness's goldens ask for one. at is the
 * output second to draw, and defaults to the middle of the shot's own span, where every
 * arrival has landed and nothing has begun to leave.
 */
async function renderShot(job, hooks = {}) {
  const { spec } = job
  const t0 = performance.now()
  // One capture fills one slot; a group fills one per member, each from its own file.
  // A group of one is a take, and is this list with one entry in it.
  const want = spec.group ? spec.group.map(m => ({ file: m.file, size: m.src }))
    : [{ file: job.image, size: spec.src }]
  const imgs = []
  for (const q of want) {
    const img = await loadImage(q.file)
    // The plan's crop, its rect and the marks fitted to it are all in the capture's own
    // pixels, so a plan made from a different picture would place every one of them
    // somewhere else. Said here rather than drawn wrong.
    if (img.width !== q.size.w || img.height !== q.size.h) {
      throw new Error(`the plan is for a ${q.size.w}x${q.size.h} picture and this one is ${img.width}x${img.height}`)
    }
    imgs.push(img)
  }
  // Built at the plan's own size so the live context can be asked for its ceiling, then
  // resized to what the shot is actually drawn at
  const comp = new Compositor(spec.W, spec.H, { preserve: true })
  try {
    // A store deliverable is a pair of integers, not a width and a shape. The plan is
    // already composed at the preset's own ratio (ui/sizes.js, through backdropAspect),
    // so this is the last rounding and it is the one that has to land on the number: a
    // file one pixel short of 1320 x 2868 is rejected at upload, after the writing, the
    // shooting and the styling are all done. Scaling by a width instead left the height
    // a pixel out on every preset but the one that divides evenly.
    const k = job.size ? job.size.w / spec.W
      : job.width ? Math.max(0.02, job.width / spec.W)
        : shotScale(spec, job.scale, comp.gl.getParameter(comp.gl.MAX_TEXTURE_SIZE))
    if (job.size) comp.resize(job.size.w, job.size.h)
    else comp.resize(spec.W * k, spec.H * k)
    if (spec.bg.kind === 'image') {
      try { comp.setImage(spec.bg.file, await loadImage(spec.bg.file)) } catch (e) { console.warn(e.message) }
    }
    await loadAssets(comp, spec)
    // The whole picture into the content slot and the crop carried in cropUV, which is
    // the path the editor's stage takes with its <video>. The export's path crops in the
    // decoder instead and hands the slot a cropped frame; parity holds the two to within
    // a level, so a still drawn this way is the frame the export would have drawn.
    // One slot per member, in the order the plan laid the group out.
    for (let i = 0; i < imgs.length; i++) comp.uploadImage(SLOTS[i], imgs[i], imgs[i].width, imgs[i].height)
    // A group's members each carry their own crop on the plan, because a capture knows
    // its own; one capture carries it here instead.
    const s = spec.src
    const cropUV = spec.group ? null : [spec.crop.x / s.w, spec.crop.y / s.h, spec.crop.w / s.w, spec.crop.h / s.h]
    const at = job.at == null ? spec.span / 2 : Math.max(0, Math.min(spec.span, +job.at))
    const n = Math.max(0, Math.min(spec.frames - 1, Math.round(at * spec.fps)))
    const fp = Plan.framePlan(spec, n / spec.fps)
    if (hooks.progress) hooks.progress(0, 1)
    if (!comp.render(spec, fp, { n, ...(cropUV ? { cropUV } : {}) })) throw new Error('no picture to draw')
    const out = await writeStill(job.out, comp.readRGBA(), comp.W, comp.H,
      { format: job.format || 'png', ...(job.quality != null ? { quality: +job.quality } : {}) })
    if (hooks.progress) hooks.progress(1, 1)
    // density says what the file did with the capture, which is the one number that
    // decides whether a screenshot is a deliverable or a preview: 1 is the capture at
    // its own size, and over 1 is that much of it thrown away.
    return { ...out, scale: +k.toFixed(2), at: +(n / spec.fps).toFixed(3), source: { w: s.w, h: s.h },
      plan: `${spec.W}x${spec.H}`, density: +(shotDensity(spec) / k).toFixed(2),
      ms: Math.round(performance.now() - t0) }
  } finally {
    comp.destroy()
  }
}

/**
 * Single frames of an edit, drawn exactly as the export draws them (preview_frame, and
 * for looking at a pass): each output time's source frame decoded on its own, drawn,
 * read back and written as a picture.
 *   job  { spec, src, ffmpeg, times: [output seconds], files: [paths], width, type }
 * type is 'image/jpeg' (default) or 'image/png'; width shrinks the frame (the plan is
 * drawn at that size, as the editor's stage draws below export size).
 *
 * A job carrying an image instead of a recording is a shot, and goes to renderShot: the
 * render window routes every still job here (ui/render-window.js), and which source the
 * frame comes from is this module's business rather than that one's.
 */
async function renderStills(job, hooks = {}) {
  if (job.image) return renderShot(job, hooks)
  const { spec, ffmpeg } = job
  const t0 = performance.now()
  const pid = hooks.pid || (() => {})
  const pts = await framePts(ffmpeg, job.src)
  if (!pts.length) throw new Error('the recording has no video frames')
  const map = Plan.screenFrames(spec, pts)
  const size = decodeSize(spec)
  const k = job.width ? Math.min(1, job.width / spec.W) : 1
  const comp = new Compositor(spec.W * k, spec.H * k, { preserve: true })
  const out = []
  try {
    if (spec.bg.kind === 'image') {
      try { comp.setImage(spec.bg.file, await loadImage(spec.bg.file)) } catch (e) { console.warn(e.message) }
    }
    await loadAssets(comp, spec)
    let cpts = null, cmap = null, csq = null
    if (spec.cam) {
      try { cpts = await framePts(ffmpeg, spec.cam.file); cmap = Plan.cameraFrames(spec, cpts); csq = camSquare(cpts.size, spec.cam.d) } catch { cpts = null }
    }
    const one = async (file, i, args, w, h) => {
      const src = new FfmpegSource(ffmpeg, args, { pick: Int32Array.from([i]), runs: [[i, i]] }, w, h, { onPid: pid })
      try { return await src.frameAt(0) } finally { src.close() }
    }
    for (let j = 0; j < job.times.length; j++) {
      const n = Math.max(0, Math.min(spec.frames - 1, Math.round(job.times[j] * spec.fps)))
      const i = map.pick[n]
      if (i < 0) throw new Error('no frame of the recording at ' + job.times[j])
      const td = performance.now()
      const f = await one(job.src, i, decodeArgs(job.src, pts, [[i, i]], { crop: size.crop, scale: size.scale, hw: true, frames: 1 }), size.w, size.h)
      if (process.env.FETCH_DEBUG_RENDER) console.log(`decode ${Math.round(performance.now() - td)} ms`)
      if (!f) throw new Error('could not decode the frame at ' + job.times[j])
      comp.uploadNV12('content', new Uint8Array(f.data), f.w, f.h, spec.src.h)
      let cam = false
      if (cpts && cmap.pick[n] >= 0) {
        const ci = cmap.pick[n]
        const cf = await one(spec.cam.file, ci, decodeArgs(spec.cam.file, cpts, [[ci, ci]], { crop: csq.crop, cover: csq.cover, hw: true, frames: 1 }), csq.side, csq.side)
        if (cf) { comp.uploadNV12('cam', new Uint8Array(cf.data), cf.w, cf.h, cpts.size ? cpts.size[1] : 1080); cam = true }
      }
      const fp = Plan.framePlan(spec, n / spec.fps)
      // A still that lands inside a dissolve is that dissolve, or a preview of a cut
      // would not be the frame the file holds. Its far side is decoded before either
      // draw, and where that decode comes back with nothing the frame is drawn once
      // from the near side alone (gl.js render, src.side): this Compositor is kept
      // between the stills of one job, so a draw that writes nothing to the output
      // would hand back the picture before it.
      const xi = fp.mix > 0 ? Plan.crossFrames(spec, pts).pick[n] : -1
      const xf = xi >= 0
        ? await one(job.src, xi, decodeArgs(job.src, pts, [[xi, xi]], { crop: size.crop, scale: size.scale, hw: true, frames: 1 }), size.w, size.h)
        : null
      if (!comp.render(spec, fp, { n, cam, side: xf ? 'a' : null })) throw new Error('no frame of the recording to draw')
      if (xf) {
        comp.uploadNV12('content', new Uint8Array(xf.data), xf.w, xf.h, spec.src.h)
        comp.render(spec, fp, { n, cam, side: 'b' })
      }
      // the same writer a finished screenshot goes out through, so a preview frame and a
      // shot of the same plan are the same file in the same format
      await writeStill(job.files[j], comp.readRGBA(), comp.W, comp.H,
        { format: job.type === 'image/png' ? 'png' : 'jpg', quality: 0.9 })
      out.push({ file: job.files[j], at: +(n / spec.fps).toFixed(3), source: i })
      if (process.env.FETCH_DEBUG_RENDER) console.log(`still ${j} at ${job.times[j]}: ${Math.round(performance.now() - t0)} ms`)
    }
  } finally {
    comp.destroy()
  }
  return out
}

module.exports = { renderVideo, renderStills, renderShot, shotScale, shotDensity, SHOT_SCALES, decodeSize, camSquare, yieldNow, loadImage, loadAssets }
