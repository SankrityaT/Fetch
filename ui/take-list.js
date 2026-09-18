// How the Library reads: takes, not files. Groups what listRecordings returns into one
// card per take, and names the card and each export on it for a person rather than
// echoing file names.
//
// Pure: no filesystem, no DOM. ui/app.js draws what this returns.

const path = require('path')

// Loose takes from before take folders have their exports beside them, named after
// them: name-edit.mp4, name-cut.mp4 and so on.
const DERIVED = /-(edit|cut|audio|trim|captions|converted|gif)$/

// A take folder groups itself: the raw take in Original/ is the original, and the
// deliverable on top plus any working versions are its exports. Loose takes group by
// name within their own folder, so a demo.mp4 on the Desktop and another somewhere
// else stay two takes.
function groupTakes(list) {
  const byBase = new Map(), seen = new Set()
  for (const c of list) {
    if (seen.has(c.path)) continue
    seen.add(c.path)
    const stem = c.name.replace(/\.[^.]+$/, '')
    const base = c.take ? 'take:' + c.take : path.dirname(c.path) + path.sep + stem.replace(DERIVED, '')
    if (!byBase.has(base)) byBase.set(base, { base, take: c.take || null, original: null, derived: [], copy: null })
    const g = byBase.get(base)
    // the unedited MP4 autoConvertMp4 left on top is the take itself, not an export
    if (c.copy) g.copy = c
    else if (c.deliverable) g.derived.unshift(c)     // the finished video reads first
    else if (DERIVED.test(stem)) g.derived.push(c)
    else if (!g.original || c.mtime > g.original.mtime) {
      if (g.original) g.derived.push(g.original)
      g.original = c
    } else g.derived.push(c)
  }
  // a derived file whose original was deleted still deserves a card
  for (const g of byBase.values()) {
    if (!g.original && g.derived.length) g.original = g.derived.shift()
    if (!g.original && g.copy) { g.original = g.copy; g.copy = null }
  }
  return [...byBase.values()].filter(g => g.original)
    .sort((a, b) => b.original.mtime - a.original.mtime)
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// Takes used to be named recording-<ms since 1970>. The number is when it was
// recorded, which is worth reading; the digits are not. "Recording, Sep 17, 6:54 PM",
// with the year only when it is not this one. Null for any other name.
function legacyTitle(stem, now = new Date()) {
  const m = /^recording-(\d{12,14})$/i.exec(String(stem || ''))
  if (!m) return null
  const d = new Date(+m[1])
  if (isNaN(d) || d.getFullYear() < 2015 || d.getFullYear() > 2100) return null
  const h = d.getHours() % 12 || 12
  const time = `${h}:${String(d.getMinutes()).padStart(2, '0')} ${d.getHours() < 12 ? 'AM' : 'PM'}`
  const year = d.getFullYear() !== now.getFullYear() ? ` ${d.getFullYear()},` : ','
  return `Recording, ${MONTHS[d.getMonth()]} ${d.getDate()}${year} ${time}`
}

// The name a card shows: the take folder's, or the loose file's, readable either way
function takeTitle(g, now) {
  const stem = g.take ? path.basename(g.take) : g.original.name.replace(/\.[^.]+$/, '')
  // a card whose original was deleted is headed by an export, still the same take;
  // "recording-policy-demo" was a default prefix plus a name, and the name is the title
  return legacyTitle(stem.replace(DERIVED, ''), now) || stem.replace(/^recording-(?=.)/i, '')
}

// Where a loose take lives, so two cards that read the same can be told apart. A take
// folder is in the Fetch folder by definition and needs no hint. The folders everyone
// knows read by name; anywhere else is a short path, since a bare "nt" for /tmp/nt
// says nothing.
const KNOWN = ['Desktop', 'Downloads', 'Documents', 'Movies']
function takeWhere(g, home = require('os').homedir()) {
  if (g.take) return ''
  const dir = path.dirname(g.original.path)
  if (path.dirname(dir) === home && KNOWN.includes(path.basename(dir))) return path.basename(dir)
  const rel = dir === home ? '~' : dir.startsWith(home + path.sep) ? '~' + dir.slice(home.length) : dir
  const parts = rel.split(path.sep).filter(Boolean)
  return parts.length > 3 ? '…/' + parts.slice(-2).join('/') : rel
}

// The rows under a card: its exports, then the unedited MP4 copy of a take folder,
// which is not an export but is a file a person goes looking for.
function takeRows(g) {
  return g.copy ? [...g.derived, g.copy] : g.derived
}

const WORKING = { cut: 'Dead air removed', audio: 'Cleaned audio', trim: 'Trimmed', captions: 'Captioned', gif: 'GIF export' }

// What an export row is, in words: "Export", "MP4 copy", "Dead air removed". The file
// name says where it is; the row says what it is.
function exportLabel(d, g) {
  const ext = String(d.ext || path.extname(d.name).slice(1)).toUpperCase()
  const stem = d.name.replace(/\.[^.]+$/, '')
  const tag = (stem.match(DERIVED) || [])[1]
  if (d.copy) return `${ext} copy`
  if (d.deliverable || tag === 'edit') return ext === 'MP4' ? 'Export' : `${ext} export`
  if (tag === 'converted') return `${ext} copy`
  if (tag) return WORKING[tag]
  // the same take in another container, or an older take of the same name
  const own = g && g.original && g.original.name.replace(/\.[^.]+$/, '')
  if (own && stem === own) return `${ext} copy`
  return legacyTitle(stem) || stem
}

// The Library's masonry, as columns the cards are dealt into in turn. CSS columns fill
// one column top to bottom before starting the next, so the top row read as a mix of
// ages ("just now", then a take from hours ago). Dealt across, the newest takes make
// the top row and each column still runs newest first. Column count follows the old
// rule: as many 290px columns as fit, gap included, never more than four.
function libraryColumns(width, min = 290, gap = 16, max = 4) {
  return Math.max(1, Math.min(max, Math.floor((width + gap) / (min + gap)) || 1))
}
function dealColumns(items, n) {
  const cols = Array.from({ length: Math.max(1, n) }, () => [])
  items.forEach((it, i) => cols[i % cols.length].push(it))
  return cols
}

module.exports = { DERIVED, groupTakes, legacyTitle, takeTitle, takeWhere, takeRows, exportLabel, libraryColumns, dealColumns }
