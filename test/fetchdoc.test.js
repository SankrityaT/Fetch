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

// ---- the nine values that used to live only in the DOM ----
{
  const doc = d.fromLegacy({ src: '/a.mov', dur: 5, in: 0, out: 5, cuts: [] },
    { zoomAmt: 2.2, gain: 6, fadeOut: 1.5, burnCaps: false })
  is('look picks up passed values', [doc.look.zoomAmt, doc.look.gain, doc.look.fadeOut], [2.2, 6, 1.5])
  is('a false value is not lost to a falsy check', doc.look.burnCaps, false)
  is('unpassed values keep their default', doc.look.bdRadius, 14)
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

console.log(`\n  ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
