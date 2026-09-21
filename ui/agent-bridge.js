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
  'shot.take': 'Took a screenshot',
  'sim.do': 'Worked with a simulator',
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

    const win = deps.getWindow()
    if (!win || win.isDestroyed()) throw new Error('Fetch is not running')

    // A simulator is named by device and recorded as the window it sits in. That is the
    // whole of it: the take then has an audio track, which the framebuffer capture simctl
    // offers does not have at all, and every transcript-spine feature Fetch has reads
    // that track. What lands on it is what the window is playing, which is the honest
    // claim: the guest app's own sound through the speakers was never measured at a
    // level here, because measuring it means making a sound on somebody's Mac.
    // Nothing is brought to the front to do it.
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
    await enforceAccess({ ...args, kind: 'take', sim }, ctx)

    // macOS sends no frames for the part of a window another covers, so a take of a
    // covered window is a frozen picture. Say so before recording anything, with the
    // way round it, rather than hand back a take of stale frames (occludedTake).
    if (args.window != null && !args.allow_covered && deps.windowCovered) {
      const hold = occludedTake(await deps.windowCovered(args.window).catch(() => null))
      if (hold) return hold
    }

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
      if (sim && started && typeof started === 'object') {
        return { ...started, simulator: simFacts(sim, bar) }
      }
      return front && started && typeof started === 'object'
        ? { ...started, recording: { window: String(front.id), app: front.app, title: front.title || '', chosen: 'the app in front' } }
        : started
    } catch (e) {
      // Nothing is left dressed for a take that never started, which is what the comment
      // above the dressing has always claimed and what this makes true.
      const held = takeSim
      takeSim = null
      if (held) await simUndress(held.sim.udid)
      throw e
    }
  },

  async 'record.stop'() {
    if (!deps.isRecording() && endedTake && Date.now() - endedTake.at < 30 * 60e3) {
      const { at, ...r } = endedTake; endedTake = null
      return await simAfterTake(r)
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
      return await simAfterTake(await done)
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
      throw new Error(`${found.reason} simulator with action list says which devices are here.` +
        (fallback ? '' : ' With a recording of a simulator running, tap and restore take that device by default.'))
    }
    const sim = found.value
    if (action === 'ready') return await simReady(sim, args, ctx)
    if (action === 'go') return await simGo(sim, args, ctx)
    if (action === 'tap') return await simTap(sim, args, ctx)
    return await simRestore(sim)
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
    const region = args.region && typeof args.region === 'object' ? args.region : null
    let front = null, target = null
    // A simulator is a window, always. A region of the device screen is judged as a
    // display, sees whatever is under it, and gives frozen pixels where something covers
    // it, so the device is named and the glass is cropped to in the picture instead.
    const sim = args.simulator != null ? await simTarget(args.simulator) : null
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
    await enforceAccess({ kind: 'shot', window: target.windowId, display: target.displayId, sim }, ctx)
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
    const cap = { kind: got.kind, ...(got.app ? { app: got.app } : {}), ...(got.title ? { title: got.title } : {}) }
    // And where the glass is, on a simulator. That one rectangle is what crops the
    // device's own outline out of the picture, what turns a device point into a place on
    // the frame, and what lets the drawn phone be the only phone in the deliverable.
    const written = { captured: cap, ...(sim ? simOnDoc(sim) : {}) }
    const shot = await inEditor(file, `${docOf(file)}.apply(${JSON.stringify(written)})`)
      .catch(() => inEditor(file, `${docOf(file)}.get()`).catch(() => null))
    // The picture, with the capture. This is the one tool that makes the only artefact
    // in the job, and it was the one tool that handed back no image of it, so an agent
    // that cannot see the screen spent a second call looking at its own work.
    const p = shot ? await drawShot(shot, file, { width: 1280 }).catch(() => null) : null
    return {
      path: file, name, kind: 'shot',
      captured: { ...cap,
        width: got.width, height: got.height, scale: got.scale,
        ...(got.display != null ? { display: String(got.display) } : {}),
        ...(got.clipped ? { clipped: true } : {}),
        ...(front ? { chosen: 'the app in front' } : {}) },
      ...(sim ? { simulator: simFacts(sim, bar) } : {}),
      ...(shot ? { shot: summariseShot(shot, file) } : {}),
      ...(p ? { preview: { image: p.file, at: SHOT_AT, why: 'the capture as it stands, unstyled. Look at it before deciding what to do with it.' } } : {}),
      do_next: 'direct writes what the picture is for, apply_look styles it, find_on_screen names what is on it, ' +
        'apply_edit places marks and the headline on it, review checks it and export writes the PNG. ' +
        'The capture in Original/ is never touched.',
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
    if (isShot(args.path)) return await applyToShot(args)
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
    // A shot holds the same look an edit holds, whole and unconverted, so a preset
    // saved off a recording lands on a capture unchanged and this is one call, not two.
    if (isShot(args.path)) return await applyToShot({ ...args, doc: { look: patch } })
    const doc = await inEditor(args.path, `window.fetchDoc.apply(${JSON.stringify({ look: patch })})`)
    deps.proc.writeDoc(args.path, doc)
    const out = { look: Look.compact(doc.look, looksDir()) }
    const w = lookWarnings(patch, doc, args.path)
    if (w.length) out.look_warnings = w
    // The plan, and the step this call closes. Applying a look is a step of a job like
    // any other, and this was the one change tool that could not close one, so closing
    // it cost a direct call that did nothing else.
    Object.assign(out, jobState(args.path, doc, args.step, await takeShape(args.path)))
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
  async 'edit.export'(args = {}) {
    if (!args.path) throw new Error('path is required')
    if (isShot(args.path)) return await exportShot(args)
    const FD = require('./fetchdoc')
    const meta = await deps.proc.probeMeta(args.path).catch(() => ({}))
    const doc = deps.proc.readDoc(args.path, meta && meta.duration)
    if (!doc.clips.length) {
      // a recording nobody has edited has no clips yet; export all of it
      doc.clips = [{ id: 'C1', start: 0, end: (meta && meta.duration) || doc.dur }]
    }
    // An exact size on a recording, said plainly rather than written wrong. The picture
    // is drawn at the take's own shape or at 720 or 1080 tall, so a preview the store
    // measures to the pixel is not something this can write, and a file one pixel out is
    // rejected on upload. The other two rules it is judged by are worth the call anyway.
    if (args.size != null) {
      const Sizes = require('./sizes')
      const got = Sizes.resolve(args.size)
      if (!got.ok) throw new Error(got.reason)
      const p = got.preset
      const clip = p.kind === 'video' ? Sizes.checkClip({ seconds: FD.outDuration(doc), codec: 'h264' }, p.id) : null
      throw new Error(`${p.id} is ${p.w} by ${p.h} exactly and Fetch draws a video at the take's own shape ` +
        `or at 720 or 1080 tall, so it will not hand you a file and call it one. ` +
        (p.kind === 'still' ? 'That size is a screenshot: take_shot the device and export that instead. '
          : 'Export this at 1080 and tell the person it is not the store size. ') +
        ((clip && !clip.ok ? `While you are here: ${(clip.problems || []).join(', ')}.` : '')))
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
        looks: require('./look').list(looksDir()), levels: lv })
      checked = { verdict: c.verdict, score: c.score, summary: c.summary, blocking: Review.blocking(c), look_at: c.look_at }
    } catch {}
    // A clip meant to autoplay on a page is judged by its wrap, and the person is
    // holding the file now. Only where the look asks for a loop: it costs a plan.
    let loop = null
    if ((require('./look').resolve(doc.look).motion || {}).loop) {
      try { loop = await loopCheckOf(args.path, doc, meta) } catch {}
    }
    return { path: r && r.file, mb, seconds: +FD.outDuration(doc).toFixed(2), ...engine,
      ...(lw.length ? { look_warnings: lw } : {}),
      ...(checked ? { review: checked } : {}),
      ...(loop ? { loop } : {}),
      ...jobState(args.path, doc, null, meta) }
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
    const r = await deps.proc.findOnScreen(args.path, shot ? SHOT_AT : args.at, { crop, query: args.query, limit: args.limit })
    // only boxes measured in apply_edit's frame (after the crop) can be named there
    const all = r.all || r.elements
    // a card, grid or panel a lift would come out wrong on says so here, with the one
    // inside it to lift instead, so the agent does not have to be refused to learn it
    // the frame the elements were measured in, which is what turns the type ruler in
    // cutEdges onto the x axis: an ultrawide and a portrait crop are not 16:9
    const aspect = r.width > 0 && r.height > 0 ? r.width / r.height : 0
    const noLift = crop || args.cropped !== false
      ? noteFound(args.path, r.at, r.elements, all, { aspect })
      : liftNotes(r.elements, all, aspect)
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
    let doc = args.doc || deps.proc.readDoc(args.path, meta && meta.duration)
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
    if (!args.path) throw new Error('path is required')
    const Director = require('./director')
    // The job sidecar sits beside whatever it is a job about, and a screenshot is a job
    // like any other: a brief, steps, and the distance to both. Only the facts it is
    // measured on differ, and a still's are its shape alone.
    const facts = isShot(args.path)
      ? shotFacts(await shotOf(args.path))
      : editFacts(withCues(args.path, deps.proc.readDoc(args.path,
        (await deps.proc.probeMeta(args.path).catch(() => ({}))).duration)))
    const patch = { brief: args.brief, plan: args.plan, done: args.done, open: args.open, drop: args.drop, note: args.note }
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
    return require('./review').review({
      doc, ...briefAndBeats(args.path, meta), path: args.path,
      looks: require('./look').list(looksDir()),
      // a finding the agent judged and wrote down stops holding the verdict at "nearly"
      declined: args.declined,
      // the take's own ends, so the rule about a ground a take sinks into can run at all
      levels: await takeLevels(args.path, doc, meta),
    })
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
  async 'edit.fit'(args = {}) {
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
    // A length is chosen from what was said, so with nothing said this is a wasted
    // turn: it would hand back the edit it was given and a sentence nobody reads.
    if (!(w && w.words && w.words.length) && !(doc.cues || []).length && !(doc.beats || []).length) {
      throw new Error('No transcript, so there is nothing to choose from. Call transcribe on this take, then fit_to_length again.')
    }
    const r = Fit.fit(doc, {
      seconds: args.seconds, keep: args.keep, extra: args.fillers,
      words: (w && w.words) || null, speech: (w && w.speech) || null,
    })
    // The clips are in the document the moment they are applied, and get_edit names
    // them; sending them back here would be the same list twice (principle 6).
    const { clips, spans, ...out } = r
    if (args.apply === false || !clips.length) return { ...out, applied: false }
    const applied = await ops['edit.apply']({ path: args.path, doc: { clips }, step: args.step })
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
  async 'edit.revert'(args = {}) {
    if (!args.path) throw new Error('path is required')
    // One undo stack, keyed by the file, so taking back a change to a shot is the same
    // button the person has and the same call the agent already knew (ui/editor.js).
    const shot = isShot(args.path)
    const before = shot ? await shotOf(args.path) : deps.proc.readDoc(args.path, null)
    const undone = await inEditor(args.path, `window.fetchUndo ? window.fetchUndo.undo(${JSON.stringify(args.path)}) : false`)
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
    const doc = await inEditor(args.path, 'window.fetchDoc.get()')
    deps.proc.writeDoc(args.path, doc)
    const gone = removedIds(before, doc)
    return { ...summarise(doc, args.path), ...(gone.length ? { removed: { ids: gone, why: 'these went back out of the edit; say so in your reply' } } : {}),
      ...jobState(args.path, doc, null, await takeShape(args.path)) }
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

  async 'chat.propose'(args = {}) {
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
      return { ...(await ops['edit.apply']({ path: args.path, doc: args.doc, step: args.step })),
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
    const where = { root: app ? app.getPath('userData') : require('os').tmpdir(),
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

  async 'voice.speak'(args = {}) {
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
      doc: { audioTrack: { file, name, volume: 1, offset: args.offset || 0, replace: args.replace !== false } } })
    return { ...out, applied: true, audioTrack: applied.audioTrack,
      ...(applied.plan ? { plan: applied.plan } : {}), ...(applied.distance ? { distance: applied.distance } : {}) }
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
        // Read off what was captured, never off what was exported, so styling a shot
        // or cutting a take never moves it to the other side of the library.
        path: o.path, mb: o.mb, kind: isShot(o.path) ? 'shot' : o.kind, srt: o.srt,
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
    // A capture says its size in its own first few hundred bytes, so this costs one
    // short read where an ffprobe costs a process, and it says no rather than zero
    // about the things a picture does not have.
    if (isShot(args.path)) {
      const pic = require('./render-host').pictureSize(args.path)
      return { kind: 'shot', width: pic.width, height: pic.height, format: pic.kind,
        mb: +(fs.statSync(args.path).size / 1e6).toFixed(2),
        duration: null, fps: null, hasAudio: false }
    }
    const meta = await deps.proc.probeMeta(args.path)
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
    const r = await deps.proc.transcribe(args.path, {}, null, 'agent:transcribe')
    // Paths and counts, not payloads: a long transcript inline is thousands of tokens
    // of an agent's context for no benefit. The text is opt-in.
    const out = { srt: r.srt, txt: r.file, words: r.words, cues: (r.cues || []).length }
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
      ? await inEditor(args.path, 'window.fetchDoc.get()').catch(() => null) : null
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
async function enforceAccess(args, ctx) {
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
    app = hit && hit.app
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
    const key = (still ? 'shot|' : 'take|') +
      (sim ? 'udid:' + sim.udid : args.window != null ? 'app:' + (app || '') : 'display')
    if (sessionAllowed.has(key)) return
    const who = (ctx && ctx.client) || 'An agent'
    const what = sim ? `the ${sim.name} simulator`
      : args.window != null ? `a ${app || 'window'} window` : 'your whole screen'
    const answer = await askPerson(
      `${who} wants to ${still ? 'take a screenshot of' : 'record'} ${what}.`,
      (args.window != null
        ? 'Only that window is captured, in the background, even while you work in front of it.'
        : 'Apps on your never-record list are left out of the frame.') +
      (still
        ? ' One frame is written, now. Nothing keeps running afterwards.'
        : ' The menu bar icon turns red while it records.'),
      sim
        ? `Allow ${still ? 'screenshots of ' : ''}${sim.name} until Fetch quits`
        : args.window != null
          ? `Allow ${still ? 'screenshots of ' : ''}${app || 'this app'} until Fetch quits`
          : null,
      still)
    if (answer === 'unanswered') throw new Error(`Fetch refused to ${act}: ${verdict.unanswered}`)
    if (answer === 'no') throw new Error(`Fetch refused to ${act}: the person at the Mac said no`)
    if (answer === 'session') sessionAllowed.add(key)
  }
}

// Approvals given with "until Fetch quits". In memory only, so a restart asks again.
const sessionAllowed = new Set()

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
async function askPerson(message, detail, sessionLabel, still = false, allowLabel = null) {
  const { dialog } = require('electron')
  // Driving somebody's device is not recording it, so the button says which it is.
  const buttons = [allowLabel || (still ? 'Allow this shot' : 'Allow this take'),
    ...(sessionLabel ? [sessionLabel] : []), 'Don\'t allow']
  const no = buttons.length - 1
  let timer = null
  const asked = dialog.showMessageBox({
    type: 'question', message, detail, buttons, defaultId: no, cancelId: no, noLink: true,
  }).then(r => (r.response === 0 ? 'once' : (sessionLabel && r.response === 1) ? 'session' : 'no'), () => 'no')
  try {
    const waited = new Promise(res => { timer = setTimeout(() => res('unanswered'), ASK_WAIT_MS) })
    return await Promise.race([asked, waited])
  } finally { if (timer) clearTimeout(timer) }
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
  return Sim.simulators({ devices, runtimes, deviceTypes: types.ok ? types.value : null,
    profiles, windows: wins, scaleOf: displayScale })
}

/**
 * The scale factor of the display a window is on, or null where it cannot be told.
 *
 * Not the primary display's: with the Simulator window on a 1x external screen beside a
 * Retina main one, the primary reads 2 where the window is really 1, so a density of 0.3
 * is reported as 0.6 and a store export that should be refused ships an upscale. The
 * window list carries the window's own origin for exactly this (WindowList.swift), and
 * with no origin there is no answer: null, and no density, rather than a guess.
 */
function displayScale(win) {
  const x = +(win && win.x), y = +(win && win.y)
  const w = +(win && win.w) || 0, h = +(win && win.h) || 0
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  try {
    const d = require('electron').screen.getDisplayMatching({ x, y, width: Math.max(1, w), height: Math.max(1, h) })
    return (d && d.scaleFactor) || null
  } catch { return null }
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
  if (!found.ok) throw new Error(`${found.reason} simulator with action list says which devices are here.`)
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
      'where it sits: nothing is brought to the front, and the take has an audio track where a capture ' +
      'of the device framebuffer has none at all. ' +
      'density is captured pixels per pixel the device has; under 1 a store sized export would be ' +
      'an upscale and is refused.',
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
    ...(sim.density != null ? { density: sim.density } : {}),
    ...(Sim.densityNote(sim) ? { density_note: Sim.densityNote(sim) } : {}),
    ...(bar && bar.said ? { status_bar: `Fetch set ${bar.said}, and puts back ${bar.restores} when this is over` } : {}),
    ...(bar && bar.failed ? { status_bar: `the status bar was left alone: ${bar.failed}` } : {}),
  }
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
  const who = (ctx && ctx.client) || 'An agent'
  const answer = await askPerson(`${who} ${say.wants} ${sim.name}.`, say.detail,
    say.session ? `${say.session} until Fetch quits` : null, false, say.allow)
  if (answer === 'unanswered') {
    throw new Error(`Fetch refused: driving somebody's device needs their word, and nobody was at the ` +
      'Mac to give it. Ask them in the chat and try again.')
  }
  if (answer === 'no') throw new Error('Fetch refused: the person at the Mac said no.')
  if (answer === 'session') sessionAllowed.add(key)
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
  const bundle = args.bundle ? String(args.bundle) : null
  const will = [
    sim.booted ? null : 'boot it',
    sim.window ? null : 'open Simulator in the background, without bringing it to the front',
    app ? `install ${path.basename(app)}` : null,
    bundle ? `launch ${bundle}` : null,
    args.status_bar === false ? null : 'set the status bar to 9:41 with full bars and a charged battery, and put your own back afterwards',
    args.appearance ? `switch it to ${String(args.appearance).toLowerCase()}` : null,
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
    if (!fs.existsSync(app)) throw new Error(`there is no app bundle at ${app}. Build it first, and send the path to the .app.`)
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
  const now = await simSettled(sim.udid, sim.window ? 0 : 25000)
  return {
    ...simFacts(now || sim, bar),
    changed,
    restore: 'record_stop puts the status bar back on its own. simulator with action restore does it by hand, ' +
      'and so does the next launch if Fetch dies mid take.',
    do_next: `record_start { simulator: '${sim.udid}' } records that window, with sound, ` +
      'find_on_screen on a shot of it names what is on the glass, and simulator with action tap taps the id it hands back.',
  }
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
    wants: 'wants to open a link on', detail: `The link is ${url}. It opens on the device, not on your Mac.`,
    allow: 'Open it', session: `Allow links on ${sim.name}`,
  })
  simAllowed('openurl', sim, ['openurl'])
  const r = await simctl().openurl(sim.udid, url)
  if (!r.ok) throw new Error(r.reason)
  return { udid: sim.udid, device: sim.name, opened: url,
    do_next: 'take_shot with simulator to see where it landed, then find_on_screen to name what is on it.' }
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
  const pt = await simPoint(sim, args)
  await simAsk('tap', sim, ctx, {
    wants: 'wants to send a tap to', detail: 'The touch goes into the device\'s own input path. It never moves this ' +
      'Mac\'s mouse and never presses its keyboard.',
    allow: 'Allow this tap', session: `Allow taps on ${sim.name}`,
  })
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
  return {
    udid: sim.udid, device: sim.name,
    tapped: { x: pt.x, y: pt.y, units: 'device points' }, aimed: pt.aimed, by: r.value.by,
    ...(drawn ? { drawn: { x: drawn.x, y: drawn.y, at: drawn.at, points: drawn.points } } : {}),
    ...(note ? { note } : {}),
    do_next: 'find_on_screen again before the next tap: the screen has moved and the ids are minted per pass.',
  }
}

// Where on the glass, in the device's own points. Everything in between is the take's:
// the element's box is measured in the frame the edit works in, so the crop goes back on
// before the viewport comes off.
async function simPoint(sim, args) {
  if (!sim.screen || !sim.viewport) {
    throw new Error(`Fetch cannot tell where ${sim.name}'s own screen sits inside its window, so there is ` +
      'nowhere for a tap to land. simulator with action list says what is known about the device, and ' +
      'ready opens its window.')
  }
  const pts = sim.glass || sim.screen.points
  if (args.element != null) {
    if (!args.path) {
      throw new Error('a tap on an element needs path as well: the shot or recording find_on_screen was ' +
        'called on, which is where that id was minted.')
    }
    const seen = foundBy.get(args.path) || null, mine = foundFor.get(args.path) || null
    const box = resolveElement(args.path, seen, mine, null, { element: args.element }).box
    const crop = await cropOfTake(args.path)
    const fx = crop ? crop.x + crop.w * (box.x + box.w / 2) : box.x + box.w / 2
    const fy = crop ? crop.y + crop.h * (box.y + box.h / 2) : box.y + box.h / 2
    return { ...devicePoint(sim, fx, fy), aimed: `the middle of ${String(args.element).toUpperCase()}` }
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

// The end of a take of a device: the glass rectangle onto the document, and everything
// Fetch changed put back. Both happen whatever the take did.
async function simAfterTake(r) {
  const held = takeSim
  takeSim = null
  if (!held) return r
  const back = await simUndress(held.sim.udid)
  let wrote = null
  try {
    // through follow(), because a take is renamed from what was said shortly after it
    // lands and the path this call is holding may already have moved
    const src = r && r.path ? follow(r.path) : null
    if (src && fs.existsSync(src)) {
      const meta = await deps.proc.probeMeta(src).catch(() => ({}))
      const doc = deps.proc.readDoc(src, meta && meta.duration)
      // A finger, not an arrow, without anybody setting anything: the look decides the
      // mark and the take's target decides the look. Inert until ui/look-schema.js
      // carries cursor.style, because Look.merge keeps only what the schema names.
      const look = { ...(doc.look || {}), cursor: { ...((doc.look || {}).cursor || {}), style: 'touch' } }
      const out = deps.proc.writeDoc(src, { ...doc, look, ...simOnDoc(held.sim) })
      wrote = 'the device screen rectangle is on the edit, so the look crops to the glass and the ' +
        'drawn phone is the only phone in the picture'
      if (out && out.look && out.look.cursor && out.look.cursor.style === 'touch') {
        wrote += ', and the pointer track draws a finger rather than an arrow'
      }
    }
  } catch (e) { wrote = `the device could not be written onto the edit: ${(e && e.message) || e}` }
  return { ...r, simulator: { ...simFacts(held.sim, held.bar),
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
  const swap = list => !Array.isArray(list) ? list : list.map(it => {
    const aimed = it && it.element ? resolveElement(src, seen, mine, crop, it) : it
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
    const { box, ...rest } = resolveElement(src, seen, mine, crop, it)
    return box ? { ...rest, at: { x: r4(box.x + box.w / 2), y: r4(box.y + box.h / 2) } } : rest
  })
  return { ...doc, ...(doc.zooms ? { zooms: swap(doc.zooms) } : {}), ...(doc.marks ? { marks: swap(doc.marks) } : {}),
    ...(doc.texts ? { texts: pin(doc.texts) } : {}) }
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
function noteFound(path, at, elements, all, { agent = true, aspect = 0 } = {}) {
  const list = all || elements || []
  const notes = liftNotes(elements, list, aspect)
  const boxes = new Map((elements || []).map(e => [e.id, e.box]))
  // an element named only inside a refusal is still one the agent may aim at
  for (const b of notes.values()) {
    if (b.instead) boxes.set(b.instead.id, b.instead.box)
    if (b.around) boxes.set(b.around.id, b.around.box)
  }
  // the frame's own shape, kept so apply_edit judges a lift by the same ruler the search
  // did: a type-sized padding is square on the screen and not in fractions of the frame
  ;(agent ? foundBy : foundFor).set(path, { at, boxes, all: list, aspect })
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
  // The two below both say the thing to lift is inside the refused element. For a line of
  // words it is the other way round: the thing to lift is the card around them.
  if (b.around) return `${b.why}; to lift it, lift ${name(b.around)}, the card the words sit in`
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
    if (seen && seen.all && seen.all.length && Math.abs(seen.at - at) <= 0.75) return seen.all
  }
  if (!deps.proc || !deps.proc.findOnScreen) return null
  try {
    const r = await deps.proc.findOnScreen(src, at, { crop: crop && crop.w > 0 ? crop : null, limit: 40 })
    // Fetch's own pass, so it does not renumber the E ids the agent is holding
    noteFound(src, r.at, r.elements, r.all, { agent: false,
      aspect: r.width > 0 && r.height > 0 ? r.width / r.height : 0 })
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
  const shot = await inEditor(src, `${docOf(src)}.get()`)
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
async function applyToShot(args) {
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
  const shot = await inEditor(args.path, `${docOf(args.path)}.apply(${JSON.stringify(doc)})`)
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
  return require('./review').review({
    doc: shot, brief, path: args.path, declined: args.declined,
    looks: require('./look').list(looksDir()),
    levels: await shotLevels(shot),
  })
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
function memoryState(file) {
  try {
    const Memory = require('./memory')
    const r = Memory.recallFor({ root: app ? app.getPath('userData') : require('os').tmpdir(), take: file || null })
    return r && r.text ? { memory: r.text } : null
  } catch { return null }
}

// `facts` is passed where the caller has already worked them out, which is how a shot
// is measured on its shape alone rather than on a length it does not have.
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
  try { silent = !!meta && meta.hasAudio === false } catch {}
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
      crop, width: meta && meta.width, height: meta && meta.height, timeout: 8000 })
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
      fonts: (deps.proc.fontList ? deps.proc.fontList() : ['Helvetica']),
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
  try { images = deps.proc.backdropList().filter(b => b.image).map(b => b.id) } catch {}
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
    // A shot says so, so the fields a capture cannot mean can be named rather than
    // silently doing nothing: frame.chrome clean has no viewport to draw against.
    still: !!(doc && doc.kind === 'shot'),
    engine: ctx && ctx.engine, format: ctx && ctx.format, marks: doc && doc.marks }))
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
  else if (op === 'edit.sheet' && result) detail = `${result.count} frames, ${result.from} to ${result.to}s`
  else if (op === 'edit.direct' && result) detail = result.plan && result.plan.line
  else if (op === 'edit.review' && result) detail = result.summary
  else if (op === 'edit.fit' && result) detail = `${result.was}s to ${result.now}s`
  else if (op === 'edit.loop' && result) detail = result.loops ? 'it loops' : (result.faults || []).map(f => f.id).join(', ')
  else if (op === 'chat.ask' && result) detail = result.answered ? `they chose ${result.label}` : result.why
  else if (op === 'chat.propose' && result) detail = result.applied ? 'applied' : result.why
  else if (op === 'voice.speak' && result) detail = `${result.characters} characters, ${result.voice}`
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
  // the two rules that are code rather than prose, exercised by test/lasso.test.js
  withElements, aimZooms,
  // the person's answer to a question or a proposal. main.js does not call it: the
  // pane's reply is picked up here. test/tools.test.js does, to answer one for real.
  settleWait }
