// Tooltips for every [data-tip] element, as one floating layer.
//
// They used to be a CSS ::after on the element itself, which cannot know where the
// window ends: anything near an edge ran off it (the chat's mic, the last clip
// action), and any scrolling pane with overflow clipped them. This places a single
// fixed element above the hovered control, kept 8px inside the window, and below it
// when there is no room above. Self-installing; control.html only needs the tag.
;(function () {
  'use strict'
  const MARGIN = 8, GAP = 8
  const tip = document.createElement('div')
  tip.className = 'tip-layer'
  tip.setAttribute('role', 'tooltip')
  document.addEventListener('DOMContentLoaded', () => document.body.appendChild(tip))
  if (document.body) document.body.appendChild(tip)

  let current = null, timer = null

  function place(el) {
    const text = el.getAttribute('data-tip')
    if (!text) return hide()
    tip.textContent = text
    tip.dataset.on = 'true'
    const r = el.getBoundingClientRect()
    const w = tip.offsetWidth, h = tip.offsetHeight
    const vw = window.innerWidth, vh = window.innerHeight
    let left = r.left + r.width / 2 - w / 2
    left = Math.max(MARGIN, Math.min(vw - w - MARGIN, left))
    let top = r.top - h - GAP
    let side = 'above'
    if (top < MARGIN) { top = Math.min(vh - h - MARGIN, r.bottom + GAP); side = 'below' }
    tip.style.left = Math.round(left) + 'px'
    tip.style.top = Math.round(top) + 'px'
    tip.dataset.side = side
  }

  function hide() {
    clearTimeout(timer)
    current = null
    tip.dataset.on = 'false'
  }

  document.addEventListener('mouseover', e => {
    const el = e.target.closest && e.target.closest('[data-tip]')
    if (el === current) return
    if (!el) return hide()
    current = el
    clearTimeout(timer)
    // a short delay so sweeping across a toolbar does not flash every label
    timer = setTimeout(() => { if (current === el && el.isConnected) place(el) }, 120)
  })
  document.addEventListener('focusin', e => {
    const el = e.target.closest && e.target.closest('[data-tip]')
    if (el && el.matches(':focus-visible')) { current = el; place(el) }
  })
  document.addEventListener('focusout', hide)
  document.addEventListener('mousedown', hide, true)
  window.addEventListener('scroll', hide, true)
  window.addEventListener('blur', hide)
})()
