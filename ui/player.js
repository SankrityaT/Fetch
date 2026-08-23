// In-app player. Clicking a clip used to reveal it in Finder, which meant leaving
// the app to watch your own recording. Self-installing: injects its own styles.
;(() => {
  if (document.getElementById('player-css')) return
  const link = document.createElement('link')
  link.id = 'player-css'; link.rel = 'stylesheet'; link.href = './ui/player.css'
  document.head.appendChild(link)
})()

function openPlayer(clip) {
  const src = typeof clip === 'string' ? clip : clip.path
  const name = (typeof clip === 'string' ? clip.split('/').pop() : clip.name) || 'Recording'
  const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

  const scrim = document.createElement('div')
  scrim.className = 'scrim'
  scrim.innerHTML = `
    <div class="player" role="dialog" aria-label="Player">
      <div class="pl-head">
        <span class="pl-name">${name.replace(/</g, '&lt;')}</span>
        <div style="flex:1"></div>
        <button class="btn btn-ghost btn-icon btn-sm" data-act="edit" data-tip="Edit">
          <svg class="icon-sm"><use href="./assets/icons/sprite.svg#i-scissors"/></svg></button>
        <button class="btn btn-ghost btn-icon btn-sm" data-act="reveal" data-tip="Show in Finder">
          <svg class="icon-sm"><use href="./assets/icons/sprite.svg#i-folder-open"/></svg></button>
        <button class="btn btn-ghost btn-icon btn-sm" data-close data-tip="Close">
          <svg class="icon-sm"><use href="./assets/icons/sprite.svg#i-x"/></svg></button>
      </div>

      <div class="pl-stage"><video id="plVideo" preload="auto"></video>
        <button class="pl-tapzone" data-act="toggle" aria-label="Play or pause"></button>
        <div class="pl-big" id="plBig"><svg class="icon-lg"><use href="./assets/icons/sprite.svg#i-play-fill"/></svg></div>
      </div>

      <div class="pl-bar">
        <button class="pl-btn" data-act="toggle" id="plToggle">
          <svg class="icon-sm"><use href="./assets/icons/sprite.svg#i-play-fill"/></svg></button>
        <span class="pl-time mono" id="plTime">0:00</span>
        <div class="pl-track" id="plTrack"><div class="pl-buf"></div><div class="pl-fill" id="plFill"></div>
          <div class="pl-knob" id="plKnob"></div></div>
        <span class="pl-time mono dimmer" id="plDur">0:00</span>
        <button class="pl-btn" data-act="mute" id="plMute">
          <svg class="icon-sm"><use href="./assets/icons/sprite.svg#i-speaker-high"/></svg></button>
      </div>
    </div>`
  document.body.appendChild(scrim)

  const $$ = s => scrim.querySelector(s)
  const v = $$('#plVideo')
  v.src = 'file://' + src

  // MediaRecorder webm has no duration until you seek past the end
  const settle = () => {
    if (isFinite(v.duration) && v.duration > 0) { $$('#plDur').textContent = fmt(v.duration); return }
    v.currentTime = 1e7
    v.ontimeupdate = () => {
      if (!isFinite(v.duration) || v.duration <= 0) return
      v.ontimeupdate = null; v.currentTime = 0
      $$('#plDur').textContent = fmt(v.duration)
    }
  }
  v.addEventListener('loadedmetadata', settle)
  if (v.readyState >= 1) settle()

  const icon = n => `<svg class="icon-sm"><use href="./assets/icons/sprite.svg#i-${n}"/></svg>`
  const paint = () => {
    const p = v.duration ? (v.currentTime / v.duration) * 100 : 0
    $$('#plFill').style.width = p + '%'
    $$('#plKnob').style.left = p + '%'
    $$('#plTime').textContent = fmt(v.currentTime || 0)
  }
  const toggle = () => v.paused ? v.play() : v.pause()

  v.ontimeupdate = paint
  v.onplay = () => { $$('#plToggle').innerHTML = icon('pause-fill'); scrim.dataset.playing = 'true' }
  v.onpause = () => { $$('#plToggle').innerHTML = icon('play-fill'); scrim.dataset.playing = 'false' }
  v.onended = () => { scrim.dataset.playing = 'false' }

  scrim.querySelectorAll('[data-act="toggle"]').forEach(b => b.onclick = toggle)
  $$('#plMute').onclick = () => {
    v.muted = !v.muted
    $$('#plMute').innerHTML = icon(v.muted ? 'speaker-slash' : 'speaker-high')
  }

  // scrub by click or drag
  const track = $$('#plTrack')
  const seekTo = e => {
    const r = track.getBoundingClientRect()
    const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width))
    if (v.duration) { v.currentTime = f * v.duration; paint() }
  }
  track.addEventListener('mousedown', e => {
    seekTo(e)
    const move = ev => seekTo(ev)
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
  })

  const close = () => {
    v.pause(); v.removeAttribute('src'); v.load()
    document.removeEventListener('keydown', keys)
    scrim.remove()
  }
  function keys(e) {
    if (e.key === 'Escape') return close()
    if (e.key === ' ') { e.preventDefault(); toggle() }
    if (e.key === 'ArrowRight') v.currentTime = Math.min(v.duration || 0, v.currentTime + 5)
    if (e.key === 'ArrowLeft') v.currentTime = Math.max(0, v.currentTime - 5)
  }
  document.addEventListener('keydown', keys)

  scrim.querySelectorAll('[data-close]').forEach(b => b.onclick = close)
  scrim.onclick = e => { if (e.target === scrim) close() }
  $$('[data-act="reveal"]').onclick = () => require('electron').ipcRenderer.send('reveal', src)
  $$('[data-act="edit"]').onclick = () => { close(); if (typeof openInEditor === 'function') openInEditor(src) }

  v.play().catch(() => {})
}
