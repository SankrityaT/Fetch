// The Activity view: what happened on this machine, and who did it.
//
// An agent that can record your screen has to be accountable, and a log is the
// cheapest honest form that takes. The design follows from one idea: a row with no
// vendor mark was done by a person. That is what makes the log worth opening, since
// it answers "was that cut mine or did the agent do it" rather than just listing
// agent activity in isolation.
//
// Self-contained in the same way as ui/library.js: injects its own stylesheet so
// control.html does not have to know about it.
;(function () {
  'use strict'

  if (!document.querySelector('link[data-activity-style]')) {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = './ui/activity.css'
    link.setAttribute('data-activity-style', '1')
    document.head.appendChild(link)
  }

  const { ipcRenderer } = require('electron')
  // Durations and the path ellipsis come from the one formatter, so the job chat
  // called "1m 4s" is "1m 4s" here too, not "1 min" (ui/fmt.js).
  const Fmt = window.Fmt || require('./ui/fmt')

  // Which glyph stands for each kind of work. Filled variants for anything that
  // captured, per the icon rule in BRAND.md.
  const OP_ICON = {
    'record.start': 'record-fill', 'record.stop': 'stop-fill', 'record.pause': 'pause-fill',
    'windows.list': 'app-window', 'displays.list': 'monitor', 'recordings.list': 'folder',
    probe: 'info', transcribe: 'closed-captioning', captions: 'closed-captioning',
    export: 'export', mp4: 'film-strip', convert: 'film-strip', gif: 'image',
    silence: 'magic-wand', enhance: 'waveform', trim: 'scissors',
  }

  // Real vendor artwork, the same files the Connect screen uses.
  const MARK = {
    'claude code': 'claude', claude: 'claude', codex: 'codex',
    cursor: 'cursor', windsurf: 'windsurf', zed: 'zed',
  }

  const ico = (name, cls) =>
    `<svg class="${cls || 'icon-sm'}"><use href="./assets/icons/sprite.svg#i-${name}"/></svg>`

  const esc = t => String(t == null ? '' : t)
    .replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

  // Keep the end of a path, which is the part that identifies it, and drop the middle.
  const shortPath = p => {
    const str = String(p)
    if (!str.startsWith('/') || str.length <= 48) return str
    const parts = str.split('/').filter(Boolean)
    return parts.length > 2 ? Fmt.ELL + '/' + parts.slice(-2).join('/') : str
  }

  const fmtClock = at => new Date(at)
    .toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

  // Day headings people actually use, rather than a date on every row.
  function dayLabel(at) {
    const d = new Date(at), now = new Date()
    const sameDay = (a, b) => a.toDateString() === b.toDateString()
    if (sameDay(d, now)) return 'Today'
    const y = new Date(now); y.setDate(now.getDate() - 1)
    if (sameDay(d, y)) return 'Yesterday'
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
  }

  function rowHtml(e) {
    const markFile = MARK[String(e.by || '').toLowerCase()]
    // A missing logo must not leave a hole, and a human row has no badge at all.
    const badge = e.by
      ? `<span class="act-badge">${markFile
          ? `<img src="./assets/agents/${markFile}.svg" alt="" onerror="this.remove()">`
          : ico('sparkle', 'icon-xs')}</span>`
      : ''

    return `<div class="act-row" data-ok="${e.ok !== false}">
      <span class="act-time mono">${fmtClock(e.at)}</span>
      <span class="act-ico">${ico(OP_ICON[e.op] || 'circle-fill', 'icon-sm')}${badge}</span>
      <span class="act-txt">
        <span class="act-title">${esc(e.title)}</span>
        ${e.error ? `<span class="act-detail act-error">${esc(e.error)}</span>`
                  : e.detail ? `<span class="act-detail">${esc(shortPath(e.detail))}</span>` : ''}
      </span>
      <span class="act-by">${e.by ? esc(e.by) : 'You'}</span>
      <span class="act-ms mono">${Fmt.dur(e.ms)}</span>
      <span class="act-state">${e.ok !== false ? ico('check', 'icon-sm') : ico('warning-circle', 'icon-sm')}</span>
    </div>`
  }

  // The page keeps its title whether or not there is anything under it, like the
  // Library, so the view never looks like a different screen when it is empty.
  const HEAD = `<div class="act-head">
        <h2>Activity</h2>
        <p class="dim">Everything Fetch has done on this Mac. A row with no logo was you.</p>
      </div>`

  function render(entries) {
    const mount = document.getElementById('activityMount')
    if (!mount) return
    mount.classList.add('act-mount')

    // Biscuit, one line and one action, centred in the space under the title (DESIGN,
    // component rule 4). The action goes to Record, the same one the Library offers.
    if (!entries.length) {
      mount.innerHTML = HEAD + `<div class="empty act-empty">
        <img class="biscuit biscuit-lg" src="./assets/mascot/curious.png" alt="">
        <p>Nothing yet. Recordings, exports and what an agent does show up here, with who did it.</p>
        <button type="button" class="btn btn-primary btn-sm" data-act-go="record">Start recording</button>
      </div>`
      const go = mount.querySelector('[data-act-go]')
      if (go) go.onclick = () => { const tab = document.querySelector('[data-view=record]'); if (tab) tab.click() }
      return
    }

    let html = HEAD + `<div class="act-list">`

    let day = null
    for (const e of entries) {
      const d = dayLabel(e.at)
      if (d !== day) { day = d; html += `<div class="act-day">${esc(d)}</div>` }
      html += rowHtml(e)
    }
    mount.innerHTML = html + '</div>'
  }

  async function refresh() {
    let entries = []
    try { entries = await ipcRenderer.invoke('activity-read', 300) || [] } catch {}
    render(entries)
  }

  // Repaint when the view is opened rather than on a timer: a log nobody is looking
  // at does not need redrawing, and ui/app.js calls this from show().
  window.refreshActivity = refresh

  document.addEventListener('DOMContentLoaded', refresh)
  if (document.readyState !== 'loading') refresh()
})()
