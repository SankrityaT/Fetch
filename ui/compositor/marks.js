// What the compositor draws in the recording's own space, before any zoom, so a zoom
// carries it with the thing it marks: the Mac's pointer lifted out, redactions, blurs,
// lifts and spotlights, numbered steps and the agent's cursor. prepare() places every
// one on the output clock once per render; at() says what each looks like at a moment.
// Pure (test/plan.test.js, test/focus.test.js).
//
// Positions and sizes are content pixels: pixels of the cropped recording, whatever
// size the source is decoded or shown at. `px` is finished pixels per content pixel
// before any zoom, so anything sized for the finished frame (a badge 60 px across at
// 1080, a feather) is the same however large the recording is.
//
// What needs the take's pixels to place (a lift's measured box and corners, a step on
// its card's corner, a cursor rest moved off the words, the clean patches under the
// Mac's pointer) is worked out once per take by prepare.js in the main process and
// arrives as `prepared`; without it the marks are drawn where the edit put them.

const Overlays = require('../overlays')
const Pointer = require('../pointer')
const Focus = require('./focus')

const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
const kinds = new Set(['redact', 'blur', 'lift', 'spotlight', 'step'])
// the most of each kind one frame draws: the shaders take fixed-size arrays
const MAX = { erase: 8, redact: 8, blur: 4 }

// The zoom scale a span is mostly seen through
const seenIn = (zooms, a, b) => Math.max(1, ...(zooms || []).filter(z => z && Math.min(z.end, b) - Math.max(z.start, a) > 0.3).map(z => +z.scale || 1))

/**
 * Place the marks of an edit.
 *   marks     the edit's marks (prepared ones when the take was read), source clock,
 *             fractions of the cropped frame
 *   W, H      the cropped frame in content pixels
 *   px        finished pixels per content pixel before any zoom
 *   clock     source seconds to output seconds (Timeline.outClock)
 *   span      output length
 *   zooms     on the output clock; lifts may re-frame them (Focus.reframe)
 * Returns { redact, blur, focus, steps, zooms }.
 */
function planMarks(marks, { W, H, px, clock, span, zooms }) {
  const on = (marks || []).filter(m => m && kinds.has(m.kind)).map(m => ({ ...m, a: clock(+m.start), b: clock(+m.end) }))
  const out = { redact: [], blur: [], focus: [], steps: [], zooms }

  for (const m of on) {
    if (!(m.b > m.a)) continue
    const x = clamp(+m.x || 0, 0, 1) * W, y = clamp(+m.y || 0, 0, 1) * H
    const w = Math.max(2, Math.min(W - x, (+m.w || 0.2) * W)), h = Math.max(2, Math.min(H - y, (+m.h || 0.1) * H))
    if (m.kind === 'redact') {
      // A redaction destroys what is under it: cells about 16 finished pixels across,
      // each one the mean of what it covers, so no letter survives at any zoom. It is
      // on from its first frame to its last, never faded, since a fade shows the secret.
      out.redact.push({ a: m.a, b: m.b, x, y, w, h, cell: Math.max(4, Math.round(16 / px)) })
    } else if (m.kind === 'blur') {
      // Gaussian, for softening something distracting (redact is for secrets), through a
      // round-cornered mask feathered over about 1 percent of the height, easing in and out
      const F = Math.max(6, Math.round(H * 0.012))
      const T = Math.min(0.35, (m.b - m.a) / 3)
      out.blur.push({ a: m.a, b: m.b, x, y, w, h, r: Math.min(H * 0.014, w / 2, h / 2), feather: F,
        sigma: clamp(+m.strength || 18, 4, 60),
        Tin: T < 0.04 || m.a <= 0.05 ? 0 : T, Tout: T < 0.04 || m.b >= span - 0.05 ? 0 : T })
    }
  }

  // Lifts and spotlights: shaped through the zoom they are seen in, and the zooms a
  // lift rides framed round it
  const focus = on.filter(m => m.kind === 'lift' || m.kind === 'spotlight')
    .map(m => ({ m, tm: Overlays.focusTiming({ ...m, start: m.a, end: m.b }, zooms) }))
    .filter(f => f.tm && f.tm.b > f.tm.a + 0.2)
  const shapeOf = (f, zs) => Focus.shape(f.m, W, H, px * seenIn(zs, f.tm.a, f.tm.b))
  const lifts = focus.filter(f => f.m.kind === 'lift')
    .map(f => ({ tm: f.tm, box: { x: +f.m.x || 0, y: +f.m.y || 0, w: +f.m.w || 0.2, h: +f.m.h || 0.1 }, shape: shapeOf(f, zooms) }))
  out.zooms = Focus.reframe(zooms, lifts, W, H)
  for (const f of focus) {
    const s = shapeOf(f, out.zooms)
    if (s.kind === 'lift') {
      // what is on screen while it is fully up: the zoom it rides at its hold, or all of it
      const mid = (Math.max(f.tm.a + f.tm.Tin, Math.min(f.tm.b - f.tm.Tout, (f.tm.a + f.tm.b) / 2)))
      const v = Overlays.zoomView(out.zooms, mid)
      s.nudge = Focus.nudge(s, { x: v.x, y: v.y, w: v.w, h: v.h }, W, H)
    }
    out.focus.push({ tm: f.tm, shape: s })
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
    const lift = out.focus.findIndex(f => f.shape.kind === 'lift' && m.a < f.tm.b && m.b > f.tm.a &&
      (+m.x || 0) * W >= f.shape.x - 0.02 * W && (+m.x || 0) * W <= f.shape.x + f.shape.w + 0.02 * W &&
      (+m.y || 0) * H >= f.shape.y - 0.02 * H && (+m.y || 0) * H <= f.shape.y + f.shape.h + 0.02 * H)
    out.steps.push({ a: m.a, b: m.b, IN: Math.min(0.34, (m.b - m.a) / 3), OUT: Math.min(0.22, (m.b - m.a) / 4),
      cx, cy, D, ring, label, lift })
  }
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
 * The agent's cursor, from its track (Pointer.cursorLayout): where it glides, when it
 * presses, when Biscuit's badge and name show and the ripples of its clicks.
 */
function planPointer(points, { W, H, clock, crop, scale, span, px, zooms }) {
  if (!Array.isArray(points) || !points.length) return null
  const L = Pointer.cursorLayout(points, { W, H, clock, crop, scale, end: span, out: px, zooms })
  if (!L) return null
  const { BADGE, LOOK, TAG } = Pointer
  const d = 2 * Math.max(4, Math.round(BADGE.r * L.size), Math.round(LOOK.badgeMin * L.unit / 2))
  const br = Math.max(BADGE.r * L.size, LOOK.badgeMin * L.unit / 2)
  const tagH = br * 1.62, tagFs = tagH * 0.6
  // the name's width as the rounded bold sets it, near enough to decide which side it goes
  const tagW = br + tagH * 0.24 + TAG.text.length * tagFs * 0.56 + tagH * 0.42
  const clicks = L.pts.filter(p => p.click).map(p => {
    // a press finishes before the next glide leaves (drawCursor)
    const next = L.pl.moves.find(m => m.from > p.t - 0.005)
    const room = clamp((next ? next.from : L.stop) - p.t, 0.04, 0.25)
    return { t: p.t, x: p.x, y: p.y, room }
  })
  return {
    pl: L.pl, size: L.size, k: L.k, unit: L.unit, stop: L.stop, d, br, tagH, tagFs, tagW,
    badge: Pointer.badgeSpans(L.pl), tags: tagSpans(L, tagW), clicks,
    ripple: Math.max(L.size * 1.1, 14 * L.unit),
  }
}
// Pointer's tag spans (it keeps them private), the same rule: up just before each click
function tagSpans(L, tagW) {
  const { BADGE, TAG } = Pointer
  const out = []
  for (const p of L.pts) {
    if (!p.click) continue
    const a = p.t - TAG.lead, b = p.t + TAG.hold + TAG.fadeOut
    const left = p.x + (BADGE.cx * L.size) + tagW > L.W - 4
    const last = out[out.length - 1]
    if (last && a <= last.b + 0.3 && last.left === left) last.b = b
    else out.push({ a: Math.max(L.pl.start, a), b, left })
  }
  return out
}

// ── one moment ───────────────────────────────────────────────────────────
const RIPPLE = 0.56, FADE_IN = 0.16

/**
 * Everything drawn in content space at output time t, from planMarks, planErase and
 * planPointer: { erase, redact, blur, focus, steps, pointer }, each only what shows.
 */
function at(m, t) {
  const live = x => t >= x.a && t < x.b
  const out = {
    erase: (m.erase || []).filter(live).slice(0, MAX.erase + 16),
    redact: (m.redact || []).filter(live).slice(0, MAX.redact),
    blur: [], focus: [], steps: [], pointer: null,
  }
  for (const b of m.blur || []) {
    if (!live(b)) continue
    const op = Math.min(1, b.Tin > 0 ? (t - b.a) / b.Tin : 1, b.Tout > 0 ? (b.b - t) / b.Tout : 1)
    if (op > 0.002 && out.blur.length < MAX.blur) out.blur.push({ ...b, op: Math.max(0, op) })
  }
  const lifted = []
  for (const f of m.focus || []) {
    const level = Focus.level(f.tm, t)
    lifted.push(level)
    if (level > 0.001) out.focus.push({ shape: f.shape, level })
  }
  for (const s of m.steps || []) {
    if (!live(s)) continue
    let scale, op
    if (t < s.a + s.IN) { const p = (t - s.a) / s.IN; scale = 0.35 + 0.65 * Overlays.POP(p); op = Math.min(1, p * 2.2) }
    else if (t >= s.b - s.OUT) { const e = Overlays.EASE_OUT((t - (s.b - s.OUT)) / s.OUT); scale = 1 - 0.18 * e; op = 1 - e }
    else { scale = 1; op = 1 }
    let cx = s.cx, cy = s.cy
    // on a lifted card: the same scale about the same centre, and the same move in
    const f = s.lift >= 0 && m.focus[s.lift]
    if (f && lifted[s.lift] > 0) {
      const sh = f.shape, L = lifted[s.lift], k = 1 + (sh.lift - 1) * L
      const ccx = sh.x + sh.w / 2, ccy = sh.y + sh.h / 2
      cx = ccx + (cx - ccx) * k + sh.nudge.dx * L; cy = ccy + (cy - ccy) * k + sh.nudge.dy * L
    }
    if (op > 0.002) out.steps.push({ cx, cy, D: s.D, ring: s.ring, label: s.label, scale, op })
  }
  const P = m.pointer
  if (P && t >= P.pl.start && t <= P.stop) {
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
      out.pointer = {
        x: pos.x, y: pos.y, press, ripples,
        op: Math.min(1, Math.max(0, t - P.pl.start) / FADE_IN),
        badge: Pointer.badgeOpacity(P.badge, t),
        tag: tag ? { op: Pointer.tagOpacity(P.tags, t), left: tag.left } : null,
      }
    }
  }
  return out
}

module.exports = { planMarks, planErase, planPointer, at, seenIn, MAX }
