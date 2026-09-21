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
  const b = { ...(before || {}), ...(raw && typeof raw === 'object' ? raw : {}) }
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
  }
}

const emptyBrief = () => normalizeBrief(null, null)

// ── the plan ─────────────────────────────────────────────────────────────────
const stepId = n => 'P' + n

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
    const what = text(o.what || o.step || o.name)
    if (!what) continue
    let id = text(o.id, 8)
    if (!(id && /^P\d+$/.test(id)) || taken.has(id)) id = null
    if (!id) {
      const match = prev.find(p => p.what === what && !taken.has(p.id))
      id = match ? match.id : null
    }
    out.push({ id, what, state: STATES.includes(o.state) ? o.state : null })
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
  }
  return out
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
  const left = steps.filter(s => s.state === 'todo').map(s => ({ id: s.id, what: s.what }))
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

function write(src, job) {
  const file = jobPath(src)
  try { fs.mkdirSync(path.dirname(file), { recursive: true }) } catch {}
  const out = normalize(job)
  fs.writeFileSync(file, JSON.stringify(out, null, 2))
  return out
}

const NO_BRIEF = 'No brief yet. Call direct with the length, shape and steps this job is for, then close each step with apply_edit step as you finish it.'

// The direct tool, whole: read, apply, write, and hand back the state the agent reads.
function direct(src, patch, opts = {}) {
  const now = opts.now || Date.now()
  const r = merge(read(src), patch, now)
  const job = r.changed ? write(src, r.job) : r.job
  return {
    file: jobPath(src),
    brief: job.brief,
    ...state(job, opts.facts),
    notes: job.notes,
    closed: r.closed,
    opened: r.opened,
    unknown: r.unknown,
  }
}

// For apply_edit and export, which carry the plan whether or not one exists. A take
// with no job returns the nudge rather than nothing, because a returned field an agent
// reads on every call is the only steering that actually holds.
function forEdit(src, facts) {
  const job = read(src)
  if (!job) return { plan: null, distance: null, hint: NO_BRIEF }
  return state(job, facts)
}

module.exports = {
  normalize, normalizeBrief, normalizeSteps, merge, progress, distance, state,
  ratio, tolerance, jobPath, read, write, direct, forEdit,
  V, EXT, STATES, MAX_STEPS, MAX_NOTES, NO_BRIEF,
}
