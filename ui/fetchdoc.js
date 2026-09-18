// The edit document: one canonical description of what a recording should become.
//
// Before this, the truth about an edit was spread across three places that did not
// agree. `ed` in ui/editor.js held trim, cuts and texts. Nine more values existed
// only as DOM slider positions and were read straight off the controls at export
// time, so they survived neither a restart nor autosave. Captions lived in the .srt
// sidecar and bypassed both. Autosave captured a fourth subset into a single global
// file, which is why only one clip could have pending edits at a time.
//
// An agent cannot drive a document that does not exist. Worse, a history of changes
// is a lie if the thing it describes has no single state. So everything lives here.
//
// Two rules make the rest work:
//
//   1. Every object an agent can name gets a short stable id: C1 for clips, Z1 for
//      zooms, T1 texts, S1 subtitles, B1 beats. Ids come from a per-document counter
//      and are never reused, so "trim C2" keeps meaning the same thing after C1 is
//      deleted, and history entries stay truthful forever.
//
//   2. Clips, not trim plus cuts, are the model. The old shape said "this range,
//      minus these holes", which cannot be talked about: there is no noun for the
//      third surviving piece. Clips are those pieces, so they can be named.
//
// Pure: no Electron, no filesystem, no DOM. processor.js does the IO.

const KINDS = { clips: 'C', zooms: 'Z', texts: 'T', cues: 'S', beats: 'B' }

const r3 = n => Math.round(n * 1000) / 1000

function emptyDoc(src, dur) {
  return {
    v: 1,
    src: src || null,
    dur: r3(dur || 0),
    clips: [], zooms: [], texts: [], cues: [], beats: [],
    look: {
      zoomAmt: 1.7, bdInset: 0.06, bdRadius: 14, burnCaps: true,
      denoise: false, loudnorm: false, gain: 0, fadeIn: 0, fadeOut: 0,
    },
    crop: null, cropAR: 'free',
    capStyle: { font: 'Helvetica', scale: 1, colour: '#FFFFFF', position: 'bottom', boxed: true },
    camera: null, audioTrack: null,
    backdrop: null, backdropFile: null, outAspect: null, autoZoom: false,
    nextId: { C: 1, Z: 1, T: 1, S: 1, B: 1 },
  }
}

// Mint and bump in one step. The counter lives in the document rather than in memory
// so ids stay unique across sessions: a doc reopened tomorrow must not hand out C1
// again to something new.
function mintId(doc, kind) {
  const letter = KINDS[kind]
  if (!letter) throw new Error(`unknown kind: ${kind}`)
  doc.nextId = doc.nextId || {}
  const n = doc.nextId[letter] || 1
  doc.nextId[letter] = n + 1
  return letter + n
}

// Give ids to anything that arrived without one, in place. Used after migration and
// whenever an external tool hands us a list.
function ensureIds(doc) {
  for (const kind of Object.keys(KINDS)) {
    for (const item of doc[kind] || []) {
      if (!item.id) item.id = mintId(doc, kind)
    }
  }
  return doc
}

/**
 * The surviving pieces of [inT, outT] once `cuts` are removed.
 *
 * This is the one-way door: it runs once per document, at migration, and after that
 * clips are what gets edited. Reversing it later would have to guess which holes were
 * deliberate, which is exactly the ambiguity the clip model removes.
 */
function clipsFromTrim(inT, outT, cuts, dur) {
  const lo = Math.max(0, inT || 0)
  const hi = Math.min(dur || outT || 0, outT != null ? outT : dur || 0)
  if (!(hi > lo)) return []

  const holes = (cuts || [])
    .map(c => [Math.max(lo, c[0]), Math.min(hi, c[1])])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0])

  // merge overlapping holes, or a clip could come out with a negative length
  const merged = []
  for (const h of holes) {
    const last = merged[merged.length - 1]
    if (last && h[0] <= last[1]) last[1] = Math.max(last[1], h[1])
    else merged.push([h[0], h[1]])
  }

  const out = []
  let cur = lo
  for (const [a, b] of merged) {
    if (a > cur) out.push({ start: r3(cur), end: r3(a) })
    cur = Math.max(cur, b)
  }
  if (cur < hi) out.push({ start: r3(cur), end: r3(hi) })
  return out
}

// The inverse, for ffmpeg. processor.js already understands "source minus these
// ranges", so the filter graph does not have to change: clips are turned back into
// the gaps between them at export time.
function trimFromClips(clips) {
  if (!clips || !clips.length) return { start: 0, end: 0, cuts: [] }
  const sorted = clips.slice().sort((a, b) => a.start - b.start)
  const start = sorted[0].start
  const end = sorted[sorted.length - 1].end
  const cuts = []
  for (let i = 0; i + 1 < sorted.length; i++) {
    const gapA = sorted[i].end, gapB = sorted[i + 1].start
    if (gapB > gapA) cuts.push([r3(gapA), r3(gapB)])
  }
  return { start: r3(start), end: r3(end), cuts }
}

/**
 * Build a document from what the old editor held.
 *
 * `legacy` is the shape of `ed` plus the autosave snapshot; `look` carries the nine
 * values that previously existed only as DOM slider positions. Passing them in here
 * is the point of the migration: it is the first time they become persistent.
 */
function fromLegacy(legacy = {}, look = {}) {
  const doc = emptyDoc(legacy.src, legacy.dur)

  doc.clips = clipsFromTrim(legacy.in, legacy.out, legacy.cuts, legacy.dur)
  doc.texts = (legacy.texts || []).map(t => ({ ...t }))
  doc.cues = (legacy.cues || []).map(c => ({ start: c.start, end: c.end, text: c.text }))

  if (legacy.crop) doc.crop = legacy.crop
  if (legacy.cropAR) doc.cropAR = legacy.cropAR
  if (legacy.capStyle) doc.capStyle = { ...doc.capStyle, ...legacy.capStyle }
  if (legacy.camera || legacy.cam) doc.camera = legacy.camera || legacy.cam
  if (legacy.audioTrack) doc.audioTrack = legacy.audioTrack
  doc.backdrop = legacy.backdrop || null
  doc.backdropFile = legacy.backdropFile || null
  doc.outAspect = legacy.outAspect != null ? legacy.outAspect : null
  doc.autoZoom = !!legacy.autoZoom

  for (const k of Object.keys(doc.look)) {
    if (look[k] != null) doc.look[k] = look[k]
  }

  return ensureIds(doc)
}

// Repair anything missing so an older or hand-edited file still opens. Never throws:
// a corrupt field costs that field, not the recording.
function normalize(doc, src, dur) {
  const base = emptyDoc(src, dur)
  if (!doc || typeof doc !== 'object') return base

  const out = { ...base, ...doc }
  out.v = 1
  out.src = src || doc.src || null
  if (dur) out.dur = r3(dur)
  out.look = { ...base.look, ...(doc.look || {}) }
  out.capStyle = { ...base.capStyle, ...(doc.capStyle || {}) }
  out.nextId = { ...base.nextId, ...(doc.nextId || {}) }

  for (const kind of Object.keys(KINDS)) {
    out[kind] = Array.isArray(doc[kind]) ? doc[kind].filter(Boolean) : []
  }

  // A document whose counter sits below an id already in use would hand out a
  // duplicate, and two objects answering to C2 is worse than a gap in the sequence.
  for (const [kind, letter] of Object.entries(KINDS)) {
    for (const item of out[kind]) {
      const m = String(item.id || '').match(new RegExp(`^${letter}(\\d+)$`))
      if (m) out.nextId[letter] = Math.max(out.nextId[letter] || 1, +m[1] + 1)
    }
  }

  return ensureIds(out)
}

// Total output length, which is what someone actually wants to know: the sum of the
// clips, not the span they were cut from.
const outDuration = doc => (doc.clips || []).reduce((n, c) => n + Math.max(0, c.end - c.start), 0)

const byId = (doc, id) => {
  for (const kind of Object.keys(KINDS)) {
    const hit = (doc[kind] || []).find(x => x.id === id)
    if (hit) return { kind, item: hit }
  }
  return null
}

/**
 * The options bag applyEdit() already expects. Everything the exporter reads comes
 * from here now, rather than half from state and half from live DOM controls.
 */
function toExportOpts(doc, extra = {}) {
  const { start, end, cuts } = trimFromClips(doc.clips)
  const L = doc.look || {}
  return {
    start, end, cuts,
    crop: doc.crop,
    texts: doc.texts,
    audioTrack: doc.audioTrack,
    autoZoom: !!doc.autoZoom,
    autoZoomOpts: { zoom: L.zoomAmt },
    backdrop: doc.backdrop || null,
    backdropAspect: doc.outAspect || null,
    inset: L.bdInset,
    radius: L.bdRadius,
    captions: !!L.burnCaps,
    captionStyle: doc.capStyle,
    camera: doc.camera && doc.camera.on ? doc.camera : null,
    denoise: !!L.denoise,
    loudnorm: !!L.loudnorm,
    gain: L.gain,
    fadeIn: L.fadeIn,
    fadeOut: L.fadeOut,
    ...extra,
  }
}

module.exports = {
  KINDS, emptyDoc, mintId, ensureIds, normalize, fromLegacy,
  clipsFromTrim, trimFromClips, toExportOpts, outDuration, byId,
}
