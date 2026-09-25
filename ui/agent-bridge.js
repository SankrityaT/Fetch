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
const Shot = require('./shot')
// The machine inside a Simulator window: which device it is, how big its screen really
// is, and where the glass sits inside the frame. Pure arithmetic over strings, so it
// costs nothing to hold here (ui/simulator.js). ui/simctl.js, which spawns, is required
// at the call so a Mac with no Xcode pays for it only when an agent asks.
const Sim = require('./simulator')
// What a take listens to, and what its result may say it heard. Pure, and it carries the
// reason and the measurements as well as the rule (ui/recorder-opts.js).
const Opts = require('./recorder-opts')
// What every id an action uses is held to, as it acts (ui/guard.js). Pure, like Sim.
const Guard = require('./guard')

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
// What audioFor() decided for the take in hand. Held because record_start can only say
// what was wired and record_stop is the one that can read the written file.
let takeHeard = null
// The Library folder an agent's take of a project goes into once it lands, or null.
let takeProject = null
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
// Takes record_stop measured at the noise floor, so review does not offer transcribe on
// a take the agent was just told has nothing to hear.
const heardSilent = new Set()
// The same, for a pass Fetch ran for itself rather than for the agent: the lasso's
// snapping while the person scrubs, and the frame a zoom's aim is read from. A pass
// handed no earlier list numbers E1, E2... in reading order, and one handed a list
// keeps that list's ids where it is sure (ui/targets.js carryIds). Either way a
// background pass never goes into foundBy and is never handed the agent's list as its
// prior: that would renumber, or carry forward, ids the agent is still holding from its
// own find_on_screen, and E7 would resolve to a different element's box with no
// warning. Its ids still resolve; they just never take one away from the pass that
// minted it.
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
  'photos.do': 'Worked with backdrop photographs',
  'look.apply': 'Changed a look',
  'look.save': 'Saved a look',
  'edit.sheet': 'Looked over the whole edit',
  'edit.direct': 'Wrote the brief and the plan',
  'edit.review': 'Checked the edit against the brief',
  'edit.fit': 'Fitted the edit to a length',
  'edit.loop': 'Checked whether the clip loops',
  'chat.ask': 'Asked a question',
  'chat.propose': 'Proposed a change',
  'edit.revert': 'Took back its own last change',
  'voice.list': 'Listed the voices',
  'voice.speak': 'Generated a voiceover',
  'memory.remember': 'Remembered something',
  'memory.guidelines': 'Read the product\'s rules',
  'sample.do': 'Worked with the sample library',
  'job.cancel': 'Stopped its export',
  'shot.take': 'Took a screenshot',
  'sim.do': 'Worked with a simulator',
  'edit.versions': 'Read the version history',
  'projects.list': 'Listed the projects',
  'projects.get': 'Looked up a project',
}

// ── a shot is a take of one frame ────────────────────────────────────────
// So it comes through the ops a take comes through, and there is no second set of
// them. Exactly two things differ, and these three lines are all of both: which
// extensions are a capture, which document the window holds for one, and which moment
// of it there is to read. Nothing here draws anything.
const STILL_EXT = /\.(png|jpe?g|heic|heif|webp|tiff?|avif)$/i
const isShot = p => typeof p === 'string' && STILL_EXT.test(p)

// A take's document is window.fetchDoc and a shot's is window.fetchShot, and while one
// is open the other answers null (ui/editor.js), so the file decides the name rather
// than the caller.
const docOf = src => (isShot(src) ? 'window.fetchShot' : 'window.fetchDoc')
// The edit as it stands. While the person is looking at an old version the stage holds
// that version, and reading the stage would hand it on as the edit: get_edit wrote it to
// disk and every export after it read the past. The real edit is held aside
// (ui/autosave.js), and this reads that.
const docNow = src => `(window.fetchHistory && window.fetchHistory.current && window.fetchHistory.src() === ${JSON.stringify(src)} ` +
  `&& window.fetchHistory.current()) || ${docOf(src)}.get()`
// Who made a change, as the second argument every apply and undo takes, so the version
// history names the agent rather than "Agent" (ui/autosave.js reads opts.by).
const byArg = ctx => JSON.stringify({ by: (ctx && ctx.client) || 'Agent' })

// A capture has one moment and it is the first. Shot.HOLD is a clock the compositor is
// lent so that every arrival in the shared planner has landed by the frame it draws
// (ui/shot.js), not a place in the picture: ask ffmpeg for second 2 of a PNG and it
// hands back nothing at all.
const SHOT_AT = 0

const { AGENT_PREFS, HUMAN_ONLY_PREFS } = policy
// Where agents run. Never the product an agent means when it records "the app in front".
const AGENT_HOSTS = ['Terminal', 'iTerm2', 'Warp', 'Ghostty', 'kitty', 'Alacritty', 'WezTerm', 'Hyper',
  'Conductor', 'Claude', 'Codex', 'ChatGPT']

const ops = {
  // Sent once by the shim so the log can say which agent is driving rather than
  // just "an agent". Unknown to older shims, which simply never call it.
  async hello(args = {}, ctx) {
    if (ctx) ctx.client = String(args.client || '').slice(0, 40) || null
    // the in-app chat's own agent, so a message to the chat releases it and no other
    if (ctx) ctx.chat = args.chat === true
    return { ok: true }
  },

  async ping() {
    return { version: VERSION, app: app ? app.getVersion() : '0', recording: deps.isRecording() }
  },

  async 'record.status'() {
    const ended = !deps.isRecording() && endedTake ? { ended: { path: endedTake.path, stopped_early: endedTake.stopped_early } } : {}
    // Paused counts as recording (the file is still open), so it is said separately:
    // an agent that held a take needs to know it is still holding it.
    const paused = deps.isRecording() ? (await recPhase()) === 'paused' : false
    return { recording: deps.isRecording(), paused, pending: !!pendingTake, ...ended }
  },

  // Starts a take through the renderer so every visible affordance still happens.
  // Resolves only when the file exists, which is what a caller actually needs.
  async 'record.start'(args = {}, ctx) {
    if (deps.isRecording()) throw new Error('already recording')
    if (pendingTake) throw new Error('a take is already being awaited')
    endedTake = null; endingAt = 0
    takeProject = null

    const win = deps.getWindow()
    if (!win || win.isDestroyed()) throw new Error('Fetch is not running')

    // A project is named by its folder and recorded as the window of what runs from it,
    // found at this moment (projectTarget), or refused in a sentence. Never the app that
    // happens to be in front: that is the one thing "@majuro" did not mean.
    const proj = await projectArgs(args, ctx)
    if (proj) args = proj.args

    // A simulator is named by device and recorded as the window it sits in. That is the
    // whole of it: the take can then have an audio track, which the framebuffer capture
    // simctl offers cannot, and every transcript-spine feature Fetch has reads that
    // track. Can, and now does: system audio was off by default on every path, so what
    // an agent actually got was the silent file this sentence said it would not be
    // (ui/recorder-opts.js). What lands on it is one of two things, and the result says
    // which off the recorder's own report: the device's own sound, through a Core Audio
    // process tap that replayd never sees, where the person has already given Fetch
    // System Audio Recording on macOS 14.4 or later; otherwise everything this Mac plays,
    // the device among it, taken from the display with no app named, because a capture
    // filter naming apps is what took replayd, and with it every screen capture on the
    // Mac, down (Recorder.swift SoundPlan). Nothing is brought to the front to do it.
    let sim = args.simulator != null ? await simTarget(args.simulator) : null
    if (sim) args = { ...args, window: String(sim.window.id) }

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
    // What the take will listen to is decided before the person is asked, so the
    // question can say it: a yes to a picture of a phone is not a yes to its sound.
    const heardPlan = Opts.audioFor(args, { simulator: !!sim, prefs: deps.getPrefs ? deps.getPrefs() : null })
    await enforceAccess({ ...args, kind: 'take', sim, sound: heardPlan }, ctx, proj && proj.seen)

    // macOS sends no frames for the part of a window another covers, so a take of a
    // covered window is a frozen picture. Say so before recording anything, with the
    // way round it, rather than hand back a take of stale frames (occludedTake).
    if (args.window != null && !args.allow_covered && deps.windowCovered) {
      const hold = occludedTake(await deps.windowCovered(args.window).catch(() => null))
      if (hold) return hold
    }

    // Where the glass sits inside that window, measured off one capture of it before a
    // frame of the take is recorded. Everything this take is worth downstream is that
    // one rectangle: where a tap lands, where the disc is drawn, and what the crop keeps.
    // The person has just approved a recording of this window, so a still of it to
    // measure is inside that yes rather than a second question.
    const measuredAt = Date.now()
    if (sim) sim = await simMeasured(sim)

    // The house status bar, after the last thing that can refuse and before a frame is
    // captured, so nothing is left dressed for a take that never started. Put back on
    // stop. It is a property of the source rather than of the picture, so it is not a
    // look field: nothing after the fact can change what the clock said.
    const bar = sim && args.status_bar !== false ? await simDressed(sim) : null
    // Held from the moment it is dressed, not from the moment the take starts: between
    // those two lines are a setup, a renderer and a thirty second wait, and a failure in
    // any of them used to leave the device wearing Fetch's 9:41 with nothing holding a
    // reference to undo it. Cleared and undressed below on the way out.
    takeSim = sim ? { sim, bar } : null

    try {
      // A simulator take gets system audio, the device's own or the whole Mac's (above).
      // The sound is the only thing recording the
      // window buys over capturing the device's framebuffer, and it was off by default,
      // so the take an agent actually got was the silent file three descriptions said it
      // would not be (ui/recorder-opts.js carries the rule and its measurements).
      takeHeard = heardPlan
      await applySetup(win, args, takeHeard)
      // In the background unless the person asked to watch (a person-only setting).
      const quiet = !(deps.getPrefs && deps.getPrefs().agentTakesVisible)
      if (deps.setQuiet) deps.setQuiet(quiet, true)
      await win.webContents.executeJavaScript(`window.__quietTake = ${quiet}`)
      // A name the agent gives is used as it is and never replaced by an automatic one
      const naming = require('./naming')
      const given = args.name != null ? naming.fit(naming.clean(args.name)) : ''
      // the take of a project is filed in its Library folder once it lands (afterTake)
      takeProject = proj && proj.folder ? { folder: proj.folder } : null
      await win.webContents.executeJavaScript(`window.__takeName = ${JSON.stringify(given || null)}`)
      // Esc may have landed during the awaits above; a stopped agent starts nothing
      if (deps.held && deps.held()) {
        win.webContents.executeJavaScript('window.__takeName = null').catch(() => {})
        throw new Error('The person pressed Esc to stop you, so Fetch did nothing.')
      }
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

      // What was wired, on the result. What actually landed is record_stop's to say, off
      // the written file, because at this moment there is no file to read.
      // with the scope the recorder started with, where main.js has it (its started event)
      const audio = Opts.startedAudio({ ...takeHeard, scope: deps.takeScope ? deps.takeScope() : null })
      // The product's rules, on the first result of the take, so what must never be on
      // screen is read while there is still time to stop. The product is the one the
      // take's name gives, where it gives one.
      const about = proj && proj.product ? proj.product : args.name ? require('./memory').productOf(args.name) : null
      const rules = memoryState(null, about) || {}
      const ofProject = proj ? { project: proj.said } : {}
      // say which window was picked, so an agent that meant another can stop and name it
      if (sim && started && typeof started === 'object') {
        // What is on the glass, off the picture that measured it, so the first tap of the
        // take is the next call rather than a shot and a search.
        const screen = await simScreen(sim, { since: measuredAt })
        const seen = screen ? neverSeen(screen.path, screen.elements, about) : null
        return { ...started, audio, simulator: simFacts(sim, bar), ...(screen ? { screen } : {}), ...(seen || {}), ...ofProject, ...rules }
      }
      const picked = proj && proj.target && proj.target.pick.window
      return front && started && typeof started === 'object'
        ? { ...started, audio, recording: { window: String(front.id), app: front.app, title: front.title || '', chosen: 'the app in front' }, ...rules }
        : picked && started && typeof started === 'object'
          ? { ...started, audio, recording: { window: String(picked.id), app: picked.app, title: picked.title || '', chosen: `the project's own window: ${proj.target.why}` }, ...ofProject, ...rules }
          : (started && typeof started === 'object' ? { ...started, audio, ...ofProject, ...rules } : started)
    } catch (e) {
      takeProject = null
      // Nothing is left dressed for a take that never started, which is what the comment
      // above the dressing has always claimed and what this makes true.
      const held = takeSim
      takeSim = null
      // and no take carries what was decided for one that never happened
      takeHeard = null
      if (held) await simUndress(held.sim.udid)
      throw e
    }
  },

  async 'record.stop'() {
    if (!deps.isRecording() && endedTake && Date.now() - endedTake.at < 30 * 60e3) {
      const { at, ...r } = endedTake; endedTake = null
      return await afterTake(r)
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
    // The device's screen rectangle goes onto the document here, and the status bar goes
    // back. Both happen whatever the take did, which is what "every override is restored,
    // including on the failure path" means in code rather than in a promise.
    try {
      return await afterTake(await done)
    } catch (e) {
      // A take that never finished saving still dressed a device, and leaving it dressed
      // is the one failure the person sees on their own machine for days.
      const held = takeSim
      takeSim = null
      if (held) await simUndress(held.sim.udid)
      throw e
    }
  },

  // Where the agent's own pointer is, during its take. The take has no Mac pointer in
  // it (native-start records agent takes with --no-cursor), so this is the only cursor
  // the video will show. Stamped on the take's clock in main.js, which also shows it
  // live over the recorded window (agent-cursor.html). Neither moves the Mac's pointer.
  async 'record.pointer'(args = {}) {
    if (!deps.pointer) throw new Error('this version of Fetch cannot draw a pointer')
    return deps.pointer(args)
  },

  // Hold a take and let it go again, through the same hotkey the person's own Pause
  // uses, so the camera and the cursor track lose the same stretch the screen does and
  // the take stays one file. An agent driving a long flow that hits a login screen can
  // wait rather than stop and start again and leave two takes behind.
  async 'record.pause'() {
    if (!deps.isRecording()) throw new Error('not recording. record_start begins a take.')
    // The renderer owns the state, so the answer is read back rather than assumed: an
    // agent that cannot tell a pause from a resume sends this twice.
    const was = await recPhase()
    deps.toRenderer('pause')
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 50))
      const now = await recPhase()
      if (now && now !== was) return { paused: now === 'paused', recording: now === 'recording' }
    }
    return { paused: was !== 'paused', recording: was === 'paused' }
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
    // A simulator window carries what is inside it, so an agent stops string-matching
    // the app name to find a phone and reads the device, its own screen and whether the
    // pixels on screen are the device's own. One join, and only when there is a
    // simulator window to join to.
    const withDevice = await attachDevices(list || [])
    return withDevice
      .filter(w => w.width > 120 && w.height > 120)   // drop tooltips and shadow panes
      .map(w => ({ id: w.id, app: w.app, title: w.title, width: w.width, height: w.height,
        ...(w.device ? { device: w.device } : {}) }))
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

  // ── projects ───────────────────────────────────────────────────────────
  // The folders of code the person works in, from Conductor, Orca and Claude Code
  // (ui/projects.js), so an agent outside the app can do what @ does inside it. The
  // list is lean on purpose: names, paths and branches, and a description only for the
  // one project looked up. Nothing here opens more than ui/projects.js already read.
  // Other tools' projects are the person's own, so an agent outside the app reaches them
  // only with the person's yes (projectsAllowed); Fetch's own chat is where @ hands one
  // over already.
  async 'projects.list'(args = {}, ctx) {
    await projectsAllowed(ctx)
    const list = await projectList()
    const limit = Math.max(1, Math.min(100, Math.round(+args.limit) || 20))
    const q = String(args.query || '').trim()
    let hits = list
    if (q) { try { hits = require('./projects').findProjects(q, list, limit) } catch { hits = [] } }
    return { count: list.length, ...(q ? { query: q, matched: hits.length } : {}),
      projects: hits.slice(0, limit).map(p => projectRow(p, { about: false })),
      do_next: 'get_project with one of these names says what it is and what runs from it; record_start and ' +
        'take_shot take project and find its window themselves.' }
  },

  // One project, whole: where it is, what it is in its own words, what runs from it this
  // moment and which window record_start would take, the product its rules are kept
  // under and the Library folder its takes go in.
  async 'projects.get'(args = {}, ctx) {
    await projectsAllowed(ctx)
    const r = resolveProject(args.project != null ? args.project : args.name, await projectList())
    if (!r.ok) return { ok: false, why: r.why, ...(r.candidates ? { candidates: r.candidates } : {}) }
    const p = r.project
    const product = productFor(p, ownRoot())
    const running = await projectRunning(p, 15000)
    let rules = null
    try {
      const g = require('./guidelines').read({ root: ownRoot(), product })
      if (g && g.ok) rules = g.text
    } catch {}
    const pick = running && running.pick
    const ready = !!(pick && !(pick.window && pick.window.onScreen === false))
    return {
      ok: true,
      project: projectRow(p),
      running: running
        ? { ...(pick ? { pick: candidateRow(pick) } : {}), why: running.why,
          candidates: (running.candidates || []).slice(0, 6).map(candidateRow) }
        : { why: 'Fetch could not read what is running in time. Ask again.' },
      ...(product ? { product } : {}),
      ...(rules ? { guidelines: rules } : {}),
      library_folder: projectFolder(p),
      do_next: ready
        ? `record_start with project "${projectArgName(p)}" records ${pick.window ? `window ${pick.window.id}` : 'it'}; ` +
          `take_shot with project "${projectArgName(p)}" captures one frame of it.`
        : 'Nothing of it can be recorded yet. Tell the person what would change that (the why above), ' +
          'and never record another window in its place.',
    }
  },

  // ── the machine inside the window ──────────────────────────────────────
  // One op behind one tool with five actions, because six tools for six simctl verbs
  // would be six tool descriptions of prose in every context window for one capability.
  //
  // Everything here except the touch already ships with Xcode, and Fetch writes none of
  // it: ui/simctl.js builds argv, reads the exit code and says a sentence. simctl has no
  // tap, no swipe and no type, so a touch is driven by a tool the person installed or it
  // is refused in words, and the take is recorded either way with the disc drawn where a
  // finger went.
  //
  // Consent is never a field the agent passes: it is the person's own yes, asked for
  // here (askPerson) and handed to policy.simDecide, which is checked before any spawn.
  async 'sim.do'(args = {}, ctx) {
    const action = String(args.action || '').trim().toLowerCase()
    if (!SIM_DOES.includes(action)) {
      throw new Error(`simulator does ${SIM_DOES.join(', ')}, and not "${args.action || ''}". ` +
        'Creating, erasing and deleting somebody\'s devices is refused to everyone, and the rest ' +
        'is a command line of their own.')
    }
    // each identifier in the argument that takes it, before anything is asked or spawned
    const fixed = simArgs(action, args)
    args = fixed.args
    const sims = await simModel()
    if (action === 'list') return simList(sims)

    // tap and restore default to the device the take in hand is of. The documented loop
    // is record_start on a simulator and then a tap per screen, and naming the device on
    // every one of those calls is a UDID the model has to carry for the whole take. boot
    // and go are not defaulted: those change something, and the thing they change has to
    // be named out loud.
    const fallback = (action === 'tap' || action === 'restore') && takeSim ? takeSim.sim.udid : null
    const found = Sim.resolve(sims, args.device != null ? args.device : fallback)
    if (!found.ok) {
      throw new Error(`${found.reason}${deviceHint(args.device)} simulator with action list says which devices are here.` +
        (fallback ? '' : ' With a recording of a simulator running, tap and restore take that device by default.'))
    }
    const sim = found.value
    const out = action === 'ready' ? await simReady(sim, args, ctx)
      : action === 'go' ? await simGo(sim, args, ctx)
        : action === 'tap' ? await simTap(sim, args, ctx)
          : await simRestore(sim)
    return fixed.moved.length ? { ...out, moved: fixed.moved } : out
  },

  // ── one frame ──────────────────────────────────────────────────────────
  // A screenshot, through the capture path a take takes: the same framework, the same
  // never-record list applied before a pixel is read, and the same folder, so the raw
  // capture sits in Original/ and whatever is styled from it lands beside it. This is
  // the one op a shot needs of its own. Everything after it is a tool a take already
  // had, pointed at a picture.
  async 'shot.take'(args = {}, ctx) {
    if (!deps.takeShot) {
      throw new Error('this build of Fetch cannot take a screenshot, so there is nothing to style. ' +
        'record_start records the screen instead.')
    }
    // A project's window, found now, exactly as record_start finds one, or the sentence
    // that says why there is none
    const proj = await projectArgs(args, ctx)
    if (proj) args = proj.args
    const region = args.region && typeof args.region === 'object' ? args.region : null
    let front = null, target = null
    // A simulator is a window, always. A region of the device screen is judged as a
    // display, sees whatever is under it, and gives frozen pixels where something covers
    // it, so the device is named and the glass is cropped to in the picture instead.
    let sim = args.simulator != null ? await simTarget(args.simulator) : null
    if (sim) target = { windowId: String(sim.window.id) }
    else if (args.window != null) target = { windowId: String(args.window) }
    else if (region) target = { region, ...(args.display != null ? { displayId: String(args.display) } : {}) }
    else if (args.display != null) target = { displayId: String(args.display) }
    else {
      // Window first, exactly as record.start chooses one: the window of the app in
      // front, never Fetch and never the terminal the agent itself runs in.
      const prefs = deps.getPrefs ? deps.getPrefs() : {}
      const never = (prefs.neverRecord || policy.DEFAULT_NEVER || []).map(x => typeof x === 'string' ? x : x && x.app).filter(Boolean)
      front = deps.frontWindow ? await deps.frontWindow([...AGENT_HOSTS, ...never]).catch(() => null) : null
      if (!front) {
        throw new Error('no window is in front to capture. Name one from list_windows, ' +
          'or a whole screen from list_displays.')
      }
      target = { windowId: String(front.id) }
    }

    // The person's say, through the same gate a take goes through and asked once for
    // the session. take-shot refuses an unapproved agent capture on its own, so this
    // is the question rather than a second opinion about the policy.
    await enforceAccess({ kind: 'shot', window: target.windowId, display: target.displayId, sim }, ctx, proj && proj.seen)
    // Dressed for the picture and undressed again in the same call: a still is over
    // before the dialog is off the screen, so nobody's simulator is left at 9:41.
    //
    // Unless a take of this same device is already holding the dressing. The documented
    // loop shoots the device it is recording, once before every tap, and undressing here
    // put the person's own clock back in the middle of the video: the take came out half
    // at 9:41 and half not, and record_stop then restored nothing while still claiming
    // it had. Only what this call dressed does this call take off.
    const worn = !!(sim && takeSim && takeSim.sim.udid === sim.udid)
    const bar = worn ? takeSim.bar
      : (sim && args.status_bar !== false ? await simDressed(sim) : null)
    let got = null
    try {
      got = await deps.takeShot({ ...target, by: 'agent', approved: true,
        cursor: args.cursor === true })
    } finally { if (sim && !worn) await simUndress(sim.udid) }
    if (!got || !got.ok) throw new Error(`Fetch took no screenshot: ${(got && got.error) || 'the capture failed'}`)

    // The picture this call just took is also what measures where the glass sits inside
    // the window, so the rectangle the crop and the next tap need costs nothing more
    // here. Measured before the rename, because a rename moves the file.
    if (sim) sim = await simMeasured(sim, got.original)

    // Named from what it captured, the way a take is named from the app in front. A
    // still has no transcript, so this is the only name it will ever get by itself,
    // and a name the agent gave is used as it stands and never replaced.
    let file = got.original, name = got.name
    const naming = require('./naming')
    const stem = args.name != null
      ? naming.fit(naming.clean(args.name))
      : naming.shotName({ app: got.app, title: got.title, area: region ? 'region' : target.displayId ? 'display' : 'window' })
    if (stem) {
      // A capture is never lost to a rename: the pixels are on disk either way.
      try {
        const r = await ops['recordings.rename']({ path: file, name: stem })
        file = r.path; name = r.name
      } catch (e) { console.warn('[shot] could not name the capture:', e && e.message) }
    }
    // Opened where the person can see it, the same way an agent editing a take is seen
    // opening it, and it is the window every tool below reads the document from.
    //
    // What it was a capture of goes onto the document in the same call. A window capture
    // brings its own title bar into the picture and a display capture its menu bar, and
    // a drawn frame round one of those is two title bars: the compositor's ownChrome
    // (ui/compositor/plan.js) and review's double-chrome are the only things that read
    // it, and neither can work it out from pixels.
    //
    // And the address, where this capture was of a project's own page and Fetch knew it
    // without being told: the browser window was found by the server the project is
    // running (ui/project-windows.js candidate url), so the address is a fact about the
    // capture rather than a guess. A drawn browser frame fills its field from this
    // (ui/compositor/plan.js barText), and Fetch still invents no host: with nothing
    // known the field is simply drawn empty.
    const found = proj && proj.target && proj.target.pick
    const url = found && found.kind === 'browser' && found.url ? String(found.url) : ''
    const cap = { kind: got.kind, ...(got.app ? { app: got.app } : {}), ...(got.title ? { title: got.title } : {}),
      ...(url ? { url } : {}) }
    // And where the glass is, on a simulator. That one rectangle is what crops the
    // device's own outline out of the picture, what turns a device point into a place on
    // the frame, and what lets the drawn phone be the only phone in the deliverable.
    const written = { captured: cap, ...(sim ? simOnDoc(sim) : {}) }
    const shot = await inEditor(file, `${docOf(file)}.apply(${JSON.stringify(written)}, ${byArg(ctx)})`)
      .catch(() => inEditor(file, docNow(file)).catch(() => null))
    // The picture, with the capture. This is the one tool that makes the only artefact
    // in the job, and it was the one tool that handed back no image of it, so an agent
    // that cannot see the screen spent a second call looking at its own work.
    const p = shot ? await drawShot(shot, file, { width: 1280 }).catch(() => null) : null
    // The product's rules held to the picture the moment it exists: one pass reads it
    // where there is a never-rule to hold it to, and the look and the name are checked
    // against the document as it stands.
    if (shot) await readForRules(file, SHOT_AT, shot.crop)
    const ruled = shot ? rulesCheck(file, shot, { width: shot.w, height: shot.h }) : null
    // a shot of a project goes into that project's Library folder
    const library = proj && proj.folder ? await fileInFolder(file, proj.folder).catch(() => null) : null
    return {
      ...(ruled ? { guidelines: ruled } : {}),
      path: file, name, kind: 'shot',
      ...(proj ? { project: proj.said } : {}),
      ...(library ? { library } : {}),
      captured: { ...cap,
        width: got.width, height: got.height, scale: got.scale,
        ...(got.display != null ? { display: String(got.display) } : {}),
        ...(got.clipped ? { clipped: true } : {}),
        ...(front ? { chosen: 'the app in front' } : proj && proj.target ? { chosen: `the project's own window: ${proj.target.why}` } : {}) },
      ...(sim ? { simulator: simFacts(sim, bar) } : {}),
      ...(shot ? { shot: summariseShot(shot, file) } : {}),
      ...(p ? { preview: { image: p.file, at: SHOT_AT, why: 'the capture as it stands, unstyled. Look at it before deciding what to do with it.' } } : {}),
      do_next: 'direct writes what the picture is for, apply_look styles it, find_on_screen names what is on it, ' +
        'apply_edit places marks and the headline on it, review checks it and export writes the PNG. ' +
        'The capture in Original/ is never touched.',
      // the product's rules before the picture is styled: its look and what must not be on it
      ...memoryState(file),
    }
  },

  // ── editing ────────────────────────────────────────────────────────────
  // The same document the editor drives, so an agent working over MCP and a person
  // working in the window are changing one thing, not two. Every change is written to
  // the recording's .fetchdoc.json, so it survives the app closing and is what the
  // next export reads.
  async 'edit.get'(args = {}) {
    if (!args.path) throw new Error('path is required')
    if (isShot(args.path)) {
      const shot = await shotOf(args.path)
      return { ...summariseShot(shot, args.path), ...memoryState(args.path) }
    }
    const doc = await inEditor(args.path, docNow(args.path))
    deps.proc.writeDoc(args.path, doc)
    const out = summarise(doc, args.path)
    // The words themselves only on request: a long transcript is thousands of tokens,
    // but correcting what the recogniser misheard needs them.
    if (args.include_cues) out.captions.cues = (doc.cues || []).map(c => ({ id: c.id, start: c.start, end: c.end, text: c.text }))
    // likewise the pointer track, which is hundreds of points on a long take
    if (args.include_pointer) out.pointer.track = pointerTrack(args.path, doc)
    return out
  },

  async 'edit.apply'(args = {}, ctx) {
    if (!args.path) throw new Error('path is required')
    if (!args.doc || typeof args.doc !== 'object') throw new Error('doc is required')
    if (isShot(args.path)) return await applyToShot(args, ctx)
    const FD = require('./fetchdoc')
    if (args.doc.remove != null && !Array.isArray(args.doc.remove)) throw new Error('remove is a list of ids, e.g. remove: [\'M12\']')
    // marks: { remove: [...] } was taken as nothing and reported as done
    for (const k of ['clips', 'zooms', 'texts', 'marks', 'cues']) {
      if (args.doc[k] != null && !Array.isArray(args.doc[k])) {
        throw new Error(`${k} is a list; to delete items send remove: ['M12'] beside it in doc, not inside it`)
      }
    }
    // A sound file that is not there exports in silence, and nobody finds out until
    // the person plays the file. It merges key by key, so file: null takes it off.
    const at = args.doc.audioTrack
    if (at && typeof at === 'object' && at.file != null) {
      if (typeof at.file !== 'string' || !fs.existsSync(at.file)) {
        throw new Error(`no sound file at ${at.file}. audioTrack.file is an absolute path to an audio file on this Mac; ` +
          'voiceover writes one and sets this for you, and audioTrack: null takes the track off.')
      }
    }
    const prev = ['marks', 'zooms', 'texts', 'remove'].some(k => Array.isArray(args.doc[k]))
      ? await inEditor(args.path, docNow(args.path)) : null
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
    const doc = await inEditor(args.path, `window.fetchDoc.apply(${JSON.stringify(args.doc)}, ${byArg(ctx)})`)
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
    const rates = rateNotes(FD, args.doc)
    if (rates.length) warn.push(...rates)
    const gains = gainNotes(FD, args.doc, doc)
    if (gains.length) warn.push(...gains)
    if (warn.length) out.warnings = (out.warnings || []).concat(warn)
    const along = FD.focusAlongside(prev, doc)
    if (along.length) {
      out.alongside = { marks: along, why: 'these still play during the zoom you changed. An earlier edit may have added them unasked: ' +
        'remove one (remove: [id]) if the person did not ask for it or complained about a highlight there, and name each in your reply' }
    }
    // What is left of the plan and how far the edit still is from the brief, on every
    // call. A description asking an agent to check is a suggestion; a field it is
    // handed every time is not. step: 'P3' closes that step of the plan.
    Object.assign(out, jobState(args.path, doc, args.step, await takeShape(args.path)), memoryState(args.path))
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
        'null puts it back to the preset, { preset: name } starts from that look. The marks on a field say which ' +
        'renderer draws it; apply_look warns when the export you asked for would leave one out.',
      fields: Look.describe(),
      looks: Look.list(looksDir()).map(p => p.name),
    }
  },

  async 'look.list'() {
    const Look = require('./look')
    return {
      looks: Look.list(looksDir()).map(p => ({ name: p.name, label: p.label, about: p.doc || undefined,
        for: p.for || undefined, yours: p.mine || undefined })),
      backgrounds: { gradients: Object.keys(require('./look-schema').GRADIENTS),
        images: deps.proc.backdropList().filter(b => b.image).map(b => b.id),
        // Most of those images are photographs somebody took. The photos tool names
        // each photographer, and searches Unsplash for one that is not here yet.
        photographs: 'photos lists these with their photographers and finds more' },
    }
  },

  // ── photographs, for a ground a take sits on ─────────────────────────────
  // "Put it on a photo of mountains." Ten photographs ship with Fetch, each with the
  // name of whoever took it, and with the person's own Unsplash key the same tool
  // searches Unsplash for one that is not bundled. Three actions behind one op, the way
  // a simulator is one: list, search, use.
  //
  // Two rules this op keeps, and they are Unsplash's rather than Fetch's.
  // A search leaves the machine, so it runs on the person's ask and never on a hunch of
  // the agent's own: the tool says so, and with no key it costs nothing because nothing
  // is sent. And every photograph carries its credit out of here, in the result the
  // agent reads, so the sentence it writes back can name the photographer.
  async 'photos.do'(args = {}, ctx) {
    const unsplash = require('./unsplash')
    const said = x => String(x == null ? '' : x).trim()
    const action = said(args.action).toLowerCase() ||
      (said(args.query) ? 'search' : said(args.photo) ? 'use' : 'list')
    const credit = c => c && { photographer: c.photographer, profile: c.profile, photo: c.photo, text: c.text }
    // Say who took it, wherever a photograph leaves this op. A credit nobody passes on
    // is a licence term quietly broken, and the agent is the one writing the reply.
    const CREDIT_RULE = 'Name the photographer when you say what you did, in the words of credit.text.'

    if (action === 'list') {
      const st = await unsplash.status().catch(() => ({ connected: false }))
      const photos = deps.proc.backdropList().filter(b => b.image)
        .map(b => ({ id: b.id, label: b.label, yours: !!b.mine, ...(b.credit ? { credit: credit(b.credit) } : {}) }))
      return {
        photos,
        use: 'photos with action use and the id puts one under a take: background.kind image, background.image that id.',
        search: st.connected
          ? 'photos with action search and a query looks on Unsplash for one that is not here.'
          : unsplash.NO_KEY,
        credit: photos.some(p => p.credit) ? CREDIT_RULE : undefined,
      }
    }

    if (action === 'search') {
      const query = said(args.query)
      if (!query) throw new Error('search needs query: what the person asked for, for example "mountains at dusk".')
      const r = await unsplash.search(query, { page: args.page })
      // No key, no network, no answer to spend a turn on: the sentence says what the
      // person has to do, and it is the same sentence the picker shows them.
      if (r.ok === false) throw new Error(r.message || r.why || 'Unsplash did not answer.')
      return {
        query: r.query, page: r.page || 1, pages: r.pages || 0, total: r.total || 0,
        photos: (r.results || []).map(p => ({
          photo: p.id,
          about: p.alt || null,
          size: p.width && p.height ? `${p.width} x ${p.height}` : null,
          colour: p.color || null,
          credit: credit(p.credit),
        })),
        use: 'photos with action use and photo set to one of these ids saves it and puts it under the take.',
        credit: CREDIT_RULE,
        source: 'Unsplash',
      }
    }

    if (action !== 'use') throw new Error(`photos takes list, search or use, and "${action}" is none of them.`)

    // Two kinds of id, and the difference is whether anything leaves the machine. An
    // img: id is already a file on this Mac (bundled, or one the person or an earlier
    // search saved), so it is applied with no network at all. Anything else is a photo
    // from a search this session ran, which is fetched once into the person's own
    // backdrops folder and never fetched again.
    const want = said(args.photo || args.id)
    if (!want) throw new Error('use needs photo: an id from photos list, or one from photos search.')
    let id = want, cr = null, saved = null
    if (/^img:/i.test(want)) {
      const hit = deps.proc.imageBackdrops().find(b => b.id === want)
      if (!hit) {
        const near = deps.proc.backdropList().filter(b => b.image).map(b => b.id).slice(0, 8).join(', ')
        throw new Error(`no backdrop called ${want} on this Mac. photos list names the ones there are: ${near}`)
      }
      id = hit.replacedBy || hit.id
      cr = credit(hit.credit)
    } else {
      const r = await unsplash.use(want, { dir: deps.proc.userBackdropDir() })
      if (!r || r.ok === false) throw new Error((r && (r.message || r.why)) || 'that photo could not be saved.')
      id = r.id
      cr = credit(r.credit)
      saved = { file: r.file, already: !!r.already, source: 'Unsplash' }
    }

    const out = { photo: id, ...(cr ? { credit: cr, crediting: CREDIT_RULE } : {}), ...(saved ? { saved } : {}) }
    if (!said(args.path)) return { ...out, applied: false, next: 'apply_look with background: { kind: "image", image: "' + id + '" }' }
    // Through look.apply, so it lands in the editor in front of the person and one Undo
    // takes it back, exactly as any other change to a look does.
    const applied = await ops['look.apply']({ path: args.path, step: args.step,
      look: { background: { kind: 'image', image: id } } }, ctx)
    return { ...out, applied: true, ...applied }
  },

  // A look onto a recording's edit: a preset, a patch, fields to reset, or all three.
  // Through the editor like apply_edit, so the person sees it and one Undo takes it back.
  async 'look.apply'(args = {}, ctx) {
    if (!args.path) throw new Error('path is required')
    const Look = require('./look')
    const patch = { ...(args.look && typeof args.look === 'object' ? args.look : {}) }
    if (args.preset) patch.preset = args.preset
    for (const p of Array.isArray(args.reset) ? args.reset : []) patch[String(p)] = null
    if (!Object.keys(patch).length) throw new Error('send preset, look or reset')
    // A shot holds the same look an edit holds, whole and unconverted, so a preset
    // saved off a recording lands on a capture unchanged and this is one call, not two.
    if (isShot(args.path)) return await applyToShot({ ...args, doc: { look: patch } }, ctx)
    const doc = await inEditor(args.path, `window.fetchDoc.apply(${JSON.stringify({ look: patch })}, ${byArg(ctx)})`)
    deps.proc.writeDoc(args.path, doc)
    const out = { look: Look.compact(doc.look, looksDir()) }
    const w = lookWarnings(patch, doc, args.path)
    if (w.length) out.look_warnings = w
    // The plan, and the step this call closes. Applying a look is a step of a job like
    // any other, and this was the one change tool that could not close one, so closing
    // it cost a direct call that did nothing else.
    // and the product's rules, since how its pictures look is one of them
    Object.assign(out, jobState(args.path, doc, args.step, await takeShape(args.path)), memoryState(args.path))
    return out
  },

  async 'look.save'(args = {}) {
    if (!args.name) throw new Error('name is required')
    const Look = require('./look')
    let look = args.look && typeof args.look === 'object' ? Look.validate(args.look).look : null
    if (!look) {
      if (!args.path) throw new Error('send path (to save that recording\'s look) or look')
      // A shot stores the look untouched, fades and all, so what is saved off one is
      // the whole look and applies to a recording unpinned.
      if (isShot(args.path)) look = (await shotOf(args.path)).look
      else {
        const meta = await deps.proc.probeMeta(args.path).catch(() => ({}))
        look = deps.proc.readDoc(args.path, meta && meta.duration).look
      }
    }
    const saved = Look.save(looksDir(), args.name, look)
    return { name: saved.name, label: saved.label, changes: saved.look }
  },

  // Renders the recording's current edit, exactly what the editor's Export would.
  // Reads the saved document rather than asking the window, so it works whether or
  // not the clip is open, which is the point of doing it without the app.
  async 'edit.export'(args = {}, ctx) {
    if (!args.path) throw new Error('path is required')
    if (isShot(args.path)) return await exportShot(args)
    const FD = require('./fetchdoc')
    const meta = await deps.proc.probeMeta(args.path).catch(() => ({}))
    const doc = cornerTrusted(deps.proc.readDoc(args.path, meta && meta.duration))
    if (!doc.clips.length) {
      // a recording nobody has edited has no clips yet; export all of it
      doc.clips = [{ id: 'C1', start: 0, end: (meta && meta.duration) || doc.dur }]
    }
    // The product's rules, before a frame is drawn: something a never-rule keeps off
    // screen that was read on the take and is not under a redaction refuses the file.
    const ruled = rulesCheck(args.path, doc, { gate: true, width: meta && meta.width, height: meta && meta.height })
    if (ruled && ruled.refused) throw rulesRefusal(ruled)
    // An app preview: the deliverable's rectangle, its length, its frame rate, its codec
    // and its container, all decided before a frame is drawn (ui/sizes.js preview). Every
    // one of them is a rule the store measures the file against, and the named job ends
    // here, so this used to be the refusal that ended it: "Fetch draws a video at the
    // take's own shape or at 720 or 1080 tall".
    const Sizes = require('./sizes')
    let want = null
    if (args.size != null) {
      const got = Sizes.resolve(args.size)
      if (!got.ok) throw new Error(got.reason)
      const p = got.preset
      if (p.kind !== 'video') {
        throw new Error(`${p.id} is ${p.what.toLowerCase()} and this is a recording. ` +
          'take_shot the device and export that at this size, or ask for an app preview size.')
      }
      // The crop is the device glass in the capture's own pixels, which is the part of
      // the frame that is the app: the same rectangle a still is fitted from.
      const c = doc.crop && +doc.crop.w > 0 && +doc.crop.h > 0
        ? { w: Math.round((meta.width || 0) * +doc.crop.w), h: Math.round((meta.height || 0) * +doc.crop.h) } : null
      // The family the take already records, where the agent did not say one: an iPhone
      // take asked into an iPad size is refused by name, as the description promises,
      // rather than drawn small in the middle of it. The rate is the take's cadence, not
      // the header's average, which reads 14 on a take that sat still half the time
      // (processor.js probeCadence says why).
      const dev = doc.device || null
      want = Sizes.preview({ w: meta.width, h: meta.height, seconds: FD.outDuration(doc),
        fps: meta.cadence || meta.fps,
        hasAudio: !!meta.hasAudio, family: args.family || (dev && dev.family) || null, codec: 'h264', container: 'mp4' },
      p.id, { crop: c, share: drawnShare(doc),
        device: dev && dev.screen ? { w: +dev.screen.w, h: +dev.screen.h } : null })
      if (!want.ok) {
        // The layout route, said as the call that takes it. The take is drawn inside the
        // look's padding, so more padding is the capture at a smaller share of the
        // picture, and that is the one fix an agent can make without the person's hands.
        const pad = want.maxShare > 0 && want.maxShare < 1 ? Math.ceil(((1 - want.maxShare) / 2) * 100) / 100 : null
        // A plain look has no padding to give: the take fills the picture whatever it says.
        const plain = drawnShare(doc) >= 1
        const route = pad != null && pad <= 0.22
          ? [`apply_look { ${plain ? 'background: { kind: \'video-blur\' }, ' : ''}frame: { padding: ${pad} } } draws the capture at ` +
            `${Math.floor(want.maxShare * 100)}% of the picture, which is its own pixels, and export again`]
          : []
        // Everything else that does not hold, in the same answer. The judged job's first
        // refusal named the upscale and held back the length, which was known, for a
        // second call: the description promises everything is named before anything is
        // drawn, and this is where that promise is kept or broken.
        const len = Sizes.lengthPlan(FD.outDuration(doc), {})
        const also = !len.ok ? [len.reason, ...(len.fix || [])] : len.needs ? [len.needs] : []
        throw new Error([want.reason, ...(want.fix || []), ...route,
          ...also.filter(l => l && l !== want.reason)].join('\n'))
      }
      // Everything that is still somebody's decision, named with the call that makes it.
      // A window out of a longer take is fit_to_length's to choose, on the take's own
      // spine, and never a number picked here.
      if (!want.ready) throw new Error([...want.needs, ...want.steps].join('\n'))
    }

    const opts = FD.toExportOpts(doc, {
      format: want ? want.container : (args.format || 'mp4'),
      quality: args.quality || 'balanced',
      // resolution and an exact size are two answers to one question, and the store's is
      // the one that gets the file rejected for being one pixel out.
      scale: want ? undefined : (args.resolution ? +args.resolution : undefined),
    })
    if (want) {
      // A pair of integers, not a shape. The picture is composed at the preset's own
      // ratio and drawn at its own pair, because a file one pixel out is rejected on
      // upload, and the rate is the take's own divided by a whole number: a dropped
      // frame is the take sampled less often, where an invented one is motion that never
      // happened.
      opts.backdropAspect = want.size.w / want.size.h
      opts.size = { ...want.size }
      // the take where the gate judged it, not where the look's padding would have put it
      opts.box = { ...want.box }
      opts.fps = want.fps.out
    }
    // Kept by the key the caller cancels with, so the MCP server can stop it when its
    // client does, and a socket that closes takes its exports with it. A stop answers
    // at once and says so in words, and the file that was there is left as it was.
    let r
    try {
      r = await tracked(args.job, ctx, () => deps.exportDoc(args.path, opts, args.job ? 'agent:export:' + args.job : undefined), args.path)
    } catch (e) {
      if (e && e.cancelled) throw new Error(STOPPED_SAID)
      throw e
    }
    await cornerOntoDoc(args.path, meta)
    const mb = r && r.file && require('fs').existsSync(r.file)
      ? +(require('fs').statSync(r.file).size / 1e6).toFixed(1) : null
    // which renderer drew it: gl (the compositor) or classic, and what kept it classic
    const engine = r && r.engine ? { engine: r.engine, ...(r.engine === 'classic' && r.why && r.why.length ? { classic_because: r.why } : {}) } : {}
    // What the renderer that actually drew it leaves out. A GIF goes to the classic
    // renderer, which draws no treatment, and used to say nothing about dropping it.
    const lw = lookWarnings(null, doc, args.path, { engine: r && r.engine, format: args.format || 'mp4' })
    // The rubric, on the file the person now has. The export still happens: refusing
    // one on somebody's own machine is rude. The agent is simply never handed a file
    // without the list of what is still wrong with it.
    let checked = null
    const lv = await takeLevels(args.path, doc, meta)
    try {
      const Review = require('./review')
      const c = Review.review({ doc: withCues(args.path, doc), ...briefAndBeats(args.path, meta), path: args.path,
        looks: require('./look').list(looksDir()), levels: lv, rules: wordsAgainstRules(args.path, doc) })
      checked = { verdict: c.verdict, score: c.score, summary: c.summary, blocking: Review.blocking(c), look_at: c.look_at }
    } catch {}
    // A clip meant to autoplay on a page is judged by its wrap, and the person is
    // holding the file now. Only where the look asks for a loop: it costs a plan.
    let loop = null
    if ((require('./look').resolve(doc.look).motion || {}).loop) {
      try { loop = await loopCheckOf(args.path, doc, meta) } catch {}
    }
    // The store measures the file, so this does too: read off what was written rather
    // than off the plan that asked for it.
    const store = want ? await clipVerdict(want, r && r.file,
      { expect: FD.outDuration(doc), kbps: r && r.written && r.written.kbps }) : null
    // The file's length where it was measured, and the plan's only where nothing was: the
    // judged preview said 28 at the top and 24 in store, and the top is what gets relayed.
    const fps = opts.fps || (r && r.render && r.render.fps)
    const seconds = r && r.written && r.written.frames && fps
      ? +(r.written.frames / fps).toFixed(2) : +FD.outDuration(doc).toFixed(2)
    // The deliverable written closes the plan's export step. A store file that is not the
    // store file has not delivered anything, so that step stays open.
    const Director = require('./director')
    let step = args.step || null
    if (!step && r && r.file && (!store || store.exact)) {
      try { step = Director.stepFor(Director.read(args.path), 'export') } catch {}
    }
    return { path: r && r.file, mb, seconds, ...engine,
      ...(store ? { store } : {}),
      ...(ruled ? { guidelines: ruled } : {}),
      ...(lw.length ? { look_warnings: lw } : {}),
      ...(checked ? { review: checked } : {}),
      ...(loop ? { loop } : {}),
      ...jobState(args.path, doc, step, meta) }
  },

  // Rename through the same helper the Library uses, so sidecars (transcript, beats,
  // camera take, edit document) move with the file and the take stays in the Library.
  // A name is cleaned of anything that could turn it into a path.
  // ── the rest of what a person can do ─────────────────────────────────
  async frame(args = {}) {
    if (!args.path) throw new Error('path is required')
    if (!fs.existsSync(args.path)) throw new Error('no such file')
    // The capture is the frame. Nothing is extracted, because there is nothing to
    // extract from: the file on disk is the one moment this take has.
    if (isShot(args.path)) {
      const pic = require('./render-host').pictureSize(args.path)
      return { image: args.path, at: SHOT_AT, source_width: pic.width, source_height: pic.height, cropped: false,
        note: 'this is the capture itself, unstyled. preview_frame draws it as the PNG will look.' }
    }
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
    // A capture goes through the same Elements pass a take does, at its one moment.
    // processor.findOnScreen needed nothing for this: it asks frameAt for a picture,
    // and a picture is already one.
    const shot = isShot(args.path) ? await shotOf(args.path) : null
    const meta = shot ? null : await deps.proc.probeMeta(args.path).catch(() => ({}))
    const crop = args.cropped === false ? null
      : shot ? shot.crop || null : deps.proc.readDoc(args.path, meta && meta.duration).crop || null
    // The list this picture already has, as the prior, so the same control keeps its id:
    // a picture of a device goes on from that device's run, and a second search of the
    // same moment goes on from the first. Only ever the agent's own list (foundBy), never
    // a background pass's.
    const run = chainOf.get(args.path) || null
    const before = foundBy.get(args.path) || null
    const at = shot ? SHOT_AT : args.at
    // A search of another moment carries nothing, and is numbered past every id this
    // recording has handed out, so an id held from the first search never comes to name
    // something on the second.
    const top = pathTop.get(args.path) || 0
    const prior = run ? runPrior(run)
      : before && before.all && Math.abs((+before.at || 0) - (+at || 0)) <= 1 ? before.all
        : top > 0 ? countedFrom(top) : null
    // held to the guard's ledger before it is ranked or drawn
    const key = runKey(args.path, { run })
    const reissued = []
    const r = await deps.proc.findOnScreen(args.path, at, { crop, query: args.query, limit: args.limit, prior,
      guard: guardHook(key, reissued) })
    reissued.push(...settle(r, key))
    // only boxes measured in apply_edit's frame (after the crop) can be named there
    const all = r.all || r.elements
    if (run) joinRun(run, args.path, prior, all)
    // a card, grid or panel a lift would come out wrong on says so here, with the one
    // inside it to lift instead, so the agent does not have to be refused to learn it
    // the frame the elements were measured in, which is what turns the type ruler in
    // cutEdges onto the x axis: an ultrawide and a portrait crop are not 16:9
    const aspect = r.width > 0 && r.height > 0 ? r.width / r.height : 0
    const noLift = crop || args.cropped !== false
      ? noteFound(args.path, r.at, r.elements, all, { aspect, run, frame: { width: r.width, height: r.height } })
      : liftNotes(r.elements, all, aspect)
    // Everything read off the frame, held to the product's never-on-screen rules, so a
    // thing the person said must not be seen is named the moment an agent looks at it
    // rather than after the export.
    const seen = neverSeen(args.path, (all || []).map(e => ({ id: e.id, text: e.text })).filter(e => e.text))
    return {
      ...(seen || {}),
      ...(reissued.length ? { ids_retired: idsRetired(reissued) } : {}),
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
    // A shot's preview is its export drawn narrow. Same plan, same compositor, same
    // sink, so the only difference between what is checked here and the file that
    // ships is how many pixels wide it is.
    if (isShot(args.path)) {
      const shot = args.doc && args.doc.kind === 'shot' ? args.doc : await shotOf(args.path)
      const r = await drawShot(shot, args.path, { width: 1280, look: args.look })
      return { image: r.file, at: SHOT_AT, frames: [{ image: r.file, at: SHOT_AT }], pixels: `${r.w}x${r.h}` }
    }
    const meta = await deps.proc.probeMeta(args.path).catch(() => ({}))
    // args.doc is a whole document to draw in place of the saved one, which is how a
    // proposal shows an edit that has not been applied. No tool takes it: nothing is
    // written either way, so the only caller is chat.propose.
    let doc = cornerTrusted(args.doc || deps.proc.readDoc(args.path, meta && meta.duration))
    // a look to try, drawn without saving it
    if (args.look && typeof args.look === 'object') doc = require('./fetchdoc').mergeDoc(doc, { look: args.look })
    // several moments in one call: the start of a move and its middle are both checked
    const times = (Array.isArray(args.at) ? args.at : [args.at]).slice(0, 6)
    let frames = null, fell = null
    // drawn by the renderer the export will use, so what the agent checks is the file
    const host = require('./render-host')
    const pick = host.pickEngine(args.path, require('./fetchdoc').toExportOpts(doc))
    if (pick.engine === 'gl') {
      try { frames = await host.previewFrames(args.path, doc, times) } catch (e) {
        fell = (e && e.message) || String(e)
        console.warn('[preview] compositor failed, drawing with the classic renderer:', fell)
      }
    }
    if (!frames) {
      frames = []
      for (const t of times) frames.push(await deps.proc.previewFrame(args.path, doc, t))
    }
    // Which renderer drew this, said out loud. It used to fall back to the classic one
    // in silence, and a picture from that path is not the picture the export makes: it
    // draws the agent's arrow where the compositor draws a finger, and leaves out every
    // look field marked classic. An agent then judges the edit against a frame the file
    // will never hold, decides the edit is wrong, and changes something that was right.
    // Measured on a touch take: the same moment came back with an arrow through this
    // path and with the tap disc through the compositor.
    const engine = frames[0] && frames[0].engine === 'gl' ? 'gl' : 'classic'
    const out = { image: frames[0].file, at: frames[0].at, engine,
      frames: frames.map(r => ({ image: r.file, at: r.at, engine })) }
    if (engine !== pick.engine) {
      out.not_the_export = 'The compositor could not draw this, so these frames came from the ' +
        'classic renderer and your export will not look like them: a touch take\'s taps are ' +
        'drawn as the agent\'s arrow rather than as a finger, and the look fields only the ' +
        'compositor draws are missing. Judge the edit from an export, or try again.'
      if (fell) out.why = fell
    }
    return out
  },

  async 'edit.silence'(args = {}) {
    if (!args.path) throw new Error('path is required')
    if (isShot(args.path)) throw notOnAShot('Dead air')
    const r = await deps.runOp('silence', args.path, {
      minSilence: args.min_silence, pad: args.padding,
    })
    return { path: r.file, removed_percent: r.savedPct, kept_segments: r.cuts, seconds: r.duration }
  },

  async 'edit.enhance'(args = {}) {
    if (!args.path) throw new Error('path is required')
    if (isShot(args.path)) throw notOnAShot('Audio')
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
    const side = ['.png', '.srt', '.txt', '.cursor.json', '.pointer.json', '.cam.json', '.cam.mov', '.words.json', '.fetchdoc.json', '.fetchshot.json', '.vo.mp3', '.name.json']
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
    if (isShot(args.path)) throw notOnAShot('Beats')
    const meta = await deps.proc.probeMeta(args.path).catch(() => ({}))
    // Same ids the timeline prints (B1, B2, ...). They were missing here, so an agent
    // was told beats have ids and then handed `undefined`, while the person watching
    // saw B2 on screen for the same span.
    return deps.proc.beatsFor(args.path, meta && meta.duration)
      .map((b, i) => ({ id: b.id || 'B' + (i + 1), ...b,
        start: Math.round(b.start * 100) / 100, end: Math.round(b.end * 100) / 100 }))
  },

  // ── the job ────────────────────────────────────────────────────────────
  // A brief, a plan and the distance to both. It lives in a sidecar beside the take
  // (ui/director.js) rather than in the edit, because the job is about the work: it
  // has to survive the undo of the edit it produced, and closing a step is not an
  // undo level.
  async 'edit.direct'(args = {}) {
    const Director = require('./director')
    const patch = { brief: briefWithSize(args.brief), plan: args.plan, done: args.done, open: args.open, drop: args.drop, note: args.note }
    // A job that films a device is decided before there is anything to direct: which
    // device to boot and how many seconds the deliverable runs are settled before
    // record_start, and the judged run wrote its brief after the fact, which is how a
    // 202 second take was recorded for a 30 second deliverable. It waits in userData and
    // record_stop moves it onto the take it turned out to be about.
    if (!args.path) {
      const dir = app ? app.getPath('userData') : require('os').tmpdir()
      return Director.direct(null, patch, { dir })
    }
    // The job sidecar sits beside whatever it is a job about, and a screenshot is a job
    // like any other: a brief, steps, and the distance to both. Only the facts it is
    // measured on differ, and a still's are its shape alone.
    const facts = isShot(args.path)
      ? shotFacts(await shotOf(args.path))
      : editFacts(withCues(args.path, deps.proc.readDoc(args.path,
        (await deps.proc.probeMeta(args.path).catch(() => ({}))).duration)))
    if (Object.values(patch).every(v => v === undefined)) {
      const job = Director.read(args.path)
      if (!job) throw new Error(Director.NO_BRIEF)
    }
    return { ...Director.direct(args.path, patch, { facts }), ...memoryState(args.path) }
  },

  // The house rubric, measured on the document rather than asked for in prose
  // (ui/review.js). Pure: no ffmpeg, no frames, so it is cheap enough to call before
  // every reply, which is the point of it.
  async 'edit.review'(args = {}) {
    if (!args.path) throw new Error('path is required')
    if (isShot(args.path)) return await reviewShot(args)
    const meta = await deps.proc.probeMeta(args.path).catch(() => ({}))
    const doc = withCues(args.path, deps.proc.readDoc(args.path, meta && meta.duration))
    const words = wordsAgainstRules(args.path, doc)
    const r = require('./review').review({
      doc, ...briefAndBeats(args.path, meta), path: args.path,
      looks: require('./look').list(looksDir()),
      // the words the product avoids, as a finding of review's own
      rules: words,
      // a finding the agent judged and wrote down stops holding the verdict at "nearly"
      declined: args.declined,
      // the take's own ends, so the rule about a ground a take sinks into can run at all
      levels: await takeLevels(args.path, doc, meta),
    })
    // every rule in force held to the edit and to what was read off the take, each
    // finding with its fix, and every rule that could not be checked said to be unchecked
    const g = rulesCheck(args.path, doc, { width: meta && meta.width, height: meta && meta.height })
    return { ...r, ...(words ? { rules: words } : {}), ...(g ? { guidelines: g } : {}) }
  },

  // Can this clip play round again with no visible jump, and what is stopping it?
  // Answered off the plan, before a pixel is drawn: every pass draws from the plan and
  // the frame's own time (ui/compositor/PASSES.md), so the two ends can be compared
  // without rendering either. look tries one without saving it, which is how an agent
  // asks "would it loop with the fades off" and gets an answer in one call.
  async 'edit.loop'(args = {}) {
    if (!args.path) throw new Error('path is required')
    if (isShot(args.path)) throw notOnAShot('A loop')
    if (!fs.existsSync(args.path)) throw new Error('no such file')
    const meta = await deps.proc.probeMeta(args.path).catch(() => ({}))
    let doc = deps.proc.readDoc(args.path, meta && meta.duration)
    if (args.look && typeof args.look === 'object') doc = require('./fetchdoc').mergeDoc(doc, { look: args.look })
    return await loopCheckOf(args.path, doc, meta)
  },

  // A length is a decision about what to keep, so it writes clips. remove_dead_air
  // writes a new file whose edit is empty; this leaves the take alone.
  async 'edit.fit'(args = {}, ctx) {
    if (!args.path) throw new Error('path is required')
    if (isShot(args.path)) throw notOnAShot('A length')
    const Fit = require('./fit')
    const meta = await deps.proc.probeMeta(args.path).catch(() => ({}))
    const doc = withCues(args.path, deps.proc.readDoc(args.path, meta && meta.duration))
    let w = null
    try { w = JSON.parse(fs.readFileSync(deps.proc.sidecarIn(args.path, '.words.json'), 'utf8')) } catch {}
    // Beats are worked out from the take, not stored on the document, so reading
    // doc.beats alone left fit's whole-beat stage with nothing it could drop: it
    // stopped 8.7 s over its target and named no beat, while review and list_beats,
    // which both call beatsFor, saw the same beats fine.
    if (!(doc.beats || []).length) {
      try { doc.beats = deps.proc.beatsFor(args.path, meta && meta.duration) || [] } catch { doc.beats = [] }
    }
    // The taps are on a sidecar beside the take rather than on the document, exactly as
    // the beats are worked out rather than stored, so a device take's spine would have
    // been empty here for the same reason the beats were.
    if (!(doc.pointer || []).length) {
      try { doc.pointer = pointerTrack(args.path, doc) } catch { doc.pointer = [] }
    }
    // A length is chosen from what was said, so with nothing said this is a wasted
    // turn: it would hand back the edit it was given and a sentence nobody reads.
    // A take of a device has nobody talking on it and is still full of decisions: a tap
    // is a moment somebody meant, and ui/fit.js keeps the seconds around each one. So the
    // gate asks for a spine of either kind. It used to ask for speech alone, and
    // transcribing silence returns silence, so a 202 second take and a 30 second
    // deliverable had no sequence of calls between them.
    if (!(w && w.words && w.words.length) && !(doc.cues || []).length && !(doc.beats || []).length
        && !(doc.pointer || []).some(p => p && p.click)) {
      throw new Error('No transcript and no taps, so there is nothing to choose from. Call transcribe on this take, then fit_to_length again.')
    }
    const r = Fit.fit(doc, {
      seconds: args.seconds, keep: args.keep, extra: args.fillers,
      words: (w && w.words) || null, speech: (w && w.speech) || null,
    })
    // The clips are in the document the moment they are applied, and get_edit names
    // them; sending them back here would be the same list twice (principle 6).
    const { clips, spans, ...out } = r
    if (args.apply === false || !clips.length) return { ...out, applied: false }
    const applied = await ops['edit.apply']({ path: args.path, doc: { clips }, step: args.step }, ctx)
    return { ...out, applied: true, output: applied.output,
      ...(applied.plan ? { plan: applied.plan } : {}), ...(applied.distance ? { distance: applied.distance } : {}),
      ...(applied.hint ? { hint: applied.hint } : {}) }
  },

  // The whole edit as one picture, so an agent can judge motion rather than a moment.
  // from, to and the times on the sheet are output seconds; each cell also comes back
  // with the source second it was drawn from, which is what every other tool takes.
  async 'edit.sheet'(args = {}) {
    if (!args.path) throw new Error('path is required')
    if (!fs.existsSync(args.path)) throw new Error('no such file')
    // The sheet exists so an agent can judge motion rather than a moment. A shot is
    // one moment, so the whole of it is that frame: the same call answers, with the
    // picture it has, rather than refusing the first line of the loop.
    if (isShot(args.path)) {
      const shot = await shotOf(args.path)
      const r = await drawShot(shot, args.path, { width: 1440 })
      return { image: r.file, from: SHOT_AT, to: SHOT_AT, output_seconds: 0, cols: 1, rows: 1, count: 1,
        frames: [{ at: SHOT_AT, source_at: SHOT_AT }],
        note: 'a shot is one frame, so the whole of it is this picture. It is the PNG export drawn narrow.' }
    }
    const meta = await deps.proc.probeMeta(args.path).catch(() => ({}))
    const doc = deps.proc.readDoc(args.path, meta && meta.duration)
    const r = await require('./render-host').contactSheet(args.path, doc,
      { from: args.from, to: args.to, count: args.count })
    return {
      image: r.file, from: r.from, to: r.to, output_seconds: r.span,
      cols: r.cols, rows: r.rows, count: r.count,
      frames: r.frames.map(f => ({ at: f.at, source_at: f.source })),
    }
  },

  // The agent's own last burst of changes, put back. One code path with the person's
  // own "Undo Biscuit's change" button, which is why it is safe to hand over: it
  // merges by id, so a zoom they dragged since stays dragged, and it never reaches
  // their own undo history.
  async 'edit.revert'(args = {}, ctx) {
    if (!args.path) throw new Error('path is required')
    // One undo stack, keyed by the file, so taking back a change to a shot is the same
    // button the person has and the same call the agent already knew (ui/editor.js).
    const shot = isShot(args.path)
    const before = shot ? await shotOf(args.path) : deps.proc.readDoc(args.path, null)
    const undone = await inEditor(args.path, `window.fetchUndo ? window.fetchUndo.undo(${JSON.stringify(args.path)}, 0, ${byArg(ctx)}) : false`)
    if (!undone) {
      throw new Error(`nothing of yours to take back on this ${shot ? 'shot' : 'take'}. Change the ${shot ? 'shot' : 'edit'} itself with apply_edit ` +
        `(a ${shot ? 'mark' : 'zoom or a mark'} is fixed by re-sending it with its id, and remove: [id] deletes one).`)
    }
    if (shot) {
      const now = await shotOf(args.path)
      const gone = (before.marks || []).map(m => m.id).filter(id => !(now.marks || []).some(m => m.id === id))
      return { ...summariseShot(now, args.path),
        ...(gone.length ? { removed: { ids: gone, why: 'these went back out of the shot; say so in your reply' } } : {}),
        ...jobState(args.path, null, null, null, shotFacts(now)) }
    }
    const doc = await inEditor(args.path, docNow(args.path))
    deps.proc.writeDoc(args.path, doc)
    const gone = removedIds(before, doc)
    return { ...summarise(doc, args.path), ...(gone.length ? { removed: { ids: gone, why: 'these went back out of the edit; say so in your reply' } } : {}),
      ...jobState(args.path, doc, null, await takeShape(args.path)) }
  },

  // ── versions ───────────────────────────────────────────────────────────
  // The take's history across sessions (ui/history.js), through the editor that keeps
  // it, so there is one log and one writer. revert_my_edit takes back the agent's own
  // last burst; this reaches any version anybody made, and what the person had on
  // Tuesday is as reachable as what the agent did a minute ago. A restore is a new
  // version on top, never a rewind, so it needs no proposal: restoring the version
  // before it takes it back, and nothing ahead of it is ever lost.
  async 'edit.versions'(args = {}, ctx) {
    if (!args.path) throw new Error('path is required')
    const action = String(args.action || 'list').trim().toLowerCase()
    if (!VERSION_DOES.includes(action)) {
      throw new Error(`versions does ${VERSION_DOES.join(', ')}, and not "${args.action}". list names the versions, ` +
        'look shows one without changing anything, restore brings one back as a new version.')
    }
    const History = require('./history')
    const shot = isShot(args.path)
    const rows = await versionRows(args.path)
    if (action === 'list') {
      const limit = Math.max(1, Math.min(200, Math.round(+args.limit || 20)))
      return {
        versions: rows.slice(0, limit).map(versionSaid),
        total: rows.length,
        ...(rows.length > limit ? { older: `${rows.length - limit} older versions are not listed; send limit to see more` } : {}),
        how: `newest first; ${rows[0].id} is the edit as it stands now. by is who made each one, and the person when ` +
          'it is "the person". look shows any of them without changing anything, and restore brings one back as a ' +
          'new version on top, so nothing ahead of it is lost.',
      }
    }
    const n = versionNumber(args.version)
    const row = rows.find(r => r.n === n)
    if (!row) {
      throw new Error(`${args.version == null ? 'version is required, and' : `"${args.version}" is not a version of this ${shot ? 'shot' : 'take'}:`} ` +
        `versions with action list names them, newest first. ${rows[0].id} is now and ${rows[rows.length - 1].id} is the oldest kept.`)
    }
    if (action === 'look') {
      const version = await inEditor(args.path, `window.fetchHistory.version(${n})`)
      if (!version) {
        throw new Error(`${row.id} is listed and cannot be read back from the history file, so there is nothing to show. ` +
          'versions with action list names the others.')
      }
      const current = await inEditor(args.path, docNow(args.path))
      // what restoring it would put on screen: the edit from then, the recording's own
      // facts from now, and any file it used that is gone kept as it is now
      const { doc, missing } = History.forRestore(version, current, fs.existsSync)
      const diff = History.describe(current, doc)
      let preview = null
      try {
        const p = await ops['edit.preview']({ path: args.path, doc,
          at: args.at != null ? +args.at : versionMoment(doc, diff.touched) })
        preview = { image: p.image, at: p.at, why: `this is ${row.id} drawn by the renderer the export uses. Nothing was changed.` }
      } catch (e) { preview = { error: (e && e.message) || String(e) } }
      return {
        version: versionSaid(row),
        restoring_it_would: History.same(current, doc) ? 'change nothing: the edit already matches it' : diff.line.charAt(0).toLowerCase() + diff.line.slice(1),
        edit: shot ? summariseShot(doc, args.path) : briefEdit(doc, args.path),
        ...(missing.length ? { missing: History.missingLine(missing).trim() } : {}),
        preview,
        do_next: row.n === rows[0].n ? `${row.id} is the edit as it stands now.`
          : `versions { action: 'restore', version: '${row.id}' } brings it back as a new version; nothing ahead of it is lost.`,
      }
    }
    const was = rows[0].id
    const by = (ctx && ctx.client) || 'Agent'
    const r = await inEditor(args.path, `window.fetchHistory.restore(${n}, ${JSON.stringify({ by })})`)
    if (!r) {
      throw new Error(`${row.id} cannot be read back from the history file, so nothing changed. versions with action list ` +
        'names the others; ask the person which one they meant if none of those is it.')
    }
    const now = await inEditor(args.path, docNow(args.path))
    if (!shot && now) deps.proc.writeDoc(args.path, now)
    return {
      restored: row.id,
      ...(r.row ? { as: r.row.id } : { unchanged: 'the edit already matched it, so no version was written' }),
      line: r.line,
      ...(r.missing && r.missing.length ? { missing: History.missingLine(r.missing).trim() } : {}),
      ...(r.row ? { undo: `versions { action: 'restore', version: '${was}' } puts back the edit as it was before this` } : {}),
      edit: shot ? summariseShot(now, args.path) : briefEdit(now, args.path),
      ...(shot ? jobState(args.path, null, args.step, null, shotFacts(now))
        : jobState(args.path, now, args.step, await takeShape(args.path))),
    }
  },

  // ── the two that wait on the person ────────────────────────────────────
  // Guessing on a request with two readings costs an edit and an undo, and the undo is
  // the person's work rather than the agent's. These two put the fork, or the whole
  // change, in front of them instead. Both come back whether or not anybody answered,
  // and every branch of both carries a do_next (ui/edit-assist.js), because a result
  // that says only "nobody answered" gets asked again a second later.
  async 'chat.ask'(args = {}) {
    const Assist = require('./edit-assist')
    const spec = Assist.askSpec({ ...args, timeoutMs: waitMs(args.timeout_seconds) })
    if (!spec.ok) throw new Error(spec.error)
    spec.ask.id = 'Q' + (++waitSeq)
    return Assist.askResult(await putToPane('ask', spec.ask))
  },

  async 'chat.propose'(args = {}, ctx) {
    if (!args.path) throw new Error('path is required')
    if (!args.doc || typeof args.doc !== 'object') throw new Error('doc is required: the change itself, exactly as apply_edit takes it')
    const Assist = require('./edit-assist')
    const spec = Assist.proposalSpec({ ...args, timeoutMs: waitMs(args.timeout_seconds) })
    if (!spec.ok) throw new Error(spec.error)
    spec.proposal.id = 'P' + (++waitSeq)
    // The edit as it would be, drawn off a copy of the document and never saved, so
    // the person is looking at the change rather than reading about it.
    spec.proposal.preview = await proposedFrame(args)
    const out = await putToPane('propose', spec.proposal)
    // Nothing is written on any other branch, which is the whole promise of this tool.
    if (out.how !== 'apply') return Assist.proposalResult(out)
    // Applied through the call the agent would have made itself, so the plan, the
    // distance, the warnings and the one undo level are the same either way.
    try {
      return { ...(await ops['edit.apply']({ path: args.path, doc: args.doc, step: args.step }, ctx)),
        ...Assist.proposalResult(out) }
    } catch (err) {
      // The card read "Applied." the moment it was clicked, because the click is the
      // answer. The edit refused after that, so the pane and the log are told, or the
      // thread goes on saying a document was written that was not.
      try {
        require('./agent-chat').say({ kind: 'settled', id: spec.proposal.id, how: 'failed', choice: null },
          deps.getWindow && deps.getWindow())
      } catch {}
      throw err
    }
  },

  // ── what is still true next week ───────────────────────────────────────
  // A brief lives in the job file and dies with the job. This is the other half: what
  // the person said about themselves and their product, which the next conversation
  // would otherwise ask for again (ui/memory.js). Writing and forgetting are one op
  // because they are one judgement a beat apart, and a store that can only grow ends
  // up holding two facts that disagree.
  async 'memory.remember'(args = {}) {
    const Memory = require('./memory')
    await sampleRoot()
    const where = { root: memRoot(args.path, args.about),
      take: args.path || null, about: args.about }
    if (args.forget) {
      // an id says which drawer it came out of; anything else is a key, and a key
      // read as an id would match nothing and report success
      const pick = String(args.forget).trim()
      const sel = /^[GFN]\d+$/i.test(pick)
        ? { id: pick }
        : { key: pick, scope: args.scope, about: Memory.place(where).about }
      const r = Memory.forget(where, sel)
      return { ok: !!r.gone.length, dropped: r.gone, memory: r.memory,
        ...(r.gone.length ? {} : { why: `nothing in the memory is ${pick}; the memory block below lists what is` }) }
    }
    if (!args.fact) throw new Error('fact is required: the sentence to write down, or forget with an id from the memory block')
    return Memory.remember(where, args)
  },

  // ── the product's rules ────────────────────────────────────────────────
  // What a product is called, who a demo of it is for, what must never be on screen, how
  // its screenshots look and the words it avoids (ui/guidelines.js). The person's words
  // are in force at once; an agent's are drafts until the person has been shown them word
  // for word and said yes, which is what show and adopt with its seal are for. The rules
  // in force already open the memory block every briefing carries; this is where they are
  // read whole, written and checked.
  //
  // Nothing an agent sends proves a person said yes: a seal only proves the words did not
  // change after show. So a rule goes into force from here only once the person has said
  // so in Fetch itself, in a question that shows them the rules word for word. A rule sent
  // as the person's own (from: person) that they do not confirm is kept as a draft; an
  // adopt they do not confirm is refused and the drafts wait. The Guidelines panel in the
  // app is the person acting, and needs no question.
  async 'memory.guidelines'(args = {}) {
    await sampleRoot()
    // a project names its product: the one its takes are named for (productFor)
    if (args.project != null && !args.product && !args.path) {
      const r = resolveProject(args.project, await projectList())
      if (!r.ok) return { ok: false, refused: { keep: false, kind: 'unplaced', why: r.why } }
      args = { ...args, product: productFor(r.project, ownRoot()) }
    }
    const about = args.product || args.about || null
    const where = { root: memRoot(args.path, about), take: args.path || null, ...(about ? { about } : {}) }
    const G = require('./guidelines')
    const action = args.action || (args.rules || args.rule ? 'write' : 'read')
    const product = G.place({ ...where, ...(args.product ? { product: args.product } : {}) }).product
    if (action === 'write' && product) {
      const list = [].concat(args.rules != null ? args.rules : args.rule != null ? [args] : [])
      const theirs = list.filter(r => r && typeof r === 'object' && r.from === 'person')
      if (theirs.length) {
        const yes = await rulesConfirmed(product, theirs.map(r => String(r.rule != null ? r.rule : r.text || '')))
        if (!yes) {
          const out = G.op(where, { ...args, rules: list.map(r => (r && r.from === 'person' ? { ...r, from: 'agent' } : r)) })
          return { ...out, unconfirmed: 'The person did not confirm these in Fetch, so they were kept as drafts and are in no ' +
            'briefing. Show them with show, and adopt only once they say yes.' }
        }
      }
    }
    if (action === 'adopt' && product) {
      const ids = new Set([].concat(args.ids || []).map(x => String(x).trim().toUpperCase()))
      const edits = args.edits && typeof args.edits === 'object' ? args.edits : {}
      const drafts = G.read(where).drafts || []
      const texts = drafts.filter(d => ids.has(d.id)).map(d => String(edits[d.id] != null ? edits[d.id] : d.text))
      if (texts.length && !(await rulesConfirmed(product, texts))) {
        return { ok: false, adopted: [], refused: { keep: false, kind: 'person',
          why: 'the person did not say yes to these in Fetch, so none went into force. The drafts are still waiting.' } }
      }
    }
    return G.op(where, args)
  },

  // ── the sample ─────────────────────────────────────────────────────────
  // Three things Fetch made of a product nobody makes (assets/sample/), laid out as real
  // takes in a folder of their own, so someone can try every tool without recording
  // anything. While it is open list_recordings lists the sample and nothing else, and
  // what is remembered about it is kept in it and goes with it. The person's own takes,
  // folders and settings are never touched, and leaving measures that they were not.
  async 'sample.do'(args = {}) {
    const action = args.action || 'status'
    if (!['status', 'open', 'close'].includes(action)) throw new Error('action is one of status, open, close')
    const win = deps.getWindow ? deps.getWindow() : null
    const inWindow = async js => {
      if (!win || win.isDestroyed()) throw new Error('Fetch is not running, and the sample opens in its Library')
      return await win.webContents.executeJavaScript(js)
    }
    const state = async () => {
      const s = await inWindow("(() => { const S = require('./ui/sample'); return S.active() ? " +
        '{ root: S.root(), product: S.product(), items: S.items() } : null })()')
      return s
    }
    const said = s => s ? {
      open: true, product: s.product, root: s.root,
      items: (s.items || []).map(i => ({ title: i.title, kind: i.kind, platform: i.platform, path: i.path, try: i.try })),
      note: 'These are the sample\'s own takes, of a product made up for it. Every tool works on them, and an export ' +
        'lands inside the sample. The person\'s own library is set aside, not touched.',
    } : { open: false }
    if (action === 'status') return said(await state())
    if (action === 'open') {
      if (deps.isRecording && deps.isRecording()) throw new Error('a take is recording; the sample opens once it has stopped')
      await inWindow("require('./ui/sample').enter().then(() => true)")
      const s = await state()
      sampleAt = s && Sample.isSample(s.root) ? s.root : null
      return said(s)
    }
    const r = await inWindow("require('./ui/sample').leave()")
    sampleAt = null
    return { open: false, left: !!(r && r.left), removed: !!(r && r.removed),
      ...(r && r.left ? { untouched: !!r.untouched } : { note: 'the sample was not open' }),
      ...(r && r.left && !r.untouched ? { note: 'the person\'s own folders changed while the sample was open; the sample did not change them, and nothing was undone' } : {}) }
  },

  // Sent by the MCP server, never by a model: the call it minted `job` for was cancelled
  // by its client, or ran out of time. Stops that export, queued or running.
  async 'job.cancel'(args = {}, ctx) {
    const key = args.job != null ? String(args.job) : ''
    if (!key) throw new Error('job is required')
    const hit = stopJobs((k, j) => k === key && (!ctx || !j.ctx || j.ctx === ctx))
    return { cancelled: hit.length > 0 }
  },

  // ── voiceover ──────────────────────────────────────────────────────────
  // The one part of Fetch that uses the network, through the person's own ElevenLabs
  // account (ui/voice.js). The key is theirs, it lives in the Keychain, it is never an
  // argument here, and only the script is sent: no audio, no video, no filenames.
  async 'voice.list'() {
    const voice = require('./voice')
    const s = await voice.status()
    if (!s.connected) throw new Error(NO_VOICE_ACCOUNT)
    return { voices: await voice.voices(),
      ...(s.limit != null ? { characters: { used: s.used, limit: s.limit } } : {}) }
  },

  async 'voice.speak'(args = {}, ctx) {
    if (!args.path) throw new Error('path is required')
    if (isShot(args.path)) throw notOnAShot('A voiceover')
    const voice = require('./voice')
    if (!(await voice.status()).connected) throw new Error(NO_VOICE_ACCOUNT)
    const meta = await deps.proc.probeMeta(args.path).catch(() => ({}))
    const doc = withCues(args.path, deps.proc.readDoc(args.path, meta && meta.duration))
    // With no script the take's own captions are the script: re-narrating what was
    // said, in a clean voice, over the same footage, is what this is for.
    const script = String(args.script || voice.scriptFromCues(doc.cues) || '').trim()
    if (!script) {
      throw new Error('nothing to say: send script, or transcribe this take first and its own words are spoken back.')
    }
    const list = await voice.voices()
    const want = args.voice == null ? '' : String(args.voice).trim()
    const pick = want
      ? list.find(v => v.id === want || v.name.toLowerCase() === want.toLowerCase())
      : list[0]
    if (!pick) throw new Error(`no voice called ${want} on this account; list_voices names the ones there are`)
    const file = deps.proc.sidecarOut(args.path, '.vo.mp3')
    await voice.speak({ text: script, voiceId: pick.id, outPath: file,
      settings: { stability: args.stability, similarity: args.similarity, speed: args.speed } })
    const vm = await deps.proc.probeMeta(file).catch(() => ({}))
    const out = { file, voice: pick.name, characters: script.length,
      seconds: vm && vm.duration ? +vm.duration.toFixed(2) : null }
    if (args.apply === false) return { ...out, applied: false }
    // Into the edit through apply_edit, so the person watching sees it land and one
    // Undo takes it back. replace mutes the take's own sound under it.
    const name = path.parse(args.path).name + ' voiceover'
    const applied = await ops['edit.apply']({ path: args.path, step: args.step,
      doc: { audioTrack: { file, name, volume: 1, offset: args.offset || 0, replace: args.replace !== false } } }, ctx)
    return { ...out, applied: true, audioTrack: applied.audioTrack,
      ...(applied.plan ? { plan: applied.plan } : {}), ...(applied.distance ? { distance: applied.distance } : {}) }
  },

  async 'recordings.list'() {
    // Through the app, never through processor directly: listRecordings falls back to
    // a different, empty library index outside Electron and ignores the saveDir pref.
    // While the sample is open the Library shows the sample and nothing else, and so does
    // this: an agent that counts takes says the number the person sees.
    const inSample = await sampleRoot()
    const list = inSample ? Sample.list(inSample, deps.proc) : deps.proc.listRecordings()
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
        // Read off what was captured, never off what was exported, so styling a shot
        // or cutting a take never moves it to the other side of the library.
        path: o.path, mb: o.mb, kind: isShot(o.path) ? 'shot' : o.kind, srt: o.srt,
        ...(g.take ? { take: g.take } : {}),
        ...(g.deliverable && g.deliverable !== o ? { deliverable: g.deliverable.path } : {}),
        ...(g.copy && g.copy !== o ? { copy: g.copy.path } : {}),
        ...(versions.length ? { versions } : {}),
        ...(inSample ? { sample: true } : {}),
      } })
    }
    return takes.sort((a, b) => b.mtime - a.mtime).map(t => t.entry)
  },

  async probe(args = {}) {
    if (!args.path) throw new Error('path is required')
    if (!fs.existsSync(args.path)) throw new Error('no such file')
    // A capture says its size in its own first few hundred bytes, so this costs one
    // short read where an ffprobe costs a process, and it says no rather than zero
    // about the things a picture does not have.
    if (isShot(args.path)) {
      const pic = require('./render-host').pictureSize(args.path)
      return { kind: 'shot', width: pic.width, height: pic.height, format: pic.kind,
        mb: +(fs.statSync(args.path).size / 1e6).toFixed(2),
        duration: null, fps: null, hasAudio: false }
    }
    const probed = await deps.proc.probeMeta(args.path)
    // where the sound sits against the picture, said beside the raw number
    const sync = soundSync(await withAudioEnd(args.path, probed), null)
    const meta = sync ? { ...probed, sound_sync: sync } : probed
    if (!args.loudness) return meta
    // Which piece of the take is under the rest, and by how many decibels, in the same
    // unit the -14 LUFS target is in (processor.clipLevels). "This bit is too quiet" is
    // a measurement, not a taste: the gain it hands back is the number to write onto
    // that clip. Only on request, since it is one decode per clip.
    const doc = deps.proc.readDoc(args.path, meta && meta.duration)
    const clips = doc.clips.length ? doc.clips : [{ id: 'C1', start: 0, end: (meta && meta.duration) || 0 }]
    const lv = await deps.proc.clipLevels(args.path, clips)
    // A gain is held to what one clip can be lifted or dropped by, so a clip sitting at
    // the limit is not a clip the number fixes: it was recorded too far off the mic, and
    // the person is the one who can do something about that.
    const GAIN = require('./fetchdoc').GAIN_DB
    const held = (lv.clips || []).filter(c => c.gain != null && Math.abs(c.gain) >= GAIN).map(c => c.id || `${c.start}s`)
    return { ...meta, audio_levels: { ...lv,
      how: 'gain is the number to put in that clip\'s audio.gain (apply_edit clips). quiet is set where ' +
        'that is 3 dB or more, which is where somebody would reach for the fader.',
      ...(held.length ? { held: `${held.join(', ')} asked for more than the ${GAIN} dB Fetch lifts or drops one clip by, ` +
        'so the gain named there is as far as it goes. Write it, and tell the person that stretch was recorded too ' +
        'quietly to fix with a number.' } : {}) } }
  },

  async transcribe(args = {}) {
    if (!args.path) throw new Error('path is required')
    if (isShot(args.path)) throw notOnAShot('A transcript')
    // Through the queue, like every other heavy op: one at a time against an export,
    // in the ledger so the app can say it is happening, and stopped with the rest when
    // the person stops the agent.
    const r = await deps.runOp('transcribe', args.path, {})
    // Paths and counts, not payloads: a long transcript inline is thousands of tokens
    // of an agent's context for no benefit. The text is opt-in.
    const out = { srt: r.srt, txt: r.file, words: r.words, cues: (r.cues || []).length,
      seconds: r.seconds }
    // A call that spent most of its time fetching the speech model looked exactly like
    // one that spent it transcribing, and a first run can be minutes on a slow line.
    // Say which it was, so nobody is left wondering whether it worked.
    if (r.modelFetched) {
      out.note = `This was the first transcription on this Mac, so most of those ${r.seconds} s ` +
        'were spent downloading the speech model. It is kept, and every transcription after this is the transcription alone.'
    }
    if (args.include_text) out.text = r.text
    return out
  },
}

// ── waiting on the person ────────────────────────────────────────────────
// A question and a proposal are the only two ops that wait on somebody, so they are the
// only two that could hang a turn. One entry each, keyed by an id this process mints,
// and every path out of here resolves exactly once.
let waitSeq = 0
const waiting = new Map()      // id -> { kind, spec, resolve, timer }
const waitMs = secs => (+secs > 0 ? +secs * 1000 : undefined)

function putToPane(kind, spec) {
  return new Promise(resolve => {
    const win = deps.getWindow && deps.getWindow()
    // A question opens the pane itself (ui/chat.js), so a window nobody can see is the
    // only unattended case. Burning ninety seconds to find that out is ninety seconds
    // of somebody's turn, and the result says plainly that it was never seen.
    const seen = win && !win.isDestroyed() && win.isVisible() &&
      require('./agent-chat').say({ kind, ...spec }, win)
    if (!seen) return resolve({ how: 'unattended', timeoutMs: spec.timeoutMs })
    // Two seconds behind the pane's own clock, so the pane wins in the ordinary case
    // and the agent is freed anyway if the window goes away with the card still up.
    const timer = setTimeout(() => settleWait(spec.id, 'timeout'), spec.timeoutMs + 2000)
    waiting.set(spec.id, { kind, spec, resolve, timer })
  })
}

// Idempotent and one way: the click, the pane's clock, this process's backstop and the
// turn ending all land here, and the first one wins. How it settled is always said back,
// even for the click the pane has already drawn: the pane ignores a card it has settled,
// and that one event is what puts the outcome in the log, so a restart replays the answer
// instead of a dead question.
function settleWait(id, how, choice) {
  const e = waiting.get(id)
  if (!e) return false
  waiting.delete(id)
  clearTimeout(e.timer)
  try {
    require('./agent-chat').say({ kind: 'settled', id, how, choice: choice || null },
      deps.getWindow && deps.getWindow())
  } catch {}
  e.resolve({ how, timeoutMs: e.spec.timeoutMs,
    choice: (e.spec.choices || []).find(c => c.id === choice) || null })
  return true
}

// One frame of the proposed edit, drawn off a copy of the document. Nothing is saved,
// no undo level is spent and the frame is a temp still like preview_frame's own, so a
// card the person turned down still shows what they turned down when the thread is
// read back. A frame that cannot be drawn is null: the card reads fine without one.
async function proposedFrame(args) {
  try {
    const FD = require('./fetchdoc')
    const meta = await deps.proc.probeMeta(args.path).catch(() => ({}))
    // The same two steps edit.apply takes before the document sees the change, on a deep
    // copy so the agent's own arguments go to Apply untouched and are resolved there
    // once. Without them the card showed a generic 1.8x centre zoom and a lift with no
    // box, and Apply then framed the element: a picture of a change that is not the
    // change, which is worse than no picture.
    const sent = JSON.parse(JSON.stringify(args.doc))
    const prev = ['marks', 'zooms', 'texts', 'remove'].some(k => Array.isArray(sent[k]))
      ? await inEditor(args.path, docNow(args.path)).catch(() => null) : null
    const resolved = withElements(args.path, sent, prev)
    await aimZooms(args.path, resolved, prev).catch(() => null)
    const doc = FD.mergeDoc(deps.proc.readDoc(args.path, meta && meta.duration), resolved)
    const p = await ops['edit.preview']({ path: args.path, at: firstChange(resolved, doc), doc })
    return p.image || null
  } catch { return null }
}

// Whether an edit loops, off the plan alone (ui/compositor/gl.js, loopCheck). Two
// halves: what Fetch draws, which the plan answers in full, and the take's own pixels
// at the two ends, which no plan can answer and which this says out loud rather than
// guessing at.
async function loopCheckOf(src, doc, meta) {
  const FD = require('./fetchdoc')
  const dur = (meta && meta.duration) || (doc && +doc.dur) || 0
  const d = FD.normalize(doc, src, dur)
  if (!d.clips.length) d.clips = [{ id: 'C1', start: 0, end: dur }]
  const spec = await require('./render-host').planFor(src, FD.toExportOpts(d), { ...meta, duration: dur }, null)
  const r = require('./compositor/gl').loopCheck(spec)
  const on = !!((require('./look').resolve(d.look).motion || {}).loop)
  // What the switch does and does not do, said exactly: it changes no exported byte,
  // because every frame an export draws is already inside the loop. It changes what a
  // player counting on past the end draws, which is the stage playing the clip again.
  const do_next = r.faults.length
    ? 'Each fault carries the fix that makes it wrap. Apply them, then call this again before you export.'
    : on
      ? 'Nothing Fetch draws stops it. Export it and play the file round twice.'
      : 'Nothing Fetch draws stops it. Export it and play the file round twice. Set look motion.loop true ' +
        'as well if the stage is going to play it round: the file is the same either way, and the switch ' +
        'is what keeps a second pass on the frames the file holds.'
  return { ...r, loop_set: on, do_next }
}

// Whether the take running is paused. The renderer holds it: a native take carries it
// on recState, a MediaRecorder take on the recorder itself, and neither is mirrored
// into this process.
async function recPhase() {
  const win = deps.getWindow()
  if (!win || win.isDestroyed()) return null
  return await win.webContents.executeJavaScript(
    '(() => { try { return (typeof nativeTake !== "undefined" && nativeTake) ? recState ' +
    ': (typeof rec !== "undefined" && rec ? rec.state : null) } catch { return null } })()').catch(() => null)
}

// Refuse the take if the policy says so, with a reason the agent can relay verbatim.
// Window targets are resolved to their owning app first, since the policy is written in
// terms of apps and the caller only gives us an id.
async function enforceAccess(args, ctx, seen = null) {
  const prefs = deps.getPrefs ? deps.getPrefs() : {}
  const p = {
    mode: prefs.recordAccess,
    neverRecord: prefs.neverRecord,
    // A simulator is one app hosting anything, so a device with a real account, a push
    // token and somebody's photos cannot be named by app. The lever is the UDID, and an
    // agent can neither add to this list nor take anything off it (HUMAN_ONLY_PREFS).
    neverRecordDevices: prefs.neverRecordDevices,
    allowedApps: prefs.allowedRecordApps,
  }

  // A window named by id goes through the device join too, or the never record devices
  // list is bypassed by naming the window instead of the device: list_windows hands back
  // the Simulator window id of a protected device, and record_start with that id used to
  // resolve only the app name. The join is not best effort here. Where it fails on a
  // Simulator window, the device cannot be told, and a device that cannot be told is
  // exactly the one that might be on the list, so decide() refuses it for the missing
  // udid rather than recording it.
  let app = null, device = null, unresolved = false
  if (args.window != null) {
    const list = await deps.listWindows()
    const hit = (list || []).find(w => String(w.id) === String(args.window))
    // A window the list leaves out (a helper built before it stopped skipping Electron
    // by name leaves every dev build of an app out) is named by what Fetch itself read
    // of it while finding a project's window, never by anything the agent sent: the
    // question then says which app, and the never-record list is held to that name.
    app = (hit && hit.app) || (seen && seen.app) || null
    if (hit && String(app || '') === policy.SIMULATOR_APP) {
      let joined = null
      try { joined = (await attachDevices([hit], { strict: true }))[0] } catch { joined = null }
      device = (joined && joined.device) || null
      unresolved = !device
    }
  }

  const sim = args.sim || (device ? { udid: device.udid, name: device.name } : null)
  const verdict = policy.decide(
    { by: 'agent', kind: (sim || unresolved) ? 'simulator' : (args.window != null ? 'window' : 'display'), app,
      ...(sim ? { udid: sim.udid, device: sim.name } : {}) }, p)

  // What the person is being asked to allow. A recording and one captured frame are
  // different acts: one runs until something stops it and turns the menu bar icon red,
  // the other is over before the dialog is off the screen. A yes to either is not a yes
  // to the other, so the question, the button and the session key all carry the kind.
  const still = args.kind === 'shot'
  const act = still ? 'capture' : 'record'

  if (!verdict.allow) throw new Error(`Fetch refused to ${act}: ${verdict.reason}`)

  // 'Ask' means a person approves every agent take. decide() said so all along, but
  // nothing asked: needsApproval was returned and dropped, so on the default setting
  // agents recorded without anyone saying yes. The question is a native dialog on
  // Fetch's own window, which an agent cannot answer, and saying nothing is a no.
  if (verdict.needsApproval) {
    // Keyed on the device for a simulator, never on the app: one yes to Simulator would
    // otherwise be a yes to every device on the Mac, and they are not the same machine.
    // And on what it hears: a yes to a silent take is not a yes to one with sound.
    const heard = !still && args.sound ? args.sound : null
    const sound = heard && (heard.systemAudio || heard.mic)
      ? (heard.systemAudio && heard.mic ? 'sys+mic' : heard.systemAudio ? 'sys' : 'mic') : null
    const key = (still ? 'shot|' : 'take|') +
      (sim ? 'udid:' + sim.udid : args.window != null ? 'app:' + (app || '') : 'display') +
      (sound ? '|sound:' + sound : '')
    if (sessionAllowed.has(key)) return
    if (allowedAlways(key)) return
    const who = (ctx && ctx.client) || 'An agent'
    const what = sim ? `the ${sim.name} simulator`
      : args.window != null ? (app ? `a ${app} window` : 'a window') : 'your whole screen'
    const heardSaid = !sound ? ''
      // What they are saying yes to, in the scope the recorder really has: a window take's
      // sound is the display's, with no app left out (Recorder.swift start says why).
      : ' ' + [heard.systemAudio ? 'Its sound is recorded too, and that is everything this Mac plays while it ' +
        `records: the ${sim ? 'device' : 'window'}, and your music or a call as well if they are playing.` : '',
      heard.mic ? 'Your microphone is recorded too.' : ''].filter(Boolean).join(' ')
    const answer = await askPerson(
      `${who} wants to ${still ? 'take a screenshot of' : 'record'} ${what}${sound ? ', with sound' : ''}.`,
      (args.window != null
        ? 'Only that window is captured, in the background, even while you work in front of it.'
        : 'Apps on your never-record list are left out of the frame.') + heardSaid +
      (still
        ? ' One frame is written, now. Nothing keeps running afterwards.'
        : ' The menu bar icon turns red while it records.'),
      sim
        ? `Allow ${still ? 'screenshots of ' : ''}${sim.name} until Fetch quits`
        : args.window != null
          ? `Allow ${still ? 'screenshots of ' : ''}${app || 'this app'} until Fetch quits`
          : null,
      still, null, false,
      { alwaysLabel: sim ? `Always allow ${sim.name}` : args.window != null ? `Always allow ${app || 'this app'}` : null })
    if (answer === 'unanswered') throw new Error(`Fetch refused to ${act}: ${verdict.unanswered}`)
    if (answer === 'no') throw new Error(`Fetch refused to ${act}: the person at the Mac said no`)
    if (answer === 'session') sessionAllowed.add(key)
    if (answer === 'always') {
      rememberAlways(key, `${still ? 'Screenshots of' : 'Recording'} ${what}${sound ? ', with sound' : ''}`)
    }
  }
}

// Approvals given with "until Fetch quits". In memory only, so a restart asks again.
const sessionAllowed = new Set()

// Approvals given with "Always allow". These outlive the run, so they live in prefs
// rather than in memory, each one carrying the words the person read when they granted
// it and the day they did, because a permission nobody can find is a permission nobody
// can take back. Settings lists them and removes them one at a time.
//
// What can never be in here: anything SIM_REFUSED names. That table is checked above
// consent in record-policy, so erase, delete, uninstall, create, clone and upgrade never
// reach a question at all, and no yes of any length can reach them. The invariant is
// structural rather than a filter on this list, and the tests assert it that way.
//
// An agent cannot write this: 'alwaysAllow' is in HUMAN_ONLY_PREFS, so set_settings
// refuses a patch that so much as mentions it. Only the button below puts one here.
const alwaysList = () => {
  const p = deps.getPrefs ? deps.getPrefs() : {}
  return Array.isArray(p.alwaysAllow) ? p.alwaysAllow.filter(e => e && e.key) : []
}
const allowedAlways = key => !!key && alwaysList().some(e => e.key === key)
function rememberAlways(key, label) {
  if (!key || allowedAlways(key)) return
  const next = [...alwaysList(), { key, label: label || key, at: new Date().toISOString() }]
  if (deps.setPrefs) deps.setPrefs({ alwaysAllow: next })
}

// A free-standing alert rather than a sheet on Fetch's window: the question needs an
// answer, but it should not drag the whole app in front of what the person is doing.
// Parent-less on purpose, and that is load bearing. Given a window to sit on, macOS
// makes it a sheet, and a sheet on a window that was created hidden is queued by AppKit
// until that window is shown: the person is never asked, the deadline below always wins,
// and every agent capture is refused a minute after it was made. A question nobody can
// see is a worse failure than the hang it was meant to fix.
//
// Bounded all the same, because an unattended agent must never wait forever. On the
// shipping Recording access default every agent capture raises this, and with nobody at
// the Mac the call simply never returned. A person who is here answers in seconds; a
// minute of silence means nobody is, and the call refuses with the sentence takeShot
// gives. The alert stays up, since only a person can dismiss a free-standing one, and an
// answer that arrives after the deadline lands on a promise nobody holds: this call
// already refused and will not capture anything on the strength of a late yes.
const ASK_WAIT_MS = 60000
// The person's yes to rules going into force, in Fetch, with the words in front of them.
// deps.confirmRules stands in for the question where there is no window (the tests). A
// question that cannot be asked is a no.
async function rulesConfirmed(product, texts) {
  try {
    if (typeof deps.confirmRules === 'function') return (await deps.confirmRules(product, texts)) === true
    const n = texts.length
    const answer = await askPerson(`Put ${n === 1 ? 'this rule' : `these ${n} rules`} in force for ${product}?`,
      texts.map(t => `\u2022 ${t}`).join('\n') + '\n\nThe agent will read ' + (n === 1 ? 'it' : 'them') +
      ' before it plans, records or styles anything for this product.', null, false, 'Put in force')
    return answer === 'once' || answer === 'session'
  } catch { return false }
}

async function askPerson(message, detail, sessionLabel, still = false, allowLabel = null, sessionFirst = false,
  { alwaysLabel = null } = {}) {
  const { dialog } = require('electron')
  // Driving somebody's device is not recording it, so the button says which it is.
  const once = allowLabel || (still ? 'Allow this shot' : 'Allow this take')
  // A flow is many of the same question. Ten taps put ten dialogs on somebody's screen
  // unless they happened to press the second button the first time, so where the answer
  // is one of a run the session answer is the one under their hand.
  const both = sessionLabel ? (sessionFirst ? [sessionLabel, once] : [once, sessionLabel]) : [once]
  const always = alwaysLabel ? [alwaysLabel] : []
  const buttons = [...both, ...always, 'Don\'t allow']
  const no = buttons.length - 1
  let timer = null
  // On a window, never parentless. A parentless message box on macOS is run with
  // -[NSAlert runModal], which blocks Electron's main thread: the socket stops
  // answering, the menu stops opening, the app cannot even be quit, and the deadline
  // below can never fire because the timer that would fire it is on the loop the modal
  // is holding. Measured: with the display asleep, every Fetch call timed out and the
  // app had to be killed. Given a window that is really on screen it is a sheet
  // instead, which leaves the loop running, so the deadline works and a person who is
  // not there costs a minute rather than the app.
  //
  // The window is shown without taking focus. A question about what an agent is doing
  // should be visible, and Fetch was already the thing being asked about; what it must
  // not do is steal the keyboard out from under whatever the person is typing in.
  let host = null
  try { host = deps.askHost ? deps.askHost() : null } catch { host = null }
  const opts = { type: 'question', message, detail, buttons, defaultId: no, cancelId: no, noLink: true }
  const asked = (host ? dialog.showMessageBox(host, opts) : dialog.showMessageBox(opts))
    .then(r => (r.response === no ? 'no'
    : buttons[r.response] === alwaysLabel ? 'always'
    : buttons[r.response] === sessionLabel ? 'session' : 'once'), () => 'no')
  let answer
  try {
    const waited = new Promise(res => { timer = setTimeout(() => res('unanswered'), ASK_WAIT_MS) })
    answer = await Promise.race([asked, waited])
  } finally { if (timer) clearTimeout(timer) }
  // A dialog can be up when the person presses Esc, and a yes clicked after that is not
  // a yes to an agent they have just stopped (main.js, the brake). Checked here, once,
  // so every question this bridge asks honours it.
  if (answer !== 'no' && answer !== 'unanswered' && deps.held && deps.held()) {
    throw new Error('The person pressed Esc to stop you, so Fetch did nothing. Stop here and ask the person what they want.')
  }
  return answer
}

// Every font family the person's projects ship, for options.fonts. Read off the files
// rather than off their names: DMSans-VF.ttf is the "DM Sans" family and no rule over
// the filename gets that right. Cached for a minute, because this is read on every
// get_edit and a project's fonts do not change inside one.
const PROJECT_FONT_MS = 60e3
let projFonts = { at: 0, names: [] }
function projectFontNames() {
  const now = Date.now()
  if (now - projFonts.at < PROJECT_FONT_MS) return projFonts.names
  const names = new Set()
  try {
    const pf = require('./project-fonts')
    for (const proj of require('./projects').projectIndex() || []) {
      const root = proj && (proj.path || proj.dir)
      if (!root) continue
      for (const f of pf.fontsIn(root)) names.add(f.family)
    }
  } catch {}
  projFonts = { at: now, names: [...names].sort() }
  return projFonts.names
}

// ── simulators, as things Fetch knows ────────────────────────────────────
//
// The scope of this whole section, stated once: simctl has forty two subcommands and no
// tap, no swipe and no type. So everything except the touch is a command that ships with
// Xcode, built as argv by ui/simctl.js, and nothing below reimplements one of them. The
// touch is driven by a tool the person put on their own PATH, or it is refused in a
// sentence and the person taps it themselves, which is a take Fetch records beautifully.
//
// The capture itself is not special at all: a simulator is a window, so it goes through
// record.start and shot.take, through decide(), through the never-record lists and
// through the one renderer, and it keeps its sound. simctl's own framebuffer capture is
// refused in ui/record-policy.js for exactly that reason: no audio track, and pixels
// that never passed the policy.

const SIM_DOES = ['list', 'ready', 'go', 'tap', 'restore']

// ── which kind of identifier an argument is ────────────────────────────────
// Every simulator argument takes one kind of identifier: device a UDID or a name, app a
// path to a built .app, bundle a bundle id, url a link with a scheme, element an E or R
// id. The judged job's one wasted call was a bundle id sent as app, and it was refused
// only after the person had said yes and the device had booted. So the form of each is
// read here, before any question and any spawn. Where the form is unambiguous (a bundle
// id is never an absolute path) the value is moved to the argument that takes it and the
// result says so; where it is not, the refusal names the argument it belongs in.
const LOOKS = {
  bundle: v => /^[A-Za-z0-9-]+(\.[A-Za-z0-9_-]+)+$/.test(v) && !/\.app$/i.test(v),
  appPath: v => /^(\/|~\/)/.test(v) || /\.app\/?$/i.test(v),
  udid: v => /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i.test(v),
  windowId: v => /^\d+$/.test(v),
  link: v => /^[A-Za-z][A-Za-z0-9+.-]*:/.test(v),
  element: v => /^[ER]\d+$/i.test(v),
}
const said = v => String(v == null ? '' : v).trim()

/** Arguments with each identifier in the argument that takes it, and what was moved. */
function simArgs(action, raw = {}) {
  const args = { ...raw }
  const moved = []
  if (action === 'ready') {
    const app = args.app != null ? said(args.app) : null
    const bundle = args.bundle != null ? said(args.bundle) : null
    if (app && !LOOKS.appPath(app)) {
      if (LOOKS.bundle(app) && (!bundle || bundle === app)) {
        delete args.app; args.bundle = app
        moved.push(`app takes the path to a built .app and ${app} is a bundle id, so it was launched as bundle`)
      } else {
        throw new Error(`app takes the absolute path to a built .app, and "${app}" is not one. ` +
          (LOOKS.bundle(app) ? 'It looks like a bundle id: send it as bundle. ' : '') +
          'simulator ready with bundle launches an app already on the device. Nothing was asked and nothing was booted.')
      }
    }
    if (bundle && LOOKS.appPath(bundle)) {
      if (!args.app) {
        delete args.bundle; args.app = bundle
        moved.push(`bundle takes a bundle id and ${bundle} is a path to a .app, so it was installed as app`)
      } else {
        throw new Error(`bundle takes a bundle id like com.example.app, and "${bundle}" is a path. The path goes in app, ` +
          'which installs it and launches it. Nothing was asked and nothing was booted.')
      }
    }
    if (args.app) {
      const a = said(args.app).replace(/^~(?=\/)/, require('os').homedir()).replace(/\/$/, '')
      if (!path.isAbsolute(a) || !/\.app$/i.test(a)) {
        throw new Error(`app takes the absolute path to a built .app, and "${args.app}" is not one. Build it and ` +
          'send the path to the .app, or send bundle to launch an app already on the device.')
      }
      if (!fs.existsSync(a)) {
        throw new Error(`there is no app bundle at ${a}. Build it first and send the path to the .app, or send ` +
          'bundle to launch an app already on the device. Nothing was asked and nothing was booted.')
      }
      args.app = a
    }
  }
  if (action === 'go') {
    const url = args.url != null ? said(args.url) : ''
    if (url && !LOOKS.link(url)) {
      throw new Error(`url takes a link with a scheme, like myapp://onboarding or https://example.com, and "${url}" has none. ` +
        (LOOKS.bundle(url) ? 'It looks like a bundle id: simulator ready with bundle launches that app. ' : '') +
        'Nothing was opened.')
    }
  }
  if (action === 'tap' && args.element != null && !LOOKS.element(said(args.element))) {
    const e = said(args.element)
    throw new Error(`element takes an id like E12, off the screen ready or the last tap handed back, and "${e}" is not one. ` +
      `To aim at words, call find_on_screen with "${e}" on a shot of the device and send the id it hands back.`)
  }
  return { args, moved }
}

// Why a device was not found, when the value was another kind of identifier.
function deviceHint(v) {
  const s = said(v)
  if (!s) return ''
  if (LOOKS.bundle(s)) return ` "${s}" looks like a bundle id: device takes a UDID or the device's name from list, and the app goes in bundle.`
  if (LOOKS.appPath(s)) return ` "${s}" is a path to an app: device takes a UDID or the device's name from list, and the path goes in app.`
  if (LOOKS.windowId(s)) return ` "${s}" looks like a window id from list_windows: device takes the UDID or the device's name.`
  return ''
}

// Required at the call, not at the top: ui/simctl.js spawns, and a Mac with no Xcode on
// it should pay nothing for a feature it cannot use.
let simctlMod = null
const simctl = () => (simctlMod || (simctlMod = require('./simctl')))

// The join that names the device inside a Simulator window is an enhancement to a
// capture, not the capture, so it waits seconds and not minutes. The wrapper's 180 s
// first call budget is right for a boot an agent asked for and wrong in front of a
// screenshot: with an empty stash nothing has spawned yet, so the first simctl call of
// the session is this one, and a person pressing record waited up to three minutes with
// nothing on screen. That is the hang the budget was written to avoid, arriving by the
// other door. A join that runs out is a window with no device named on it.
const CAPTURE_JOIN_MS = 6000
let simctlQuick = null
const simctlFast = () => (simctlQuick || (simctlQuick = require('./simctl')
  .make({ budget: { read: CAPTURE_JOIN_MS }, firstMs: CAPTURE_JOIN_MS })))

// The device a take or a shot is of, held from start to stop. Only the two things that
// outlive the call: what to write onto the document, and what to put back.
let takeSim = null
const dressed = new Set()     // the devices whose status bar Fetch is holding right now


const readQuiet = (bin, argv) => new Promise(res => {
  require('child_process').execFile(bin, argv, { timeout: 8000, maxBuffer: 4 << 20 },
    (err, out) => res(err ? null : String(out)))
})

// profile.plist is the only place on this Mac the native framebuffer size exists, and it
// is a binary plist, so plutil converts it. Read once per device type rather than once
// per device, and read only.
async function simProfiles(typeIds, types) {
  const ids = [...new Set(typeIds)].filter(Boolean)
  // Fetched here because plutil is a process and this file is the one that spawns; the
  // keying, the parse and the once-per-type rule are the model's (Sim.readProfiles), so
  // two booted iPhone 16s read one profile between them and there is one copy of what a
  // profile means.
  const text = {}
  await Promise.all(ids.map(async id => {
    const p = Sim.profilePath(types[id])
    if (p) text[p] = await readQuiet('/usr/bin/plutil', ['-convert', 'json', '-o', '-', p])
  }))
  return Sim.readProfiles(ids, types, path => text[path] || null)
}

/**
 * Every simulator on this Mac, joined to the windows on screen. Never cached: the person
 * creates and deletes devices between turns, and `list devices -j` is a fifth of a second.
 */
async function simModel(windows, o = {}) {
  const c = o.budget ? simctlFast() : simctl()
  const [dev, run, types] = await Promise.all([c.listDevices(), c.listRuntimes(), c.listDeviceTypes()])
  if (!dev.ok) throw new Error(dev.reason)
  const runtimes = run.ok ? Sim.parseRuntimes(run.value) : {}
  const typeMap = { ...Sim.deviceTypesFromRuntimes(runtimes), ...Sim.parseDeviceTypes(types.ok ? types.value : null) }
  const devices = Sim.parseDevices(dev.value)
  const profiles = await simProfiles([...new Set(devices.map(d => d.deviceTypeId))], typeMap)
  const wins = windows || (deps.listWindows ? await deps.listWindows().catch(() => []) : [])
  // Where the glass sits inside each window is handed in from what a capture measured,
  // never worked out from the window's shape: ui/simulator.js has the numbers and the
  // reason. Nothing here captures anything, so a list stays a list.
  return Sim.simulators({ devices, runtimes, deviceTypes: types.ok ? types.value : null,
    profiles, windows: wins, glassOf })
}

// ── where the glass is, read off pixels ──────────────────────────────────
//
// The rectangle a tap is aimed through, a capture is cropped to and the drawn phone
// stands in cannot be derived. Simulator's toolbar is 52 points tall whatever the window
// scale, so the screen is a different fraction of the window on every device and moves
// again the moment somebody drags a corner: fitting the screen's aspect inside the
// window put the rectangle 12 percent out on a phone with a notch and 19 percent out on
// one with a home button, which sent a tap 80 points above the button it was aimed at
// and left the Mac's own toolbar inside a crop that promised to remove it.
//
// So it is measured off a capture of the window (ui/simulator.js measureGlass) and kept
// against that window's own size. Fractions of the window are what is kept, so moving
// the window changes nothing and resizing it changes everything: a resized window has a
// new key and no measurement until the next capture, which is the refusal in words
// rather than a stale rectangle.
//
// This replaced the display's backing scale. A measured glass is already in the
// capture's own pixels, so which display the window sits on stops coming into it.
const glassSeen = new Map()    // `${window id}|${w}x${h}` -> what measureGlass returned
const GLASS_KEEP = 16

const glassKey = w => (w && w.id != null
  ? `${w.id}|${Math.round(+w.w || +w.width || 0)}x${Math.round(+w.h || +w.height || 0)}` : null)

function glassOf(win) {
  const k = glassKey(win)
  const hit = k ? glassSeen.get(k) : null
  return hit && hit.glass ? hit.glass : null
}

/**
 * Measure one Simulator window off a capture of it, and keep what came back.
 *
 * file is a capture this call already had (take_shot's own, which costs nothing extra);
 * with none, one is taken. Returns { glass, file } or null. Never throws: a measurement
 * that fails leaves the device with no rectangle, which every tool downstream already
 * says out loud rather than working around.
 */
async function readGlass(win, file, screen) {
  const k = glassKey(win)
  if (!k) return null
  let shot = file ? { file, scratch: false } : null
  if (!shot) shot = await scratchShot(win)
  if (!shot) return null
  let glass = null
  try {
    const img = require('electron').nativeImage.createFromPath(shot.file)
    const size = img.getSize()
    // toBitmap is BGRA and measureGlass reads the largest of the three colour channels,
    // so which way round they are never comes into it.
    const m = Sim.measureGlass({ width: size.width, height: size.height, data: img.toBitmap() })
    glass = m && m.ok ? m.value : null
    if (!glass && m) glassWhyNot.set(k, m.reason)
    // A rectangle that is not the screen's shape is a dark app read as the glass, and it
    // is turned down here rather than kept, the same test the viewport is held to.
    if (glass && screen && !Sim.glassViewport(glass, screen)) {
      glassWhyNot.set(k, 'what was measured is not the shape of the device screen, which is what an app dark to its own edge looks like.')
      glass = null
    }
  } catch { /* no Electron, or a file that is not a picture: no rectangle, and no guess */ }
  // The frame is kept while it is the newest one for this window, because the ids
  // find_on_screen minted on it have to resolve until the next capture replaces it.
  // The rectangle is not: one screen that cannot be read (dark mode, a splash, a black
  // hero) says nothing about where the glass is, and the window has not moved, so the
  // last one that passed stands until a new window size makes a new key.
  const had = glassSeen.get(k)
  if (had && had.file && had.file !== shot.file) dropScratch(had.file)
  const kept = glass || (had && had.glass) || null
  glassSeen.set(k, { glass: kept, file: shot.scratch ? shot.file : null, at: Date.now() })
  while (glassSeen.size > GLASS_KEEP) {
    const oldest = glassSeen.keys().next().value
    const gone = glassSeen.get(oldest)
    if (gone && gone.file) dropScratch(gone.file)
    glassSeen.delete(oldest)
  }
  // captured says a picture was taken now, whatever it measured: what is on screen is
  // named off this frame and no older one.
  return { glass: kept, fresh: !!glass, file: shot.file, captured: true }
}

// Why the last measurement of a window found nothing, so a refusal can say it.
const glassWhyNot = new Map()

/**
 * One capture of a window, for Fetch to measure and read rather than for anybody to
 * look at. It never lands in the person's library: main.js writes a scratch capture to
 * a temporary file. A build whose capture path has no scratch in it yet writes a take
 * folder, and that folder goes to the trash here rather than leaving a measurement in
 * somebody's Library.
 */
async function scratchShot(win) {
  if (!deps.takeShot || !win || win.id == null) return null
  let got = null
  try { got = await deps.takeShot({ windowId: String(win.id), by: 'agent', approved: true, scratch: true }) }
  catch { return null }
  if (!got || !got.ok || !got.original) return null
  if (got.scratch) return { file: got.original, scratch: true }
  // No scratch in this build's capture path: the frame is moved out and the folder the
  // capture made goes to the trash, so a measurement never sits in the person's Library
  // looking like a picture they asked for. Recoverable, and only ever the folder this
  // call just made.
  try {
    const to = path.join(require('os').tmpdir(), `fetch-glass-${process.pid}-${Date.now().toString(36)}.png`)
    fs.copyFileSync(got.original, to)
    const take = deps.proc && deps.proc.takeDir ? deps.proc.takeDir(got.original) : null
    if (take && /^shot-\d+$/.test(path.basename(take))) {
      require('electron').shell.trashItem(take).catch(() => {})
    }
    return { file: to, scratch: true }
  } catch { return { file: got.original, scratch: false } }
}

function dropScratch(file) {
  try { if (file && file.startsWith(require('os').tmpdir())) fs.unlinkSync(file) } catch {}
}

// The newest capture of each device's window, by UDID, so a tap can name an element
// without being handed the path the id was minted on.
const simSeen = new Map()

// One device's screens as one run of ids. Each new picture of the device is handed the
// last list as its prior, so the same control keeps the same id from ready to
// record_start to every tap, and anything new is numbered past every id the run has
// handed out (ui/targets.js carryIds). An id held from any screen in the run means the
// same control on the newest one, or is not on it and is refused. A control repeated
// down a list (a Delete per row) takes its id from its own row's words and nothing else,
// so when a row is deleted its Delete's id dies with it and never passes to the next
// row's. A row with no words of its own ("Untitled" on every row, "Step 1", a bare
// thumbnail) carries nothing, and a heading replaced in place starts a new screen with
// nothing carried. The cases carryIds cannot tell apart are the same words at the same
// size and place on a screen the device went on to (a Done in the same corner), and two
// controls that each appear once on a one-row screen whose label changed below a heading
// that stayed ("Shakshuka [Edit] [Delete]" becoming "Pancakes [Edit] [Delete]" under
// "Recipes"), which vouch for each other. Both are carried as the same controls, and so
// is a detail screen whose item name sits below the top quarter, under a hero picture:
// "Delete recipe" carried from Shakshuka's page to Pancakes' (/tmp/q-taste/detail.js case
// 2, E4 to E4). The guard (ui/guard.js), run on the picture simTap takes just before the
// touch, is what refuses those; the matcher cannot, and is not asked to.
//
// That holds only while the carry really happens, so it is checked on every pass
// (carriedOn) rather than assumed: a pass that came back numbered from E1 again starts
// the run over, and ids from before it are not trusted on the newest screen.
const simChain = new Map()     // udid -> the newest list in the run
const chainOf = new Map()      // path -> udid, for every picture whose list is in a run

/**
 * Whether `all` was numbered on from `prior` rather than from E1. A list that kept an
 * id kept it on purpose; a list that kept none is on from prior only if every id in it
 * is past the highest prior could have handed out. A pass that ignored prior numbers
 * from E1, which is neither.
 *
 * A prior that handed out nothing proves nothing: numbering on from 0 and starting at E1
 * are the same list, and taking that for a carry is how an id held from a screen before
 * an empty one came to resolve on a different control. A screen with nothing on it keeps
 * the run going when it kept the count (its seq is past the prior's top), so the ids
 * after it are numbered past everything before it.
 */
function carriedOn(prior, all) {
  if (!Array.isArray(prior) || !Array.isArray(all)) return false
  const num = e => +String(e && e.id).slice(1) || 0
  const top = Math.max(+prior.seq || 0, 0, ...prior.map(num))
  if (!(top > 0)) return false
  // where the list says how far it counted, that has to reach past what prior handed out
  if (typeof all.seq === 'number' && !(all.seq >= top)) return false
  if (!all.length) return typeof all.seq === 'number'
  if (all.carried > 0) return true
  return all.every(e => num(e) > top)
}

// A pass on a device's picture joins its run when it carried on from it, and starts the
// run over when it did not. A search of an older picture in the run is numbered on from
// the run too, but it does not become the run's newest list: the next screen of the
// device is matched against the screen before it, not against an older one searched late.
// One that did not carry leaves the run on its own and takes nothing else with it.
//
// Every pass in the run moves the run's count on, the late search of an older picture
// included: a control only it saw was numbered past the run's top, and the next screen
// of the device must be numbered past that too, or the same E-number would name two
// different controls on one device.
function joinRun(udid, file, prior, all) {
  const on = !!prior && carriedOn(prior, all)
  const newest = simSeen.get(udid) === file || !simChain.has(udid)
  const num = e => +String(e && e.id).slice(1) || 0
  const top = Math.max(+(all && all.seq) || 0, 0, ...(Array.isArray(all) ? all.map(num) : []))
  if (!newest) {
    if (on) { chainOf.set(file, udid); runTop.set(udid, Math.max(runTop.get(udid) || 0, top)) } else chainOf.delete(file)
    return on
  }
  if (!on) for (const [p, u] of chainOf) if (u === udid) chainOf.delete(p)
  runTop.set(udid, on ? Math.max(runTop.get(udid) || 0, top) : top)
  simChain.set(udid, all)
  chainOf.set(file, udid)
  return on
}
const runTop = new Map()        // udid -> the highest id number handed out in the run

// The run's newest list as the prior for the next pass, counting from the run's top
// rather than from that list's own, which a late search of an older picture may have
// passed. The list's seq and frame are read-only, so a copy carries the higher count.
function runPrior(udid) {
  const l = simChain.get(udid) || null
  const top = runTop.get(udid) || 0
  if (!l || !(top > (+l.seq || 0))) return l
  const c = l.slice()
  Object.defineProperty(c, 'seq', { value: top })
  Object.defineProperty(c, 'frame', { value: l.frame })
  return c
}

/**
 * What is on the glass, named, off the same capture that measured it.
 *
 * Five of the nineteen calls in the judged job were a take_shot and a find_on_screen
 * after something that had just changed what is on screen. The picture is already paid
 * for here, so naming what is on it costs one pass over a file this call already has,
 * and the ids are the ones a tap takes: the next call is the tap rather than a look.
 */
async function simScreen(sim, o = {}) {
  const k = glassKey(sim && sim.window)
  const held = k ? glassSeen.get(k) : null
  // Only a frame this call took. A capture that failed leaves the last one in place, and
  // naming that as the new screen hands back ids for a screen that has gone.
  if (!held || !(held.at >= (+o.since || 0))) return null
  const file = held.file || null
  if (!file || !deps.proc || !deps.proc.findOnScreen) return null
  try {
    // No crop: a tap is aimed through the glass rectangle and that arithmetic starts in
    // the whole frame, so the boxes have to be measured there too.
    // The device's last screen as the prior, so a button that has not moved keeps its id
    // (or, for a tap aimed off a still no run has taken on, that still's list)
    const prior = o.prior || runPrior(sim.udid)
    const key = runKey(file, { run: sim.udid }), reissued = []
    const r = await deps.proc.findOnScreen(file, 0, { limit: Math.max(1, Math.min(24, +o.limit || 12)), prior,
      guard: guardHook(key, reissued) })
    reissued.push(...settle(r, key))
    noteFound(file, 0, r.elements, r.all, { aspect: r.width > 0 && r.height > 0 ? r.width / r.height : 0,
      run: sim.udid, frame: { width: r.width, height: r.height } })
    simSeen.set(sim.udid, file)
    const carries = joinRun(sim.udid, file, prior, r.all || r.elements)
    const kept = carries ? Math.max(0, +(r.all || []).carried || 0) : 0
    return {
      path: file, found: r.found,
      elements: r.elements.map(e => ({ id: e.id, text: e.text, kind: e.kind, box: e.box, confidence: e.confidence })),
      ...(carries ? { kept_ids: kept } : {}),
      ...(reissued.length ? { ids_retired: idsRetired(reissued) } : {}),
      how: carries
        ? 'these ids are what simulator tap takes as element. A control that was on this device\'s last screen ' +
          `keeps the id it had there (${kept} did), and anything new is numbered past every id handed out on ` +
          'this device before, so an id you hold from an earlier screen names the same control here or is refused.'
        : 'these ids are what simulator tap takes as element. They are minted on this picture, so use these and ' +
          'not an id from an earlier call.',
    }
  } catch { return null }
}

/**
 * The device again, with its window measured. Called where a rectangle is about to be
 * relied on: before a take of the device, after ready has put its window up, and before
 * a tap is aimed. The model is re-read rather than patched, because the viewport, the
 * density and which way up the device is all come off the same measurement.
 */
async function simMeasured(sim, file) {
  if (!sim || !sim.window) return sim
  const m = await readGlass(sim.window, file, sim.screen)
  if (!m || !m.glass) return sim
  const sims = await simModel().catch(() => null)
  const hit = sims && sims.find(s => s.udid === sim.udid)
  return hit || sim
}

/**
 * The window list with the machine inside each Simulator window named on it. The join
 * costs three simctl reads, so it is only paid where there is a simulator window to join
 * to, and a Mac with no Xcode gets back exactly what it handed in.
 */
async function attachDevices(windows, o = {}) {
  const list = windows || []
  if (!list.some(w => String(w.app || '') === policy.SIMULATOR_APP)) return list
  let sims = null
  // strict is the enforcement path: there the join failing is not "no device on this
  // window", it is "Fetch cannot tell", and the two must not look alike. Everywhere else
  // the join is an enhancement to a list and a Mac with no Xcode gets its list back.
  // The capture path also gets its own short deadline: waiting three minutes on Xcode's
  // first launch check is the hang the wrapper was written to avoid, and this join is
  // not what the person pressed record for.
  try { sims = await simModel(list, { budget: o.strict ? null : CAPTURE_JOIN_MS }) }
  catch (e) { if (o.strict) throw e; return list }
  const byWindow = new Map()
  for (const s of sims) if (s.window) byWindow.set(String(s.window.id), s)
  return list.map(w => {
    const s = byWindow.get(String(w.id))
    if (!s) return w
    return { ...w, device: {
      udid: s.udid, name: s.name, family: s.family, state: s.state, booted: s.booted,
      ...(s.screen ? { screen: `${s.screen.w}x${s.screen.h}`, points: s.glass || s.screen.points } : {}),
      ...(s.orientation === 'landscape' ? { orientation: 'landscape' } : {}),
      ...(s.viewport ? { viewport: s.viewport } : {}),
      ...(s.density != null ? { density: s.density } : {}),
      ...(Sim.densityNote(s) ? { density_note: Sim.densityNote(s) } : {}),
    } }
  })
}

// A device named on record_start or take_shot, resolved to the window Fetch records.
// Nothing is brought to the front to make one: a window that is not there is a boot the
// person has not asked for yet, and ready is where they ask.
async function simTarget(q) {
  const sims = await simModel()
  const found = Sim.resolve(sims, q)
  if (!found.ok) throw new Error(`${found.reason}${deviceHint(q)} simulator with action list says which devices are here.`)
  const sim = found.value
  if (!sim.window) {
    throw new Error(`${sim.name} has no window on screen, and Fetch records windows. ` +
      `simulator { action: 'ready', device: '${sim.name}' } boots it and opens its window. ` +
      (sim.booted ? 'The device is booted, so Simulator is closed or showing another one.' : ''))
  }
  return sim
}

function simList(sims) {
  const never = (deps.getPrefs ? deps.getPrefs() : {}).neverRecordDevices
  return {
    devices: sims.map(s => ({
      // Said here rather than discovered by being refused three calls later. The device
      // is still listed, because a device the person can see in Simulator and not here
      // reads as Fetch being broken rather than as their own list doing its job.
      ...(policy.isDeviceProtected({ udid: s.udid, name: s.name }, never)
        ? { never_record: 'this device is on the person\'s never record devices list, so Fetch neither records it nor drives it, with any consent. Only they can take it off that list.' }
        : {}),
      udid: s.udid, name: s.name, family: s.family, device_type: s.deviceType, runtime: s.runtime,
      state: s.state, booted: s.booted,
      ...(s.screen ? { screen: `${s.screen.w}x${s.screen.h}`, scale: s.screen.scale, points: s.glass || s.screen.points } : {}),
      ...(s.orientation === 'landscape' ? { orientation: 'landscape' } : {}),
      ...(s.window ? { window: String(s.window.id), window_size: `${s.window.w}x${s.window.h}` } : {}),
      ...(s.density != null ? { density: s.density } : {}),
      ...(Sim.densityNote(s) ? { density_note: Sim.densityNote(s) } : {}),
      ...(s.note ? { note: s.note } : {}),
      ...(s.availabilityError ? { unavailable: s.availabilityError } : {}),
    })),
    how: 'record_start and take_shot take simulator where they take window, and record the device ' +
      `where it sits: nothing is brought to the front, and ${Opts.SIM_LIST_SAID}. ` +
      'viewport and density are measured off a picture of the window and are missing until something ' +
      'takes one: ready measures it, and so does a take or a shot of the device. density is captured ' +
      'pixels per pixel the device has; under 1 a store sized export would be an upscale and is refused.',
  }
}

// What the result says about the device a capture is of.
function simFacts(sim, bar) {
  return {
    udid: sim.udid, device: sim.name, family: sim.family, runtime: sim.runtime,
    ...(sim.window ? { window: String(sim.window.id) } : {}),
    ...(sim.screen ? { screen: `${sim.screen.w}x${sim.screen.h}`, scale: sim.screen.scale, points: sim.glass || sim.screen.points } : {}),
    ...(sim.orientation === 'landscape' ? { orientation: 'landscape, so the points a tap is aimed in are the long edge across' } : {}),
    ...(sim.viewport ? { viewport: sim.viewport } : {}),
    // Why there is none, where there is none: the descriptions promise the result says so.
    ...(!sim.viewport && sim.window && (sim.note || Sim.glassNote(sim)) ? { note: sim.note || Sim.glassNote(sim) } : {}),
    ...(sim.density != null ? { density: sim.density } : {}),
    ...(Sim.densityNote(sim) ? { density_note: Sim.densityNote(sim) } : {}),
    ...(bar && bar.said ? { status_bar: `Fetch set ${bar.said}, and puts back ${bar.restores} when this is over` } : {}),
    ...(bar && bar.failed ? { status_bar: `the status bar was left alone: ${bar.failed}` } : {}),
  }
}

// A take of a device written before the capture stored its glass's corner has the
// corner read off one of its frames when it is drawn (ui/compositor/prepare.js). Once
// that has been read, it goes onto the document, so it is read once and never again, and
// review and the editor see the same corner the export drew. Only ever added: a corner
// already there is the capture's own and wins.
async function cornerOntoDoc(src, meta) {
  try {
    if (!src || !fs.existsSync(src) || isShot(src)) return
    const m = meta && meta.width > 0 ? meta : await deps.proc.probeMeta(src).catch(() => null)
    // A corner already stored is kept only while it passes the check a new one has to:
    // the old rule read a third of the real corner off a recording (0.0535 against
    // 0.1578) and wrote it here for good, so every later export inherited it. A suspect
    // one is read again, and taken off where the new reading is refused, so the take
    // draws with no corner rather than a wrong one, and is read again next time.
    // ui/fetchdoc.js drops a suspect corner on read, so readDoc never hands one back.
    // On a screen whose radius is not known, glassFor checks a stored corner against one
    // frame and says what it replaces where the two disagree.
    const doc = cornerTrusted(deps.proc.readDoc(src, m && m.duration))
    const g = await require('./compositor/prepare').glassFor(src, doc, m)
    const ok = g && g.corner > 0 && g.corner < 0.5 &&
      !Sim.cornerSuspect({ corner: g.corner }, doc.device && doc.device.screen)
    // read again at the moment of writing, so nothing written while the frame was read is lost
    const now = deps.proc.readDoc(src, m && m.duration)
    if (!now.viewport) return
    const stored = +now.viewport.corner > 0
    const suspect = stored && !!Sim.cornerSuspect(now.viewport, now.device && now.device.screen)
    // a stored corner a frame disagreed with, and still the one the frame was checked against
    const refuted = stored && !!g && g.replaces != null && Math.abs(+now.viewport.corner - g.replaces) < 1e-6
    if (stored && !suspect && !refuted) return
    if (ok) deps.proc.writeDoc(src, { ...now, viewport: { ...now.viewport, corner: g.corner } })
    else if (suspect || refuted) {
      const { corner, ...rest } = now.viewport
      deps.proc.writeDoc(src, { ...now, viewport: rest })
    }
  } catch (e) { console.warn('[bridge] the glass corner was not written onto the edit:', e && e.message) }
}

// The document with a stored corner it cannot trust taken off, in memory only, so what is
// drawn from it reads the corner again with the checked rule (compositor/prepare.js reads
// one off the take wherever the viewport has none). A corner that passes is left alone.
function cornerTrusted(doc) {
  try {
    const v = doc && doc.viewport
    if (!v || !(+v.corner > 0)) return doc
    if (!Sim.cornerSuspect(v, doc.device && doc.device.screen)) return doc
    const { corner, ...rest } = v
    return { ...doc, viewport: rest }
  } catch { return doc }
}

// What a capture of a device writes onto its document. The rectangle is the same object
// an agent's browser viewport is (ui/pointer.js viewportBox), so frame.chrome crops to
// the glass with no new plumbing, the drawn phone becomes the only phone in the picture,
// and the screen beside it is what the touch disc's 44 points are measured through.
const simOnDoc = sim => ({
  viewport: sim.viewport || null,
  device: {
    udid: sim.udid, name: sim.name, family: sim.family,
    // Which way up it was, because the same framebuffer turned is a different screen to
    // aim in and to measure 44 points across. A device on its side with this missing
    // draws a disc several times too small.
    ...(sim.screen ? { screen: { w: sim.screen.w, h: sim.screen.h, scale: sim.screen.scale,
      ...(sim.orientation === 'landscape' ? { orientation: 'landscape' } : {}) } } : {}),
    ...(sim.density != null ? { density: sim.density } : {}),
  },
})

// ── conduct, which is checked before any spawn ───────────────────────────

// The policy's answer, or a refusal with its sentence. Never a flag a caller can forget
// to read: this throws.
function simAllowed(verb, sim, consent, extra = {}) {
  const prefs = deps.getPrefs ? deps.getPrefs() : {}
  const v = policy.simDecide(verb, { udid: sim.udid, device: sim.name, consent, ...extra },
    { neverRecordDevices: prefs.neverRecordDevices })
  if (!v.allow) throw new Error(`Fetch refused: ${v.reason}`)
  return v
}

/**
 * The person's own yes, asked here and never read off the agent's arguments.
 *
 * An agent that can set its own consent flag has no consent rule at all, so the flag
 * simDecide takes is minted in this function and nowhere else.
 */
async function simAsk(verb, sim, ctx, say) {
  // The policy first, so a device on the never list is refused rather than raised as a
  // question nobody's yes could answer. Only what needs consent is ever asked for.
  const prefs = deps.getPrefs ? deps.getPrefs() : {}
  const first = policy.simDecide(verb, { udid: sim.udid, device: sim.name },
    { neverRecordDevices: prefs.neverRecordDevices })
  if (!first.allow && !first.needsConsent) throw new Error(`Fetch refused: ${first.reason}`)
  if (first.allow) return true
  const key = `sim|${verb}|${sim.udid}`
  if (sessionAllowed.has(key)) return true
  if (allowedAlways(key)) return true
  const who = (ctx && ctx.client) || 'An agent'
  const answer = await askPerson(`${who} ${say.wants} ${sim.name}.`, say.detail,
    say.session ? `${say.session} until Fetch quits` : null, false, say.allow, !!say.sessionFirst,
    { alwaysLabel: say.session ? `${say.session} always` : null })
  if (answer === 'unanswered') {
    throw new Error(`Fetch refused: driving somebody's device needs their word, and nobody was at the ` +
      'Mac to give it. Ask them in the chat and try again.')
  }
  if (answer === 'no') throw new Error('Fetch refused: the person at the Mac said no.')
  if (answer === 'session') sessionAllowed.add(key)
  if (answer === 'always') rememberAlways(key, `${say.session || verb} on ${sim.name}`)
  return true
}

// ── the five actions ─────────────────────────────────────────────────────

/**
 * Boot, show, install, launch, dress. One yes carries the sequence, because a person who
 * asked for a device to be made ready did not want to be asked again about the boot
 * inside it, and the result names every part of it in words.
 */
async function simReady(sim, args, ctx) {
  const c = simctl()
  const app = args.app ? String(args.app) : null
  // A built app installed and not launched is a device showing its home screen, and the
  // step this call is was "launch the app". The id is read off the bundle's own
  // Info.plist rather than asked for, because it is written there and nowhere else.
  const bundle = args.bundle ? String(args.bundle) : app ? await bundleIdOf(app) : null
  const will = [
    sim.booted ? null : 'boot it',
    sim.window ? null : 'open Simulator in the background, without bringing it to the front',
    app ? `install ${path.basename(app)}` : null,
    bundle ? `launch ${bundle}` : null,
    args.status_bar === false ? null : 'set the status bar to 9:41 with full bars and a charged battery, and put your own back afterwards',
    args.appearance ? `switch it to ${String(args.appearance).toLowerCase()}` : null,
    'take one picture of its window, to measure where the screen sits inside it',
  ].filter(Boolean)
  await simAsk('ready', sim, ctx, {
    wants: 'wants to get a simulator ready to record:',
    detail: `It will ${will.join(', ')}. Nothing moves your mouse, presses your keyboard or makes a sound, ` +
      'and no device is created, erased or deleted.',
    allow: 'Allow',
  })

  const changed = []
  if (!sim.booted) {
    simAllowed('boot', sim, ['ready'])
    const r = await c.boot(sim.udid)
    if (!r.ok) throw new Error(r.reason)
    changed.push(r.value.changed ? `booted ${sim.name}` : `${sim.name} was already booted`)
  }
  // simctl boot is headless and produces no window at all, so a boot the person asked
  // for would otherwise happen invisibly. Opened in the background: an invisible boot is
  // worse than a visible one, and a window dragged in front of their work is worse again.
  if (!sim.window) {
    simAllowed('open simulator', sim, ['ready'])
    if (!deps.openSimulator) throw new Error('this build of Fetch cannot open Simulator, so the booted device has no window to record.')
    await deps.openSimulator()
    changed.push('opened Simulator in the background; nothing was brought to the front')
  }
  if (app) {
    simAllowed('install', sim, ['ready'])
    const r = await c.install(sim.udid, app)
    if (!r.ok) throw new Error(r.reason)
    changed.push(`installed ${path.basename(app)}`)
  }
  if (bundle) {
    simAllowed('launch', sim, ['ready'])
    const r = await c.launch(sim.udid, bundle)
    if (!r.ok) throw new Error(r.reason)
    changed.push(`launched ${bundle}`)
  }
  let bar = null
  if (args.status_bar !== false) {
    bar = await simDressed(sim, true)
    if (bar && bar.said) changed.push(`set the status bar: ${bar.said}`)
    if (bar && bar.failed) changed.push(`left the status bar alone: ${bar.failed}`)
  }
  if (args.appearance) {
    simAllowed('ui appearance', sim, ['ready'])
    // Read, written to disk, then set (ui/simctl.js dressAppearance). On disk and not in
    // this process's memory, because a crash loses the memory and the device stays dark:
    // an override nobody can see is wrong is the one that most needs to survive.
    const r = await c.dressAppearance(sim.udid, args.appearance)
    if (!r.ok) throw new Error(r.reason)
    changed.push(`switched it to ${r.value.appearance}${r.value.was ? `, from ${r.value.was}` : ''}`)
  }

  // Simulator takes a moment to put the window up, and a device with no window is a
  // device Fetch cannot record, so this is worth waiting for rather than reporting.
  const settled = await simSettled(sim.udid, sim.window ? 0 : 25000)
  // One picture of the window, which answers two questions at once: where the glass sits
  // inside the frame, and what is on it. Both were calls an agent had to make for itself,
  // and the first of them is the number every tap and every crop is wrong without.
  const since = Date.now()
  const now = await simMeasured(settled || sim)
  const screen = await simScreen(now, { since })
  if (screen) changed.push('measured where the screen sits inside the window, and named what is on it')
  return {
    ...simFacts(now || sim, bar),
    changed,
    ...(screen ? { screen } : {}),
    restore: 'record_stop puts the status bar back on its own. simulator with action restore does it by hand, ' +
      'and so does the next launch if Fetch dies mid take.',
    do_next: `record_start { simulator: '${sim.udid}' } ${Opts.READY_NEXT_SAID}, ` +
      'and simulator with action tap taps an element id off screen above, which hands back the next screen ' +
      'the same way.',
  }
}

// The bundle id a built .app declares. Read only, and null when there is none to read,
// so an app with no readable plist is still installed and simply not launched.
async function bundleIdOf(app) {
  const out = await readQuiet('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', path.join(app, 'Info.plist')])
  const id = out && out.trim()
  return id && LOOKS.bundle(id) ? id : null
}

// The device again once whatever was asked for has settled, waiting for a window where
// one is expected. The model is re-read rather than patched: the window id, the glass
// rectangle and the density are all measurements, and a guess at any of them lands a tap
// somewhere nobody pointed.
async function simSettled(udid, waitMs) {
  const until = Date.now() + Math.max(0, waitMs || 0)
  for (;;) {
    let sims = null
    try { sims = await simModel() } catch { return null }
    const hit = sims.find(s => s.udid === udid) || null
    if (!hit || hit.window || Date.now() >= until) return hit
    await new Promise(r => setTimeout(r, 1000))
  }
}

// A deep link, which is the one navigation primitive simctl does hand us and the
// reliable one: it lands on the same screen every time, where a tap script does not.
async function simGo(sim, args, ctx) {
  const url = String(args.url || '').trim()
  if (!url) throw new Error('go needs url: the deep link to open on the device, for example myapp://onboarding.')
  await simAsk('openurl', sim, ctx, {
    wants: 'wants to open a link on', detail: `The link is ${url}. It opens on the device, not on your Mac. ` +
      'Fetch takes one picture of the window afterwards, to see where it landed.',
    allow: 'Open it', session: `Allow links on ${sim.name}`,
  })
  simAllowed('openurl', sim, ['openurl'])
  const r = await simctl().openurl(sim.udid, url)
  if (!r.ok) throw new Error(r.reason)
  // Where it landed, read rather than asked about. A link changes the screen, and the
  // call that changed it is the one already holding a picture of it.
  await new Promise(res => setTimeout(res, SCREEN_SETTLE_MS))
  const since = Date.now()
  await readGlass(sim.window, null, sim.screen)
  const screen = await simScreen(sim, { since })
  return { udid: sim.udid, device: sim.name, opened: url,
    ...(screen ? { screen } : {}),
    do_next: screen
      ? 'simulator with action tap takes an element id off screen above.'
      : 'take_shot with simulator to see where it landed, then find_on_screen to name what is on it.' }
}

/**
 * A touch, and the mark of it, in one call.
 *
 * The aim is an element id from find_on_screen, never a coordinate: pixels always exist
 * where a label may not, and a point read off a picture lands on the wrong thing. A raw
 * point in device points is taken where nothing can be named and comes back marked hand
 * aimed, the same way a hand aimed zoom does.
 */
async function simTap(sim, args, ctx) {
  // The person's yes first, because aiming this tap takes a picture of their screen and
  // a capture belongs inside the yes rather than in front of it.
  await simAsk('tap', sim, ctx, {
    wants: 'wants to send a tap to', detail: 'The touch goes into the device\'s own input path. It never moves this ' +
      'Mac\'s mouse and never presses its keyboard. Fetch takes a picture of that window just before the ' +
      'touch to aim by, and another afterwards, to see what the tap did.',
    allow: 'Allow this tap', session: `Allow taps on ${sim.name}`, sessionFirst: true,
  })
  // Aimed through a measured rectangle or not at all. Where nothing has measured this
  // window yet, one picture of it measures it here: a tap is the call that most needs
  // the number, and the fit it used to fall back on put the finger 80 points above the
  // button near the top of the screen.
  if (!sim.viewport) sim = await simMeasured(sim)
  // Aimed on a picture taken now, after the yes, and never on the list the agent holds
  const aimed = await aimFresh(sim, args)
  // A whole number of points, because both tools that send a touch take integers and one
  // refuses a float outright ("invalid int value: '218.6'"), which killed every tap aimed
  // at an element, since an element's middle is almost never whole. Rounded here, once,
  // so the touch that is sent and the disc that is drawn are the same number.
  const pt = { ...aimed, x: Math.round(aimed.x), y: Math.round(aimed.y) }
  simAllowed('tap', sim, ['tap'])
  const r = await simctl().tap(sim.udid, pt.x, pt.y)
  if (!r.ok) throw new Error(r.reason)
  // Reported onto the pointer track in the same call, on the take's own clock, so the
  // disc is drawn where the finger went and nothing has to be aimed twice. Only a touch
  // that was really sent is drawn: a mark for a tap that never happened is a lie in the
  // one part of the picture that says what the agent did.
  const f = Sim.pointToFrame(sim, pt.x, pt.y)
  let drawn = null, note = null
  if (f && deps.pointer) {
    try { drawn = deps.pointer({ x: f.x, y: f.y, click: true }) }
    catch (e) { note = `the tap was sent and nothing drew it: ${e.message}` }
  }
  // What the tap did, off one picture taken after the screen settles. This is the
  // take_shot and the find_on_screen an agent used to spend per tap, and the ids on it
  // are what the next tap takes.
  await new Promise(res => setTimeout(res, SCREEN_SETTLE_MS))
  const since = Date.now()
  await readGlass(sim.window, null, sim.screen)
  const screen = await simScreen(sim, { since })
  return {
    udid: sim.udid, device: sim.name,
    tapped: { x: pt.x, y: pt.y, units: 'device points' }, aimed: pt.aimed, by: r.value.by,
    ...(drawn ? { drawn: { x: drawn.x, y: drawn.y, at: drawn.at, points: drawn.points } } : {}),
    ...(note ? { note } : {}),
    ...(screen ? { screen } : {}),
    do_next: screen
      ? (screen.kept_ids != null
        ? 'the next tap takes an element id off screen above. An id from an earlier screen of this device still ' +
          'works where that control is still there, and is refused where it is not.'
        : 'the next tap takes an element id off screen above. The ids are minted on that picture, so use the ' +
          'newest ones and never an id from an earlier call.')
      : 'take_shot the device and call find_on_screen on it before the next tap: the screen has moved and the ' +
        'ids on it have not been read.',
  }
}

// How long a screen is given to answer a tap before it is read. A press, a transition
// and a settle: the same 1.2 s ui/fit.js keeps after a tap for the same reason.
const SCREEN_SETTLE_MS = 1200

// Where on the glass, in the device's own points. Everything in between is the take's:
// the element's box is measured in the frame the edit works in, so the crop goes back on
// before the viewport comes off.
async function simPoint(sim, args, o = {}) {
  if (!sim.screen || !sim.viewport) {
    const why = glassWhyNot.get(glassKey(sim.window))
    throw new Error(`Fetch cannot tell where ${sim.name}'s own screen sits inside its window, so there is ` +
      'nowhere for a tap to land. That rectangle is measured off a picture of the window, never worked out ' +
      `from its shape.${why ? ' The last measurement found nothing: ' + why : ''} ` +
      'take_shot with simulator measures it, simulator with action ready measures it, and simulator with ' +
      'action list says what is known about the device.')
  }
  const pts = sim.glass || sim.screen.points
  if (args.element != null) {
    const id = String(args.element).trim().toUpperCase()
    // The picture the id was minted on (tapSource, which refuses what cannot be told),
    // unless simTap already worked it out before it looked at the device again.
    const on = o.from || tapSource(sim, args).on
    const seenHere = simSeen.get(sim.udid) || null
    // The device shows its newest screen, so that is where the finger lands and the only
    // list a tap is ever aimed on. simTap reads it just before the touch.
    const aimOn = seenHere || on
    const here = foundBy.get(aimOn) || null
    if (seenHere && !holds(here, id)) {
      // one the device's run handed out and took back is said to be dead, in the guard's words
      const v = here && here.ledger ? here.ledger.check(id, here.all, { frame: here.frame, act: 'tap' }) : null
      if (v && !v.ok && v.reason === 'spent') throw new Error(v.say)
      throw new Error(`${id} is not on ${sim.name}'s newest screen. Ids carry from screen to screen on one device, ` +
        'so that control has gone from the device, or Fetch could not be sure it is the same one. The device ' +
        'shows its newest screen, so a tap is only ever aimed there: pick an id off the newest screen, or call ' +
        'find_on_screen on it in the person\'s own words.')
    }
    // the guard on the list the finger lands on, and the box of the element it judged
    const box = resolveElement(aimOn, here, null, null, { element: args.element }, { act: 'tap' }).box
    // An id minted on a picture outside the device's run (a still it was carried on from)
    // is held to what it named there too: the run's own ledger never saw it minted.
    const there = aimOn !== on ? foundBy.get(on) : null
    if (there && there.ledger && here && there.ledger !== here.ledger) {
      guardCheck({ ledger: there.ledger, all: here.all, frame: here.frame }, id, 'tap')
    }
    // A scratch frame has no document and no crop: its boxes are the whole frame already.
    const crop = seenHere === aimOn ? null : await cropOfTake(aimOn)
    const fx = crop ? crop.x + crop.w * (box.x + box.w / 2) : box.x + box.w / 2
    const fy = crop ? crop.y + crop.h * (box.y + box.h / 2) : box.y + box.h / 2
    return { ...devicePoint(sim, fx, fy), aimed: `the middle of ${id}` }
  }
  const x = +args.x, y = +args.y
  if (Number.isFinite(x) && Number.isFinite(y)) {
    if (x < 0 || y < 0 || x > pts.w || y > pts.h) {
      throw new Error(`${sim.name}'s screen is ${pts.w} by ${pts.h} points and (${x}, ${y}) is off it.`)
    }
    return { x, y, aimed: 'hand aimed: a point, not a box anything on screen was found at' }
  }
  throw new Error('a tap aims at a box, never at a coordinate: call find_on_screen on a shot of the device ' +
    'in the person\'s own words and send the id it hands back as element, with that shot\'s path. ' +
    'x and y in device points are taken where nothing on screen can be named, and are reported as hand aimed.')
}

/**
 * Which picture a tap's element id was minted on, worked out before anything is taken:
 * { on, id }, or the refusal that says why that cannot be told.
 *
 * With no path, the device's newest screen, while it is also the newest thing
 * find_on_screen named (or the last search was on a picture in the same run). A path in
 * the device's run is aimed on the newest screen. A path outside the run (a still, a
 * recording) only while the device has not handed back a screen of its own: the order
 * lists were searched in says nothing about when their pictures were taken, and a still
 * searched after a tap is still a picture from before it.
 */
function tapSource(sim, args) {
  const seenHere = simSeen.get(sim.udid) || null
  const id = String(args.element).trim().toUpperCase()
  // The last search was on another picture of this same device, in the same run of
  // ids: an id off it is the same control on the newest screen, or is not there.
  const inRun = !!seenHere && !!lastFoundOn && lastFoundOn !== seenHere &&
    chainOf.get(lastFoundOn) === sim.udid && chainOf.get(seenHere) === sim.udid
  const older = !!args.path && !!seenHere && args.path !== seenHere &&
    chainOf.get(args.path) === sim.udid && chainOf.get(seenHere) === sim.udid
  const on = older ? seenHere : args.path || (seenHere && (seenHere === lastFoundOn || inRun) ? seenHere : null)
  if (!on && seenHere) {
    throw new Error('a tap on an element needs path here: find_on_screen has named another picture since ' +
      `${sim.name}'s last screen, and an id off that picture can name something else on this one, so ${id} ` +
      'without a path could be a different thing. Send the path the id was minted on.')
  }
  if (!on) {
    throw new Error('a tap on an element needs path as well: the shot or recording find_on_screen was ' +
      'called on, which is where that id was minted. simulator with action ready hands back the screen ' +
      'and the ids on it, and so does every tap.')
  }
  if (on !== seenHere && seenHere && chainOf.get(on) !== sim.udid) {
    throw new Error(`${id} was minted on a picture that is not one of ${sim.name}'s own screens since its last ` +
      'ready or tap, and may be older than the screen it shows now, so what it names may not be under the finger ' +
      'and Fetch did not tap it. Use an id off the screen the last ready or tap handed back, or call simulator ' +
      'with action ready for a new one.')
  }
  return { on, id }
}

/**
 * Aim a tap on what the device shows at the moment of the touch. The id's list is
 * chosen first (tapSource), then the device is read once more, after the person's yes
 * and just before the touch, and the id is judged on that picture. The list the agent
 * holds can be a whole Allow dialog old, or off a tap whose picture failed, and in that
 * time a sync can push every row down one. A device that cannot be read now is not tapped
 * by id. `look` reads the device (lookNow); test/tools.test.js hands in its own.
 */
async function aimFresh(sim, args, look = lookNow) {
  if (args.element == null) return simPoint(sim, args)
  const { on, id } = tapSource(sim, args)
  const fresh = await look(sim, on)
  if (!fresh) {
    throw new Error(`Fetch could not read ${sim.name}'s screen just before the tap, so it cannot tell that ${id} ` +
      'still names what it did, and did not tap it. Call simulator with action ready, or take_shot with ' +
      'simulator and find_on_screen, and use an id off that.')
  }
  return simPoint(sim, args, { from: on })
}

// One picture of the device now, named on from the list the id came from: the device's
// run, or a still of it that no run has taken on yet.
async function lookNow(sim, on) {
  const since = Date.now()
  await readGlass(sim.window, null, sim.screen)
  const from = foundBy.get(on)
  const prior = chainOf.get(on) === sim.udid || !from ? null : from.all
  return simScreen(sim, { since, limit: 24, ...(prior ? { prior } : {}) })
}

function devicePoint(sim, fx, fy) {
  // The points the device is showing, which on a device lying on its side are the
  // framebuffer's axes swapped (ui/simulator.js glassPoints).
  const v = sim.viewport, pts = sim.glass || sim.screen.points
  const x = ((fx - v.x) / v.w) * pts.w, y = ((fy - v.y) / v.h) * pts.h
  if (!(x >= -1 && y >= -1 && x <= pts.w + 1 && y <= pts.h + 1)) {
    throw new Error(`that element is at (${Math.round(x)}, ${Math.round(y)}) in device points, off a ` +
      `${pts.w} by ${pts.h} point screen: it is on the Mac's part of the window rather than on the glass.`)
  }
  const hold = (n, max) => Math.round(Math.min(Math.max(n, 0), max) * 10) / 10
  return { x: hold(x, pts.w), y: hold(y, pts.h) }
}

// The crop an element's box was measured inside, which is the one the edit works in.
async function cropOfTake(src) {
  try {
    if (isShot(src)) { const s = await shotOf(src); return (s && s.crop) || null }
    const meta = await deps.proc.probeMeta(src).catch(() => ({}))
    return deps.proc.readDoc(src, meta && meta.duration).crop || null
  } catch { return null }
}

// ── the status bar, which Fetch sets and Fetch puts back ─────────────────

/**
 * Dress the device for the picture. Free while Fetch is the thing capturing it, and only
 * because the old values are written down first and go back afterwards: take the restore
 * away and this is an ordinary edit to somebody's machine.
 */
async function simDressed(sim, forReady) {
  simAllowed('status bar override', sim, forReady ? ['ready'] : null,
    forReady ? {} : { capturing: true, restores: true })
  const r = await simctl().setStatusBar(sim.udid)
  // A bar Fetch could not set is a worse picture, not a failed take. The refusal is
  // reported and the capture goes on.
  if (!r.ok) return { failed: r.reason }
  dressed.add(sim.udid)
  return { said: r.value.said, restores: r.value.restores }
}

// Put it back. On stop, on failure, and on the next launch if Fetch died mid take
// (ui/simctl.js restorePending, called from main.js). Restoring is never refused, even
// on a device that has since gone onto the never list: a simulator stuck at 9:41 is
// Fetch's mess and not the person's.
async function simUndress(udid) {
  if (!udid || !dressed.has(udid)) return null
  dressed.delete(udid)
  // restoreStatusBar puts the appearance back too where `ready` set one: everything in
  // the stash comes off together, so record_stop keeps the promise the tool description
  // makes rather than half of it.
  let back = null
  try {
    const r = await simctl().restoreStatusBar(udid)
    back = r.ok ? r.value : { failed: r.reason }
  } catch (e) { back = { failed: String((e && e.message) || e) } }
  return back
}

/**
 * The end of any take an agent started: what the file actually has, said here.
 *
 * record_start could only report what was wired, because at that moment there was no
 * file. This is the one place that knows, and an agent should not have to learn that a
 * take is silent from transcribe refusing it. A job directed before the take existed is
 * also moved onto it here, since this is where the take starts existing.
 */
async function afterTake(r) {
  const heard = takeHeard
  takeHeard = null
  // Probed once and handed down, since simAfterTake wants the same header.
  let meta = null
  const src = r && r.path ? follow(r.path) : null
  try {
    if (src && fs.existsSync(src)) meta = await deps.proc.probeMeta(src).catch(() => null)
  } catch {}
  const out = await simAfterTake(r, meta)
  // A brief written before record_start was waiting for this file to exist.
  let job = null
  try {
    if (src && fs.existsSync(src)) {
      job = require('./director').attach(src, app ? app.getPath('userData') : require('os').tmpdir())
    }
  } catch {}
  // A take the person started has no plan of its own to judge against, so it keeps the
  // shape it always had.
  // How loud the track is, measured once, because a track at the floor and a wired
  // sound that failed both come back from transcribe as no speech: the judged take was
  // -91 dB with a track on it. Bounded, since this is a stop and not an export.
  let level = {}
  if (heard && meta && meta.hasAudio && deps.proc && deps.proc.clipLevels) {
    try {
      const lv = await Promise.race([deps.proc.clipLevels(src, null),
        new Promise(res => setTimeout(() => res(null), 15000))])
      const t = lv && lv.take
      if (t) level = t.lufs == null ? { floor: true } : { meanDb: t.lufs }
    } catch {}
  }
  // A take record_stop has just called silent is silent to review too, or review offers
  // transcribe on the take this result told the agent to narrate over instead.
  const atFloor = level.floor === true || (typeof level.meanDb === 'number' && level.meanDb <= Opts.SILENT_DB)
  if (src && atFloor) heardSilent.add(src)
  // The recorder's own account of the take: where each track's sound sits, and whose
  // sound the system track is (soundScope, on the track itself). Handed to takeAudio so
  // the result says one app's sound or the whole Mac's off what the recorder did, not
  // off what was hoped for. A recorder that said nothing gets nothing claimed.
  const sound = (r && r.sound) || (deps.takeSound ? deps.takeSound() : null)
  let audio = heard && meta ? Opts.takeAudio(heard, meta, { ...level, sound }) : null
  if (audio && audio.track) {
    const sync = soundSync(await withAudioEnd(src, meta), sound)
    if (sync) audio = { ...audio, sync }
  }
  // an agent's take of a project goes into that project's Library folder
  const filing = takeProject
  takeProject = null
  const library = filing && src ? await fileInFolder(src, filing.folder).catch(() => null) : null
  return { ...out,
    ...(audio ? { audio } : {}),
    ...(library ? { library } : {}),
    ...(job ? { job: 'the brief you wrote before the take is now the job on it, and the steps that made the ' +
      'take are closed', plan: job.plan } : {}) }
}

// Where a take's sound sits against its picture, said from two measurements: what the
// recorder reports about its own capture (leadMs, gaps, lostMs per track, when this
// build's recorder wrote the file) and where the file's first sound frame really is
// (processor.js probeAudioLead). The judged simulator take's sound started 2.3 s after
// its picture and every result called it a track and nothing more, so a narrator would
// have been 2.3 s early with nothing anywhere saying so. Said in numbers, and only what
// was measured: a take with no sound, or a header nobody read, gets nothing.
const LEAD_SAID = 0.001        // processor.js LEAD_MIN: under this the graphs are unchanged
// How short a sound may end against its picture before it is called drift: two frames,
// and never under the 50 ms a recorder of the time lost to the stream closing at Stop
const shortSaid = fps => Math.max(0.05, 2 / (+fps > 0 ? +fps : 30))
// A track whose last buffer came in this long before Stop stopped arriving mid take. The
// buffers in flight at a clean Stop are tens of milliseconds (53 ms on the take that
// checked the replayd fix). The recorder fills the rest with silence so the file keeps
// its length, which is why nothing else here would notice: the end lands with the
// picture. Since that fix, a window take's sound stream that stops with an error is let
// go and not reopened (Recorder.swift stream(_:didStopWithError:)), so this is the one
// place that says a take went quiet part way.
const TAIL_SAID_MS = 500
// The header with where its sound ends, read only where a sync is said (a stream copy,
// no decode). A copy, since probeMeta's answer is shared.
async function withAudioEnd(src, meta) {
  if (!meta || !meta.hasAudio || !src || !deps.proc || !deps.proc.probeAudioEnd) return meta
  const audioEnd = await deps.proc.probeAudioEnd(src).catch(() => null)
  return audioEnd == null ? meta : { ...meta, audioEnd }
}
function soundSync(meta, sound) {
  if (!meta || !meta.hasAudio) return null
  const lead = +meta.audioLead
  // Where the sound ends against where the picture does. A lead is put back on every
  // export; sound lost inside the file is not, and shows as a track that ends early.
  const end = meta.audioEnd == null ? NaN : +meta.audioEnd
  const pic = +meta.duration
  const short = Number.isFinite(end) && pic > 0 ? pic - end : NaN
  const drift = short > shortSaid(meta.fps)
  const tracks = Array.isArray(sound) ? sound.filter(t => t && typeof t === 'object') : []
  const sum = k => tracks.reduce((a, t) => a + (+t[k] > 0 ? +t[k] : 0), 0)
  const startMs = Math.max(0, ...tracks.map(t => +t.leadMs || 0))
  const gaps = sum('gaps'), gapMs = sum('gapMs'), lostMs = sum('lostMs')
  if (!Number.isFinite(lead) && !tracks.length) return null
  const said = []
  if (Number.isFinite(lead) && lead > LEAD_SAID) {
    said.push(`the sound in this file starts ${lead.toFixed(3)} s after its picture. Every export, transcript and ` +
      `waveform Fetch makes puts that start back at its own time; a tool that reads the track from its first sample ` +
      `would hear it ${lead.toFixed(2)} s early`)
  }
  if (drift) {
    said.push(`the sound ends ${short.toFixed(2)} s before the picture does, so sound was lost inside the file while ` +
      `it was recorded. With the start put back, it drifts ahead of the picture through the take, up to ` +
      `${short.toFixed(2)} s early by the end, and nothing Fetch writes can put that back. For narration that has to ` +
      'match the screen, record the take again with this version of Fetch, or write the narration with voiceover')
  }
  if (startMs > 0) {
    said.push(`the sound capture started ${Math.round(startMs)} ms after the first frame, and that stretch is silence ` +
      'in the file, so the track starts with the picture')
  }
  if (gaps > 0) {
    said.push(`${gaps} stretch${gaps === 1 ? '' : 'es'} (${Math.round(gapMs)} ms) where the capture sent no sound ` +
      'are silence in place, so what follows stays on the picture\'s clock')
  }
  if (lostMs > 0) {
    said.push(`${Math.round(lostMs)} ms of sound was let go when the file fell behind; silence stands in its place, ` +
      'so sync holds and that sound is gone')
  }
  const cut = tracks.filter(t => +t.tailMs > TAIL_SAID_MS)
  for (const t of cut) {
    said.push(`the ${t.track === 'mic' ? 'microphone' : 'system sound'} stopped arriving ${(+t.tailMs / 1000).toFixed(2)} s ` +
      'before the take was stopped, and silence fills the file from there to the end. Sync holds, and anything ' +
      'that played in that stretch is not in the file')
  }
  const quietMs = cut.length ? Math.round(Math.max(...cut.map(t => +t.tailMs))) : 0
  const measured = Number.isFinite(short)
  return {
    // true only when the end was measured and lands with the picture; unmeasured is not in sync
    in_sync: measured ? !drift : null,
    ...(Number.isFinite(lead) ? { starts_s: +lead.toFixed(3) } : {}),
    ...(measured ? { ends_early_s: +Math.max(0, short).toFixed(3) } : {}),
    ...(tracks.length ? { filled_ms: Math.round(startMs + gapMs), ...(lostMs > 0 ? { lost_ms: Math.round(lostMs) } : {}) } : {}),
    ...(quietMs ? { silent_end_ms: quietMs } : {}),
    said: said.length ? said.map(x => x[0].toUpperCase() + x.slice(1)).join('. ') + '.'
      : measured ? 'the sound starts with the picture and ends with it, measured on this file.'
        : 'the sound starts with the picture, measured on this file. Where it ends was not measured.',
  }
}

// The end of a take of a device: the glass rectangle onto the document, and everything
// Fetch changed put back. Both happen whatever the take did.
async function simAfterTake(r, known) {
  const held = takeSim
  takeSim = null
  if (!held) return r
  const back = await simUndress(held.sim.udid)
  // The newest rectangle that passed for this window, not the one record_start happened
  // to get: a take started on a dark launch screen measures nothing, and the taps after
  // it that did measure are what the crop and the disc should stand on. Same window at
  // the same size only, since a resized window is a different rectangle.
  let sim = held.sim
  try {
    const sims = await simModel()
    const hit = sims.find(x => x.udid === sim.udid)
    if (hit && hit.viewport && glassKey(hit.window) === glassKey(sim.window)) sim = hit
  } catch {}
  let wrote = null
  try {
    // through follow(), because a take is renamed from what was said shortly after it
    // lands and the path this call is holding may already have moved
    const src = r && r.path ? follow(r.path) : null
    if (src && fs.existsSync(src)) {
      const meta = known || await deps.proc.probeMeta(src).catch(() => ({}))
      const doc = deps.proc.readDoc(src, meta && meta.duration)
      // A finger, not an arrow, without anybody setting anything: the look decides the
      // mark and the take's target decides the look. Inert until ui/look-schema.js
      // carries cursor.style, because Look.merge keeps only what the schema names.
      const look = { ...(doc.look || {}), cursor: { ...((doc.look || {}).cursor || {}), style: 'touch' } }
      const out = deps.proc.writeDoc(src, { ...doc, look, ...simOnDoc(sim) })
      // Said by what was written. A take with nothing measured has no rectangle on it,
      // and saying the crop removes the Mac window there is the sentence the judge caught.
      wrote = sim.viewport
        ? 'the device screen rectangle is on the edit, so the look crops to the glass and the ' +
          'drawn phone is the only phone in the picture'
        : 'no device screen rectangle was measured for this take, so the edit has none: the Simulator\'s ' +
          'toolbar and outline stay in the picture and a drawn phone is a plain frame. crop can take them off by hand'
      if (out && out.look && out.look.cursor && out.look.cursor.style === 'touch') {
        wrote += ', and the pointer track draws a finger rather than an arrow'
      }
    }
  } catch (e) { wrote = `the device could not be written onto the edit: ${(e && e.message) || e}` }
  return { ...r, simulator: { ...simFacts(sim, held.bar),
    ...(back ? { restored: back } : {}), ...(wrote ? { document: wrote } : {}) } }
}

// Everything Fetch changed on a device, put back by hand. The appearance is only known
// within this run of the app; the status bar survives a crash because it is stashed on
// disk where a person can see the clock is wrong.
async function simRestore(sim) {
  simAllowed('restore', sim, null)
  const out = []
  // One call, because one stash holds everything Fetch is wearing on this device: the
  // status bar and, where `ready` set one, the appearance. Putting back a value Fetch
  // set is the free action rather than a second mutation of their device, which is why
  // this is allowed even on a device that has since gone onto the never list.
  const back = await simctl().restoreStatusBar(sim.udid)
  out.push(back.ok ? (back.value.said || `the status bar: ${back.value.restored}`) : `the status bar could not be put back: ${back.reason}`)
  if (back.ok) for (const line of back.value.also || []) out.push(line)
  dressed.delete(sim.udid)
  return { udid: sim.udid, device: sim.name, restored: out,
    note: 'Fetch never changed anything else on this device: it does not create, erase or delete one.' }
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
  const swap = (list, key) => !Array.isArray(list) ? list : list.map(it => {
    const aimed = it && it.element ? resolveElement(src, seen, mine, crop, it, { past: true, act: actOf(key, it) }) : it
    if (aimed && (aimed.kind === 'lift' || aimed.kind === 'loupe' || aimed.kind === 'arrow')) {
      // a new lift, loupe or arrow with nothing but times raises nothing, magnifies
      // nothing and points at nothing, so say what to send. One that names an existing mark keeps that
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
  // A pinned label or a callout names a thing on the page, not a place on the canvas,
  // so it aims the way a mark aims: element: 'E12' from find_on_screen becomes the point
  // at that element's middle, which is what the text pass pins to. One rule for aiming
  // and not two, and the same refusal when the id is not one the agent was handed.
  const r4 = n => Math.round(n * 10000) / 10000
  const pin = list => !Array.isArray(list) ? list : list.map(it => {
    if (!it || !it.element) return it
    const { box, ...rest } = resolveElement(src, seen, mine, crop, it, { past: true, act: actOf('texts', it) })
    return box ? { ...rest, at: { x: r4(box.x + box.w / 2), y: r4(box.y + box.h / 2) } } : rest
  })
  return { ...doc, ...(doc.zooms ? { zooms: swap(doc.zooms, 'zooms') } : {}), ...(doc.marks ? { marks: swap(doc.marks, 'marks') } : {}),
    ...(doc.texts ? { texts: pin(doc.texts) } : {}) }
}

// One id, one box. R ids come from the lasso, E ids from an Elements pass, and neither
// map can shadow the other. The agent's own find_on_screen is read before a pass Fetch
// ran for itself, so a background pass never takes an E id away from it.
// Only on a list that carried ids on from an earlier one: there an id the agent was shown
// before can be on this frame without being among the ones shown now. On a list minted
// fresh, the ids it did not show are ones nobody has seen, and a typo should not land.
const boxInList = (found, id) => {
  const all = found && Array.isArray(found.all) && found.all.carried > 0 ? found.all : null
  const e = all ? all.find(x => x && x.id === id) : null
  return e ? e.box : null
}
const holds = (found, id) => !!(found && (found.boxes.has(id) || boxInList(found, id)))

function resolveElement(src, seen, mine, crop, it, o = {}) {
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
  // An id from an earlier screen can be carried onto this one without being among the
  // ones this pass showed, so the whole list is read too: same pass, same frame. On a
  // recording (o.past) an id from an earlier search of another moment is looked up on
  // the list it was minted on, however many searches ago that was (idHome keeps every
  // one): ids on one recording are never handed out twice, so an id off any of its lists
  // names one element. A tap never looks back: the device shows its newest screen, and
  // simPoint has already chosen the list that is.
  //
  // Fetch's own passes (a zoom's aim, the rules' read, the lasso) number from E1 each
  // time, so their E4 is not the agent's E4. An id the agent's own run ever handed out,
  // live or spent, is only ever looked up in the agent's lists, and one that is not
  // there any more is refused rather than found in Fetch's.
  const theirs = !!(seen && seen.ledger && seen.ledger.knows(id))
  const inList = r => !!(r && (r.boxes.has(id) || boxInList(r, id)))
  const home = o.past ? ((idHome.get(src) || new Map()).get(id) || null) : null
  const rec = inList(seen) ? seen : inList(home) ? home : !theirs && inList(mine) ? mine : null
  if (!rec) {
    // an id this run handed out and has since taken back is said to be dead, in the
    // guard's own words, rather than as a typo
    const v = seen && seen.ledger ? seen.ledger.check(id, seen.all, { frame: seen.frame, act: o.act }) : null
    if (v && !v.ok && v.reason !== 'unknown') throw new Error(v.say)
    const at = seen || mine
    throw new Error(`${element} is not in the last find_on_screen result for this recording` +
      (at ? ` (at ${at.at} s)` : '') + '. Call find_on_screen again and name one it lists, or send its box.')
  }
  // The moment. A list names what was on screen at the moment it was read, and a
  // recording moves: the recipe at y 0.27 at 2 s is another recipe at 8 s. An id aimed
  // at a span it was not read inside (give or take a second) would land on whatever sits
  // in its old place then, so it is refused with the moment to read instead.
  if (o.past) atMoment(src, rec, id, rest, o.act)
  // The guard, at the moment of acting: the element this list gives the id is held to
  // what the id was minted for, and anything that does not match, or cannot be told, is
  // refused. The box handed back is the judged element's own, never a lookup in some
  // other list. There is no way to a box that does not come through here
  // (test/tools.test.js).
  const el = guardCheck(rec, id, o.act)
  return { ...rest, box: el.box }
}

// How far either side of a zoom or mark's span the list its id came from may have been
// read, in seconds: the same second a search of "that moment" is allowed to miss by.
const MOMENT_SLACK = 1
function atMoment(src, rec, id, it, act) {
  if (isShot(src)) return
  const at = +rec.at, a = +it.start, b = +it.end
  if (!Number.isFinite(at) || !Number.isFinite(a) || !Number.isFinite(b)) return
  if (at >= a - MOMENT_SLACK && at <= b + MOMENT_SLACK) return
  const mid = Math.round((a + (b > a ? (b - a) / 2 : 0)) * 10) / 10
  throw new Error(`${id} was read off the frame at ${at} s, and this runs from ${a} to ${b} s. What sits in its ` +
    `place then was never read, and a recording moves, so Fetch did not ${act || 'act on'} it. Call ` +
    `find_on_screen at that moment (at: ${mid}) and use the id it hands back.`)
}

// ── every id an action uses goes through the guard ─────────────────────────
// ui/targets.js carryIds guesses which element on a new picture is the one an old id
// named, and a guess always has another case. It is no longer what keeps the promise an
// id makes (the same element, or nothing). Every list an agent or Fetch is handed is
// recorded in a ledger (ui/guard.js) as it is minted, which writes down what each id is
// and gives a new id to anything the matcher handed an old one it does not match; and
// every action that turns an id into a box (a tap, a zoom, every kind of mark, a pinned
// label or callout) calls guardCheck here as it acts. A matcher mistake then costs the
// agent one find_on_screen, never the wrong row.
//
// One ledger per run of ids: a device's screens ('sim:' + udid), one recording or shot's
// own searches ('take:' + path), and the passes Fetch runs for itself on it ('fetch:' +
// path), which number from E1 each time and are kept apart from the agent's.
const ledgers = new Map()      // run key -> Guard.ledger()
const minted = new WeakSet()   // lists already held to their ledger
const idHome = new Map()       // path -> Map(id -> the newest agent list holding it), never evicted
const pathTop = new Map()      // path -> the highest id number handed out on it
let mintSeq = 0                // the order lists were minted in

function ledgerFor(key) {
  let L = ledgers.get(key)
  if (!L) ledgers.set(key, L = Guard.ledger())
  return L
}
function runKey(file, { agent = true, run = null } = {}) {
  if (!agent) return 'fetch:' + file
  const udid = run || chainOf.get(file) || null
  return udid ? 'sim:' + udid : 'take:' + file
}

/**
 * Hold a list to its ledger before anyone sees it. `fresh` starts the run over, for
 * Fetch's own passes, which are never handed a prior. Returns { list, reissued }.
 */
function mint(key, list, frame, { fresh = false } = {}) {
  if (!Array.isArray(list) || minted.has(list)) return { list, reissued: [] }
  const L = ledgerFor(key)
  if (fresh) L.reset()
  const r = L.record(list, frame && frame.width > 0 ? { frame } : {})
  minted.add(r.list)
  return r
}
// The same, as the hook processor.findOnScreen runs before it ranks and draws, so the
// numbers on the picture are the ids the agent is handed. What it renamed lands in `got`.
const guardHook = (key, got, o) => (list, frame) => {
  const r = mint(key, list, frame, o)
  got.push(...r.reissued)
  return r.list
}
function renamed(list, reissued) {
  if (!reissued.length || !Array.isArray(list)) return list
  const to = new Map(reissued.map(x => [x.from, x.to]))
  return list.map(e => {
    if (!e) return e
    const id = to.get(e.id), inn = e.in && to.get(e.in)
    return id || inn ? { ...e, ...(id ? { id } : {}), ...(inn ? { in: inn } : {}) } : e
  })
}
// A findOnScreen result held to its ledger, where the processor did not do it (a stand
// in, or an older build): its shown list renamed to match. Returns what was renamed.
function settle(r, key, o) {
  if (!r) return []
  const all = r.all || r.elements
  if (!Array.isArray(all) || minted.has(all)) return []
  const g = mint(key, all, { width: r.width, height: r.height }, o)
  r.elements = r.elements === all ? g.list : renamed(r.elements, g.reissued)
  if (r.all) r.all = g.list
  return g.reissued
}

/**
 * The check itself: the element `rec`'s list gives this id, held to what the id was
 * minted for. Returns the element, or throws the guard's sentence.
 */
function guardCheck(rec, id, act) {
  if (!rec || !rec.ledger) {
    throw new Error(`${id} came from a list Fetch never wrote down, so what it names cannot be told and ` +
      `Fetch did not ${act || 'act on'} it. Call find_on_screen again and use the id it hands back.`)
  }
  const v = rec.ledger.check(id, rec.all, { frame: rec.frame, act })
  if (!v.ok) throw new Error(v.say)
  return v.element
}

// An empty prior that only carries a count, so a fresh pass numbers on past it.
function countedFrom(top) {
  const c = []
  Object.defineProperty(c, 'seq', { value: top })
  Object.defineProperty(c, 'frame', { value: null })
  return c
}
// What the ledger took back on this pass, said to the agent holding the old ids.
function idsRetired(reissued) {
  return { ids: reissued.map(x => ({ was: x.from, now: x.to })),
    why: 'on this picture the matcher gave each old id to something that is not what it named before, so ' +
      'that element takes the new id and the old one names nothing now. An action sent with an old one is refused.' }
}

// How the sentence names what was not done, per kind of thing an id aims.
const MARK_ACT = { redact: 'redact', blur: 'blur', spotlight: 'spotlight', lift: 'lift', loupe: 'magnify',
  arrow: 'point an arrow at', highlight: 'highlight', outline: 'outline', step: 'put a step on' }
const actOf = (list, it) => list === 'zooms' ? 'zoom to'
  : list === 'texts' ? `pin ${it && it.kind === 'callout' ? 'a callout' : 'a label'} to`
    : MARK_ACT[it && it.kind] || `put a ${(it && it.kind) || 'mark'} on`

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
function liftNotes(elements, all, aspect) {
  const T = require('./targets')
  const out = new Map()
  for (const e of elements || []) {
    // text is in the list because a lift aimed at a bare line of words is the commonest
    // miss of all: once the card round it is refused the lift lands on its lower half and
    // the picture reads as a floating tooltip. Unjudged, nobody ever said so.
    if (!['card', 'grid', 'panel', 'text'].includes(e.kind)) continue
    const b = T.liftBlock(e, all || elements, aspect)
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
function noteFound(path, at, elements, all, { agent = true, aspect = 0, frame = null, run = null } = {}) {
  // Held to its ledger first, where the search did not already do it, so no list is ever
  // registered that an action could resolve an id in without the guard knowing the id.
  let list = all || elements || []
  if (!minted.has(list)) {
    const g = mint(runKey(path, { agent, run }), list, frame, { fresh: !agent })
    elements = elements === list ? g.list : renamed(elements, g.reissued)
    list = g.list
  }
  const notes = liftNotes(elements, list, aspect)
  const boxes = new Map((elements || []).map(e => [e.id, e.box]))
  // an element named only inside a refusal is still one the agent may aim at
  for (const b of notes.values()) {
    if (b.instead) boxes.set(b.instead.id, b.instead.box)
    if (b.around) boxes.set(b.around.id, b.around.box)
  }
  // the frame's own shape, kept so apply_edit judges a lift by the same ruler the search
  // did: a type-sized padding is square on the screen and not in fractions of the frame
  const ledger = ledgerFor(runKey(path, { agent, run }))
  const rec = { at, boxes, all: list, aspect, frame: frame && frame.width > 0 ? frame : (list.frame || null), ledger, seq: ++mintSeq }
  if (agent) {
    // every id stays reachable on the list it came in, for a zoom or mark aimed at the
    // moment it was read, however many searches later: ids on a path are never reused
    const homes = idHome.get(path) || new Map()
    for (const e of list) if (e && e.id) homes.set(e.id, rec)
    for (const b of notes.values()) for (const x of [b.instead, b.around]) if (x && x.id && !homes.has(x.id)) homes.set(x.id, rec)
    idHome.set(path, homes)
    const num = e => +String(e && e.id).slice(1) || 0
    pathTop.set(path, Math.max(pathTop.get(path) || 0, +list.seq || 0, ...list.map(num)))
  }
  ;(agent ? foundBy : foundFor).set(path, rec)
  // what was read off this moment, for the product's never-on-screen rules
  noteFrame(path, at, list, agent)
  // Which picture the agent last had ids minted on. Each picture numbers its own ids,
  // so a tap with no path may only fall back to the device's newest screen while that
  // screen is also the newest pass: after a find_on_screen on anything else, E5 is that
  // other picture's E5.
  if (agent) lastFoundOn = path
  return notes
}
let lastFoundOn = null

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
  // The two below both say the thing to lift is inside the refused element. For a line of
  // words it is the other way round: the thing to lift is the card around them.
  if (b.around) return `${b.why}; to lift it, lift ${name(b.around)}, the card the words sit in`
  if (b.instead && b.share >= 0.2) return `${b.why}; to lift it, lift ${name(b.instead)}, the part of it that can be raised`
  if (b.instead) return `${b.why}; only small pieces inside it can be lifted (such as ${name(b.instead)}): lift the one the person means, or point at the whole with a spotlight and say why`
  return `${b.why}; nothing inside it can be lifted either, so a spotlight is the way to point at it (say so if the person asked for a lift)`
}
// Every lift with a box is checked, including one being moved: the old guard let a
// lift dragged onto the frame's edge by a bare box through without a word.
// It only ever refuses, and never hands back a box to act on. From apply_edit it is
// handed a mark whose element resolveElement has already turned into a box, through the
// guard, so it matches by that box; an id is read only by a caller asking about a lift.
function liftable(seen, m) {
  if (!seen || !seen.all) return
  const T = require('./targets')
  const id = m.element ? String(m.element).trim().toUpperCase() : null
  const box = m.box && typeof m.box === 'object' ? T.cleanBox(m.box) : null
  const same = (a, b) => ['x', 'y', 'w', 'h'].every(k => Math.abs(a[k] - b[k]) < 0.004)
  const el = seen.all.find(e => id ? e.id === id : box && same(e.box, box))
  const b = el && ['card', 'grid', 'panel', 'text'].includes(el.kind) ? T.liftBlock(el, seen.all, seen.aspect) : null
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
    if (seen && seen.all && seen.all.length && Math.abs(seen.at - at) <= 0.75) return { list: seen.all, agent: m === foundBy }
  }
  if (!deps.proc || !deps.proc.findOnScreen) return null
  try {
    const key = runKey(src, { agent: false })
    const r = await deps.proc.findOnScreen(src, at, { crop: crop && crop.w > 0 ? crop : null, limit: 40,
      guard: guardHook(key, [], { fresh: true }) })
    settle(r, key, { fresh: true })
    // Fetch's own pass, so it does not renumber the E ids the agent is holding
    noteFound(src, r.at, r.elements, r.all, { agent: false,
      aspect: r.width > 0 && r.height > 0 ? r.width / r.height : 0, frame: { width: r.width, height: r.height } })
    return { list: r.all || r.elements, agent: false }
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
    let box = T.cleanBox(z.box), el = null, byId = false
    if (!box) {
      const x = num(z.x, old && old.x), y = num(z.y, old && old.y)
      // {start, end} alone still means 1.8x at the frame centre: nothing was aimed, so
      // there is nothing to correct
      if (x == null && y == null || !(end > start)) continue
      const aim = r2(start + Math.min(1, (end - start) / 3))
      const found = await elementsNear(src, aim, crop)
      el = found ? T.nearPoint({ x: x == null ? 0.5 : x, y: y == null ? 0.5 : y }, found.list) : null
      box = el ? T.cleanBox(el.box) : null
      if (!box) continue      // nothing under the point: the zoom stands, and handAimed says so
      z.box = box
      // The element it went on, by id only where the id is one the agent was handed. A
      // pass Fetch ran for itself numbers from E1, so its E4 is not the agent's E4, and
      // an id said here is one the agent will aim with. Otherwise its words and its box.
      byId = found.agent
      const entry = { id: z.id || null, ...(byId ? { element: el.id } : { on: el.text ? `"${el.text}"` : `a ${el.kind}` }),
        at: aim, from: { x, y, scale: num(z.scale, old && old.scale) }, to: null, box }
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
      const entry = { id: z.id || null, what: el ? (byId ? el.id : el.text ? `"${el.text}"` : `a ${el.kind}`) : 'its box', share }
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

// What a rate the agent sent is not. Fetchdoc clamps quietly, which is right for a
// document being read back, and wrong for a call being answered: an agent that asked
// for a freeze got normal speed and the only sign was a field missing from get_edit.
// So the clamp is said out loud here, once, naming the range and the clip.
function rateNotes(FD, sent) {
  const out = []
  for (const c of (sent && sent.clips) || []) {
    if (!c || c.rate == null) continue
    const ends = Array.isArray(c.rate) ? c.rate : [c.rate]
    const name = c.id ? `${c.id}'s` : 'a clip\'s'
    for (const v of ends) {
      const n = +v
      if (!Number.isFinite(n) || n <= 0) {
        out.push(`${name} rate ${JSON.stringify(v)} is not a speed, so that clip plays at 1. rate is source seconds ` +
          `per output second, ${FD.RATE_MIN} to ${FD.RATE_MAX}: 2 is twice speed, 0.5 is half. Fetch holds no frames, ` +
          'so there is no rate that freezes one; to hold a moment, ask the person whether a still is what they want.')
      } else if (n < FD.RATE_MIN || n > FD.RATE_MAX) {
        out.push(`${name} rate ${n} was held to ${Math.min(FD.RATE_MAX, Math.max(FD.RATE_MIN, n))}, which is the fastest ` +
          `and slowest Fetch plays: ${FD.RATE_MIN} to ${FD.RATE_MAX}. The finished length in this result is measured at what it runs at.`)
      }
    }
  }
  return out
}

// The same for a clip's own sound. A gain is clamped as quietly as a rate was, and one
// thing more is worth saying out loud: a piece running faster than 1 is silent by
// default, so a gain on it does nothing until the take's speedAudio is keep. That is
// the right default and the surprising one.
function gainNotes(FD, sent, doc) {
  const out = []
  const keeps = ((doc && doc.audio) || {}).speedAudio === 'keep'
  for (const c of (sent && sent.clips) || []) {
    const a = c && c.audio
    if (!a || typeof a !== 'object') continue
    const name = c.id ? `${c.id}'s` : 'a clip\'s'
    const n = +a.gain
    if (a.gain != null && Number.isFinite(n) && Math.abs(n) > FD.GAIN_DB) {
      out.push(`${name} gain ${n} dB was held to ${n < 0 ? -FD.GAIN_DB : FD.GAIN_DB}, which is as far as Fetch lifts or ` +
        'drops one clip. A passage further under the rest than that was recorded too quietly to rescue with a number: ' +
        'probe with loudness true measures every clip, and say so to the person rather than asking for more decibels.')
    }
    const fast = Math.max(...[].concat(c.rate == null ? [1] : c.rate).map(v => +v || 1))
    if (!keeps && fast > 1 && (a.gain != null || a.denoise != null) && !a.mute) {
      out.push(`${name} own sound is set and that clip runs at ${fast}, and a piece faster than 1 is silent unless ` +
        'audio.speedAudio is keep, so the gain and the denoise on it do nothing. Send audio: { speedAudio: \'keep\' } ' +
        'beside the clips if the person wants to hear that stretch.')
    }
  }
  return out
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
  // A shot and a take are the same editor and the same openInEditor. Which of the two
  // documents is open is the one thing the window answers differently, so the file
  // decides which accessor is asked and nothing else here changes.
  const src = `${docOf(path)} ? ${docOf(path)}.src() : null`
  const open = await win.webContents.executeJavaScript(src)
  if (open !== path) {
    await win.webContents.executeJavaScript(`openInEditor(${JSON.stringify(path)})`)
    // openInEditor is async and wires the document only once the clip has loaded
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 150))
      const now = await win.webContents.executeJavaScript(src)
      if (now === path) break
    }
  }
  return win.webContents.executeJavaScript(expr)
}

// ── versions ───────────────────────────────────────────────────────────────
const VERSION_DOES = ['list', 'look', 'restore']

// The rows, with the person's unsettled change written as their own version first, so
// the list is the edit as it stands and a restore never folds their last minute of work
// into somebody else's name.
async function versionRows(src) {
  const ready = `window.fetchHistory && window.fetchHistory.src() === ${JSON.stringify(src)} && window.fetchHistory.rows().length > 0`
  let ok = await inEditor(src, `!!(${ready})`)
  // the history opens just after the editor does (ui/autosave.js histOpen)
  for (let i = 0; !ok && i < 20; i++) {
    await new Promise(res => setTimeout(res, 150))
    ok = await inEditor(src, `!!(${ready})`)
  }
  if (!ok) {
    const has = await inEditor(src, '!!window.fetchHistory')
    throw new Error(has
      ? 'the version history for this take did not open, so nothing can be listed or restored. get_edit reads the edit as it stands, and revert_my_edit takes back your own last change.'
      : 'this build of Fetch keeps no version history, so there is nothing to list. revert_my_edit takes back your own last change.')
  }
  return await inEditor(src, 'window.fetchHistory.flush(), window.fetchHistory.rows()')
}

// 'V12', 'v12' and 12 are the same version.
function versionNumber(v) {
  const m = String(v == null ? '' : v).trim().match(/^v?(\d+)$/i)
  return m ? +m[1] : null
}

// One row as an agent reads it. The person is named as the person, never as null.
function versionSaid(r) {
  return {
    id: r.id, at: new Date(r.at).toISOString(), by: r.by || 'the person', how: r.how, line: r.line,
    ...(r.of ? { of: r.of } : {}),
    ...(r.merged ? { merged: r.merged, ...(r.also && r.also.length ? { also: r.also } : {}) } : {}),
    ...(r.missing && r.missing.length ? { missing: [...new Set(r.missing.map(m => m.what))] } : {}),
  }
}

// The moment worth drawing: the middle of the first zoom, mark or text that differs,
// and early in the take when it is the look or the cut that moved.
function versionMoment(doc, touched) {
  for (const k of ['zooms', 'marks', 'texts']) {
    const t = touched && touched[k]
    const id = t && [...t.added, ...t.changed][0]
    const it = id && (doc[k] || []).find(x => x && x.id === id)
    if (it && +it.end > +it.start) return r2((+it.start + +it.end) / 2)
  }
  return Math.min(1, (+doc.dur || 2) / 2)
}

// The edit as get_edit says it, without the option lists that are the same on every take.
function briefEdit(doc, src) {
  const { options, pointer, ...rest } = summarise(doc, src)
  return rest
}

// ── a shot, everywhere a take would have been ────────────────────────────
// Every function below is the shot half of an op above. None of them draws anything:
// the one that produces a picture hands ui/render-host.js the options bag
// Shot.toExportOpts builds, which is the bag an export hands it, so the stage, the
// preview and the PNG are one renderer at three widths.

// A question about time, asked of one frame. The refusal names the call that does the
// job on a capture instead, because a refusal that only says no costs a turn.
const SHOT_INSTEAD = 'A shot is one frame. apply_look styles it, apply_edit places marks and the ' +
  'headline on it, preview_frame draws it and export writes the PNG.'
const notOnAShot = what => new Error(`${what} is a question about time, and this is a shot. ${SHOT_INSTEAD}`)

// The shot document, from the window that holds it. The editor is asked rather than
// the disk because the person may be styling it at this moment and the window is where
// their change is first; the sidecar behind it is 400 ms old at worst (ui/editor.js).
async function shotOf(src) {
  const shot = await inEditor(src, docNow(src))
  if (shot && shot.kind === 'shot') return shot
  // The window could not open it. The sidecar is the fallback, and with neither the
  // capture is still a capture: an empty document on its own pixels.
  if (deps.proc.readShot) {
    try { return deps.proc.readShot(src, require('./render-host').pictureSize(src)) } catch {}
  }
  return Shot.normalize(null, src, require('./render-host').pictureSize(src))
}

// What the brief is measured against for a still: its shape, and no length at all. A
// screenshot has no seconds, so `seconds` is absent rather than zero, which Director
// reads as a length it should not report on.
function shotFacts(shot) {
  const Look = require('./look')
  const aspect = Look.resolve(shot && shot.look).frame.aspect
  if (aspect !== 'auto') return { aspect }
  const c = shot && shot.crop
  const box = c && +c.w > 0 && +c.h > 0 ? [+c.w * (shot.w || 1), +c.h * (shot.h || 1)]
    : shot && shot.w > 0 && shot.h > 0 ? [shot.w, shot.h] : null
  if (!box) return { aspect: null }
  const n = box[0] / box[1]
  return { aspect: Look.aspectOf(n) || `${Math.round(n * 100) / 100}:1` }
}

// The shot as an agent reads it back. Short on purpose: a document full of fields that
// mean nothing is a worse contract than one that says what it does not have.
function summariseShot(shot, src) {
  const Look = require('./look')
  return {
    kind: 'shot', id: shot.id || null, path: src,
    capture: { width: shot.w, height: shot.h },
    marks: (shot.marks || []).map(m => ({ id: m.id, kind: m.kind, x: m.x, y: m.y, w: m.w, h: m.h, n: m.n,
      ...(m.kind === 'blur' ? { strength: m.strength || 18 } : {}) })),
    // The words on the picture, with no times on them: a headline is a fact about the
    // composition and not about a clock.
    texts: (shot.texts || []).map(t => ({ id: t.id, text: t.text, style: t.style || null,
      ...(t.subtitle ? { subtitle: t.subtitle } : {}), ...(t.at ? { at: t.at } : {}) })),
    crop: shot.crop, cropAR: shot.cropAR,
    ...(shot.viewport ? { viewport: shot.viewport } : {}),
    ...(shot.group ? { group: { gap: shot.group.gap, align: shot.group.align,
      members: (shot.group.members || []).map(m => ({ id: m.id, src: m.src, device: m.device, mm: m.mm })) } } : {}),
    look: Look.compact(shot.look, looksDir()),
    // Said outright rather than left to be found out: a still has no clock, so the
    // fields an edit carries for one are not missing here, they do not exist.
    no_timeline: 'one frame: no clips, zooms, captions, sound or pointer, and marks and texts are placed ' +
      'and never timed. A headline is not a question about time, so a still carries type: apply_edit texts ' +
      'with style headline, caption, label or callout is how a capture becomes a hero. ' +
      'The look is the same look a recording holds, and the fades, the arrival, the loop and the motion blur ' +
      'are kept as sent and simply not drawn on one frame.',
    options: {
      looks: Look.list(looksDir()).map(p => p.name),
      backgroundImages: deps.proc.backdropList().filter(b => b.image).map(b => b.id),
      markKinds: [...Shot.KINDS],
      textStyles: ['headline', 'caption', 'label', 'callout'],
      cropAR: Look.CROP_ARS,
    },
  }
}

// apply_edit, on a capture. The patch goes through the same element resolution a
// recording's does (E ids from find_on_screen, R ids from the person's lasso, the
// refusal on a lift that has nothing to raise), and then through ui/shot.js, which
// merges marks by the edit document's own rule. What a shot has no room for is refused
// by name rather than accepted and dropped.
// texts is not in this list, and that is the round's largest single change: a headline
// has nothing to do with a clock. A hero, a docs picture and a store listing are all a
// capture with a line of type on it, and until now a still could carry every mark and
// no words, so the one thing a screenshot exists to be was the one thing it could not be.
const SHOT_HAS_NO = { clips: 'clips', zooms: 'zooms', cues: 'captions',
  beats: 'beats', camera: 'a camera bubble', audio: 'sound', audioTrack: 'a sound track',
  pointer: 'a pointer track', autoZoom: 'auto-zoom' }
async function applyToShot(args, ctx) {
  const patch = args.doc
  const refused = Object.keys(SHOT_HAS_NO).filter(k => patch[k] != null)
  if (refused.length) {
    throw new Error(`a shot has no ${refused.map(k => SHOT_HAS_NO[k]).join(', ')}. ${SHOT_INSTEAD} ` +
      'To put this on a recording instead, send it to that recording\'s path.')
  }
  for (const k of ['marks', 'texts']) {
    if (patch[k] != null && !Array.isArray(patch[k])) {
      throw new Error(`${k} is a list; to delete one send remove: ['${k === 'texts' ? 'T1' : 'M2'}'] beside it in doc, not inside it`)
    }
  }
  if (patch.remove != null && !Array.isArray(patch.remove)) throw new Error('remove is a list of ids, e.g. remove: [\'M2\']')

  const prev = await shotOf(args.path)
  // element: 'E7' and element: 'R1' resolve here exactly as they do for a recording,
  // so aiming at a box rather than at a coordinate is one rule and not two.
  let doc = withElements(args.path, patch, prev)
  let replaced = []
  if (Array.isArray(doc.marks)) {
    const merged = Shot.mergeMarks(prev.marks, doc.marks, doc.remove)
    const s = Shot.settleFocus(prev.marks, merged.marks)
    doc = { ...doc, marks: s.marks, remove: [...(doc.remove || []), ...s.replaced] }
    replaced = s.replaced
  }
  const shot = await inEditor(args.path, `${docOf(args.path)}.apply(${JSON.stringify(doc)}, ${byArg(ctx)})`)
  if (deps.proc.writeShot) { try { deps.proc.writeShot(args.path, shot) } catch {} }

  const out = summariseShot(shot, args.path)
  if (replaced.length) out.replaced = { marks: replaced, why: 'a new lift or spotlight takes the place of one it overlaps' }
  const gone = (prev.marks || []).map(m => m.id).filter(id => !(shot.marks || []).some(m => m.id === id) && !replaced.includes(id))
  if (gone.length) out.removed = { ids: gone, why: 'these are no longer on the shot; say so in your reply' }
  const warn = Shot.focusClashes(shot.marks).map(c =>
    `${c.a} (${c.kinds[0]}) and ${c.b} (${c.kinds[1]}) cover the same part of the picture, so one dims or cuts ` +
    'across the other. Keep one of them unless the person asked for both.')
  // A group is arranged on the document rather than in the look, because which captures
  // are in this picture is not a style that travels to another one.
  if (patch.group && !shot.group) {
    warn.push('this build of Fetch keeps no group on a shot, so the second capture was not placed and the ' +
      'picture is of the first alone. Say so rather than sending it again.')
  }
  // Same shape as the group line above, for the same reason: a field a build's document
  // does not keep has to say so once rather than come back as a picture with no words on it.
  if (Array.isArray(patch.texts) && patch.texts.length && !(shot.texts || []).length) {
    warn.push('this build of Fetch keeps no text on a shot, so the headline was not placed and the picture ' +
      'is the capture alone. Say so rather than sending it again.')
  }
  // Type never lies on the product, so type needs somewhere that is not the product to
  // stand. A look with no ground draws the capture edge to edge and leaves nowhere, and
  // the type is simply not drawn. Said here rather than found in the picture.
  if ((shot.texts || []).length && !Shot.toExportOpts(shot).backdrop) {
    warn.push('this look draws the capture edge to edge, so there is no ground for the words to stand on and ' +
      'none of them are drawn. Type never lies over the product. apply_look with a preset that gives the ' +
      'capture a ground, such as studio or clean, and the headline appears beside it or above it.')
  }
  if (warn.length) out.warnings = warn
  const lw = lookWarnings(require('./fetchdoc').lookPatchOf(patch).look, shot, args.path, { engine: 'gl' })
  if (lw.length) out.look_warnings = lw
  // The one field a still cannot honour, said where it is set rather than found in the
  // picture: what is stored keeps the fade, and one frame simply does not draw it.
  const Look = require('./look')
  const pinned = Object.keys(Shot.STILL_PINS)
    .filter(p => Look.getPath(require('./fetchdoc').lookPatchOf(patch).look || {}, p) !== undefined)
  if (pinned.length) {
    out.not_drawn = { fields: pinned, why: 'these describe how a take arrives, leaves or moves, and this is one frame. ' +
      'They are kept on the look, so saving it and using it on a recording still has them.' }
  }
  Object.assign(out, jobState(args.path, null, args.step, null, shotFacts(shot)), memoryState(args.path))
  const p = await drawShot(shot, args.path, { width: 1280 }).catch(e => ({ error: (e && e.message) || String(e) }))
  out.preview = p.error ? { error: p.error }
    : { image: p.file, at: SHOT_AT, why: 'this is the shot as it now stands. Look at it before replying.' }
  return out
}

// One picture of the shot, through ui/render-host.js. `width` draws the plan at an
// exact pixel width, which is how a preview is the export made narrow rather than a
// second opinion of it; with no width the shot is drawn at the size it ships at.
async function drawShot(shot, src, { width, dest, format, look, size } = {}) {
  const host = require('./render-host')
  const s = look && typeof look === 'object' ? Shot.mergeShot(shot, { look }) : shot
  const opts = Shot.toExportOpts(s)
  // A deliverable the store measures is a pair of integers, not a shape: the picture is
  // planned at the preset's own ratio and drawn at its own width, and the pair travels
  // beside it for the renderer that can set both (ui/compositor/index.js, job.size).
  if (size) opts.backdropAspect = size.w / size.h
  // A photo backdrop is a file on this Mac, resolved the way an export resolves it.
  try {
    const id = opts.backdrop
    const hit = id ? deps.proc.backdropList().find(b => b.id === id && b.image) : null
    if (hit && hit.file) opts.imageFile = hit.file
  } catch {}
  const w = size ? size.w : width
  return await host.renderShot(src, opts, { dest, format: format || 'png', width: w, size: size || undefined,
    scale: w ? undefined : 'native' }, dest ? `agent-shot-${Date.now()}` : undefined)
}

// ── the sizes a store measures ───────────────────────────────────────────
// One table, ui/sizes.js, and no number restated here. Two rules it enforces and this
// only relays: the size is a pair of integers rather than a shape, because a file one
// pixel out is rejected, and the capture is never enlarged into it, because a soft store
// asset is worse than none. The refusal is the deliverable in the common case: a default
// Simulator window is at 0.6 of the device's own pixels, so most people meet it first.
function storeSize(name, shot) {
  const Sizes = require('./sizes')
  const got = Sizes.resolve(name)
  if (!got.ok) throw new Error(got.reason)
  const preset = got.preset
  if (preset.kind !== 'still') {
    throw new Error(`${preset.id} is a video size (${preset.what}) and this is a shot. ` +
      'Export a recording for a preview; a screenshot takes the still sizes.')
  }
  // The crop on a document is fractions of the capture and fit() reads pixels, so a
  // crop of 0.995 arrived as a one pixel capture and the shot cropped to the device's
  // glass, which is the whole point of the round, was the one input that could not be
  // exported at a size. Multiplied out here, where the capture's own pixels are.
  const c = shot.crop
  const box = c && +c.w > 0 && +c.h > 0
    ? { w: Math.round(shot.w * +c.w), h: Math.round(shot.h * +c.h) } : null
  const fit = Sizes.fit({ w: shot.w, h: shot.h }, preset.id, { crop: box })
  // The reason and its ways out on their own lines: three routes run together in one
  // paragraph is a refusal an agent relays as prose instead of acting on.
  if (!fit.ok) throw new Error([fit.reason, ...(fit.fix || [])].join('\n'))
  // Not a refusal: what this size will cost the look it is drawn with, so a long wait is
  // expected rather than read as a hang (ui/sizes.js cost).
  const slow = Sizes.cost(shot.look, preset.id)
  return { preset, size: fit.size, fit, ...(slow.warnings.length ? { slow: slow.warnings } : {}) }
}

/**
 * An app preview, measured after it is written. Same rule as a still's sizeVerdict: the
 * plan is what Fetch meant to draw and the store is only ever shown the file, so the
 * length, the weight, the rate, the codec, the container and the rectangle all come off
 * the file itself.
 */
async function clipVerdict(want, file, made = {}) {
  if (!file || !fs.existsSync(file)) return { preview: want.preset, not_written: 'no file was written to measure' }
  const m = await deps.proc.probeMeta(file).catch(() => ({}))
  const bytes = fs.statSync(file).size
  // held to the edit it was made from and to the rate the plan promised, as well as to
  // the store's own rules: a legal 24 s file of a 28 s edit at 0.46 Mbps is not the file
  const got = require('./sizes').checkClip({
    seconds: m.duration, bytes, fps: m.fps, codec: m.vcodec || m.codec,
    expect: made.expect, bps: made.kbps ? made.kbps * 1000 : undefined,
    container: path.extname(file).replace('.', ''), w: m.width, h: m.height }, want.preset)
  return {
    preview: want.preset, what: want.what,
    store_size: `${want.size.w}x${want.size.h}`,
    drawn: m.width && m.height ? `${m.width}x${m.height}` : null,
    seconds: m.duration != null ? +(+m.duration).toFixed(2) : null,
    fps: m.fps != null ? +(+m.fps).toFixed(3) : null,
    mb: +(bytes / 1e6).toFixed(1),
    ...(made.kbps ? { mbps: +(made.kbps / 1000).toFixed(2) } : {}),
    poster: `the store shows the frame at ${want.poster} s before anybody presses play, so something has to be on screen there`,
    exact: !!got.ok,
    ...(got.ok ? {} : { not_the_store_file: `${got.reason} Say so rather than uploading it.` }),
    ...(want.warnings && want.warnings.length ? { warnings: want.warnings } : {}),
  }
}

// How much of the picture the take is drawn across, which is what an upscale has to be
// judged by: a framed look sits the take inside its padding on every side
// (ui/compositor/layout.js backdropGeometry, the same clamp), and a plain one fills it.
function drawnShare(doc) {
  const o = require('./fetchdoc').toExportOpts(doc, {})
  if (!o.backdrop) return 1
  const inset = Math.min(0.22, Math.max(0.02, o.inset != null ? +o.inset : 0.08))
  return Math.round((1 - inset * 2) * 1000) / 1000
}

// Said after the file exists, off the file's own pixels rather than off the plan: the
// store measures the file, so this reports what the store will see.
function sizeVerdict(want, drawn) {
  const exact = drawn.w === want.size.w && drawn.h === want.size.h
  return {
    size: want.preset.id,
    store_size: `${want.size.w}x${want.size.h}`,
    exact,
    ...(exact ? {} : { not_the_store_size: `this file is ${drawn.w}x${drawn.h} and ${want.preset.what} is ` +
      `exactly ${want.size.w}x${want.size.h}, which is what the store measures. Fetch will not call this a ` +
      'store file. Say so rather than uploading it.' }),
    ...(want.slow ? { slow: want.slow } : {}),
    ...(want.fit.pristine ? { pristine: 'the capture is drawn at its own pixels, so nothing was resampled' } : {}),
    ...(want.fit.leftover && (want.fit.leftover.w || want.fit.leftover.h)
      ? { filled: `${want.fit.leftover.w} by ${want.fit.leftover.h} pixels of the picture are not the capture, ` +
        'and are drawn: Fetch never writes a black bar' } : {}),
  }
}

// export, on a capture: the PNG the editor's own Export button writes, beside the
// capture and named after its folder. A still has no length, no quality and no frame
// rate, so nothing is asked about any of them.
const SHOT_FORMATS = { png: 'png', jpg: 'jpg', jpeg: 'jpg' }
async function exportShot(args) {
  const want = String(args.format || 'png').toLowerCase()
  const fmt = SHOT_FORMATS[want]
  if (!fmt) {
    throw new Error(`a shot exports as a PNG or a JPEG, not ${want}. PNG is the default because a screenshot ` +
      'draws hairlines and small text, which is exactly what JPEG softens. To export a video, send export the ' +
      'path of a recording.')
  }
  const shot = await shotOf(args.path)
  // The product's rules, before the PNG is written: a still is one frame, so it is read
  // here if nobody has read it, and anything a never-rule keeps off it refuses the file.
  await readForRules(args.path, SHOT_AT, shot.crop)
  const ruled = rulesCheck(args.path, shot, { gate: true, still: true, width: shot.w, height: shot.h })
  if (ruled && ruled.refused) throw rulesRefusal(ruled)
  // An exact size the store measures, from the one table that holds those numbers
  // (ui/sizes.js). Refused before anything is drawn where the capture cannot fill it,
  // because a soft store asset is worse than no store asset.
  const store = args.size != null ? storeSize(args.size, shot) : null
  const dest = deps.proc.exportDest(args.path, fmt === 'png' ? 'png' : 'jpg')
  const r = await drawShot(shot, args.path, { dest, format: fmt, ...(store ? { size: store.size } : {}) })
  const mb = r && r.file && fs.existsSync(r.file) ? +(fs.statSync(r.file).size / 1e6).toFixed(2) : null
  const checked = await reviewShot({ path: args.path, shot }).catch(() => null)
  return {
    path: r.file, mb, pixels: `${r.w}x${r.h}`, scale: r.scale, format: fmt, engine: r.engine,
    capture: r.capture, density: r.density,
    ...(store ? sizeVerdict(store, r) : {}),
    // Capture pixels per output pixel, which is the one number that tells a deliverable
    // from a preview and the one an agent cannot derive from two sizes it was handed.
    density_means: '1 is the capture at the size it was captured; over 1 is that much of it thrown away',
    original: 'the capture in Original/ is untouched, so this can be styled again from it',
    ...(checked ? { review: { verdict: checked.verdict, score: checked.score, summary: checked.summary,
      blocking: require('./review').blocking(checked) } } : {}),
    ...(ruled ? { guidelines: ruled } : {}),
    ...jobState(args.path, null, null, null, shotFacts(shot)),
  }
}

// review, on a capture. The same file and not the same rules: a shot says what it is
// (ui/shot.js writes kind) and ui/review.js judges it as a picture, off the plan the
// compositor draws it from, so the judge and the renderer cannot disagree about where
// anything is. The rules about a clock come back under not_judged, named, rather than
// reported as failures, since a screenshot cannot be the wrong length.
//
// It used to be the edit rubric run on a take of one frame, and on one frame every rule
// that rubric had passed: it answered "ready, 10" for a bare capture on a gradient and,
// word for word, for a picture with two title bars in it. A checker that always says ten
// is worse than none, which this project has learned once already.
async function reviewShot(args) {
  const shot = args.shot || await shotOf(args.path)
  let brief = null
  try { brief = (require('./director').read(args.path) || {}).brief || null } catch {}
  const r = require('./review').review({
    doc: shot, brief, path: args.path, declined: args.declined,
    looks: require('./look').list(looksDir()),
    levels: await shotLevels(shot),
    rules: wordsAgainstRules(args.path, shot),
  })
  // the product's rules as checks, beside the rubric: a still is read once if nobody has
  await readForRules(args.path, SHOT_AT, shot.crop)
  const g = rulesCheck(args.path, shot, { width: shot.w, height: shot.h })
  return g ? { ...r, guidelines: g } : r
}

// The capture's own black and white points, so the rule about a ground it sinks into
// can run on a shot too. Only where the look states a ground whose colour is known,
// which is the one rule that reads them, and kept per capture, since a capture never
// changes. An image ground and one made of the take's own blur are not measured: the
// rubric reports null for them rather than comparing against a colour nobody has.
const shotLevelCache = new Map()
const GROUND_READ = ['solid', 'gradient', 'mesh']
async function shotLevels(shot) {
  const L = (shot && shot.look) || {}
  if (!L.background || !GROUND_READ.includes(L.background.kind) || !shot.src) return null
  const key = `${shot.src}|${JSON.stringify(shot.crop || null)}`
  if (shotLevelCache.has(key)) return shotLevelCache.get(key)
  let lv = null
  try {
    lv = await require('./compositor/levels').measure(shot.src, {
      crop: shot.crop || null, width: shot.w, height: shot.h, timeout: 8000 })
  } catch {}
  shotLevelCache.set(key, lv)
  return lv
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

// What the brief is measured against: the finished length and the shape it goes out
// in. Both come off the document, so nothing is drawn to answer it.
// What the distance is measured on: the finished length, and the shape the export will
// actually be. 'auto' is the take's own shape, not an unanswered question, so it is
// resolved here against the crop or the take's own pixels; reporting it as "none set"
// made a 16:9 screen recording read as the wrong shape for a 16:9 brief forever.
function editFacts(doc, meta) {
  const Look = require('./look')
  const aspect = Look.resolve(doc && doc.look).frame.aspect
  const seconds = require('./fetchdoc').outDuration(doc || {})
  if (aspect !== 'auto') return { seconds, aspect }
  const c = doc && doc.crop
  const box = c && +c.w > 0 && +c.h > 0 ? [+c.w, +c.h]
    : meta && +meta.width > 0 && +meta.height > 0 ? [+meta.width, +meta.height] : null
  if (!box) return { seconds, aspect: null }
  const n = box[0] / box[1]
  return { seconds, aspect: Look.aspectOf(n) || `${Math.round(n * 100) / 100}:1` }
}

// The plan and the distance, on every call that changes or finishes an edit. This is
// the enforcement: a returned field an agent reads every time beats a description
// asking it to check. `step` closes a step of the plan, which is one direct call and
// not a second code path. A missing or broken job file is a nudge, never an error.
// The take's own pixel size, which never changes for a file, so it is probed once per
// path rather than once per call: apply_edit needs it only to answer "is 'auto' the
// shape the brief asked for", and that is not worth an ffmpeg spawn every time.
const shapeMemo = new Map()
async function takeShape(file) {
  if (shapeMemo.has(file)) return shapeMemo.get(file)
  let m = null
  try { const p = await deps.proc.probeMeta(file); if (p && p.width > 0) m = { width: p.width, height: p.height } } catch {}
  shapeMemo.set(file, m)
  return m
}

// What the person has already said about themselves and this product, on the two
// results an agent reads before it decides anything. An outside client never sees the
// in-app system prompt, so without this the store is written by one agent and read by
// none. The block only, never the fact objects: ids and text, not payloads.
//
// The block opens with the product's rules (ui/guidelines.js through Memory.recall), so
// the same call is how "never on screen" and the house look reach an agent before it
// captures or styles anything. `about` names the product where there is no take yet:
// record_start has only the name it was given.
function memoryState(file, about) {
  try {
    const Memory = require('./memory')
    const r = Memory.recallFor({ root: memRoot(file, about), take: file || null,
      ...(about ? { about } : {}) })
    return r && r.text ? { memory: r.text } : null
  } catch { return null }
}

// The product's rules held to this edit, in the shape review takes as input.rules: every
// word the edit puts on the picture (the texts, the captions, the marks' labels) against
// the words the rules avoid and the product's name, the look against the look rules, and
// what was read off the take against the never-rules (ui/guidelines.js check). `words`
// is the words list as review has always read it; `findings` and `unchecked` are check's
// own, each finding with its fix, so a name, a look or a never finding is an item of
// review's and not a note beside it. Null when there is nothing to say or no rules.
function wordsAgainstRules(file, doc) {
  try {
    const r = require('./guidelines').check({ root: memRoot(file), take: file || null },
      { doc, path: file, frames: framesRead.get(file) || [] })
    if (!r || !r.ok) return null
    const words = (r.words || []).map(w => ({ term: w.term, rule: w.rule, ...(w.instead ? { instead: w.instead } : {}) }))
    const findings = r.findings || [], unchecked = r.unchecked || []
    if (!words.length && !findings.length && !unchecked.length) return null
    return { words, findings, unchecked,
      ...(words.length ? { note: `${r.product}'s rules avoid ${words.map(w => `"${w.term}"`).join(', ')}, and the words on ` +
        `this edit use ${words.length === 1 ? 'it' : 'them'}. Change ${words.length === 1 ? 'it' : 'them'} before this is ` +
        'exported, or say in your reply why not.' } : {}) }
  } catch { return null }
}

// ── the sample library, as the agent sees it ─────────────────────────────
// The sample (ui/sample.js) lives in the renderer: the Library's chip opens it and its
// session is held there. main.js is meant to be told where it is ('sample-root', handed
// here as deps.sampleRoot); until it is, the window is asked, which is the same module
// the chip opened, since the renderer requires it from the same file.
const Sample = require('./sample')
// The root last seen open, so the synchronous paths (memoryState) can tell without a
// round trip. Only trusted while the folder still carries the sample's own marker, so a
// sample that was closed is never mistaken for an open one.
let sampleAt = null
async function sampleRoot() {
  let r = null
  if (typeof deps.sampleRoot === 'function') {
    try { r = deps.sampleRoot() } catch {}
  } else {
    const win = deps.getWindow ? deps.getWindow() : null
    if (win && !win.isDestroyed()) {
      r = await Promise.race([
        win.webContents.executeJavaScript("(() => { try { return require('./ui/sample').root() } catch (e) { return null } })()"),
        new Promise(res => setTimeout(() => res(null), 1500)),
      ]).catch(() => null)
    }
  }
  sampleAt = r && Sample.isSample(r) ? r : null
  return sampleAt
}
// The sample a file belongs to, read off the file's own folders: a sample take is
// <root>/<Take>/Original/<Take>.ext, and only the root carries the marker.
function sampleOf(file) {
  if (!file || typeof file !== 'string') return null
  let d = path.dirname(file)
  for (let i = 0; i < 4; i++) {
    if (Sample.isSample(d)) return d
    const up = path.dirname(d)
    if (up === d) break
    d = up
  }
  return null
}
// Where a fact or a rule is kept. Anything about the sample, its takes or its made up
// product, goes into the sample's own folder and is deleted with it, so trying Fetch
// never leaves a product nobody makes in the person's memory. While the sample is open,
// so does anything that names no take and no product: "the product is called Biscuit's
// Pantry" with no path was written to the person's own memory as a fact about nothing in
// particular, and those belong to whoever asks, so the made up name reached the briefing
// for every real product after they left. Only a fact about one of the person's own
// takes, or naming a product that is not the sample's, is theirs while it is open.
function memRoot(file, about) {
  const own = sampleOf(file)
  if (own) return own
  const theirs = app ? app.getPath('userData') : require('os').tmpdir()
  if (!sampleAt || !Sample.isSample(sampleAt)) return theirs
  if (file) return theirs
  if (!about) return sampleAt
  try {
    const Memory = require('./memory')
    return Memory.sameSubject(about, Sample.manifest().product) ? sampleAt : theirs
  } catch { return sampleAt }
}

// What the product's rules say about labels read off a picture: anything a never-rule
// names that is on it. Null when nothing is, when there are no rules, or when no product
// can be told, so a picture with nothing wrong costs the result nothing.
function neverSeen(file, labels, about) {
  try {
    if (!labels || !labels.length) return null
    const where = { root: memRoot(file, about), take: file || null, ...(about ? { about } : {}) }
    const r = require('./guidelines').check(where, { labels })
    if (!r || !r.ok || !r.onScreen || !r.onScreen.length) return null
    return {
      never_on_screen: r.onScreen,
      rule: `${r.product}'s rules say ${[...new Set(r.onScreen.map(h => h.thing))].join(', ')} must never be on screen, ` +
        'and it is on this picture. Blur it, crop it out or go to another screen before this is used, and tell the person.',
    }
  } catch { return null }
}

// ── a project, from @ to its window ──────────────────────────────────────
// "@majuro record a demo of the lasso" names a folder of the person's own code, and a
// take needs a window. ui/projects.js knows the folders (Conductor, Orca, Claude Code),
// ui/project-windows.js knows what runs from one; this is where the two meet the tools.
// record_start and take_shot take project and resolve it to the best window at the
// moment of the call, and refuse with the finder's own sentence when nothing suitable
// is running, rather than record the app that happens to be in front.
//
// A name has to be exact to count: an id, a path, or a name or alias one project and
// no other answers to. A near miss is refused with the closest names, because a guess
// here points a recording at the wrong project with the person's authority.
function projectList() {
  if (typeof deps.projects === 'function') return Promise.resolve(deps.projects()).then(l => l || [], () => [])
  return require('./projects').projectIndexAsync().catch(() => [])
}
let projectFinderMade = null
function projectFinder() {
  if (deps.projectWindows) return deps.projectWindows
  if (!projectFinderMade) {
    // the Fetch doing the recording is found and named, never picked: it hides its own
    // window while a take runs
    projectFinderMade = require('./project-windows').make({ selfPid: process.pid, simModel: () => simModel() })
  }
  return projectFinderMade
}

// Where an unlisted folder may not be taken from, and what makes one look like a project.
// Hidden folders are where keys and settings live (.ssh, .aws, .gnupg, .config), ~/Library
// holds keychains and every app's data, and the system folders are nobody's project.
// Temp folders (/tmp, /private/var/folders) stay open: they are scratch, someone may well
// clone a project into one, and the hidden-folder and project-file rules still apply there.
const SYSTEM_DIR = /^\/(System|Library|etc|usr|bin|sbin|dev|cores|opt|private\/(etc|var\/db|var\/root)|Volumes\/[^/]+\/(System|Library))(\/|$)/
const PROJECT_MARKERS = ['.git', 'package.json', 'Package.swift', 'Cargo.toml', 'pyproject.toml', 'go.mod',
  'Gemfile', 'pom.xml', 'build.gradle', 'CMakeLists.txt', 'Makefile', 'README.md', 'README']
function unlistedFolderRefusal(real, home) {
  if (real.split(path.sep).some(part => part.startsWith('.'))) return 'is inside a hidden folder, where keys and settings live rather than projects'
  const rel = path.relative(home, real)
  const inHome = rel && !rel.startsWith('..') && !path.isAbsolute(rel)
  if (inHome && (rel === 'Library' || rel.startsWith('Library' + path.sep))) return 'is inside ~/Library, which holds keychains and app data rather than projects'
  if (!inHome && SYSTEM_DIR.test(real)) return 'is a system folder'
  // asked of each name in turn, never a listing of the folder
  const marked = PROJECT_MARKERS.some(m => { try { fs.lstatSync(path.join(real, m)); return true } catch { return false } })
  if (!marked) return 'does not look like a project: it has no .git, package.json, README or other project file'
  return null
}

const lowerOf = v => String(v == null ? '' : v).trim().toLowerCase()
function resolveProject(q, list) {
  const raw = typeof q === 'object' && q ? (q.path || q.id || q.name || '') : q
  const want = String(raw == null ? '' : raw).trim().replace(/^@/, '').replace(/\/+$/, '')
  if (!want) return { ok: false, why: 'project is empty. list_projects lists the projects Fetch knows.' }
  list = Array.isArray(list) ? list : []
  let hits
  if (want.startsWith('/') || want.startsWith('~')) {
    const abs = want.startsWith('~') ? path.join(require('os').homedir(), want.slice(1)) : want
    let real = abs
    try { real = fs.realpathSync(abs) } catch {}
    hits = list.filter(p => p.path === real || p.path === abs)
    if (!hits.length) {
      // A folder the tools have not seen is still a folder something can run from. It is
      // named by its last part and carries nothing read out of it.
      let dir = false
      try { dir = fs.statSync(real).isDirectory() } catch {}
      if (!dir) return { ok: false, why: `${want} is not a folder on this Mac.` }
      // Being a folder was all it took, so ~/.ssh passed and its file names were listed.
      // A folder no tool has seen is taken only where a project could live and only if it
      // looks like one, and that is judged by name and by asking after a few project files,
      // so a secret folder is refused without anything inside it being listed.
      const off = unlistedFolderRefusal(real, require('os').homedir())
      if (off) return { ok: false, why: `${want} ${off}. Name a project's own folder, or one list_projects gives.` }
      if (require('./project-windows').tooBroad(real, require('os').homedir())) {
        return { ok: false, why: `${want} holds far more than one project. Name the project's own folder.` }
      }
      return { ok: true, project: { id: null, name: path.basename(real), handle: path.basename(real), path: real, source: null } }
    }
  } else {
    const w = lowerOf(want)
    hits = list.filter(p => p.id === want || lowerOf(p.handle) === w || lowerOf(p.name) === w ||
      (Array.isArray(p.aliases) && p.aliases.includes(w)))
  }
  if (hits.length === 1) return { ok: true, project: hits[0] }
  if (hits.length > 1) {
    return { ok: false, why: `${hits.length} projects answer to "${want}": ` +
      `${hits.slice(0, 5).map(p => `${p.name} (${p.path})`).join('; ')}. Name one by its path or its id.`,
    candidates: hits.slice(0, 5).map(projectRow) }
  }
  let near = []
  try { near = require('./projects').findProjects(want, list, 5) } catch {}
  return { ok: false, why: `No project Fetch knows is called "${want}".` +
    (near.length ? ` Closest: ${near.map(p => p.handle || p.name).join(', ')}.` : '') +
    ' list_projects lists them, from Conductor, Orca and Claude Code.',
  ...(near.length ? { candidates: near.map(projectRow) } : {}) }
}

// What record_start's project takes to mean this project and no other: its handle, which
// ui/projects.js keeps unique, or its path when it is a folder no tool has listed.
const projectArgName = p => (p && p.id && p.handle) || (p && p.path) || (p && p.name) || ''

// Other tools' data about other projects leaves Fetch only for an agent the person let
// see it. Fetch's own chat is the person's (the shim it starts says --chat); any other
// agent is asked about once, and a yes holds until Fetch quits, like a take's. Saying
// nothing is a no. deps.confirmProjects stands in for the question in the tests.
async function projectsAllowed(ctx) {
  if (ctx && ctx.chat === true) return
  if (sessionAllowed.has('projects')) return
  // This one had no standing yes at all: once, or until Fetch quits, and then it asked
  // again on the next launch. It is the gate in front of naming a project, so it is the
  // question a person who works this way sees most often, and answering it every
  // restart is the asking that made somebody say they should not have to say this all
  // the time. Revocable in Settings like every other.
  if (allowedAlways('projects')) return
  const who = (ctx && ctx.client) || 'An agent'
  let answer
  if (typeof deps.confirmProjects === 'function') answer = await deps.confirmProjects(who)
  else {
    answer = await askPerson(`${who} wants to see the projects on this Mac.`,
      'Their names, folders, branches and remotes, from Conductor, Orca and Claude Code, what runs from one ' +
      'it names, and the first lines of that one\'s README. It goes to that agent\'s model.',
      'Allow until Fetch quits', false, 'Allow once', false,
      { alwaysLabel: 'Always allow' })
  }
  if (answer === 'session') { sessionAllowed.add('projects'); return }
  if (answer === 'always') { rememberAlways('projects', 'See the projects on this Mac'); return }
  if (answer === 'once') return
  throw new Error(answer === 'unanswered'
    ? 'Fetch did not hand over the projects on this Mac: nobody answered the question on screen. Ask the person to tag the project in Fetch\'s chat, or to allow it.'
    : 'Fetch did not hand over the projects on this Mac: the person at the Mac said no. Do not ask again in this task.')
}

// One project as a tool hands it back. The description is the project's own first
// lines, already capped and cleaned of anything shaped like a key by ui/projects.js.
function projectRow(p, o = {}) {
  if (!p) return null
  return {
    ...(p.id ? { id: p.id } : {}),
    name: p.name, handle: p.handle || p.name, path: p.path,
    ...(p.sources && p.sources.length ? { from: p.sources } : p.source ? { from: [p.source] } : {}),
    ...(p.branch ? { branch: p.branch } : {}),
    ...(p.remoteShort || p.remote ? { remote: p.remoteShort || p.remote } : {}),
    ...(o.about !== false && p.about ? { about: p.about } : {}),
    ...(p.lastUsed ? { last_used: new Date(p.lastUsed).toISOString() } : {}),
  }
}

// The product a project's rules are kept under. A product the person already has rules
// or facts for wins when the project answers to it (its remote's name, its repo, its
// workspace, its handle, its folder); otherwise the remote's name, since that is what a
// repo is called outside this Mac, and then the handle. "rec/majuro" with the remote
// SankrityaT/Fetch is Fetch, so its rules are the ones Fetch's takes are held to.
function productFor(p, root) {
  if (!p) return null
  const Memory = require('./memory')
  const fromRemote = p.remoteShort ? String(p.remoteShort).split('/').pop() : p.remote
    ? String(p.remote).replace(/\.git$/, '').split(/[/:]/).pop() : null
  const names = [fromRemote, p.repo, p.workspace, p.handle, p.name, p.path ? path.basename(p.path) : null]
    .map(x => Memory.clean(x || '', 60)).filter(Boolean)
  try {
    const known = new Set()
    for (const f of Memory.read(root || ownRoot()).facts) if (f.scope === 'product' && f.about) known.add(f.about)
    for (const n of names) for (const k of known) if (Memory.sameSubject(n, k)) return k
  } catch {}
  return names[0] || null
}

// The Library folder a project's takes and shots are filed in: the project's own name,
// as the chip in the chat showed it.
const projectFolder = p => (p && (p.name || p.handle)) || null

// Where a project's rules and facts are kept: the person's own memory, always. A project
// is a folder of their code, never the sample's made up product.
const ownRoot = () => (app ? app.getPath('userData') : require('os').tmpdir())

// What runs from a project right now, bounded: a turn does not wait on a slow Mac.
function projectRunning(p, ms = 6000) {
  return Promise.race([
    Promise.resolve().then(() => projectFinder().find({ name: p.handle || p.name, path: p.path })).catch(() => null),
    new Promise(res => { const t = setTimeout(() => res(null), ms); if (t.unref) t.unref() }),
  ])
}

// The candidates as a tool hands them back: what the finder said, less its internals.
const candidateRow = c => ({
  kind: c.kind, ...(c.window ? { window: c.window } : {}), ...(c.device ? { device: c.device } : {}),
  ...(c.url ? { url: c.url } : {}), recordable: !!c.recordable, evidence: c.evidence || [],
  ...(c.note ? { note: c.note } : {}), ...(c.self ? { self: true } : {}),
})

// record_start and take_shot with project: the window to use, or the sentence that
// refuses. A pick that is not on screen is refused too, since a take of it gets no
// frames and Fetch never brings a window forward.
// Dev servers Fetch started, by project path, so one is not started twice and so
// something holds the handle: a server started and then forgotten is a port somebody
// has to hunt for later. Stopped when Fetch quits.
const started = new Map()
function stopStarted() {
  for (const [, v] of started) { try { v.stop() } catch {} }
  started.clear()
}

/**
 * Start what a project serves, because it was asked to be recorded and nothing of it is
 * running. Fetch used to name the command and stop, and the person went and typed it:
 * for a tool whose claim is that an agent drives it, being told to go and start your own
 * dev server is the thing not working.
 *
 * It is its own yes, and a larger one than recording a window: this runs the
 * repository's own code on somebody's Mac. Only a script the project itself declares is
 * ever run, read out of its own package.json, and the question says the command in full
 * before anything spawns.
 */
async function startProject(p, ctx) {
  const PS = require('./project-start')
  const live = started.get(p.path)
  if (live) return live
  const plan = PS.planStart(p.path)
  if (!plan.ok) return { refused: plan.why }
  const who = (ctx && ctx.client) || 'An agent'
  const key = `start|${p.path}`
  if (!sessionAllowed.has(key) && !allowedAlways(key)) {
    const answer = await askPerson(
      `${who} wants to start ${p.handle || p.name} to record it.`,
      `It will run ${plan.says} in ${p.path}, which runs that project's own code on this Mac, ` +
      `and open the address it prints in your browser. Nothing is recorded until it is serving.`,
      `Let ${who} start ${p.handle || p.name} until Fetch quits`, false, `Start it once`, false,
      { alwaysLabel: `Always start ${p.handle || p.name}` })
    if (answer === 'unanswered') return { refused: `starting ${p.handle || p.name} needs the person's word and nobody was at the Mac to give it.` }
    if (answer === 'no') return { refused: 'the person at the Mac said no.' }
    if (answer === 'session') sessionAllowed.add(key)
    if (answer === 'always') rememberAlways(key, `Start ${p.handle || p.name}`)
  }
  let out
  try { out = await PS.run(plan) } catch (e) { return { refused: (e && e.message) || String(e) } }
  started.set(p.path, out)
  // the address it printed, in the person's own browser: a page nobody can see is not a
  // page Fetch can record
  try { require('child_process').execFile('/usr/bin/open', [out.url]) } catch {}
  return { ...out, says: plan.says }
}

/**
 * Put a project's own page on screen, when it is serving and nothing is showing it.
 *
 * Its own small yes, because opening a browser puts a window on somebody's screen, and
 * Fetch is otherwise careful never to. One Always allow ends the asking for that
 * project. This is not the same act as starting it: the code is already running and
 * this only looks at what it serves.
 */
async function showPage(p, url, ctx) {
  const key = `show|${p.path}`
  if (!sessionAllowed.has(key) && !allowedAlways(key)) {
    const who = (ctx && ctx.client) || 'An agent'
    const answer = await askPerson(
      `${who} wants to open ${p.handle || p.name} to record it.`,
      `${p.handle || p.name} is already serving at ${url}, and nothing on screen is showing it, ` +
      `so there is no window to record. This opens that address in your browser and records that window.`,
      `Let ${who} open ${p.handle || p.name} until Fetch quits`, false, 'Open it once', false,
      { alwaysLabel: `Always open ${p.handle || p.name}` })
    if (answer === 'unanswered') return { ok: false, why: `opening ${p.handle || p.name} needs the person's word and nobody was at the Mac to give it.` }
    if (answer === 'no') return { ok: false, why: 'the person at the Mac said no.' }
    if (answer === 'session') sessionAllowed.add(key)
    if (answer === 'always') rememberAlways(key, `Open ${p.handle || p.name}`)
  }
  // Which windows the browsers had before, so the one this opens can be told from them.
  // Matching it afterwards by the page's title does not work and cannot be made to: a
  // dev server for a client rendered app serves HTML with no <title> in it at all, the
  // title is written by JavaScript after hydration, and that is most of the web now.
  // Measured on a Next app: the window read "Songscription · Your library" and the
  // served document had no title element, so nothing matched and Fetch said no browser
  // was showing a page that was plainly on screen. Fetch opened this one, so it does
  // not have to guess: it watches for the window that appears.
  const before = await browserWindows()
  try { require('child_process').execFile('/usr/bin/open', [url]) } catch (e) { return { ok: false, why: (e && e.message) || String(e) } }
  const win = await appearedWindow(before)
  return { ok: true, window: win }
}

const BROWSERS = /chrome|safari|firefox|arc|brave|edge|orion|vivaldi/i
async function browserWindows() {
  let list = []
  try { list = await deps.listWindows() } catch { list = [] }
  const out = new Map()
  for (const w of list || []) if (BROWSERS.test(String(w.app || ''))) out.set(String(w.id), String(w.title || ''))
  return out
}

/**
 * The browser window that turned up after a page was opened, or null.
 *
 * A browser given a URL either opens a window, which is a new id, or a tab in one it
 * already has, which is the same id with a new title. Both are watched. Polled rather
 * than waited out once, because a cold tab can take a few seconds to paint and a fixed
 * sleep is either too short to catch it or too long on every call that was fine.
 */
async function appearedWindow(before, ms = 9000) {
  const until = Date.now() + ms
  let last = null
  while (Date.now() < until) {
    await new Promise(r => setTimeout(r, 600))
    let list = []
    try { list = await deps.listWindows() } catch { list = [] }
    const browsers = (list || []).filter(w => BROWSERS.test(String(w.app || '')))
    const fresh = browsers.find(w => !before.has(String(w.id)))
    if (fresh) return fresh
    const retitled = browsers.find(w => before.has(String(w.id)) && String(w.title || '') !== before.get(String(w.id)) && String(w.title || '').trim())
    if (retitled) last = retitled
  }
  if (last) return last
  // Nothing new and nothing renamed, which is not the same as nothing happening: a page
  // that sets no title at all loads into a window Chrome still calls "Untitled", so it
  // is neither a new id nor a changed one. Measured on the app this was built against.
  // `open` brings the browser forward and focuses the tab it loaded, so the front
  // window is the one showing it, and that is a fact about what just happened rather
  // than a guess about a title.
  try {
    const front = deps.frontWindow ? await deps.frontWindow(AGENT_HOSTS) : null
    if (front && BROWSERS.test(String(front.app || ''))) return front
  } catch {}
  return null
}

async function projectTarget(q, ctx = null) {
  const list = await projectList()
  const r = resolveProject(q, list)
  if (!r.ok) throw new Error(r.why)
  const p = r.project
  let running = await projectRunning(p, 15000)
  if (!running) throw new Error(`Fetch could not read what is running from ${p.handle || p.name} in time, so nothing was captured. Call it again.`)
  // Nothing of it is running, and it is startable: start it rather than saying how.
  let began = null
  if (!running.pick && /^Nothing from /.test(running.why || '')) {
    const go = await startProject(p, ctx)
    if (go && !go.refused) {
      began = go
      // the browser needs a moment to put the page on screen before anything looks for it
      await new Promise(r2 => setTimeout(r2, 2500))
      running = await projectRunning(p, 15000) || running
    } else if (go && go.refused) {
      running = { ...running, why: `${running.why} Fetch tried to start it and could not: ${go.refused}` }
    }
  }
  // Serving, with nothing showing it. Fetch used to hand back the address and ask the
  // person to go and open it, which is the same failure as naming the start command and
  // stopping: the one thing standing between the request and the recording is a thing
  // Fetch can do. It opens the page itself.
  if (!running.pick) {
    const serving = (running.candidates || []).find(c => c.kind === 'server' && c.url)
    if (serving) {
      const shown = await showPage(p, serving.url, ctx)
      if (shown.ok) {
        began = { ...(began || {}), url: serving.url, opened: serving.url }
        // The window Fetch itself opened, taken as the answer rather than looked for
        // again: it knows which one it is, and the search it would run cannot find a
        // client rendered page by title.
        if (shown.window) {
          running = { ...running, pick: { kind: 'browser', url: serving.url, recordable: true,
            window: { ...shown.window, onScreen: true },
            evidence: [`Fetch opened ${serving.url} and this window is what appeared`] },
            why: `Fetch opened ${serving.url} in ${shown.window.app} and is recording that window.` }
        } else {
          running = await projectRunning(p, 15000) || running
        }
      } else if (shown.why) {
        running = { ...running, why: `${running.why} Fetch tried to open it and could not: ${shown.why}` }
      }
    }
  }
  const pick = running.pick
  const others = (running.candidates || []).filter(c => c.window && c.recordable).slice(0, 3)
  const named = others.length ? ` Seen: ${others.map(c => `window ${c.window.id} (${c.window.app}${c.window.title ? `, ${c.window.title}` : ''})`).join('; ')}.` : ''
  if (!pick) throw new Error(`Nothing was captured. ${running.why}${/Say which one/.test(running.why) ? '' : named}`)
  if (pick.window && pick.window.onScreen === false) {
    throw new Error(`Nothing was captured. ${running.why} Fetch never brings a window forward itself.`)
  }
  const root = ownRoot()
  const product = productFor(p, root)
  return { project: p, pick, why: running.why, product, folder: projectFolder(p),
    ...(began ? { started: { ran: began.says, url: began.url, pid: began.pid } } : {}),
    said: { name: p.name, handle: p.handle || p.name, path: p.path, ...(p.branch ? { branch: p.branch } : {}),
      chosen: running.why, ...(product ? { product } : {}),
      // Said from what actually happened, not from a shape that assumes both. Starting
      // a project and opening a page it was already serving are two different acts and
      // either can happen without the other; reading says on a page that was only
      // opened printed the sentence "Fetch ran undefined".
      ...(began ? { started: began.says
        ? `Fetch ran ${began.says}${began.opened ? ' and opened' : ', and it is serving at'} ${began.url}`
        : `Fetch opened ${began.url}, which ${p.handle || p.name} was already serving` } : {}) } }
}

// A take or a shot of a project, named product first, so the rules and the facts kept for
// that product follow the file without anyone passing about (ui/memory.js productOf reads
// the part before the dot). The app in front would have named it after Electron.
function projectTakeName(p, product) {
  const handle = (p && (p.handle || p.name)) || ''
  if (!product) return handle || null
  return !handle || require('./memory').sameSubject(handle, product) ? product : `${product} · ${handle}`
}

// record_start's and take_shot's project argument, taken off the args and turned into
// what they already understand: a window (or a simulator) found now, a name that says the
// product, and the folder the file is filed in. A window, display, region or simulator
// named alongside wins over the finder, and the project still names the product and the
// folder. Null when no project was named.
async function projectArgs(args = {}, ctx = null) {
  if (args.project == null || String(args.project).trim() === '') return null
  // resolving a name hands back names and paths of the projects near it, so an agent
  // outside the app needs the same yes list_projects does
  await projectsAllowed(ctx)
  const out = { ...args }
  delete out.project
  const named = args.window != null || args.display != null || args.simulator != null || !!args.full_screen || !!args.region
  let target = null, p, product
  if (named) {
    const r = resolveProject(args.project, await projectList())
    if (!r.ok) throw new Error(r.why)
    p = r.project
    product = productFor(p, ownRoot())
  } else {
    target = await projectTarget(args.project, ctx)
    p = target.project
    product = target.product
    if (target.pick.kind === 'simulator' && target.pick.device) out.simulator = target.pick.device.udid
    else out.window = String(target.pick.window.id)
  }
  if (out.name == null) {
    const n = projectTakeName(p, product)
    if (n) out.name = n
  }
  const said = target ? target.said : { name: p.name, handle: p.handle || p.name, path: p.path,
    ...(p.branch ? { branch: p.branch } : {}), ...(product ? { product } : {}),
    chosen: 'the window, display or simulator named alongside it' }
  return { args: out, target, product, folder: projectFolder(p), said,
    seen: target && target.pick.window && target.pick.kind !== 'simulator' ? { app: target.pick.window.app } : null }
}

// The block a chat turn carries for each project it tagged: where it is, what it is,
// what runs from it now and how to record it (ui/edit-assist.js projectLines). Tags the
// chat already described carry only what it could not know. A typed @name the chat did
// not tag is resolved here too, exactly or not at all.
async function projectTurn(tags = [], text = '') {
  const list = await projectList()
  const picked = []
  for (const t of (Array.isArray(tags) ? tags : [])) {
    if (!t || t.kind !== 'project' || !t.path) continue
    const r = resolveProject(t.path, list)
    picked.push({ project: r.ok ? { ...t, ...r.project } : { ...t, handle: t.name }, described: true })
  }
  const re = /(^|\s)@([^\s@]+)/g
  let m
  while ((m = re.exec(String(text || ''))) && picked.length < 3) {
    const word = m[2].replace(/[.,;:!?)]+$/, '')
    const r = resolveProject(word, list)
    if (r.ok && r.project.id && !picked.some(x => x.project.path === r.project.path)) picked.push({ project: r.project, described: false })
  }
  if (!picked.length) return ''
  const root = ownRoot()
  const out = await Promise.all(picked.slice(0, 3).map(async e =>
    ({ ...e, product: productFor(e.project, root), running: await projectRunning(e.project) })))
  return require('./edit-assist').projectLines(out)
}

// Filed in the project's Library folder, through the Library itself: its folders live in
// the window and are written from there, so a second writer here would lose one side's
// change. Said plainly when this build's Library cannot take it.
async function fileInFolder(file, folder) {
  if (!file || !folder) return null
  const win = deps.getWindow ? deps.getWindow() : null
  if (!win || win.isDestroyed()) return { folder, filed: false, why: 'Fetch has no window to file it from.' }
  const js = `(() => { try { const L = require('./ui/library.js'); ` +
    `if (typeof L.fileInto !== 'function') return { filed: false, why: 'this build of the Library cannot file into a folder yet' }; ` +
    `const r = L.fileInto(${JSON.stringify(folder)}, ${JSON.stringify(file)}); ` +
    `if (typeof window.refreshLibrary === 'function') window.refreshLibrary(); ` +
    `return { filed: r !== false } } catch (e) { return { filed: false, why: String(e && e.message || e) } } })()`
  const r = await Promise.race([
    win.webContents.executeJavaScript(js).catch(e => ({ filed: false, why: e.message })),
    new Promise(res => setTimeout(() => res({ filed: false, why: 'the Library did not answer' }), 3000)),
  ])
  return { folder, ...(r && typeof r === 'object' ? r : { filed: false }) }
}

// ── the product's rules, as checks ──────────────────────────────────────
// A rule an agent only reads is a suggestion. ui/guidelines.js holds work to four of the
// five sections (the words it avoids, what it is called, what must never be on screen,
// how its pictures look) and says of any rule it could not hold the work to that it was
// unchecked, never that it passed. Here is where that check runs: on take_shot, the
// moment the picture exists; on review, beside the rubric; and at export, where anything
// a never-rule keeps off screen that was seen and is not under a redaction refuses the
// file before a frame is drawn. Nothing is refused for a rule that could not be checked.
//
// What is on screen is what was read: every list an Elements pass handed back for a file,
// the agent's and Fetch's own, by moment. A later read of the same moment replaces the
// earlier one, since it is the same picture read again.
const framesRead = new Map()   // path -> [{ at, elements: [{ id, text, box }] }], by time
const FRAMES_KEPT = 60
function noteFrame(file, at, list, agent = true) {
  if (!file || !Array.isArray(list)) return
  const t = Number.isFinite(+at) ? +at : null
  // Only the agent's own ids are kept: a finding's fix names the element by its id, and
  // an id off Fetch's own pass is not one the agent holds (its E4 is the agent's E4 on
  // another element). Those are fixed by box instead.
  const els = list.filter(e => e && e.text).map(e => ({ ...(agent ? { id: e.id } : {}), text: e.text, box: e.box }))
  const kept = (framesRead.get(file) || []).filter(f => t == null || f.at == null || Math.abs(f.at - t) > 0.25)
  kept.push({ at: t, elements: els })
  kept.sort((a, b) => (a.at || 0) - (b.at || 0))
  framesRead.set(file, kept.slice(-FRAMES_KEPT))
}

// The rules a file's product has in force, or null when there is no product or no rule.
function rulesInForce(file) {
  try {
    const r = require('./guidelines').read({ root: memRoot(file), take: file || null })
    if (!r || !r.ok) return null
    return Object.values(r.rules || {}).some(l => l && l.length) ? r : null
  } catch { return null }
}

/**
 * The product's rules held to this piece of work. `gate` asks the yes or no an export
 * needs; without it this is the check review and take_shot report. Null when there is
 * nothing to hold it to. The result carries the findings, each with the call that fixes
 * it, and every rule left unchecked with why.
 */
function rulesCheck(file, doc, o = {}) {
  if (!rulesInForce(file)) return null
  try {
    const G = require('./guidelines')
    const where = { root: memRoot(file), take: file || null }
    const args = { doc, path: file, frames: framesRead.get(file) || [],
      ...(o.width > 0 && o.height > 0 ? { width: o.width, height: o.height } : {}),
      ...(o.gate ? { for: o.still ? 'still' : 'export' } : {}) }
    const r = o.gate ? G.gate(where, args) : G.check(where, args)
    if (!r) return null
    const refused = r.refused && r.refused.kind === 'never-on-screen' ? r.refused : null
    if (!r.ok && !refused) return null
    const findings = r.findings || [], unchecked = r.unchecked || []
    if (!findings.length && !unchecked.length && !refused) return null
    return { product: r.product, verdict: r.verdict, ...(refused ? { refused } : {}),
      findings, unchecked, ...(r.covered && r.covered.length ? { covered: r.covered } : {}),
      note: refused ? refused.why
        : findings.length ? `${findings.length} thing${findings.length === 1 ? '' : 's'} here break${findings.length === 1 ? 's' : ''} ` +
          `${r.product}'s rules. Each finding names the rule and the call that fixes it.`
          : `Nothing here breaks ${r.product}'s rules that could be checked; the rules under unchecked were not ` +
            'checked and have not passed.' }
  } catch { return null }
}

// A picture no pass has read yet, read once for the never-rules, as Fetch's own pass so
// no id the agent holds is renumbered. Only where the product has a never-rule to hold
// it to, since it costs an Elements pass; a frame that cannot be read is left unchecked.
async function readForRules(file, at, crop) {
  const r0 = rulesInForce(file)
  if (!r0 || !(r0.rules.never || []).length) return
  if ((framesRead.get(file) || []).length || !deps.proc || !deps.proc.findOnScreen) return
  try {
    const key = runKey(file, { agent: false })
    const r = await deps.proc.findOnScreen(file, at, { crop: crop && crop.w > 0 ? crop : null, limit: 60,
      guard: guardHook(key, [], { fresh: true }) })
    settle(r, key, { fresh: true })
    noteFound(file, r.at, r.elements, r.all, { agent: false,
      aspect: r.width > 0 && r.height > 0 ? r.width / r.height : 0, frame: { width: r.width, height: r.height } })
  } catch (e) { console.warn('[rules] could not read', file, e && e.message) }
}

// The export refused, in the product's own words, with every finding and its fix.
function rulesRefusal(g) {
  const lines = [g.refused.why]
  for (const f of g.findings.filter(x => x.severity === 'blocking')) {
    lines.push(`${f.guideline}: ${f.what}` + (f.fix && f.fix.tool ? ` Fix: ${f.fix.tool} ${JSON.stringify(f.fix.args)}` : ''))
  }
  const err = new Error(lines.join('\n'))
  err.guidelines = g
  return err
}

// ── an export an agent can stop ──────────────────────────────────────────
// main.js submits an agent's export to the queue under an id of its own and hands this
// file nothing back, so the id is read off the queue the moment the job is submitted:
// submit is synchronous up to the push, and nothing else can submit in between. `key` is
// what the caller will cancel by (the MCP server mints one per call and sends it as
// args.job); ctx is the socket, so a client that goes away takes its exports with it.
const agentJobs = new Map()    // key -> { queue id, ctx }
function queueIds() {
  try { const j = require('./job-queue').jobs(); return [...j.queued, ...j.running] } catch { return [] }
}
let untracked = 0
function tracked(key0, ctx, submit, src) {
  // an export sent with no key is still held, under one of the bridge's own, so Esc, a
  // client going away and leaving the sample all reach it
  const key = key0 != null && key0 !== '' ? String(key0) : 'bridge:' + (++untracked)
  const before = new Set(queueIds())
  const p = submit()
  const id = queueIds().find(x => !before.has(x) && /^agent:/.test(String(x))) || null
  if (id) agentJobs.set(key, { id, ctx: ctx || null, src: src || null })
  const done = () => agentJobs.delete(key)
  return Promise.resolve(p).finally(done)
}
// Stop exports an agent started: one by its key, every one a client started, or all of
// them. Returns the queue ids it stopped.
function stopJobs(match) {
  const Q = require('./job-queue')
  const hit = []
  for (const [key, j] of [...agentJobs]) {
    if (!match(key, j)) continue
    if (Q.cancel(j.id)) hit.push(j.id)
    agentJobs.delete(key)
  }
  return hit
}
// The export's own error, said as a sentence. The queue's is the word "cancelled".
const STOPPED_SAID = 'The export was stopped before it finished. Nothing was written: the file that was there before is still there.'

// `facts` is passed where the caller has already worked them out, which is how a shot
// is measured on its shape alone rather than on a length it does not have.
/**
 * A brief whose size has a length window and no seconds of its own takes the window's
 * numbers. A store refuses a preview by its length, so a job aimed at one has a length
 * from the first call rather than from the export that refuses it, and the store's own
 * numbers live in one table (ui/sizes.js) rather than in the director.
 */
function briefWithSize(brief) {
  const b = typeof brief === 'string' ? { what: brief } : brief
  if (!b || typeof b !== 'object' || !b.size || b.seconds != null) return brief
  const got = require('./sizes').resolve(b.size)
  const win = got.ok && got.preset.kind === 'video' ? got.preset.seconds : null
  if (!win || !(win.max > 0)) return brief
  // The top of the window, because a preview is judged on what it shows and the longest
  // legal one shows the most. fit_to_length can be asked for less.
  return { ...b, seconds: win.max }
}

function jobState(file, doc, step, meta, given) {
  const Director = require('./director')
  try {
    const facts = given || editFacts(doc, meta)
    if (!step || !Director.read(file)) return Director.forEdit(file, facts)
    const r = Director.direct(file, { done: step }, { facts })
    return {
      plan: r.plan, distance: r.distance,
      ...(r.closed.length ? { closed: r.closed } : {}),
      ...(r.unknown.length ? { unknown: r.unknown,
        why: `no ${r.unknown.join(', ')} in the plan; direct names the steps and their ids` } : {}),
    }
  } catch { return null }
}

// What review reads beside the document: the brief from the job sidecar and the beats
// from the transcript. A take with neither still reviews, and says so in its findings.
// The captions of a take that nobody has opened in the editor. transcribe writes a
// .srt beside the recording, and the cues reach the document only when the editor loads
// the take and saves it back, so an agent that transcribed and went straight to review
// handed the rubric a document with no captions in it: the rubric then said the take was
// untranscribed and told it to call transcribe again. The same shape as edit.fit and the
// beats, and the same fix, in the two places that reason about cues rather than draw
// them (the renderers both fall back to the .srt themselves). Nothing is written back:
// the .srt is where a caption lives until somebody edits one.
function withCues(src, doc) {
  if (!doc || (doc.cues || []).length) return doc
  try {
    const cues = deps.proc.readCues(src) || []
    if (cues.length) return { ...doc, cues: cues.map((c, i) => ({ id: 'S' + (i + 1), ...c })) }
  } catch {}
  return doc
}

function briefAndBeats(file, meta) {
  let brief = null, beats = null, silent = false
  try { brief = (require('./director').read(file) || {}).brief || null } catch {}
  try { beats = deps.proc.beatsFor(file, meta && meta.duration) } catch {}
  try { silent = (!!meta && meta.hasAudio === false) || heardSilent.has(file) } catch {}
  // the take's own pixels, so the rubric can tell "no shape set" from "the shape asked for"
  return { brief, beats, silent, width: meta && meta.width, height: meta && meta.height }
}

// The take's own black and white points, which review holds a solid ground against. It
// is a demux of the keyframes, too much to pay before every reply, so it is asked for
// only where the rule reads it (review's own test: a background of kind solid) and kept
// per take and crop. A raw take does not change, so the answer does not either.
const takeLevelCache = new Map()
async function takeLevels(src, doc, meta) {
  const L = (doc && doc.look) || {}
  if (!L.background || L.background.kind !== 'solid') return null
  const crop = (doc && doc.crop) || null
  const key = `${src}|${JSON.stringify(crop)}`
  if (takeLevelCache.has(key)) return takeLevelCache.get(key)
  let lv = null
  try {
    lv = await require('./compositor/levels').measure(src, {
      crop, width: meta && meta.width, height: meta && meta.height, timeout: 8000,
      viewport: (doc && doc.viewport) || null, screen: (doc && doc.device && doc.device.screen) || null })
  } catch {}
  takeLevelCache.set(key, lv)
  return lv
}

// The key is the person's and it is entered by hand, in the editor, into the Keychain.
// An agent cannot connect an account for somebody, so the refusal names who can.
const NO_VOICE_ACCOUNT = 'No ElevenLabs account is connected. The person connects their own in the editor\'s ' +
  'Voiceover tab (their key goes to the Keychain and is never an argument here). Ask them to connect it, ' +
  'or record narration with record_start { mic: true } instead.'

function summarise(doc, path) {
  const r = n => Math.round(n * 100) / 100
  const Look = require('./look')
  const L = Look.resolve(doc.look)
  const cam = doc.camera
  return {
    duration: r(doc.dur || 0),
    // through outDuration, not a sum of the spans: a 20 second clip at 4x is five
    // seconds of the finished video, and this number is what the brief is measured on
    output: r(require('./fetchdoc').outDuration(doc)),

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
    camera: cam ? { recorded: true, on: cam.on !== false, x: cam.x, y: cam.y, size: cam.size,
      ...(Array.isArray(cam.keys) && cam.keys.length ? { keys: cam.keys } : {}) } : { recorded: false },
    audioTrack: doc.audioTrack ? { name: doc.audioTrack.name, volume: doc.audioTrack.volume,
      offset: doc.audioTrack.offset, replace: !!doc.audioTrack.replace } : null,
    // the look as the preset it came from and what differs (get_look_schema for every field)
    look: Look.compact(doc.look, looksDir()),
    audio: doc.audio,
    pointer: pointerSummary(path, doc),

    // the values each setting accepts, so an agent never has to guess a font name
    options: {
      // the system faces, and the ones the person's own projects carry, so a picture
      // of a product can be typeset in that product's face rather than in SF Pro
      fonts: [...(deps.proc.fontList ? deps.proc.fontList() : ['Helvetica']), ...projectFontNames()],
      looks: Look.list(looksDir()).map(p => p.name),
      // from the exporter's own list, so an image someone dropped in is offered to
      // agents the moment it exists, not when this line is edited
      backgroundImages: deps.proc.backdropList().filter(b => b.image).map(b => b.id),
      textStyles: ['title', 'lower-third', 'label'],
      markKinds: ['redact', 'blur', 'lift', 'spotlight', 'step', 'loupe', 'arrow'],
      cropAR: require('./look').CROP_ARS,
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
// Whether this take carries the keys that were pressed during it: on the document, or
// in the sidecar the capture side will write beside .cursor.json.
function hasKeyTrack(doc, file) {
  if (doc && (doc.keys || []).length) return true
  try { return fs.existsSync(deps.proc.sidecarIn(file, '.keys.json')) } catch { return false }
}

function lookWarnings(patch, doc, file, ctx) {
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
  // Every image id that really draws something, which is a longer list than the one the
  // picker offers: the three drawn gradients the photographs replaced still resolve to
  // the photograph nearest them (processor.js RETIRED_BACKDROPS), so a look saved last
  // month renders. Warning about one of those would be telling the truth about the
  // list and a lie about the export.
  try { images = deps.proc.imageBackdrops().map(b => b.id) } catch {}
  // Keystrokes are drawn from a key track on the take (ui/compositor/marks.js), and
  // Fetch does not capture the keyboard yet: reading it needs an event tap and the Input
  // Monitoring permission, which is a different promise to the person than "Fetch
  // watches the screen you pointed it at". Only where the agent asked for keys, because
  // keys.show is true by default and a take with no track simply draws none.
  if (patch && patch.keys && !hasKeyTrack(doc, file)) {
    out.push('keys are drawn from the keystrokes recorded with the take, and this take has none, so nothing ' +
      'is drawn. Fetch does not capture the keyboard yet. Say so rather than sending the look again, and use ' +
      'texts (a label) or marks (a step badge) to name a shortcut the person asks you to show.')
  }
  // Which renderer draws a field is a question about the engine, not about a release,
  // so the engine that will draw this output is passed where it is known (the export
  // knows both). Nothing given, the compositor answers, which is what draws the stage.
  return out.concat(Look.warnings(L, { viewport: !!(doc && doc.viewport), browser, images,
    // A take of a simulator, which has a screen rectangle to crop to where one was
    // measured and nothing to crop to where one was not. Without this the crop that
    // cannot happen happens silently, and the drawn phone comes out as a plain frame
    // with the Simulator's own toolbar still inside it.
    device: !!(doc && doc.device && doc.device.screen),
    // A shot says so, so the fields a capture cannot mean can be named rather than
    // silently doing nothing: frame.chrome clean has no viewport to draw against.
    // Null on a recording, not false: Look.warnings asks `still != null`, and false
    // called every recording a still frame drawn by the classic renderer.
    still: doc && doc.kind === 'shot' ? true : null,
    engine: ctx && ctx.engine, format: ctx && ctx.format, marks: doc && doc.marks }))
}

// Point the renderer's setup at what was asked for, reusing the same state the UI
// drives. Anything unspecified keeps the user's saved preference.
async function applySetup(win, args, heard) {
  const wanted = {
    display: args.display != null ? String(args.display) : null,
    window: args.window != null ? String(args.window) : null,
    // What a take listens to is ui/recorder-opts.js's call, with the reason and the
    // measurements written beside it. These used to fall back to the person's own
    // defaults, so an agent recording a browser window in the background turned on their
    // camera and microphone without anyone asking for either.
    mic: heard.mic,
    systemAudio: heard.systemAudio,
    camera: heard.camera,
    // Sound nobody asked for by name rides only on Fetch's own recorder. That recorder
    // now hears everything the Mac plays as well (Recorder.swift start: a filter naming
    // apps is what crashed replayd), so both paths hear the same and this flag only keeps
    // the older rule. Whether it should stay is ui/recorder-opts.js's.
    sysNativeOnly: !!(heard.systemAudio && heard.asked === 'default'),
  }
  // The take borrows the person's setup card. What it held is kept aside and put back
  // when the take ends (restorePersonSetup in app.js), or their next take would aim at
  // the agent's window, often closed by then, with their mic switched off.
  const js = `(async () => {
    const w = ${JSON.stringify(wanted)}
    if (!window.__personSetup) window.__personSetup = { mode: setup.mode, source: setup.source,
      window: setup.window, mic: setup.mic, sys: setup.sys, cam: setup.cam }
    window.__sysNativeOnly = !!w.sysNativeOnly
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
  // a restore is logged where it happens (ui/autosave.js, edit.restore, under this
  // agent's name), and a second row for the same act would read as two
  if (op === 'edit.versions' && result && result.restored && result.as) return
  let detail = null
  if (op === 'record.start' && result) detail = result.path
  else if (op === 'transcribe' && result) detail = `${result.words} words, ${result.cues} cues`
  else if (op === 'windows.list' && result) detail = `${result.length} windows`
  else if (op === 'projects.list' && result) detail = `${(result.projects || []).length} of ${result.count}`
  else if (op === 'projects.get' && result) detail = result.project ? result.project.name : result.why
  else if (op === 'recordings.list' && result) detail = `${result.length} take${result.length === 1 ? '' : 's'}`
  else if (op === 'probe' && args && args.path) detail = args.path
  else if (op === 'edit.silence' && result) detail = `${result.removed_percent}% removed, ${result.path}`
  else if (op === 'frame' && result) detail = `${result.at}s`
  else if (op === 'find' && result) detail = `${result.at}s${result.query ? `, "${result.query}"` : ''}`
  else if (op === 'edit.preview' && result) detail = (result.frames || [result]).map(f => `${f.at}s`).join(', ')
  else if (op === 'edit.sheet' && result) detail = `${result.count} frames, ${result.from} to ${result.to}s`
  else if (op === 'edit.direct' && result) detail = result.plan && result.plan.line
  else if (op === 'edit.review' && result) detail = result.summary
  else if (op === 'edit.fit' && result) detail = `${result.was}s to ${result.now}s`
  else if (op === 'edit.loop' && result) detail = result.loops ? 'it loops' : (result.faults || []).map(f => f.id).join(', ')
  else if (op === 'chat.ask' && result) detail = result.answered ? `they chose ${result.label}` : result.why
  else if (op === 'chat.propose' && result) detail = result.applied ? 'applied' : result.why
  else if (op === 'voice.speak' && result) detail = `${result.characters} characters, ${result.voice}`
  // the photographer, so the log line credits whoever took it too
  else if (op === 'photos.do' && result) {
    detail = result.photo ? `${result.photo}${result.credit ? ` · ${result.credit.text}` : ''}`
      : result.query ? `"${result.query}", ${(result.photos || []).length} photos`
        : `${(result.photos || []).length} photos`
  }
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
    // The person's answer to a question or a proposal, from the pane's own buttons and
    // from its own clock. The card has already settled itself there, so nothing is sent
    // back; this only frees the op that is waiting.
    ipcMain.on('chat-reply', (e, r = {}) => { if (r && r.id) settleWait(r.id, r.how || 'timeout', r.choice) })
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

  // A question cannot outlive the turn that asked it: the tool has long since been
  // handed its do_next, and a button still lit would answer into nothing.
  try { require('./agent-chat').onTurnEnd(how => {
    for (const id of [...waiting.keys()]) settleWait(id, how)
  }) } catch {}

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
    // an agent whose socket closed is done, so main.js can stop holding the brake for it
    // and nobody is left to collect what it was exporting, so that stops too
    sock.on('close', () => {
      try { stopJobs((k, j) => j.ctx === ctx) } catch {}
      try { if (deps.clientGone) deps.clientGone(ctx) } catch {}
    })
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

module.exports = { start, stop, socketPath, VERSION,
  // a project, from @ to its window: the chat turn's block (main.js chat-send), and the
  // pieces test/tools.test.js holds to their word
  projectTurn, resolveProject, unlistedFolderRefusal, productFor, projectTakeName, startingAgentTake, takeEndedAlone, stillNote, occludedTake, noteMoves, follow, checkTimes, liftable,
  // every op this bridge answers. test/tools.test.js walks it against the tools
  // mcp/index.js registers, because record.pause sat here unregistered for months and
  // a feature no agent can reach is a feature that does not exist.
  ops,
  // which files are a capture rather than a recording. One answer, so the tool surface
  // and anything testing it agree on what a shot is.
  isShot,
  // the lasso: main.js registers what the Elements pass found and the areas the person
  // drew, and apply_edit resolves R ids out of the same store
  noteFound, noteRegion, regionFor, forgetRegion,
  // the machine inside a Simulator window, for the capture paths in main.js: the never
  // record devices list can only be honoured by id, and the id is on the window or it is
  // nowhere (ui/record-policy.js windowsToExclude)
  attachDevices, simModel,
  // a place on the frame to a place on the glass, which is the one piece of arithmetic
  // between an element id and a touch. test/tools.test.js walks it against
  // ui/simulator.js pointToFrame, which is the same map pointing the other way.
  devicePoint,
  // the store size, and what the written file really is. Both are refusals more often
  // than they are answers, so test/tools.test.js runs them rather than reading them.
  storeSize, sizeVerdict,
  // which kind of identifier each simulator argument takes, read before anyone is asked
  simArgs, deviceHint,
  // where a take's sound sits against its picture, as record_stop and probe say it
  soundSync,
  // whether a pass kept on numbering from the list it was handed, which is what lets an
  // id off one screen of a device stand on the next (simScreen, find, simPoint)
  carriedOn,
  // one device's run of screens, driven by test/tools.test.js without a device: how a pass
  // joins the run, the prior the next pass is handed, and where a tap on an id is aimed
  deviceRun: { joinRun, runPrior, simPoint, aimFresh, tapSource, noteFound, see: (udid, file) => simSeen.set(udid, file),
    reset: () => {
      simSeen.clear(); simChain.clear(); chainOf.clear(); runTop.clear(); foundBy.clear(); lastFoundOn = null
      ledgers.clear(); idHome.clear(); pathTop.clear(); framesRead.clear()
    } },
  // the two rules that are code rather than prose, exercised by test/lasso.test.js
  withElements, aimZooms,
  // the person's answer to a question or a proposal. main.js does not call it: the
  // pane's reply is picked up here. test/tools.test.js does, to answer one for real.
  settleWait,
  // an Esc from the person takes back every "until Fetch quits" they gave (main.js stopAgent),
  // and stops every export an agent has queued or running: Esc stops the agent, and an
  // export it started is the agent still at work on the person's machine
  // the device an agent's take of a simulator is for, so native-start can name it to the
  // recorder (--sound-device) and the tap hears that device alone with two booted
  takeSoundDevice: () => (takeSim && takeSim.sim && takeSim.sim.udid) || null,
  forgetConsent: () => {
    sessionAllowed.clear()
    try { stopJobs(() => true) } catch {}
    // a dev server Fetch started for an agent the person has just stopped is that
    // agent's, and it goes with it
    try { stopStarted() } catch {}
  },
  // every dev server Fetch started, stopped: one left running is a port somebody has to
  // hunt for later, so Fetch does not leave them behind when it quits
  stopStartedServers: () => { try { stopStarted() } catch {} },
  // the same stop on its own, for a caller that wants it by name
  stopAgentJobs: () => stopJobs(() => true),
  // every export an agent has running on a take inside the sample, stopped before the
  // sample's folder is deleted (main.js 'sample-root'), and nothing of the person's
  stopSampleJobs: root => stopJobs((k, j) => !!(root && j.src && Sample.within(root, j.src))) }
