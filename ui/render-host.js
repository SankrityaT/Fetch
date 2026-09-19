// Exports, whichever renderer draws them. Main-process module.
//
// exportEdit takes the same options as processor.applyEdit and answers the same way,
// plus which engine drew the file. The compositor (ui/compositor/) draws an edit when
// it can draw everything the edit uses; anything else, or a compositor that fails,
// goes to the classic ffmpeg renderer, and the result says why. FETCH_ENGINE=classic
// or gl forces one (gl leaves out what it cannot draw yet, for measuring).
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
const Plan = require('./compositor/plan')
const Prepare = require('./compositor/prepare')

const IDLE_MS = 3 * 60 * 1000
let win = null, ready = null, idleTimer = null
const jobs = new Map()          // id -> { resolve, reject, onProgress, pids }
let seq = 0

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
    for (const [id, j] of jobs) { jobs.delete(id); j.reject(new Error('the compositor stopped: ' + d.reason)) }
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
ipcMain.on('render:pid', (_e, m) => { const j = jobs.get(m.id); if (j) j.pids.add(m.pid) })
ipcMain.on('render:done', (_e, m) => {
  const j = jobs.get(m.id)
  if (!j) return
  jobs.delete(m.id)
  if (m.error) j.reject(Object.assign(new Error(m.error), { cancelled: !!m.cancelled }))
  else j.resolve(m.stats)
})

// Draw the picture of one export in the render window
async function renderPicture(job, onProgress, jobId) {
  clearTimeout(idleTimer)
  const w = await renderWindow()
  const id = ++seq
  const entry = { onProgress, pids: new Set() }
  // processor.cancel(jobId) kills every child registered under the job: this one stands
  // for the window's work, and kills its ffmpegs too in case the window is busy
  const stand = {
    kill() {
      if (!w.isDestroyed()) w.webContents.send('render:cancel', id)
      for (const pid of entry.pids) { try { process.kill(pid, 'SIGKILL') } catch {} }
    },
  }
  proc.register(jobId, stand)
  try {
    return await new Promise((resolve, reject) => {
      Object.assign(entry, { resolve, reject })
      jobs.set(id, entry)
      w.webContents.send('render:job', { ...job, id })
    })
  } finally {
    proc.unregister(jobId, stand)
    closeWhenIdle()
  }
}

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

// The plan of an edit with everything its take says worked out (prepare.js)
async function planFor(src, opts, meta, jobId) {
  const prepared = await Prepare.prepareRender(src, opts, { meta, jobId })
  const camera = opts.camera && opts.camera.file && fs.existsSync(opts.camera.file) ? opts.camera : null
  const ctx = { prepared, gutter: prepared.gutter || null, imageFile: prepared.imageFile || null }
  return Plan.prepare({ ...opts, camera }, meta, ctx)
}

async function classic(src, opts, onProgress, jobId, why) {
  const r = await proc.applyEdit(src, opts, onProgress, jobId)
  return { ...r, engine: 'classic', why }
}

/**
 * Export an edit. Same arguments and result as processor.applyEdit, plus
 * { engine: 'gl' | 'classic', why: [...] } and, for the compositor, its timings.
 */
async function exportEdit(src, opts = {}, onProgress, jobId) {
  let pick
  try { pick = pickEngine(src, opts) } catch (e) { pick = { engine: 'classic', why: ['could not read the take: ' + e.message] } }
  if (pick.engine !== 'gl') return classic(src, opts, onProgress, jobId, pick.why)
  try {
    return await glExport(src, opts, onProgress, jobId, pick.why)
  } catch (e) {
    if (e && e.cancelled) throw e
    console.warn('[render] compositor failed, using the classic renderer:', e && e.message)
    return classic(src, opts, onProgress, jobId, [...pick.why, 'the compositor failed: ' + (e && e.message)])
  }
}

async function glExport(src, opts, onProgress, jobId, why) {
  if (!src || !fs.existsSync(src)) throw new Error(`No recording at ${src}. It may have been renamed or deleted.`)
  const meta = await proc.probeMeta(src)
  // a MediaRecorder webm with no duration needs the classic path's remux first
  if (!meta.width || !(meta.duration > 0)) throw new Error('the recording has no readable length or size')
  const fmtId = opts.format || 'mp4'
  const fmt = proc.FORMATS[fmtId] || proc.FORMATS.mp4

  const spec = await planFor(src, opts, meta, jobId)
  if (spec.span < 0.2) throw new Error('trim range is too short')

  // As applyEdit: a take folder's deliverable is encoded beside itself and swapped in
  // when finished, so a cancelled or failed export never destroys the last good one
  const deliverable = opts.dest ? null : proc.deliverablePath(src, fmt.ext)
  const dest = opts.dest || proc.exportDest(src, fmt.ext)
  const out = deliverable ? path.join(path.dirname(dest), `.${path.parse(dest).name}.partial.${fmt.ext}`) : dest
  const tag = `fetch-gl-${process.pid}-${Date.now()}`
  const video = path.join(os.tmpdir(), `${tag}.mp4`), audio = path.join(os.tmpdir(), `${tag}.m4a`)
  const tmp = [video, audio]
  if (out !== dest) tmp.push(out)
  const t0 = Date.now()
  try {
    const onP = onProgress ? (n, total) => onProgress(n / spec.fps, spec.span, Math.min(97, Math.round(n / total * 100))) : null
    // picture in the window and sound in ffmpeg, at once
    // either failing stops the other, so a fallback to the classic renderer does not run
    // beside a render window still drawing (or an ffmpeg still writing) for nothing
    const [stats, sound] = await Promise.all([
      renderPicture({ spec, src, out: video, ffmpeg: proc.FFMPEG, quality: opts.quality || 'balanced', sink: opts.sink }, onP, jobId),
      proc.renderAudio(src, opts, spec.keep, spec.span, meta, audio, jobId),
    ]).catch(e => { proc.cancel(jobId); throw e })
    await proc.run(proc.FFMPEG, ['-y', '-i', video, ...(sound ? ['-i', sound] : []), '-map', '0:v:0', ...(sound ? ['-map', '1:a:0'] : []),
      '-c', 'copy', '-movflags', '+faststart', out], null, jobId)
    if (opts.music) {
      const bed = await proc.musicBed(out, opts.music, fmt, spec.span, meta.hasAudio, jobId)
      if (bed) fs.renameSync(bed, out)
    }
    if (out !== dest) fs.renameSync(out, dest)
    const ms = Date.now() - t0
    if (onProgress) onProgress(spec.span, spec.span, 100)
    return {
      file: dest, duration: +spec.span.toFixed(1), cuts: (opts.cuts || []).filter(c => Array.isArray(c) && c.length === 2).length,
      format: fmt.ext, mb: +(fs.statSync(dest).size / 1e6).toFixed(1),
      engine: 'gl', why,
      render: { ...stats, size: `${spec.W}x${spec.H}`, fps: spec.fps, ms, realtime: +(spec.span * 1000 / ms).toFixed(2), pictureFps: stats.fps },
    }
  } finally {
    for (const f of tmp) { try { fs.unlinkSync(f) } catch {} }
  }
}

/**
 * Frames of an edit as the compositor exports them, for looking before exporting
 * (preview_frame). doc is the edit document; times are source seconds, as the
 * classic processor.previewFrame takes them. Returns [{ file, at }], JPEGs 1280 wide.
 */
async function previewFrames(src, doc, times, { width = 1280 } = {}) {
  const FD = require('./fetchdoc')
  const Timeline = require('./timeline')
  const meta = await proc.probeMeta(src)
  const dur = meta.duration || (doc && +doc.dur) || 0
  const d = FD.normalize(doc, src, dur)
  if (!d.clips.length) d.clips = [{ id: 'C1', start: 0, end: dur }]
  const opts = FD.toExportOpts(d)
  const spec = await planFor(src, opts, { ...meta, duration: dur }, null)
  const clock = Timeline.outClock(opts.cuts, spec.start, spec.end)
  const at = (times || []).map(t => Math.min(Math.max(spec.start, +t || 0), Math.max(spec.start, spec.end - 0.05)))
  const tag = `fetch-preview-${process.pid}-${Date.now().toString(36)}`
  const files = at.map((t, i) => path.join(os.tmpdir(), `${tag}-${i}-${t.toFixed(2)}.jpg`))
  clearTimeout(idleTimer)
  const w = await renderWindow()
  const id = ++seq
  try {
    const out = await new Promise((resolve, reject) => {
      jobs.set(id, { resolve, reject, pids: new Set() })
      w.webContents.send('render:job', { stills: true, id, spec, src, ffmpeg: proc.FFMPEG, times: at.map(t => clock(t)), files, width })
    })
    return out.map((f, i) => ({ file: f.file, at: +at[i].toFixed(2), engine: 'gl' }))
  } finally { closeWhenIdle() }
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

module.exports = { exportEdit, pickEngine, previewFrames, planFor, warm, probe, close: closeWindow }
