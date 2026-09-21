// What the compositor draws in the recording's own space, before any zoom, so a zoom
// carries it with the thing it marks: the Mac's pointer lifted out, redactions, blurs,
// lifts and spotlights, numbered steps, arrows and the agent's cursor. prepare() places every
// one on the output clock once per render; at() says what each looks like at a moment.
// Pure (test/plan.test.js, test/focus.test.js).
//
// Positions and sizes are content pixels: pixels of the cropped recording, whatever
// size the source is decoded or shown at. `px` is finished pixels per content pixel
// before any zoom, so anything sized for the finished frame (a badge 60 px across at
// 1080, a feather) is the same however large the recording is.
//
// The keys are the one thing here drawn in the output's own space instead (planKeys,
// keysAt): a keycap is Fetch's furniture rather than something on the recording, so a
// zoom must not carry it and must not scale it.
//
// What needs the take's pixels to place (a lift's measured box and corners, a step on
// its card's corner, a cursor rest moved off the words, the clean patches under the
// Mac's pointer) is worked out once per take by prepare.js in the main process and
// arrives as `prepared`; without it the marks are drawn where the edit put them.

const Overlays = require('../overlays')
const Pointer = require('../pointer')
const Touch = require('../touch')
const Focus = require('./focus')

const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
const kinds = new Set(['redact', 'blur', 'lift', 'spotlight', 'step', 'loupe', 'arrow'])
// the most of each kind one frame draws: the shaders take fixed-size arrays, and four
// arrows at once is nobody pointing at anything
const MAX = { erase: 8, redact: 8, blur: 4, loupe: 2, arrow: 4 }

// The lift a thing sits on, or -1: a step badge on a raised card and an arrow pointing
// at one both go up with it.
const liftAt = (focus, x, y, a, b, W, H) => focus.findIndex(f => f.shape.kind === 'lift' && a < f.tm.b && b > f.tm.a &&
  x >= f.shape.x - 0.02 * W && x <= f.shape.x + f.shape.w + 0.02 * W &&
  y >= f.shape.y - 0.02 * H && y <= f.shape.y + f.shape.h + 0.02 * H)

// A point on a raised piece, moved the way the piece moves: the same scale about the
// same centre and the same move in from the edge (focus.js nudge).
const onLift = (sh, L, x, y) => {
  const k = 1 + (sh.lift - 1) * L, ccx = sh.x + sh.w / 2, ccy = sh.y + sh.h / 2
  return { x: ccx + (x - ccx) * k + sh.nudge.dx * L, y: ccy + (y - ccy) * k + sh.nudge.dy * L }
}

// Whether a step's point is on a mark's box, give or take 2 percent of the frame
const onBox = (st, m, W, H) => {
  const x = +st.x || 0, y = +st.y || 0, slack = 0.02
  return x >= (+m.x || 0) - slack && x <= (+m.x || 0) + (+m.w || 0) + slack && y >= (+m.y || 0) - slack && y <= (+m.y || 0) + (+m.h || 0) + slack
}

// The zoom scale a span is mostly seen through
const seenIn = (zooms, a, b) => Math.max(1, ...(zooms || []).filter(z => z && Math.min(z.end, b) - Math.max(z.start, a) > 0.3).map(z => +z.scale || 1))

// ── arrows ──────────────────────────────────────────────────────────────────
// The light way to point at something. A zoom, a lift and a spotlight all rebuild the
// picture to say "this one"; an arrow says it and leaves the picture alone, which is
// what someone narrating over their own product does with their hand.
//
// It is Fetch's own furniture, so it is made of what the step badge is made of: gold,
// a white keyline and a soft shadow, and the geometry the app's icons have (Phosphor,
// BRAND.md) rather than clip art: a shaft of one weight with a round tail, and a plain
// head. It aims at a box like every other mark, sits a gap outside that box and points
// at the middle of the nearest edge, so the thing it points at is never under it.
//
// Sizes are finished pixels at 1080 through the zoom the arrow is seen in, as a badge's
// are, so an arrow is the same size whatever the recording's resolution and however far
// a zoom pushes in.
const ARROW = {
  len: 130, head: 38, half: 24, thick: 11,
  gap: 15,          // tip to the box it points at
  edge: 14,         // tail to the edge of what is on screen
  short: 0.55,      // how far it may be shortened to fit before it is not drawn at all
  slide: 0.18,      // how far back along its own line it comes in from, a share of its length
}
// `from` names the side it comes in from, so an arrow from the left points right. Left
// first, then top: an arrow crossing with the reading direction is the one the eye is
// already travelling along, and the rest in the order there is usually room in.
const SIDES = ['left', 'top', 'right', 'bottom']

/**
 * Where an arrow sits on the cropped recording, content pixels.
 *   m     the mark: the box it aims at, fractions of the cropped frame, and `from`
 *   out   finished pixels per content pixel, through the zoom it is seen in
 *   view  what is on screen while it is up, fractions of the cropped frame. The side
 *         and the length are settled against this rather than against the recording:
 *         a zoom carries the arrow with the thing it points at, so a side picked
 *         against the whole frame stood the arrow outside the window it is seen in.
 *   size  the look's focus.arrow
 * Returns { dir, ux, uy, tip, len, head, half, thick, hair, slide }, or null where the
 * box leaves no room on any side, which is a box that fills the window: there is no
 * outside left to point from, and a clipped arrow is worse than none.
 */
function arrowShape(m, W, H, out = 1, view = null, size = 1) {
  const u = 1 / Math.max(1e-3, out), k = clamp(+size || 1, 0.6, 1.8)
  const bx = clamp(+m.x || 0, 0, 1) * W, by = clamp(+m.y || 0, 0, 1) * H
  const bw = Math.max(2, Math.min(W - bx, (+m.w > 0 ? +m.w : 0.12) * W))
  const bh = Math.max(2, Math.min(H - by, (+m.h > 0 ? +m.h : 0.08) * H))
  const v = view ? { x: view.x * W, y: view.y * H, w: view.w * W, h: view.h * H } : { x: 0, y: 0, w: W, h: H }
  const len = ARROW.len * u * k, half = ARROW.half * u * k, gap = ARROW.gap * u * k, edge = ARROW.edge * u
  const cx = bx + bw / 2, cy = by + bh / 2
  const tips = {
    left: [1, 0, bx - gap, cy], right: [-1, 0, bx + bw + gap, cy],
    top: [0, 1, cx, by - gap], bottom: [0, -1, cx, by + bh + gap],
  }
  // How much of the window is left behind each tip for the body to stand in, and where
  // the tip goes across it so the head is inside the window too.
  const fit = name => {
    const [ux, uy, tx, ty] = tips[name]
    // Along the way it points: the tip has to be inside what is on screen. A box below
    // or beside the window has no near edge in the picture at all, and a side picked on
    // the room behind the tip alone put the whole arrow off the side of a 2x window,
    // where nobody saw it.
    const along = ux ? tx : ty
    const aLo = (ux ? v.x : v.y) + edge, aHi = (ux ? v.x + v.w : v.y + v.h) - edge
    if (along < aLo || along > aHi) return null
    const back = ux > 0 ? along - aLo : ux < 0 ? aHi - along : uy > 0 ? along - aLo : aHi - along
    const lo = (ux ? v.y : v.x) + edge + half, hi = (ux ? v.y + v.h : v.x + v.w) - edge - half
    if (hi < lo) return null
    const c = clamp(ux ? ty : tx, lo, hi)
    // And across it: the tip starts at the middle of the box's nearest edge, and the
    // window may only slide it along that edge. Pushed off the box entirely it points
    // at whatever happens to be there, which on a 2x window was content 500 px away.
    const from = ux ? by : bx, to = ux ? by + bh : bx + bw
    if (c < from || c > to) return null
    return { name, ux, uy, back, x: ux ? tx : c, y: ux ? c : ty }
  }
  // the side it was asked for first, and the others behind it: a named side with no
  // room left is still an arrow that has to be drawn somewhere
  const named = typeof m.from === 'string' && tips[m.from] ? [m.from, ...SIDES.filter(q => q !== m.from)] : SIDES
  const tried = named.map(fit).filter(Boolean)
  if (!tried.length) return null
  const best = tried.find(f => f.back >= len) || tried.reduce((a, b) => (b.back > a.back ? b : a))
  if (best.back < len * ARROW.short) return null
  const L = Math.min(len, best.back)
  return {
    dir: best.name, ux: best.ux, uy: best.uy, tip: { x: best.x, y: best.y },
    len: L, head: ARROW.head * u * k, half, thick: ARROW.thick * u * k,
    hair: Math.max(1, 1.5 * u), slide: ARROW.slide * L,
  }
}

/**
 * Place the marks of an edit.
 *   marks     the edit's marks (prepared ones when the take was read), source clock,
 *             fractions of the cropped frame
 *   W, H      the cropped frame in content pixels
 *   px        finished pixels per content pixel before any zoom
 *   clock     source seconds to output seconds (Timeline.outClock)
 *   span      output length
 *   zooms     on the output clock; lifts may re-frame them (Focus.reframe)
 *   ease      the look's motion.zoomEase, so a mark riding a zoom takes that zoom's
 *             own ramp rather than the default one
 *   look      { dim, lift, loupe, arrow } from the look's focus section
 * Returns { redact, blur, focus, steps, loupe, arrow, zooms }.
 */
function planMarks(marks, { W, H, px, clock, span, zooms, ease, look = {} }) {
  const on = (marks || []).filter(m => m && kinds.has(m.kind)).map(m => ({ ...m, a: clock(+m.start), b: clock(+m.end) }))
  const out = { redact: [], blur: [], focus: [], steps: [], loupe: [], arrow: [], zooms }

  for (const m of on) {
    if (!(m.b > m.a)) continue
    const x = clamp(+m.x || 0, 0, 1) * W, y = clamp(+m.y || 0, 0, 1) * H
    const w = Math.max(2, Math.min(W - x, (+m.w || 0.2) * W)), h = Math.max(2, Math.min(H - y, (+m.h || 0.1) * H))
    if (m.kind === 'redact') {
      // A redaction destroys what is under it: cells at least 16 finished pixels across
      // and never fewer than about three and a half to the box's short side, each one
      // the mean of what it covers, so no letter survives at any zoom, large type
      // included. It is on from its first frame to its last, never faded, since a fade
      // shows the secret.
      out.redact.push({ a: m.a, b: m.b, x, y, w, h, cell: Math.max(4, Math.round(16 / px), Math.round(Math.min(w, h) / 3.5)) })
    } else if (m.kind === 'blur') {
      // Gaussian, for softening something distracting (redact is for secrets), through a
      // round-cornered mask, easing in and out.
      //
      // The mask used to feather over about 1 percent of the height, which at 1720 lines
      // is twenty pixels, wider than the corner it was rounded with: magnified, the mark
      // was a soft blob with no boundary anywhere, and a viewer reads that as a render
      // that went wrong rather than as something deliberately hidden. It is a plate now:
      // a crisp corner, feathered over about two finished pixels so it antialiases and
      // no further, with its own hairline inside the edge.
      const F = Math.max(1, 2 / (px || 1))
      const T = Math.min(0.35, (m.b - m.a) / 3)
      // it arrives deliberately and gets out of the way: the leave is the shorter one
      const TO = Overlays.leaveOf(T, (m.b - m.a) / 3)
      out.blur.push({ a: m.a, b: m.b, x, y, w, h, r: Math.min(H * 0.014, w / 2, h / 2), feather: F, hair: Math.max(1, 1.5 / (px || 1)),
        sigma: clamp(+m.strength || 18, 4, 60),
        Tin: T < 0.04 || m.a <= 0.05 ? 0 : T, Tout: T < 0.04 || m.b >= span - 0.05 ? 0 : TO })
    }
  }

  // Lifts and spotlights: shaped through the zoom they are seen in, and the zooms a
  // lift rides framed round it
  const focus = on.filter(m => m.kind === 'lift' || m.kind === 'spotlight')
    .map(m => ({ m, tm: Overlays.focusTiming({ ...m, start: m.a, end: m.b }, zooms, ease) }))
    .filter(f => f.tm && f.tm.b > f.tm.a + 0.2)
  const shapeOf = (f, zs) => Focus.shape(f.m, W, H, px * seenIn(zs, f.tm.a, f.tm.b), look)
  // a step badge on a lifted card rises with it, and the frame has to hold it too
  const riders = f => {
    const rides = st => st.kind === 'step' && st.a < f.tm.b && st.b > f.tm.a && onBox(st, f.m, W, H)
    return on.some(rides) ? Overlays.stepSize(H, px * seenIn(zooms, f.tm.a, f.tm.b)).D * 0.8 : 0
  }
  const lifts = focus.filter(f => f.m.kind === 'lift')
    .map(f => ({ tm: f.tm, box: { x: +f.m.x || 0, y: +f.m.y || 0, w: +f.m.w || 0.2, h: +f.m.h || 0.1 }, shape: { ...shapeOf(f, zooms), margin: riders(f) } }))
  out.zooms = Focus.reframe(zooms, lifts, W, H)
  for (const f of focus) {
    const s = shapeOf(f, out.zooms)
    if (s.kind === 'lift') s.margin = riders(f)
    if (s.kind === 'lift') {
      // what is on screen while it is fully up: the zoom it rides at its hold, or all of it
      const mid = (Math.max(f.tm.a + f.tm.Tin, Math.min(f.tm.b - f.tm.Tout, (f.tm.a + f.tm.b) / 2)))
      const v = Overlays.zoomView(out.zooms, mid)
      s.nudge = Focus.nudge(s, { x: v.x, y: v.y, w: v.w, h: v.h }, W, H)
    }
    out.focus.push({ tm: f.tm, shape: s })
  }

  // Loupes, after the zooms are settled: sized through the zoom each is mostly seen in,
  // like a lift, so the inset's gap, its corner and its hairline are for the finished
  // frame rather than for the recording's own resolution, and placed inside what that
  // zoom shows, so the inset never lands off the side of the window.
  for (const m of on) {
    if (m.kind !== 'loupe' || !(m.b > m.a)) continue
    const T = Math.min(0.32, (m.b - m.a) / 3)
    const mid = Math.max(m.a + T, Math.min(m.b - T, (m.a + m.b) / 2))
    const v = Overlays.zoomView(out.zooms, mid)
    const s = Focus.loupeShape(m, W, H, px * seenIn(out.zooms, m.a, m.b), look.loupe, { x: v.x, y: v.y, w: v.w, h: v.h })
    if (!s) continue
    out.loupe.push({ a: m.a, b: m.b, ...s,
      Tin: T < 0.04 ? 0 : T, Tout: T < 0.04 ? 0 : Overlays.leaveOf(T, (m.b - m.a) / 3) })
  }

  // Arrows, after the zooms are settled, for the same reason a loupe is: the side one
  // comes in from is a question about what is on screen, and the zoom decides that.
  for (const m of on) {
    if (m.kind !== 'arrow' || !(m.b > m.a + 0.1)) continue
    const { IN, OUT } = Overlays.stepFade(m.a, m.b)
    const mid = Math.max(m.a + IN, Math.min(m.b - OUT, (m.a + m.b) / 2))
    const v = Overlays.zoomView(out.zooms, mid)
    // Sized by the window it is actually seen in, at the same instant the side is
    // picked, and not by the deepest zoom anywhere in its life: a 0.5 s push at 4x
    // beside a seven second arrow drew that arrow at a quarter of its size for all
    // seven of them.
    const s = arrowShape(m, W, H, px * Math.max(1, +v.s || 1), { x: v.x, y: v.y, w: v.w, h: v.h }, look.arrow)
    if (!s) continue
    // pointing at a card that is lifted, it goes up with the card. The tip and the
    // card's edge are scaled about the same centre, so the gap between them grows with
    // the piece and the arrow cannot land on it.
    const lift = liftAt(out.focus, (+m.x || 0) * W + (+m.w > 0 ? +m.w : 0.12) * W / 2,
      (+m.y || 0) * H + (+m.h > 0 ? +m.h : 0.08) * H / 2, m.a, m.b, W, H)
    out.arrow.push({ a: m.a, b: m.b, IN, OUT, ...s, lift })
  }

  // Numbered steps, sized for the finished frame through the zoom they are seen in, a
  // step with no number of its own counting in order among the steps
  let k = 0
  for (const m of on) {
    if (m.kind !== 'step') continue
    const label = Overlays.stepLabel(m, ++k)
    if (!(m.b > m.a + 0.1)) continue
    const { D, ring } = Overlays.stepSize(H, px * seenIn(out.zooms, m.a, m.b))
    const R = D / 2, edge = R + D * 0.2
    // on a card's corner found in the picture the badge sits a little up and out from it
    const ox = m.corner ? -D * 0.18 : 0, oy = m.corner ? -D * 0.18 : 0
    const cx = clamp((+m.x || 0) * W + ox, edge, W - edge), cy = clamp((+m.y || 0) * H + oy, edge, H - edge)
    // a step on a lifted card rises with it (see at)
    const lift = liftAt(out.focus, (+m.x || 0) * W, (+m.y || 0) * H, m.a, m.b, W, H)
    out.steps.push({ a: m.a, b: m.b, ...Overlays.stepFade(m.a, m.b), cx, cy, D, ring, label, lift })
  }
  // badges that end together clear in the order they arrived, not all on one frame
  Overlays.stepLeads(out.steps).forEach((lead, i) => { out.steps[i].gone = out.steps[i].b - lead })
  return out
}

/**
 * The Mac's pointer lifted out: where the recording shows it, and what covers it.
 *   spans   processor.macCursorSpans (source clock, fractions of the whole frame)
 *   plates  processor.cursorPlates, per span index [{ a, b, file, x, y, w, h }] in
 *           source pixels and clock (prepare.js adds w and h)
 *   src     { w, h } the recording, crop { x, y } its offset in source pixels
 * Where a rest has a clean patch of the same spot it is laid over; everything else is
 * filled from the box's edges, as ffmpeg's delogo did.
 */
function planErase(spans, plates, { src, crop, content, clock, end, span }) {
  const out = []
  const on = (a, b) => {
    const A = clock(a), B = Math.min(clock(Math.min(b, end)), span)
    return B - A > 0.02 ? [A, B] : null
  }
  ;(spans || []).forEach((s, i) => {
    let open = [[s.a, s.b]]
    for (const p of (plates && plates[i]) || []) {
      const t = on(p.a, p.b)
      if (t && p.file && p.w > 0 && p.h > 0) out.push({ a: t[0], b: t[1], plate: { file: p.file, x: p.x - crop.x, y: p.y - crop.y, w: p.w, h: p.h } })
      open = open.flatMap(([a, b]) => [[a, Math.min(b, p.a)], [Math.max(a, p.b), b]]).filter(([a, b]) => b > a)
    }
    for (const q of s.pieces || [s]) {
      const x0 = Math.max(1, Math.round(q.x * src.w) - crop.x), y0 = Math.max(1, Math.round(q.y * src.h) - crop.y)
      const x1 = Math.min(content.w - 1, Math.round((q.x + q.w) * src.w) - crop.x), y1 = Math.min(content.h - 1, Math.round((q.y + q.h) * src.h) - crop.y)
      if (x1 - x0 < 3 || y1 - y0 < 3) continue
      for (const [a, b] of open) {
        const t = on(a, b)
        if (t) out.push({ a: t[0], b: t[1], fill: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } })
      }
    }
  })
  return out
}

/**
 * How wide the touch disc is, in content pixels: a 44 point touch target measured
 * through the device's own screen, so it is a fingertip on a handset and a fingertip on
 * a 13 inch tablet rather than right on exactly one of them (ui/touch.js discPixels).
 *
 * The viewport is fractions of the recorded window and the content is a crop of that
 * window, so the measure is taken against the whole window's width in content pixels,
 * `W / crop.w`. Without a device, or with a viewport the document cannot vouch for, the
 * fallback is the click ripple's own diameter: the mark Fetch already draws where a
 * click landed, sized off the frame, rather than a physical size guessed confidently.
 */
function discSize(L, device, W, crop) {
  const c = crop && crop.w > 0 ? crop.w : 1
  const ripple = 2 * Math.max(L.size * 1.1, 14 * L.unit)
  if (!device || !device.screen) return ripple
  try {
    return Touch.discPixels({ screen: device.screen, viewport: device.viewport, W: W / c }) || ripple
  } catch { return ripple }
}

/**
 * The agent's cursor, from its track (Pointer.cursorLayout): where it glides, when it
 * presses, when Biscuit's badge and name show and the ripples of its clicks.
 *   size    the look's cursor.size, 1 is about 30 px tall at 1080
 *   ripple  the look's cursor.ripple
 *   style   the look's cursor.style: 'arrow' is the cursor, 'touch' is a finger
 *   device  { screen, viewport } of the simulator this take was of, for the disc's size
 */
function planPointer(points, { W, H, clock, crop, scale, span, px, zooms, size = 1, ripple = true, style = 'arrow', device = null }) {
  if (!Array.isArray(points) || !points.length) return null
  // cursorLayout sizes the arrow for the finished frame from px; a larger cursor is the
  // same arrow for a frame with fewer pixels per content pixel
  const L = Pointer.cursorLayout(points, { W, H, clock, crop, scale, end: span, out: px / clamp(+size || 1, 0.6, 2), zooms })
  if (!L) return null
  // A finger is not on the glass between taps, so a touch take is its touches and
  // nothing in between: no glide from one tap to the next, no badge, no name tag, no
  // ripple, because the disc is the mark the ripple would have been under. Everything
  // before this point is shared on purpose: the output clock, the crop, the zoom fit and
  // the size are the same work whether the track came off a mouse or off a device, and a
  // tap is a position and a moment exactly as a click is (ui/touch.js).
  if (style === 'touch') {
    const tp = Touch.planTouch(L.pts)
    if (!tp) return null
    // The empty lists are the refusal written down rather than left to be inferred: a
    // touch take has no click ripple, no Biscuit badge and no name tag on it.
    return { touch: tp, disc: discSize(L, device, W, crop), stop: Math.max(L.stop, tp.stop),
      clicks: [], badge: [], tags: [], rippleOn: false }
  }
  const { BADGE, LOOK, TAG } = Pointer
  const d = 2 * Math.max(4, Math.round(BADGE.r * L.size), Math.round(LOOK.badgeMin * L.unit / 2))
  const br = Math.max(BADGE.r * L.size, LOOK.badgeMin * L.unit / 2)
  const tagH = br * 1.62, tagFs = tagH * 0.6
  // the name's width as the rounded bold sets it, near enough to decide which side it goes
  const tagW = br + tagH * 0.24 + TAG.text.length * tagFs * 0.56 + tagH * 0.42
  const clicks = L.pts.filter(p => p.click).map(p => {
    // a press finishes before the next glide leaves (pointer.js drawCursor)
    const next = L.pl.moves.find(m => m.from > p.t - 0.005)
    const room = clamp((next ? next.from : L.stop) - p.t, 0.04, 0.25)
    return { t: p.t, x: p.x, y: p.y, room }
  })
  return {
    pl: L.pl, size: L.size, k: L.k, unit: L.unit, stop: L.stop, d, br, tagH, tagFs, tagW,
    badge: Pointer.badgeSpans(L.pl), tags: Pointer.tagSpans(L, tagW), clicks,
    ripple: Math.max(L.size * 1.1, 14 * L.unit), rippleOn: ripple !== false,
  }
}

// ── keys on screen ──────────────────────────────────────────────────────────
// A demo where someone hits Cmd+K and a palette appears is incomprehensible without the
// keys, so Fetch draws them. Not as a gamer overlay: they are caps made of the step
// badge's own furniture (a soft shadow, a keyline, the badge's gold on the one key that
// did something), in the take's bottom corner, where a product's own content rarely is
// and the palette a chord opens never is.
//
// **Fetch does not capture keystrokes today and this round does not add it.** Reading
// the keyboard needs a CGEvent tap and the Input Monitoring permission, which is a
// privacy surface of its own: the recorder polls the mouse buttons for exactly that
// reason (Recorder.swift, pollClick). So this is the drawing side alone, against one
// clear input shape, source seconds, on the edit document:
//
//   edit.keys = [{ t, key, mods, char }]
//     key   what went down: 'k', 'enter', 'esc', 'tab', 'space', 'up', 'f5', ...
//     mods  what was held with it: 'cmd', 'ctrl', 'alt', 'shift', 'fn'
//     char  what it typed, and only where the capture knows it was safe to show
//
// The last line is the privacy rule and it is one line of code: a character is drawn
// only where the event carries one. Nothing here infers a character from `key`, so a run
// of typing nobody vouched for reads `typing…` and never the letters, and a run with one
// unvouched key in it is hidden whole rather than in part. A password is typed into a
// field macOS has put into secure input, which the capture can ask about and the drawing
// side cannot, so the drawing side assumes it cannot tell. A modified key is a command
// rather than content and is named from `key`: nobody's password is Cmd+Shift+P.
const MOD_CANON = { cmd: 'cmd', meta: 'cmd', command: 'cmd', ctrl: 'ctrl', control: 'ctrl',
  alt: 'alt', opt: 'alt', option: 'alt', shift: 'shift', fn: 'fn' }
// The Mac's own glyphs, in the Mac's own order, because that is what is printed on the
// keys in front of the person watching. Everything else is a word or the arrow itself,
// which survives being read at a glance on a phone.
const MOD_GLYPH = { fn: 'fn', ctrl: '⌃', alt: '⌥', shift: '⇧', cmd: '⌘' }
const MOD_ORDER = ['fn', 'ctrl', 'alt', 'shift', 'cmd']
const KEY_NAMES = {
  enter: 'Return', return: 'Return', escape: 'Esc', esc: 'Esc', tab: 'Tab', space: 'Space',
  backspace: 'Delete', delete: 'Delete', up: '↑', down: '↓', left: '←', right: '→',
  home: 'Home', end: 'End', pageup: 'Page up', pagedown: 'Page down',
}
const keyName = k => {
  const s = String(k == null ? '' : k).toLowerCase()
  return KEY_NAMES[s] || (/^f([1-9]|1[0-2])$/.test(s) ? s.toUpperCase() : null)
}

const KEY = {
  h: 0.056,      // a cap's height, a share of the output's own height: 60 px at 1080
  gap: 0.010,    // between the caps of one chord
  inset: 0.030,  // from the corner it sits in
  pad: 0.34,     // a cap's side padding, a share of its height
  text: 0.40,    // and its label, ditto
  radius: 0.22,  // the compact 10 px corner (BRAND.md), grown with the cap
  hold: 0.9,     // how long a chord stays up: long enough to read, short enough to keep up
  join: 0.6,     // typing this close carries on the same run
  tail: 0.7,     // and a run leaves this long after its last key
  arrive: 0.14,  // --dur-1 and a little, since it travels as well as fades
  chars: 22,     // the most a typing pill shows, which is its tail
  life: 0.08,    // under this a group is not drawn at all: a flash is worse than nothing
  max: 6,        // caps in one frame
}

/**
 * The keys of an edit, placed on the output clock and on the frame.
 *   keys      the edit's key track, source clock
 *   W, H      the output frame
 *   box       what the strip sits in the corner of: the framed take, or the whole frame
 *   capBox    what the captions are laid out against (plan.js), for staying off them
 *   caption   the look's caption style while captions are burned in, else null
 *   clock     source seconds to output seconds (Timeline.outClock)
 *   span      output length
 *   place     the look's keys.place, size its keys.size, show its keys.show
 * Returns the anchor, the metrics and the groups, or null where nothing shows.
 */
function planKeys(keys, { W, H, box, capBox = null, caption = null, clock, span, place = 'left', size = 1, show = true }) {
  if (show === false || !Array.isArray(keys) || !keys.length) return null
  const k = clamp(+size || 1, 0.7, 1.6)
  const capH = H * KEY.h * k
  const on = keys
    .filter(e => e && Number.isFinite(+e.t) && (!clock.kept || clock.kept(+e.t)))
    .map(e => ({ ...e, t: clock(+e.t) }))
    .filter(e => e.t >= 0 && e.t < span)
    .sort((a, b) => a.t - b.t)
  const groups = []
  let run = null
  const closeRun = () => {
    if (!run) return
    // A run with a single unvouched key in it is hidden whole: half a sentence with the
    // secret parts missing is still the secret's shape.
    const shown = run.chars.every(c => typeof c[1] === 'string')
    // A vouched run is typed out as it was typed, so the pill grows under the person's
    // own hands (keysAt); an unvouched one says the same thing at every moment of itself,
    // because how many keys went down is the length of what was typed.
    groups.push({ a: run.a, last: run.t, hold: KEY.tail, ...(shown ? { chars: run.chars } : {}),
      caps: [{ label: 'typing…', role: 'hint', face: 'sub' }] })
    run = null
  }
  for (const e of on) {
    const mods = [...new Set((Array.isArray(e.mods) ? e.mods : []).map(m => MOD_CANON[String(m).toLowerCase()]).filter(Boolean))]
    const command = mods.some(m => m !== 'shift')
    const named = keyName(e.key)
    const char = typeof e.char === 'string' && e.char.length ? e.char : null
    // A space with a run open is that run's own space, not a cap of its own: broken into
    // caps, a typed sentence reads as three chords and a word.
    if (!command && named === 'Space' && run && e.t - run.t <= KEY.join) { run.chars.push([e.t, char || ' ']); run.t = e.t; continue }
    if (command || named) {
      closeRun()
      const label = named || String(char || e.key || '').toUpperCase()
      if (!label) continue
      const caps = mods.sort((a, b) => MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b))
        .map(m => ({ label: MOD_GLYPH[m], role: 'mod', face: 'sub' }))
      caps.push({ label, role: 'action', face: 'caption' })
      const prev = groups[groups.length - 1]
      // A key held down, or hit three times: one cap with a count, rather than the same
      // cap flashing three times in half a second. The count is kept off the comparison,
      // or the third press would no longer look like the first two.
      if (prev && prev.hold === KEY.hold && e.t - prev.last <= KEY.hold && sameCaps(prev.base, caps)) {
        prev.n = (prev.n || 1) + 1; prev.last = e.t
        prev.caps = [...prev.base.slice(0, -1), { ...caps[caps.length - 1], label: `${label} ×${prev.n}` }]
        continue
      }
      groups.push({ a: e.t, last: e.t, hold: KEY.hold, caps, base: caps })
      continue
    }
    if (run && e.t - run.t <= KEY.join) { run.chars.push([e.t, char]); run.t = e.t }
    else { closeRun(); run = { a: e.t, t: e.t, chars: [[e.t, char]] } }
  }
  closeRun()

  // A burst nobody can read one cap at a time is one sequence, not nothing. Each group's
  // end is clamped to the next one's start below, so keys landing a twentieth of a second
  // apart, which is a vim run or a shortcut run, used to clamp each other under KEY.life
  // and drop the lot: the demo the feature exists for drew an empty strip. Folded in the
  // order they were pressed and held to the last KEY.max of them, which is the tail the
  // typing pill keeps for the same reason. A run of typing keeps its own pill: it is
  // already one object and folding a chord into it would read as a typo.
  const packed = []
  for (const g of groups) {
    const prev = packed[packed.length - 1]
    if (prev && !prev.chars && !g.chars && g.a - prev.last <= KEY.life) {
      prev.seq = prev.seq || [[prev.last, prev.caps]]
      prev.seq.push([g.last, g.caps])
      prev.base = g.base; prev.last = g.last; prev.n = g.n
      continue
    }
    packed.push(g)
  }

  // One group is on screen at a time: a new one pushes the one before it out rather than
  // landing on top of it, so the strip stays a single object in a fixed place.
  const out = []
  packed.forEach((g, i) => {
    const next = packed[i + 1]
    const b = Math.min(g.last + g.hold, next ? next.a : Infinity, span)
    if (!(b - g.a > KEY.life)) return
    const Tin = Math.min(KEY.arrive, (b - g.a) / 2)
    out.push({ a: g.a, b, Tin, Tout: Overlays.leaveOf(Tin, (b - g.a) / 2), caps: g.caps.slice(0, KEY.max),
      ...(g.seq ? { seq: g.seq } : {}), ...(g.chars ? { chars: g.chars } : {}) })
  })
  if (!out.length) return null

  const B = box && box.w > 0 ? box : { x: 0, y: 0, w: W, h: H }
  const inset = H * KEY.inset
  const below = H - (B.y + B.h)
  const band = caption ? Overlays.captionLayout(W, H, caption, capBox || B) : null
  // Outside the picture wherever the look leaves room under the take, because furniture
  // standing on the ground cannot cover what is being demonstrated at all. The caption
  // band is that same room and it was there first.
  const outside = below >= capH + 2 * inset && !(band && band.band)
  // Hung an inset under the take rather than centred in whatever ground there is: on a
  // 9:16 clip the ground is half the frame, and the strip belongs to the picture.
  let y = outside ? B.y + B.h + inset + capH : B.y + B.h - inset
  // Inside the take with the captions inside it too, the strip goes above them: two
  // lines up, because a phrase may wrap to a second line and a cap may not land on it.
  if (!outside && band && !band.band && band.an === 2) y = Math.min(y, band.y - 2.4 * band.px - inset * 0.5)
  y = Math.max(capH + inset, y)
  const dir = place === 'right' || place === 'centre' ? place : 'left'
  const x = dir === 'right' ? B.x + B.w - inset : dir === 'centre' ? B.x + B.w / 2 : B.x + inset
  return { groups: out, dir, x, y, capH, gap: H * KEY.gap * k, pad: capH * KEY.pad, text: capH * KEY.text, r: capH * KEY.radius }
}

const sameCaps = (a, b) => a.length === b.length && a.every((c, i) => c.label === b[i].label && c.role === b[i].role)
// What a group says at a moment. A chord says one thing for its whole life; a run of
// typing is typed out, so the pill holds what had been typed by t and grows the way a
// field does, and past what it can hold it keeps the tail, which is where the caret is.
const capsOf = (g, t) => {
  // A folded burst grows the same way, so the strip never shows a key that has not been
  // pressed yet, and it keeps the tail for the same reason the pill does.
  if (g.seq) return g.seq.filter(x => x[0] <= t).flatMap(x => x[1]).slice(-KEY.max)
  if (!g.chars) return g.caps
  const s = g.chars.filter(c => c[0] <= t).map(c => c[1]).join('')
  if (!s) return []
  return [{ label: s.length > KEY.chars ? '…' + s.slice(-KEY.chars) : s, role: 'text', face: 'SF Mono' }]
}
// A width when no canvas is at hand (loopCheck, tests): the two ends of a loop are
// compared against each other, so a guess that is wrong the same way at both is enough.
const KEY_MEASURE = (s, px) => String(s).length * px * 0.6

/**
 * The caps on screen at output time t, in the plan's own pixels: where each sits, how
 * far in it is, and what it says. measure(text, px, face) is the compositor's (text.js
 * canvasMeasure), which caches per string and size.
 */
function keysAt(K, t, measure = KEY_MEASURE) {
  if (!K) return null
  const caps = []
  for (const g of K.groups) {
    const op = Overlays.fadeLevel(t, g.a, g.b, g.Tin, g.Tout)
    if (!(op > 0.002)) continue
    // it comes up from under its own line and settles, the way everything else in the
    // house arrives: --ease-in on the move, the S on the alpha (DESIGN.md, Motion)
    const p = g.Tin > 0 ? clamp((t - g.a) / g.Tin, 0, 1) : 1
    const rise = (1 - Overlays.MOVE(p)) * K.capH * 0.22
    const grow = 0.96 + 0.04 * Overlays.MOVE(p)
    const list = capsOf(g, t)
    if (!list.length) continue
    const w = list.map(c => Math.max(K.capH, 2 * K.pad + measure(c.label, K.text, c.face)))
    const total = w.reduce((a, b) => a + b, 0) + K.gap * (list.length - 1)
    let x = K.dir === 'right' ? K.x - total : K.dir === 'centre' ? K.x - total / 2 : K.x
    list.forEach((c, i) => {
      caps.push({ ...c, x, y: K.y - K.capH + rise, w: w[i], h: K.capH, r: K.r, text: K.text, op, grow })
      x += w[i] + K.gap
    })
  }
  return caps.length ? { caps } : null
}

// ── one moment ───────────────────────────────────────────────────────────
const RIPPLE = 0.56, FADE_IN = 0.16

// A tap arrives and leaves the way a badge does, in the one part of a badge's manner a
// finger has: it grows in on the way down and settles back as it lifts, with no
// overshoot, because a finger does not bounce. Written against the presence ui/touch.js
// already solved, so it stays a closed form of the time since the tap and any frame
// still draws alone: op runs 0 to 1 over the approach and 1 back to 0 over the lift.
const GROW = { down: 0.82, up: 0.92 }
const growOf = d => (d.age < 0 ? GROW.down + (1 - GROW.down) * d.op : GROW.up + (1 - GROW.up) * d.op)

/**
 * Everything drawn in content space at output time t, from planMarks, planErase and
 * planPointer: { erase, redact, blur, focus, steps, pointer, touch }, each only what
 * shows. `pointer` is the agent's cursor and `touch` the discs of a touch take; a plan
 * carries one or the other, never both.
 */
function at(m, t) {
  const live = x => t >= x.a && t < x.b
  const out = {
    erase: (m.erase || []).filter(live).slice(0, MAX.erase + 16),
    redact: (m.redact || []).filter(live).slice(0, MAX.redact),
    blur: [], focus: [], steps: [], loupe: [], arrow: [], pointer: null, touch: [],
  }
  for (const b of m.blur || []) {
    if (!live(b)) continue
    const op = Overlays.fadeLevel(t, b.a, b.b, b.Tin, b.Tout)
    if (op > 0.002 && out.blur.length < MAX.blur) out.blur.push({ ...b, op })
  }
  for (const g of m.loupe || []) {
    if (!live(g)) continue
    const op = Overlays.fadeLevel(t, g.a, g.b, g.Tin, g.Tout)
    // it arrives by settling out of its own area rather than by appearing: the inset
    // grows the last twelfth of the way in while it fades, which is the same arrival a
    // step badge has without the overshoot
    if (op > 0.002 && out.loupe.length < MAX.loupe) out.loupe.push({ ...g, op, scale: 0.94 + 0.06 * op })
  }
  const lifted = []
  for (const f of m.focus || []) {
    const level = Focus.level(f.tm, t)
    lifted.push(level)
    if (level > 0.001) out.focus.push({ shape: f.shape, level })
  }
  for (const s of m.steps || []) {
    if (t < s.a || t >= s.gone) continue
    let scale, op
    // It lands with a pop and clears by shrinking away: the shape rides --ease-out, as
    // DESIGN.md says a leave should, and the alpha rides the S (Overlays.fadeLevel),
    // which is what stops 200 ms of leaving reading as 80 ms of blink.
    if (t < s.a + s.IN) { const p = (t - s.a) / s.IN; scale = 0.35 + 0.65 * Overlays.POP(p); op = Math.min(1, p * 2.2) }
    else if (t >= s.gone - s.OUT) {
      const p = (t - (s.gone - s.OUT)) / s.OUT
      scale = 1 - 0.2 * Overlays.EASE_OUT(p); op = Overlays.MOVE(1 - p)
    } else { scale = 1; op = 1 }
    let cx = s.cx, cy = s.cy
    // on a lifted card: the same scale about the same centre, and the same move in
    const f = s.lift >= 0 && m.focus[s.lift]
    if (f && lifted[s.lift] > 0) {
      const q = onLift(f.shape, lifted[s.lift], cx, cy)
      cx = q.x; cy = q.y
    }
    if (op > 0.002) out.steps.push({ cx, cy, D: s.D, ring: s.ring, label: s.label, scale, op })
  }
  // An arrow arrives and leaves the way a badge does, on the badge's own curves: the
  // shape rides the pop and then --ease-out, the alpha rides the S. The difference is
  // where it is anchored. A badge grows about its centre; an arrow grows about its tip,
  // and slides in along its own line from further out, so the tip travels toward what it
  // points at, stops at the gap, and is never carried past it by the pop's overshoot.
  // It leaves by backing off the same way, which is what "it appears, it points, it
  // goes" has to look like.
  for (const a of m.arrow || []) {
    if (t < a.a || t >= a.b) continue
    let grow, op, back
    if (t < a.a + a.IN) { const p = (t - a.a) / a.IN; grow = 0.58 + 0.42 * Overlays.POP(p); op = Math.min(1, p * 2.2); back = a.slide * (1 - Overlays.MOVE(p)) }
    else if (t >= a.b - a.OUT) {
      const p = (t - (a.b - a.OUT)) / a.OUT, e = Overlays.EASE_OUT(p)
      grow = 1 - 0.16 * e; op = Overlays.MOVE(1 - p); back = a.slide * 0.55 * e
    } else { grow = 1; op = 1; back = 0 }
    if (!(op > 0.002) || out.arrow.length >= MAX.arrow) continue
    let { x, y } = a.tip
    const f = a.lift >= 0 && m.focus[a.lift]
    if (f && lifted[a.lift] > 0) { const q = onLift(f.shape, lifted[a.lift], x, y); x = q.x; y = q.y }
    out.arrow.push({ ...a, op, grow, x: x - a.ux * back, y: y - a.uy * back })
  }

  // A point on a lifted card rides the card, whichever mark is drawn there.
  const rideLift = (x, y) => {
    let rx = x, ry = y
    m.focus.forEach((f, i) => {
      const sh = f.shape, L = lifted[i]
      if (sh.kind !== 'lift' || !(L > 0) || x < sh.x || x > sh.x + sh.w || y < sh.y || y > sh.y + sh.h) return
      const q = onLift(sh, L, x, y); rx = q.x; ry = q.y
    })
    return { x: rx, y: ry }
  }

  const P = m.pointer
  // Every disc is its own closed form of the time since its own tap, so two taps inside
  // one lift are two marks and neither of them reads the frame before it.
  if (P && P.touch) {
    for (const d of Touch.discsAt(P.touch, t)) {
      const q = rideLift(d.x, d.y)
      out.touch.push({ x: q.x, y: q.y, op: d.op, scale: d.press * growOf(d) })
    }
  } else if (P && t >= P.pl.start && t <= P.stop) {
    const pos = Pointer.positionAt(P.pl, t)
    if (pos) {
      let press = 1
      for (const c of P.clicks) {
        if (t < c.t || t > c.t + c.room) continue
        const down = c.room * 0.28
        press = t < c.t + down ? 1 - 0.16 * (t - c.t) / down : 0.84 + 0.16 * Math.pow((t - c.t - down) / (c.room - down), 0.7)
      }
      const ripples = P.clicks.filter(c => t >= c.t && t < c.t + RIPPLE)
        .map(c => ({ x: c.x, y: c.y, p: Math.pow((t - c.t) / RIPPLE, 0.45) }))
      const tag = P.tags.find(s => t >= s.a && t <= s.b)
      // pointing at something on a lifted card, the cursor rises with the card, the
      // same scale about the same centre and the same move in as the piece
      const { x, y } = rideLift(pos.x, pos.y)
      out.pointer = {
        x, y, press, ripples,
        op: Math.min(1, Math.max(0, t - P.pl.start) / FADE_IN),
        badge: Pointer.badgeOpacity(P.badge, t),
        tag: tag ? { op: Pointer.tagOpacity(P.tags, t), left: tag.left } : null,
      }
    }
  }
  return out
}

module.exports = { planMarks, planErase, planPointer, planKeys, keysAt, at, seenIn, MAX, KEY }
