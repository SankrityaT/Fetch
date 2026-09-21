// Version history: every edit kept with who made it, any version opened, and a
// restore that is a new version rather than a rewind.
//   node test/history.test.js
const assert = require('assert')
const H = require('../ui/history')

let n = 0
const queue = []
const t = (name, fn) => queue.push([name, fn])

const doc = (o = {}) => ({
  v: 2, src: '/m/Demo/Original/Demo.mov', dur: 30,
  clips: [{ id: 'C1', start: 0, end: 30 }], zooms: [], marks: [], texts: [], cues: [], beats: [],
  pointer: null, look: { background: { kind: 'gradient', gradient: 'dusk' }, frame: { aspect: 'auto' } },
  audio: { denoise: false, loudnorm: true, gain: 0, music: null, speedAudio: 'mute' },
  crop: null, cropAR: 'free', viewport: null, device: null, camera: null, audioTrack: null,
  autoZoom: false, nextId: { C: 2, Z: 1, T: 1, S: 1, B: 1, M: 1 }, ...o,
})
const zoom = (id, start, scale = 2) => ({ id, start, end: start + 2, scale, x: 0.5, y: 0.5 })

// a sidecar in a string, and a clock the test moves
function memIO() {
  const io = { text: '', appends: 0, replaces: 0 }
  io.read = () => io.text
  io.append = s => { io.text += s; io.appends++ }
  io.replace = s => { io.text = s; io.replaces++ }
  return io
}
function rig(opts = {}) {
  const io = memIO()
  const clock = { t: Date.UTC(2026, 8, 21, 12) }
  const log = H.createLog({ io, now: () => clock.t, ...opts })
  return { io, clock, log }
}

t('the first open records the edit as history first saw it', () => {
  const { log } = rig()
  const r = log.open(doc())
  assert.strictEqual(r.id, 'V1')
  assert.strictEqual(r.how, 'start')
  assert.strictEqual(log.open(doc()), null, 'reopening the same edit adds nothing')
})

t('a person\'s edits settle into one version after a quiet spell', () => {
  const { log, clock } = rig()
  log.open(doc())
  for (let i = 0; i < 12; i++) { log.person(doc({ zooms: [zoom('Z1', 4 + i * 0.1)] })); clock.t += 400 }
  assert.strictEqual(log.tick(), null, 'still moving, nothing recorded yet')
  clock.t += H.GAP_MS
  const r = log.tick()
  assert.ok(r && r.id === 'V2')
  assert.strictEqual(r.by, null, 'no name means the person, as in the activity log')
  assert.ok(/added Z1/i.test(r.line), r.line)
  assert.strictEqual(log.size(), 2)
})

t('an agent\'s change is attributed to it and says what changed by id', () => {
  const { log } = rig()
  const a = doc({ zooms: [zoom('Z1', 4)] })
  log.open(a)
  const b = doc({ zooms: [zoom('Z1', 4, 2.5), zoom('Z2', 9)], nextId: { C: 2, Z: 3, T: 1, S: 1, B: 1, M: 1 } })
  const { mine, theirs } = log.agent(a, b, 'Claude Code')
  assert.strictEqual(mine, null)
  assert.strictEqual(theirs.by, 'Claude Code')
  assert.deepStrictEqual(theirs.touched.zooms, { added: ['Z2'], changed: ['Z1'], removed: [] })
  assert.ok(/added Z2; changed Z1/i.test(theirs.line), theirs.line)
})

t('person and agent at once: the person\'s pending edit is closed as theirs first', () => {
  const { log, clock } = rig()
  log.open(doc())
  const mineDoc = doc({ texts: [{ id: 'T1', start: 0, end: 3, text: 'Hello' }] })
  log.person(mineDoc)                                  // held open, not yet quiet
  clock.t += 500
  // the agent read the document with the person's title in it, and adds a zoom
  const after = { ...mineDoc, zooms: [zoom('Z1', 5)] }
  const { mine, theirs } = log.agent(mineDoc, after, 'Codex')
  assert.ok(mine && mine.by === null && /added T1/i.test(mine.line), 'the title is the person\'s')
  assert.ok(theirs.by === 'Codex' && /added Z1/i.test(theirs.line) && !/T1/.test(theirs.line), 'the zoom is the agent\'s alone')
  assert.strictEqual(log.pending(), false)
  assert.deepStrictEqual(log.rows().map(r => r.id), ['V3', 'V2', 'V1'])
})

t('a restore is a new version and nothing ahead of it is lost', () => {
  const { log } = rig()
  const v1 = doc()
  log.open(v1)
  const v2 = doc({ zooms: [zoom('Z1', 4)], nextId: { C: 2, Z: 2, T: 1, S: 1, B: 1, M: 1 } })
  log.agent(v1, v2, 'Claude Code')
  const v3 = doc({ zooms: [zoom('Z1', 4), zoom('Z2', 8)], clips: [{ id: 'C1', start: 0, end: 12 }, { id: 'C2', start: 14, end: 30 }],
    nextId: { C: 3, Z: 3, T: 1, S: 1, B: 1, M: 1 } })
  log.agent(v2, v3, 'Claude Code')
  const r = log.restore(2, v3)
  assert.strictEqual(r.row.id, 'V4')
  assert.strictEqual(r.row.how, 'restore')
  assert.strictEqual(r.row.of, 'V2')
  assert.deepStrictEqual(r.doc.zooms, v2.zooms)
  assert.deepStrictEqual(r.doc.clips, v2.clips)
  // ids never go backwards, or Z2 would come to name two zooms
  assert.deepStrictEqual(r.doc.nextId, { C: 3, Z: 3, T: 1, S: 1, B: 1, M: 1 })
  // V3 is still there, whole, and can be restored in turn
  assert.deepStrictEqual(log.version(3).clips, v3.clips)
  const back = log.restore(3, r.doc)
  assert.strictEqual(back.row.id, 'V5')
  assert.deepStrictEqual(back.doc.clips, v3.clips)
  assert.deepStrictEqual(log.rows().map(x => x.id), ['V5', 'V4', 'V3', 'V2', 'V1'])
})

t('restoring what is already on screen writes nothing', () => {
  const { log } = rig()
  log.open(doc())
  const r = log.restore(1, doc())
  assert.strictEqual(r.same, true)
  assert.strictEqual(r.row, null)
  assert.strictEqual(log.size(), 1)
})

t('a restore keeps the take\'s facts from now: a renamed path, a device written since', () => {
  const was = doc({ zooms: [zoom('Z1', 4)] })
  const now = doc({ src: '/m/Renamed/Original/Renamed.mov', device: { name: 'iPhone 17 Pro', screen: { x: 0, y: 0, w: 1, h: 1 } } })
  const { doc: out } = H.forRestore(was, now)
  assert.strictEqual(out.src, '/m/Renamed/Original/Renamed.mov')
  assert.deepStrictEqual(out.device, now.device)
  assert.deepStrictEqual(out.zooms, was.zooms)
})

t('a version pointing at a file since deleted restores everything else and says so', () => {
  const was = doc({
    zooms: [zoom('Z1', 4)],
    camera: { on: true, file: '/m/Demo/Original/.fetch/Demo.cam.mov', corner: 'br' },
    look: { background: { kind: 'image', image: '/Users/x/Pictures/gone.jpg' }, frame: { aspect: 'auto' } },
  })
  const now = doc()
  const gone = new Set(['/m/Demo/Original/.fetch/Demo.cam.mov', '/Users/x/Pictures/gone.jpg'])
  const { log } = rig()
  log.open(was)
  log.person(now); log.flush()
  const r = log.restore(1, now, { exists: f => !gone.has(f) })
  assert.deepStrictEqual(r.doc.zooms, was.zooms, 'the rest of the version comes back')
  assert.strictEqual(r.doc.camera, null, 'the camera stays as it is now rather than pointing nowhere')
  assert.deepStrictEqual(r.doc.look.background, now.look.background)
  assert.deepStrictEqual(r.missing.map(m => m.what).sort(), ['background image', 'camera take'])
  assert.ok(/are gone, so those parts stay as it is now/.test(r.line), r.line)
  // the version itself still holds the path, so if the file comes back so does it
  assert.strictEqual(log.version(1).camera.file, '/m/Demo/Original/.fetch/Demo.cam.mov')
  assert.strictEqual(log.rows()[0].missing.length, 2)
})

t('an agent undo is its own version, by whoever pressed it', () => {
  const { log } = rig()
  const a = doc(), b = doc({ zooms: [zoom('Z1', 4)] })
  log.open(a)
  log.agent(a, b, 'Claude Code')
  const r = log.undo(b, a, null)
  assert.strictEqual(r.how, 'undo')
  assert.strictEqual(r.by, null)
  assert.ok(/removed Z1/i.test(r.line))
})

t('a change made while history was not watching is recorded unattributed', () => {
  const { io, log } = rig()
  log.open(doc())
  const { log: again } = { log: H.createLog({ io, now: () => Date.UTC(2026, 8, 22) }) }
  const r = again.open(doc({ marks: [{ id: 'M1', kind: 'redact', start: 0, end: 3, x: 0.1, y: 0.1, w: 0.2, h: 0.1 }] }))
  assert.strictEqual(r.how, 'outside')
  assert.strictEqual(r.by, null)
  assert.ok(/not watching: added M1/.test(r.line), r.line)
})

t('history survives a reopen and key order is not a change', () => {
  const { io, log } = rig()
  const d = doc({ zooms: [zoom('Z1', 4)] })
  log.open(d)
  const shuffled = Object.fromEntries(Object.entries(d).reverse())
  const again = H.createLog({ io })
  assert.strictEqual(again.open(shuffled), null)
  assert.strictEqual(again.rows().length, 1)
})

t('a torn last line costs that line and no more', () => {
  const { io, log, clock } = rig()
  log.open(doc())
  for (let i = 1; i <= 5; i++) { clock.t += 1000; log.agent(log.head().doc, doc({ zooms: [zoom('Z1', i)] }), 'Codex') }
  io.text = io.text.slice(0, -40)                     // the crash lands mid-write
  const again = H.createLog({ io, now: () => clock.t })
  again.open(doc({ zooms: [zoom('Z1', 5)] }))
  const rows = again.rows()
  assert.strictEqual(rows[0].how, 'outside', 'what the torn line held is found again on open')
  assert.deepStrictEqual(again.version(rows[0].n).zooms, [zoom('Z1', 5)])
  const es = H.parse(io.text)
  assert.strictEqual(es[es.length - 1].n, rows[0].n, 'the torn tail does not swallow the line after it')
  assert.deepStrictEqual(H.materialize(es, rows[0].n).zooms, [zoom('Z1', 5)], 'and it reads back from the file alone')
  assert.deepStrictEqual(again.version(5).zooms, [zoom('Z1', 4)], 'what came before is untouched')
})

t('a delta names its parent, so a missing line is unreadable, never wrong', () => {
  const { io, log } = rig({ keyEvery: 1000 })
  log.open(doc())
  for (let i = 1; i <= 3; i++) log.agent(log.head().doc, doc({ zooms: [zoom('Z1', i)] }), 'Codex')
  const lines = io.text.trim().split('\n')
  lines.splice(2, 1)                                   // V3 is lost
  const es = H.parse(lines.join('\n'))
  assert.strictEqual(H.materialize(es, 4), null)
  assert.deepStrictEqual(H.materialize(es, 2).zooms, [zoom('Z1', 1)])
})

// ── a thousand versions, and the disk ─────────────────────────────────────
// A long take: 300 caption lines and a 2,000 point cursor track, the heavy fields
// that almost never change between versions.
const heavy = () => doc({
  dur: 600,
  cues: Array.from({ length: 300 }, (_, i) => ({ start: i * 2, end: i * 2 + 1.8, text: `Line ${i} of what was said over the take, at about this length.` })),
  pointer: Array.from({ length: 2000 }, (_, i) => ({ t: +(i * 0.3).toFixed(2), x: +(Math.sin(i) * 0.4 + 0.5).toFixed(4), y: +(Math.cos(i) * 0.4 + 0.5).toFixed(4) })),
})

t('a thousand versions of one take stay small and any one opens fast', () => {
  const { io, log, clock } = rig({ compactEvery: 1e9 })
  let d = heavy()
  log.open(d)
  const whole = JSON.stringify(d).length
  for (let i = 1; i < 1000; i++) {
    clock.t += 30000
    const next = { ...d, zooms: [zoom('Z1', 4 + (i % 50) * 0.1, 1.5 + (i % 7) * 0.1)], nextId: { ...d.nextId, Z: 2 } }
    if (i % 100 === 0) next.cues = d.cues.map((c, j) => j === i / 100 ? { ...c, text: c.text + ' (fixed)' } : c)
    if (i % 2) log.agent(d, next, 'Claude Code'); else { log.person(next); log.flush() }
    d = next
  }
  const bytes = io.text.length
  assert.strictEqual(log.size(), 1000)
  // a copy per version would be a thousand documents
  assert.ok(bytes < whole * 40, `history ${bytes} bytes for a ${whole} byte document`)
  const t0 = process.hrtime.bigint()
  const v = log.version(537)
  const ms = Number(process.hrtime.bigint() - t0) / 1e6
  assert.ok(v && v.zooms[0].start === 4 + (536 % 50) * 0.1, 'V537 is the 536th change')
  assert.ok(ms < 100, `opening V537 took ${ms} ms`)
  const t1 = process.hrtime.bigint()
  const again = H.createLog({ io, now: () => clock.t })
  again.open(d)
  const openMs = Number(process.hrtime.bigint() - t1) / 1e6
  assert.ok(openMs < 1000, `reading the history took ${openMs} ms`)
  console.log(`   1000 versions of a ${(whole / 1024).toFixed(0)} KB edit: ${(bytes / 1024).toFixed(0)} KB on disk, ` +
    `${(bytes / whole).toFixed(1)} documents' worth; V537 opens in ${ms.toFixed(1)} ms, the file reads in ${openMs.toFixed(0)} ms`)
})

t('thinning: a week kept whole, then one a day, then one a week, pinned versions whatever their age', () => {
  const day = 864e5, now = Date.UTC(2026, 8, 21, 12)
  const es = []
  let k = 0
  // six versions a day for 200 days, alternating person and agent in the last one of each day
  for (let dd = 200; dd >= 0; dd--) {
    for (let j = 0; j < 6; j++) es.push({ n: ++k, at: now - dd * day + j * 3600e3, by: null, how: 'edit' })
  }
  es[500].how = 'restore'
  const keep = H.plan(es, now)
  assert.ok(keep.has(1), 'the first version is kept for ever')
  assert.ok(keep.has(k), 'the head is kept')
  assert.ok(keep.has(501), 'a restore is kept whatever its age')
  const recent = es.filter(e => now - e.at <= 7 * day)
  assert.ok(recent.every(e => keep.has(e.n)), 'everything from the last week')
  const mid = es.filter(e => now - e.at > 7 * day && now - e.at <= 90 * day && e.how === 'edit' && e.n !== 1)
  const days = new Set(mid.filter(e => keep.has(e.n)).map(e => Math.floor(e.at / day)))
  assert.strictEqual(mid.filter(e => keep.has(e.n)).length, days.size, 'one a day between a week and three months')
  const old = es.filter(e => now - e.at > 90 * day && e.n !== 1 && e.how === 'edit')
  const oldKept = old.filter(e => keep.has(e.n))
  assert.ok(oldKept.length <= Math.ceil(110 / 7) + 1 && oldKept.length >= 14, `about one a week before that, kept ${oldKept.length}`)
})

t('the state just before an agent changed it is pinned', () => {
  const day = 864e5, now = Date.UTC(2026, 8, 21)
  const es = [
    { n: 1, at: now - 40 * day, by: null, how: 'start' },
    { n: 2, at: now - 30 * day, by: null, how: 'edit' },
    { n: 3, at: now - 30 * day + 1000, by: 'Codex', how: 'edit' },
    { n: 4, at: now - 30 * day + 2000, by: null, how: 'edit' },
  ]
  const keep = H.plan(es, now)
  assert.ok(keep.has(2), 'before the agent')
  assert.ok(!keep.has(3) || keep.has(4))
})

t('over the cap, one author\'s bursts collapse first and the survivors say who else was folded in', () => {
  const { io, log, clock } = rig({ policy: { cap: 60 }, compactEvery: 1e9 })
  let d = doc()
  log.open(d)
  // an agent nudging a zoom eighty times in a burst, then the person's one change
  for (let i = 1; i <= 80; i++) {
    clock.t += 2000
    const next = { ...d, zooms: [zoom('Z1', 4, 1.5 + i / 100)] }
    log.agent(d, next, 'Claude Code'); d = next
  }
  clock.t += 600000
  const mine = { ...d, texts: [{ id: 'T1', start: 0, end: 2, text: 'Hi' }] }
  log.person(mine); log.flush()
  assert.strictEqual(log.size(), 82)
  assert.ok(log.tidy())
  assert.ok(log.size() <= 60, `kept ${log.size()}`)
  const rows = log.rows()
  assert.strictEqual(rows[0].by, null, 'the person\'s version survives')
  assert.ok(rows.some(r => r.merged > 0), 'a survivor says how many it stands for')
  // every kept version still opens to exactly what it was
  const all = H.parse(io.text)
  for (const r of rows) assert.ok(H.materialize(all, r.n), `${r.id} opens`)
  assert.deepStrictEqual(log.version(rows[0].n).texts, mine.texts)
  assert.strictEqual(log.version(1).zooms.length, 0, 'V1 kept')
})

t('thinning rewrites a line against its new parent and it still opens exactly', () => {
  const { io, log, clock } = rig({ compactEvery: 1e9 })
  let d = doc()
  log.open(d)
  const states = [d]
  for (let i = 1; i <= 30; i++) {
    clock.t += 3600e3
    const next = { ...d, zooms: [...d.zooms, zoom('Z' + i, i)] }
    log.agent(d, next, i % 2 ? 'Codex' : 'Claude Code'); d = next; states.push(d)
  }
  clock.t += 30 * 864e5                         // a month later everything is past the week
  log.tidy()
  const es = H.parse(io.text)
  for (const e of es) assert.deepStrictEqual(H.materialize(es, e.n).zooms, states[e.n - 1].zooms, `V${e.n}`)
  assert.ok(es.length < 31)
  const folded = log.rows().find(r => r.merged)
  assert.ok(folded && /added/i.test(folded.line), 'said again against the version it now follows')
})

t('describe names every kind of change, and never calls a real one none', () => {
  const a = doc(), b = doc({
    look: { ...a.look, frame: { aspect: '16:9' } }, crop: { x: 0, y: 0, w: 0.5, h: 0.5 },
    audio: { ...a.audio, denoise: true }, cues: [{ start: 0, end: 1, text: 'hi' }], somethingNew: 1,
  })
  const { line, touched } = H.describe(a, b)
  assert.ok(/look: frame/.test(line) && /the crop/.test(line) && /the sound/.test(line) && /edited a caption/i.test(line) && /somethingNew/.test(line), line)
  assert.deepStrictEqual(touched.look, ['frame'])
  assert.strictEqual(H.describe(a, a).line, 'No visible change')
  assert.ok(!/\u2014/.test(line), 'no em dashes')
})

t('a shot keeps its history the same way', () => {
  const shot = o => ({ v: 1, kind: 'shot', id: 'S1', src: '/m/Shot.png', w: 1200, h: 800, look: {}, marks: [], crop: null, cropAR: 'free', ...o })
  const { log } = rig()
  log.open(shot())
  log.agent(shot(), shot({ marks: [{ id: 'M1', kind: 'arrow', x: 0.2, y: 0.2 }] }), 'Claude Code')
  const r = log.restore(1, shot({ marks: [{ id: 'M1', kind: 'arrow', x: 0.2, y: 0.2 }], w: 1210 }))
  assert.deepStrictEqual(r.doc.marks, [])
  assert.strictEqual(r.doc.w, 1210, 'the capture\'s size is a fact from now')
})

t('the sidecar path sits beside the take\'s other sidecars', () => {
  assert.strictEqual(H.historyPath('/m/Demo/Original/Demo.mov'), '/m/Demo/Original/.fetch/Demo.history.jsonl')
})

// ── the wiring in ui/autosave.js, run against a stand-in editor ──────────────
// No Electron and no DOM: the editor's globals are faked just far enough for the three
// ways an edit changes (hand, agent, undo) and a restore to pass through the real file.
t('a field that appears as null is written, so a reopen sees no phantom change', () => {
  // Crop Reset on a never-cropped take: crop goes from absent to null
  const { io, log, clock } = rig()
  const before = doc(); delete before.crop
  log.open(before)
  clock.t += 1000
  log.person({ ...before, crop: null, zooms: [zoom('Z1', 4)] }); log.flush()
  const again = H.createLog({ io, now: () => clock.t })
  assert.strictEqual(again.open({ ...before, crop: null, zooms: [zoom('Z1', 4)] }), null, 'a phantom "outside" version on every open')
  assert.strictEqual(again.open({ ...before, crop: null, zooms: [zoom('Z1', 4)] }), null)
})

t('the byte bound is measured line by line and never thins inside the week past the bursts', () => {
  const now = Date.UTC(2026, 8, 21, 12)
  // 600 versions of a caption-heavy edit in the last hours, one every 7 minutes, so no
  // two are one burst. Scaled by count, the old estimate kept 3 of 601.
  const big = 'x'.repeat(30000)
  const es = []
  for (let i = 1; i <= 600; i++) es.push({ n: i, at: now - (600 - i) * 7 * 60000, by: null, how: 'edit', set: { cues: big } })
  const bytes = es.reduce((a, e) => a + JSON.stringify(e).length + 1, 0)
  assert.ok(bytes > 16 * 1024 * 1024)
  const keep = H.plan(es, now, {}, bytes)
  assert.strictEqual(keep.size, 600, `kept ${keep.size} of this week's 600`)
  // older than a week, the bound thins oldest first and stops once it holds
  const day = 864e5
  const old = []
  for (let i = 1; i <= 40; i++) old.push({ n: i, at: now - (48 - i) * day, by: null, how: 'edit', set: { cues: 'y'.repeat(1000) } })
  const total = old.reduce((a, e) => a + JSON.stringify(e).length + 1, 0)
  const line = JSON.stringify(old[1]).length + 1
  const kept = H.plan(old, now, { maxBytes: total - 5 * line }, total)
  assert.ok(kept.size >= 34 && kept.size <= 35, `five or so lines over the bound, kept ${kept.size} of 40`)
  assert.ok(kept.has(40) && kept.has(1), 'first and newest')
})

t('pins age like everything else and give way to the cap', () => {
  const day = 864e5, now = Date.UTC(2026, 8, 21, 12)
  // 61 versions a month ago, person and agent alternating, one every ten minutes: before
  // this every one of the person's was pinned and all 61 stayed for ever
  const es = []
  for (let i = 1; i <= 61; i++) es.push({ n: i, at: now - 30 * day + i * 600e3, by: i % 2 ? null : 'Claude Code', how: 'edit' })
  const keep = H.plan(es, now)
  assert.ok(keep.size <= 4, `a month-old day of pre-agent versions kept ${keep.size}`)
  assert.ok(keep.has(59), 'the last pre-agent state of that day is kept')
  // inside the week, a cap smaller than the pins thins them oldest first, never V1 or the head
  const fresh = []
  for (let i = 1; i <= 61; i++) fresh.push({ n: i, at: now - 61 * 3600e3 + i * 3600e3, by: i % 2 ? null : 'Codex', how: 'edit' })
  const capped = H.plan(fresh, now, { cap: 10 })
  assert.ok(capped.size <= 10, `the cap held ${capped.size}`)
  assert.ok(capped.has(1) && capped.has(61))
  assert.ok(capped.has(59) && !capped.has(3), 'the oldest pins went first')
})

t('a line that never reached the disk is not a version, and the next one is whole', () => {
  const { io, log, clock } = rig()
  log.open(doc())
  let fail = false
  const append = io.append
  io.append = s => (fail ? false : append(s))
  for (let i = 1; i <= 9; i++) {
    fail = i === 6
    clock.t += 1000
    log.agent(log.head().doc, doc({ zooms: [zoom('Z1', 4, 1 + i / 10)] }), 'Codex')
  }
  const again = H.createLog({ io, now: () => clock.t })
  again.open(null)
  const all = H.parse(io.text)
  for (const e of all) assert.ok(H.materialize(all, e.n), `V${e.n} reads back after a lost write`)
  assert.strictEqual(again.head().doc.zooms[0].scale, 1.9, 'the newest version is the edit')
})

t('a restore knows a file rewritten in place, and follows one moved by a rename', () => {
  const files = new Map([['/m/Demo/Original/.fetch/Demo.vo.mp3', { size: 100, mtime: 1000 }]])
  const exists = f => files.has(f)
  const stat = f => files.get(f)
  const withVo = doc({ audioTrack: { file: '/m/Demo/Original/.fetch/Demo.vo.mp3', gain: 0 } })
  const ids = H.identities(withVo, stat)
  // voiceover rewrote the one .vo.mp3
  files.set('/m/Demo/Original/.fetch/Demo.vo.mp3', { size: 180, mtime: 2000 })
  const r = H.forRestore(withVo, doc({ audioTrack: { file: '/m/Demo/Original/.fetch/Demo.vo.mp3', gain: 0 } }), exists, { files: ids, stat })
  assert.deepStrictEqual(r.missing.map(m => [m.field, !!m.changed]), [['audioTrack', true]])
  assert.match(H.missingLine(r.missing), /not the same file any more/)
  // the take renamed since: the same track under the new folder and name is found
  files.clear(); files.set('/m/Launch/Original/.fetch/Launch.vo.mp3', { size: 100, mtime: 1000 })
  const now = doc({ src: '/m/Launch/Original/Launch.mov', audioTrack: null })
  const moved = H.forRestore(withVo, now, exists, { files: ids, stat })
  assert.deepStrictEqual(moved.missing, [], 'reported gone although it is there')
  assert.strictEqual(moved.doc.audioTrack.file, '/m/Launch/Original/.fetch/Launch.vo.mp3')
})

t('autosave records hand, agent and undo, and a restore writes a new version', () => {
  const fs = require('fs'), os = require('os'), path = require('path'), vm = require('vm')
  const root = path.join(__dirname, '..')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-history-'))
  const src = path.join(tmp, 'Demo', 'Original', 'Demo.mov')
  fs.mkdirSync(path.dirname(src), { recursive: true }); fs.writeFileSync(src, '')
  const timers = []
  const listeners = {}
  const clock = { t: Date.UTC(2026, 8, 21, 12) }
  class FakeDate extends Date { static now() { return clock.t } }
  let current = doc({ src })
  // holds an agent's apply at its await, the way write-cues does
  const busyGate = { hold: false }
  busyGate.wait = new Promise(r => { busyGate.open = () => { busyGate.hold = false; r() } })
  const ed = { src: null, docReady: false, shot: false }
  const window = {
    addEventListener: (k, fn) => { (listeners[k] = listeners[k] || []).push(fn) },
    dispatchEvent: e => (listeners[e.type] || []).forEach(fn => fn(e)),
  }
  window.fetchDoc = {
    get: () => JSON.parse(JSON.stringify(current)),
    load: d => { current = JSON.parse(JSON.stringify(d)) },
    apply: async patch => {
      if (busyGate.hold) await busyGate.wait
      current = { ...current, ...patch }; return JSON.parse(JSON.stringify(current))
    },
  }
  window.editorFollowRename = () => {}
  window.fetchUndo = { undo: async () => { current = { ...current, zooms: [] }; return true }, mark: () => {} }
  window.openInEditor = async s => { ed.src = s; ed.docReady = true }
  const sandbox = {
    window, ed, document: { querySelector: () => null }, console, Date: FakeDate,
    setInterval: fn => { timers.push(fn); return timers.length }, setTimeout: () => 0,
    require: name => name === 'os' ? { ...os, homedir: () => tmp }
      : name.startsWith('./ui/') ? require(path.join(root, name)) : require(name),
  }
  vm.runInNewContext(fs.readFileSync(path.join(root, 'ui/autosave.js'), 'utf8'), sandbox)
  const tickAll = () => timers.forEach(fn => fn())
  return (async () => {
    await window.openInEditor(src)
    const H2 = window.fetchHistory
    assert.deepStrictEqual(H2.rows().map(r => r.id), ['V1'])
    // the person adds a title by hand; it settles after the quiet spell
    current = { ...current, texts: [{ id: 'T1', start: 0, end: 2, text: 'Hi' }] }
    tickAll(); clock.t += H.GAP_MS + 1; tickAll()
    // an agent adds a zoom, naming itself
    await window.fetchDoc.apply({ zooms: [zoom('Z1', 4)] }, { by: 'Claude Code' })
    // revert_my_edit, which passes the path alone
    await window.fetchUndo.undo(src)
    const rows = H2.rows()
    assert.deepStrictEqual(rows.map(r => [r.id, r.by, r.how]),
      [['V4', 'Agent', 'undo'], ['V3', 'Claude Code', 'edit'], ['V2', null, 'edit'], ['V1', null, 'start']])
    const r = await H2.restore(3)
    assert.strictEqual(r.row.id, 'V5')
    assert.deepStrictEqual(current.zooms, [zoom('Z1', 4)], 'the editor holds the restored version')
    assert.ok(fs.existsSync(H.historyPath(src)), 'written beside the take')
    assert.strictEqual(H.parse(fs.readFileSync(H.historyPath(src), 'utf8')).length, 5)
    // looking needs the editor to hold its autosave; until it says so, a peek refuses
    assert.strictEqual(H2.peek(1).ok, false)
    H2.editorHonoursPeek = true
    assert.strictEqual(H2.peek(1).ok, true)
    assert.deepStrictEqual(current.texts, [], 'V1 on the stage')
    // an agent edit while looking lands on now, never on the old version
    await window.fetchDoc.apply({ marks: [{ id: 'M1', kind: 'arrow', start: 1, end: 2, x: 0.5, y: 0.5 }] }, { by: 'Codex' })
    assert.strictEqual(H2.peeking(), false)
    assert.deepStrictEqual(current.zooms, [zoom('Z1', 4)])
    assert.strictEqual(H2.rows()[0].by, 'Codex')

    // Looking: anything that reads the edit reads now, not the version on the stage
    assert.strictEqual(H2.peek(1).ok, true)
    assert.deepStrictEqual(current.texts, [], 'V1 on the stage')
    assert.strictEqual(JSON.stringify(H2.current().texts), JSON.stringify([{ id: 'T1', start: 0, end: 2, text: 'Hi' }]), 'current() is the edit held aside')
    H2.back()
    assert.strictEqual(H2.current(), null, 'and nothing once back')

    // An agent's apply mid-await: a look or a restore now would land inside its change
    const rowsBefore = H2.rows().length
    busyGate.hold = true
    const agentGo = window.fetchDoc.apply({ zooms: [zoom('Z3', 9)] }, { by: 'Claude Code' })
    await new Promise(r => setImmediate(r))
    assert.strictEqual(await H2.restore(2), null, 'a restore during an agent\'s apply')
    assert.strictEqual(H2.peek(2).ok, false, 'a look during an agent\'s apply')
    busyGate.open()
    await agentGo
    assert.strictEqual(H2.rows().length, rowsBefore + 1)
    assert.strictEqual(H2.rows()[0].by, 'Claude Code')
    assert.deepStrictEqual(current.zooms, [zoom('Z3', 9)], 'the agent\'s change stands')

    // The take's folder moved and the file was renamed, with the history left behind
    // under the old name: it is found, carried, and the next line is written whole
    const next = path.join(tmp, 'Launch', 'Original', 'Launch.mov')
    fs.renameSync(path.join(tmp, 'Demo'), path.join(tmp, 'Launch'))
    fs.renameSync(path.join(tmp, 'Launch', 'Original', 'Demo.mov'), next)
    current = { ...current, src: next }
    ed.src = next
    window.editorFollowRename([[src, next]])
    assert.ok(fs.existsSync(H.historyPath(next)), 'the history is at the new name')
    const had = H.parse(fs.readFileSync(H.historyPath(next), 'utf8')).length
    await window.fetchDoc.apply({ zooms: [] }, { by: 'Codex' })
    const moved = H.parse(fs.readFileSync(H.historyPath(next), 'utf8'))
    for (const e of moved) assert.ok(H.materialize(moved, e.n), `V${e.n} reads back after the rename`)
    assert.ok(moved.length > had && moved[had].doc, 'the first line after a rename stands on its own')
    fs.rmSync(tmp, { recursive: true, force: true })
  })()
})

;(async () => {
  for (const [name, fn] of queue) { await fn(); n++; console.log('ok', name) }
  console.log(`\n${n} history checks passed`)
})().catch(e => { console.error(e); process.exit(1) })
