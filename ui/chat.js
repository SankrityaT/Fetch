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
    models: [],            // chat-models: what each installed CLI can run
    pick: null,            // { engine, model, effort }, saved in prefs.chatModel
    busy: false,
    tools: new Map(),      // tool id -> its row, so the result can land on it
  }

  let pane, list, input, sendBtn, enginePill

  // ── attachments ────────────────────────────────────────────────────────
  // Paste or drop a file into either composer and it becomes a tile above the text,
  // never its filename as text. Images reach the model as images (ui/agent-chat.js);
  // recordings and other files travel as paths the Fetch tools can use. One list for
  // both composers, since the hero hands its message to this pane's thread.
  const { webUtils, clipboard } = require('electron')
  const MAX_ATT = 8
  const IMG_RE = /\.(png|jpe?g|gif|webp|heic|tiff?)$/i
  const VID_RE = /\.(mov|mp4|m4v|webm|mkv)$/i
  const kindOf = p => IMG_RE.test(p) ? 'image' : VID_RE.test(p) ? 'video' : 'file'
  const fileUrl = p => 'file://' + encodeURI(p).replace(/#/g, '%23').replace(/\?/g, '%3F')
  const baseName = p => String(p).split('/').pop()
  let attach = []                // [{ path, kind, name }]
  let heroSync = () => {}

  function addAttachments(paths) {
    let over = 0
    for (const p of paths) {
      if (!p || attach.some(a => a.path === p)) continue
      if (attach.length >= MAX_ATT) { over++; continue }
      attach.push({ path: p, kind: kindOf(p), name: baseName(p) })
    }
    if (over && window.toast) toast(`Up to ${MAX_ATT} attachments per message`, 'bad')
    paintAttach()
  }

  function tileHtml(a, i) {
    const x = `<button type="button" class="att-x" data-unattach="${i}" aria-label="Remove ${esc(a.name)}">${ico('x', 'icon-xs')}</button>`
    if (a.kind === 'image') {
      return `<div class="att att-img" title="${esc(a.name)}"><img src="${esc(fileUrl(a.path))}" alt="">${x}</div>`
    }
    if (a.kind === 'video') {
      return `<div class="att att-img att-vid" title="${esc(a.name)}">
        <video src="${esc(fileUrl(a.path))}#t=0.4" muted preload="metadata" playsinline></video>
        <span class="att-badge">${ico('play-fill', 'icon-xs')}<span class="att-dur"></span></span>${x}</div>`
    }
    const ext = (a.name.match(/\.([a-z0-9]{1,5})$/i) || [, 'file'])[1]
    return `<div class="att att-file" title="${esc(a.path)}">
      <span class="att-ico">${ico('file-text', 'icon-sm')}</span>
      <span class="att-meta"><span class="att-name">${esc(a.name)}</span><span class="att-ext">${esc(ext.toUpperCase())}</span></span>${x}</div>`
  }

  function paintAttach() {
    for (const id of ['chatAtt', 'heroAtt']) {
      const tray = document.getElementById(id)
      if (!tray) continue
      tray.hidden = !attach.length
      tray.innerHTML = attach.map(tileHtml).join('')
      tray.querySelectorAll('video').forEach(v => v.addEventListener('loadedmetadata', () => {
        const d = v.duration, lab = v.parentElement.querySelector('.att-dur')
        if (lab && isFinite(d)) lab.textContent = `${Math.floor(d / 60)}:${String(Math.round(d % 60)).padStart(2, '0')}`
      }, { once: true }))
    }
    if (sendBtn) sync()
    heroSync()
  }

  // Paths from a paste or a drop. Files from Finder have a path; an image copied to
  // the clipboard (a screenshot) does not, so main writes it to the temp dir first.
  async function pathsFrom(dt) {
    const out = []
    for (const f of Array.from((dt && dt.files) || [])) {
      let p = ''
      try { p = webUtils.getPathForFile(f) } catch {}
      if (p) out.push(p)
      else if (/^image\//.test(f.type)) {
        const bytes = new Uint8Array(await f.arrayBuffer())
        out.push(await ipcRenderer.invoke('chat-attach-blob', { bytes, type: f.type }))
      }
    }
    return out
  }

  // Copying files in Finder puts their paths on the pasteboard, and Chromium pastes
  // only the bare filename as text. Read the real paths, synchronously, so the paste
  // can be stopped before that text lands.
  function finderPaths() {
    const out = []
    try {
      const plist = clipboard.read('NSFilenamesPboardType')
      for (const m of String(plist || '').matchAll(/<string>([^<]+)<\/string>/g)) {
        out.push(m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'))
      }
    } catch {}
    if (!out.length) try {
      const url = clipboard.read('public.file-url')
      if (url && url.startsWith('file://')) out.push(decodeURIComponent(new URL(url).pathname))
    } catch {}
    return out
  }

  function wireAttach(field, zone) {
    field.addEventListener('paste', async e => {
      const finder = finderPaths()
      if (finder.length) { e.preventDefault(); addAttachments(finder); return }
      const dt = e.clipboardData
      if (dt && dt.files && dt.files.length) {
        e.preventDefault()
        addAttachments(await pathsFrom(dt))
      }
    })
    zone.addEventListener('dragover', e => {
      if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return
      e.preventDefault()
      zone.classList.add('is-drop')
    })
    zone.addEventListener('dragleave', e => { if (!zone.contains(e.relatedTarget)) zone.classList.remove('is-drop') })
    zone.addEventListener('drop', async e => {
      zone.classList.remove('is-drop')
      if (!e.dataTransfer || !e.dataTransfer.files.length) return
      e.preventDefault()
      addAttachments(await pathsFrom(e.dataTransfer))
      field.focus()
    })
    zone.addEventListener('click', e => {
      const x = e.target.closest('[data-unattach]')
      if (!x) return
      e.preventDefault()
      attach.splice(+x.dataset.unattach, 1)
      paintAttach()
      field.focus()
    })
  }

  // ── Biscuit's face follows the turn ──────────────────────────────────
  // The chat already knows everything that happens in a turn, so the dog in its
  // header says it at a glance: thinking while the agent reasons, the recording pose
  // while it records, running while it renders, focused while it reads. A turn that
  // made a file ends in a celebration, a plain answer in a wink, a failure in the sad
  // face, which stays until the next message so it is not missed.
  const FACE = {
    rest: 'sit-happy', think: 'thinking', read: 'focused', record: 'recording',
    render: 'running', made: 'celebrating', answer: 'wink', fail: 'sad',
  }
  const faceForTool = name => {
    const t = String(name || '').replace(/^mcp__fetch__/, '')
    if (t === 'record_start') return 'record'
    if (/^(export|remove_dead_air|enhance_audio)$/.test(t)) return 'render'
    return 'read'
  }
  let faceTimer = null
  function setFace(k, holdMs) {
    clearTimeout(faceTimer)
    const src = `./assets/mascot/${FACE[k] || FACE.rest}.png`
    const imgs = [pane && pane.querySelector('.chat-head .biscuit')]
    // The Record screen's Biscuit mirrors the pane while a turn runs, since that is
    // where a turn started from the front door is being watched. A turn is something
    // happening, so it wakes him first, the same as any other mood change.
    if (k !== 'rest' && window.Biscuit) window.Biscuit.wake()
    const hero = document.getElementById('biscuit')
    const heroOn = hero && hero.tagName === 'IMG' && hero.dataset.sleeping !== 'true' && hero.offsetParent
    if (heroOn && k !== 'rest') { imgs.push(hero); heroTouched = true }
    for (const img of imgs) {
      if (!img || img.getAttribute('src') === src) continue
      img.classList.add('face-swap')
      img.src = src
      setTimeout(() => img.classList.remove('face-swap'), 260)
    }
    if (holdMs) faceTimer = setTimeout(() => setFace('rest'), holdMs)
    // A failure keeps its face in the pane until the next message, but the Record
    // screen is the front door, so he only looks sorry there for a moment.
    clearTimeout(heroTimer)
    if (k === 'fail' && heroTouched) heroTimer = setTimeout(settleHero, 5000)
    if (k === 'rest') settleHero()
  }
  // Nothing is happening once a turn is over, and on the Record screen that means he
  // goes back to sleep (ui/idle.js), not to sitting awake. Only if this pane woke him.
  let heroTimer = null
  function settleHero() {
    if (!heroTouched) return
    heroTouched = false
    const hero = document.getElementById('biscuit')
    if (!hero || hero.dataset.sleeping === 'true') return
    hero.src = './assets/mascot/idle.png'
    if (window.Biscuit) window.Biscuit.nap()      // refuses while a take is running
  }
  let heroTouched = false
  const turn = { made: false }

  // Shown on an empty thread, and again after New chat.
  const INTRO = `
        <div class="chat-intro">
          <p>Record a window, find a moment by what was said, cut, zoom and export.
             Ask in plain words.</p>
          <div class="chat-egs">
            <button type="button" class="chat-eg">Record my Chrome window for 10 seconds</button>
            <button type="button" class="chat-eg">Cut the dead air from my last take</button>
            <button type="button" class="chat-eg">Export my latest recording</button>
          </div>
        </div>`

  function wireIntro() {
    list.querySelectorAll('.chat-eg').forEach(b => {
      b.onclick = () => { input.value = b.textContent; grow(); input.focus(); sync() }
    })
  }

  function build() {
    pane = document.createElement('aside')
    pane.className = 'chat'
    pane.id = 'chatPane'
    pane.hidden = true
    pane.innerHTML = `
      <div class="chat-head">
        <img class="biscuit" src="./assets/mascot/sit-happy.png" alt="">
        <div class="chat-head-txt">
          <span class="chat-title">Chat</span>
          <span class="chat-sub" id="chatSub">on your own plan</span>
        </div>
        <button type="button" class="btn btn-ghost btn-sm chat-new" id="chatNew"
          data-tip="Clear this chat and start a fresh conversation">${ico('plus', 'icon-sm')}New chat</button>
        <button class="btn btn-ghost btn-icon btn-sm" id="chatClose" data-tip="Close">${ico('x', 'icon-sm')}</button>
      </div>

      <div class="chat-list" id="chatList">
        ${INTRO}
      </div>

      <form class="chat-composer" id="chatForm">
        <div class="chat-mention" id="chatMention" hidden></div>
        <div class="chat-on-row" id="chatOn" hidden></div>
        <div class="chat-ctx" id="chatCtx" hidden></div>
        <div class="att-tray" id="chatAtt" hidden></div>
        <textarea id="chatInput" rows="1" placeholder="Ask anything, or type @ to point at a recording"></textarea>
        <div class="chat-foot">
          <button type="button" class="chat-engine" id="chatEngine"></button>
          <span class="chat-hint" data-tip="Only Fetch's own tools. No shell, no files, no network.">Fetch's tools only</span>
          <button type="button" class="chat-mic" id="chatMic"
            data-tip="Dictate. Transcribed on this Mac.">${ico('microphone', 'icon-sm')}</button>
          <button type="submit" class="chat-send" id="chatSend" aria-label="Send" disabled>${ico('arrow-right', 'icon-sm')}</button>
        </div>
      </form>`
    document.body.appendChild(pane)

    list = pane.querySelector('#chatList')
    input = pane.querySelector('#chatInput')
    sendBtn = pane.querySelector('#chatSend')
    enginePill = pane.querySelector('#chatEngine')

    pane.querySelector('#chatClose').onclick = () => toggle(false)
    pane.querySelector('#chatNew').onclick = newChat
    // While a turn runs the send button is Stop. Enter never stops a turn (see the
    // keydown below), only a deliberate click does.
    pane.querySelector('#chatForm').onsubmit = e => { e.preventDefault(); state.busy ? stop() : submit() }
    wireIntro()
    list.addEventListener('click', openCard)
    pane.querySelector('#chatOn').addEventListener('click', e => {
      if (!e.target.closest('[data-unon]')) return
      ctxOff = true
      paintOn()
      input.focus()
    })
    window.addEventListener('fetch:editor-open', () => { ctxOff = false; paintOn() })
    // a rename can move the open recording under the chip, so look again before typing
    input.addEventListener('focus', () => paintOn())
    input.addEventListener('input', () => { grow(); sync(); updateMention() })
    // Enter sends, Shift+Enter is a newline: this is a chat box, not a document.
    input.addEventListener('keydown', e => {
      const pop = pane.querySelector('#chatMention')
      if (!pop.hidden && mentionList.length) {
        if (e.key === 'ArrowDown') { e.preventDefault(); mentionPick = (mentionPick + 1) % mentionList.length; updateMention(); return }
        if (e.key === 'ArrowUp') { e.preventDefault(); mentionPick = (mentionPick - 1 + mentionList.length) % mentionList.length; updateMention(); return }
        if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); takeMention(mentionPick); return }
        if (e.key === 'Escape') { e.preventDefault(); pop.hidden = true; return }
      }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() }
    })
    pane.querySelector('#chatMention').addEventListener('mousedown', e => {
      const row = e.target.closest('.chat-mention-row')
      if (row) { e.preventDefault(); takeMention(+row.dataset.i) }
    })
    pane.querySelector('#chatCtx').addEventListener('click', e => {
      const x = e.target.closest('[data-untag]')
      if (x) { tags.splice(+x.dataset.untag, 1); paintTags() }
    })
    wireAttach(input, pane.querySelector('#chatForm'))
    enginePill.onclick = () => openPicker(enginePill)
    enginePill.setAttribute('aria-haspopup', 'dialog')
    pane.querySelector('#chatMic').onclick = micToggle
  }

  // ── @ mentions ─────────────────────────────────────────────────────────
  // Point at a recording instead of describing it. "Caption @demo-take" is exact;
  // "caption the one from this morning" makes the agent guess, and a wrong guess on a
  // recording is an edit to the wrong file.
  //
  // Rows follow the shape that makes this usable when twenty takes have similar
  // names: the match is bolded, and the second line carries the one fact that
  // disambiguates. Kind is shown as a glyph, not a thumbnail, because at this size
  // kind resolves faster than a 20px picture.
  let tags = []                        // [{ name, path }] riding along with the message
  let mentionList = [], mentionPick = 0, mentionAt = -1

  async function recordingsForMention() {
    try { return await ipcRenderer.invoke('list-recordings') || [] } catch { return [] }
  }

  function mentionQuery() {
    const v = input.value, caret = input.selectionStart
    const before = v.slice(0, caret)
    const m = /(^|\s)@([^\s@]*)$/.exec(before)
    if (!m) return null
    return { q: m[2].toLowerCase(), at: caret - m[2].length - 1 }
  }

  const agoText = t => {
    if (!t) return ''
    const d = (Date.now() - t) / 1000
    if (d < 3600) return Math.max(1, Math.round(d / 60)) + 'm ago'
    if (d < 86400) return Math.round(d / 3600) + 'h ago'
    return Math.round(d / 86400) + 'd ago'
  }

  function boldMatch(name, q) {
    const i = q ? name.toLowerCase().indexOf(q) : -1
    if (i < 0) return esc(name)
    return esc(name.slice(0, i)) + '<strong>' + esc(name.slice(i, i + q.length)) + '</strong>' + esc(name.slice(i + q.length))
  }

  async function updateMention() {
    const hit = mentionQuery()
    const pop = pane.querySelector('#chatMention')
    if (!hit) { pop.hidden = true; mentionAt = -1; return }
    mentionAt = hit.at
    const all = await recordingsForMention()
    mentionList = all
      .filter(r => !hit.q || String(r.name).toLowerCase().includes(hit.q))
      .slice(0, 7)
    if (!mentionList.length) { pop.hidden = true; return }
    mentionPick = Math.min(mentionPick, mentionList.length - 1)
    pop.innerHTML = mentionList.map((r, i) =>
      '<button type="button" class="chat-mention-row" data-i="' + i + '" data-on="' + (i === mentionPick) + '">' +
        ico(r.srt ? 'closed-captioning' : 'film-strip', 'icon-sm') +
        '<span class="chat-mention-txt">' +
          '<span class="chat-mention-name">' + boldMatch(r.name, hit.q) + '</span>' +
          '<span class="chat-mention-sub">Recording' +
            (r.mb ? ' · ' + r.mb + ' MB' : '') + (r.mtime ? ' · ' + agoText(r.mtime) : '') +
            (r.srt ? ' · transcribed' : '') + '</span>' +
        '</span>' +
      '</button>').join('')
    pop.hidden = false
  }

  function takeMention(i) {
    const r = mentionList[i]
    if (!r || mentionAt < 0) return
    const v = input.value, caret = input.selectionStart
    input.value = (v.slice(0, mentionAt) + v.slice(caret)).replace(/\s{2,}/g, ' ')
    input.selectionStart = input.selectionEnd = mentionAt
    if (!tags.some(t => t.path === r.path)) tags.push({ name: r.name, path: r.path })
    pane.querySelector('#chatMention').hidden = true
    mentionAt = -1
    paintTags(); grow(); sync(); input.focus()
  }

  function paintTags() {
    const host = pane.querySelector('#chatCtx')
    host.hidden = !tags.length
    host.innerHTML = tags.map((t, i) =>
      '<span class="chat-tag">' + ico('film-strip', 'icon-sm') +
        '<span>' + esc(t.name) + '</span>' +
        '<button type="button" data-untag="' + i + '" aria-label="Remove">' + ico('x', 'icon-sm') + '</button>' +
      '</span>').join('')
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

  // scrollHeight leaves out the border, so without it a one-line box sat 2px short
  // and showed a scrollbar. It scrolls only once it reaches its cap.
  const grow = () => {
    input.style.height = 'auto'
    const want = input.scrollHeight + input.offsetHeight - input.clientHeight
    input.style.height = Math.min(want, 160) + 'px'
    input.style.overflowY = want > 160 ? 'auto' : 'hidden'
  }
  const sync = () => {
    sendBtn.disabled = !state.busy && !input.value.trim() && !attach.length
    const stopping = String(state.busy)
    if (sendBtn.dataset.stop === stopping) return
    sendBtn.dataset.stop = stopping
    sendBtn.innerHTML = ico(state.busy ? 'stop-fill' : 'arrow-right', 'icon-sm')
    sendBtn.setAttribute('aria-label', state.busy ? 'Stop' : 'Send')
    if (state.busy) sendBtn.setAttribute('data-tip', 'Stop')
    else sendBtn.removeAttribute('data-tip')
    const nb = pane.querySelector('#chatNew')
    nb.disabled = state.busy
    nb.setAttribute('data-tip', state.busy ? 'Stop this turn first' : 'Clear this chat and start a fresh conversation')
  }

  // One label for both pills: vendor mark, model, then effort in a quieter weight.
  // Before the catalogue arrives it falls back to the CLI name, so the pill is never
  // blank on a slow first detect.
  function pillHtml() {
    const e = state.engines.find(x => x.id === state.engine) || state.engines[0]
    if (!e) return null
    const d = window.modelPicker && modelPicker.describe(state.models, state.pick)
    const mark = `<img src="./assets/agents/${MARK[e.id]}.svg" alt="" onerror="this.remove()">`
    return d
      ? mark + `<span>${esc(d.model.label)}</span>` +
        (d.effort ? `<span class="mp-pill-eff">${esc(d.effortLabel)}</span>` : '') + ico('caret-down', 'icon-sm')
      : mark + `<span>${esc(e.label)}</span>`
  }

  function paintEngine() {
    const html = pillHtml()
    const e = state.engines.find(x => x.id === state.engine) || state.engines[0]
    if (!html) {
      enginePill.innerHTML = `<span class="chat-engine-none">No agent connected</span>`
      pane.querySelector('#chatSub').textContent = 'no agent found'
      return
    }
    state.engine = e.id
    enginePill.innerHTML = html
    pane.querySelector('#chatSub').textContent = `on your ${e.label} plan`
  }

  // Choosing a model chooses its CLI too: a Codex model runs on Codex. Each CLI keeps
  // its own conversation (ui/agent-chat.js), so switching back picks the thread up.
  function openPicker(anchor) {
    if (!window.modelPicker || !state.models.length) return
    modelPicker.show(anchor, {
      catalogue: state.models,
      value: state.pick,
      mark: id => `./assets/agents/${MARK[id]}.svg`,
      onPick: v => {
        state.pick = v
        state.engine = v.engine
        if (window.savePrefs) savePrefs({ chatModel: v })
        paintEngine()
        paintHeroEngine()
      },
    })
  }

  const atBottom = () => list.scrollHeight - list.scrollTop - list.clientHeight < 80
  const scroll = was => { if (was) list.scrollTop = list.scrollHeight }

  function add(html, cls) {
    const was = atBottom()
    const n = document.createElement('div')
    n.className = cls
    n.innerHTML = html
    // the working line always stays last, under whatever just arrived
    list.insertBefore(n, statusEl && statusEl.parentNode === list ? statusEl : null)
    scroll(was)
    return n
  }

  const dropIntro = () => { const i = list.querySelector('.chat-intro'); if (i) i.remove() }

  // ── the person's turn ──────────────────────────────────────────────────
  // One renderer for a message just sent and for one replayed from the log, so the
  // thread after a restart looks exactly as it did before it.
  function renderUser(msg) {
    dropIntro()
    lastCard = null
    const typed = msg.text || ''
    const sentAtt = msg.attachments || []
    const sentTags = msg.tags || []
    // what was attached rides on the message bubble, small, so the thread shows it
    const thumbs = sentAtt.map(a => a.kind === 'file'
      ? `<span class="chat-me-file">${ico('file-text', 'icon-xs')}${esc(a.name)}</span>`
      : a.kind === 'video'
        ? `<video src="${esc(fileUrl(a.path))}#t=0.4" muted preload="metadata" title="${esc(a.name)}"></video>`
        : `<img src="${esc(fileUrl(a.path))}" alt="" title="${esc(a.name)}">`).join('')
    // what was tagged stays visible on the message it went with
    const tagLine = sentTags.length
      ? '<div class="chat-me-tags">' + sentTags.map(t => '<span>@' + esc(t.name) + '</span>').join('') + '</div>' : ''
    add((sentAtt.length ? `<div class="chat-me-att">${thumbs}</div>` : '') + (typed ? esc(typed) : '') + tagLine,
      'chat-msg chat-me' + (typed ? '' : ' chat-me-only-att'))
  }

  function submit() {
    const typed = input.value.trim()
    if ((!typed && !attach.length) || state.busy) return
    // a pref changed while the pane stayed open still decides this turn
    if (state.models.length) { adoptPick(); if (state.pick) state.engine = state.pick.engine; paintEngine(); paintHeroEngine() }
    const text = typed || (attach.length === 1 ? 'Take a look at this.' : 'Take a look at these.')

    const sentAtt = attach.slice()
    attach = []; paintAttach()
    // the chips were for this message; the conversation remembers them from here
    const sentTags = tags.slice()
    tags = []; paintTags()
    const display = { text: typed, tags: sentTags, attachments: sentAtt }
    renderUser(display)
    input.value = ''; grow()
    startTurn()

    const ctx = contextSrc()
    let prompt = text
    // Tagged recordings travel as exact paths, so the agent acts on the file that was
    // pointed at rather than one it guessed from a description.
    if (sentTags.length) {
      prompt += '\n\nRecordings the user tagged:\n' +
        sentTags.map(t => `- ${t.name}: ${t.path}`).join('\n')
    }
    // The open take is what "this" means, not what "my latest" means: without saying
    // so, an agent asked for the newest take quietly used the open one instead.
    if (ctx && !sentTags.some(t => t.path === ctx)) {
      prompt += `\n\n(Open in the Fetch editor: ${ctx}. Use it when the person says "this" ` +
        `or names no recording. For "latest", "last" or "newest", check list_recordings instead. ` +
        `Name the recording you acted on in your reply.)`
    }

    const pick = state.pick && state.pick.engine === state.engine ? state.pick : {}
    ipcRenderer.send('chat-send', { engine: state.engine, model: pick.model, effort: pick.effort, prompt,
      attachments: sentAtt.map(a => a.path), display })
  }

  // ── a turn in progress ─────────────────────────────────────────────────
  // A quiet line under the last message says who is doing the work, so a long pause
  // between tool calls reads as thinking rather than as a hang.
  let statusEl = null
  function startTurn() {
    state.busy = true; sync()
    turn.made = false
    setFace('think')
    const e = state.engines.find(x => x.id === state.engine)
    hideStatus()
    statusEl = document.createElement('div')
    statusEl.className = 'chat-status'
    statusEl.setAttribute('role', 'status')
    statusEl.innerHTML = `<span class="chat-status-dot" aria-hidden="true"></span>` +
      `<span>Working with ${esc(e ? e.label : 'your agent')}…</span>`
    list.appendChild(statusEl)
    list.scrollTop = list.scrollHeight
  }
  function hideStatus() { if (statusEl) statusEl.remove(); statusEl = null }

  function stop() {
    if (!state.busy) return
    ipcRenderer.send('chat-cancel')
    sendBtn.disabled = true                     // until the turn reports it has ended
    if (statusEl) statusEl.lastElementChild.textContent = 'Stopping…'
  }

  async function newChat() {
    if (state.busy) return
    const ok = await ipcRenderer.invoke('chat-new').catch(() => false)
    if (!ok) return
    list.innerHTML = INTRO
    wireIntro()
    state.tools.clear()
    lastCard = null
    setFace('rest')
    input.focus()
  }

  // One row per tool call, filled in when its result arrives. The row appears the
  // moment the call starts, so a long transcribe shows what is happening rather than
  // leaving the pane silent.
  const toolOf = ev => ev.tool || String(ev.name || '').replace(/^mcp__fetch__/, '').replace(/ /g, '_')

  function toolRow(ev) {
    const n = add(
      `<span class="chat-tool-ico">${ico('circle-fill', 'icon-sm')}</span>` +
      `<span class="chat-tool-name">${esc(String(ev.name || '').replace(/^mcp__fetch__/, ''))}</span>` +
      `<span class="chat-tool-sum"></span>` +
      `<span class="chat-tool-ms mono"></span>`, 'chat-tool')
    n.dataset.state = 'running'
    n.dataset.tool = toolOf(ev)
    n._input = ev.input || {}          // the card needs the path the tool was pointed at
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

  // Any tool still marked running never reported back; say so rather than leaving a
  // row spinning forever. A stopped turn's rows read as stopped, not as failures.
  function settleTools(how) {
    for (const [, n] of state.tools) {
      n.dataset.state = how
      n.querySelector('.chat-tool-ico').innerHTML = ico(how === 'stopped' ? 'stop-fill' : 'warning-circle', 'icon-sm')
    }
    state.tools.clear()
  }

  // ── result cards ───────────────────────────────────────────────────────
  // A tool that made or changed a file ends in a card with the file itself: a
  // thumbnail, one plain line and a click that opens it. The row above is the log of
  // what ran; the card is the thing you came for.
  const clock = s => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`
  const stemOf = p => baseName(p).replace(/\.[^.]+$/, '')
  const AUDIO_RE = /\.(m4a|mp3|wav|aac|flac|ogg)$/i
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`

  function cardInfo(tool, d, inp) {
    d = d || {}; inp = inp || {}
    const meta = []
    if (tool === 'export' && d.path) {
      if (d.mb) meta.push(`${d.mb} MB`)
      if (d.seconds) meta.push(clock(d.seconds))
      return { path: d.path, open: 'reveal', line: `Exported ${baseName(d.path)}`, meta }
    }
    if (tool === 'record_stop' && d.path) {
      if (d.mb) meta.push(`${d.mb} MB`)
      return { path: d.path, open: 'editor', line: `Recorded ${stemOf(d.path)}`, meta }
    }
    if (tool === 'remove_dead_air' && d.path) {
      if (d.seconds) meta.push(clock(d.seconds))
      return { path: d.path, open: 'editor', meta,
        line: typeof d.removed_percent === 'number'
          ? `Removed dead air, ${Math.round(d.removed_percent)}% shorter` : 'Removed the dead air' }
    }
    if (tool === 'enhance_audio' && d.path) {
      return { path: d.path, open: 'editor', line: 'Cleaned up the audio', meta: [stemOf(d.path)] }
    }
    if (tool === 'rename_recording' && d.path) {
      return { path: d.path, open: 'editor', line: `Renamed to ${d.name || stemOf(d.path)}`, meta }
    }
    if (tool === 'apply_edit' && inp.path) {
      const n = k => Array.isArray(d[k]) ? d[k].length : 0
      const parts = []
      if (n('clips') > 1) parts.push(plural(n('clips'), 'clip'))
      if (n('zooms')) parts.push(plural(n('zooms'), 'zoom'))
      if (n('marks')) parts.push(plural(n('marks'), 'mark'))
      if (n('texts')) parts.push(plural(n('texts'), 'text'))
      return { path: inp.path, open: 'editor', meta: [stemOf(inp.path)],
        line: parts.length ? `Updated the edit: ${parts.join(', ')}` : 'Updated the edit' }
    }
    if (tool === 'get_frame' && inp.path) {
      return { path: inp.path, open: 'editor', image: d.image, compact: true,
        line: `Looked at ${clock(+d.at || +inp.at || 0)}`, meta: [stemOf(inp.path)] }
    }
    return null
  }

  let lastCard = null                  // { key, node }, so repeated edits update one card
  function card(tool, data, inp) {
    const c = cardInfo(tool, data, inp)
    if (!c) return false
    const key = tool + '|' + c.path
    // An agent often applies an edit in several passes. One card that says where it
    // ended up is the fact; five in a row are noise.
    if (tool === 'apply_edit' && lastCard && lastCard.key === key) lastCard.node.remove()
    const action = c.open === 'reveal' ? 'Show in Finder' : 'Open in editor'
    const n = add(
      `<button type="button" class="chat-card${c.compact ? ' chat-card-sm' : ''}" data-path="${esc(c.path)}" ` +
        `data-open="${c.open}" aria-label="${esc(c.line)}. ${action}">` +
        `<span class="chat-card-thumb" aria-hidden="true"></span>` +
        `<span class="chat-card-txt">` +
          `<span class="chat-card-line">${esc(c.line)}</span>` +
          `<span class="chat-card-meta">${[...c.meta.map(esc), `<span class="chat-card-act">${action}</span>`].join(' · ')}</span>` +
        `</span>` +
        `<span class="chat-card-ok" aria-hidden="true">${ico('check-circle-fill', 'icon-sm')}</span>` +
      `</button>`, 'chat-card-wrap')
    lastCard = { key, node: n }
    fillThumb(n.querySelector('.chat-card-thumb'), c)
    return true
  }

  // The Library's poster when the file has one, else the video's own early frame,
  // else a plain glyph. Never a broken image.
  // One Library listing shared by every card drawn at once, so a replayed thread with
  // twenty cards asks once, not twenty times.
  let recCache = null, recAt = 0
  async function posterFor(p) {
    if (!recCache || Date.now() - recAt > 5000) { recCache = recordingsForMention(); recAt = Date.now() }
    const r = (await recCache).find(x => x.path === p)
    return r && r.poster
  }

  async function fillThumb(box, c) {
    const glyph = () => { box.innerHTML = ico(AUDIO_RE.test(c.path) ? 'waveform' : 'film-strip', 'icon-lg'); box.dataset.empty = 'true' }
    const img = c.image || (AUDIO_RE.test(c.path) || /\.gif$/i.test(c.path) ? null : await posterFor(c.path).catch(() => null))
    const still = img || (/\.gif$/i.test(c.path) ? c.path : null)
    if (still) {
      box.innerHTML = `<img alt="" src="${esc(fileUrl(still))}">`
      box.firstChild.onerror = glyph
    } else if (!AUDIO_RE.test(c.path)) {
      box.innerHTML = `<video muted preload="metadata" playsinline src="${esc(fileUrl(c.path))}#t=0.4"></video>`
      box.firstChild.onerror = glyph
    } else glyph()
  }

  function openCard(e) {
    const c = e.target.closest('.chat-card')
    if (!c) return
    const p = c.dataset.path
    if (!require('fs').existsSync(p)) {
      if (window.toast) toast('That file is not there any more. It may have been moved or renamed.', 'bad')
      return
    }
    if (c.dataset.open === 'editor' && typeof window.openInEditor === 'function') window.openInEditor(p)
    else ipcRenderer.send('reveal', p)
  }

  // ── "Working on" ───────────────────────────────────────────────────────
  // The recording open in the editor goes along with every message, so "zoom in on the
  // login" has something to point at. Shown, so it is never a hidden assumption, and
  // removable, for a question that has nothing to do with it.
  // Off for the recording open now, until another is opened. A flag rather than the
  // path, so a rename of the open take does not quietly put it back in the prompt.
  let ctxOff = false
  const currentSrc = () => {
    try { if (window.fetchDoc && typeof window.fetchDoc.src === 'function' && window.fetchDoc.src()) return window.fetchDoc.src() } catch {}
    return (window.ed && window.ed.src) || null
  }
  const contextSrc = () => ctxOff ? null : currentSrc()

  function paintOn() {
    const host = pane.querySelector('#chatOn')
    const src = contextSrc()
    host.hidden = !src
    host.innerHTML = src
      ? `<span class="chat-on">${ico('film-strip', 'icon-xs')}<span class="chat-on-lab">Working on:</span>` +
        `<span class="chat-on-name" title="${esc(src)}">${esc(stemOf(src))}</span>` +
        `<button type="button" data-unon aria-label="Leave this recording out" data-tip="Leave it out">${ico('x', 'icon-xs')}</button></span>`
      : ''
  }

  // ── events ─────────────────────────────────────────────────────────────
  // Live events and the saved log go through the same renderer. A replay draws the
  // thread and nothing else: no faces, no activity refresh, no busy state.
  function render(ev, { replay = false } = {}) {
    // Anything arriving means a conversation is under way, so the introduction goes,
    // whoever started the turn.
    dropIntro()
    if (ev.kind === 'user') { renderUser(ev); return }
    if (ev.kind === 'text') add(md(ev.text), 'chat-msg chat-them')
    else if (ev.kind === 'tool') {
      toolRow(ev)
      if (!replay) setFace(faceForTool(toolOf(ev)))
    }
    else if (ev.kind === 'result') {
      const row = state.tools.get(ev.id)
      const name = ev.tool || (row && row.dataset.tool) || ''
      toolDone(ev)
      // the card names the file, so the row's one-line summary would say it twice
      if (ev.ok && card(name, ev.data, row && row._input) && row) row.querySelector('.chat-tool-sum').textContent = ''
      if (replay) return
      if (!ev.ok) setFace('fail')
      else {
        if (/^(export|remove_dead_air|enhance_audio|record_stop)$/.test(name)) turn.made = true
        setFace('think')
      }
    }
    else if (ev.kind === 'done') {
      settleTools(ev.cancelled ? 'stopped' : 'bad')
      if (ev.cancelled) add(`<span>Stopped</span>`, 'chat-note')
      else if (!ev.ok && ev.error) add(esc(ev.error), 'chat-msg chat-err')
      if (replay) return
      hideStatus()
      state.busy = false; sync()
      paintOn()                        // the turn may have opened or renamed a take
      if (ev.cancelled) setFace('rest')
      else if (!ev.ok) setFace('fail')
      else setFace(turn.made ? 'made' : 'answer', turn.made ? 3200 : 1800)
      if (window.refreshActivity) window.refreshActivity()
    }
  }

  ipcRenderer.on('chat-event', (e, ev) => { if (pane) render(ev) })

  // The saved thread, drawn once at start. Anything that arrived live while the log
  // was loading is moved back below it, so the order is still the order it happened.
  async function replay() {
    let log = []
    try { log = await ipcRenderer.invoke('chat-history') || [] } catch {}
    if (!log.length) return
    const live = Array.from(list.children).filter(n => !n.classList.contains('chat-intro'))
    const liveTools = new Map(state.tools)
    state.tools.clear()
    for (const ev of log) { try { render(ev, { replay: true }) } catch {} }
    // a turn cut off by quitting never said it was done
    settleTools('bad')
    for (const [k, v] of liveTools) state.tools.set(k, v)
    for (const n of live) list.appendChild(n)
    if (statusEl) list.appendChild(statusEl)
    list.scrollTop = list.scrollHeight
  }

  function toggle(open) {
    state.open = open == null ? !state.open : open
    pane.hidden = !state.open
    document.getElementById('stage').classList.toggle('with-chat', state.open)
    // the hero composer hides while the pane is open, so a half-typed line moves across
    const hero = document.getElementById('heroInput')
    if (state.open && hero && hero.value.trim() && !input.value.trim()) {
      input.value = hero.value; hero.value = ''
      hero.dispatchEvent(new Event('input')); grow(); sync()
    }
    if (state.open) { input.focus(); refreshEngines(); paintOn() }
  }

  // The saved pref is the source of truth, not the last pick this pane made, so a
  // change made anywhere else (savePrefs, another composer) is what the next turn
  // runs on. null means the CLI's own default.
  function adoptPick() {
    const saved = window.prefs ? window.prefs.chatModel : state.pick
    state.pick = window.modelPicker ? modelPicker.resolve(state.models, saved) : null
  }

  async function refreshEngines() {
    try { state.engines = await ipcRenderer.invoke('chat-engines') || [] } catch { state.engines = [] }
    try { state.models = await ipcRenderer.invoke('chat-models', state.engines.map(e => e.id)) || [] } catch { state.models = [] }
    adoptPick()
    if (state.pick) state.engine = state.pick.engine
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
    const sync = () => { send.disabled = !field.value.trim() && !attach.length }
    heroSync = sync

    const ask = text => {
      if (!text.trim() && !attach.length) return
      toggle(true)
      input.value = text
      field.value = ''; grow(); sync()
      submit()
    }

    field.addEventListener('input', () => { grow(); sync() })
    field.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(field.value) }
    })
    wireAttach(field, form)
    form.onsubmit = e => { e.preventDefault(); ask(field.value) }

    chips.addEventListener('click', e => {
      const chip = e.target.closest('[data-ask]')
      if (chip) ask(chip.dataset.ask)
    })

    // mirror the engine pill so the front door says which plan this runs on
    const pill = document.getElementById('heroEngine')
    if (pill) {
      pill.onclick = () => openPicker(pill)
      pill.setAttribute('aria-haspopup', 'dialog')
      window.__paintHeroEngine = paintHeroEngine
      paintHeroEngine()
    }
  }

  function paintHeroEngine() {
    const pill = document.getElementById('heroEngine')
    if (!pill) return
    pill.innerHTML = pillHtml() || `<span class="chat-engine-none">No agent connected</span>`
  }

  function init() {
    if (document.getElementById('chatPane')) return
    build()
    wireHero()
    refreshEngines()
    replay()
    sync()
    document.addEventListener('keydown', e => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') { e.preventDefault(); toggle() }
      if (e.key === 'Escape' && state.open && document.activeElement === input) toggle(false)
    })
    window.toggleChat = toggle
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init)
  else init()
})()
