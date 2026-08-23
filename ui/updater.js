// Fetch auto-update flow. Main-process module, required from main.js.
//
// Prefers electron-updater against GitHub Releases. If electron-updater is
// not installed (or fails to load), falls back to a small manifest checker
// that reads a JSON feed and downloads a DMG by hand. Either way the module
// exposes the same functions to main.js, and main.js exposes the same IPC
// surface to the renderer, so ui/settings.js never has to know which path
// is active.
//
// The one rule that matters: never install, and never restart, while the
// user is mid-work. "Busy" means recording or paused, a processing job
// running, or the editor holding unsaved work (see isBusy below). When an
// update is ready and the user asks to restart while busy, this waits and
// re-checks instead of interrupting. It never restarts on its own.

const path = require('path')
const fs = require('fs')
const os = require('os')
const https = require('https')

let app, shell
try { ({ app, shell } = require('electron')) } catch {}

const GITHUB_OWNER = 'SankrityaT'
const GITHUB_REPO = 'fetch'
const MANIFEST_URL = 'https://raw.githubusercontent.com/SankrityaT/fetch/main/latest.json'
const PERIODIC_CHECK_MS = 4 * 60 * 60 * 1000   // background check cadence when auto-update is on
const IDLE_POLL_MS = 5000

// ---------- semver ----------
// Only the numeric major.minor.patch triple is compared; pre-release tags
// are ignored, which is all the manifest feed or a GitHub tag needs.
function parseSemver(v) {
  const m = String(v == null ? '' : v).trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)/)
  if (!m) return [0, 0, 0]
  return [+m[1], +m[2], +m[3]]
}
function semverCompare(a, b) {
  const pa = parseSemver(a), pb = parseSemver(b)
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1
  }
  return 0
}
function semverGt(a, b) { return semverCompare(a, b) > 0 }

// ---------- busy gating ----------
// Pure function, no electron dependency, so it can be unit-tested directly
// with node against fabricated states.
function isBusy(s) {
  s = s || {}
  if (s.recState === 'recording' || s.recState === 'paused') return true
  if ((s.jobsActive || 0) > 0) return true
  if (s.editorDirty === true) return true
  return false
}

// ---------- module state ----------
const state = {
  recState: 'idle',
  jobsActive: 0,
  autoUpdate: true,
  mechanism: null,          // 'electron-updater' | 'manifest'
  status: 'up-to-date',     // checking | downloading | ready | error | up-to-date
  currentVersion: '0.0.0',
  availableVersion: null,
  pct: 0,
  message: null,
  waitingForIdle: false,
  manifestDownloadPath: null,
}

let getWindowFn = () => null
let onChangeCb = null
let electronUpdaterLib = null
let manualCheckPending = false
let pendingRestartRequested = false
let idlePollTimer = null
let periodicTimer = null

function editorStatePath() {
  return path.join(app.getPath('userData'), 'editor-state.json')
}
function readEditorDirty() {
  try {
    const raw = fs.readFileSync(editorStatePath(), 'utf8')
    const obj = JSON.parse(raw)
    return !!(obj && obj.dirty === true)
  } catch { return false }
}
function currentBusyState() {
  return { recState: state.recState, jobsActive: state.jobsActive, editorDirty: readEditorDirty() }
}
function busy() { return isBusy(currentBusyState()) }

function cleanMessage(err) {
  const msg = String((err && err.message) || err || 'Something went wrong.')
  return msg.split('\n')[0].slice(0, 160)
}

function publicState() {
  return {
    status: state.status,
    currentVersion: state.currentVersion,
    availableVersion: state.availableVersion,
    pct: state.pct,
    message: state.message,
    waitingForIdle: !!state.waitingForIdle,
    autoUpdate: !!state.autoUpdate,
  }
}
function getState() { return publicState() }

function pushToRenderer() {
  const w = getWindowFn && getWindowFn()
  if (w && !w.isDestroyed()) { try { w.webContents.send('updater-state', publicState()) } catch {} }
}

// A "Check now" click should never look stuck. electron-updater quietly
// no-ops in an unpacked dev build (and a dropped connection can leave a real
// build waiting on an event that never comes), so anything that stays in
// 'checking' too long is treated as a failed check rather than a frozen one.
let checkWatchdog = null
function armCheckWatchdog() {
  clearTimeout(checkWatchdog)
  checkWatchdog = setTimeout(() => {
    if (state.status === 'checking') {
      manualCheckPending = false
      setState({ status: 'error', message: 'Could not check for updates.' })
    }
  }, 15000)
}
function disarmCheckWatchdog() { clearTimeout(checkWatchdog); checkWatchdog = null }

function setState(patch) {
  Object.assign(state, patch)
  if (patch.status && patch.status !== 'checking') disarmCheckWatchdog()
  pushToRenderer()
  if (typeof onChangeCb === 'function') { try { onChangeCb() } catch {} }
}

function maybeInstallIfWaiting() {
  if (pendingRestartRequested && !busy()) doInstall()
}

// ---------- electron-updater path ----------
function trySetupElectronUpdater() {
  let mod
  try { mod = require('electron-updater') } catch { return null }
  const au = mod.autoUpdater
  try {
    au.autoDownload = !!state.autoUpdate
    au.autoInstallOnAppQuit = false   // we control install timing ourselves
    au.setFeedURL({ provider: 'github', owner: GITHUB_OWNER, repo: GITHUB_REPO })
  } catch {}

  au.on('checking-for-update', () => setState({ status: 'checking', message: null }))
  au.on('update-available', info => {
    setState({ availableVersion: (info && info.version) || null })
    // autoDownload already handles this when the pref is on. A manual "Check
    // now" click should still fetch it even if the pref is off, since that
    // is an explicit ask, just not an automatic one.
    if (!au.autoDownload && manualCheckPending) {
      setState({ status: 'downloading', pct: 0 })
      au.downloadUpdate().catch(err => setState({ status: 'error', message: cleanMessage(err) }))
    }
    manualCheckPending = false
  })
  au.on('update-not-available', () => {
    manualCheckPending = false
    setState({ status: 'up-to-date', availableVersion: null })
  })
  au.on('download-progress', p => setState({ status: 'downloading', pct: Math.round((p && p.percent) || 0) }))
  au.on('update-downloaded', () => { setState({ status: 'ready', pct: 100 }); maybeInstallIfWaiting() })
  au.on('error', err => { manualCheckPending = false; setState({ status: 'error', message: cleanMessage(err) }) })

  return au
}

// ---------- manifest fallback path ----------
// Follows a handful of redirects, since both the raw manifest and a GitHub
// release asset URL can redirect before serving the real content.
function httpGetFollow(url, onResponse, onError, redirectsLeft = 5) {
  https.get(url, res => {
    const loc = res.headers.location
    if (loc && res.statusCode >= 300 && res.statusCode < 400 && redirectsLeft > 0) {
      res.resume()
      return httpGetFollow(loc, onResponse, onError, redirectsLeft - 1)
    }
    onResponse(res)
  }).on('error', onError)
}

function manifestCheck(manual) {
  return new Promise(resolve => {
    httpGetFollow(MANIFEST_URL, res => {
      if (res.statusCode !== 200) {
        setState({ status: 'error', message: 'Could not reach the update feed.' })
        manualCheckPending = false
        return resolve()
      }
      let body = ''
      res.on('data', c => { body += c })
      res.on('end', () => {
        manualCheckPending = false
        try {
          const data = JSON.parse(body)
          if (data && data.version && semverGt(data.version, state.currentVersion)) {
            setState({ availableVersion: data.version })
            if (manual) {
              downloadManifestDmg(data.url).then(resolve).catch(err => {
                setState({ status: 'error', message: cleanMessage(err) })
                resolve()
              })
            } else {
              // background check found something but auto-download is not on:
              // leave it visible without pulling the file down unasked
              setState({ status: 'up-to-date' })
              resolve()
            }
          } else {
            setState({ status: 'up-to-date', availableVersion: null })
            resolve()
          }
        } catch {
          setState({ status: 'error', message: 'The update feed did not parse.' })
          resolve()
        }
      })
    }, err => {
      manualCheckPending = false
      setState({ status: 'error', message: cleanMessage(err) })
      resolve()
    })
  })
}

function downloadManifestDmg(url) {
  return new Promise((resolve, reject) => {
    setState({ status: 'downloading', pct: 0 })
    const dest = path.join(os.tmpdir(), 'Fetch-update.dmg')
    const file = fs.createWriteStream(dest)
    httpGetFollow(url, res => {
      if (res.statusCode !== 200) { reject(new Error('Download failed with status ' + res.statusCode)); return }
      const total = +(res.headers['content-length'] || 0)
      let received = 0
      res.on('data', chunk => {
        received += chunk.length
        if (total) setState({ pct: Math.round((received / total) * 100) })
      })
      res.pipe(file)
      file.on('finish', () => file.close(() => {
        state.manifestDownloadPath = dest
        setState({ status: 'ready', pct: 100 })
        resolve()
      }))
      file.on('error', reject)
    }, reject)
  })
}

// ---------- shared entry points ----------
function checkNow(manual) {
  manualCheckPending = !!manual
  setState({ status: 'checking', message: null })
  armCheckWatchdog()
  if (state.mechanism === 'electron-updater' && electronUpdaterLib) {
    return electronUpdaterLib.checkForUpdates().catch(err => {
      manualCheckPending = false
      setState({ status: 'error', message: cleanMessage(err) })
    })
  }
  return manifestCheck(!!manual)
}

function doInstall() {
  pendingRestartRequested = false
  clearInterval(idlePollTimer); idlePollTimer = null
  setState({ waitingForIdle: false })
  if (state.mechanism === 'electron-updater' && electronUpdaterLib) {
    electronUpdaterLib.quitAndInstall(false, true)
  } else if (state.manifestDownloadPath) {
    shell.openPath(state.manifestDownloadPath)
  }
}

function requestRestart() {
  if (state.status !== 'ready') return { ok: false, reason: 'not-ready' }
  if (!busy()) { doInstall(); return { ok: true } }
  pendingRestartRequested = true
  setState({ waitingForIdle: true })
  clearInterval(idlePollTimer)
  idlePollTimer = setInterval(() => {
    if (!pendingRestartRequested) { clearInterval(idlePollTimer); idlePollTimer = null; return }
    if (!busy()) { clearInterval(idlePollTimer); idlePollTimer = null; doInstall() }
  }, IDLE_POLL_MS)
  return { ok: false, busy: true }
}

function setRecState(s) { state.recState = s; maybeInstallIfWaiting() }
function setJobsActive(n) { state.jobsActive = Math.max(0, n || 0); maybeInstallIfWaiting() }
function setAutoUpdate(v) {
  state.autoUpdate = !!v
  if (electronUpdaterLib) { try { electronUpdaterLib.autoDownload = !!v } catch {} }
}

function schedulePeriodicCheck() {
  clearInterval(periodicTimer)
  periodicTimer = setInterval(() => {
    if (state.autoUpdate && state.status !== 'downloading' && state.status !== 'ready') checkNow(false)
  }, PERIODIC_CHECK_MS)
}

function init(opts = {}) {
  getWindowFn = opts.getWindow || (() => null)
  onChangeCb = opts.onChange || null
  state.currentVersion = app.getVersion()
  state.autoUpdate = opts.autoUpdate !== undefined ? !!opts.autoUpdate : true
  electronUpdaterLib = trySetupElectronUpdater()
  state.mechanism = electronUpdaterLib ? 'electron-updater' : 'manifest'
  schedulePeriodicCheck()
}

module.exports = {
  init,
  checkNow,
  requestRestart,
  getState,
  setAutoUpdate,
  setRecState,
  setJobsActive,
  isBusy,
  semverCompare,
}
