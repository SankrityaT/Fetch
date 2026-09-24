/* Fetch shared dropdown. One custom popover component used anywhere a native
   <select> would otherwise show macOS's own popup: system font, blue
   highlight, none of it drawn from our design system.

   Extracted from the pattern that used to live only inside ui/editor.js (a
   local `dropdown(mount, items, value, onPick)` function) so the setup
   wizard, and anything else, can use the same control.

     window.Dropdown(mount, items, value, onPick)
       mount    an element, or an element id, becomes the dropdown root
       items    [{ id, label, font? }]  (font is optional, a family name such as
                'SF Pro'; the item previews in it, used for the caption font picker)
       value    the id of the currently selected item
       onPick   called with the picked id when the user chooses one

   Calling it again on the same mount rebuilds it in place, so callers can
   just re-run it whenever the item list changes (e.g. devicechange).

   Behaviour: Enter/Space opens the trigger and picks a focused item, since
   both are real <button> elements and get that for free. Arrow keys move
   through the list, Home/End jump to the ends. Escape closes and returns
   focus to the trigger. Clicking outside, or opening a different dropdown,
   closes it too: only one is ever open at a time across the app. Long
   labels are truncated with an ellipsis and kept in full in a title
   tooltip. The menu is the shared popover (.popover in ui/components.css).

     window.Dropdown.close()        closes whichever dropdown is open, for a
                                    caller about to open a modal (L1)
     window.Dropdown.cssFamily(n)   the CSS font stack that previews family n */

;(function () {
  let openDD = null   // at most one dropdown open at a time, across the app

  function closeOpen() {
    if (!openDD) return
    const menu = openDD.querySelector('.dd-menu')
    if (menu) menu.hidden = true
    openDD.dataset.open = 'false'
    openDD = null
  }

  document.addEventListener('click', closeOpen)
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !openDD) return
    const btn = openDD.querySelector('.dd-btn')
    closeOpen()
    if (btn) btn.focus()
    // otherwise this same Escape keeps bubbling and can close a parent
    // modal too: it should only ever close the dropdown that caught it.
    e.stopImmediatePropagation()
    e.preventDefault()
  })

  // macOS system faces have no CSS family of that name: `font-family:SF Pro` falls
  // through to the default serif, so SF Pro and SF Mono previewed in Times (D1).
  // Map each to the generic that reaches it, then any other name is quoted with
  // a sensible generic after it so an absent face never lands in Times either.
  const SYSTEM_FAMILY = {
    'sf pro': '-apple-system, "SF Pro Display", "SF Pro Text", system-ui, sans-serif',
    'sf pro display': '-apple-system, "SF Pro Display", system-ui, sans-serif',
    'sf pro text': '-apple-system, "SF Pro Text", system-ui, sans-serif',
    'sf mono': 'ui-monospace, "SF Mono", Menlo, monospace',
    'new york': 'ui-serif, "New York", Georgia, serif',
    'sf pro rounded': 'ui-rounded, "SF Pro Rounded", system-ui, sans-serif',
  }
  const SERIF = /georgia|times|new york|baskerville|garamond|palatino|serif/i
  const MONO = /mono|courier|menlo|monaco|code/i
  function cssFamily(name) {
    const n = String(name == null ? '' : name).trim()
    if (!n) return ''
    const hit = SYSTEM_FAMILY[n.toLowerCase()]
    if (hit) return hit
    if (/[,"']/.test(n)) return n            // already a stack
    const generic = MONO.test(n) ? 'monospace' : SERIF.test(n) ? 'serif' : 'sans-serif'
    return `"${n}", ${generic}`
  }

  const escHtml = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

  function Dropdown(mount, items, value, onPick) {
    const el2 = typeof mount === 'string' ? document.getElementById(mount) : mount
    if (!el2) return
    items = items && items.length ? items : [{ id: '', label: '' }]
    const label = v => (items.find(i => i.id === v) || items[0] || {}).label || ''

    el2.className = 'dd'
    el2.innerHTML = `
      <button class="dd-btn" type="button">
        <span class="dd-val" title="${escHtml(label(value))}">${escHtml(label(value))}</span>
        ${ico('caret-down', 'icon-sm')}
      </button>
      <div class="dd-menu popover" hidden role="listbox">
        ${items.map(i => `<button class="dd-item popover-row" type="button" data-id="${escHtml(i.id)}" role="option"
          title="${escHtml(i.label)}"
          style="${i.font ? `font-family:${escHtml(cssFamily(i.font))}` : ''}" aria-selected="${i.id === value}">
          <span>${escHtml(i.label)}</span>${ico('check', 'icon-sm popover-check')}</button>`).join('')}
      </div>`

    const btn = el2.querySelector('.dd-btn')
    const menu = el2.querySelector('.dd-menu')
    const optionEls = () => Array.from(menu.querySelectorAll('.dd-item'))

    const open = () => {
      if (openDD && openDD !== el2) closeOpen()
      // open upward when the window has no room below the trigger
      const r = btn.getBoundingClientRect()
      const need = Math.min(260, window.innerHeight * 0.5) + 12
      el2.dataset.side = (window.innerHeight - r.bottom < need && r.top > window.innerHeight - r.bottom) ? 'above' : 'below'
      menu.hidden = false
      const sel = menu.querySelector('[aria-selected="true"]')
      if (sel) sel.scrollIntoView({ block: 'nearest' })
      el2.dataset.open = 'true'
      openDD = el2
    }
    const close = () => {
      menu.hidden = true
      el2.dataset.open = 'false'
      if (openDD === el2) openDD = null
    }

    btn.onclick = e => {
      e.stopPropagation()
      if (menu.hidden) open(); else close()
    }
    btn.onkeydown = e => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      e.preventDefault()
      open()
      const opts = optionEls()
      if (opts.length) opts[e.key === 'ArrowDown' ? 0 : opts.length - 1].focus()
    }

    const pick = b => {
      const id = b.dataset.id
      const val = el2.querySelector('.dd-val')
      val.textContent = label(id)
      val.title = label(id)
      optionEls().forEach(x => x.setAttribute('aria-selected', String(x === b)))
      close()
      btn.focus()
      onPick(id)
    }
    optionEls().forEach((b, i) => {
      b.onclick = e => { e.stopPropagation(); pick(b) }
      b.onkeydown = e => {
        const opts = optionEls()
        if (e.key === 'ArrowDown') { e.preventDefault(); opts[(i + 1) % opts.length].focus() }
        else if (e.key === 'ArrowUp') { e.preventDefault(); opts[(i - 1 + opts.length) % opts.length].focus() }
        else if (e.key === 'Home') { e.preventDefault(); opts[0].focus() }
        else if (e.key === 'End') { e.preventDefault(); opts[opts.length - 1].focus() }
        else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(b) }
        else if (e.key === 'Tab') { close() }
      }
    })

    return el2
  }

  Dropdown.close = closeOpen
  Dropdown.cssFamily = cssFamily
  window.Dropdown = Dropdown
})()
