/* Fetch renderer. Record, Library, Edit. */
const { ipcRenderer } = require('electron')
const fs = require('fs'), os = require('os'), path = require('path')

const $ = id => document.getElementById(id)
const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n }
const ico = (name, cls = 'icon') => `<svg class="${cls}"><use href="./assets/icons/sprite.svg#i-${name}"/></svg>`
const fmtTime = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
const fmtAgo = ms => {
  const m = (Date.now() - ms) / 6e4
  if (m < 1) return 'just now'
  if (m < 60) return `${Math.floor(m)}m ago`
  if (m < 1440) return `${Math.floor(m / 60)}h ago`
  return `${Math.floor(m / 1440)}d ago`
}

// ── Biscuit reacts to app state ──────────────────────────────────────────
const MOODS = {
  idle:    ['idle',        'Screen, camera and mic. Set it up once and go.'],
  arming:  ['excited',     'Here we go...'],
  rec:     ['recording',   'Rolling. Go get it.'],
  paused:  ['thinking',    'Holding that thought.'],
  working: ['thinking',    'Working on it...'],
  done:    ['done',        'Got it. Saved to your Fetch folder.'],
  error:   ['sad',         'That did not go through.'],
  happy:   ['happy',       'Nice.'],
  excited: ['excited',     'Ready?'],
}
const face = pose => `./assets/mascot/${pose}.png`
function mood(k) {
  const [pose, line] = MOODS[k] || MOODS.idle
  // anything other than sitting idle means he is needed, so get him up first
  if (k !== 'idle' && window.Biscuit) window.Biscuit.wake()
  const el2 = $('biscuit')
  if (el2 && el2.dataset.sleeping !== 'true') {
    el2.classList.add('face-swap')
    el2.src = face(pose)
    setTimeout(() => el2.classList.remove('face-swap'), 260)
  }
  if ($('biscuitLine')) $('biscuitLine').textContent = line
}

// ── toasts ───────────────────────────────────────────────────────────────
function toast(msg, kind = '', ms = 3800) {
  const icon = kind === 'ok' ? 'check-circle-fill' : kind === 'bad' ? 'warning-circle-fill' : 'paw-print'
  const t = el('div', `toast ${kind}`, `${ico(icon, 'icon-sm')}<span>${msg}</span>`)
  $('toasts').appendChild(t)
  setTimeout(() => { t.style.transition = 'opacity .25s, transform .25s'; t.style.opacity = 0; t.style.transform = 'translateY(8px)'; setTimeout(() => t.remove(), 260) }, ms)
}

// ── views ────────────────────────────────────────────────────────────────
function show(view) {
  document.querySelectorAll('#nav button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.view === view)))
  document.querySelectorAll('.view').forEach(v => { v.hidden = v.dataset.view !== view })
  if (view === 'library') refreshLibrary()
  if (view === 'activity' && window.refreshActivity) window.refreshActivity()
  if (view === 'record') paintHeroCta()      // the pref may have changed in Settings
}
$('nav').addEventListener('click', e => {
  const b = e.target.closest('button[data-view]')
  if (b && !b.disabled) show(b.dataset.view)
})

// ── source preview on the hero card stays live ──────────────────────────
const usableThumb = t => typeof t === 'string' && t.length > 512   // empty captures come back as a stub
// get-sources enumerates every screen and window, grabs a 1000x640 thumbnail of each
// and base64s the lot over IPC: about 300ms of work. Running it every two seconds
// cost roughly 15% of a core for as long as the app sat open, purely to keep one tile
// fresh. Refresh when attention actually returns instead, and keep only a slow
// heartbeat while the window is genuinely being looked at.
let thumbBusy = false
async function refreshSourceThumb() {
  if (thumbBusy) return
  if (setup.mode === 'window' ? !setup.window : !setup.source || setup.mode !== 'screen') return
  if (document.querySelector('.view[data-view="record"]').hidden) return
  if (document.querySelector('.scrim')) return                      // the wizard is polling instead
  if (document.visibilityState !== 'visible' || !document.hasFocus()) return
  if (recording()) return
  if (setup.mode === 'window') { refreshWindowTarget(); return }
  thumbBusy = true
  try {
    const fresh = (await ipcRenderer.invoke('get-sources')).find(x => x.id === setup.source.id)
    if (fresh && usableThumb(fresh.thumb)) { setup.source.thumb = fresh.thumb; $('sourceThumb').src = fresh.thumb }
  } catch {} finally { thumbBusy = false }
}

// A window can close under the setup card, or end a take by closing. Find it again:
// the same id, or the same app and title reopened under a new one. Failing both, the
// card goes back to asking for a window rather than naming one that is gone.
async function refreshWindowTarget(withShot = true) {
  const w = setup.window
  if (setup.mode !== 'window' || !w || thumbBusy) return !!w
  thumbBusy = true
  try {
    let list
    try { list = await ipcRenderer.invoke('list-windows') } catch { return true }
    // an empty list is the helper failing (it answers [] on a timeout), not every
    // window on the Mac closing, so the pick stands
    if (!list || !list.length) return true
    if (setup.window !== w) return !!setup.window
    const hit = (list || []).find(x => x.id === w.id) ||
      (list || []).find(x => x.app === w.app && x.title === w.title)
    if (!hit) { setup.window = null; applySetup(); return false }
    let shot = null
    if (withShot) try { shot = await ipcRenderer.invoke('window-shot', hit.id, 520) } catch {}
    if (setup.window !== w) return !!setup.window
    setup.window = { ...hit, shot: usableThumb(shot) ? shot : w.shot }
    if (hit.id !== w.id) applySetup()           // the halo follows the new id
    else paintHeroReady()
    return true
  } finally { thumbBusy = false }
}
// a picture that fails to load falls back to the tile under it, never a broken image
$('sourceThumb').addEventListener('error', e => e.target.removeAttribute('src'))
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshSourceThumb()
})
window.addEventListener('focus', refreshSourceThumb)
setInterval(refreshSourceThumb, 20000)

// With quick record on, the hero button is the record button. Anything else is a
// lie about what pressing it does.
function paintHeroCta() {
  const b = $('setupBtn'); if (!b) return
  const quick = !!(window.prefs && window.prefs.quickRecord)
  b.classList.toggle('btn-record', quick)
  b.classList.toggle('btn-primary', !quick)
  b.classList.toggle('btn-lg', !quick)
  b.innerHTML = quick
    ? `<span class="dot"></span> Start recording`
    : `${ico('sliders-horizontal', 'icon-sm')} Set up recording`
  const hint = document.querySelector('.hero-sub')
  if (hint) hint.textContent = quick
    ? 'Using your saved defaults. Change them in Settings.'
    : 'Screen, camera and mic. Set it up once and go.'
}
window.paintHeroCta = paintHeroCta

$('setupBtn').onclick = () => {
  // Quick record starts straight away using the saved defaults, no wizard.
  if (window.prefs && window.prefs.quickRecord) {
    applySetup()
    startRecording()
    return
  }
  openSetup()
}
$('editSetup').onclick = () => openSetup()

// ── recording ────────────────────────────────────────────────────────────
let rec = null, stream = null, ticker = null, startedAt = 0, pausedFor = 0, pauseMark = 0

// Screen recording refused is the one failure that cannot be retried in place:
// macOS never asks twice, and the grant only takes effect on relaunch. A toast
// saying "go to System Settings" is where a first run dies, so hand over the two
// buttons that actually resolve it.
function screenBlocked() {
  mood('error')
  const scrim = el('div', 'scrim')
  scrim.innerHTML = `
    <div class="modal" style="width:min(460px,92vw)">
      <div class="modal-body" style="text-align:center;display:grid;gap:12px;justify-items:center">
        <img class="biscuit" src="./assets/mascot/sad.png" alt="" style="width:96px;height:96px">
        <h3 style="font-family:var(--font-display);font-size:var(--t-24);letter-spacing:-.03em">
          macOS will not let Fetch see your screen</h3>
        <p class="dim" style="font-size:var(--t-13);line-height:1.5">
          Turn Fetch on under Screen &amp; System Audio Recording, then come back and relaunch.
          macOS only applies it on a restart.</p>
      </div>
      <div class="modal-foot" style="gap:8px">
        <button class="btn btn-sm btn-ghost" id="pbSetup">Run setup again</button>
        <div style="flex:1"></div>
        <button class="btn btn-sm btn-ghost" data-close>Not now</button>
        <button class="btn btn-sm" id="pbRelaunch">Relaunch</button>
        <button class="btn btn-sm btn-primary" id="pbOpen">Open System Settings</button>
      </div>
    </div>`
  document.body.appendChild(scrim)
  const close = () => scrim.remove()
  scrim.querySelectorAll('[data-close]').forEach(b => b.onclick = close)
  scrim.onclick = e => { if (e.target === scrim) close() }
  scrim.querySelector('#pbOpen').onclick = () => ipcRenderer.invoke('open-privacy', 'screen')
  scrim.querySelector('#pbRelaunch').onclick = () => ipcRenderer.invoke('relaunch')
  scrim.querySelector('#pbSetup').onclick = () => {
    close()
    if (typeof window.startOnboarding === 'function') window.startOnboarding()
  }
}
window.screenBlocked = screenBlocked

async function buildStream() {
  let screenStream
  const wantSys = setup.sys
  try {
    // `video: true` left everything to Chromium: 30fps and whatever bitrate it felt
    // like, which for a Retina screen worked out at about 0.02 bits per pixel.
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: { ideal: PREFERRED_FPS, max: PREFERRED_FPS },
        width: { ideal: 4096 }, height: { ideal: 4096 },   // never scale the display down
      },
      audio: wantSys,
    })
  } catch (e) {
    throw new Error('Screen recording is blocked. Allow Fetch in System Settings → Privacy → Screen Recording.')
  }
  const ctx = new AudioContext()
  const dest = ctx.createMediaStreamDestination()
  let any = false

  // Computer audio comes from Electron's loopback by default. If a virtual device
  // like BlackHole was chosen in setup, capture that input instead, which is how
  // people route a single app's sound.
  if (wantSys && setup.sysId) {
    try {
      const sys = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: setup.sysId } } })
      ctx.createMediaStreamSource(sys).connect(dest); any = true
    } catch {
      toast('That audio device is unavailable, falling back to system audio', 'bad')
      if (screenStream.getAudioTracks().length) {
        ctx.createMediaStreamSource(new MediaStream(screenStream.getAudioTracks())).connect(dest); any = true
      }
    }
  } else if (screenStream.getAudioTracks().length) {
    ctx.createMediaStreamSource(new MediaStream(screenStream.getAudioTracks())).connect(dest); any = true
  } else if (wantSys) toast('No system audio available, recording mic only')
  if (setup.mic) {
    try {
      const m = await navigator.mediaDevices.getUserMedia({
        audio: setup.micId ? { deviceId: { exact: setup.micId } } : true })
      ctx.createMediaStreamSource(m).connect(dest); any = true
    } catch { toast('Microphone unavailable', 'bad') }
  }
  const vt = screenStream.getVideoTracks()[0]
  // tells the encoder this is sharp-edged UI, not camera footage
  try { vt.contentHint = 'text' } catch {}
  const tracks = [vt]
  if (any) tracks.push(dest.stream.getAudioTracks()[0])
  return new MediaStream(tracks)
}

// Screen content is mostly static with hard edges, so it wants a far bigger budget
// than Chromium's default. Scaled from the pixels actually being captured rather
// than hardcoded, so a small window does not get a firehose and a 6K display does
// not get starved.
const PREFERRED_FPS = 60
function bitrateFor(track) {
  const s = track.getSettings ? track.getSettings() : {}
  const w = s.width || 1920, h = s.height || 1080, fps = s.frameRate || 30
  const bits = Math.round(w * h * fps * 0.09)          // ~0.09 bits per pixel
  return Math.max(12e6, Math.min(60e6, bits))
}

function tick() {
  const secs = (Date.now() - startedAt - pausedFor) / 1000
  ipcRenderer.send('hud-tick', { time: fmtTime(secs), paused: nativeTake ? recState === 'paused' : !!(rec && rec.state === 'paused') })
}

async function countdown() {
  const secs = window.prefs && Number.isInteger(window.prefs.countdown) ? window.prefs.countdown : 3
  if (secs <= 0 || window.__quietTake) return      // an agent's take has no one to count down for
  const cd = $('countdown')
  if (!cd.querySelector('.motion')) {
    const v = document.createElement('video')
    v.className = 'motion countdown-dog'
    v.src = './assets/mascot/motion/fetch-away.webm'
    v.autoplay = v.loop = v.muted = v.playsInline = true
    v.onerror = () => v.replaceWith(Object.assign(new Image(),
      { src: './assets/mascot/running.png', className: 'motion countdown-dog' }))
    cd.prepend(v)
  }
  cd.hidden = false
  for (const n of Array.from({ length: secs }, (_, i) => secs - i)) {
    $('countNum').textContent = n
    $('countNum').style.animation = 'none'; void $('countNum').offsetWidth; $('countNum').style.animation = ''
    await new Promise(r => setTimeout(r, 700))
  }
  $('countdown').hidden = true
}

// Everything that happens once a take exists on disk, whichever recorder made it.
// Name a take after what it recorded, before anyone is told where it is. Doing it
// after 'take-finished' would hand an agent waiting on record_start a path that no
// longer exists a moment later.
//
// Only window takes can be named here, since only they carry an app and a title.
// A full-screen take keeps its timestamp until it is transcribed, and is renamed from
// what was said then (see the editor's transcribe handler).
async function nameTake(file) {
  if (setup.mode !== 'window' || !setup.window) return file
  const naming = require('./ui/naming')
  const stem = naming.smartName({ app: setup.window.app, title: setup.window.title })
  if (!stem) return file
  try {
    return await renameTake(file, stem)
  } catch (e) {
    console.error('could not name the take:', e.message)
    return file          // the recording matters more than its name
  }
}

// An agent's take borrowed the setup card (applySetup in agent-bridge.js kept the
// person's own aside). Once the take is over, named or failed, it goes back.
function restorePersonSetup() {
  const was = window.__personSetup
  if (!was) return
  window.__personSetup = null
  Object.assign(setup, was)
  applySetup()
  paintHeroCta()           // applySetup relabels the first chip "Change setup"
}

async function finishTake(file, mb, info = {}) {
  file = await nameTake(file)
  restorePersonSetup()
  // Tell main a take landed. hotkey() is fire-and-forget, so without this an agent
  // that asked for a recording has no way to learn where the file went.
  try { ipcRenderer.send('take-finished', { ...info, file, mb: +mb }) } catch {}
  // A background take lands in the library and the agent gets its path. Nothing pops
  // up over whatever the person is doing.
  // The stop above left him on "Working on it...", which stayed until someone
  // changed view; hand the hero back to its resting line.
  if (window.__quietTake) { window.__quietTake = false; mood('idle'); paintHeroCta(); refreshLibrary(); return }
  mood('done')
  refreshLibrary()
  const pf = window.prefs || {}
  if (pf.autoConvertMp4) runJob({ op: 'mp4', src: file }, 'MP4 copy', { done: 'Saved an MP4 copy' }).then(() => refreshLibrary())
  if (pf.openEditorAfter) { openInEditor(file); return }     // straight to the editor, no prompt
  afterRecording(file, mb)
}

// The native recorder captures with ScreenCaptureKit and encodes on the media
// engine, so it holds 60fps without stealing CPU from whatever is being recorded.
// It is not available everywhere, so this returns false and the caller falls back.
let nativeTake = false

function nativeTarget() {
  // desktopCapturer ids look like "screen:<CGDirectDisplayID>:0" and our own window
  // ids like "window:<CGWindowID>:0"
  if (setup.mode === 'window' && setup.window) return { windowId: +setup.window.id }
  const id = setup.source && setup.source.id
  const m = /^screen:(\d+)/.exec(id || '')
  return m ? { displayId: +m[1] } : {}
}

async function startNative() {
  let avail
  try { avail = await ipcRenderer.invoke('native-available') } catch { return false }
  if (!avail || !avail.ok) return false
  // The mic only rides along on macOS 15+. Below that the Chromium path is the only
  // way to get voice, so bail out here rather than after starting: the old order
  // spawned a recorder, wrote a file, stopped it and orphaned it in the temp folder
  // on every single take.
  if (setup.mic && !avail.mic) return false
  const r = await ipcRenderer.invoke('native-start', {
    ...nativeTarget(),
    fps: 60,
    systemAudio: !!setup.sys,
    mic: !!setup.mic,
    hevc: false,
  })
  if (!r || !r.ok) {
    // a real failure is worth knowing about, but it must not stop the take
    if (r && r.error) console.log('native recorder unavailable:', r.error)
    return false
  }
  console.log(`native capture ${r.width}x${r.height} @${r.fps}fps ${r.codec}`)
  return true
}

// A second stop (the hotkey again, an agent's record_stop landing on a take that
// already ended) must not start a second commit of the same file.
let nativeStopping = false
async function stopNative(ended) {
  if (nativeStopping) return
  nativeStopping = true
  try { await stopNativeOnce(ended) } finally { nativeStopping = false }
}
async function stopNativeOnce(ended) {
  const r = await ipcRenderer.invoke('native-stop')
  ipcRenderer.send('cam-record', false)
  ipcRenderer.send('cam-visible', false)
  ipcRenderer.send('rec-state', 'idle')
  ipcRenderer.send('cursor-track', false)
  clearInterval(ticker); ticker = null
  $('start').disabled = false
  nativeTake = false
  recState = 'idle'
  const gone = ((r && r.kind) || (ended && ended.kind)) === 'display' ? 'The display' : 'The window'
  if (!r || !r.ok) {
    const why = r && r.endedAlone ? `${gone} went away before anything was recorded.`
      : r && r.error ? r.error : 'Nothing was captured'
    try { ipcRenderer.send('take-failed', { error: why }) } catch {}
    restorePersonSetup()
    mood('error'); toast(why, 'bad')
    if (r && r.endedAlone) refreshWindowTarget()
    return
  }
  mood('working')
  const c = await ipcRenderer.invoke('native-commit', r.tmp)
  if (!c || !c.ok) {
    // the take is still on disk, so say where rather than losing someone's recording
    restorePersonSetup()
    mood('error')
    toast(`Could not save it. The recording is at ${r.tmp}`, 'bad', 12000)
    try { ipcRenderer.send('take-failed', { error: `could not save the take, it is at ${r.tmp}` }) } catch {}
    return
  }
  if (r.dropped) console.log(`dropped ${r.dropped} frames of ${r.frames}`)
  const mb = (require('fs').statSync(c.file).size / 1e6).toFixed(1)
  // how long a window sent nothing new, so an agent can be told its window was covered
  const still = r.kind === 'window' && r.stillMs ? { stillMs: r.stillMs } : {}
  if (!r.endedAlone) { finishTake(c.file, mb, still); return }
  // Named from the window it recorded before the card forgets that window
  await finishTake(c.file, mb, { ...still, endedAlone: true, reason: `${gone.toLowerCase()} went away` })
  toast(`${gone} went away, so the recording stopped. Saved what was captured.`, '', 7000)
  refreshWindowTarget()
}
// The recorder lost what it was capturing and gave up looking for it. Its file is
// finished, so end the take the way Stop would.
ipcRenderer.on('native-ended', (e, info) => { if (nativeTake) stopNative(info || {}) })

async function startRecording() {
  // A window that has since closed would otherwise fall through to recording the
  // whole screen, which is not what anyone picked.
  if (setup.mode === 'window' && !(await refreshWindowTarget(false))) {
    const why = 'That window is closed. Pick another one.'
    try { ipcRenderer.send('take-failed', { error: why }) } catch {}
    if (window.__quietTake) { window.__quietTake = false; restorePersonSetup(); return }
    mood('error'); toast(why, 'bad'); openSetup()
    return
  }
  try {
    mood('arming')
    $('start').disabled = true
    // The camera needs seconds to come up, so it starts now and the countdown covers
    // it; the screen waits for it, or the first line would have no face.
    const camArmed = setup.cam ? ipcRenderer.invoke('cam-arm').catch(() => null) : null
    await countdown()
    if (camArmed) await camArmed

    nativeTake = await startNative()
    if (nativeTake) {
      startedAt = Date.now(); pausedFor = 0
      if (setup.cam) {
        ipcRenderer.send('cam-visible', true)
        ipcRenderer.send('cam-record', true, startedAt)
      }
      ipcRenderer.send('rec-state', 'recording')
      ipcRenderer.send('cursor-track', true)
      ticker = setInterval(tick, 250); tick()
      mood('rec')
      return
    }

    stream = await buildStream()
    const chunks = []                       // per-take buffer, never shared between takes
    let mime = 'video/webm;codecs=vp9,opus'
    if (!MediaRecorder.isTypeSupported(mime)) mime = 'video/webm'
    const vTrack = stream.getVideoTracks()[0]
    const vbps = bitrateFor(vTrack)
    rec = new MediaRecorder(stream, {
      mimeType: mime,
      videoBitsPerSecond: vbps,
      audioBitsPerSecond: 192e3,
    })
    const got = vTrack.getSettings ? vTrack.getSettings() : {}
    console.log(`capture ${got.width}x${got.height} @${Math.round(got.frameRate || 0)}fps, ` +
                `video ${(vbps / 1e6).toFixed(1)} Mbit/s`)
    const owned = rec
    rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data) }
    rec.onstop = async () => {
      owned.ondataavailable = null
      ipcRenderer.send('cam-record', false)   // finalise the movie before the helper is killed
      ipcRenderer.send('cam-visible', false)
      ipcRenderer.send('rec-state', 'idle')
      ipcRenderer.send('cursor-track', false)
      stream.getTracks().forEach(t => t.stop())
      clearInterval(ticker); ticker = null
      $('start').disabled = false
      const blob = new Blob(chunks, { type: 'video/webm' })
      if (!blob.size) {
        try { ipcRenderer.send('take-failed', { error: 'Nothing was captured' }) } catch {}
        restorePersonSetup()
        mood('error'); toast('Nothing was captured', 'bad'); return
      }
      mood('working')
      const file = await ipcRenderer.invoke('save', new Uint8Array(await blob.arrayBuffer()))
      mood('done')
      refreshLibrary()
      const pf = window.prefs || {}
      finishTake(file, (blob.size / 1e6).toFixed(1))
    }
    stream.getVideoTracks()[0].onended = () => { if (rec && rec.state !== 'inactive') rec.stop() }
    rec.start(1000)
    startedAt = Date.now(); pausedFor = 0
    if (setup.cam) {
      ipcRenderer.send('cam-visible', true)   // camera only exists while recording
      // recorded to its own file, so the bubble stays movable in the editor
      ipcRenderer.send('cam-record', true, startedAt)
    }
    ipcRenderer.send('rec-state', 'recording')
    ipcRenderer.send('cursor-track', true)      // sampled in the main process while we record
    ticker = setInterval(tick, 250); tick()
    mood('rec')
  } catch (e) {
    $('countdown').hidden = true
    $('start').disabled = false
    ipcRenderer.send('cam-disarm')          // no take, so no camera left rolling for it
    try { ipcRenderer.send('take-failed', { error: e.message }) } catch {}
    // An agent's take that never started still hands the card back, and must not
    // leave the person's next take running as a hidden background one.
    window.__quietTake = false
    restorePersonSetup()
    if (/screen recording is blocked/i.test(e.message || '')) screenBlocked()
    else { mood('error'); toast(e.message, 'bad', 7000) }
  }
}

$('start').onclick = startRecording
function stopRecording() {
  if (nativeTake) { stopNative(); return }
  if (rec && rec.state !== 'inactive') { rec.requestData(); rec.stop() }
}
function togglePause() {
  if (nativeTake) {
    const paused = recState === 'paused'
    ipcRenderer.send(paused ? 'native-resume' : 'native-pause')
    if (paused) { pausedFor += Date.now() - pauseMark; mood('rec'); recState = 'recording' }
    else { pauseMark = Date.now(); mood('paused'); recState = 'paused' }
    ipcRenderer.send('rec-state', recState)
    tick()
    return
  }
  if (!rec) return
  if (rec.state === 'recording') {
    rec.pause(); pauseMark = Date.now(); mood('paused')
    ipcRenderer.send('rec-state', 'paused')
  } else if (rec.state === 'paused') {
    rec.resume(); pausedFor += Date.now() - pauseMark; mood('rec')
    ipcRenderer.send('rec-state', 'recording')
  }
  tick()
}
let recState = 'idle'
const recording = () => nativeTake || (rec && rec.state !== 'inactive')
function hotkey(action) {
  if (action === 'start') { if (!recording()) startRecording() }
  else if (action === 'stop') stopRecording()
  else if (action === 'pause') togglePause()
}
ipcRenderer.on('hotkey', (e, action) => hotkey(action))
document.addEventListener('keydown', e => {
  if (!(e.metaKey || e.ctrlKey) || !e.shiftKey) return
  const k = e.key.toLowerCase()
  if (k === 'r') { e.preventDefault(); hotkey(recording() ? 'stop' : 'start') }
  if (k === 'p') { e.preventDefault(); hotkey('pause') }
})

// ── jobs ─────────────────────────────────────────────────────────────────
let jobSeq = 0
const jobs = new Map()
ipcRenderer.on('edit-job', (e, j) => {
  const h = jobs.get(j.cid); if (!h) return
  h(j)
})
// quiet: true skips the success toast, for background work the user did not ask
// for (thumbnails, waveforms, filmstrips). Failures always surface either way.
// done replaces "<label> done" where that would not read as a sentence.
function runJob(payload, label, { quiet = false, done = null } = {}) {
  const cid = 'c' + (++jobSeq)
  return new Promise(resolve => {
    jobs.set(cid, j => {
      if (j.status === 'done') { jobs.delete(cid); if (!quiet) toast(done || `${label} done`, 'ok'); resolve(j.result) }
      if (j.status === 'error') { jobs.delete(cid); toast(j.message, 'bad', 6000); resolve(null) }
      if (j.status === 'cancelled') { jobs.delete(cid); resolve(null) }
    })
    ipcRenderer.invoke('edit-job', { ...payload, cid })
  })
}

// ── library ──────────────────────────────────────────────────────────────
// Folders are virtual groupings, kept in ui/library.js (own module, own JSON
// file on disk). It also injects its own stylesheet, so nothing here needs
// to touch control.html.
const Library = require('./ui/library.js')

// Grouping files into takes, and naming each card and export row, lives in its own
// pure module so the rules can be tested without a window.
const { DERIVED, groupTakes, takeTitle, takeWhere, takeRows, exportLabel, libraryColumns, dealColumns } = require('./ui/take-list')

// move to Trash rather than unlink, so a misclick is recoverable (Put Back included)
const trash = paths => ipcRenderer.invoke('trash-items', paths).catch(() => 0)
// Support files live in a hidden folder beside the media, so the save folder only
// holds recordings and exports. Mirrors sidecarPath() in processor.js.
const SIDE_DIR = '.fetch'
const SIDE_EXT = ['.png', '.srt', '.txt', '.cursor.json', '.pointer.json', '.cam.json', '.cam.mov', '.words.json', '.fetchdoc.json', '.vo.mp3']
const sidecarPath = (media, ext) =>
  path.join(path.dirname(media), SIDE_DIR, path.basename(media).replace(/\.[^.]+$/, '') + ext)
const sidecarIn = (media, ext) => {
  const hidden = sidecarPath(media, ext)
  if (fs.existsSync(hidden)) return hidden
  const legacy = media.replace(/\.[^.]+$/, ext)      // clips made before the move
  return fs.existsSync(legacy) ? legacy : hidden
}

const sidecars = p => SIDE_EXT.flatMap(ext => [sidecarPath(p, ext), p.replace(/\.[^.]+$/, ext)])
  .filter(f => fs.existsSync(f))
const escHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

// ── renaming a clip, and its sidecars, in place ─────────────────────────────
function sanitizeClipName(raw) {
  const name = String(raw || '').trim()
  if (!name) return { error: 'Give it a name first.' }
  if (/[/:]/.test(name)) return { error: 'Names can\'t contain / or :.' }
  return { name }
}
// The one rename, for the Library, the editor and agents alike. processor.renameTake
// moves a take folder, its files, sidecars and deliverable together (or a loose file
// and its sidecars) and keeps the import index in step. This side repoints what the
// renderer holds: folder membership, and the clip open in the editor. Returns the new
// path of `file`.
async function renameTake(file, name) {
  const r = await ipcRenderer.invoke('rename-take', file, name)
  for (const [from, to] of r.moves) Library.renamePath(from, to)
  if (typeof window.editorFollowRename === 'function') window.editorFollowRename(r.moves)
  return r.path
}
// derived exports (name-edit.mp4, name-cut.mp4, ...) keep their suffix when renamed
function derivedSuffix(name) {
  const stem = name.replace(/\.[^.]+$/, '')
  const m = stem.match(DERIVED)
  return m ? m[0] : ''
}
function confirmRenameDerived(g, newBase, onChoice) {
  const scrim = el('div', 'scrim')
  scrim.innerHTML = `<div class="modal" style="width:min(430px,92vw)">
    <div class="modal-body" style="text-align:center;display:grid;gap:12px;justify-items:center">
      <img class="biscuit" src="./assets/mascot/thinking.png" alt="" style="width:88px;height:88px">
      <h3 style="font-family:var(--font-display);font-size:var(--t-18);letter-spacing:-.03em">Rename the exports too?</h3>
      <p class="dim" style="font-size:var(--t-12)">This take has ${g.derived.length} export${g.derived.length === 1 ? '' : 's'}.
        They can follow along as "${escHtml(newBase)}${escHtml(derivedSuffix(g.derived[0].name))}" and so on, or stay as they are.</p>
    </div>
    <div class="modal-foot"><div style="flex:1"></div>
      <button class="btn btn-sm" id="renameJustOne">Just this one</button>
      <button class="btn btn-sm btn-primary" id="renameAllToo">Rename all</button></div>
  </div>`
  document.body.appendChild(scrim)
  const close = () => scrim.remove()
  scrim.onclick = e => { if (e.target === scrim) close() }
  scrim.querySelector('#renameJustOne').onclick = () => { close(); onChoice(false) }
  scrim.querySelector('#renameAllToo').onclick = () => { close(); onChoice(true) }
}
function performRename(g, newBase) {
  const finish = async includeDerived => {
    try {
      await renameTake(g.original.path, newBase)
      if (includeDerived) {
        for (const d of g.derived) await renameTake(d.path, newBase + derivedSuffix(d.name))
      }
      toast('Renamed', 'ok')
    } catch (e) {
      toast('Could not rename it: ' + String(e.message || e).replace(/^.*Error: /, ''), 'bad', 6000)
    }
    refreshLibrary()
  }
  // a take folder renames as one, deliverable included, so there is nothing to ask
  if (g.take) finish(false)
  else if (g.derived.length) confirmRenameDerived(g, newBase, finish)
  else finish(false)
}
// swaps the clip title for an inline <input>, no modal. Enter commits, Escape cancels,
// blur commits. The value is pre-filled without the extension.
function startRename(card, g) {
  if (card.dataset.renaming) return
  card.dataset.renaming = '1'
  const c = g.original
  const nameEl = card.querySelector('.clip-name')
  const ext = path.extname(c.path)
  const currentBase = g.take ? path.basename(g.take) : path.basename(c.path, ext)

  const input = document.createElement('input')
  input.className = 'clip-name clip-name-edit'
  // a timestamp name is not worth editing, so start empty with the readable title as a hint
  const stamp = /^recording-\d{12,14}$/i.test(currentBase)
  input.value = stamp ? '' : currentBase
  if (stamp) input.placeholder = takeTitle(g)
  input.maxLength = 200
  nameEl.replaceWith(input)
  input.focus(); input.select()

  let done = false
  const restore = () => { if (!input.isConnected) return; input.replaceWith(nameEl); delete card.dataset.renaming }
  const cancel = () => { if (done) return; done = true; restore() }
  const commit = () => {
    if (done) return
    done = true
    if (stamp && !input.value.trim()) { restore(); return }
    const check = sanitizeClipName(input.value)
    if (check.error) { toast(check.error, 'bad'); restore(); return }
    if (check.name === currentBase) { restore(); return }
    delete card.dataset.renaming
    performRename(g, check.name)
  }
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); commit() }
    else if (e.key === 'Escape') { e.preventDefault(); cancel() }
  })
  input.addEventListener('blur', commit)
}

// re-entry guard: a refresh triggered while one is already in flight (e.g. a thumbnail
// job landing mid-render) is dropped rather than starting a second overlapping wave
let libraryRefreshing = false
async function refreshLibrary() {
  // before the in-flight guard, so a delete during a refresh still closes its take
  if (window.editorCloseIfGone) window.editorCloseIfGone()
  if (libraryRefreshing) return
  libraryRefreshing = true
  try {
    await refreshLibraryOnce()
  } finally {
    libraryRefreshing = false
  }
}
async function refreshLibraryOnce() {
  const list = await ipcRenderer.invoke('list-recordings')
  const grid = $('libGrid')
  grid._cards = null                            // an empty state must not be re-dealt on resize
  const groups = groupTakes(list)

  // the folder bar lives above the grid and survives refreshes as its own element
  Library.renderBar(grid, groups, refreshLibrary)

  if (!list.length) {
    $('libCount').textContent = '0 clips'
    grid.innerHTML = `<div class="empty" style="grid-column:1/-1">
      <img class="biscuit biscuit-lg" src="./assets/mascot/sit-happy.png" alt="">
      <p>Nothing recorded yet. Hit record and Biscuit will bring it back here.</p>
      <button class="btn btn-primary btn-sm" onclick="document.querySelector('[data-view=record]').click()">Start recording</button></div>`
    return
  }

  const visible = Library.filterGroups(groups)
  $('libCount').textContent = `${visible.length} take${visible.length === 1 ? '' : 's'}`

  if (!visible.length) {
    const folder = Library.findFolder(Library.getActiveId())
    grid.innerHTML = Library.emptyFolderHTML(folder || { name: 'this folder' })
    const back = $('libBackToAll')
    if (back) back.onclick = () => { Library.setActive('all'); refreshLibrary() }
    return
  }

  grid.innerHTML = ''
  const needsThumb = [], cards = []
  for (const g of visible) {
    const c = g.original
    const card = el('div', 'clip')
    card.innerHTML = `
      <button class="clip-shot">
        ${c.poster ? `<img src="file://${encodeURI(c.poster).replace(/#/g, '%23').replace(/\?/g, '%3F')}" alt="">` : `<span class="ph">${ico('film-strip', 'icon-xl')}</span>`}
        <span class="clip-play"><span>${ico('play-fill', 'icon-lg')}</span></span>
        <span class="clip-badges">
          ${c.srt ? '<span class="badge gold">CC</span>' : ''}
          ${c.imported ? `<span class="badge">imported ${c.ext}</span>` : ''}
          ${g.derived.length ? `<span class="badge gold">${g.derived.length} export${g.derived.length === 1 ? '' : 's'}</span>` : ''}
        </span>
      </button>
      <div class="clip-body">
        <div class="clip-name-row">
          <div class="clip-name" title="${escHtml(g.take ? path.basename(g.take) : c.name)}">${escHtml(takeTitle(g))}</div>
          ${Library.tagHTML(c.path)}
        </div>
        <div class="clip-meta">${c.mb} MB · ${fmtAgo(c.mtime)}${takeWhere(g) ? ` · ${escHtml(takeWhere(g))}` : ''}</div>
        ${takeRows(g).length ? `<div class="derived">${takeRows(g).map(d => `
          <button class="derived-row" data-p="${d.path}">
            ${ico('film-strip', 'icon-sm')}
            <span class="d-name" title="${escHtml(d.name)}">${escHtml(exportLabel(d, g))}</span>
            <span class="d-size mono">${d.mb} MB</span>
          </button>`).join('')}</div>` : ''}
        <div class="clip-acts">
          <button class="btn btn-sm" data-act="edit">${ico('scissors', 'icon-sm')} Edit</button>
          <button class="btn btn-sm" data-act="convert" data-tip="Convert">${ico('export', 'icon-sm')}</button>
          <button class="btn btn-sm" data-act="rename" data-tip="Rename">${ico('pencil-simple', 'icon-sm')}</button>
          ${Library.assignButtonHTML()}
          <button class="btn btn-sm" data-act="reveal" data-tip="Show in Finder">${ico('magnifying-glass', 'icon-sm')}</button>
          <button class="btn btn-sm btn-danger" data-act="delete" data-tip="Move to Trash">${ico('trash', 'icon-sm')}</button>
        </div>
      </div>`
    card.querySelector('.clip-shot').onclick = () => openPlayer(c)     // watch it here, not in Finder
    // a take folder shows its finished video, or the folder itself before there is one
    card.querySelector('[data-act="reveal"]').onclick = () => ipcRenderer.send('reveal',
      g.take ? ((g.derived.find(d => d.deliverable) || g.copy || {}).path || g.take) : c.path)
    card.querySelector('[data-act="edit"]').onclick = () => openInEditor(c.path)
    card.querySelector('[data-act="convert"]').onclick = () => quickConvert(c)
    card.querySelector('[data-act="rename"]').onclick = () => startRename(card, g)
    card.querySelector('.clip-name').ondblclick = () => startRename(card, g)
    card.querySelector('[data-act="folder"]').onclick = e => Library.openAssignMenu(e.currentTarget, c.path, refreshLibrary)
    card.querySelector('[data-act="delete"]').onclick = () => confirmDelete(g)
    card.querySelectorAll('.derived-row').forEach(b => {
      // the player and editor read video; a GIF deliverable is shown in Finder instead
      if (/\.gif$/i.test(b.dataset.p)) { b.onclick = () => ipcRenderer.send('reveal', b.dataset.p); return }
      b.onclick = () => openPlayer(b.dataset.p)
      b.ondblclick = () => openInEditor(b.dataset.p)
    })
    cards.push(card)

    if (!c.poster) needsThumb.push(c)
  }
  grid._cards = cards
  grid._cols = 0
  dealLibrary(grid)

  // Missing thumbnails run quietly (no "Thumbnail done" toast per clip) and capped per
  // pass, so a big library doesn't spawn dozens of ffmpeg processes at once. They land
  // together, then trigger a single follow-up refresh instead of one per completion.
  if (needsThumb.length) {
    const batch = needsThumb.slice(0, 8)
    Promise.all(batch.map(c => runJob({ op: 'thumb', src: c.path, atSec: 1 }, 'Thumbnail', { quiet: true })))
      .then(results => { if (results.some(Boolean)) refreshLibrary() })
  }
}

// Deals the cards into columns, left to right, so the newest takes are the top row.
// Again whenever the width crosses a column boundary (window resize, chat docked).
function dealLibrary(grid) {
  if (!grid._ro) {
    grid._ro = new ResizeObserver(() => dealLibrary(grid))
    grid._ro.observe(grid)
  }
  const cards = grid._cards
  if (!cards || !cards.length || !grid.isConnected) return
  const n = libraryColumns(grid.clientWidth || 1240)
  if (n === grid._cols && cards[0].parentElement && cards[0].parentElement.parentElement === grid) return
  grid._cols = n
  grid.replaceChildren(...dealColumns(cards, n).map(col => {
    const c = el('div', 'lib-col')
    c.append(...col)
    return c
  }))
}

function confirmDelete(g) {
  const all = [g.original, ...g.derived]
  const scrim = el('div', 'scrim')
  scrim.innerHTML = `<div class="modal" style="width:min(430px,92vw)">
    <div class="modal-body" style="text-align:center;display:grid;gap:12px;justify-items:center">
      <img class="biscuit" src="./assets/mascot/sad.png" alt="" style="width:88px;height:88px">
      <h3 style="font-family:var(--font-display);font-size:var(--t-18);letter-spacing:-.03em">Move to Trash?</h3>
      <p class="dim" style="font-size:var(--t-12)">
        ${all.length === 1 ? 'This take' : `This take and its ${g.derived.length} export${g.derived.length === 1 ? '' : 's'}`},
        plus any captions and thumbnails. You can get them back from the Trash.</p>
      ${g.derived.length ? `<label class="opt" style="padding:6px 0"><span class="opt-txt">
        <span class="opt-title">Keep the original</span>
        <span class="opt-sub">delete only the exports</span></span>
        <span class="switch"><input type="checkbox" id="keepOrig"><span class="track"></span></span></label>` : ''}
    </div>
    <div class="modal-foot"><div style="flex:1"></div>
      <button class="btn btn-sm" data-close>Cancel</button>
      <button class="btn btn-sm btn-danger" id="doDel">Move to Trash</button></div>
  </div>`
  document.body.appendChild(scrim)
  const close = () => scrim.remove()
  scrim.querySelectorAll('[data-close]').forEach(b => b.onclick = close)
  scrim.onclick = e => { if (e.target === scrim) close() }
  scrim.querySelector('#doDel').onclick = async e => {
    // the Trash answers asynchronously; a second click would report the take as lost
    if (e.currentTarget.disabled) return
    e.currentTarget.disabled = true
    // with no exports there is nothing to keep the original apart from, so no switch
    const keep = !!(scrim.querySelector('#keepOrig') || {}).checked
    const targets = keep ? g.derived : all
    // a whole take folder goes as one, so it comes back from the Trash in one piece
    const whole = g.take && !keep
    const n = await (whole ? trash([g.take]) : trash(targets.flatMap(t => [t.path, ...sidecars(t.path)])))
    targets.forEach(t => Library.forgetPath(t.path))   // folders never hold onto dead paths
    close()
    if (whole) toast(n ? `Moved "${path.basename(g.take)}" to Trash` : 'Could not move it to Trash', n ? 'ok' : 'bad')
    else toast(`Moved ${n} file${n === 1 ? '' : 's'} to Trash`, 'ok')
    refreshLibrary()
  }
}

async function quickConvert(c) {
  const fmts = await ipcRenderer.invoke('formats')
  const scrim = el('div', 'scrim')
  scrim.innerHTML = `<div class="modal" style="width:min(460px,90vw)">
    <div class="modal-head">${ico('export', 'icon-lg')}<span class="modal-title">Convert</span></div>
    <div class="modal-body"><div class="tiles" style="grid-template-columns:1fr 1fr">
      ${fmts.map(f => `<button class="btn" data-fmt="${f.id}" style="justify-content:flex-start">${ico(f.video ? 'film-strip' : 'waveform', 'icon-sm')} ${f.label}</button>`).join('')}
    </div></div>
    <div class="modal-foot"><div style="flex:1"></div><button class="btn btn-sm" data-close>Cancel</button></div>
  </div>`
  document.body.appendChild(scrim)
  const close = () => scrim.remove()
  scrim.querySelectorAll('[data-close]').forEach(b => b.onclick = close)
  scrim.onclick = e => { if (e.target === scrim) close() }
  scrim.querySelectorAll('[data-fmt]').forEach(b => b.onclick = async () => {
    close(); toast(`Converting to ${b.dataset.fmt.toUpperCase()}…`)
    const r = await runJob({ op: 'convert', src: c.path, opts: { format: b.dataset.fmt, quality: 'balanced' } }, 'Convert')
    if (r) refreshLibrary()
  })
}

// openInEditor lives in editor.js

// ── titlebar actions ─────────────────────────────────────────────────────
$('folderBtn').onclick = () => ipcRenderer.send('open-folder')
const doImport = async () => {
  const added = await ipcRenderer.invoke('pick-file')
  const ok = added.filter(a => !a.error)
  if (ok.length) { toast(`Imported ${ok.length} file${ok.length === 1 ? '' : 's'}`, 'ok'); show('library') }
  added.filter(a => a.error).forEach(a => toast(a.error, 'bad'))
}
$('importBtn').onclick = doImport
$('libImport').onclick = doImport

// ── boot ─────────────────────────────────────────────────────────────────
// First run. Deferred to the load event because onboarding.js is parsed after
// this file, so window.startOnboarding does not exist yet at this point.
window.addEventListener('load', () => {
  try {
    const p = path.join(os.homedir(), 'Library/Application Support/Fetch/prefs.json')
    const saved = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {}
    if (!saved.onboarded && typeof window.startOnboarding === 'function') {
      setTimeout(() => window.startOnboarding(), 300)
    }
  } catch {}
})

// The hero's state depends only on prefs, which prefs.js has already settled
// synchronously, so paint it now. Leaving it until after get-sources meant the
// wrong button sat on screen for that whole round trip (about 300ms), which reads
// as the label flickering on launch.
mood('idle')
paintHeroCta()

;(async () => {
  try {
    const list = await ipcRenderer.invoke('get-sources')
    setup.source = list.find(s => s.isScreen) || list[0] || null   // sensible default for the wizard
  } catch {}
  refreshLibrary()
})()
