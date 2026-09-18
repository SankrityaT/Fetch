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
const policy = require('./record-policy')
const activity = require('./activity-log')

let app, ipcMain
try { ({ app, ipcMain } = require('electron')) } catch {}

const VERSION = 1
let server = null
let deps = {}                  // { getWindow, toRenderer, proc, isRecording }

// One take at a time, matching the recorder's own mutex.
// A take an agent started goes through two waits, each resolved once: `starting`
// until capture begins (after the countdown), `stopping` until the file is written.
// It used to be one wait that resolved only when the take finished, under a 30 second
// "did not start" timer that was never cleared on start, so any agent take longer
// than 30 seconds reported an error to the agent while it was still recording.
let pendingTake = null         // { phase: 'starting'|'recording'|'stopping', resolve, reject, timer }
// A take that ended on its own (the window closed) with nobody waiting on it. The
// agent that started it learns its path from the record_stop it sends next.
let endedTake = null
// When a take ended on its own and is still being saved, so a record_stop in that
// second waits for the path instead of hearing "not recording".
let endingAt = 0

function socketPath() {
  const dir = app ? app.getPath('userData') : require('os').tmpdir()
  try { fs.mkdirSync(dir, { recursive: true }) } catch {}
  return path.join(dir, 'agent.sock')
}

// ---------- ops ----------
// Human-readable titles. The log is read by a person, so "Recorded a window" beats
// "record.start ok". Ops with no entry here are still logged, under their own name.
const TITLES = {
  'record.start': 'Started recording',
  'record.stop': 'Stopped recording',
  'record.pause': 'Paused recording',
  'record.pointer': 'Moved its pointer',
  'windows.list': 'Looked at open windows',
  'displays.list': 'Looked at displays',
  'recordings.list': 'Listed recordings',
  probe: 'Read a file\'s details',
  transcribe: 'Transcribed a recording',
  'edit.get': 'Read an edit',
  'edit.apply': 'Changed an edit',
  'edit.beats': 'Read the beats',
  'edit.export': 'Exported a video',
  'recordings.rename': 'Renamed a recording',
  'edit.silence': 'Removed dead air',
  frame: 'Looked at a frame',
  'edit.enhance': 'Cleaned up the audio',
  'settings.set': 'Changed settings',
  'recordings.trash': 'Moved a recording to the Trash',
}

const { AGENT_PREFS, HUMAN_ONLY_PREFS } = policy

const ops = {
  // Sent once by the shim so the log can say which agent is driving rather than
  // just "an agent". Unknown to older shims, which simply never call it.
  async hello(args = {}, ctx) {
    if (ctx) ctx.client = String(args.client || '').slice(0, 40) || null
    return { ok: true }
  },

  async ping() {
    return { version: VERSION, app: app ? app.getVersion() : '0', recording: deps.isRecording() }
  },

  async 'record.status'() {
    const ended = !deps.isRecording() && endedTake ? { ended: { path: endedTake.path, stopped_early: endedTake.stopped_early } } : {}
    return { recording: deps.isRecording(), pending: !!pendingTake, ...ended }
  },

  // Starts a take through the renderer so every visible affordance still happens.
  // Resolves only when the file exists, which is what a caller actually needs.
  async 'record.start'(args = {}, ctx) {
    if (deps.isRecording()) throw new Error('already recording')
    if (pendingTake) throw new Error('a take is already being awaited')
    endedTake = null; endingAt = 0

    const win = deps.getWindow()
    if (!win || win.isDestroyed()) throw new Error('Fetch is not running')

    // Access check before anything starts. This is the enforcement point: the rule
    // lives here rather than in the MCP tool description, because a description is
    // prose and prose is a suggestion.
    await enforceAccess(args, ctx)

    // macOS sends no frames for the part of a window another covers, so a take of a
    // covered window is a frozen picture. Say so before recording anything, with the
    // way round it, rather than hand back a take of stale frames (occludedTake).
    if (args.window != null && !args.allow_covered && deps.windowCovered) {
      const hold = occludedTake(await deps.windowCovered(args.window).catch(() => null))
      if (hold) return hold
    }

    await applySetup(win, args)
    // In the background unless the person asked to watch (a person-only setting).
    const quiet = !(deps.getPrefs && deps.getPrefs().agentTakesVisible)
    if (deps.setQuiet) deps.setQuiet(quiet, true)
    await win.webContents.executeJavaScript(`window.__quietTake = ${quiet}`)
    deps.toRenderer('start')

    // The renderer counts down before it captures, so allow for that plus a margin.
    return await new Promise((resolve, reject) => {
      pendingTake = {
        phase: 'starting', resolve, reject,
        timer: setTimeout(() => {
          pendingTake = null
          reject(new Error('the recording did not start in time'))
        }, 30000),
      }
    })
  },

  async 'record.stop'() {
    if (!deps.isRecording() && endedTake && Date.now() - endedTake.at < 30 * 60e3) {
      const { at, ...r } = endedTake; endedTake = null
      return r
    }
    const ending = !deps.isRecording() && endingAt && Date.now() - endingAt < 2 * 60e3
    if (!deps.isRecording() && !ending) throw new Error('not recording')
    // Returns the finished file. A take started by a person has no waiter, so one is
    // made here; either way stop answers with the path once it is on disk.
    const done = new Promise((resolve, reject) => {
      if (pendingTake) clearTimeout(pendingTake.timer)
      pendingTake = {
        phase: 'stopping', resolve, reject,
        timer: setTimeout(() => {
          pendingTake = null
          reject(new Error('the recording did not finish saving in time'))
        }, 120000),
      }
    })
    if (!ending) deps.toRenderer('stop')
    return await done
  },

  // Where the agent's own pointer is, during its take. The take has no Mac pointer in
  // it (native-start records agent takes with --no-cursor), so this is the only cursor
  // the video will show. Stamped on the take's clock in main.js, which also shows it
  // live over the recorded window (agent-cursor.html). Neither moves the Mac's pointer.
  async 'record.pointer'(args = {}) {
    if (!deps.pointer) throw new Error('this version of Fetch cannot draw a pointer')
    return deps.pointer(args)
  },

  async 'record.pause'() {
    if (!deps.isRecording()) throw new Error('not recording')
    deps.toRenderer('pause')
    return { toggled: true }
  },

  // Discovery. Without these an agent cannot target anything: record.start takes a
  // window or display id and had no way to find one, so the only reachable behaviour
  // was "record the main display". Driving a browser or a Simulator and then
  // recording that window needs this.
  //
  // Icons are stripped. The helper attaches a ~20KB base64 PNG per window, which for
  // a typical desktop is most of a megabyte of base64 in the agent's context for no
  // benefit, and this server's rule is paths and summaries rather than payloads.
  async 'windows.list'() {
    const list = await deps.listWindows()
    return (list || [])
      .filter(w => w.width > 120 && w.height > 120)   // drop tooltips and shadow panes
      .map(w => ({ id: w.id, app: w.app, title: w.title, width: w.width, height: w.height }))
  },

  async 'displays.list'() {
    const { screen } = require('electron')
    const primary = screen.getPrimaryDisplay().id
    return screen.getAllDisplays().map(d => ({
      id: String(d.id),
      primary: d.id === primary,
      width: d.size.width,
      height: d.size.height,
      scale: d.scaleFactor,
    }))
  },

  // ── editing ────────────────────────────────────────────────────────────
  // The same document the editor drives, so an agent working over MCP and a person
  // working in the window are changing one thing, not two. Every change is written to
  // the recording's .fetchdoc.json, so it survives the app closing and is what the
  // next export reads.
  async 'edit.get'(args = {}) {
    if (!args.path) throw new Error('path is required')
    const doc = await inEditor(args.path, 'window.fetchDoc.get()')
    deps.proc.writeDoc(args.path, doc)
    const out = summarise(doc, args.path)
    // The words themselves only on request: a long transcript is thousands of tokens,
    // but correcting what the recogniser misheard needs them.
    if (args.include_cues) out.captions.cues = (doc.cues || []).map(c => ({ id: c.id, start: c.start, end: c.end, text: c.text }))
    // likewise the pointer track, which is hundreds of points on a long take
    if (args.include_pointer) out.pointer.track = pointerTrack(args.path, doc)
    return out
  },

  async 'edit.apply'(args = {}) {
    if (!args.path) throw new Error('path is required')
    if (!args.doc || typeof args.doc !== 'object') throw new Error('doc is required')
    const doc = await inEditor(args.path, `window.fetchDoc.apply(${JSON.stringify(args.doc)})`)
    deps.proc.writeDoc(args.path, doc)
    return summarise(doc, args.path)
  },

  // Renders the recording's current edit, exactly what the editor's Export would.
  // Reads the saved document rather than asking the window, so it works whether or
  // not the clip is open, which is the point of doing it without the app.
  async 'edit.export'(args = {}) {
    if (!args.path) throw new Error('path is required')
    const FD = require('./fetchdoc')
    const meta = await deps.proc.probeMeta(args.path).catch(() => ({}))
    const doc = deps.proc.readDoc(args.path, meta && meta.duration)
    if (!doc.clips.length) {
      // a recording nobody has edited has no clips yet; export all of it
      doc.clips = [{ id: 'C1', start: 0, end: (meta && meta.duration) || doc.dur }]
    }
    const opts = FD.toExportOpts(doc, {
      format: args.format || 'mp4',
      quality: args.quality || 'balanced',
      scale: args.resolution ? +args.resolution : undefined,
    })
    const r = await deps.exportDoc(args.path, opts)
    const mb = r && r.file && require('fs').existsSync(r.file)
      ? +(require('fs').statSync(r.file).size / 1e6).toFixed(1) : null
    return { path: r && r.file, mb, seconds: +FD.outDuration(doc).toFixed(2) }
  },

  // Rename through the same helper the Library uses, so sidecars (transcript, beats,
  // camera take, edit document) move with the file and the take stays in the Library.
  // A name is cleaned of anything that could turn it into a path.
  // ── the rest of what a person can do ─────────────────────────────────
  async frame(args = {}) {
    if (!args.path) throw new Error('path is required')
    if (!fs.existsSync(args.path)) throw new Error('no such file')
    let crop = null
    if (args.cropped) {
      const meta = await deps.proc.probeMeta(args.path).catch(() => ({}))
      crop = deps.proc.readDoc(args.path, meta && meta.duration).crop || null
    }
    const r = await deps.proc.frameAt(args.path, args.at, 1280, crop)
    return { image: r.file, at: r.at, source_width: r.width, source_height: r.height, cropped: !!crop }
  },

  async 'edit.silence'(args = {}) {
    if (!args.path) throw new Error('path is required')
    const r = await deps.runOp('silence', args.path, {
      minSilence: args.min_silence, pad: args.padding,
    })
    return { path: r.file, removed_percent: r.savedPct, kept_segments: r.cuts, seconds: r.duration }
  },

  async 'edit.enhance'(args = {}) {
    if (!args.path) throw new Error('path is required')
    const r = await deps.runOp('enhance', args.path, {})
    return { path: r.file }
  },

  // Settings an agent may read and change. Consent settings are refused in code
  // (record-policy.js), not left to a tool description asking nicely.
  async 'settings.get'() {
    const p = deps.getPrefs ? deps.getPrefs() : {}
    const out = {}
    for (const k of AGENT_PREFS) if (k in p) out[k] = p[k]
    out.human_only = HUMAN_ONLY_PREFS
    return out
  },

  async 'settings.set'(args = {}) {
    const clean = policy.checkSettingsPatch(args.settings, d => {
      try { return fs.statSync(d).isDirectory() } catch { return false }
    })
    deps.setPrefs(clean)
    return await ops['settings.get']()
  },

  // To the Trash, with Finder's Put Back, never a permanent delete. An agent should not
  // be able to do something to a recording that a person cannot undo.
  async 'recordings.trash'(args = {}) {
    if (!args.path) throw new Error('path is required')
    if (!fs.existsSync(args.path)) throw new Error('no such recording')
    const { shell } = require('electron')
    const refresh = () => {
      const win = deps.getWindow()
      if (win && !win.isDestroyed()) win.webContents.executeJavaScript('refreshLibrary()').catch(() => {})
    }
    // A take folder goes as a whole when given its raw take or its deliverable. A
    // working version (-cut, -audio, ...) inside it goes on its own.
    const take = deps.proc.takeDir(args.path)
    const stem = path.parse(args.path).name
    const working = take && stem !== path.basename(take) && /-(edit|cut|audio|trim|captions|converted|gif)$/.test(stem)
    if (take && !working) {
      await shell.trashItem(take)
      refresh()
      return { trashed: take, folder: true, recoverable: true }
    }
    const side = ['.png', '.srt', '.txt', '.cursor.json', '.pointer.json', '.cam.json', '.cam.mov', '.words.json', '.fetchdoc.json', '.vo.mp3']
      .map(e => deps.proc.sidecarIn(args.path, e)).filter(f => f !== args.path && fs.existsSync(f))
    for (const f of [args.path, ...side]) await shell.trashItem(f)
    refresh()
    return { trashed: args.path, with_sidecars: side.length, recoverable: true }
  },

  async 'recordings.rename'(args = {}) {
    if (!args.path) throw new Error('path is required')
    const naming = require('./naming')
    const stem = naming.fit(naming.clean(args.name || ''))
    if (!stem) throw new Error('name is empty once cleaned')
    const win = deps.getWindow()
    if (!win || win.isDestroyed()) throw new Error('Fetch is not running')
    if (!fs.existsSync(args.path)) throw new Error('no such recording')
    // through the renderer's renameTake, so the Library and an open editor follow it
    const next = await win.webContents.executeJavaScript(`(async () => {
      const out = await renameTake(${JSON.stringify(args.path)}, ${JSON.stringify(stem)})
      refreshLibrary()
      return out
    })()`)
    // the name it actually got, which is "Name 2" when "Name" was taken
    const take = deps.proc.takeDir(next)
    return { path: next, name: take ? path.basename(take) : path.parse(next).name, ...(take ? { folder: take } : {}) }
  },

  async 'edit.beats'(args = {}) {
    if (!args.path) throw new Error('path is required')
    const meta = await deps.proc.probeMeta(args.path).catch(() => ({}))
    // Same ids the timeline prints (B1, B2, ...). They were missing here, so an agent
    // was told beats have ids and then handed `undefined`, while the person watching
    // saw B2 on screen for the same span.
    return deps.proc.beatsFor(args.path, meta && meta.duration)
      .map((b, i) => ({ id: b.id || 'B' + (i + 1), ...b,
        start: Math.round(b.start * 100) / 100, end: Math.round(b.end * 100) / 100 }))
  },

  async 'recordings.list'() {
    // Through the app, never through processor directly: listRecordings falls back to
    // a different, empty library index outside Electron and ignores the saveDir pref.
    const list = deps.proc.listRecordings()
    // One entry per take, grouped exactly as the Library groups them (groupTakes in
    // ui/app.js), so an agent that counts them says the number the person sees. A
    // flat file list read "13 recordings" beside a Library of 8 takes. path is the raw
    // take to edit; the deliverable an export wrote and any working versions (a
    // dead-air cut, cleaned audio) ride along on it.
    const DERIVED = /-(edit|cut|audio|trim|captions|converted|gif)$/
    const groups = new Map()
    for (const c of list) {
      const stem = path.parse(c.path).name
      const key = c.take ? 'take:' + c.take : path.join(path.dirname(c.path), stem.replace(DERIVED, ''))
      if (!groups.has(key)) groups.set(key, { take: c.take || null, original: null, deliverable: null, copy: null, versions: [] })
      const g = groups.get(key)
      if (c.copy) g.copy = c                  // autoConvertMp4's unedited MP4, not an export
      else if (c.deliverable && !g.deliverable) g.deliverable = c
      else if (c.deliverable || DERIVED.test(stem)) g.versions.push(c)
      else if (!g.original || c.mtime > g.original.mtime) {
        if (g.original) g.versions.push(g.original)
        g.original = c
      } else g.versions.push(c)
    }
    const takes = []
    for (const g of groups.values()) {
      // an export whose raw take was deleted is still a take in the Library
      const o = g.original || g.deliverable || g.versions[0] || g.copy
      if (!o) continue
      const versions = g.versions.filter(v => v !== o).map(v => v.path)
      takes.push({ mtime: o.mtime, entry: {
        name: g.take ? path.basename(g.take) : path.parse(o.path).name,
        path: o.path, mb: o.mb, kind: o.kind, srt: o.srt,
        ...(g.take ? { take: g.take } : {}),
        ...(g.deliverable && g.deliverable !== o ? { deliverable: g.deliverable.path } : {}),
        ...(g.copy && g.copy !== o ? { copy: g.copy.path } : {}),
        ...(versions.length ? { versions } : {}),
      } })
    }
    return takes.sort((a, b) => b.mtime - a.mtime).map(t => t.entry)
  },

  async probe(args = {}) {
    if (!args.path) throw new Error('path is required')
    if (!fs.existsSync(args.path)) throw new Error('no such file')
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

// Refuse the take if the policy says so, with a reason the agent can relay verbatim.
// Window targets are resolved to their owning app first, since the policy is written in
// terms of apps and the caller only gives us an id.
async function enforceAccess(args, ctx) {
  const prefs = deps.getPrefs ? deps.getPrefs() : {}
  const p = {
    mode: prefs.recordAccess,
    neverRecord: prefs.neverRecord,
    allowedApps: prefs.allowedRecordApps,
  }

  let app = null
  if (args.window != null) {
    const list = await deps.listWindows()
    const hit = (list || []).find(w => String(w.id) === String(args.window))
    app = hit && hit.app
  }

  const verdict = policy.decide(
    { by: 'agent', kind: args.window != null ? 'window' : 'display', app }, p)

  if (!verdict.allow) throw new Error(`Fetch refused to record: ${verdict.reason}`)

  // 'Ask' means a person approves every agent take. decide() said so all along, but
  // nothing asked: needsApproval was returned and dropped, so on the default setting
  // agents recorded without anyone saying yes. The question is a native dialog on
  // Fetch's own window, which an agent cannot answer, and saying nothing is a no.
  if (verdict.needsApproval) {
    const key = args.window != null ? 'app:' + (app || '') : 'display'
    if (sessionAllowed.has(key)) return
    const who = (ctx && ctx.client) || 'An agent'
    const what = args.window != null ? `a ${app || 'window'} window` : 'your whole screen'
    const answer = await askPerson(`${who} wants to record ${what}.`,
      (args.window != null
        ? 'Only that window is captured, in the background, even while you work in front of it.'
        : 'Apps on your never-record list are left out of the frame.') +
      ' The menu bar icon turns red while it records.',
      args.window != null ? `Allow ${app || 'this app'} until Fetch quits` : null)
    if (answer === 'no') throw new Error('Fetch refused to record: the person at the Mac said no')
    if (answer === 'session') sessionAllowed.add(key)
  }
}

// Approvals given with "until Fetch quits". In memory only, so a restart asks again.
const sessionAllowed = new Set()

// A free-standing alert rather than a sheet on Fetch's window: the question needs an
// answer, but it should not drag the whole app in front of what the person is doing.
async function askPerson(message, detail, sessionLabel) {
  const { dialog } = require('electron')
  const buttons = ['Allow this take', ...(sessionLabel ? [sessionLabel] : []), 'Don\'t allow']
  const no = buttons.length - 1
  const r = await dialog.showMessageBox({
    type: 'question', message, detail, buttons, defaultId: no, cancelId: no, noLink: true,
  })
  if (r.response === 0) return 'once'
  if (sessionLabel && r.response === 1) return 'session'
  return 'no'
}

// Open `path` in the editor if it is not already the clip on screen, then run `expr`
// against it. Opening is visible on purpose: an agent editing a recording should be
// seen doing it, the same way an agent recording is seen through the border.
async function inEditor(path, expr) {
  const win = deps.getWindow()
  if (!win || win.isDestroyed()) throw new Error('Fetch is not running')
  const open = await win.webContents.executeJavaScript('window.fetchDoc ? window.fetchDoc.src() : null')
  if (open !== path) {
    await win.webContents.executeJavaScript(`openInEditor(${JSON.stringify(path)})`)
    // openInEditor is async and wires the document only once the clip has loaded
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 150))
      const now = await win.webContents.executeJavaScript('window.fetchDoc ? window.fetchDoc.src() : null')
      if (now === path) break
    }
  }
  return win.webContents.executeJavaScript(expr)
}

// Everything an agent can change, and what values are allowed. The earlier version
// returned clips, zooms, texts and beats only, which had two costs: an agent could not
// see or reach the crop, the caption style, the backdrop, the camera or the audio
// settings at all, and a document sent back after reading it was missing them. Every
// setting a person has in the editor window is here, because an agent that cannot
// read a setting cannot be trusted to leave it alone.
// What auto-zoom has to work with. Fetch sees the real pointer only: input a driver
// injects into a page (Playwright's page.mouse, anything over CDP) never moves it, so
// such a take records no clicks and a still pointer, and auto-zoom silently does
// nothing. Saying so lets the agent place zooms itself instead of exporting a flat video.
// An agent take's own pointer track, when it has one, is what auto-zoom follows.
function pointerTrack(path, doc) {
  const t = path && deps.proc.pointerTrack ? deps.proc.pointerTrack(path, { pointer: doc.pointer }) : null
  return t ? t.points : []
}

function pointerSummary(path, doc) {
  const track = pointerTrack(path, doc)
  const own = track.length ? require('./pointer').asCursorData(track) : null
  const data = own || (path && deps.proc.readCursor ? deps.proc.readCursor(path) : null)
  if (!data) return { recorded: false, clicks: 0, autoZoomSpots: 0 }
  const clips = doc.clips || []
  const clock = t => t
  clock.kept = t => !clips.length || clips.some(c => t >= c.start && t <= c.end)
  let spots = 0
  try { spots = deps.proc.zoomMoments(data, { clock, crop: doc.crop }).length } catch {}
  const out = { recorded: true, clicks: (data.clicks || []).length, autoZoomSpots: spots }
  if (own) { out.source = Array.isArray(doc.pointer) ? 'edit' : 'agent'; out.points = track.length }
  // the Mac's pointer is in the pixels whenever the take recorded one, so say whether
  // the export will lift it out (hideMacCursor)
  const mac = path && deps.proc.readCursor ? deps.proc.readCursor(path) : null
  if (mac && mac.inPicture !== false) {
    out.macCursorInPicture = true
    out.macCursorHidden = doc.hideMacCursor === true || (doc.hideMacCursor !== false && track.length > 0)
  }
  if (!spots) out.note = 'No clicks or pointer pauses in the picture, so auto-zoom has nothing to zoom on. ' +
    'Input from Playwright or another driver that does not move the real pointer is not seen unless it ' +
    'is reported with the pointer tool during the take. Place zooms with the zooms list instead.'
  return out
}

// A text's time on the output clock and the output's length, which is what decides
// whether an unstyled text is a title card (see ui/overlays.js textStyle)
const overlays = require('./overlays')
function outputLength(doc) { return (doc.clips || []).reduce((n, c) => n + Math.max(0, c.end - c.start), 0) }
function textOnOutput(doc, t) {
  const clips = (doc.clips || []).slice().sort((a, b) => a.start - b.start)
  const at = s => {
    if (s == null) return null
    let acc = 0
    for (const c of clips) { if (s < c.start) return acc; if (s <= c.end) return acc + s - c.start; acc += c.end - c.start }
    return acc
  }
  return { ...t, start: at(t.start), end: at(t.end) }
}

function summarise(doc, path) {
  const r = n => Math.round(n * 100) / 100
  const cam = doc.camera
  return {
    duration: r(doc.dur || 0),
    output: r((doc.clips || []).reduce((n, c) => n + (c.end - c.start), 0)),

    clips: (doc.clips || []).map(c => ({ id: c.id, start: r(c.start), end: r(c.end) })),
    zooms: (doc.zooms || []).map(z => ({ id: z.id, start: r(z.start), end: r(z.end), scale: z.scale, x: z.x, y: z.y })),
    marks: (doc.marks || []).map(m => ({ id: m.id, kind: m.kind, start: r(m.start), end: r(m.end), x: m.x, y: m.y, w: m.w, h: m.h, n: m.n,
      ...(m.kind === 'blur' ? { strength: m.strength || 18 } : {}) })),
    // style says how each text will export, worked out the same way the exporter does
    // when the text does not set one
    texts: (doc.texts || []).map(t => ({
      id: t.id, text: t.text, start: t.start, end: t.end,
      fx: t.fx, fy: t.fy, sizeFrac: t.sizeFrac, color: t.color, box: t.box, font: t.font || 'SF Pro', align: t.align || 'center',
      style: overlays.textStyle(textOnOutput(doc, t), outputLength(doc)), ...(t.subtitle ? { subtitle: t.subtitle } : {}),
    })),
    beats: (doc.beats || []).map(b => ({ id: b.id, start: r(b.start), end: r(b.end), label: b.label })),
    captions: { count: (doc.cues || []).length, style: doc.capStyle },

    crop: doc.crop, cropAR: doc.cropAR,
    backdrop: doc.backdrop, outAspect: doc.outAspect,
    autoZoom: !!doc.autoZoom,
    camera: cam ? { recorded: true, on: cam.on !== false, x: cam.x, y: cam.y, size: cam.size } : { recorded: false },
    audioTrack: doc.audioTrack ? { name: doc.audioTrack.name, volume: doc.audioTrack.volume,
      offset: doc.audioTrack.offset, replace: !!doc.audioTrack.replace } : null,
    look: doc.look,
    pointer: pointerSummary(path, doc),

    // the values each setting accepts, so an agent never has to guess a font name
    options: {
      fonts: (deps.proc.fontList ? deps.proc.fontList() : ['Helvetica']),
      // from the exporter's own list, so a new backdrop (blur, an image someone dropped
      // in) is offered to agents the moment it exists, not when this line is edited
      backdrops: [null, ...deps.proc.backdropList().map(b => b.id)],
      captionPositions: ['top', 'middle', 'bottom'],
      captionHighlights: ['word', 'pill', 'none'],
      textStyles: ['title', 'lower-third', 'label'],
      markKinds: ['redact', 'blur', 'spotlight', 'step'],
      aspects: [null, 16 / 9, 9 / 16, 1, 4 / 5],
      cropAR: ['free', '16:9', '9:16', '1:1', '4:5'],
    },
  }
}

// Point the renderer's setup at what was asked for, reusing the same state the UI
// drives. Anything unspecified keeps the user's saved preference.
async function applySetup(win, args) {
  const wanted = {
    display: args.display != null ? String(args.display) : null,
    window: args.window != null ? String(args.window) : null,
    // Off unless the agent asks. These used to fall back to the person's own defaults,
    // so an agent recording a browser window in the background turned on their camera
    // and microphone without anyone asking for either.
    mic: args.mic === true,
    systemAudio: args.system_audio === true,
    camera: args.camera === true,
  }
  // The take borrows the person's setup card. What it held is kept aside and put back
  // when the take ends (restorePersonSetup in app.js), or their next take would aim at
  // the agent's window, often closed by then, with their mic switched off.
  const js = `(async () => {
    const w = ${JSON.stringify(wanted)}
    if (!window.__personSetup) window.__personSetup = { mode: setup.mode, source: setup.source,
      window: setup.window, mic: setup.mic, sys: setup.sys, cam: setup.cam }
    try {
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
    } catch (e) { restorePersonSetup(); throw e }
    applySetup()
    return true
  })()`
  await win.webContents.executeJavaScript(js)
}

// ---------- wire ----------
function handleLine(sock, line, ctx) {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  const id = msg && msg.id
  const reply = obj => { try { sock.write(JSON.stringify({ id, ...obj }) + '\n') } catch {} }

  const op = msg && msg.op
  const fn = ops[op]
  if (!fn) return reply({ ok: false, error: `unknown op: ${op}` })

  const t0 = Date.now()
  Promise.resolve()
    .then(() => fn(msg.args || {}, ctx))
    .then(result => { logOp(op, ctx, t0, msg.args, result, null); reply({ ok: true, result }) })
    .catch(err => {
      const m = err && err.message ? err.message : String(err)
      logOp(op, ctx, t0, msg.args, null, m)
      reply({ ok: false, error: m })
    })
}

// Reads are noise in a log meant to answer "what did it do to my machine", so the
// pure lookups are skipped and anything with an effect is kept.
// The pointer is a note about the take, sent many times a take, not an action.
const QUIET = new Set(['ping', 'hello', 'record.status', 'record.pointer'])

function logOp(op, ctx, t0, args, result, error) {
  if (QUIET.has(op)) return
  let detail = null
  if (op === 'record.start' && result) detail = result.path
  else if (op === 'transcribe' && result) detail = `${result.words} words, ${result.cues} cues`
  else if (op === 'windows.list' && result) detail = `${result.length} windows`
  else if (op === 'recordings.list' && result) detail = `${result.length} take${result.length === 1 ? '' : 's'}`
  else if (op === 'probe' && args && args.path) detail = args.path
  else if (op === 'edit.silence' && result) detail = `${result.removed_percent}% removed, ${result.path}`
  else if (op === 'frame' && result) detail = `${result.at}s`
  else if (op === 'edit.enhance' && result) detail = result.path
  else if (op === 'recordings.trash' && result) detail = result.trashed
  else if (op === 'settings.set' && args && args.settings) detail = Object.keys(args.settings).join(', ')

  activity.record({
    op,
    title: TITLES[op] || op,
    detail,
    by: (ctx && ctx.client) || 'Agent',
    ms: Date.now() - t0,
    ok: !error,
    error,
  })
}

// What record_start answers for a window others cover by more than a sliver, or null
// to go ahead. Fetch records, it does not drive, so it will not raise the window
// itself: it offers the two ways round it, the person bringing it forward, or the
// display it is on, recorded whole, with the crop that shows just this window.
const COVERED = 0.08
function occludedTake(cov) {
  if (!cov || !(cov.covered > COVERED)) return null
  const out = {
    recording: false, status: 'occluded',
    covered: Math.round(cov.covered * 100) / 100, covered_by: cov.by || [],
    note: `${Math.round(cov.covered * 100)}% of that window is behind ${(cov.by || []).join(', ') || 'other windows'}, ` +
      'and macOS sends no frames for a covered window, so the take would freeze. Nothing was recorded. ' +
      'Ask the person to bring the window to the front and call record_start again, or record its display ' +
      'with record_start { display } and then apply_edit { crop } with the crop given here. ' +
      'record_start { window, allow_covered: true } records it anyway.',
  }
  try {
    const { screen } = require('electron')
    const d = screen.getDisplayMatching({ x: cov.x, y: cov.y, width: cov.width, height: cov.height })
    const b = d.bounds, f = n => Math.round(Math.max(0, Math.min(1, n)) * 1000) / 1000
    out.display = String(d.id)
    out.crop = { x: f((cov.x - b.x) / b.width), y: f((cov.y - b.y) / b.height),
      w: f(cov.width / b.width), h: f(cov.height / b.height) }
  } catch {}
  return out
}

// macOS stops sending a window's frames while another window covers it. The take
// still runs to Stop (the recorder holds the last picture), but an agent should hear
// that part of its video is a frozen frame, and why, rather than find out on playback.
function stillNote(stillMs) {
  if (!(stillMs >= 3000)) return null
  return `The window showed nothing new for ${(stillMs / 1000).toFixed(1)} s, so that stretch of the video ` +
    'holds one frozen picture. Usually another window was covering it: macOS sends no frames for a ' +
    'covered window. Keep the recorded window uncovered while recording.'
}

function start(d) {
  deps = d
  if (server) return

  // A take can finish because an agent asked for it or because someone pressed the
  // button. Either way the waiter is resolved once and cleared.
  if (ipcMain) {
    ipcMain.on('rec-state', (e, state) => {
      if (state !== 'recording' || !pendingTake || pendingTake.phase !== 'starting') return
      clearTimeout(pendingTake.timer)
      const p = pendingTake; pendingTake = null
      p.resolve({ recording: true, started_at: new Date().toISOString() })
    })
    ipcMain.on('take-finished', (e, info) => {
      endingAt = 0
      const note = stillNote(info && info.stillMs)
      const r = { path: info && info.file, mb: info && info.mb,
        ...(info && info.endedAlone ? { stopped_early: info.reason || 'the capture ended on its own' } : {}),
        ...(note ? { note } : {}) }
      if (!pendingTake || pendingTake.phase !== 'stopping') {
        if (info && info.endedAlone) endedTake = { ...r, at: Date.now() }
        return
      }
      clearTimeout(pendingTake.timer)
      const p = pendingTake; pendingTake = null
      p.resolve(r)
    })
    ipcMain.on('take-failed', (e, info) => {
      endingAt = 0
      // A take that failed before it went live never sent the idle rec-state that
      // clears this, so the person's next take would run without border or HUD.
      if (deps.setQuiet) deps.setQuiet(false)
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
    const ctx = { client: null }         // filled in by the shim's hello
    let buf = ''
    sock.on('data', chunk => {
      buf += chunk
      if (buf.length > 1e6) { buf = ''; sock.destroy(); return }   // no unbounded growth
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1)
        if (line.trim()) handleLine(sock, line, ctx)
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

// Whether the take about to start is an agent's, so main.js records it without the
// Mac's pointer. True from record.start until capture begins.
const startingAgentTake = () => !!pendingTake && pendingTake.phase === 'starting'
const takeEndedAlone = () => { endingAt = Date.now() }

function stop() {
  if (!server) return
  try { server.close() } catch {}
  try { fs.unlinkSync(socketPath()) } catch {}
  server = null
}

module.exports = { start, stop, socketPath, VERSION, startingAgentTake, takeEndedAlone, stillNote, occludedTake }
