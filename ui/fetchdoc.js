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
//      zooms, T1 texts, S1 subtitles, B1 beats, M1 marks. Ids come from a per-document counter
//      and are never reused, so "trim C2" keeps meaning the same thing after C1 is
//      deleted, and history entries stay truthful forever.
//
//   2. Clips, not trim plus cuts, are the model. The old shape said "this range,
//      minus these holes", which cannot be talked about: there is no noun for the
//      third surviving piece. Clips are those pieces, so they can be named.
//
// Pure: no Electron, no filesystem, no DOM. processor.js does the IO.

const KINDS = { clips: 'C', zooms: 'Z', texts: 'T', cues: 'S', beats: 'B', marks: 'M' }
const { normalizeTrack } = require('./pointer')
const Targets = require('./targets')
const Look = require('./look')
const Timeline = require('./timeline')

const r3 = n => Math.round(n * 1000) / 1000

// Version 2 keeps the whole look in `look`, generated from ui/look-schema.js, and the
// sound in `audio`. Version 1 spread the look over backdrop, outAspect, capStyle,
// hideMacCursor and a bag of slider values; normalize reads it forever.
// speedAudio is what the take's own sound does where a clip runs at more than 1.
// mute is the default because the reason to speed a piece up is that nothing is being
// said over it: a 4x typing montage with the voice pitched up and gabbling is the one
// result nobody asked for. keep is there for the other case, a slow section someone
// wants to hear through.
const AUDIO_DEFAULTS = { denoise: false, loudnorm: true, gain: 0, music: null, speedAudio: 'mute' }

function emptyDoc(src, dur) {
  return {
    v: 2,
    src: src || null,
    dur: r3(dur || 0),
    clips: [], zooms: [], texts: [], cues: [], beats: [],
    // redactions, lifts, spotlights, numbered steps and arrows drawn onto the frame for a stretch
    marks: [],
    // The agent's own cursor, [{t, x, y, click}] (see ui/pointer.js). null means the
    // track recorded with the take, [] means no cursor at all. Not id'd: a track is
    // hundreds of points, and it is edited as one thing.
    pointer: null,
    look: Look.defaults(),
    // music is a bed under the voice (processor.js musicBed): 'warm', 'bright', 'calm' or null
    audio: { ...AUDIO_DEFAULTS },
    crop: null, cropAR: 'free',
    // Where a browser's page sits in its window, as fractions {x, y, w, h}, when an
    // agent reported it (pointer with viewport). What frame.chrome remove crops to.
    viewport: null,
    // The machine the take was of, where it was a simulator: the device's own
    // framebuffer and which phone it was. The screen is the only part anything drawn
    // reads, and it reads it for one number, the 44 points a touch target really is.
    device: null,
    camera: null, audioTrack: null,
    autoZoom: false,
    nextId: { C: 1, Z: 1, T: 1, S: 1, B: 1, M: 1 },
  }
}

// v1 fields that now live in look or audio. A document or a patch carrying them is
// routed (lookPatchOf), never refused: agents built against v1 keep working.
const LEGACY = ['backdrop', 'backdropFile', 'outAspect', 'capStyle', 'hideMacCursor']

// The two frame.chrome settings that crop the real browser chrome off where the page's
// place is known exactly: remove leaves the page bare, clean draws Fetch's own frame
// round it. Look owns the pair, because Look.warnings has to say the same thing about
// a take where neither can happen.
const CROPS_CHROME = Look.CROPS_CHROME

/**
 * The device a capture was of, cleaned. Written by a capture of a simulator beside the
 * viewport (ui/agent-bridge.js simOnDoc), and read by exactly one thing that draws: the
 * touch disc, which is 44 of the device's own points across and cannot know how wide
 * that is without the device's own screen. Everything else here is for a person reading
 * the document, so a wrong field is dropped rather than refused.
 *
 * orientation is carried because a device on its side shows the same framebuffer turned,
 * and a disc sized off the portrait width would be several times too small.
 */
// The glass's rectangle and its measured corner (ui/simulator.js cornerOf), a share of
// the glass's short side. cleanBox keeps the rectangle alone, and a corner dropped here
// never reaches the plan, which then masks with the window's small radius and leaves a
// crescent of Simulator bezel in each corner of the phone.
function cleanViewport(v) {
  const box = Targets.cleanBox(v)
  if (!box) return null
  const corner = +v.corner
  return corner > 0 && corner < 0.5 ? { ...box, corner } : box
}

function cleanDevice(d) {
  if (!d || typeof d !== 'object') return null
  const n = v => (Number.isFinite(+v) && +v > 0 ? +v : null)
  const s = d.screen && typeof d.screen === 'object' ? d.screen : null
  const out = {}
  if (d.udid) out.udid = String(d.udid)
  if (d.name) out.name = String(d.name)
  if (d.family) out.family = String(d.family)
  if (s && n(s.w) && n(s.h)) {
    out.screen = { w: n(s.w), h: n(s.h), scale: n(s.scale) || 1,
      ...(String(s.orientation || '') === 'landscape' ? { orientation: 'landscape' } : {}) }
  }
  if (n(d.density)) out.density = n(d.density)
  return Object.keys(out).length ? out : null
}

// Every level in the document is decibels against the take as recorded, and the same
// ten either way wherever it is asked for: enough to rescue a passage a metre off the
// mic, short of the level war a bigger number invites in front of loudnorm.
const GAIN_DB = 10
const oneGain = v => { const g = +v; return Number.isFinite(g) ? Math.max(-GAIN_DB, Math.min(GAIN_DB, g)) : 0 }

function cleanAudio(a, base = AUDIO_DEFAULTS) {
  const o = { ...base, ...(a && typeof a === 'object' ? a : {}) }
  const music = o.music == null || o.music === '' ? null
    : typeof o.music === 'string' ? o.music : (o.music && o.music.bed ? { bed: String(o.music.bed), ...(o.music.level != null ? { level: +o.music.level } : {}) } : null)
  return { denoise: !!o.denoise, loudnorm: o.loudnorm !== false, gain: oneGain(o.gain), music,
    speedAudio: o.speedAudio === 'keep' ? 'keep' : 'mute' }
}

/**
 * A clip's own sound: `{ gain, denoise, mute }`, and whatever it does not say falls
 * back to the take's own `audio`. That fallback is the whole compatibility story: a
 * clip that says nothing is written back as nothing at all, hands the exporter no
 * clipAudio, and gets the one filter chain over the whole take that it always got.
 *
 * Loudness is deliberately not here. loudnorm measures the finished sound once and
 * lifts all of it to -14 LUFS; run per clip it would pull every piece to the same
 * level, which flattens a take rather than balancing it, and its own resampling would
 * fight the sample-exact pinning a sped-up piece needs (processor.rateAudio). The per
 * clip answer to "this passage is too quiet" is a measured gain, and
 * processor.clipLevels says how many decibels that is.
 */
function cleanClipAudio(a) {
  if (!a || typeof a !== 'object') return null
  const out = {}
  // A clip may say 0 dB on purpose, to hold its own level while the take is lifted
  // around it, so an explicit gain is kept whatever it is. mute has no take-level
  // counterpart, so only the true of it is worth writing down.
  if (a.gain != null && Number.isFinite(+a.gain)) out.gain = oneGain(a.gain)
  if (a.denoise != null) out.denoise = !!a.denoise
  if (a.mute) out.mute = true
  return Object.keys(out).length ? out : null
}
// What a clip does to its own sound, or null where it asked for nothing.
const clipAudioOf = clip => cleanClipAudio(clip && clip.audio)

// The spans that really do something the take does not, against the take's own sound.
const clipAudioFor = (spans, take) => {
  const live = (spans || []).filter(([, , a]) =>
    a.mute || (a.gain != null && a.gain !== take.gain) || (a.denoise != null && a.denoise !== take.denoise))
  return live.length ? live : null
}

/**
 * What a patch (or a v1 document) asks of the look and the sound, whatever shape it
 * came in: { look: patch or null, audio: patch or null }. A v1 look bag's sound keys go
 * to audio; capStyle, backdrop, outAspect and hideMacCursor to their look fields.
 */
function lookPatchOf(p) {
  if (!p || typeof p !== 'object') return { look: null, audio: null }
  let look = null, audio = p.audio && typeof p.audio === 'object' ? { ...p.audio } : null
  const add = (path, v) => { look = look || {}; look[path] = v }
  if (p.look && typeof p.look === 'object') {
    const bag = { ...p.look }
    for (const k of ['denoise', 'loudnorm', 'gain', 'music']) {
      if (k in bag) { audio = audio || {}; audio[k] = bag[k]; delete bag[k] }
    }
    const v1 = Look.v1Patch(bag)
    for (const k of Look.V1_KEYS) delete bag[k]
    look = { ...bag, ...v1 }
  }
  if (p.capStyle && typeof p.capStyle === 'object') {
    for (const k of ['font', 'scale', 'colour', 'position', 'highlight', 'fx', 'fy']) if (k in p.capStyle) add('captions.' + k, p.capStyle[k])
  }
  if ('backdrop' in p) {
    const bg = Look.backgroundFromId(p.backdrop, p.backdropFile)
    for (const [k, v] of Object.entries(bg)) add('background.' + k, v)
  }
  if ('outAspect' in p) add('frame.aspect', Look.aspectOf(p.outAspect) || 'auto')
  if ('hideMacCursor' in p) add('cursor.hideSystem', p.hideMacCursor === true ? 'hide' : p.hideMacCursor === false ? 'keep' : 'auto')
  if (look && !Object.keys(look).length) look = null
  return { look, audio }
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

/**
 * A clip's speed. `rate` is source seconds spent per output second: 2 plays that
 * piece of the take twice as fast, 0.5 at half. A pair, [1, 4], is a ramp from the
 * first to the second across the clip, and the ramp is held in output seconds so the
 * map stays closed form with an exact inverse (ui/timeline.js).
 *
 * Absent or 1 is written back as nothing at all. That is the whole compatibility
 * story: a document made before speed existed carries no rate, hands the clock no
 * rates, and gets the ranges and the graph it always got.
 */
const RATE_MIN = Timeline.RATE_MIN, RATE_MAX = Timeline.RATE_MAX
const oneRate = v => {
  const n = +v
  return Number.isFinite(n) && n > 0 ? Math.min(RATE_MAX, Math.max(RATE_MIN, n)) : 1
}
function cleanRate(rate) {
  if (rate == null) return null
  const pair = Array.isArray(rate) ? [oneRate(rate[0]), oneRate(rate.length > 1 ? rate[1] : rate[0])]
    : [oneRate(rate), oneRate(rate)]
  if (pair[0] === 1 && pair[1] === 1) return null
  return pair
}
// What a clip runs at, as the two ends of its ramp; [1, 1] where it was never asked.
const rateOf = clip => cleanRate(clip && clip.rate) || [1, 1]

// The inverse, for ffmpeg. processor.js already understands "source minus these
// ranges", so the filter graph does not have to change: clips are turned back into
// the gaps between them at export time. `rates` is the one thing that shape cannot
// say, so it comes back beside the cuts as source spans the clock reads
// (Timeline.outClock's fourth argument), and it is null unless a clip asked.
// `clipAudio` rides along the same way, source spans carrying what that clip does to
// its own sound, and null unless a clip asked for something of its own.
function trimFromClips(clips) {
  if (!clips || !clips.length) return { start: 0, end: 0, cuts: [], rates: null, clipAudio: null }
  const sorted = clips.slice().sort((a, b) => a.start - b.start)
  const start = sorted[0].start
  const end = sorted[sorted.length - 1].end
  const cuts = []
  for (let i = 0; i + 1 < sorted.length; i++) {
    const gapA = sorted[i].end, gapB = sorted[i + 1].start
    if (gapB > gapA) cuts.push([r3(gapA), r3(gapB)])
  }
  const rates = sorted.filter(c => cleanRate(c.rate))
    .map(c => { const [a, b] = rateOf(c); return [c.start, c.end, a, b] })
  const clipAudio = sorted.map(c => [c.start, c.end, clipAudioOf(c)]).filter(s => s[2])
  return { start: r3(start), end: r3(end), cuts, rates: rates.length ? rates : null,
    clipAudio: clipAudio.length ? clipAudio : null }
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
  if (legacy.camera || legacy.cam) doc.camera = legacy.camera || legacy.cam
  if (legacy.audioTrack) doc.audioTrack = legacy.audioTrack
  doc.autoZoom = !!legacy.autoZoom

  // the look as a v1 document held it, read the way normalize reads any v1 file
  const v1 = Look.fromV1({ look, capStyle: legacy.capStyle, backdrop: legacy.backdrop || null,
    backdropFile: legacy.backdropFile || null, outAspect: legacy.outAspect != null ? legacy.outAspect : null })
  doc.look = v1.look
  doc.audio = cleanAudio(v1.audio)

  return ensureIds(doc)
}

// Repair anything missing so an older or hand-edited file still opens. Never throws:
// a corrupt field costs that field, not the recording.
function normalize(doc, src, dur) {
  const base = emptyDoc(src, dur)
  if (!doc || typeof doc !== 'object') return base

  const out = { ...base, ...doc }
  out.src = src || doc.src || null
  if (dur) out.dur = r3(dur)
  // v1 migrates once, here, every time it is read: the file is written back as v2
  if (doc.v !== 2 || Look.isV1Look(doc.look)) {
    const m = Look.fromV1(doc)
    out.look = m.look
    out.audio = cleanAudio(m.audio, { ...AUDIO_DEFAULTS, loudnorm: false })
  } else {
    // a v2 document carrying a v1 field (a hand-edited file) has it routed, not lost
    const stray = LEGACY.some(k => k in doc) ? lookPatchOf(doc) : { look: null, audio: null }
    out.look = Look.merge(doc.look, stray.look || {}).look
    out.audio = cleanAudio({ ...(doc.audio || {}), ...(stray.audio || {}) })
  }
  out.v = 2
  for (const k of LEGACY) delete out[k]
  out.viewport = cleanViewport(doc.viewport)
  out.device = cleanDevice(doc.device)
  // The page's place arriving for the first time crops the chrome off, once: a crop
  // the person or an agent later changes or clears stays theirs.
  if (out.viewport && !doc.viewportApplied) {
    if (CROPS_CHROME.has(out.look.frame.chrome) && !out.crop) out.crop = { ...out.viewport }
    out.viewportApplied = true
  }
  out.nextId = { ...base.nextId, ...(doc.nextId || {}) }

  for (const kind of Object.keys(KINDS)) {
    out[kind] = Array.isArray(doc[kind]) ? doc[kind].filter(Boolean) : []
  }
  // A clip's speed is written back as the pair it means, or dropped where it is 1, and
  // its own sound as the keys it really set, or dropped where it set none. A document
  // that asked for neither is untouched, which is what keeps it the document it was.
  out.clips = out.clips.map(c => {
    if (!c || typeof c !== 'object' || !('rate' in c || 'audio' in c)) return c
    const clip = { ...c }
    const rate = cleanRate(clip.rate)
    if (rate) clip.rate = rate[0] === rate[1] ? rate[0] : rate
    else delete clip.rate
    const audio = cleanClipAudio(clip.audio)
    if (audio) clip.audio = audio
    else delete clip.audio
    return clip
  })
  out.pointer = Array.isArray(doc.pointer) ? normalizeTrack(doc.pointer) : null
  // A zoom sent with times alone gets the export's own defaults written in, so the
  // timeline, the result an agent reads back and the render all agree on it.
  // A box (from find_on_screen) is turned into the zoom that frames it once, here, and
  // not kept: from then on the zoom is its centre and scale like any other, so a
  // person dragging it in the editor is not snapped back to the box. When a box is
  // sent it wins over any x, y and scale beside it: an agent re-aiming Z1 sends the
  // zoom back as it read it, old 1.8 included, plus the box it now means.
  out.zooms = out.zooms.map(({ box, ...z }) => {
    const fit = box ? Targets.boxZoom(box) : null
    if (fit) return { ...z, ...fit }
    return {
      ...z,
      scale: Number.isFinite(+z.scale) && +z.scale > 0 ? +z.scale : 1.8,
      x: Number.isFinite(+z.x) && z.x !== null ? +z.x : 0.5,
      y: Number.isFinite(+z.y) && z.y !== null ? +z.y : 0.5,
    }
  })
  // A mark's own x, y, w, h already are a box, so one sent as box is simply that. A
  // step numbers a point, and for a box that point is its top left corner.
  out.marks = out.marks.map(m => {
    const b = m && m.box ? Targets.cleanBox(m.box) : null
    if (!m || !m.box) return m
    const { box, ...rest } = m
    if (!b) return rest
    const r = n => Math.round(n * 10000) / 10000
    return m.kind === 'step' ? { ...rest, x: r(b.x), y: r(b.y) } : { ...rest, x: r(b.x), y: r(b.y), w: r(b.w), h: r(b.h) }
  })

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
// clips, not the span they were cut from, and each one divided by the speed it runs
// at: a 20 second clip at 4x is five seconds of the finished video.
const outDuration = doc => (doc.clips || []).reduce((n, c) => {
  const [r0, r1] = rateOf(c)
  return n + Math.max(0, c.end - c.start) * 2 / (r0 + r1)
}, 0)

const byId = (doc, id) => {
  for (const kind of Object.keys(KINDS)) {
    const hit = (doc[kind] || []).find(x => x.id === id)
    if (hit) return { kind, item: hit }
  }
  return null
}

// frame.chrome switched with the page's place known: remove and clean both crop to the
// page, keep takes that crop away again. A crop someone drew by hand is never touched.
// clean crops for the same reason remove does, and then draws a frame of Fetch's own in
// place of the one it took off (ui/compositor/plan.js, devicePlan).
function chromeCrop(doc, was) {
  const now = doc && doc.look && doc.look.frame && doc.look.frame.chrome
  const v = doc && doc.viewport
  if (!v || !now || was === now) return doc
  const same = c => c && ['x', 'y', 'w', 'h'].every(k => Math.abs(+c[k] - v[k]) < 0.002)
  if (CROPS_CHROME.has(now) && !doc.crop) doc.crop = { ...v }
  else if (!CROPS_CHROME.has(now) && same(doc.crop)) doc.crop = null
  return doc
}

/**
 * The options bag applyEdit() expects: the v2 document read through for today's
 * ffmpeg renderer. The editor's Export, the MCP export and preview_frame all come
 * through here, so the three cannot disagree about what an edit is.
 */
function toExportOpts(doc, extra = {}) {
  // a v1 document, or one carrying a v1 field, is read as v2 first
  if (doc && (doc.v !== 2 || Look.isV1Look(doc.look) || LEGACY.some(k => k in doc))) {
    const clips = doc.clips
    doc = normalize(doc, doc.src, doc.dur)
    if (Array.isArray(clips)) doc.clips = clips
  }
  const { start, end, cuts, rates, clipAudio } = trimFromClips(doc.clips)
  const L = Look.toClassic(doc.look)
  const A = cleanAudio(doc.audio)
  const at = doc.audioTrack
  return {
    start, end, cuts,
    // What each clip does to its own sound, where it differs from the take's. A clip
    // asking for exactly what the take already does is not per-clip sound at all, and
    // dropping it here is what keeps such an edit on the single chain and the input
    // seek it had (processor.applyEdit).
    clipAudio: clipAudioFor(clipAudio, A),
    // the speed of each surviving piece, source spans (Timeline.outClock). null where
    // nothing runs at anything but 1, which is what keeps an old edit's graph the same
    rates,
    // what a sped-up piece does with the take's own sound (cleanAudio)
    speedAudio: A.speedAudio,
    crop: doc.crop,
    // where the page sits in a browser take, for the compositor: frame.chrome clean
    // only draws its own browser where the real one could be cropped off
    viewport: doc.viewport || null,
    // The device's own framebuffer on a take of a simulator, so the touch disc is a real
    // 44 point target measured through that screen rather than a size guessed against
    // the frame. Null on every other take, where the disc has no business being drawn.
    screen: (doc.device && doc.device.screen) || null,
    // the keys as they were pressed, for the strip marks.js draws over the finished
    // frame. Nothing is drawn until a take carries a key track, which is the capture
    // side and its own round, and without this line nothing ever would be.
    keys: doc.keys || null,
    texts: doc.texts,
    // the waveform peaks drawn on the timeline are the editor's, not the export's
    audioTrack: at && at.file ? { file: at.file, volume: at.volume, offset: at.offset, replace: !!at.replace,
      ...(at.fadeIn != null ? { fadeIn: at.fadeIn } : {}), ...(at.fadeOut != null ? { fadeOut: at.fadeOut } : {}) } : null,
    autoZoom: !!doc.autoZoom,
    autoZoomOpts: L.autoZoomOpts,
    zooms: (doc.zooms || []).map(z => ({ start: z.start, end: z.end, scale: z.scale, x: z.x, y: z.y })),
    // from is the side an arrow comes in from, and the renderer picks one where the
    // edit does not name it. A field left out here never reaches the compositor.
    marks: (doc.marks || []).map(m => ({ kind: m.kind, start: m.start, end: m.end, x: m.x, y: m.y, w: m.w, h: m.h, n: m.n, strength: m.strength, from: m.from })),
    // cursor.show off draws no cursor, whatever track the take has
    pointer: !L.cursor ? [] : Array.isArray(doc.pointer) ? doc.pointer : null,
    hideMacCursor: L.hideMacCursor,
    backdrop: L.backdrop,
    backdropAspect: L.backdropAspect,
    inset: L.inset,
    radius: L.radius,
    shadow: L.shadow,
    captions: L.captions,
    captionStyle: L.captionStyle,
    // the words on screen come from the document, which a person or agent may have corrected
    cues: (doc.cues || []).map(c => ({ start: c.start, end: c.end, text: c.text })),
    camera: doc.camera && doc.camera.on !== false && doc.camera.file ? doc.camera : null,
    denoise: A.denoise,
    loudnorm: A.loudnorm,
    gain: A.gain,
    fadeIn: L.fadeIn,
    fadeOut: L.fadeOut,
    music: A.music,
    // the whole look, for the compositor (ui/compositor/plan.js), which draws fields
    // the classic options above cannot say; applyEdit ignores it
    look: Look.resolve(doc.look),
    ...extra,
  }
}

/**
 * Everything a frame of the edit needs, for the compositor: the look whole, the kept
 * ranges of the take and the objects placed on it. Timing is source seconds, as in
 * the document; keep maps it to the output (ui/timeline.js).
 */
function toRenderSpec(doc) {
  const d = doc && doc.v === 2 ? doc : normalize(doc, doc && doc.src, doc && doc.dur)
  const { start, end, cuts, rates, clipAudio } = trimFromClips(d.clips)
  const keep = Timeline.applyRates(
    d.clips.length ? Timeline.keepRanges(cuts, start, end) : [[0, d.dur || 0]], rates)
  const A = cleanAudio(d.audio)
  return {
    v: 2, src: d.src, dur: d.dur,
    keep, length: +Timeline.outLength(keep).toFixed(3),
    look: Look.resolve(d.look), audio: A, clipAudio: clipAudioFor(clipAudio, A),
    crop: d.crop || null, viewport: d.viewport || null, device: d.device || null,
    zooms: d.zooms, marks: d.marks, texts: d.texts, cues: d.cues,
    pointer: d.pointer, camera: d.camera && d.camera.on !== false ? d.camera : null,
    autoZoom: !!d.autoZoom, audioTrack: d.audioTrack || null,
  }
}

/**
 * Apply a change onto an existing document, keeping everything the change does not
 * mention.
 *
 * apply_edit used to replace the whole document with whatever it was sent. An agent
 * reads a summary, adds one zoom and sends it back, and the summary never carried the
 * crop, the caption font, the backdrop or the camera, so all of them were reset to
 * defaults. Adding a zoom wiped your crop. Now a field that is absent is kept.
 *
 * Lists (clips, zooms, texts, cues, beats) are replaced as a whole when present,
 * because the list IS the edit: sending three zooms means there are three. Marks are
 * the exception, merged by id (mergeMarks), and remove: [ids] deletes from any list.
 * Settings are merged: look through Look.merge (a field left out is kept, null resets
 * it, { preset } rebases), audio, camera and audioTrack key by key, so sending
 * { audio: { denoise: true } } turns denoise on without resetting the gain. v1 shapes
 * (look.gain, capStyle, backdrop, outAspect, hideMacCursor) are routed to their v2 place.
 */
const LISTS = ['clips', 'zooms', 'texts', 'marks', 'cues', 'beats']
const OBJECTS = ['camera', 'audioTrack']

// ── what the mark family reads of the clock ─────────────────────────────
// sameItem, adoptIds, mergeMarks, settleFocus and focusClashes decide by id and by
// where a thing sits on screen; a time only ever narrows an answer they already have.
// ui/shot.js leans on that. A shot has no timeline, so it lends every mark the same
// span and runs them through here, and a time test that always passes leaves the
// spatial one deciding, which is exactly what a still wants. A comparison added below
// that a shared span cannot satisfy would break shots in silence, so
// test/fetchdoc.test.js pins it.

// ── ids an agent left off ───────────────────────────────────────────────
// A list is replaced whole, so an agent adding one lift sends every mark back, and
// often without the ids it was shown. Each then got a new id (M45 to M52 became M54
// to M61 for an edit that added one mark) and an old spotlight read as new, so the new
// lift could not replace it. An id-less item that matches one already there is that
// item. get_edit rounds times to the hundredth, hence the slack.
const SAME_TIME = 0.006, SAME_PLACE = 0.0006

// Aimed afresh (a box or a find_on_screen element) is a change, never the same item.
const aimed = n => !!(n && (n.element || (n.box && typeof n.box === 'object')))

function sameItem(p, n) {
  if (!p || !n || aimed(n)) return false
  let compared = 0
  for (const [k, v] of Object.entries(n)) {
    if (k === 'id' || v == null || p[k] == null) continue   // a field one side leaves out is its default
    const u = p[k]
    if (typeof v === 'number' && typeof u === 'number') {
      if (Math.abs(u - v) > (k === 'start' || k === 'end' ? SAME_TIME : SAME_PLACE)) return false
    } else if (JSON.stringify(u) !== JSON.stringify(v)) return false
    compared++
  }
  return compared >= 2
}

function adoptIds(prev, next) {
  if (!Array.isArray(prev) || !Array.isArray(next)) return next
  const taken = new Set(next.filter(x => x && x.id).map(x => x.id))
  const free = prev.filter(p => p && p.id && !taken.has(p.id))
  if (!free.length) return next
  return next.map(n => {
    if (!n || typeof n !== 'object' || n.id) return n
    const i = free.findIndex(p => sameItem(p, n))
    if (i < 0) return n
    const [p] = free.splice(i, 1)
    return { ...n, id: p.id }
  })
}

// ── marks, merged by id ─────────────────────────────────────────────────
// Marks used to be replaced whole like the other lists, and an agent adding one lift
// sent back only the marks it had in mind: the two redaction blurs hiding the person's
// name went with the rest, and the export showed the name. A rule in the tool text did
// not stop it, so it is code: a mark sent with a known id replaces that mark, one
// without is added, and every mark not sent stays. The one way to delete a mark is to
// name it in remove. Returns { marks, removed: [ids that went] }.
const idOf = x => String(x == null ? '' : x).trim().toUpperCase()

// A mark sent with an id changes only what it names. An agent listing the marks to
// keep as bare { id: 'M48' } wiped five step badges to nothing. New geometry (a box,
// an element, x/y/w/h) replaces the old placement whole rather than mixing with it.
const PLACE = ['x', 'y', 'w', 'h', 'box', 'element']
function patchMark(was, sent) {
  const moved = PLACE.some(k => sent[k] != null)
  const out = {}
  for (const [k, v] of Object.entries(was)) if (!(moved && PLACE.includes(k))) out[k] = v
  for (const [k, v] of Object.entries(sent)) if (v !== undefined) out[k] = v
  return out
}

function mergeMarks(prev, sent, remove) {
  const gone = new Set((Array.isArray(remove) ? remove : []).map(idOf))
  const before = (Array.isArray(prev) ? prev : []).filter(Boolean)
  if (!Array.isArray(sent)) sent = []
  sent = adoptIds(before, sent.filter(Boolean)).filter(m => !(m.id && gone.has(idOf(m.id))))
  const byId = new Map(sent.filter(m => m.id).map(m => [m.id, m]))
  const marks = before.filter(m => !gone.has(idOf(m.id))).map(m => byId.has(m.id) ? patchMark(m, byId.get(m.id)) : m)
  const placed = new Set(marks.map(m => m.id).filter(Boolean))
  for (const m of sent) if (!m.id || !placed.has(m.id)) marks.push(m)
  return { marks, removed: before.filter(m => m.id && gone.has(idOf(m.id))).map(m => m.id) }
}

function mergeDoc(current, patch) {
  let out = JSON.parse(JSON.stringify(current || {}))
  if (out.v !== 2 || Look.isV1Look(out.look)) out = normalize(out, out.src, out.dur)
  const wanted = lookPatchOf(patch)
  const remove = patch && Array.isArray(patch.remove) ? patch.remove : null
  if (remove) {
    const gone = new Set(remove.map(idOf))
    for (const k of LISTS) if (Array.isArray(out[k])) out[k] = out[k].filter(x => !(x && x.id && gone.has(idOf(x.id))))
  }
  for (const [k, v] of Object.entries(patch || {})) {
    if (v === undefined || k === 'remove' || k === 'look' || k === 'audio' || LEGACY.includes(k)) continue
    if (k === 'marks') out[k] = Array.isArray(v) ? mergeMarks(out[k], v, remove).marks : out[k]
    else if (LISTS.includes(k)) out[k] = Array.isArray(v) ? adoptIds(out[k], v) : out[k]
    else if (k === 'pointer') out[k] = v === null || Array.isArray(v) ? v : out[k]   // null: back to the recorded track
    else if (OBJECTS.includes(k) && v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = { ...(out[k] || {}), ...v }
    } else out[k] = v          // crop, cropAR, viewport, autoZoom: null is a real value
  }
  if (wanted.look) {
    const was = out.look && out.look.frame && out.look.frame.chrome
    out.look = Look.merge(out.look, wanted.look).look
    chromeCrop(out, was)
  }
  if (wanted.audio) out.audio = cleanAudio({ ...(out.audio || {}), ...wanted.audio })
  return out
}

// ── an agent's lifts and spotlights ─────────────────────────────────────
// Asked to lift a card that already had a spotlight on it, an agent sent both, and
// the export drew a lift with a second glow inside it. A new lift or spotlight takes
// the place of any it overlaps, in time and on screen. And a lift raises the whole
// element over a shadow, so its box has to be fully on screen: one running to the
// frame's edge (a panel cut off by the crop, or a box drawn by eye) came out sliced,
// and one a hair inside it came out flush with the video's edge (Targets.liftEdges).
const FOCUS_MARKS = ['lift', 'spotlight']

function markRect(m) {
  return Targets.cleanBox(m.box && typeof m.box === 'object' ? m.box : { x: m.x, y: m.y, w: m.w, h: m.h })
}

/**
 * The marks list an agent sent, settled against the one it replaces:
 * { marks, replaced: [ids dropped] }. Throws, saying what to do instead, for a new or
 * moved lift whose box touches the frame's edge.
 */
function settleFocus(prev, next) {
  if (!Array.isArray(next)) return { marks: next, replaced: [] }
  next = adoptIds(prev, next)
  const known = new Map((prev || []).filter(m => m && m.id).map(m => [m.id, m]))
  const fresh = next.filter(m => m && FOCUS_MARKS.includes(m.kind) && (!m.id || !known.has(m.id) || !sameItem(known.get(m.id), m)))
  for (const m of fresh) {
    const b = m.kind === 'lift' ? markRect(m) : null
    if (!b) continue
    const sides = Targets.liftEdges(b)
    if (sides.length) {
      throw new Error(`${m.id || 'The new lift'} runs to the ${sides.join(' and ')} edge of the frame, so the raised piece ` +
        'would sit flush with or past the video\'s edge. Lift a card or grid inside it with room around it ' +
        '(find_on_screen names it under no_lift). Use a spotlight only if nothing inside can be raised.')
    }
  }
  const overlaps = (a, b) => {
    const t = Math.min(+a.end, +b.end) - Math.max(+a.start, +b.start)
    if (!(t > 0.5 * Math.min(+a.end - +a.start, +b.end - +b.start))) return false
    const A = markRect(a), B = markRect(b)
    if (!A || !B) return false
    const w = Math.min(A.x + A.w, B.x + B.w) - Math.max(A.x, B.x), h = Math.min(A.y + A.h, B.y + B.h) - Math.max(A.y, B.y)
    return w > 0 && h > 0 && w * h > 0.3 * Math.min(A.w * A.h, B.w * B.h)
  }
  const replaced = []
  const marks = next.filter(m => {
    if (!m || !FOCUS_MARKS.includes(m.kind) || fresh.includes(m)) return true
    if (!fresh.some(f => overlaps(f, m))) return true
    if (m.id) replaced.push(m.id)
    return false
  })
  return { marks, replaced }
}

// Lifts and spotlights still sharing screen and time once an edit is settled. Two
// that only partly overlap are both kept, and the render shows it: a spotlight dims
// the header of a lifted card. An agent previewing that frame read it as right, so
// the result says so in words.
function focusClashes(marks) {
  const f = (marks || []).filter(m => m && FOCUS_MARKS.includes(m.kind))
  const out = []
  for (let i = 0; i < f.length; i++) {
    for (let j = i + 1; j < f.length; j++) {
      const a = f[i], b = f[j]
      const from = Math.max(+a.start, +b.start), to = Math.min(+a.end, +b.end)
      if (!(to - from > 0.1)) continue
      const A = markRect(a), B = markRect(b)
      if (!A || !B) continue
      const w = Math.min(A.x + A.w, B.x + B.w) - Math.max(A.x, B.x), h = Math.min(A.y + A.h, B.y + B.h) - Math.max(A.y, B.y)
      if (w > 0.002 && h > 0.002) out.push({ a: a.id, b: b.id, kinds: [a.kind, b.kind], start: +from.toFixed(2), end: +to.toFixed(2) })
    }
  }
  return out
}

// Zooms sharing time. Only one frames the shot at once, so a second zoom added over
// an old one on the wrong spot leaves the old one showing: re-aim it instead.
function zoomClashes(zooms) {
  const z = (zooms || []).filter(Boolean).slice().sort((a, b) => a.start - b.start)
  const out = []
  for (let i = 0; i < z.length; i++) {
    for (let j = i + 1; j < z.length && z[j].start < z[i].end; j++) {
      const from = Math.max(+z[i].start, +z[j].start), to = Math.min(+z[i].end, +z[j].end)
      if (to - from > 0.1) out.push({ a: z[i].id, b: z[j].id, start: +from.toFixed(2), end: +to.toFixed(2) })
    }
  }
  return out
}

// Lifts and spotlights this edit left alone that play during a zoom it changed. Asked
// to re-aim a zoom, an agent kept the spotlight an earlier turn had added unasked (the
// highlight the person complained about) and never mentioned it.
function focusAlongside(prev, doc) {
  const was = new Map(((prev && prev.zooms) || []).filter(z => z && z.id).map(z => [z.id, z]))
  const before = new Map(((prev && prev.marks) || []).filter(m => m && m.id).map(m => [m.id, m]))
  const changed = ((doc && doc.zooms) || []).filter(z => z && z.id && was.has(z.id) && !sameItem(was.get(z.id), z))
  const out = []
  for (const m of (doc && doc.marks) || []) {
    if (!m || !FOCUS_MARKS.includes(m.kind) || !before.has(m.id) || !sameItem(before.get(m.id), m)) continue
    const z = changed.find(z => Math.min(+z.end, +m.end) - Math.max(+z.start, +m.start) > 0.1)
    if (z) out.push({ id: m.id, kind: m.kind, start: +m.start, end: +m.end, zoom: z.id })
  }
  return out
}

module.exports = {
  KINDS, emptyDoc, mintId, ensureIds, normalize, fromLegacy, AUDIO_DEFAULTS, cleanAudio, lookPatchOf, chromeCrop, cleanDevice, cleanViewport,
  clipsFromTrim, trimFromClips, toExportOpts, toRenderSpec, outDuration, byId, mergeDoc, settleFocus,
  cleanRate, rateOf, RATE_MIN, RATE_MAX, cleanClipAudio, clipAudioOf, GAIN_DB,
  mergeMarks, adoptIds, sameItem, focusClashes, zoomClashes, focusAlongside,
}
