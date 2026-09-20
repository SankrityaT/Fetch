// Fetch: the Library, which holds two kinds.
//
// A screenshot is a take of one frame, so the library that lists takes lists shots as
// well, and nobody has to learn a file format to use it: a styled screenshot is still a
// screenshot, an edited take is still a recording. The kind is read off what was
// captured (`kind`, else the original's extension), never off what was exported, so
// styling a shot or cutting a take never moves it to the other side of the library.
//
// This file also holds the virtual folders, which never move or copy files, they only
// group existing paths. Storage lives outside the repo, in
// ~/Library/Application Support/Fetch/collections.json, since the renderer has no access
// to electron.app to ask Electron for that path itself.
//
// Pure where it can be: kindOf, platformOf, filterGroups, byDay, infoRows and
// countLabel are plain functions over what list-recordings returned, and test/
// library.test.js drives them under node with no DOM at all.
//
// Required from ui/app.js (which already runs with node integration); it injects its
// own stylesheet so control.html never has to change.

const fs = require('fs')
const os = require('os')
const path = require('path')

// Outside the renderer (a test, a headless tool) there is no window to draw into and no
// right to rewrite the person's folders: read nothing of theirs, write nothing of theirs.
const headless = typeof document === 'undefined'

// ── stylesheet, injected once ─────────────────────────────────────────────
if (!headless) {
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = './ui/library.css'
  document.head.appendChild(link)
}

// ── storage ────────────────────────────────────────────────────────────────
const DIR = path.join(os.homedir(), 'Library', 'Application Support', 'Fetch')
const FILE = path.join(DIR, 'collections.json')

function load() {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    if (data && Array.isArray(data.folders)) return data
  } catch {}
  return { folders: [] }
}
function save() {
  if (headless) return
  try {
    fs.mkdirSync(DIR, { recursive: true })
    fs.writeFileSync(FILE, JSON.stringify(state, null, 2))
  } catch (e) { console.error('Fetch: could not save collections.json', e) }
}

let state = headless ? { folders: [] } : load()

// What the grid is showing. The folder is one of four filters now, so it keeps its own
// name rather than standing for the whole view.
let view = { folder: 'all', kind: 'all', platform: 'all', query: '', sort: 'new' }
let lastGroups = []          // the last set drawn, so a card's ⓘ can find its neighbours

const genId = () => 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
const findFolder = id => state.folders.find(f => f.id === id)
const foldersFor = p => state.folders.filter(f => f.paths.includes(p))

function addFolder(name) {
  const f = { id: genId(), name: (name || '').trim() || 'New folder', paths: [] }
  state.folders.push(f)
  save()
  return f
}
function renameFolder(id, name) {
  const f = findFolder(id); if (!f) return
  const clean = (name || '').trim()
  if (clean) f.name = clean
  save()
}
function deleteFolder(id) {
  state.folders = state.folders.filter(f => f.id !== id)
  if (view.folder === id) view.folder = 'all'
  save()
}
function toggleMember(id, filePath) {
  const f = findFolder(id); if (!f) return false
  const i = f.paths.indexOf(filePath)
  if (i === -1) f.paths.push(filePath); else f.paths.splice(i, 1)
  save()
  return i === -1   // true if it just became a member
}
// called when a take is deleted, so folders never hold onto dead paths
function forgetPath(filePath) {
  let changed = false
  for (const f of state.folders) {
    const i = f.paths.indexOf(filePath)
    if (i !== -1) { f.paths.splice(i, 1); changed = true }
  }
  if (changed) save()
}
// called when a clip is renamed, so folder membership follows the file to its new path
function renamePath(oldPath, newPath) {
  if (oldPath === newPath) return
  let changed = false
  for (const f of state.folders) {
    const i = f.paths.indexOf(oldPath)
    if (i !== -1) { f.paths[i] = newPath; changed = true }
  }
  if (changed) save()
}

// ── the two kinds ──────────────────────────────────────────────────────────
// A capture path that knows what it took says so (`kind`). Everything already in the
// library predates that and is read off its container instead.
const STILL_EXT = /^(png|jpe?g|jpeg|heic|heif|webp|tiff?|avif)$/i
const item = g => (g && g.original) || g || {}

function kindOf(g) {
  const c = item(g)
  if (c.kind === 'shot' || c.kind === 'take') return c.kind
  return STILL_EXT.test(String(c.ext || path.extname(c.name || '')).replace(/^\./, '')) ? 'shot' : 'take'
}
const isShot = g => kindOf(g) === 'shot'

// Platform is a tag so the Mac shot and the phone shot of one feature sit together.
// No brand names: a device frame here is a shape, not a make, and the tag has to stay
// true of a shot taken on a handset Fetch has never heard of.
const PLATFORMS = ['Mac', 'Phone', 'Tablet', 'Web']
const FRAME_PLATFORM = { browser: 'Web', window: 'Mac', laptop: 'Mac', desktop: 'Mac', phone: 'Phone', tablet: 'Tablet' }
function platformOf(g) {
  const c = item(g)
  const said = String(c.platform || '')
  const known = PLATFORMS.find(p => p.toLowerCase() === said.toLowerCase())
  if (known) return known
  const frame = FRAME_PLATFORM[String(c.device || c.frame || '').toLowerCase()]
  if (frame) return frame
  // Everything Fetch captures itself comes off this Mac. An import came from anywhere,
  // and guessing its platform from its shape would be a guess with a label on it.
  return c.imported ? null : 'Mac'
}
function platformsIn(groups) {
  const seen = []
  for (const g of groups || []) {
    const p = platformOf(g)
    if (p && !seen.includes(p)) seen.push(p)
  }
  return PLATFORMS.filter(p => seen.includes(p))
}

// ── tiny local helpers, kept self-contained ─────────────────────────────────
const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n }
const ico = (name, cls = 'icon-sm') => `<svg class="${cls}"><use href="./assets/icons/sprite.svg#i-${name}"/></svg>`
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`

// The name on a card, without reaching into ui/take-list.js: the take or shot folder,
// else the file's stem. Enough to sort and search by.
function stemOf(g) {
  const c = item(g)
  const box = g && (g.take || g.shot)
  return box ? path.basename(box) : String(c.name || '').replace(/\.[^.]+$/, '')
}

// ── sort and filter ────────────────────────────────────────────────────────
const SORTS = [
  ['new', 'Newest first'],
  ['old', 'Oldest first'],
  ['name', 'Name'],
  ['size', 'Largest'],
]
const byDate = sort => sort === 'new' || sort === 'old'

function sortGroups(list, sort = view.sort) {
  const out = list.slice()
  const at = g => item(g).mtime || 0
  const mb = g => Number(item(g).mb) || 0
  if (sort === 'old') out.sort((a, b) => at(a) - at(b))
  else if (sort === 'name') out.sort((a, b) => stemOf(a).localeCompare(stemOf(b), undefined, { numeric: true, sensitivity: 'base' }))
  else if (sort === 'size') out.sort((a, b) => mb(b) - mb(a))
  else out.sort((a, b) => at(b) - at(a))
  return out
}

function matches(g) {
  const f = view.folder === 'all' ? null : findFolder(view.folder)
  if (view.folder !== 'all' && (!f || !f.paths.includes(item(g).path))) return false
  if (view.kind !== 'all' && kindOf(g) !== view.kind) return false
  if (view.platform !== 'all' && platformOf(g) !== view.platform) return false
  const q = view.query.trim().toLowerCase()
  if (q && !stemOf(g).toLowerCase().includes(q)) return false
  return true
}

function filterGroups(groups) {
  // a folder deleted under the view falls back rather than showing nothing
  if (view.folder !== 'all' && !findFolder(view.folder)) view.folder = 'all'
  return sortGroups((groups || []).filter(matches))
}

// ── the gallery, grouped by day ────────────────────────────────────────────
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const midnight = d => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
const dayKey = ms => { const d = new Date(ms); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}` }

// "Today", "Yesterday", then the weekday while it is still this week, then the date.
// A heading is only worth a row if it says something a timestamp does not.
function dayLabel(ms, now = new Date()) {
  const d = new Date(ms)
  const days = Math.round((midnight(now) - midnight(d)) / 86400000)
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days > 1 && days < 7) return DAYS[d.getDay()]
  const year = d.getFullYear() !== now.getFullYear() ? ` ${d.getFullYear()}` : ''
  return `${MONTHS[d.getMonth()]} ${d.getDate()}${year}`
}

/**
 * The visible groups cut into days, newest day first, in the same order filterGroups
 * returned them. Sorted by name or size the runs would not be contiguous, so the
 * gallery is one unlabelled run instead: a day heading over a list that is not in day
 * order would be a lie.
 */
function byDay(groups, now = new Date(), sort = view.sort) {
  const list = groups || []
  if (!byDate(sort) || !list.length) return list.length ? [{ key: 'all', label: '', items: list }] : []
  const out = []
  for (const g of list) {
    const ms = item(g).mtime || 0
    const key = dayKey(ms)
    const last = out[out.length - 1]
    if (last && last.key === key) last.items.push(g)
    else out.push({ key, label: dayLabel(ms, now), items: [g] })
  }
  return out
}
// what dealInto needs: how many cards belong under each heading, in card order
const daySpans = (groups, now = new Date()) => byDay(groups, now).map(d => ({ key: d.key, label: d.label, n: d.items.length }))

// ── provenance ─────────────────────────────────────────────────────────────
// Any item can say what it was styled or cut from, what came out of it, how big it is
// and when. `from` is written by whoever made the derived item: { path, at } , where
// `at` is the second of the take the still was pulled from.
const stamp = (ms, now = new Date()) => {
  if (!ms) return ''
  const d = new Date(ms)
  const h = d.getHours() % 12 || 12
  const year = d.getFullYear() !== now.getFullYear() ? ` ${d.getFullYear()}` : ''
  return `${MONTHS[d.getMonth()]} ${d.getDate()}${year}, ${h}:${String(d.getMinutes()).padStart(2, '0')} ${d.getHours() < 12 ? 'AM' : 'PM'}`
}
const clock = s => {
  const t = Math.max(0, Math.round(Number(s) || 0))
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`
}
// Nothing in Fetch writes `from` yet: every derived file so far lives in its own take's
// folder, where the relationship is the folder. So the three provenance rows below are
// silent on every item today, and this is the one place to write when a path is added
// that makes a new library item out of an old one. Said in PRODUCT.md under Not built.
const sourceOf = g => { const c = item(g); return c.from || c.styledFrom || null }
const titleFor = (p, all) => {
  const hit = (all || []).find(g => item(g).path === p)
  return hit ? stemOf(hit) : path.basename(String(p || '')).replace(/\.[^.]+$/, '')
}

/**
 * The rows the ⓘ shows, as plain label and value pairs so the same facts can be read
 * by a test, by the panel, and by anything else that wants them.
 */
function infoRows(g, all = lastGroups, now = new Date()) {
  const c = item(g)
  const shot = isShot(g)
  const rows = [{ label: 'Kind', value: shot ? 'Screenshot' : 'Recording' }]
  const platform = platformOf(g)
  if (platform) rows.push({ label: 'Platform', value: platform })

  const src = sourceOf(g)
  if (src && src.path) {
    const at = src.at == null ? '' : `, at ${clock(src.at)}`
    rows.push({ label: shot ? 'Styled from' : 'Cut from', value: titleFor(src.path, all) + at, path: src.path })
  }
  const made = (all || []).filter(o => o !== g && (sourceOf(o) || {}).path === c.path)
  if (made.length) rows.push({ label: 'Used to make', value: made.map(o => stemOf(o)).join(', ') })

  if (c.width && c.height) rows.push({ label: 'Size', value: `${c.width} × ${c.height}` })
  const bytes = [c, ...((g && g.derived) || [])].reduce((n, f) => n + (Number(f.mb) || 0), 0)
  if (bytes) rows.push({ label: 'On disk', value: `${Math.round(bytes * 10) / 10} MB` })

  rows.push({ label: shot ? 'Captured' : 'Recorded', value: stamp(c.ctime || c.mtime, now) })
  const edited = ((g && g.derived) || []).reduce((n, f) => Math.max(n, f.mtime || 0), 0)
  if (edited && edited > (c.mtime || 0)) rows.push({ label: 'Last export', value: stamp(edited, now) })

  const owners = foldersFor(c.path)
  if (owners.length) rows.push({ label: owners.length === 1 ? 'Folder' : 'Folders', value: owners.map(f => f.name).join(', ') })
  return rows
}

// "3 shots · 2 takes", so the count says what kind of library this is
function countLabel(groups) {
  const list = groups || []
  const shots = list.filter(isShot).length
  const takes = list.length - shots
  if (shots && takes) return `${plural(shots, 'shot', 'shots')} · ${plural(takes, 'take', 'takes')}`
  if (shots) return plural(shots, 'shot', 'shots')
  return plural(takes, 'take', 'takes')
}

// ── generic scrim + modal, matches the pattern already used elsewhere in the app ──
function showScrim(bodyHtml, width) {
  const scrim = el('div', 'scrim')
  scrim.innerHTML = `<div class="modal" style="width:min(${width},92vw)">${bodyHtml}</div>`
  document.body.appendChild(scrim)
  const close = () => scrim.remove()
  scrim.querySelectorAll('[data-close]').forEach(b => b.onclick = close)
  scrim.onclick = e => { if (e.target === scrim) close() }
  return { scrim, close }
}

function promptFolderName({ title, value = '', confirmLabel, onConfirm }) {
  const { scrim, close } = showScrim(`
    <div class="modal-head">${ico('folder', 'icon-lg')}<span class="modal-title">${esc(title)}</span></div>
    <div class="modal-body"><input class="input" id="libFolderName" type="text" maxlength="60"
      placeholder="Folder name" value="${esc(value)}"></div>
    <div class="modal-foot"><div style="flex:1"></div>
      <button class="btn btn-sm" data-close>Cancel</button>
      <button class="btn btn-sm btn-primary" id="libFolderOk">${esc(confirmLabel)}</button>
    </div>`, '380px')
  const input = scrim.querySelector('#libFolderName')
  input.focus(); input.select()
  const commit = () => {
    const name = input.value.trim()
    if (!name) { input.focus(); return }
    close(); onConfirm(name)
  }
  scrim.querySelector('#libFolderOk').onclick = commit
  input.addEventListener('keydown', e => { if (e.key === 'Enter') commit() })
}

function confirmDeleteFolder(folder, onConfirm) {
  const { scrim, close } = showScrim(`
    <div class="modal-body" style="text-align:center;display:grid;gap:12px;justify-items:center">
      <img class="biscuit" src="./assets/mascot/sad.png" alt="" style="width:88px;height:88px">
      <h3 style="font-family:var(--font-display);font-size:var(--t-18);letter-spacing:-.03em">Delete "${esc(folder.name)}"?</h3>
      <p class="dim" style="font-size:var(--t-12)">The shots and recordings stay right where they are, this only removes the folder.</p>
    </div>
    <div class="modal-foot"><div style="flex:1"></div>
      <button class="btn btn-sm" data-close>Cancel</button>
      <button class="btn btn-sm btn-danger" id="libFolderDel">Delete folder</button>
    </div>`, '420px')
  scrim.querySelector('#libFolderDel').onclick = () => { close(); onConfirm() }
}

// ── floating menu, closes on outside click, Escape or scroll ────────────────
let openMenuEl = null
function closeMenu() { if (openMenuEl) { openMenuEl.remove(); openMenuEl = null } }
function positionMenu(m, anchorRect) {
  const mr = m.getBoundingClientRect()
  let left = anchorRect.left
  if (left + mr.width > window.innerWidth - 10) left = window.innerWidth - mr.width - 10
  let top = anchorRect.bottom + 6
  if (top + mr.height > window.innerHeight - 10) top = anchorRect.top - mr.height - 6
  m.style.left = `${Math.max(10, left)}px`
  m.style.top = `${Math.max(10, top)}px`
}
function openMenu(anchor, innerHtml, cls = 'lib-menu') {
  closeMenu()
  const m = el('div', cls, innerHtml)
  document.body.appendChild(m)
  positionMenu(m, anchor.getBoundingClientRect())
  openMenuEl = m
  setTimeout(() => {
    const cleanup = () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onScroll)
      document.removeEventListener('scroll', onScroll, true)
      closeMenu()
    }
    const onDown = e => { if (!m.contains(e.target) && !anchor.contains(e.target)) cleanup() }
    const onKey = e => { if (e.key === 'Escape') cleanup() }
    const onScroll = () => cleanup()
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', onScroll)
    document.addEventListener('scroll', onScroll, true)
  }, 0)
  return m
}

// ── folder chip menu: rename / delete ───────────────────────────────────────
function openFolderMenu(anchor, folder, onChange) {
  const m = openMenu(anchor, `
    <button class="lib-menu-item" data-a="rename">${ico('pencil-simple')}<span>Rename</span></button>
    <button class="lib-menu-item danger" data-a="delete">${ico('trash')}<span>Delete</span></button>`)
  m.querySelector('[data-a="rename"]').onclick = () => {
    closeMenu()
    promptFolderName({
      title: 'Rename folder', value: folder.name, confirmLabel: 'Save',
      onConfirm: name => { renameFolder(folder.id, name); onChange() }
    })
  }
  m.querySelector('[data-a="delete"]').onclick = () => {
    closeMenu()
    confirmDeleteFolder(folder, () => { deleteFolder(folder.id); onChange() })
  }
}

// ── assign menu: opened from a card, lists folders plus New folder ────────
function openAssignMenu(anchor, filePath, onChange) {
  const rows = state.folders.map(f => `
    <button class="lib-menu-item" data-id="${f.id}">
      ${ico(f.paths.includes(filePath) ? 'check' : 'folder')}<span>${esc(f.name)}</span>
    </button>`).join('')
  const m = openMenu(anchor, `
    ${rows || `<div class="lib-menu-empty">No folders yet.</div>`}
    <button class="lib-menu-item" data-new="1">${ico('plus')}<span>New folder...</span></button>`)
  m.querySelectorAll('[data-id]').forEach(b => b.onclick = () => {
    toggleMember(b.dataset.id, filePath)
    closeMenu(); onChange()
  })
  m.querySelector('[data-new]').onclick = () => {
    closeMenu()
    promptFolderName({
      title: 'New folder', confirmLabel: 'Create',
      onConfirm: name => { const f = addFolder(name); toggleMember(f.id, filePath); onChange() }
    })
  }
}

// ── the ⓘ panel, opened from a card ────────────────────────────────────────
function openInfo(anchor, filePath) {
  const g = lastGroups.find(x => item(x).path === filePath)
  if (!g) return
  const rows = infoRows(g, lastGroups).map(r => `
    <div class="lib-info-row"><span class="lib-info-k">${esc(r.label)}</span>
      <span class="lib-info-v">${esc(r.value)}</span></div>`).join('')
  const where = path.dirname(item(g).path)
  openMenu(anchor, `
    <div class="lib-info-head">${esc(stemOf(g))}</div>
    ${rows}
    <div class="lib-info-row"><span class="lib-info-k">Where</span>
      <span class="lib-info-v mono">${esc(where)}</span></div>`, 'lib-menu lib-info')
}

// ── the bar above the grid: kinds, search, sort, folders, platforms ────────
function countIn(pred, groups) { return (groups || []).filter(pred).length }

function renderBar(gridEl, groups, onChange) {
  lastGroups = groups || []
  let bar = document.getElementById('libFolderBar')
  if (!bar) {
    bar = el('div', 'lib-bar')
    bar.id = 'libFolderBar'
    gridEl.parentElement.insertBefore(bar, gridEl)
  }
  // a refresh lands mid-typing (a thumbnail job, an agent's export): put the caret back
  const focused = document.activeElement
  const caret = focused && focused.id === 'libQuery' ? focused.selectionStart : null

  const shots = countIn(isShot, groups)
  const takes = (groups || []).length - shots
  const kinds = [['all', 'All', (groups || []).length], ['shot', 'Screenshots', shots], ['take', 'Recordings', takes]]
  // one kind on its own needs no switch: the library is already only that
  const kindHtml = shots && takes ? `<div class="seg" role="group" aria-label="Kind">${kinds.map(([id, label, n]) =>
    `<button data-kind="${id}" aria-selected="${view.kind === id}">${esc(label)}<span class="chip-count">${n}</span></button>`).join('')}</div>` : ''

  const platforms = platformsIn(groups)
  // a tag every item shares says nothing, so platforms appear once there are two
  const platformHtml = platforms.length > 1 ? `<span class="lib-bar-sep"></span>` + [['all', 'All platforms'], ...platforms.map(p => [p, p])]
    .map(([id, label]) => `<button class="chip" data-platform="${esc(id)}" aria-pressed="${view.platform === id}">${esc(label)}</button>`).join('') : ''

  const folders = state.folders.map(f => `
    <span class="chip folder-chip" data-id="${f.id}" aria-pressed="${view.folder === f.id}" role="button" tabindex="0">
      ${ico('folder')}<span class="chip-label">${esc(f.name)}</span><span class="chip-count">${countIn(g => f.paths.includes(item(g).path), groups)}</span>
      <button class="chip-more" data-more="${f.id}" data-tip="More">${ico('dots-three')}</button>
    </span>`).join('')

  bar.innerHTML = `
    <div class="lib-bar-row">
      ${kindHtml}
      <div style="flex:1"></div>
      <div class="lib-search">${ico('magnifying-glass')}
        <input id="libQuery" class="input" type="search" placeholder="Search names" value="${esc(view.query)}" autocomplete="off"></div>
      <button class="btn btn-sm" id="libSort" data-tip="Sort">${ico('sliders-horizontal')}
        <span>${esc((SORTS.find(s => s[0] === view.sort) || SORTS[0])[1])}</span></button>
    </div>
    <div class="lib-bar-row wrap">
      <button class="chip folder-chip" data-id="all" aria-pressed="${view.folder === 'all'}">All <span class="chip-count">${(groups || []).length}</span></button>
      ${folders}
      <button class="chip new-folder-chip" id="libNewFolder">${ico('plus')} New folder</button>
      ${platformHtml}
    </div>`

  bar.querySelectorAll('.folder-chip').forEach(c => {
    const select = () => { view.folder = c.dataset.id; onChange() }
    c.addEventListener('click', e => { if (!e.target.closest('[data-more]')) select() })
    c.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && !e.target.closest('[data-more]')) { e.preventDefault(); select() } })
  })
  bar.querySelectorAll('[data-more]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation()
      openFolderMenu(btn, findFolder(btn.dataset.more), onChange)
    })
  })
  bar.querySelectorAll('[data-kind]').forEach(b => b.onclick = () => { view.kind = b.dataset.kind; onChange() })
  bar.querySelectorAll('[data-platform]').forEach(b => b.onclick = () => { view.platform = b.dataset.platform; onChange() })

  const nf = bar.querySelector('#libNewFolder')
  if (nf) nf.onclick = () => promptFolderName({
    title: 'New folder', confirmLabel: 'Create',
    onConfirm: name => { const f = addFolder(name); view.folder = f.id; onChange() }
  })

  const sort = bar.querySelector('#libSort')
  sort.onclick = () => {
    const m = openMenu(sort, SORTS.map(([id, label]) =>
      // a blank of the same size where the tick is not, so the labels stay in one line
      `<button class="lib-menu-item" data-s="${id}">${view.sort === id ? ico('check') : '<span class="icon-sm"></span>'}<span>${esc(label)}</span></button>`).join(''))
    m.querySelectorAll('[data-s]').forEach(b => b.onclick = () => { view.sort = b.dataset.s; closeMenu(); onChange() })
  }

  const q = bar.querySelector('#libQuery')
  let typing = null
  q.addEventListener('input', () => {
    view.query = q.value
    clearTimeout(typing)
    typing = setTimeout(onChange, 160)      // redraw on the pause, not on every keystroke
  })
  q.addEventListener('keydown', e => { if (e.key === 'Escape' && view.query) { view.query = ''; q.value = ''; onChange() } })
  if (caret != null) { q.focus(); try { q.setSelectionRange(caret, caret) } catch {} }
}

// ── card decorations ────────────────────────────────────────────────────────
// Takes a group (so the kind and platform can be read) or a bare path (the old call).
function tagHTML(g) {
  const c = typeof g === 'string' ? { path: g } : item(g)
  const group = typeof g === 'string' ? null : g
  const out = []
  // The shot chip is what the card's shape cannot say. A recording has a play triangle
  // and a duration and needs no chip of its own.
  if (group && isShot(group)) out.push(`<span class="kind kind-shot">${ico('image')}<span>Shot</span></span>`)
  if (group) {
    const p = platformOf(group)
    if (p && p !== 'Mac') out.push(`<span class="kind kind-platform">${esc(p)}</span>`)
  }
  const owners = foldersFor(c.path)
  if (owners.length) {
    const label = owners.length === 1 ? esc(owners[0].name) : `${esc(owners[0].name)} +${owners.length - 1}`
    out.push(`<span class="folder-tag">${ico('folder')}<span>${label}</span></span>`)
  }
  return out.join('')
}

// The folder button app.js wires by hand, plus an ⓘ this file wires itself.
function assignButtonHTML(g) {
  const p = g ? item(g).path : ''
  return `<button class="btn btn-sm" data-act="folder" data-tip="Add to folder">${ico('folder')}</button>` +
    (p ? `<button class="btn btn-sm" data-lib="info" data-p="${esc(p)}" data-tip="Details">${ico('info')}</button>` : '')
}

// One delegated listener rather than a handler per card: the grid is rebuilt on every
// refresh and app.js does not have to know this button exists.
if (!headless) {
  document.addEventListener('click', e => {
    const b = e.target.closest && e.target.closest('[data-lib="info"]')
    if (b) { e.stopPropagation(); openInfo(b, b.dataset.p) }
  })
}

// ── laying the cards out under their day ───────────────────────────────────
// app.js deals cards into columns so the newest sit along the top row. With days on,
// each day is its own run of columns, and the heading sits above it.
function dealInto(grid, cards, cols, deal) {
  const columns = list => deal(list, cols).map(col => {
    const c = el('div', 'lib-col')
    c.append(...col)
    return c
  })
  const days = grid._days
  if (!days || !days.length || !days.some(d => d.label)) {
    grid.classList.remove('by-day')
    grid.replaceChildren(...columns(cards))
    return
  }
  grid.classList.add('by-day')
  const out = []
  let i = 0
  for (const d of days) {
    const slice = cards.slice(i, i + d.n)
    i += d.n
    if (!slice.length) continue
    const sec = el('div', 'lib-day')
    sec.append(el('div', 'lib-day-head', `<span class="lib-day-label">${esc(d.label)}</span><span class="chip-count">${d.n}</span>`))
    const run = el('div', 'lib-day-grid')
    run.append(...columns(slice))
    sec.append(run)
    out.push(sec)
  }
  grid.replaceChildren(...out)
}

// ── empty state, whichever filter emptied it ───────────────────────────────
function emptyHTML() {
  const folder = findFolder(view.folder)
  let line = 'Nothing here yet.'
  let action = ''
  if (view.query.trim()) {
    line = `Nothing matches "${esc(view.query.trim())}".`
    action = `<button class="btn btn-primary btn-sm" id="libBackToAll">Clear the search</button>`
  } else if (view.kind === 'shot') {
    line = 'No screenshots yet. Capture one and it lands here beside the recordings.'
    action = `<button class="btn btn-primary btn-sm" id="libBackToAll">Show everything</button>`
  } else if (view.kind === 'take') {
    line = 'No recordings yet. Hit record and Biscuit will bring one back here.'
    action = `<button class="btn btn-primary btn-sm" id="libBackToAll">Show everything</button>`
  } else if (view.platform !== 'all') {
    line = `Nothing from ${esc(view.platform)} here.`
    action = `<button class="btn btn-primary btn-sm" id="libBackToAll">Show every platform</button>`
  } else if (folder) {
    line = `Nothing in "${esc(folder.name)}" yet. Use the folder button on a card to add it here.`
    action = `<button class="btn btn-primary btn-sm" id="libBackToAll">Show everything</button>`
  }
  return `<div class="empty" style="grid-column:1/-1">
    <img class="biscuit biscuit-lg" src="./assets/mascot/idle.png" alt="">
    <p>${line}</p>
    ${action}
  </div>`
}
// the button in every one of those empty states puts the view back
function clearFilters() { view = { ...view, folder: 'all', kind: 'all', platform: 'all', query: '' } }

module.exports = {
  // what ui/app.js calls
  getActiveId: () => view.folder,
  // the way back from every empty state, so one dead end does not leave three filters on
  setActive: id => { clearFilters(); view.folder = id || 'all' },
  filterGroups,
  renderBar,
  tagHTML,
  assignButtonHTML,
  openAssignMenu,
  emptyFolderHTML: emptyHTML,     // the name app.js knows it by; it is every filter now
  emptyHTML,
  dealInto,
  countLabel,
  forgetPath,
  renamePath,
  findFolder,
  // the two kinds, and what can be said about one item
  kindOf,
  isShot,
  platformOf,
  platformsIn,
  byDay,
  daySpans,
  dayLabel,
  infoRows,
  stemOf,
  // for tests: the view and the folders, without touching the person's own
  _view: () => ({ ...view }),
  _setView: next => { view = { ...view, ...next } },
  _setFolders: folders => { state = { folders: folders || [] } },
}
