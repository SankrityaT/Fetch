// The lasso, and targeting enforced in code. Two halves of one idea: the person can
// point at an area of their own video (ui/targets.js snapBox, regionLabel; the region
// store in ui/agent-bridge.js), and apply_edit no longer takes an agent's aim on trust
// (nearPoint, zoomFit, liftNeedsBox, and the rules in withElements and aimZooms).
// Plain node: nothing here needs a window, a socket or ffmpeg.
const T = require('../ui/targets')
const FD = require('../ui/fetchdoc')
const AB = require('../ui/agent-bridge')

let pass = 0, fail = 0
const is = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}` +
    (ok ? '' : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`))
}
const threw = async (name, fn, has) => {
  let msg = null
  try { await fn() } catch (e) { msg = e.message }
  is(name, msg && msg.includes(has) ? has : msg, has)
}

// One screen, the shape Elements.swift reads: a pane with a card in it, an Export chip
// beside it, a line of text and a small icon.
const ELS = [
  { id: 'E1', kind: 'panel', text: 'Recently played Details Export', box: { x: 0.04, y: 0.08, w: 0.6, h: 0.7 } },
  { id: 'E2', kind: 'card', text: 'Details', box: { x: 0.08, y: 0.5, w: 0.3, h: 0.2 } },
  { id: 'E3', kind: 'chip', text: 'Export', box: { x: 0.44, y: 0.26, w: 0.12, h: 0.05 } },
  { id: 'E4', kind: 'text', text: 'Recently played', box: { x: 0.1, y: 0.12, w: 0.2, h: 0.02 } },
  { id: 'E5', kind: 'icon', text: '+', box: { x: 0.9, y: 0.05, w: 0.03, h: 0.03 } },
]

console.log('\nsnapping a drawn rectangle to what is under it')
{
  is('a sloppy box over a chip is that chip',
    T.snapBox({ x: 0.435, y: 0.255, w: 0.13, h: 0.055 }, ELS).element, 'E3')
  is('and comes back as the chip\'s own box',
    T.snapBox({ x: 0.435, y: 0.255, w: 0.13, h: 0.055 }, ELS).box, ELS[2].box)
  // same overlap, two candidates: the smaller one is what was drawn round
  const tie = [
    { id: 'E1', kind: 'card', text: 'wide', box: { x: 0.2, y: 0.2, w: 0.25, h: 0.2 } },
    { id: 'E2', kind: 'card', text: 'tight', box: { x: 0.2, y: 0.2, w: 0.16, h: 0.2 } },
  ]
  is('a tie on overlap goes to the smaller box', T.snapBox({ x: 0.2, y: 0.2, w: 0.2, h: 0.2 }, tie).element, 'E2')
  const same = [
    { id: 'E7', kind: 'card', text: 'later', box: { x: 0.2, y: 0.2, w: 0.2, h: 0.2 } },
    { id: 'E3', kind: 'card', text: 'earlier', box: { x: 0.2, y: 0.2, w: 0.2, h: 0.2 } },
  ]
  is('and a tie on size to the lower E number', T.snapBox({ x: 0.2, y: 0.2, w: 0.2, h: 0.2 }, same).element, 'E3')
  is('a small drag inside a chip takes the chip',
    T.snapBox({ x: 0.46, y: 0.275, w: 0.05, h: 0.03 }, ELS).element, 'E3')
  is('the same drag inside a whole panel takes nothing',
    T.snapBox({ x: 0.3, y: 0.6, w: 0.05, h: 0.03 }, ELS).element, null)
  is('a drag over empty ground stays exactly as drawn',
    T.snapBox({ x: 0.7, y: 0.82, w: 0.1, h: 0.06 }, ELS), { box: { x: 0.7, y: 0.82, w: 0.1, h: 0.06 }, element: null, kind: 'free', iou: 0 })
  is('a line of text is never what a rectangle means', T.snapBox(ELS[3].box, ELS).element, null)
  is('a box that is not one snaps to nothing', T.snapBox({ x: 0.2, y: 0.2, w: 0, h: 0.1 }, ELS).box, null)
}

console.log('\nthe element under a point')
{
  is('a point in two boxes takes the smaller', T.nearPoint({ x: 0.5, y: 0.285 }, ELS).id, 'E3')
  const flat = [ELS[2], ELS[4]]
  is('a point just outside takes the nearest within reach', T.nearPoint({ x: 0.62, y: 0.285 }, flat).id, 'E3')
  is('a point in the middle of nowhere takes nothing', T.nearPoint({ x: 0.2, y: 0.95 }, flat), null)
  is('a point with no numbers in it takes nothing', T.nearPoint({ x: null, y: 0.5 }, ELS), null)
  // a line of words is inside the control it labels and is the smallest thing round
  // the point, so taking it would frame a sliver of what was aimed at
  is('a point on a line of text takes the thing around it', T.nearPoint({ x: 0.2, y: 0.13 }, ELS).id, 'E1')
  is('and with nothing around it, nothing at all', T.nearPoint({ x: 0.2, y: 0.13 }, [ELS[3]]), null)
}

console.log('\nhow much of the view the target fills')
{
  const box = { x: 0.4, y: 0.3, w: 0.3, h: 0.2 }
  is('a zoom scales both axes alike, so the share is the wider one', T.zoomShare(2, box), 0.6)
  const ok = T.zoomFit({ x: 0.55, y: 0.4, scale: 2 }, box)
  is('a scale that already reads is left alone', [ok.changed, ok.scale, ok.share, ok.x], [false, 2, 0.6, 0.55])
  const loose = T.zoomFit({ x: 0.5, y: 0.5, scale: 1.3 }, { x: 0.3, y: 0.4, w: 0.25, h: 0.15 })
  const fit = T.boxZoom({ x: 0.3, y: 0.4, w: 0.25, h: 0.15 })
  is('a zoom too loose on its target is tightened to Fetch\'s own fit',
    [loose.changed, loose.scale, loose.x, loose.y], [true, fit.scale, fit.x, fit.y])
  is('and the tightened zoom fills at least half the view', loose.share >= T.FIT_LOW && !loose.capped, true)
  const tight = T.zoomFit({ x: 0.5, y: 0.5, scale: 3.4 }, { x: 0.3, y: 0.4, w: 0.3, h: 0.2 })
  is('a zoom so tight the target is cut off is widened', [tight.changed, tight.scale < 3.4], [true, true])
  const tiny = T.zoomFit({ x: 0.5, y: 0.5, scale: 1.8 }, { x: 0.5, y: 0.5, w: 0.02, h: 0.02 })
  is('a 0.02 element reports the 2.6x ceiling rather than pretending', [tiny.scale, tiny.capped], [T.BOX_MAX, true])
  is('a zoom fitted to no box at all is nothing', T.zoomFit({ scale: 2 }, null), null)
}

console.log('\nwhat to call the area someone drew')
{
  is('snapped to a chip, its own words', T.regionLabel(ELS[2].box, ELS, 'E3'), 'Export')
  const quiet = [{ id: 'E9', kind: 'panel', text: '', box: { x: 0.1, y: 0.1, w: 0.4, h: 0.4 } }]
  is('snapped to something with nothing written on it, its kind', T.regionLabel(quiet[0].box, quiet, 'E9'), 'Panel')
  is('free over two texts, the longest of them',
    T.regionLabel({ x: 0.05, y: 0.1, w: 0.6, h: 0.25 }, ELS, null), 'Recently played')
  is('free over nothing at all', T.regionLabel({ x: 0.8, y: 0.85, w: 0.1, h: 0.1 }, ELS, null), 'Area')
  const long = [{ id: 'E1', kind: 'chip', text: 'Tonight: a favorite you have not played yet, ever', box: { x: 0.1, y: 0.1, w: 0.4, h: 0.1 } }]
  is('and never longer than the chip can hold', T.regionLabel(long[0].box, long, 'E1').length <= 40, true)
}

console.log('\na lift has to say what it raises')
{
  const need = T.liftNeedsBox({ kind: 'lift', start: 10, end: 14 })
  is('a lift with only a time is refused', typeof need === 'string', true)
  is('and the refusal names both ways out',
    [need.includes('find_on_screen at 11 s'), need.includes('its E id'), need.includes('its R id')], [true, true, true])
  is('a lift naming an element is aimed', T.liftNeedsBox({ kind: 'lift', element: 'E3', start: 1, end: 4 }), null)
  is('a lift with a box is aimed', T.liftNeedsBox({ kind: 'lift', box: ELS[2].box }), null)
  is('a lift with all four of x, y, w, h is aimed',
    T.liftNeedsBox({ kind: 'lift', x: 0.1, y: 0.1, w: 0.2, h: 0.2 }), null)
  is('a lift with a centre point and no size is not', typeof T.liftNeedsBox({ kind: 'lift', x: 0.1, y: 0.1 }) === 'string', true)
}

console.log('\nthe areas the person lassoed, per recording')
const TAKE = '/tmp/fetch-test/Take.mov', OTHER = '/tmp/fetch-test/Other.mov'
const region = (box, o = {}) => ({ id: null, path: TAKE, at: 12.34, box, element: null, kind: 'free', label: 'Area', ...o })
{
  const r1 = AB.noteRegion(TAKE, region({ x: 0.44, y: 0.26, w: 0.12, h: 0.05 }, { element: 'E3', kind: 'chip', label: 'Export' }))
  const r2 = AB.noteRegion(TAKE, region({ x: 0.1, y: 0.5, w: 0.2, h: 0.2 }))
  is('ids count up per recording', [r1.id, r2.id], ['R1', 'R2'])
  is('a region comes back by its id', AB.regionFor(TAKE, 'R1').label, 'Export')
  is('and by an id typed in lower case', AB.regionFor(TAKE, 'r2').id, 'R2')
  is('taking one off the message forgets it', [AB.forgetRegion(TAKE, 'R1'), AB.regionFor(TAKE, 'R1')], [true, null])
  is('forgetting it twice is not an error', AB.forgetRegion(TAKE, 'R1'), false)
  is('an id is never handed out twice in a session', AB.noteRegion(TAKE, region({ x: 0.2, y: 0.2, w: 0.1, h: 0.1 })).id, 'R3')
  is('another recording counts from its own start', AB.noteRegion(OTHER, region({ x: 0.2, y: 0.2, w: 0.1, h: 0.1 })).id, 'R1')
  is('and the two do not see each other', AB.regionFor(OTHER, 'R2'), null)
  // the ninth pushes the first out: a composer holds eight chips at most
  const many = '/tmp/fetch-test/Many.mov'
  for (let i = 0; i < 9; i++) AB.noteRegion(many, { ...region({ x: 0.1, y: 0.1, w: 0.1, h: 0.1 }), path: many })
  is('the ninth area evicts the first', [AB.regionFor(many, 'R1'), !!AB.regionFor(many, 'R2'), !!AB.regionFor(many, 'R9')], [null, true, true])
}

console.log('\nan area the person drew is a target like any other')
{
  AB.noteFound(TAKE, 11, ELS, ELS)
  const r = AB.noteRegion(TAKE, region({ x: 0.44, y: 0.26, w: 0.12, h: 0.05 }, { element: 'E3', kind: 'chip', label: 'Export' }))
  const out = AB.withElements(TAKE, { zooms: [{ start: 10, end: 13, element: r.id }] })
  is('a zoom aimed at a region gets that region\'s box, untouched', out.zooms[0].box, r.box)
  is('and the region id is gone from the zoom', out.zooms[0].element, undefined)
  is('a find_on_screen never overwrites a region', AB.regionFor(TAKE, r.id).box, r.box)
  is('and a region is never an E id', AB.regionFor(TAKE, 'E3'), null)
  const mark = AB.withElements(TAKE, { marks: [{ kind: 'spotlight', start: 10, end: 13, element: 'E3' }] })
  is('an E id still resolves out of the other map', mark.marks[0].box, ELS[2].box)
  // E ids are positional per frame, so a pass Fetch ran for itself (the lasso snapping
  // while the person scrubs, a zoom's aim) must not renumber the ones the agent holds
  const later = [
    { id: 'E1', kind: 'chip', text: 'Share', box: { x: 0.7, y: 0.7, w: 0.1, h: 0.05 } },
    { id: 'E9', kind: 'chip', text: 'Done', box: { x: 0.8, y: 0.8, w: 0.1, h: 0.05 } },
  ]
  AB.noteFound(TAKE, 30, later, later, { agent: false })
  is('a pass Fetch ran for itself leaves the agent\'s E ids where they were',
    AB.withElements(TAKE, { zooms: [{ start: 10, end: 13, element: 'E1' }] }).zooms[0].box, ELS[0].box)
  is('and an id only that pass saw still resolves',
    AB.withElements(TAKE, { zooms: [{ start: 10, end: 13, element: 'E9' }] }).zooms[0].box, later[1].box)
}

console.log('\nan area is read in the crop the edit is in')
{
  const r4 = n => Math.round(n * 10000) / 10000
  const box4 = b => b && { x: r4(b.x), y: r4(b.y), w: r4(b.w), h: r4(b.h) }
  const moved = '/tmp/fetch-test/Cropped.mov'
  // drawn with no crop set, then the agent crops and aims at it in the next call
  const r = AB.noteRegion(moved, { ...region({ x: 0.1, y: 0.2, w: 0.2, h: 0.1 }), path: moved, crop: null })
  const out = AB.withElements(moved, { zooms: [{ start: 1, end: 3, element: r.id }] },
    { crop: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } })
  is('the same pixels, read again through the crop now in force',
    box4(out.zooms[0].box), { x: 0, y: 0.2, w: 0.4, h: 0.2 })
  const same = AB.withElements(moved, { zooms: [{ start: 1, end: 3, element: r.id }] }, { crop: null })
  is('and with the crop it was drawn in, the box it was drawn as', same.zooms[0].box, r.box)
}

console.log('\nthe rules apply_edit keeps')
const run = async () => {
  // Rule 2: a lift with no box is refused, and the refusal is useful
  await threw('a lift with nothing but a time is refused',
    () => AB.withElements(TAKE, { marks: [{ kind: 'lift', start: 10, end: 14 }] }),
    'A lift needs the box of the thing it raises')
  const had = { marks: [{ id: 'M4', kind: 'lift', start: 2, end: 6, x: 0.1, y: 0.1, w: 0.2, h: 0.2 }] }
  const kept = AB.withElements(TAKE, { marks: [{ id: 'M4', kind: 'lift', start: 10, end: 14 }] }, had)
  is('retiming a lift already in the edit is not refused', kept.marks[0].id, 'M4')
  // an id the document has never seen is a new mark, and mergeMarks pushes it through
  // as one, so a made-up id used to land a lift with no geometry at all
  await threw('a lift on an id the edit does not know is refused like any other',
    () => AB.withElements(TAKE, { marks: [{ id: 'M99', kind: 'lift', start: 5, end: 9 }] }, had),
    'A lift needs the box of the thing it raises')
  await threw('an unknown region is refused by name, with what to do instead',
    () => AB.withElements(TAKE, { zooms: [{ start: 1, end: 2, element: 'R91' }] }),
    'R91 is not an area the person lassoed on this recording')

  // a lasso does not buy a way past the lift rules
  const edge = [
    { id: 'E1', kind: 'panel', text: 'Details', box: { x: 0.0, y: 0.1, w: 0.6, h: 0.7 } },
    { id: 'E2', kind: 'card', text: 'Stats', box: { x: 0.08, y: 0.5, w: 0.3, h: 0.2 } },
  ]
  const flush = '/tmp/fetch-test/Flush.mov'
  AB.noteFound(flush, 11, edge, edge)
  const big = AB.noteRegion(flush, { ...region(edge[0].box, { element: 'E1', kind: 'panel', label: 'Details' }), path: flush })
  await threw('a lift on a lassoed area flush with the frame edge is still refused',
    () => AB.withElements(flush, { marks: [{ kind: 'lift', start: 10, end: 14, element: big.id }] }),
    'Not lifting E1')

  // Rule 1: a zoom given only a point is put on the element under it
  AB.noteFound(TAKE, 11, ELS, ELS)
  const doc = { zooms: [{ start: 10, end: 13, x: 0.5, y: 0.285, scale: 2 }] }
  const aim = await AB.aimZooms(TAKE, doc, null)
  const fit = T.boxZoom(ELS[2].box)
  is('a point-only zoom snaps to the box under the point', doc.zooms[0].box, ELS[2].box)
  is('and the result says which element it was put on',
    [aim.snapped.length, aim.snapped[0].element, aim.snapped[0].at], [1, 'E3', 11])
  is('and what the zoom became', aim.snapped[0].to, fit)
  is('the point it was sent with is still in the report', aim.snapped[0].from, { x: 0.5, y: 0.285, scale: 2 })

  // Rule 3: a zoom is held to a readable share of the view
  const loose = { zooms: [{ id: 'Z1', start: 4, end: 8, box: { x: 0.3, y: 0.4, w: 0.25, h: 0.15 }, scale: 1.3 }] }
  const r3 = await AB.aimZooms(TAKE, loose, null)
  is('a zoom too loose on its target is tightened',
    r3.refit.map(z => [z.id, z.scale_sent, z.scale]), [['Z1', 1.3, T.boxZoom(loose.zooms[0].box).scale]])
  is('and the scale it sent is dropped, so the box path fits it once', 'scale' in loose.zooms[0], false)
  // a box on a zoom wins over any scale beside it downstream (ui/fetchdoc.js:252), so
  // a scale inside the readable band is replaced too, and saying nothing about it told
  // the agent its own number had stood
  const fine = { zooms: [{ id: 'Z3', start: 1, end: 4, x: 0.45, y: 0.4, scale: 2, box: { x: 0.3, y: 0.3, w: 0.3, h: 0.2 } }] }
  const r5 = await AB.aimZooms(TAKE, fine, null)
  is('a scale beside a box is reported as replaced, not quietly dropped',
    [r5.refit[0].id, r5.refit[0].scale_sent, r5.refit[0].scale],
    ['Z3', 2, T.boxZoom(fine.zooms[0].box).scale])
  is('and the report says the box is what framed it', /a box frames its own zoom/.test(r5.refit[0].why), true)
  const tiny = { zooms: [{ id: 'Z2', start: 4, end: 8, box: { x: 0.5, y: 0.5, w: 0.02, h: 0.02 }, scale: 3 }] }
  const r4 = await AB.aimZooms(TAKE, tiny, null)
  is('a target too small for any zoom is reported, not fixed', r4.warnings[0].share < T.FIT_LOW, true)

  // Rule 1 leaves alone what was never aimed
  const plain = { zooms: [{ start: 0, end: 2 }] }
  is('a zoom with no point and no box still means 1.8x at the centre',
    [await AB.aimZooms(TAKE, plain, null), plain.zooms[0]], [null, { start: 0, end: 2 }])
  const held = { zooms: [{ id: 'Z1', start: 4, end: 8, scale: 1.8, x: 0.5, y: 0.5 }] }
  const was = { zooms: [{ id: 'Z1', start: 4, end: 8, scale: 1.8, x: 0.5, y: 0.5 }] }
  is('a zoom sent back unchanged is not re-aimed under the person',
    [await AB.aimZooms(TAKE, held, was), held.zooms[0].box], [null, undefined])
}

console.log('\nan edit saved before any of this still opens')
const old = async () => {
  // a v1 document: no look, no marks list of its own, zooms by centre and scale
  const v1 = {
    v: 1, src: TAKE, dur: 30, clips: [{ id: 'C1', start: 0, end: 30 }],
    zooms: [{ id: 'Z1', start: 2, end: 6, scale: 2.2, x: 0.4, y: 0.35 }],
    marks: [{ id: 'M1', kind: 'lift', start: 8, end: 12, x: 0.1, y: 0.2, w: 0.3, h: 0.2 }],
    texts: [{ id: 'T1', text: 'Hello', start: 0, end: 3, fx: 0.5, fy: 0.5 }],
    burnCaps: true, backdrop: 'ink',
  }
  const doc = FD.normalize(JSON.parse(JSON.stringify(v1)), TAKE, 30)
  is('its zoom is still where it was', [doc.zooms[0].scale, doc.zooms[0].x, doc.zooms[0].y], [2.2, 0.4, 0.35])
  is('its lift is still where it was', [doc.marks[0].id, doc.marks[0].w], ['M1', 0.3])
  // and the same document sent back as a patch is not touched by the new rules
  const patch = AB.withElements(TAKE, { zooms: doc.zooms.map(z => ({ ...z })), marks: doc.marks.map(m => ({ ...m })) })
  is('an old lift with x, y, w, h is not refused', patch.marks[0].id, 'M1')
  is('and aiming leaves an unchanged old zoom alone', await AB.aimZooms(TAKE, patch, doc), null)
}

run().then(old).then(() => {
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
})
