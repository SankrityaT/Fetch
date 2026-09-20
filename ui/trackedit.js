/**
 * The maths behind editing a zoom or a mark by hand.
 *
 * Until now no person could create, move, retime, re-aim or delete a single zoom or a
 * single mark: clicking a pill seeked the playhead and that was all of it. For a
 * redaction that was a hole, since the one edit where a miss ships something private
 * could only be undone or asked for again.
 *
 * Pure on purpose, like ui/stage-pick.js: no DOM, no Electron, nothing but the numbers
 * the editor already has, so `node test/trackedit.test.js` holds it to the arithmetic.
 * The editor does the pointer and the pixels; every rule about what a drag is allowed
 * to become lives here.
 *
 * The one rule that outranks the rest: a box a person drags becomes a zoom through
 * Targets.boxZoom, which is the same call ui/fetchdoc.js makes for an agent's box. Two
 * clients, one document.
 */

const Targets = require('./targets')

// A zoom has to arrive, hold and leave on the look's own ease, and under this it is a
// jump rather than a move. A mark is a state rather than a move, so it can be brief.
const MIN_SPAN = 0.4
const MIN_MARK = 0.2
// The lasso's floor (Pick.MIN_DRAG), for the same reason: thinner than this in either
// direction and a drag was a click, not an area.
const MIN_BOX = 0.02
// What a fresh object is given when nobody said how long, in seconds
const WANT = { zoom: 2.5, mark: 3 }

const r4 = n => Math.round(n * 10000) / 10000
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const num = (v, d) => (Number.isFinite(+v) ? +v : d)

// The nearest of the times a drag should land flush on (a beat's edge, a cut, the
// playhead, the trim), or t untouched when none of them is close enough.
function snapTime(t, targets, tol) {
  if (!(tol > 0) || !targets || !targets.length) return t
  let best = t, gap = tol
  for (const c of targets) {
    if (!Number.isFinite(+c)) continue
    const d = Math.abs(+c - t)
    if (d <= gap) { gap = d; best = +c }
  }
  return best
}

/**
 * How far a span may travel before it runs into its neighbours on an exclusive track.
 * Only one zoom frames the shot at once, so dragging Z2 over Z1 leaves the wrong one
 * showing; the drag stops at the edge instead. A neighbour that already overlaps is
 * left alone: an overlap the document arrived with is not this drag's to repair.
 */
function spanLimits(list, id, o = {}) {
  let lo = num(o.lo, 0), hi = num(o.hi, Infinity)
  const me = (list || []).find(x => x && x.id === id)
  if (!me) return { lo, hi }
  for (const x of list) {
    if (!x || x.id === id) continue
    if (+x.end <= +me.start + 1e-6) lo = Math.max(lo, +x.end)
    else if (+x.start >= +me.end - 1e-6) hi = Math.min(hi, +x.start)
  }
  return { lo, hi }
}

/**
 * The room a new object has at a moment, or null when something is already there.
 * "Add a zoom" with the playhead inside Z1 should say so rather than quietly stack a
 * second zoom nobody will see.
 */
function freeGap(list, at, o = {}) {
  let lo = num(o.lo, 0), hi = num(o.hi, Infinity)
  for (const x of list || []) {
    if (!x) continue
    if (+x.end <= at) lo = Math.max(lo, +x.end)
    else if (+x.start >= at) hi = Math.min(hi, +x.start)
    else return null
  }
  return { lo, hi }
}

/**
 * A pill dragged by an edge or by its middle. grip is 'start', 'end' or 'body'; dt is
 * how far the pointer has moved in seconds.
 *
 * An edge snaps on its own. The middle snaps as a pair, taking whichever end lands
 * nearest something, so a pill dropped on a beat is flush with it at one end and keeps
 * its length at the other.
 */
function dragSpan(span, grip, dt, o = {}) {
  const min = o.min > 0 ? o.min : MIN_SPAN
  const lo = num(o.lo, 0), hi = num(o.hi, Infinity)
  const at = o.snap || [], tol = o.tol || 0
  const s0 = +span.start, e0 = +span.end
  if (grip === 'body') {
    const len = Math.min(e0 - s0, hi - lo)
    let s = clamp(s0 + dt, lo, hi - len)
    const moves = [snapTime(s, at, tol) - s, snapTime(s + len, at, tol) - (s + len)].filter(d => d !== 0)
    const d = moves.length ? moves.reduce((a, b) => (Math.abs(a) <= Math.abs(b) ? a : b)) : 0
    s = clamp(s + d, lo, hi - len)
    return { start: r4(s), end: r4(s + len) }
  }
  if (grip === 'start') {
    return { start: r4(clamp(snapTime(s0 + dt, at, tol), lo, e0 - min)), end: r4(e0) }
  }
  return { start: r4(s0), end: r4(clamp(snapTime(e0 + dt, at, tol), s0 + min, hi)) }
}

/**
 * A rectangle on the stage, dragged by a corner, an edge or its middle, in fractions
 * of the cropped frame. Pulled past its far side it holds at the minimum rather than
 * turning inside out, so a redaction never flips off the thing it is hiding.
 */
function dragBox(box, grip, d, o = {}) {
  const min = o.min > 0 ? o.min : MIN_BOX
  const b = o.bounds || { x: 0, y: 0, w: 1, h: 1 }
  const L = b.x, T = b.y, R = b.x + b.w, B = b.y + b.h
  const dx = num(d && d.x, 0), dy = num(d && d.y, 0)
  let x = +box.x, y = +box.y, w = +box.w, h = +box.h
  if (grip === 'move') {
    return { x: r4(clamp(x + dx, L, R - w)), y: r4(clamp(y + dy, T, B - h)), w: r4(w), h: r4(h) }
  }
  if (grip.includes('w')) { const nx = clamp(x + dx, L, x + w - min); w = x + w - nx; x = nx }
  if (grip.includes('e')) { w = clamp(w + dx, min, R - x) }
  if (grip.includes('n')) { const ny = clamp(y + dy, T, y + h - min); h = y + h - ny; y = ny }
  if (grip.includes('s')) { h = clamp(h + dy, min, B - y) }
  return { x: r4(x), y: r4(y), w: r4(w), h: r4(h) }
}

// A step numbers a point rather than an area, so it moves and never resizes.
function movePoint(p, d, o = {}) {
  const b = o.bounds || { x: 0, y: 0, w: 1, h: 1 }
  return { x: r4(clamp(+p.x + num(d && d.x, 0), b.x, b.x + b.w)),
    y: r4(clamp(+p.y + num(d && d.y, 0), b.y, b.y + b.h)) }
}

/**
 * A zoom re-aimed at a box. This is the rule the piece exists for: the person's drag
 * goes through Targets.boxZoom exactly as an agent's box does in Fetchdoc.normalize,
 * scale and all, so the same rectangle drawn by either hand writes the same zoom.
 */
function aimZoom(zoom, box) {
  const fit = Targets.boxZoom(box)
  return fit ? { ...zoom, ...fit } : zoom
}

// A mark moved or resized. Its x, y, w, h already are a box; a step keeps only the
// point it numbers, which for a box is its top left corner, as the document does.
function placeMark(mark, box) {
  const b = Targets.cleanBox(box)
  if (!mark || !b) return mark
  return mark.kind === 'step'
    ? { ...mark, x: r4(b.x), y: r4(b.y) }
    : { ...mark, x: r4(b.x), y: r4(b.y), w: r4(b.w), h: r4(b.h) }
}

/**
 * Where a new object goes when someone presses Add at the playhead: from here, as long
 * as it fits, shortened rather than refused when the room runs out, and null when even
 * the minimum does not fit.
 */
function newSpan(at, want, o = {}) {
  const min = o.min > 0 ? o.min : MIN_SPAN
  const lo = num(o.lo, 0), hi = num(o.hi, Infinity)
  if (!(hi - lo >= min)) return null
  let len = Math.min(Math.max(want, min), hi - lo)
  let s = clamp(at, lo, hi)
  // no room ahead: it keeps what is left rather than starting before the moment the
  // person is looking at, and steps back only as far as the minimum needs
  if (hi - s < len) { len = Math.max(min, Math.min(len, hi - s)); s = Math.min(s, hi - len) }
  return { start: r4(s), end: r4(s + len) }
}

// A mark with geometry from the start, because a mark with only a time hides nothing,
// raises nothing and magnifies nothing. The box is the lasso's if there is one, else a
// readable rectangle in the middle of the frame for the person to drag onto the thing.
function blankMark(kind, span, box) {
  const b = Targets.cleanBox(box) || { x: 0.32, y: 0.36, w: 0.36, h: 0.22 }
  const m = { kind, start: r4(span.start), end: r4(span.end) }
  if (kind === 'blur') m.strength = 18
  return placeMark(m, b)
}

const removeById = (list, id) => (list || []).filter(x => !(x && x.id === id))

module.exports = {
  MIN_SPAN, MIN_MARK, MIN_BOX, WANT,
  snapTime, spanLimits, freeGap, dragSpan, dragBox, movePoint,
  aimZoom, placeMark, newSpan, blankMark, removeById,
}
