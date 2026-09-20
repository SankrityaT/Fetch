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
// The two numbers the ground's tooth and the film's grain are held together by, both in
// levels of the finished frame. TOOTH_SIGMA is what the frame pass's own tooth measures
// (three levels either side, uniform, so 6 * 255 / 219 wide); GRAIN_ENDS is how much of
// the film's midtone weighting survives at the ends of the range (gl.js, the final
// pass). Kept here because the tooth is scaled against the grain and the two have to be
// read off the same arithmetic.
const TOOTH_SIGMA = 6 / 219 / Math.sqrt(12)
const GRAIN_ENDS = 0.6
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
const edgeFor = light => ({ light, col: rgb(light ? EDGE_INK : EDGE_LIT) })
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

// ── the drawn device ────────────────────────────────────────────────────
//
// A frame round the take: a browser, a plain window, a laptop or a phone, drawn from
// rectangles, radii and two tones. Everything here is generic by construction and by
// intent. No outline is traced from a product, nothing carries a wordmark, a window's
// buttons are three dots in the shell's own tone rather than three coloured ones, a
// laptop is a slab and a shallow foot with no keyboard, wedge or hinge detail, and a
// phone has a speaker slit and nothing else: no notch, no island, no home bar. If a
// shape would make anyone think of one company's product it is the wrong shape.
//
// The device takes the place the layout gave the take and hands back what is left, so
// the frame's margins, its shadow and the whole composition stay where they were and
// only the take gets smaller. Sizes are shares of the screen's own width, so a device
// is the same device at 720p and at 4K.
// bar: the top bezel, side and foot the others, r and sr the shell's and the screen's
// corners, base and over a laptop's foot: its height and how far it stands out either
// side. All of them shares of the screen's own width.
const DEVICES = {
  browser: { bar: 0.070, side: 0.008, foot: 0.008, r: 0.018, sr: 0.005 },
  window: { bar: 0.046, side: 0.008, foot: 0.008, r: 0.018, sr: 0.005 },
  laptop: { bar: 0.020, side: 0.020, foot: 0.052, r: 0.022, sr: 0.006, base: 0.030, over: 0.055 },
  phone: { bar: 0.050, side: 0.030, foot: 0.050, r: 0.070, sr: 0.030 },
}
// The shell, and the hairline that answers for both of its edges. The two are the
// range apart on purpose: an edge drawn as a pair of tones that far apart stands clear
// of whatever it meets, because nothing can be within the floor of both of them. That
// is how a device keeps the take's edge contract without measuring anything per pixel,
// which is what keeps the two decode paths on the same side of it.
// face is the bar a browser wears, a shade up from the shell because a toolbar sits in
// front of the page; deep is the laptop's foot, a shade down, because a foot is under
// the lid rather than in front of it.
const SHELL = {
  dark: { shell: '#2A2420', line: EDGE_LIT, face: '#1F1B18', deep: '#1F1B18', text: '#BDB5AC', sheen: 0.07 },
  light: { shell: '#E8E2DA', line: EDGE_INK, face: '#F6F3EE', deep: '#D6CFC5', text: '#6E655C', sheen: 0.5 },
}

/**
 * Where a drawn device sits, in output pixels, or null when the look asks for none.
 *   D       the look's device section
 *   chrome  the look's frame.chrome: clean draws the browser frame on its own, which
 *           is the whole of that setting's third option (the crop that removes the
 *           real chrome is the document's, ui/fetchdoc.js chromeCrop). It only draws
 *           where that crop could happen: with no viewport the take still carries its
 *           own tabs and toolbar, and a drawn browser round them is two browsers.
 *           Look.warnings says so in the same case.
 *   g       the layout's geometry, gut the take's corner floor, end the ground's own end
 *   bg      the ground, for the shell's own tone
 */
function devicePlan(D = {}, chrome, g, corner, end, bg = {}, viewport = null) {
  const kind = DEVICES[D.kind] ? D.kind : (chrome === 'clean' && viewport ? 'browser' : null)
  if (!kind) return null
  const d = DEVICES[kind]
  const a = g.vidW / g.vidH
  const base = d.base || 0
  // the largest screen of the take's own shape that leaves room for the shell round it
  const sw = Math.min(g.vidW / (1 + 2 * d.side), g.vidH / (1 / a + d.bar + d.foot + base))
  const sh = sw / a
  const boxW = sw * (1 + 2 * d.side), boxH = sh + sw * (d.bar + d.foot)
  const cx = g.ox + g.vidW / 2, cy = g.oy + g.vidH / 2
  const box = { x: Math.round(cx - boxW / 2), y: Math.round(cy - (boxH + sw * base) / 2), w: Math.round(boxW), h: Math.round(boxH), r: sw * d.r }
  const screen = {
    x: Math.round(box.x + sw * d.side), y: Math.round(box.y + sw * d.bar),
    w: 2 * Math.round(sw / 2), h: 2 * Math.round(sh / 2),
    // never tighter than the window's own rounded corner, or its black corner shows
    r: Math.max(corner, sw * d.sr),
  }
  // Graphite on a dark ground, bone on a light one. A photo is the one ground the plan
  // cannot read: edgeEnd calls every image light, because the hairline's ink end is the
  // safe one until the picture is decoded, and for a shell that would be a pale slab on
  // a near-black photo, which is four of the five we ship. So a photo starts on graphite
  // and gl.js re-picks it from the decoded mean (deviceOf), the way it does the hairline.
  const auto = D.theme !== 'light' && D.theme !== 'dark'
  const light = !auto ? D.theme === 'light' : bg.kind !== 'image' && !!end.light
  const foot = base ? {
    x: box.x - sw * d.over, y: box.y + box.h, w: box.w + 2 * sw * d.over, h: sw * base,
    r: sw * base * 0.35, taper: sw * base * 0.5,
  } : null
  // a phone's speaker, the one detail on it: a slit in the top bezel, centred
  const slit = kind === 'phone' ? { w: sw * 0.10, h: Math.max(2, sw * 0.006), y: box.y + sw * d.bar * 0.42 } : null
  const pad = Math.ceil(sw * 0.02)
  const x0 = Math.min(box.x, foot ? foot.x : box.x) - pad, y0 = box.y - pad
  const x1 = Math.max(box.x + box.w, foot ? foot.x + foot.w : 0) + pad, y1 = (foot ? foot.y + foot.h : box.y + box.h) + pad
  return {
    kind, box, screen, foot, slit, light, auto, ...SHELL[light ? 'light' : 'dark'],
    bar: sw * d.bar, unit: sw,
    title: String(D.title || '').slice(0, 80),
    extent: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
  }
}

// ── the tilt ────────────────────────────────────────────────────────────
//
// frame.tilt turns the framed take in perspective: a real rotation about the vertical
// axis through its own centre, projected from a camera 2.2 frames away, not a skew.
// The frame pass reads it backwards, per pixel: every pixel of the output is asked
// which point of the flat plane it shows, and everything after that (the take's rounded
// mask, its border, its shadow, the camera bubble lying on it) is worked out on the
// plane exactly as it was before the tilt existed. So the mask follows the perspective
// because it is the same mask, and the shadow follows it because it is cast on the
// plane rather than painted under the picture.
//
// The plane is shrunk by as much as the projection's near edge grows, so a tilted take
// occupies exactly the room the flat one did and the near corner cannot reach past the
// frame. Positive turns the take's right edge toward the viewer.
const TILT_DIST = 2.2
function tiltPlan(deg, box, g) {
  const t = clamp(num(deg, 0), -20, 20)
  if (!(Math.abs(t) > 0.01)) return null
  const rad = t * Math.PI / 180
  const D = TILT_DIST * Math.max(g.outW, g.outH)
  const sin = Math.sin(rad), m = D * Math.cos(rad)
  // the near edge grows by D / (D - halfW |sin|); the whole plane gives that back
  const fit = (D - (box.w / 2) * Math.abs(sin)) / D
  return { sin, m, D, fit, cx: box.x + box.w / 2, cy: box.y + box.h / 2 }
}

// ── the camera bubble's track ───────────────────────────────────────────
//
// The bubble used to sit in one corner at one size for a whole take. It is keyframed
// now: where it is, how big it is and what shape it is, over time. The reason is the
// shot and not the feature. A face should be large while somebody is introducing a
// thing and small once the thing itself is the point, and a bubble that cannot move is
// one of those two wrong for most of the take.
//
// A key is a state the bubble starts moving to at its own time, the way a zoom starts
// pushing in at its own start rather than arriving there. Fields a key leaves out keep
// the value the bubble already had, which is what makes this one call rather than six:
// "keep the camera small while the lift is up" says a size and says nothing about the
// corner the bubble never leaves.
//
// An entry with start and end is that same thing said once: the state at start, and
// whatever the bubble had before it at end. That is the shape an agent reaches for,
// because what it wants is almost never a keyframe, it is a stretch of the take where
// the face is not the point.
//
// Times are the document's, source seconds, like a zoom's; clock() puts them on the
// output. The track is a function of time alone, so any frame still draws alone.
const CAM_SHAPES = { circle: 0.5, rounded: 0.22 }
const CAM_MIN = 0.05, CAM_MAX = 0.6

// The keys of a camera as states in fractions of the take: { t, x, y, size, rf }, the
// first one at 0 being where the editor put the bubble.
function camKeys(list, base, clock) {
  const partial = e => {
    const s = {}
    if (Number.isFinite(+e.x)) s.x = clamp(+e.x, 0, 1)
    if (Number.isFinite(+e.y)) s.y = clamp(+e.y, 0, 1)
    if (Number.isFinite(+e.size)) s.size = clamp(+e.size, CAM_MIN, CAM_MAX)
    if (CAM_SHAPES[e.shape] != null) s.rf = CAM_SHAPES[e.shape]
    return s
  }
  const raw = []
  for (const e of Array.isArray(list) ? list : []) {
    if (!e) continue
    const s = partial(e)
    if (!Object.keys(s).length) continue
    // a span if it has both ends and they are the right way round, else one moment
    const span = Number.isFinite(+e.start) && Number.isFinite(+e.end) && +e.end > +e.start
    const a = [span ? e.start : null, e.t, e.at, e.start].find(v => v != null && Number.isFinite(+v))
    if (a == null) continue
    raw.push({ a: +a, b: span ? +e.end : null, s })
  }
  raw.sort((p, q) => p.a - q.a)
  // What a span puts back is what the bubble had before that span, read as the list is
  // walked in order. A span whose whole stretch the edit cut lands both of its ends on
  // one output instant, and the sort is stable, so the state put back is the one that
  // survives: a bubble does not shrink for a moment that is not in the video.
  const edges = []
  let cur = { ...base }
  for (const r of raw) {
    edges.push({ t: clock(r.a), s: r.s })
    if (r.b != null) {
      const back = {}
      for (const f of Object.keys(r.s)) back[f] = cur[f]
      edges.push({ t: clock(r.b), s: back })
    }
    cur = { ...cur, ...r.s }
  }
  edges.sort((p, q) => p.t - q.t)
  const keys = [{ ...base, t: 0 }]
  let st = { ...base }
  for (const e of edges) {
    st = { ...st, ...e.s }
    const t = Math.max(0, e.t)
    // two keys on one instant are one key, the last of them
    if (t <= keys[keys.length - 1].t) keys[keys.length - 1] = { ...st, t: keys[keys.length - 1].t }
    else keys.push({ ...st, t })
  }
  return keys
}

// The same track in the pixels of the output, each key a centre, a diameter and a
// corner, plus how long the move into it takes.
//
// The lengths are the zooms' own measures, because a bubble easing differently from the
// frame it sits in reads as two takes cut together: octaves of size through easeSpan,
// bubble widths travelled through panSpan, and the longer of the two. Never longer than
// the gap to the key after it, so a move always lands before the next one leaves.
function camPlan(keys, rect, ease) {
  const out = keys.map(st => {
    // the size is a share of the take's width, and never more of it than the take's
    // short side: a bubble wider than the take it lies on has nowhere to be put
    const d = 2 * Math.round(Math.min(Math.max(24, st.size * rect.w), Math.min(rect.w, rect.h)) / 2)
    return {
      t: st.t, d, rf: st.rf,
      // never outside the take, at every key and so at every instant between two of
      // them: the centre and its room are both affine in the ease, and no ease here
      // overshoots, so a move between two bubbles that fit is made of bubbles that fit
      cx: clamp(rect.x + st.x * rect.w, rect.x + d / 2, rect.x + rect.w - d / 2),
      cy: clamp(rect.y + st.y * rect.h, rect.y + d / 2, rect.y + rect.h - d / 2),
      T: 0,
    }
  })
  for (let i = 1; i < out.length; i++) {
    const a = keys[i - 1], b = keys[i]
    const grow = Overlays.easeSpan(1, Math.max(a.size, b.size) / Math.max(1e-4, Math.min(a.size, b.size)), ease)
    const px = Math.hypot((b.x - a.x) * rect.w, (b.y - a.y) * rect.h)
    const wide = px > 0 ? Overlays.panSpan(px / Math.max(1, (a.size + b.size) / 2 * rect.w), ease) : 0
    const gap = i + 1 < out.length ? out[i + 1].t - out[i].t : Infinity
    out[i].T = Math.max(1 / 240, Math.min(Math.max(grow, wide), gap))
  }
  return out
}

/**
 * Where the bubble is at output time t: { x, y, d, round, ring }, x and y its top left
 * in output pixels. At a key and before the first one it is that key exactly, so a take
 * with no keys draws the bubble it always drew, byte for byte.
 */
function camAt(cam, t) {
  const ks = cam.track
  let i = 0
  while (i + 1 < ks.length && ks[i + 1].t <= t) i++
  const b = ks[i]
  const e = i === 0 || !(b.T > 0) ? 1 : Overlays.easeAt((t - b.t) / b.T, cam.ease)
  const a = i === 0 ? b : ks[i - 1]
  const m = (p, q) => (e >= 1 ? q : p + (q - p) * e)
  const d = m(a.d, b.d)
  // The shape is the corner as a share of the diameter, so circle to rounded is a
  // morph the frame pass already knows how to draw rather than a switch on a frame.
  return { x: m(a.cx, b.cx) - d / 2, y: m(a.cy, b.cy) - d / 2, d, round: d * m(a.rf, b.rf),
    ring: cam.ringOn ? Math.max(2, Math.round(d * 0.016)) : 0 }
}

// ── which renderer ──────────────────────────────────────────────────────
// The compositor draws everything an edit places (M3): the framed look, zooms, fades,
// cuts, the camera, marks, lifts and spotlights, steps, the agent's cursor, the Mac's
// pointer lifted out, captions, titles, labels and auto zoom (its moments worked out by
// prepare.js). Every format that carries a picture is drawn here now and differs only at
// the sink: H.264 for MP4 and MOV, VP9 for WebM, a palette pass for GIF (sinks.js). A
// GIF used to be the old product, missing the treatment, the lift, the device frames and
// the easing, which is the one deliverable a landing page autoplays. What is left for the
// classic renderer is a file with no picture in it (m4a, mp3, wav) and a still frame.
const GL_FORMATS = new Set(['mp4', 'mov', 'webm', 'gif'])
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
  const clock = Timeline.outClock(opts.cuts, start, end, opts.rates)
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

  // The drawn frame round the take, and the take's own rect inside it. A device takes
  // the place the layout gave the take and hands the take back what is left, so the
  // composition, the margins and the shadow stay exactly where they were.
  const end0 = edgeEnd(bg)
  // the screen's corner is the device's own, floored at the window's (`corner`) so the
  // take's black corner never shows; frame.radius belongs to a take with no device
  const device = framed ? devicePlan(L('device'), L('frame').chrome, g, corner, end0, bg, opts.viewport) : null
  const rect = device ? device.screen : { x: g.ox, y: g.oy, w: g.vidW, h: g.vidH }
  const rad = device ? device.screen.r : radius
  // A tilt turns the whole framed take, the device and the camera bubble on it in one
  // plane; the frame pass reads it backwards, per pixel (gl.js, FS_FRAME).
  // A take with nothing behind it is the whole output, and turning it would open black
  // wedges at the corners, which is the one thing the output never draws. Same rule as
  // the take's own arrival: it can only turn in something.
  const tilt = bg.kind === 'none' ? null : tiltPlan(num(L('frame').tilt, 0), device ? device.box : rect, g)

  // Zooms on the output clock, as the classic export places them; with auto zoom and
  // none of its own, the moments prepare.js found (already on the output clock)
  let zooms = (opts.zooms || []).filter(z => z && +z.end > +z.start)
    .map(z => ({ start: clock(z.start), end: clock(z.end), scale: z.scale, x: z.x, y: z.y }))
    .filter(z => z.end > z.start)
  if (!zooms.length && opts.autoZoom && P && Array.isArray(P.autoZooms)) zooms = P.autoZooms.filter(z => z && z.end > z.start)

  // The camera bubble, over the framed take in its own fractions, as the editor places
  // it: never zoomed with the content, never outside the take. Keyframed, so where it
  // is, how big it is and what shape it is are all functions of time (camKeys, camAt).
  let cam = null
  const k = opts.camera
  if (k && k.file && k.on !== false) {
    const C = L('camera')
    // its fractions are of the take, so under a device frame it sits on the screen and
    // not on the bezel
    const base = { x: clamp(num(k.x, 0.82), 0, 1), y: clamp(num(k.y, 0.78), 0, 1),
      size: clamp(num(k.size, 0.22), CAM_MIN, CAM_MAX), rf: CAM_SHAPES[C.shape] != null ? CAM_SHAPES[C.shape] : 0.5 }
    const track = camPlan(camKeys(k.keys, base, clock), rect, L('motion').zoomEase)
    const k0 = track[0]
    cam = {
      file: k.file, track, ease: L('motion').zoomEase, ringOn: C.ring !== false,
      // Where the bubble opens, which is the whole of it on a take with no keys.
      x: k0.cx - k0.d / 2, y: k0.cy - k0.d / 2, round: k0.d * k0.rf,
      ring: C.ring === false ? 0 : Math.max(2, Math.round(k0.d * 0.016)),
      // What the camera take is decoded at (compositor/index.js, camSquare): the
      // biggest the bubble ever gets, so a key that grows it is drawn from the camera's
      // own pixels rather than upscaled from the size the take opened on.
      d: Math.max(...track.map(q => q.d)),
      camStartedAt: k.camStartedAt, screenStartedAt: k.screenStartedAt, gaps: k.gaps || [],
    }
  }

  // What is drawn on the recording itself, placed once: sizes for the finished frame
  // from px, the finished pixels per content pixel before any zoom
  const px = rect.h / (ch * inner.h)
  const drawn = markList(opts.marks, P && P.marks)
  const F = L('focus'), Cu = L('cursor')
  const pm = Marks.planMarks(drawn, { W: cw, H: ch, px, clock, span, zooms, ease: L('motion').zoomEase,
    look: { dim: F.dim, lift: F.lift, loupe: F.loupe, arrow: F.arrow } })
  const erase = P && P.erase ? Marks.planErase(P.erase.spans, P.erase.plates,
    { src: { w: srcW, h: srcH }, crop: { x: cx, y: cy }, content: { w: cw, h: ch }, clock, end, span }) : []
  // an empty track is the look's cursor switched off, whatever the take has
  const raw = Array.isArray(opts.pointer) ? opts.pointer : null
  const points = raw && !raw.length ? null : P && P.pointer ? P.pointer.points : raw
  const pointer = points ? Marks.planPointer(points, { W: cw, H: ch, clock, crop: c, scale: P && P.pointer ? P.pointer.scale : null,
    span, px, zooms: pm.zooms, size: Cu.size, ripple: Cu.ripple }) : null
  const marks = { ...pm, erase, pointer }
  // What the edit hides, on the source clock, for the one transition that shows the
  // material a cut removed (cutPoints). The marks themselves are on the output clock by
  // now, and the removed material has no time there at all.
  const hidden = [
    ...(opts.marks || []).filter(m => m && (m.kind === 'redact' || m.kind === 'blur') && +m.end > +m.start).map(m => [+m.start, +m.end]),
    ...((P && P.erase && P.erase.spans) || []).map(q => [+q.a, +q.b]),
  ]
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

  // The caption band is the room the layout left under the take, and a device sits in
  // the take's own place rather than beside it, so the band is measured from the take
  // and not from the screen inside the device. Laid out from the screen, a 50 px caption
  // landed on a laptop's foot. Everything else a text reads (a lower third rides the
  // product) still goes by the screen.
  const capBox = framed ? (device ? { x: g.ox, y: g.oy, w: g.vidW, h: g.vidH } : { ...rect }) : null
  const text = Text.planText(opts, { clock, span, W: g.outW, H: g.outH, box: framed ? { ...rect } : null,
    capBox, prepared: P, zooms: pm.zooms })

  return {
    W: g.outW, H: g.outH, fps, frames, span, keep, start, end,
    src: { w: srcW, h: srcH }, crop: { x: cx, y: cy, w: cw, h: ch },
    content: { w: cw, h: ch, px },
    framed, rect, radius: rad, shadow, inner, device, tilt,
    // The edge floor, and the hairline that meets it where nothing else does: about a
    // pixel and a quarter at 1080, scaled with the output so it stays a hairline at 4K.
    // No ground, no contract: a take in its own shape is the whole output, and a line
    // round that is a line round the video.
    // A device frame answers for the take's edge itself: the bezel is a tone Fetch
    // chose, held off the ground by the same floor, and it carries a hairline on both
    // sides of itself (devicePlan). A second line just inside the screen would be a
    // line drawn on a line.
    edge: bg.kind === 'none' || device ? null : { floor: EDGE_FLOOR, px: Math.max(1, g.outH * 1.25 / 1080), ...end0 },
    border: borderPx > 0 ? { px: borderPx, color: rgb(L('frame').borderColor || '#FFFFFF') } : null,
    bg, zooms: pm.zooms, ease: L('motion').zoomEase, cam, marks,
    cut: cutPoints(keep, L('motion').cutTransition, fps, hidden),
    // The take can only arrive in something. Where the look puts nothing behind it the
    // take is the whole output, so there is nowhere to rise from and dimming the picture
    // instead would be a fade from black, which is motion.fadeIn and the person's call.
    reveal: L('motion').reveal === 'none' || bg.kind === 'none' ? null : { in: REVEAL_IN, out: REVEAL_OUT },
    text: text.phrases.length || text.cards.length || text.labels.length ? text : null,
    // The keys as they were pressed, over the finished frame rather than on the take, so
    // a zoom neither carries nor scales them (marks.js planKeys). Laid out against the
    // same box the captions are, so the two never land on each other.
    keys: Marks.planKeys(opts.keys, { W: g.outW, H: g.outH, box: framed ? { ...rect } : { x: 0, y: 0, w: g.outW, h: g.outH },
      capBox, caption: opts.captions ? (opts.captionStyle || {}) : null, clock, span,
      place: L('keys').place, size: L('keys').size, show: L('keys').show !== false }),
    // the schema's own default: 0.5 is a 180 degree shutter, the film standard
    motionBlur: clamp(num(T.motionBlur, 0.5), 0, 1),
    treat,
    // Film grain: its strength, and a cell sized on the output so a look grains the
    // same at 720p and at 4K. 0.055 at full is a little over three times the still
    // grain the classic blur ground carries (noise=c0s=3), which is what a moving
    // grain needs to read at all without eating the text under it.
    grain: film > 0 ? { amp: film * 0.055, cell: Math.max(1, g.outH * 1.4 / 1080) } : null,
    // and the ground's own tooth under it. A roll of film is in front of the whole
    // frame, so where a look has grain the film is what the frame's texture is, and the
    // ground's tooth cannot stand above what that grain leaves on the picture: a wall
    // three times grainier than the plate hanging on it is a mat, not a surface, and it
    // is exactly backwards on the two looks whose identity is the grain. Measured at the
    // end of the range, because the picture in a screen recording is an app page and
    // that is where the film's own midtone weighting leaves least. Where a look asks for
    // no film there is nothing in front of anything: the tooth is all the ground has and
    // it keeps its three levels, and a recording of a screen is not given grain nobody
    // asked for. Never under a third either, which is what keeps it clear of the dither.
    tooth: film > 0 ? clamp(film * 0.055 * GRAIN_ENDS / Math.sqrt(6) / TOOTH_SIGMA, 0.3, 1) : 1,
    // How many output frames one draw of that texture lasts. Both are seeded by the
    // frame index, which is what lets any frame draw alone, and at 60 fps that meant a
    // completely new field of grain sixty times a second: the same look boiling twice
    // as fast at 60 as at 30, and noise no frame can predict from the one before it,
    // which is the first thing an encoder spends nothing on. At CRF 23 a fifth of what
    // was drawn arrived in the file. So the roll is exposed at the take's own rate up
    // to 30 a second and no faster, and a frame's seed is still its own index and
    // nothing else. 30 rather than a projector's 24 because it divides both output
    // rates: at 60 every draw lasts exactly two frames, at 30 it lasts one, and the
    // grain of a 30 fps export is what it always was.
    grainHold: Math.max(1, Math.round(fps / 30)),
    // A clip meant to autoplay and repeat: the loop's length in output frames, which is
    // the index gl.js seeds the grain, the tooth and the dither by (loopIndex). A caller
    // that counts frames on past the end, which a stage playing the clip round again
    // does, then draws the frames the file holds rather than a second cycle of fresh
    // noise. 0 where the look does not ask for a loop, and the index passes straight
    // through.
    loop: L('motion').loop ? frames : 0,
    fadeIn: Math.max(0, num(opts.fadeIn, 0)), fadeOut: Math.max(0, num(opts.fadeOut, 0)),
    dither: L('grain').dither !== false,
  }
}

// ── arriving, leaving, and meeting at a cut ─────────────────────────────
//
// Everything here is a function of output time. A transition is not a filter over two
// rendered frames and never reads the frame before: a dissolve is two source times and
// a weight, all three solved from t, which is what lets the export render out of order
// and the stage scrub straight to a frame in the middle of one.
//
// The curve is the same quintic the zoom rides (Overlays.easeS), with no warp, because
// a cut is symmetric in a way a zoom is not: unwarped, the weight is exactly 0.5 at the
// instant the timeline names, so the dissolve crosses over on the cut and the dip is at
// its darkest there. Called with p in [0, 1] only; outside it the polynomial is not a
// curve, and cutAt is what keeps p inside.
const S = Overlays.easeS, dS = Overlays.easeSVel

// The take arriving and leaving: a third of a second up into its frame, a little less
// back out. 10 px at 1080 and three and a half percent, which is the distance a card
// already travels (Text.frameMove) rather than a second opinion about it.
const REVEAL_IN = 0.36, REVEAL_OUT = 0.32, REVEAL_K = 0.035, REVEAL_PX = 10
// A cut transition, in seconds: half the window either side of the boundary for the
// dissolve and the dip, and the whole of the push, which lives after the cut alone.
const CUT_HALF = 0.1, PUSH_AFTER = 0.35, PUSH_AMOUNT = 0.06

/**
 * Where the cuts land on the output clock and how long each transition may be there.
 *   t  the boundary, the output time the piece after the cut starts at
 *   d  half the window (crossfade, dip) or the whole of it (zoom), whole frames
 *   a  the take time the outgoing piece ends at, b the one the incoming piece starts at
 *
 * A dissolve is made of the frames the cut removed: the outgoing side runs on past its
 * end into the gap and the incoming side starts inside it, so no output time is added
 * and nothing the viewer already saw is shown twice. That caps it at the gap, and at
 * half of either piece, so a cut with nothing behind it simply stays hard. Under two
 * frames it is dropped: a transition the eye reads as a glitch is worse than the cut.
 *
 * And at whatever the edit starts hiding inside that gap (`hidden`, source seconds: a
 * redaction, a blur, the Mac's pointer lifted out). Each side reads its marks from its
 * own side of the cut (framePlan), which covers everything already hidden where the cut
 * falls; what no instant of the output clock can speak for is a mark that begins inside
 * the removed material, and the window stops short of those.
 */
// ra and rb are the rates the two sides run at. Every length here is output seconds
// and every span of material is source seconds, so the two are only ever compared
// through the rate: a dissolve on a 4x section eats four source seconds of the gap
// for each output second it lasts, and given the same gap it may last a quarter as
// long. Without that division a fast section would reach for material the cut did not
// remove and show the viewer a moment twice.
function cutRoom(hidden, a, b, ra, rb) {
  let room = Infinity
  for (const [h0, h1] of hidden || []) {
    // the outgoing side plays on from a, so nothing may begin hiding inside its reach
    if (h0 >= a && h0 <= b) room = Math.min(room, (h0 - a) / ra)
    // and the incoming side starts before b, so nothing may stop hiding inside its reach
    if (h1 >= a && h1 <= b) room = Math.min(room, (b - h1) / rb)
  }
  return room
}
function cutPoints(keep, kind, fps, hidden) {
  if (!kind || kind === 'none' || !keep || keep.length < 2) return null
  const points = []
  let acc = 0
  for (let i = 0; i + 1 < keep.length; i++) {
    acc += Timeline.outSpan(keep[i])
    const gap = keep[i + 1][0] - keep[i][1]
    // Two ranges meeting with nothing between them are one piece of the take that a
    // speed change split (Timeline.applyRates), not a cut. Nothing was removed there,
    // so there is nothing to transition across and a dip would be a flicker in the
    // middle of a continuous shot.
    if (!(gap > 1e-6)) continue
    const ra = Timeline.rateEnds(keep[i])[1], rb = Timeline.rateEnds(keep[i + 1])[0]
    const lenA = Timeline.outSpan(keep[i]), lenB = Timeline.outSpan(keep[i + 1])
    const want = kind === 'zoom' ? Math.min(PUSH_AFTER, lenB)
      : Math.min(CUT_HALF, lenA / 2, lenB / 2, kind === 'crossfade'
        ? Math.min(gap / Math.max(ra, rb), cutRoom(hidden, keep[i][1], keep[i + 1][0], ra, rb)) : Infinity)
    const f = Math.floor(want * fps + 1e-6)
    if (f < 2) continue
    points.push({ t: acc, d: f / fps, a: keep[i][1], b: keep[i + 1][0], ra, rb })
  }
  return points.length ? { kind, points } : null
}

// The cut t is inside, with its progress through the window: 0 to 1 across the whole
// window, so p is 0.5 exactly on the boundary for the two symmetric kinds.
function cutAt(spec, t, kind) {
  const c = spec.cut
  if (!c || (kind && c.kind !== kind)) return null
  for (const b of c.points) {
    if (c.kind === 'zoom') { if (t >= b.t && t < b.t + b.d) return { b, p: (t - b.t) / b.d } }
    else if (t > b.t - b.d && t < b.t + b.d) return { b, p: (t - b.t + b.d) / (2 * b.d) }
  }
  return null
}

/**
 * The take's time at output time t, and the other side of a dissolve: { s, s2, mix }.
 * Both sides move forward at the take's own rate, so a dissolve is two clips playing,
 * not two frozen frames. Away from a dissolve s2 is null and mix 0.
 */
function srcPair(spec, t) {
  const c = cutAt(spec, t, 'crossfade')
  if (!c) return { s: srcAt(spec.keep, t), s2: null, mix: 0 }
  const dt = t - c.b.t
  // before the boundary the outgoing side is what srcAt already says; after it, that
  // same piece carried on into the gap. Each side carries on at its own piece's rate,
  // or a dissolve out of a 4x montage plays that half of itself at 1x and the cut is
  // the one place in the edit that visibly stalls.
  return { s: c.b.a + dt * (c.b.ra || 1), s2: c.b.b + dt * (c.b.rb || 1), mix: S(c.p) }
}

// The cut's push, as a magnification and its rate: the piece after a cut lands a little
// tight and settles back out. Never under 1, so the window never asks for more picture
// than the frame has, which is the one way a transition could put black at an edge.
function pushAt(spec, t) {
  const c = cutAt(spec, t, 'zoom')
  if (!c) return [1, 0]
  return [1 + PUSH_AMOUNT * (1 - S(c.p)), -PUSH_AMOUNT * dS(c.p) / c.b.d]
}

// How wide the shutter may open at t. A push lands the piece after a cut tight, so the
// view jumps on the boundary, and an exposure straddling it would smear the cut itself:
// thirty-two taps of a six percent zoom on the first frame of the new piece. A shutter
// cannot see both sides of an edit, so it is held to the side its own frame is on. The
// other transitions leave the view continuous and this never touches them.
// Held to just inside the frame's own side of it, not up to it: cutAt reads the
// boundary itself as already pushed, so an exposure ending exactly there put the whole
// six percent jump on the last frame before the cut. Only the frames whose own time
// lands on or after the boundary are pushed, and a boundary is rarely on a frame.
const CUT_EPS = 1e-6
function shutterHalf(spec, t, half) {
  if (!spec.cut || spec.cut.kind !== 'zoom') return half
  for (const b of spec.cut.points) if (Math.abs(t - b.t) < half) return Math.max(0, Math.abs(t - b.t) - CUT_EPS)
  return half
}

/**
 * How the take sits at output time t: { k, dy, alpha, shadow }, as the frame pass takes
 * it. A title card's landing where there is one (Text.frameMove), the look's own open
 * and close where there is not, and a cut's dip over the top. The card wins because it
 * is the reason the take is moving at all; the two are never added.
 */
function takeMove(spec, t) {
  const mv = Text.frameMove(spec.text, t, spec.H)
  const rv = spec.reveal, tp = spec.text
  if (rv && !(tp && tp.reveal) && t < rv.in) {
    const e = S(clamp(t / rv.in, 0, 1))
    mv.k *= 1 - REVEAL_K * (1 - e)
    mv.dy += REVEAL_PX * spec.H / 1080 * (1 - e)
    // opaque well before it lands: what arrives is a take settling, not a take fading in
    mv.alpha *= S(clamp(t / (rv.in * 0.6), 0, 1))
    mv.shadow *= e
  }
  if (rv && !(tp && tp.close) && t > spec.span - rv.out) {
    const e = S(clamp((t - (spec.span - rv.out)) / rv.out, 0, 1))
    mv.k *= 1 - REVEAL_K * e
    mv.dy += REVEAL_PX * spec.H / 1080 * e
    mv.alpha *= 1 - S(clamp((t - (spec.span - rv.out * 0.6)) / (rv.out * 0.6), 0, 1))
    mv.shadow *= 1 - e
  }
  const dip = cutAt(spec, t, 'dip')
  if (dip) {
    // down through the look's own ground and back, darkest on the boundary itself, so
    // the frame the cut jumps on is the one frame the take is not on screen
    const level = 1 - S(1 - Math.abs(2 * dip.p - 1))
    mv.alpha *= level; mv.shadow *= level
  }
  return mv
}

// The take's time output time t shows. Ranges are half open here: the frame at the
// instant a cut closes shows the moment after the cut, not the last moment before it
// (Timeline.srcTime keeps range ends inclusive for its round trip). A range carrying a
// rate walks its own closed form, so a 4x piece advances four source seconds an output
// second and every frame still solves from t alone.
function srcAt(keep, t) {
  let acc = 0
  for (let i = 0; i < keep.length; i++) {
    const seg = keep[i], len = Timeline.outSpan(seg)
    if (t < acc + len - 1e-9 || i === keep.length - 1) {
      return Math.min(seg[1], Timeline.srcIn(seg, Math.max(0, t - acc)))
    }
    acc += len
  }
  return t
}

// How fast the take itself is running at output time t, source seconds per output
// second. The cut window and the dissolve both measure in output seconds and both
// read source material, so both have to ask.
const rateAt = (keep, t) => Timeline.rateAt(keep, t)

// What a zoom shows at output time t, as fractions of the cropped frame, with the cut's
// push over it. The push tightens the window about its own centre, so what it asks for
// is always inside what the zoom already showed and no clamp is needed.
function viewAt(spec, t) {
  const z = Overlays.zoomView(spec.zooms, t, spec.ease)
  const [m] = pushAt(spec, t)
  if (m === 1) return [z.x, z.y, z.w, z.h]
  const w = z.w / m, h = z.h / m
  return [z.x + (z.w - w) / 2, z.y + (z.h - h) / 2, w, h]
}

// How fast a pixel of content is travelling on the output at time t, in output pixels
// per second. The analytic derivative of the same window, not a difference between two
// frames: the rule is that a frame draws from its own time alone, and this is what the
// shutter reads. Same four corners travel() walks, to first order in the rates.
function travelRate(spec, t) {
  const v = Overlays.zoomWindow(spec.zooms, t, spec.ease)
  const [m, dm] = pushAt(spec, t)
  // only the rates and the window's size are read below, so the push is chained into
  // those alone: where its centre sits does not change how fast anything is moving
  let { w: vw, h: vh, dx: vdx, dy: vdy, dw: vdw, dh: vdh } = v
  if (m !== 1) {
    // the same tightening viewAt applies, differentiated: a push settling out moves the
    // picture, so the shutter has to see it as travel like any other
    const w2 = vw / m, h2 = vh / m
    const dw2 = (vdw * m - vw * dm) / (m * m), dh2 = (vdh * m - vh * dm) / (m * m)
    vdx += (vdw - dw2) / 2; vdy += (vdh - dh2) / 2
    vw = w2; vh = h2; vdw = dw2; vdh = dh2
  }
  if (!(vw > 0)) return 0
  const { w, h } = spec.rect
  let most = 0
  for (const u of [0, 1]) for (const c of [0, 1]) {
    const dx = (vdx + u * vdw) / vw * w, dy = (vdy + c * vdh) / vh * h
    most = Math.max(most, Math.hypot(dx, dy))
  }
  return most
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
 * One output frame, at output time t (seconds): { t, s, s2, mix, view0, view1, taps,
 * speed, fade, camT }. s is the take's own time the frame shows; through a dissolve s2
 * is the other side's and mix is how much of it there is, 0 on one side of the cut and
 * 1 on the other. view0 and view1 bound the zoom's travel across the shutter; taps is
 * how many samples blur it, scaled with how far a pixel moves so a fast glide never
 * shows separate ghost copies of text.
 */
function framePlan(spec, t) {
  const { s, s2, mix } = srcPair(spec, t)
  let view0 = viewAt(spec, t), view1 = view0, taps = 1
  // What smears is the zoom's own speed at this instant, which is the derivative of the
  // ease. The dial is the shutter alone: motionBlur 1 is 360 degrees, 0.5 the film
  // standard 180. So a fast pass smears, a settle does not, and neither asks for a dial
  // to be turned up. Nothing at rest blurs, because the ease leaves and arrives with
  // zero velocity, so every held frame stays byte for byte what it was. A cut's push
  // moves the picture with no zoom in the edit at all, so it opens the shutter too.
  //
  // Speed does not need a second dial here, and that is worth saying because it looks
  // like it should. What the shutter must see is velocity per OUTPUT second, and every
  // zoom was placed on the output clock before this ran (prepare, clock(z.start)), so a
  // zoom inside a 4x piece is already a quarter as long in output seconds and its ease
  // already runs four times as fast. Read the rate here as well and the blur would be
  // scaled twice. The rate is on the frame plan (fp.rate) for anything that measures in
  // source seconds, and the one thing that genuinely does is the dissolve (srcPair).
  const moving = spec.zooms.length > 0 || (spec.cut && spec.cut.kind === 'zoom')
  const speed = moving ? travelRate(spec, t) : 0
  if (spec.motionBlur > 0 && moving) {
    const half = shutterHalf(spec, t, spec.motionBlur / spec.fps / 2)
    const a = viewAt(spec, t - half), b = viewAt(spec, t + half)
    // the chord is exact for the two ends of the exposure, the rate is right through a
    // turn in the middle of it; the longer of the two is what the samples have to cover
    const px = Math.max(travel(spec, a, b), speed * 2 * half)
    if (px > 0.75) { view0 = a; view1 = b; taps = Math.max(2, Math.min(32, Math.ceil(px / 1.5))) }
  }
  const fi = spec.fadeIn > 0 ? clamp(t / spec.fadeIn, 0, 1) : 1
  const fo = spec.fadeOut > 0 ? clamp((spec.span - t) / spec.fadeOut, 0, 1) : 1
  const camT = spec.cam ? Timeline.camTime(spec.cam, s) : null
  // Where the bubble is this frame. On the output clock, like the zooms: the bubble is
  // a thing placed in the video, not a moment of the camera take.
  const bubble = spec.cam ? camAt(spec.cam, t) : null
  // Each side of a dissolve reads the marks at its own side of the cut. Both sides are
  // playing inside the material the cut removed, and a mark is placed on the output
  // clock, where that material has no time at all: a redaction keyed to output time has
  // already ended on the boundary while the outgoing side runs on past it, so the frames
  // of the dissolve showed the secret. The outgoing side takes the last instant before
  // the cut and the incoming one the first instant after it, which is where their own
  // source times went when the clock closed the gap. cutPoints keeps the window clear of
  // anything the edit starts hiding inside the gap, which is the part no instant of the
  // output clock can speak for.
  const xd = mix > 0 ? cutAt(spec, t, 'crossfade') : null
  const marks = spec.marks ? Marks.at(spec.marks, xd ? Math.min(t, xd.b.t - CUT_EPS) : t) : null
  const marks2 = spec.marks && xd ? Marks.at(spec.marks, Math.max(t, xd.b.t)) : null
  return { t, s, s2, mix, view0, view1, taps, speed, rate: rateAt(spec.keep, t), fade: fi * fo, camT, bubble,
    marks, ...(marks2 ? { marks2 } : {}), move: takeMove(spec, t) }
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
  return frameMap(pts, spec.frames, n => srcPair(spec, n / spec.fps).s)
}
// And the other side of every dissolve: nothing at all except through a transition, so
// the second decode is a few runs of a few frames each and stops after the last of them
function crossFrames(spec, pts) {
  return frameMap(pts, spec.frames, n => srcPair(spec, n / spec.fps).s2)
}
// The camera's frames: its own clock, which starts late and runs through pauses
function cameraFrames(spec, pts) {
  return frameMap(pts, spec.frames, n => Timeline.camTime(spec.cam, srcAt(spec.keep, n / spec.fps)))
}

module.exports = { prepare, framePlan, camAt, srcAt, rateAt, srcPair, viewAt, travel, engineFor, unsupported, holdIndex, frameMap, screenFrames, crossFrames, cameraFrames, cutPoints, takeMove, rgb, markKey, edgeFor, SHELL }
