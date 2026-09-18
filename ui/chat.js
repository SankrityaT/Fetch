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
    // back to rest: hand the Record screen's Biscuit back to idle, but only if this
    // pane changed him, and never while he is asleep (he may be a video by then)
    if (k === 'rest' && heroTouched) {
      heroTouched = false
      if (heroOn) hero.src = './assets/mascot/idle.png'
    }
  }
  let heroTouched = false
  const turn = { made: false }

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
        <div class="chat-mention" id="chatMention" hidden></div>
        <div class="chat-ctx" id="chatCtx" hidden></div>
        <div class="att-tray" id="chatAtt" hidden></div>
        <textarea id="chatInput" rows="1" placeholder="Ask anything, or type @ to point at a recording"></textarea>
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

  const grow = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 160) + 'px' }
  const sync = () => { sendBtn.disabled = state.busy || (!input.value.trim() && !attach.length) }

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
    list.appendChild(n)
    scroll(was)
    return n
  }

  function submit() {
    const typed = input.value.trim()
    if ((!typed && !attach.length) || state.busy) return
    const text = typed || (attach.length === 1 ? 'Take a look at this.' : 'Take a look at these.')
    const intro = list.querySelector('.chat-intro')
    if (intro) intro.remove()

    // what was attached rides on the message bubble, small, so the thread shows it
    const sentAtt = attach.slice()
    attach = []; paintAttach()
    const thumbs = sentAtt.map(a => a.kind === 'file'
      ? `<span class="chat-me-file">${ico('file-text', 'icon-xs')}${esc(a.name)}</span>`
      : a.kind === 'video'
        ? `<video src="${esc(fileUrl(a.path))}#t=0.4" muted preload="metadata" title="${esc(a.name)}"></video>`
        : `<img src="${esc(fileUrl(a.path))}" alt="" title="${esc(a.name)}">`).join('')
    add((sentAtt.length ? `<div class="chat-me-att">${thumbs}</div>` : '') + (typed ? esc(typed) : ''),
      'chat-msg chat-me' + (typed ? '' : ' chat-me-only-att'))
    input.value = ''; grow()
    state.busy = true; sync()
    turn.made = false
    setFace('think')
    sendBtn.classList.add('working')

    const ctx = window.ed && window.ed.src ? window.ed.src : null
    let prompt = text
    // Tagged recordings travel as exact paths, so the agent acts on the file that was
    // pointed at rather than one it guessed from a description.
    if (tags.length) {
      prompt += '\n\nRecordings the user tagged:\n' +
        tags.map(t => `- ${t.name}: ${t.path}`).join('\n')
    }
    if (ctx && !tags.some(t => t.path === ctx)) {
      prompt += `\n\n(The recording currently open in Fetch is ${ctx})`
    }
    // the chips were for this message; the conversation remembers them from here
    const sentTags = tags.slice()
    tags = []; paintTags()
    if (sentTags.length) {
      const last = list.lastElementChild
      if (last) last.insertAdjacentHTML('beforeend',
        '<div class="chat-me-tags">' + sentTags.map(t => '<span>@' + esc(t.name) + '</span>').join('') + '</div>')
    }

    const pick = state.pick && state.pick.engine === state.engine ? state.pick : {}
    ipcRenderer.send('chat-send', { engine: state.engine, model: pick.model, effort: pick.effort, prompt,
      attachments: sentAtt.map(a => a.path) })
  }

  // One row per tool call, filled in when its result arrives. The row appears the
  // moment the call starts, so a long transcribe shows what is happening rather than
  // leaving the pane silent.
  function toolRow(ev) {
    const n = add(
      `<span class="chat-tool-ico">${ico('circle-fill', 'icon-sm')}</span>` +
      `<span class="chat-tool-name">${esc(String(ev.name || '').replace(/^mcp__fetch__/, ''))}</span>` +
      `<span class="chat-tool-sum"></span>` +
      `<span class="chat-tool-ms mono"></span>`, 'chat-tool')
    n.dataset.state = 'running'
    n.dataset.tool = String(ev.name || '').replace(/^mcp__fetch__/, '')
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
    // Anything arriving means a conversation is under way, so the introduction goes,
    // whoever started the turn. Removing it only on submit left it sitting above a
    // reply that arrived from a turn begun elsewhere.
    const intro = list.querySelector('.chat-intro')
    if (intro) intro.remove()
    if (ev.kind === 'text') add(md(ev.text), 'chat-msg chat-them')
    else if (ev.kind === 'tool') { toolRow(ev); setFace(faceForTool(ev.name)) }
    else if (ev.kind === 'result') {
      const row = state.tools.get(ev.id)
      const name = row && row.dataset.tool
      toolDone(ev)
      if (!ev.ok) setFace('fail')
      else {
        if (/^(export|remove_dead_air|enhance_audio|record_stop)$/.test(name || '')) turn.made = true
        setFace('think')
      }
    }
    else if (ev.kind === 'done') {
      if (!ev.ok) setFace('fail')
      else setFace(turn.made ? 'made' : 'answer', turn.made ? 3200 : 1800)
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
    try { state.models = await ipcRenderer.invoke('chat-models', state.engines.map(e => e.id)) || [] } catch { state.models = [] }
    state.pick = window.modelPicker
      ? modelPicker.resolve(state.models, state.pick || (window.prefs && window.prefs.chatModel))
      : null
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
    document.addEventListener('keydown', e => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') { e.preventDefault(); toggle() }
      if (e.key === 'Escape' && state.open && document.activeElement === input) toggle(false)
    })
    window.toggleChat = toggle
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init)
  else init()
})()
