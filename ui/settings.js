/* Fetch settings view. Builds the view into #settingsMount and wires it to
   window.prefs (ui/prefs.js). Loads after ui/app.js, so it reuses that
   script's globals ($, ico, toast, ipcRenderer) rather than re-declaring
   them, which would collide across script tags and crash the page.

   Wrapped in an IIFE anyway so nothing here leaks into the shared scope
   that setup.js and editor.js also read from. */
;(function () {
  function fmtSaveDir(dir) {
    if (!dir) return 'Desktop'
    const home = require('os').homedir()
    return dir.startsWith(home) ? '~' + dir.slice(home.length) : dir
  }

  function row(id, iconName, title, sub, checkboxId, on) {
    return `
      <div class="set-row" id="${id}" data-on="${!!on}">
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

    let title = 'Fetch is up to date.'
    if (s.status === 'checking') title = 'Checking for updates...'
    else if (s.status === 'downloading') title = `Downloading update, ${s.pct || 0}%`
    else if (s.status === 'ready') title = 'Ready to install.'
    else if (s.status === 'error') title = s.message || 'Update failed.'
    titleEl.textContent = title

    let sub = `Version ${s.currentVersion || ''}`
    if (s.availableVersion) sub += `, ${s.availableVersion} available`
    if (s.waitingForIdle) sub = 'Waiting for you to finish before restarting.'
    subEl.textContent = sub

    checkBtn.disabled = s.status === 'checking' || s.status === 'downloading'
    restartBtn.hidden = s.status !== 'ready'
    restartBtn.disabled = !!s.waitingForIdle
    restartBtn.textContent = s.waitingForIdle ? 'Waiting to restart...' : 'Restart and update'
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

  function renderSettings() {
    const mount = $('settingsMount')
    if (!mount) return
    const p = window.prefs || {}
    const mode = ACCESS_MODES.includes(p.recordAccess) ? p.recordAccess : 'ask'
    const never = Array.isArray(p.neverRecord) ? p.neverRecord : DEFAULT_NEVER

    mount.innerHTML = `
      <div class="set-wrap">
        <div class="set-head">
          <h2>Settings</h2>
          <p class="dim">Fetch remembers these, so you do not have to set up every recording from scratch.</p>
        </div>

        <div class="card" id="setSaveCard">
          <div class="card-head"><h3>Save location</h3></div>
          <div class="set-row">
            <div class="opt-ico">${ico('folder-open', 'icon-sm')}</div>
            <div class="opt-txt">
              <span class="opt-title">Save folder</span>
              <span class="opt-sub set-path" id="saveDirPath">${fmtSaveDir(p.saveDir)}</span>
            </div>
            <div class="set-actions">
              <button class="btn btn-sm" id="chooseDirBtn">Choose...</button>
              <button class="btn btn-sm btn-ghost" id="revealDirBtn">Reveal</button>
            </div>
          </div>
        </div>

        <div class="card set-quick">
          ${row('quickRow', 'sparkle', 'Skip setup and record immediately',
            'The hero button starts recording right away, using the defaults below.',
            'quickRecordToggle', p.quickRecord)}
        </div>

        <div class="card">
          <div class="card-head"><h3>Recording defaults</h3></div>
          ${row('rowCam', 'video-camera', 'Camera', 'Show the camera bubble by default', 'defCam', p.camera)}
          ${row('rowMic', 'microphone', 'Microphone', 'Record your voice by default', 'defMic', p.mic)}
          ${row('rowSys', 'speaker-high', 'System audio', 'Capture computer sound by default', 'defSys', p.systemAudio)}
          <div class="set-row">
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
        </div>

        <div class="card">
          <div class="card-head"><h3>Updates</h3></div>
          ${row('rowAutoUpdate', 'arrow-clockwise', 'Install updates automatically',
            'Fetch checks in the background and gets updates ready before you ask.',
            'updateAutoToggle', p.autoUpdate)}
          <div class="set-row" id="updateStatusRow">
            <div class="opt-ico" id="updateStatusIco">${ico('check-circle', 'icon-sm')}</div>
            <div class="opt-txt">
              <span class="opt-title" id="updateStatusTitle">Fetch is up to date.</span>
              <span class="opt-sub" id="updateStatusSub">Checking version...</span>
            </div>
            <div class="set-actions">
              <button class="btn btn-sm" id="checkUpdateBtn">Check now</button>
              <button class="btn btn-sm btn-primary" id="restartUpdateBtn" hidden>Restart and update</button>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h3>Permissions</h3></div>
          <div class="set-row">
            <div class="opt-ico">${ico('monitor', 'icon-sm')}</div>
            <div class="opt-txt">
              <span class="opt-title">Screen, camera and microphone</span>
              <span class="opt-sub">Run the first-run setup again, or open the macOS privacy settings.</span>
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
            <input type="text" id="neverInput" placeholder="App name, e.g. Notes" autocomplete="off" spellcheck="false">
            <button class="btn btn-sm" type="submit" id="neverAddBtn" disabled>Add</button>
          </form>

          <p class="acc-seen">${ico('eye', 'icon-sm')}<span>You always see a take in progress: the red
            border, the floating controls and Biscuit in the menu bar. <kbd>Shift</kbd><kbd>&#8984;</kbd><kbd>R</kbd>
            stops one an agent started, the same as your own.</span></p>
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
    bindToggle('defCam', 'camera', 'rowCam')
    bindToggle('defMic', 'mic', 'rowMic')
    bindToggle('defSys', 'systemAudio', 'rowSys')
    bindToggle('defAutoMp4', 'autoConvertMp4', 'rowMp4')
    bindToggle('defOpenEditor', 'openEditorAfter', 'rowEditor')
    bindToggle('defKeepOriginal', 'keepOriginal', 'rowKeep')
    bindToggle('updateAutoToggle', 'autoUpdate', 'rowAutoUpdate')
    bindToggle('telemetryToggle', 'telemetry', 'rowTelemetry')
    if ($('rerunSetup')) $('rerunSetup').onclick = () => {
      if (typeof window.startOnboarding === 'function') window.startOnboarding()
      else toast('Setup is unavailable in this build', 'bad')
    }
    if ($('openPrivacy')) $('openPrivacy').onclick = () => ipcRenderer.invoke('open-privacy', 'screen')

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
