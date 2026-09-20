// The house rubric, measured: what review says about an edit, and that every finding
// it makes carries the call that fixes it.
//   node test/review.test.js
const assert = require('assert')
const R = require('../ui/review')

let n = 0
const t = (name, fn) => { fn(); n++; console.log('ok', name) }

// A take of 120 s, the whole of it kept, with speech across it.
const cue = (start, end, text) => ({ id: 'S' + Math.round(start), start, end, text })
const doc = (o = {}) => ({
  v: 2, src: '/m/Demo/Original/Demo.mov', dur: 120,
  clips: [{ id: 'C1', start: 0, end: 60 }],
  // two zooms fitted to a box, so the camera moves and the aims are Fetch's own
  zooms: [{ id: 'Z1', start: 5, end: 11, x: 0.3721, y: 0.6042, scale: 2.13 },
    { id: 'Z2', start: 14, end: 19, x: 0.6113, y: 0.4408, scale: 1.94 }],
  marks: [], texts: [], beats: [],
  cues: [cue(0, 20, 'here is the thing'), cue(20, 40, 'and here is what it does'), cue(40, 60, 'that is it')],
  look: { frame: { aspect: '16:9' }, captions: { show: true }, background: { kind: 'solid', color: '#1A1714' } },
  ...o,
})
const brief = (o = {}) => ({ seconds: 60, aspect: null, where: 'landing page', must_keep: [], must_hide: [], ...o })
const run = (d, b, more = {}) => R.review({ doc: d, brief: b, path: '/m/Demo/Original/Demo.mov', ...more })
const rules = r => r.items.map(i => i.rule)
const of = (r, rule) => r.items.find(i => i.rule === rule)

t('an edit that answers the brief is ready, and says so in one line', () => {
  const r = run(doc(), brief())
  assert.deepStrictEqual(rules(r), [], JSON.stringify(rules(r)))
  assert.strictEqual(r.verdict, 'ready')
  assert.ok(r.summary.startsWith('Ready: 60 s against the 60 s asked for'), r.summary)
  assert.strictEqual(r.measured.seconds, 60)
  assert.strictEqual(r.measured.target, 60)
  assert.strictEqual(r.measured.where, 'landing page')
})

t('no brief is itself the finding, and the fix is to write one', () => {
  const r = run(doc(), null)
  assert.deepStrictEqual(rules(r), ['no-brief'])
  assert.strictEqual(r.verdict, 'ready')       // nothing was asked for, so nothing is wrong yet
  assert.strictEqual(of(r, 'no-brief').fix.tool, 'direct')
})

t('what must be hidden is never quietly dropped', () => {
  const r = run(doc(), brief({ must_hide: ['my email', 'the API key'] }))
  const it = of(r, 'redactions')
  assert.strictEqual(it.severity, 'blocking')
  assert.strictEqual(r.verdict, 'not ready')
  assert.ok(it.what.includes('my email'))
  assert.strictEqual(it.fix.tool, 'find_on_screen')
  assert.strictEqual(it.fix.args.query, 'my email')
  assert.strictEqual(it.fix.args.path, '/m/Demo/Original/Demo.mov')
  // one blur is enough for the rubric to stop asserting nothing is hidden
  const hidden = run(doc({ marks: [{ id: 'M1', kind: 'blur', start: 1, end: 5, x: 0.1, y: 0.1, w: 0.2, h: 0.1 }] }),
    brief({ must_hide: ['my email'] }))
  assert.ok(!of(hidden, 'redactions'))
  assert.strictEqual(hidden.measured.redactions, 1)
})

t('the shape is measured against the brief, and against where it is going', () => {
  const r = run(doc({ look: { frame: { aspect: 'auto' }, captions: { show: true } } }), brief())
  const it = of(r, 'aspect')
  assert.strictEqual(it.severity, 'blocking')
  assert.ok(it.what.includes('landing page wants 16:9'), it.what)
  assert.deepStrictEqual(it.fix, {
    tool: 'apply_look',
    args: { path: '/m/Demo/Original/Demo.mov', look: { frame: { aspect: '16:9' } } },
    why: 'the space round the take is filled by the background, never black bars',
  })
  // the brief's own aspect outranks the destination's
  const vert = run(doc(), brief({ aspect: '9:16' }))
  assert.ok(of(vert, 'aspect').what.includes('the brief asks for 9:16'))
  // 16:9 asked for and 16:9 set is not a finding
  assert.ok(!of(run(doc(), brief()), 'aspect'))

  // and neither is a 16:9 take nobody has set a shape on: 'auto' is the take's own
  // shape, and where that is the shape asked for there is nothing to fix
  const auto = doc({ look: { frame: { aspect: 'auto' }, captions: { show: true } } })
  assert.ok(!of(run(auto, brief(), { width: 1920, height: 1080 }), 'aspect'))
  // a vertical take against a landing page still blocks, and says what shape it is
  const tall = of(run(auto, brief(), { width: 1080, height: 1920 }), 'aspect')
  assert.ok(tall.what.includes('the take\'s own shape, 0.56 to 1'), tall.what)
  // a crop outranks the take's pixels: the crop is what gets exported
  assert.ok(!of(run(doc({ crop: { x: 0, y: 0, w: 1600, h: 900 },
    look: { frame: { aspect: 'auto' }, captions: { show: true } } }), brief(), { width: 1080, height: 1920 }), 'aspect'))
})

t('a redaction the edit never draws does not clear the rule that hides things', () => {
  const d = doc({ clips: [{ id: 'C1', start: 0, end: 20 }],
    marks: [{ id: 'M1', kind: 'redact', start: 50, end: 55, x: 0.1, y: 0.1, w: 0.2, h: 0.1 }] })
  const it = of(run(d, brief({ must_hide: ['the API key'], seconds: 20 })), 'redactions')
  assert.strictEqual(it.severity, 'blocking')
  assert.ok(it.what.includes('nothing this edit draws is redacted'), it.what)
  // three things to hide is not covered by one blur
  const one = doc({ marks: [{ id: 'M1', kind: 'blur', start: 1, end: 5, x: 0.1, y: 0.1, w: 0.2, h: 0.1 }] })
  const three = of(run(one, brief({ must_hide: ['a', 'b', 'c'] })), 'redactions')
  assert.ok(three.what.includes('3 things to hide and this edit draws 1 redaction'), three.what)
  assert.strictEqual(three.fix.args.query, 'b')
  // and three drawn redactions for three things is nothing to say
  const all = doc({ marks: [1, 2, 3].map(i => ({ id: 'M' + i, kind: 'redact', start: i, end: i + 1, x: 0.1, y: 0.1, w: 0.2, h: 0.1 })) })
  const r = run(all, brief({ must_hide: ['a', 'b', 'c'] }))
  assert.ok(!of(r, 'redactions'))
  assert.strictEqual(r.measured.redactions_drawn, 3)
})

t('dead air is not asserted on a take nothing has been heard in', () => {
  // no cues, no beats: every kept second would read as silence, and there is no
  // evidence for that. The captions rule has already said there is no transcript.
  const d = doc({ cues: [] })
  const r = run(d, brief())
  assert.ok(!of(r, 'dead-air'), JSON.stringify(rules(r)))
  assert.ok(of(r, 'captions'))
  assert.strictEqual(r.measured.dead_air.seconds, null)
})

t('the dead-air fix targets what is left once the silence is out', () => {
  // a 45 s edit against a 60 s brief: fit_to_length is a ceiling, so handing it 60
  // would drop nothing and the finding would come back word for word
  const d = doc({ clips: [{ id: 'C1', start: 0, end: 45 }],
    cues: [cue(0, 20, 'one'), cue(25, 45, 'two')] })
  const it = of(run(d, brief({ seconds: 60 })), 'dead-air')
  assert.strictEqual(it.fix.tool, 'fit_to_length')
  assert.strictEqual(it.fix.args.seconds, 40)
})

t('a brief that names no destination is measured against itself alone', () => {
  const b = { seconds: 60, aspect: '9:16', where: null, must_keep: [], must_hide: [] }
  const r = run(doc({ cues: [] }), b)
  assert.strictEqual(r.measured.where, null)
  assert.ok(of(r, 'aspect').what.includes('the brief asks for 9:16'))
  // nobody said it plays muted, so missing captions are worth fixing and not blocking
  assert.strictEqual(of(r, 'captions').severity, 'should')
  assert.strictEqual(r.verdict, 'not ready')       // the shape of the deliverable still is
})

t('a muted destination needs the words on the picture', () => {
  const none = run(doc({ cues: [] }), brief())
  assert.strictEqual(of(none, 'captions').severity, 'blocking')
  assert.strictEqual(of(none, 'captions').fix.tool, 'transcribe')
  assert.ok(of(none, 'captions').what.includes('autoplays muted'))
  // sound on: still worth captions, not blocking
  const yt = run(doc({ cues: [] }), brief({ where: 'youtube', seconds: null }))
  assert.strictEqual(of(yt, 'captions').severity, 'should')
  // captions written but not burned in
  const off = run(doc({ look: { frame: { aspect: '16:9' }, captions: { show: false } } }), brief())
  assert.strictEqual(of(off, 'burn-in').severity, 'blocking')
  assert.deepStrictEqual(of(off, 'burn-in').fix.args.look, { captions: { show: true } })
  // a take with no audio at all is not missing its captions, and only the caller knows
  const silent = run(doc({ cues: [] }), brief(), { silent: true })
  assert.ok(!of(silent, 'captions') && !of(silent, 'burn-in'))
})

t('a length off target names the distance and hands over fit_to_length', () => {
  const long = run(doc({ clips: [{ id: 'C1', start: 0, end: 75 }] }), brief())
  const it = of(long, 'length')
  assert.strictEqual(it.severity, 'should')
  assert.ok(it.what.includes('75 s against the 60 s asked for, 15 s long'), it.what)
  assert.deepStrictEqual(it.fix.args, { path: '/m/Demo/Original/Demo.mov', seconds: 60 })
  assert.strictEqual(it.fix.tool, 'fit_to_length')
  // a quarter over is not the thing that was asked for at all
  assert.strictEqual(of(run(doc({ clips: [{ id: 'C1', start: 0, end: 100 }] }), brief()), 'length').severity, 'blocking')
  // 63 s against 60 is a 60 second demo
  assert.ok(!of(run(doc({ clips: [{ id: 'C1', start: 0, end: 63 }] }), brief()), 'length'))
})

t('too short says whether the take has more to give', () => {
  const spare = run(doc({ clips: [{ id: 'C1', start: 0, end: 30 }] }), brief())
  assert.ok(spare.items.some(i => i.rule === 'length' && i.what.includes('90 s of the take not in it')))
  assert.strictEqual(of(spare, 'length').fix.tool, 'apply_edit')
  assert.deepStrictEqual(of(spare, 'length').fix.args.doc, { clips: [{ start: 0, end: 120 }] })
  // the whole take is in and it is still short: the target is what has to move
  const all = run(doc({ dur: 30, clips: [{ id: 'C1', start: 0, end: 30 }], cues: [cue(0, 30, 'hello')] }), brief())
  assert.ok(of(all, 'length').what.includes('The whole take is already in it.'))
  assert.strictEqual(of(all, 'length').fix.tool, 'direct')
  assert.deepStrictEqual(of(all, 'length').fix.args.brief, { seconds: 30 })
})

t('dead air is measured from the cues that are kept, gap by gap', () => {
  const d = doc({
    clips: [{ id: 'C1', start: 0, end: 60 }],
    cues: [cue(0, 10, 'one'), cue(14, 20, 'two'), cue(20, 55, 'three')],
  })
  const r = run(d, brief())
  const it = of(r, 'dead-air')
  assert.ok(it.what.includes('9 s of the edit has nobody speaking, in 2 gaps'), it.what)
  assert.ok(it.what.includes('longest 5 s at 55 s'), it.what)
  assert.strictEqual(it.fix.tool, 'fit_to_length')
  assert.strictEqual(r.measured.dead_air.seconds, 9)
  assert.deepStrictEqual(r.measured.dead_air.gaps[0], { start: 10, end: 14, out: 10 })
  // under the gap that reads as dead air, nothing is said
  assert.ok(!of(run(doc(), brief()), 'dead-air'))
  // a repro is evidence: its pauses are not a fault
  assert.ok(!of(run(d, brief({ where: 'bug report', seconds: null })), 'dead-air'))
})

t('dead air falls back to the beats when a take has no cues yet', () => {
  const d = doc({ cues: [] })
  const beats = [{ id: 'B1', start: 0, end: 10, label: 'opening' }, { id: 'B2', start: 40, end: 60, label: 'the end' }]
  const r = run(d, brief(), { beats })
  assert.ok(of(r, 'dead-air').what.includes('30 s'), of(r, 'dead-air').what)
})

t('an object on material the edit cut away is never drawn, and the fix removes it', () => {
  const d = doc({
    clips: [{ id: 'C1', start: 0, end: 20 }, { id: 'C2', start: 40, end: 80 }],
    zooms: [{ id: 'Z1', start: 25, end: 30, x: 0.5, y: 0.5, scale: 1.8 }],
    marks: [
      { id: 'M1', kind: 'step', start: 26, end: 29, x: 0.4, y: 0.4, n: 1 },
      { id: 'M2', kind: 'redact', start: 30, end: 35, x: 0.1, y: 0.1, w: 0.2, h: 0.1 },
    ],
  })
  const r = run(d, brief())
  const drawn = r.items.filter(i => i.rule === 'never-drawn')
  assert.strictEqual(drawn.length, 3)
  assert.deepStrictEqual(drawn.map(i => i.fix.args.doc.remove), [['Z1'], ['M1'], ['M2']])
  // nothing is exposed by a redaction on material that is gone, so it is only clutter
  assert.strictEqual(drawn.find(i => i.what.startsWith('M2')).severity, 'note')
  assert.strictEqual(drawn.find(i => i.what.startsWith('M1')).severity, 'should')
})

t('a lift that runs over a cut is retimed to the piece it mostly lies in', () => {
  const d = doc({
    clips: [{ id: 'C1', start: 0, end: 20 }, { id: 'C2', start: 40, end: 80 }],
    marks: [{ id: 'M1', kind: 'lift', start: 18, end: 50, x: 0.2, y: 0.2, w: 0.3, h: 0.3 }],
  })
  const it = of(run(d, brief()), 'spans-a-cut')
  assert.ok(it.what.includes('M1 (lift) runs across a cut'), it.what)
  assert.deepStrictEqual(it.fix.args.doc, { marks: [{ id: 'M1', start: 40, end: 50 }] })
  assert.strictEqual(it.at, 18)
  // one that sits inside a single piece is fine
  assert.ok(!of(run(doc({ marks: [{ id: 'M1', kind: 'lift', start: 5, end: 9, x: 0.2, y: 0.2, w: 0.3, h: 0.3 }] }), brief()), 'spans-a-cut'))
})

t('two focus marks on the same place at the same time', () => {
  const d = doc({ marks: [
    { id: 'M1', kind: 'lift', start: 5, end: 12, x: 0.2, y: 0.2, w: 0.4, h: 0.3 },
    { id: 'M2', kind: 'spotlight', start: 8, end: 20, box: { x: 0.3, y: 0.25, w: 0.3, h: 0.3 } },
    { id: 'M3', kind: 'spotlight', start: 8, end: 20, x: 0.8, y: 0.8, w: 0.1, h: 0.1 },
  ] })
  const it = of(run(d, brief()), 'focus-clash')
  assert.ok(it.what.includes('M1 and M2 (lift and spotlight) cover the same place from 8 s to 12 s'), it.what)
  assert.deepStrictEqual(it.fix.args.doc, { remove: ['M2'] })
  // M3 is elsewhere on screen and is left alone
  assert.strictEqual(run(d, brief()).items.filter(i => i.rule === 'focus-clash').length, 1)
})

t('zoom count is judged against the output length, and the shortest go first', () => {
  const zooms = Array.from({ length: 11 }, (_, i) => ({ id: 'Z' + (i + 1), start: i * 5, end: i * 5 + (i < 3 ? 1 : 4), x: 0.5, y: 0.5, scale: 1.8 }))
  const r = run(doc({ zooms }), brief())
  const it = of(r, 'zoom-density')
  assert.ok(it.what.includes('11 zooms in 60 s of output'), it.what)
  assert.ok(it.what.includes('At this length 8 is the ceiling'), it.what)
  assert.deepStrictEqual(it.fix.args.doc, { remove: ['Z1', 'Z2', 'Z3'] })
  assert.strictEqual(r.measured.zoom_ceiling, 8)
  // eight of them is the ceiling, not over it
  assert.ok(!of(run(doc({ zooms: zooms.slice(0, 8) }), brief()), 'zoom-density'))
})

t('a minute of output with a camera that never moves is worth saying', () => {
  const beats = [{ id: 'B1', start: 0, end: 8, label: 'opening' }, { id: 'B2', start: 8, end: 50, label: 'the import runs' }]
  const it = of(run(doc({ zooms: [] }), brief(), { beats }), 'no-zooms')
  assert.strictEqual(it.severity, 'note')
  assert.strictEqual(it.fix.tool, 'find_on_screen')
  assert.deepStrictEqual(it.fix.args, { path: '/m/Demo/Original/Demo.mov', at: 29, query: 'the import runs' })
  // autoZoom is the camera moving
  assert.ok(!of(run(doc({ zooms: [], autoZoom: true }), brief()), 'no-zooms'))
  // and a short clip is not a demo that needs one
  assert.ok(!of(run(doc({ zooms: [], clips: [{ id: 'C1', start: 0, end: 8 }] }), brief({ seconds: 8 })), 'no-zooms'))
})

t('a zoom aimed by a point somebody worked out is a smell, never a fault', () => {
  const r = run(doc({ zooms: [{ id: 'Z1', start: 10, end: 16, x: 0.35, y: 0.7, scale: 2 }] }), brief())
  const it = of(r, 'hand-aimed')
  assert.strictEqual(it.severity, 'note')
  assert.strictEqual(it.at, 11)
  assert.deepStrictEqual(it.fix.args, { path: '/m/Demo/Original/Demo.mov', at: 11 })
  // Fetch's own fit lands on four decimals: not a typed aim
  assert.ok(!of(run(doc({ zooms: [{ id: 'Z1', start: 10, end: 16, x: 0.3721, y: 0.6042, scale: 2.13 }] }), brief()), 'hand-aimed'))
  // and "zoom in on the first two seconds" is the frame centre, which aimed at nothing on purpose
  assert.ok(!of(run(doc({ zooms: [{ id: 'Z1', start: 0, end: 2, x: 0.5, y: 0.5, scale: 1.8 }] }), brief()), 'hand-aimed'))
})

t('the ground is measured against the take\'s own ends, and a look is named by what it is for', () => {
  const looks = [
    { name: 'clean', label: 'Clean', for: 'a light product on a quiet ground', look: { background: { kind: 'solid', color: '#1A1714' } } },
    { name: 'paper', label: 'Paper', for: 'a terminal or a dark editor', look: { background: { kind: 'solid', color: '#EDE6DA' } } },
    { name: 'film', label: 'Film', look: { background: { kind: 'video-blur' } } },
  ]
  // a dark terminal take on a near-black ground
  const r = run(doc(), brief(), { levels: { lo: 0.01, hi: 0.5 }, looks })
  const it = of(r, 'ground')
  assert.strictEqual(it.severity, 'note')
  assert.ok(it.what.includes('within 24 levels of the take\'s own black point'), it.what)
  assert.deepStrictEqual(it.fix, {
    tool: 'apply_look',
    args: { path: '/m/Demo/Original/Demo.mov', preset: 'paper' },
    why: 'Paper is for a terminal or a dark editor',
  })
  assert.deepStrictEqual(r.measured.take_levels, { lo: 0.01, hi: 0.5 })
  // a white page on that same ground stands well off it
  assert.ok(!of(run(doc(), brief(), { levels: { lo: 0.2, hi: 0.95 }, looks }), 'ground'))
  // with no looks list to read, a colour is named instead
  const bare = of(run(doc(), brief(), { levels: { lo: 0.01, hi: 0.5 } }), 'ground')
  assert.deepStrictEqual(bare.fix.args.look, { background: { kind: 'solid', color: '#EDE6DA' } })
  // a ground the look does not draw as one colour is not measured at all
  assert.ok(!of(run(doc({ look: { frame: { aspect: '16:9' }, background: { kind: 'video-blur' } } }), brief(),
    { levels: { lo: 0.01, hi: 0.5 } }), 'ground'))
})

t('a phrase the brief said to keep, cut out of the edit', () => {
  const d = doc({ clips: [{ id: 'C1', start: 0, end: 30 }], cues: [cue(0, 20, 'here is the thing'), cue(40, 50, 'and the price is free')] })
  const it = of(run(d, brief({ must_keep: ['the price'], seconds: 30 })), 'must-keep')
  assert.ok(it.what.includes('"the price" is in the take at 40 s and the edit cuts it out'), it.what)
  // the fix has to be able to clear its own finding, and fit_to_length only ever
  // removes material: the call puts the phrase's own span back into the clips
  assert.strictEqual(it.fix.tool, 'apply_edit')
  assert.deepStrictEqual(it.fix.args.doc.clips, [{ start: 0, end: 30 }, { start: 39.7, end: 50.3 }])
  assert.ok(it.fix.why.includes('fit_to_length'), it.fix.why)
  // a phrase nobody ever said is not a cut
  assert.ok(!of(run(d, brief({ must_keep: ['the pricing page'], seconds: 30 })), 'must-keep'))
})

t('findings are ranked, blocking first, and the verdict follows them', () => {
  const d = doc({
    look: { frame: { aspect: 'auto' }, captions: { show: true }, background: { kind: 'solid', color: '#1A1714' } },
    clips: [{ id: 'C1', start: 0, end: 90 }],
    zooms: [{ id: 'Z1', start: 10, end: 16, x: 0.35, y: 0.7, scale: 2 }],
  })
  const r = run(d, brief({ must_hide: ['my email'] }))
  assert.deepStrictEqual(rules(r), ['redactions', 'aspect', 'length', 'dead-air', 'hand-aimed'])
  assert.strictEqual(r.verdict, 'not ready')
  assert.strictEqual(r.summary, 'Not ready: 3 things to fix, 1 thing worth fixing.')
  assert.deepStrictEqual(R.blocking(r).map(i => i.rule), ['redactions', 'aspect', 'length'])
  // nothing blocking, something to fix
  const nearly = run(doc({ clips: [{ id: 'C1', start: 0, end: 70 }], cues: [cue(0, 70, 'talking all the way through')] }), brief())
  assert.strictEqual(nearly.verdict, 'nearly')
  assert.strictEqual(nearly.summary, 'Nearly: 1 thing worth fixing.')
  assert.deepStrictEqual(R.blocking(nearly), [])
})

t('every finding carries a call that can be made as it stands', () => {
  const d = doc({
    look: { frame: { aspect: 'auto' }, captions: { show: false }, background: { kind: 'solid', color: '#1A1714' } },
    clips: [{ id: 'C1', start: 0, end: 20 }, { id: 'C2', start: 40, end: 95 }],
    zooms: [{ id: 'Z1', start: 25, end: 30, x: 0.35, y: 0.7, scale: 2 }],
    marks: [{ id: 'M1', kind: 'lift', start: 18, end: 50, x: 0.2, y: 0.2, w: 0.3, h: 0.3 }],
  })
  const r = run(d, brief({ must_hide: ['my email'] }), { levels: { lo: 0.01, hi: 0.5 } })
  assert.ok(r.items.length >= 6)
  const tools = new Set(['apply_edit', 'apply_look', 'fit_to_length', 'find_on_screen', 'transcribe', 'direct'])
  for (const i of r.items) {
    assert.ok(tools.has(i.fix.tool), `${i.rule} calls ${i.fix.tool}`)
    assert.strictEqual(i.fix.args.path, '/m/Demo/Original/Demo.mov', i.rule)
    assert.ok(i.fix.why && i.fix.why.length > 10, i.rule)
    assert.ok(i.what.length > 20 && i.what.endsWith('.'), i.rule)
    assert.ok(['blocking', 'should', 'note'].includes(i.severity))
  }
})

t('the times to look at come in both clocks, findings first', () => {
  const beats = [{ id: 'B1', start: 0, end: 20, label: 'opening' }, { id: 'B2', start: 20, end: 60, label: 'the run' }]
  const r = run(doc({ zooms: [], clips: [{ id: 'C1', start: 30, end: 90 }], cues: [cue(30, 90, 'talking')] }), brief(), { beats })
  assert.ok(r.look_at.length > 0 && r.look_at.length <= 6)
  for (const l of r.look_at) assert.ok(Number.isFinite(l.at) && l.why)
  // sorted by the recording's clock, and each output time is its own place in the export
  assert.deepStrictEqual(r.look_at.map(l => l.at).slice().sort((a, b) => a - b), r.look_at.map(l => l.at))
  const kept = r.look_at.filter(l => l.at >= 30 && l.at <= 90)
  for (const l of kept) assert.strictEqual(l.out, Math.round((l.at - 30) * 100) / 100)
  // a beat the edit cut away still says where it is, and that it is nowhere in the export
  assert.ok(r.look_at.every(l => l.out === null || l.out >= 0))
})

t('the clock helpers agree with the edit they came from', () => {
  const k = R.kept({ dur: 120, clips: [{ id: 'C1', start: 10, end: 20 }, { id: 'C2', start: 50, end: 60 }] })
  assert.deepStrictEqual(k.map(c => c.out), [0, 10])
  assert.strictEqual(R.outAt(k, 15), 5)
  assert.strictEqual(R.outAt(k, 55), 15)
  assert.strictEqual(R.outAt(k, 30), null)
  // no clips at all is the whole take, which is what the editor shows
  const whole = R.kept({ dur: 12, clips: [] })
  assert.deepStrictEqual(whole.map(c => [c.id, c.start, c.end, c.out, c.span]), [[null, 0, 12, 0, 12]])
  assert.deepStrictEqual(R.kept({ dur: 0, clips: [] }), [])

  // a clip carrying a rate is as long here as it is in the file: 60 s at 2x is 30 s of
  // output, and a moment half way through it lands at output second 15, not 30
  const fast = R.kept({ dur: 60, clips: [{ id: 'C1', start: 0, end: 60, rate: 2 }] })
  assert.strictEqual(R.outLength(fast), 30)
  assert.strictEqual(R.outAt(fast, 30), 15)
  // and a ramp is measured at its mean rate, the same closed form ui/timeline.js uses
  const ramp = R.kept({ dur: 60, clips: [{ id: 'C1', start: 0, end: 60, rate: [1, 4] }] })
  assert.strictEqual(R.outLength(ramp), 24)
})

t('a destination is read from the words people write in a brief', () => {
  assert.strictEqual(R.whereSpec('landing page').where, 'landing page')
  assert.strictEqual(R.whereSpec('for my landing page').where, 'landing page')
  assert.strictEqual(R.whereSpec('The Docs site').where, 'docs')
  assert.strictEqual(R.whereSpec('tiktok').where, 'vertical')
  assert.strictEqual(R.whereSpec('a repro for the issue').where, 'bug report')
  assert.strictEqual(R.whereSpec('YouTube').muted, false)
  assert.strictEqual(R.whereSpec('somewhere nobody named'), null)
  assert.strictEqual(R.whereSpec(''), null)
  assert.strictEqual(R.whereSpec(null), null)
  // every row asks for something a rubric can measure
  for (const [name, w] of Object.entries(R.WHERE)) {
    assert.ok(typeof w.muted === 'boolean' && typeof w.tight === 'boolean', name)
    assert.ok(w.why && w.why.length > 10, name)
    assert.ok(w.aspect === null || /^\d+:\d+$/.test(w.aspect), name)
  }
})

t('review is pure: same in, same out, and the document comes back untouched', () => {
  const d = doc({ zooms: [{ id: 'Z1', start: 25, end: 30, x: 0.35, y: 0.7, scale: 2 }], clips: [{ id: 'C1', start: 0, end: 20 }] })
  const before = JSON.stringify(d)
  const a = JSON.stringify(run(d, brief(), { levels: { lo: 0.01, hi: 0.5 } }))
  const b = JSON.stringify(run(JSON.parse(before), brief(), { levels: { lo: 0.01, hi: 0.5 } }))
  assert.strictEqual(a, b)
  assert.strictEqual(JSON.stringify(d), before)
  // and it survives a document with nothing in it
  const empty = R.review({})
  assert.strictEqual(empty.measured.seconds, 0)
  assert.ok(empty.verdict)
})

t('no em dashes anywhere a person or a model reads', () => {
  const all = JSON.stringify([
    run(doc(), brief({ must_hide: ['x'], must_keep: ['thing'] }), { levels: { lo: 0.01, hi: 0.5 } }),
    run(doc({ look: { frame: { aspect: 'auto' } }, cues: [], clips: [{ id: 'C1', start: 0, end: 5 }] }), brief()),
    R.WHERE,
  ])
  assert.ok(!/\u2014/.test(all))
  assert.ok(!/\u2014/.test(require('fs').readFileSync(require.resolve('../ui/review'), 'utf8')))
})

console.log(`\n${n} checks passed`)
