// The chat and the editor working on one take: what the agent is told about the edit
// each turn, which edits to offer, what an agent's change touched, and how to take it
// back. Pure, no DOM and no Electron, so test/assist.test.js runs it under plain node.

const arr = v => Array.isArray(v) ? v : []
const clock = s => `${Math.floor((+s || 0) / 60)}:${String(Math.round((+s || 0) % 60)).padStart(2, '0')}`
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`

// Counts, not contents: enough for the agent to know what exists and for the chips to
// know what is missing, without putting a transcript into every prompt.
function editFacts(doc) {
  doc = doc || {}
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
    burnCaps: !!(doc.look && doc.look.burnCaps),
    backdrop: doc.backdrop || null,
    outAspect: doc.outAspect || null,
    autoZoom: !!doc.autoZoom,
  }
}

const ids = list => list.length ? ` (${list.slice(0, 8).join(', ')}${list.length > 8 ? ', ...' : ''})` : ''

// Sent at the top of every turn. A resumed session remembers what an earlier turn
// said about "the latest recording", and twice answered from that memory after a new
// take had landed. So every turn restates the present and says plainly that the past
// is stale. The newest recording is deliberately not named: when it was, the model
// took it as the answer and never read the library, so a take that landed a moment
// later, or one renamed or deleted meanwhile, went unseen. Only list_recordings is
// current by construction.
function contextHeader({ open, omitted } = {}) {
  const lines = ['<fetch_context>', 'Current as of this message.']
  if (open && open.path) {
    lines.push(`Open in the Fetch editor: ${open.path}${open.dur ? ` (${clock(open.dur)})` : ''}.`)
    // no document while the take is still loading: counts from a blank edit would be wrong
    if (open.doc) {
      const f = editFacts(open.doc)
      const cap = f.captions
        ? `captions: yes, ${plural(f.captions, 'line')}${f.burnCaps ? ', burned in on export' : ', not burned in'}`
        : 'captions: none yet'
      lines.push(`Its edit right now: ${plural(f.clips, 'clip')}, ${plural(f.zooms, 'zoom')}${ids(f.zoomIds)}, ` +
        `${plural(f.marks, 'mark')}${ids(f.markIds)}, ${plural(f.texts, 'text')}${ids(f.textIds)}, ${cap}` +
        `${f.outAspect ? `, output aspect ${f.outAspect}` : ''}${f.backdrop ? `, backdrop ${f.backdrop}` : ''}.`)
    } else lines.push('Its edit is still loading; read it with get_edit.')
    lines.push('"This", "it" or no named recording means the one open in the editor.')
    // A small model asked for scale and centre twice before adding a plain "zoom on
    // the first two seconds". Every edit can be undone, so acting beats asking.
    lines.push('For an edit, fill anything the person left out with a sensible default and make ' +
      'the change, rather than asking; they can see it and undo it.')
  } else if (omitted) {
    lines.push('The person left the recording open in the editor out of this message, so do not assume it.')
  } else {
    lines.push('No recording is open in the editor.')
  }
  lines.push('Recordings and edits change between messages: takes are recorded, renamed and deleted, ' +
    'and the person edits by hand. Do not trust what an earlier turn said about them. ' +
    'Before acting, read the current state with list_recordings or get_edit. ' +
    'Any question or request about which recordings exist, or about the latest, last or newest one, ' +
    'needs a fresh list_recordings call in this turn, even if an earlier turn already answered it; ' +
    'the newest is the first take it lists. ' +
    'Name the recording you acted on in your reply.')
  // The brand writes no em dashes, and models reach for them by default
  lines.push('Write replies in short plain sentences. Never use an em dash; use a comma, colon, ' +
    'full stop or parentheses instead.')
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
const MARK_NOUN = { step: 'step badge', spotlight: 'spotlight', blur: 'blur', redact: 'blur', arrow: 'arrow' }
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

module.exports = { editFacts, contextHeader, plainDashes, suggestions, changedIds, anyChange, revert, createUndo, undoSummary }
