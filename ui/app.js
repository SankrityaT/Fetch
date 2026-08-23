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
  done:    ['done',        'Got it. Saved to your Desktop.'],
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
  if (view === 'record') paintHeroCta()      // the pref may have changed in Settings
}
$('nav').addEventListener('click', e => {
  const b = e.target.closest('button[data-view]')
  if (b && !b.disabled) show(b.dataset.view)
})

// ── source preview on the hero card stays live ──────────────────────────
const usableThumb = t => typeof t === 'string' && t.length > 512   // empty captures come back as a stub
setInterval(async () => {
  if (!setup.source || setup.mode !== 'screen') return
  if (document.querySelector('.view[data-view="record"]').hidden) return
  if (document.querySelector('.scrim')) return                      // the wizard is polling instead
  try {
    const fresh = (await ipcRenderer.invoke('get-sources')).find(x => x.id === setup.source.id)
    if (fresh && usableThumb(fresh.thumb)) { setup.source.thumb = fresh.thumb; $('sourceThumb').src = fresh.thumb }
  } catch {}
}, 2000)

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
  ipcRenderer.send('hud-tick', { time: fmtTime(secs), paused: rec && rec.state === 'paused' })
}

async function countdown() {
  const secs = window.prefs && Number.isInteger(window.prefs.countdown) ? window.prefs.countdown : 3
  if (secs <= 0) return
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

async function startRecording() {
  try {
    mood('arming')
    $('start').disabled = true
    await countdown()
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
      if (!blob.size) { mood('error'); toast('Nothing was captured', 'bad'); return }
      mood('working')
      const file = await ipcRenderer.invoke('save', new Uint8Array(await blob.arrayBuffer()))
      mood('done')
      refreshLibrary()
      const pf = window.prefs || {}
      if (pf.autoConvertMp4) runJob({ op: 'mp4', src: file }, 'Converting to MP4').then(() => refreshLibrary())
      if (pf.openEditorAfter) { openInEditor(file); return }     // straight to the editor, no prompt
      afterRecording(file, (blob.size / 1e6).toFixed(1))
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
    mood('error'); toast(e.message, 'bad', 7000)
  }
}

$('start').onclick = startRecording
function stopRecording() { if (rec && rec.state !== 'inactive') { rec.requestData(); rec.stop() } }
function togglePause() {
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
const recording = () => rec && rec.state !== 'inactive'
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
function runJob(payload, label, { quiet = false } = {}) {
  const cid = 'c' + (++jobSeq)
  return new Promise(resolve => {
    jobs.set(cid, j => {
      if (j.status === 'done') { jobs.delete(cid); if (!quiet) toast(`${label} done`, 'ok'); resolve(j.result) }
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

// Exports are written next to the source as name-edit.mp4, name-cut.mp4 and so on.
// Group them under the original so the library shows takes, not a pile of files.
const DERIVED = /-(edit|cut|audio|trim|captions|converted|gif)$/
function groupTakes(list) {
  const byBase = new Map()
  for (const c of list) {
    const stem = c.name.replace(/\.[^.]+$/, '')
    const base = DERIVED.test(stem) ? stem.replace(DERIVED, '') : stem
    if (!byBase.has(base)) byBase.set(base, { base, original: null, derived: [] })
    const g = byBase.get(base)
    if (DERIVED.test(stem)) g.derived.push(c)
    else if (!g.original || c.mtime > g.original.mtime) {
      if (g.original) g.derived.push(g.original)
      g.original = c
    } else g.derived.push(c)
  }
  // a derived file whose original was deleted still deserves a card
  for (const g of byBase.values()) {
    if (!g.original && g.derived.length) g.original = g.derived.shift()
  }
  return [...byBase.values()].filter(g => g.original)
    .sort((a, b) => b.original.mtime - a.original.mtime)
}

// move to Trash rather than unlink, so a misclick is recoverable
function trash(paths) {
  const dir = path.join(os.homedir(), '.Trash')
  let moved = 0
  for (const p of paths) {
    if (!p || !fs.existsSync(p)) continue
    let dest = path.join(dir, path.basename(p))
    let n = 1
    while (fs.existsSync(dest)) {
      const e = path.extname(p), b = path.basename(p, e)
      dest = path.join(dir, `${b} ${++n}${e}`)
    }
    try { fs.renameSync(p, dest); moved++ } catch {}
  }
  return moved
}
// Support files live in a hidden folder beside the media, so the save folder only
// holds recordings and exports. Mirrors sidecarPath() in processor.js.
const SIDE_DIR = '.fetch'
const SIDE_EXT = ['.png', '.srt', '.txt', '.cursor.json', '.cam.json', '.cam.mov']
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
// never overwrite an existing file, suffix instead: "demo.mp4" -> "demo 2.mp4"
function uniquePath(target) {
  if (!fs.existsSync(target)) return target
  const dir = path.dirname(target), ext = path.extname(target), base = path.basename(target, ext)
  let n = 2, candidate
  do { candidate = path.join(dir, `${base} ${n}${ext}`); n++ } while (fs.existsSync(candidate))
  return candidate
}
// renames one file to newBase (keeping its extension), plus any sidecars sharing its
// basename, and keeps folder membership pointed at the new path. Returns the final path.
function renameFileWithSidecars(oldPath, newBase) {
  const ext = path.extname(oldPath)
  const dir = path.dirname(oldPath)
  let target = path.join(dir, newBase + ext)
  if (target !== oldPath) target = uniquePath(target)
  if (target === oldPath) return oldPath
  fs.renameSync(oldPath, target)
  for (const sExt of SIDE_EXT) {
    const oldSide = sidecarIn(oldPath, sExt)
    if (oldSide === oldPath || !fs.existsSync(oldSide)) continue
    const dest = sidecarPath(target, sExt)
    try { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.renameSync(oldSide, dest) } catch {}
  }
  Library.renamePath(oldPath, target)
  return target
}
// list-recordings only picks up files named "recording-..." from the Desktop scan;
// anything else has to be in the app's own import index or it silently drops out of
// the Library the moment it is renamed. Add it there so a rename never looks like deletion.
async function ensureListed(newPath) {
  if (/^recording-/i.test(path.basename(newPath))) return
  try { await ipcRenderer.invoke('import-file', newPath) }
  catch (e) { toast('Renamed, but it fell out of the Library. Import it again.', 'bad', 6000) }
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
    const newMain = renameFileWithSidecars(g.original.path, newBase)
    await ensureListed(newMain)
    if (includeDerived) {
      for (const d of g.derived) {
        const newDerived = renameFileWithSidecars(d.path, newBase + derivedSuffix(d.name))
        await ensureListed(newDerived)
      }
    }
    toast('Renamed', 'ok')
    refreshLibrary()
  }
  if (g.derived.length) confirmRenameDerived(g, newBase, finish)
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
  const currentBase = path.basename(c.path, ext)

  const input = document.createElement('input')
  input.className = 'clip-name clip-name-edit'
  input.value = currentBase
  input.maxLength = 200
  nameEl.replaceWith(input)
  input.focus(); input.select()

  let done = false
  const restore = () => { if (!input.isConnected) return; input.replaceWith(nameEl); delete card.dataset.renaming }
  const cancel = () => { if (done) return; done = true; restore() }
  const commit = () => {
    if (done) return
    done = true
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
  const needsThumb = []
  for (const g of visible) {
    const c = g.original
    const card = el('div', 'clip')
    card.innerHTML = `
      <button class="clip-shot">
        ${c.poster ? `<img src="file://${c.poster}" alt="">` : `<span class="ph">${ico('film-strip', 'icon-xl')}</span>`}
        <span class="clip-play"><span>${ico('play-fill', 'icon-lg')}</span></span>
        <span class="clip-badges">
          <span class="badge">${c.ext}</span>
          ${c.srt ? '<span class="badge gold">CC</span>' : ''}
          ${c.imported ? '<span class="badge">imported</span>' : ''}
          ${g.derived.length ? `<span class="badge gold">${g.derived.length + 1} versions</span>` : ''}
        </span>
      </button>
      <div class="clip-body">
        <div class="clip-name-row">
          <div class="clip-name" title="${c.name}">${c.name.replace(/^recording-/, '').replace(/\.[^.]+$/, '')}</div>
          ${Library.tagHTML(c.path)}
        </div>
        <div class="clip-meta">${c.mb} MB · ${fmtAgo(c.mtime)}</div>
        ${g.derived.length ? `<div class="derived">${g.derived.map(d => `
          <button class="derived-row" data-p="${d.path}">
            ${ico('film-strip', 'icon-sm')}
            <span class="d-name">${d.name.replace(/^recording-[0-9]+/, '').replace(/^-/, '') || d.name}</span>
            <span class="d-size mono">${d.mb} MB</span>
          </button>`).join('')}</div>` : ''}
        <div class="clip-acts">
          <button class="btn btn-sm" data-act="edit">${ico('scissors', 'icon-sm')} Edit</button>
          <button class="btn btn-sm" data-act="convert" data-tip="Convert">${ico('export', 'icon-sm')}</button>
          <button class="btn btn-sm" data-act="rename" data-tip="Rename">${ico('pencil-simple', 'icon-sm')}</button>
          ${Library.assignButtonHTML()}
          <button class="btn btn-sm" data-act="reveal" data-tip="Show in Finder">${ico('folder-open', 'icon-sm')}</button>
          <button class="btn btn-sm btn-danger" data-act="delete" data-tip="Move to Trash">${ico('trash', 'icon-sm')}</button>
        </div>
      </div>`
    card.querySelector('.clip-shot').onclick = () => openPlayer(c)     // watch it here, not in Finder
    card.querySelector('[data-act="reveal"]').onclick = () => ipcRenderer.send('reveal', c.path)
    card.querySelector('[data-act="edit"]').onclick = () => openInEditor(c.path)
    card.querySelector('[data-act="convert"]').onclick = () => quickConvert(c)
    card.querySelector('[data-act="rename"]').onclick = () => startRename(card, g)
    card.querySelector('.clip-name').ondblclick = () => startRename(card, g)
    card.querySelector('[data-act="folder"]').onclick = e => Library.openAssignMenu(e.currentTarget, c.path, refreshLibrary)
    card.querySelector('[data-act="delete"]').onclick = () => confirmDelete(g)
    card.querySelectorAll('.derived-row').forEach(b => {
      b.onclick = () => openPlayer(b.dataset.p)
      b.ondblclick = () => openInEditor(b.dataset.p)
    })
    grid.appendChild(card)

    if (!c.poster) needsThumb.push(c)
  }

  // Missing thumbnails run quietly (no "Thumbnail done" toast per clip) and capped per
  // pass, so a big library doesn't spawn dozens of ffmpeg processes at once. They land
  // together, then trigger a single follow-up refresh instead of one per completion.
  if (needsThumb.length) {
    const batch = needsThumb.slice(0, 8)
    Promise.all(batch.map(c => runJob({ op: 'thumb', src: c.path, atSec: 1 }, 'Thumbnail', { quiet: true })))
      .then(results => { if (results.some(Boolean)) refreshLibrary() })
  }
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
      <label class="opt" style="padding:6px 0"><span class="opt-txt">
        <span class="opt-title">Keep the original</span>
        <span class="opt-sub">delete only the exports</span></span>
        <span class="switch"><input type="checkbox" id="keepOrig"><span class="track"></span></span></label>
    </div>
    <div class="modal-foot"><div style="flex:1"></div>
      <button class="btn btn-sm" data-close>Cancel</button>
      <button class="btn btn-sm btn-danger" id="doDel">Move to Trash</button></div>
  </div>`
  document.body.appendChild(scrim)
  const close = () => scrim.remove()
  scrim.querySelectorAll('[data-close]').forEach(b => b.onclick = close)
  scrim.onclick = e => { if (e.target === scrim) close() }
  scrim.querySelector('#doDel').onclick = () => {
    const keep = scrim.querySelector('#keepOrig').checked
    const targets = keep ? g.derived : all
    const files = targets.flatMap(t => [t.path, ...sidecars(t.path)])
    const n = trash(files)
    targets.forEach(t => Library.forgetPath(t.path))   // folders never hold onto dead paths
    close()
    toast(`Moved ${n} file${n === 1 ? '' : 's'} to Trash`, 'ok')
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
