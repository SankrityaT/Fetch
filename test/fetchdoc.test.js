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
is('round trip preserves the holes', rt(0, 10, [[4, 6]], 10), { start: 0, end: 10, cuts: [[4, 6]], rates: null, clipAudio: null })
is('round trip preserves trim', rt(2, 8, [[4, 6]], 10), { start: 2, end: 8, cuts: [[4, 6]], rates: null, clipAudio: null })
is('round trip of a single clip has no cuts', rt(0, 10, [], 10), { start: 0, end: 10, cuts: [], rates: null, clipAudio: null })

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

// ---- a clip's own sound ----
{
  is('a clip says only what it really set',
    [d.cleanClipAudio({ gain: 6 }), d.cleanClipAudio({ denoise: true }), d.cleanClipAudio({ mute: true })],
    [{ gain: 6 }, { denoise: true }, { mute: true }])
  is('nothing, or nonsense, is nothing at all',
    [d.cleanClipAudio(null), d.cleanClipAudio({}), d.cleanClipAudio({ gain: 'loud' }), d.cleanClipAudio({ mute: false })],
    [null, null, null, null])
  is('a level is clamped where the take\'s is', [d.cleanClipAudio({ gain: 40 }).gain, d.cleanClipAudio({ gain: -40 }).gain], [10, -10])
  // 0 is a real answer: hold this clip's own level while the take is lifted around it
  is('and an explicit nought is kept', d.cleanClipAudio({ gain: 0 }), { gain: 0 })

  const doc = d.normalize({ v: 2, clips: [
    { id: 'C1', start: 0, end: 4 },
    { id: 'C2', start: 4, end: 9, audio: { gain: 5, denoise: true, junk: 1 } },
    { id: 'C3', start: 9, end: 12, audio: {} },
  ] }, '/x.mov', 12)
  is('a clip that asked for nothing carries nothing', doc.clips[0], { id: 'C1', start: 0, end: 4 })
  is('a clip that asked carries what it asked, and only that', doc.clips[1].audio, { gain: 5, denoise: true })
  is('an empty bag is dropped rather than kept as clutter', 'audio' in doc.clips[2], false)

  const opts = d.toExportOpts(doc)
  is('the spans reach the exporter beside the cuts', opts.clipAudio, [[4, 9, { gain: 5, denoise: true }]])
  is('and the take keeps saying what it always said', [opts.gain, opts.denoise], [0, false])

  // A clip asking for exactly what the take already does is not per-clip sound. It has
  // to come back null, or an edit would be put on the cut graph for nothing.
  const same = d.normalize({ v: 2, audio: { gain: 5, denoise: true }, clips: [
    { id: 'C1', start: 0, end: 4, audio: { gain: 5 } }, { id: 'C2', start: 4, end: 9, audio: { denoise: true } },
  ] }, '/x.mov', 9)
  is('a clip agreeing with the take is not per-clip sound', d.toExportOpts(same).clipAudio, null)
  is('and one disagreeing by a decibel is',
    d.toExportOpts(d.mergeDoc(same, { clips: [{ id: 'C1', start: 0, end: 4, audio: { gain: 4 } }, { id: 'C2', start: 4, end: 9 }] })).clipAudio,
    [[0, 4, { gain: 4 }]])
  is('the compositor is told the same thing', d.toRenderSpec(doc).clipAudio, [[4, 9, { gain: 5, denoise: true }]])
}

// ---- and a document saved before any of that ----
{
  // A v1 file as it was written to disk: the trim and cuts, the slider bag, the sound
  // spread over look. It has to load, and to reach the exporter asking for nothing per
  // clip, so the one chain over the whole take is the chain it gets (test/timeline.test.js
  // holds that chain, character for character).
  const saved = JSON.parse(JSON.stringify({
    src: '/old.mov', dur: 30, in: 2, out: 28, cuts: [[10, 12]],
    capStyle: { font: 'Georgia' }, backdrop: 'ink',
    texts: [{ text: 'hello', start: 1, end: 3 }],
  }))
  const doc = d.fromLegacy(saved, { gain: 4, denoise: true, loudnorm: true, zoomAmt: 2 })
  const o = d.toExportOpts(doc)
  is('it still loads', [doc.v, doc.clips.length, doc.texts.length], [2, 2, 1])
  is('its sound is the take\'s, where it has always been', [o.gain, o.denoise, o.loudnorm], [4, true, true])
  is('no clip of it asks for anything of its own', o.clipAudio, null)
  is('and normalizing it twice changes nothing', JSON.stringify(d.normalize(doc, '/old.mov', 30)), JSON.stringify(doc))

  // the same claim for a v2 document from before this round: its clips come back
  // exactly as they were written, with no audio key invented for them
  const v2 = { v: 2, src: '/x.mov', dur: 12, audio: { gain: 3, denoise: true, loudnorm: false, music: null, speedAudio: 'mute' },
    clips: [{ id: 'C1', start: 0, end: 5 }, { id: 'C2', start: 6, end: 12, rate: 4 }] }
  const back = d.normalize(JSON.parse(JSON.stringify(v2)), '/x.mov', 12)
  is('a v2 document\'s clips come back as they were written', back.clips, v2.clips)
  is('and it asks for nothing per clip either', d.toExportOpts(back).clipAudio, null)
}

// ---- the mark family decides on screen, not on the clock ----
// A shot has no timeline and reaches these through one lent span (ui/shot.js). Every
// claim below is the same claim: with the times equal, the answer still comes out, and
// it comes out of where the marks are. Break one of these and screenshots break with it.
{
  const SPAN = [0, 4]
  const one = (kind, x, y, w, h, extra = {}) => ({ kind, start: SPAN[0], end: SPAN[1], x, y, w, h, ...extra })

  is('an id-less mark is matched to the one it replaces with no time to tell them apart',
    d.adoptIds([one('blur', 0.1, 0.1, 0.2, 0.1, { id: 'M7' })], [one('blur', 0.1, 0.1, 0.2, 0.1)]).map(m => m.id), ['M7'])

  is('a mark not sent survives even though every mark shares one span',
    d.mergeMarks([one('redact', 0.1, 0.1, 0.2, 0.1, { id: 'M1' })], [one('step', 0.5, 0.5, 0, 0, { id: 'M2' })], null)
      .marks.map(m => m.id), ['M1', 'M2'])

  // the whole point: with the clock saying nothing, overlap on screen decides alone
  const covered = d.settleFocus([one('spotlight', 0.2, 0.2, 0.4, 0.3, { id: 'M1' })],
    [one('spotlight', 0.2, 0.2, 0.4, 0.3, { id: 'M1' }), one('lift', 0.22, 0.22, 0.36, 0.26)])
  is('a lift over a spotlight replaces it on the spatial test alone', covered.replaced, ['M1'])
  const beside = d.settleFocus([one('spotlight', 0.2, 0.2, 0.3, 0.2, { id: 'M1' })],
    [one('spotlight', 0.2, 0.2, 0.3, 0.2, { id: 'M1' }), one('lift', 0.7, 0.7, 0.2, 0.2)])
  is('and one somewhere else does not', beside.replaced, [])

  is('two sharing the one span and the screen are still reported',
    d.focusClashes([one('lift', 0.2, 0.2, 0.3, 0.3, { id: 'M1' }), one('spotlight', 0.3, 0.3, 0.3, 0.3, { id: 'M2' })])
      .map(c => [c.a, c.b]), [['M1', 'M2']])
  is('and two that only share the span are not',
    d.focusClashes([one('lift', 0.05, 0.05, 0.2, 0.2, { id: 'M1' }), one('spotlight', 0.7, 0.7, 0.2, 0.2, { id: 'M2' })]), [])
}

// The glass's measured corner rides with its rectangle. cleanBox kept the rectangle
// alone, so the phone shell masked with the window's small radius and the Simulator's
// own bezel showed as a crescent in every corner.
{
  const FDc = require('../ui/fetchdoc')
  const v = FDc.normalize({ viewport: { x: 0.0554, y: 0.0896, w: 0.8892, h: 0.8929, corner: 0.1563 } }).viewport
  is('a viewport keeps its glass corner through normalize', v && v.corner, 0.1563)
  is('a corner out of range is dropped, the rectangle kept',
    FDc.normalize({ viewport: { x: 0.1, y: 0.1, w: 0.5, h: 0.5, corner: 0.7 } }).viewport, { x: 0.1, y: 0.1, w: 0.5, h: 0.5 })
  is('a square glass stays four keys', Object.keys(FDc.normalize({ viewport: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } }).viewport).length, 4)
}

console.log(`\n  ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
