// The brief and the plan for one take: what the person asked for, the structure the
// agent decided on, what is done, what is left.
//
// It lives in its own sidecar, `.fetch/<stem>.job.json`, and deliberately not in the
// edit document. The job is about the work, not about the edit: it has to survive the
// undo of the edit it produced, closing a step must not become an undo level or dirty
// the autosave, and a crash or a context limit mid-turn must not lose what was decided.
// That is what makes a turn resumable.
//
// Pure apart from the four functions at the bottom that touch the disk, so
// test/director.test.js runs the whole thing under plain node with no Electron and no
// codec. It measures two things only, length and shape, because those are what the
// brief states; everything else the edit should be judged on is ui/review.js.

const fs = require('fs')
const path = require('path')

// The same hidden folder every other sidecar uses (processor.js SIDE_DIR), so a take's
// machinery stays in one place and the save folder only holds what the person made.
const SIDE_DIR = '.fetch'
const EXT = '.job.json'

const V = 1
const STATES = ['todo', 'done', 'dropped']
// A call an agent can make without reading anything else: its tool and the arguments
// the brief already answered. More than a handful of arguments is a tool call the
// director is guessing at rather than one the brief decided.
const MAX_ARGS = 8
// A plan of forty steps is a transcript, not a plan, and the agent has to be able to
// read the whole thing back on every call without it costing a page.
const MAX_STEPS = 12
const MAX_NOTES = 20
const MAX_TEXT = 200
const MAX_SECONDS = 3600

const num = v => (typeof v === 'number' ? v : parseFloat(v))
const arr = v => (Array.isArray(v) ? v : [])
const round1 = n => Math.round(n * 10) / 10

function text(v, max = MAX_TEXT) {
  if (v === null || v === undefined) return null
  const s = String(v).replace(/\s+/g, ' ').trim()
  return s ? s.slice(0, max) : null
}

// A list an agent may send as an array or as one comma separated line, because both
// forms turn up and refusing one of them buys nothing.
function list(v) {
  const raw = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : v == null ? [] : [v]
  const out = []
  for (const item of raw) {
    const s = text(item, 120)
    if (s && !out.includes(s)) out.push(s)
  }
  return out.slice(0, 12)
}

// '16:9', '16/9', '16x9' or 1.7778 to a number. 'auto' and empty mean the brief does
// not ask for a shape, which is different from asking for the wrong one. Nothing wider
// than 5:1 or taller than 1:5 is a shape anyone frames a video in, so a stray number
// reads as no demand rather than as a demand the edit can never meet.
const RATIO_MIN = 0.2, RATIO_MAX = 5
function ratio(v) {
  if (v === null || v === undefined || v === '' || v === 'auto' || v === 'source') return null
  const m = typeof v === 'number' ? null : String(v).trim().match(/^(\d+(?:\.\d+)?)\s*[:/x]\s*(\d+(?:\.\d+)?)$/i)
  const n = m ? +m[1] / +m[2] : typeof v === 'number' ? v : parseFloat(v)
  return n >= RATIO_MIN && n <= RATIO_MAX ? n : null
}

// How far off a length may be and still count as hitting it. Five percent, never less
// than a second: a 60 second demo that runs 61 has hit the number, and holding an agent
// to the frame would make it cut a word in half to win an argument with arithmetic.
const tolerance = want => Math.max(1, want * 0.05)

// ── the brief ────────────────────────────────────────────────────────────────
// Shape is fixed rather than sparse: ui/review.js reads this file and a missing key
// and a null key should not be two different cases there.
function normalizeBrief(raw, before) {
  // A brief sent as one line is still a brief: the line is what the thing is. Refusing
  // it costs a call and teaches nothing, and an argument shape rediscovered by being
  // refused is two of the nineteen calls the named device job took.
  const given = typeof raw === 'string' ? { what: raw } : raw
  const b = { ...(before || {}), ...(given && typeof given === 'object' ? given : {}) }
  const seconds = num(b.seconds)
  return {
    // On a recording the length and the shape carry most of the intent. A still has no
    // length, so this is most of what a brief is there, and it was the field being
    // dropped: review builds its find_on_screen queries out of it (ui/review.js).
    what: text(b.what, 200),
    seconds: seconds > 0 ? Math.min(round1(seconds), MAX_SECONDS) : null,
    aspect: text(b.aspect, 16),
    where: text(b.where, 60),
    audience: text(b.audience),
    must_keep: list(b.must_keep),
    must_hide: list(b.must_hide),
    // The three facts a job that films a device is about, and the three an agent was
    // re-deriving on every call: which device, which app on it, and the size the
    // deliverable has to come out at. Written once, they are arguments from then on.
    device: text(b.device, 64),
    // a bundle id or a path to a built .app, and a path can be long: cut short, it is a
    // path to nothing
    app: text(b.app, 400),
    size: text(b.size, 40),
  }
}

const emptyBrief = () => normalizeBrief(null, null)

// ── a job whose shape is already known ───────────────────────────────────────
// Most jobs here are one of a handful, and one of them has a published shape: film a
// device. Judged against a real phone, "boot an iPhone, open my app, tap through the
// onboarding and record it" took nineteen calls against the five it was sold as. Six
// were bugs other pieces own. The rest were an agent working out, one call at a time,
// a path that is the same every time anybody films a device.
//
// So the director writes that path down. A brief naming a device gets the device job's
// plan back, and every step carries the call it is: the tool's own name and the
// arguments the brief already answered. An agent reads the next call instead of
// guessing at an argument name, which is how `export 1080p` was refused for an enum.
//
// The words of a shaped step never quote the brief, so the plan can be laid down again
// whenever the brief moves and every id and state survives it. That matters: a size
// named on the second call has to reach the export step, or the step names a call that
// will be refused.
const SHAPES = {
  device: {
    when: b => !!(b && b.device),
    steps: b => [
      { what: 'boot the device, launch the app on it and dress its status bar',
        tool: 'simulator', args: { action: 'ready', device: b.device, ...appArg(b.app) } },
      { what: 'record the device window', tool: 'record_start', args: { simulator: b.device } },
      { what: 'tap through the flow, aiming each tap at what the call before it named',
        tool: 'simulator', args: { action: 'tap', device: b.device } },
      { what: 'stop the take', tool: 'record_stop', args: {} },
      // Only when a length was asked for. A deliverable with a length window is the
      // reason this step exists: a store refuses a preview by its length, and finding
      // that out at export is a call spent on something the brief said at the start.
      ...(b.seconds ? [{ what: 'land the take on the length the brief asks for',
        tool: 'fit_to_length', args: { seconds: b.seconds } }] : []),
      { what: 'export at the size the brief asks for',
        tool: 'export', args: b.size ? { size: b.size } : {} },
    ],
  },
}

// The brief says "the app" in whichever form the person gave it, and ready takes two
// kinds of identifier under two names: a path to a built .app goes in app and is
// installed, a bundle id goes in bundle and is launched. Writing a bundle id into app
// was the one wasted call of the judged device job, so the form decides the argument.
// A display name ("Yolkling") is neither and lands in no argument: a call that guesses
// an identifier is worse than one that visibly leaves it out (see appNote).
const APP_PATH = /^(\/|~\/)|\.app\/?$/i
const BUNDLE_ID = /^[A-Za-z0-9-]+(\.[A-Za-z0-9_-]+)+$/
function appArg(v) {
  const s = text(v, 400)
  if (!s) return {}
  if (APP_PATH.test(s)) return { app: s }
  if (BUNDLE_ID.test(s)) return { bundle: s }
  return {}
}
// Said on the result when the brief's app went into no argument, so the agent learns it
// here rather than from a ready that launched nothing.
function appNote(brief) {
  const s = brief && brief.app
  if (!s || Object.keys(appArg(s)).length) return null
  return `"${s}" is neither a bundle id (com.example.app) nor a path to a built .app, so the ready step launches ` +
    'nothing. Send app again as one of those; simulator ready with bundle launches an app already on the device.'
}

/** Which of the known jobs this brief is, or null when it is an edit like any other. */
function shapeOf(brief) {
  for (const name of Object.keys(SHAPES)) if (SHAPES[name].when(brief)) return name
  return null
}

/** The steps of a known job, as words plus the call each one is. [] for an edit. */
function outline(brief) {
  const name = shapeOf(brief)
  return name ? SHAPES[name].steps(brief) : []
}

// ── the plan ─────────────────────────────────────────────────────────────────
const stepId = n => 'P' + n

// What a step is, when the step came from a known shape. Scalars only: an argument the
// director cannot write down in one line is one it has no business deciding.
function callOf(o) {
  const tool = text(o && o.tool, 40)
  if (!tool) return null
  const raw = o.args && typeof o.args === 'object' && !Array.isArray(o.args) ? o.args : {}
  const args = {}
  for (const k of Object.keys(raw).slice(0, MAX_ARGS)) {
    const v = raw[k]
    if (typeof v === 'number' ? Number.isFinite(v) : typeof v === 'boolean') { args[k] = v; continue }
    // long enough for a path: a call carrying half of one is a call that fails
    const s = text(v, 400)
    if (s) args[k] = s
  }
  return { tool, args }
}

// Steps arrive as plain lines ('cut to the three moments that matter') or as objects
// carrying an id and a state. Ids are stable because apply_edit closes a step by id,
// so a re-plan keeps the id of every step whose words did not change, and with it that
// step's state. A step whose words changed is a different step and goes back to todo:
// carrying 'done' across a rewrite would be the agent telling itself a lie.
function normalizeSteps(raw, before) {
  const prev = arr(before)
  const src = Array.isArray(raw) ? raw : raw == null ? [] : [raw]
  const out = []
  const taken = new Set()
  for (const item of src.slice(0, MAX_STEPS)) {
    const o = item && typeof item === 'object' ? item : { what: item }
    const what = text(o.what || o.step || o.name || o.text)
    if (!what) continue
    let id = text(o.id, 8)
    if (!(id && /^P\d+$/.test(id)) || taken.has(id)) id = null
    if (!id) {
      const match = prev.find(p => p.what === what && !taken.has(p.id))
      id = match ? match.id : null
    }
    out.push({ id, what, state: STATES.includes(o.state) ? o.state : null, call: callOf(o.call || o) })
    if (id) taken.add(id)
  }
  // Unnamed steps take the lowest free number, so a plan of five reads P1 to P5.
  let next = 1
  for (const s of out) {
    if (!s.id) {
      while (taken.has(stepId(next))) next++
      s.id = stepId(next)
      taken.add(s.id)
    }
    if (!s.state) {
      const was = prev.find(p => p.id === s.id)
      s.state = was && was.what === s.what ? was.state : 'todo'
    }
    // Same rule as the state: a step whose words did not change is the same step, so
    // the call it was keeps riding on it when a re-plan arrives as plain lines.
    if (!s.call) {
      const was = prev.find(p => p.id === s.id)
      s.call = was && was.what === s.what ? was.call || null : null
    }
  }
  return out.map(s => ({ id: s.id, what: s.what, state: s.state, ...(s.call ? { call: s.call } : {}) }))
}

function normalize(raw) {
  const j = raw && typeof raw === 'object' ? raw : {}
  const steps = normalizeSteps(j.steps, j.steps)
  return {
    v: V,
    brief: normalizeBrief(j.brief, null),
    steps,
    notes: arr(j.notes).slice(-MAX_NOTES).map(n => ({
      at: num(n && n.at) > 0 ? num(n.at) : 0,
      text: text(n && (n.text || n)) || '',
    })).filter(n => n.text),
    created: num(j.created) > 0 ? num(j.created) : 0,
    updated: num(j.updated) > 0 ? num(j.updated) : 0,
  }
}

const blank = now => ({ v: V, brief: emptyBrief(), steps: [], notes: [], created: now || 0, updated: now || 0 })

// ── one edit of the job ──────────────────────────────────────────────────────
// `patch` is the direct tool's own arguments: { brief, plan, done, open, note }.
// Returns the new job plus what happened, because an id that closed nothing is the
// agent's most likely mistake here and silence would hide it.
function merge(job, patch, now = Date.now()) {
  const base = job ? normalize(job) : blank(now)
  const p = patch && typeof patch === 'object' ? patch : {}
  const out = { ...base, brief: { ...base.brief }, steps: base.steps.map(s => ({ ...s })), notes: base.notes.slice() }
  const closed = []
  const opened = []
  const unknown = []
  let changed = false

  if (p.brief !== undefined && p.brief !== null) {
    out.brief = normalizeBrief(p.brief, base.brief)
    changed = true
  }
  if (p.plan !== undefined && p.plan !== null) {
    out.steps = normalizeSteps(p.plan, base.steps)
    changed = true
  } else {
    // A known job lays its own plan out, so the agent spends its first call doing the
    // job instead of writing down the path nobody has ever changed. A plan the agent
    // wrote itself is never overruled: only a plan that is empty, or one this same
    // shape laid down, is re-laid when the brief moves.
    const shaped = outline(out.brief)
    if (shaped.length && out.steps.every(s => s.call)) {
      const next = normalizeSteps(shaped, out.steps)
      if (JSON.stringify(next) !== JSON.stringify(out.steps)) { out.steps = next; changed = true }
    }
  }

  const set = (ids, state, log) => {
    for (const raw of list(ids)) {
      const id = raw.toUpperCase()
      const step = out.steps.find(s => s.id === id)
      if (!step) { unknown.push(id); continue }
      if (step.state !== state) changed = true
      step.state = state
      log.push(id)
    }
  }
  if (p.done != null) set(p.done, 'done', closed)
  if (p.open != null) set(p.open, 'todo', opened)
  if (p.drop != null) set(p.drop, 'dropped', closed)

  const note = text(p.note, 400)
  if (note) {
    out.notes.push({ at: now, text: note })
    if (out.notes.length > MAX_NOTES) out.notes = out.notes.slice(-MAX_NOTES)
    changed = true
  }

  if (!out.created) out.created = now
  if (changed) out.updated = now
  return { job: out, closed, opened, unknown, changed }
}

// ── what is left ─────────────────────────────────────────────────────────────
// The line the chat draws instead of prose, and the list apply_edit hands back on
// every call so the agent cannot work without seeing what it said it would do.
function progress(job) {
  const j = normalize(job)
  const steps = j.steps
  const done = steps.filter(s => s.state !== 'todo').length
  // The call rides on what is left, not just on the step, because the next call is the
  // one thing an agent reads on every result and the one thing it kept guessing at.
  const left = steps.filter(s => s.state === 'todo')
    .map(s => ({ id: s.id, what: s.what, ...(s.call ? { call: s.call } : {}) }))
  return {
    total: steps.length,
    done,
    line: steps.length ? `${done} of ${steps.length}` : 'no plan yet',
    next: left[0] || null,
    left,
    steps: steps.map(s => ({ ...s })),
  }
}

// Length and shape against what was asked. `facts` is what the caller already knows
// about the edit: { seconds, aspect }. Nothing here reads a file or a frame.
function distance(job, facts) {
  const b = normalize(job).brief
  const f = facts && typeof facts === 'object' ? facts : {}
  const out = { seconds: null, aspect: null, ok: true, line: '' }
  const parts = []

  const got = num(f.seconds)
  if (b.seconds != null && got >= 0) {
    const off = round1(got - b.seconds)
    const tol = round1(tolerance(b.seconds))
    const ok = Math.abs(off) <= tol
    out.seconds = { want: b.seconds, got: round1(got), off, tol, ok }
    parts.push(ok
      ? `${round1(got)} s against ${b.seconds} asked, on the number`
      : `${round1(got)} s against ${b.seconds} asked, ${Math.abs(off)} s ${off > 0 ? 'over' : 'under'}`)
    if (!ok) out.ok = false
  }

  const want = ratio(b.aspect)
  const has = ratio(f.aspect)
  if (want != null) {
    // A shape nobody has set yet is not the wrong shape, it is an unanswered question,
    // and the agent should be told which of the two it is looking at.
    const ok = has != null && Math.abs(has - want) <= 0.02
    out.aspect = { want: b.aspect, got: f.aspect == null ? null : String(f.aspect), ok }
    parts.push(ok ? `${b.aspect} as asked`
      : has == null ? `${b.aspect} asked, none set` : `${b.aspect} asked, ${f.aspect} set`)
    if (!ok) out.ok = false
  }

  out.line = parts.join('; ')
  return out
}

// What every apply_edit result carries: how far the work still is from the plan, and
// how far the result still is from the brief.
const state = (job, facts) => ({ plan: progress(job), distance: distance(job, facts) })

// ── the sidecar ──────────────────────────────────────────────────────────────
const stem = p => path.basename(String(p || '')).replace(/\.[^.]+$/, '')
const jobPath = src => path.join(path.dirname(String(src || '')), SIDE_DIR, stem(src) + EXT)

// A job that will not parse must never block an edit, so a bad file reads as no job
// and the next write replaces it.
function read(src) {
  try { return normalize(JSON.parse(fs.readFileSync(jobPath(src), 'utf8'))) } catch { return null }
}

function writeTo(file, job) {
  try { fs.mkdirSync(path.dirname(file), { recursive: true }) } catch {}
  const out = normalize(job)
  fs.writeFileSync(file, JSON.stringify(out, null, 2))
  return out
}

const write = (src, job) => writeTo(jobPath(src), job)

// ── a job that exists before the take does ───────────────────────────────────
// An edit's job can only begin once there is a take, because the sidecar sits beside
// the file. A device job cannot wait that long: which device to boot and how many
// seconds the deliverable takes are decided before record_start, and a brief written
// after record_stop arrived too late to steer anything it was for. So a job may be
// opened with no take under it. It waits alone in a folder the caller names, and
// record_stop moves it onto the take it turned out to be about.
const PENDING = 'pending' + EXT
// A job nobody attached within the day is not this take's job. Better none than the
// wrong one: a stale brief quietly steering somebody else's recording is worse than
// being asked for the brief again.
const PENDING_STALE = 24 * 3600 * 1000

const pendingPath = dir => path.join(String(dir || ''), SIDE_DIR, PENDING)

function readPending(dir, now = Date.now()) {
  if (!dir) return null
  try {
    const job = normalize(JSON.parse(fs.readFileSync(pendingPath(dir), 'utf8')))
    return now - (job.updated || job.created || 0) > PENDING_STALE ? null : job
  } catch { return null }
}

const clearPending = dir => { try { fs.unlinkSync(pendingPath(dir)) } catch {} }

/**
 * Move the waiting job onto the take it was about, and take it out of the way whether
 * or not it landed. A take that already has a job of its own keeps it: a job written
 * with the take in front of it beats one written before there was a take, and a brief
 * that waited is not an override.
 */
function attach(src, dir, now = Date.now()) {
  const pend = readPending(dir, now)
  clearPending(dir)
  if (!pend || read(src)) return null
  // The take existing is the proof that everything up to record_stop happened, and none
  // of those calls takes a step: left open, plan.next stayed on 'simulator ready' for the
  // rest of the job and an agent reading next.call booted the device again. So they
  // close here, and the calls after them learn which take they are about.
  const steps = pend.steps.map(s => (s.state === 'todo' && s.call && TAKE_MAKERS.has(s.call.tool)
    ? { ...s, state: 'done' } : s))
  const job = write(src, { ...pend, steps, updated: now })
  return { file: jobPath(src), brief: job.brief, ...state(withPath(job, src), null), notes: job.notes }
}

// The calls that make a take. A take on disk means each one ran.
const TAKE_MAKERS = new Set(['simulator', 'record_start', 'record_stop'])

// A shaped step's call is written before there is a take, so it has no path. Once there
// is one, the call is only a call if it names it. Added where the plan is handed back
// rather than stored, so the stored plan stays the shape's own and a re-plan does not
// see a difference that is only the path.
function withPath(job, src) {
  if (!src) return job
  const PATHED = new Set(['fit_to_length', 'export', 'review', 'apply_edit', 'apply_look', 'contact_sheet'])
  return { ...job, steps: job.steps.map(s => (s.call && PATHED.has(s.call.tool) && !s.call.args.path
    ? { ...s, call: { ...s.call, args: { path: String(src), ...s.call.args } } } : s)) }
}

const NO_BRIEF = 'No brief yet. Call direct with the length, shape and steps this job is for, then close each step with apply_edit step as you finish it. A job that films a device is worth directing before record_start rather than after it, because the brief is what decides the device and the length.'

/**
 * The direct tool, whole: read, apply, write, and hand back the state the agent reads.
 * `src` may be null for a job with no take under it yet, and then `opts.dir` says where
 * it waits. Everything else is the same job, read and written the same way.
 */
function direct(src, patch, opts = {}) {
  const now = opts.now || Date.now()
  const waiting = !src
  if (waiting && !opts.dir) throw new Error('a job with no take under it needs a folder to wait in')
  const file = waiting ? pendingPath(opts.dir) : jobPath(src)
  const r = merge(waiting ? readPending(opts.dir, now) : read(src), patch, now)
  const job = r.changed ? writeTo(file, r.job) : r.job
  return {
    file,
    ...(waiting ? { waiting: true } : {}),
    brief: job.brief,
    ...state(withPath(job, src), opts.facts),
    notes: job.notes,
    closed: r.closed,
    opened: r.opened,
    unknown: r.unknown,
    ...(appNote(job.brief) ? { app_note: appNote(job.brief) } : {}),
  }
}

/**
 * The first open step whose call is this tool, for a call that finished that step
 * without being told its id. export is the deliverable of the device job, and a plan
 * still reading "4 of 5" after the file is written is the plan lying about the job.
 */
function stepFor(job, tool) {
  if (!job) return null
  const s = normalize(job).steps.find(x => x.state === 'todo' && x.call && x.call.tool === tool)
  return s ? s.id : null
}

// For apply_edit and export, which carry the plan whether or not one exists. A take
// with no job returns the nudge rather than nothing, because a returned field an agent
// reads on every call is the only steering that actually holds.
function forEdit(src, facts) {
  const job = read(src)
  if (!job) return { plan: null, distance: null, hint: NO_BRIEF }
  return state(withPath(job, src), facts)
}

module.exports = {
  normalize, normalizeBrief, normalizeSteps, merge, progress, distance, state,
  ratio, tolerance, jobPath, read, write, direct, forEdit,
  shapeOf, outline, pendingPath, readPending, clearPending, attach, appArg, appNote, stepFor,
  V, EXT, STATES, SHAPES, MAX_STEPS, MAX_NOTES, PENDING_STALE, NO_BRIEF,
}
