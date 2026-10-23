// Parking the camera take beside the finished recording. Loads main.js under a stub
// electron and drives the real 'cam-record' and 'save' handlers.
//
// The bug this pins: AVFoundation writes a movie's moov atom last, while stopRecording
// runs, and a camera take is hundreds of megabytes. parkCamTake used to wait for the
// file's size to stop changing and then copy it regardless, which copies a movie that
// has no moov atom and that every decoder refuses. It then deleted the source, so the
// only copy that would ever have become playable was gone. On screen the recording was
// fine and the face was simply missing in the editor, with nothing reporting an error.
const Module = require('module'), path = require('path'), os = require('os'), fs = require('fs')
const ROOT = path.join(__dirname, '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-camtake-'))
process.env.HOME = tmp
process.env.FETCH_CAM_FINISH_MS = '500'      // a missing finish signal, without a 30 s wait
const ipcOn = new Map(), ipcHandle = new Map()
const js = []                       // every executeJavaScript string, so toasts are visible
let readyFns = []
const noop = () => {}
class Win { constructor() { this.webContents = { send: noop, once: noop, on: noop, executeJavaScript: async s => { js.push(s) } } }
  isDestroyed() { return false } loadFile() {} on() {} once() {} show() {} hide() {} showInactive() {} focus() {} setAlwaysOnTop() {}
  setVisibleOnAllWorkspaces() {} setContentProtection() {} setIgnoreMouseEvents() {} setBounds() {} getBounds() { return { x: 0, y: 0, width: 1, height: 1 } } destroy() {} }
const display = { bounds: { x: 0, y: 0, width: 1512, height: 982 }, workArea: { x: 0, y: 0, width: 1512, height: 982 } }
const electron = {
  app: { setPath: noop, getPath: () => tmp, whenReady: () => ({ then: fn => { readyFns.push(fn) } }), on: noop, quit: noop,
    isReady: () => true, isPackaged: true, getVersion: () => '0', dock: { hide: noop, show: noop }, requestSingleInstanceLock: () => true,
    setAboutPanelOptions: noop, commandLine: { appendSwitch: noop, hasSwitch: () => false } },
  BrowserWindow: Win, desktopCapturer: {}, session: { defaultSession: { setPermissionCheckHandler: noop, setDisplayMediaRequestHandler: noop, setPermissionRequestHandler: noop } },
  ipcMain: { on: (c, f) => ipcOn.set(c, f), handle: (c, f) => ipcHandle.set(c, f), removeHandler: noop },
  dialog: {}, screen: { getAllDisplays: () => [display], getPrimaryDisplay: () => display, on: noop },
  shell: {}, systemPreferences: { getMediaAccessStatus: () => 'granted' },
  globalShortcut: { register: () => true, isRegistered: () => false, unregister: noop, unregisterAll: noop },
  Tray: class { setToolTip() {} setContextMenu() {} setImage() {} on() {} },
  Menu: { buildFromTemplate: t => ({ template: t }), setApplicationMenu: noop },
  nativeImage: { createFromPath: () => ({ isEmpty: () => false, setTemplateImage: noop }), createFromNamedImage: () => ({}) },
}
const load = Module._load
Module._load = function (req, parent, ...r) {
  if (req === 'electron') return electron
  if (req === 'electron-updater') return { autoUpdater: { on: noop, checkForUpdates: async () => {} } }
  return load.call(this, req, parent, ...r)
}
// nothing opens a socket, launches a helper or shells out: only the park path is under test
const bridge = require(path.join(ROOT, 'ui/agent-bridge')); bridge.start = noop
const cp = require('child_process')
cp.spawn = () => ({ on: noop, unref: noop, stdout: { on: noop }, stderr: { on: noop } })
cp.execFile = (a, b, cb) => { if (typeof cb === 'function') cb(new Error('no shell under test')) }
for (const h of ['telemetry', 'updater', 'simctl', 'agent-connect']) {
  try { const m = require(path.join(ROOT, 'ui', h)); for (const k of Object.keys(m)) if (typeof m[k] === 'function') m[k] = () => Promise.resolve({}) } catch {}
}
require(path.join(ROOT, 'main.js'))
for (const f of readyFns) { try { f() } catch {} }

let pass = 0, fail = 0
const is = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); ok ? pass++ : fail++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`) }

const stateFile = path.join(tmp, '.cambubble.json')
const side = (file, ext) => path.join(path.dirname(file), '.fetch', path.basename(file).replace(/\.[^.]+$/, '') + ext)

// Roll a camera take and hand back the temp paths the bubble was told to write to.
// 'cam-record' is how the renderer starts one, and it puts the path in the state file.
function roll() {
  ipcOn.get('cam-record')(null, true, Date.now())
  const out = JSON.parse(fs.readFileSync(stateFile, 'utf8')).out
  const stem = out.replace(/\.[^.]+$/, '')
  fs.writeFileSync(out, Buffer.alloc(2 << 20, 7))              // a take big enough to still be finalising
  fs.writeFileSync(stem + '.start.json', JSON.stringify({
    startedAt: Date.now() - 1686, size: 222, x: 1234, y: 647, screenW: 1512, screenH: 982 }))
  return { out, done: stem + '.done.json' }
}
const save = async () => ipcHandle.get('save')(null, Buffer.from([1, 2, 3]))

;(async () => {
  // 1. The camera never reported a finished take. The bytes on disk have no moov atom,
  //    so they must not be passed off as the take, and must not be destroyed either.
  {
    const { out } = roll()
    js.length = 0
    const file = await save()
    is('with no finish signal, no camera take is parked', fs.existsSync(side(file, '.cam.mov')), false)
    is('and no sidecar claims there is one', fs.existsSync(side(file, '.cam.json')), false)
    is('and the unfinished take is kept, not deleted', fs.existsSync(out), true)
    is('and it says so', js.some(s => /toast\(/.test(s) && /camera/i.test(s)), true)
  }

  // 2. The camera reported a finished take, which is the only moment the movie is
  //    playable. Now it may be parked, and the temp file cleaned up.
  {
    const { out, done } = roll()
    fs.writeFileSync(done, JSON.stringify({ finishedAt: Date.now(), bytes: 2 << 20 }))
    js.length = 0
    const file = await save()
    is('a finished take is parked beside the recording', fs.existsSync(side(file, '.cam.mov')), true)
    is('with every byte of it', fs.existsSync(side(file, '.cam.mov')) && fs.statSync(side(file, '.cam.mov')).size, 2 << 20)
    is('the temp take is cleaned up', fs.existsSync(out), false)
    is('and nothing is reported wrong', js.some(s => /toast\(/.test(s) && /camera/i.test(s)), false)
    const j = JSON.parse(fs.readFileSync(side(file, '.cam.json'), 'utf8'))
    is('the sidecar points at the parked take', j.file, side(file, '.cam.mov'))
    is('and carries the two clocks, so the editor can line them up', [typeof j.camStartedAt, typeof j.screenStartedAt], ['number', 'number'])
    is('and where the bubble sat', [j.bubbleSize, j.bubbleX, j.bubbleY], [222, 1234, 647])
  }

  // 3. The camera reported an error. Same rule as 1: say so, keep what is there.
  {
    const { out, done } = roll()
    fs.writeFileSync(done, JSON.stringify({ finishedAt: Date.now(), error: 'the session stopped' }))
    js.length = 0
    const file = await save()
    is('a take that finished with an error is not parked', fs.existsSync(side(file, '.cam.mov')), false)
    is('and is kept for recovery', fs.existsSync(out), true)
    is('and the error is reported', js.some(s => /toast\(/.test(s) && /camera/i.test(s)), true)
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
  process.exit(fail ? 1 : 0)
})()
