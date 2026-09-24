/* Fetch settings view. Builds the view into #settingsMount and wires it to
   window.prefs (ui/prefs.js). Loads after ui/app.js, so it reuses that
   script's globals ($, ico, toast, ipcRenderer) rather than re-declaring
   them, which would collide across script tags and crash the page.

   Wrapped in an IIFE anyway so nothing here leaks into the shared scope
   that setup.js and editor.js also read from. */
;(function () {
  // The one formatter (ui/fmt.js): a plain script here, so window.Fmt once control.html
  // loads it, and required otherwise
  const Fmt = window.Fmt || require('./ui/fmt')

  function fmtSaveDir(dir) {
    if (!dir) return '~/Movies/Fetch'
    const home = require('os').homedir()
    return dir.startsWith(home) ? '~' + dir.slice(home.length) : dir
  }

  // "Only the recorded app's sound" is a permission, not a pref: it is on exactly when
  // macOS has given Fetch System Audio Recording, which is read without asking. Turning it
  // on is the one thing in Fetch that asks. It cannot be taken back from here, since macOS
  // keeps that in System Settings, so off opens that pane instead.
  const APP_SOUND_SAID = {
    granted: 'On. A window or simulator take hears only its own app or device. macOS keeps this in System Settings.',
    denied: 'macOS was told no. Allow Fetch under System Audio Recording Only in System Settings.',
    unknown: 'A window or simulator take hears its own app or device, never a notification or music. ' +
      'Needs System Audio Recording, which macOS asks for once.',
    unavailable: 'Needs Fetch\'s own recorder, which this build does not have.',
  }
  function paintAppSound(state) {
    const input = $('onlyAppSound'), r = $('rowOnlyApp')
    if (!input || !r) return
    const on = state === 'granted'
    input.checked = on
    r.dataset.on = String(on)
    input.disabled = state === 'unavailable'
    const sub = r.querySelector('.opt-sub')
    if (sub) sub.textContent = APP_SOUND_SAID[state] || APP_SOUND_SAID.unknown
  }
  function wireAppSound() {
    const input = $('onlyAppSound')
    if (!input) return
    ipcRenderer.invoke('audio-access').then(a => paintAppSound(a && a.state)).catch(() => {})
    input.onchange = async () => {
      const want = input.checked
      input.checked = !want            // shown as it is until macOS answers
      const now = await ipcRenderer.invoke('audio-access').catch(() => null)
      const state = now && now.state
      if (!want || state === 'denied') {
        // nothing here can take it back or ask again: that is System Settings' to do
        paintAppSound(state)
        ipcRenderer.invoke('open-privacy', 'audio')
        return
      }
      const got = await ipcRenderer.invoke('audio-access-request').catch(() => null)
      paintAppSound(got && got.state)
      if (got && got.state === 'granted') toast('Takes of a window or a simulator now hear only that app or device')
    }
  }

  // ── product guidelines ────────────────────────────────────────────────
  // The person's side of ui/guidelines.js, through main.js 'guidelines'. Every rule shows
  // its id, which is the handle an agent names it by.
  const GUIDE_SECTIONS = [['name', 'Name'], ['audience', 'Audience'], ['never', 'Never on screen'], ['look', 'Look'], ['words', 'Words']]
  const GUIDE_FROM = { screen: 'read off its screens', help: 'read off its help pages', code: 'read off its code', agent: 'from the agent' }
  let guideProduct = ''
  function guideHtml(g) {
    const e = t => String(t == null ? '' : t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
    const rules = GUIDE_SECTIONS.flatMap(([k, head]) => ((g.rules && g.rules[k]) || []).map(r =>
      `<div class="guide-row"><span class="guide-id">${e(r.id)}</span><span class="guide-sec">${head}</span>` +
      `<span class="guide-text">${e(r.text)}</span>` +
      `<button class="btn btn-sm btn-ghost guide-x" data-forget="${e(r.id)}" aria-label="Remove ${e(r.id)}">Remove</button></div>`))
    const drafts = (g.drafts || []).map(d =>
      `<div class="guide-row guide-draft"><span class="guide-id">${e(d.id)}</span>` +
      `<span class="guide-sec">${e((GUIDE_SECTIONS.find(([k]) => k === d.section) || [0, d.section])[1])}</span>` +
      `<span class="guide-text">${e(d.text)}<span class="guide-src">${e(GUIDE_FROM[d.from] || 'from the agent')}` +
      `${d.evidence ? ', ' + e(d.evidence) : ''}${d.replacing ? `. Would replace ${e(d.replaces)}: ${e(d.replacing)}` : ''}</span></span>` +
      `<span class="guide-acts"><button class="btn btn-sm" data-yes="${e(d.id)}">Yes</button>` +
      `<button class="btn btn-sm btn-ghost" data-no="${e(d.id)}">No</button></span></div>`)
    const gaps = (g.gaps || []).map(x => e(x.ask)).join(' ')
    return (drafts.length ? `<div class="acc-sub"><span class="acc-sub-title">Drafted by an agent, waiting for you</span>` +
        `<p class="acc-sub-note">None of these is used until you say yes.</p></div><div class="guide-list">${drafts.join('')}</div>` : '') +
      `<div class="acc-sub"><span class="acc-sub-title">Rules for ${e(g.product)}</span>` +
      (gaps ? `<p class="acc-sub-note">Still to answer: ${gaps}</p>` : '') + '</div>' +
      (rules.length ? `<div class="guide-list">${rules.join('')}</div>` : '<p class="acc-sub-note guide-none">No rules yet.</p>') +
      `<form class="acc-add" id="guideAdd"><select class="select input-sm" id="guideSection">` +
      GUIDE_SECTIONS.map(([k, head]) => `<option value="${k}">${head}</option>`).join('') + '</select>' +
      '<input class="input input-sm" type="text" id="guideRule" placeholder="One rule, in your words" autocomplete="off">' +
      '<button class="btn btn-sm" type="submit" id="guideAddBtn" disabled>Add</button></form>'
  }
  async function paintGuide() {
    const body = $('guideBody')
    if (!body) return
    const list = await ipcRenderer.invoke('guidelines', { action: 'products' }).catch(() => null)
    const dl = $('guideProducts')
    if (dl) dl.innerHTML = ((list && list.products) || []).map(p => `<option value="${String(p).replace(/"/g, '&quot;')}">`).join('')
    if (!guideProduct) { body.innerHTML = ''; return }
    const g = await ipcRenderer.invoke('guidelines', { action: 'read', product: guideProduct }).catch(e => ({ ok: false, refused: { why: e.message } }))
    body.innerHTML = g && g.ok ? guideHtml(g) : `<p class="acc-sub-note">${(g && g.refused && g.refused.why) || 'Those rules could not be read.'}</p>`
    const input = $('guideRule'), add = $('guideAddBtn')
    if (input && add) input.oninput = () => { add.disabled = !input.value.trim() }
  }
  function wireGuidelines() {
    const form = $('guideProductForm'), body = $('guideBody')
    if (!form || !body) return
    form.onsubmit = e => { e.preventDefault(); guideProduct = $('guideProduct').value.trim(); paintGuide() }
    body.addEventListener('submit', async e => {
      if (e.target.id !== 'guideAdd') return
      e.preventDefault()
      const rule = $('guideRule').value.trim()
      if (!rule) return
      const r = await ipcRenderer.invoke('guidelines', { action: 'write', product: guideProduct, section: $('guideSection').value, rule })
      const w = r && r.written && r.written[0]
      if (w && !w.ok) toast(`Not added: ${(w.refused && w.refused.why) || 'that rule was refused'}`, 'bad')
      paintGuide()
    })
    body.addEventListener('click', async e => {
      const b = e.target.closest('[data-yes],[data-no],[data-forget]')
      if (!b) return
      const [action, id] = b.dataset.yes ? ['yes', b.dataset.yes] : b.dataset.no ? ['no', b.dataset.no] : ['forget', b.dataset.forget]
      const r = await ipcRenderer.invoke('guidelines', { action, id, product: guideProduct }).catch(() => null)
      if (action === 'yes' && !(r && r.ok)) toast(`${id} was not put in force: ${(r && r.refused && r.refused.why) || 'it could not be read'}`, 'bad')
      paintGuide()
    })
    paintGuide()
  }

  // ── photos: the Unsplash key ──────────────────────────────────────────
  // The person's own access key, kept in the macOS Keychain by the main process the way
  // the voiceover key is (unsplash-status, unsplash-connect, unsplash-disconnect). It
  // is typed here and handed straight over: the field is a password field and is
  // cleared the moment the key is taken, so no copy stays in the page. The Look tab's
  // picker (ui/unsplash-picker.js) hears about a change through 'unsplash-key'.
  const KEY_PAGE = 'https://unsplash.com/developers'
  function photosHtml(st) {
    const on = !!(st && st.connected)
    const sub = st == null ? `Checking${Fmt.ELL}`
      : on ? 'Connected. Search from the Look tab, under Background, Image'
      : 'Not connected. Make a free app on Unsplash for developers and paste its access key here'
    return `
      <div class="opt set-row" id="rowPhotos" data-on="${on}">
        <div class="opt-ico">${ico(on ? 'check-circle' : 'image', 'icon-sm')}</div>
        <div class="opt-txt">
          <span class="opt-title">Unsplash</span>
          <span class="opt-sub">${sub}</span>
        </div>
        <div class="set-actions">
          ${on ? '<button class="btn btn-sm btn-ghost" id="phDisconnect" type="button">Disconnect</button>'
            : '<button class="btn btn-sm btn-ghost" id="phKeyPage" type="button">Get a key</button>'}
        </div>
      </div>
      ${on || st == null ? '' : `
      <form class="acc-add" id="phKeyForm">
        <input class="input input-sm" type="password" id="phKey" placeholder="Access key" autocomplete="off" spellcheck="false" aria-label="Unsplash access key">
        <button class="btn btn-sm" type="submit" id="phConnect" disabled>Connect</button>
      </form>`}`
  }
  // what a rejected IPC call says, without Electron's wrapping
  const ipcWhy = err => { const raw = String((err && err.message) || err || ''); return raw.split(/Error:\s*/).pop().trim() || raw }
  function wirePhotos() {
    const body = $('photosBody')
    if (!body) return
    const paint = async () => {
      const st = await ipcRenderer.invoke('unsplash-status').catch(() => ({ connected: false }))
      body.innerHTML = photosHtml(st || { connected: false })
      const key = $('phKey'), go = $('phConnect')
      if (key && go) key.oninput = () => { go.disabled = !key.value.trim() }
    }
    const changed = () => window.dispatchEvent(new CustomEvent('unsplash-key'))
    body.addEventListener('submit', async e => {
      if (e.target.id !== 'phKeyForm') return
      e.preventDefault()
      const key = $('phKey'), go = $('phConnect')
      const k = key.value.trim()
      if (!k) return
      go.disabled = true; go.textContent = `Checking${Fmt.ELL}`
      try {
        const r = await ipcRenderer.invoke('unsplash-connect', k)
        if (r && r.ok === false) throw new Error(r.message || r.why || 'Unsplash did not accept that key')
        key.value = ''
        toast('Unsplash connected', 'ok')
        changed()
        paint()
      } catch (err) {
        toast(ipcWhy(err), 'bad', 7000)
        go.textContent = 'Connect'
        go.disabled = !key.value.trim()
      }
    })
    body.addEventListener('click', async e => {
      const b = e.target.closest('button')
      if (!b) return
      if (b.id === 'phKeyPage') { try { require('electron').shell.openExternal(KEY_PAGE) } catch {} }
      else if (b.id === 'phDisconnect') {
        await ipcRenderer.invoke('unsplash-disconnect').catch(() => {})
        toast('Unsplash disconnected. Your key is gone from the Keychain', 'ok')
        changed()
        paint()
      }
    })
    paint()
  }

  function row(id, iconName, title, sub, checkboxId, on) {
    return `
      <div class="opt set-row" id="${id}" data-on="${!!on}">
        <div class="opt-ico">${ico(iconName, 'icon-sm')}</div>
        <div class="opt-txt">
          <span class="opt-title">${title}</span>
          <span class="opt-sub">${sub}</span>
        </div>
        <label class="switch"><input type="checkbox" id="${checkboxId}" ${on ? 'checked' : ''}><span class="track"></span></label>
      </div>`
  }

  // ── auto update ──────────────────────────────────────────────────────
  // Talks to ui/updater.js (main process) through the three IPC entry points
  // main.js exposes: updater-check, updater-restart, updater-get-state, plus
  // a live push on 'updater-state' whenever anything changes.
  let lastUpdateState = null

  function applyUpdateState(s) {
    if (!s) return
    lastUpdateState = s
    const row = $('updateStatusRow')
    const icoEl = $('updateStatusIco')
    const titleEl = $('updateStatusTitle')
    const subEl = $('updateStatusSub')
    const checkBtn = $('checkUpdateBtn')
    const restartBtn = $('restartUpdateBtn')
    if (!row || !icoEl || !titleEl || !subEl || !checkBtn || !restartBtn) return

    const positive = s.status === 'up-to-date' || s.status === 'ready'
    row.dataset.on = String(positive)

    const iconName = s.status === 'downloading' ? 'download-simple'
      : s.status === 'checking' ? 'spinner-gap'
      : s.status === 'error' ? 'warning-circle'
      : s.status === 'ready' ? 'check-circle-fill'
      : 'check-circle'
    icoEl.innerHTML = ico(iconName, 'icon-sm')

    let title = 'Fetch is up to date'
    if (s.status === 'checking') title = `Checking for updates${Fmt.ELL}`
    else if (s.status === 'downloading') title = `Downloading update, ${Fmt.value(s.pct || 0, { unit: '%', scale: 1 })}`
    else if (s.status === 'ready') title = 'Ready to install'
    else if (s.status === 'error') title = s.message || 'Update failed'
    titleEl.textContent = title

    let sub = `Version ${s.currentVersion || ''}`
    if (s.availableVersion) sub += `, ${s.availableVersion} available`
    if (s.waitingForIdle) sub = 'Waiting for you to finish before restarting'
    subEl.textContent = sub

    checkBtn.disabled = s.status === 'checking' || s.status === 'downloading'
    restartBtn.hidden = s.status !== 'ready'
    restartBtn.disabled = !!s.waitingForIdle
    restartBtn.textContent = s.waitingForIdle ? `Waiting to restart${Fmt.ELL}` : 'Restart and update'
  }

  function wireUpdater() {
    $('checkUpdateBtn').onclick = async () => {
      applyUpdateState(Object.assign({}, lastUpdateState, { status: 'checking' }))
      try { await ipcRenderer.invoke('updater-check') } catch {}
    }
    $('restartUpdateBtn').onclick = async () => {
      let res
      try { res = await ipcRenderer.invoke('updater-restart') } catch { res = null }
      if (res && res.busy) toast('Fetch will restart once you are done working.', '')
    }
    ipcRenderer.on('updater-state', (e, s) => applyUpdateState(s))
    ipcRenderer.invoke('updater-get-state').then(applyUpdateState).catch(() => {})
  }

  // Kept in step with ui/record-policy.js, which is where these are enforced. The
  // renderer cannot require that module (it also loads in main), so the labels live
  // here and the rules live there.
  const ACCESS_MODES = ['ask', 'allowed', 'open']
  const DEFAULT_NEVER = [
    '1Password', 'Bitwarden', 'Dashlane', 'LastPass', 'Proton Pass', 'Keychain Access',
    'Messages', 'WhatsApp', 'Signal', 'Telegram',
    'Mail', 'System Settings', 'System Preferences',
  ]

  // One sentence per mode, swapped as you choose. Three bare labels would leave you
  // guessing what "Allowed apps only" does to a full-screen take, which is the one
  // thing about it worth knowing.
  const ACCESS_NOTES = {
    ask: 'Every recording an agent asks for waits for you. Nothing starts on its own.',
    allowed: 'Agents may record only the apps you list, and never a whole display.',
    open: 'Agents may record any window or display, apart from the apps below.',
  }

  const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]))

  // No per-chip state icon: every chip here is the same state, so a glyph on each one
  // is noise. The section heading carries the meaning.
  function neverChipsHtml(list) {
    if (!list.length) {
      return '<p class="acc-empty">Nothing is protected. Any app on screen can end up in a take.</p>'
    }
    return list.map(name =>
      '<span class="chip chip-static acc-chip">' + esc(name) +
        '<button class="acc-chip-x" data-remove="' + esc(name) + '" ' +
          'aria-label="Stop protecting ' + esc(name) + '">' + ico('x', 'icon-sm') + '</button>' +
      '</span>').join('')
  }

  // The device list, written the way the app list above is. Two differences, both
  // forced by what a simulator is: every simulator on the Mac answers to one app name,
  // so the lever is the UDID rather than a name, and nobody knows their own UDIDs, so
  // the devices Fetch can see are offered and the field is there for the rest.
  function deviceChipsHtml(list) {
    if (!list.length) {
      return '<p class="acc-empty">No device is held back. An agent can record and drive any simulator on this Mac.</p>'
    }
    return list.map(d => {
      const udid = typeof d === 'string' ? d : (d && d.udid) || ''
      const name = typeof d === 'string' ? '' : (d && d.name) || ''
      const label = name || udid
      return '<span class="chip chip-static acc-chip" title="' + esc(udid) + '">' + esc(label) +
        (name && udid ? '<span class="acc-chip-sub">' + esc(udid.slice(0, 8)) + '</span>' : '') +
        '<button class="acc-chip-x" data-remove-device="' + esc(udid || label) + '" ' +
          'aria-label="Stop protecting ' + esc(label) + '">' + ico('x', 'icon-sm') + '</button>' +
      '</span>'
    }).join('')
  }

  // What you said "Always allow" to. A standing permission nobody can find is a
  // standing permission nobody can take back, so every grant is listed here with the
  // words that were on the button and the day it was given, and one click ends it.
  // Only this list and that button ever write them: an agent asking set_settings for
  // alwaysAllow is refused, because an agent that can grant itself a permission has
  // no permission rule at all.
  const grantDay = at => {
    const d = new Date(at)
    return isNaN(d) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
  }
  function alwaysChipsHtml(list) {
    if (!list.length) {
      return '<p class="acc-empty">Nothing is always allowed. Every agent take and every tap on a ' +
        'device still waits for you.</p>'
    }
    return list.map(g => {
      const label = (g && g.label) || (g && g.key) || ''
      const day = g && g.at ? grantDay(g.at) : ''
      return '<span class="chip chip-static acc-chip" title="' + esc((g && g.key) || '') + '">' + esc(label) +
        (day ? '<span class="acc-chip-sub">' + esc(day) + '</span>' : '') +
        '<button class="acc-chip-x" data-revoke="' + esc((g && g.key) || '') + '" ' +
          'aria-label="Stop always allowing ' + esc(label) + '">' + ico('x', 'icon-sm') + '</button>' +
      '</span>'
    }).join('')
  }

  function renderSettings() {
    const mount = $('settingsMount')
    if (!mount) return
    const p = window.prefs || {}
    const mode = ACCESS_MODES.includes(p.recordAccess) ? p.recordAccess : 'ask'
    const never = Array.isArray(p.neverRecord) ? p.neverRecord : DEFAULT_NEVER
    // Empty rather than seeded, deliberately: no device is dangerous on every Mac, and a
    // made up id would teach somebody that this list knows something it does not.
    const neverDevices = Array.isArray(p.neverRecordDevices) ? p.neverRecordDevices : []
    const always = Array.isArray(p.alwaysAllow) ? p.alwaysAllow.filter(g => g && g.key) : []

    mount.innerHTML = `
      <div class="set-wrap">
        <div class="set-head">
          <h2>Settings</h2>
          <p class="dim">Fetch remembers these, so you do not have to set up every recording from scratch.</p>
        </div>

        <div class="card" id="setSaveCard">
          <div class="card-head"><h3>Save location</h3></div>
          <div class="opt set-row">
            <div class="opt-ico">${ico('folder-open', 'icon-sm')}</div>
            <div class="opt-txt">
              <span class="opt-title">Save folder</span>
              <span class="opt-sub set-path" id="saveDirPath">${fmtSaveDir(p.saveDir)}</span>
            </div>
            <div class="set-actions">
              <button class="btn btn-sm" id="chooseDirBtn">Choose…</button>
              <button class="btn btn-sm btn-ghost" id="revealDirBtn">Reveal</button>
            </div>
          </div>
        </div>

        <div class="card set-quick">
          ${row('quickRow', 'sparkle', 'Skip setup and record immediately',
            'The hero button starts recording right away, using the defaults below',
            'quickRecordToggle', p.quickRecord)}
        </div>

        <div class="card">
          <div class="card-head"><h3>Recording defaults</h3></div>
          ${row('rowCam', 'video-camera', 'Camera', 'Show the camera bubble by default', 'defCam', p.camera)}
          ${row('rowMic', 'microphone', 'Microphone', 'Record your voice by default', 'defMic', p.mic)}
          ${row('rowSys', 'speaker-high', 'System audio', 'Capture computer sound by default', 'defSys', p.systemAudio)}
          ${row('rowOnlyApp', 'app-window', 'Only the recorded app\'s sound',
            'A window or simulator take hears its own app or device, never a notification or music. ' +
            'Needs System Audio Recording, which macOS asks for once.', 'onlyAppSound', false)}
          <div class="opt set-row">
            <div class="opt-ico">${ico('clock', 'icon-sm')}</div>
            <div class="opt-txt"><span class="opt-title">Countdown</span><span class="opt-sub">Time before recording starts</span></div>
            <div class="seg" id="countdownSeg" role="tablist">
              <button data-val="0" role="tab" aria-selected="${p.countdown === 0}">Off</button>
              <button data-val="3" role="tab" aria-selected="${p.countdown === 3}">3s</button>
              <button data-val="5" role="tab" aria-selected="${p.countdown === 5}">5s</button>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h3>After recording</h3></div>
          ${row('rowMp4', 'film-strip', 'Convert to MP4', 'Automatically convert the recording when it finishes', 'defAutoMp4', p.autoConvertMp4)}
          ${row('rowEditor', 'scissors', 'Open in editor', 'Jump straight into editing when a recording finishes', 'defOpenEditor', p.openEditorAfter)}
          ${row('rowKeep', 'check', 'Keep original file', 'Keep the source recording when you export a copy', 'defKeepOriginal', p.keepOriginal)}
          ${row('rowAgentNames', 'pencil-simple', 'Name recordings with your agent',
            'Your connected Claude Code or Codex gets the app, the window title and the first 80 words said, ' +
            'never the video or audio. Names you type are never changed.',
            'defAgentNames', p.agentNames !== false)}
        </div>

        <div class="card">
          <div class="card-head"><h3>Updates</h3></div>
          ${row('rowAutoUpdate', 'arrow-clockwise', 'Install updates automatically',
            'Fetch checks in the background and gets updates ready before you ask',
            'updateAutoToggle', p.autoUpdate)}
          <div class="opt set-row" id="updateStatusRow">
            <div class="opt-ico" id="updateStatusIco">${ico('check-circle', 'icon-sm')}</div>
            <div class="opt-txt">
              <span class="opt-title" id="updateStatusTitle">Fetch is up to date</span>
              <span class="opt-sub" id="updateStatusSub">Checking version…</span>
            </div>
            <div class="set-actions">
              <button class="btn btn-sm" id="checkUpdateBtn">Check now</button>
              <button class="btn btn-sm btn-primary" id="restartUpdateBtn" hidden>Restart and update</button>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h3>Permissions</h3></div>
          <div class="opt set-row">
            <div class="opt-ico">${ico('monitor', 'icon-sm')}</div>
            <div class="opt-txt">
              <span class="opt-title">Screen, camera and microphone</span>
              <span class="opt-sub">Run the first-run setup again, or open the macOS privacy settings</span>
            </div>
            <div class="set-actions">
              <button class="btn btn-sm" id="rerunSetup">Run setup again</button>
              <button class="btn btn-sm" id="openPrivacy">System Settings</button>
            </div>
          </div>
        </div>

        <div class="card" id="setAccessCard">
          <div class="card-head"><h3>Recording access</h3></div>
          <p class="acc-lede">What an agent may record on this Mac, and what it can never see.</p>

          <div class="seg acc-seg" id="accessSeg" role="tablist">
            <button data-val="ask" role="tab" aria-selected="${mode === 'ask'}">Ask every time</button>
            <button data-val="allowed" role="tab" aria-selected="${mode === 'allowed'}">Allowed apps only</button>
            <button data-val="open" role="tab" aria-selected="${mode === 'open'}">Anything on screen</button>
          </div>
          <p class="acc-note" id="accessNote">${ACCESS_NOTES[mode]}</p>

          <div class="acc-sub">
            <span class="acc-sub-title">Never recorded</span>
            <p class="acc-sub-note">These stay out of every take, even when an agent records the
              whole screen. Fetch leaves their windows out of the frame, so nothing sensitive
              reaches the disk in the first place.</p>
          </div>
          <div class="acc-chips" id="neverChips">${neverChipsHtml(never)}</div>
          <form class="acc-add" id="neverAdd">
            <input class="input input-sm" type="text" id="neverInput" placeholder="App name, e.g. Notes" autocomplete="off" spellcheck="false">
            <button class="btn btn-sm" type="submit" id="neverAddBtn" disabled>Add</button>
          </form>

          <div class="acc-sub">
            <span class="acc-sub-title">Never touched</span>
            <p class="acc-sub-note">Simulators an agent may neither record nor drive, whatever you or it
              says afterwards. Every simulator on this Mac is the same application, so a device with your
              real account signed into it can only be named by its own id.</p>
          </div>
          <div class="acc-chips" id="deviceChips">${deviceChipsHtml(neverDevices)}</div>
          <form class="acc-add" id="deviceAdd">
            <select class="select input-sm" id="devicePick"><option value="">Loading your simulators…</option></select>
            <button class="btn btn-sm" type="submit" id="deviceAddBtn" disabled>Add</button>
          </form>

          <div class="acc-sub">
            <span class="acc-sub-title">Always allowed</span>
            <p class="acc-sub-note">What you pressed Always allow to, so Fetch stops asking. Each one
              covers that one thing on that one device or app, and never anything that would erase or
              remove something. Take one back and the next attempt asks you again.</p>
          </div>
          <div class="acc-chips" id="alwaysChips">${alwaysChipsHtml(always)}</div>

          ${row('rowAgentVisible', 'eye', 'Show agent recordings on screen',
            'Off: an agent records in the background and nothing appears over your work. ' +
            'On: the red border and floating controls show, as for your own takes.',
            'agentVisibleToggle', !!p.agentTakesVisible)}
          <p class="acc-seen"><span>Either way the menu bar icon turns red while
            anything records, every take is in Activity, and <kbd>&#8997;&#8679;&#8984;R</kbd>
            stops one an agent started, the same as your own.</span></p>
        </div>

        <div class="card" id="guideCard">
          <div class="card-head"><h3>Product guidelines</h3></div>
          <p class="acc-lede">What an agent reads before it plans, records or styles anything for a product:
            what it is called, who a demo is for, what must never be on screen, how its screenshots look,
            and the words it avoids. What you write here is in force at once. What an agent drafts
            waits here until you say yes.</p>
          <form class="acc-add" id="guideProductForm">
            <input class="input input-sm" type="text" id="guideProduct" list="guideProducts" placeholder="Product name, e.g. Yolk" autocomplete="off" spellcheck="false">
            <datalist id="guideProducts"></datalist>
            <button class="btn btn-sm" type="submit">Open</button>
          </form>
          <div id="guideBody"></div>
        </div>

        <div class="card" id="setPhotosCard">
          <div class="card-head"><h3>Photos</h3></div>
          <p class="acc-lede">Search Unsplash for a backdrop from the Look tab, with your own free access key.
            Only your search words go to Unsplash, and a note when you use a photo, as Unsplash asks.
            Never your recordings, their audio or their names.</p>
          <div id="photosBody">${photosHtml(null)}</div>
        </div>

        <div class="card">
          <div class="card-head"><h3>Privacy</h3></div>
          ${row('rowTelemetry', 'paw-print', 'Count this install',
            'Sends a random id, the app version and your macOS version, once a day. ' +
            'Never your recordings, filenames or transcripts. Turn it off and Fetch says nothing.',
            'telemetryToggle', p.telemetry !== false)}
        </div>
      </div>`

    const bindToggle = (checkboxId, key, rowId) => {
      const input = $(checkboxId)
      if (!input) return
      input.onchange = () => {
        window.savePrefs({ [key]: input.checked })
        const r = $(rowId)
        if (r) r.dataset.on = String(input.checked)
      }
    }
    bindToggle('quickRecordToggle', 'quickRecord', 'quickRow')
    bindToggle('agentVisibleToggle', 'agentTakesVisible', 'rowAgentVisible')
    bindToggle('defCam', 'camera', 'rowCam')
    bindToggle('defMic', 'mic', 'rowMic')
    bindToggle('defSys', 'systemAudio', 'rowSys')
    bindToggle('defAutoMp4', 'autoConvertMp4', 'rowMp4')
    bindToggle('defOpenEditor', 'openEditorAfter', 'rowEditor')
    bindToggle('defKeepOriginal', 'keepOriginal', 'rowKeep')
    bindToggle('defAgentNames', 'agentNames', 'rowAgentNames')
    bindToggle('updateAutoToggle', 'autoUpdate', 'rowAutoUpdate')
    bindToggle('telemetryToggle', 'telemetry', 'rowTelemetry')
    if ($('rerunSetup')) $('rerunSetup').onclick = () => {
      if (typeof window.startOnboarding === 'function') window.startOnboarding()
      else toast('Setup is unavailable in this build', 'bad')
    }
    if ($('openPrivacy')) $('openPrivacy').onclick = () => ipcRenderer.invoke('open-privacy', 'screen')
    wireAppSound()
    wireGuidelines()
    wirePhotos()

    wireUpdater()

    $('countdownSeg').addEventListener('click', e => {
      const b = e.target.closest('button[data-val]')
      if (!b) return
      const val = +b.dataset.val
      $('countdownSeg').querySelectorAll('button').forEach(x => x.setAttribute('aria-selected', String(x === b)))
      window.savePrefs({ countdown: val })
    })

    // --- recording access ---
    const currentNever = () =>
      Array.isArray(window.prefs.neverRecord) ? window.prefs.neverRecord.slice() : DEFAULT_NEVER.slice()

    function paintNever(list) {
      window.savePrefs({ neverRecord: list })
      window.prefs.neverRecord = list
      $('neverChips').innerHTML = neverChipsHtml(list)
    }

    $('accessSeg').addEventListener('click', e => {
      const b = e.target.closest('button[data-val]')
      if (!b) return
      $('accessSeg').querySelectorAll('button').forEach(x => x.setAttribute('aria-selected', String(x === b)))
      $('accessNote').textContent = ACCESS_NOTES[b.dataset.val]
      window.savePrefs({ recordAccess: b.dataset.val })
    })

    $('neverChips').addEventListener('click', e => {
      const btn = e.target.closest('[data-remove]')
      if (!btn) return
      const name = btn.dataset.remove
      paintNever(currentNever().filter(n => n !== name))
      toast(name + ' can be recorded again', 'ok')
    })

    // --- the devices, the same shape as the apps above ---
    const currentDevices = () =>
      Array.isArray(window.prefs.neverRecordDevices) ? window.prefs.neverRecordDevices.slice() : []

    const udidOf = d => String((typeof d === 'string' ? d : (d && d.udid)) || '').toUpperCase()

    function paintDevices(list) {
      window.savePrefs({ neverRecordDevices: list })
      window.prefs.neverRecordDevices = list
      $('deviceChips').innerHTML = deviceChipsHtml(list)
    }

    $('deviceChips').addEventListener('click', e => {
      const btn = e.target.closest('[data-remove-device]')
      if (!btn) return
      const id = btn.dataset.removeDevice
      const list = currentDevices()
      const gone = list.find(d => udidOf(d) === id.toUpperCase() || (typeof d !== 'string' && d && d.name === id))
      paintDevices(list.filter(d => d !== gone))
      toast((gone && gone.name ? gone.name : 'That device') + ' can be recorded again', 'ok')
      fillDevicePicker()
    })

    $('alwaysChips').addEventListener('click', e => {
      const btn = e.target.closest('[data-revoke]')
      if (!btn) return
      const key = btn.dataset.revoke
      const list = (Array.isArray(window.prefs.alwaysAllow) ? window.prefs.alwaysAllow : []).filter(g => g && g.key)
      const gone = list.find(g => g.key === key)
      const left = list.filter(g => g.key !== key)
      window.savePrefs({ alwaysAllow: left })
      window.prefs.alwaysAllow = left
      $('alwaysChips').innerHTML = alwaysChipsHtml(left)
      toast('Fetch will ask again before ' + ((gone && gone.label) || 'that'), 'ok')
    })

    // The devices Fetch can see, so nobody has to copy a UDID out of a terminal to
    // protect their own phone. A Mac with no Xcode gets an empty list and says so; the
    // list is the thing that protects, so it never pretends it is unavailable.
    async function fillDevicePicker() {
      const pick = $('devicePick')
      if (!pick) return
      let devices = []
      try { devices = await ipcRenderer.invoke('sim-devices') } catch { devices = [] }
      const held = new Set(currentDevices().map(udidOf))
      const free = (devices || []).filter(d => d && d.udid && !held.has(String(d.udid).toUpperCase()))
      if (!free.length) {
        pick.innerHTML = '<option value="">' +
          (devices && devices.length ? 'Every simulator here is already held back' : 'No simulators on this Mac') +
          '</option>'
        pick.disabled = true
        $('deviceAddBtn').disabled = true
        return
      }
      pick.disabled = false
      pick.innerHTML = '<option value="">Choose a simulator…</option>' + free.map(d =>
        '<option value="' + esc(d.udid) + '" data-name="' + esc(d.name || '') + '">' +
          esc(d.name || d.udid) + (d.booted ? ' (booted)' : '') + '</option>').join('')
      $('deviceAddBtn').disabled = true
    }
    $('devicePick').onchange = () => { $('deviceAddBtn').disabled = !$('devicePick').value }
    $('deviceAdd').onsubmit = e => {
      e.preventDefault()
      const pick = $('devicePick')
      const udid = pick.value
      if (!udid) return
      const name = pick.selectedOptions[0] ? pick.selectedOptions[0].dataset.name : ''
      const list = currentDevices()
      if (list.some(d => udidOf(d) === udid.toUpperCase())) {
        toast((name || 'That device') + ' is already held back', 'bad')
        return
      }
      paintDevices(list.concat([{ udid, ...(name ? { name } : {}) }]))
      toast((name || 'That device') + ' will never be recorded or driven', 'ok')
      fillDevicePicker()
    }
    fillDevicePicker()

    // Disabled until there is something to add, and a duplicate is refused out loud
    // rather than silently ignored, so pressing Add always does something visible.
    const neverInput = $('neverInput')
    neverInput.oninput = () => { $('neverAddBtn').disabled = !neverInput.value.trim() }
    $('neverAdd').onsubmit = e => {
      e.preventDefault()
      const name = neverInput.value.trim()
      if (!name) return
      const list = currentNever()
      if (list.some(n => n.toLowerCase() === name.toLowerCase())) {
        toast(name + ' is already protected', 'bad')
        return
      }
      paintNever(list.concat(name))
      neverInput.value = ''
      $('neverAddBtn').disabled = true
      toast(name + ' will never be recorded', 'ok')
    }

    $('chooseDirBtn').onclick = async () => {
      const dir = await ipcRenderer.invoke('pick-save-dir')
      if (dir) {
        window.prefs.saveDir = dir
        $('saveDirPath').textContent = fmtSaveDir(dir)
        toast('Save folder updated', 'ok')
      }
    }
    $('revealDirBtn').onclick = () => ipcRenderer.invoke('reveal-save-dir')
  }

  // show(view) in app.js already toggles any element with a matching
  // data-view, so the settings view needs no special-casing there. Build the
  // content once at load, since window.prefs is already settled by the time
  // this script runs (ui/prefs.js loads first and reads it synchronously).
  renderSettings()
  window.addEventListener('prefs-changed', () => renderSettings())
  $('gearBtn').onclick = () => show('settings')
})()
