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
// What find_on_screen last handed out for each recording, so apply_edit can take
// element: 'E129' and use that element's own box. An agent given a box still worked
// out a centre and a scale by hand; naming the element leaves nothing to work out.
const foundBy = new Map()      // path -> { at, boxes: Map(id -> box) }
// The same, for a pass Fetch ran for itself rather than for the agent: the lasso's
// snapping while the person scrubs, and the frame a zoom's aim is read from. E ids are
// positional per frame (ui/targets.js:143), so putting a background pass into foundBy
// would quietly renumber the ids the agent is still holding from its own
// find_on_screen, and E7 would resolve to a different element's box with no warning.
// Its ids still resolve; they just never take one away from the pass that minted it.
const foundFor = new Map()     // path -> { at, boxes: Map(id -> box) }
// What the person lassoed on the stage, per recording: R1, R2... An area someone drew
// with their own hand is a better target than anything a search ranks, so it is kept
// apart from foundBy, whose E ids are renumbered by every search. Regions outlive the
// turn that carried them, so "now lift it" in the next message still finds R1, and
// they die with the app like the E ids do.
const regions = new Map()      // path -> [region], newest last
const regionSeq = new Map()    // path -> the last number handed out, never rewound
const MAX_REGIONS = 8

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
  find: 'Looked for something on screen',
  'edit.preview': 'Checked a frame of the edit',
  'edit.enhance': 'Cleaned up the audio',
  'settings.set': 'Changed settings',
  'recordings.trash': 'Moved a recording to the Trash',
  'look.schema': 'Read the look settings',
  'look.list': 'Listed looks',
  'look.apply': 'Changed a look',
  'look.save': 'Saved a look',
}

const { AGENT_PREFS, HUMAN_ONLY_PREFS } = policy
// Where agents run. Never the product an agent means when it records "the app in front".
const AGENT_HOSTS = ['Terminal', 'iTerm2', 'Warp', 'Ghostty', 'kitty', 'Alacritty', 'WezTerm', 'Hyper',
  'Conductor', 'Claude', 'Codex', 'ChatGPT']

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

    // Window first: with no window and no display named, the take is the window of the
    // app in front, not the whole screen, which caught the person's other windows,
    // notifications and desktop. The terminal or chat the agent itself runs in, and
    // anything on the never-record list, are looked past.
    let front = null
    if (args.window == null && args.display == null && !args.full_screen && deps.frontWindow) {
      const prefs = deps.getPrefs ? deps.getPrefs() : {}
      const never = (prefs.neverRecord || policy.DEFAULT_NEVER || []).map(x => typeof x === 'string' ? x : x && x.app).filter(Boolean)
      front = await deps.frontWindow([...AGENT_HOSTS, ...never]).catch(() => null)
      if (front) args = { ...args, window: String(front.id) }
    }

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
    // A name the agent gives is used as it is and never replaced by an automatic one
    const naming = require('./naming')
    const given = args.name != null ? naming.fit(naming.clean(args.name)) : ''
    await win.webContents.executeJavaScript(`window.__takeName = ${JSON.stringify(given || null)}`)
    deps.toRenderer('start')

    // The renderer counts down before it captures, so allow for that plus a margin.
    const started = await new Promise((resolve, reject) => {
      pendingTake = {
        phase: 'starting', resolve, reject,
        timer: setTimeout(() => {
          pendingTake = null
          // the name was for this take, not the person's next one
          if (!win.isDestroyed()) win.webContents.executeJavaScript('window.__takeName = null').catch(() => {})
          reject(new Error('the recording did not start in time'))
        }, 30000),
      }
    })
    // say which window was picked, so an agent that meant another can stop and name it
    return front && started && typeof started === 'object'
      ? { ...started, recording: { window: String(front.id), app: front.app, title: front.title || '', chosen: 'the app in front' } }
      : started
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
    const FD = require('./fetchdoc')
    if (args.doc.remove != null && !Array.isArray(args.doc.remove)) throw new Error('remove is a list of ids, e.g. remove: [\'M12\']')
    // marks: { remove: [...] } was taken as nothing and reported as done
    for (const k of ['clips', 'zooms', 'texts', 'marks', 'cues']) {
      if (args.doc[k] != null && !Array.isArray(args.doc[k])) {
        throw new Error(`${k} is a list; to delete items send remove: ['M12'] beside it in doc, not inside it`)
      }
    }
    const prev = ['marks', 'zooms', 'texts', 'remove'].some(k => Array.isArray(args.doc[k]))
      ? await inEditor(args.path, 'window.fetchDoc.get()') : null
    // the edit as it stands is read first: which mark ids exist decides whether a lift
    // is being retimed or made, and the crop decides what a lassoed box now points at
    args = { ...args, doc: withElements(args.path, args.doc, prev) }
    // a zoom is held to what it frames before the document sees it, so a point becomes
    // the element under it and a scale that would not read becomes Fetch's own fit
    const aim = await aimZooms(args.path, args.doc, prev)
    // a new lift or spotlight replaces the one it lands on, rather than stacking
    let replaced = [], timed = null
    if (Array.isArray(args.doc.marks)) {
      // marks are merged by id (FD.mergeMarks): the ones not sent stay, so settle the
      // whole list, and what settling drops goes out as remove, or the merge keeps it
      const merged = FD.mergeMarks(prev && prev.marks, args.doc.marks, args.doc.remove)
      const s = FD.settleFocus(prev && prev.marks, merged.marks)
      args = { ...args, doc: { ...args.doc, marks: s.marks, remove: [...(args.doc.remove || []), ...s.replaced] } }
      replaced = s.replaced
      timed = await timeFocus(args.path, prev, args.doc).catch(() => ({ moved: [], absent: [] }))
    }
    const doc = await inEditor(args.path, `window.fetchDoc.apply(${JSON.stringify(args.doc)})`)
    deps.proc.writeDoc(args.path, doc)
    const out = summarise(doc, args.path)
    if (replaced.length) out.replaced = { marks: replaced, why: 'a new lift or spotlight takes the place of one it overlaps' }
    // Anything else this edit took out (named in remove, or left out of a zooms or texts
    // list), so the reply can say so rather than the person finding out in the export.
    const gone = removedIds(prev, doc).filter(id => !replaced.includes(id))
    if (gone.length) out.removed = { ids: gone, why: 'these are no longer in the edit; say so in your reply' }
    const check = checkTimes(FD, prev, doc)
    if (check.length) {
      out.check = { preview_frame_at: check, why: 'call preview_frame once with at set to these times (just after each new zoom or mark lands, and in its middle) and look before replying' }
    }
    // a new mark had no id when it was timed; name it by the one it was given
    if (timed) {
      for (const a of [...timed.moved, ...timed.absent]) {
        if (!/^the new /.test(a.id)) continue
        const to = a.to || [a.start, a.end]
        const m = (doc.marks || []).find(x => x.kind === (a.kind || x.kind) && x.start === to[0] && x.end === to[1] && ['lift', 'spotlight'].includes(x.kind))
        if (m) a.id = m.id
      }
    }
    if (timed && timed.moved.length) {
      out.retimed = { marks: timed.moved, why: 'the element is only on screen for part of the span, so the lift or spotlight now starts when it appears and ends when it goes' }
    }
    if (timed && timed.absent.length) {
      out.warnings = (out.warnings || []).concat(timed.absent.map(a =>
        `${a.id} (${a.kind} ${a.start}-${a.end} s): what is inside its box keeps changing, so no one element is there for the span. ` +
        'Call find_on_screen at a moment the element is fully open and preview_frame near the start and the end.'))
    }
    // what aiming did to the zooms, now that the new ones have their ids
    if (aim) {
      const said = nameZooms(aim, doc)
      if (said.snapped) out.snapped = said.snapped
      if (said.refit) out.refit = said.refit
      if (said.warnings.length) out.warnings = (out.warnings || []).concat(said.warnings)
    }
    // what the look part of the edit did: values clamped, fields unknown, settings not drawn yet
    const lw = lookWarnings(FD.lookPatchOf(args.doc).look, doc, args.path)
    if (lw.length) out.look_warnings = lw
    const warn = [...handAimed(FD, prev, args.doc, doc), ...FD.focusClashes(doc.marks).map(c =>
      `${c.a} (${c.kinds[0]}) and ${c.b} (${c.kinds[1]}) cover the same part of the frame from ${c.start} to ${c.end} s, ` +
      'so one dims or cuts across the other. Keep one of them unless the person asked for both.'),
    ...(Array.isArray(args.doc.zooms) ? FD.zoomClashes(doc.zooms) : []).map(c =>
      `${c.a} and ${c.b} are both zooms from ${c.start} to ${c.end} s, and only one frames the shot at a time. ` +
      'Re-aim or retime the one already there rather than adding a second.')]
    if (warn.length) out.warnings = (out.warnings || []).concat(warn)
    const along = FD.focusAlongside(prev, doc)
    if (along.length) {
      out.alongside = { marks: along, why: 'these still play during the zoom you changed. An earlier edit may have added them unasked: ' +
        'remove one (remove: [id]) if the person did not ask for it or complained about a highlight there, and name each in your reply' }
    }
    out.preview = await previewOf(args.path, check, args.doc, doc)
    return out
  },

  // ── looks ──────────────────────────────────────────────────────────────
  // The Look spec (ui/look-schema.js) as an agent reads it: every field, its range and
  // default, one line each, generated from the same table the inspector is.
  async 'look.schema'() {
    const Look = require('./look')
    return {
      how: 'A look is { preset, <section>: { <field>: value } }. Send only what changes: a field left out is kept, ' +
        'null puts it back to the preset, { preset: name } starts from that look. Fields marked [new renderer] are ' +
        'saved but not drawn by this version; apply_look warns when one is set.',
      fields: Look.describe(),
      looks: Look.list(looksDir()).map(p => p.name),
    }
  },

  async 'look.list'() {
    const Look = require('./look')
    return {
      looks: Look.list(looksDir()).map(p => ({ name: p.name, label: p.label, about: p.doc || undefined, yours: p.mine || undefined })),
      backgrounds: { gradients: Object.keys(require('./look-schema').GRADIENTS),
        images: deps.proc.backdropList().filter(b => b.image).map(b => b.id) },
    }
  },

  // A look onto a recording's edit: a preset, a patch, fields to reset, or all three.
  // Through the editor like apply_edit, so the person sees it and one Undo takes it back.
  async 'look.apply'(args = {}) {
    if (!args.path) throw new Error('path is required')
    const Look = require('./look')
    const patch = { ...(args.look && typeof args.look === 'object' ? args.look : {}) }
    if (args.preset) patch.preset = args.preset
    for (const p of Array.isArray(args.reset) ? args.reset : []) patch[String(p)] = null
    if (!Object.keys(patch).length) throw new Error('send preset, look or reset')
    const doc = await inEditor(args.path, `window.fetchDoc.apply(${JSON.stringify({ look: patch })})`)
    deps.proc.writeDoc(args.path, doc)
    const out = { look: Look.compact(doc.look, looksDir()) }
    const w = lookWarnings(patch, doc, args.path)
    if (w.length) out.look_warnings = w
    return out
  },

  async 'look.save'(args = {}) {
    if (!args.name) throw new Error('name is required')
    const Look = require('./look')
    let look = args.look && typeof args.look === 'object' ? Look.validate(args.look).look : null
    if (!look) {
      if (!args.path) throw new Error('send path (to save that recording\'s look) or look')
      const meta = await deps.proc.probeMeta(args.path).catch(() => ({}))
      look = deps.proc.readDoc(args.path, meta && meta.duration).look
    }
    const saved = Look.save(looksDir(), args.name, look)
    return { name: saved.name, label: saved.label, changes: saved.look }
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
    // which renderer drew it: gl (the compositor) or classic, and what kept it classic
    const engine = r && r.engine ? { engine: r.engine, ...(r.engine === 'classic' && r.why && r.why.length ? { classic_because: r.why } : {}) } : {}
    return { path: r && r.file, mb, seconds: +FD.outDuration(doc).toFixed(2), ...engine }
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

  // The things on a frame an edit can land on, found on device and ranked against what
  // the person said. Measured after the crop unless asked otherwise, because that is
  // the frame every zoom and mark is placed in.
  async find(args = {}) {
    if (!args.path) throw new Error('path is required')
    if (!fs.existsSync(args.path)) throw new Error('no such file')
    const meta = await deps.proc.probeMeta(args.path).catch(() => ({}))
    const crop = args.cropped === false ? null : deps.proc.readDoc(args.path, meta && meta.duration).crop || null
    const r = await deps.proc.findOnScreen(args.path, args.at, { crop, query: args.query, limit: args.limit })
    // only boxes measured in apply_edit's frame (after the crop) can be named there
    const all = r.all || r.elements
    // a card, grid or panel a lift would come out wrong on says so here, with the one
    // inside it to lift instead, so the agent does not have to be refused to learn it
    const noLift = crop || args.cropped !== false
      ? noteFound(args.path, r.at, r.elements, all)
      : liftNotes(r.elements, all)
    return {
      image: r.image, at: r.at, cropped: !!crop, query: args.query || null,
      found: r.found, shown: r.elements.length,
      elements: r.elements.map(e => ({
        id: e.id, text: e.text, kind: e.kind, box: e.box,
        colour: e.background.colour, tone: e.background.tone, hex: e.background.hex, luminance: e.background.luminance,
        confidence: e.confidence, ...(e.in ? { in: e.in } : {}), ...(e.cards ? { cards: e.cards } : {}),
        ...(e.score != null && args.query ? { score: e.score } : {}),
        ...(noLift.has(e.id) ? { no_lift: noLift.get(e.id).advice } : {}),
      })),
    }
  },

  // One frame of the saved edit drawn as the export would, to check an edit landed.
  async 'edit.preview'(args = {}) {
    if (!args.path) throw new Error('path is required')
    if (!fs.existsSync(args.path)) throw new Error('no such file')
    const meta = await deps.proc.probeMeta(args.path).catch(() => ({}))
    let doc = deps.proc.readDoc(args.path, meta && meta.duration)
    // a look to try, drawn without saving it
    if (args.look && typeof args.look === 'object') doc = require('./fetchdoc').mergeDoc(doc, { look: args.look })
    // several moments in one call: the start of a move and its middle are both checked
    const times = (Array.isArray(args.at) ? args.at : [args.at]).slice(0, 6)
    let frames = null
    // drawn by the renderer the export will use, so what the agent checks is the file
    const host = require('./render-host')
    const pick = host.pickEngine(args.path, require('./fetchdoc').toExportOpts(doc))
    if (pick.engine === 'gl') {
      try { frames = await host.previewFrames(args.path, doc, times) } catch (e) { console.warn('[preview] compositor failed, drawing with the classic renderer:', e && e.message) }
    }
    if (!frames) {
      frames = []
      for (const t of times) frames.push(await deps.proc.previewFrame(args.path, doc, t))
    }
    return { image: frames[0].file, at: frames[0].at, frames: frames.map(r => ({ image: r.file, at: r.at })) }
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
    const side = ['.png', '.srt', '.txt', '.cursor.json', '.pointer.json', '.cam.json', '.cam.mov', '.words.json', '.fetchdoc.json', '.vo.mp3', '.name.json']
      .map(e => deps.proc.sidecarIn(args.path, e)).filter(f => f !== args.path && fs.existsSync(f))
    for (const f of [args.path, ...side]) await shell.trashItem(f)
    refresh()
    return { trashed: args.path, with_sidecars: side.length, recoverable: true }
  },

  async 'recordings.rename'(args = {}) {
    if (!args.path) throw new Error('path is required')
    // No name: the same naming as a new take, and only over a name Fetch gave it
    if (args.name == null && deps.nameTake) {
      const r = await deps.nameTake(args.path)
      if (!r || !r.to) return { path: args.path, name: deps.proc.takeName(args.path), renamed: false, reason: (r && r.skipped) || 'nothing better to name it from' }
      const take = deps.proc.takeDir(r.to)
      return { path: r.to, name: r.name, renamed: true, ...(take ? { folder: take } : {}) }
    }
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

// A lift or spotlight an agent times to the narration can start before the card it
// raises has opened, lifting whatever was there first. Each new or moved one is held to
// the part of its span where its box shows one steady picture (Targets.presentSpan),
// changing doc.marks in place. Returns what moved and what never settled.
// element: 'E129' on a zoom or mark is that element's box from the last find_on_screen
// on this recording. An id it never handed out is refused rather than guessed at.
// element: 'R2' is an area the person lassoed on the stage. From here on it is an
// ordinary box: fitted by boxZoom, judged by liftBlock, settled by settleFocus. A
// lasso buys a target, not a way past the rules.
function withElements(src, doc, prev) {
  const seen = foundBy.get(src) || null, mine = foundFor.get(src) || null
  const T = require('./targets')
  // the crop this edit lands in: the one it is setting, else the one already there
  const crop = doc && doc.crop !== undefined ? doc.crop : (prev && prev.crop) || null
  // a lift may only be retimed without a box when the document already holds that id
  // and its geometry. An id the document has never seen is a new mark, and mergeMarks
  // pushes it through as one, so it has to answer for its box like any other.
  const known = new Set(((prev && prev.marks) || []).map(m => m && m.id).filter(Boolean))
  const swap = list => !Array.isArray(list) ? list : list.map(it => {
    const aimed = it && it.element ? resolveElement(src, seen, mine, crop, it) : it
    if (aimed && (aimed.kind === 'lift' || aimed.kind === 'loupe')) {
      // a new lift or loupe with nothing but times raises nothing and magnifies
      // nothing, so say what to send. One that names an existing mark keeps that
      // mark's box and is only being retimed.
      if (!aimed.id || !known.has(aimed.id)) {
        const needs = T.liftNeedsBox({ ...it, kind: aimed.kind })
        if (needs) throw new Error(needs)
      }
      // a loupe asks nothing of the element under it: it copies what is there, room or
      // no room, and the one thing it must not do is cover the area it magnifies
      if (aimed.kind === 'lift') liftable(seen || mine, aimed)
    }
    return aimed
  })
  return { ...doc, ...(doc.zooms ? { zooms: swap(doc.zooms) } : {}), ...(doc.marks ? { marks: swap(doc.marks) } : {}) }
}

// One id, one box. R ids come from the lasso, E ids from an Elements pass, and neither
// map can shadow the other. The agent's own find_on_screen is read before a pass Fetch
// ran for itself, so a background pass never takes an E id away from it.
function resolveElement(src, seen, mine, crop, it) {
  const { element, ...rest } = it
  const id = String(element).trim().toUpperCase()
  if (/^R\d+$/.test(id)) {
    const region = regionFor(src, id)
    if (!region) {
      throw new Error(`${id} is not an area the person lassoed on this recording. ` +
        'Ask them to lasso it again, or call find_on_screen and name an E id.')
    }
    return { ...rest, box: regionBox(region, crop) }
  }
  const box = (seen && seen.boxes.get(id)) || (mine && mine.boxes.get(id))
  if (!box) {
    const at = seen || mine
    throw new Error(`${element} is not in the last find_on_screen result for this recording` +
      (at ? ` (at ${at.at} s)` : '') + '. Call find_on_screen again and name one it lists, or send its box.')
  }
  return { ...rest, box }
}

// A region's box is fractions of the frame as it was cropped when the person drew the
// rectangle. Move the crop and those same fractions point at a different part of the
// picture, so the box goes back into the recording's own frame and is read again in the
// crop this edit lands in. A crop that has cut the area away is refused, not guessed at.
function regionBox(region, crop) {
  const T = require('./targets')
  const same = c => c && c.w > 0 && c.h > 0 ? c : { x: 0, y: 0, w: 1, h: 1 }
  const f = same(region.crop), t = same(crop)
  if (f.x === t.x && f.y === t.y && f.w === t.w && f.h === t.h) return region.box
  const b = region.box
  const s = { x: f.x + f.w * b.x, y: f.y + f.h * b.y, w: f.w * b.w, h: f.h * b.h }
  const r = { x: (s.x - t.x) / t.w, y: (s.y - t.y) / t.h, w: s.w / t.w, h: s.h / t.h }
  // what is left of it inside the new frame, measured before clamping: cleanBox slides
  // a box back in rather than cutting it, which would hide a crop that moved right off
  const span = (a, len) => Math.max(0, Math.min(1, a + len) - Math.max(0, a))
  const ow = span(r.x, r.w), oh = span(r.y, r.h)
  const moved = ow * oh >= r.w * r.h / 2
    ? T.cleanBox({ x: Math.max(0, r.x), y: Math.max(0, r.y), w: ow, h: oh }) : null
  if (!moved) {
    throw new Error(`${region.id} was lassoed in a different crop, and this one cuts most of it away. ` +
      'Ask the person to lasso it again in the crop the edit uses, or send the box yourself.')
  }
  const r4 = n => Math.round(n * 10000) / 10000
  return { x: r4(moved.x), y: r4(moved.y), w: r4(moved.w), h: r4(moved.h) }
}

// A card, grid or panel a lift would come out wrong on: why, what to lift instead,
// and the sentence that says both. find_on_screen returns these as no_lift, the
// lasso's own Elements pass hands them to the editor, and liftable refuses on them.
function liftNotes(elements, all) {
  const T = require('./targets')
  const out = new Map()
  for (const e of elements || []) {
    if (!['card', 'grid', 'panel'].includes(e.kind)) continue
    const b = T.liftBlock(e, all || elements)
    if (b) out.set(e.id, { ...b, advice: liftAdvice(b) })
  }
  return out
}

/**
 * Remember what an Elements pass found, so apply_edit can take element: 'E7' and use
 * that element's own box. The only way boxes are registered: find_on_screen and the
 * editor's lasso both come through here, so an id the person can see is an id the
 * agent can aim with.
 *
 * `agent` false is a pass Fetch ran for itself, which is kept in its own map: its ids
 * resolve, but they never replace the ones the agent asked for and is still holding.
 */
function noteFound(path, at, elements, all, { agent = true } = {}) {
  const list = all || elements || []
  const notes = liftNotes(elements, list)
  const boxes = new Map((elements || []).map(e => [e.id, e.box]))
  // an element named only inside a refusal is still one the agent may aim at
  for (const b of notes.values()) if (b.instead) boxes.set(b.instead.id, b.instead.box)
  ;(agent ? foundBy : foundFor).set(path, { at, boxes, all: list })
  return notes
}

/** An area the person drew, given the next id for this recording and kept. */
function noteRegion(path, region) {
  const n = (regionSeq.get(path) || 0) + 1
  regionSeq.set(path, n)
  const kept = { ...region, id: 'R' + n }
  const list = regions.get(path) || []
  list.push(kept)
  while (list.length > MAX_REGIONS) list.shift()
  regions.set(path, list)
  return kept
}

function regionFor(path, id) {
  const want = String(id || '').trim().toUpperCase()
  return (regions.get(path) || []).find(r => r.id === want) || null
}

// The person took the chip off the message, so the agent must not be able to aim at it.
function forgetRegion(path, id) {
  const list = regions.get(path)
  if (!list) return false
  const want = String(id || '').trim().toUpperCase()
  const i = list.findIndex(r => r.id === want)
  if (i < 0) return false
  list.splice(i, 1)
  return true
}

// Ids in the zooms, texts and marks before an edit that are not there after it.
function removedIds(prev, doc) {
  if (!prev) return []
  const out = []
  for (const key of ['zooms', 'texts', 'marks']) {
    const now = new Set((doc[key] || []).map(x => x && x.id))
    for (const x of prev[key] || []) if (x && x.id && !now.has(x.id)) out.push(x.id)
  }
  return out
}

// When to look at what an edit just placed: for each new or changed zoom and mark,
// once it has landed (past the ease in) and in its middle. An agent that checked one
// frame of a zoom saw it half way through the push and called it done.
function checkTimes(FD, prev, doc) {
  const out = []
  for (const key of ['zooms', 'marks']) {
    const was = new Map((((prev && prev[key]) || [])).filter(x => x && x.id).map(x => [x.id, x]))
    for (const it of doc[key] || []) {
      if (!it || !(+it.end > +it.start)) continue
      if (was.has(it.id) && FD.sameItem(was.get(it.id), it)) continue
      const span = +it.end - +it.start
      out.push(+it.start + Math.min(1, span / 3), +it.start + span / 2)
    }
  }
  const r = [...new Set(out.map(t => Math.round(t * 10) / 10))].sort((a, b) => a - b)
  return prev ? r.slice(0, 6) : []
}

// A new lift, named by element or sent with a found element's box, on something a
// lift comes out wrong on (Targets.liftBlock): flush with the frame's edge, or a pane
// whose content is cut off at its foot. Refused, naming the element inside to lift.
// With a piece inside to lift, that is the only way out offered: offered "or use a
// spotlight" too, an agent asked to lift the song details spotlit the whole pane.
function liftAdvice(b) {
  const name = e => `${e.id} (${e.kind}, "${String(e.text || '').slice(0, 40)}")`
  if (b.instead && b.share >= 0.2) return `${b.why}; to lift it, lift ${name(b.instead)}, the part of it that can be raised`
  if (b.instead) return `${b.why}; only small pieces inside it can be lifted (such as ${name(b.instead)}): lift the one the person means, or point at the whole with a spotlight and say why`
  return `${b.why}; nothing inside it can be lifted either, so a spotlight is the way to point at it (say so if the person asked for a lift)`
}
// Every lift with a box is checked, including one being moved: the old guard let a
// lift dragged onto the frame's edge by a bare box through without a word.
function liftable(seen, m) {
  if (!seen || !seen.all) return
  const T = require('./targets')
  const id = m.element ? String(m.element).trim().toUpperCase() : null
  const box = m.box && typeof m.box === 'object' ? T.cleanBox(m.box) : null
  const same = (a, b) => ['x', 'y', 'w', 'h'].every(k => Math.abs(a[k] - b[k]) < 0.004)
  const el = seen.all.find(e => id ? e.id === id : box && same(e.box, box))
  const b = el && ['card', 'grid', 'panel'].includes(el.kind) ? T.liftBlock(el, seen.all) : null
  if (!b) return
  throw new Error(`Not lifting ${el.id}: ${liftAdvice(b)}. A lifted piece needs room on every side and its whole content on screen.`)
}

const r2 = n => Math.round(n * 100) / 100

// The elements on the frame at `at`: the ones the agent already has when it looked at
// about this moment, otherwise a fresh pass, registered so it can name what it got.
// Null when the frame cannot be read, which is never a reason to fail an edit.
async function elementsNear(src, at, crop) {
  for (const m of [foundBy, foundFor]) {
    const seen = m.get(src)
    if (seen && seen.all && seen.all.length && Math.abs(seen.at - at) <= 0.75) return seen.all
  }
  if (!deps.proc || !deps.proc.findOnScreen) return null
  try {
    const r = await deps.proc.findOnScreen(src, at, { crop: crop && crop.w > 0 ? crop : null, limit: 40 })
    // Fetch's own pass, so it does not renumber the E ids the agent is holding
    noteFound(src, r.at, r.elements, r.all, { agent: false })
    return r.all || r.elements
  } catch (e) {
    console.warn('[aim] could not read the frame at', at, e && e.message)
    return null
  }
}

/**
 * Hold every zoom in this patch to what it is actually aimed at, before the document
 * sees it. A zoom given a bare point is put on the element under that point: a point
 * is a guess at a centre, and the thing under it is what was meant. A zoom that ends
 * up with a box is framed by Fetch's own fit, so a scale too loose to read or so tight
 * the element is cut off does not land. Changes doc.zooms in place, the way timeFocus
 * changes doc.marks, and returns what to tell the agent.
 */
async function aimZooms(src, doc, prev) {
  if (!Array.isArray(doc.zooms)) return null
  const T = require('./targets'), FD = require('./fetchdoc')
  const was = new Map(((prev && prev.zooms) || []).filter(z => z && z.id).map(z => [z.id, z]))
  const crop = doc.crop !== undefined ? doc.crop : (prev && prev.crop) || null
  const out = { snapped: [], refit: [], warnings: [], unnamed: [] }
  for (const z of doc.zooms) {
    if (!z || typeof z !== 'object') continue
    const old = z.id ? was.get(z.id) : null
    // a zoom sent back unchanged is not being re-aimed, and re-reading its frame would
    // move a zoom the person never asked about
    if (old && FD.sameItem(old, z)) continue
    const num = (v, alt) => Number.isFinite(+v) && v !== null ? +v : (old && Number.isFinite(+alt) ? +alt : null)
    const start = num(z.start, old && old.start), end = num(z.end, old && old.end)
    const mine = []
    let box = T.cleanBox(z.box), el = null
    if (!box) {
      const x = num(z.x, old && old.x), y = num(z.y, old && old.y)
      // {start, end} alone still means 1.8x at the frame centre: nothing was aimed, so
      // there is nothing to correct
      if (x == null && y == null || !(end > start)) continue
      const aim = r2(start + Math.min(1, (end - start) / 3))
      const found = await elementsNear(src, aim, crop)
      el = found ? T.nearPoint({ x: x == null ? 0.5 : x, y: y == null ? 0.5 : y }, found) : null
      box = el ? T.cleanBox(el.box) : null
      if (!box) continue      // nothing under the point: the zoom stands, and handAimed says so
      z.box = box
      const entry = { id: z.id || null, element: el.id, at: aim,
        from: { x, y, scale: num(z.scale, old && old.scale) }, to: null, box }
      out.snapped.push(entry); mine.push(entry)
    }
    // where the box lands the zoom: the one place a box becomes a zoom is normalize,
    // and this is the same sum it will do
    const land = T.boxZoom(box)
    const share = r2(T.zoomShare(land.scale, box))
    const sent = Number.isFinite(+z.scale) ? +z.scale : null
    for (const e of mine) e.to = land
    // A box on a zoom wins over any scale beside it, every time (ui/fetchdoc.js:252),
    // so what lands is boxZoom's sum whether or not the sent scale was readable. The
    // report is of what landed: telling the agent its 2.0 stood when 2.6 did is worse
    // than telling it nothing.
    const fit = T.zoomFit({ x: z.x, y: z.y, scale: sent }, box)
    if (sent !== null && sent !== land.scale) {
      delete z.scale     // the box path in normalize is the single place the fit is worked out
      const entry = { id: z.id || null, scale_sent: sent, scale: land.scale, share,
        why: fit.changed ? 'the target was cut off or too small to read at the scale sent'
          : 'a box frames its own zoom, so the scale beside it was not used' }
      out.refit.push(entry); mine.push(entry)
    }
    if (share < T.FIT_LOW) {
      const entry = { id: z.id || null, what: el ? el.id : 'its box', share }
      out.warnings.push(entry); mine.push(entry)
    }
    // a new zoom has no id until the document mints one
    if (mine.some(e => e.id == null) && end > start) out.unnamed.push({ entries: mine, start, end })
  }
  return out.snapped.length || out.refit.length || out.warnings.length ? out : null
}

// A new zoom is named by the document, after the edit lands. Until then every report
// about it says "the new zoom", which is no use to an agent that wants to fix it.
function nameZooms(aim, doc) {
  for (const u of aim.unnamed) {
    const got = (doc.zooms || []).find(d => Math.abs(d.start - u.start) < 0.006 && Math.abs(d.end - u.end) < 0.006)
    for (const e of u.entries) if (e.id == null && got) e.id = got.id
  }
  for (const e of [...aim.snapped, ...aim.refit, ...aim.warnings]) if (e.id == null) e.id = 'the new zoom'
  return {
    ...(aim.snapped.length ? { snapped: { zooms: aim.snapped,
      why: 'a zoom aimed at a point was put on the element under that point and fitted to it' } } : {}),
    ...(aim.refit.length ? { refit: { zooms: aim.refit,
      why: 'the zoom was fitted to its box rather than to the scale sent, and each entry says why' } } : {}),
    warnings: aim.warnings.map(w => `${w.id} frames ${w.what} at ${w.share} of the view, ` +
      `the tightest a zoom goes (${require('./targets').BOX_MAX}x). ` +
      'Lasso a smaller area, or say the element is too small to fill the frame.'),
  }
}

// A picture of what just happened. An agent that reported from the numbers it sent
// said "done" over a zoom on the wrong half of the frame; one frame of the edit as it
// now stands costs a second and is the only thing that can tell it otherwise.
async function previewOf(src, check, sent, doc) {
  const at = check.length ? check[0] : firstChange(sent, doc)
  try {
    const p = await ops['edit.preview']({ path: src, at })
    return { image: p.image, at: p.at, why: 'this is the edit as it now stands at that moment. Look at it before replying.' }
  } catch (e) {
    // a frame that could not be drawn never undoes an edit that was applied
    return { error: (e && e.message) || String(e) }
  }
}
function firstChange(sent, doc) {
  for (const it of [...(sent.zooms || []), ...(sent.marks || [])]) {
    if (it && Number.isFinite(+it.start) && +it.end > +it.start) return r2((+it.start + +it.end) / 2)
  }
  return Math.min(1, (+doc.dur || 2) / 2)
}

// A new or moved zoom placed by centre and scale rather than by what it frames. Fine
// for "zoom in on the first two seconds"; for a thing on screen, Fetch's own fit from
// the box is what lands it, so the result says so.
function handAimed(FD, prev, sent, doc) {
  if (!Array.isArray(sent.zooms)) return []
  const was = new Map(((prev && prev.zooms) || []).filter(z => z && z.id).map(z => [z.id, z]))
  const out = []
  for (const z of FD.adoptIds(prev && prev.zooms, sent.zooms)) {
    if (!z || z.box || (z.x == null && z.y == null)) continue
    if (z.id && was.has(z.id) && FD.sameItem(was.get(z.id), z)) continue
    const got = (doc.zooms || []).find(d => z.id ? d.id === z.id : Math.abs(d.start - z.start) < 0.006 && Math.abs(d.end - z.end) < 0.006)
    out.push(`${(got && got.id) || 'The new zoom'} (${z.start}-${z.end} s) is aimed by a centre point you worked out, not by what it frames. ` +
      'If it is on an element, send element (its E id from find_on_screen) or its box instead, so Fetch fits the zoom to it.')
  }
  return out
}

async function timeFocus(src, prev, doc) {
  const T = require('./targets')
  const known = new Map(((prev && prev.marks) || []).filter(m => m && m.id).map(m => [m.id, m]))
  const crop = doc.crop !== undefined ? doc.crop : (prev && prev.crop) || null
  const moved = [], absent = []
  for (const m of doc.marks) {
    if (!m || !['lift', 'spotlight'].includes(m.kind)) continue
    const was = m.id && known.get(m.id)
    if (was && require('./fetchdoc').sameItem(was, m)) continue
    const box = T.cleanBox(m.box && typeof m.box === 'object' ? m.box : { x: m.x, y: m.y, w: m.w, h: m.h })
    const start = +m.start, end = +m.end
    if (!box || !(end - start >= 1)) continue
    const samples = await deps.proc.boxSamples(src, box, start, end, crop && crop.w > 0 ? crop : null)
    const r = T.presentSpan(samples, start, end)
    const name = m.id || `the new ${m.kind}`
    if (!r.present) { absent.push({ id: name, kind: m.kind, start, end }); continue }
    if (!r.moved) continue
    // too short once held to the element to read as a move: leave it and say so
    if (r.end - r.start < 0.8) { absent.push({ id: name, kind: m.kind, start, end }); continue }
    m.start = r.start; m.end = r.end
    moved.push({ id: name, kind: m.kind, from: [start, end], to: [r.start, r.end] })
  }
  return { moved, absent }
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
    const hide = require('./look').toClassic(doc.look).hideMacCursor
    out.macCursorHidden = hide === true || (hide !== false && track.length > 0)
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
  const Look = require('./look')
  const L = Look.resolve(doc.look)
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
    captions: { count: (doc.cues || []).length, burned: !!L.captions.show },

    crop: doc.crop, cropAR: doc.cropAR,
    ...(doc.viewport ? { viewport: doc.viewport } : {}),
    autoZoom: !!doc.autoZoom,
    camera: cam ? { recorded: true, on: cam.on !== false, x: cam.x, y: cam.y, size: cam.size } : { recorded: false },
    audioTrack: doc.audioTrack ? { name: doc.audioTrack.name, volume: doc.audioTrack.volume,
      offset: doc.audioTrack.offset, replace: !!doc.audioTrack.replace } : null,
    // the look as the preset it came from and what differs (get_look_schema for every field)
    look: Look.compact(doc.look, looksDir()),
    audio: doc.audio,
    pointer: pointerSummary(path, doc),

    // the values each setting accepts, so an agent never has to guess a font name
    options: {
      fonts: (deps.proc.fontList ? deps.proc.fontList() : ['Helvetica']),
      looks: Look.list(looksDir()).map(p => p.name),
      // from the exporter's own list, so an image someone dropped in is offered to
      // agents the moment it exists, not when this line is edited
      backgroundImages: deps.proc.backdropList().filter(b => b.image).map(b => b.id),
      textStyles: ['title', 'lower-third', 'label'],
      markKinds: ['redact', 'blur', 'lift', 'spotlight', 'step', 'loupe'],
      cropAR: ['free', '16:9', '9:16', '1:1', '4:5'],
    },
  }
}

// Saved looks live beside the backdrops a person adds, in userData, so an update never
// wipes them. The editor's inspector reads the same folder.
function looksDir() {
  return path.join(app ? app.getPath('userData') : require('os').tmpdir(), 'looks')
}

// Warnings for a look an agent sent: values clamped or unknown (validate), then what
// the look as a whole does on this take (Look.warnings: fields not drawn yet, a shape
// filled rather than letterboxed, chrome that cannot be removed).
function lookWarnings(patch, doc, file) {
  const Look = require('./look')
  const out = patch ? Look.validate(patch, { userDir: looksDir() }).warnings : []
  const L = Look.resolve(doc && doc.look)
  let browser = false
  try {
    // the app the take was named from (.name.json), or a take the pointer mapped as a page
    const note = deps.proc.readNameNote(file)
    const app = (note && note.front && note.front.app) || ''
    browser = !!(note && note.front && note.front.product) || /chrome|safari|arc\b|firefox|edge|brave|aside|opera|vivaldi|orion|dia\b/i.test(app)
  } catch {}
  let images
  try { images = deps.proc.backdropList().filter(b => b.image).map(b => b.id) } catch {}
  return out.concat(Look.warnings(L, { viewport: !!(doc && doc.viewport), browser, images }))
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
// Where renamed files went, old path to new. A take is renamed after it lands (from
// the app in front, then from what was said) and a person can rename one mid-session,
// so a path an agent was handed a minute ago may have moved. Any path it sends is
// followed here, so the path record_stop returned keeps working.
const moved = new Map()
function noteMoves(moves = []) {
  for (const [from, to] of moves) if (from && to && from !== to) moved.set(from, to)
  if (moved.size > 4000) moved.delete(moved.keys().next().value)
}
function follow(p) {
  let out = p
  for (let i = 0; i < 20 && out && moved.has(out) && !fs.existsSync(out); i++) out = moved.get(out)
  return out
}

function handleLine(sock, line, ctx) {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  const id = msg && msg.id
  const reply = obj => { try { sock.write(JSON.stringify({ id, ...obj }) + '\n') } catch {} }

  const op = msg && msg.op
  const fn = ops[op]
  if (!fn) return reply({ ok: false, error: `unknown op: ${op}` })
  if (msg.args && typeof msg.args.path === 'string') msg.args.path = follow(msg.args.path)

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
  else if (op === 'find' && result) detail = `${result.at}s${result.query ? `, "${result.query}"` : ''}`
  else if (op === 'edit.preview' && result) detail = (result.frames || [result]).map(f => `${f.at}s`).join(', ')
  else if (op === 'edit.enhance' && result) detail = result.path
  else if (op === 'recordings.trash' && result) detail = result.trashed
  else if (op === 'settings.set' && args && args.settings) detail = Object.keys(args.settings).join(', ')
  else if (op === 'edit.export' && result && result.path) {
    detail = result.engine === 'gl' ? `${result.path} · compositor`
      : result.engine ? `${result.path} · classic renderer${result.classic_because ? ` (${result.classic_because.join(', ')})` : ''}` : result.path
  }

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

module.exports = { start, stop, socketPath, VERSION, startingAgentTake, takeEndedAlone, stillNote, occludedTake, noteMoves, follow, checkTimes, liftable,
  // the lasso: main.js registers what the Elements pass found and the areas the person
  // drew, and apply_edit resolves R ids out of the same store
  noteFound, noteRegion, regionFor, forgetRegion,
  // the two rules that are code rather than prose, exercised by test/lasso.test.js
  withElements, aimZooms }
