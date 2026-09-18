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
// that is tenth in line should not wait for the nine ahead of it.

const LANES = {
  heavy: { limit: 1, active: 0, waiting: [] },
  light: { limit: 2, active: 0, waiting: [] },
}

// Anything that re-encodes video belongs in the slow lane.
const LIGHT_OPS = new Set(['thumb', 'waveform', 'filmstrip'])
const laneFor = op => (LIGHT_OPS.has(op) ? LANES.light : LANES.heavy)

const cancelled = new Set()      // ids cancelled while still queued

function pump(lane) {
  while (lane.active < lane.limit && lane.waiting.length) {
    const item = lane.waiting.shift()
    if (cancelled.has(item.id)) {
      cancelled.delete(item.id)
      item.reject(Object.assign(new Error('cancelled'), { cancelled: true }))
      continue
    }
    lane.active++
    item.onStart()
    Promise.resolve()
      .then(item.run)
      .then(item.resolve, item.reject)
      .finally(() => { lane.active--; pump(lane) })
  }
}

// run() is only called once the lane has room. onStart fires at that moment, not at
// submit, so a caller can tell "queued" from "running" honestly.
function submit({ id, op, run, onStart = () => {} }) {
  const lane = laneFor(op)
  return new Promise((resolve, reject) => {
    lane.waiting.push({ id, run, onStart, resolve, reject })
    pump(lane)
  })
}

// Returns true if the job was still queued and got dropped. A job already running is
// not this module's business: the caller cancels that through processor.cancel(id),
// which kills the actual child processes.
function dropIfQueued(id) {
  for (const lane of Object.values(LANES)) {
    const i = lane.waiting.findIndex(w => w.id === id)
    if (i >= 0) {
      cancelled.add(id)
      return true
    }
  }
  return false
}

function stats() {
  return {
    heavy: { active: LANES.heavy.active, queued: LANES.heavy.waiting.length },
    light: { active: LANES.light.active, queued: LANES.light.waiting.length },
  }
}

module.exports = { submit, dropIfQueued, stats }
