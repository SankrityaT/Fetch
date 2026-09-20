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
async function drawStills(job, jobId) {
  clearTimeout(idleTimer)
  const w = await renderWindow()
  const id = ++seq
  const entry = { pids: new Set() }
  const stand = {
    kill() {
      if (!w.isDestroyed()) w.webContents.send('render:cancel', id)
      for (const pid of entry.pids) { try { process.kill(pid, 'SIGKILL') } catch {} }
    },
  }
  if (jobId) proc.register(jobId, stand)
  try {
    return await new Promise((resolve, reject) => {
      Object.assign(entry, { resolve, reject })
      jobs.set(id, entry)
      w.webContents.send('render:job', { ...job, stills: true, id, ffmpeg: proc.FFMPEG })
    })
  } finally {
    if (jobId) proc.unregister(jobId, stand)
    closeWhenIdle()
  }
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
async function contactSheet(src, doc, { from, to, count = 12, width = 1440 } = {}, jobId) {
  if (!src || !fs.existsSync(src)) throw new Error(`No recording at ${src}. It may have been renamed or deleted.`)
  const Timeline = require('./timeline')
  const { spec } = await specForDoc(src, doc)
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
    await drawStills({ spec, src, times, files, width: drawW, type: 'image/png' }, jobId)
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

module.exports = { exportEdit, pickEngine, previewFrames, contactSheet, planFor, warm, probe, close: closeWindow }
