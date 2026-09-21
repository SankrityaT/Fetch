// Version history for one take: every settled state of its edit, who made it, and
// what changed, kept across sessions and restorable.
//
// Session undo (ui/editor.js edHistory) lives in memory and dies with the window, and
// the agent's undo (ui/edit-assist.js createUndo) only knows the agent's own bursts.
// Neither can answer "what did this look like on Tuesday, before Claude re-cut it".
// This can, and it builds on both rather than beside them: what changed is said with
// edit-assist's changedIds, a restore keeps the id counter moving forward the way
// edit-assist's revert does, and `by` means what it means in the activity log (a
// name is an agent, null is the person).
//
// The one rule: a restore is a new version. Nothing is ever rewound, so the versions
// ahead of the one restored stay exactly where they were, and restoring is itself
// undoable by restoring the version before it.
//
// Storage is a sidecar per take, `.fetch/<stem>.history.jsonl`, append-only for the
// same reason the activity log is: a crash mid-write costs a line, not the file. A
// line is a whole document every KEY_EVERY versions and otherwise only the top-level
// fields that changed, so a thousand versions of a zoom being nudged cost a thousand
// copies of the zoom list and not a thousand copies of the captions.
//
// Pure: no Electron, no DOM. The filesystem is handed in (createLog's io), so
// test/history.test.js drives all of it under plain node.

const path = require('path')
const EditAssist = require('./edit-assist')

const EXT = '.history.jsonl'
// A whole document once the deltas since the last one add up to its size, and at least
// every KEY_EVERY lines. Opening any version is one whole document and at most that
// many shallow merges, well under a millisecond; the disk pays for a document about
// once per document's worth of change rather than once every fifty versions.
const KEY_EVERY = 200
const GAP_MS = 20000           // the person's edits settle into one version after this much quiet

// What is kept, and for how long. Everything from the last week; one a day for three
// months before that; one a week before that, for as long as the take exists. The
// first version, a restore, and the version just before an agent's change are kept
// whatever their age, because those are the ones anyone comes back for.
const POLICY = {
  allMs: 7 * 864e5,
  dailyMs: 90 * 864e5,
  cap: 1000,                   // versions per take; past it, bursts collapse first
  burstMs: 5 * 60000,          // one author's run of versions this close is one burst
  maxBytes: 16 * 1024 * 1024,  // per take; past it, thinning runs even inside the week
}

// Facts about the recording rather than choices about its edit. A restore takes the
// edit from the old version and these from now: a take renamed since keeps its new
// path, and a simulator's screen rectangle written after the fact is not unwritten.
const FACTS = ['v', 'kind', 'id', 'src', 'dur', 'w', 'h', 'device', 'viewport', 'source']

const arr = v => Array.isArray(v) ? v : []
const clone = x => x === undefined ? undefined : JSON.parse(JSON.stringify(x))

// Key order is not meaning. A document rebuilt from deltas holds its keys in a
// different order from the one the editor hands over, and they are the same edit.
function canon(x) {
  if (Array.isArray(x)) return '[' + x.map(canon).join(',') + ']'
  if (x && typeof x === 'object') {
    return '{' + Object.keys(x).filter(k => x[k] !== undefined).sort()
      .map(k => JSON.stringify(k) + ':' + canon(x[k])).join(',') + '}'
  }
  return JSON.stringify(x === undefined ? null : x)
}
const same = (a, b) => canon(a) === canon(b)

// Mirrors processor.js sidecarPath, so the history rides with its take through a
// rename and into the Trash once SIDE_EXT lists it.
const historyPath = src => path.join(path.dirname(src), '.fetch', path.basename(src).replace(/\.[^.]+$/, '') + EXT)

const vid = n => 'V' + n
// only the first letter: the rest holds ids, and Z1 is not z1
const lower = s => s.charAt(0).toLowerCase() + s.slice(1)

// ── what changed ────────────────────────────────────────────────────────
// A row has to say what moved in one line a person can check against the timeline,
// by the same ids the timeline draws. changedIds names new and changed items; a
// history also has to name what went.
function describe(before, after) {
  before = before || {}; after = after || {}
  const c = EditAssist.changedIds(before, after)
  const gone = k => {
    const now = new Set(arr(after[k]).map(x => x && x.id))
    return arr(before[k]).filter(x => x && x.id && !now.has(x.id)).map(x => x.id)
  }
  const was = k => new Set(arr(before[k]).map(x => x && x.id))
  const touched = {}, bits = []
  for (const k of ['zooms', 'marks', 'texts']) {
    const old = was(k)
    const added = c[k].filter(id => !old.has(id)), changed = c[k].filter(id => old.has(id)), removed = gone(k)
    if (added.length || changed.length || removed.length) touched[k] = { added, changed, removed }
    const ids = l => l.length > 4 ? `${l.slice(0, 3).join(', ')} and ${l.length - 3} more` : l.join(', ')
    if (added.length) bits.push(`added ${ids(added)}`)
    if (changed.length) bits.push(`changed ${ids(changed)}`)
    if (removed.length) bits.push(`removed ${ids(removed)}`)
  }
  if (c.clips) { touched.clips = true; bits.push('re-cut the clips') }
  if (c.cues.length) { touched.cues = c.cues.length; bits.push(c.cues.length === 1 ? 'edited a caption' : `edited ${c.cues.length} captions`) }
  // the look is one field to changedIds; a history names which part of it moved
  const L0 = before.look || {}, L1 = after.look || {}
  const sections = [...new Set([...Object.keys(L0), ...Object.keys(L1)])].filter(k => !same(L0[k], L1[k]))
  if (sections.length) { touched.look = sections; bits.push(`look: ${sections.slice(0, 4).join(', ')}${sections.length > 4 ? ' and more' : ''}`) }
  if (!same(before.crop, after.crop) || !same(before.cropAR, after.cropAR)) { touched.crop = true; bits.push('the crop') }
  if (!same(before.audio, after.audio) || !same(before.audioTrack, after.audioTrack)) { touched.audio = true; bits.push('the sound') }
  if (!same(before.camera, after.camera)) { touched.camera = true; bits.push('the camera') }
  if (!same(before.pointer, after.pointer)) { touched.pointer = true; bits.push('the cursor track') }
  if (!same(before.beats, after.beats)) { touched.beats = true; bits.push('the beats') }
  // anything else, named rather than hidden, so no change is ever described as none
  const known = new Set(['zooms', 'marks', 'texts', 'clips', 'cues', 'look', 'crop', 'cropAR', 'audio', 'audioTrack',
    'camera', 'pointer', 'beats', 'nextId', ...FACTS])
  const other = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(k => !known.has(k) && !same(before[k], after[k]))
  if (other.length) { touched.other = other; bits.push(other.join(', ')) }
  const line = bits.length ? bits.join('; ').replace(/^./, s => s.toUpperCase()) : 'No visible change'
  return { line, touched }
}

// ── encoding ────────────────────────────────────────────────────────────
// A field that appears is written even when canon calls it the same as absent: crop
// going from missing to null is no change to look at, but a version rebuilt without the
// key differs from the editor's document, and every open then logged a phantom change.
function delta(prev, doc) {
  const set = {}, del = []
  const had = k => Object.prototype.hasOwnProperty.call(prev, k) && prev[k] !== undefined
  for (const k of Object.keys(doc)) if (doc[k] !== undefined && (!had(k) || !same(prev[k], doc[k]))) set[k] = doc[k]
  for (const k of Object.keys(prev)) if (!(k in doc) || doc[k] === undefined) del.push(k)
  return { set, del }
}

// One line of the file. `from` names the version a delta applies to, so a missing
// line breaks one chain visibly instead of silently building the wrong document.
function encode(prev, doc, meta, keyframe) {
  const e = { n: meta.n, at: meta.at, by: meta.by == null ? null : String(meta.by), how: meta.how || 'edit' }
  if (meta.of != null) e.of = meta.of
  if (meta.merged) e.merged = meta.merged
  if (meta.also && meta.also.length) e.also = meta.also
  e.line = meta.line
  if (meta.touched && Object.keys(meta.touched).length) e.touched = meta.touched
  if (meta.missing && meta.missing.length) e.missing = meta.missing
  if (meta.files && Object.keys(meta.files).length) e.files = meta.files
  if (keyframe || !prev) e.doc = clone(doc)
  else {
    const d = delta(prev, doc)
    e.from = meta.from
    e.set = clone(d.set)
    if (d.del.length) e.del = d.del
    // a delta nearly as big as the document is a document that forgot to say so
    if (JSON.stringify(e.set).length > JSON.stringify(doc).length / 2) { delete e.from; delete e.set; delete e.del; e.doc = clone(doc) }
  }
  return e
}

// Torn lines are skipped, not fatal, exactly as the activity log reads its own.
function parse(text) {
  const out = []
  for (const l of String(text || '').split('\n')) {
    const s = l.trim()
    if (!s) continue
    try { const e = JSON.parse(s); if (e && Number.isFinite(e.n)) out.push(e) } catch {}
  }
  return out
}
const serialize = entries => entries.map(e => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : '')

// Every version's document, in order, as one pass from `start`, which has to be a
// whole document. A version whose chain is broken comes back null and is listed as
// unreadable rather than guessed at. Only the head of the chain is held, so walking a
// thousand versions costs one document of memory, not a thousand.
function* walk(entries, start = 0) {
  let last = null
  for (let i = start; i < entries.length; i++) {
    const e = entries[i]
    let doc = null
    if (e.doc) doc = e.doc
    else if (e.set && last && last.doc && e.from === last.n) {
      // shallow is enough: nothing here writes into a nested value, and the one caller
      // that hands a document out clones it first
      doc = { ...last.doc }
      for (const k of arr(e.del)) delete doc[k]
      Object.assign(doc, e.set)
    }
    last = { n: e.n, doc }
    yield { e, doc }
  }
}

// Start at the nearest whole document at or before n, so opening an old version reads
// at most KEY_EVERY lines of it however long the history is.
function materialize(entries, n) {
  const at = entries.findIndex(e => e.n === n)
  if (at < 0) return null
  let start = at
  while (start > 0 && !entries[start].doc) start--
  for (const { e, doc } of walk(entries, start)) if (e.n === n) return doc ? clone(doc) : null
  return null
}

// What a list shows: newest first, no documents, so a thousand rows cost nothing to draw.
function rows(entries) {
  return entries.slice().reverse().map(e => ({
    n: e.n, id: vid(e.n), at: e.at, by: e.by == null ? null : e.by, how: e.how || 'edit',
    of: e.of != null ? vid(e.of) : null, line: e.line || '', touched: e.touched || {},
    merged: e.merged || 0, also: e.also || [], missing: e.missing || [],
  }))
}

// ── what is kept ────────────────────────────────────────────────────────
const dayOf = t => Math.floor(t / 864e5)
const weekOf = t => Math.floor(t / (7 * 864e5))

// Two kinds of pin. The first and the newest version are kept whatever happens. A
// restore and the person's own state just before an agent took over are kept whatever
// their age while they are recent, then one a day and one a week like everything else,
// and they are the last to go when the cap is hit: kept forever, an agent-heavy take
// kept every one of them, and 61 alternating versions sat at six times the byte bound.
function pinned(entries) {
  const hard = new Set(), soft = new Set()
  if (entries.length) { hard.add(entries[0].n); hard.add(entries[entries.length - 1].n) }
  entries.forEach((e, i) => {
    if (e.how === 'restore') soft.add(e.n)
    // the person's own state just before an agent took over is what "put it back" means
    if (e.by && i > 0 && !entries[i - 1].by) soft.add(entries[i - 1].n)
  })
  return { hard, soft, has: n => hard.has(n) || soft.has(n) }
}

// Which versions survive, as a set of n. Age thinning first, then the caps: bursts
// collapse oldest first, then the oldest plain versions go, then the oldest soft pins.
// The count cap may reach inside the week; the byte bound never does past the bursts,
// since a week of a person correcting captions is exactly what a history is for.
// `bytes` is the file's size now, and each version's own line is subtracted as it goes,
// so the bound is measured rather than guessed: scaled by count, a take whose file
// passed 16 MB lost every unpinned version, this week's included.
function plan(entries, now, policy = POLICY, bytes = 0) {
  const P = { ...POLICY, ...policy }
  const pin = pinned(entries)
  const keep = new Set()
  const lastOfBucket = new Map(), lastPinOfBucket = new Map()
  for (const e of entries) {
    const age = now - e.at
    if (age <= P.allMs || pin.hard.has(e.n)) { keep.add(e.n); continue }
    const bucket = age <= P.dailyMs ? 'd' + dayOf(e.at) : 'w' + weekOf(e.at)
    lastOfBucket.set(bucket, e.n)           // entries are in order, so the last one wins
    if (pin.soft.has(e.n)) lastPinOfBucket.set(bucket, e.n)
  }
  for (const n of lastOfBucket.values()) keep.add(n)
  for (const n of lastPinOfBucket.values()) keep.add(n)

  const size = new Map(entries.map(e => [e.n, JSON.stringify(e).length + 1]))
  let left = bytes ? bytes - entries.filter(e => !keep.has(e.n)).reduce((a, e) => a + size.get(e.n), 0) : 0
  const drop = n => { if (keep.delete(n)) left -= size.get(n) }
  const overCount = () => keep.size > P.cap
  const overBytes = () => bytes > 0 && left > P.maxBytes && keep.size > 2
  const over = () => overCount() || overBytes()
  if (!over()) return keep
  // A burst is one author's run of versions close together: an agent nudging a zoom
  // forty times, a person dragging a slider. Only its last state matters to anyone.
  const kept = entries.filter(e => keep.has(e.n))
  for (let i = 0; i < kept.length - 1 && over(); i++) {
    const a = kept[i], b = kept[i + 1]
    if (pin.has(a.n) || a.how !== 'edit' || b.how !== 'edit') continue
    if ((a.by || null) === (b.by || null) && b.at - a.at <= P.burstMs) drop(a.n)
  }
  const old = e => now - e.at > P.allMs
  for (const pass of [e => !pin.has(e.n), e => pin.soft.has(e.n) && !pin.hard.has(e.n)]) {
    for (const e of entries) {
      if (!keep.has(e.n) || !pass(e)) continue
      if (overCount()) drop(e.n)
      else if (overBytes() && old(e)) drop(e.n)
      else if (!over()) break
    }
  }
  return keep
}

// The file rewritten to hold only `keep`. A kept version now follows a different
// parent, so its line is said again against the version before it, and the authors
// of the versions folded into it are named, so thinning never loses who did what.
function compact(entries, keep, keyEvery = KEY_EVERY) {
  const out = []
  let prev = null, sinceKey = 0, deltaBytes = 0, folded = 0, authors = new Set()
  for (const { e, doc } of walk(entries)) {
    if (!keep.has(e.n) || !doc) {
      if (doc) { folded++; if (e.by) authors.add(e.by) }
      continue
    }
    const meta = { ...e }
    if (folded) {
      const d = describe(prev && prev.doc, doc)
      meta.line = d.line; meta.touched = d.touched
      meta.merged = (e.merged || 0) + folded
      meta.also = [...new Set([...(e.also || []), ...authors])].filter(a => a !== e.by)
    }
    meta.from = prev && prev.n
    const key = !prev || ++sinceKey >= keyEvery || deltaBytes >= JSON.stringify(doc).length
    if (key) { sinceKey = 0; deltaBytes = 0 }
    const line = encode(prev && prev.doc, doc, meta, key)
    if (!line.doc) deltaBytes += JSON.stringify(line).length
    out.push(line)
    prev = { n: e.n, doc }
    folded = 0; authors = new Set()
  }
  return out
}

// ── restoring ───────────────────────────────────────────────────────────
// Files an edit points at that live outside it. Any may be gone since the version
// was made: a camera take trashed, a music file moved, an image on an unplugged disk.
function fileRefs(doc) {
  const refs = []
  const d = doc || {}
  if (d.camera && d.camera.file) refs.push({ field: 'camera', file: d.camera.file, what: 'camera take' })
  if (d.audioTrack && d.audioTrack.file) refs.push({ field: 'audioTrack', file: d.audioTrack.file, what: 'sound track' })
  const bg = d.look && d.look.background
  if (bg && typeof bg.image === 'string' && path.isAbsolute(bg.image)) refs.push({ field: 'look.background', file: bg.image, what: 'background image' })
  if (typeof d.backdropFile === 'string' && d.backdropFile) refs.push({ field: 'backdropFile', file: d.backdropFile, what: 'background image' })
  if (typeof d.src === 'string' && d.src) refs.push({ field: 'src', file: d.src, what: 'recording' })
  return refs
}

// Which file each reference was when the version was made, so a file rewritten in place
// (voiceover writes one .vo.mp3 per take) is not taken for the one the version used.
function identities(doc, stat) {
  if (typeof stat !== 'function') return null
  const out = {}
  for (const r of fileRefs(doc)) {
    if (r.field === 'src') continue
    try { const s = stat(r.file); if (s) out[r.field] = { file: r.file, size: s.size, mtime: Math.round(s.mtime) } } catch {}
  }
  return out
}

// Where a file inside the take's own folder went when the take was renamed: the same
// place under the new folder, the old name swapped for the new one where it carried it.
// The way processor.js repointSidecars follows a rename, for paths only history holds.
function relocate(file, fromSrc, toSrc) {
  if (!file || !fromSrc || !toSrc || fromSrc === toSrc) return []
  const root = src => (path.basename(path.dirname(src)) === 'Original' ? path.dirname(path.dirname(src)) : path.dirname(src))
  const stem = src => path.basename(src).replace(/\.[^.]+$/, '')
  const r0 = root(fromSrc), r1 = root(toSrc)
  if (!file.startsWith(r0 + path.sep)) return []
  const rel = file.slice(r0.length)
  const out = [r1 + rel]
  const base = path.basename(rel), s0 = stem(fromSrc), s1 = stem(toSrc)
  if (base.startsWith(s0)) out.unshift(path.join(r1, path.dirname(rel), s1 + base.slice(s0.length)))
  return out
}

// The document a restore writes. The edit comes from the version; the facts about the
// recording come from now; the id counter never goes backwards, or "Z3" in the
// activity log would name two zooms. A file the version points at that is gone is not
// restored as a dangling path: that one part stays as it is now and the result says so.
// The version itself keeps the path, so if the file comes back, restoring again finds it.
function forRestore(version, current, exists = () => true, { files = null, stat = null } = {}) {
  const doc = clone(version) || {}
  current = current || {}
  const fromSrc = version && version.src
  for (const k of FACTS) {
    if (current[k] !== undefined) doc[k] = clone(current[k])
    else if (k in doc && !(k in current) && k !== 'v') delete doc[k]
  }
  if (version && (version.nextId || current.nextId)) {
    doc.nextId = { ...(version.nextId || {}) }
    for (const [k, v] of Object.entries(current.nextId || {})) doc.nextId[k] = Math.max(doc.nextId[k] || 1, v)
  }
  const missing = []
  const put = (field, file) => {
    if (field === 'camera') doc.camera = { ...doc.camera, file }
    else if (field === 'audioTrack') doc.audioTrack = { ...doc.audioTrack, file }
    else if (field === 'look.background') doc.look = { ...doc.look, background: { ...doc.look.background, image: file } }
    else if (field === 'backdropFile') doc.backdropFile = file
  }
  for (const r of fileRefs(doc)) {
    if (r.field === 'src') continue
    let file = r.file
    // a take renamed since: its own files moved with it
    if (!exists(file)) {
      const moved = relocate(file, fromSrc, doc.src).find(f => exists(f))
      if (moved) { put(r.field, moved); file = moved }
    }
    // there, but not the file it was: rewritten in place since the version was made
    const was = files && files[r.field]
    let changed = false
    if (exists(file) && was && typeof stat === 'function') {
      try { const s = stat(file); changed = !!s && (s.size !== was.size || Math.round(s.mtime) !== was.mtime) } catch {}
    }
    if (exists(file) && !changed) continue
    missing.push({ field: r.field, file: r.file, what: r.what, ...(changed ? { changed: true } : {}) })
    if (r.field === 'camera') doc.camera = clone(current.camera) || null
    else if (r.field === 'audioTrack') doc.audioTrack = clone(current.audioTrack) || null
    else if (r.field === 'look.background') doc.look = { ...doc.look, background: clone(current.look && current.look.background) || { kind: 'gradient', gradient: 'dusk' } }
    else if (r.field === 'backdropFile') { doc.backdropFile = current.backdropFile || null; doc.backdrop = current.backdrop || null }
  }
  return { doc, missing }
}

const missingLine = missing => missing.length
  ? ` The ${[...new Set(missing.map(m => m.what))].join(' and ')} it used ${missing.length === 1 ? 'is' : 'are'} ` +
    `${missing.every(m => m.changed) ? 'not the same file any more' : missing.some(m => m.changed) ? 'gone or changed since' : 'gone'}, ` +
    `so ${missing.length === 1 ? 'that part stays' : 'those parts stay'} as it is now.`
  : ''

// ── the log ─────────────────────────────────────────────────────────────
// One take's history, live. io is { read() -> string, append(text), replace(text) };
// ui/autosave.js hands it the sidecar, the test hands it a string.
//
// Person and agent at once: the renderer runs one thing at a time, so two edits never
// truly land together, but the person's edits are held open for GAP_MS to settle a drag
// into one version. When an agent's change arrives, whatever the person had pending is
// closed first, as their own version, and only then is the agent's recorded against the
// state it actually started from. Neither is ever folded into the other's name.
function createLog({ io, now = () => Date.now(), gapMs = GAP_MS, keyEvery = KEY_EVERY, policy = POLICY, compactEvery = 200, stat = null } = {}) {
  let entries = [], head = null, pending = null, sinceKey = 0, appended = 0, broken = false, torn = false, deltaBytes = 0

  const bytes = () => { try { return String(io.read() || '').length } catch { return 0 } }

  function commit(doc, meta) {
    if (!doc) return null
    if (head && same(head.doc, doc)) return null
    const d = describe(head && head.doc, doc)
    const n = (entries.length ? entries[entries.length - 1].n : 0) + 1
    // after a torn or broken file, the next line stands on its own
    const key = !head || broken || ++sinceKey >= keyEvery || deltaBytes >= JSON.stringify(doc).length
    if (key) { sinceKey = 0; deltaBytes = 0; broken = false }
    const e = encode(head && head.doc, doc, {
      n, at: now(), by: meta.by, how: meta.how, of: meta.of, missing: meta.missing,
      line: meta.line || (head ? d.line : 'The edit as history first saw it'), touched: head ? d.touched : {},
      from: head && head.n, files: identities(doc, stat),
    }, key)
    // a torn tail has no newline, and the next line appended onto it would be torn too
    const text = JSON.stringify(e)
    // A line that did not reach the disk is not a version: the next one would be a delta
    // against a parent the file never held, and read back as unreadable. So it is not
    // kept, the change rides into the next version, and that one is written whole.
    if (io.append((torn ? '\n' : '') + text + '\n') === false) {
      broken = true; torn = true
      return null
    }
    if (!e.doc) deltaBytes += text.length
    torn = false
    entries.push(e)
    head = { n, doc: clone(doc) }
    if (++appended >= compactEvery) tidy()
    return rows([e])[0]
  }

  // close the person's open version, if its state is not already the head
  function settle(upTo) {
    const doc = upTo || (pending && pending.doc)
    pending = null
    if (doc && head && !same(head.doc, doc)) return commit(doc, { by: null, how: 'edit' })
    return null
  }

  const filesOf = n => { const e = entries.find(x => x.n === n); return (e && e.files) || null }

  function tidy() {
    appended = 0
    const keep = plan(entries, now(), policy, bytes())
    if (keep.size === entries.length) return false
    const next = compact(entries, keep, keyEvery)
    io.replace(serialize(next))
    torn = false
    entries = next
    sinceKey = 0; deltaBytes = 0
    // the rewrite may have ended on a delta; the next line is said whole to be safe
    broken = true
    return true
  }

  return {
    // Read the file and line it up with the document the editor just loaded. A
    // document that differs from the last version was changed where history could not
    // see it (a crash before the person's edits settled, or a tool writing the file
    // with the editor closed), and it is recorded as that, unattributed, rather than
    // credited to anyone.
    open(doc) {
      const text = String(io.read() || '')
      torn = !!text && !text.endsWith('\n')
      entries = parse(text)
      head = null; pending = null; sinceKey = 0; appended = 0
      let lastGood = null
      deltaBytes = 0
      for (const { e, doc: d } of walk(entries)) {
        if (d) lastGood = { n: e.n, doc: d }
        sinceKey = e.doc ? 0 : sinceKey + 1
        deltaBytes = e.doc ? 0 : deltaBytes + JSON.stringify(e).length
      }
      const tail = entries[entries.length - 1]
      broken = !!(tail && (!lastGood || lastGood.n !== tail.n))
      head = lastGood
      if (!entries.length) return commit(doc, { by: null, how: 'start' })
      if (doc && head && !same(head.doc, doc)) return commit(doc, { by: null, how: 'outside', line: 'Changed while history was not watching: ' + lower(describe(head.doc, doc).line) })
      if (doc && !head) return commit(doc, { by: null, how: 'outside', line: 'The edit as found, after an unreadable history' })
      return null
    },
    // The person's hand, seen on each autosave tick. Held open until quiet.
    person(doc) {
      if (!doc) return null
      if (pending && same(pending.doc, doc)) return null
      if (!pending && head && same(head.doc, doc)) return null
      pending = { doc: clone(doc), last: now() }
      return null
    },
    tick() {
      if (pending && now() - pending.last >= gapMs) return settle()
      return null
    },
    flush: () => settle(),
    // An agent's change: before is what it started from, after what it left.
    agent(before, after, by) {
      const mine = settle(before)
      const theirs = commit(after, { by: by || 'Agent', how: 'edit' })
      return { mine, theirs }
    },
    // An agent's change taken back, by whoever pressed it.
    undo(before, after, by) {
      settle(before)
      return commit(after, { by: by == null ? null : by, how: 'undo' })
    },
    // Restore version n on top of `current`. Returns the document to load and the row
    // it became, or null for a version that cannot be read.
    restore(n, current, { exists, by = null } = {}) {
      const v = materialize(entries, n)
      if (!v) return null
      settle(current)
      const { doc, missing } = forRestore(v, current || (head && head.doc), exists, { files: filesOf(n), stat })
      if (head && same(head.doc, doc)) return { doc, row: null, missing, same: true, line: `The edit already matches ${vid(n)}.` }
      const d = describe(head && head.doc, doc)
      const row = commit(doc, { by, how: 'restore', of: n, missing, line: `Restored ${vid(n)}: ${lower(d.line)}` })
      return { doc, row, missing, same: false, line: `Restored ${vid(n)}.${missingLine(missing)}` }
    },
    version: n => materialize(entries, n),
    // what restoring n would bring back, without writing anything (a look)
    forRestore: (n, current, exists) => {
      const v = materialize(entries, n)
      return v ? forRestore(v, current, exists, { files: filesOf(n), stat }) : null
    },
    // The file moved under us (a take renamed while open): whatever it held, the next
    // line stands on its own, so it can be read without the lines before it
    rebase: () => { broken = true; torn = true },
    rows: () => rows(entries),
    head: () => head && { n: head.n, doc: clone(head.doc) },
    pending: () => !!pending,
    tidy,
    size: () => entries.length,
  }
}

module.exports = {
  EXT, KEY_EVERY, GAP_MS, POLICY, FACTS, historyPath, vid, canon, same, describe, encode, parse, serialize,
  materialize, rows, plan, compact, fileRefs, forRestore, missingLine, createLog, relocate, identities,
}
