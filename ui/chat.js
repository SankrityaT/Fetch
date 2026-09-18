// The chat pane. Docked on the right, toggled with Cmd J.
//
// It runs on the agent CLI already installed and signed in on this Mac, so Fetch
// holds no API key and adds no bill. The pane's job is to make the work legible:
// every tool the agent calls appears as its own row, as it happens, with how long it
// took. An agent that records your screen should never be a spinner.
//
// Self-installing, like ui/library.js and ui/activity.js, so control.html only needs
// the script tag.
;(function () {
  'use strict'

  if (!document.querySelector('link[data-chat-style]')) {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = './ui/chat.css'
    link.setAttribute('data-chat-style', '1')
    document.head.appendChild(link)
  }

  const { ipcRenderer } = require('electron')

  const MARK = { claude: 'claude', codex: 'codex' }
  const ico = (n, c) => `<svg class="${c || 'icon-sm'}"><use href="./assets/icons/sprite.svg#i-${n}"/></svg>`
  const esc = t => String(t == null ? '' : t)
    .replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

  // The smallest markdown that matters here. Models write **bold** and bullet lists
  // whatever you ask, and showing the asterisks reads as a bug. Escaped first, so the
  // only tags that reach the DOM are the ones made below.
  function md(t) {
    return esc(t)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/^[-*] +/gm, '\u00b7 ')
  }

  const state = {
    open: false,
    engine: 'claude',
    engines: [],
    busy: false,
    tools: new Map(),      // tool id -> its row, so the result can land on it
  }

  let pane, list, input, sendBtn, enginePill

  function build() {
    pane = document.createElement('aside')
    pane.className = 'chat'
    pane.id = 'chatPane'
    pane.hidden = true
    pane.innerHTML = `
      <div class="chat-head">
        <img class="biscuit" src="./assets/mascot/sit-happy.png" alt="">
        <div class="chat-head-txt">
          <span class="chat-title">Ask Biscuit</span>
          <span class="chat-sub" id="chatSub">on your own plan</span>
        </div>
        <button class="btn btn-ghost btn-icon btn-sm" id="chatClose" data-tip="Close">${ico('x', 'icon-sm')}</button>
      </div>

      <div class="chat-list" id="chatList">
        <div class="chat-intro">
          <p>I can record, look at what is on screen, transcribe and read your takes.
             Ask for it in plain words.</p>
          <div class="chat-egs">
            <button class="chat-eg">What is on my screen right now?</button>
            <button class="chat-eg">Record my Chrome window</button>
            <button class="chat-eg">Transcribe my latest recording</button>
          </div>
        </div>
      </div>

      <form class="chat-composer" id="chatForm">
        <div class="chat-ctx" id="chatCtx" hidden></div>
        <textarea id="chatInput" rows="1" placeholder="Ask for a recording, a transcript, anything Fetch can do"></textarea>
        <div class="chat-foot">
          <button type="button" class="chat-engine" id="chatEngine"></button>
          <span class="chat-hint" data-tip="Only Fetch's own tools. No shell, no files, no network.">Fetch's tools only</span>
          <button type="button" class="chat-mic" id="chatMic"
            data-tip="Dictate. Transcribed on this Mac.">${ico('microphone', 'icon-sm')}</button>
          <button type="submit" class="chat-send" id="chatSend" disabled>${ico('arrow-right', 'icon-sm')}</button>
        </div>
      </form>`
    document.body.appendChild(pane)

    list = pane.querySelector('#chatList')
    input = pane.querySelector('#chatInput')
    sendBtn = pane.querySelector('#chatSend')
    enginePill = pane.querySelector('#chatEngine')

    pane.querySelector('#chatClose').onclick = () => toggle(false)
    pane.querySelector('#chatForm').onsubmit = e => { e.preventDefault(); submit() }
    pane.querySelectorAll('.chat-eg').forEach(b => {
      b.onclick = () => { input.value = b.textContent; grow(); input.focus(); sync() }
    })
    input.addEventListener('input', () => { grow(); sync() })
    // Enter sends, Shift+Enter is a newline: this is a chat box, not a document.
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() }
    })
    enginePill.onclick = cycleEngine
    pane.querySelector('#chatMic').onclick = micToggle
  }

  // ── dictation ──────────────────────────────────────────────────────────
  // Speaking a message is as local as typing one: the audio goes to the transcriber
  // already bundled in the app and never to a server. The honest counterpart to the
  // voiceover panel, which is the one feature here that does use the network.
  let rec = null, recChunks = [], recTimer = null, recStart = 0

  async function micToggle() {
    const btn = pane.querySelector('#chatMic')
    if (rec) { stopDictation(); return }

    let stream
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }) }
    catch { toast('Fetch needs microphone access to dictate', 'bad', 6000); return }

    recChunks = []
    rec = new MediaRecorder(stream, { mimeType: 'audio/webm' })
    rec.ondataavailable = e => { if (e.data && e.data.size) recChunks.push(e.data) }
    rec.onstop = async () => {
      // Release the mic before the transcribe round trip, so the macOS recording
      // indicator does not stay lit while we are only thinking.
      stream.getTracks().forEach(t => t.stop())
      clearInterval(recTimer); recTimer = null
      rec = null
      btn.dataset.state = 'thinking'
      btn.setAttribute('data-tip', 'Transcribing on this Mac')

      const blob = new Blob(recChunks, { type: 'audio/webm' })
      if (blob.size < 2000) { resetMic(btn); return }      // a stray tap, not speech
      const buf = new Uint8Array(await blob.arrayBuffer())
      const r = await ipcRenderer.invoke('dictate', buf).catch(() => null)
      resetMic(btn)
      if (!r || !r.ok || !r.text) { toast((r && r.error) || 'Nothing was said', 'bad'); return }
      input.value = input.value.trim() ? input.value.trim() + ' ' + r.text : r.text
      grow(); sync(); input.focus()
    }

    rec.start()
    recStart = Date.now()
    btn.dataset.state = 'recording'
    recTimer = setInterval(() => {
      const s = Math.floor((Date.now() - recStart) / 1000)
      btn.setAttribute('data-tip', s + 's. Click to stop.')
      if (s >= 120) stopDictation()        // a mic left open is nobody's intent
    }, 250)
  }

  function resetMic(btn) {
    btn.dataset.state = ''
    btn.setAttribute('data-tip', 'Dictate. Transcribed on this Mac.')
  }
  function stopDictation() { if (rec && rec.state !== 'inactive') rec.stop() }

  const grow = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 160) + 'px' }
  const sync = () => { sendBtn.disabled = state.busy || !input.value.trim() }

  function paintEngine() {
    const e = state.engines.find(x => x.id === state.engine) || state.engines[0]
    if (!e) {
      enginePill.innerHTML = `<span class="chat-engine-none">No agent connected</span>`
      pane.querySelector('#chatSub').textContent = 'no agent found'
      return
    }
    state.engine = e.id
    enginePill.innerHTML =
      `<img src="./assets/agents/${MARK[e.id]}.svg" alt="" onerror="this.remove()">` +
      `<span>${esc(e.label)}</span>` +
      (state.engines.length > 1 ? ico('caret-down', 'icon-sm') : '')
    pane.querySelector('#chatSub').textContent = `on your ${e.label} plan`
  }

  // Two engines at most, so a menu would be more clicks than a toggle.
  function cycleEngine() {
    if (state.engines.length < 2) return
    const i = state.engines.findIndex(x => x.id === state.engine)
    state.engine = state.engines[(i + 1) % state.engines.length].id
    paintEngine()
  }

  const atBottom = () => list.scrollHeight - list.scrollTop - list.clientHeight < 80
  const scroll = was => { if (was) list.scrollTop = list.scrollHeight }

  function add(html, cls) {
    const was = atBottom()
    const n = document.createElement('div')
    n.className = cls
    n.innerHTML = html
    list.appendChild(n)
    scroll(was)
    return n
  }

  function submit() {
    const text = input.value.trim()
    if (!text || state.busy) return
    const intro = list.querySelector('.chat-intro')
    if (intro) intro.remove()

    add(esc(text), 'chat-msg chat-me')
    input.value = ''; grow()
    state.busy = true; sync()
    sendBtn.classList.add('working')

    const ctx = window.ed && window.ed.src ? window.ed.src : null
    const prompt = ctx
      ? `${text}\n\n(The recording currently open in Fetch is ${ctx})`
      : text

    ipcRenderer.send('chat-send', { engine: state.engine, prompt })
  }

  // One row per tool call, filled in when its result arrives. The row appears the
  // moment the call starts, so a long transcribe shows what is happening rather than
  // leaving the pane silent.
  function toolRow(ev) {
    const n = add(
      `<span class="chat-tool-ico">${ico('circle-fill', 'icon-sm')}</span>` +
      `<span class="chat-tool-name">${esc(ev.name)}</span>` +
      `<span class="chat-tool-sum"></span>` +
      `<span class="chat-tool-ms mono"></span>`, 'chat-tool')
    n.dataset.state = 'running'
    state.tools.set(ev.id, n)
  }

  function toolDone(ev) {
    const n = state.tools.get(ev.id)
    if (!n) return
    state.tools.delete(ev.id)
    n.dataset.state = ev.ok ? 'ok' : 'bad'
    n.querySelector('.chat-tool-ico').innerHTML = ico(ev.ok ? 'check' : 'warning-circle', 'icon-sm')
    if (ev.summary) n.querySelector('.chat-tool-sum').textContent = ev.summary
    if (ev.ms != null) n.querySelector('.chat-tool-ms').textContent = ev.ms < 1000
      ? ev.ms + ' ms' : (ev.ms / 1000).toFixed(1) + ' s'
  }

  ipcRenderer.on('chat-event', (e, ev) => {
    if (!pane) return
    if (ev.kind === 'text') add(md(ev.text), 'chat-msg chat-them')
    else if (ev.kind === 'tool') toolRow(ev)
    else if (ev.kind === 'result') toolDone(ev)
    else if (ev.kind === 'done') {
      state.busy = false; sync()
      sendBtn.classList.remove('working')
      // Any tool still marked running never reported back; say so rather than
      // leaving a row spinning forever.
      for (const [, n] of state.tools) { n.dataset.state = 'bad'; n.querySelector('.chat-tool-ico').innerHTML = ico('warning-circle', 'icon-sm') }
      state.tools.clear()
      if (!ev.ok && ev.error) add(esc(ev.error), 'chat-msg chat-err')
      if (window.refreshActivity) window.refreshActivity()
    }
  })

  function toggle(open) {
    state.open = open == null ? !state.open : open
    pane.hidden = !state.open
    document.getElementById('stage').classList.toggle('with-chat', state.open)
    if (state.open) { input.focus(); refreshEngines() }
  }

  async function refreshEngines() {
    try { state.engines = await ipcRenderer.invoke('chat-engines') || [] } catch { state.engines = [] }
    paintEngine()
    if (window.__paintHeroEngine) window.__paintHeroEngine()
  }

  // The hero composer on the Record screen is the same conversation as the pane, not
  // a second one. Typing there opens the pane and sends, so a question asked from the
  // front door and a follow-up asked in the sidebar are one thread.
  function wireHero() {
    const form = document.getElementById('heroAsk')
    const field = document.getElementById('heroInput')
    const send = document.getElementById('heroSend')
    const chips = document.getElementById('heroChips')
    if (!form || !field) return

    const grow = () => { field.style.height = 'auto'; field.style.height = Math.min(field.scrollHeight, 140) + 'px' }
    const sync = () => { send.disabled = !field.value.trim() }

    const ask = text => {
      if (!text.trim()) return
      toggle(true)
      input.value = text
      field.value = ''; grow(); sync()
      submit()
    }

    field.addEventListener('input', () => { grow(); sync() })
    field.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(field.value) }
    })
    form.onsubmit = e => { e.preventDefault(); ask(field.value) }

    chips.addEventListener('click', e => {
      const chip = e.target.closest('[data-ask]')
      if (chip) ask(chip.dataset.ask)
    })

    // mirror the engine pill so the front door says which plan this runs on
    const pill = document.getElementById('heroEngine')
    if (pill) {
      pill.onclick = () => { cycleEngine(); paintHeroEngine() }
      window.__paintHeroEngine = paintHeroEngine
      paintHeroEngine()
    }
  }

  function paintHeroEngine() {
    const pill = document.getElementById('heroEngine')
    if (!pill) return
    const e = state.engines.find(x => x.id === state.engine) || state.engines[0]
    pill.innerHTML = e
      ? `<img src="./assets/agents/${MARK[e.id]}.svg" alt="" onerror="this.remove()"><span>${esc(e.label)}</span>` +
        (state.engines.length > 1 ? ico('caret-down', 'icon-sm') : '')
      : `<span class="chat-engine-none">No agent connected</span>`
  }

  function init() {
    if (document.getElementById('chatPane')) return
    build()
    wireHero()
    refreshEngines()
    document.addEventListener('keydown', e => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') { e.preventDefault(); toggle() }
      if (e.key === 'Escape' && state.open && document.activeElement === input) toggle(false)
    })
    window.toggleChat = toggle
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init)
  else init()
})()
