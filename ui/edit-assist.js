// The chat and the editor working on one take: what the agent is told about the edit
// each turn, which edits to offer, what an agent's change touched, and how to take it
// back. Pure, no DOM and no Electron, so test/assist.test.js runs it under plain node.

const Look = require('./look')
const arr = v => Array.isArray(v) ? v : []
const clock = s => `${Math.floor((+s || 0) / 60)}:${String(Math.round((+s || 0) % 60)).padStart(2, '0')}`
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`

// Counts, not contents: enough for the agent to know what exists and for the chips to
// know what is missing, without putting a transcript into every prompt.
function editFacts(doc) {
  doc = doc || {}
  const L = doc.look || {}
  const marks = arr(doc.marks)
  return {
    clips: Math.max(1, arr(doc.clips).length),
    zooms: arr(doc.zooms).length,
    zoomIds: arr(doc.zooms).map(z => z.id).filter(Boolean),
    marks: marks.length,
    markIds: marks.map(m => m.id).filter(Boolean),
    redactions: marks.filter(m => m.kind === 'redact' || m.kind === 'blur').length,
    texts: arr(doc.texts).length,
    textIds: arr(doc.texts).map(t => t.id).filter(Boolean),
    captions: arr(doc.cues).length,
    // v2 keeps these in the look (ui/look.js); a v1 document at the top
    burnCaps: !!(L.captions ? L.captions.show : L.burnCaps),
    backdrop: L.background ? Look.backdropId(L) : doc.backdrop || null,
    outAspect: L.frame ? Look.aspectNumber(L.frame.aspect) : doc.outAspect || null,
    autoZoom: !!doc.autoZoom,
  }
}

const ids = list => list.length ? ` (${list.slice(0, 8).join(', ')}${list.length > 8 ? ', ...' : ''})` : ''

// ── the standing doctrine ───────────────────────────────────────────────
// This used to ride on every single message: about 600 words of instruction ahead of
// a six word request, twenty to one. It is doctrine, not news, so it is said once per
// conversation instead, as a system prompt (Claude Code takes one; a Codex thread gets
// it on the message that opens the thread and its resume carries it from there).
// What stays in the per-turn header is only what actually changed: the take, its
// counts, the job, the lassoed areas.
//
// The loop is the part the tools then hold the agent to: a plan and a distance come
// back on every apply_edit, so this is a reminder of a shape the results enforce,
// not an honour system.
const LOOP = [
  'See the whole take with contact_sheet before you change it.',
  'Write the brief and the plan with direct before the first change.',
  'Make one step at a time and close it: apply_edit takes step, for example "P3".',
  'Call review before you reply.',
  'Fix what review names, or say in your reply why you did not.',
  'Report the plan and what changed, not prose.',
  'Write down with remember anything the person tells you that will still be true next week: what ' +
    'their product is called, who a demo is for, what must never be on screen.',
]

// Aiming. An agent that eyeballed one frame zoomed on the wrong button, added a
// spotlight nobody asked for and never looked at the result. Aim, add only what was
// asked, check.
const AIM = [
  'To zoom on, spotlight, blur, redact or number something, first call find_on_screen at that ' +
    'moment with the person\'s own words for it, and send element: its E id (or its box) for the one ' +
    'they meant; never work out x, y and scale yourself or guess coordinates from a frame.',
  'For something bigger than one element (a panel, a card grid, a section), use the element of kind ' +
    'panel or grid, or the one the matching element is `in`; if none fits, search again with other ' +
    'words rather than drawing a box.',
  'Add only the effects that were asked for. A new lift or spotlight replaces any already on that ' +
    'spot: remove the old one rather than stacking two.',
  'A lift needs room round it and its whole content on screen: an element find_on_screen marks ' +
    'no_lift is not lifted. When the person asked for a lift, lift the card or grid its no_lift names ' +
    '(that is what they meant by the card); a spotlight is not a lift, and is only for when no_lift ' +
    'names nothing, which you say.',
  'Time a zoom or a mark to when the element is on screen, not to when the narration starts: a card ' +
    'that opens mid-sentence is not there yet at the sentence\'s start. Fetch holds a new lift or ' +
    'spotlight to the part of its span where its box shows the element (the result lists it under retimed).',
  'When sending a list back, keep every existing item\'s id. Marks you leave out are kept; delete one ' +
    'only by naming it in remove, and never remove a redact or blur the person did not ask about. If ' +
    'the result lists removed or replaced ids, say which in your reply.',
  'When fixing or re-aiming a zoom, the result lists under alongside any spotlight or lift that plays ' +
    'with it: an earlier turn may have added it unasked. Remove it if the person complained about a ' +
    'highlight there or never asked for one in this conversation; otherwise keep it, and either way ' +
    'name it in your reply.',
  'Read the result\'s warnings and fix what they name. After the edit, call preview_frame once with at ' +
    'set to every time the result lists under check.preview_frame_at, never just one, and look at each ' +
    'frame; if one is not on the thing they meant, or anything else dims or covers it, fix it before replying.',
  'When the context names a lassoed area, send element: that R id on the zoom or mark. Do not call ' +
    'find_on_screen for it, do not rank anything, and do not pick a different element: the person has ' +
    'already pointed at it.',
]

// The library and the open edit both move under the agent's feet, and a resumed
// session twice answered "my latest recording" from what an earlier turn had said.
const STATE = [
  'Recordings and edits change between messages: takes are recorded, renamed and deleted, and the ' +
    'person edits by hand. Do not trust what an earlier turn said about them; read the current state ' +
    'with list_recordings or get_edit before acting.',
  'Any question about which recordings exist, or about the latest, last or newest one, needs a fresh ' +
    'list_recordings call in this turn, even if an earlier turn already answered it; the newest is the ' +
    'first take it lists. Name the recording you acted on in your reply.',
  'For an edit, fill anything the person left out with a sensible default and make the change, rather ' +
    'than asking; they can see it and undo it. The one exception is the narrow one under Asking.',
]

// ── asking, and proposing ───────────────────────────────────────────────
// The bar for a question is damage, not doubt. An agent that asks about everything is
// worse than one that guesses, because the whole promise of the pane is that it does
// the work. But "hide the sidebar" when they meant one button inside it costs an edit
// and an undo, and two buttons cost one click.
const ASKING = [
  'Ask with ask only when the request has two or more readings that would touch different parts of the ' +
    'take, and the wrong one costs an edit and an undo: "the whole sidebar, or just the Practice button". ' +
    'Offer two to four choices, each one a thing you would then go and do. Never ask twice about the same ' +
    'thing, and never ask what you can find out yourself with find_on_screen, get_edit or list_recordings.',
  'Everything else you decide: a default they can see and undo beats a question. Styling, timing, wording, ' +
    'easing and which preset to use are never worth asking about.',
  'Show it with propose instead of applying it when the change is wide or awkward to take back: cutting ' +
    'more than half the take, changing or deleting something they made by hand, touching a redact or a ' +
    'blur, or replacing the look. propose takes the same arguments apply_edit takes and writes nothing ' +
    'until they press Apply.',
  'Both come back whether or not anyone answered, and the result\'s do_next says what to do with that. ' +
    'Follow it. Do not ask the same question again, and never apply a proposal they did not accept.',
]

// Sent once per conversation, not once per message. Plain text, since both CLIs take
// it as a system prompt rather than as part of the thread.
//
// `memory` is ui/memory.js's own block, already capped and already ordered general to
// specific. It rides here rather than in the per-turn header because it is not news:
// what the product is called was true last week and will be true next week, and paying
// for it on every message is what the header was split off to stop.
function systemPrompt({ memory = '' } = {}) {
  const known = String(memory || '').trim()
  return [
    'You are the agent inside Fetch, a Mac screen recorder, working on this person\'s own machine ' +
      'through Fetch\'s tools.',
    '',
    'How a job goes, every time:',
    ...LOOP.map(l => `- ${l}`),
    '',
    'Aiming:',
    ...AIM.map(l => `- ${l}`),
    '',
    'What is true only right now:',
    ...STATE.map(l => `- ${l}`),
    '',
    'Asking:',
    ...ASKING.map(l => `- ${l}`),
    '',
    // nothing at all when the store is empty, rather than a heading over a blank
    ...(known ? ['What this person has already told you, from earlier conversations:', known, ''] : []),
    'Write replies in short plain sentences, in the house voice: plain, short, a little warm. Never ' +
      'use an em dash; use a comma, colon, full stop or parentheses instead.',
  ].join('\n')
}

// ── the per-turn header ─────────────────────────────────────────────────
// An area the person drew round on the stage, as the agent reads it. The box is
// already the frame apply_edit places things in, and the picture beside the message is
// that area alone, so there is nothing left to search for or rank.
function regionLines(regions) {
  const list = arr(regions).filter(r => r && r.id && r.box).slice(0, 8)
  if (!list.length) return []
  const out = []
  for (const r of list) {
    const px = r.px ? `, ${Math.round(r.px.w)} by ${Math.round(r.px.h)} pixels of the recording` : ''
    // the path on every bullet: a chip can outlive the editor being on screen, and
    // without it the agent has an area and no file to apply it to
    const on = r.path ? ` of ${r.path}` : ''
    out.push(`Lassoed for this message, work on exactly it: ${r.id} at ${(+r.at || 0).toFixed(2)} s${on}, ` +
      `"${r.label || 'Area'}" (${r.kind || 'free'}), box ${JSON.stringify(r.box)} of the frame after the ` +
      `crop${px}. The attached picture is that area alone.`)
  }
  return out
}

// The job sidecar (.fetch/<stem>.job.json, written by direct) read once for both
// surfaces that show it: this header and the chat pane's plan strip. Shapes vary by
// caller, so a job, a plan object or a bare list of steps all read the same.
function planState(job) {
  const src = job && typeof job === 'object' ? job : null
  const steps = arr(Array.isArray(src) ? src : src && (src.steps || src.plan || (src.job && src.job.steps)))
    .filter(s => s && (s.id || s.what))
    .map(s => ({ id: s.id || '', what: s.what || s.step || '', state: s.state || 'todo' }))
  if (!steps.length) return null
  // Closed, not finished: a step the agent dropped on purpose is closed too, and
  // ui/director.js counts it the same way, so the header and the strip agree with the
  // line the tool itself returns.
  const counted = src && !Array.isArray(src) ? +src.done : NaN
  const done = Number.isFinite(counted) && counted >= 0 && counted <= steps.length
    ? counted : steps.filter(s => s.state !== 'todo').length
  const next = steps.find(s => s.state === 'todo') || null
  const brief = (src && !Array.isArray(src) && (src.brief || (src.job && src.job.brief))) || null
  return { steps, done, total: steps.length, next, brief }
}

// A brief is a target, so it is said as one: the number to hit and where it is going.
function briefLine(b) {
  if (!b) return ''
  const bits = []
  if (+b.seconds) bits.push(`${+b.seconds} s`)
  if (b.aspect) bits.push(String(b.aspect))
  if (b.where) bits.push(`for ${b.where}`)
  return bits.join(', ')
}

// The top of every turn, and only what is new since the last one: the doctrine above
// is sent once per conversation instead. The newest recording is deliberately not
// named here; when it was, the model took it as the answer and never read the library,
// so a take that landed a moment later went unseen.
function contextHeader({ open, omitted, regions = [], job = null } = {}) {
  const lines = ['<fetch_context>', 'True as of this message only.']
  if (open && open.path) {
    lines.push(`Open in the editor, and what "this" or "it" means: ${open.path}${open.dur ? ` (${clock(open.dur)})` : ''}.`)
    // no document while the take is still loading: counts from a blank edit would be wrong
    if (open.doc) {
      const f = editFacts(open.doc)
      const cap = f.captions
        ? `captions ${plural(f.captions, 'line')}${f.burnCaps ? ', burned in' : ', not burned in'}`
        : 'no captions'
      lines.push(`Its edit: ${plural(f.clips, 'clip')}, ${plural(f.zooms, 'zoom')}${ids(f.zoomIds)}, ` +
        `${plural(f.marks, 'mark')}${ids(f.markIds)}, ${plural(f.texts, 'text')}${ids(f.textIds)}, ${cap}` +
        `${f.outAspect ? `, aspect ${f.outAspect}` : ''}${f.backdrop ? `, backdrop ${f.backdrop}` : ''}.`)
    } else lines.push('Its edit is still loading; read it with get_edit.')
  } else if (omitted) {
    lines.push('The person left the recording open in the editor out of this message, so do not assume it.')
  } else {
    lines.push('No recording is open in the editor.')
  }
  const p = planState(job)
  if (p) {
    const b = briefLine(p.brief)
    lines.push(`Job: ${b || 'in progress'}. Plan: ${p.done} of ${p.total} done` +
      `${p.next ? `, next ${p.next.id}${p.next.what ? ` ${p.next.what}` : ''}` : ', all closed'}.`)
  }
  lines.push(...regionLines(regions))
  lines.push('</fetch_context>')
  return lines.join('\n')
}
// The brand has no em dashes on any surface, and a model writes them however it is
// asked. A spaced or joined em dash reads as a comma; a spaced en dash is the same
// habit. An unspaced en dash is a range (1 to 3) and stays.
function plainDashes(t) {
  return String(t == null ? '' : t)
    .replace(/^[ \t]*\u2014[ \t]*/gm, '')
    .replace(/\s*\u2014\s*/g, ', ')
    .replace(/ \u2013 /g, ', ')
    .replace(/, ([.,;:!?])/g, '$1')
}

// Edits worth offering for this take, most useful first, each dropped once the edit
// already has it. The label is what the chip says; the ask is the sentence it sends.
function suggestions(doc, o = {}) {
  const f = editFacts(doc)
  const speech = o.hasAudio !== false
  const out = []
  if (speech && !f.captions) out.push({ label: 'Add captions', ask: 'Transcribe this take and burn captions into it.' })
  if (speech && f.clips <= 1) out.push({ label: 'Tighten the pauses', ask: 'Cut the long pauses out of this take so it keeps moving.' })
  if (!f.zooms && !f.autoZoom) out.push({ label: 'Zoom into each step', ask: 'Look through this take and add a zoom on each step.' })
  if (!f.redactions) out.push({ label: 'Blur my name', ask: 'Find everywhere my name or email is visible in this take and blur it.' })
  if (!f.outAspect && !f.backdrop) out.push({ label: '16:9 on a blurred background', ask: 'Make this 16:9 on a blurred background.' })
  if (!f.texts) out.push({ label: 'Add a title', ask: 'Add a short title over the first few seconds of this take.' })
  if (f.captions) out.push({ label: 'Fix caption mistakes', ask: 'Read the captions on this take and fix anything that was misheard.' })
  if (f.zooms) out.push({ label: 'Make the zooms gentler', ask: 'Make the zooms on this take gentler and a little shorter.' })
  return out.slice(0, 4)
}

// What an agent's change touched, by id, so the editor can light exactly those rows.
// New or changed both count: a zoom moved by a second is as much a change as a new one.
function changedIds(before, after) {
  before = before || {}; after = after || {}
  const byId = (k) => {
    const was = new Map(arr(before[k]).map(x => [x.id, JSON.stringify(x)]))
    return arr(after[k]).filter(x => x && x.id && was.get(x.id) !== JSON.stringify(x)).map(x => x.id)
  }
  const cuesA = arr(before.cues), cuesB = arr(after.cues)
  const cues = []
  cuesB.forEach((c, i) => { if (JSON.stringify(c) !== JSON.stringify(cuesA[i])) cues.push(i) })
  const same = k => JSON.stringify(before[k] == null ? null : before[k]) === JSON.stringify(after[k] == null ? null : after[k])
  return {
    zooms: byId('zooms'), marks: byId('marks'), texts: byId('texts'), cues,
    clips: !same('clips'),
    frame: !same('backdrop') || !same('outAspect') || !same('crop') || !same('look'),
  }
}
// One named list (zooms, marks, texts) put back item by item against what the person
// has done since: b before the agent, a after it, n now.
const BY_ID = ['zooms', 'marks', 'texts']
function mergeById(b, a, n) {
  const key = x => JSON.stringify(x)
  const B = new Map(b.filter(x => x && x.id).map(x => [x.id, x]))
  const A = new Map(a.filter(x => x && x.id).map(x => [x.id, x]))
  const N = new Map(n.filter(x => x && x.id).map(x => [x.id, x]))
  const agentTouched = id => !B.has(id) || !A.has(id) || key(B.get(id)) !== key(A.get(id))
  let kept = false
  const list = []
  for (const x of n) {
    const id = x && x.id
    if (!id || !A.has(id)) { list.push(x); continue }            // the person's own, or unnamed
    if (key(x) !== key(A.get(id))) {                               // changed by hand since
      list.push(x); if (agentTouched(id)) kept = true; continue
    }
    if (B.has(id)) list.push(B.get(id))                            // as it was; added by the agent: gone
  }
  // what the agent removed comes back
  let back = 0
  for (const [id, x] of B) if (!A.has(id) && !N.has(id)) { list.push(x); back++ }
  // a removal the person made after the agent's edit is theirs
  for (const id of A.keys()) if (!N.has(id) && agentTouched(id) && B.has(id)) kept = true
  const at = x => Number.isFinite(x && x.start) ? x.start : Infinity
  if (back) list.sort((p, q) => at(p) - at(q))
  return { list: JSON.parse(JSON.stringify(list)), kept }
}

// What undo puts back: the edit from before the agent's change, except for anything
// the person has changed since, which stays as they left it. Restoring the snapshot
// whole would quietly throw away their own work, and the path of a take renamed since.
// The id counter only moves forward, so an id is never handed out twice.
function revert(before, after, now) {
  before = before || {}; after = after || {}; now = now || {}
  const back = JSON.parse(JSON.stringify(before))
  const kept = []
  for (const k of new Set([...Object.keys(before), ...Object.keys(after), ...Object.keys(now)])) {
    if (k === 'nextId') continue
    // Lists of named things merge item by item: a zoom the person dragged afterwards
    // must not keep the agent's other new zooms alive, as a whole-list compare did.
    if (BY_ID.includes(k) && [before[k], after[k], now[k]].every(Array.isArray)) {
      const m = mergeById(before[k], after[k], now[k])
      back[k] = m.list
      if (m.kept) kept.push(k)
      continue
    }
    if (JSON.stringify(now[k]) !== JSON.stringify(after[k])) {
      if (now[k] === undefined) delete back[k]; else back[k] = JSON.parse(JSON.stringify(now[k]))
      if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) kept.push(k)
    }
  }
  back.nextId = { ...(before.nextId || {}) }
  for (const src of [after.nextId, now.nextId]) {
    for (const [k, v] of Object.entries(src || {})) back.nextId[k] = Math.max(back.nextId[k] || 1, v)
  }
  return { doc: back, kept }
}

// What an undo did, said as a report the person can check against the timeline. A
// removed zoom leaves nothing to flash, so the sentence is the only signal they get.
const MARK_NOUN = { step: 'step badge', lift: 'lift', spotlight: 'spotlight', blur: 'blur', redact: 'blur', arrow: 'arrow' }
function undoSummary(was, now) {
  was = was || {}; now = now || {}
  const noun = (k, x) => k === 'zooms' ? 'zoom' : k === 'texts' ? 'title' : (MARK_NOUN[x && x.kind] || 'mark')
  const say = (k, list) => {
    if (list.length === 1) {
      const x = list[0]
      return `the ${noun(k, x)}${Number.isFinite(x.start) ? ` at ${clock(x.start)}` : ''}`
    }
    const kinds = [...new Set(list.map(x => noun(k, x)))]
    return kinds.length === 1 ? `${list.length} ${kinds[0]}s` : plural(list.length, k === 'marks' ? 'mark' : noun(k))
  }
  const acts = { 'took out': [], 'brought back': [], 'restored': [] }
  for (const k of ['zooms', 'texts', 'marks']) {
    const a = new Map(arr(was[k]).filter(x => x && x.id).map(x => [x.id, x]))
    const b = new Map(arr(now[k]).filter(x => x && x.id).map(x => [x.id, x]))
    const gone = [...a.values()].filter(x => !b.has(x.id))
    const back = [...b.values()].filter(x => !a.has(x.id))
    const moved = [...b.values()].filter(x => a.has(x.id) && JSON.stringify(a.get(x.id)) !== JSON.stringify(x))
    if (gone.length) acts['took out'].push(say(k, gone))
    if (back.length) acts['brought back'].push(say(k, back))
    if (moved.length) acts['restored'].push(say(k, moved))
  }
  const same = k => JSON.stringify(was[k] == null ? null : was[k]) === JSON.stringify(now[k] == null ? null : now[k])
  if (!same('cues')) acts['restored'].push('the captions')
  if (!same('clips')) acts['restored'].push('the cuts')
  if (!same('backdrop') || !same('outAspect') || !same('crop') || !same('look')) acts['restored'].push('the framing')
  const join = l => l.length < 3 ? l.join(' and ') : `${l.slice(0, -1).join(', ')} and ${l[l.length - 1]}`
  const parts = Object.entries(acts).filter(([, l]) => l.length).map(([v, l]) => `${v} ${join(l)}`)
  return parts.length ? `Undid Biscuit's change: ${parts.join(', ')}` : 'Undid Biscuit\'s change'
}

const anyChange = c =>!!(c && (c.zooms.length || c.marks.length || c.texts.length || c.cues.length || c.clips || c.frame))

// ── a question, and a proposal ──────────────────────────────────────────
// Two chat events that are not a report. A question is buttons the person clicks; a
// proposal is a change shown before it lands, which writes nothing until Apply.
//
// Both are checked here, in one place, because both cross a process boundary twice
// (agent to app, person back to agent) and a malformed one must fail at the tool call
// with a sentence the agent can act on, not half-draw in the pane.
//
// Neither may block forever. Both carry their own deadline, the pane runs it and main
// runs it a moment later as a backstop, and the tool comes back either way.
const ASK_MS = 90000
const PROPOSE_MS = 240000
const MAX_CHOICES = 4              // the pane is 380px wide, and five readings is not a question
const MAX_CHANGES = 12
const trim = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n)

// Choice ids are the agent's own words for what it would do, so the result reads as
// a decision ("choice: sidebar") rather than as an index into a list it has forgotten.
function choiceList(raw) {
  const out = []
  for (const c of arr(raw)) {
    const o = typeof c === 'string' ? { label: c } : (c || {})
    const label = trim(o.label || o.id, 60)
    if (!label) continue
    const id = trim(o.id || label, 40).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
    // A blank or repeated choice is dropped rather than counted, so a sloppy list
    // does not push a real reading off the end of the card.
    if (!id || out.some(x => x.id === id)) continue
    out.push({ id, label, hint: trim(o.hint, 90) || null })
  }
  return out.slice(0, MAX_CHOICES)
}

function askSpec(spec = {}) {
  const question = trim(spec.question, 140)
  if (!question) return { ok: false, error: 'A question needs its question, in the person\'s own words.' }
  const choices = choiceList(spec.choices)
  if (choices.length < 2) {
    return { ok: false, error: 'A question needs two to four choices, each one a thing you would then go and do. ' +
      'With one reading there is nothing to ask: make the change.' }
  }
  const ms = Math.max(10000, Math.min(600000, +spec.timeoutMs || ASK_MS))
  return { ok: true, ask: { id: trim(spec.id, 24) || 'Q', question, note: trim(spec.note, 160) || null, choices, timeoutMs: ms } }
}

function proposalSpec(spec = {}) {
  const title = trim(spec.title, 80)
  if (!title) return { ok: false, error: 'A proposal needs a title: what it would do, in one short line.' }
  const changes = arr(spec.changes).slice(0, MAX_CHANGES)
    .map(c => ({ id: trim(c && c.id, 12) || null, line: trim(c && (c.line || c.what || c), 120) }))
    .filter(c => c.line)
  const ms = Math.max(10000, Math.min(900000, +spec.timeoutMs || PROPOSE_MS))
  return { ok: true, proposal: {
    id: trim(spec.id, 24) || 'P', title, what: trim(spec.what, 160) || null,
    changes, preview: typeof spec.preview === 'string' ? spec.preview : null, timeoutMs: ms } }
}

// What the tool hands back, every branch carrying a do_next. A result that says only
// "nobody answered" gets asked again a second later, which is the failure this whole
// feature exists to stop.
const secsOf = ms => Math.round((+ms || ASK_MS) / 1000)
function askResult(o = {}) {
  const how = o.how || 'timeout'
  if (how === 'answered' && o.choice && o.choice.id) {
    return { answered: true, choice: o.choice.id, label: o.choice.label || o.choice.id,
      do_next: `They chose "${o.choice.label || o.choice.id}". Do that, and do not ask about it again in this job.` }
  }
  if (how === 'cancelled') {
    return { answered: false, reason: how, why: 'They stopped the turn while the question was up.',
      do_next: 'Stop here. Change nothing else and keep your reply to one line.' }
  }
  const why = {
    dismissed: 'They waved the question away.',
    unattended: 'The chat pane was not on screen, so the question was never seen.',
  }[how] || `Nobody answered in ${secsOf(o.timeoutMs)} s.`
  return { answered: false, reason: how === 'answered' ? 'timeout' : how, why,
    do_next: 'Take the narrowest choice you offered, make that change, and say in your reply which one you ' +
      'took and that they can undo it. Do not ask again.' }
}

function proposalResult(o = {}) {
  const how = o.how || 'timeout'
  if (how === 'apply') {
    return { applied: true, decision: 'apply',
      do_next: 'It is applied already, so do not send it again through apply_edit. Check it with preview_frame and carry on.' }
  }
  if (how === 'discard' || how === 'dismissed') {
    return { applied: false, decision: 'discard', why: 'They looked at it and said no. Nothing was written.',
      do_next: 'Do not apply it, and do not propose the same thing again. Ask in one short question what to change instead.' }
  }
  if (how === 'cancelled') {
    return { applied: false, decision: 'none', reason: how, why: 'They stopped the turn while the proposal was up. Nothing was written.',
      do_next: 'Stop here. Nothing needs undoing.' }
  }
  const why = how === 'unattended'
    ? 'The chat pane was not on screen, so the proposal was never seen. Nothing was written.'
    : `Nobody answered in ${secsOf(o.timeoutMs)} s. Nothing was written.`
  return { applied: false, decision: 'none', reason: how === 'apply' ? 'timeout' : how, why,
    do_next: 'Leave it unapplied. Say in your reply what you proposed and that it is still waiting. Never apply it behind their back.' }
}

// The one line the card shows once it is settled. An answered question needs none:
// the chosen button, ticked, is the record of what was said.
const SETTLED = {
  ask: {
    answered: '', timeout: 'No answer, so Biscuit carried on.',
    dismissed: 'Waved away, so Biscuit carried on.', unattended: 'Not seen, so Biscuit carried on.',
    cancelled: 'Stopped before you answered.', stale: 'From an earlier chat.',
    superseded: 'Asked again, below.',
  },
  propose: {
    apply: 'Applied.', discard: 'Discarded. Nothing was changed.',
    // The card says Applied the moment Apply is pressed, because the click is the
    // answer. The edit runs after that and can still refuse, so there is one line that
    // arrives later and corrects it (ui/agent-bridge.js, chat.propose).
    failed: 'That could not be applied, so nothing was changed.',
    dismissed: 'Discarded. Nothing was changed.', timeout: 'No answer, so nothing was applied.',
    unattended: 'Not seen, so nothing was applied.', cancelled: 'Stopped. Nothing was changed.',
    stale: 'From an earlier chat. Nothing was changed.',
    superseded: 'Proposed again, below. Nothing was changed.',
  },
}
const settleLine = (kind, how) => (SETTLED[kind] || {})[how] || ''

// Undo for agent edits. One level per burst: an agent often applies an edit in
// several passes, and undoing a third of what it did is not what anyone asks for. A
// new level starts on a new chat turn (mark), after a pause, or once the person has
// touched the edit in between, since their change is not the agent's to take back.
function createUndo({ max = 20, gapMs = 60000 } = {}) {
  let stack = []                 // [{ n, src, before, after, at }] oldest first
  let marked = true, seq = 0
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  const topFor = src => { for (let i = stack.length - 1; i >= 0; i--) if (stack[i].src === src) return i; return -1 }
  return {
    note(src, before, after, now = Date.now()) {
      if (!src || same(before, after)) return
      const i = topFor(src), top = stack[i]
      if (top && !marked && i === stack.length - 1 && now - top.at < gapMs && same(top.after, before)) {
        top.after = after; top.at = now
      } else {
        stack.push({ n: ++seq, src, before, after, at: now })
        if (stack.length > max) stack.shift()
      }
      marked = false
    },
    mark() { marked = true },
    size: src => stack.filter(e => e.src === src).length,
    peek: src => { const i = topFor(src); return i < 0 ? null : stack[i] },
    pop(src) { const i = topFor(src); return i < 0 ? null : stack.splice(i, 1)[0] },
    rename(from, to) { for (const e of stack) if (e.src === from) e.src = to },
  }
}

module.exports = { editFacts, systemPrompt, contextHeader, planState, plainDashes, suggestions, changedIds, anyChange, revert, createUndo, undoSummary,
  askSpec, proposalSpec, askResult, proposalResult, settleLine, ASK_MS, PROPOSE_MS }
