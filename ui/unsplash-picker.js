// The photo picker in the Look tab: the backdrops Fetch ships, the person's own
// images, and, with their own Unsplash access key, a live search of Unsplash.
//
// Every photograph is shown with who took it. The bundled ones carry their credit in
// the backdrop list (processor.js backdropList, item.credit); a search result carries
// its photographer from the API. Unsplash asks for three things and all three are
// here: the photographer named with a link to their profile, Unsplash named with a
// link, both links tagged with where they came from (utm_source, utm_medium), and the
// photo's own download endpoint pinged when a photo is used, which the client module
// does inside use() because it holds the key.
//
// The network side is not in this file. It talks to an api object, by default the
// main process over IPC (unsplash-status, unsplash-search, unsplash-use); the key
// lives in the macOS Keychain the way the voiceover key does, and is typed into
// Settings, never here. Without a key the picker still shows every local photo and
// says in one line where the key goes.
//
// The inspector redraws its whole body on every change, so this keeps its own state
// (the query, the results, what is being fetched) and hands back HTML on each draw.
// Its events are delegated from the inspector's root, and a result that arrives while
// the inspector is still up repaints only the results.

const APP = 'fetch'
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const Fmt = (() => { try { return require('./fmt') } catch { return (typeof window !== 'undefined' && window.Fmt) || { ELL: '…' } } })()

// Unsplash asks for every link back to it to say where it came from. Only Unsplash's
// own links are stamped: a photograph credited to somewhere else (README.md invites a
// credits.json entry for one) keeps its link exactly as its entry wrote it.
function tagged(url, stamp = true) {
  if (!/^https:\/\//i.test(String(url || ''))) return ''
  try {
    const u = new URL(url)
    if (stamp && /(^|\.)unsplash\.com$/.test(u.hostname)) {
      u.searchParams.set('utm_source', APP)
      u.searchParams.set('utm_medium', 'referral')
    }
    return u.toString()
  } catch { return '' }
}
const UNSPLASH = tagged('https://unsplash.com/')

// A photographer credit, from whichever shape it arrived in
function creditOf(item) {
  const c = (item && (item.credit || item.author || item.user)) || null
  if (!c || !c.name) return null
  return {
    name: String(c.name),
    url: tagged(c.url || (c.links && c.links.html) || ''),
    // Never invented: an entry that does not say where it came from, and whose links do
    // not say either, is shown with the photographer's name alone rather than stamped
    // with a source it may not belong to.
    source: c.source || (item.source === 'unsplash' ? 'Unsplash' : ''),
    link: tagged(item.link || c.link || (item.links && item.links.html) || ''),
  }
}

// The line under a photo: "Name · Unsplash", both links, the name shortened first
function captionHtml(item, fallback) {
  const c = creditOf(item)
  if (!c) return `<span class="ph-cap"><span>${esc(fallback || '')}</span></span>`
  const who = c.url
    ? `<a href="${esc(c.url)}" data-ph-link="${esc(c.url)}">${esc(c.name)}</a>`
    : `<span>${esc(c.name)}</span>`
  const on = c.source === 'Unsplash'
    ? `<a href="${esc(c.link || UNSPLASH)}" data-ph-link="${esc(c.link || UNSPLASH)}">Unsplash</a>`
    : c.source ? `<span>${esc(c.source)}</span>` : ''
  const title = `Photo by ${c.name}${c.source ? ' on ' + c.source : ''}`
  return `<span class="ph-cap" title="${esc(title)}">${who}${on ? `<span aria-hidden="true">${Fmt.SEP ? Fmt.SEP.trim() : '·'}</span>${on}` : ''}</span>`
}

// Both land inside a double-quoted style attribute, so both go through esc() at the call
// site as every other value in those templates does. Without it a remote thumb URL or a
// dropped-in file named `a".jpg` closes the attribute and writes its own attributes into
// the button, and this renderer has node in it.
const fileUrl = f => `url('file://${encodeURI(f).replace(/'/g, '%27')}')`
const webUrl = u => /^https:\/\//i.test(String(u || '')) ? `url('${String(u).replace(/'/g, '%27')}')` : 'none'

// The main process by default. Anything with the same three methods will do, which is
// how the harness draws it with no network at all.
function ipcApi() {
  let ipc = null
  try { ipc = require('electron').ipcRenderer } catch {}
  if (!ipc) return null
  return {
    status: () => ipc.invoke('unsplash-status'),
    search: (query, page) => ipc.invoke('unsplash-search', { query, page }),
    // the whole result as search returned it: use() needs its download_location to
    // tell Unsplash, and its raw url to fetch; the main process checks both hosts
    use: photo => ipc.invoke('unsplash-use', photo),
  }
}

function openLink(url) {
  if (!/^https:\/\//i.test(url)) return
  try { require('electron').shell.openExternal(url) } catch {}
}

// Electron wraps a rejected handler as "Error invoking remote method 'x': Error: why"
const why = err => { const raw = String((err && err.message) || err || ''); return raw.split(/Error:\s*/).pop().trim() || raw }

function create(root, o = {}) {
  const api = o.api === undefined ? ipcApi() : o.api
  const ico = o.ico || (() => '')
  const st = {
    connected: null,     // null until the main process answers
    query: '', page: 1, pages: 0,
    results: [], busy: false, error: '', using: '',
  }
  let timer = null, seq = 0, path = 'background.image'

  function checkKey() {
    if (!api || !api.status) { st.connected = false; return Promise.resolve() }
    return Promise.resolve(api.status()).then(s => { st.connected = !!(s && s.connected) }, () => { st.connected = false })
      .then(paint)
  }

  function resultsHtml() {
    if (st.connected === false) {
      return `<p class="ph-note">Search Unsplash with your own free access key: add it in
        <button class="ph-inline" type="button" data-ph-settings>Settings</button>.</p>`
    }
    if (st.connected == null || !st.query.trim()) return ''
    if (st.error) return `<p class="ph-note">${esc(st.error)}</p>`
    if (st.busy && !st.results.length) return `<p class="ph-note">Searching Unsplash${Fmt.ELL}</p>`
    if (!st.results.length) return `<p class="ph-note">Nothing on Unsplash for “${esc(st.query.trim())}”.</p>`
    return `<div class="ph-grid" role="list" aria-label="Unsplash photos">${st.results.map(p => `
        <div class="ph-tile" role="listitem">
          <button class="ph-pick" type="button" data-ph-web="${esc(p.id)}" aria-busy="${st.using === p.id}"
            aria-label="Use ${esc(p.alt || 'this photo')}${creditOf(p) ? ', by ' + esc(creditOf(p).name) : ''}"
            style="background-image:${esc(webUrl(p.thumb))};background-color:${/^#[0-9a-f]{3,8}$/i.test(p.color || '') ? p.color : 'var(--ink-2)'}"></button>
          ${captionHtml({ ...p, source: 'unsplash' })}
        </div>`).join('')}</div>
      ${st.page < st.pages ? `<button class="btn btn-sm btn-ghost ph-more" type="button" data-ph-more ${st.busy ? 'disabled' : ''}>${st.busy ? 'Loading' + Fmt.ELL : 'More photos'}</button>` : ''}`
  }

  // The whole picker, for the inspector's draw. list is the image backdrops, each
  // { id, label, file, credit? }; value is the id in use.
  function html(p, value, list, canAdd) {
    path = p
    if (st.connected == null && api) checkKey()
    const tiles = (list || []).map(a => `
      <div class="ph-tile" aria-selected="${a.id === value}">
        <button class="ph-pick" type="button" data-asset="${esc(p)}" data-v="${esc(a.id)}" role="radio" aria-checked="${a.id === value}"
          aria-label="${esc(a.label)}" style="background-image:${esc(fileUrl(a.file))}"></button>
        ${captionHtml(a, a.label)}
      </div>`).join('')
    const add = canAdd ? `
      <div class="ph-tile">
        <button class="ph-pick ph-add" type="button" data-add-asset="${esc(p)}" aria-label="Your image">${ico('plus', 'icon-sm')}</button>
        <span class="ph-cap"><span>Your image</span></span>
      </div>` : ''
    const search = st.connected ? `
      <div class="ph-search">
        <input class="input input-sm ph-q" type="search" data-ph-q value="${esc(st.query)}" placeholder="Search Unsplash"
          spellcheck="false" autocomplete="off" aria-label="Search Unsplash">
      </div>` : ''
    // the search first: the shipped photos run long, and a field under them is a field
    // nobody finds
    return `<div class="ph" data-ph>
      ${search}
      <div class="ph-results" data-ph-results aria-live="polite">${resultsHtml()}</div>
      <div class="ph-grid" role="radiogroup" aria-label="Photos">${tiles}${add}</div>
    </div>`
  }

  // Repaint what changed without redrawing the inspector: the results, and the search
  // field once the key is known
  function paint() {
    const box = root.querySelector('[data-ph]')
    if (!box) return
    const hasSearch = !!box.querySelector('[data-ph-q]')
    if (!!st.connected !== hasSearch && o.redraw) { o.redraw(); return }
    const r = box.querySelector('[data-ph-results]')
    if (r) r.innerHTML = resultsHtml()
  }

  async function run(page) {
    const q = st.query.trim()
    const mine = ++seq
    if (!q || !api || !api.search) { st.results = []; st.error = ''; st.busy = false; paint(); return }
    st.busy = true; st.error = ''
    if (page === 1) st.results = []
    paint()
    try {
      const r = await api.search(q, page)
      if (mine !== seq) return
      if (r && r.ok === false) throw new Error(r.message || r.why || 'Unsplash did not answer')
      const got = (r && r.results) || []
      st.results = page === 1 ? got : st.results.concat(got.filter(g => !st.results.some(x => x.id === g.id)))
      st.page = page
      st.pages = (r && r.pages) || 0
    } catch (err) {
      if (mine !== seq) return
      st.error = why(err)
    }
    st.busy = false
    paint()
  }

  async function useWeb(id) {
    const p = st.results.find(x => x.id === id)
    if (!p || st.using || !api || !api.use) return
    st.using = id; paint()
    try {
      const got = await api.use(p)
      if (!got || got.ok === false || !got.id) throw new Error((got && (got.message || got.why)) || 'That photo could not be saved')
      st.using = ''
      if (o.onAssetsChanged) await o.onAssetsChanged()
      if (o.onPick) o.onPick(path, got.id)
    } catch (err) {
      st.using = ''
      paint()
      if (o.toast) o.toast(why(err), 'bad')
    }
  }

  root.addEventListener('click', e => {
    const link = e.target.closest('[data-ph-link]')
    if (link && root.contains(link)) { e.preventDefault(); openLink(link.dataset.phLink); return }
    const b = e.target.closest('button')
    if (!b || !root.contains(b)) return
    if (b.dataset.phWeb) useWeb(b.dataset.phWeb)
    else if ('phMore' in b.dataset) run(st.page + 1)
    else if ('phSettings' in b.dataset) (o.onAddKey || defaultAddKey)()
  })
  root.addEventListener('input', e => {
    if (!e.target.matches || !e.target.matches('[data-ph-q]')) return
    st.query = e.target.value
    clearTimeout(timer)
    timer = setTimeout(() => run(1), 350)
  })
  root.addEventListener('keydown', e => {
    if (!e.target.matches || !e.target.matches('[data-ph-q]')) return
    if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); run(1) }
    if (e.key === 'Escape' && st.query) { e.preventDefault(); e.stopPropagation(); e.target.value = ''; st.query = ''; run(1) }
  })
  // Settings says when a key is added or taken away; both live in this one window
  if (typeof window !== 'undefined') window.addEventListener('unsplash-key', () => { st.connected = null; checkKey() })

  return { html, checkKey, state: st }
}

// Settings is a view in this same window; its Photos card is where the key goes
function defaultAddKey() {
  if (typeof window === 'undefined') return
  if (typeof window.show === 'function') window.show('settings')
  const card = document.getElementById('setPhotosCard')
  if (card) card.scrollIntoView({ block: 'center' })
  const key = document.getElementById('phKey')
  if (key) key.focus({ preventScroll: true })
}

module.exports = { create, tagged, creditOf, captionHtml }
