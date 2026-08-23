// Toast discipline, applied globally by wrapping toast() rather than trusting
// every call site. A library refresh can kick off one background job per clip,
// and each completion posting its own toast buries the app in a wall of them.
//
// Three rules:
//   1. Never show more than MAX at once, oldest goes first.
//   2. Repeats collapse into one toast with a count, they do not stack.
//   3. Background chatter is dropped entirely, it is not news.
;(() => {
  const MAX = 3
  const QUIET = /^(thumbnail|waveform|filmstrip)\b/i

  const install = () => {
    if (typeof window.toast !== 'function' || window.toast.__guarded) return false
    const original = window.toast
    const recent = new Map()   // message -> { el, count, at }

    const guarded = function (msg, kind = '', ms = 3800) {
      const text = String(msg == null ? '' : msg)

      // routine background work finishing is not worth a notification
      if (QUIET.test(text) && kind !== 'bad') return

      const box = document.getElementById('toasts')
      const seen = recent.get(text)
      if (seen && box && box.contains(seen.el)) {
        seen.count++
        let badge = seen.el.querySelector('.toast-count')
        if (!badge) {
          badge = document.createElement('span')
          badge.className = 'toast-count'
          seen.el.appendChild(badge)
        }
        badge.textContent = String(seen.count)
        return
      }

      original(text, kind, ms)

      if (box) {
        const el = box.lastElementChild
        if (el) {
          recent.set(text, { el, count: 1 })
          setTimeout(() => { if (recent.get(text) && recent.get(text).el === el) recent.delete(text) }, ms + 400)
        }
        // trim the oldest so the stack can never run off screen
        while (box.children.length > MAX) box.firstElementChild.remove()
      }
    }
    guarded.__guarded = true
    window.toast = guarded
    return true
  }

  if (!install()) window.addEventListener('load', install)
})()
