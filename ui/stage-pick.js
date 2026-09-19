/**
 * A point on the editor's stage, turned into a box of the recording.
 *
 * The compositor draws the take through four divisions (ui/compositor/gl.js:147-174):
 * the output rect the take sits in, the window margin the export trims, the zoom in
 * force, and the crop into the source texture. Picking is those divisions run
 * backwards, and it has to be exact: a lasso that lands two pixels off points the
 * agent at the wrong element.
 *
 * Pure on purpose. No DOM, no Electron, nothing but the numbers the editor has
 * already read, so `node test/stage-pick.test.js` can hold it to the arithmetic.
 */

// under this in either direction a drag is a click, not an area
const MIN_DRAG = 0.02

// spec.rect and spec.inner are objects, Plan.viewAt returns [x, y, w, h]. Both say
// the same four numbers, so take either rather than make the caller convert.
function four(v) {
  if (!v) return { x: 0, y: 0, w: 1, h: 1 }
  return Array.isArray(v) ? { x: v[0], y: v[1], w: v[2], h: v[3] } : v
}

/**
 * A client point in the canvas's output pixels, top-left origin, spec.W by spec.H.
 * Straight from the canvas's own client rect, so a fractional device pixel ratio and
 * the backing store's rounding never enter into it.
 */
function toOutput(client, rect, spec) {
  return { x: (client.x - rect.left) * spec.W / rect.width,
    y: (client.y - rect.top) * spec.H / rect.height }
}

/**
 * The take's rect while a title card lifts it (ui/compositor/gl.js:659-663). The
 * shader scales the rect about its own centre and drops it by dy, so a hit test
 * against the resting rect is off for as long as a card is on screen.
 */
function movedRect(rect, move) {
  const k = move && move.k > 0 ? move.k : 1
  const dy = (move && move.dy) || 0
  const w = rect.w * k, h = rect.h * k
  return { x: rect.x + (rect.w - w) / 2, y: rect.y + (rect.h - h) / 2 + dy, w, h }
}

/**
 * Output pixels to fractions of the cropped frame, which is the space marks, zooms
 * and Elements all speak. Null when the point is on the backdrop rather than on the
 * take: there is nothing under it to point at.
 *
 * W and H ride along on the geometry because the caller has them in hand; the maths
 * does not need them once the point is already in output pixels.
 */
function toFrac(p, { rect, inner, view }) {
  const r = four(rect), n = four(inner), v = four(view)
  if (!(r.w > 0 && r.h > 0)) return null
  const local = { x: (p.x - r.x) / r.w, y: (p.y - r.y) / r.h }
  if (local.x < 0 || local.x > 1 || local.y < 0 || local.y > 1) return null
  const q = { x: n.x + local.x * n.w, y: n.y + local.y * n.h }
  return { x: v.x + q.x * v.w, y: v.y + q.y * v.h }
}

// The same four divisions forward again, for drawing a box that is already in frame
// fractions back onto the stage. Not clamped: a box outside the view is off the
// picture, and the stage clips it.
function fromFrac(f, { rect, inner, view }) {
  const r = four(rect), n = four(inner), v = four(view)
  const q = { x: (f.x - v.x) / v.w, y: (f.y - v.y) / v.h }
  const local = { x: (q.x - n.x) / n.w, y: (q.y - n.y) / n.h }
  return { x: r.x + local.x * r.w, y: r.y + local.y * r.h }
}

// Two corners of a drag into a box. The drag may go up and to the left.
function rectOf(a, b) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) }
}

// Into the frame, the same contract as Targets.cleanBox: null when there is no box
// left after clamping.
function clampBox(box) {
  if (!box) return null
  let { x, y, w, h } = box
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null
  x = Math.max(0, Math.min(1, x)); y = Math.max(0, Math.min(1, y))
  w = Math.min(1 - x, w); h = Math.min(1 - y, h)
  return w > 0 && h > 0 ? { x, y, w, h } : null
}

// A flick is a click. Anything thinner than this in either direction is not an area.
function tooSmall(box) {
  return !box || box.w < MIN_DRAG || box.h < MIN_DRAG
}

module.exports = { MIN_DRAG, toOutput, movedRect, toFrac, fromFrac, rectOf, clampBox, tooSmall }
