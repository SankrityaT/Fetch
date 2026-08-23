/* Fetch setup wizard: source, camera, audio. Horizontal, one step at a time. */

// setup.sysId: the deviceId of an audio INPUT device to use for computer audio,
// or '' for the default. macOS has no general system-audio capture device, so ''
// means the existing path: Electron's `audio: 'loopback'` in
// setDisplayMediaRequestHandler (main.js). A non-empty id is the deviceId of a
// virtual/loopback-looking input (BlackHole, ZoomAudioDevice and similar) that the
// user has routed computer audio into, picked from navigator.mediaDevices
// .enumerateDevices(). Same shape as setup.micId: a plain deviceId string, meant
// for getUserMedia({ audio: { deviceId: { exact: setup.sysId } } }) in
// ui/app.js buildStream() when it is not ''.

const P = (typeof window !== 'undefined' && window.prefs) || {}

const setup = {
  mode: 'screen',        // 'screen' | 'window'
  source: null,          // {id,name,thumb} when mode is screen
  window: null,          // {id,app,title} when mode is window
  cam: P.camera !== false, camSize: 260, camZoom: 1, camAnchor: 'br', camId: '',
  mic: P.mic !== false, sys: P.systemAudio !== false, micId: '', sysId: '',
  step: 0,
}

const STEP_COPY = [
  ['excited', 'What are we capturing?', 'A whole screen, or a single app window.'],
  ['happy',   'Show your face?',        'A round camera bubble floats on top. Drag it anywhere while you record.'],
  ['record',  'How should it sound?',   'Your voice, the computer, or both.'],
]

let micStream = null, camStream = null, meterRAF = null

function openSetup() {
  const scrim = el('div', 'scrim')
  scrim.innerHTML = `
  <div class="modal wiz" role="dialog" aria-label="Set up recording">
    <div class="modal-head">
      <div class="wiz-steps" id="wizSteps">
        <span class="wiz-runner" id="wizRunner"><img id="wizRunnerImg" src="./assets/mascot/sit-happy.png" alt=""></span>
        ${[['monitor', 'Source'], ['video-camera', 'Camera'], ['waveform', 'Audio']].map(([g, label], i) => `
          <span class="wiz-step" data-i="${i}"><span class="n">${ico(g, 'icon-sm')}</span>${label}</span>
          ${i < 2 ? `<span class="wiz-line" data-line="${i}"></span>` : ''}`).join('')}
      </div>
      <button class="btn btn-ghost btn-icon btn-sm" data-close>${ico('x', 'icon-sm')}</button>
    </div>

    <div class="modal-body wiz-view">
      <div class="wiz-track" id="wizTrack">

        <!-- 1. source -->
        <section class="wiz-pane">
          <div class="wiz-head">
            <img class="biscuit" src="./assets/mascot/excited.png" alt="">
            <div><h3>What are we capturing?</h3><p>A whole screen, or a single app window.</p></div>
          </div>
          <div class="opt-grid">
            <button class="pick" data-mode="screen" aria-pressed="true">
              <span class="pico">${ico('monitor', 'icon-lg')}</span>
              <span class="pit">A screen</span><span class="pis">everything you see</span>
            </button>
            <button class="pick" data-mode="window" aria-pressed="false">
              <span class="pico">${ico('app-window', 'icon-lg')}</span>
              <span class="pit">One window</span><span class="pis">just that app</span>
            </button>
          </div>
          <div class="shots" id="wizTiles"></div>
          <div id="winList" hidden>
            <div class="win-toolbar">
              <span class="win-search">
                ${ico('magnifying-glass', 'icon-sm')}
                <input class="input" id="winSearch" type="text" placeholder="Search by app or window title" autocomplete="off">
              </span>
              <span class="win-count micro dimmer" id="winCount"></span>
            </div>
            <div class="win-grid" id="winGrid"></div>
            <p class="win-empty micro dimmer" id="winEmpty" hidden>No windows match that search.</p>
          </div>
        </section>

        <!-- 2. camera -->
        <section class="wiz-pane" aria-hidden="true">
          <div class="wiz-head">
            <img class="biscuit" src="./assets/mascot/happy.png" alt="">
            <div><h3>Show your face?</h3><p>Pick a corner. You can still drag it while recording.</p></div>
          </div>

          <div class="opt-grid">
            <button class="pick" data-cam="on" aria-pressed="true">
              <span class="pico">${ico('video-camera', 'icon-lg')}</span>
              <span class="pit">Camera on</span><span class="pis">floating bubble</span></button>
            <button class="pick" data-cam="off" aria-pressed="false">
              <span class="pico">${ico('x', 'icon-lg')}</span>
              <span class="pit">No camera</span><span class="pis">screen only</span></button>
          </div>

          <div class="place-row" id="camDials">
            <!-- a real slab you drop the bubble onto -->
            <div class="scene">
              <div class="slab" id="slab">
                <div class="slab-deck">
                  <div class="deck-glass"></div>
                  <div class="deck-grid" id="miniGrid"></div>
                  <div class="bubble-shadow" id="bubbleShadow"></div>
                  <div class="bubble3d" id="miniBubble">
                    <img class="mini-face" src="./assets/mascot/happy.png" alt="">
                  </div>
                </div>
                <div class="slab-edge front"></div>
                <div class="slab-edge right"></div>
                <div class="slab-edge left"></div>
              </div>
            </div>

            <div class="place-dials">
              <div class="row"><span class="row-lbl">Size</span>
                <input type="range" class="slider" id="wSize" min="120" max="700" value="260">
                <span class="row-val mono" id="wSizeVal">260</span></div>
              <div class="row"><span class="row-lbl">Zoom</span>
                <input type="range" class="slider" id="wZoom" min="100" max="300" value="100">
                <span class="row-val mono" id="wZoomVal">1.0×</span></div>
              <div class="row" style="margin-top:2px"><span class="row-lbl">Camera</span>
                <div id="camDevice" style="flex:1;min-height:34px"></div></div>
              <p class="micro dimmer" id="camHint" style="margin-top:10px">Click a spot to place it.</p>
            </div>
          </div>
        </section>

        <!-- 3. audio -->
        <section class="wiz-pane" aria-hidden="true">
          <div class="wiz-head">
            <img class="biscuit" src="./assets/mascot/recording.png" alt="">
            <div><h3>How should it sound?</h3><p>Your voice, the computer, or both.</p></div>
          </div>
          <div class="opt-grid">
            <button class="pick" data-aud="mic" aria-pressed="true">
              <span class="pico">${ico('microphone', 'icon-lg')}</span>
              <span class="pit">Microphone</span><span class="pis">your voice</span></button>
            <button class="pick" data-aud="sys" aria-pressed="true">
              <span class="pico">${ico('speaker-high', 'icon-lg')}</span>
              <span class="pit">Computer audio</span><span class="pis">system sound</span></button>
          </div>
          <div class="meter-wrap">
            <div class="dev-row">
              <span class="caps" style="flex:none">Input</span>
              <div id="micDevice" style="flex:1;min-height:34px"></div>
            </div>
            <div class="meter" style="margin-top:12px"><i id="micMeter"></i></div>
            <p class="micro dimmer" id="micHint" style="margin-top:9px">Say something to check your mic.</p>

            <div class="dev-row" style="margin-top:18px">
              <span class="caps" style="flex:none">Computer audio</span>
              <div id="sysDevice" style="flex:1;min-height:34px"></div>
            </div>
            <p class="micro dimmer" id="sysHint" style="margin-top:9px">System audio is captured automatically. Install a tool like BlackHole to route just one app's sound here instead.</p>
          </div>
        </section>
      </div>
    </div>

    <div class="modal-foot">
      <button class="btn btn-sm btn-ghost" id="wizBack" disabled>Back</button>
      <div style="flex:1"></div>
      <div class="wiz-summary" id="wizSummary"></div>
      <button class="btn btn-primary btn-sm" id="wizNext">Next</button>
    </div>
  </div>`
  document.body.appendChild(scrim)

  const track = scrim.querySelector('#wizTrack')
  const paint = () => {
    track.style.transform = `translateX(-${setup.step * 33.333}%)`
    scrim.querySelectorAll('.wiz-pane').forEach((p, i) => p.setAttribute('aria-hidden', String(i !== setup.step)))
    scrim.querySelectorAll('.wiz-step').forEach((s, i) =>
      s.dataset.state = i === setup.step ? 'active' : i < setup.step ? 'done' : '')
    scrim.querySelectorAll('.wiz-line').forEach(l => l.dataset.done = String(+l.dataset.line < setup.step))
    moveRunner(scrim)
    scrim.querySelector('#wizBack').disabled = setup.step === 0
    scrim.querySelector('#wizNext').disabled = setup.step === 0 && setup.mode === 'window' && !setup.window
    scrim.querySelector('#wizNext').innerHTML = setup.step === 2
      ? `${ico('record-fill', 'icon-sm')} Start recording` : 'Next'
    scrim.querySelector('#wizNext').classList.toggle('btn-record', false)
    scrim.querySelector('#wizSummary').innerHTML = summaryChips()
    mood(['idle', 'happy', 'excited'][setup.step] || 'idle')
    if (setup.step === 1) startCamPreview(scrim)
    if (setup.step === 2) startMeter(scrim)
  }

  // step 1: source
  let tiles = []
  const drawTiles = list => {
    const box = scrim.querySelector('#wizTiles')
    const screens = list.filter(s => s.isScreen)
    if (box.childElementCount !== screens.length) {
      box.innerHTML = ''
      screens.forEach(s => {
        const t = el('button', 'shot')
        t.dataset.id = s.id
        t.innerHTML = `<img class="shot-img" src="${usableThumb(s.thumb) ? s.thumb : ''}" alt=""
             style="aspect-ratio:${s.aspect || 1.6}">
          <span class="shot-live">Live</span>
          <span class="shot-check">${ico('check', 'icon-sm')}</span>
          <span class="shot-meta">${ico('monitor', 'icon-sm')}<span class="shot-name">${s.name}</span></span>`
        t.onclick = () => { setup.source = s; paintTiles() }
        box.appendChild(t)
      })
      if (!setup.source) setup.source = screens[0] || null
    } else {
      screens.forEach(s => {
        const t = box.querySelector(`[data-id="${CSS.escape(s.id)}"]`)
        if (t && usableThumb(s.thumb)) t.querySelector('.shot-img').src = s.thumb
      })
    }
    paintTiles()
  }
  const paintTiles = () => scrim.querySelectorAll('#wizTiles .shot').forEach(t =>
    t.setAttribute('aria-selected', String(setup.source && t.dataset.id === setup.source.id)))

  const pull = async () => { try { drawTiles(await ipcRenderer.invoke('get-sources')) } catch {} }
  pull()

  // windows come from the ScreenCaptureKit helper: desktopCapturer only ever
  // reports one or two of them on current macOS
  let winCache = []
  let winQuery = ''
  let shotLoaded = new Set()
  let shotGen = 0

  const matchesQuery = (w, q) => !q ||
    (w.app + ' ' + (w.title || '')).toLowerCase().includes(q)

  async function pullWindows() {
    const list = await ipcRenderer.invoke('list-windows')
    const grid = scrim.querySelector('#winGrid')
    if (!grid) return
    winCache = list
    if (!list.length) {
      grid.innerHTML = `<p class="micro dimmer" style="grid-column:1/-1;text-align:center;padding:24px 0">
        No open windows found.</p>`
      scrim.querySelector('#winCount').textContent = ''
      scrim.querySelector('#winEmpty').hidden = true
      return
    }
    if (grid.childElementCount !== list.length) {
      grid.innerHTML = ''
      list.forEach(w => {
        const b = el('button', 'win')
        b.dataset.id = w.id
        b.innerHTML = `
          <span class="win-shot" data-shot="${w.id}">
            <span class="win-shot-fallback">
              ${w.icon ? `<img class="win-fallback" src="${w.icon}" alt="">` : ico('app-window', 'icon-xl')}
              <span class="win-shot-label">Preview unavailable</span>
            </span>
          </span>
          <span class="win-meta">
            ${w.icon ? `<img class="win-ico" src="${w.icon}" alt="">` : ico('app-window', 'icon-sm')}
            <span class="win-text"><span class="win-app">${w.app}</span>
              <span class="win-title">${(w.title || 'Untitled window').replace(/</g, '&lt;')}</span></span>
          </span>
          <span class="shot-check">${ico('check', 'icon-sm')}</span>`
        b.onclick = () => { setup.window = w; paintWindows() }
        grid.appendChild(b)
      })
      shotLoaded = new Set()
    }
    loadShots(list)
    paintWindows()
    filterWindows()
  }

  // previews load cheapest-first (whatever currently matches the search box),
  // one request at a time: macOS can only screenshot windows it is currently
  // compositing, so occluded ones keep the fallback panel and are retried by
  // the poll below in case they become visible later.
  function shotOrder(list) {
    const q = winQuery.trim().toLowerCase()
    return [...list].sort((a, b) => {
      const am = matchesQuery(a, q) ? 0 : 1, bm = matchesQuery(b, q) ? 0 : 1
      return am - bm
    })
  }
  async function loadShots(list) {
    const gen = ++shotGen
    for (const w of shotOrder(list)) {
      if (!document.body.contains(scrim)) return
      if (gen !== shotGen) return              // a newer priority pass took over
      if (shotLoaded.has(w.id)) continue
      try {
        const data = await ipcRenderer.invoke('window-shot', w.id, 520)
        if (!document.body.contains(scrim)) return
        const holder = scrim.querySelector(`[data-shot="${w.id}"]`)
        if (data && holder) {
          holder.innerHTML = `<img class="win-img" src="${data}" alt="">`
          shotLoaded.add(w.id)
        }
      } catch {}
    }
  }
  const paintWindows = () => scrim.querySelectorAll('#winGrid .win').forEach(b =>
    b.setAttribute('aria-selected', String(setup.window && +b.dataset.id === setup.window.id)))

  // live search: filters by app name and title, case-insensitive
  function filterWindows() {
    const grid = scrim.querySelector('#winGrid')
    const emptyEl = scrim.querySelector('#winEmpty')
    const countEl = scrim.querySelector('#winCount')
    if (!grid || !winCache.length) return
    const q = winQuery.trim().toLowerCase()
    let shown = 0
    grid.querySelectorAll('.win').forEach(b => {
      const w = winCache.find(x => String(x.id) === b.dataset.id)
      const ok = !w || matchesQuery(w, q)
      b.hidden = !ok
      if (ok) shown++
    })
    countEl.textContent = q
      ? `${shown} of ${winCache.length}`
      : `${winCache.length} window${winCache.length === 1 ? '' : 's'}`
    const noMatches = q && shown === 0
    emptyEl.hidden = !noMatches
    grid.hidden = noMatches
  }
  scrim.querySelector('#winSearch').oninput = e => {
    winQuery = e.target.value
    filterWindows()
    loadShots(winCache)   // re-prioritise so whatever now matches loads first
  }

  const poll = setInterval(() => { if (setup.step === 0 && setup.mode === 'screen') pull() }, 1500)
  // previews of occluded windows fail silently; keep retrying while the
  // picker is open so a window that becomes visible fills in
  const shotPoll = setInterval(() => {
    if (setup.step === 0 && setup.mode === 'window' && winCache.length) loadShots(winCache)
  }, 4000)

  scrim.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => {
    setup.mode = b.dataset.mode
    scrim.querySelectorAll('[data-mode]').forEach(x => x.setAttribute('aria-pressed', String(x === b)))
    scrim.querySelector('#wizTiles').hidden = setup.mode !== 'screen'
    scrim.querySelector('#winList').hidden = setup.mode !== 'window'
    if (setup.mode === 'window') {
      pullWindows()
      scrim.querySelector('#winSearch').focus()
    }
    paint()
  })

  // step 2: camera
  scrim.querySelectorAll('[data-cam]').forEach(b => b.onclick = () => {
    setup.cam = b.dataset.cam === 'on'
    scrim.querySelectorAll('[data-cam]').forEach(x => x.setAttribute('aria-pressed', String(x === b)))
    scrim.querySelector('#camDials').dataset.off = String(!setup.cam)
    if (setup.cam) startCamPreview(scrim); else stopCamPreview(scrim)
    paint()
  })
  const dial = (id, key, fmt) => {
    const s = scrim.querySelector('#' + id), out = scrim.querySelector('#' + id + 'Val')
    const paintFill = () => s.style.setProperty('--fill', ((s.value - s.min) / (s.max - s.min) * 100) + '%')
    s.oninput = () => {
      setup[key] = key === 'camZoom' ? +s.value / 100 : +s.value
      out.textContent = fmt(+s.value); paintFill(); pushBubble()

    }
    paintFill()
  }
  dial('wSize', 'camSize', v => v)
  dial('wZoom', 'camZoom', v => (v / 100).toFixed(1) + '×')

  // nine placement slots on a small tilted screen
  const SLOTS = ['tl','tc','tr','ml','mc','mr','bl','bc','br']
  const grid = scrim.querySelector('#miniGrid')
  SLOTS.forEach(code => {
    const d = el('button', 'slot')
    d.dataset.code = code
    d.innerHTML = '<i></i>'
    d.onclick = () => { setup.camAnchor = code; placeBubble(); pushBubble() }
    grid.appendChild(d)
  })
  function placeBubble() {
    scrim.querySelectorAll('.slot').forEach(x =>
      x.setAttribute('aria-pressed', String(x.dataset.code === setup.camAnchor)))
    const b = scrim.querySelector('#miniBubble')
    const sh = scrim.querySelector('#bubbleShadow')
    const deck = scrim.querySelector('.slab-deck')
    if (!b || !deck || !deck.clientWidth) return
    const [row, col] = setup.camAnchor.split('')
    // same proportion the real bubble takes up on a 1440pt-wide screen
    const px = Math.max(18, Math.min(0.34, setup.camSize / 1440) * deck.clientWidth)
    const pad = 10
    const x = col === 'l' ? pad : col === 'r' ? deck.clientWidth - px - pad : (deck.clientWidth - px) / 2
    const y = row === 't' ? pad : row === 'b' ? deck.clientHeight - px - pad : (deck.clientHeight - px) / 2
    for (const n of [b, sh]) { n.style.width = n.style.height = px + 'px'; n.style.left = x + 'px'; n.style.top = y + 'px' }
  }
  scrim.querySelector('#wSize').addEventListener('input', placeBubble)
  setTimeout(placeBubble, 60)

  // virtual/loopback-looking audio inputs: BlackHole, Loopback, Soundflower, VB-Cable,
  // an Aggregate or Multi-Output device, ZoomAudioDevice and similar. macOS has no
  // general system-audio capture device, so people route computer audio through one
  // of these instead, and it shows up here as an ordinary audio input.
  const VIRTUAL_AUDIO_RE = /blackhole|loopback|soundflower|vb[- ]?cable|aggregate|multi-?output|zoomaudiodevice/i

  // devices: labels only appear once permission has been granted at least once
  async function fillDevices() {
    let list = []
    try { list = await navigator.mediaDevices.enumerateDevices() } catch { return }
    const named = (kind, fallback) => list
      .filter(d => d.kind === kind && d.deviceId && d.deviceId !== 'default')
      .map((d, i) => ({ id: d.deviceId, label: d.label || `${fallback.split(' ')[1]} ${i + 1}` }))

    window.Dropdown('micDevice', [{ id: '', label: 'Default microphone' }, ...named('audioinput', 'Default microphone')],
      setup.micId, id => {
        setup.micId = id
        stopMeter(scrim); startMeter(scrim)      // re-point the level meter at the new input
      })

    window.Dropdown('camDevice', [{ id: '', label: 'Default camera' }, ...named('videoinput', 'Default camera')],
      setup.camId, id => {
        setup.camId = id
        pushBubble()                             // the native bubble switches device on its own
      })

    const virtualInputs = list.filter(d => d.kind === 'audioinput' && d.deviceId &&
      d.deviceId !== 'default' && VIRTUAL_AUDIO_RE.test(d.label || ''))
    window.Dropdown('sysDevice',
      [{ id: '', label: 'System audio (default)' }, ...virtualInputs.map(d => ({ id: d.deviceId, label: d.label }))],
      setup.sysId, id => { setup.sysId = id })
  }
  fillDevices()
  navigator.mediaDevices.addEventListener('devicechange', fillDevices)

  // step 3: audio
  scrim.querySelectorAll('[data-aud]').forEach(b => b.onclick = () => {
    const k = b.dataset.aud
    setup[k] = !setup[k]
    b.setAttribute('aria-pressed', String(setup[k]))
    if (k === 'mic') setup.mic ? startMeter(scrim) : stopMeter(scrim)
    paint()
  })

  // nav
  const close = ({ recording = false } = {}) => {
    clearInterval(poll); clearInterval(shotPoll); stopMeter(scrim)
    if (!recording) ipcRenderer.send('cam-visible', false)   // only recording keeps it alive
    scrim.remove()
  }
  scrim.querySelectorAll('[data-close]').forEach(b => b.onclick = close)
  scrim.onclick = e => { if (e.target === scrim) close() }
  document.addEventListener('keydown', function esc(e) {
    if (!document.body.contains(scrim)) return document.removeEventListener('keydown', esc)
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc) }
  })
  scrim.querySelector('#wizBack').onclick = () => { setup.step = Math.max(0, setup.step - 1); paint() }
  scrim.querySelector('#wizNext').onclick = () => {
    if (setup.step < 2) { setup.step++; paint(); return }
    applySetup()
    close({ recording: true })
    startRecording()
  }

  // the choice cards must show the saved defaults, not a hardcoded on state
  scrim.querySelectorAll('[data-cam]').forEach(b =>
    b.setAttribute('aria-pressed', String((b.dataset.cam === 'on') === !!setup.cam)))
  scrim.querySelector('#camDials').dataset.off = String(!setup.cam)
  scrim.querySelectorAll('[data-aud]').forEach(b =>
    b.setAttribute('aria-pressed', String(!!setup[b.dataset.aud])))

  setup.step = 0
  paint()
  setTimeout(() => moveRunner(scrim, true), 60)      // after layout settles
  const onResize = () => moveRunner(scrim, true)
  window.addEventListener('resize', onResize)
  scrim.addEventListener('remove', () => window.removeEventListener('resize', onResize))
}

// Biscuit sits on the active step and runs to the next one. running.png faces
// left, so it is flipped when travelling forward.
let runnerAt = 0
function moveRunner(scrim, instant) {
  const runner = scrim.querySelector('#wizRunner')
  const node = scrim.querySelectorAll('.wiz-step')[setup.step]
  const track = scrim.querySelector('#wizSteps')
  if (!runner || !node || !track) return

  const x = node.offsetLeft + node.offsetWidth / 2 - runner.offsetWidth / 2
  const forward = setup.step >= runnerAt
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
  const moving = setup.step !== runnerAt && !instant && !reduced

  const img = scrim.querySelector('#wizRunnerImg')
  runner.style.transform = `translateX(${Math.round(x)}px)`   // travel only, transitioned
  const flip = f => { if (img) img.style.transform = `scaleX(${f ? -1 : 1})` }  // flip only, instant

  if (moving) {
    if (img) img.src = './assets/mascot/running.png'
    runner.dataset.state = 'run'
    flip(forward)                        // running.png faces left, so flip going forward
    clearTimeout(runner._t)
    runner._t = setTimeout(() => {
      if (img) img.src = './assets/mascot/sit-happy.png'
      runner.dataset.state = 'sit'
      flip(false)
    }, 430)
  } else {
    runner.dataset.state = 'sit'
    flip(false)
  }
  runnerAt = setup.step
}

const summaryChips = () => {
  const src = setup.mode === 'window'
    ? (setup.window ? setup.window.app : 'Pick a window')
    : (setup.source ? setup.source.name : 'Screen')
  const chips = [[setup.mode === 'window' ? 'app-window' : 'monitor', src, true]]
  chips.push(['video-camera', 'Camera', setup.cam])
  chips.push(['microphone', 'Mic', setup.mic])
  chips.push(['speaker-high', 'Audio', setup.sys])
  return chips.map(([i, t, on]) =>
    `<span class="sum ${on ? 'on' : 'off'}">${ico(i, 'icon-sm')}${t}</span>`).join('')
}

function applySetup() {
  if (setup.mode === 'window' && setup.window) {
    ipcRenderer.send('select-window', { id: setup.window.id, name: setup.window.app })
  } else if (setup.source) {
    ipcRenderer.send('select-source', setup.source.id)
  }
  pushBubble()
  paintHeroReady()
}

function paintHeroReady() {
  $('heroReady').hidden = false
  $('setupBtn').textContent = 'Change setup'
  document.querySelector('.hero-cta').hidden = true
  $('sourceName').textContent = setup.mode === 'window'
    ? (setup.window ? `${setup.window.app}${setup.window.title ? ' · ' + setup.window.title : ''}` : 'A window')
    : (setup.source ? setup.source.name : 'Entire screen')
  const img = $('sourceThumb')
  if (setup.mode === 'screen' && setup.source && usableThumb(setup.source.thumb)) img.src = setup.source.thumb
  else img.removeAttribute('src')
  $('readyChips').innerHTML = [
    setup.cam ? ['video-camera', 'Camera'] : null,
    setup.mic ? ['microphone', 'Mic'] : null,
    setup.sys ? ['speaker-high', 'System audio'] : null,
  ].filter(Boolean).map(([i, t]) => `<span class="chip chip-static">${ico(i, 'icon-sm')} ${t}</span>`).join('')
}

const pushBubble = () => {
  try {
    fs.writeFileSync(path.join(os.homedir(), '.cambubble.json'),
      JSON.stringify({ size: setup.camSize, zoom: setup.camZoom,
                       anchor: setup.camAnchor, camera: setup.camId }))
  } catch (e) {
    // the only channel to the native bubble: if this fails, size and position
    // changes silently do nothing at all
    console.error('could not reach the camera bubble:', e.message)
  }
}

// ── live previews inside the wizard ─────────────────────────────────────
// The bubble itself is the preview: it is a native app, and it is the only thing
// on this machine that can actually open the camera.
function startCamPreview(scrim) {
  if (!setup.cam) return
  pushBubble()                       // position and size land before it appears
  ipcRenderer.send('cam-visible', true)
  const hint = scrim.querySelector('#camHint')
  if (hint) hint.textContent = 'Your bubble is live on screen. Drag it, or pick a spot here.'
}
function stopCamPreview(scrim) {
  ipcRenderer.send('cam-visible', false)
  const hint = scrim.querySelector('#camHint')
  if (hint) hint.textContent = 'Click a spot to place it.'
}

async function startMeter(scrim) {
  const bar = scrim.querySelector('#micMeter')
  if (!setup.mic || !bar || micStream) return
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: setup.micId ? { deviceId: { exact: setup.micId } } : true })
    const ctx = new AudioContext()
    const an = ctx.createAnalyser(); an.fftSize = 512
    ctx.createMediaStreamSource(micStream).connect(an)
    const buf = new Uint8Array(an.frequencyBinCount)
    const loop = () => {
      an.getByteTimeDomainData(buf)
      let peak = 0
      for (const b of buf) peak = Math.max(peak, Math.abs(b - 128) / 128)
      bar.style.width = Math.min(100, peak * 180) + '%'
      meterRAF = requestAnimationFrame(loop)
    }
    loop()
    scrim.querySelector('#micHint').textContent = 'Looks good. Say something to see it move.'
  } catch {
    scrim.querySelector('#micHint').textContent = 'Microphone unavailable. Check Privacy settings.'
  }
}
function stopMeter(scrim) {
  if (meterRAF) cancelAnimationFrame(meterRAF), meterRAF = null
  if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null }
  const bar = scrim && scrim.querySelector('#micMeter')
  if (bar) bar.style.width = '0%'
}

// ── after the take ──────────────────────────────────────────────────────
function afterRecording(file, mb) {
  const scrim = el('div', 'scrim')
  scrim.innerHTML = `
  <div class="modal" style="width:min(480px,92vw)">
    <div class="modal-body">
      <div class="after">
        <img class="biscuit" src="./assets/mascot/done.png" alt="">
        <h3 style="font-family:var(--font-display);font-size:var(--t-24);letter-spacing:-.03em">Got it.</h3>
        <p class="dim" style="font-size:var(--t-12)">${mb} MB, saved to your Desktop.</p>
        <div class="after-acts">
          <button class="after-act" data-go="export">
            ${ico('export', 'icon-xl')}
            <span class="t">Export it</span><span class="s">pick a format and share</span>
          </button>
          <button class="after-act" data-go="edit">
            ${ico('magic-wand', 'icon-xl')}
            <span class="t">Enhance &amp; edit</span><span class="s">trim, captions, clean audio</span>
          </button>
        </div>
      </div>
    </div>
    <div class="modal-foot"><div style="flex:1"></div>
      <button class="btn btn-sm btn-ghost" data-close>Not now</button></div>
  </div>`
  document.body.appendChild(scrim)
  const close = () => scrim.remove()
  scrim.querySelectorAll('[data-close]').forEach(b => b.onclick = close)
  scrim.onclick = e => { if (e.target === scrim) close() }
  scrim.querySelector('[data-go="edit"]').onclick = () => { close(); openInEditor(file) }
  scrim.querySelector('[data-go="export"]').onclick = async () => {
    close(); show('library'); await refreshLibrary()
    quickConvert({ path: file, name: path.basename(file) })
  }
}
