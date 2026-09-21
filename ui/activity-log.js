// What happened on this machine, and who did it. Main-process module.
//
// An agent that records your screen has to be accountable, and until now nothing
// recorded what one did. A take showed its border and its mascot while it ran and
// then left no trace; `transcribe` and `probe` over the socket were invisible even
// while they happened, because they bypass the job queue entirely.
//
// The log is append-only JSONL rather than a JSON array so a crash mid-write costs
// one line instead of the file, and so appending never rewrites what came before.
//
// Human actions are recorded too, and that is the point rather than an oversight: a
// log that only contains agent activity cannot tell you whether the cut you are
// looking at was yours. An entry with no `by` was done by a person.

const fs = require('fs')
const path = require('path')

let app
try { ({ app } = require('electron')) } catch {}

const MAX_LINES = 2000          // a few weeks of ordinary use, trimmed on write
const listeners = new Set()
let trimCounter = 0
// While the sample library is open (ui/sample.js), every row is marked as the sample's,
// and leaving takes those rows out again, so trying Fetch leaves no trace in the log of
// what was done to the person's own work. Set by main.js 'sample-root'.
let inSample = false

function logPath() {
  const dir = app ? app.getPath('userData') : require('os').tmpdir()
  try { fs.mkdirSync(dir, { recursive: true }) } catch {}
  return path.join(dir, 'activity.jsonl')
}

/**
 * @param {object} e
 *   @param {string} e.op      machine name, e.g. 'record.start'
 *   @param {string} e.title   one human line, e.g. 'Recorded Simulator · iPhone 17 Pro'
 *   @param {string} [e.detail] the precise result, shown smaller beneath
 *   @param {string} [e.by]    the agent, e.g. 'Claude Code'. Absent means a person.
 *   @param {number} [e.ms]    how long it took
 *   @param {boolean} [e.ok]
 *   @param {string} [e.error]
 */
function record(e) {
  const entry = {
    at: Date.now(),
    op: e.op,
    title: e.title || e.op,
    detail: e.detail || null,
    by: e.by || null,
    ms: e.ms != null ? Math.round(e.ms) : null,
    ok: e.ok !== false,
    error: e.error || null,
    ...(inSample ? { sample: true } : {}),
  }
  try {
    fs.appendFileSync(logPath(), JSON.stringify(entry) + '\n')
    // Trimming on every append would rewrite the file constantly, which is the one
    // thing append-only was chosen to avoid.
    if (++trimCounter % 200 === 0) trim()
  } catch (err) {
    console.error('activity not recorded:', err.message)
  }
  for (const fn of listeners) { try { fn(entry) } catch {} }
  return entry
}

// Newest first, because that is the only order anyone reads this in.
function read(limit = 300) {
  let text = ''
  try { text = fs.readFileSync(logPath(), 'utf8') } catch { return [] }
  const out = []
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const l = lines[i].trim()
    if (!l) continue
    try { out.push(JSON.parse(l)) } catch {}   // a torn line is skipped, not fatal
  }
  return out
}

function trim() {
  try {
    const lines = fs.readFileSync(logPath(), 'utf8').split('\n').filter(Boolean)
    if (lines.length <= MAX_LINES) return
    fs.writeFileSync(logPath(), lines.slice(-MAX_LINES).join('\n') + '\n')
  } catch {}
}

// The sample opened or closed. Closing drops its rows, and leaves the file as it was
// byte for byte when there were none.
function sampleOpen(on) {
  inSample = !!on
  if (on) return 0
  try {
    const text = fs.readFileSync(logPath(), 'utf8')
    const lines = text.split('\n').filter(Boolean)
    const keep = lines.filter(l => { try { return !JSON.parse(l).sample } catch { return true } })
    if (keep.length === lines.length) return 0
    fs.writeFileSync(logPath(), keep.length ? keep.join('\n') + '\n' : '')
    return lines.length - keep.length
  } catch { return 0 }
}

function clear() {
  try { fs.unlinkSync(logPath()) } catch {}
}

// Live updates, so an open Activity view fills in as work happens rather than only
// on reopen.
function subscribe(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

module.exports = { record, read, trim, clear, subscribe, logPath, sampleOpen, MAX_LINES }
