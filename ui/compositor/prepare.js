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
//   captions  the words' timings and when the product put something where the
//             captions sit (captionClutterTimes), so those phrases go to the top
//   autoZooms auto zoom's moments (processor.zoomMoments), when the edit has no zooms
//             of its own, on the output clock
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
    const content = crop ? { w: 2 * Math.floor(W * crop.w / 2), h: 2 * Math.floor(H * crop.h / 2) } : { w: W, h: H }
    const tasks = {}

    if (opts.backdrop) {
      tasks.gutter = memo(`g|${id}|${JSON.stringify([start, end, crop])}`, () => proc.frameGutter(seek.src, start, end, crop).catch(() => null))
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
      tasks.marks = Promise.all(drawn.map(x => memo(`m|${id}|${JSON.stringify([x, crop])}`, async () => {
        const [timed] = await presence(seek.src, [x], crop)
        const [fit] = await proc.stepSpots(seek.src, [timed], crop, content)
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
        const moments = proc.zoomMoments(data, { ...zo, clock: Timeline.outClock(opts.cuts, start, end || dur), crop })
        tasks.autoZooms = Promise.resolve(moments.map(q => ({ start: q.inStart, end: q.outEnd, scale: zo.zoom != null ? zo.zoom : 1.7, x: q.x, y: q.y })))
      }
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
      const clock = Timeline.outClock(opts.cuts, start, end || dur)
      tasks.captions = memo(`c|${id}|${JSON.stringify([cues, dodge, dodge ? [opts.zooms, opts.autoZoom, opts.cuts, start, end, crop] : null])}`, async () => {
        const busy = dodge
          ? await proc.captionClutterTimes(seek.src, { start, end: end || dur, crop, zooms: opts.zooms, autoZoom: opts.autoZoom, clock }).catch(() => [])
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

module.exports = { prepareRender }
