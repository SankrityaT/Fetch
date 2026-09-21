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
    device: null, app: null, size: null,
  })
  assert.deepStrictEqual(D.read(src).brief, r.brief)
})

// "brief wants an object" cost a call in the judged run, and a refusal that teaches an
// argument shape is the cheapest call in the product to delete.
t('a brief sent as one line is a brief, not a refusal', () => {
  const src = take('OneLine')
  const r = D.direct(src, { brief: 'a 30 second preview of the onboarding' }, { now: NOW })
  assert.strictEqual(r.brief.what, 'a 30 second preview of the onboarding')
  assert.strictEqual(D.direct(src, { brief: { seconds: 30 } }, { now: NOW + 1 }).brief.what,
    'a 30 second preview of the onboarding')
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

// ── a job whose shape is already known ──────────────────────────────────────
// The named device job was judged at nineteen calls against the five it was sold as,
// and the calls that were not a bug were an agent rediscovering a path that never
// changes. These pin the path.

console.log('\na job whose shape is already known')

t('a brief that names a device is a device job, and anything else is an edit', () => {
  assert.strictEqual(D.shapeOf(D.normalizeBrief({ device: 'Yolk-ProMax' })), 'device')
  assert.strictEqual(D.shapeOf(D.normalizeBrief({ seconds: 60, where: 'landing page' })), null)
  assert.deepStrictEqual(D.outline(D.normalizeBrief({ seconds: 60 })), [])
})

t('the device job lays its own plan out, and every step is a call with its arguments', () => {
  const src = take('Device')
  const r = D.direct(src, {
    brief: { what: 'the onboarding', device: 'Yolk-ProMax', app: 'com.yolkling.ios', seconds: 28, size: 'app-preview-6.9' },
  }, { now: NOW })
  assert.deepStrictEqual(r.plan.steps.map(s => s.call.tool),
    ['simulator', 'record_start', 'simulator', 'record_stop', 'fit_to_length', 'export'])
  assert.deepStrictEqual(r.plan.next.call,
    { tool: 'simulator', args: { action: 'ready', device: 'Yolk-ProMax', app: 'com.yolkling.ios' } })
  // the two calls the judge spent on argument shapes: the size enum and the length
  const by = Object.fromEntries(r.plan.steps.map(s => [s.call.tool, s.call.args]))
  // with a take under the job, the calls that need one name it
  assert.deepStrictEqual(by.export, { path: src, size: 'app-preview-6.9' })
  assert.deepStrictEqual(by.fit_to_length, { path: src, seconds: 28 })
  assert.deepStrictEqual(by.record_start, { simulator: 'Yolk-ProMax' })
  assert.strictEqual(r.plan.line, '0 of 6')
})

t('with no length asked there is nothing to fit, so the step is not there to be closed', () => {
  const src = take('NoLength')
  const r = D.direct(src, { brief: { device: 'Yolk-SE' } }, { now: NOW })
  assert.deepStrictEqual(r.plan.steps.map(s => s.call.tool),
    ['simulator', 'record_start', 'simulator', 'record_stop', 'export'])
  assert.deepStrictEqual(r.plan.steps[4].call.args, { path: src }, 'a size nobody named is not guessed at')
})

t('a size named on a later call reaches the export step, and nothing already closed reopens', () => {
  const src = take('LateSize')
  D.direct(src, { brief: { device: 'Yolk-ProMax' } }, { now: NOW })
  const closed = D.direct(src, { done: ['P1', 'P2'] }, { now: NOW + 1 })
  assert.strictEqual(closed.plan.line, '2 of 5')
  const r = D.direct(src, { brief: { size: 'app-preview-6.9', seconds: 28 } }, { now: NOW + 2 })
  const ex = r.plan.steps.find(s => s.call.tool === 'export')
  assert.deepStrictEqual(ex.call.args, { path: src, size: 'app-preview-6.9' })
  assert.deepStrictEqual(r.plan.steps.filter(s => s.state === 'done').map(s => s.id), ['P1', 'P2'])
  assert.ok(r.plan.steps.some(s => s.call.tool === 'fit_to_length'), 'the length arrived, so the step did')
})

t('a plan the agent wrote is never overruled by the shape', () => {
  const src = take('Mine')
  D.direct(src, { plan: ['cut to the three moments', 'export'] }, { now: NOW })
  const r = D.direct(src, { brief: { device: 'Yolk-ProMax' } }, { now: NOW + 1 })
  assert.deepStrictEqual(r.plan.steps.map(s => s.what), ['cut to the three moments', 'export'])
  assert.ok(!r.plan.steps.some(s => s.call))
})

t('reading a shaped job back does not touch it, so a plan is not dirtied by being looked at', () => {
  const src = take('Stable')
  D.direct(src, { brief: { device: 'Yolk-ProMax', seconds: 28, size: 'app-preview-6.9' } }, { now: NOW })
  const once = fs.readFileSync(D.jobPath(src), 'utf8')
  const again = D.direct(src, {}, { now: NOW + 5000 })
  assert.strictEqual(fs.readFileSync(D.jobPath(src), 'utf8'), once)
  assert.strictEqual(again.plan.next.call.tool, 'simulator')
  assert.deepStrictEqual(D.normalize(JSON.parse(once)), JSON.parse(once), 'normalize is still a fixed point')
})

t('a step keeps its call across a re-plan that sends the same words back as lines', () => {
  const src = take('Relines')
  const first = D.direct(src, { brief: { device: 'Yolk-ProMax' } }, { now: NOW })
  const words = first.plan.steps.map(s => s.what)
  const r = D.direct(src, { plan: words }, { now: NOW + 1 })
  assert.deepStrictEqual(r.plan.steps.map(s => s.id), first.plan.steps.map(s => s.id))
  assert.strictEqual(r.plan.steps[0].call.tool, 'simulator')
})

// ── a job that exists before the take does ──────────────────────────────────

console.log('\na job that exists before the take does')

t('a job can be directed with no take under it, and it waits in the folder it was given', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-pending-'))
  const r = D.direct(null, { brief: { device: 'Yolk-ProMax', seconds: 28, size: 'app-preview-6.9' } }, { dir: home, now: NOW })
  assert.strictEqual(r.waiting, true)
  assert.strictEqual(r.file, D.pendingPath(home))
  assert.ok(fs.existsSync(r.file))
  assert.strictEqual(r.plan.next.call.args.device, 'Yolk-ProMax')
  // a second call before the take exists refines the same waiting job
  const more = D.direct(null, { brief: { app: 'com.yolkling.ios' } }, { dir: home, now: NOW + 1 })
  assert.strictEqual(more.brief.device, 'Yolk-ProMax')
  assert.strictEqual(more.plan.next.call.args.app, 'com.yolkling.ios')
  assert.throws(() => D.direct(null, { brief: { device: 'x' } }, { now: NOW }), /folder to wait in/)
  fs.rmSync(home, { recursive: true, force: true })
})

t('record_stop moves the waiting job onto the take, and it is not left to catch the next one', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-pending-'))
  const src = take('Attach')
  D.direct(null, { brief: { device: 'Yolk-ProMax', seconds: 28 } }, { dir: home, now: NOW })
  const r = D.attach(src, home, NOW + 1)
  assert.strictEqual(r.brief.device, 'Yolk-ProMax')
  assert.strictEqual(D.read(src).brief.seconds, 28)
  assert.strictEqual(D.readPending(home, NOW + 2), null, 'the waiting job is taken, not copied')
  assert.strictEqual(D.attach(take('Attach2'), home, NOW + 3), null)
  fs.rmSync(home, { recursive: true, force: true })
})

t('once the take exists, the steps that made it are closed and next is the length, with the take named', () => {
  // Nothing in simulator, record_start or record_stop takes a step, so left open the
  // plan's next call stayed 'simulator ready' for the rest of the job.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-pending-'))
  const src = take('Closes')
  D.direct(null, { brief: { device: 'Yolk-ProMax', seconds: 28, size: 'app-preview-6.9' } }, { dir: home, now: NOW })
  const r = D.attach(src, home, NOW + 1)
  assert.deepStrictEqual(r.plan.steps.filter(s => s.state === 'done').map(s => s.id), ['P1', 'P2', 'P3', 'P4'])
  assert.strictEqual(r.plan.next.call.tool, 'fit_to_length')
  assert.deepStrictEqual(r.plan.next.call.args, { path: src, seconds: 28 })
  const later = D.forEdit(src, null)
  assert.strictEqual(later.plan.next.id, 'P5', 'and stays there when the plan is read back')
  fs.rmSync(home, { recursive: true, force: true })
})

t('a take that already has a job keeps it, and the waiting job is still cleared away', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-pending-'))
  const src = take('Keeps')
  D.direct(null, { brief: { device: 'Yolk-SE', seconds: 10 } }, { dir: home, now: NOW })
  D.direct(src, { brief: { seconds: 60, aspect: '16:9' } }, { now: NOW + 1 })
  assert.strictEqual(D.attach(src, home, NOW + 2), null)
  assert.strictEqual(D.read(src).brief.seconds, 60)
  assert.strictEqual(D.readPending(home, NOW + 3), null)
  fs.rmSync(home, { recursive: true, force: true })
})

t('a job nobody attached within the day is not this take\'s job', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-pending-'))
  D.direct(null, { brief: { device: 'Yolk-ProMax' } }, { dir: home, now: NOW })
  assert.ok(D.readPending(home, NOW + D.PENDING_STALE))
  assert.strictEqual(D.readPending(home, NOW + D.PENDING_STALE + 1), null)
  assert.strictEqual(D.attach(take('Stale'), home, NOW + D.PENDING_STALE + 1), null)
  fs.rmSync(home, { recursive: true, force: true })
})

t('the length the brief asks for is measured on every call, not discovered at export', () => {
  const src = take('Far')
  D.direct(src, { brief: { device: 'Yolk-ProMax', seconds: 28, size: 'app-preview-6.9' } }, { now: NOW })
  const s = D.forEdit(src, { seconds: 202.3 })
  assert.strictEqual(s.distance.ok, false)
  assert.ok(s.distance.line.startsWith('202.3 s against 28 asked, 174.3 s over'))
  assert.strictEqual(s.plan.next.call.tool, 'simulator')
})

fs.rmSync(dir, { recursive: true, force: true })
console.log(`\n${n} director tests passed`)
