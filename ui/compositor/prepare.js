// What the compositor needs to know about a take that only its pixels can say, worked
// out once and shared by the editor's stage and the export (main process: it runs
// ffmpeg). Every frame is then drawn from the plan alone, so nothing here is per frame.
//
//   gutter    the window's own margin and corner (processor.frameGutter), framed only
//   marks     the edit's marks, lifts and spotlights held to when their element is on
//             screen (Targets.presentSpan) and fitted to it (spotFit, edgeFit, the
//             element's own corner radius), steps set on the card corner they name
//   erase     where the Mac's pointer is in the pixels and the clean patches that
//             cover it (processor.macCursorSpans, cursorPlates)
//   pointer   the agent's track, its rests moved off the words they would cover
//   captions  the words' timings and when the bottom of the frame is no place for a
//             caption (captionClutterTimes: the product put a toast where they sit, or
//             its own content is there and the top is clear), so those phrases go up
//   autoZooms auto zoom's moments (processor.zoomMoments), when the edit has no zooms
//             of its own, on the output clock
//   glass     the corner of a device's glass on a take whose document has none (one
//             written before the capture stored it): read off one frame of the take
//             (ui/simulator.js measureCorner), only where the crop is the glass
//   levels    the take's black and white points (levels.js), while the look asks for
//             auto level, for a glow, or for the one grade the pair moves: treatment
//             stretches every frame between the same two, the bright pass reads what is
//             above the white one, and the grade's shoulder and toe are pinned to both
//
// Times stay on the source clock except `busy`, which is on the output clock of the
// edit it was judged for. Each part is cached on what it depends on, so moving a zoom
// in the editor does not read the take again for its cursor.

const fs = require('fs')
const proc = require('../../processor')
const Timeline = require('../timeline')
const Targets = require('../targets')
const Plan = require('./plan')
const Overlays = require('../overlays')
const Pointer = require('../pointer')
const Levels = require('./levels')

const cache = new Map()
const MAX = 48
// A plate's picture lives as long as the entry that made it
function evict() {
  while (cache.size > MAX) {
    const [k, v] = cache.entries().next().value
    cache.delete(k)
    Promise.resolve(v).then(r => {
      for (const list of Object.values((r && r.plates) || {})) for (const p of list) { try { fs.unlinkSync(p.file) } catch {} }
    }).catch(() => {})
  }
}
function memo(key, fn) {
  if (cache.has(key)) { const v = cache.get(key); cache.delete(key); cache.set(key, v); return v }
  const p = fn()
  cache.set(key, p)
  // a failure is not remembered: the next ask tries again
  p.catch(() => cache.delete(key))
  evict()
  return p
}

const FOCUS = new Set(['lift', 'spotlight'])

// One frame of the take at its own size as RGBA bytes: no scale and no crop, since the
// glass is measured in the take's whole pixels.
function frameRGBA(src, at, W, H) {
  return new Promise(resolve => {
    const chunks = []
    const p = require('child_process').spawn(proc.FFMPEG, ['-v', 'error', '-nostdin', ...(at > 0 ? ['-ss', at.toFixed(3)] : []),
      '-i', src, '-frames:v', '1', '-an', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'])
    p.stdout.on('data', d => chunks.push(d))
    p.on('close', () => {
      const data = Buffer.concat(chunks)
      resolve(data.length >= W * H * 4 ? { width: W, height: H, data: data.subarray(0, W * H * 4) } : null)
    })
    p.on('error', () => resolve(null))
  })
}

// The glass's corner on a take whose document has none, read off the take itself. The
// middle frame first; a dark screen there (an app black to its own edge) refuses, so a
// quarter and three quarters are tried, and nothing past that.
async function glassCorner(src, viewport, W, H, dur) {
  const Sim = require('../simulator')
  const times = dur > 0.2 ? [0.5, 0.25, 0.75].map(k => k * dur) : [0]
  for (const t of times) {
    const frame = await frameRGBA(src, t, W, H)
    if (!frame) continue
    const r = Sim.measureCorner(frame, viewport)
    if (r.ok) return r.value.share > 0 ? { corner: r.value.share, at: +t.toFixed(3) } : null
  }
  return null
}
const sameBox = (a, b) => !!a && !!b && ['x', 'y', 'w', 'h'].every(k => Math.abs(+a[k] - +b[k]) <= 0.002)

// Lifts and spotlights held to the part of their span where their element is on
// screen, as apply_edit holds an agent's (agent-bridge timeFocus), so a mark a person
// placed a moment early does not raise the empty page before the card opens
async function presence(src, marks, crop) {
  const out = []
  for (const m of marks) {
    const start = +m.start, end = +m.end
    if (!m || !FOCUS.has(m.kind) || !(end - start >= 1) || !(+m.w > 0 && +m.h > 0)) { out.push(m); continue }
    try {
      const samples = await proc.boxSamples(src, { x: +m.x, y: +m.y, w: +m.w, h: +m.h }, start, end, crop)
      const r = Targets.presentSpan(samples, start, end)
      out.push(r.present && r.moved && r.end - r.start >= 0.8 ? { ...m, start: r.start, end: r.end, retimed: [start, end] } : m)
    } catch { out.push(m) }
  }
  return out
}

/**
 * Everything the take says, for one edit. opts is toExportOpts' bag; meta the take's
 * probe when the caller has it. Never throws for a part that cannot be read: that part
 * is left out and the frame draws without it.
 */
async function prepareRender(src, opts = {}, { meta = null, jobId = null } = {}) {
  if (!src || !fs.existsSync(src)) throw new Error(`No recording at ${src}. It may have been renamed or deleted.`)
  const st = fs.statSync(src)
  const id = `${src}#${st.mtimeMs}#${st.size}`
  const seek = await proc.ensureSeekable(src, jobId)
  try {
    const m = meta || seek.meta
    const dur = m.duration || 0
    const start = Math.max(0, +opts.start || 0)
    const end = opts.end && opts.end > start ? Math.min(opts.end, dur || opts.end) : dur
    const crop = opts.crop && opts.crop.w > 0 && opts.crop.h > 0 ? opts.crop : null
    const W = m.width || 1920, H = m.height || 1080
    // the crop's size in pixels as the plan takes it, held to the glass on a device take
    const px = crop ? Plan.cropPx(crop, W, H, { viewport: opts.viewport, screen: opts.screen }) : null
    const content = px ? { w: px.w, h: px.h } : { w: W, h: H }
    // what processor's own crops need to cut the same pixels (processor.cropArg)
    const dev = { W, H, viewport: opts.viewport, screen: opts.screen }
    const tasks = {}

    const v = opts.viewport
    if (opts.screen && v && !(+v.corner > 0) && sameBox(crop, v)) {
      tasks.glass = memo(`gl|${id}|${JSON.stringify(v)}`, () => glassCorner(seek.src, v, W, H, dur))
    }

    if (opts.backdrop) {
      tasks.gutter = memo(`g|${id}|${JSON.stringify([start, end, crop, px])}`, () => proc.frameGutter(seek.src, start, end, crop, dev).catch(() => null))
    }
    if (String(opts.backdrop || '').startsWith('img:')) {
      const hit = proc.imageBackdrops().find(b => b.id === opts.backdrop)
      tasks.imageFile = Promise.resolve(hit ? hit.file : null)
    }

    // each keeps the key of the mark it was made from, so the plan knows it (plan.markList)
    const drawn = (opts.marks || []).filter(x => x && (x.kind === 'step' || FOCUS.has(x.kind)) && +x.end > +x.start)
      .map(x => ({ ...x, k0: Plan.markKey(x) }))
    if (drawn.length) {
      // one at a time, so editing one mark does not read the take again for the others
      tasks.marks = Promise.all(drawn.map(x => memo(`m|${id}|${JSON.stringify([x, crop, px])}`, async () => {
        const [timed] = await presence(seek.src, [x], crop)
        const [fit] = await proc.stepSpots(seek.src, [timed], crop, content, dev)
        return fit
      }).catch(() => x))).then(list => {
        // badges on one grid of cards share rows and columns
        const corners = list.filter(q => q && q.corner)
        if (corners.length < 2) return list
        const grid = Overlays.stepGrid(corners, content.w, content.h)
        return list.map(q => (q && q.corner ? grid[corners.indexOf(q)] : q))
      })
    }

    // Auto zoom: the moments the classic renderer would zoom to, from the agent's track or
    // the recorded pointer's clicks, on the output clock; the plan zooms to them as it
    // does to zooms asked for by name
    if (opts.autoZoom && !(opts.zooms || []).some(z => z && z.end > z.start)) {
      const tr = proc.pointerTrack(src, opts)
      const data = tr ? Pointer.asCursorData(tr.points) : proc.readCursor(src)
      if (data && (data.display || data.windowBounds)) {
        const zo = opts.autoZoomOpts || {}
        const moments = proc.zoomMoments(data, { ...zo, clock: Timeline.outClock(opts.cuts, start, end || dur, opts.rates), crop })
        // Whole, not flattened to start and end. zoomMoments had already decided inEnd,
        // outStart, the scale the click's own spread asks for and the pan; handing over
        // two of those and letting Overlays.zoomPlan re-derive the rest from a second
        // copy of the constants is how auto zoom and explicit zoom drift apart.
        // A moment carries where the camera was when the one before it handed over
        // (`from`), and a lift re-framing a moment rebuilds that for the next one
        // (Focus.reframe): nothing downstream of here would.
        tasks.autoZooms = Promise.resolve(moments.map(q => ({
          start: q.inStart, end: q.outEnd, inEnd: q.inEnd, outStart: q.outStart,
          scale: q.scale, x: q.x, y: q.y, ...(q.from ? { from: q.from } : {}) })))
      }
    }

    // Auto level's two constants, measured once for the whole take: every frame is
    // stretched between them, so they cannot come from the frame being drawn. Two other
    // parts of the treatment want the same pair without asking for auto level. The
    // bright pass reads what is above the take's own white, in the same pixels levels.js
    // measured, and with nothing measured it has to assume the take fills the range and
    // read nothing at all. And the grade's shoulder and toe are pinned to those two
    // ends, but only where being pinned changes the curve, which is narrower than it
    // sounds: the run is the longer of the take's own empty end and the length that
    // makes the curve arrive carrying 1 / gain of the line's slope, and with a contrast
    // and no brightness the slope wins at both ends for every pair levels.js can return
    // (its white is never under 170 and its black never over 64). So the shoulder moves
    // only for a contrast pulled down by a brightness and the toe only for a contrast
    // pushed up by one, and a look with neither is not worth a demux and four hundred
    // keyframes of a long take before the first frame of the stage.
    const T = (opts.look && opts.look.treatment) || {}
    const grades = +T.contrast > 0 && (+T.brightness || 0) !== 0
    if (T.autoLevel || +T.bloom > 0 || +T.halation > 0 || grades) {
      tasks.levels = memo(`lv|${id}|${JSON.stringify([start, end, crop, px])}`,
        () => Levels.measure(seek.src, { start, end, crop, width: W, height: H, viewport: opts.viewport, screen: opts.screen }))
    }

    const spans = proc.macCursorSpans(src, opts)
    if (spans.length) {
      tasks.erase = memo(`e|${id}|${JSON.stringify(spans.length)}|${opts.hideMacCursor}`, async () => {
        const plates = await proc.cursorPlates(seek.src, spans, m, jobId)
        const out = {}
        for (const [i, list] of Object.entries(plates)) out[i] = list.map(p => ({ a: p.a, b: p.b, file: p.png, x: p.x, y: p.y, w: p.w, h: p.h }))
        return { spans, plates: out }
      })
    }

    const ptr = proc.pointerTrack(src, opts)
    if (ptr && ptr.points.length) {
      tasks.pointer = memo(`p|${id}|${JSON.stringify([ptr.points, start, end])}`, async () =>
        ({ points: await proc.pointerRests(seek.src, ptr.points, start, end || dur), scale: ptr.scale || null }))
    }

    if (opts.captions) {
      const cues = Array.isArray(opts.cues) && opts.cues.length ? opts.cues : proc.readCues(src)
      let words = null
      try { words = JSON.parse(fs.readFileSync(proc.sidecarIn(src, '.words.json'), 'utf8')) } catch {}
      const cst = opts.captionStyle || {}
      // only captions left at the bottom of the frame dodge; the band under a framed
      // take is off the product already (processor.applyEdit decides the same)
      const dodge = cues.length && !opts.backdrop && (!cst.position || cst.position === 'bottom') && cst.fx == null
      const clock = Timeline.outClock(opts.cuts, start, end || dur, opts.rates)
      // A lift re-frames the zoom it rides, so the window the frame pass draws is not
      // the edit's own zoom and the dodge has to judge its two zones through the one
      // that will be on screen. A lift only moves a window there is one of, so nothing
      // waits on the marks being fitted unless the edit has both.
      const lifts = (opts.zooms || []).some(z => z && +z.end > +z.start) ? drawn.filter(x => x.kind === 'lift') : []
      tasks.captions = memo(`c|${id}|${JSON.stringify([cues, dodge, dodge ? [opts.zooms, lifts, opts.autoZoom, opts.cuts, opts.rates, start, end, crop] : null])}`, async () => {
        // the re-framing is the plan's own (marks.planMarks), asked of it here rather
        // than worked out twice, and it needs the lifts fitted to their elements first
        let zoomsOut = null
        if (dodge && lifts.length) {
          try {
            const marks = tasks.marks ? await tasks.marks : null
            zoomsOut = Plan.prepare(opts, m, { prepared: { src, content, marks } }).zooms
          } catch (e) { console.warn(`[prepare] captions read the raw zooms: ${e && e.message}`) }
        }
        const busy = dodge
          ? await proc.captionClutterTimes(seek.src, { start, end: end || dur, crop, zooms: opts.zooms, zoomsOut, autoZoom: opts.autoZoom, clock }).catch(() => [])
          : []
        return { cues, words, busy }
      })
    }

    const keys = Object.keys(tasks)
    const vals = await Promise.all(keys.map(k => Promise.resolve(tasks[k]).catch(e => { console.warn(`[prepare] ${k} left out: ${e && e.message}`); return null })))
    const out = { src, content }
    keys.forEach((k, i) => { out[k] = vals[i] })
    return out
  } finally {
    seek.done()
  }
}

/**
 * The corner prepareRender reads for a device take whose document has none, from the
 * same cache, so a caller that writes it onto the document (agent-bridge export) does not
 * read the take a second time. Null where the document has a corner, the crop is not the
 * glass, or no frame gave one.
 */
async function glassFor(src, doc, meta) {
  const v = doc && doc.viewport, crop = doc && doc.crop
  const screen = doc && doc.device && doc.device.screen
  if (!src || !fs.existsSync(src) || !screen || !v || +v.corner > 0 || !sameBox(crop, v)) return null
  if (!(meta && meta.width > 0 && meta.height > 0)) return null
  const st = fs.statSync(src)
  const id = `${src}#${st.mtimeMs}#${st.size}`
  return memo(`gl|${id}|${JSON.stringify(v)}`, () => glassCorner(src, v, meta.width, meta.height, meta.duration || 0))
}

module.exports = { prepareRender, glassFor }
