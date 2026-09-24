const { app, BrowserWindow, desktopCapturer, session, ipcMain, dialog, screen, shell,
        globalShortcut, Tray, Menu, nativeImage, systemPreferences } = require('electron')
const fs = require('fs')
const path = require('path')
const os = require('os')

// own profile dir. The shared ~/Library/Application Support/Electron profile is
// used by other dev Electron apps and its GPU/capture state can get poisoned
app.setPath('userData', path.join(app.getPath('appData'), 'Fetch'))

// Window enumeration helper. Module scope on purpose: both the whenReady IPC handlers
// and native-start (registered at module level) need it. Declaring it inside whenReady
// meant native-start referenced a name that did not exist in its scope, and the only
// symptom would have been a protected app silently reappearing in a full-screen take.
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
const listWindowsJson = () =>
  runHelper([]).then(o => { try { return JSON.parse(o || '[]') } catch { return [] } })
// The window in front, front to back on screen (WindowList --front), past Fetch and any
// app named in skip: { id, app, title, ... } or null. What a take records when nobody
// named a window or asked for the whole screen.
const frontWindow = (skip = []) => new Promise(resolve => {
  const bin = winListBin()
  if (!fs.existsSync(bin)) return resolve(null)
  require('child_process').execFile(bin, ['--front'], { timeout: 5000, env: { ...process.env, FETCH_FRONT_SKIP: skip.join(',') } },
    (err, stdout) => { try { const w = JSON.parse(String(stdout || 'null')); resolve(w && w.id ? w : null) } catch { resolve(null) } })
})

let control, cam

const updater = require('./ui/updater')
const telemetry = require('./ui/telemetry')
const agentBridge = require('./ui/agent-bridge')
const jobQueue = require('./ui/job-queue')
let agentJobSeq = 0      // one id per agent job, for the queue and the processor alike
const activity = require('./ui/activity-log')
const chatLog = require('./ui/chat-log')
const agentChat = require('./ui/agent-chat')
const voice = require('./ui/voice')
const unsplash = require('./ui/unsplash')

// ---------- preferences ----------
// Persisted to <userData>/prefs.json. Loaded lazily and cached in memory;
// every write goes straight back to disk so a crash never loses a setting.
const PREFS_PATH = path.join(app.getPath('userData'), 'prefs.json')
const DEFAULT_PREFS = {
  saveDir: null,           // null means ~/Movies/Fetch, resolved at save time
  camera: false,            // the camera is something a person turns on, never a default
  mic: true,
  systemAudio: true,
  countdown: 3,            // 0, 3 or 5 seconds
  autoConvertMp4: false,
  openEditorAfter: false,
  keepOriginal: true,
  quickRecord: false,
  autoUpdate: true,        // let Fetch check and download updates in the background
  telemetry: true,         // anonymous install count: a random id, the version, the OS
  // What an agent may record. Defaults to 'ask' so a fresh install is never wide open,
  // and neverRecord is seeded rather than empty (see ui/record-policy.js).
  recordAccess: 'ask',
  // "Always allow" grants, each { key, label, at }. Listed and revoked in Settings.
  alwaysAllow: [],
  neverRecord: null,       // null means "use the seeded list"
  allowedRecordApps: [],
  // UDIDs an agent may never record and never drive. Empty rather than seeded: no device
  // is dangerous on every Mac, and a made up UDID would teach a person that the list
  // knows something it does not. A simulator is one app hosting anything, so the app
  // name above cannot express "not that phone" and the UDID is the only lever.
  neverRecordDevices: [],
  agentTakesVisible: false, // an agent's take runs in the background unless this is on
  agentNames: null,        // name takes with the person's agent; null means on when one is connected
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
// The root that take folders go in. ~/Movies/Fetch unless the person picked a folder,
// so nothing lands on the Desktop by default.
function resolvedSaveDir() {
  const dir = loadPrefs().saveDir
  if (dir) { try { fs.accessSync(dir, fs.constants.W_OK); return dir } catch {} }
  const home = path.join(app.getPath('videos'), 'Fetch')
  try { fs.mkdirSync(home, { recursive: true }) } catch {}
  return home
}
// A new take's file, in a folder of its own: <root>/<name>/Original/<name>.<ext>. The
// timestamp name is provisional; the take is renamed once it is known what it shows.
function newTakePath(ext) {
  const stem = `recording-${Date.now()}`
  const dir = path.join(resolvedSaveDir(), stem, 'Original')
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, `${stem}.${ext}`)
}
// A still lands in the same shape, for the same reason: the capture goes in Original
// and never moves again, so whatever the compositor writes beside it is a second file
// and the raw pixels stay one click away forever.
function newShotPath(ext = 'png') {
  const stem = `shot-${Date.now()}`
  const dir = path.join(resolvedSaveDir(), stem, 'Original')
  fs.mkdirSync(dir, { recursive: true })
  return { stem, dir, file: path.join(dir, `${stem}.${ext}`) }
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
// The devices Settings offers under "Never touched". Reading somebody's simulators is a
// free action in the policy because it costs them nothing, and the alternative is making
// a person copy a UDID out of a terminal to protect their own phone, which is the sort
// of thing a list nobody can fill looks like from the inside. Empty on a Mac with no
// Xcode, and the text field still takes a name or a UDID by hand.
ipcMain.handle('sim-devices', async () => {
  try {
    const sims = await require('./ui/agent-bridge').simModel()
    return sims.map(s => ({ udid: s.udid, name: s.name, state: s.state, booted: !!s.booted }))
  } catch { return [] }
})

ipcMain.handle('pick-save-dir', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: resolvedSaveDir(),
  })
  if (canceled || !filePaths.length) return null
  return writePrefs({ saveDir: filePaths[0] }).saveDir
})
ipcMain.handle('reveal-save-dir', () => shell.openPath(resolvedSaveDir()))

// A launch driven by a script (a debugging port, or FETCH_BEHIND=1) opens the window
// behind whatever the person is using. A shown window activates the app, and the
// person's typing then lands in Fetch's composer instead of the app they are in.
const launchedBehind = app.commandLine.hasSwitch('remote-debugging-port') || process.env.FETCH_BEHIND === '1'

function createWindows() {
  control = new BrowserWindow({
    width: 1240, height: 800,
    minWidth: 1000, minHeight: 640,
    x: 60, y: 40,
    title: 'Fetch',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: '#0B0A09',
    show: !launchedBehind,
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  })
  if (launchedBehind) control.showInactive()
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
  sweepStaleTakes()

  // The socket an MCP server talks to. Recording is driven through the renderer so
  // an agent-run take still shows the border, the HUD and the mascot.
  agentBridge.start({
    getWindow: () => control,
    toRenderer,
    proc: require('./processor'),
    isRecording: () => recState === 'recording' || recState === 'paused',
    listWindows: listWindowsJson,
    frontWindow,
    // how much of a window others in front of it hide (WindowList --covered), or null
    windowCovered: id => runHelper(['--covered', String(id)]).then(o => { try { return JSON.parse(o || 'null') } catch { return null } }),
    getPrefs: loadPrefs,
    // One captured frame, through the same policy gate and the same take folder a
    // recording uses. The bridge asks the person first and passes approved.
    takeShot,
    // Exports an agent asks for go through the same queue as the ones a person
    // starts, one heavy job at a time, so ten requests in a second cannot become ten
    // ffmpeg processes each threading across every core.
    // Any other edit job an agent asks for (remove dead air, enhance audio) goes
    // through the same queue as export, for the same reason.
    // One id for the queue and the processor, from a counter (two jobs in one millisecond
    // shared an id when it was the clock), so the brake, the person's Cancel and
    // processor.cancel all reach the same job. The work registers its own stop.
    runOp: (op, src, opts) => {
      const id = `agent:${op}:` + (++agentJobSeq)
      return jobQueue.submit({
        id, op,
        run: () => {
          const p = require('./processor')
          jobQueue.onCancel(() => p.cancel(id))
          if (op === 'silence') return p.removeSilence(src, opts || {}, null, id)
          if (op === 'enhance') return p.enhanceAudio(src, opts || {}, null, id)
          throw new Error('unknown op ' + op)
        },
      })
    },
    setQuiet: (on, agent) => { quietTake = !!on; agentTake = !!agent },
    // The one app Fetch ever opens on somebody's Mac, and only inside a `ready` they
    // asked for: `simctl boot` is headless and puts no window on screen, so the boot
    // they asked for would otherwise happen invisibly, and an invisible boot is worse
    // than a visible one. -g opens it without bringing it to the front, because nothing
    // here ever takes the front: a simulator is driven and recorded where it sits.
    openSimulator: () => new Promise((resolve, reject) => {
      require('child_process').execFile('/usr/bin/open', ['-g', '-a', 'Simulator'], { timeout: 20000 },
        err => err ? reject(new Error('Simulator would not open: ' + err.message)) : resolve(true))
    }),
    nameTake: p => takeNamer.name(p, { local: true }),     // rename_recording without a name
    pointer: agentPointer,
    setPrefs: patch => {
      writePrefs(patch)
      if (control && !control.isDestroyed()) control.webContents.send('prefs-changed', patch)
    },
    // the compositor when it can draw the edit, the classic renderer otherwise (ui/render-host.js)
    // `key` is the bridge's own name for the call ('agent:export:<job>'), so the queue, the
    // processor and the bridge's job.cancel all hold one id
    exportDoc: (src, opts, key) => {
      const id = key || 'agent:export:' + (++agentJobSeq)
      return jobQueue.submit({ id, op: 'export', run: () => require('./ui/render-host').exportEdit(src, opts, null, id) })
    },
    // A window for the consent dialog to hang off, so it is a sheet and not a modal.
    // Parentless, macOS runs the alert with -[NSAlert runModal] and the main thread
    // stops: no socket, no menu, no quit, and the bridge's own one minute deadline can
    // never fire because its timer is on the loop the modal holds. The window is shown
    // without focus where it was hidden, since a sheet on a window that is not on
    // screen is queued by AppKit and nobody is ever asked.
    askHost: () => {
      if (!control || control.isDestroyed()) return null
      try { if (!control.isVisible()) control.showInactive() } catch {}
      return control
    },
    // whether the person has stopped agents with Esc, for a question whose answer lands
    // after the stop: a late yes must not act for an agent that was stopped
    held: () => !!brake.held,
    // a socket closing is its agent done, so the brake need not stay armed for it
    clientGone: agentGone,
    // the recorder's own account of the take that just stopped, and only that one
    takeSound: () => (lastTakeSound && Date.now() - lastTakeSound.at < 10 * 60e3 ? lastTakeSound.sound : null),
    // where the sample is, while it is open (ui/sample.js), so list_recordings and memory
    // read it without asking the window
    sampleRoot: () => sampleOpen(),
    // and whose sound the take under way is taking, as its started event said
    takeScope: () => (nativeRec && nativeRec.started && nativeRec.started.soundScope) || null,
  })
  brakeAgentOps()
  // a chat turn ending, however it ends, can end the driving
  agentChat.onTurnEnd(() => { brake.lastAt = Date.now(); driveChanged() })
  Menu.setApplicationMenu(appMenu())

  // Any status bar Fetch was still holding when it died. Before anything else touches a
  // simulator, so nobody's device is left reading 9:41 because an export crashed. Silent
  // when there is nothing owed, which is almost always, and it never spawns on a Mac
  // with no stash file.
  require('./ui/simctl').restorePending()
    // Counted off what really went back, not off what was attempted: an entry whose
    // device the person has since deleted can never be restored, and printing it as
    // restored was the log agreeing with itself rather than with the Mac.
    .then(r => { const n = (r && r.value && r.value.ok) || 0
      if (n) console.log(`[sim] put back what Fetch was still wearing on ${n} device${n > 1 ? 's' : ''}`) })
    .catch(err => console.warn('[sim] simulator restore:', err && err.message))

  // Onboarding's Connect screen. Resolving binaries needs a login shell, which costs
  // about a second, so warm it now: by the time anyone reaches that screen the answer
  // is already cached and the rows paint immediately.
  const agentConnect = require('./ui/agent-connect')
  agentConnect.detect().catch(() => {})
  ipcMain.handle('agents-detect', () => agentConnect.detect())
  ipcMain.handle('agents-connect', (e, id) => agentConnect.connect(id))

  // Auto-answer getDisplayMedia with the user's chosen source (or the primary screen)
  // (chosenSourceId and chosenWindow live at module scope: the halo needs them too)
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

  ipcMain.handle('list-windows', async () => {
    const out = await runHelper([])
    try { return JSON.parse(out || '[]') } catch { return [] }
  })
  ipcMain.handle('window-shot', async (e, id, px) => (await runHelper([String(id), String(px || 600)])) || null)
  ipcMain.handle('front-window', () => frontWindow())

  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(true))
  session.defaultSession.setPermissionCheckHandler(() => true)

  createWindows()
  setupTray()
  updater.init({
    getWindow: () => control,
    autoUpdate: loadPrefs().autoUpdate,
    onChange: () => { if (tray) tray.setContextMenu(trayMenu()) },
  })
  // Option is part of the chord on purpose. The old Shift+Command+R is hard reload in
  // every browser, so refreshing a page started a full-screen recording with the
  // camera on. Nothing on a Mac uses Option+Shift+Command+R.
  globalShortcut.register(HOTKEY_REC, () => toRenderer(recState === 'idle' ? 'start' : 'stop'))

  // The bubble is deliberately NOT launched here. It appears when recording starts
  // and goes away when it stops, so the camera light never comes on unasked.
})

app.on('will-quit', () => globalShortcut.unregisterAll())

app.on('before-quit', () => {
  showBorder(false)
  showHud(false)
  hideAgentCursor()
  stopBubble()
})

// the camera request can wedge the renderer if another app (e.g. Presenter Overlay)
// holds the device, so reload the window until it comes back
let camOk = false, camTry = 0
ipcMain.on('cam-ok', () => { camOk = true })
// Only arm this when the Electron camera fallback actually exists: it is created
// solely under FETCH_ELECTRON_CAM=1, so in a normal build the timer woke every nine
// seconds forever to do nothing.
if (cam) setInterval(() => {
  if (!camOk && cam && !cam.isDestroyed()) {
    camTry++
    console.log('[main] camera not up, retrying with camera #' + camTry)
    cam.loadFile('cam.html', { query: { try: String(camTry) } })
  }
}, 9000)

// ---------- recording border ----------
// A click-through frame so you can see which display is being captured.
// setContentProtection keeps it out of the capture itself.
// What the next or current take records. Set by the renderer's setup; read by the
// capture handler and by the halo, which has to outline exactly this.
let chosenSourceId = null
let chosenWindow = null          // { id, name } from the ScreenCaptureKit list
let border = null
// The halo says what is being recorded, so it has to sit on exactly that: the chosen
// display, or the chosen window, following it as it moves. It used to be drawn around
// the primary display for every take, so a window take outlined the whole screen and a
// second display's take outlined the wrong one: the halo and the recording disagreed.
let borderFollow = null
function showBorder(on) {
  if (!on) {
    if (borderFollow) { try { borderFollow.kill() } catch {} borderFollow = null }
    if (border && !border.isDestroyed()) border.destroy()
    border = null
    return
  }
  if (border && !border.isDestroyed()) return

  const PAD = 5                                     // the halo sits just outside a window
  let start = screen.getPrimaryDisplay().bounds
  if (!chosenWindow && chosenSourceId) {
    const did = String(chosenSourceId).split(':')[1]
    const d = screen.getAllDisplays().find(x => String(x.id) === did)
    if (d) start = d.bounds
  }
  border = new BrowserWindow({
    x: start.x, y: start.y, width: start.width, height: start.height,
    frame: false, transparent: true, hasShadow: false, resizable: false, movable: false,
    focusable: false, skipTaskbar: true, enableLargerThanScreen: true, show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  })
  // shown inactive, always: show() activates Fetch and takes the keyboard from the app being recorded
  if (!chosenWindow) border.showInactive()
  border.setIgnoreMouseEvents(true, { forward: true })
  border.setAlwaysOnTop(true, 'screen-saver')
  // an agent's take must never move the person's Space (see the agent cursor below)
  border.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: agentTake })
  border.setContentProtection(true)          // excluded from the recording
  border.loadFile('border.html')
  if (process.env.FETCH_DEBUG_HALO) console.log('halo target', JSON.stringify({ window: chosenWindow, source: chosenSourceId, start }))

  if (chosenWindow) {
    const bin = winListBin()
    if (!fs.existsSync(bin)) { border.showInactive(); return }
    borderFollow = require('child_process').spawn(bin, ['--follow', String(chosenWindow.id)])
    let buf = ''
    borderFollow.stdout.on('data', d => {
      buf += d
      const lines = buf.split('\n'); buf = lines.pop()
      const b = (() => { try { return JSON.parse(lines[lines.length - 1] || 'null') } catch { return undefined } })()
      if (b === undefined || !border || border.isDestroyed()) return
      // minimised, on another Space, or closed: nothing on screen to outline
      if (!b || !b.onScreen) { border.hide(); return }
      border.setBounds({ x: b.x - PAD, y: b.y - PAD, width: b.width + PAD * 2, height: b.height + PAD * 2 })
      if (process.env.FETCH_DEBUG_HALO) console.log('halo', JSON.stringify(border.getBounds()), 'window', JSON.stringify(b))
      if (!border.isVisible()) border.showInactive()
    })
    borderFollow.on('error', () => { if (border && !border.isDestroyed()) border.showInactive() })
  }
}

// ---------- the agent's cursor, live ----------
// While an agent records, the person at the desk sees where it is pointing: Fetch's
// own cursor (agent-cursor.html, the one the export draws) over the recorded window.
// It is a picture and nothing more. Click-through, never focusable, content protected
// so no capture sees it, and it never moves or clicks the Mac's pointer. It appears on
// the take's first pointer call and goes when the take stops.
let agentCursor = null, agentCursorLast = null, agentCursorQueue = null
// The recorded frame in screen points now: the window's latest bounds from the same
// WindowList --follow stream the halo uses (null while it is off screen), or the display
function agentCursorFrame() {
  const s = cursorSamples
  if (!s || !s.native) return null
  if (s.kind !== 'window') return s.display ? { ...s.display } : null
  const b = s.bounds[s.bounds.length - 1]
  if (!b || b[5] === 0) return null
  return { x: b[1], y: b[2], width: b[3], height: b[4] }
}
function agentCursorSend(msg) {
  if (!agentCursor || agentCursor.isDestroyed()) return
  if (agentCursor.webContents.isLoading()) { agentCursorQueue = msg; return }
  agentCursor.webContents.send('agent-cursor', msg)
}
// glide: a pointer call animates there; a moved window just carries the cursor along
function agentCursorTo(f, click, glide) {
  const B = agentCursorFrame()
  if (!B) { if (agentCursor && !agentCursor.isDestroyed()) agentCursor.hide(); return }
  const d = screen.getDisplayMatching({ x: Math.round(B.x), y: Math.round(B.y),
    width: Math.max(1, Math.round(B.width)), height: Math.max(1, Math.round(B.height)) }).bounds
  if (!agentCursor || agentCursor.isDestroyed()) {
    agentCursor = new BrowserWindow({
      x: d.x, y: d.y, width: d.width, height: d.height,
      frame: false, transparent: true, hasShadow: false, resizable: false, movable: false,
      focusable: false, skipTaskbar: true, enableLargerThanScreen: true, show: false,
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    })
    agentCursor.setIgnoreMouseEvents(true)
    agentCursor.setAlwaysOnTop(true, 'screen-saver')
    // skipTransformProcessType: without it Electron flips Fetch to a UI element and back to
    // a foreground app, and macOS answers by sliding the person to Fetch's Space mid-take
    agentCursor.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
    agentCursor.setContentProtection(true)     // never in a recording, this one or any other
    agentCursor.webContents.once('did-finish-load', () => {
      if (agentCursorQueue) { agentCursor.webContents.send('agent-cursor', agentCursorQueue); agentCursorQueue = null }
    })
    agentCursor.loadFile('agent-cursor.html')
  } else {
    const now = agentCursor.getBounds()
    // the window moved to another display: the overlay follows, the cursor jumps
    if (now.x !== d.x || now.y !== d.y || now.width !== d.width || now.height !== d.height) {
      agentCursor.setBounds(d); glide = false
    }
  }
  if (!agentCursor.isVisible()) agentCursor.showInactive()
  agentCursorLast = { f, B }
  const msg = { x: B.x + f.x * B.width - d.x, y: B.y + f.y * B.height - d.y, click: !!click, glide: !!glide }
  agentCursorSend(msg)
  if (process.env.FETCH_DEBUG_CURSOR) console.log('agent cursor', JSON.stringify({ ...msg, at: Date.now(), overlay: agentCursor.getBounds() }))
}
// Each bounds report from the follow stream: keep the cursor on the same spot of the window
function agentCursorReflow() {
  if (!agentCursorLast || !agentCursor || agentCursor.isDestroyed()) return
  const B = agentCursorFrame(), L = agentCursorLast.B
  if (B && L && B.x === L.x && B.y === L.y && B.width === L.width && B.height === L.height && agentCursor.isVisible()) return
  agentCursorTo(agentCursorLast.f, false, false)
}
function hideAgentCursor() {
  if (process.env.FETCH_DEBUG_CURSOR && agentCursor) console.log('agent cursor gone', Date.now())
  agentCursorLast = null; agentCursorQueue = null
  if (agentCursor && !agentCursor.isDestroyed()) agentCursor.destroy()
  agentCursor = null
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
    skipTaskbar: true, alwaysOnTop: true, movable: true, show: false, acceptFirstMouse: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  })
  // an agent's take leaves the keyboard with the person; first-mouse keeps Stop one click
  if (agentTake) hud.showInactive(); else hud.show()
  hud.setAlwaysOnTop(true, 'screen-saver')
  hud.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: agentTake })
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
      accelerator: HOTKEY_REC, click: () => toRenderer(rec || paused ? 'stop' : 'start') },
    { label: paused ? 'Resume' : 'Pause', enabled: rec || paused,
      accelerator: HOTKEY_PAUSE, click: () => toRenderer('pause') },
    ...brakeItems(),
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

// ---------- the brake: Esc stops an agent ----------
// An agent working this Mac has to be stoppable in one key, wherever the person's focus
// is: in Simulator, in their terminal, in Fetch. So Esc is claimed system wide, but only
// while an agent is actually at work: a call running, a chat turn, its take rolling, and
// a few seconds after. The rest of the time it belongs to whatever app is in front, the
// same bargain the pause chord makes, and a terminal agent's own Esc still reaches it.
// Command+. is the Mac's own "cancel" and stays in the menu for when Fetch is in front.
//
// Between calls an agent is still at work, thinking, so the brake stays armed for the
// whole stretch an agent is connected: from its first call until its socket closes or
// it has been quiet for AGENT_IDLE_MS. Armed, the pill, the tray, the menu and Esc in
// Fetch's own window all stop it; only the system wide chord waits for the next call.
//
// Stopped means held: every call an agent makes after that is refused with a sentence
// until the person lets it continue, because killing a CLI in the chat stops one agent
// and an agent in a terminal would simply call again.
// Esc in Fetch's own window, and a chord for everywhere else. Plain Escape was claimed
// system wide here once, and that is the one key it cannot have: an agent drives Fetch
// from a terminal, and Esc is that terminal's own interrupt. Pressing it to interrupt
// the agent also latched this brake, so the agent's very next call was refused and the
// person had to come back to Fetch and click Let it continue. The stop from anywhere is
// worth keeping, so it moved to a chord nothing else answers to.
const HOTKEY_BRAKE = 'Escape'
const GLOBAL_BRAKE = 'Shift+Command+Escape'
const MENU_BRAKE = 'Command+.'
// Esc stays claimed this long after a call, so one pressed as the next call lands is not lost
const DRIVE_GRACE_MS = 3000
// and the brake stays armed this long after an agent's last call, if its socket stays open
const AGENT_IDLE_MS = 5 * 60e3
// What still answers while held: enough for an agent to learn it was stopped, nothing
// that touches the machine or the edit.
const BRAKE_FREE = new Set(['ping', 'hello', 'record.status'])
const brake = { inflight: 0, lastAt: 0, by: null, held: null, timer: null, on: false, armed: false, global: null,
  // every connected client that has called, by its socket's ctx: { by, chat, lastAt }
  clients: new Map() }

const agentTakeLive = () => agentTake && (recState === 'recording' || recState === 'paused')
const agentDriving = () => !brake.held && (brake.inflight > 0 || agentChat.busy() || agentTakeLive() ||
  Date.now() - brake.lastAt < DRIVE_GRACE_MS)
const recentClients = () => [...brake.clients.values()].filter(c => Date.now() - c.lastAt < AGENT_IDLE_MS)
const agentArmed = () => !brake.held && (agentDriving() || recentClients().length > 0)
const heldSentence = () => 'The person pressed Esc to stop you, so Fetch did nothing. Stop here and ask ' +
  'them what they want. Fetch answers again once they let you continue.'

// Every op the bridge answers passes through here. The bridge looks its table up per
// call (handleLine: ops[op]), so wrapping the entries in place gates the socket, the
// in-app chat's agent included, without a second path into the bridge.
function brakeAgentOps() {
  const ops = agentBridge.ops || {}
  for (const name of Object.keys(ops)) {
    const fn = ops[name]
    if (typeof fn !== 'function' || fn.braked) continue
    const free = BRAKE_FREE.has(name)
    const gated = async function (args, ctx) {
      if (brake.held && !free) throw new Error(heldSentence())
      if (free || name === 'record.pointer') return fn.call(this, args, ctx)
      brake.inflight++
      if (ctx && ctx.client) brake.by = ctx.client
      if (ctx) brake.clients.set(ctx, { by: ctx.client || 'Agent', chat: ctx.chat === true, lastAt: Date.now() })
      driveChanged()
      try { return await fn.call(this, args, ctx) } finally {
        brake.inflight--; brake.lastAt = Date.now()
        const c = ctx && brake.clients.get(ctx); if (c) c.lastAt = brake.lastAt
        driveChanged()
      }
    }
    gated.braked = true
    ops[name] = gated
  }
}

// a client whose socket closed is no longer at work, whatever it last did
function agentGone(ctx) {
  if (ctx && brake.clients.delete(ctx)) driveChanged()
}

function driveChanged() {
  const on = agentDriving(), armed = agentArmed()
  clearTimeout(brake.timer)
  // only the grace and the idle are on a clock; everything else calls back here when it ends
  if (armed && !brake.inflight && !agentChat.busy() && !agentTakeLive()) {
    const idle = recentClients().map(c => AGENT_IDLE_MS - (Date.now() - c.lastAt))
    const wait = on ? DRIVE_GRACE_MS - (Date.now() - brake.lastAt) : Math.max(0, ...idle)
    brake.timer = setTimeout(driveChanged, Math.max(50, wait + 50))
  }
  if (on === brake.on && armed === brake.armed) return
  brake.armed = armed
  if (on === brake.on) { paintBrake(); return }
  brake.on = on
  if (app.isReady()) {
    if (on && !globalShortcut.isRegistered(GLOBAL_BRAKE)) brake.global = globalShortcut.register(GLOBAL_BRAKE, () => stopAgent('Shift+Cmd+Esc'))
    if (!on && globalShortcut.isRegistered(GLOBAL_BRAKE)) globalShortcut.unregister(GLOBAL_BRAKE)
  }
  paintBrake()
}

function stopAgent(how) {
  if (!agentArmed()) return false
  const who = brake.by || 'the agent'
  // Whether anything outside the in-app chat was stopped: a message to the chat lets
  // the chat's own agent go on, and never a terminal agent the person stopped
  const outside = recentClients().some(c => !c.chat) || (brake.inflight > 0 && !agentChat.busy())
  brake.held = { at: Date.now(), by: who, outside }
  if (agentChat.busy()) agentChat.cancel()
  // what it recorded so far is kept: Stop, not discard
  if (agentTakeLive()) toRenderer('stop')
  hideAgentCursor()
  // a yes given "until Fetch quits" was given to an agent the person has just stopped
  if (agentBridge.forgetConsent) agentBridge.forgetConsent()
  // and every job an agent has queued or running (an export, dead air, enhance audio),
  // including any the bridge does not track. A person's jobs are ext: or a number.
  jobQueue.cancelWhere(id => String(id).startsWith('agent:'))
  // no by: a person did this
  activity.record({ op: 'agent.stop', title: `Stopped ${who}`, detail: how, ok: true })
  driveChanged(); paintBrake()
  return true
}

function releaseAgent(onlyChat) {
  if (!brake.held) return false
  if (onlyChat && brake.held.outside) return false
  const who = brake.held.by
  brake.held = null
  brake.lastAt = 0
  activity.record({ op: 'agent.release', title: `Let ${who} continue`, ok: true })
  driveChanged(); paintBrake()
  return true
}

// driving is what the renderer shows the pill and takes Esc for, so it is the armed
// stretch; esc says whether Esc is claimed system wide right now
const brakeState = () => ({ driving: brake.armed, held: brake.held, by: brake.by, esc: brake.on && brake.global !== false })
function paintBrake() {
  const state = brakeState()
  if (control && !control.isDestroyed()) control.webContents.send('agent-brake', state)
  if (tray) tray.setContextMenu(trayMenu())
  if (app.isReady()) Menu.setApplicationMenu(appMenu())
}

function brakeItems() {
  const who = (brake.held && brake.held.by) || brake.by || 'the agent'
  if (brake.held) return [{ type: 'separator' }, { label: `Let ${who} continue`, click: () => releaseAgent() }]
  if (!brake.armed) return []
  // the global Esc is what fires; the menu only says so
  return [{ type: 'separator' }, { label: `Stop ${who}`, accelerator: HOTKEY_BRAKE, registerAccelerator: false, click: () => stopAgent('menu') }]
}

ipcMain.on('agent-stop', (e, how) => stopAgent(how || 'Esc'))
ipcMain.on('agent-release', () => releaseAgent())
ipcMain.on('agent-brake-get', e => {
  e.returnValue = brakeState()
})

// ---------- the menu bar ----------
// Every shortcut lives here, where macOS people look for them, and nowhere else can
// claim one without this list showing it. Checked against what already existed: Cmd+Z
// and Shift+Cmd+Z are the editor's (ui/editor.js), Cmd+J is the chat's (ui/chat.js),
// Shift+Cmd+R and Shift+Cmd+P are the Record screen's (ui/app.js), and the two Option
// chords are global. Those show here with registerAccelerator off, so one key never
// fires twice. The stock View menu is gone with this: its Shift+Cmd+R was a hard reload
// that threw away an open edit.
const shortcut = what => () => { if (control && !control.isDestroyed()) control.webContents.send('shortcut', what) }
function appMenu() {
  const shown = (label, accelerator, what) => ({ label, accelerator, registerAccelerator: false, click: shortcut(what) })
  const brakeHeld = !!brake.held, who = (brake.held && brake.held.by) || brake.by || 'the agent'
  const view = [
    { label: 'Record', accelerator: 'Command+1', click: shortcut('view:record') },
    { label: 'Library', accelerator: 'Command+2', click: shortcut('view:library') },
    { label: 'Edit', accelerator: 'Command+3', click: shortcut('view:editor') },
    { label: 'Activity', accelerator: 'Command+4', click: shortcut('view:activity') },
    { type: 'separator' },
    { label: 'Search Library', accelerator: 'Command+F', click: shortcut('search') },
    { label: 'Version History', accelerator: 'Command+Y', click: shortcut('history') },
    shown('Ask Biscuit', 'Command+J', 'chat'),
    { type: 'separator' },
    { role: 'togglefullscreen' },
  ]
  if (!app.isPackaged) view.push({ type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' })
  return Menu.buildFromTemplate([
    { role: 'appMenu', submenu: [
      { role: 'about' },
      { type: 'separator' },
      { label: 'Settings…', accelerator: 'Command+,', click: shortcut('settings') },
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' },
    ] },
    { label: 'File', submenu: [
      { label: 'Import Video…', accelerator: 'Command+O', click: shortcut('import') },
      { type: 'separator' },
      { role: 'close' },
    ] },
    { role: 'editMenu' },
    { label: 'View', submenu: view },
    { label: 'Record', submenu: [
      { label: recState === 'idle' ? 'Start Recording' : 'Stop Recording', accelerator: HOTKEY_REC,
        registerAccelerator: false, click: () => toRenderer(recState === 'idle' ? 'start' : 'stop') },
      { label: recState === 'paused' ? 'Resume' : 'Pause', accelerator: HOTKEY_PAUSE, registerAccelerator: false,
        enabled: recState !== 'idle', click: () => toRenderer('pause') },
    ] },
    { label: 'Agent', submenu: [
      { label: brake.armed ? `Stop ${who}` : 'Stop Agent', accelerator: MENU_BRAKE, enabled: brake.armed,
        click: () => stopAgent('Command+.') },
      { label: brakeHeld ? `Let ${who} Continue` : 'Let Agent Continue', enabled: brakeHeld, click: () => releaseAgent() },
    ] },
    { role: 'windowMenu' },
  ])
}

// An agent's take runs in the background: no border around the display, no floating
// controls, and the Fetch window is neither hidden nor pulled back to the front
// afterwards. The menu bar icon still turns red, macOS shows its own recording
// indicator, and every take is in Activity. Set by the bridge for the take it starts.
const HOTKEY_REC = 'Alt+Shift+Command+R'
const HOTKEY_PAUSE = 'Alt+Shift+Command+P'
let quietTake = false
// An agent started this take: nothing it shows may activate Fetch, because the person
// is typing in another app and their keystrokes would follow the focus into Fetch.
let agentTake = false
ipcMain.on('rec-state', (e, state) => {
  // Pause exists only while something records, so the rest of the time the chord
  // belongs to whatever app is in front (Shift+Command+P is VS Code's palette).
  const liveNow = state === 'recording' || state === 'paused'
  if (liveNow && !globalShortcut.isRegistered(HOTKEY_PAUSE)) globalShortcut.register(HOTKEY_PAUSE, () => toRenderer('pause'))
  if (!liveNow && globalShortcut.isRegistered(HOTKEY_PAUSE)) globalShortcut.unregister(HOTKEY_PAUSE)
  if (state === 'paused') { camPause(true); cursorPause(true) }
  if (state === 'recording' && recState === 'paused') { camPause(false); cursorPause(false) }
  const wasLive = recState === 'recording' || recState === 'paused'
  recState = state
  updater.setRecState(state)
  if (tray) { tray.setImage(trayIcon(state === 'recording')); tray.setContextMenu(trayMenu()) }
  Menu.setApplicationMenu(appMenu())
  const live = state === 'recording' || state === 'paused'
  if (!live) hideAgentCursor()
  const byAgent = agentTake
  if (!live) agentTake = false
  if (byAgent) { brake.lastAt = Date.now(); driveChanged() }   // an agent's take is it driving
  // A take whose start was already on its way when Esc landed goes live after the stop.
  // Stopped agents start nothing, so it is stopped too, and kept.
  if (byAgent && state === 'recording' && brake.held && !wasLive) toRenderer('stop')
  if (quietTake) {
    if (!live) quietTake = false
    return
  }
  showBorder(live)
  showHud(live)
  if (live && control && !control.isDestroyed()) control.hide()   // get the app out of the shot
  if (!live && control && !control.isDestroyed()) byAgent ? control.showInactive() : control.show()
})

ipcMain.on('reveal', (e, p) => shell.showItemInFolder(p))
ipcMain.on('open-folder', () => shell.openPath(resolvedSaveDir()))
// The Finder's own Trash, so a take comes back with Put Back and a folder on another
// volume goes to that volume's Trash instead of failing to move. Answers how many went.
ipcMain.handle('trash-items', async (e, paths) => {
  const t0 = Date.now()
  const gone = []
  for (const p of paths || []) {
    if (!p || !fs.existsSync(p)) continue
    try { await shell.trashItem(p); gone.push(p) } catch (err) { console.error('could not trash', p, err.message) }
  }
  // Logged like any other change, with no `by` since a person did it here. A take
  // that vanished with nothing in the log could not be told apart from something
  // outside Fetch removing it.
  if (gone.length) {
    activity.record({ op: 'recordings.trash', title: 'Moved a recording to the Trash',
      detail: gone.length === 1 ? gone[0] : `${gone[0]} and ${gone.length - 1} more`, ms: Date.now() - t0, ok: true, error: null })
  }
  return gone.length
})



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
// Matched on the executable itself, not the command line: `pkill -f <path>` also killed
// any shell whose command merely mentioned the path.
function stopBubble() {
  const exe = bubbleExec()
  require('child_process').execFile('ps', ['-axo', 'pid=,comm='], (err, out) => {
    if (err) return
    for (const line of String(out).split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(.+?)\s*$/)
      if (m && m[2] === exe) try { process.kill(+m[1]) } catch {}
    }
  })
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

let camTake = null      // { out, screenStartedAt, gaps:[[from,to]], pausedAt, armed }
// A cold camera takes two to four seconds to launch, open its session and write a first
// frame, so a camera started with the screen missed the opening line: the face popped
// in mid-video. Arm it first (during the countdown, for a person) and start the screen
// once it is recording. It rolls a little early; the export trims to the screen's clock.
ipcMain.handle('cam-arm', async () => {
  const out = path.join(os.tmpdir(), `fetch-cam-${Date.now()}.mov`)
  const started = out.replace(/\.[^.]+$/, '.start.json')
  camTake = { out, screenStartedAt: null, gaps: [], pausedAt: 0, native: null, armed: true }
  patchBubbleState({ record: true, out })
  if (fs.existsSync(bubblePath())) require('child_process').spawn('open', [bubblePath()])
  // no camera, or access refused: give up waiting and record the screen regardless
  for (let i = 0; i < 80 && camTake && camTake.out === out; i++) {
    if (fs.existsSync(started)) return { ok: true }
    await new Promise(r => setTimeout(r, 100))
  }
  return { ok: false }
})
// The take never started (the countdown was cancelled, capture failed): stop the camera
// that was armed for it and drop its file.
ipcMain.on('cam-disarm', () => {
  if (!camTake || !camTake.armed || camTake.screenStartedAt) return
  const take = camTake; camTake = null
  patchBubbleState({ record: false })
  setTimeout(() => {
    stopBubble()
    for (const f of [take.out, take.out.replace(/\.[^.]+$/, '.start.json')]) try { fs.unlinkSync(f) } catch {}
  }, 1500)
})
ipcMain.on('cam-record', (e, on, screenStartedAt) => {
  if (on) {
    // A native take knows when its first frame landed; the renderer's time is only
    // when the IPC reply reached it. If that frame has not arrived yet, the recorder's
    // firstFrame event fills it in.
    const at = (nativeRec && nativeRec.firstFrameAt) || screenStartedAt || Date.now()
    if (camTake && camTake.armed && !camTake.screenStartedAt) {
      // already rolling since cam-arm: this only says where the screen starts
      camTake.screenStartedAt = at; camTake.native = nativeRec
      return
    }
    const out = path.join(os.tmpdir(), `fetch-cam-${Date.now()}.mov`)
    camTake = { out, screenStartedAt: at, gaps: [], pausedAt: 0, native: nativeRec }
    patchBubbleState({ record: true, out })
  } else {
    patchBubbleState({ record: false })
  }
})

// MediaRecorder writes nothing while paused, so the camera has to lose the same
// spans or everything after the first pause would drift.
function camPause(paused) {
  if (!camTake) return
  if (paused) camTake.pausedAt = camTake.pausedAt || Date.now()   // a lost window can already hold it
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
// What was in front while a take recorded, sampled every two seconds (WindowList
// --front, CoreGraphics only), so the take can be named after the app it mostly
// showed. A window take samples its own window, whose title changes as tabs do; a
// display take the frontmost window on that display. Kept until the next take starts,
// since the renderer asks for them after the recorder has stopped.
let frontSamples = [], frontProc = null
ipcMain.on('front-track', (e, on, target = {}) => {
  if (frontProc) { try { frontProc.kill() } catch {} frontProc = null }
  if (!on || !fs.existsSync(winListBin())) return
  frontSamples = []
  const d = target.displayId && screen.getAllDisplays().find(x => String(x.id) === String(target.displayId))
  const where = target.windowId ? [String(target.windowId)]
    : d ? [`@${d.bounds.x},${d.bounds.y},${d.bounds.width},${d.bounds.height}`] : []
  frontProc = require('child_process').spawn(winListBin(), ['--front', '2', ...where])
  // A never-record app is kept out of the picture, so its window title ("Messages ·
  // a contact") must not name the file or reach the agent either
  const { isProtected, DEFAULT_NEVER } = require('./ui/record-policy')
  const never = loadPrefs().neverRecord || DEFAULT_NEVER
  let buf = ''
  frontProc.stdout.on('data', chunk => {
    buf += chunk
    const lines = buf.split('\n'); buf = lines.pop()
    for (const line of lines) {
      let s; try { s = JSON.parse(line) } catch { continue }
      if (s && s.app && !isProtected(s.app, never) && frontSamples.length < 5400) frontSamples.push({ app: s.app, title: s.title || '' })
    }
  })
  frontProc.on('error', () => {})
})
ipcMain.handle('front-samples', () => {
  if (frontProc) { try { frontProc.kill() } catch {} frontProc = null }
  return frontSamples
})

let cursorSamples = null, cursorTimer = null, cursorFollow = null

// The Chromium path, started by the renderer once MediaRecorder is running. A native
// take has its own sampler on the recorder's clock (startNativeCursor), so this only
// stops that one and never replaces it. Samples left by a native take that was never
// committed are stale, and a Chromium take replaces them.
ipcMain.on('cursor-track', (e, on) => {
  if (cursorSamples && cursorSamples.native && (!on || nativeRec === cursorSamples.take)) {
    if (!on) stopCursorSampler()
    return
  }
  clearInterval(cursorTimer); cursorTimer = null
  if (!on) return
  const t0 = Date.now()
  cursorSamples = { t0, display: screen.getPrimaryDisplay().bounds, scale: screen.getPrimaryDisplay().scaleFactor, points: [] }
  cursorTimer = setInterval(() => {
    const p = screen.getCursorScreenPoint()
    cursorSamples.points.push([Date.now() - t0, p.x, p.y])
  }, 50)                                    // 20 Hz is plenty to drive a smooth zoom
})

// A native take samples on wall-clock time and is put onto the video clock when it
// is written: frame zero is the recorder's firstFrame, and paused spans are removed
// the way the recorder removes them. Starting from an IPC round trip after "started"
// put every zoom a few hundred milliseconds late, and each pause added to it.
function startNativeCursor(take, opts) {
  stopCursorSampler()
  const kind = opts.windowId ? 'window' : 'display'
  const d = (!opts.windowId && opts.displayId &&
    screen.getAllDisplays().find(x => String(x.id) === String(opts.displayId))) || screen.getPrimaryDisplay()
  const s = cursorSamples = {
    native: true, take, kind, windowId: opts.windowId || null,
    display: d.bounds, scale: d.scaleFactor,
    raw: [], bounds: [], gaps: [], pausedAt: 0,
  }
  cursorTimer = setInterval(() => {
    const p = screen.getCursorScreenPoint()
    s.raw.push([Date.now(), p.x, p.y])
  }, 50)
  // A window take is recorded in the window's own frame, which moves. Keep its
  // bounds over time so each point maps against where the window was at that moment.
  if (opts.windowId && fs.existsSync(winListBin())) {
    cursorFollow = require('child_process').spawn(winListBin(), ['--follow', String(opts.windowId)])
    let buf = ''
    cursorFollow.stdout.on('data', chunk => {
      buf += chunk
      const lines = buf.split('\n'); buf = lines.pop()
      for (const line of lines) {
        let b; try { b = JSON.parse(line) } catch { continue }
        if (!b || !(b.width > 0)) continue
        // Off screen (another Space, minimised) is kept as a state too: the recorder
        // still captures the window, but the pointer is not over it, so points in
        // that span must be dropped rather than mapped against where it last was.
        if (b.onScreen && !s.bounds.some(e => e[5])) {
          const wd = screen.getDisplayMatching({ x: b.x, y: b.y, width: b.width, height: b.height })
          if (wd) { s.display = wd.bounds; s.scale = wd.scaleFactor }
        }
        s.bounds.push([Date.now(), b.x, b.y, b.width, b.height, b.onScreen ? 1 : 0])
      }
      if (take.agent) agentCursorReflow()
    })
    cursorFollow.on('error', () => {})
  }
}

function stopCursorSampler() {
  clearInterval(cursorTimer); cursorTimer = null
  if (cursorFollow) { try { cursorFollow.kill() } catch {} cursorFollow = null }
}

function cursorPause(paused) {
  const s = cursorSamples
  if (!s || !s.native) return
  if (paused) s.pausedAt = s.pausedAt || Date.now()
  else if (s.pausedAt) { s.gaps.push([s.pausedAt, Date.now()]); s.pausedAt = 0 }
}

// What .cursor.json holds for a native take: every time in ms on the video clock.
function nativeCursorData(s) {
  const take = s.take
  const t0 = take.firstFrameAt || (take.started && take.started.startedAt) || (s.raw[0] && s.raw[0][0])
  if (!t0) return null
  const gaps = s.pausedAt ? [...s.gaps, [s.pausedAt, Infinity]] : s.gaps
  // null for a moment that is not in the video (before frame zero, or while paused),
  // unless snap is set, when it lands on the frame where the video resumes
  const clock = (at, snap) => {
    if (at < t0) return snap ? 0 : null
    let t = at - t0
    for (const [a, b] of gaps) {
      if (at >= b) t -= b - a
      else if (at >= a) { if (!snap) return null; t -= at - a; break }
    }
    return Math.round(t)
  }
  const points = s.raw.map(([at, x, y]) => { const t = clock(at); return t == null ? null : [t, x, y] }).filter(Boolean)
  // Bounds are a state, not an event: the last one before frame zero is where the
  // window was at frame zero.
  const windowBounds = []
  for (const [at, x, y, w, h, on] of s.bounds) {
    const t = clock(at, true)
    if (windowBounds.length && windowBounds[windowBounds.length - 1][0] >= t) windowBounds.pop()
    windowBounds.push(on ? [t, x, y, w, h] : [t, x, y, w, h, 0])      // a trailing 0: off screen
  }
  const tail = take.stopAt ? clock(take.stopAt, true) : null
  return {
    t0, kind: s.kind, display: s.display, scale: s.scale,
    ...(take.cursorHidden ? { inPicture: false } : {}),
    ...(s.kind === 'window' ? { windowId: s.windowId, windowBounds } : {}),
    // The last clicks before stop are the stop itself (the tray icon, then its menu),
    // and a zoom that late would be cut off by the end anyway.
    points, clicks: (take.clicks || []).filter(([t]) => !(tail != null && t > tail - 1500)),
  }
}


// ---------- the agent's own cursor ----------
// An agent take is recorded without the Mac's pointer and the agent reports its own
// through the pointer tool. Reports are kept on wall-clock time and put onto the video
// clock when the take is written, like the recorded cursor, so one made before the
// first frame lands on it and pauses are taken out.
const pointerLib = require('./ui/pointer')

function agentPointer(args = {}) {
  const take = nativeRec
  if (!take || !take.agent) throw new Error('no agent take is recording; the pointer only applies to a take started with record_start')
  const s = cursorSamples && cursorSamples.native && cursorSamples.take === take ? cursorSamples : null
  if (recState === 'paused' || (s && s.pausedAt)) throw new Error('the recording is paused, so this pointer was not recorded')
  // screen points map against where the recorded window or display is right now
  let bounds = null
  if (s && s.kind === 'window') {
    const b = s.bounds[s.bounds.length - 1]
    if (b) bounds = { x: b[1], y: b[2], width: b[3], height: b[4] }
  } else if (s) bounds = s.display
  const f = pointerLib.toFraction(args, bounds, take.kind)
  // A page's viewport says exactly where the page sits in the browser window, which is
  // what removing the browser's chrome from the take crops to (look frame.chrome)
  if (args.viewport && take.kind !== 'display') {
    const v = pointerLib.viewportBox(args.viewport)
    if (v) take.viewport = v
  }
  const at = Date.now()
  take.pointer.push([at, f.x, f.y, args.click ? 1 : 0])
  // and shown live, to the person watching; a picture only, it never moves their mouse.
  // Not once the take is stopping or has ended, or a late call would bring it back.
  if (!take.stopAt && !take.endedAlone) try { agentCursorTo(f, !!args.click, true) } catch (err) { console.error('agent cursor:', err.message) }
  const t0 = take.firstFrameAt || (take.started && take.started.startedAt) || at
  return { x: f.x, y: f.y, click: !!args.click, at: +(Math.max(0, at - t0) / 1000).toFixed(2), points: take.pointer.length }
}

// What .pointer.json holds: t in seconds on the video clock, x, y fractions of the
// recorded frame
function pointerData(take, s) {
  if (!take.pointer || !take.pointer.length) return null
  const t0 = take.firstFrameAt || (take.started && take.started.startedAt) || take.pointer[0][0]
  const clock = pointerLib.videoClock(t0, (s && s.gaps) || [], (s && s.pausedAt) || 0)
  const points = take.pointer.map(([at, x, y, click]) => {
    const ms = clock(at, true)
    return { t: ms / 1000, x, y, ...(click ? { click: true } : {}) }
  })
  return { v: 1, kind: take.kind || (s && s.kind) || 'display', scale: (s && s.scale) || null,
    ...(take.viewport ? { viewport: take.viewport } : {}),
    points: pointerLib.normalizeTrack(points) }
}

// Park the camera take beside the finished recording, with a sidecar describing how the
// two line up in time.
//
// This lived inline in the 'save' handler, which is the Chromium webm path. The native
// ScreenCaptureKit path commits through native-commit and never ran any of it, so on
// macOS 13 and later, where native is the default, the bubble recorded to a temp file
// that was then discarded. The screen take looked correct and the face was simply
// absent in the editor, with nothing reporting an error. Both paths call this now,
// which is the only way it stays fixed.
async function parkCamTake(file) {
  if (!camTake) return
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
      // read the start sidecar before deleting the take it is named after
      let started = null
      try { started = JSON.parse(fs.readFileSync(take.out.replace(/\.[^.]+$/, '.start.json'), 'utf8')) } catch {}
      try { fs.unlinkSync(take.out) } catch {}
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
    } else {
      // Say so. A missing face video discovered in the editor, minutes later, looks
      // like the editor lost it.
      console.error('the camera take was empty, so this recording has no face video')
      if (control && !control.isDestroyed()) control.webContents.executeJavaScript(
        `toast('The camera did not record this take. The screen recording is fine.', 'bad', 9000)`).catch(() => {})
    }
  } catch (err) { console.error('cam take failed: ' + err.message) }
  if (take.killWhenDone) { take.killWhenDone = false; stopBubble() }
}

ipcMain.handle('save', async (e, buf) => {
  const file = newTakePath('webm')
  fs.writeFileSync(file, Buffer.from(buf))
  clearInterval(cursorTimer); cursorTimer = null
  if (cursorSamples && !cursorSamples.native && cursorSamples.points.length) {
    try { fs.writeFileSync(proc.sidecarOut(file, '.cursor.json'), JSON.stringify(cursorSamples)) }
    catch (e) { console.error('cursor track not saved, auto-zoom will have nothing to work with:', e.message) }
  }
  cursorSamples = null

  await parkCamTake(file)
  return file
})

// ---------- permission recovery ----------
// macOS gives no way to re-prompt once screen recording has been refused: the only
// route is the Privacy pane. Telling someone to "go to System Settings" and leaving
// them to find it is where a first run dies, so open the exact pane for them.
const PRIVACY_PANES = {
  screen: 'Privacy_ScreenCapture',
  mic: 'Privacy_Microphone',
  camera: 'Privacy_Camera',
  audio: 'Privacy_AudioCapture',
}
ipcMain.handle('open-privacy', (e, which) => {
  const pane = PRIVACY_PANES[which] || PRIVACY_PANES.screen
  return shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${pane}`)
})

// Screen Recording only takes effect on relaunch, so offer to do it rather than
// letting someone grant it and wonder why nothing changed.
ipcMain.handle('relaunch', () => { app.relaunch(); app.exit(0) })

// Whether macOS will actually let us capture, asked of the system rather than guessed.
// Reading raises nothing: only a capture, or an outright request for the grant, puts
// the system's dialog on somebody's screen, and neither is this.
const screenAccessStatus = () => {
  try { return systemPreferences.getMediaAccessStatus('screen') } catch { return 'unknown' }
}
ipcMain.handle('screen-permission', () => screenAccessStatus())

// ---------- native recorder ----------
// ScreenCaptureKit in, AVAssetWriter out, via a bundled Swift helper. The Chromium
// path stays as the fallback: it works everywhere, this needs macOS 13 (15 for the
// microphone) and does not exist in a plain `npx electron .` checkout until the
// helper has been built.
function recorderPath() {
  for (const dir of [process.resourcesPath || '.', __dirname]) {
    const p = path.join(dir, 'Recorder')
    if (fs.existsSync(p)) return p
  }
  return null
}

// System Audio Recording, which one app's or one device's sound needs (a Core Audio
// process tap, Recorder.swift AppSound). A take never asks for it: a tap made without it
// records silence and raises macOS's dialog mid take. So it is read here without asking,
// for Settings, and asked for only when the person turns on "Only the recorded app's
// sound" there. Until it is given, window and simulator takes hear the whole Mac and say so.
function audioAccess(request) {
  const bin = recorderPath()
  if (!bin) return Promise.resolve({ state: 'unavailable' })
  return new Promise(resolve => {
    require('child_process').execFile(bin, request ? ['--audio-access', 'request'] : ['--audio-access'],
      { timeout: request ? 120000 : 5000 }, (err, out) => {
        let state = 'unknown'
        try { state = JSON.parse(String(out || '').trim().split('\n').pop()).state || 'unknown' } catch {}
        resolve({ state, ...(err && state === 'unknown' ? { error: err.message } : {}) })
      })
  })
}
ipcMain.handle('audio-access', () => audioAccess(false))
// the one place in the app that can put the dialog up, and only from the person's click
ipcMain.handle('audio-access-request', () => audioAccess(true))

let nativeRec = null      // { proc, out, started, resolveStop }
// What the recorder said about the last take's sound (leadMs, gaps, lostMs per track),
// for record_stop to say beside what it measured in the file
let lastTakeSound = null

// v1.0.1 could abandon a take in the temp folder without cleaning it up: on macOS 13
// and 14 the microphone check ran after the recorder had already started writing.
// That is fixed, but anyone who ran that build has strays to clear.
function sweepStaleTakes() {
  const dir = os.tmpdir()
  const DAY = 24 * 60 * 60 * 1000
  let files = []
  try { files = fs.readdirSync(dir) } catch { return }
  for (const f of files) {
    if (!/^fetch-take-.*\.(mov|start\.json)$/.test(f) && !/^fetch-cam-/.test(f)) continue
    const p = path.join(dir, f)
    try {
      if (Date.now() - fs.statSync(p).mtimeMs > DAY) fs.unlinkSync(p)
    } catch {}
  }
}

function majorOSVersion() {
  return parseInt(String(require('os').release()).split('.')[0], 10) || 0
}

ipcMain.handle('native-available', () => ({
  // Darwin 22 is macOS 13, which is where ScreenCaptureKit became usable for this
  ok: !!recorderPath() && majorOSVersion() >= 22,
  mic: majorOSVersion() >= 24,          // Darwin 24 is macOS 15: mic capture in SCK
}))

ipcMain.handle('native-start', async (e, opts = {}) => {
  lastTakeSound = null        // a new take is not described by the last one's sound
  const bin = recorderPath()
  if (!bin) return { ok: false, error: 'the recorder helper is not in this build' }
  // one that ended on its own before the renderer knew it had started is not in the way
  if (nativeRec && nativeRec.endedAlone && nativeRec.proc.exitCode !== null) nativeRec = null
  if (nativeRec) return { ok: false, error: 'already recording' }

  const out = path.join(os.tmpdir(), `fetch-take-${Date.now()}.mov`)
  const args = ['--out', out, '--fps', String(opts.fps || 60)]
  if (opts.windowId) args.push('--window', String(opts.windowId))
  else if (opts.displayId) args.push('--display', String(opts.displayId))
  // The halo outlines what the recorder is actually given, not what was last picked
  // in setup, so the two cannot disagree.
  if (opts.windowId) { chosenWindow = { id: opts.windowId, name: (chosenWindow && chosenWindow.name) || '' }; chosenSourceId = null }
  else if (opts.displayId) { chosenSourceId = `screen:${opts.displayId}:0`; chosenWindow = null }
  else { chosenSourceId = null; chosenWindow = null }

  // A display capture sees everything on screen, so the never-record list has to be
  // applied here as well as at the bridge. Refusing window targets alone would leave a
  // protected app visible in any full-screen take, which would make the promise on the
  // Recording access screen false. This applies to human takes too: the point is that
  // those pixels are never written, whoever pressed record.
  if (!opts.windowId) {
    try {
      const recordPolicy = require('./ui/record-policy')
      const prefs = loadPrefs()
      // The device inside each Simulator window comes with the list, because a protected
      // device can only be kept out of a display capture by its window id: every
      // simulator answers to the same app name.
      const wins = await agentBridge.attachDevices(await listWindowsJson())
      const drop = recordPolicy.windowsToExclude(wins,
        { neverRecord: prefs.neverRecord, neverRecordDevices: prefs.neverRecordDevices })
      if (drop.length) args.push('--exclude', drop.join(','))
    } catch (err) { console.error('exclusion list failed:', err.message) }
  }
  if (opts.systemAudio) args.push('--system-audio')
  // Which simulator the take is for, so the recorder taps that device's sound alone
  // rather than refusing to guess between two booted ones (Recorder.swift SoundPlan).
  // The bridge knows it for an agent's take; the renderer may pass one for the person's.
  const agentTaking = !!(agentBridge.startingAgentTake && agentBridge.startingAgentTake())
  const soundDevice = opts.soundDevice || (agentTaking && agentBridge.takeSoundDevice ? agentBridge.takeSoundDevice() : null)
  if (opts.systemAudio && soundDevice) args.push('--sound-device', String(soundDevice))
  if (opts.mic) { args.push('--mic'); if (opts.micDeviceId) args.push('--mic-device', opts.micDeviceId) }
  if (opts.hevc) args.push('--hevc')
  // An agent's take never shows the Mac's own pointer: that belongs to the person at
  // the desk, and the agent draws its own (the pointer tool, ui/pointer.js)
  const agentTake = !!(agentBridge.startingAgentTake && agentBridge.startingAgentTake())
  if (opts.hideCursor || agentTake) args.push('--no-cursor')
  if (process.env.FETCH_DEBUG_CURSOR) console.log('recorder args', JSON.stringify({ agentTake, args }))

  const child = require('child_process').spawn(bin, args)
  const take = { proc: child, out, started: null, resolveStop: null, error: null, firstFrameAt: null, clicks: [],
    kind: opts.windowId ? 'window' : 'display' }
  nativeRec = take
  if (agentTake) { take.agent = true; take.pointer = [] }
  // so the export knows there is no pointer in these pixels to lift out
  if (opts.hideCursor) take.cursorHidden = true

  let buf = ''
  child.stdout.on('data', d => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1)
      if (!line.trim()) continue
      let ev; try { ev = JSON.parse(line) } catch { continue }
      if (ev.event === 'started') take.started = ev
      if (ev.event === 'firstFrame') {
        take.firstFrameAt = ev.at
        if (camTake && camTake.native === take) camTake.screenStartedAt = ev.at
      }
      // Already on the video clock, so they go into .cursor.json as they are. A press
      // on the HUD's Pause or Stop is not part of the take (the HUD is kept out of the
      // picture), and zooming on it would push into whatever sits underneath.
      if (ev.event === 'click') {
        const hb = hud && !hud.isDestroyed() && hud.isVisible() ? hud.getBounds() : null
        const onHud = hb && ev.x >= hb.x && ev.x < hb.x + hb.width && ev.y >= hb.y && ev.y < hb.y + hb.height
        if (!onHud) take.clicks.push([ev.t, ev.x, ev.y])
      }
      if (ev.event === 'error') { take.error = ev.message; console.log('recorder:', ev.message) }
      // The recorder holds a lost window as a pause while it looks for it again, so
      // the camera and the cursor track have to lose the same span or they drift.
      if (ev.event === 'interrupted' && recState === 'recording') { take.held = true; camPause(true); cursorPause(true) }
      // a person who paused while it was lost keeps the gap open until they resume
      if (ev.event === 'recovered' && take.held) { take.held = false; if (recState === 'recording') { camPause(false); cursorPause(false) } }
      if (ev.event === 'stopped') { take.stoppedEv = ev; if (take.resolveStop) take.resolveStop(ev) }
    }
  })
  // Most of what the recorder writes here is chatter, but a sound stream that stopped part
  // way or a stream that did not stop cleanly is written nowhere else, so those lines are
  // kept on the take and logged in a packaged build too.
  child.stderr.on('data', d => {
    const text = String(d).trim()
    if (!app.isPackaged) console.log('recorder stderr:', text)
    for (const line of text.split('\n')) {
      if (!/system audio|did not stop cleanly|kept an output/.test(line)) continue
      if (app.isPackaged) console.error('recorder:', line)
      if ((take.warnings || (take.warnings = [])).length < 8) take.warnings.push(line)
    }
  })
  child.on('close', () => {
    // the capture is over however it ended, so the agent's cursor has nothing to point at
    if (nativeRec === take) hideAgentCursor()
    if (take.resolveStop) take.resolveStop(null)   // died without reporting
    else if (nativeRec === take && take.started && control && !control.isDestroyed()) {
      // Nobody asked it to stop: the window closed or the display went away. The
      // recorder still finished the file, so the take stays current and the renderer
      // ends it through the usual stop and commit, which names it, writes its
      // sidecars and answers an agent waiting on record_stop.
      take.endedAlone = true
      if (agentBridge.takeEndedAlone) agentBridge.takeEndedAlone()
      control.webContents.send('native-ended', { kind: take.kind, reason: take.error || '' })
      return
    }
    if (nativeRec === take) nativeRec = null
  })

  // wait for it to actually be capturing, so the countdown does not lie
  const startedAt = Date.now()
  while (Date.now() - startedAt < 6000) {
    if (take.started) {
      startNativeCursor(take, opts)
      return { ok: true, ...take.started }
    }
    if (take.error) { nativeRec = null; return { ok: false, error: take.error } }
    if (child.exitCode !== null) { nativeRec = null; return { ok: false, error: 'the recorder exited before it started' } }
    await new Promise(r => setTimeout(r, 60))
  }
  try { child.kill() } catch {}
  nativeRec = null
  return { ok: false, error: 'the recorder did not start in time' }
})

ipcMain.on('native-pause', () => { try { nativeRec && nativeRec.proc.stdin.write('pause\n') } catch {} })
ipcMain.on('native-resume', () => { try { nativeRec && nativeRec.proc.stdin.write('resume\n') } catch {} })

ipcMain.handle('native-stop', async () => {
  const take = nativeRec
  if (!take) return { ok: false, error: 'not recording' }
  hideAgentCursor()          // gone the moment the take stops, not when the file lands
  let ev = take.stoppedEv || null
  if (!take.endedAlone) {
    const done = new Promise(res => { take.resolveStop = res })
    take.stopAt = Date.now()
    try { take.proc.stdin.write('stop\n') } catch {}
    ev = await Promise.race([done, new Promise(r => setTimeout(() => r(null), 20000))])
  }
  nativeRec = null
  lastTakeSound = { sound: (ev && Array.isArray(ev.sound)) ? ev.sound : null, at: Date.now() }
  if (cursorSamples && cursorSamples.native) stopCursorSampler()
  if (!ev || !fs.existsSync(take.out) || !fs.statSync(take.out).size) {
    // nothing will be committed, so nothing should outlive it into the next take
    if (cursorSamples && cursorSamples.native) cursorSamples = null
    return { ok: false, error: take.error || 'the take was not written', endedAlone: !!take.endedAlone, kind: take.kind }
  }
  return { ok: true, tmp: take.out, frames: ev.frames, dropped: ev.dropped, stillMs: ev.stillMs || 0, endedAlone: !!take.endedAlone, kind: take.kind,
    ...(Array.isArray(ev.sound) ? { sound: ev.sound } : {}),
    ...(take.warnings && take.warnings.length ? { warnings: take.warnings } : {}) }
})

// Move a finished native take into the save folder, reusing the same naming and
// sidecar handling the Chromium path already goes through.
ipcMain.handle('native-commit', async (e, tmp) => {
  let file
  try {
    file = newTakePath('mov')
    // system audio and the mic arrive as separate tracks; fold them together before
    // this leaves the temp folder, or everything downstream hears only the first one
    let source = tmp
    try { source = await proc.flattenAudio(tmp, 'native-commit') } catch {}
    fs.copyFileSync(source, file)
    try { fs.unlinkSync(source) } catch {}
    if (source !== tmp) { try { fs.unlinkSync(tmp) } catch {} }
  } catch (err) {
    return { ok: false, error: err.message }
  }
  stopCursorSampler()
  const agentTake = cursorSamples && cursorSamples.native && cursorSamples.take && cursorSamples.take.agent
    ? cursorSamples.take : null
  const ptr = agentTake && pointerData(agentTake, cursorSamples)
  if (ptr) {
    try { fs.writeFileSync(proc.sidecarOut(file, '.pointer.json'), JSON.stringify(ptr)) }
    catch (err) { console.error('pointer track not saved:', err.message) }
  }
  const cursor = cursorSamples && cursorSamples.native ? nativeCursorData(cursorSamples) : cursorSamples
  // In an agent's take the Mac's pointer was the person's, doing something else, and
  // auto-zoom must not follow their clicks into it
  if (cursor && !agentTake && (cursor.points.length || (cursor.clicks || []).length)) {
    try { fs.writeFileSync(proc.sidecarOut(file, '.cursor.json'), JSON.stringify(cursor)) }
    catch (err) { console.error('cursor track not saved:', err.message) }
  }
  cursorSamples = null
  // the native path never did this, which is why camera takes vanished on macOS 13+
  await parkCamTake(file)
  return { ok: true, file }
})

// ---------- stills ----------
// A screenshot is a take of one frame, so it comes through the same door: the same
// ScreenCaptureKit family (Shot.swift), the same never-record list, the same folder
// with the raw capture in Original. Nothing here renders. Everything that turns this
// PNG into a finished one is the compositor's, which already draws every part of it.
function shotPath() {
  for (const dir of [process.resourcesPath || '.', __dirname]) {
    const p = path.join(dir, 'Shot')
    if (fs.existsSync(p)) return p
  }
  return null
}

const runShot = args => new Promise(resolve => {
  const bin = shotPath()
  if (!bin) return resolve({ ok: false, error: 'the screenshot helper is not in this build' })
  require('child_process').execFile(bin, args, { timeout: 20000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
    // The helper answers in JSON whichever way it went, so a parse failure means it
    // never got to speak: a crash, or a kill on the timeout.
    try { return resolve(JSON.parse(String(stdout).trim().split('\n').pop())) } catch {}
    // Killed on the timeout is the one case worth naming. The helper refuses in
    // milliseconds when it can see the answer, so the only thing that holds it for
    // twenty seconds is macOS waiting on a person, and "said nothing" leaves whoever
    // reads it with nowhere to go.
    if (err && err.killed) {
      return resolve({ ok: false, error: 'the screenshot helper did not answer in 20 seconds. ' +
        'macOS is most likely waiting for someone to grant Fetch Screen Recording in System Settings, ' +
        'Privacy and Security, Screen Recording.' })
    }
    resolve({ ok: false, error: (err && err.message) || 'the screenshot helper said nothing' })
  })
})

// Darwin 23 is macOS 14, where SCScreenshotManager arrived. Older Macs still record.
ipcMain.handle('shot-available', () => ({ ok: !!shotPath() && majorOSVersion() >= 23 }))

// opts: { windowId } | { displayId } | { region: {x,y,width,height}, displayId? },
// plus by: 'agent' | 'human', cursor, windowShadow, approved.
//
// A named function rather than only a handler, because the agent bridge runs in this
// process and calls it directly (take_shot).
async function takeShot(opts = {}) {
  if (!shotPath()) return { ok: false, error: 'the screenshot helper is not in this build' }
  if (majorOSVersion() < 23) return { ok: false, error: 'stills need macOS 14 or later' }
  const policy = require('./ui/record-policy')
  const prefs = loadPrefs()
  const by = opts.by === 'agent' ? 'agent' : 'human'

  // macOS first, before the never-record list and before anything is spawned. Without
  // the Screen Recording grant a capture does not fail, it stops: the system puts up a
  // dialog only a person can answer, and an agent with nobody at the Mac waits on a
  // question it cannot see. A refusal that names the pane is something an agent can
  // report and stop on. Fetch never asks for the grant on the person's behalf.
  const grant = policy.screenAccess(screenAccessStatus(), by)
  if (!grant.allow) return { ok: false, needsPermission: true, error: `Fetch refused to capture: ${grant.reason}` }

  const r = opts.region ? {
    x: Math.round(opts.region.x), y: Math.round(opts.region.y),
    w: Math.round(opts.region.width != null ? opts.region.width : opts.region.w),
    h: Math.round(opts.region.height != null ? opts.region.height : opts.region.h),
  } : null
  if (r && ![r.x, r.y, r.w, r.h].every(Number.isFinite)) return { ok: false, error: 'a region needs x, y, width and height' }
  if (r && (r.w < 1 || r.h < 1)) return { ok: false, error: 'that region has no size' }
  const kind = opts.windowId ? 'window' : r ? 'region' : 'display'

  // The never-record list is applied here, before a pixel is read, exactly as a take
  // applies it: a protected window is never the target, and on anything wider it is
  // left out of the frame rather than captured and cropped afterwards.
  // Each Simulator window carries the device inside it, so the never record devices list
  // can be honoured here too. A device nobody could name refuses the capture rather than
  // passing it: the one that cannot be resolved is exactly the one that might be listed.
  const wins = await agentBridge.attachDevices(await listWindowsJson())
  let app = null, device = null
  if (kind === 'window') {
    const hit = wins.find(w => String(w.id) === String(opts.windowId))
    app = hit && hit.app
    device = (hit && hit.device) || null
  }
  // A region is judged as a display: it sees whatever happens to be under it, and no
  // list of apps can be honoured by excluding windows from a rectangle.
  // A Simulator window with no device on it is not "a window": it is a device Fetch
  // could not tell, and the one it could not tell is exactly the one that might be on
  // the never record devices list. Judged as a simulator with no udid, which decide()
  // refuses, rather than waved through as an ordinary window.
  const blind = kind === 'window' && !device &&
    String(app || '') === policy.SIMULATOR_APP && by === 'agent'
  const request = { by, kind: (device || blind) ? 'simulator' : kind === 'window' ? 'window' : 'display', app,
    ...(device ? { udid: device.udid, device: device.name } : {}) }
  const verdict = policy.decide(request, { mode: prefs.recordAccess, neverRecord: prefs.neverRecord,
    neverRecordDevices: prefs.neverRecordDevices, allowedApps: prefs.allowedRecordApps })
  if (!verdict.allow) return { ok: false, error: `Fetch refused to capture: ${verdict.reason}` }
  // 'Ask' means a person approves every agent capture. The question belongs to whoever
  // is holding the agent's request (ui/agent-bridge.js asks it once and can remember a
  // yes for the session), so this refuses rather than raising a second dialog. The
  // sentence is the policy's own, and it says what to do: "nobody approved this" tells
  // an agent it failed and leaves it nothing to act on.
  if (verdict.needsApproval && !opts.approved) {
    return { ok: false, needsApproval: true, kind, app,
      error: `Fetch refused to capture: ${verdict.unanswered}` }
  }

  // A scratch capture is a measurement, not a picture anybody asked for: it goes to a
  // temporary file, is never named and never lands in the person's library.
  // ui/agent-bridge.js measures where a device's screen sits inside its window off one,
  // on every ready, tap and take, and a take folder per measurement went to the Trash.
  const scratch = opts.scratch === true && by === 'agent' && kind === 'window'
  const { stem, dir, file } = scratch
    ? { stem: null, dir: null, file: path.join(os.tmpdir(), `fetch-glass-${process.pid}-${Date.now().toString(36)}.png`) }
    : newShotPath('png')
  // Who asked goes to the helper, because the two callers want opposite things from a
  // Mac that has never been asked: an agent wants a refusal it can report, a person
  // wants the system's own prompt. The helper is the only process that can raise it.
  const args = ['--out', file, '--by', by]
  if (kind === 'window') args.push('--window', String(opts.windowId))
  else {
    if (opts.displayId) args.push('--display', String(opts.displayId))
    if (r) args.push('--region', [r.x, r.y, r.w, r.h].join(','))
    // By name, and by id as well. The ids come off the list a picker draws, which is
    // filtered for readability and so cannot see a password manager's small panel or a
    // second window with the same title and size. The helper matches the names against
    // every window it can see, so what is left out is decided where the pixels are read.
    const drop = policy.windowsToExclude(wins,
      { neverRecord: prefs.neverRecord, neverRecordDevices: prefs.neverRecordDevices })
    if (drop.length) args.push('--exclude', drop.join(','))
    for (const name of policy.appsToExclude({ neverRecord: prefs.neverRecord })) args.push('--exclude-app', name)
  }
  // The person's own pointer is out of a still unless it is the point of the shot.
  if (opts.cursor) args.push('--cursor')
  if (opts.windowShadow) args.push('--window-shadow')

  // Fetch's own window is never in the shot. The recording path hides it (setRecState),
  // and WindowList never lists Fetch, so its window id can never reach --exclude: being
  // off screen while the helper reads the pixels is the only way out of a display or a
  // region capture. A window capture reads one window's backing store and does not care.
  const hideMe = kind !== 'window' && control && !control.isDestroyed() && control.isVisible()
  const hadFocus = hideMe && control.isFocused()
  if (hideMe) {
    control.hide()
    // the window server takes a moment to stop compositing it
    await new Promise(r => setTimeout(r, 150))
  }
  let got
  try { got = await runShot(args) } finally {
    if (hideMe && control && !control.isDestroyed()) hadFocus ? control.show() : control.showInactive()
  }
  if (!got || !got.ok) {
    // Nothing was written, so the folder it would have gone in should not outlive it
    // in the library as an empty shot.
    if (!scratch) { try { fs.rmSync(path.join(resolvedSaveDir(), stem), { recursive: true, force: true }) } catch {} }
    return { ok: false, error: (got && got.error) || 'the shot was not written', kind }
  }
  if (scratch) return { ...got, ok: true, original: file, scratch: true, kind }
  return { ...got, ok: true, ...nameShot(file, stem, got, kind, by), dir }
}
ipcMain.handle('take-shot', (e, opts = {}) => takeShot(opts))

// A capture named from what it captured, the way a take is named from the app in
// front. A still has no transcript, so this is the only name it will ever get by
// itself, and shot-<epoch> is a timestamp nobody typed. An agent's capture is left
// alone here: the bridge names it, and it may have been handed a name to use.
// Returns { name, original }, whichever way the rename went.
function nameShot(file, stem, got, kind, by) {
  if (by === 'agent') return { name: stem, original: file }
  try {
    const naming = require('./ui/naming')
    const want = naming.shotName({ app: got.app, title: got.title, area: kind })
    if (!want || want === stem) return { name: stem, original: file }
    const P = require('./processor')
    const r = P.renameTake(file, want)
    // so a later naming knows this name was Fetch's and may still be improved
    try { P.writeNameNote(r.path, P.takeName(r.path), 'app', { front: { app: got.app, title: got.title } }) } catch {}
    agentBridge.noteMoves(r.moves)
    return { name: P.takeName(r.path), original: r.path }
  } catch (err) {
    console.warn('[shot] could not name the capture:', err.message)
    return { name: stem, original: file }
  }
}

// ---------- edit / post-production ----------
const proc = require('./processor')
proc.setTakesRoot(resolvedSaveDir)
// The one rename for a take: folder, files, sidecars and deliverable move together.
// The bridge remembers the moves, so a path an agent already holds keeps working.
ipcMain.handle('rename-take', (e, file, name) => {
  const r = proc.renameTake(file, name)
  agentBridge.noteMoves(r.moves)
  return r
})

// Names from the person's own agent (ui/take-namer.js): every finished take with
// speech, unless an agent gave it a name, and the Library's "Name these recordings".
// Renames go through the renderer's renameTake so the Library and editor follow.
const takeNamer = require('./ui/take-namer')
takeNamer.init({
  proc,
  getPrefs: loadPrefs,
  follow: p => agentBridge.follow(p),
  rename: (file, stem) => {
    if (!control || control.isDestroyed()) {
      const r = proc.renameTake(file, stem)
      agentBridge.noteMoves(r.moves)
      return Promise.resolve(r.path)
    }
    return control.webContents.executeJavaScript(`(async () => {
      const out = await renameTake(${JSON.stringify(file)}, ${JSON.stringify(stem)})
      refreshLibrary()
      return out
    })()`)
  },
  log: e => activity.record(e),
  // any queued job, or a process under a job id other than the namer's own transcription
  busy: () => {
    const q = jobQueue.stats()
    return q.heavy.active + q.heavy.queued + q.light.active + q.light.queued > 0 ||
      proc.runningJobs().some(id => !String(id).startsWith('name-'))
  },
})
ipcMain.on('take-finished', (e, info) => {
  if (info && info.file && !info.named) takeNamer.name(info.file).catch(() => {})
})
// The name nameTake in app.js just gave, and what was in front, so the take-namer
// can tell it from a name a person types later
ipcMain.handle('name-note', (e, file, front) => proc.writeNameNote(file, proc.takeName(file), 'app', front ? { front } : null))
ipcMain.handle('namer-engine', () => takeNamer.engine())
ipcMain.handle('name-takes', async (e, files, opts = {}) => {
  const out = []
  for (const f of files || []) out.push(await takeNamer.name(f, { local: true, upgrade: !!opts.upgrade }))
  return out
})
ipcMain.handle('name-takes-undo', (e, entries) => takeNamer.restore(entries))

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

// The sample library (ui/sample.js), while it is open: the Library, the agent's
// list_recordings and memory all read the sample and nothing of the person's. The renderer
// says where it is on the way in and clears it on the way out; a folder that no longer
// carries the sample's marker is never taken for it.
let sampleRoot = null
const sampleOpen = () => {
  try { return sampleRoot && require('./ui/sample').isSample(sampleRoot) ? sampleRoot : null } catch { return null }
}
ipcMain.handle('sample-root', (e, r) => {
  const was = sampleOpen()
  sampleRoot = r ? String(r) : null
  // the sample's rows in the activity log go with it (ui/activity-log.js)
  activity.sampleOpen(!!sampleRoot)
  // leaving: whatever an agent still has running on a sample take stops before the folder
  // goes, so a late export cannot write into a folder that is being deleted
  if (was && !sampleRoot) {
    try { if (agentBridge.stopSampleJobs) agentBridge.stopSampleJobs(was) } catch {}
  }
  return true
})
// The Guidelines card in Settings: the person reading and writing their products' rules
// (ui/guidelines.js). This is the person acting in Fetch itself, so what they write is in
// force at once and their Yes on a draft is the yes an agent can only ask for. While the
// sample is open its rules are the sample's, as an agent's are.
ipcMain.handle('guidelines', (e, args = {}) => {
  const G = require('./ui/guidelines'), Memory = require('./ui/memory')
  const root = sampleOpen() || app.getPath('userData')
  const product = args.product ? String(args.product).trim() : ''
  const at = { root, ...(product ? { product } : {}) }
  const known = () => {
    const seen = new Map()
    for (const f of Memory.read(root).facts) if (f.scope === 'product' && f.about) seen.set(Memory.slug(f.about), f.about)
    return [...seen.values()]
  }
  switch (args.action) {
    case 'products': return { products: known() }
    case 'read': return G.read(at)
    case 'write': return G.write(at, [{ rule: args.rule, section: args.section, from: 'person' }])
    // the person's Yes: shown to them in the card, so shown here, and adopted in the same breath
    case 'yes': {
      const shown = G.show(at, { ids: [args.id] })
      return G.adopt(at, { ids: [args.id], seal: shown.seal, ...(args.edit ? { edits: { [args.id]: args.edit } } : {}) })
    }
    case 'no': return G.reject(at, [args.id])
    case 'forget': return Memory.forget({ root, about: product }, { id: args.id })
    default: throw new Error('unknown guidelines action')
  }
})

// The projects @ can point at: every folder of code the person's tools know (Conductor,
// Orca, Claude Code), read by ui/projects.js on a worker thread and kept half a minute.
// Only names, paths, branches, remotes and the first lines of a README or agent notes.
// It goes to the chat's model when the person tags a project, and to an outside agent
// only after the person's yes (agent-bridge projectsAllowed); the chat's log keeps a
// tag's name, path, source and branch and never the description (ui/chat.js tagFor).
ipcMain.handle('list-projects', () => require('./ui/projects').projectIndexAsync().catch(() => []))

ipcMain.handle('list-recordings', () => {
  const s = sampleOpen()
  if (s) return require('./ui/sample').list(s, proc)
  tidySaveFolders()
  return proc.listRecordings()
})
ipcMain.handle('probe', (e, src) => proc.probeMeta(src))

// ---- the lasso: the person points at an area of their own video ----------
// The editor's rectangle snaps to what is really under it, and the chip it becomes is
// a target the agent can aim with by id. The same Elements pass find_on_screen uses,
// registered in the same place, so R1 and E7 resolve through one door.
// The crop the box was measured in. The editor sends the one its stage is drawing,
// because the document on disk is up to one autosave behind a crop drag (400 ms,
// ui/editor.js:591) and a box read in the wrong crop points at the wrong pixels.
const lassoCrop = async (src, sent) => {
  const meta = await proc.probeMeta(src).catch(() => ({}))
  const drawn = require('./ui/targets').cleanBox(sent)
  if (drawn) return { meta, crop: drawn.w >= 1 && drawn.h >= 1 ? null : drawn }
  const doc = proc.readDoc(src, meta && meta.duration)
  return { meta, crop: doc.crop && doc.crop.w > 0 ? doc.crop : null }
}
ipcMain.handle('lasso-elements', async (e, { path: src, at, crop: sent } = {}) => {
  try {
    const { crop } = await lassoCrop(src, sent)
    const r = await proc.findOnScreen(src, at, { crop, limit: 40 })
    // Fetch's own pass, for the band to snap against: its ids still resolve in
    // apply_edit, but a scrub with the lasso armed never renumbers the E ids the
    // agent is holding from its own find_on_screen
    const notes = agentBridge.noteFound(src, r.at, r.elements, r.all, { agent: false })
    return {
      at: r.at, width: r.width, height: r.height,
      elements: r.elements.map(el => ({
        id: el.id, kind: el.kind, text: el.text, box: el.box,
        ...(notes.has(el.id) ? { no_lift: notes.get(el.id).advice } : {}),
      })),
    }
  } catch (err) {
    // a frame that could not be read means no snapping, never a broken gesture
    console.warn('[lasso] no elements at', at, err && err.message)
    return { at: +at || 0, width: 0, height: 0, elements: [] }
  }
})

const REGION_KINDS = ['chip', 'card', 'panel', 'grid', 'icon', 'text', 'free']
ipcMain.handle('lasso-region', async (e, { path: src, at, box, element, kind, label, crop: sent } = {}) => {
  const T = require('./ui/targets')
  const b = T.cleanBox(box)
  if (!b || b.w < 0.02 || b.h < 0.02) throw new Error('that area is too small to work on')
  const { meta, crop } = await lassoCrop(src, sent)
  const r4 = n => Math.round(n * 10000) / 10000
  const c = crop || { x: 0, y: 0, w: 1, h: 1 }
  // where the area sits in the recording's own frame, before the crop: the fractions
  // frameAt takes, and the pixels the agent reads
  const sub = { x: c.x + c.w * b.x, y: c.y + c.h * b.y, w: c.w * b.w, h: c.h * b.h }
  const px = {
    x: Math.round(meta.width * sub.x), y: Math.round(meta.height * sub.y),
    w: Math.round(meta.width * sub.w), h: Math.round(meta.height * sub.h),
  }
  // frameAt's own name is keyed on the path and the time alone, so the Elements pass
  // for this same moment writes that very file. The picture is named before ffmpeg
  // runs rather than renamed after, because renaming afterwards races a pass that is
  // still reading it, and either the region gets the whole frame or the Elements
  // binary gets nothing.
  const shot = path.join(os.tmpdir(), `fetch-region-${path.parse(src).name}-${Date.now().toString(36)}.jpg`)
  const f = await proc.frameAt(src, at, 1600, sub, shot)
  const region = agentBridge.noteRegion(src, {
    id: null, path: src, at: f.at,
    box: { x: r4(b.x), y: r4(b.y), w: r4(b.w), h: r4(b.h) }, px,
    source: { width: meta.width, height: meta.height }, crop,
    element: element || null, kind: REGION_KINDS.includes(kind) ? kind : 'free',
    label: String(label || 'Area').slice(0, 40), image: f.file, made: Date.now(),
  })
  return region
})

ipcMain.handle('lasso-drop', (e, { path: src, id } = {}) => agentBridge.forgetRegion(src, id))
// The in-app chat. Runs on the person's own Claude Code or Codex, so events stream
// back from a real CLI rather than from any model Fetch talks to itself.
// Everything the pane shows is also written to userData/chat.jsonl, so the thread is
// still there after a restart (ui/chat-log.js).
//
// A project the message tagged, or named with an @ that answers to exactly one, is read
// before the turn starts: what runs from it now, which window a take of it would be,
// and the product its rules are kept under (agentBridge.projectTurn). That is the one
// await in front of a turn, bounded, and a Stop pressed during it starts nothing.
let chatPending = null
ipcMain.on('chat-send', async (e, payload) => {
  const d = (payload && payload.display) || {}
  // the lassoed areas ride with the message, so the chips are still on the bubble
  // after a restart
  chatLog.append({ kind: 'user', text: d.text || '', tags: d.tags || [], attachments: d.attachments || [], regions: d.regions || [] })
  const reply = ev => {
    chatLog.append(ev)
    try { e.sender.send('chat-event', ev) } catch {}
  }
  // a person sending a message is them letting the chat's agent go on, and only that one
  releaseAgent(true)
  const tagged = (d.tags || []).some(t => t && t.kind === 'project')
  if (tagged || /(^|\s)@[^\s@]/.test(d.text || '')) {
    const mine = chatPending = { cancelled: false }
    const block = await Promise.race([
      agentBridge.projectTurn(d.tags || [], d.text || '').catch(() => ''),
      new Promise(res => setTimeout(() => res(''), 8000)),
    ])
    if (chatPending === mine) chatPending = null
    if (mine.cancelled) { reply({ kind: 'done', ok: false, cancelled: true, ms: 0 }); return }
    if (block) payload = { ...payload, prompt: `${payload.prompt}\n\n${block}` }
  }
  try {
    agentChat.send(payload, reply)
    driveChanged()
  } catch (err) {
    reply({ kind: 'done', ok: false, error: err.message, ms: 0 })
  }
})
ipcMain.on('chat-cancel', () => { if (chatPending) chatPending.cancelled = true; agentChat.cancel() })
// A pasted image with no file behind it (a screenshot copied to the clipboard) gets
// one in the temp dir, so from here on every attachment is just a path.
ipcMain.handle('chat-attach-blob', (e, { bytes, type }) => {
  const ext = /png/.test(type) ? 'png' : /jpe?g/.test(type) ? 'jpg' : /gif/.test(type) ? 'gif' : /webp/.test(type) ? 'webp' : 'png'
  const out = path.join(os.tmpdir(), `fetch-paste-${Date.now()}.${ext}`)
  fs.writeFileSync(out, Buffer.from(bytes))
  return out
})
// A new chat never starts under a turn still running, or its last events would land
// in the fresh log.
ipcMain.handle('chat-new', () => {
  if (agentChat.busy()) return false
  agentChat.newConversation()
  return true
})
ipcMain.handle('chat-history', () => chatLog.read())

// Dictation for the chat composer. Runs through the transcriber already bundled in
// the app, so speaking a message is as local as typing one. The counterpart to the
// ElevenLabs panel: that one is the exception that uses the network, this one is not.
ipcMain.handle('dictate', async (e, buf) => {
  const tmp = path.join(os.tmpdir(), `fetch-dictate-${Date.now()}.webm`)
  try {
    fs.writeFileSync(tmp, Buffer.from(buf))
    const r = await proc.transcribe(tmp, { quick: true }, null, 'dictate')
    return { ok: true, text: (r.text || '').trim() }
  } catch (err) {
    return { ok: false, error: err.message }
  } finally {
    try { fs.unlinkSync(tmp) } catch {}
  }
})

// Voiceover, through the person's own ElevenLabs account. One of the two parts of
// Fetch that use the network, and the key lives in the Keychain (see ui/voice.js).
ipcMain.handle('voice-status', () => voice.status())
ipcMain.handle('voice-connect', (e, key) => voice.connect(key))
ipcMain.handle('voice-disconnect', () => voice.clearKey())
ipcMain.handle('voice-voices', () => voice.voices())
ipcMain.handle('voice-speak', async (e, { src, text, voiceId, settings }) => {
  const out = proc.sidecarOut(src, '.vo.mp3')
  const t0 = Date.now()
  try {
    await voice.speak({ text, voiceId, outPath: out, settings })
    activity.record({ op: 'voice.speak', title: 'Generated a voiceover',
      detail: `${String(text).length} characters`, ms: Date.now() - t0, ok: true })
    return { ok: true, file: out }
  } catch (err) {
    activity.record({ op: 'voice.speak', title: 'Generated a voiceover',
      ms: Date.now() - t0, ok: false, error: err.message })
    return { ok: false, error: err.message }
  }
})
// Photographs for the backdrop picker, through the person's own Unsplash key. The
// second and last part of Fetch that uses the network (ui/unsplash.js), and the key
// lives in the Keychain beside the voiceover's, never in prefs.json. Ten photographs
// ship with the app and need none of this: without a key every handler below still
// answers, and says in one sentence how to add one.
//
// A refusal is an answer, not an exception: the picker (ui/unsplash-picker.js) and
// Settings both read { ok: false, message }, so no key, no network and a key Unsplash
// will not take are all one sentence on screen.
ipcMain.handle('unsplash-status', () => unsplash.status())
ipcMain.handle('unsplash-connect', (e, key) => unsplash.connect(key))
ipcMain.handle('unsplash-disconnect', () => unsplash.disconnect())
ipcMain.handle('unsplash-search', (e, { query, page } = {}) => unsplash.search(query, { page }))
// The renderer sends back the whole result it was handed. use() looks the photo up by
// id among the results this client gave out and follows those URLs, not the renderer's,
// and an object it never gave out is checked host by host. So a compromised renderer
// cannot make Fetch download from anywhere it likes.
ipcMain.handle('unsplash-use', async (e, photo) => {
  const r = await unsplash.use(photo, { dir: proc.userBackdropDir() })
    .catch(err => ({ ok: false, reason: 'write', message: `That photo could not be saved: ${err.message}` }))
  activity.record({ op: 'backdrop.unsplash', title: 'Saved a photo from Unsplash',
    detail: r.ok && r.credit ? r.credit.text : null, ok: !!r.ok, error: r.ok ? null : r.message })
  return r
})

ipcMain.handle('chat-engines', async () => {
  const d = await require('./ui/agent-connect').detect()
  return d.clients.filter(c => c.installed && (c.id === 'claude' || c.id === 'codex'))
})
// What each installed CLI can run, for the model picker (ui/models.js).
ipcMain.handle('chat-models', (e, installed) => require('./ui/models').catalogue(installed))

// The activity log. Read by the Activity view; written from the bridge and from
// every job that finishes here.
ipcMain.handle('activity-read', (e, limit) => activity.read(limit || 300))
ipcMain.handle('activity-clear', () => { activity.clear(); return true })
// A restore from the history panel, logged beside the edits it undoes. Only what a log
// line holds is taken, so the renderer cannot write anything else into the file.
ipcMain.handle('activity-record', (e, x = {}) => activity.record({
  op: String(x.op || 'edit'), title: String(x.title || x.op || 'edit'), detail: x.detail == null ? null : String(x.detail),
  by: x.by == null ? null : String(x.by), ok: x.ok !== false }))

// The edit document, and the beats a recording is scrubbed by.
ipcMain.handle('read-doc', (e, src, dur) => proc.readDoc(src, dur))
// the recorded window's own margin and corner (corner as a fraction of the frame's
// width), so the stage trims and rounds a framed take as the export does
ipcMain.handle('frame-gutter', (e, src, dur, crop) => proc.frameGutter(src, 0, dur || 1, crop || null).catch(() => null))
// What the take's pixels say for an edit, for the editor's stage: the same cached work
// the export reads (ui/compositor/prepare.js)
ipcMain.handle('render-prepare', (e, src, opts) => require('./ui/compositor/prepare').prepareRender(src, opts || {}))
ipcMain.handle('write-doc', (e, src, doc) => proc.writeDoc(src, doc))
// The same two for a shot. A capture says its size rather than its length, so the
// read takes { w, h } where a take's takes a duration.
ipcMain.handle('read-shot', (e, src, size) => proc.readShot(src, size))
ipcMain.handle('write-shot', (e, src, shot) => proc.writeShot(src, shot))
ipcMain.handle('beats-for', (e, src, dur) => proc.beatsFor(src, dur))

ipcMain.handle('read-cues', (e, src) => proc.readCues(src))
ipcMain.handle('write-cues', (e, src, cues) => proc.writeCues(src, cues))
ipcMain.handle('cancel-job', (e, id) => {
  // A job waiting in the queue has no child process to kill yet, so drop it from the
  // lane; otherwise cancelling something tenth in line would wait for the nine ahead.
  // A job sent with its own jobId runs as ext:<jobId> (edit-job namespaces it), so the
  // editor's Cancel, which knows only its jobId, has to be looked up the same way.
  // One path for a person's cancel and an agent's: the queue stops a job queued or
  // running by its own id (its work's stop hooks included), then the processor's children.
  const queued = jobQueue.cancel(id) || jobQueue.cancel('ext:' + id)
  return proc.cancel(id) || proc.cancel('ext:' + id) || queued
})
ipcMain.handle('queue-stats', () => jobQueue.stats())
ipcMain.handle('formats', () => proc.formatList())
// the export modal says where the file goes, and whether it replaces one
ipcMain.handle('export-dest', (e, src, fmt) => {
  const f = proc.formatList().find(x => x.id === fmt)
  const file = proc.exportDest(src, f ? fmt : 'mp4')
  return { file, exists: fs.existsSync(file), take: !!proc.takeDir(src) }
})
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

// Work that finished here, whoever asked for it. A job carrying an external jobId
// arrived over the socket, so it belongs to an agent; anything else was a person
// pressing a button, and those entries deliberately carry no `by`. A log that showed
// only agent activity could not tell you whether the cut in front of you was yours.
const JOB_TITLES = {
  export: 'Exported a video', mp4: 'Converted to MP4', convert: 'Converted a recording',
  silence: 'Removed dead air', enhance: 'Cleaned up the audio', trim: 'Trimmed a recording',
  captions: 'Burned in captions', gif: 'Made a GIF', transcribe: 'Transcribed a recording',
}
// Thumbnails, waveforms and filmstrips are how the UI draws itself rather than things
// anyone did, and logging them would bury everything that matters.
const JOB_QUIET = new Set(['thumb', 'waveform', 'filmstrip'])

// Which renderer drew an export, for its Activity row: the compositor with its speed, or
// the classic ffmpeg renderer and what sent it there
function engineNote(r) {
  if (r.engine === 'gl') return `compositor${r.render && r.render.realtime ? `, ${r.render.realtime}x real time` : ''}`
  return `classic renderer${r.why && r.why.length ? ` (${r.why.join(', ')})` : ''}`
}

function logJob(payload, t0, result, error) {
  if (JOB_QUIET.has(payload.op)) return
  let detail = (result && result.file) || payload.src || null
  if (payload.op === 'silence' && result) detail = `kept ${result.cuts} segments, saved ${result.savedPct}%`
  if (payload.op === 'transcribe' && result) detail = `${result.words} words, ${(result.cues || []).length} cues`
  if (payload.op === 'export' && result && result.engine) detail = `${detail} · ${engineNote(result)}`
  activity.record({
    op: payload.op,
    title: JOB_TITLES[payload.op] || payload.op,
    detail,
    by: payload.jobId != null ? 'Agent' : null,
    ms: Date.now() - t0,
    ok: !error,
    error,
  })
}

ipcMain.handle('edit-job', async (e, payload) => {
  // Namespace caller-supplied ids. processor.cancel() keys off this, so a renderer
  // job and an agent job sharing a number would cancel each other.
  const id = payload.jobId != null ? `ext:${payload.jobId}` : ++jobSeq
  const t0 = Date.now()
  const cid = payload.cid
  const wc = e.sender
  const send = (status, extra) => { if (!wc.isDestroyed()) wc.send('edit-job', { id, cid, status, ...extra }) }
  const onP = (secs, total, pct) => send('progress', { secs, total, pct })

  jobsActive++
  updater.setJobsActive(jobsActive)
  try {
    try {
      send('queued', { id })
      return await jobQueue.submit({ id, op: payload.op, onStart: () => send('running', { id }), run: async () => {
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
        case 'export':     result = await require('./ui/render-host').exportEdit(payload.src, o, onP, id); break
        // A shot is drawn from the same plan an export is, and lands where an export
        // lands: beside its Original, named after the folder.
        case 'shot': {
          const out = payload.out || {}
          const fmt = (out.format || 'png').toLowerCase() === 'png' ? 'png' : 'jpg'
          result = await require('./ui/render-host').renderShot(payload.src, o,
            { ...out, dest: out.dest || proc.exportDest(payload.src, fmt) }, id)
          break
        }
        case 'transcribe':
          result = await proc.transcribe(payload.src, o,
            (pct, isDownload) => send('progress', isDownload ? { downloadPct: pct } : { pct }), id)
          break
        default: throw new Error('unknown op ' + payload.op)
      }
      send('done', { result })
      logJob(payload, t0, result, null)
      return { ok: true, ...result }
      } })
    } catch (err) {
      if (err && err.cancelled) { send('cancelled', {}); return { ok: false, cancelled: true } }
      send('error', { message: String(err.message || err) })
      logJob(payload, t0, null, String(err.message || err))
      return { ok: false, error: String(err.message || err) }
    }
  } finally {
    jobsActive--
    updater.setJobsActive(jobsActive)
  }
})


app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => {
  // a dev server Fetch started to record a project is Fetch's to stop: one left running
  // is a port somebody has to go and hunt for after the app is gone
  if (agentBridge.stopStartedServers) try { agentBridge.stopStartedServers() } catch {}
  agentBridge.stop(); require('./ui/render-host').close()
})
// The editor opening a take is the moment an export becomes likely: start the hidden
// render window now so the first export does not wait for it
ipcMain.on('render-warm', () => require('./ui/render-host').warm())
