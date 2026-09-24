// A shot: one captured frame, styled by the look a recording is styled by.
//
// A screenshot is a take of one frame, so nothing here draws anything. The file is a
// document and a projection. The document says what a shot is; the projection hands the
// compositor the same options an edit hands it, so the stage and the PNG come off one
// renderer and cannot disagree.
//
// The honest question was whether a shot is an edit document with one frame and no
// timeline, or its own document that shares the look. It is its own document.
//
//   1. Half of ui/fetchdoc.js is a clock: clips, cues, beats, zooms, the pointer track,
//      speed ramps, per-clip sound, fades, the loop, the cut transition. A shot holding
//      all of that at its defaults is a document that lies about itself, and the first
//      agent to read one back would reasonably try to set speedAudio on a PNG.
//   2. A degenerate edit is not free either. A take of zero length hands Timeline a zero
//      span, and marks planned across it are thrown away before anything draws them
//      (ui/compositor/marks.js wants more than a tenth of a second of a step or an
//      arrow). Every shared path would need a still branch anyway. One visible branch,
//      here, beats a dozen invisible ones scattered through the edit document.
//
// What is shared is the look, whole and unconverted. Both documents keep
// Look.defaults() at `.look`, validated by the same ui/look.js against the same
// ui/look-schema.js, so `shot.look = doc.look` and `doc.look = shot.look` are both
// simply true and a preset saved from either applies to the other. A shot never edits
// the look to suit itself: it pins the handful of fields one frame cannot mean at the
// moment it projects (STILL_PINS), and what is stored keeps the recording's fade.
//
// Pure: no Electron, no filesystem, no DOM.

const Look = require('./look')
const Targets = require('./targets')
const Fetchdoc = require('./fetchdoc')

// A shot has no clock, and the shared code that plans marks, focus and badges is
// written against one. Rather than teach that code about stills, a shot is handed a
// clock with exactly one instant worth drawing: every mark runs the whole of SPAN, and
// the frame is taken at HOLD. Nothing is arriving and nothing is leaving at HOLD. The
// longest arrival in that code is a focus ease of 0.45 s (ui/overlays.js FOCUS_EASE)
// and the earliest departure starts a third of a span from the end, so half of four
// seconds is far more room than any of them need. It costs nothing: one frame is drawn.
const SPAN = 4, HOLD = 2

// The marks a shot takes, which is every mark the compositor draws on a frame
// (ui/compositor/marks.js). Nothing here needs motion to mean something.
const KINDS = new Set(['redact', 'blur', 'lift', 'spotlight', 'step', 'loupe', 'arrow'])

// More than one capture in one picture. Three is the ceiling the compositor draws
// (ui/compositor/plan.js GROUP_MAX): a fourth is four small pictures and the eye gives
// up on all of them.
const GROUP_MAX = 3
// The frame a member wears. 'none' is bare, and a member that names none wears the
// look's, which is what makes a group of one capture the same picture it was.
const DEVICE_KINDS = new Set(['none', 'browser', 'window', 'laptop', 'phone'])

// A shot's own id. Marks inside it keep M, exactly as they do in an edit. The shot
// itself needs a namespace no per-document letter can shadow: an agent holding a
// recording and a shot in the same breath would otherwise read S1 as a subtitle and as
// a shot, and an id you have to disambiguate is not a handle.
const shotId = n => 'SH' + Math.max(1, Math.floor(+n) || 1)
const isShotId = s => /^SH\d+$/.test(String(s == null ? '' : s).trim().toUpperCase())

const r4 = n => Math.round(n * 10000) / 10000
const whole = n => { const v = Math.round(+n); return Number.isFinite(v) && v > 0 ? v : 0 }

function emptyShot(src, size = {}, id = null) {
  return {
    v: 1,
    // Said outright rather than inferred, because a shot and an edit travel through the
    // same tools and a reader must never have to guess which one it is holding.
    kind: 'shot',
    id: isShotId(id) ? String(id).trim().toUpperCase() : null,
    src: src || null,
    // The capture's own pixels. A still carries no duration to stand in for its shape,
    // so it says its size, and Plan.prepare gets the meta it would have read off a take.
    w: whole(size.w != null ? size.w : size.width),
    h: whole(size.h != null ? size.h : size.height),
    look: Look.defaults(),
    // lift, loupe, arrow, step, redact, blur and spotlight, placed and never timed
    marks: [],
    crop: null, cropAR: 'free',
    // Where a browser's page sits in the capture, as fractions, when whoever grabbed it
    // knew. Same field and same meaning as an edit's, so frame.chrome works the same.
    viewport: null,
    // What take_shot captured: { kind: 'window' | 'display' | 'region', app, title }. The
    // drawn frame is the only thing that reads it, and the only thing that can.
    captured: null,
    // The machine it was a capture of, where it was a simulator. Same field and same
    // meaning as an edit's: the device's own framebuffer, which is the only way the
    // touch disc knows how wide 44 of that device's points are.
    device: null,
    // The words on the picture: a headline, the quieter line under it, a caption, a
    // label or a callout pinned to a point. No times on any of them.
    texts: [],
    // More than one capture in one picture. Null is a shot of one, which is nearly
    // every shot, and every field of a member is that member's own: what it captured,
    // how big the real thing is, the frame it wears and what is drawn on it. The
    // arrangement lives here rather than in the look, because which captures are in
    // this picture is not a style that travels to another one.
    group: null,
    nextId: { M: 1, C: 1, T: 1 },
  }
}

// ── times, which are the thing that does not apply ──────────────────────
//
// The whole of "no timeline" in code, and the reason nothing downstream needs changing.
// Give every mark the same span and a time comparison stops deciding anything, so
// Fetchdoc.mergeMarks, adoptIds, settleFocus and focusClashes fall through to the test a
// shot actually wants, which is the spatial one alone. Two lifts on a shot clash when
// they overlap on screen, and that is the only question there is to ask.
const timed = marks => (marks || []).filter(Boolean).map(m => ({ ...m, start: 0, end: SPAN }))
const untimed = marks => (marks || []).filter(Boolean).map(m => { const { start, end, ...rest } = m; return rest })

// The one instant to draw, in the shape ui/compositor/index.js renderStills takes.
const times = () => [HOLD]

/**
 * One mark, as a shot keeps it: placed, never timed.
 *
 * A start or an end sent with a mark is dropped rather than kept and ignored. Keeping
 * it would read back to an agent as a time a shot honours, and the next request would
 * be to change it.
 */
function cleanMark(m) {
  if (!m || typeof m !== 'object' || !KINDS.has(m.kind)) return null
  const { start, end, box, ...rest } = m
  const b = box && typeof box === 'object' ? Targets.cleanBox(box) : null
  if (!b) return rest
  // A mark's own x, y, w, h already are a box, so one sent as a box is simply that, and
  // a step numbers a point, which for a box is its top left corner. Same rule as an
  // edit's (ui/fetchdoc.js normalize), because a mark moved from one to the other must
  // not land somewhere else.
  return rest.kind === 'step'
    ? { ...rest, x: r4(b.x), y: r4(b.y) }
    : { ...rest, x: r4(b.x), y: r4(b.y), w: r4(b.w), h: r4(b.h) }
}

// The type a finished picture carries. A text says what it is rather than when it is,
// so start and end are dropped here rather than stored and ignored: a headline has
// nothing to do with a clock (ui/compositor/text.js).
function cleanText(t) {
  if (!t || typeof t !== 'object') return null
  const { start, end, at, ...rest } = t
  const text = String(rest.text == null ? '' : rest.text).trim()
  if (!text) return null
  const pt = at && typeof at === 'object' && +at.x >= 0 && +at.y >= 0
    ? { x: r4(Math.min(1, +at.x)), y: r4(Math.min(1, +at.y)) } : null
  return { ...rest, text, ...(pt ? { at: pt } : {}) }
}

// What a capture was of. Only a window or a display capture brings chrome of its own into
// the picture, and a frame drawn round that is two title bars, so this is the one fact the
// compositor needs and cannot work out (ui/compositor/plan.js, ownChrome).
const CAPTURE_KINDS = new Set(['window', 'display', 'region'])
// The address the capture itself knew, where it knew one. A browser frame draws
// device.url first and this second (ui/compositor/plan.js, barText), so a shot of a
// project's own dev server carries its address into the bar without anyone typing it.
// The same shape test the compositor uses, so a window title that is really a filename
// never travels as an address, and nothing here is made up.
const ADDRESS = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[:/?#]\S*)?$/i
const HAS_PATH = /^[a-z][a-z0-9+.-]*:\/\/|[/?#]/i
const A_FILE = /\.(?:md|txt|html?|jsx?|tsx?|json|ya?ml|css|scss|less|png|jpe?g|gif|svg|webp|pdf|zip|csv|xml|py|rb|go|rs|swift|java|kt|php|cpp|hpp|toml|lock|log|sh|bash|zsh|sql|env|ini|conf|cfg|plist|xcodeproj|docx?|xlsx?|pptx?|mp4|mov|wav|mp3|webm)$/i
const isAddress = t => !!t && ADDRESS.test(t) && (HAS_PATH.test(t) || !A_FILE.test(t))
function cleanUrl(u) {
  const s = String(u == null ? '' : u).trim().slice(0, 200)
  return isAddress(s) ? s : ''
}
function cleanCaptured(c) {
  if (!c || typeof c !== 'object' || !CAPTURE_KINDS.has(String(c.kind))) return null
  const out = { kind: String(c.kind) }
  if (c.app != null) out.app = String(c.app).slice(0, 120)
  if (c.title != null) out.title = String(c.title).slice(0, 120)
  const u = cleanUrl(c.url)
  if (u) out.url = u
  return out
}

/**
 * One member of a group: a capture, and what is known about how big the real thing is.
 *
 * Real relative size is a fact about the capture rather than a dial, so `mm`, `ppi` and
 * `scale` are evidence in that order and there is no "make this one bigger". The moment
 * one member can be resized the group stops being a photograph of a desk.
 */
function cleanMember(m) {
  if (!m || typeof m !== 'object' || !m.src) return null
  const out = { id: null, src: String(m.src), w: whole(m.w), h: whole(m.h) }
  if (typeof m.id === 'string' && /^C\d+$/i.test(m.id.trim())) out.id = m.id.trim().toUpperCase()
  if (+m.scale > 0) out.scale = +m.scale
  if (+m.ppi > 0) out.ppi = +m.ppi
  if (+m.mm > 0) out.mm = +m.mm
  // Left out entirely, the member wears the look's frame. Said, it wears its own, which
  // is the case this exists for: a handset and a browser window in one picture.
  if (m.device != null && DEVICE_KINDS.has(String(m.device))) out.device = String(m.device)
  if (m.title != null) out.title = String(m.title).slice(0, 80)
  // and its own address, so a browser member of a group draws the page it was of
  const mu = cleanUrl(m.url)
  if (mu) out.url = mu
  // a member answers the chrome question about its own capture, which is how a handset
  // with no title bar stands beside a window that has one and both are drawn right
  const cap = cleanCaptured(m.captured)
  if (cap) out.captured = cap
  const c = Targets.cleanBox(m.crop)
  if (c) out.crop = c
  // A member's marks are in that member's own fractions and are drawn on that member's
  // own pixels, so a lift is fitted to the capture it was drawn on. Never timed, the
  // same as the shot's own.
  out.marks = (Array.isArray(m.marks) ? m.marks : []).map(cleanMark).filter(Boolean)
  return out
}

/**
 * The group as the document keeps it, or null where there is nothing to arrange. Fewer
 * than two captures is a shot of one and goes down the path a shot of one goes down,
 * which is what keeps every tool written against a single capture working.
 */
function cleanGroup(raw, shot) {
  const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.members) ? raw.members : null)
  if (!list) return null
  const members = list.map(cleanMember).filter(Boolean).slice(0, GROUP_MAX)
  if (members.length < 2) return null
  const cfg = Array.isArray(raw) ? {} : raw
  const g = {
    // a share of the widest member's own shell, so it means the same thing whatever is
    // in the group, and negative is an overlap, which is what finishes the illusion
    gap: Number.isFinite(+cfg.gap) ? Math.max(-0.45, Math.min(0.6, +cfg.gap)) : 0.06,
    align: cfg.align === 'centre' ? 'centre' : 'stand',
    members,
  }
  for (const m of members) {
    const hit = String(m.id || '').match(/^C(\d+)$/)
    if (hit) shot.nextId.C = Math.max(shot.nextId.C || 1, +hit[1] + 1)
  }
  for (const m of members) if (!m.id) { m.id = 'C' + (shot.nextId.C || 1); shot.nextId.C = (shot.nextId.C || 1) + 1 }
  return g
}

// Mint and bump, through the edit document's own counter, so M ids mean the same thing
// in both and an id is never reused after a delete.
const mintId = shot => Fetchdoc.mintId(shot, 'marks')

// Fetchdoc.ensureIds walks only the lists a document actually has, so a shot passes
// through it untouched but for its marks.
const ensureIds = shot => Fetchdoc.ensureIds(shot)

/**
 * Repair anything missing so an older or hand-edited shot still opens. Never throws: a
 * corrupt field costs that field, not the capture.
 */
function normalize(shot, src, size) {
  const base = emptyShot(src, size || {})
  if (!shot || typeof shot !== 'object') return base

  const out = { ...base, ...shot }
  out.v = 1
  out.kind = 'shot'
  out.src = src || shot.src || null
  if (size && (size.w || size.width)) out.w = base.w
  if (size && (size.h || size.height)) out.h = base.h
  out.w = whole(out.w); out.h = whole(out.h)
  out.id = isShotId(out.id) ? String(out.id).trim().toUpperCase() : null

  // Look.resolve reads a v2 look and a v1 slider bag alike, which is what lets a look
  // written by any version of Fetch land on a shot without a migration of its own.
  const stray = Fetchdoc.lookPatchOf(shot)
  out.look = Look.merge(Look.resolve(shot.look), stray.look || {}).look

  out.crop = Targets.cleanBox(shot.crop) || null
  out.cropAR = Look.CROP_ARS.includes(shot.cropAR) ? shot.cropAR : 'free'
  out.viewport = Fetchdoc.cleanViewport(shot.viewport)
  out.captured = cleanCaptured(shot.captured)
  out.device = Fetchdoc.cleanDevice(shot.device)
  // The page's place arriving for the first time crops the chrome off, once; a crop the
  // person or an agent later changed stays theirs. Same rule and same code as an edit's.
  if (out.viewport && !shot.viewportApplied) {
    if (Look.CROPS_CHROME.has(out.look.frame.chrome) && !out.crop) out.crop = { ...out.viewport }
    out.viewportApplied = true
  }

  out.marks = (Array.isArray(shot.marks) ? shot.marks : []).map(cleanMark).filter(Boolean)
  out.texts = (Array.isArray(shot.texts) ? shot.texts : []).map(cleanText).filter(Boolean)

  // A counter sitting below an id already in use would hand out a duplicate, and two
  // marks answering to M2 is worse than a gap in the sequence.
  out.nextId = { M: Math.max(1, Math.floor(+(shot.nextId && shot.nextId.M)) || 1),
    C: Math.max(1, Math.floor(+(shot.nextId && shot.nextId.C)) || 1),
    T: Math.max(1, Math.floor(+(shot.nextId && shot.nextId.T)) || 1) }
  for (const m of out.marks) {
    const hit = String(m.id || '').match(/^M(\d+)$/)
    if (hit) out.nextId.M = Math.max(out.nextId.M, +hit[1] + 1)
  }
  for (const t of out.texts) {
    const hit = String(t.id || '').match(/^T(\d+)$/)
    if (hit) out.nextId.T = Math.max(out.nextId.T, +hit[1] + 1)
  }
  out.group = cleanGroup(shot.group, out)
  return ensureIds(out)
}

// ── editing a shot ──────────────────────────────────────────────────────

/**
 * Marks merged by id, the edit document's rule verbatim: a mark sent with a known id
 * replaces that mark, one without is added, every mark not sent stays, and the one way
 * to delete is to name it in `remove`. Copying the rule rather than the code would let
 * the two drift, and the drift a person would feel is a redaction quietly dropped.
 */
function mergeMarks(prev, sent, remove) {
  const out = Fetchdoc.mergeMarks(timed(prev), timed(sent), remove)
  return { marks: untimed(out.marks).map(cleanMark).filter(Boolean), removed: out.removed }
}

/**
 * The marks list settled against the one it replaces: { marks, replaced }. A new lift or
 * spotlight takes the place of one it covers, and a lift running to the frame's edge is
 * refused with the same sentence a recording refuses it with.
 *
 * On a shot every focus mark shares the one span, so the time half of the test is always
 * true and only the overlap on screen decides. That is the right answer here and it
 * falls out of the adapter rather than out of a second rule.
 */
function settleFocus(prev, next) {
  if (!Array.isArray(next)) return { marks: next, replaced: [] }
  const out = Fetchdoc.settleFocus(timed(prev), timed(next))
  return { marks: untimed(out.marks).map(cleanMark).filter(Boolean), replaced: out.replaced }
}

// Lifts and spotlights still sharing screen once an edit is settled. No start and end
// come back: on a shot the answer is which two, and there is no when to report.
const focusClashes = marks => Fetchdoc.focusClashes(timed(marks)).map(c => ({ a: c.a, b: c.b, kinds: c.kinds }))

const byId = (shot, id) => {
  const key = String(id == null ? '' : id).trim().toUpperCase()
  const hit = (shot && shot.marks || []).find(m => m && String(m.id).toUpperCase() === key)
  return hit ? { kind: 'marks', item: hit } : null
}

/**
 * Apply a change onto a shot, keeping everything the change does not mention. The look
 * merges field by field through Look.merge, marks merge by id, and v1 shapes (capStyle,
 * backdrop, outAspect, hideMacCursor, a look bag of slider values) are routed to their
 * v2 place by the edit document's own router, so an agent built against either
 * document drives this one.
 */
const SETTABLE = ['src', 'w', 'h', 'crop', 'cropAR', 'viewport', 'captured', 'device', 'id']
function mergeShot(current, patch) {
  let out = JSON.parse(JSON.stringify(current || {}))
  if (out.kind !== 'shot') out = normalize(out, out.src, out)
  const p = patch && typeof patch === 'object' ? patch : {}
  const remove = Array.isArray(p.remove) ? p.remove : null
  const wanted = Fetchdoc.lookPatchOf(p)

  if (remove) {
    const gone = new Set(remove.map(x => String(x == null ? '' : x).trim().toUpperCase()))
    out.marks = (out.marks || []).filter(m => !(m && m.id && gone.has(String(m.id).toUpperCase())))
    // texts is a whole list, the way an edit takes it: sending it replaces what was
    // there, and remove takes one out by id without resending the rest.
    out.texts = (out.texts || []).filter(t => !(t && t.id && gone.has(String(t.id).toUpperCase())))
  }
  if (Array.isArray(p.marks)) out.marks = mergeMarks(out.marks, p.marks, remove).marks
  if (Array.isArray(p.texts)) out.texts = p.texts
  // A group is small, and which captures are in this picture is one decision rather
  // than a list to merge into: sent, it replaces what was there; null clears it.
  if ('group' in p) out.group = p.group
  for (const k of SETTABLE) if (k in p && p[k] !== undefined) out[k] = p[k]
  if (wanted.look) {
    const was = out.look && out.look.frame && out.look.frame.chrome
    out.look = Look.merge(out.look, wanted.look).look
    // the same crop-the-chrome rule an edit gets, because frame.chrome means the same
    Fetchdoc.chromeCrop(out, was)
  }
  return normalize(out, out.src, out)
}

// ── the look one frame can mean ─────────────────────────────────────────
//
// Fields that describe how a take arrives, leaves or moves. A still is stored with them
// untouched, so a look crossing from a recording and back loses nothing, and they are
// pinned at the moment of projection, so the one frame drawn is the settled one.
//
// motion.fadeIn and motion.fadeOut are the two that would really show: at HOLD a three
// second fade from black still has the frame a third dark. The rest are already inert
// on a shot, and pinning them is how the inspector knows to say so rather than offering
// a dial that does nothing.
const STILL_PINS = {
  'motion.fadeIn': 0,
  'motion.fadeOut': 0,
  'motion.reveal': 'none',
  'motion.loop': false,
  'motion.cutTransition': 'none',
  // travel-driven shutter, and nothing travels
  'treatment.motionBlur': 0,
}

// The look as a still honours it. Resolved, so every field is present and in range.
function stillLook(look) {
  const L = Look.resolve(look)
  for (const [path, v] of Object.entries(STILL_PINS)) Look.setPath(L, path, v)
  return L
}

// ── one renderer ────────────────────────────────────────────────────────

// The meta Plan.prepare would have read off a take. The duration is the clock a shot was
// lent, not a claim that the PNG lasts four seconds.
const toMeta = shot => ({ width: shot && shot.w || 0, height: shot && shot.h || 0, duration: SPAN })

/**
 * Everything a frame of the shot needs, in the shape Fetchdoc.toRenderSpec returns. The
 * keys match one for one so a reader never has to branch: a shot is a take whose keep
 * is the whole of its lent span, with no zooms, no cues, no sound and no cursor.
 *
 * `still` carries what only a shot knows: the instant to draw and the capture's size.
 */
function toRenderSpec(shot) {
  const s = shot && shot.kind === 'shot' ? shot : normalize(shot, shot && shot.src, shot || {})
  return {
    v: 1, src: s.src, dur: SPAN,
    keep: [[0, SPAN]], length: SPAN,
    look: stillLook(s.look),
    // A PNG has no sound and says so, rather than carrying an edit's defaults and
    // inviting someone to set a gain on it.
    audio: null, clipAudio: null,
    crop: s.crop || null, viewport: s.viewport || null,
    captured: s.captured || null, device: s.device || null,
    zooms: [], marks: timed(s.marks), texts: s.texts || [], cues: [],
    // [] is no cursor at all, as against null, which means the track the take recorded.
    // A capture has no track, so the distinction has one honest answer here.
    pointer: [], camera: null,
    autoZoom: false, audioTrack: null,
    // Straight through: this is already the shape Plan.prepare takes.
    group: s.group || null,
    still: { at: HOLD, w: s.w, h: s.h },
  }
}

/**
 * The options bag Plan.prepare takes, in the shape Fetchdoc.toExportOpts returns, so the
 * shot path and the recording path reach the compositor through one door.
 *
 * The sound keys are here and inert. prepare reads none of them, and leaving them out
 * would make a shot a different shape from an edit for no gain; setting them to what
 * silence means is the smaller lie than setting them to an edit's defaults.
 */
function toExportOpts(shot, extra = {}) {
  const s = shot && shot.kind === 'shot' ? shot : normalize(shot, shot && shot.src, shot || {})
  const L = Look.toClassic(stillLook(s.look))
  return {
    start: 0, end: SPAN, cuts: [], rates: null, clipAudio: null, speedAudio: 'mute',
    crop: s.crop || null,
    viewport: s.viewport || null,
    captured: s.captured || null,
    // The device's own framebuffer, for the one mark that is measured in the device's
    // points rather than in the frame's pixels.
    screen: (s.device && s.device.screen) || null,
    keys: null,
    texts: s.texts || [],
    audioTrack: null,
    autoZoom: false,
    autoZoomOpts: L.autoZoomOpts,
    zooms: [],
    marks: timed(s.marks).map(m => ({ kind: m.kind, start: m.start, end: m.end, x: m.x, y: m.y,
      w: m.w, h: m.h, n: m.n, strength: m.strength, from: m.from })),
    pointer: [],
    // More than one capture in one picture, in the shape Plan.prepare takes it.
    group: s.group || null,
    hideMacCursor: L.hideMacCursor,
    backdrop: L.backdrop,
    backdropAspect: L.backdropAspect,
    inset: L.inset,
    radius: L.radius,
    shadow: L.shadow,
    captions: L.captions,
    captionStyle: L.captionStyle,
    cues: [],
    camera: null,
    denoise: false, loudnorm: false, gain: 0, music: null,
    fadeIn: 0, fadeOut: 0,
    look: stillLook(s.look),
    ...extra,
  }
}

// ── across the two documents ────────────────────────────────────────────

/**
 * A shot from a moment of an edit: the take of one frame, said plainly. The look, the
 * crop and the page's place carry over as they stand, and the marks alive at `at` come
 * with it, stripped of the times they no longer have.
 *
 * `at` is source seconds, as the edit document holds them.
 */
function fromTake(doc, { src = null, w = 0, h = 0, at = 0, id = null } = {}) {
  const d = doc && typeof doc === 'object' ? doc : {}
  const shot = emptyShot(src, { w, h }, id)
  shot.look = Look.resolve(d.look)
  shot.crop = Targets.cleanBox(d.crop) || null
  shot.cropAR = Look.CROP_ARS.includes(d.cropAR) ? d.cropAR : 'free'
  shot.viewport = Fetchdoc.cleanViewport(d.viewport)
  // A crop the edit already carries is the person's, so the chrome rule must not run
  // again and re-apply one they cleared.
  shot.viewportApplied = true
  const t = +at || 0
  shot.marks = untimed((d.marks || []).filter(m => m && +m.start <= t && +m.end > t))
    .map(cleanMark).filter(Boolean)
  return normalize(shot, shot.src, shot)
}

/**
 * A shot as a patch an edit takes (Fetchdoc.mergeDoc): the look whole, the crop, and the
 * marks given the stretch of the recording they should play over. The look crosses
 * unpinned, because what a shot could not mean is still what the recording meant.
 */
function toTake(shot, start = 0, end = 0) {
  const s = shot && shot.kind === 'shot' ? shot : normalize(shot, shot && shot.src, shot || {})
  const a = Math.max(0, +start || 0)
  const b = +end > a ? +end : a + SPAN
  return {
    look: Look.resolve(s.look),
    crop: s.crop || null,
    cropAR: s.cropAR,
    viewport: s.viewport || null,
    // The M ids are this shot's own. Carried onto a recording they merge onto whatever
    // already answers to that number there, so a shot's arrow would overwrite the
    // take's redaction over an email address. The marks are added; the target mints.
    marks: (s.marks || []).map(({ id, ...m }) => ({ ...m, start: a, end: b })),
  }
}

module.exports = {
  SPAN, HOLD, KINDS, STILL_PINS, GROUP_MAX,
  shotId, isShotId, emptyShot, normalize, cleanMark, cleanMember, cleanGroup, mintId, ensureIds, byId,
  timed, untimed, times, stillLook, toMeta,
  mergeMarks, settleFocus, focusClashes, mergeShot,
  toRenderSpec, toExportOpts, fromTake, toTake,
}
