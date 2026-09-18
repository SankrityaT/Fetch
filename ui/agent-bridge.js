// Agent bridge. Main-process module, required from main.js.
//
// This is the socket an MCP server talks to. It deliberately does NOT expose the
// recorder directly, for two reasons that are both load-bearing:
//
// 1. macOS attributes screen-recording permission to the responsible process. If an
//    agent's CLI spawned the recorder itself, the user would have to grant Claude
//    Code or Codex screen recording. Routing through the running app keeps the
//    permission where it belongs, on Fetch.
//
// 2. Recording is renderer-driven. The red border, the floating HUD, the tray state,
//    the cursor track and the camera take are all downstream of the renderer's
//    rec-state. Calling native-start straight from here would produce a recording
//    with none of them, including no visible sign that an agent is recording your
//    screen. So this re-enters at exactly the point the tray and global shortcuts
//    use: hotkey().
//
// Transport is a unix socket under userData rather than a TCP port: nothing is
// exposed on localhost, there is no port to collide, and filesystem permissions are
// the authentication. Protocol is newline-delimited JSON, one object per line.
//
//   -> {"id":"1","op":"record.start","args":{...}}
//   <- {"id":"1","ok":true,"result":{...}}
//   <- {"id":"1","ok":false,"error":"..."}

const fs = require('fs')
const net = require('net')
const path = require('path')

let app, ipcMain
try { ({ app, ipcMain } = require('electron')) } catch {}

const VERSION = 1
let server = null
let deps = {}                  // { getWindow, toRenderer, proc, isRecording }

// One take at a time, matching the recorder's own mutex.
let pendingTake = null         // { resolve, reject, timer }

function socketPath() {
  const dir = app ? app.getPath('userData') : require('os').tmpdir()
  try { fs.mkdirSync(dir, { recursive: true }) } catch {}
  return path.join(dir, 'agent.sock')
}

// ---------- ops ----------
const ops = {
  async ping() {
    return { version: VERSION, app: app ? app.getVersion() : '0', recording: deps.isRecording() }
  },

  async 'record.status'() {
    return { recording: deps.isRecording(), pending: !!pendingTake }
  },

  // Starts a take through the renderer so every visible affordance still happens.
  // Resolves only when the file exists, which is what a caller actually needs.
  async 'record.start'(args = {}) {
    if (deps.isRecording()) throw new Error('already recording')
    if (pendingTake) throw new Error('a take is already being awaited')

    const win = deps.getWindow()
    if (!win || win.isDestroyed()) throw new Error('Fetch is not running')

    await applySetup(win, args)
    deps.toRenderer('start')

    // The renderer counts down before it captures, so allow for that plus a margin.
    return await new Promise((resolve, reject) => {
      pendingTake = {
        resolve, reject,
        timer: setTimeout(() => {
          pendingTake = null
          reject(new Error('the recording did not start in time'))
        }, 30000),
      }
    })
  },

  async 'record.stop'() {
    if (!deps.isRecording()) throw new Error('not recording')
    deps.toRenderer('stop')
    // The take resolves through take-finished, which record.start is already waiting
    // on. Callers that started the take get the path there; this just acknowledges.
    return { stopping: true }
  },

  async 'record.pause'() {
    if (!deps.isRecording()) throw new Error('not recording')
    deps.toRenderer('pause')
    return { toggled: true }
  },

  async 'recordings.list'() {
    // Through the app, never through processor directly: listRecordings falls back to
    // a different, empty library index outside Electron and ignores the saveDir pref.
    const list = deps.proc.listRecordings()
    return list.map(c => ({ path: c.path, name: c.name, mb: c.mb, kind: c.kind, srt: c.srt }))
  },

  async probe(args = {}) {
    if (!args.path) throw new Error('path is required')
    return await deps.proc.probeMeta(args.path)
  },

  async transcribe(args = {}) {
    if (!args.path) throw new Error('path is required')
    const r = await deps.proc.transcribe(args.path, {}, null, 'agent:transcribe')
    // Paths and counts, not payloads: a long transcript inline is thousands of tokens
    // of an agent's context for no benefit. The text is opt-in.
    const out = { srt: r.srt, txt: r.file, words: r.words, cues: (r.cues || []).length }
    if (args.include_text) out.text = r.text
    return out
  },
}

// Point the renderer's setup at what was asked for, reusing the same state the UI
// drives. Anything unspecified keeps the user's saved preference.
async function applySetup(win, args) {
  const wanted = {
    display: args.display != null ? String(args.display) : null,
    window: args.window != null ? String(args.window) : null,
    mic: typeof args.mic === 'boolean' ? args.mic : null,
    systemAudio: typeof args.system_audio === 'boolean' ? args.system_audio : null,
    camera: typeof args.camera === 'boolean' ? args.camera : null,
  }
  const js = `(async () => {
    const w = ${JSON.stringify(wanted)}
    if (w.mic !== null) setup.mic = w.mic
    if (w.systemAudio !== null) setup.sys = w.systemAudio
    if (w.camera !== null) setup.cam = w.camera
    if (w.window) {
      const list = await ipcRenderer.invoke('list-windows')
      const hit = (list || []).find(x => String(x.id) === w.window)
      if (!hit) throw new Error('no window with id ' + w.window)
      setup.mode = 'window'; setup.window = hit
    } else {
      const srcs = await ipcRenderer.invoke('get-sources')
      const screens = srcs.filter(s => s.isScreen)
      const hit = w.display ? screens.find(s => s.id.includes(':' + w.display + ':')) : screens[0]
      if (!hit) throw new Error('no display with id ' + w.display)
      setup.mode = 'screen'; setup.source = hit
    }
    applySetup()
    return true
  })()`
  await win.webContents.executeJavaScript(js)
}

// ---------- wire ----------
function handleLine(sock, line) {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  const id = msg && msg.id
  const reply = obj => { try { sock.write(JSON.stringify({ id, ...obj }) + '\n') } catch {} }

  const fn = ops[msg && msg.op]
  if (!fn) return reply({ ok: false, error: `unknown op: ${msg && msg.op}` })

  Promise.resolve()
    .then(() => fn(msg.args || {}))
    .then(result => reply({ ok: true, result }))
    .catch(err => reply({ ok: false, error: err && err.message ? err.message : String(err) }))
}

function start(d) {
  deps = d
  if (server) return

  // A take can finish because an agent asked for it or because someone pressed the
  // button. Either way the waiter is resolved once and cleared.
  if (ipcMain) {
    ipcMain.on('take-finished', (e, info) => {
      if (!pendingTake) return
      clearTimeout(pendingTake.timer)
      const p = pendingTake; pendingTake = null
      p.resolve({ path: info && info.file, mb: info && info.mb })
    })
    ipcMain.on('take-failed', (e, info) => {
      if (!pendingTake) return
      clearTimeout(pendingTake.timer)
      const p = pendingTake; pendingTake = null
      p.reject(new Error((info && info.error) || 'the take failed'))
    })
  }

  const sp = socketPath()
  try { fs.unlinkSync(sp) } catch {}          // a stale socket from a crash blocks bind

  server = net.createServer(sock => {
    sock.setEncoding('utf8')
    let buf = ''
    sock.on('data', chunk => {
      buf += chunk
      if (buf.length > 1e6) { buf = ''; sock.destroy(); return }   // no unbounded growth
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1)
        if (line.trim()) handleLine(sock, line)
      }
    })
    sock.on('error', () => {})
  })
  server.on('error', err => console.error('agent bridge:', err.message))
  server.listen(sp, () => {
    try { fs.chmodSync(sp, 0o600) } catch {}   // this socket can record the screen
    console.log('agent bridge listening at', sp)
  })
}

function stop() {
  if (!server) return
  try { server.close() } catch {}
  try { fs.unlinkSync(socketPath()) } catch {}
  server = null
}

module.exports = { start, stop, socketPath, VERSION }
