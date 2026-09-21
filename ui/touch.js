// The touch track: what a finger did, on a device Fetch is filming.
//
// A tap is a position and a moment, which is the shape the pointer track already
// keeps, so this file adds no second track and no second coordinate space. It reads
// the same { id, t, x, y, click } points ui/pointer.js normalizes, and answers two
// questions a cursor never has to:
//
//   Is a finger on the glass at all? A cursor is always somewhere. A finger is not
//   there between taps, and drawing one gliding from tap to tap is the single thing
//   that makes a touch take read as a mouse take with a round cursor.
//
//   Where is a device point in the recorded frame? The take records a window, the
//   agent aims in the device's own points, and the device screen is a rectangle
//   inside that window. One multiply, through the viewport box ui/pointer.js already
//   uses for a browser page.
//
// Deliberately absent: swipe trails, long press and pinch. A trail is where a pass
// would reach for the previous frame, and no pass reads the previous frame. A held
// tap across consecutive points glides, and that is the whole of motion here.
//
// Pure: no Electron, no filesystem, no GL. Everything is a closed form of t.

const Pointer = require('./pointer')

const ease = Pointer.ease
const clamp01 = n => Math.max(0, Math.min(1, n))
const r3 = n => Math.round(n * 1000) / 1000

// The absence rule, in seconds. The finger comes down onto the moment it was
// reported, so presence is full at contact and the rise reads as the approach; the
// long fall reads as lifting off. Hold keeps an instant tap on screen long enough to
// see at all, since a reported tap has no duration of its own.
const TOUCH = { rise: 0.09, hold: 0.09, fall: 0.22 }

// A real touch target is 44 points across whatever the device's own scale, so the
// disc is measured through the screen rather than sized against the frame. dip is
// how far it squashes on contact and back is how long it takes to come back.
const DISC = { pt: 44, min: 8, dip: 0.86, dipFor: 0.06, back: 0.16 }

// More than this many discs at once means taps faster than the fall, which is a
// machine gun and not a demo; the faintest are dropped rather than drawn.
const MAX = 3

// ── the device screen, inside the recorded frame ────────────────────────────

// The device screen as fractions of the recorded frame, the same { x, y, w, h } box
// pointer.js:viewportBox() returns for a browser page. Missing means the whole frame,
// which is what a capture cropped to the screen already is.
function screenRect(box) {
  if (!box) return { x: 0, y: 0, w: 1, h: 1 }
  const x = +box.x || 0, y = +box.y || 0, w = +box.w, h = +box.h
  if (!(w > 0 && h > 0) || x < 0 || y < 0 || x + w > 1.001 || y + h > 1.001) {
    throw new Error('the device screen viewport is fractions of the recorded window, {x, y, w, h}, inside 0 to 1')
  }
  return { x, y, w: Math.min(w, 1 - x), h: Math.min(h, 1 - y) }
}

// The device's screen in its own points. A device type's profile gives the native
// framebuffer in pixels and a scale; an agent aims in points, because that is what a
// layout is written in and what find_on_screen reports back.
function screenPoints(screen, units = 'points') {
  const w = +(screen && screen.w), h = +(screen && screen.h)
  if (!(w > 0 && h > 0)) return null
  const s = units === 'pixels' ? 1 : (+screen.scale > 0 ? +screen.scale : 1)
  // A device on its side reports the same framebuffer and shows it turned, so the axes
  // an agent aims in are swapped and everything measured from them follows: the fit, the
  // refusal's own numbers, and how wide 44 points is across the glass. Read off the
  // record rather than guessed, because nothing in simctl reports orientation and the
  // window's shape is the only evidence there is (ui/simulator.js orientOf).
  return isLandscape(screen) ? { w: h / s, h: w / s } : { w: w / s, h: h / s }
}

const isLandscape = screen => String((screen && screen.orientation) || '').toLowerCase().startsWith('landscape')

/**
 * A point in the device's own coordinates to a fraction of the recorded frame.
 *
 *   pt      { x, y } in device points, or pixels with units 'pixels'
 *   view    { screen: {w, h, scale}, viewport: {x, y, w, h}, units }, from the
 *           simulator model: screen is the native framebuffer, viewport is where
 *           that screen sits inside the recorded window.
 *
 * Off the screen by more than a point is refused rather than clamped, because a
 * disc pinned to an edge for a whole take is a worse answer than a sentence.
 */
function deviceToWindow(pt, view = {}) {
  const x = +(pt && pt.x), y = +(pt && pt.y)
  if (!isFinite(x) || !isFinite(y)) throw new Error('x and y are required numbers')
  const sp = screenPoints(view.screen, view.units)
  if (!sp) throw new Error('the device screen size is not known yet; send fractions of the recorded window instead')
  if (x < -1 || y < -1 || x > sp.w + 1 || y > sp.h + 1) {
    throw new Error(`x and y are device points, 0 to ${r3(sp.w)} by ${r3(sp.h)} on this device. ` +
      'For a fraction of the recorded window send x and y between 0 and 1 with no simulator')
  }
  const box = screenRect(view.viewport)
  return { x: r3(clamp01(box.x + (x / sp.w) * box.w)), y: r3(clamp01(box.y + (y / sp.h) * box.h)) }
}

/**
 * A run of taps in device coordinates as points on the pointer track. click is
 * derived, never asked for: the first point of an id is the finger landing, and the
 * points that follow under that id are the same finger still down.
 */
function mapTaps(list, view = {}) {
  if (!Array.isArray(list)) return []
  const out = []
  let held = null
  for (const p of list) {
    if (!p || !isFinite(+p.t)) continue
    const id = p.id ? String(p.id) : ''
    const f = deviceToWindow(p, view)
    out.push({ ...(id ? { id } : {}), t: r3(+p.t), x: f.x, y: f.y, ...(id && id === held ? {} : { click: true }) })
    held = id
  }
  return out
}

// ── what a finger did ───────────────────────────────────────────────────────

// A track in fractions of the recorded frame, cleaned the one way the repo cleans
// them. Frame pixels come in already cleaned, from pointer.js cursorLayout, and must
// not go through this: it clamps to 0..1, which is a fraction's range and not a
// pixel's.
const normalizeTaps = list => Pointer.normalizeTrack(list)

// In time order, with anything unusable dropped and every value left alone, so this
// reads fractions and frame pixels alike.
function order(list) {
  if (!Array.isArray(list)) return []
  return list.filter(p => p && isFinite(+p.t) && isFinite(+p.x) && isFinite(+p.y) && +p.t >= 0)
    .map(p => ({ ...(p.id ? { id: String(p.id) } : {}), t: +p.t, x: +p.x, y: +p.y, ...(p.click ? { click: true } : {}) }))
    .sort((a, b) => a.t - b.t)
}

/**
 * A track split into the times a finger was actually on the glass.
 *
 * A touch starts on a click. A point that follows carrying the same id is that same
 * finger still down, so the disc glides to it. Anything else is a move with no
 * finger behind it, and in touch mode that is nothing at all: it is dropped.
 *
 * Points are passed through in whatever units they arrive in, so this works on
 * fractions of the recorded frame and on frame pixels alike.
 */
function touches(points) {
  const out = []
  // One open touch per id, not one open touch. Two fingers held at once are two
  // touches, and a single slot made each of them close the other: both came out a
  // single point long and both discs were gone half a second in.
  const open = new Map()
  for (const p of order(points)) {
    const id = p.id || ''
    const q = { t: p.t, x: p.x, y: p.y }
    if (!p.click) {
      // A move whose id matches no finger still down has no finger behind it, and in
      // touch mode that is nothing at all. It does not close anybody else's touch.
      const cur = id ? open.get(id) : null
      if (cur) cur.points.push(q)
      continue
    }
    const cur = { ...(id ? { id } : {}), down: p.t, points: [q] }
    if (id) open.set(id, cur)
    out.push(cur)
  }
  return out.map(c => {
    const last = c.points[c.points.length - 1]
    return { ...c, up: last.t, moved: c.points.length > 1,
      a: r3(c.down - TOUCH.rise), b: r3(last.t + TOUCH.hold + TOUCH.fall) }
  })
}

/**
 * The touch plan for one take: every touch, when the first disc appears and when the
 * last one is gone. The counterpart of pointer.js plan(), and shaped like it, except
 * that there is nothing between the touches to plan.
 */
function planTouch(points) {
  const list = touches(points)
  if (!list.length) return null
  return { start: list[0].a, stop: Math.max(...list.map(c => c.b)), touches: list }
}

// Where the finger is inside one touch at t. A drag is a straight line on the move
// curve every travelling thing in an export uses, not an arc: a wrist bows, a finger
// pinned to the glass does not.
function posIn(c, t) {
  const pts = c.points
  if (t <= pts[0].t) return { x: pts[0].x, y: pts[0].y }
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i]
    if (t >= b.t) continue
    const p = b.t > a.t ? ease((t - a.t) / (b.t - a.t)) : 1
    return { x: a.x + (b.x - a.x) * p, y: a.y + (b.y - a.y) * p }
  }
  const z = pts[pts.length - 1]
  return { x: z.x, y: z.y }
}

// How present one touch is at t: up over the rise, full from contact to the end of
// the hold, gone over the fall.
function opacityIn(c, t) {
  if (t <= c.a || t >= c.b) return 0
  if (t < c.down) return ease((t - c.a) / TOUCH.rise)
  const held = c.up + TOUCH.hold
  if (t <= held) return 1
  return 1 - ease((t - held) / TOUCH.fall)
}

// The squash on contact, a function of t - down alone so any frame draws alone.
function pressIn(c, t) {
  const dt = t - c.down
  if (dt < 0) return 1
  if (dt < DISC.dipFor) return 1 - (1 - DISC.dip) * ease(dt / DISC.dipFor)
  return DISC.dip + (1 - DISC.dip) * ease(Math.min(1, (dt - DISC.dipFor) / DISC.back))
}

/**
 * Every disc to draw at t: { x, y, op, press, age }, most opaque first.
 *
 * A list rather than one disc, because two taps closer together than the fall really
 * are two marks on screen: the one being lifted and the one landing. Each carries its
 * own closed-form time, so nothing here needs the frame before it.
 */
function discsAt(pl, t) {
  if (!pl || !pl.touches.length) return []
  const out = []
  for (const c of pl.touches) {
    const op = opacityIn(c, t)
    if (!(op > 0.002)) continue
    const p = posIn(c, t)
    out.push({ x: p.x, y: p.y, op, press: pressIn(c, t), age: r3(t - c.down) })
  }
  // The cap sheds the oldest ghosts, never the live finger. Under a run of taps faster
  // than the fall, several discs are at full opacity at once, so ranking by opacity kept
  // whichever three came first and dropped the tap that had just happened: Fetch drew
  // the past and hid the present exactly where a demo is moving fastest. Ranked by
  // recency instead, then handed back most opaque first, which is the order it draws in.
  return out.sort((a, b) => a.age - b.age).slice(0, MAX).sort((a, b) => b.op - a.op)
}

// How much of a finger is on screen at t, 0 to 1. The absence rule as one number,
// for anything that only needs to know whether to draw at all.
function presenceAt(pl, t) {
  return discsAt(pl, t).reduce((m, d) => Math.max(m, d.op), 0)
}

/**
 * The disc's diameter in pixels of the frame it is drawn into, from a real 44 point
 * touch target measured through the device's own screen. Sized this way it is a
 * fingertip on a phone and a fingertip on a 13 inch tablet; sized against the frame
 * it would be right on exactly one device.
 *
 * null when the device screen is not known, so a caller can fall back to its own
 * size rather than draw a wrong one confidently.
 */
function discPixels({ screen, viewport, W, units } = {}) {
  const sp = screenPoints(screen, units)
  if (!sp || !(W > 0)) return null
  const box = screenRect(viewport)
  return Math.max(DISC.min, (DISC.pt / sp.w) * box.w * W)
}

module.exports = {
  TOUCH, DISC, MAX,
  screenRect, screenPoints, deviceToWindow, mapTaps,
  normalizeTaps, touches, planTouch, posIn, opacityIn, pressIn,
  discsAt, presenceAt, discPixels,
}
