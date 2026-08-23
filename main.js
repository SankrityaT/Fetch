const { app, BrowserWindow, desktopCapturer, session, ipcMain, dialog, screen, shell,
        globalShortcut, Tray, Menu, nativeImage } = require('electron')
const fs = require('fs')
const path = require('path')
const os = require('os')

// own profile dir. The shared ~/Library/Application Support/Electron profile is
// used by other dev Electron apps and its GPU/capture state can get poisoned
app.setPath('userData', path.join(app.getPath('appData'), 'Fetch'))

let control, cam

const updater = require('./ui/updater')
const telemetry = require('./ui/telemetry')

// ---------- preferences ----------
// Persisted to <userData>/prefs.json. Loaded lazily and cached in memory;
// every write goes straight back to disk so a crash never loses a setting.
const PREFS_PATH = path.join(app.getPath('userData'), 'prefs.json')
const DEFAULT_PREFS = {
  saveDir: null,           // null means "use Desktop", resolved at save time
  camera: true,
  mic: true,
  systemAudio: true,
  countdown: 3,            // 0, 3 or 5 seconds
  autoConvertMp4: false,
  openEditorAfter: false,
  keepOriginal: true,
  quickRecord: false,
  autoUpdate: true,        // let Fetch check and download updates in the background
  telemetry: true,         // anonymous install count: a random id, the version, the OS
}
let prefsCache = null
function loadPrefs() {
  if (prefsCache) return prefsCache
  prefsCache = { ...DEFAULT_PREFS }
  try { Object.assign(prefsCache, JSON.parse(fs.readFileSync(PREFS_PATH, 'utf8'))) } catch {}
  return prefsCache
}
function writePrefs(patch) {
  loadPrefs()
  Object.assign(prefsCache, patch)
  try { fs.mkdirSync(path.dirname(PREFS_PATH), { recursive: true }) } catch {}
  try { fs.writeFileSync(PREFS_PATH, JSON.stringify(prefsCache, null, 2)) } catch {}
  return prefsCache
}
function resolvedSaveDir() {
  const dir = loadPrefs().saveDir
  if (!dir) return app.getPath('desktop')
  try { fs.accessSync(dir, fs.constants.W_OK); return dir } catch { return app.getPath('desktop') }
}

ipcMain.on('prefs-get-sync', e => { e.returnValue = loadPrefs() })
ipcMain.handle('prefs-set', (e, patch) => {
  const next = writePrefs(patch || {})
  if (patch && 'autoUpdate' in patch) updater.setAutoUpdate(next.autoUpdate)
  if (patch && 'telemetry' in patch && !next.telemetry) telemetry.stop()
  return next
})

// ---------- auto update ----------
ipcMain.handle('updater-check', () => updater.checkNow(true))
ipcMain.handle('updater-restart', () => updater.requestRestart())
ipcMain.handle('updater-get-state', () => updater.getState())
ipcMain.handle('pick-save-dir', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: resolvedSaveDir(),
  })
  if (canceled || !filePaths.length) return null
  return writePrefs({ saveDir: filePaths[0] }).saveDir
})
ipcMain.handle('reveal-save-dir', () => shell.openPath(resolvedSaveDir()))

function createWindows() {
  control = new BrowserWindow({
    width: 1240, height: 800,
    minWidth: 1000, minHeight: 640,
    x: 60, y: 40,
    title: 'Fetch',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: '#0B0A09',
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  })
  control.loadFile('control.html')
  if (process.env.FETCH_FRONT === '1') { control.setAlwaysOnTop(true, 'screen-saver'); control.focus() }
  // dev: capture our own window so UI iteration doesn't depend on window focus
  if (process.env.FETCH_PROBE) {
    control.webContents.once('did-finish-load', () => setTimeout(async () => {
      try {
        const r = await control.webContents.executeJavaScript(process.env.FETCH_PROBE)
        console.log('[probe] ' + r)
      } catch (e) { console.log('[probe] ERR ' + e.message) }
      app.quit()
    }, 6500))
  }
  if (process.env.FETCH_EVAL) {           // dev: drive the UI before capturing
    control.webContents.once('did-finish-load', () => setTimeout(() =>
      control.webContents.executeJavaScript(process.env.FETCH_EVAL)
        .catch(e => console.log('[eval] ' + e.message)), 1400))
  }
  if (process.env.FETCH_SHOT) {
    control.webContents.once('did-finish-load', () => setTimeout(async () => {
      try {
        const img = await control.webContents.capturePage()
        fs.writeFileSync(process.env.FETCH_SHOT, img.toPNG())
        console.log('[shot] written')
      } catch (e) { console.log('[shot] ' + e.message) }
    }, +(process.env.FETCH_SHOT_DELAY || 3000)))
  }
  if (process.env.FETCH_EXPORT) {          // dev: open a clip, trim it, export it
    control.webContents.once('did-finish-load', () => setTimeout(async () => {
      try {
        await control.webContents.executeJavaScript(`openInEditor(${JSON.stringify(process.env.FETCH_EXPORT)})`)
        await new Promise(r => setTimeout(r, 5000))
        const out = await control.webContents.executeJavaScript(`(async () => {
          ed.in = 0.5; ed.out = Math.min(2.5, ed.dur); paintTrim();
          ed.texts = [{text:'Fetch 100%', fx:.5, fy:.15, sizeFrac:.07, color:'white', box:true}];
          const r = await doExport({fmt:'mp4', q:'balanced', res:'720'});
          return JSON.stringify(r);
        })()`)
        console.log('[export] ' + out)
      } catch (e) { console.log('[export] ERR ' + e.message) }
    }, 1500))
  }
  if (process.env.FETCH_OPEN) {                       // dev: jump straight into the editor
    control.webContents.once('did-finish-load', () => setTimeout(() =>
      control.webContents.executeJavaScript(`openInEditor(${JSON.stringify(process.env.FETCH_OPEN)})`)
        .catch(e => console.log('[open] ' + e.message)), 1200))
  }
  if (process.argv.includes('--uitest')) {
    control.webContents.once('did-finish-load', () => {
      console.log('[uitest] page loaded')
      setTimeout(() => {
        console.log('[uitest] firing')
        const os = require('os')
        const fsx = require('fs')
        const dir = path.join(os.homedir(), 'Desktop')
        const pick = fsx.readdirSync(dir).filter(f => /^recording-.*\.webm$/.test(f)).sort().pop()
        control.webContents.executeJavaScript(
          `openInEditor(${JSON.stringify(path.join(dir, pick))}); 'opened'`
        ).then(r => { console.log('[uitest]', r); return new Promise(r => setTimeout(r, 2500)) }).then(() =>
          control.webContents.executeJavaScript(`
            ed.trimEnd = Math.min(4, ed.trimStart + 4); updateTimeline();
            $('burnCaps').checked = false;
            (async () => {
              const r = await doExport(); return 'RES:' + JSON.stringify(r).slice(0,200) + ' | el=' + JSON.stringify($('expResult').textContent)
            })()
          `)
        ).then(r => console.log('[uitest]', r)).catch(e => console.log('[uitest] ERR', e.message))
      }, 1500)
    })
  }

  if (process.env.FETCH_ELECTRON_CAM !== '1') return   // bubble handled by the native helper
  const d = screen.getPrimaryDisplay().workAreaSize
  cam = new BrowserWindow({
    width: 240, height: 240,
    x: d.width - 300, y: d.height - 300,
    frame: false, transparent: false, backgroundColor: '#000000', hasShadow: false,
    resizable: true, movable: true, skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  })
  cam.setAlwaysOnTop(true, 'screen-saver')
  cam.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  cam.loadFile('cam.html')
  if (!app.isPackaged) cam.webContents.on('console-message', (e, lvl, msg) => console.log('[cam]', msg))
  if (!app.isPackaged) control.webContents.on('console-message', (e, lvl, msg) => console.log('[ctl]', msg))
}

app.whenReady().then(() => {
  // Anonymous install count. Waits 30s so it never competes with launch, and does
  // nothing at all unless a metrics endpoint was configured at build time.
  telemetry.start(loadPrefs)

  // Auto-answer getDisplayMedia with the user's chosen source (or the primary screen)
  let chosenSourceId = null
  let chosenWindow = null          // { id, name } from the ScreenCaptureKit list
  ipcMain.on('select-source', (e, id) => { chosenSourceId = id; chosenWindow = null })
  ipcMain.on('select-window', (e, win) => { chosenWindow = win; chosenSourceId = null })

  // Window enumeration is unreliable on current macOS (it returns almost nothing),
  // so windows go through Apple's own picker while screens use our custom one.
  const useOurPicker = () => session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    // A window chosen from our own list is addressed by its CoreGraphics id.
    // Chromium resolves that id directly, so windows desktopCapturer never
    // listed still record correctly.
    if (chosenWindow) {
      return callback({ video: { id: `window:${chosenWindow.id}:0`, name: chosenWindow.name }, audio: 'loopback' })
    }
    desktopCapturer.getSources({ types: ['screen', 'window'] }).then(sources => {
      const pick = sources.find(s => s.id === chosenSourceId) ||
                   sources.find(s => s.id.startsWith('screen')) || sources[0]
      callback({ video: pick, audio: 'loopback' })
    }).catch(() => callback({}))
  }, { useSystemPicker: false })

  const useSystemPicker = () => session.defaultSession.setDisplayMediaRequestHandler(
    (request, callback) => callback({}), { useSystemPicker: true })

  useOurPicker()
  
  // source picker: screens + windows with thumbnails
  // Big enough to stay sharp on retina, JPEG so polling every couple of seconds
  // does not push megabytes of base64 through IPC.
  ipcMain.handle('get-sources', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 1000, height: 640 },
      fetchWindowIcons: true
    })
    return sources.map(s => {
      const t = s.thumbnail
      const size = t.getSize()
      return {
        id: s.id, name: s.name,
        thumb: t.isEmpty() ? null : 'data:image/jpeg;base64,' + t.toJPEG(72).toString('base64'),
        aspect: size.height ? +(size.width / size.height).toFixed(4) : 1.6,
        icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
        isScreen: s.id.startsWith('screen')
      }
    }).filter(s => !/^(Fetch|CamBubble|Status Bar|Dock|Picture-in-Picture)$/i.test(s.name))
  })

  // ---------- window enumeration ----------
  // desktopCapturer returns almost nothing on current macOS, so a small
  // ScreenCaptureKit helper does the listing and the per-window previews.
  const winListBin = () => {
    const packaged = path.join(process.resourcesPath || '.', 'WindowList')
    return fs.existsSync(packaged) ? packaged : path.join(__dirname, 'WindowList')
  }
  const runHelper = args => new Promise(resolve => {
    const bin = winListBin()
    if (!fs.existsSync(bin)) return resolve('')
    require('child_process').execFile(bin, args, { maxBuffer: 64 * 1024 * 1024, timeout: 15000 },
      (err, stdout) => resolve(err ? '' : String(stdout).trim()))
  })

  ipcMain.handle('list-windows', async () => {
    const out = await runHelper([])
    try { return JSON.parse(out || '[]') } catch { return [] }
  })
  ipcMain.handle('window-shot', async (e, id, px) => (await runHelper([String(id), String(px || 600)])) || null)

  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(true))
  session.defaultSession.setPermissionCheckHandler(() => true)

  createWindows()
  setupTray()
  updater.init({
    getWindow: () => control,
    autoUpdate: loadPrefs().autoUpdate,
    onChange: () => { if (tray) tray.setContextMenu(trayMenu()) },
  })
  globalShortcut.register('Shift+Command+R', () => toRenderer(recState === 'idle' ? 'start' : 'stop'))
  globalShortcut.register('Shift+Command+P', () => toRenderer('pause'))

  // The bubble is deliberately NOT launched here. It appears when recording starts
  // and goes away when it stops, so the camera light never comes on unasked.
})

app.on('will-quit', () => globalShortcut.unregisterAll())

app.on('before-quit', () => {
  showBorder(false)
  showHud(false)
  stopBubble()
})

// the camera request can wedge the renderer if another app (e.g. Presenter Overlay)
// holds the device, so reload the window until it comes back
let camOk = false, camTry = 0
ipcMain.on('cam-ok', () => { camOk = true })
setInterval(() => {
  if (!camOk && cam && !cam.isDestroyed()) {
    camTry++
    console.log('[main] camera not up, retrying with camera #' + camTry)
    cam.loadFile('cam.html', { query: { try: String(camTry) } })
  }
}, 9000)

// ---------- recording border ----------
// A click-through frame so you can see which display is being captured.
// setContentProtection keeps it out of the capture itself.
let border = null
function showBorder(on) {
  if (!on) { if (border && !border.isDestroyed()) border.destroy(); border = null; return }
  if (border && !border.isDestroyed()) return
  const d = screen.getPrimaryDisplay().bounds
  border = new BrowserWindow({
    x: d.x, y: d.y, width: d.width, height: d.height,
    frame: false, transparent: true, hasShadow: false, resizable: false, movable: false,
    focusable: false, skipTaskbar: true, enableLargerThanScreen: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  })
  border.setIgnoreMouseEvents(true, { forward: true })
  border.setAlwaysOnTop(true, 'screen-saver')
  border.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  border.setContentProtection(true)          // excluded from the recording
  border.loadFile('border.html')
}

// ---------- recording toolbar ----------
// Its own window so it sits above everything and outside the app, and content
// protected so pausing or stopping never shows up inside the recording.
let hud = null
function showHud(on) {
  if (!on) { if (hud && !hud.isDestroyed()) hud.destroy(); hud = null; return }
  if (hud && !hud.isDestroyed()) return
  const wa = screen.getPrimaryDisplay().workArea
  const w = 240, h = 76
  hud = new BrowserWindow({
    width: w, height: h,
    x: Math.round(wa.x + wa.width / 2 - w / 2), y: wa.y + wa.height - h - 26,
    frame: false, transparent: true, hasShadow: false, resizable: false,
    skipTaskbar: true, alwaysOnTop: true, movable: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  })
  hud.setAlwaysOnTop(true, 'screen-saver')
  hud.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  hud.setContentProtection(true)         // stays out of the capture
  hud.loadFile('hud.html')
}
ipcMain.on('hud-action', (e, action) => toRenderer(action))
ipcMain.on('hud-tick', (e, state) => { if (hud && !hud.isDestroyed()) hud.webContents.send('hud', state) })

// ---------- tray + global hotkeys ----------
let tray = null, recState = 'idle'

function trayMenu() {
  const rec = recState === 'recording', paused = recState === 'paused'
  const items = [
    { label: rec ? 'Recording…' : paused ? 'Paused' : 'Fetch is ready', enabled: false },
    { type: 'separator' },
    { label: rec || paused ? 'Stop recording' : 'Start recording',
      accelerator: 'Shift+Command+R', click: () => toRenderer(rec || paused ? 'stop' : 'start') },
    { label: paused ? 'Resume' : 'Pause', enabled: rec || paused,
      accelerator: 'Shift+Command+P', click: () => toRenderer('pause') },
  ]
  if (updater.getState().status === 'ready') {
    items.push({ type: 'separator' })
    items.push({ label: 'Update ready, restart', click: () => updater.requestRestart() })
  }
  items.push(
    { type: 'separator' },
    { label: 'Open Fetch', click: () => { if (control) { control.show(); control.focus() } } },
    { label: 'Quit Fetch', accelerator: 'Command+Q', click: () => app.quit() },
  )
  return Menu.buildFromTemplate(items)
}
// nativeImage cannot decode SVG, so the tray art is pre-rendered PNG.
// Electron picks up the @2x file automatically from the 1x path.
function trayIcon(active) {
  const file = path.join(__dirname, 'assets', active ? 'tray-rec.png' : 'tray-idle.png')
  const img = nativeImage.createFromPath(file)
  if (img.isEmpty()) {                       // never leave the menu bar with a blank slot
    return nativeImage.createFromNamedImage('NSStatusAvailable', [0, 0, 0, 1])
  }
  img.setTemplateImage(false)                // keep Biscuit gold rather than flat black
  return img
}
function setupTray() {
  tray = new Tray(trayIcon(false))
  tray.setToolTip('Fetch')
  tray.setContextMenu(trayMenu())
}
function toRenderer(action) { if (control && !control.isDestroyed()) control.webContents.send('hotkey', action) }

ipcMain.on('rec-state', (e, state) => {
  if (state === 'paused') camPause(true)
  if (state === 'recording' && recState === 'paused') camPause(false)
  recState = state
  updater.setRecState(state)
  if (tray) { tray.setImage(trayIcon(state === 'recording')); tray.setContextMenu(trayMenu()) }
  const live = state === 'recording' || state === 'paused'
  showBorder(live)
  showHud(live)
  if (live && control && !control.isDestroyed()) control.hide()   // get the app out of the shot
  if (!live && control && !control.isDestroyed()) control.show()
})

ipcMain.on('reveal', (e, p) => shell.showItemInFolder(p))
ipcMain.on('open-folder', () => shell.openPath(app.getPath('desktop')))



// the camera bubble is its own native app, toggled by the switch
function bubblePath() {
  for (const dir of [process.resourcesPath || '.', __dirname]) {
    for (const name of ['Fetch.app', 'CamBubble.app']) {      // old name kept as a fallback
      const p = path.join(dir, name)
      if (fs.existsSync(p)) return p
    }
  }
  return path.join(__dirname, 'Fetch.app')
}

// Full path, because a bare name would also match the main app's own executable.
function bubbleExec() {
  const base = bubblePath()
  for (const exe of ['Fetch', 'CamBubble']) {
    const p = path.join(base, 'Contents', 'MacOS', exe)
    if (fs.existsSync(p)) return p
  }
  return path.join(base, 'Contents', 'MacOS', 'Fetch')
}
function stopBubble() {
  require('child_process').spawn('pkill', ['-f', bubbleExec()])
}
// ---------- camera take ----------
// The bubble is kept out of the screen capture and recorded to its own file, so the
// editor can move and resize it instead of it being burned into the pixels.
const bubbleStatePath = () => path.join(os.homedir(), '.cambubble.json')
function patchBubbleState(patch) {
  let j = {}
  try { j = JSON.parse(fs.readFileSync(bubbleStatePath(), 'utf8')) } catch {}
  Object.assign(j, patch)
  try { fs.writeFileSync(bubbleStatePath(), JSON.stringify(j)) } catch {}
}

let camTake = null      // { out, screenStartedAt, gaps:[[from,to]], pausedAt }
ipcMain.on('cam-record', (e, on, screenStartedAt) => {
  if (on) {
    const out = path.join(os.tmpdir(), `fetch-cam-${Date.now()}.mov`)
    camTake = { out, screenStartedAt: screenStartedAt || Date.now(), gaps: [], pausedAt: 0 }
    patchBubbleState({ record: true, out })
  } else {
    patchBubbleState({ record: false })
  }
})

// MediaRecorder writes nothing while paused, so the camera has to lose the same
// spans or everything after the first pause would drift.
function camPause(paused) {
  if (!camTake) return
  if (paused) camTake.pausedAt = Date.now()
  else if (camTake.pausedAt) { camTake.gaps.push([camTake.pausedAt, Date.now()]); camTake.pausedAt = 0 }
}

ipcMain.on('cam-visible', (e, on) => {
  const cp = require('child_process')
  if (on) { if (fs.existsSync(bubblePath())) cp.spawn('open', [bubblePath()]) }
  else if (camTake) {
    // killing the helper mid-write would leave an unfinalised movie atom, so ask it
    // to stop and let the save step reap it once the file settles
    camTake.killWhenDone = true
    patchBubbleState({ record: false })
    const take = camTake
    setTimeout(() => { if (take.killWhenDone) stopBubble() }, 15000)   // never leave it running
  } else stopBubble()
})

// ---------- cursor tracking (feeds auto-zoom at export time) ----------
// Has to run *during* the take. There is no way to recover it afterwards.
let cursorSamples = null, cursorTimer = null

ipcMain.on('cursor-track', (e, on) => {
  clearInterval(cursorTimer); cursorTimer = null
  if (!on) return
  const t0 = Date.now()
  cursorSamples = { t0, display: screen.getPrimaryDisplay().bounds, scale: screen.getPrimaryDisplay().scaleFactor, points: [] }
  cursorTimer = setInterval(() => {
    const p = screen.getCursorScreenPoint()
    cursorSamples.points.push([Date.now() - t0, p.x, p.y])
  }, 50)                                    // 20 Hz is plenty to drive a smooth zoom
})


ipcMain.handle('save', async (e, buf) => {
  const file = path.join(resolvedSaveDir(), `recording-${Date.now()}.webm`)
  fs.writeFileSync(file, Buffer.from(buf))
  clearInterval(cursorTimer); cursorTimer = null
  if (cursorSamples && cursorSamples.points.length) {
    try { fs.writeFileSync(proc.sidecarOut(file, '.cursor.json'), JSON.stringify(cursorSamples)) }
    catch (e) { console.error('cursor track not saved, auto-zoom will have nothing to work with:', e.message) }
  }
  cursorSamples = null

  // park the camera take beside the recording and record how the two line up
  if (camTake) {
    const take = camTake; camTake = null
    patchBubbleState({ record: false })
    try {
      if (take.pausedAt) take.gaps.push([take.pausedAt, Date.now()])
      const dest = proc.sidecarOut(file, '.cam.mov')
      // AVFoundation finalises the movie atom after stopRecording returns
      for (let i = 0; i < 40 && !fs.existsSync(take.out); i++) await new Promise(r => setTimeout(r, 100))
      let lastSize = -1
      for (let i = 0; i < 40; i++) {
        const sz = fs.existsSync(take.out) ? fs.statSync(take.out).size : 0
        if (sz > 0 && sz === lastSize) break
        lastSize = sz
        await new Promise(r => setTimeout(r, 100))
      }
      if (fs.existsSync(take.out) && fs.statSync(take.out).size > 0) {
        fs.copyFileSync(take.out, dest)          // tmpdir and the save dir can be different volumes
        try { fs.unlinkSync(take.out) } catch {}
        let started = null
        try { started = JSON.parse(fs.readFileSync(take.out.replace(/\.[^.]+$/, '.start.json'), 'utf8')) } catch {}
        const d = screen.getPrimaryDisplay()
        fs.writeFileSync(proc.sidecarOut(file, '.cam.json'), JSON.stringify({
          file: dest,
          screenStartedAt: take.screenStartedAt,
          camStartedAt: started && started.startedAt || null,
          bubbleSize: started && started.size || 260,
          bubbleX: started ? started.x : null,
          bubbleY: started ? started.y : null,
          screenW: started ? started.screenW : null,
          screenH: started ? started.screenH : null,
          gaps: take.gaps,
          display: { w: d.bounds.width, h: d.bounds.height },
        }))
      }
    } catch (err) { console.log('cam take failed: ' + err.message) }
    if (take.killWhenDone) { take.killWhenDone = false; stopBubble() }
  }
  return file
})

// ---------- edit / post-production ----------
const proc = require('./processor')

// tidy any folder that was littered before support files moved out of the way
let tidied = false
function tidySaveFolders() {
  if (tidied) return
  tidied = true
  const seen = new Set()
  for (const d of [resolvedSaveDir(), app.getPath('desktop')]) {
    if (!d || seen.has(d)) continue
    seen.add(d)
    try { const n = proc.migrateSidecars(d); if (n) console.log(`tidied ${n} support files in ${d}`) } catch {}
  }
}

ipcMain.handle('list-recordings', () => { tidySaveFolders(); return proc.listRecordings() })
ipcMain.handle('probe', (e, src) => proc.probeMeta(src))
ipcMain.handle('read-cues', (e, src) => proc.readCues(src))
ipcMain.handle('write-cues', (e, src, cues) => proc.writeCues(src, cues))
ipcMain.handle('cancel-job', (e, id) => proc.cancel(id))
ipcMain.handle('formats', () => proc.formatList())
ipcMain.handle('backdrops', () => proc.backdropList())
ipcMain.handle('has-cursor', (e, src) =>
  fs.existsSync(proc.sidecarIn(String(src), '.cursor.json')))
ipcMain.handle('import-file', (e, src) => proc.importFile(src))

// "Import...": any container ffmpeg can read
ipcMain.handle('pick-file', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Video & audio', extensions: ['webm','mp4','mov','mkv','m4v','avi','mpg','mpeg','wmv','flv','ogv','ts','3gp','mts','m2ts','mp3','m4a','wav','aac','aiff','flac','ogg','opus','caf'] }],
  })
  if (canceled || !filePaths.length) return []
  const out = []
  for (const f of filePaths) { try { out.push(await proc.importFile(f)) } catch (err) { out.push({ path: f, error: String(err.message || err) }) } }
  return out
})

let jobSeq = 0
let jobsActive = 0   // reported to the updater, so it never installs mid-export

ipcMain.handle('edit-job', async (e, payload) => {
  const id = payload.jobId != null ? payload.jobId : ++jobSeq
  const cid = payload.cid
  const wc = e.sender
  const send = (status, extra) => { if (!wc.isDestroyed()) wc.send('edit-job', { id, cid, status, ...extra }) }
  const onP = (secs, total, pct) => send('progress', { secs, total, pct })

  jobsActive++
  updater.setJobsActive(jobsActive)
  try {
    try {
      send('running', { id })
      const o = payload.opts || {}
      let result
      switch (payload.op) {
        case 'mp4':        result = await proc.toMp4(payload.src, onP, id); break
        case 'convert':    result = await proc.convert(payload.src, o, onP, id); break
        case 'silence':    result = await proc.removeSilence(payload.src, o, onP, id); break
        case 'enhance':    result = await proc.enhanceAudio(payload.src, o, onP, id); break
        case 'trim':       result = await proc.trim(payload.src, payload.start, payload.end, onP, id); break
        case 'captions':   result = await proc.burnCaptions(payload.src, o, onP, id); break
        case 'gif':        result = await proc.toGif(payload.src, o, onP, id); break
        case 'thumb':      result = await proc.thumbnail(payload.src, payload.atSec, onP, id); break
        case 'waveform':   result = await proc.waveform(payload.src, o, onP, id); break
      case 'filmstrip':  result = await proc.filmstrip(payload.src, o, onP, id); break
        case 'export':     result = await proc.applyEdit(payload.src, o, onP, id); break
        case 'transcribe':
          result = await proc.transcribe(payload.src, o,
            (pct, isDownload) => send('progress', isDownload ? { downloadPct: pct } : { pct }), id)
          break
        default: throw new Error('unknown op ' + payload.op)
      }
      send('done', { result })
      return { ok: true, ...result }
    } catch (err) {
      if (err && err.cancelled) { send('cancelled', {}); return { ok: false, cancelled: true } }
      send('error', { message: String(err.message || err) })
      return { ok: false, error: String(err.message || err) }
    }
  } finally {
    jobsActive--
    updater.setJobsActive(jobsActive)
  }
})


app.on('window-all-closed', () => app.quit())
