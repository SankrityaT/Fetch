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

  function renderSettings() {
    const mount = $('settingsMount')
    if (!mount) return
    const p = window.prefs || {}

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

    wireUpdater()

    $('countdownSeg').addEventListener('click', e => {
      const b = e.target.closest('button[data-val]')
      if (!b) return
      const val = +b.dataset.val
      $('countdownSeg').querySelectorAll('button').forEach(x => x.setAttribute('aria-selected', String(x === b)))
      window.savePrefs({ countdown: val })
    })

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
  $('gearBtn').onclick = () => show('settings')
})()
