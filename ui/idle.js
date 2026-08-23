// Biscuit dozes on the hero. Resting is his default state on this screen rather
// than an away-indicator, so there is no timer and moving the mouse does not
// disturb him: he gets up when you commit to a take, and settles back afterwards.
//
// Kept in its own file so it does not touch the record flow.
;(() => {
  const CLIP = './assets/mascot/motion/sleeping.webm'
  const STILL = './assets/mascot/sleeping.png'
  const AWAKE = './assets/mascot/idle.png'
  // the controls that mean "I am about to record", and so should wake him
  const WAKERS = '#start, #setupBtn, #editSetup'

  const hero = () => document.getElementById('biscuit')
  const onRecordView = () => {
    const v = document.querySelector('.view[data-view="record"]')
    return v && !v.hidden
  }
  const busy = () => {
    try { return typeof rec !== 'undefined' && rec && rec.state !== 'inactive' } catch { return false }
  }
  const counting = () => {
    const c = document.getElementById('countdown')
    return c && !c.hidden
  }

  function nap() {
    const img = hero()
    if (!img || img.dataset.sleeping === 'true') return
    if (!onRecordView() || busy() || counting()) return

    const v = document.createElement('video')
    v.id = 'biscuit'
    v.className = img.className.replace(/\s*biscuit-asleep/, '') + ' biscuit-asleep'
    v.src = CLIP
    v.poster = STILL
    v.autoplay = v.loop = v.muted = v.playsInline = true
    v.dataset.sleeping = 'true'
    // if the clip cannot decode, the still is a perfectly good sleeping dog
    v.onerror = () => v.replaceWith(Object.assign(new Image(),
      { id: 'biscuit', className: img.className, src: STILL }))
    // a covered window gets its media throttled, so pick the nap back up on return
    v.addEventListener('pause', () => {
      if (document.visibilityState === 'visible' && v.dataset.sleeping === 'true') v.play().catch(() => {})
    })
    img.replaceWith(v)
    v.play().catch(() => {})
  }

  function wake() {
    const el = hero()
    if (!el || el.dataset.sleeping !== 'true') return
    const img = new Image()
    img.id = 'biscuit'
    img.className = el.className.replace(/\s*biscuit-asleep/, '')
    img.src = AWAKE
    el.replaceWith(img)
  }

  // getting up is a deliberate act: only the record controls do it
  document.addEventListener('click', e => {
    if (e.target.closest && e.target.closest(WAKERS)) wake()
  }, true)

  // settle back down whenever the hero screen comes back around
  const settle = () => { if (onRecordView() && !busy() && !counting()) nap() }
  const view = () => document.querySelector('.view[data-view="record"]')
  const watch = () => {
    const v = view()
    if (!v) return setTimeout(watch, 200)
    new MutationObserver(() => setTimeout(settle, 80))
      .observe(v, { attributes: true, attributeFilter: ['hidden'] })
    settle()
  }
  document.addEventListener('visibilitychange', () => {
    const e = hero()
    if (document.visibilityState === 'visible' && e && e.dataset.sleeping === 'true' && e.paused) {
      e.play().catch(() => {})
    }
  })

  window.addEventListener('load', watch)
  watch()

  window.Biscuit = { nap, wake, isAsleep: () => { const e = hero(); return !!e && e.dataset.sleeping === 'true' } }
})()
