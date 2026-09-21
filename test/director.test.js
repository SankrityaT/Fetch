// The job Biscuit is trying to finish: the brief, the plan, what is closed, and how far
// the edit still is from what was asked.
//   node test/director.test.js
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const D = require('../ui/director')

let n = 0
const t = (name, fn) => { fn(); n++; console.log('ok', name) }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-director-'))
const take = (name = 'Demo') => {
  const f = path.join(dir, name, 'Original', name + '.mov')
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, 'not really a movie')
  return f
}
const NOW = 1_700_000_000_000

console.log('the director: a brief and a plan it can keep')

t('the job sits in the take\'s own hidden folder, beside every other sidecar', () => {
  const src = take('Sidecar')
  assert.strictEqual(D.jobPath(src), path.join(dir, 'Sidecar', 'Original', '.fetch', 'Sidecar.job.json'))
  D.direct(src, { brief: { seconds: 60 } }, { now: NOW })
  assert.ok(fs.existsSync(D.jobPath(src)))
  // nothing else written: closing a step must not dirty the autosave or the document
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'Sidecar', 'Original', '.fetch')), ['Sidecar.job.json'])
})

t('a brief is written and reads back whole', () => {
  const src = take('Brief')
  const r = D.direct(src, {
    brief: {
      what: 'the import and export of a project', seconds: 60, aspect: '16:9',
      where: 'landing page', audience: 'people who have never seen it',
      must_keep: ['the import step', 'the export step'], must_hide: 'the API key',
    },
  }, { now: NOW })
  assert.deepStrictEqual(r.brief, {
    what: 'the import and export of a project',
    seconds: 60, aspect: '16:9', where: 'landing page', audience: 'people who have never seen it',
    must_keep: ['the import step', 'the export step'], must_hide: ['the API key'],
  })
  assert.deepStrictEqual(D.read(src).brief, r.brief)
})

// what a picture is for. A still has no length, so on a shot this is nearly the whole
// brief, and review builds its find_on_screen queries out of it: dropped on write, the
// rubric's own fixes went out with no query in them and the loop could not be closed.
t('what the thing is survives the write, which on a still is most of the brief', () => {
  const src = take('BriefWhat')
  const r = D.direct(src, { brief: { what: 'a help centre hero of the library' } }, { now: NOW })
  assert.strictEqual(r.brief.what, 'a help centre hero of the library')
  assert.strictEqual(D.read(src).brief.what, 'a help centre hero of the library')
  const kept = D.direct(src, { brief: { aspect: '16:9' } }, { now: NOW + 1 })
  assert.strictEqual(kept.brief.what, 'a help centre hero of the library')
  assert.strictEqual(D.direct(src, { brief: { what: null } }, { now: NOW + 2 }).brief.what, null)
})

t('a second call refines the brief rather than wiping it, and an explicit null clears one field', () => {
  const src = take('Refine')
  D.direct(src, { brief: { seconds: 60, aspect: '16:9', where: 'landing page' } }, { now: NOW })
  const r = D.direct(src, { brief: { seconds: 45 } }, { now: NOW + 1 })
  assert.strictEqual(r.brief.seconds, 45)
  assert.strictEqual(r.brief.aspect, '16:9')
  const cleared = D.direct(src, { brief: { where: null } }, { now: NOW + 2 })
  assert.strictEqual(cleared.brief.where, null)
  assert.strictEqual(cleared.brief.seconds, 45)
})

t('plain lines become numbered steps, and the line is what the chat draws', () => {
  const src = take('Plan')
  const r = D.direct(src, { plan: ['cut to the three moments', 'zoom on each', 'captions', 'export 16:9'] }, { now: NOW })
  assert.deepStrictEqual(r.plan.steps.map(s => s.id), ['P1', 'P2', 'P3', 'P4'])
  assert.deepStrictEqual(r.plan.steps.map(s => s.state), ['todo', 'todo', 'todo', 'todo'])
  assert.strictEqual(r.plan.line, '0 of 4')
  assert.deepStrictEqual(r.plan.next, { id: 'P1', what: 'cut to the three moments' })
})

t('closing a step moves the count, and an id that closes nothing is said out loud', () => {
  const src = take('Close')
  D.direct(src, { plan: ['one', 'two', 'three'] }, { now: NOW })
  const r = D.direct(src, { done: 'p1' }, { now: NOW + 1 })
  assert.deepStrictEqual(r.closed, ['P1'])
  assert.strictEqual(r.plan.line, '1 of 3')
  assert.deepStrictEqual(r.plan.left.map(s => s.id), ['P2', 'P3'])
  const bad = D.direct(src, { done: ['P2', 'P9'] }, { now: NOW + 2 })
  assert.deepStrictEqual(bad.closed, ['P2'])
  assert.deepStrictEqual(bad.unknown, ['P9'])
  assert.strictEqual(bad.plan.line, '2 of 3')
})

t('a step review sends back is reopened, and a dropped step is not left', () => {
  const src = take('Reopen')
  D.direct(src, { plan: ['one', 'two'], done: ['P1', 'P2'] }, { now: NOW })
  assert.strictEqual(D.direct(src, { open: 'P2' }, { now: NOW + 1 }).plan.line, '1 of 2')
  const dropped = D.direct(src, { drop: 'P2' }, { now: NOW + 2 })
  assert.strictEqual(dropped.plan.line, '2 of 2')
  assert.deepStrictEqual(dropped.plan.left, [])
  assert.strictEqual(dropped.plan.steps[1].state, 'dropped')
})

t('re-planning keeps the state of every step whose words did not change', () => {
  const src = take('Replan')
  D.direct(src, { plan: ['cut', 'zoom', 'captions'], done: ['P1', 'P2'] }, { now: NOW })
  const r = D.direct(src, { plan: ['cut', 'zoom on each moment', 'captions', 'export'] }, { now: NOW + 1 })
  const by = Object.fromEntries(r.plan.steps.map(s => [s.what, s.state]))
  assert.strictEqual(by.cut, 'done')
  assert.strictEqual(by['zoom on each moment'], 'todo', 'a step whose words changed is a different step')
  assert.strictEqual(by.captions, 'todo')
  assert.strictEqual(by.export, 'todo')
  assert.strictEqual(r.plan.line, '1 of 4')
})

t('a step keeps its id across a re-plan, because apply_edit closes it by id', () => {
  const src = take('Ids')
  D.direct(src, { plan: [{ id: 'P1', what: 'cut' }, { id: 'P2', what: 'zoom' }] }, { now: NOW })
  const r = D.direct(src, { plan: ['zoom', 'cut', 'grade'] }, { now: NOW + 1 })
  assert.deepStrictEqual(r.plan.steps.map(s => [s.id, s.what]), [['P2', 'zoom'], ['P1', 'cut'], ['P3', 'grade']])
})

t('a plan is a plan, so it stops at twelve steps and the notes keep only the last twenty', () => {
  const src = take('Caps')
  const many = Array.from({ length: 30 }, (_, i) => 'step ' + i)
  const r = D.direct(src, { plan: many }, { now: NOW })
  assert.strictEqual(r.plan.total, D.MAX_STEPS)
  let job = null
  for (let i = 0; i < 25; i++) job = D.merge(job, { note: 'note ' + i }, NOW + i).job
  assert.strictEqual(job.notes.length, D.MAX_NOTES)
  assert.strictEqual(job.notes[0].text, 'note 5')
  assert.strictEqual(job.notes[D.MAX_NOTES - 1].text, 'note 24')
})

t('distance measures length against the brief, in the agent\'s own words', () => {
  const job = D.merge(null, { brief: { seconds: 60, aspect: '16:9' } }, NOW).job
  const on = D.distance(job, { seconds: 61.4, aspect: '16:9' })
  assert.strictEqual(on.ok, true)
  assert.strictEqual(on.seconds.off, 1.4)
  assert.strictEqual(on.line, '61.4 s against 60 asked, on the number; 16:9 as asked')

  const long = D.distance(job, { seconds: 94, aspect: '16:9' })
  assert.strictEqual(long.ok, false)
  assert.strictEqual(long.seconds.ok, false)
  assert.ok(long.line.startsWith('94 s against 60 asked, 34 s over'))
  assert.ok(D.distance(job, { seconds: 40, aspect: '16:9' }).line.includes('20 s under'))
})

t('a shape nobody set reads differently from the wrong shape', () => {
  const job = D.merge(null, { brief: { aspect: '16:9' } }, NOW).job
  assert.strictEqual(D.distance(job, { aspect: null }).line, '16:9 asked, none set')
  assert.strictEqual(D.distance(job, { aspect: '9:16' }).line, '16:9 asked, 9:16 set')
  assert.strictEqual(D.distance(job, { aspect: 1.778 }).aspect.ok, true, 'a number is the same shape as its name')
})

t('what the brief does not ask for is not measured here', () => {
  const job = D.merge(null, { brief: { where: 'landing page' } }, NOW).job
  const d = D.distance(job, { seconds: 300, aspect: '1:1' })
  assert.deepStrictEqual(d, { seconds: null, aspect: null, ok: true, line: '' })
})

t('the tolerance is five percent and never under a second', () => {
  assert.strictEqual(D.tolerance(60), 3)
  assert.strictEqual(D.tolerance(10), 1)
})

t('every edit carries the plan and the distance, and a take with no job carries the nudge', () => {
  const src = take('ForEdit')
  const none = D.forEdit(src, { seconds: 90 })
  assert.strictEqual(none.plan, null)
  assert.strictEqual(none.hint, D.NO_BRIEF)
  D.direct(src, { brief: { seconds: 60 }, plan: ['cut', 'zoom'], done: 'P1' }, { now: NOW })
  const s = D.forEdit(src, { seconds: 90 })
  assert.strictEqual(s.plan.line, '1 of 2')
  assert.deepStrictEqual(s.plan.next, { id: 'P2', what: 'zoom' })
  assert.strictEqual(s.distance.seconds.off, 30)
  assert.strictEqual(s.hint, undefined)
})

t('the job survives being read back, byte for byte', () => {
  const src = take('Round')
  D.direct(src, { brief: { seconds: 60, aspect: '16:9' }, plan: ['cut', 'zoom'], done: 'P1', note: 'the login screen stays in' }, { now: NOW })
  const once = fs.readFileSync(D.jobPath(src), 'utf8')
  const again = D.write(src, JSON.parse(once))
  assert.strictEqual(fs.readFileSync(D.jobPath(src), 'utf8'), once)
  assert.deepStrictEqual(again, D.normalize(again), 'normalize is a fixed point')
  assert.deepStrictEqual(again.notes, [{ at: NOW, text: 'the login screen stays in' }])
})

t('a job file that will not parse reads as no job and never blocks an edit', () => {
  const src = take('Broken')
  fs.mkdirSync(path.dirname(D.jobPath(src)), { recursive: true })
  fs.writeFileSync(D.jobPath(src), '{ this is not json')
  assert.strictEqual(D.read(src), null)
  assert.strictEqual(D.forEdit(src, {}).hint, D.NO_BRIEF)
  const r = D.direct(src, { brief: { seconds: 30 } }, { now: NOW })
  assert.strictEqual(r.brief.seconds, 30)
  assert.strictEqual(D.read(src).brief.seconds, 30)
})

t('a call that changes nothing leaves the stamp alone, so a plan is not touched by being read', () => {
  const job = D.merge(null, { plan: ['cut'] }, NOW).job
  const r = D.merge(job, {}, NOW + 5000)
  assert.strictEqual(r.changed, false)
  assert.strictEqual(r.job.updated, NOW)
  assert.strictEqual(r.job.created, NOW)
  assert.strictEqual(D.merge(job, { done: 'P1' }, NOW + 5000).job.updated, NOW + 5000)
})

t('ratios come in three spellings and a shape nobody asked for is null', () => {
  assert.strictEqual(Math.round(D.ratio('16:9') * 1000), 1778)
  assert.strictEqual(Math.round(D.ratio('16/9') * 1000), 1778)
  assert.strictEqual(Math.round(D.ratio('16x9') * 1000), 1778)
  assert.strictEqual(D.ratio(1.5), 1.5)
  for (const v of [null, '', 'auto', 'source', 'wide', 0, -2, 42, '1:99']) assert.strictEqual(D.ratio(v), null, String(v))
})

t('junk in the patch does not become a step or a brief', () => {
  const r = D.merge(null, { plan: ['  ', null, { what: '' }, 'real step'], brief: { seconds: 'soon', aspect: 42 } }, NOW)
  assert.deepStrictEqual(r.job.steps, [{ id: 'P1', what: 'real step', state: 'todo' }])
  assert.strictEqual(r.job.brief.seconds, null)
  assert.strictEqual(r.job.brief.aspect, '42')
  assert.strictEqual(D.distance(r.job, { aspect: '16:9' }).aspect, null, 'a shape that parses to nothing is not a demand')
})

fs.rmSync(dir, { recursive: true, force: true })
console.log(`\n${n} director tests passed`)
