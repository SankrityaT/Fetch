// The chat working on the take in the editor: the context each turn carries, the
// edits it offers, what an agent change touched, and undo.
//   node test/assist.test.js
const assert = require('assert')
const A = require('../ui/edit-assist')

let n = 0
const t = (name, fn) => { fn(); n++; console.log('ok', name) }

const doc = (o = {}) => ({
  clips: [{ id: 'C1', start: 0, end: 30 }], zooms: [], marks: [], texts: [], cues: [],
  look: { burnCaps: true }, backdrop: null, outAspect: null, ...o,
})

t('the header states the open take and its edit', () => {
  const h = A.contextHeader({
    open: { path: '/m/Demo/Original/Demo.mov', dur: 42, doc: doc({
      zooms: [{ id: 'Z1' }, { id: 'Z2' }], marks: [{ id: 'M1', kind: 'redact' }],
      cues: [{ start: 0, end: 1, text: 'hi' }] }) },
  })
  assert.ok(h.startsWith('<fetch_context>') && h.endsWith('</fetch_context>'))
  assert.ok(h.includes('Open in the Fetch editor: /m/Demo/Original/Demo.mov (0:42)'))
  assert.ok(h.includes('2 zooms (Z1, Z2)'))
  assert.ok(h.includes('1 mark (M1)'))
  assert.ok(h.includes('0 texts'))
  assert.ok(h.includes('captions: yes, 1 line, burned in'))
  assert.ok(/list_recordings or get_edit/.test(h), 'says to read current state')
  assert.ok(/Do not trust what an earlier turn said/.test(h), 'says memory is stale')
})

t('with nothing open the header says so, and never names a take', () => {
  const h = A.contextHeader({ open: null })
  assert.ok(h.includes('No recording is open in the editor.'))
  assert.ok(!h.includes('Open in the Fetch editor'))
  assert.ok(!/\.mov|\.mp4/.test(h), 'names no file')
  const off = A.contextHeader({ omitted: true })
  assert.ok(off.includes('left the recording open in the editor out'))
})

t('no em dashes in anything a model or a person reads', () => {
  const all = A.contextHeader({ open: { path: '/a', dur: 3, doc: doc() } }) +
    A.suggestions(doc()).map(s => s.label + s.ask).join('') +
    A.suggestions(doc({ cues: [{}], zooms: [{ id: 'Z1' }], texts: [{ id: 'T1' }] })).map(s => s.label + s.ask).join('')
  assert.ok(!/\u2014/.test(all))
  assert.ok(!/\u2014/.test(require('fs').readFileSync(require.resolve('../ui/edit-assist'), 'utf8')))
})

// The header once named the newest take, and the model answered "what is my latest
// recording?" from it without ever reading the library, so a take that landed a
// moment earlier could be missed. The library is read by a tool call every time.
t('the header never names the newest take, and asks for list_recordings every time', () => {
  const h = A.contextHeader({ open: { path: '/m/Open.mov', dur: 3, doc: doc() } })
  assert.ok(!/Newest recording/.test(h))
  assert.ok(/fresh list_recordings call in this turn/.test(h))
  assert.ok(/even if an earlier turn already answered it/.test(h))
})

t('the header tells the model not to write em dashes', () => {
  assert.ok(/Never use an em dash/.test(A.contextHeader({ open: null })))
})

t('plainDashes turns em dashes into commas and keeps ranges', () => {
  const D = A.plainDashes, em = '\u2014', en = '\u2013'
  assert.strictEqual(D(`Your latest recording is Suite Beta ${em} a new one since the last check.`),
    'Your latest recording is Suite Beta, a new one since the last check.')
  assert.strictEqual(D(`Done${em}the zoom is in.`), 'Done, the zoom is in.')
  assert.strictEqual(D(`Captions added ${en} 12 lines.`), 'Captions added, 12 lines.')
  assert.strictEqual(D(`Cut 1${en}3 seconds.`), `Cut 1${en}3 seconds.`)
  assert.strictEqual(D(`${em} first\nsecond ${em}.`), 'first\nsecond.')
  assert.strictEqual(D('No dashes here.'), 'No dashes here.')
  assert.strictEqual(D(null), '')
})

t('suggestions follow what the edit is missing', () => {
  const fresh = A.suggestions(doc()).map(s => s.label)
  assert.deepStrictEqual(fresh, ['Add captions', 'Tighten the pauses', 'Zoom into each step', 'Blur my name'])
  const done = A.suggestions(doc({
    clips: [{ id: 'C1' }, { id: 'C2' }], cues: [{ text: 'x' }], zooms: [{ id: 'Z1' }],
    marks: [{ id: 'M1', kind: 'blur' }] })).map(s => s.label)
  assert.ok(!done.includes('Add captions') && !done.includes('Tighten the pauses'))
  assert.ok(!done.includes('Zoom into each step') && !done.includes('Blur my name'))
  assert.ok(done.includes('16:9 on a blurred background'))
  assert.ok(done.includes('Fix caption mistakes'))
  // a silent take is not offered captions or pause trimming
  const silent = A.suggestions(doc(), { hasAudio: false }).map(s => s.label)
  assert.ok(!silent.includes('Add captions') && !silent.includes('Tighten the pauses'))
  assert.ok(A.suggestions(doc()).every(s => s.ask.length > s.label.length))
})

t('changedIds names new and changed objects only', () => {
  const a = doc({ zooms: [{ id: 'Z1', start: 1, end: 2 }], texts: [{ id: 'T1', text: 'a' }], cues: [{ text: 'x' }, { text: 'y' }] })
  const b = doc({ zooms: [{ id: 'Z1', start: 1, end: 3 }, { id: 'Z2', start: 5, end: 6 }],
    texts: [{ id: 'T1', text: 'a' }], marks: [{ id: 'M1', kind: 'redact' }], cues: [{ text: 'x' }, { text: 'why' }] })
  const c = A.changedIds(a, b)
  assert.deepStrictEqual(c.zooms, ['Z1', 'Z2'])
  assert.deepStrictEqual(c.marks, ['M1'])
  assert.deepStrictEqual(c.texts, [])
  assert.deepStrictEqual(c.cues, [1])
  assert.strictEqual(c.clips, false)
  assert.strictEqual(c.frame, false)
  assert.ok(A.anyChange(c))
  assert.ok(!A.anyChange(A.changedIds(a, a)))
  assert.strictEqual(A.changedIds(a, doc({ ...a, outAspect: 16 / 9 })).frame, true)
})

t('undo groups one burst of passes into one level', () => {
  const u = A.createUndo()
  const d0 = doc(), d1 = doc({ zooms: [{ id: 'Z1' }] }), d2 = doc({ zooms: [{ id: 'Z1' }, { id: 'Z2' }] })
  u.mark()
  u.note('/a', d0, d1, 1000)
  u.note('/a', d1, d2, 2000)          // second pass of the same turn
  assert.strictEqual(u.size('/a'), 1)
  assert.deepStrictEqual(u.peek('/a').before, d0)
  assert.deepStrictEqual(u.peek('/a').after, d2)
})

t('a new turn, a pause, or a hand edit in between each start a new level', () => {
  const u = A.createUndo({ gapMs: 5000 })
  const d = k => doc({ zooms: Array.from({ length: k }, (_, i) => ({ id: 'Z' + (i + 1) })) })
  u.note('/a', d(0), d(1), 0)
  u.mark(); u.note('/a', d(1), d(2), 100)              // new chat turn
  u.note('/a', d(2), d(3), 99999)                      // long pause
  u.note('/a', doc({ texts: [{ id: 'T1' }] }), d(4), 100000)   // the person changed it first
  assert.strictEqual(u.size('/a'), 4)
  const levels = [u.pop('/a'), u.pop('/a'), u.pop('/a'), u.pop('/a')].map(e => e.before.zooms.length)
  assert.deepStrictEqual(levels, [0, 2, 1, 0])
  assert.strictEqual(u.pop('/a'), null)
})

t('undo is per take, follows a rename, ignores no-op applies and is capped', () => {
  const u = A.createUndo({ max: 3 })
  u.note('/a', doc(), doc(), 0)
  assert.strictEqual(u.size('/a'), 0, 'nothing changed, nothing to undo')
  u.note('/a', doc(), doc({ zooms: [{ id: 'Z1' }] }), 0)
  u.mark(); u.note('/b', doc(), doc({ texts: [{ id: 'T1' }] }), 0)
  assert.strictEqual(u.size('/a'), 1); assert.strictEqual(u.size('/b'), 1)
  const lv = u.peek('/a').n
  u.rename('/a', '/a2')
  assert.strictEqual(u.size('/a'), 0); assert.strictEqual(u.peek('/a2').n, lv)
  for (let i = 0; i < 5; i++) { u.mark(); u.note('/c', doc(), doc({ marks: [{ id: 'M' + i }] }), i) }
  assert.strictEqual(u.size('/a2') + u.size('/b') + u.size('/c'), 3)
  assert.ok(u.peek('/c').n > lv, 'levels are never reused')
})

t('undo takes back the agent change and keeps what the person did since', () => {
  const before = doc({ src: '/a.mov', zooms: [], texts: [], nextId: { Z: 1, T: 1 } })
  const after = doc({ src: '/a.mov', zooms: [{ id: 'Z1' }], texts: [], nextId: { Z: 2, T: 1 } })
  // nothing touched since: exactly the old edit, counter kept
  let r = A.revert(before, after, after)
  assert.deepStrictEqual(r.doc.zooms, []); assert.strictEqual(r.doc.nextId.Z, 2); assert.deepStrictEqual(r.kept, [])
  // the person added a title and the take was renamed since: both stay
  const now = { ...after, src: '/b.mov', texts: [{ id: 'T1', text: 'Hi' }], nextId: { Z: 2, T: 2 } }
  r = A.revert(before, after, now)
  assert.deepStrictEqual(r.doc.zooms, [])
  assert.strictEqual(r.doc.texts[0].text, 'Hi'); assert.strictEqual(r.doc.src, '/b.mov')
  assert.strictEqual(r.doc.nextId.T, 2); assert.deepStrictEqual(r.kept, [])
  // the person moved the agent's own zoom: theirs wins, and the caller is told
  r = A.revert(before, after, { ...after, zooms: [{ id: 'Z1', start: 3 }] })
  assert.strictEqual(r.doc.zooms[0].start, 3); assert.deepStrictEqual(r.kept, ['zooms'])
  assert.deepStrictEqual(before.zooms, [], 'the snapshot itself is never changed')
  // the person dragged one zoom: only that one stays theirs, the agent's others go
  const b2 = doc({ zooms: [{ id: 'Z1', start: 1 }] })
  const a2 = doc({ zooms: [{ id: 'Z1', start: 1 }, { id: 'Z2', start: 5 }, { id: 'Z3', start: 9 }] })
  r = A.revert(b2, a2, doc({ zooms: [{ id: 'Z1', start: 2 }, { id: 'Z2', start: 5 }, { id: 'Z3', start: 9 }] }))
  assert.deepStrictEqual(r.doc.zooms, [{ id: 'Z1', start: 2 }]); assert.deepStrictEqual(r.kept, [])
  // a zoom the agent removed comes back, in time order, beside one the person added
  r = A.revert(a2, b2, doc({ zooms: [{ id: 'Z1', start: 1 }, { id: 'Z4', start: 7 }] }))
  assert.deepStrictEqual(r.doc.zooms.map(z => z.id), ['Z1', 'Z2', 'Z4', 'Z3'])
})

t('an undo reports what it did, including things that are now gone', () => {
  const after = doc({ zooms: [{ id: 'Z1', start: 64.2, end: 70 }] })
  assert.strictEqual(A.undoSummary(after, doc()), "Undid Biscuit's change: took out the zoom at 1:04")
  const was = doc({ marks: [{ id: 'M1', kind: 'blur', start: 1 }, { id: 'M2', kind: 'redact', start: 2 }], cues: [{ text: 'a' }] })
  const now = doc({ zooms: [{ id: 'Z1', start: 3 }], cues: [{ text: 'b' }] })
  assert.strictEqual(A.undoSummary(was, now),
    "Undid Biscuit's change: took out 2 blurs, brought back the zoom at 0:03, restored the captions")
  const mixed = doc({ marks: [{ id: 'M1', kind: 'step' }, { id: 'M2', kind: 'spotlight' }] })
  assert.ok(A.undoSummary(mixed, doc()).endsWith('took out 2 marks'))
  assert.strictEqual(A.undoSummary(doc(), doc()), "Undid Biscuit's change")
  assert.ok(!/\u2014/.test(A.undoSummary(was, now)))
})

t('a take still loading reports no edit rather than a blank one', () => {
  const h = A.contextHeader({ open: { path: '/a.mov', dur: 5, doc: null } })
  assert.ok(h.includes('Open in the Fetch editor: /a.mov (0:05)'))
  assert.ok(!h.includes('Its edit right now') && h.includes('still loading'))
})

t('with a take open, the header says to act on defaults rather than ask', () => {
  const h = A.contextHeader({ open: { path: '/a.mov', dur: 5, doc: doc() } })
  assert.ok(/sensible default and make the change, rather than asking/.test(h))
  assert.ok(!/rather than asking/.test(A.contextHeader({ open: null })), 'only when there is an edit to make')
})

console.log(`\n${n} assist tests passed`)
