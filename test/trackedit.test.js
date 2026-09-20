// Editing a zoom or a mark by hand (ui/trackedit.js): what a drag on a pill or on the
// stage is allowed to become. Snap, the minimum span, the neighbours on an exclusive
// track, delete, and the rule the piece exists for: a box a person drags becomes a
// zoom through the same call an agent's box goes through, so both write one document.
const TE = require('../ui/trackedit')
const FD = require('../ui/fetchdoc')
const T = require('../ui/targets')

let pass = 0, fail = 0
const is = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}` +
    (ok ? '' : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`))
}

console.log('snapping')
is('an edge within reach lands flush', TE.snapTime(4.06, [2, 4, 9], 0.1), 4)
is('nothing in reach leaves it where it was', TE.snapTime(4.4, [2, 4, 9], 0.1), 4.4)
is('the nearest of two wins', TE.snapTime(4.04, [4, 4.07], 0.1), 4.07)
is('no targets, no snap', TE.snapTime(4.4, [], 0.2), 4.4)

console.log('retiming a pill')
const Z = { start: 4, end: 7 }
is('the left edge moves and the right stays', TE.dragSpan(Z, 'start', -1.5), { start: 2.5, end: 7 })
is('an edge cannot cross the other: the minimum span holds',
  TE.dragSpan(Z, 'start', 5, { min: 0.4 }), { start: 6.6, end: 7 })
is('and the same from the right', TE.dragSpan(Z, 'end', -5, { min: 0.4 }), { start: 4, end: 4.4 })
is('an edge dragged past the take stops at it', TE.dragSpan(Z, 'end', 99, { hi: 8.2 }), { start: 4, end: 8.2 })
is('the middle keeps its length', TE.dragSpan(Z, 'body', 2), { start: 6, end: 9 })
is('and stops at the end of the take with its length whole',
  TE.dragSpan(Z, 'body', 99, { lo: 0, hi: 8 }), { start: 5, end: 8 })
is('an edge snaps to a beat', TE.dragSpan(Z, 'start', -1.04, { snap: [2.9, 6], tol: 0.12 }), { start: 2.9, end: 7 })
is('a pill dropped near a beat lands flush at whichever end is nearest',
  TE.dragSpan(Z, 'body', 2.05, { snap: [9], tol: 0.12 }), { start: 6, end: 9 })
is('a snap that would push it past the take is held in',
  TE.dragSpan(Z, 'end', 1.05, { hi: 8, snap: [8.04], tol: 0.12 }), { start: 4, end: 8 })

console.log('the neighbours on the zoom track')
const zooms = [{ id: 'Z1', start: 1, end: 3 }, { id: 'Z2', start: 5, end: 7 }, { id: 'Z3', start: 9, end: 11 }]
is('a zoom may not be dragged over the ones either side',
  TE.spanLimits(zooms, 'Z2', { lo: 0, hi: 20 }), { lo: 3, hi: 9 })
is('the first one has the take to its left', TE.spanLimits(zooms, 'Z1', { lo: 0, hi: 20 }), { lo: 0, hi: 5 })
is('a zoom an agent already overlapped is not this drag to repair',
  TE.spanLimits([{ id: 'Z1', start: 1, end: 6 }, { id: 'Z2', start: 5, end: 7 }], 'Z2', { lo: 0, hi: 20 }),
  { lo: 0, hi: 20 })
is('dragged to the edge of its neighbour and no further',
  TE.dragSpan({ start: 5, end: 7 }, 'body', 99, TE.spanLimits(zooms, 'Z2', { lo: 0, hi: 20 })),
  { start: 7, end: 9 })

console.log('a new one at the playhead')
is('it starts where the playhead is', TE.newSpan(4, 2.5, { lo: 0, hi: 20 }), { start: 4, end: 6.5 })
is('near the end it is shortened, never started before the playhead', TE.newSpan(19, 2.5, { lo: 0, hi: 20 }), { start: 19, end: 20 })
is('with less room than the minimum it steps back exactly that far',
  TE.newSpan(19.9, 2.5, { lo: 0, hi: 20, min: 0.4 }), { start: 19.6, end: 20 })
is('a gap too small for the minimum is refused', TE.newSpan(4, 2.5, { lo: 4, hi: 4.2, min: 0.4 }), null)
is('the gap at 4 s is between Z1 and Z2', TE.freeGap(zooms, 4, { lo: 0, hi: 20 }), { lo: 3, hi: 5 })
is('the playhead inside a zoom has no gap to fill', TE.freeGap(zooms, 6, { lo: 0, hi: 20 }), null)
is('and a mark track lets two share a moment', TE.freeGap([], 6, { lo: 0, hi: 20 }), { lo: 0, hi: 20 })

console.log('a rectangle on the stage')
const B = { x: 0.2, y: 0.3, w: 0.4, h: 0.2 }
is('the middle drags the whole thing', TE.dragBox(B, 'move', { x: 0.1, y: -0.1 }), { x: 0.3, y: 0.2, w: 0.4, h: 0.2 })
is('and stops at the edge of the frame with its size whole',
  TE.dragBox(B, 'move', { x: 9, y: 9 }), { x: 0.6, y: 0.8, w: 0.4, h: 0.2 })
is('a corner moves two sides', TE.dragBox(B, 'nw', { x: 0.1, y: 0.1 }), { x: 0.3, y: 0.4, w: 0.3, h: 0.1 })
is('an edge moves one', TE.dragBox(B, 'e', { x: 0.1, y: 0.4 }), { x: 0.2, y: 0.3, w: 0.5, h: 0.2 })
is('pulled through its far side it holds at the minimum, never inside out',
  TE.dragBox(B, 'w', { x: 9, y: 0 }), { x: 0.58, y: 0.3, w: 0.02, h: 0.2 })
is('and never grows past the frame', TE.dragBox(B, 'se', { x: 9, y: 9 }), { x: 0.2, y: 0.3, w: 0.8, h: 0.7 })
is('a step numbers a point, so it only moves', TE.movePoint({ x: 0.5, y: 0.5 }, { x: 0.8, y: -0.9 }), { x: 1, y: 0 })

console.log('re-aiming a zoom, the way an agent does')
{
  const box = { x: 0.62, y: 0.14, w: 0.1, h: 0.05 }
  const was = { id: 'Z1', start: 4, end: 7, scale: 1.2, x: 0.5, y: 0.5 }
  const byHand = TE.aimZoom(was, box)
  const byAgent = FD.normalize({ ...FD.emptyDoc('/t.mp4', 30), zooms: [{ ...was, box }] }, '/t.mp4', 30).zooms[0]
  is('the drag and the agent write the same zoom', byHand, byAgent)
  is('the scale is the one that frames the box, not the one it had', byHand.scale, T.boxZoom(box).scale)
  is('its times are untouched', [byHand.start, byHand.end], [4, 7])
  is('a box too small to mean anything leaves the zoom alone', TE.aimZoom(was, { x: 0.5, y: 0.5, w: 0, h: 0 }), was)
}

console.log('moving a mark')
{
  const redact = { id: 'M1', kind: 'redact', start: 2, end: 5, x: 0.1, y: 0.1, w: 0.2, h: 0.1 }
  const moved = TE.placeMark(redact, TE.dragBox(redact, 'move', { x: 0.05, y: 0 }))
  is('a redaction can be moved onto the thing it hides', [moved.x, moved.y, moved.w, moved.h], [0.15, 0.1, 0.2, 0.1])
  is('and keeps its id and kind', [moved.id, moved.kind], ['M1', 'redact'])
  const step = TE.placeMark({ id: 'M2', kind: 'step', x: 0.1, y: 0.1 }, { x: 0.4, y: 0.44444444, w: 0.2, h: 0.2 })
  is('a step takes the corner and no size', step, { id: 'M2', kind: 'step', x: 0.4, y: 0.4444 })
  is('a blur is made with the strength the export documents', TE.blankMark('blur', { start: 1, end: 4 }).strength, 18)
  is('a new mark made from a lassoed area is exactly that area',
    TE.blankMark('loupe', { start: 1, end: 4 }, { x: 0.25, y: 0.5, w: 0.1, h: 0.08 }),
    { kind: 'loupe', start: 1, end: 4, x: 0.25, y: 0.5, w: 0.1, h: 0.08 })
  is('and one made with nothing to go on is big enough to grab',
    TE.MIN_BOX < TE.blankMark('redact', { start: 1, end: 4 }).w, true)
}

console.log('delete')
is('a mark goes by its id', TE.removeById([{ id: 'M1' }, { id: 'M2' }], 'M1').map(m => m.id), ['M2'])
is('an id that is not there changes nothing', TE.removeById([{ id: 'M1' }], 'M9').length, 1)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
