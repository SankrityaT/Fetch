// Work queue for ffmpeg jobs. Main-process module, required from main.js.
//
// Nothing used to limit these. A person clicking buttons serialises themselves, so it
// never showed. An agent does not: an MCP client can fire ten exports in a second,
// and every one of them is an ffmpeg that threads across all cores by default. That
// is how you flatten a laptop.
//
// Two lanes, because one queue starves the wrong things. Exports and conversions are
// minutes long and run one at a time. Thumbnails, waveforms and filmstrips are the
// small jobs the UI needs to feel alive, and they must not sit behind a five minute
// export, so they get their own shallow lane.
//
// Queued work is cancellable before it ever starts, which matters: cancelling a job
// that is tenth in line should not wait for the nine ahead of it. It used to: a drop
// only marked the id, and the job said it was cancelled when the lane got round to it,
// which on a loaded machine is after nine exports. It leaves the lane and answers now.
//
// Running work is cancellable here too, by the queue's own id. That is what an agent's
// export needed: main.js hands the queue one id and the renderer another, made a
// millisecond later, and kept neither, so nothing could ever name the running export to
// stop it. Now the work says how it is stopped from inside its own run (onCancel, which
// render-host's exports call with their own jobId), and cancel(id) or cancelWhere(match)
// reaches it through the id the queue already holds. The caller hears "cancelled" at
// once. The lane stays taken until the work has really stopped, so the next export does
// not start beside children that are still dying, and is given back after RELEASE_CAP_MS
// if it never does.

const { AsyncLocalStorage } = require('async_hooks')

const LANES = {
  heavy: { limit: 1, active: 0, waiting: [], running: new Set() },
  light: { limit: 2, active: 0, waiting: [], running: new Set() },
}

const RELEASE_CAP_MS = 60 * 1000

// Anything that re-encodes video belongs in the slow lane.
const LIGHT_OPS = new Set(['thumb', 'waveform', 'filmstrip'])
const laneFor = op => (LIGHT_OPS.has(op) ? LANES.light : LANES.heavy)

// The job whose run() this code is inside, however many awaits down
const inJob = new AsyncLocalStorage()

const cancelledError = () => Object.assign(new Error('cancelled'), { cancelled: true })

// One answer per job: the work's own, or "cancelled", whichever comes first
function answer(item, ok, v) {
  if (item.answered) return
  item.answered = true
  if (ok) item.resolve(v)
  else item.reject(v)
}

function pump(lane) {
  while (lane.active < lane.limit && lane.waiting.length) {
    const item = lane.waiting.shift()
    lane.active++
    lane.running.add(item)
    let freed = false
    item.free = () => {
      if (freed) return
      freed = true
      clearTimeout(item.cap)
      lane.running.delete(item)
      lane.active--
      pump(lane)
    }
    item.onStart()
    inJob.run(item, () => Promise.resolve().then(item.run))
      .then(v => answer(item, true, v), e => answer(item, false, e))
      // A run that answered "cancelled" (render-host races its work against the cancel)
      // settles before the work behind it has stopped. The lane waits for the work it
      // was told about (working), or for RELEASE_CAP_MS, whichever comes first.
      .finally(() => item.works.size
        ? Promise.allSettled([...item.works]).then(item.free)
        : item.free())
  }
}

// run() is only called once the lane has room. onStart fires at that moment, not at
// submit, so a caller can tell "queued" from "running" honestly.
function submit({ id, op, run, onStart = () => {} }) {
  const lane = laneFor(op)
  return new Promise((resolve, reject) => {
    lane.waiting.push({ id, run, onStart, resolve, reject, hooks: new Set(), works: new Set(), cancelled: false, answered: false })
    pump(lane)
  })
}

// Returns true if the job was still queued and got dropped. A job already running is
// left alone here: cancel(id) is the one that stops it.
function dropIfQueued(id) {
  for (const lane of Object.values(LANES)) {
    const i = lane.waiting.findIndex(w => w.id === id)
    if (i >= 0) {
      const [item] = lane.waiting.splice(i, 1)
      item.cancelled = true
      answer(item, false, cancelledError())
      return true
    }
  }
  return false
}

// Called from inside a job's run, at any depth: fn is how that job is stopped. A job
// already cancelled is stopped at once. Returns a function that takes fn back, for work
// that has finished and has nothing left to stop. Outside a job it does nothing, since
// there is no queue id anybody could cancel it by.
function onCancel(fn) {
  const item = inJob.getStore()
  if (!item || typeof fn !== 'function') return () => {}
  if (item.cancelled) { try { fn() } catch {} return () => {} }
  item.hooks.add(fn)
  return () => item.hooks.delete(fn)
}

// Called from inside a job's run with the promise of the work itself, where the run
// answers sooner than the work stops. The lane is only given back once that work has
// settled (or at RELEASE_CAP_MS after a cancel), so the next export never starts beside
// children still dying and writing the same partial names. Outside a job it does nothing.
function working(p) {
  const item = inJob.getStore()
  if (!item || !p || typeof p.then !== 'function') return p
  const w = Promise.resolve(p).catch(() => {})
  item.works.add(w)
  w.then(() => item.works.delete(w))
  return p
}

function stopRunning(item) {
  if (!item.cancelled) {
    item.cancelled = true
    for (const fn of item.hooks) { try { fn() } catch (e) { console.warn('[queue] a cancel hook failed:', e && e.message) } }
    item.hooks.clear()
    // a cancel that nothing inside could act on still frees the lane, just not at once
    item.cap = setTimeout(() => item.free && item.free(), RELEASE_CAP_MS)
    if (item.cap.unref) item.cap.unref()
  }
  answer(item, false, cancelledError())
}

// Cancel one job by the id it was submitted with, queued or running. True if the queue
// held it. A running job answers "cancelled" now; its work is stopped through what it
// gave onCancel.
function cancel(id) {
  if (dropIfQueued(id)) return true
  for (const lane of Object.values(LANES)) {
    for (const item of lane.running) {
      if (item.id === id) { stopRunning(item); return true }
    }
  }
  return false
}

// Cancel every job whose id matches, queued ones first so none of them starts in the
// room a running one leaves. Returns the ids it cancelled. This is the brake's: every
// job an agent started has an id that begins with agent: (main.js).
function cancelWhere(match) {
  const hit = []
  for (const lane of Object.values(LANES)) {
    for (const item of [...lane.waiting]) if (match(item.id)) { dropIfQueued(item.id); hit.push(item.id) }
  }
  for (const lane of Object.values(LANES)) {
    for (const item of [...lane.running]) if (!item.cancelled && match(item.id)) { stopRunning(item); hit.push(item.id) }
  }
  return hit
}

function stats() {
  return {
    heavy: { active: LANES.heavy.active, queued: LANES.heavy.waiting.length },
    light: { active: LANES.light.active, queued: LANES.light.waiting.length },
  }
}

// The ids in the queue now: what is waiting, and what holds a lane (a cancelled job
// holds its lane until its work has stopped, and is listed as stopping)
function jobs() {
  const all = Object.values(LANES)
  return {
    queued: all.flatMap(l => l.waiting.map(w => w.id)),
    running: all.flatMap(l => [...l.running].filter(i => !i.cancelled).map(i => i.id)),
    stopping: all.flatMap(l => [...l.running].filter(i => i.cancelled).map(i => i.id)),
  }
}

module.exports = { submit, dropIfQueued, cancel, cancelWhere, onCancel, working, stats, jobs, RELEASE_CAP_MS }
