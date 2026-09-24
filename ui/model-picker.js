// The model picker. One popover for both places a model is chosen: the hero composer
// and the chat pane. Lists every model the installed CLIs can run, grouped by CLI, with
// a search field, and the effort levels the chosen model supports underneath.
//
// Holds no state of its own beyond the open popover. The caller passes the catalogue
// (ui/models.js via the chat-models IPC) and the current pick, and gets the new pick
// back through onPick. Self-installing like ui/chat.js.
;(function () {
  'use strict'

  if (!document.querySelector('link[data-mp-style]')) {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = './ui/model-picker.css'
    link.setAttribute('data-mp-style', '1')
    document.head.appendChild(link)
  }

  const ico = (n, c) => `<svg class="${c || 'icon-sm'}"><use href="./assets/icons/sprite.svg#i-${n}"/></svg>`
  const esc = t => String(t == null ? '' : t)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

  const EFFORT_LABEL = { minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'XHigh', max: 'Max', ultra: 'Ultra' }
  const effortLabel = e => EFFORT_LABEL[e] || (e ? e[0].toUpperCase() + e.slice(1) : '')

  // The effort to keep when moving to another model: the same level if it has it,
  // else the model's own default, else the CLI's, else the middle of what it offers.
  function effortFor(model, engine, wanted) {
    const ls = model.efforts || []
    if (!ls.length) return null
    if (wanted && ls.includes(wanted)) return wanted
    if (model.defaultEffort && ls.includes(model.defaultEffort)) return model.defaultEffort
    if (engine.default && ls.includes(engine.default.effort)) return engine.default.effort
    return ls.includes('high') ? 'high' : ls[Math.floor(ls.length / 2)]
  }

  // The pick to use when nothing was saved, or what was saved no longer exists: the
  // person's own CLI default where Fetch can read it.
  function resolve(catalogue, saved) {
    const find = (eid, mid) => {
      const e = catalogue.find(x => x.id === eid)
      const m = e && e.models.find(x => x.id === mid)
      return m ? { e, m } : null
    }
    let hit = saved && find(saved.engine, saved.model)
    if (!hit) {
      for (const e of catalogue) {
        const m = e.models.find(x => x.id === (e.default && e.default.model)) || e.models[0]
        if (m) { hit = { e, m }; break }
      }
    }
    if (!hit) return null
    return { engine: hit.e.id, model: hit.m.id, effort: effortFor(hit.m, hit.e, saved && saved.effort) }
  }

  function describe(catalogue, pick) {
    const e = pick && catalogue.find(x => x.id === pick.engine)
    const m = e && e.models.find(x => x.id === pick.model)
    return m ? { engine: e, model: m, effort: pick.effort, effortLabel: effortLabel(pick.effort) } : null
  }

  let open = null            // { el, anchor, off }

  function close() {
    if (!open) return
    open.off()
    const { el, anchor } = open
    open = null
    anchor.setAttribute('aria-expanded', 'false')
    el.classList.remove('is-in')
    setTimeout(() => el.remove(), 120)
  }

  /**
   * @param {HTMLElement} anchor   the pill that opened it
   * @param {object} o
   *   @param {Array}    o.catalogue  from chat-models
   *   @param {object}   o.value      { engine, model, effort }
   *   @param {Function} o.onPick     called with the new { engine, model, effort }
   *   @param {Function} [o.mark]     engine id -> vendor mark url
   */
  function show(anchor, o) {
    if (open && open.anchor === anchor) { close(); return }
    close()
    const cat = o.catalogue || []
    let value = resolve(cat, o.value)
    let query = ''
    let cursor = 0                  // index into the flat list of visible rows

    const el = document.createElement('div')
    el.className = 'popover mp'
    el.setAttribute('role', 'dialog')
    el.setAttribute('aria-label', 'Choose a model')
    el.innerHTML = `
      <label class="mp-search">
        ${ico('magnifying-glass')}
        <input type="text" placeholder="Search models" spellcheck="false" aria-label="Search models">
        <kbd>esc</kbd>
      </label>
      <div class="mp-list" role="listbox"></div>
      <div class="mp-effort"></div>`
    document.body.appendChild(el)
    const field = el.querySelector('input')
    const listEl = el.querySelector('.mp-list')
    const effortEl = el.querySelector('.mp-effort')

    const visible = () => {
      const q = query.trim().toLowerCase()
      const rows = []
      for (const e of cat) {
        for (const m of e.models) {
          const hay = `${m.label} ${m.id} ${e.label} ${m.family || ''}`.toLowerCase()
          if (!q || q.split(/\s+/).every(w => hay.includes(w))) rows.push({ e, m })
        }
      }
      return rows
    }

    function paintList() {
      const rows = visible()
      if (cursor >= rows.length) cursor = Math.max(0, rows.length - 1)
      if (!rows.length) {
        listEl.innerHTML = `<div class="mp-empty">No model matches “${esc(query)}”</div>`
        return
      }
      let html = '', last = null
      rows.forEach(({ e, m }, i) => {
        if (e !== last) {
          html += `<div class="mp-group">
            <img src="${esc(o.mark ? o.mark(e.id) : '')}" alt="" onerror="this.remove()">
            <span>${esc(e.label)}</span></div>`
          last = e
        }
        const on = value && value.engine === e.id && value.model === m.id
        const isDef = e.default && e.default.model === m.id
        html += `<button type="button" class="popover-row mp-row" role="option" data-i="${i}"
            aria-selected="${on}" data-cursor="${i === cursor}">
          <span class="mp-name">${esc(m.label)}</span>
          ${on && value.effort ? `<span class="mp-eff">${esc(effortLabel(value.effort))}</span>` : ''}
          ${isDef ? `<span class="mp-def" data-tip="Your ${esc(e.label)} default">default</span>` : ''}
          <span class="mp-check">${on ? ico('check') : ''}</span>
        </button>`
      })
      listEl.innerHTML = html
      const cur = listEl.querySelector('[data-cursor="true"]')
      if (cur) cur.scrollIntoView({ block: 'nearest' })
    }

    function paintEffort() {
      const d = describe(cat, value)
      if (!d) { effortEl.innerHTML = ''; return }
      const ls = d.model.efforts || []
      effortEl.innerHTML = ls.length
        ? `<span class="mp-effort-label">Effort</span>
           <div class="seg seg-sm mp-seg" role="radiogroup" aria-label="Effort">
             ${ls.map(l => `<button type="button" role="radio" data-effort="${esc(l)}"
                aria-checked="${l === value.effort}">${esc(effortLabel(l))}</button>`).join('')}
           </div>`
        : `<span class="mp-effort-label">Effort</span>
           <span class="mp-effort-none">${esc(d.model.label)} has one setting</span>`
    }

    function pick(i, keepOpen) {
      const r = visible()[i]
      if (!r) return
      value = { engine: r.e.id, model: r.m.id, effort: effortFor(r.m, r.e, value && value.effort) }
      cursor = i
      o.onPick(value)
      if (keepOpen) { paintList(); paintEffort() } else close()
    }

    function setEffort(l) {
      if (!value) return
      value = { ...value, effort: l }
      o.onPick(value)
      paintList(); paintEffort()
    }

    function stepEffort(dir) {
      const d = describe(cat, value)
      const ls = d ? d.model.efforts || [] : []
      if (!ls.length) return
      const i = Math.max(0, ls.indexOf(value.effort))
      setEffort(ls[Math.min(ls.length - 1, Math.max(0, i + dir))])
    }

    // start on the current pick, so Enter without moving keeps it
    const rows0 = visible()
    const at = rows0.findIndex(r => value && r.e.id === value.engine && r.m.id === value.model)
    cursor = at < 0 ? 0 : at
    paintList(); paintEffort()

    field.addEventListener('input', () => { query = field.value; cursor = 0; paintList() })
    field.addEventListener('keydown', e => {
      const n = visible().length
      if (e.key === 'ArrowDown') { e.preventDefault(); cursor = n ? (cursor + 1) % n : 0; paintList() }
      else if (e.key === 'ArrowUp') { e.preventDefault(); cursor = n ? (cursor - 1 + n) % n : 0; paintList() }
      else if (e.key === 'Enter') { e.preventDefault(); pick(cursor) }
      else if (e.key === 'Escape') { e.preventDefault(); close(); anchor.focus() }
      // left and right move effort without leaving the list, as long as the search
      // box is empty (otherwise they move the caret in what you typed)
      else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !field.value) {
        e.preventDefault(); stepEffort(e.key === 'ArrowRight' ? 1 : -1)
      }
    })
    listEl.addEventListener('click', e => {
      const row = e.target.closest('.mp-row')
      if (row) pick(+row.dataset.i)
    })
    listEl.addEventListener('mousemove', e => {
      const row = e.target.closest('.mp-row')
      if (row && +row.dataset.i !== cursor) {
        listEl.querySelectorAll('[data-cursor="true"]').forEach(n => n.dataset.cursor = 'false')
        row.dataset.cursor = 'true'
        cursor = +row.dataset.i
      }
    })
    effortEl.addEventListener('click', e => {
      const b = e.target.closest('[data-effort]')
      if (b) { setEffort(b.dataset.effort); field.focus() }
    })

    // Place it against the pill: above when the pill sits low (the chat composer),
    // below when there is room (the hero). Clamped to the window either way.
    const place = () => {
      const r = anchor.getBoundingClientRect()
      const w = el.offsetWidth, h = el.offsetHeight, pad = 12
      const below = window.innerHeight - r.bottom - pad
      const top = below >= h + 8 || below > r.top ? r.bottom + 8 : r.top - 8 - h
      el.style.top = Math.max(pad, top) + 'px'
      el.style.left = Math.min(Math.max(pad, r.left), window.innerWidth - w - pad) + 'px'
      el.dataset.side = top > r.top ? 'below' : 'above'
    }
    place()
    requestAnimationFrame(() => el.classList.add('is-in'))
    anchor.setAttribute('aria-expanded', 'true')
    field.focus()

    const onDown = e => { if (!el.contains(e.target) && !anchor.contains(e.target)) close() }
    const onResize = () => close()
    document.addEventListener('mousedown', onDown, true)
    window.addEventListener('resize', onResize)
    open = { el, anchor, off() {
      document.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('resize', onResize)
    } }
  }

  window.modelPicker = { show, close, resolve, describe, effortLabel }
})()
