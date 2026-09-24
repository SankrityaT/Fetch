// Exports, whichever renderer draws them. Main-process module.
//
// exportEdit takes the same options as processor.applyEdit and answers the same way,
// plus which engine drew the file. The compositor (ui/compositor/) draws an edit when
// it can draw everything the edit uses; anything else, or a compositor that fails,
// goes to the classic ffmpeg renderer, and the result says why. FETCH_ENGINE=classic
// or gl forces one (gl leaves out what it cannot draw yet, for measuring).
//
// Every container with a picture in it comes from the same drawn frames and differs only
// at the encoder: MP4 and MOV H.264, WebM VP9, GIF a palette pass. What changes here is
// what has to be muxed alongside. A GIF has no sound at all, so none is rendered and the
// picture file is the deliverable; a WebM cannot carry the AAC the app's one audio graph
// writes, so its track is turned into Opus at the mux and nowhere earlier.
//
// The compositor runs in one hidden window, kept warm between exports and closed after
// a while idle. Throttling is off and it paints while hidden (M0: a never-painted
// window stops rVFC; GL and MessageChannel run at full speed either way). The window
// spawns its own ffmpeg children, so frames never cross IPC; their pids come back here
// so a cancel can kill them. The sound is rendered here with ffmpeg at the same time
// and muxed with the picture at the end.

const { app, BrowserWindow, ipcMain } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')
const proc = require('../processor')
const jobQueue = require('./job-queue')
const Plan = require('./compositor/plan')
const Prepare = require('./compositor/prepare')
const Sinks = require('./compositor/sinks')

const IDLE_MS = 3 * 60 * 1000
let win = null, ready = null, idleTimer = null
const jobs = new Map()          // id -> { resolve, reject, onProgress, pids, stopped, ended }
// Window jobs that were cancelled and given up on before the window answered. A pid the
// window reports for one of them after that is killed, not ignored (id -> when)
const abandoned = new Map()
let seq = 0

// ---- cancel ----------------------------------------------------------------
// A cancel is processor.cancel(jobId): it kills what is registered under the id at that
// instant and forgets the id. On an idle machine an export has a child registered almost
// the whole way through, so that was enough. On a loaded one it is not. The first
// seconds of an export (probing the take, preparing the plan, starting the render window)
// can have nothing registered at all, and a cancel that lands there found nothing, said
// false, and was lost: the export ran on to the end, which at a load of 200 is a quarter
// of an hour. A child started after the cancel was never killed either, since the id had
// been forgotten, and the window's own ffmpegs report their pids a message later.
//
// So an export holds a stand-in under its id from its first line to its last. A cancel
// always finds it, and from then on:
//   the caller hears "cancelled" at once, without waiting on anything the load can slow
//   every child registered under the id dies at once (SIGKILL, which a starved process
//     cannot put off)
//   a child registered under the id afterwards dies within SWEEP_MS of starting
//   a pid the render window reports afterwards dies the moment it arrives
//   the window stops at its next frame, and one that has not answered in GRACE_MS is
//     closed if it has nothing else to draw
// The work behind the answer is stopped at its next await rather than left to finish,
// and the sweep that keeps it stopped ends when that work settles, or after SWEEP_CAP_MS.
const SWEEP_MS = 250
const SWEEP_CAP_MS = 60 * 1000
const GRACE_MS = 5000

const cancelledError = () => Object.assign(new Error('cancelled'), { cancelled: true })

function cancelGuard(jobId) {
  let hit = null, sweep = null, capTimer = null, quiet = false, off = false
  const stopped = new Promise((_resolve, reject) => { hit = reject })
  stopped.catch(() => {})
  const g = { cancelled: false, stopped }
  const stand = {
    kill() {
      if (quiet || g.cancelled) return
      g.cancelled = true
      hit(cancelledError())
      if (off) return
      sweep = setInterval(() => proc.cancel(jobId), SWEEP_MS)
      capTimer = setTimeout(g.release, SWEEP_CAP_MS)
    },
  }
  // stop at the next await if a cancel has come in
  g.check = () => { if (g.cancelled) throw cancelledError() }
  // the work is over, one way or the other: nothing left to sweep for
  g.release = () => {
    off = true
    clearInterval(sweep); clearTimeout(capTimer)
    proc.unregister(jobId, stand)
  }
  // kill the children under the id without taking it for a cancel: a picture that fails
  // stops its sound, and the classic renderer it falls back to runs under the same id
  g.killChildren = () => {
    quiet = true
    try { proc.cancel(jobId, { keep: true }) } finally { quiet = false }
    if (!off && !g.cancelled) proc.register(jobId, stand)
  }
  if (jobId == null) return Object.assign(g, { check() {}, release() {}, killChildren() {} })
  proc.register(jobId, stand)
  return g
}

// The answer the caller waits for: the work's own, or "cancelled" the moment one comes
// in. The work itself is kept stopped by the guard until it has actually settled.
//
// Work that runs inside a queued job (ui/job-queue.js) can also be stopped by the queue's
// id, which is the only id an agent's export has anyone holding: main.js makes the jobId
// passed here a moment after the queue's and keeps neither. A cancel through the queue
// is the same processor.cancel(jobId) a person's Cancel is, so it kills the same
// children, leaves the same tombstone, and keeps the same sweep going.
function guarded(jobId, work) {
  const g = cancelGuard(jobId)
  const unhook = jobId == null ? () => {} : jobQueue.onCancel(() => proc.cancel(jobId))
  let p
  try { p = Promise.resolve(work(g)) } catch (e) { p = Promise.reject(e) }
  const done = () => { unhook(); g.release() }
  p.then(done, done)
  // the queue's lane is held on the work itself, not on the race, so a cancelled export
  // keeps it until its children have stopped
  jobQueue.working(p)
  return Promise.race([p, g.stopped])
}

function closeWindow() {
  if (win && !win.isDestroyed()) win.destroy()
  win = null; ready = null
}

function renderWindow() {
  if (win && !win.isDestroyed() && ready) return ready
  win = new BrowserWindow({
    show: false, width: 320, height: 200, focusable: false, skipTaskbar: true, frame: false,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      nodeIntegration: true, nodeIntegrationInWorker: true, contextIsolation: false, sandbox: false,
      backgroundThrottling: false,
    },
  })
  const w = win
  ready = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('the render window did not start')), 15000)
    ipcMain.once('render:ready', () => { clearTimeout(t); resolve(w) })
    w.webContents.once('did-fail-load', (_e, code, desc) => { clearTimeout(t); reject(new Error('render window: ' + desc)) })
  })
  // a window that never started is not kept: the next export tries a fresh one rather
  // than failing on this promise for the rest of the session
  ready.catch(() => { if (win === w) { try { w.destroy() } catch {} win = null; ready = null } })
  // a crash fails whatever it was drawing; the next export starts a fresh window
  w.webContents.on('render-process-gone', (_e, d) => {
    for (const [id, j] of jobs) { jobs.delete(id); j.end(); j.reject(new Error('the compositor stopped: ' + d.reason)) }
    if (win === w) { win = null; ready = null }
  })
  w.on('closed', () => { if (win === w) { win = null; ready = null } })
  if (process.env.FETCH_DEBUG_RENDER) w.webContents.on('console-message', (_e, _l, msg) => console.log('[render]', msg))
  w.loadFile(path.join(__dirname, '..', 'render.html'))
  return ready
}

// The render window must not keep the app open once every real window has closed:
// with nothing drawing, it goes too, and window-all-closed quits as it always has
app.on('browser-window-created', (_e, w) => w.on('closed', () => {
  if (w === win || jobs.size) return
  if (BrowserWindow.getAllWindows().every(x => x === win || x.isDestroyed())) closeWindow()
}))

ipcMain.on('render:progress', (_e, m) => {
  const j = jobs.get(m.id)
  if (j && j.onProgress) j.onProgress(m.n, m.total)
})
ipcMain.on('render:pid', (_e, m) => {
  const j = jobs.get(m.id)
  // a window starved past its grace can still start an ffmpeg for a job it was told to
  // stop: that one was left running for good, writing a picture nobody would collect
  if (!j) { if (abandoned.has(m.id)) { try { process.kill(m.pid, 'SIGKILL') } catch {} } return }
  j.pids.add(m.pid)
  // an ffmpeg the window started just before the cancel reached it
  if (j.stopped) { try { process.kill(m.pid, 'SIGKILL') } catch {} }
})
ipcMain.on('render:done', (_e, m) => {
  const j = jobs.get(m.id)
  if (!j) return
  jobs.delete(m.id)
  clearTimeout(j.grace)
  j.end()
  if (m.error) j.reject(Object.assign(new Error(m.error), { cancelled: !!m.cancelled }))
  else j.resolve(m.stats)
})

// One job drawn in the render window: an export's picture, or stills. guard is the
// export's own (cancelGuard); without one the work cannot be cancelled and runs to its end.
async function drawInWindow(msg, onProgress, jobId, guard) {
  clearTimeout(idleTimer)
  const w = await renderWindow()
  // a cancel that came in while the window was starting: nothing is sent to it
  if (guard) guard.check()
  const id = ++seq
  const entry = { onProgress, pids: new Set(), stopped: false, grace: null }
  // settles when the window's work on this job is really over, not when its caller was
  // answered: what the export cleans up after a cancel waits on this
  entry.ended = new Promise(resolve => { entry.end = resolve })
  if (guard) guard.drawn = entry.ended
  // processor.cancel(jobId) kills every child registered under the job: this one stands
  // for the window's work, and kills its ffmpegs too in case the window is busy. It
  // answers "cancelled" at once and gives the window GRACE_MS to say it has stopped; a
  // window too starved to answer by then is closed, unless another job is drawing in it,
  // and the next export starts a fresh one.
  const stand = {
    kill() {
      if (entry.stopped) return
      entry.stopped = true
      if (!w.isDestroyed()) w.webContents.send('render:cancel', id)
      for (const pid of entry.pids) { try { process.kill(pid, 'SIGKILL') } catch {} }
      if (entry.reject) entry.reject(cancelledError())
      entry.grace = setTimeout(() => {
        if (jobs.get(id) !== entry) return
        jobs.delete(id)
        for (const pid of entry.pids) { try { process.kill(pid, 'SIGKILL') } catch {} }
        const now = Date.now()
        for (const [k, t] of abandoned) if (now - t > SWEEP_CAP_MS) abandoned.delete(k)
        abandoned.set(id, now)
        entry.end()
        if (win === w && !jobs.size) { console.warn('[render] the window did not stop, closing it'); closeWindow() }
      }, GRACE_MS)
    },
  }
  if (jobId != null) proc.register(jobId, stand)
  try {
    return await new Promise((resolve, reject) => {
      Object.assign(entry, { resolve, reject })
      jobs.set(id, entry)
      w.webContents.send('render:job', { ...msg, id, fonts: fontsWanted(msg) })
    })
  } finally {
    if (jobId != null) proc.unregister(jobId, stand)
    closeWhenIdle()
  }
}

// ── the fonts a job names ───────────────────────────────────────────────
//
// The compositor names faces by CSS family, and a family the render window never
// registered falls back to system-ui silently. So every font named anywhere in a job
// that is not one of the system faces is looked for in the person's own projects, and
// the file is sent with the job. A product filmed from its own repository gets typeset
// in the face that repository ships, which is the whole point: a title card over
// somebody's app should not be in the system font beside a screen that is not.
//
// Lazy and cached: nothing is scanned until a job names a family Fetch does not
// already have, and the answer is kept, misses included, so a font nobody has is
// looked for once rather than on every frame of every export.
const projectFonts = require('./project-fonts')
const SYSTEM_FAMILY = new Set(['SF Pro', 'SF Pro Rounded', 'SF Mono', 'New York',
  'Helvetica', 'Avenir Next', 'Georgia', 'Impact'])
const fontFound = new Map()

function familiesIn(v, out = new Set(), depth = 0) {
  if (!v || typeof v !== 'object' || depth > 8) return out
  if (Array.isArray(v)) { for (const x of v) familiesIn(x, out, depth + 1); return out }
  for (const [k, x] of Object.entries(v)) {
    if ((k === 'font' || k === 'titleFont') && typeof x === 'string' && x && !SYSTEM_FAMILY.has(x)) out.add(x)
    else familiesIn(x, out, depth + 1)
  }
  return out
}

function findFamily(family) {
  if (fontFound.has(family)) return fontFound.get(family)
  let hit = null
  try {
    for (const proj of require('./projects').projectIndex() || []) {
      const root = proj && (proj.path || proj.dir)
      if (!root) continue
      const found = projectFonts.fontsIn(root).find(f => f.family === family)
      if (found) { hit = found; break }
    }
  } catch { hit = null }
  fontFound.set(family, hit)
  return hit
}

function fontsWanted(msg) {
  const out = []
  for (const family of familiesIn(msg)) {
    const hit = findFamily(family)
    if (hit) out.push(hit)
  }
  return out
}

// Draw the picture of one export in the render window
const renderPicture = (job, onProgress, jobId, guard) => drawInWindow(job, onProgress, jobId, guard)

// A warm window costs memory while nothing draws: it goes after a few idle minutes
function closeWhenIdle() {
  clearTimeout(idleTimer)
  idleTimer = setTimeout(() => { if (!jobs.size) closeWindow() }, IDLE_MS)
}

// Which engine an export would use, without running it
function pickEngine(src, opts = {}) {
  const mode = opts.engine || process.env.FETCH_ENGINE || 'auto'
  return Plan.engineFor(opts, {}, mode)
}

// The plan of an edit with everything its take says worked out (prepare.js). extra goes
// into the plan's ctx: { fps } is how a GIF asks for its own slower clock.
async function planFor(src, opts, meta, jobId, extra = null) {
  const prepared = await Prepare.prepareRender(src, opts, { meta, jobId })
  const camera = opts.camera && opts.camera.file && fs.existsSync(opts.camera.file) ? opts.camera : null
  const ctx = { prepared, gutter: prepared.gutter || null, imageFile: prepared.imageFile || null, ...(extra || {}) }
  return Plan.prepare({ ...opts, camera }, meta, ctx)
}

// The sound the mux carries. renderAudio writes the app's one audio graph, and what it
// writes is AAC; a WebM cannot hold AAC, so Opus is made here from the finished track
// rather than by giving that graph a second codec to know about.
function audioCopy(fmtId, sound) {
  if (!sound) return []
  return fmtId === 'webm' ? ['-c:a', 'libopus', '-b:a', '128k', '-ar', '48000', '-ac', '2'] : ['-c:a', 'copy']
}

// tmpdir and the save folder are not always the same volume, and a rename across two
// fails; a GIF is the only deliverable that arrives whole and has no mux to move it
function moveInto(from, to) {
  try { fs.renameSync(from, to) } catch { fs.copyFileSync(from, to); try { fs.unlinkSync(from) } catch {} }
}

// The classic renderer writes its partial beside where it is told to and renames it in
// the moment its ffmpeg exits. A cancel that lands in the last instant of that ffmpeg
// found a clean exit, and the deliverable was replaced after the caller had been told
// "cancelled". So it is told a staging name beside the deliverable, and the file is
// moved in here, after the same last check the compositor's export makes.
async function classic(src, opts, onProgress, jobId, why, guard = null) {
  const fmt = proc.FORMATS[opts.format || 'mp4'] || proc.FORMATS.mp4
  const dest = opts.dest || proc.exportDest(src, fmt.ext)
  const staged = path.join(path.dirname(dest), `.${path.parse(dest).name}.staged${path.extname(dest) || '.' + fmt.ext}`)
  try {
    const r = await proc.applyEdit(src, { ...opts, dest: staged }, onProgress, jobId)
    if (guard) guard.check()
    fs.renameSync(staged, dest)
    const mb = +(fs.statSync(dest).size / 1e6).toFixed(1)
    return { ...r, file: dest, mb, engine: 'classic', why }
  } finally {
    try { fs.unlinkSync(staged) } catch {}
  }
}

/**
 * Export an edit. Same arguments and result as processor.applyEdit, plus
 * { engine: 'gl' | 'classic', why: [...] } and, for the compositor, its timings.
 */
function exportEdit(src, opts = {}, onProgress, jobId) {
  return guarded(jobId, guard => exportWith(src, opts, onProgress, jobId, guard))
}

async function exportWith(src, opts, onProgress, jobId, guard) {
  let pick
  try { pick = pickEngine(src, opts) } catch (e) { pick = { engine: 'classic', why: ['could not read the take: ' + e.message] } }
  // An exact size is the compositor's alone: the classic renderer scales to 720 or 1080
  // and knows nothing about a pair of integers, so falling back to it would write a file
  // of the wrong shape and call it a store deliverable. Refused in words instead, with
  // what kept it off the compositor, since that is the thing to fix.
  const store = opts.size && +opts.size.w > 0 && +opts.size.h > 0
  if (store && pick.engine !== 'gl') {
    throw new Error(`an exact ${Math.round(+opts.size.w)} by ${Math.round(+opts.size.h)} file is drawn by the ` +
      `compositor and this export cannot use it: ${pick.why.join(', ')}. Export it without size, or fix what ` +
      'is named here and ask again.')
  }
  if (pick.engine !== 'gl') return classic(src, opts, onProgress, jobId, pick.why, guard)
  try {
    return await glExport(src, opts, onProgress, jobId, pick.why, guard)
  } catch (e) {
    if (e && e.cancelled) throw e
    if (store) throw e
    guard.check()
    console.warn('[render] compositor failed, using the classic renderer:', e && e.message)
    return classic(src, opts, onProgress, jobId, [...pick.why, 'the compositor failed: ' + (e && e.message)], guard)
  }
}

async function glExport(src, opts, onProgress, jobId, why, guard) {
  if (!src || !fs.existsSync(src)) throw new Error(`No recording at ${src}. It may have been renamed or deleted.`)
  const meta = await proc.probeMeta(src, jobId)
  guard.check()
  // a MediaRecorder webm with no duration needs the classic path's remux first
  if (!meta.width || !(meta.duration > 0)) throw new Error('the recording has no readable length or size')
  const fmtId = opts.format || 'mp4'
  const fmt = proc.FORMATS[fmtId] || proc.FORMATS.mp4
  const gif = !!fmt.gif

  // A GIF is delivered slow and small, as the classic renderer delivered it, and the plan
  // is made at that rate so nothing is drawn only to be thrown away by a scaler. The rate
  // is snapped to one GIF's centisecond clock can actually hold (sinks.js, gifRate).
  const gifFps = gif ? Sinks.gifRate(+opts.gifFps > 0 ? +opts.gifFps : 12.5) : null
  // 640 wide unless the edit asked for a size, as the classic renderer had it: a chosen
  // scale is a chosen scale whatever the container, and null draws the plan's own frame
  const gifWidth = !gif ? null
    : +opts.gifWidth > 0 ? Math.max(120, +opts.gifWidth)
      : (opts.scale === 1080 || opts.scale === 720) ? null : 640
  // A store deliverable is a pair of integers, not a shape, and a file one pixel out is
  // rejected on upload. The plan is already composed at the preset's own ratio
  // (opts.backdropAspect, from ui/sizes.js preview), so the frame is drawn at that pair
  // exactly, and its rate is the plan's rather than the take's: the compositor keeps one
  // source frame in n and invents none.
  const store = opts.size && +opts.size.w > 0 && +opts.size.h > 0
    ? { w: Math.round(+opts.size.w), h: Math.round(+opts.size.h) } : null
  const rate = gif ? { fps: gifFps } : (+opts.fps > 0 ? { fps: +opts.fps } : null)
  const spec = await planFor(src, opts, meta, jobId, rate)
  guard.check()
  if (spec.span < 0.2) throw new Error('trim range is too short')

  // Every export is encoded beside where it goes and moved in when finished, so a
  // cancelled or failed one never destroys the last good file there, nor leaves a cut
  // off one in its place. That used to be a take folder's deliverable only: an export to
  // a path of its own (opts.dest, or a take that is not in a take folder) had its mux and
  // music bed written straight into it, ffmpeg's -y deleted what was there first, and a
  // cancel during either left a truncated file with nothing to clear it.
  const dest = opts.dest || proc.exportDest(src, fmt.ext)
  const out = path.join(path.dirname(dest), `.${path.parse(dest).name}.partial${path.extname(dest) || '.' + fmt.ext}`)
  const tag = `fetch-gl-${process.pid}-${Date.now()}`
  // the picture is written in its own container, so the mux is a stream copy on every
  // format rather than a second encode of what the compositor already drew
  const vext = gif ? 'gif' : fmtId === 'webm' ? 'webm' : 'mp4'
  const video = path.join(os.tmpdir(), `${tag}.${vext}`), audio = path.join(os.tmpdir(), `${tag}.m4a`)
  // and the music bed mixed beside out, which a cancel mid-mix would otherwise leave there
  const tmp = [video, audio, out, path.join(path.dirname(out), `.${path.parse(out).name}.music.${fmt.ext}`)]
  const t0 = Date.now()
  let written = null
  try {
    const onP = onProgress ? (n, total) => onProgress(n / spec.fps, spec.span, Math.min(97, Math.round(n / total * 100))) : null
    // picture in the window and sound in ffmpeg, at once
    // either failing stops the other, so a fallback to the classic renderer does not run
    // beside a render window still drawing (or an ffmpeg still writing) for nothing
    const [stats, sound] = await Promise.all([
      // a store file's rate is Apple's number and not a quality name (sinks.js STORE)
      renderPicture({ spec, src, out: video, ffmpeg: proc.FFMPEG, quality: store ? 'store' : opts.quality || 'balanced',
        sink: store ? undefined : opts.sink,
        format: fmtId, width: store ? store.w : gifWidth }, onP, jobId, guard),
      gif ? null : proc.renderAudio(src, opts, spec.keep, spec.span, meta, audio, jobId),
    ]).catch(e => { guard.killChildren(); throw e })
    guard.check()
    if (gif) moveInto(video, out)
    else if (store) {
      // The store's own audio line: one stereo AAC track at 256 kbps and 48 kHz. A take
      // with no sound gets a silent one of that shape rather than none, because the page
      // lists a track and nothing on it says a file without one is taken.
      // The picture is the length. This mux used -shortest, and a track 4 s short (a take
      // whose sound starts late) cut a 28 s edit to 24 s and still reported 28. The sound
      // is padded with silence to the picture's span and never the other way round.
      const span = spec.span.toFixed(3)
      const silent = sound ? [] : ['-f', 'lavfi', '-t', span, '-i', 'anullsrc=r=48000:cl=stereo']
      await proc.run(proc.FFMPEG, ['-y', '-i', video, ...(sound ? ['-i', sound] : silent), '-map', '0:v:0', '-map', '1:a:0',
        '-c:v', 'copy', '-af', `apad=whole_dur=${span}`, '-c:a', 'aac', '-b:a', '256k', '-ar', '48000', '-ac', '2',
        '-t', span, '-movflags', '+faststart', out], null, jobId)
      // Measured, not assumed: a store file that lost picture is refused here rather than
      // handed back as the preview of an edit it is not all of
      guard.check()
      written = await measurePicture(out)
      guard.check()
      if (written.frames < spec.frames - 1) {
        try { fs.unlinkSync(out) } catch {}
        throw new Error(`the preview came out ${(written.frames / spec.fps).toFixed(2)}s of a ${spec.span.toFixed(2)}s edit ` +
          `(${written.frames} of ${spec.frames} frames), so it was not kept. Nothing was trimmed on purpose: this is a fault ` +
          'in the export, and the edit is unchanged.')
      }
    } else {
      await proc.run(proc.FFMPEG, ['-y', '-i', video, ...(sound ? ['-i', sound] : []), '-map', '0:v:0', ...(sound ? ['-map', '1:a:0'] : []),
        '-c:v', 'copy', ...audioCopy(fmtId, sound), ...(vext === 'mp4' ? ['-movflags', '+faststart'] : []), out], null, jobId)
    }
    // a GIF has no track to put a bed under, as the classic renderer has it
    guard.check()
    if (opts.music && !gif) {
      const bed = await proc.musicBed(out, opts.music, fmt, spec.span, meta.hasAudio, jobId)
      guard.check()
      if (bed) fs.renameSync(bed, out)
    }
    // the last word: a cancelled export never replaces the deliverable it was redoing
    guard.check()
    fs.renameSync(out, dest)
    const ms = Date.now() - t0
    if (onProgress) onProgress(spec.span, spec.span, 100)
    return {
      // a store file answers with what it holds, read off the file
      file: dest, duration: +(written ? written.frames / spec.fps : spec.span).toFixed(1), cuts: (opts.cuts || []).filter(c => Array.isArray(c) && c.length === 2).length,
      format: fmt.ext, mb: +(fs.statSync(dest).size / 1e6).toFixed(1),
      engine: 'gl', why,
      // size is what was drawn, which for a GIF is smaller than the plan's own frame
      render: { size: `${spec.W}x${spec.H}`, ...stats, fps: spec.fps, ms, realtime: +(spec.span * 1000 / ms).toFixed(2), pictureFps: stats.fps },
      ...(written ? { written } : {}),
    }
  } finally {
    const sweep = files => { for (const f of files) { try { fs.unlinkSync(f) } catch {} } }
    sweep(tmp)
    // A cancel answers before the window has stopped, and a starved window's ffmpeg is
    // only killed when its pid arrives, so the picture can be written for a moment after
    // this. The scratch files are swept again once the window's job has ended, and once
    // more at the cap. Only the scratch: out is beside the deliverable, and a re-export
    // started meanwhile writes the same name.
    if (guard.cancelled) {
      if (guard.drawn) guard.drawn.then(() => sweep([video, audio]))
      const late = setTimeout(() => sweep([video, audio]), SWEEP_CAP_MS)
      if (late.unref) late.unref()
    }
  }
}

// What a written file's picture actually is: its frames counted by reading every packet
// (a stream copy into nothing, no decode) and the rate its header states. Only ffmpeg,
// because that is the one binary the app ships.
async function measurePicture(file) {
  const err = await new Promise(resolve => {
    let buf = ''
    const p = require('child_process').spawn(proc.FFMPEG, ['-hide_banner', '-i', file, '-map', '0:v:0', '-c', 'copy', '-f', 'null', '-'])
    p.stderr.on('data', d => { buf = (buf + d).slice(-20000) })
    p.on('close', () => resolve(buf))
    p.on('error', () => resolve(buf))
  })
  const frames = [...err.matchAll(/frame=\s*(\d+)/g)].map(m => +m[1]).pop() || 0
  const v = /Stream #\d+:\d+.*?: Video: .*?(\d+) kb\/s/.exec(err)
  return { frames, kbps: v ? +v[1] : null }
}

// The plan of a saved edit, drawn the way the export would draw it: the document
// normalised against the take's own length, and the spec every still here comes from.
async function specForDoc(src, doc) {
  const FD = require('./fetchdoc')
  const meta = await proc.probeMeta(src)
  const dur = meta.duration || (doc && +doc.dur) || 0
  const d = FD.normalize(doc, src, dur)
  if (!d.clips.length) d.clips = [{ id: 'C1', start: 0, end: dur }]
  const opts = FD.toExportOpts(d)
  return { spec: await planFor(src, opts, { ...meta, duration: dur }, null), opts, dur }
}

// Draw stills in the render window. times are output seconds and line up with files.
// A jobId registers the work with the processor, so proc.cancel(jobId) stops a sheet
// halfway the way it stops an export.
function drawStills(job, jobId, guard = null) {
  return drawInWindow({ ...job, stills: true, ffmpeg: proc.FFMPEG }, null, jobId || null, guard)
}

/**
 * Frames of an edit as the compositor exports them, for looking before exporting
 * (preview_frame). doc is the edit document; times are source seconds, as the
 * classic processor.previewFrame takes them. Returns [{ file, at }], JPEGs 1280 wide.
 */
async function previewFrames(src, doc, times, { width = 1280 } = {}) {
  const Timeline = require('./timeline')
  const { spec, opts } = await specForDoc(src, doc)
  const clock = Timeline.outClock(opts.cuts, spec.start, spec.end, opts.rates)
  const at = (times || []).map(t => Math.min(Math.max(spec.start, +t || 0), Math.max(spec.start, spec.end - 0.05)))
  const tag = `fetch-preview-${process.pid}-${Date.now().toString(36)}`
  const files = at.map((t, i) => path.join(os.tmpdir(), `${tag}-${i}-${t.toFixed(2)}.jpg`))
  const out = await drawStills({ spec, src, times: at.map(t => clock(t)), files, width })
  return out.map((f, i) => ({ file: f.file, at: +at[i].toFixed(2), engine: 'gl' }))
}

// ---- screenshots ---------------------------------------------------------
// A screenshot is a take of one frame. It is planned by the same Plan.prepare an export
// runs through and drawn by the same passes in the same compositor, so what the editor
// shows over a shot is what the file holds, exactly as it is for a clip.
//
// The one thing a still has to be given is a clock, because a plan is a thing that runs:
// a reveal rises, a badge lands, a caption's glass comes up. Rather than teaching every
// one of those passes what a still is, a shot gets a real timeline a few seconds long
// whose every frame is the same picture, and the still is taken from the middle of it.
// Every arrival in the vocabulary lands well inside half of it (plan.js REVEAL_IN is
// 0.36 s, a badge lands in 0.34, a focus eases in 0.45), so at the middle everything is
// at rest and nothing has begun to leave. No pass forks and nothing is special-cased: a
// shot's marks read as marks that have arrived because they have.
//
// The shot document lends itself the same clock and says so in its own words
// (ui/shot.js, SPAN and HOLD), and hands that span over as the options bag's end. These
// are the fallback for a caller with no document, so the two cannot drift into two
// different answers about one picture.
const SHOT_SPAN = 4, SHOT_FPS = 30
// mirrored for the surfaces that offer a size; compositor/index.js shotScale is what
// actually holds a shot to them, against the GPU's own ceiling. Nobody has to ask: the
// default is the size the capture was taken at, and these are for a caller who wants a
// smaller file than that.
const SHOT_SCALES = [1, 2, 3]

/**
 * The size of a captured picture, from its own header. A screenshot is a PNG or a JPEG
 * and both say their size in the first few hundred bytes, so this costs one short read
 * where probing it with ffmpeg costs a process.
 */
function pictureSize(file) {
  const fd = fs.openSync(file, 'r')
  try {
    const b = Buffer.alloc(65536)
    const n = fs.readSync(fd, b, 0, b.length, 0)
    if (n > 24 && b.readUInt32BE(0) === 0x89504e47 && b.toString('latin1', 12, 16) === 'IHDR') {
      return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), kind: 'png' }
    }
    if (n > 4 && b[0] === 0xff && b[1] === 0xd8) {
      // walk the markers to the start of frame, which is the only one carrying the size
      for (let p = 2; p + 9 < n && b[p] === 0xff;) {
        const m = b[p + 1], len = b.readUInt16BE(p + 2)
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
          return { width: b.readUInt16BE(p + 7), height: b.readUInt16BE(p + 5), kind: 'jpg' }
        }
        p += 2 + len
      }
    }
  } finally { fs.closeSync(fd) }
  throw new Error(`${path.basename(file)} is not a PNG or a JPEG, so there is no picture to style`)
}

// The members of a group, each measured from its own header where the caller did not
// say. A shot of one capture has no group and is untouched.
function groupSizes(opts = {}) {
  const raw = opts.group && (Array.isArray(opts.group) ? opts.group : opts.group.members)
  if (!raw || raw.length < 2) return opts
  const members = raw.map(m => {
    if (+m.w > 0 && +m.h > 0) return m
    const p = pictureSize(m.src)
    return { ...m, w: p.width, h: p.height }
  })
  return { ...opts, group: Array.isArray(opts.group) ? members : { ...opts.group, members } }
}

/**
 * The plan of a shot: the same options bag an export takes (toExportOpts' shape), on a
 * take of one frame. Returns { spec, size }.
 */
function shotPlan(image, opts = {}, size = null) {
  opts = groupSizes(opts)
  const pic = size || pictureSize(image)
  const look = opts.look || {}
  // The span the document lent itself, where it sent one
  const span = +opts.end > 0 ? +opts.end : SHOT_SPAN
  // A still has nothing to fade from, nothing to cut to and nothing to loop into, so
  // those are off here rather than refused somewhere a person can see the refusal.
  const o = { ...opts, start: 0, end: span, fadeIn: 0, fadeOut: 0, cuts: null, rates: null, camera: null,
    look: { ...look, motion: { ...(look.motion || {}), loop: false } } }
  const prepared = opts.prepared || null
  const ctx = { fps: SHOT_FPS, imageFile: opts.imageFile || (prepared && prepared.imageFile) || null, prepared }
  return { spec: Plan.prepare(o, { width: pic.width, height: pic.height, duration: span, fps: SHOT_FPS }, ctx), size: pic }
}

/**
 * Draw a finished screenshot.
 *   image  the captured picture (PNG or JPEG)
 *   opts   the export options bag, as a clip's edit hands it over
 *   out    { dest, scale, format, quality, width, size, at }
 * size is a pair of integers the output is drawn at exactly, for a store deliverable.
 * scale is 1, 2, 3 or 'native' (the default: the capture at its own size, so a shot ships
 * at the size it was captured unless a smaller one is asked for). at defaults to the
 * middle of the shot's own span. Returns what was written, with the size it was drawn at
 * and what that did with the capture (density: 1 is one output pixel per captured one).
 */
function renderShot(image, opts = {}, out = {}, jobId) {
  return guarded(jobId || null, guard => shotWith(image, opts, out, jobId, guard))
}

async function shotWith(image, opts, out, jobId, guard) {
  // Every capture in the picture, not just the first: a group draws one file per member
  // and a missing one would come back as a size mismatch rather than as a missing file.
  const files = [image, ...((opts.group && (opts.group.members || opts.group)) || []).map(m => m.src)]
  for (const f of files) if (!f || !fs.existsSync(f)) throw new Error(`No picture at ${f}. It may have been renamed or deleted.`)
  const { spec, size } = shotPlan(image, opts)
  const format = (out.format || 'png').toLowerCase()
  const dest = out.dest || path.join(os.tmpdir(), `fetch-shot-${process.pid}-${Date.now().toString(36)}.${format === 'png' ? 'png' : 'jpg'}`)
  // written beside itself and swapped in, as an export's deliverable is: a shot that
  // fails halfway never destroys the last good one
  const partial = path.join(path.dirname(dest), `.${path.basename(dest)}.partial`)
  const t0 = Date.now()
  try {
    const r = await drawStills({ spec, image, out: partial, format, quality: out.quality,
      // An exact pair of integers, where the caller asked for a size the store measures.
      // Carried through rather than turned into a width: a width plus an aspect rounds,
      // and the whole point of a preset is that it does not.
      size: out.size || null,
      scale: out.scale == null ? 'native' : out.scale, width: out.width, at: out.at }, jobId, guard)
    guard.check()
    moveInto(partial, dest)
    return { ...r, file: dest, engine: 'gl', ms: Date.now() - t0, capture: `${size.width}x${size.height}` }
  } finally {
    try { fs.unlinkSync(partial) } catch {}
  }
}

// ---- contact sheet -------------------------------------------------------
// The whole edit in one picture (contact_sheet): frames of the output, evenly spaced,
// drawn by the compositor and tiled with each frame's output time burned into its
// corner.
//
// One image rather than a list of stills, because what an agent has to judge here is
// motion. An ease that overshoots, a dissolve, the travel blur under a zoom: each is
// invisible in a single frame and obvious in a row of them. The frames come from the
// compositor and not from processor.filmstrip, so the sheet is the edit, with its
// crop, zooms, marks and look, and not the raw take.

const SHEET_MAX = 24
const SHEET_GROUND = '0x0A0908'   // --ink-0, so an empty cell is the app's own ground
const SHEET_INK = '0xFBFAF8'      // --text-0, legible on any frame through its box
const SHEET_GAP = 3               // a hairline of ground, so the grid reads as cells

const even = n => Math.max(2, 2 * Math.round(n / 2))

// Columns for n cells. A sheet reads best near square, but an empty cell is drawn in
// the ground and a model reading the sheet can take that for an edit ending on black,
// so a full grid is worth a worse shape and empties are expensive.
function sheetGrid(n, cellAspect) {
  let best = null
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols)
    const score = Math.abs(Math.log((cols * cellAspect) / rows / 1.3)) + 0.25 * (cols * rows - n)
    if (!best || score < best.score) best = { cols, rows, score }
  }
  return best
}

// A font file ffmpeg can load without quoting trouble; fontconfig answers for the rest
function sheetFont() {
  const f = ['SF Mono', 'Helvetica'].map(n => proc.FONT_FILES[n]).find(Boolean)
  return f && /^[\w/.-]+$/.test(f) ? `fontfile=${f}` : 'font=Menlo'
}

// Tile the drawn stills into one JPEG. Every cell is the same size and carries the
// output's own aspect, so the pad rounds off a pixel and nothing more: a sheet never
// shows bars either.
function sheetArgs(files, labels, { cols, cellW, cellH, out }) {
  const size = Math.max(11, Math.round(cellH * 0.07))
  const inset = Math.round(size * 0.7)
  const font = sheetFont()
  const cell = `scale=${cellW}:${cellH}:force_original_aspect_ratio=decrease:flags=area`
    + `,pad=${cellW}:${cellH}:(ow-iw)/2:(oh-ih)/2:color=${SHEET_GROUND}`
  const chains = files.map((_, i) => `[${i}:v]${cell},drawtext=${font}:text=${labels[i]}`
    + `:fontsize=${size}:fontcolor=${SHEET_INK}:box=1:boxcolor=${SHEET_GROUND}@0.78`
    + `:boxborderw=${Math.max(2, Math.round(size * 0.45))}:x=${inset}:y=h-th-${inset}[t${i}]`).join(';')
  const layout = files.map((_, i) => `${(i % cols) * (cellW + SHEET_GAP)}_${Math.floor(i / cols) * (cellH + SHEET_GAP)}`).join('|')
  const stack = files.map((_, i) => `[t${i}]`).join('')
    + `xstack=inputs=${files.length}:layout=${layout}:fill=${SHEET_GROUND}[sheet]`
  return [...files.flatMap(f => ['-i', f]), '-filter_complex', `${chains};${stack}`,
    '-map', '[sheet]', '-frames:v', '1', '-q:v', '3', '-y', out]
}

/**
 * A contact sheet of an edit: one JPEG of up to 24 frames across [from, to] in output
 * seconds, defaulting to the whole output. Returns
 *   { file, cols, rows, width, height, span, from, to, frames: [{ at, source }] }
 * where at is the output second burned into the cell and source is the second of the
 * recording it came from, which is what apply_edit and preview_frame take.
 */
function contactSheet(src, doc, range = {}, jobId) {
  return guarded(jobId || null, guard => sheetWith(src, doc, range || {}, jobId, guard))
}

async function sheetWith(src, doc, { from, to, count = 12, width = 1440 }, jobId, guard) {
  if (!src || !fs.existsSync(src)) throw new Error(`No recording at ${src}. It may have been renamed or deleted.`)
  const Timeline = require('./timeline')
  const { spec } = await specForDoc(src, doc)
  guard.check()
  const span = spec.span
  if (!(span > 0)) throw new Error('the edit has no length to draw')

  let a = Math.max(0, Math.min(span, +from || 0))
  let b = Math.max(0, Math.min(span, to == null ? span : +to || 0))
  // an agent that asks for a window with no width gets the whole take rather than an error
  if (!(b > a)) { a = 0; b = span }
  const n = Math.max(1, Math.min(SHEET_MAX, Math.round(+count || 12), spec.frames))

  // The middle of n equal slices, not the edges: an edit starts on a fade in and ends
  // on a fade out, and a sheet drawn at the edges spends two cells on the ground.
  // Snapped to the output's own frame grid, so the burned time is the time drawn.
  const times = Array.from({ length: n }, (_, i) =>
    Math.max(0, Math.min(spec.frames - 1, Math.round((a + (i + 0.5) * (b - a) / n) * spec.fps))) / spec.fps)

  const { cols, rows } = sheetGrid(n, spec.W / spec.H)
  const cellW = even(Math.max(160, Math.floor((width - (cols - 1) * SHEET_GAP) / cols)))
  const cellH = even(cellW * spec.H / spec.W)
  // drawn at twice the cell and scaled down, so a caption or a cursor badge lands on
  // the sheet the way a viewer sees it rather than laid out at a size it never runs at
  const drawW = Math.min(spec.W, cellW * 2)

  const tag = `fetch-sheet-${process.pid}-${Date.now().toString(36)}`
  const files = times.map((_, i) => path.join(os.tmpdir(), `${tag}-${i}.png`))
  const out = path.join(os.tmpdir(), `${tag}.jpg`)
  const t0 = Date.now()
  try {
    await drawStills({ spec, src, times, files, width: drawW, type: 'image/png' }, jobId, guard)
    guard.check()
    await proc.run(proc.FFMPEG, ['-v', 'error', ...sheetArgs(files, times.map(t => `${t.toFixed(1)}s`), { cols, cellW, cellH, out })], null, jobId)
    if (!fs.existsSync(out)) throw new Error('could not build the contact sheet')
    return {
      file: out, engine: 'gl',
      cols, rows, count: n,
      width: cols * cellW + (cols - 1) * SHEET_GAP, height: rows * cellH + (rows - 1) * SHEET_GAP,
      cell: { w: cellW, h: cellH, gap: SHEET_GAP },
      span: +span.toFixed(2), from: +a.toFixed(2), to: +b.toFixed(2),
      frames: times.map(t => ({ at: +t.toFixed(2), source: +Timeline.srcTime(spec.keep, t).toFixed(2) })),
      ms: Date.now() - t0,
    }
  } finally {
    for (const f of files) { try { fs.unlinkSync(f) } catch {} }
  }
}

// Start the window ahead of the first export, so that one does not wait for it
function warm() {
  if (jobs.size) return
  renderWindow().then(closeWhenIdle, () => {})
}

// Can this machine run the compositor? { ok, renderer }
async function probe() {
  const w = await renderWindow()
  const id = ++seq
  return new Promise(resolve => {
    const t = setTimeout(() => resolve({ ok: false, error: 'no answer' }), 5000)
    const on = (_e, m) => { if (m.id !== id) return; ipcMain.removeListener('render:probe', on); clearTimeout(t); resolve(m) }
    ipcMain.on('render:probe', on)
    w.webContents.send('render:probe', id)
  })
}

module.exports = { exportEdit, pickEngine, previewFrames, contactSheet, planFor, warm, probe, close: closeWindow,
  renderShot, shotPlan, pictureSize, SHOT_SCALES, SHOT_SPAN, SHOT_FPS }
