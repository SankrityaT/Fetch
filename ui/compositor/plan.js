// The compositor's plan: everything a frame of an edit needs, as plain numbers.
//
// prepare() reads an edit (the options bag toExportOpts makes, the same one the classic
// export takes) once per render and fixes the output's size, the framed take's place,
// the background, the zooms on the output clock, the camera bubble and the fades.
// framePlan() then answers for one output time: which moment of the take, what the
// zoom shows (and where it was half a shutter either side, for motion blur), how far a
// fade has gone, which camera moment. The editor's canvas and the export both draw from
// these two functions, so the stage and the file cannot disagree about a frame.
//
// No frame depends on the one before it: any frame can be drawn alone, in any order.
//
// Pure: no Electron, no filesystem, no DOM (test/plan.test.js).

const Timeline = require('../timeline')
const Layout = require('./layout')
const Overlays = require('../overlays')
const Marks = require('./marks')
const Text = require('./text')
const { GRADIENTS, MESHES } = require('../look-schema')

const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
const num = (v, d) => (v != null && Number.isFinite(+v) ? +v : d)

// '#F0A93C' or '0xF0A93C' to [r, g, b] in 0..1
function rgb(hex) {
  const m = /^(?:#|0x)?([0-9a-f]{6})$/i.exec(String(hex || ''))
  if (!m) return [0.1, 0.09, 0.08]
  return [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16) / 255)
}

// ── which renderer ──────────────────────────────────────────────────────
// The compositor draws everything an edit places (M3): the framed look, zooms, fades,
// cuts, the camera, marks, lifts and spotlights, steps, the agent's cursor, the Mac's
// pointer lifted out, captions, titles, labels and auto zoom (its moments worked out by
// prepare.js). Other formats than MP4 and MOV go to the classic renderer whole.
const GL_FORMATS = new Set(['mp4', 'mov'])
function unsupported(opts = {}, ctx = {}) {
  const why = []
  const fmt = opts.format || 'mp4'
  if (!GL_FORMATS.has(fmt)) why.push(`${fmt} output`)
  if (opts.still != null) why.push('a still frame')
  return why
}

/**
 * The engine for an export: { engine: 'gl' | 'classic', why }. mode is auto (the
 * compositor when it draws everything the edit uses), gl (forced: what it cannot draw
 * yet is left out, and why says what) or classic.
 */
function engineFor(opts, ctx = {}, mode = 'auto') {
  const why = unsupported(opts, ctx)
  if (mode === 'classic') return { engine: 'classic', why: ['classic requested'] }
  if (mode === 'gl') return { engine: why.includes(`${opts.format || 'mp4'} output`) ? 'classic' : 'gl', why }
  return { engine: why.length ? 'classic' : 'gl', why }
}

// The marks to draw: each lift, spotlight and step as prepare.js fitted it to the take
// (held to its element, its box grown to the element's edge, its corner measured, a
// step on its card's corner) when that was worked out for this very mark, else as the
// edit has it. A mark edited since is drawn as it now is until it is read again.
const markKey = m => [m.kind, m.start, m.end, m.x, m.y, m.w, m.h, m.n].join('|')
function markList(marks, fitted) {
  const byKey = new Map((fitted || []).filter(m => m && m.k0).map(m => [m.k0, m]))
  return (marks || []).filter(Boolean).map(m => byKey.get(markKey(m)) || m)
}

// ── the plan ────────────────────────────────────────────────────────────
/**
 * The fixed part of a render.
 *   opts  toExportOpts' bag (start, end, cuts, crop, zooms, backdrop, backdropAspect,
 *         inset, radius, shadow, scale, camera, fadeIn, fadeOut, look)
 *   meta  { width, height, duration, fps } of the take
 *   ctx   { gutter } the window's own margin (processor.frameGutter), { imageFile }
 *         the image backdrop's file, { fps } to override the output rate, { prepared }
 *         what the take's pixels say (prepare.js): fitted marks, the Mac's pointer,
 *         the agent's cursor, caption timings
 */
function prepare(opts = {}, meta = {}, ctx = {}) {
  const srcW = meta.width || 1920, srcH = meta.height || 1080
  const dur = meta.duration || 0
  const fps = ctx.fps || Timeline.outFps(meta)
  const start = Math.max(0, +opts.start || 0)
  const end = opts.end && opts.end > start ? Math.min(opts.end, dur || opts.end) : dur
  const clock = Timeline.outClock(opts.cuts, start, end)
  const keep = clock.keep
  const span = Timeline.outLength(keep)
  const frames = Math.max(1, Math.round(span * fps))

  // The crop as the classic export's ffmpeg crop takes it: even size, and an offset
  // rounded down to even for 4:2:0 chroma. Even with no crop, so NV12 always fits.
  const c = opts.crop && opts.crop.w > 0 && opts.crop.h > 0 ? opts.crop : null
  const cw = c ? 2 * Math.floor(srcW * c.w / 2) : srcW & ~1
  const ch = c ? 2 * Math.floor(srcH * c.h / 2) : srcH & ~1
  const cx = c ? Math.min(srcW - cw, Math.floor(srcW * c.x) & ~1) : 0
  const cy = c ? Math.min(srcH - ch, Math.floor(srcH * c.y) & ~1) : 0

  const look = opts.look || {}
  const L = sec => look[sec] || {}
  const framed = !!opts.backdrop
  const aspect = +opts.backdropAspect || null
  // Burned captions under a framed take get a band of their own below it, as the classic
  // export and the editor's layers lay them out; without it the stage's canvas drew the
  // take where the caption sits. ctx.cues overrides the count (0: none drawn here).
  const cst = opts.captionStyle || {}
  const P = ctx.prepared || null
  const cues = ctx.cues != null ? ctx.cues
    : (opts.cues || []).length || (P && P.captions && (P.captions.cues || []).length) || 0
  const band = framed && opts.captions && cues > 0 && (!cst.position || cst.position === 'bottom') && cst.fx == null
    ? Overlays.CAP_BAND : 0
  const g = framed
    ? Layout.backdropGeometry(cw, ch, { inset: opts.inset, radius: opts.radius, scale: opts.scale, band,
      outWidth: opts.scale === 720 ? 1280 : 1920, outAspect: aspect })
    : Layout.plainGeometry(cw, ch, { outAspect: aspect, scale: opts.scale })

  // never tighter than the window's own rounded corner, or its black corner shows
  const gut = framed && ctx.gutter ? ctx.gutter : null
  const corner = gut && gut.corner ? Math.ceil(gut.corner * g.vidW * 1.45) + 2 : 0
  const radius = framed ? Math.max(g.radius, corner) : 0

  // The window's own margin trimmed off inside the frame, covered to the frame's shape,
  // as the classic export does after its zoom: fractions of what the zoom shows.
  let inner = { x: 0, y: 0, w: 1, h: 1 }
  if (gut && (gut.l || gut.t || gut.r || gut.b)) {
    const gw = 1 - gut.l - gut.r, gh = 1 - gut.t - gut.b
    inner = gw > gh
      ? { x: gut.l + (gw - gh) / 2, y: gut.t, w: gh, h: gh }
      : { x: gut.l, y: gut.t + (gh - gw) / 2, w: gw, h: gw }
    // the frame is the crop's shape, so equal fractions keep it; correct for the rest
    const want = (g.vidW / g.vidH) / (cw / ch)
    if (want > 1) inner.h /= want; else inner.w *= want
  }

  // The classic shadow is the frame's shape blurred by boxblur radius r, power 2: a
  // Gaussian of that variance, hanging 0.9 r low.
  const r = g.blur
  const shadow = framed ? {
    alpha: clamp(num(opts.shadow, 0.6), 0, 1),
    sigma: Math.sqrt((4 * r * r + 4 * r) / 6),
    dy: Math.round(r * 0.9),
  } : null
  const borderPx = framed ? num(L('frame').border, 0) * g.outH / 1080 : 0

  // What fills the output round the take
  let bg = { kind: 'none' }
  const id = String(opts.backdrop || '')
  const blurFill = () => {
    // The take, blurred to a colour field, as the classic export makes it: shrunk to a
    // few dozen pixels, blurred about 125 px wide at 1080, luma pressed to 30 percent,
    // chroma to 80, a soft vignette. blurAmount 0.5 is exactly that.
    const fw = 2 * Math.max(8, Math.round(g.outW / 64)), fh = 2 * Math.max(5, Math.round(g.outH / 64))
    const amount = clamp(num(L('background').blurAmount, 0.5), 0, 1)
    return { kind: 'blur', fw, fh, sigma: Math.max(2, 125 * fh / 1080) * (0.25 + 1.5 * amount) }
  }
  // Bokeh is the background's own defocus given an aperture's shape, so it rides on the
  // background rather than on the finished frame: an image backdrop or the take's own
  // blurred ground. A gradient, a mesh or no background has nothing to defocus.
  const bokehDial = clamp(num(L('treatment').bokeh, 0), 0, 1)
  if (!framed) bg = aspect ? blurFill() : { kind: 'none' }
  else if (id === 'blur') bg = blurFill()
  else if (id.startsWith('img:') && ctx.imageFile) {
    const B = L('background')
    bg = { kind: 'image', file: ctx.imageFile, blur: clamp(num(B.imageBlur, 0), 0, 1), dim: clamp(num(B.imageDim, 0), 0, 1) }
  } else if (L('background').kind === 'mesh') {
    // A mesh gradient: its control points as plain numbers, drawn once per plan like
    // the still gradient is. Colours stay in sRGB, as the flat gradient's do.
    const pts = (MESHES[L('background').mesh] || MESHES.dusk).slice(0, 8)   // FS_MESH carries eight
    bg = { kind: 'mesh', p: pts.flatMap(q => [q[0], q[1], q[2]]), c: pts.flatMap(q => rgb(q[3])) }
  } else if (/^color:#?[0-9a-f]{6}$/i.test(id)) {
    const col = rgb(id.slice(6).replace('#', ''))
    bg = { kind: 'gradient', c0: col, c1: col }
  } else {
    const pair = GRADIENTS[id] || GRADIENTS.dusk
    bg = { kind: 'gradient', c0: rgb(pair[0]), c1: rgb(pair[1]) }
  }
  if (bokehDial > 0 && (bg.kind === 'image' || bg.kind === 'blur')) bg.bokeh = bokehDial

  // Zooms on the output clock, as the classic export places them; with auto zoom and
  // none of its own, the moments prepare.js found (already on the output clock)
  let zooms = (opts.zooms || []).filter(z => z && +z.end > +z.start)
    .map(z => ({ start: clock(z.start), end: clock(z.end), scale: z.scale, x: z.x, y: z.y }))
    .filter(z => z.end > z.start)
  if (!zooms.length && opts.autoZoom && P && Array.isArray(P.autoZooms)) zooms = P.autoZooms.filter(z => z && z.end > z.start)

  // The camera bubble, over the framed take in its own fractions, as the editor places
  // it: never zoomed with the content, never outside the take.
  let cam = null
  const k = opts.camera
  if (k && k.file && k.on !== false) {
    const d = 2 * Math.round(Math.max(24, clamp(num(k.size, 0.22), 0.05, 0.6) * g.vidW) / 2)
    const cxp = clamp(g.ox + num(k.x, 0.82) * g.vidW, g.ox + d / 2, g.ox + g.vidW - d / 2)
    const cyp = clamp(g.oy + num(k.y, 0.78) * g.vidH, g.oy + d / 2, g.oy + g.vidH - d / 2)
    const C = L('camera')
    cam = {
      file: k.file, x: cxp - d / 2, y: cyp - d / 2, d,
      round: C.shape === 'rounded' ? d * 0.22 : d / 2,
      ring: C.ring === false ? 0 : Math.max(2, Math.round(d * 0.016)),
      camStartedAt: k.camStartedAt, screenStartedAt: k.screenStartedAt, gaps: k.gaps || [],
    }
  }

  // What is drawn on the recording itself, placed once: sizes for the finished frame
  // from px, the finished pixels per content pixel before any zoom
  const px = g.vidH / (ch * inner.h)
  const drawn = markList(opts.marks, P && P.marks)
  const F = L('focus'), Cu = L('cursor')
  const pm = Marks.planMarks(drawn, { W: cw, H: ch, px, clock, span, zooms, look: { dim: F.dim, lift: F.lift } })
  const erase = P && P.erase ? Marks.planErase(P.erase.spans, P.erase.plates,
    { src: { w: srcW, h: srcH }, crop: { x: cx, y: cy }, content: { w: cw, h: ch }, clock, end, span }) : []
  // an empty track is the look's cursor switched off, whatever the take has
  const raw = Array.isArray(opts.pointer) ? opts.pointer : null
  const points = raw && !raw.length ? null : P && P.pointer ? P.pointer.points : raw
  const pointer = points ? Marks.planPointer(points, { W: cw, H: ch, clock, crop: c, scale: P && P.pointer ? P.pointer.scale : null,
    span, px, zooms: pm.zooms, size: Cu.size, ripple: Cu.ripple }) : null
  const marks = { ...pm, erase, pointer }
  // Treatment: the grade and the lens over the finished frame, as plain numbers in
  // export pixels. Null while the look asks for none of it, so the pass is skipped and
  // a default look draws what it drew before treatment existed.
  const T = L('treatment')
  const lv = T.autoLevel && P && P.levels && P.levels.hi > P.levels.lo ? [P.levels.lo, P.levels.hi] : null
  const bright = clamp(num(T.brightness, 0), -1, 1)
  const contrast = clamp(num(T.contrast, 0), -1, 1)
  const sat = clamp(num(T.saturation, 0), -1, 1)
  const tintAmount = clamp(num(T.tintAmount, 0), 0, 1)
  const haze = clamp(num(T.haze, 0), 0, 1)
  const vignette = clamp(num(T.vignette, 0), 0, 1)
  const soft = clamp(num(T.blur, 0), 0, 1)
  const bloom = clamp(num(T.bloom, 0), 0, 1)
  const halation = clamp(num(T.halation, 0), 0, 1)
  const aberration = clamp(num(T.aberration, 0), 0, 1)
  const glow = Math.max(bloom, halation)
  const treat = lv || bright || contrast || sat || tintAmount || haze || vignette || soft || glow || aberration ? {
    level: lv,
    // the dials ffmpeg eq takes: 1 is neutral for contrast and saturation, brightness adds
    bright, contrast: 1 + contrast, sat: 1 + sat,
    tint: rgb(T.tint || '#F0A93C'), tintAmount, haze, vignette,
    // the whole frame softened: sigma in export pixels, about 26 of them at 1080 at full
    blur: soft * 0.024 * g.outH,
    bloom, halation,
    // One dial, so it has to move the threshold as well as the strength: a light touch
    // of bloom should only catch what is nearly white, and a heavy one should catch the
    // bright half of the picture. Bloom and halation share the bright pass, so the
    // louder of the two sets it.
    glowThresh: 0.9 - 0.45 * glow,
    // Aberration: how far the channels part at the corners, in export pixels. 3 px at
    // 1080 at the top of the dial, so the settings anyone will actually use are a
    // fraction of a pixel and read as a fringe on an edge, not as three pictures.
    aberration: aberration * 3 * g.outH / 1080,
  } : null
  const film = clamp(num(L('grain').film, 0), 0, 1)

  const text = Text.planText(opts, { clock, span, W: g.outW, H: g.outH, box: framed ? { x: g.ox, y: g.oy, w: g.vidW, h: g.vidH } : null,
    prepared: P, zooms: pm.zooms })

  return {
    W: g.outW, H: g.outH, fps, frames, span, keep, start, end,
    src: { w: srcW, h: srcH }, crop: { x: cx, y: cy, w: cw, h: ch },
    content: { w: cw, h: ch, px },
    framed, rect: { x: g.ox, y: g.oy, w: g.vidW, h: g.vidH }, radius, shadow, inner,
    border: borderPx > 0 ? { px: borderPx, color: rgb(L('frame').borderColor || '#FFFFFF') } : null,
    bg, zooms: pm.zooms, cam, marks,
    text: text.phrases.length || text.cards.length || text.labels.length ? text : null,
    motionBlur: clamp(num(T.motionBlur, 0), 0, 1),
    treat,
    // Film grain: its strength, and a cell sized on the output so a look grains the
    // same at 720p and at 4K. 0.055 at full is a little over three times the still
    // grain the classic blur ground carries (noise=c0s=3), which is what a moving
    // grain needs to read at all without eating the text under it.
    grain: film > 0 ? { amp: film * 0.055, cell: Math.max(1, g.outH * 1.4 / 1080) } : null,
    fadeIn: Math.max(0, num(opts.fadeIn, 0)), fadeOut: Math.max(0, num(opts.fadeOut, 0)),
    dither: L('grain').dither !== false,
  }
}

// The take's time output time t shows. Ranges are half open here: the frame at the
// instant a cut closes shows the moment after the cut, not the last moment before it
// (Timeline.srcTime keeps range ends inclusive for its round trip).
function srcAt(keep, t) {
  let acc = 0
  for (let i = 0; i < keep.length; i++) {
    const [a, b] = keep[i], len = b - a
    if (t < acc + len - 1e-9 || i === keep.length - 1) return Math.min(b, a + Math.max(0, t - acc))
    acc += len
  }
  return t
}

// What a zoom shows at output time t, as fractions of the cropped frame
function viewAt(spec, t) {
  const z = Overlays.zoomView(spec.zooms, t)
  return [z.x, z.y, z.w, z.h]
}

// How far a pixel of content travels on the output between two views
function travel(spec, a, b) {
  const { w, h } = spec.rect
  let most = 0
  for (const u of [0, 1]) for (const v of [0, 1]) {
    // the content under this corner of the frame in view a, and where view b puts it
    const px = a[0] + u * a[2], py = a[1] + v * a[3]
    const dx = ((px - b[0]) / b[2] - u) * w, dy = ((py - b[1]) / b[3] - v) * h
    most = Math.max(most, Math.hypot(dx, dy))
  }
  return most
}

/**
 * One output frame, at output time t (seconds): { t, s, view0, view1, taps, fade, camT }.
 * s is the take's own time the frame shows. view0 and view1 bound the zoom's travel
 * across the shutter; taps is how many samples blur it, scaled with how far a pixel
 * moves so a fast glide never shows separate ghost copies of text.
 */
function framePlan(spec, t) {
  const s = srcAt(spec.keep, t)
  let view0 = viewAt(spec, t), view1 = view0, taps = 1
  if (spec.motionBlur > 0 && spec.zooms.length) {
    // motionBlur 1 is a 360 degree shutter, 0.5 the film standard 180
    const half = spec.motionBlur / spec.fps / 2
    const a = viewAt(spec, t - half), b = viewAt(spec, t + half)
    const px = travel(spec, a, b)
    if (px > 0.75) { view0 = a; view1 = b; taps = Math.max(2, Math.min(32, Math.ceil(px / 1.5))) }
  }
  const fi = spec.fadeIn > 0 ? clamp(t / spec.fadeIn, 0, 1) : 1
  const fo = spec.fadeOut > 0 ? clamp((spec.span - t) / spec.fadeOut, 0, 1) : 1
  const camT = spec.cam ? Timeline.camTime(spec.cam, s) : null
  return { t, s, view0, view1, taps, fade: fi * fo, camT,
    marks: spec.marks ? Marks.at(spec.marks, t) : null, move: Text.frameMove(spec.text, t, spec.H) }
}

// ── which source frames ─────────────────────────────────────────────────
// The last frame at or before u in a sorted list of presentation times, or 0
function holdIndex(pts, u) {
  if (!pts.length || u < pts[0]) return 0
  let lo = 0, hi = pts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (pts[mid] <= u + 1e-6) lo = mid; else hi = mid - 1
  }
  return lo
}

/**
 * The frames of a stream an export reads, sample and hold: output frame n shows the
 * latest frame whose time is at or before the moment it maps to (the spike's rule, 200
 * of 200 on a jittered variable-rate counter). A native take writes a frame only when
 * the screen changes, so this is what keeps a still screen still and the picture on
 * the sound's clock across cuts.
 *   pts     the stream's presentation times, sorted, seconds
 *   timeOf  output time to the stream's time, or null where it shows nothing
 * Returns { pick: index per output frame (-1 none), runs: [[i0, i1]] index ranges to
 * decode, in order }. Frames between two needed ones closer than `gap` are decoded and
 * skipped rather than starting a new range, and there are never more than maxRuns
 * ranges: each is a term of ffmpeg's select expression, whose parser gives up between
 * 100 and 150 (an edit with dead air removed can have that many cuts).
 */
function frameMap(pts, frames, timeOf, gap = 12, maxRuns = 64) {
  const pick = new Int32Array(frames).fill(-1)
  for (let n = 0; n < frames; n++) {
    const u = timeOf(n)
    if (u != null) pick[n] = holdIndex(pts, u)
  }
  const used = [...new Set(pick)].filter(i => i >= 0).sort((a, b) => a - b)
  const runs = []
  for (const i of used) {
    const last = runs[runs.length - 1]
    if (last && i - last[1] <= gap) last[1] = i
    else runs.push([i, i])
  }
  // too many: join the two runs with the fewest frames between them, and again
  while (runs.length > maxRuns) {
    let best = 1
    for (let k = 2; k < runs.length; k++) if (runs[k][0] - runs[k - 1][1] < runs[best][0] - runs[best - 1][1]) best = k
    runs[best - 1][1] = runs[best][1]
    runs.splice(best, 1)
  }
  return { pick, runs }
}

// The take's frames for a plan
function screenFrames(spec, pts) {
  return frameMap(pts, spec.frames, n => srcAt(spec.keep, n / spec.fps))
}
// The camera's frames: its own clock, which starts late and runs through pauses
function cameraFrames(spec, pts) {
  return frameMap(pts, spec.frames, n => Timeline.camTime(spec.cam, srcAt(spec.keep, n / spec.fps)))
}

module.exports = { prepare, framePlan, srcAt, viewAt, travel, engineFor, unsupported, holdIndex, frameMap, screenFrames, cameraFrames, rgb, markKey }
