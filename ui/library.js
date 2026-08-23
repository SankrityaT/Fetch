// Fetch: virtual folders for the Library. Folders never move or copy files,
// they only group existing paths. Storage lives outside the repo, in
// ~/Library/Application Support/Fetch/collections.json, since the renderer
// has no access to electron.app to ask Electron for that path itself.
//
// This file injects its own stylesheet so control.html never has to change,
// and is required from ui/app.js (which already runs with node integration).

const fs = require('fs')
const os = require('os')
const path = require('path')

// ── stylesheet, injected once ─────────────────────────────────────────────
;(() => {
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = './ui/library.css'
  document.head.appendChild(link)
})()

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
  try {
    fs.mkdirSync(DIR, { recursive: true })
    fs.writeFileSync(FILE, JSON.stringify(state, null, 2))
  } catch (e) { console.error('Fetch: could not save collections.json', e) }
}

let state = load()
let activeId = 'all'

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
  if (activeId === id) activeId = 'all'
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

// ── tiny local helpers, kept self-contained ─────────────────────────────────
const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n }
const ico = (name, cls = 'icon-sm') => `<svg class="${cls}"><use href="./assets/icons/sprite.svg#i-${name}"/></svg>`
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

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
      <p class="dim" style="font-size:var(--t-12)">The recordings stay right where they are, this only removes the folder.</p>
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
function openMenu(anchor, innerHtml) {
  closeMenu()
  const m = el('div', 'lib-menu', innerHtml)
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

// ── assign menu: opened from a clip card, lists folders plus New folder ────
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

// ── folder bar: "All", one chip per folder, "+ New folder" ─────────────────
function countIn(id, groups) {
  if (id === 'all') return groups.length
  const f = findFolder(id); if (!f) return 0
  return groups.filter(g => f.paths.includes(g.original.path)).length
}
function filterGroups(groups) {
  if (activeId === 'all') return groups
  const f = findFolder(activeId)
  if (!f) { activeId = 'all'; return groups }
  return groups.filter(g => f.paths.includes(g.original.path))
}
function renderBar(gridEl, groups, onChange) {
  let bar = document.getElementById('libFolderBar')
  if (!bar) {
    bar = el('div', 'folder-bar')
    bar.id = 'libFolderBar'
    gridEl.parentElement.insertBefore(bar, gridEl)
  }
  const parts = [`<button class="chip folder-chip" data-id="all" aria-pressed="${activeId === 'all'}">All <span class="chip-count">${countIn('all', groups)}</span></button>`]
  for (const f of state.folders) {
    parts.push(`<span class="chip folder-chip" data-id="${f.id}" aria-pressed="${activeId === f.id}" role="button" tabindex="0">
      ${ico('folder')}<span class="chip-label">${esc(f.name)}</span><span class="chip-count">${countIn(f.id, groups)}</span>
      <button class="chip-more" data-more="${f.id}" data-tip="More">${ico('dots-three')}</button>
    </span>`)
  }
  parts.push(`<button class="chip new-folder-chip" id="libNewFolder">${ico('plus')} New folder</button>`)
  bar.innerHTML = parts.join('')

  bar.querySelectorAll('.folder-chip').forEach(c => {
    const select = () => { activeId = c.dataset.id; onChange() }
    c.addEventListener('click', e => { if (!e.target.closest('[data-more]')) select() })
    c.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && !e.target.closest('[data-more]')) { e.preventDefault(); select() } })
  })
  bar.querySelectorAll('[data-more]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation()
      openFolderMenu(btn, findFolder(btn.dataset.more), onChange)
    })
  })
  const nf = bar.querySelector('#libNewFolder')
  if (nf) nf.onclick = () => promptFolderName({
    title: 'New folder', confirmLabel: 'Create',
    onConfirm: name => { const f = addFolder(name); activeId = f.id; onChange() }
  })
}

// ── card decorations ────────────────────────────────────────────────────────
function tagHTML(filePath) {
  const owners = foldersFor(filePath)
  if (!owners.length) return ''
  const label = owners.length === 1 ? esc(owners[0].name) : `${esc(owners[0].name)} +${owners.length - 1}`
  return `<span class="folder-tag">${ico('folder')}<span>${label}</span></span>`
}
function assignButtonHTML() {
  return `<button class="btn btn-sm" data-act="folder" data-tip="Add to folder">${ico('folder')}</button>`
}

// ── empty state for a folder with no clips in it yet ────────────────────────
function emptyFolderHTML(folder) {
  return `<div class="empty" style="grid-column:1/-1">
    <img class="biscuit biscuit-lg" src="./assets/mascot/idle.png" alt="">
    <p>Nothing in "${esc(folder.name)}" yet. Use the folder button on a clip to add it here.</p>
    <button class="btn btn-primary btn-sm" id="libBackToAll">Show all clips</button>
  </div>`
}

module.exports = {
  getActiveId: () => activeId,
  setActive: id => { activeId = id },
  filterGroups,
  renderBar,
  tagHTML,
  assignButtonHTML,
  openAssignMenu,
  emptyFolderHTML,
  forgetPath,
  renamePath,
  findFolder,
}
