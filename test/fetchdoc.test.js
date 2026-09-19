const d = require('../ui/fetchdoc')

let pass = 0, fail = 0
const is = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}` +
    (ok ? '' : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`))
}

// ---- clips from trim + cuts ----
const bare = (clips) => clips.map(c => [c.start, c.end])

is('no cuts is one clip',
  bare(d.clipsFromTrim(0, 10, [], 10)), [[0, 10]])

is('one hole makes two clips',
  bare(d.clipsFromTrim(0, 10, [[4, 6]], 10)), [[0, 4], [6, 10]])

is('trim narrows the range',
  bare(d.clipsFromTrim(2, 8, [[4, 6]], 10)), [[2, 4], [6, 8]])

is('a hole at the head does not make an empty clip',
  bare(d.clipsFromTrim(0, 10, [[0, 3]], 10)), [[3, 10]])

is('a hole at the tail does not make an empty clip',
  bare(d.clipsFromTrim(0, 10, [[7, 10]], 10)), [[0, 7]])

// overlapping holes previously could produce a clip with end < start
is('overlapping holes merge',
  bare(d.clipsFromTrim(0, 10, [[3, 6], [5, 8]], 10)), [[0, 3], [8, 10]])

is('unsorted holes still work',
  bare(d.clipsFromTrim(0, 10, [[7, 8], [2, 3]], 10)), [[0, 2], [3, 7], [8, 10]])

is('holes outside the trim are clipped away',
  bare(d.clipsFromTrim(2, 8, [[0, 1], [9, 10]], 10)), [[2, 8]])

is('a hole covering everything leaves nothing',
  bare(d.clipsFromTrim(0, 10, [[0, 10]], 10)), [])

// ---- round trip ----
const rt = (inT, outT, cuts, dur) => {
  const clips = d.clipsFromTrim(inT, outT, cuts, dur)
  return d.trimFromClips(clips)
}
is('round trip preserves the holes', rt(0, 10, [[4, 6]], 10), { start: 0, end: 10, cuts: [[4, 6]] })
is('round trip preserves trim', rt(2, 8, [[4, 6]], 10), { start: 2, end: 8, cuts: [[4, 6]] })
is('round trip of a single clip has no cuts', rt(0, 10, [], 10), { start: 0, end: 10, cuts: [] })

// ---- ids ----
{
  const doc = d.fromLegacy({ src: '/a.mov', dur: 10, in: 0, out: 10, cuts: [[4, 6]], texts: [{ text: 'hi' }] })
  is('clips get C ids', doc.clips.map(c => c.id), ['C1', 'C2'])
  is('texts get T ids', doc.texts.map(t => t.id), ['T1'])
  is('counter advanced past what it minted', doc.nextId.C, 3)

  // the whole point: an id must not be reused after a delete
  doc.clips.splice(0, 1)
  const fresh = d.mintId(doc, 'clips')
  is('a new clip does not reuse C1', fresh, 'C3')
  is('surviving clip keeps its id', doc.clips[0].id, 'C2')
}

// ---- the nine values that used to live only in the DOM, now in look and audio ----
{
  const doc = d.fromLegacy({ src: '/a.mov', dur: 5, in: 0, out: 5, cuts: [] },
    { zoomAmt: 2.2, gain: 6, fadeOut: 1.5, burnCaps: false })
  is('look picks up passed values', [doc.look.motion.zoomDepth, doc.audio.gain, doc.look.motion.fadeOut], [2.2, 6, 1.5])
  is('a false value is not lost to a falsy check', doc.look.captions.show, false)
  is('unpassed values keep their default', doc.look.frame.radius, 14)
}

// ---- normalize repairs, never throws ----
is('garbage becomes an empty doc', d.normalize(null, '/a.mov', 3).clips, [])
is('a corrupt array is dropped, not fatal', d.normalize({ clips: 'nope' }, '/a.mov', 3).clips, [])

{
  // a counter behind an id in use would hand out a duplicate
  const doc = d.normalize({ clips: [{ id: 'C7', start: 0, end: 1 }], nextId: { C: 2 } }, '/a.mov', 3)
  is('counter is pulled past ids already in use', d.mintId(doc, 'clips'), 'C8')
}
{
  const doc = d.normalize({ clips: [{ start: 0, end: 1 }, { start: 2, end: 3 }] }, '/a.mov', 3)
  is('missing ids are filled in', doc.clips.map(c => c.id), ['C1', 'C2'])
}
{
  // a zoom asked for with times alone lands on the export's defaults, not undefined
  const doc = d.normalize({ zooms: [{ start: 0, end: 2 }, { start: 3, end: 4, scale: 2.5, x: 0, y: 0.2 }] }, '/a.mov', 6)
  is('a bare zoom gets 1.8x on the centre', ['scale', 'x', 'y'].map(k => doc.zooms[0][k]), [1.8, 0.5, 0.5])
  is('a zoom that says where keeps it, 0 included', ['scale', 'x', 'y'].map(k => doc.zooms[1][k]), [2.5, 0, 0.2])
}

// ---- export opts ----
{
  const doc = d.fromLegacy({ src: '/a.mov', dur: 10, in: 1, out: 9, cuts: [[4, 6]] }, { zoomAmt: 2, gain: 3 })
  const o = d.toExportOpts(doc)
  is('export start/end/cuts come from clips', [o.start, o.end, o.cuts], [1, 9, [[4, 6]]])
  is('export reads look, not the DOM', [o.autoZoomOpts.zoom, o.gain], [2, 3])
  is('camera is omitted when off', d.toExportOpts({ ...doc, camera: { on: false } }).camera, null)
}

// ---- helpers ----
{
  const doc = d.fromLegacy({ src: '/a.mov', dur: 10, in: 0, out: 10, cuts: [[4, 6]] })
  is('outDuration sums the clips, not the span', d.outDuration(doc), 8)
  is('byId finds across kinds', d.byId(doc, 'C2').item.start, 6)
  is('byId misses cleanly', d.byId(doc, 'Z9'), null)
}

// ---- partial updates keep what they do not mention ----
{
  const mine = d.normalize({ clips:[{id:'C1',start:0,end:6}], crop:{x:.1,y:.1,w:.8,h:.8},
    capStyle:{font:'Georgia',colour:'#FFD9A0'}, backdrop:'ink', look:{denoise:true,gain:4} }, '/x', 6)
  const after = d.normalize(d.mergeDoc(mine, { zooms:[{start:1,end:3,scale:2,x:.5,y:.5}] }), '/x', 6)
  is('adding a zoom keeps the crop', after.crop, { x:.1, y:.1, w:.8, h:.8 })
  is('adding a zoom keeps the caption font', after.look.captions.font, 'Georgia')
  is('adding a zoom keeps the backdrop', [after.look.background.kind, after.look.background.gradient], ['gradient', 'ink'])
  is('adding a zoom keeps the sound', [after.audio.denoise, after.audio.gain], [true, 4])
  is('and the zoom is there', after.zooms.length, 1)

  const tweak = d.mergeDoc(mine, { look: { gain: -2 } })
  is('a v1 sound change merges, not replaces', [tweak.audio.gain, tweak.audio.denoise], [-2, true])
  const pad = d.mergeDoc(mine, { look: { frame: { padding: 0.1 } } })
  is('a look change merges, not replaces', [pad.look.frame.padding, pad.look.background.gradient, pad.look.captions.font], [0.1, 'ink', 'Georgia'])
  is('a list replaces as a whole', d.mergeDoc(mine, { clips: [] }).clips, [])
  is('crop can be cleared explicitly', d.mergeDoc(mine, { crop: null }).crop, null)
  is('undefined is ignored', d.mergeDoc(mine, { crop: undefined }).crop, { x:.1, y:.1, w:.8, h:.8 })
}

// ---- marks merge by id, and only remove deletes ----
{
  // the precision suite's repro: redaction blurs M45, M46 and a spotlight M53, and an
  // agent adding one lift sent back only the lift and the steps it had in mind
  const blurs = [{ id: 'M45', kind: 'blur', start: 0, end: 60, x: .02, y: .1, w: .15, h: .03 },
    { id: 'M46', kind: 'redact', start: 0, end: 60, x: .8, y: .02, w: .1, h: .03 }]
  const steps = [48, 49].map((n, i) => ({ id: 'M' + n, kind: 'step', start: 5 + i, end: 7 + i, x: .3, y: .3 + i * .1 }))
  const spot = { id: 'M53', kind: 'spotlight', start: 40, end: 44, x: .5, y: .5, w: .2, h: .2 }
  const doc = d.normalize({ marks: [...blurs, ...steps, spot], nextId: { M: 54 } }, '/x', 60)
  const lift = { kind: 'lift', start: 20.6, end: 27.8, x: .75, y: .47, w: .23, h: .32 }
  const after = d.normalize(d.mergeDoc(doc, { marks: [lift, { ...steps[0], x: .31 }] }), '/x', 60)
  is('marks left out stay', after.marks.map(m => m.id), ['M45', 'M46', 'M48', 'M49', 'M53', 'M54'])
  is('one sent with its id is changed in place', after.marks[2].x, .31)
  const m = d.mergeMarks(doc.marks, [{ ...lift, id: undefined }], ['m45', 'M53'])
  is('remove names what goes, and says so', [m.marks.map(x => x.id), m.removed], [['M46', 'M48', 'M49', undefined], ['M45', 'M53']])
  is('remove works without a marks list', d.mergeDoc(doc, { remove: ['M46'] }).marks.map(x => x.id), ['M45', 'M48', 'M49', 'M53'])
  is('and on any list, never stored', (x => [x.zooms.length, 'remove' in x])(d.mergeDoc({ zooms: [{ id: 'Z1', start: 0, end: 1 }] }, { remove: ['Z1'] })), [0, false])
  is('an empty marks list deletes nothing', d.mergeDoc(doc, { marks: [] }).marks.length, 5)
  // Sonnet listed the steps to keep as bare ids, and they came back with no kind or times
  const kept = d.normalize(d.mergeDoc(doc, { marks: [{ id: 'M48' }, { id: 'M49', start: 6.5 }] }), '/x', 60)
  is('a bare id keeps its mark whole', kept.marks.find(x => x.id === 'M48'), doc.marks.find(x => x.id === 'M48'))
  is('an id with one field changes only that', (x => [x.kind, x.start, x.x])(kept.marks.find(x => x.id === 'M49')), ['step', 6.5, .3])
  const moved = d.mergeMarks(doc.marks, [{ id: 'M53', kind: 'lift', box: { x: .6, y: .6, w: .1, h: .1 } }]).marks.find(x => x.id === 'M53')
  is('a new box replaces the old placement', [moved.kind, moved.x, moved.box.x, moved.start], ['lift', undefined, .6, 40])
}

console.log(`\n  ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
