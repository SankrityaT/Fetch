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

// The shoulder on the contrast line, and the same curve mirrored for its toe.
//
// w is what the top of the range becomes under the straight line
// (c - 0.5) * contrast + 0.5 + brightness, wp what the take's own white point becomes
// under it, and gain the line's own slope. At 1 or under nothing goes over the edge and
// the line is left exactly as it was. Over 1, the line runs straight up to a knee and a
// cubic takes it from there onto 1.0 at w, so nothing the line carries past the range's
// end is cut off. Returns [knee, run, and the curve's two terms] for gl.js's rollIn().
//
// Two numbers place the knee, and the take's own white is the first of them: the run
// starts there where there is room above it, so the overshoot is spent entirely on what
// the take has nothing in and the picture keeps the line whole. A white app page leaves
// no room at all (this take's white measures 253 of 255), and there the run reaches down
// into the picture instead, far enough that the curve still arrives carrying 1 / gain of
// the line's slope. That is the slope the picture had before the grade touched it, so a
// hairline at the top of the take is never flatter than it was ungraded, whatever the
// dial says. Never past the bottom of the range: a gain that would put the knee under 0
// makes the whole line curve, and the arrival goes with it.
//
// It arrives carrying that slope rather than flat, and that is the fix. Arriving flat
// put the one place the curve has no slope left exactly on the take's white, which on a
// white app page is the page: every row separator and card hairline a level under it was
// compressed into it, 2.5 times on Noir. Above the take's white the curve still runs, so
// a cursor or a white toast in the top 0.4 percent levels.js leaves out is rolled in
// rather than clipped.
function rollOff(w, wp, gain) {
  if (!(w > 1.0001)) return [0, 0, 0, 0]
  const d = w - 1
  const a = Math.min(w, Math.max(w - wp, gain > 1.0001 ? d * gain / (gain - 1) : w))
  const k = w - a, r = (1 - k) / a - 1
  // f(0) = 0, f'(0) = 1 so it meets the straight line; f(1) = 1 + r so w lands on 1.0;
  // f'(1) = 1 + r, the shoulder's own average slope, so it arrives on the end carrying
  // slope. Monotone for every dial: the curve's least slope is 1 + 4r/3, and r, which is
  // 1/gain - 1 where the slope sets the run and (1 - w)/w where the range does, does not
  // reach -3/4 anywhere the dials go (contrast 1 with brightness 1 leaves it at -0.6).
  return [k, a, 2 * r, -r]
}

// ── the take's edge ─────────────────────────────────────────────────────
// The edge is a contract, not whatever the ground a look chose happens to leave. The
// take's outermost pixels stand off the ground just outside them by at least EDGE_FLOOR
// levels of luma, everywhere round the perimeter, and the frame pass meets that with
// whatever is available: a hairline where the ground is the take's own tone, a shadow
// where there is room to cast one, and a blur ground that holds near the take's own
// mean. Four of the seven presets failed it for four different reasons before this
// (.context/survey/fix-edge.md).
const EDGE_FLOOR = 24 / 255
// And the other end of it, for the one ground that is the take itself. A gutter filled
// by the take's own blur is bleed, so it never stands further off the take than this.
// Pressed to 30 percent luma under a 236 page it measured 183 levels, which is a black
// bar by any other name, and PRODUCT says the output never draws one.
const EDGE_BLEED = 64 / 255
// How far the top of the vignette dial reaches, in cos^4 fall-offs (see the treatment's
// own note below). At 1 the frame's furthest corner keeps a third of its light and the
// take's own corners about seven tenths, which is a lens and not a tunnel.
const VIG_REACH = 2.4
// Warm ink over a light ground, a warm light over a dark one (BRAND --ink-1, --text-0).
// Never #000 or #fff: every neutral here is warmed toward the fur hue.
const EDGE_INK = '#1A1714', EDGE_LIT = '#FBFAF8'
const lum = c => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]

/**
 * Which warm end the hairline goes to: { col }. Which way that is falls out of the tone
 * itself in the frame pass, which reads the take's own edge against it.
 *
 * Decided once from the ground a look chose, not per pixel, and that is the point. A
 * ground can cross mid grey along one edge (every gradient does), and a line that
 * changed ends where it crossed would put a seam down one side of the frame and would
 * land the two decode paths on opposite sides of it. One end for the whole frame is
 * continuous in whatever is under it, so the line fades to nothing rather than
 * switching off.
 *
 * A blurred copy of the take is the take's own dark side by construction (the band in
 * blurFill only ever holds it under the take's own mean), so the take is the light one
 * of the pair and the line goes with it: an ink line there would close the very gap it
 * is drawn to open. A photo can be anything, so the compositor reads the decoded
 * picture's own mean and picks with edgeFor(); until it has, the ink end stands.
 *
 * One end, and it does not travel. The take's own edge is under a lift for part of a
 * perimeter and not for the rest, so it can land on the very tone the plan chose, and
 * letting the line drift to the other end there was tried and taken out: the two ends
 * are the range apart, so the drift carried the line's tone across the take's own luma,
 * and one level of the take either side of that crossing took the finished pixel from a
 * floor above the take to a floor below it. A hairline that swings thirty levels on a
 * level of the picture pops while a lift fades a page and lands the two decode paths on
 * opposite sides of the crossing, which is the rim the whole contract exists to stop.
 * Where this end cannot carry the floor against the take, the frame pass delivers what
 * the tone has and no more.
 */
const edgeFor = light => (light ? { col: rgb(EDGE_INK) } : { col: rgb(EDGE_LIT) })
function edgeEnd(bg) {
  const light = bg.kind === 'gradient' ? (lum(bg.c0) + lum(bg.c1)) / 2 > 0.5
    : bg.kind === 'mesh' ? bg.c.reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i % 3], 0) / (bg.c.length / 3) > 0.5
    : bg.kind === 'blur' ? false
    : true
  return edgeFor(light)
}

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
  // Gaussian of that variance, hanging 0.9 r low. Widened, because DESIGN's Elevation
  // says wide rather than tight: on a near-black ground the classic width measured nine
  // levels deep and gone inside 25 px, which reads as a hairline of dark rather than as
  // elevation. A wide shadow is also the one the edge floor can measure, since the
  // ground a pixel out and the ground three pixels out are then the same ground; a
  // tight one is a cliff and the floor lands on whichever pixel it happened to read.
  //
  // Capped against the margin the frame actually leaves, though, with the drop taken
  // out of it first. A pool that runs off the canvas is not elevation either: at two
  // and a quarter times flat, the last row under the take was still a tenth of the way
  // to black on four of the seven presets, so the look's own ground colour was nowhere
  // visible and the shadow read as a vignette with a straight edge. The drop stays the
  // classic one, so the light still comes from where it always did.
  const r = g.blur
  const flat = Math.sqrt((4 * r * r + 4 * r) / 6)
  const dy = Math.round(r * 0.9)
  const margin = Math.min(g.ox, g.oy, g.outW - g.ox - g.vidW, g.outH - g.oy - g.vidH)
  const shadow = framed ? {
    alpha: clamp(num(opts.shadow, 0.6), 0, 1),
    sigma: Math.max(flat, Math.min(2.25 * flat, (margin - dy) / 1.7)),
    dy,
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
    // band: this ground is the take itself, so it is held inside a band of the take's
    // own mean at that point rather than wherever the press leaves it. The press is
    // right for a dark take and ruinous for a bright one: under a white page it made a
    // 20 px gutter a bar.
    // Half again the floor at the near end, not the floor itself: a ground sitting
    // exactly on it leaves nothing for grain and dither, and this one is wide enough
    // to want a step rather than a line.
    return { kind: 'blur', fw, fh, sigma: Math.max(2, 125 * fh / 1080) * (0.25 + 1.5 * amount),
      band: [1.5 * EDGE_FLOOR, EDGE_BLEED] }
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
  // The dial is how many fall-offs, not the fall-off itself. One of them is the blur
  // ground's own cos^4 at ffmpeg's angle 0.4 (gl.js fillAt), which was the right shape
  // to hold the ground and the frame to one fall-off and the wrong size for a dial: at
  // the top of the range it took 28 percent off the frame's furthest corner and 15 off
  // the take's, so a look whose identity is a vignette had nothing left to ask for and
  // Noir's 0.35 measured 6. VIG_REACH is what the top of the dial is worth in those
  // fall-offs. It scales the mix and nothing else, so the share the blur ground divides
  // back out stays exactly the share the treatment puts on, and the ground and the take
  // still fall off together and once.
  const vignette = clamp(num(T.vignette, 0), 0, 1) * VIG_REACH
  const soft = clamp(num(T.blur, 0), 0, 1)
  const bloom = clamp(num(T.bloom, 0), 0, 1)
  const halation = clamp(num(T.halation, 0), 0, 1)
  const aberration = clamp(num(T.aberration, 0), 0, 1)
  const glow = Math.max(bloom, halation)
  // The take's own white point, in the pixels the glow's bright pass reads, which are
  // the frame before the grade: the same place levels.js measured, and prepare.js now
  // measures it for a look that glows as well as for one that auto levels. A take
  // nobody could measure, or one that already fills the range, ends where the range
  // ends, and then nothing in it is above its own white.
  const white = P && P.levels && P.levels.hi > P.levels.lo ? P.levels.hi : 1
  const black = P && P.levels && P.levels.hi > P.levels.lo ? P.levels.lo : 0
  // The take's own two ends where the grade sees them, which is after auto level: a
  // measured take has already been stretched onto 0 and 1 by the time the grade runs,
  // so its ends are the range's; an unmeasured one is taken to fill the range, which is
  // the same two numbers. Everywhere else they are what levels.js measured, and the
  // shoulder and the toe are pinned to them: they say where the picture actually ends,
  // so the curve knows what it may bend and what it must leave alone. prepare.js
  // measures them for anything that grades, not only for auto level and the glow.
  const gWhite = lv ? 1 : white, gBlack = lv ? 0 : black
  const line = v => (v - 0.5) * (1 + contrast) + 0.5 + bright
  const treat = lv || bright || contrast || sat || tintAmount || haze || vignette || soft || glow || aberration ? {
    level: lv,
    // the dials ffmpeg eq takes: 1 is neutral for contrast and saturation, brightness adds
    bright, contrast: 1 + contrast, sat: 1 + sat,
    // and the two ends of that line rolled in rather than cut off, each pinned to the
    // take's own end. Without these a contrast over about 0.06 takes a white app page
    // and everything near it to 255 together, which is every row separator, card edge
    // and hairline in the product gone; with them but pinned to the range instead of to
    // the take, the same hairlines survived the clip and died in the shoulder. The toe
    // is the same argument at the bottom, where a hairline on a dark page goes black.
    shoulder: rollOff(line(1), line(gWhite), 1 + contrast),
    toe: rollOff(1 - line(0), 1 - line(gBlack), 1 + contrast),
    tint: rgb(T.tint || '#F0A93C'), tintAmount, haze, vignette,
    // the whole frame softened: sigma in export pixels, about 26 of them at 1080 at full
    blur: soft * 0.024 * g.outH,
    bloom, halation,
    // What the glow is allowed to read: what is at the take's own white point, a shade
    // under it. The threshold used to come off the dial alone (0.9 down to 0.45), which
    // put a page white at 254 deep inside the bright pass, so halation's warm wide end
    // came back over every grey glyph on the page as a pink collar. It is one to four
    // 8-bit levels under the measured white instead, one at a light touch and four at
    // the top of the dial, and the strength is still the dial's alone. prepare.js
    // measures that white for a look that glows and not only for one that auto levels,
    // which is what this was missing: unmeasured it fell back to 1, so a dark-mode take,
    // whose highlights top out well under white, had no bloom and no halation at any
    // setting. Bloom and halation share the bright pass, so the louder of the two sets it.
    glowThresh: clamp(white - (1 + 3 * glow) / 255, 0.05, 0.995),
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
    // The edge floor, and the hairline that meets it where nothing else does: about a
    // pixel and a quarter at 1080, scaled with the output so it stays a hairline at 4K.
    // No ground, no contract: a take in its own shape is the whole output, and a line
    // round that is a line round the video.
    edge: bg.kind === 'none' ? null : { floor: EDGE_FLOOR, px: Math.max(1, g.outH * 1.25 / 1080), ...edgeEnd(bg) },
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

module.exports = { prepare, framePlan, srcAt, viewAt, travel, engineFor, unsupported, holdIndex, frameMap, screenFrames, cameraFrames, rgb, markKey, edgeFor }
