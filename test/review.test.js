// The house rubric, measured: what review says about an edit, that every finding it
// makes carries the call that fixes it, and that following those calls is safe. The
// last of those is the whole of this file's second half: a fix may not shorten the work,
// two fixes may not undo each other, a fix asked for 60 s may not land on 44.8, and
// applying the lot in order has to leave the edit better by review's own score.
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

// ── following the advice ────────────────────────────────────────────────────
// The editor's own merge, small enough to state a case against: apply_edit replaces a
// list whole, merges marks and zooms by id and removes by id; apply_look merges into
// the look; direct writes the brief. It is the four ops review's fixes can name.
const merge = (a, b) => {
  const out = { ...a }
  for (const [k, v] of Object.entries(b || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(a[k] || {}, v) : v
  }
  return out
}
const apply = (state, fix) => {
  const d = JSON.parse(JSON.stringify(state.doc))
  let b = JSON.parse(JSON.stringify(state.brief))
  const a = fix.args || {}
  if (fix.tool === 'apply_edit') {
    const patch = a.doc || {}
    for (const list of ['clips', 'zooms', 'marks', 'texts', 'cues', 'beats']) {
      if (!patch[list]) continue
      if (list === 'clips' || list === 'texts' || list === 'cues' || list === 'beats') { d[list] = patch[list].map(x => ({ ...x })); continue }
      for (const x of patch[list]) {
        const was = (d[list] || []).find(y => y.id === x.id)
        if (was) Object.assign(was, x); else (d[list] = d[list] || []).push({ ...x })
      }
    }
    for (const id of patch.remove || []) {
      for (const list of ['clips', 'zooms', 'marks', 'texts', 'cues', 'beats']) d[list] = (d[list] || []).filter(x => x.id !== id)
    }
  } else if (fix.tool === 'apply_look') {
    d.look = merge(d.look || {}, a.look || {})
  } else if (fix.tool === 'direct') {
    if (a.brief) b = { ...b, ...a.brief }
  }
  return { doc: d, brief: b }
}

// What the edit draws of each piece of the work, keyed by what it is, so "nothing
// must-keep disappeared" is a comparison and not an opinion. An object an item asked
// in so many words to remove is the exception and has to be named: this is about the
// material under the work, not about an agent taking a clashing spotlight out.
const drawn = r => Object.fromEntries(r.measured.must_keep.map(w => [w.what, w]))
const nothingLost = (before, after, removed = []) => {
  for (const [what, was] of Object.entries(drawn(before))) {
    const now = drawn(after)[what]
    if (!now) { assert.ok(removed.includes(was.id), `${what} went and no call named it`); continue }
    assert.ok(now.drawn >= was.drawn - 0.05, `${what}: ${was.drawn} s drawn, then ${now.drawn} s`)
  }
}

t('an edit that answers the brief is ready, and says so in one line', () => {
  const r = run(doc(), brief())
  assert.deepStrictEqual(rules(r), [], JSON.stringify(rules(r)))
  assert.strictEqual(r.verdict, 'ready')
  assert.strictEqual(r.score, 10)
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

// ── the work ────────────────────────────────────────────────────────────────

t('the work is the cards, the lifts and the phrases the brief named', () => {
  const d = doc({
    texts: [{ id: 'T1', text: 'Songscription', start: 0, end: 2.7 }],
    marks: [{ id: 'M1', kind: 'lift', start: 23, end: 27, x: 0.2, y: 0.2, w: 0.4, h: 0.3 },
      { id: 'M2', kind: 'redact', start: 30, end: 32, x: 0.1, y: 0.1, w: 0.2, h: 0.1 }],
  })
  const r = run(d, brief({ must_keep: ['what it does'] }))
  const kept = r.measured.must_keep.map(w => w.what)
  assert.deepStrictEqual(kept, ['the card "Songscription"', 'the lift M1', '"what it does"'])
  // a redaction is not the work: dropping the footage hides more than blurring it did
  assert.ok(!kept.some(w => w.includes('M2')))
  for (const w of r.measured.must_keep) assert.strictEqual(w.drawn, w.seconds)
})

t('a title card is not a silence to be cut', () => {
  // the gap the opener sits in, and the gap the closing URL card sits in
  const d = doc({
    clips: [{ id: 'C1', start: 0, end: 40 }],
    texts: [{ id: 'T1', text: 'Songscription', start: 0, end: 2.7 },
      { id: 'T2', text: 'songscription.app', start: 37, end: 40 }],
    cues: [cue(2.7, 20, 'here is the thing'), cue(20, 36.6, 'and here is what it does')],
  })
  const r = run(d, brief({ seconds: 40 }))
  assert.ok(!of(r, 'dead-air'), JSON.stringify(rules(r)))
  assert.strictEqual(r.measured.dead_air.seconds, 0)
  assert.strictEqual(r.measured.dead_air.covered, 6.1)
  // take the cards away and the same 6.1 s is dead air again
  const bare = run(doc({ clips: [{ id: 'C1', start: 0, end: 40 }],
    cues: [cue(2.7, 20, 'one'), cue(20, 36.6, 'two')] }), brief({ seconds: 40 }))
  assert.strictEqual(bare.measured.dead_air.seconds, 6.1)
})

t('a card a cut only half draws is a finding, and the fix puts it back', () => {
  // exactly what the round before this one did: the opener clipped to 0.72 s and the
  // closing URL card cut down to a quarter of a second, neither of them reported
  const d = doc({
    dur: 55.55, clips: [{ id: 'C1', start: 1.98, end: 12.37 }, { id: 'C2', start: 43.96, end: 53.84 }],
    zooms: [], cues: [cue(2, 12, 'one'), cue(44, 53, 'two')],
    texts: [{ id: 'T1', text: 'Songscription', start: 0, end: 2.7 },
      { id: 'T2', text: 'songscription.app', start: 53.6, end: 55.55 }],
  })
  const r = run(d, brief({ seconds: 25 }))
  const it = of(r, 'clipped')
  assert.strictEqual(it.severity, 'should')
  assert.ok(it.what.includes('the card "Songscription": 0.72 s of its 2.7 s is drawn'), it.what)
  assert.strictEqual(it.fix.tool, 'apply_edit')
  // both cards come back whole, and nothing else about the edit is touched
  const after = run(apply({ doc: d, brief: brief({ seconds: 25 }) }, it.fix).doc, brief({ seconds: 25 }))
  for (const w of after.measured.must_keep) assert.strictEqual(w.drawn, w.seconds, w.what)
  assert.ok(!of(after, 'clipped'))
  assert.ok(after.score > r.score)
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

// ── the one call that retimes the edit ──────────────────────────────────────

t('too long, and the silence can pay for it: the cut is exact and the work is untouched', () => {
  const d = doc({ clips: [{ id: 'C1', start: 0, end: 75 }], cues: [cue(0, 20, 'one'), cue(20, 40, 'two'), cue(40, 58, 'three')] })
  const r = run(d, brief())
  const it = of(r, 'length')
  assert.ok(it.what.includes('75 s against the 60 s asked for, 15 s long'), it.what)
  assert.ok(it.what.includes('16.85 s of it is silence'), it.what)
  assert.strictEqual(it.fix.tool, 'apply_edit')
  // it lands on the number it was asked for, not eleven seconds under it. 58.15 s
  // rather than 60 exactly, because the last 1.85 s of that gap is silence somebody
  // would have to come back for and the tolerance can carry it
  const after = run(apply({ doc: d, brief: brief() }, it.fix).doc, brief())
  assert.strictEqual(after.measured.seconds, 58.15)
  assert.ok(Math.abs(after.measured.seconds - 60) <= 3)
  assert.ok(!of(after, 'length') && !of(after, 'dead-air'))
  assert.ok(after.score > r.score)
  // and only one finding in the whole result moves the length
  assert.strictEqual(r.items.filter(i => i.rule === 'length' || i.rule === 'dead-air').length, 1)
})

t('too long by more than the silence, and fit_to_length is told what must survive', () => {
  const beats = [{ id: 'B1', start: 0, end: 10, label: 'the opener' },
    { id: 'B2', start: 10, end: 45, label: 'the run' }, { id: 'B3', start: 45, end: 100, label: 'the price' }]
  const d = doc({
    clips: [{ id: 'C1', start: 0, end: 100 }],
    texts: [{ id: 'T1', text: 'Fetch', start: 0, end: 3 }],
    cues: Array.from({ length: 10 }, (_, i) => cue(i * 10, i * 10 + 9.5, i === 5 ? 'and the price is free' : 'talking')),
  })
  const r = run(d, brief({ must_keep: ['the price'] }), { beats })
  const it = of(r, 'length')
  assert.strictEqual(it.severity, 'blocking')          // a quarter over is not the thing asked for
  assert.strictEqual(it.fix.tool, 'fit_to_length')
  assert.strictEqual(it.fix.args.seconds, 60)          // never under the number it was asked for
  // the phrase the brief named, the beat the title card sits in and the beat that
  // carries the phrase: the three things fit has to be told not to cut
  assert.deepStrictEqual(it.fix.args.keep, ['the price', 'B1', 'B3'])
})

t('a target the work itself cannot fit inside is one decision, and it says which', () => {
  const d = doc({
    clips: [{ id: 'C1', start: 0, end: 60 }],
    texts: [{ id: 'T1', text: 'Fetch', start: 0, end: 25 }],
    marks: [{ id: 'M1', kind: 'lift', start: 30, end: 55, x: 0.2, y: 0.2, w: 0.3, h: 0.3 }],
  })
  const r = run(d, brief({ seconds: 20 }))
  const it = of(r, 'length')
  assert.ok(it.what.includes('cannot be reached without cutting into them'), it.what)
  assert.ok(it.what.includes('one decision and not two'), it.what)
  assert.strictEqual(it.fix.tool, 'direct')
  assert.strictEqual(it.choices.length, 2)
  assert.strictEqual(it.choices[0].fix, it.fix)        // the safe one is the one on offer
})

t('too short, and the material nearest the cuts comes back, not the whole take', () => {
  const d = doc({ clips: [{ id: 'C1', start: 0, end: 30 }] })
  const r = run(d, brief())
  const it = of(r, 'length')
  assert.ok(it.what.includes('30 s against the 60 s asked for, 30 s short'), it.what)
  assert.ok(it.what.includes('90 s of the take not in it'), it.what)
  assert.deepStrictEqual(it.fix.args.doc.clips, [{ id: 'C1', start: 0, end: 60 }])
  // 60 s asked for, 60 s landed on: restoring the whole 120 s take would overshoot by a minute
  assert.strictEqual(run(apply({ doc: d, brief: brief() }, it.fix).doc, brief()).measured.seconds, 60)
})

t('the take is not long enough, and now the sentence that says so can be reached', () => {
  // 55.55 s against 60, which is 4.45 s out: review used to want 4.8 s before it would
  // speak, while the director called the same number missed on every call
  const d = doc({ dur: 55.55, clips: [{ id: 'C1', start: 0, end: 55.55 }], cues: [cue(0, 55.55, 'talking')] })
  const it = of(run(d, brief()), 'length')
  assert.ok(it.what.includes('55.55 s against the 60 s asked for, 4.45 s short'), it.what)
  assert.ok(it.what.includes('the whole take is already in it'), it.what)
  assert.strictEqual(it.fix.tool, 'direct')
  assert.deepStrictEqual(it.fix.args.brief, { seconds: 56 })
  assert.ok(it.fix.why.includes('change the target, record more'))
  // The other answer, and it is a tool call rather than a rate review writes itself. A
  // rate on every clip slows the narration, which is the one thing fit refuses to do;
  // fit_to_length slows only what is already holding with nobody speaking over it.
  assert.strictEqual(it.choices.length, 2)
  assert.strictEqual(it.choices[1].fix.tool, 'fit_to_length')
  assert.strictEqual(it.choices[1].fix.args.seconds, 60)
  assert.ok(!JSON.stringify(it.choices).includes('rate'), 'review no longer writes a rate over the words')
  // a take a third short of the brief is still offered the same call, because fit is
  // the thing that knows how far it can honestly go and says so rather than drawling
  const tinyDoc = doc({ dur: 30, clips: [{ id: 'C1', start: 0, end: 30 }], cues: [cue(0, 30, 'hi')] })
  const tiny = of(run(tinyDoc, brief()), 'length')
  assert.strictEqual(tiny.choices[1].fix.tool, 'fit_to_length')
  const said = require('../ui/fit').fit(tinyDoc, { seconds: 60, speech: [[0, 30]] })
  assert.strictEqual(said.hit, false)
  assert.ok(/record more/.test(said.why), said.why)
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
  assert.strictEqual(r.measured.dead_air.seconds, 9)
  assert.deepStrictEqual(r.measured.dead_air.gaps[0], { start: 10, end: 14, out: 10 })
  // under the gap that reads as dead air, nothing is said
  assert.ok(!of(run(doc(), brief()), 'dead-air'))
  // a repro is evidence: its pauses are not a fault
  assert.ok(!of(run(d, brief({ where: 'bug report', seconds: null })), 'dead-air'))
})

t('silence comes out of an edit that hits its number only as far as the number allows', () => {
  const d = doc({ clips: [{ id: 'C1', start: 0, end: 60 }], cues: [cue(0, 10, 'one'), cue(14, 20, 'two'), cue(20, 55, 'three')] })
  const r = run(d, brief())
  const it = of(r, 'dead-air')
  assert.strictEqual(it.fix.tool, 'apply_edit')
  // 60 s against a 60 s brief: three seconds of silence can go and the edit still
  // reads as the number, and the rest is said out loud rather than taken quietly
  const after = run(apply({ doc: d, brief: brief() }, it.fix).doc, brief())
  assert.strictEqual(after.measured.seconds, 57)
  assert.ok(it.what.includes('only if the target moves with it'), it.what)
  assert.ok(after.score > r.score)
})

t('silence that cannot come out without missing the number is one decision, not two fixes', () => {
  // the pair that walked a real job in a circle: "put the take back whole" and "cut it
  // to 44", handed over together, each undoing the other
  const d = doc({ clips: [{ id: 'C1', start: 0, end: 57 }], cues: [cue(0, 10, 'one'), cue(14, 20, 'two'), cue(20, 52, 'three')] })
  const r = run(d, brief())
  const it = of(r, 'dead-air')
  assert.strictEqual(it.severity, 'note')              // declining it cannot hold the verdict
  assert.strictEqual(r.verdict, 'ready')
  assert.ok(it.what.includes('Taking it out leaves 48.45 s, 11.55 s under the 60 s asked for'), it.what)
  assert.ok(it.what.includes('one decision'), it.what)
  assert.strictEqual(it.fix.tool, 'direct')
  assert.deepStrictEqual(it.fix.args.brief, { seconds: 49 })
  assert.strictEqual(it.choices.length, 2)
  assert.ok(it.choices[1].fix.args.note.length > 10)
  // with no length asked for at all, the silence simply comes out, and only the silence
  const loose = of(run(d, brief({ seconds: null, where: null })), 'dead-air')
  assert.strictEqual(loose.severity, 'should')
  assert.strictEqual(loose.fix.tool, 'apply_edit')
  const after = run(apply({ doc: d, brief: brief({ seconds: null, where: null }) }, loose.fix).doc, brief({ seconds: null, where: null }))
  assert.ok(!of(after, 'dead-air'))
  assert.strictEqual(after.measured.seconds, 48.45)
})

t('dead air falls back to the beats when a take has no cues yet', () => {
  const d = doc({ cues: [] })
  const beats = [{ id: 'B1', start: 0, end: 10, label: 'opening' }, { id: 'B2', start: 40, end: 60, label: 'the end' }]
  const r = run(d, brief(), { beats })
  assert.ok(of(r, 'dead-air').what.includes('30 s'), of(r, 'dead-air').what)
})

// ── the rest of the rubric ──────────────────────────────────────────────────

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
  const drawnNever = r.items.filter(i => i.rule === 'never-drawn')
  assert.strictEqual(drawnNever.length, 3)
  assert.deepStrictEqual(drawnNever.map(i => i.fix.args.doc.remove), [['Z1'], ['M1'], ['M2']])
  // nothing is exposed by a redaction on material that is gone, so it is only clutter
  assert.strictEqual(drawnNever.find(i => i.what.startsWith('M2')).severity, 'note')
  assert.strictEqual(drawnNever.find(i => i.what.startsWith('M1')).severity, 'should')
})

t('a lift that runs over a cut is retimed to the piece it mostly lies in', () => {
  const d = doc({
    clips: [{ id: 'C1', start: 0, end: 20 }, { id: 'C2', start: 40, end: 80 }],
    marks: [{ id: 'M1', kind: 'lift', start: 18, end: 50, x: 0.2, y: 0.2, w: 0.3, h: 0.3 }],
  })
  const it = of(run(d, brief({ seconds: 60 })), 'spans-a-cut')
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
  const b = brief({ must_keep: ['the price'], seconds: 30 })
  const it = of(run(d, b), 'must-keep')
  assert.strictEqual(it.severity, 'blocking')          // the brief promised it
  assert.ok(it.what.includes('"the price", which is in the take at 40 s'), it.what)
  // fit_to_length only ever removes material, so handing it back here was a call that
  // could not clear its own finding: clips is the whole list, with the phrase's own
  // span back in it and the seconds it costs taken out of the silence
  assert.strictEqual(it.fix.tool, 'apply_edit')
  assert.deepStrictEqual(it.fix.args.doc.clips, [{ id: 'C1', start: 0, end: 20.15 }, { start: 39.7, end: 50.3 }])
  const after = run(apply({ doc: d, brief: b }, it.fix).doc, b)
  assert.ok(!of(after, 'must-keep'))
  assert.ok(after.score > run(d, b).score)
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
  // the length and the silence used to be two findings pulling opposite ways; they are
  // one call now, and the silence is named inside it
  assert.deepStrictEqual(rules(r), ['redactions', 'aspect', 'length', 'hand-aimed'])
  assert.ok(of(r, 'length').what.includes('silence'), of(r, 'length').what)
  assert.strictEqual(r.verdict, 'not ready')
  assert.strictEqual(r.summary, 'Not ready: 3 things to fix.')
  assert.deepStrictEqual(R.blocking(r).map(i => i.rule), ['redactions', 'aspect', 'length'])
  // nothing blocking, something to fix
  const nearly = run(doc({ clips: [{ id: 'C1', start: 0, end: 70 }], cues: [cue(0, 70, 'talking all the way through')] }), brief())
  assert.strictEqual(nearly.verdict, 'nearly')
  assert.strictEqual(nearly.summary, 'Nearly: 1 thing worth fixing.')
  assert.deepStrictEqual(R.blocking(nearly), [])
})

t('a finding the agent judged and wrote off stops holding the verdict at nearly', () => {
  const d = doc({ clips: [{ id: 'C1', start: 0, end: 70 }], cues: [cue(0, 70, 'talking all the way through')] })
  const before = run(d, brief())
  assert.strictEqual(before.verdict, 'nearly')
  const after = run(d, brief(), { declined: ['length'] })
  assert.strictEqual(after.verdict, 'ready')
  assert.strictEqual(after.score, 10)
  assert.ok(after.summary.endsWith('1 item declined.'), after.summary)
  // it is still in the list, marked, because a declined item is not a deleted one
  assert.strictEqual(of(after, 'length').declined, true)
  assert.deepStrictEqual(R.blocking(run(doc({ cues: [] }), brief(), { declined: ['captions'] })), [])
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
    // a choice is a choice between calls, and the one on offer is one of them
    if (!i.choices) continue
    assert.ok(i.choices.length >= 2 && i.choices.some(c => c.fix === i.fix), i.rule)
    for (const c of i.choices) assert.ok(c.what && tools.has(c.fix.tool), i.rule)
  }
})

// ── safe to follow ──────────────────────────────────────────────────────────
// The take the round before this one was driven on, cold, with one sentence: a 55.55 s
// library tour carrying two cards, five zooms, a lift, five step chips and sixteen
// captions, asked to become a 60 second demo for a landing page.
const tour = () => ({
  v: 2, src: '/m/Tour/Original/Tour.mov', dur: 55.55,
  clips: [{ id: 'C1', start: 0, end: 55.55 }],
  zooms: [
    { id: 'Z1', start: 5.2, end: 9.4, x: 0.4413, y: 0.3821, scale: 1.82 },
    { id: 'Z2', start: 13.9, end: 18.2, x: 0.6217, y: 0.5104, scale: 2.11 },
    { id: 'Z3', start: 23.6, end: 27.2, x: 0.5188, y: 0.4427, scale: 1.94 },
    { id: 'Z4', start: 30.1, end: 34.4, x: 0.3902, y: 0.6013, scale: 2.05 },
    { id: 'Z5', start: 45.2, end: 50.1, x: 0.5511, y: 0.4902, scale: 1.77 },
  ],
  marks: [{ id: 'M1', kind: 'lift', start: 23.6, end: 27.2, x: 0.28, y: 0.2, w: 0.44, h: 0.36 },
    ...[0, 1, 2, 3, 4].map(i => ({ id: 'M' + (i + 2), kind: 'step', start: 24 + i * 0.6, end: 27.2, x: 0.3, y: 0.3 + i * 0.05, n: i + 1 }))],
  texts: [{ id: 'T1', text: 'Songscription', start: 0, end: 2.7 },
    { id: 'T2', text: 'songscription-library.vercel.app', start: 53.6, end: 55.55 }],
  beats: [{ id: 'B1', start: 0, end: 16.2, label: 'the library' }, { id: 'B2', start: 16.2, end: 34.6, label: 'the detail card' },
    { id: 'B3', start: 34.6, end: 55.55, label: 'pick for me' }],
  cues: [[2.13, 8.5], [9.6, 16.2], [17.0, 22.4], [23.6, 28.2], [29.0, 34.6], [35.8, 40.47], [44.11, 53.69]]
    .map(([a, b], i) => cue(a, b, `line ${i + 1} of the tour`)),
  look: { frame: { aspect: '16:9' }, captions: { show: true }, motion: { fadeIn: 0.4, fadeOut: 0.8 },
    background: { kind: 'solid', color: '#2A1D12' } },
})
const tourBrief = () => ({ seconds: 60, aspect: '16:9', where: 'landing page', must_keep: [], must_hide: [] })
const look = (d, b) => R.review({ doc: d, brief: b, path: '/m/Tour/Original/Tour.mov' })

t('the 60 second demo, cold: the first call does not cut the take to 44.8 s', () => {
  const r = look(tour(), tourBrief())
  const it = of(r, 'length')
  // 4.45 s out on a 60 s target: the director called this missed on every call while
  // review needed 4.8 s before it would speak, and the sentence sat behind the gap
  assert.ok(it.what.includes('55.55 s against the 60 s asked for, 4.45 s short'), it.what)
  assert.strictEqual(it.fix.tool, 'direct')
  // and nothing anywhere in the result proposes cutting the take shorter
  for (const i of r.items) {
    assert.notStrictEqual(i.fix.tool, 'fit_to_length')
    if (i.fix.tool !== 'apply_edit' || !i.fix.args.doc.clips) continue
    assert.ok(R.outLength(R.kept({ dur: 55.55, clips: i.fix.args.doc.clips })) >= 55.55 - 0.01)
  }
})

t('the closing URL card and the title card survive every call review makes', () => {
  // the two the round before this one deleted: one orphaned, one clipped to 0.72 s and
  // reported as nothing at all
  let state = { doc: tour(), brief: tourBrief() }
  let last = look(state.doc, state.brief)
  const first = last
  const seen = []
  for (let round = 0; round < 6; round++) {
    const r = look(state.doc, state.brief)
    seen.push({ verdict: r.verdict, score: r.score, seconds: r.measured.seconds, target: r.measured.target })
    assert.ok(r.score >= last.score - 1e-9, `score fell from ${last.score} to ${r.score}`)
    nothingLost(first, r)
    // the two cards are drawn whole at every step, whatever review has just advised
    for (const w of r.measured.must_keep) assert.strictEqual(w.drawn, w.seconds, `${w.what} in round ${round}`)
    const todo = r.items.filter(i => ['apply_edit', 'apply_look', 'direct'].includes(i.fix.tool))
    if (!todo.length) { last = r; break }
    for (const i of todo) state = apply(state, i.fix)
    last = r
  }
  const end = look(state.doc, state.brief)
  assert.strictEqual(end.verdict, 'ready')
  assert.ok(end.score >= first.score, `${first.score} then ${end.score}`)
  assert.ok(seen.length <= 4, `it took ${seen.length} rounds to settle`)
  // it settled on a length it can actually be, within the director's own tolerance
  assert.ok(Math.abs(end.measured.seconds - end.measured.target) <= Math.max(1, end.measured.target * 0.05),
    `${end.measured.seconds} s against ${end.measured.target} s`)
  // and the demo still opens on its title and closes on its address
  const cards = end.measured.must_keep.filter(w => w.what.startsWith('the card'))
  assert.deepStrictEqual(cards.map(w => [w.id, w.drawn, w.seconds]), [['T1', 2.7, 2.7], ['T2', 1.95, 1.95]])
})

t('applying every call in order leaves the edit better by review\'s own measure', () => {
  const d = doc({
    dur: 120, clips: [{ id: 'C1', start: 0, end: 78 }],
    look: { frame: { aspect: 'auto' }, captions: { show: false }, background: { kind: 'solid', color: '#1A1714' } },
    texts: [{ id: 'T1', text: 'Fetch', start: 0, end: 3 }, { id: 'T2', text: 'fetch.app', start: 74, end: 78 }],
    zooms: [{ id: 'Z1', start: 5, end: 11, x: 0.3721, y: 0.6042, scale: 2.13 },
      { id: 'Z9', start: 90, end: 95, x: 0.4113, y: 0.6042, scale: 2.13 }],
    marks: [{ id: 'M1', kind: 'lift', start: 20, end: 30, x: 0.2, y: 0.2, w: 0.4, h: 0.3 },
      { id: 'M2', kind: 'spotlight', start: 22, end: 28, x: 0.25, y: 0.22, w: 0.3, h: 0.3 }],
    cues: [cue(3, 20, 'one'), cue(40, 60, 'two'), cue(70, 74, 'three')],
  })
  const b = brief()
  const before = run(d, b)
  assert.ok(before.items.length >= 5, JSON.stringify(rules(before)))
  assert.strictEqual(before.verdict, 'not ready')
  // every one of them is a call this harness can actually make
  for (const i of before.items) assert.ok(['apply_edit', 'apply_look', 'direct'].includes(i.fix.tool), i.rule)
  let state = { doc: d, brief: b }
  const removed = []
  for (const i of before.items) {
    removed.push(...((i.fix.args.doc && i.fix.args.doc.remove) || []))
    state = apply(state, i.fix)
  }
  const after = R.review({ doc: state.doc, brief: state.brief, path: '/m/Demo/Original/Demo.mov' })
  assert.ok(after.score > before.score, `${before.score} then ${after.score}`)
  assert.strictEqual(after.verdict, 'ready')
  // 58.6 s against the 60 asked for: inside the director's own tolerance, and never
  // the eleven seconds under that following review's advice used to cost
  assert.strictEqual(after.measured.seconds, 58.6)
  assert.ok(Math.abs(after.measured.seconds - 60) <= Math.max(1, 60 * 0.05))
  nothingLost(before, after, removed)
})

t('no call review makes ever shortens the work', () => {
  // every finding on every edit in this file's awkward corners, applied and measured
  const cases = [
    [tour(), tourBrief()],
    [doc({ clips: [{ id: 'C1', start: 0, end: 75 }], texts: [{ id: 'T1', text: 'Fetch', start: 0, end: 4 }] }), brief()],
    [doc({ clips: [{ id: 'C1', start: 0, end: 30 }], texts: [{ id: 'T1', text: 'Fetch', start: 100, end: 104 }] }), brief()],
    [doc({ clips: [{ id: 'C1', start: 10, end: 40 }], texts: [{ id: 'T1', text: 'Fetch', start: 8, end: 14 }] }), brief({ seconds: 30 })],
    [doc({ clips: [{ id: 'C1', start: 0, end: 60, rate: 2 }] }), brief({ seconds: 20 })],
    [doc({ clips: [{ id: 'C1', start: 0, end: 30 }], cues: [cue(0, 20, 'one'), cue(40, 50, 'and the price is free')] }),
      brief({ must_keep: ['the price'], seconds: 30 })],
  ]
  let fixes = 0
  for (const [d, b] of cases) {
    const r = R.review({ doc: d, brief: b, path: d.src })
    const before = R.work(d, b, R.kept(d), d.cues)
    for (const i of [...r.items, ...r.items.flatMap(x => x.choices || [])]) {
      const clips = i.fix.args.doc && i.fix.args.doc.clips
      if (!clips) continue
      fixes++
      assert.deepStrictEqual(R.damage(before, R.kept({ dur: d.dur, clips })), [], `${i.rule}: ${JSON.stringify(clips)}`)
    }
  }
  // three now rather than four: the short-edit choice used to write a rate over every
  // clip and hands over fit_to_length instead, which is a call and not a clips list
  assert.ok(fixes >= 3, `${fixes} clips lists were checked`)
})

t('two calls can never undo each other, because only one of them retimes the edit', () => {
  const retimes = i => (i.fix.tool === 'fit_to_length') ||
    (i.fix.tool === 'apply_edit' && !!(i.fix.args.doc && i.fix.args.doc.clips)) ||
    (i.fix.tool === 'direct' && !!(i.fix.args.brief && i.fix.args.brief.seconds))
  const cases = [
    [tour(), tourBrief()],
    [doc({ clips: [{ id: 'C1', start: 0, end: 90 }] }), brief()],
    [doc({ clips: [{ id: 'C1', start: 0, end: 20 }], cues: [cue(0, 20, 'one'), cue(40, 50, 'and the price is free')] }),
      brief({ must_keep: ['the price'] })],
    [doc({ clips: [{ id: 'C1', start: 0, end: 30 }] }), brief()],
    [doc({ clips: [{ id: 'C1', start: 0, end: 60 }], cues: [cue(0, 10, 'one'), cue(30, 60, 'two')] }), brief()],
  ]
  for (const [d, b] of cases) {
    const r = R.review({ doc: d, brief: b, path: d.src })
    const moving = r.items.filter(retimes)
    assert.ok(moving.length <= 1, `${moving.length} calls move the length: ${moving.map(i => i.rule)}`)
    // the choices inside one decision are allowed to disagree, and say so out loud
    for (const i of moving) if (i.choices) assert.ok(i.what.includes('decision') || i.choices.length === 2, i.rule)
  }
})

t('a clips list hands back the ids and the speed regions it was given', () => {
  const d = doc({
    clips: [{ id: 'C1', start: 0, end: 20 }, { id: 'C2', start: 20, end: 60, rate: 2 }],
    cues: [cue(0, 8, 'one'), cue(20, 60, 'two')],
  })
  const it = of(run(d, brief({ seconds: 30 })), 'dead-air') || of(run(d, brief({ seconds: 30 })), 'length')
  const clips = it.fix.args.doc.clips
  // the sped clip comes back sped, and keeps its id: a fix that dropped the rate would
  // hand back a different video and call it the same edit
  const fast = clips.find(c => c.rate)
  assert.deepStrictEqual([fast.id, fast.start, fast.end, fast.rate], ['C2', 20, 60, 2])
  assert.strictEqual(clips[0].id, 'C1')
  // and the cut came out of the plain clip, where the silence was
  assert.ok(clips[0].end < 20)
})

// ── the clocks, the table, and the shape of the thing ───────────────────────

t('the times to look at come in both clocks, findings first', () => {
  const beats = [{ id: 'B1', start: 0, end: 20, label: 'opening' }, { id: 'B2', start: 20, end: 60, label: 'the run' }]
  const r = run(doc({ zooms: [], clips: [{ id: 'C1', start: 30, end: 90 }], cues: [cue(30, 90, 'talking')] }), brief(), { beats })
  assert.ok(r.look_at.length > 0 && r.look_at.length <= 6)
  for (const l of r.look_at) assert.ok(Number.isFinite(l.at) && l.why)
  // sorted by the recording's clock, and each output time is its own place in the export
  assert.deepStrictEqual(r.look_at.map(l => l.at).slice().sort((a, b) => a - b), r.look_at.map(l => l.at))
  const inEdit = r.look_at.filter(l => l.at >= 30 && l.at <= 90)
  for (const l of inEdit) assert.strictEqual(l.out, Math.round((l.at - 30) * 100) / 100)
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

  // cutting and restoring are the two halves of one sum, and both keep the rate
  const cut = R.without(fast, [[10, 20]])
  assert.deepStrictEqual(cut.map(c => [c.start, c.end, c.rate[0]]), [[0, 10, 2], [20, 60, 2]])
  assert.strictEqual(R.outLength(cut), 25)
  const back = R.including(cut, [[10, 20]], 60)
  assert.deepStrictEqual(back.map(c => [c.start, c.end, c.rate[0]]), [[0, 10, 2], [10, 20, 1], [20, 60, 2]])
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
  // the tour, which exercises every new rule in this file, comes back untouched too
  const t0 = JSON.stringify(tour())
  look(tour(), tourBrief())
  assert.strictEqual(JSON.stringify(tour()), t0)
  // and it survives a document with nothing in it
  const empty = R.review({})
  assert.strictEqual(empty.measured.seconds, 0)
  assert.ok(empty.verdict && empty.score >= 0)
})

t('review and fit_to_length settle instead of undoing each other', () => {
  // The judged take's shape, asked for 45 s: review's top fix was fit_to_length, fit
  // deleted both cards, review answered must-keep, and the two calls went round for
  // ever with the score pinned. Both tools are driven here, for real, from one call to
  // the next, so the loop is the thing under test rather than either half of it.
  const Fit = require('../ui/fit')
  let d = doc({
    dur: 55.55,
    clips: [{ id: 'C1', start: 0, end: 55.55 }],
    zooms: [],
    marks: [{ id: 'M1', kind: 'lift', start: 20, end: 24, x: 0.3, y: 0.3, w: 0.2, h: 0.2 }],
    texts: [{ id: 'T1', text: 'Songscription', start: 0, end: 2.7 },
      { id: 'T2', text: 'songscription-library.vercel.app', start: 53.85, end: 55.55 }],
    beats: Array.from({ length: 5 }, (_, i) => ({ id: 'B' + (i + 1), start: 3 + i * 10, end: 13 + i * 10 })),
    cues: Array.from({ length: 5 }, (_, i) => cue(3 + i * 10, 12 + i * 10, 'talking')),
  })
  let b = brief({ seconds: 45 })
  const speech = d.cues.map(c => [c.start, c.end])
  const drawn = (doc2, a, z) => R.kept(doc2).reduce((n, c) => n + Math.max(0, Math.min(z, c.end) - Math.max(a, c.start)), 0)
  let rounds = 0, last = null
  while (rounds++ < 6) {
    const r = R.review({ doc: d, brief: b, path: d.src })
    assert.ok(Math.abs(drawn(d, 0, 2.7) - 2.7) < 0.05, `round ${rounds}: the title card is ${drawn(d, 0, 2.7)} of 2.7`)
    assert.ok(Math.abs(drawn(d, 53.85, 55.55) - 1.7) < 0.05, `round ${rounds}: the URL card is ${drawn(d, 53.85, 55.55)} of 1.7`)
    last = r
    const it = r.items.find(x => ['length', 'dead-air', 'must-keep', 'clipped'].includes(x.rule))
    if (!it) break
    if (it.fix.tool === 'fit_to_length') {
      d = { ...d, clips: Fit.fit(d, { seconds: it.fix.args.seconds, keep: it.fix.args.keep, speech }).clips }
    } else if (it.fix.tool === 'apply_edit' && it.fix.args.doc.clips) {
      d = { ...d, clips: it.fix.args.doc.clips }
    } else if (it.fix.tool === 'direct') {
      b = { ...b, ...it.fix.args.brief }
    } else break
  }
  assert.ok(rounds <= 4, `${rounds} rounds and still going`)
  assert.strictEqual(last.verdict, 'ready')
  assert.ok(Math.abs(last.measured.seconds - b.seconds) <= 2.25, `landed on ${last.measured.seconds}`)
})

t('a written-off blocking item is softened, never deleted, and a redaction not even that', () => {
  // An agent that could turn "not ready" into "ready" on its own say-so is marking its
  // own paper, and the word has to keep meaning an edit with nothing blocking left.
  const d = doc()
  const b = brief({ must_hide: ['the API key in the header'] })
  const before = run(d, b)
  assert.strictEqual(before.verdict, 'not ready')
  const after = run(d, b, { declined: ['redactions'] })
  assert.strictEqual(after.verdict, 'not ready')
  assert.strictEqual(R.blocking(after).length, 1)
  assert.ok(!/nothing the rubric can name/.test(after.summary), after.summary)
  // any other blocking item drops to a should and stays on the list
  const long = doc({ clips: [{ id: 'C1', start: 0, end: 110 }], cues: [cue(0, 110, 'talking')] })
  const raw = of(run(long, brief()), 'length')
  assert.strictEqual(raw.severity, 'blocking')
  const soft = of(run(long, brief(), { declined: ['length'] }), 'length')
  assert.strictEqual(soft.severity, 'should')
  assert.strictEqual(soft.lowered, true)
  assert.notStrictEqual(soft.declined, true)
})

t('a cut in the silence is sized in the seconds the finished video spends', () => {
  // A hold at 0.655x pays out half as much again, so a gap measured in the recording's
  // own seconds overshot the target it had just promised to hold, and the next round
  // called the edit short and cut again.
  const d = doc({
    dur: 40,
    clips: [{ id: 'C1', start: 0, end: 12 }, { id: 'C2', start: 12, end: 24, rate: 0.655 }, { id: 'C3', start: 24, end: 40 }],
    cues: [cue(0, 11, 'talking'), cue(13, 23, 'talking'), cue(24, 30, 'talking')],
  })
  const secs = run(d, brief()).measured.seconds
  const target = Math.round(secs - 2)
  const it = of(run(d, brief({ seconds: target })), 'length') || of(run(d, brief({ seconds: target })), 'dead-air')
  assert.ok(it, 'nothing was offered')
  const after = run(apply({ doc: d, brief: brief({ seconds: target }) }, it.fix).doc, brief({ seconds: target }))
  assert.ok(Math.abs(after.measured.seconds - target) <= 1.65,
    `landed on ${after.measured.seconds} against ${target}`)
})

t('a must_keep phrase said across two cues is still held, and one nobody said is named', () => {
  const d = doc({
    clips: [{ id: 'C1', start: 0, end: 60 }],
    cues: [cue(0, 20, 'here is the pricing'), cue(20, 40, 'page and then we are done'), cue(40, 60, 'that is it')],
  })
  const r = run(d, brief({ must_keep: ['the pricing page', 'the admin panel'] }))
  const held = r.measured.must_keep.map(w => w.what)
  assert.ok(held.includes('"the pricing page"'), JSON.stringify(held))
  // and the span it protects is the two cues joined, not one of them
  const span = r.measured.must_keep.find(w => w.what === '"the pricing page"')
  assert.strictEqual(span.seconds, 40)
  assert.deepStrictEqual(r.measured.must_keep_unmatched, ['the admin panel'])
  // a phrase inside one cue still protects that cue alone
  const one = run(d, brief({ must_keep: ['that is it'] }))
  assert.strictEqual(one.measured.must_keep[0].seconds, 20)
})

t('no em dashes anywhere a person or a model reads', () => {
  const all = JSON.stringify([
    run(doc(), brief({ must_hide: ['x'], must_keep: ['thing'] }), { levels: { lo: 0.01, hi: 0.5 } }),
    run(doc({ look: { frame: { aspect: 'auto' } }, cues: [], clips: [{ id: 'C1', start: 0, end: 5 }] }), brief()),
    look(tour(), tourBrief()),
    R.WHERE,
  ])
  assert.ok(!/—/.test(all))
  assert.ok(!/—/.test(require('fs').readFileSync(require.resolve('../ui/review'), 'utf8')))
})

console.log(`\n${n} checks passed`)
