// The house rubric, measured rather than asserted: what is wrong with this edit, ranked,
// with the exact call that fixes each one. It is how an agent checks its own work instead
// of declaring success, and the export runs it too, so nobody can say "done" without
// having been handed the list.
//
// Two documents, one door. A recording is judged by what is below; a capture says what
// it is (ui/shot.js) and is judged by the picture rubric at the bottom of this file,
// which measures the frame instead of the clock. review() routes on that, so a caller
// holding either one calls one function and reads one shape back, and the two can never
// drift into two ideas of what a score is.
//
// Pure. It runs inside an export, inside the bridge and under plain node, and it takes
// a document and a few measured numbers, never a path: a module that reads the disk or
// spawns ffmpeg is a module no test can state a case for. The one thing it does import
// is ui/timeline.js, which reads nothing either and owns the map from source seconds to
// output seconds. Every length in here is an output length, and a clip can carry a
// rate, so copying that map rather than calling it is how review and the export end up
// reporting two different numbers for one edit. A picture is measured off the plan the
// compositor draws it from, for the same reason and by the same rule: the judge reads
// the numbers the renderer works to rather than a second set of its own.
//
// One clock: every time in a finding, and every time in a fix, is a second of the
// original recording, the clock the document and apply_edit already use, so a fix can be
// sent back exactly as it was read. An output length says so by name (seconds, target),
// and look_at carries both, because contact_sheet reads the output and preview_frame
// reads the recording.
//
// Safe to follow, which is the whole of this round's work here. A checker that damages
// the edit is worse than no checker, and the round before this one had review rank a
// cut that deleted a closing URL card and four fifths of a title card, then hand over
// two calls that undid each other. Three rules hold now, in code rather than in wording:
//
//   the work    a card, a lift, a phrase the brief named: `work` computes them, `damage`
//               measures what a proposed clips list would cost them, and a fix that
//               costs any of it is not offered at all
//   one call    the length, the silence and the work put back all move the same number,
//               so `decide` returns at most one finding that retimes the edit. Two calls
//               that both retime it are two halves of a choice, and an agent handed both
//               walks in a circle
//   no overshoot  a fix asked to reach 60 s lands on 60 s. Every cut is sized against
//               the target and the last one is trimmed to the second rather than taken
//               whole
//
// Where more than one answer is defensible the item carries `choices` and `fix` is the
// safest of them, so an agent that applies `fix` without reading cannot be made worse
// off by doing so.

const Timeline = require('./timeline')
// One judge for one number. The tolerance that decides a length has been hit is
// Director's own, imported rather than restated: two modules with two tolerances is how
// one edit got told "4.5 s under the brief" and "the length is near enough" at once, and
// the sentence that would have ended that job sat behind the wider of the two.
const Director = require('./director')

const arr = v => (Array.isArray(v) ? v : [])
const r2 = n => Math.round(n * 100) / 100
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`
const secs = n => `${r2(n)} s`

// A gap this long with nobody speaking reads as dead air in a demo. Shorter than this
// is a breath between sentences and cutting it makes the voice gabble.
const DEAD_GAP = 1.2
// One zoom per this many output seconds is the ceiling. Above it the camera never rests
// and the viewer never reads anything: eleven zooms in a 60 second demo is a fairground.
const ZOOM_EVERY = 8
// The take's edge contract (PRODUCT.md): its outermost pixels stand at least 24 levels of
// luma off the ground beside them. The same 24 levels are what a ground and a take's own
// measured end need between them before the edge is carried by the hairline alone.
const EDGE = 24 / 255
// Marks that are the point of a moment rather than decoration on it, so cutting into
// one costs the edit the thing it was for. A redaction is not on the list: dropping the
// footage hides more than blurring it ever did.
const WORK = ['lift', 'spotlight', 'step', 'loupe', 'arrow']
// How much of a card or a lift has to survive a cut before it is still that card. Under
// a fifth of a 2.7 s title card left on screen is a flash, not a title.
const WHOLE = 0.8
// Breath left either side of a cut in the silence. remove_dead_air and fit_to_length
// both leave 0.15, so a cut review works out sounds like a cut they make.
const PAD = 0.15
// Below this a cut is a flicker rather than an edit; below MIN_PIECE ui/timeline.js
// drops the sliver a cut would leave anyway.
const MIN_CUT = 0.4
const MIN_PIECE = 0.05
// Room round a phrase put back, so the word is not clipped at its attack.
const BREATH = 0.3
// What review grades itself by. A fix is meant to raise this number and the test that
// applies every fix in order and reviews again is what proves each one does.
const PENALTY = { blocking: 2.5, should: 1, note: 0.25 }

// A look field with its default, without asking look.js to resolve the whole spec:
// review is handed whatever document exists, including one written by hand.
function field(look, path, def) {
  let v = look
  for (const k of String(path).split('.')) {
    if (!v || typeof v !== 'object') return def
    v = v[k]
  }
  return v === undefined || v === null ? def : v
}

// Rec. 709 luma of #RRGGBB, the same sum ui/look.js does, so a ground measured here and
// one measured there are one number.
function luma(hex) {
  const m = String(hex || '').match(/^#?([0-9a-f]{6})$/i)
  if (!m) return null
  const [r, g, b] = [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16) / 255)
    .map(c => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function aspectNumber(a) {
  if (!a || a === 'auto') return null
  const [w, h] = String(a).split(':').map(Number)
  return w > 0 && h > 0 ? Math.round((w / h) * 10000) / 10000 : null
}

// ── where it is going ───────────────────────────────────────────────────────
/**
 * A destination is not an export preset. It is a handful of obligations a rubric can
 * measure, and this is the table `brief.where` names. An unknown destination asks for
 * nothing rather than guessing: a wrong obligation is worse than no obligation.
 *
 * muted   it plays with the sound off, so the words have to be on the picture
 * tight   dead air is a fault there (a bug repro is evidence, and is not tightened)
 * seconds what "a demo" means there when the brief does not give a length
 *
 * There is no ground in this table on purpose. What ground suits a site is a fact about
 * the site, which Fetch never sees; the ground is measured against the take instead.
 */
const WHERE = {
  'landing page': { aspect: '16:9', muted: true, tight: true, seconds: 60,
    why: 'a landing page autoplays muted, so nobody hears the narration' },
  docs: { aspect: '16:9', muted: true, tight: true, seconds: 90,
    why: 'a docs page plays muted beside the text it explains' },
  'product hunt': { aspect: '16:9', muted: true, tight: true, seconds: 60,
    why: 'a launch page autoplays muted in a feed' },
  email: { aspect: '16:9', muted: true, tight: true, seconds: 30,
    why: 'an email plays muted and is watched for a few seconds' },
  social: { aspect: null, muted: true, tight: true, seconds: 45,
    why: 'a feed plays muted and the sound is turned on only after the words earned it' },
  vertical: { aspect: '9:16', muted: true, tight: true, seconds: 45,
    why: 'a vertical feed plays muted and full height' },
  youtube: { aspect: '16:9', muted: false, tight: true, seconds: null,
    why: 'YouTube plays with sound and carries its own captions' },
  presentation: { aspect: '16:9', muted: false, tight: true, seconds: null,
    why: 'a deck is played to a room, out loud' },
  tutorial: { aspect: '16:9', muted: false, tight: false, seconds: null,
    why: 'a tutorial is followed along with, so its pauses are the viewer\'s own' },
  'bug report': { aspect: null, muted: false, tight: false, seconds: null,
    why: 'a repro is evidence: tightening it throws away what someone has to see' },
}

// The words people actually write in a brief, against the row each one means.
const ALIAS = {
  landing: 'landing page', website: 'landing page', 'web site': 'landing page',
  'home page': 'landing page', homepage: 'landing page', hero: 'landing page',
  marketing: 'landing page', 'marketing site': 'landing page', 'app store': 'landing page',
  documentation: 'docs', 'help centre': 'docs', 'help center': 'docs', guide: 'docs',
  readme: 'docs', changelog: 'docs', 'release notes': 'docs',
  launch: 'product hunt', producthunt: 'product hunt', 'show hn': 'product hunt',
  newsletter: 'email', 'cold email': 'email',
  twitter: 'social', x: 'social', linkedin: 'social', bluesky: 'social', feed: 'social',
  tiktok: 'vertical', reels: 'vertical', shorts: 'vertical', stories: 'vertical',
  'youtube shorts': 'vertical', instagram: 'vertical',
  yt: 'youtube', deck: 'presentation', talk: 'presentation', slides: 'presentation',
  course: 'tutorial', walkthrough: 'tutorial', onboarding: 'tutorial',
  repro: 'bug report', bug: 'bug report', issue: 'bug report', 'support ticket': 'bug report',
  slack: 'bug report', teammate: 'bug report',
}

/** What `brief.where` asks of the edit, or null when nobody said where it is going. */
function whereSpec(where) {
  const k = String(where || '').trim().toLowerCase()
  if (!k) return null
  const named = WHERE[k] || WHERE[ALIAS[k]]
  if (named) return { ...named, where: WHERE[k] ? k : ALIAS[k] }
  // "for my landing page", "the docs site": the destination is in the sentence
  const keys = [...Object.keys(WHERE), ...Object.keys(ALIAS)]
    .sort((a, b) => b.length - a.length)
    .filter(w => new RegExp(`(^|[^a-z])${w.replace(/ /g, '[ -]')}([^a-z]|$)`).test(k))
  if (!keys.length) return null
  const row = WHERE[keys[0]] ? keys[0] : ALIAS[keys[0]]
  return { ...WHERE[row], where: row }
}

// ── the edit, as numbers ────────────────────────────────────────────────────
// The kept pieces in order, each carrying where it starts in the export. A document
// with no clips is the whole take, which is what the editor shows.
// A clip's rate as the two ends of its ramp, the shape Fetchdoc.rateOf writes.
const rateEndsOf = c => {
  const r = c && c.rate
  if (Array.isArray(r)) { const a = +r[0] > 0 ? +r[0] : 1; return [a, +r[1] > 0 ? +r[1] : a] }
  const a = +r > 0 ? +r : 1
  return [a, a]
}

function kept(doc) {
  const dur = +doc.dur > 0 ? +doc.dur : 0
  const cs = arr(doc.clips)
    .filter(c => c && +c.end > +c.start)
    .map(c => ({ id: c.id || null, start: Math.max(0, +c.start), end: +c.end, rate: rateEndsOf(c) }))
    .sort((a, b) => a.start - b.start)
  return retime(cs.length ? cs : (dur > 0 ? [{ id: null, start: 0, end: dur, rate: [1, 1] }] : []))
}

// Pieces on the output clock. Every proposed edit below goes through this, so what a
// fix would produce is measured by exactly the arithmetic the edit it came from was.
function retime(pieces) {
  let t = 0
  return pieces.map(c => {
    // the kept range as the clock reads it, so a sped clip is as long here as it is in
    // the file: 60 s at 2x is 30 s of output, which is what get_edit and export say
    const seg = [c.start, c.end, c.rate[0], c.rate[1]]
    const piece = { ...c, seg, span: Timeline.outSpan(seg), out0: t, out: r2(t) }
    t += piece.span
    return piece
  })
}

const outLength = k => k.reduce((n, c) => n + c.span, 0)

// Spans merged into the fewest that cover the same ground, for a fix that hands back a
// whole clips list rather than a patch.
function mergeSpans(spans) {
  const s = spans.filter(x => x[1] > x[0]).sort((a, b) => a[0] - b[0])
  const out = []
  for (const x of s) {
    const last = out[out.length - 1]
    if (last && x[0] <= last[1] + 1e-6) last[1] = Math.max(last[1], x[1])
    else out.push([x[0], x[1]])
  }
  return out
}

// One span list with another taken out of it. The silence minus the cards, the take
// minus what is kept, a cut minus the piece it may not touch: it is the same sum.
function minus(spans, cuts) {
  let out = spans.map(x => [x[0], x[1]])
  for (const [a, b] of mergeSpans(cuts)) {
    const next = []
    for (const [s, e] of out) {
      if (b <= s || a >= e) { next.push([s, e]); continue }
      if (a > s) next.push([s, a])
      if (b < e) next.push([b, e])
    }
    out = next
  }
  return out
}

const sumSpans = list => arr(list).reduce((n, g) => n + (g.end - g.start), 0)

// Where a moment of the recording lands in the export, or null when the edit cut it out.
function outAt(k, t) {
  for (const c of k) {
    if (t >= c.start - 1e-6 && t <= c.end + 1e-6) {
      return r2(c.out0 + Timeline.outIn(c.seg, Math.min(c.end, Math.max(c.start, t))))
    }
  }
  return null
}

// Which kept pieces a span touches, and for how long in each. Two or more means the span
// runs over a cut: whatever it was aimed at is not there for all of it.
function across(k, start, end) {
  const out = []
  for (const c of k) {
    const t = Math.min(end, c.end) - Math.max(start, c.start)
    if (t > 0.05) out.push({ piece: c, seconds: r2(t) })
  }
  return out
}

// Speech spans, merged: the cues when there are any, else the beats. Both are spans of
// the recording named from what was said, and dead air is what is left of the edit.
function speechSpans(doc, beats) {
  const src = arr(doc.cues).length ? arr(doc.cues) : arr(beats)
  const spans = src
    .filter(c => c && +c.end > +c.start)
    .map(c => [+c.start, +c.end])
    .sort((a, b) => a[0] - b[0])
  const out = []
  for (const [a, b] of spans) {
    const last = out[out.length - 1]
    if (last && a <= last[1] + 0.01) last[1] = Math.max(last[1], b)
    else out.push([a, b])
  }
  return out
}

// Silence left inside the kept pieces, gap by gap. The head and the tail of a piece
// count: a clip that opens on two seconds of nothing opens on nothing.
function deadAir(k, speech) {
  const out = []
  for (const c of k) {
    let at = c.start
    for (const [a, b] of speech) {
      if (b <= c.start || a >= c.end) continue
      if (a - at >= DEAD_GAP) out.push({ start: r2(at), end: r2(a), out: outAt(k, at) })
      at = Math.max(at, b)
    }
    if (c.end - at >= DEAD_GAP) out.push({ start: r2(at), end: r2(c.end), out: outAt(k, at) })
  }
  return out
}

const FOCUS = ['lift', 'spotlight']
// The two marks that say what not to look at. Everything else on a picture points.
const HIDES = ['redact', 'blur']
// One box wholly within another, in whatever fractions both are held in.
const inside = (a, b) => !!(a && b && a.x >= b.x - 1e-6 && a.y >= b.y - 1e-6 &&
  a.x + a.w <= b.x + b.w + 1e-6 && a.y + a.h <= b.y + b.h + 1e-6)
const rect = m => {
  const b = m && m.box && typeof m.box === 'object' ? m.box : m
  const x = +b.x, y = +b.y, w = +b.w, h = +b.h
  return [x, y, w, h].every(Number.isFinite) && w > 0 && h > 0 ? { x, y, w, h } : null
}

// Two lifts or spotlights sharing screen and time. Only one thing can be the subject, and
// the render shows the argument: a spotlight dims the header of the card a lift raised.
function focusClashes(marks) {
  const f = arr(marks).filter(m => m && FOCUS.includes(m.kind) && m.id)
  const out = []
  for (let i = 0; i < f.length; i++) {
    for (let j = i + 1; j < f.length; j++) {
      const a = f[i], b = f[j]
      const from = Math.max(+a.start, +b.start), to = Math.min(+a.end, +b.end)
      if (!(to - from > 0.1)) continue
      const A = rect(a), B = rect(b)
      if (!A || !B) continue
      const w = Math.min(A.x + A.w, B.x + B.w) - Math.max(A.x, B.x)
      const h = Math.min(A.y + A.h, B.y + B.h) - Math.max(A.y, B.y)
      if (w > 0.002 && h > 0.002) out.push({ a: a.id, b: b.id, kinds: [a.kind, b.kind], start: r2(from), end: r2(to) })
    }
  }
  return out
}

// A zoom placed by a centre somebody worked out, rather than by the thing it frames.
// Fetch's own fit lands on four decimals and a fitted scale on two; a typed aim lands on
// round numbers on both axes. It is a smell and it is reported as one, never as a fault:
// "zoom in on the first two seconds" is a centred zoom and is exactly right.
const grid = (v, step) => Math.abs(v / step - Math.round(v / step)) < 1e-6
function handAimed(zooms) {
  return arr(zooms).filter(z => {
    if (!z || !z.id) return false
    const x = +z.x, y = +z.y, s = +z.scale
    if (![x, y, s].every(Number.isFinite)) return false
    if (x === 0.5 && y === 0.5) return false          // nothing was aimed: the frame centre
    return grid(x, 0.05) && grid(y, 0.05) && grid(s, 0.1)
  })
}


// ── the work, and what no fix may take off it ───────────────────────────────
/**
 * What this edit is for, as spans of the recording: the title card, the closing card
 * with the address, the lift the whole demo builds to, and any phrase the brief named.
 * These are the work. No call review hands over may shorten one of them.
 *
 * A text is always on the list, drawn or not: somebody typed those words, and a card a
 * cut deleted is the deletion worth reporting rather than clutter worth removing. A
 * lift or a step is on it only while the edit still draws it, because a mark left
 * behind on material already cut away is clutter, and the never-drawn rule says so.
 *
 * `restore` is the difference between the two when one has already been cut into. A
 * card and a phrase the brief named are put back, material and all. A mark is aimed at
 * material rather than the other way round, so a clipped one is retimed onto what the
 * edit kept, which is the spans-a-cut rule below and not this one.
 */
function work(doc, brief, k, cues) {
  const out = []
  const dur = +doc.dur > 0 ? +doc.dur : (k.length ? k[k.length - 1].end : 0)
  const add = (id, what, from, to, promised, restore = true) => {
    // clamped to the take: a span running past the end could never be put back, and a
    // finding no call can clear is a loop with better manners
    const start = Math.max(0, from), end = Math.min(dur || to, to)
    if (!(end > start)) return
    const drawn = r2(across(k, start, end).reduce((n, p) => n + p.seconds, 0))
    out.push({ id: id || null, what, start: r2(start), end: r2(end), drawn, promised: !!promised, restore })
  }
  for (const t of arr(doc.texts)) {
    if (!t) continue
    const words = String(t.text || '').replace(/\s+/g, ' ').trim()
    add(t.id, words ? `the card "${words.slice(0, 40)}"` : 'a card', +t.start, +t.end, false)
  }
  for (const m of arr(doc.marks)) {
    if (!m || !WORK.includes(m.kind) || !(+m.end > +m.start)) continue
    if (!across(k, +m.start, +m.end).length) continue
    add(m.id, `the ${m.kind}${m.id ? ` ${m.id}` : ''}`, +m.start, +m.end, false, false)
  }
  // A phrase is matched against the cues joined across their neighbours, never inside
  // one cue alone: "the pricing page" split over "here is the pricing" and "page and
  // then we are done" matched nothing, so the span the brief named was protected by
  // nothing and review reported the brief as naming nothing at all.
  const said = arr(cues).filter(c => c && +c.end > +c.start).sort((a, b) => +a.start - +b.start)
  const joined = (a, b) => said.slice(a, b + 1)
    .map(c => String(c.text || '').toLowerCase().replace(/\s+/g, ' ').trim()).filter(Boolean).join(' ')
  const unmatched = []
  for (const phrase of arr(brief && brief.must_keep).filter(Boolean).slice(0, 6)) {
    const needle = String(phrase).toLowerCase().trim()
    if (!needle) continue
    let hit = false
    for (let i = 0; i < said.length; i++) {
      let j = i
      while (j < said.length && j < i + JOIN && !joined(i, j).includes(needle)) j++
      if (j >= said.length || j >= i + JOIN) continue
      // the shortest run of cues that still holds the phrase, so a phrase inside one
      // cue protects that cue alone and not the quiet one before it
      let a = i
      while (a < j && joined(a + 1, j).includes(needle)) a++
      add(said[a].id, `"${phrase}"`, +said[a].start, +said[j].end, true)
      hit = true
      i = j                            // one run per phrase per place it was said
    }
    if (!hit) unmatched.push(String(phrase))
  }
  out.unmatched = unmatched
  return out
}

// How many cues a must_keep phrase may run across. A phrase nobody would call a phrase
// is not worth joining half the transcript to find.
const JOIN = 4

// The moment of the recording that lands at this second of the export: outAt the other
// way round, for the rules written in output seconds. A fade is one of those.
function srcAt(k, o) {
  let left = Math.max(0, o)
  for (const c of k) {
    if (left <= c.span + 1e-6) return Math.min(c.end, Timeline.srcIn(c.seg, left))
    left -= c.span
  }
  return k.length ? k[k.length - 1].end : 0
}

// Silence with something on the picture is not dead air: a title card is read, not
// waited through, and a fade from black is the video starting. Measuring dead air from
// the soundtrack alone is what had review ask an agent to delete its own opener.
function covered(look, k, keeps, seconds) {
  const out = keeps.map(w => [w.start, w.end])
  if (!k.length) return mergeSpans(out)
  const inFade = +field(look, 'motion.fadeIn', 0) || 0
  const outFade = +field(look, 'motion.fadeOut', 0) || 0
  if (inFade > 0) out.push([k[0].start, srcAt(k, Math.min(seconds, inFade))])
  if (outFade > 0) out.push([srcAt(k, Math.max(0, seconds - outFade)), k[k.length - 1].end])
  return mergeSpans(out)
}

// The gaps once the picture is taken into account. What is left of a gap has to still
// read as dead air on its own, or it is a pause somebody would not notice.
function uncovered(dead, cover, k) {
  const out = []
  for (const [s, e] of minus(dead.map(g => [g.start, g.end]), cover)) {
    if (e - s >= DEAD_GAP) out.push({ start: r2(s), end: r2(e), out: outAt(k, s) })
  }
  return out.sort((a, b) => a.start - b.start)
}

// A piece as apply_edit takes it, carrying the id and the rate it came with. A fix that
// handed back bare spans would quietly reset every speed region the edit had, which is
// a destroyed edit under another name.
function clipOf(p) {
  const [r0, r1] = p.rate
  const rate = r0 === r1 ? (r0 === 1 ? null : r2(r0)) : [r2(r0), r2(r1)]
  return { ...(p.id ? { id: p.id } : {}), start: r2(p.start), end: r2(p.end), ...(rate === null ? {} : { rate }) }
}
const ramped = p => p.rate[0] !== p.rate[1]

// The kept pieces with `cuts` taken out. Only the first piece of a split keeps the id,
// the way ui/fit.js does it: two clips answering to C2 is worse than a gap in the ids.
function without(k, cuts) {
  const out = []
  for (const c of k) {
    minus([[c.start, c.end]], cuts)
      .filter(([a, b]) => b - a > MIN_PIECE)
      .forEach(([a, b], i) => out.push({ ...c, id: i === 0 ? c.id : null, start: a, end: b }))
  }
  return retime(out)
}

// The kept pieces with `spans` put back. Restored material is its own clip at 1x and is
// never merged into one carrying a rate: material handed back at somebody else's speed
// is not the material that was asked for.
function including(k, spans, dur) {
  const held = k.map(p => [p.start, p.end])
  const top = dur > 0 ? dur : (k.length ? k[k.length - 1].end : 0)
  const add = minus(mergeSpans(spans).map(([a, b]) => [Math.max(0, a), Math.min(top, b)]), held)
    .filter(([a, b]) => b - a > MIN_PIECE)
    .map(([a, b]) => ({ id: null, start: a, end: b, rate: [1, 1] }))
  const all = [...k.map(p => ({ id: p.id, start: p.start, end: p.end, rate: p.rate })), ...add]
    .sort((a, b) => a.start - b.start)
  const out = []
  for (const p of all) {
    const last = out[out.length - 1]
    // two neighbours at the same plain speed are one clip; a rate is a seam that stays
    const joins = last && !ramped(last) && !ramped(p) && last.rate[0] === p.rate[0] && p.start <= last.end + 1e-6
    // the clip that was already there keeps its id through a join, so a person's undo
    // and a later merge by id still find the piece they were pointing at
    if (joins) { last.end = Math.max(last.end, p.end); last.id = last.id || p.id }
    else out.push({ ...p })
  }
  return retime(out)
}

// The material nearest the cuts, put back until the edit reaches the number and then
// not a second more. The old advice was to restore the whole take and cut it again,
// which is two calls, the first of which throws away every cut made on purpose.
function fillTo(k, dur, target) {
  let pieces = k
  for (const [a, b] of minus([[0, dur]], k.map(p => [p.start, p.end]))) {
    const need = target - outLength(pieces)
    if (need <= 0.05) break
    const take = Math.min(b - a, need)
    if (take < MIN_PIECE) continue
    pieces = including(pieces, [[a, a + take]], dur)
  }
  return pieces
}

/**
 * Cuts taken from the silence, longest first, with not a second of them inside the
 * work or inside a ramp. `want` is how many output seconds to take and `slack` is how
 * much past that the caller can still afford: a gap that overshoots by less than the
 * slack is taken whole, because leaving a second and a half of nothing behind is a
 * pause an agent has to come back for. Past that the last cut is trimmed, from the end
 * nobody speaks at, so the breath beside the words is the part that survives.
 *
 * `free` is what the silence could pay if it were all spent, which tells a caller
 * whether a target is reachable without cutting into what was said.
 */
function silenceCuts(k, dead, keeps, want, slack = 0) {
  const block = mergeSpans([...keeps.map(w => [w.start, w.end]), ...k.filter(ramped).map(p => [p.start, p.end])])
  // Breath is left where a cut meets speech. Where it meets the end of a kept piece
  // there is nothing to breathe from and padding would leave a sliver of a clip.
  const edge = t => k.some(p => Math.abs(p.start - t) < 0.02 || Math.abs(p.end - t) < 0.02)
  // What a gap is worth is what the edit spends on it, not how long the recording ran
  // there: a hold at 0.655x pays out half as much again. `want` and `slack` are output
  // seconds, so every gap is measured in them too, and the last cut is trimmed in the
  // recording's own seconds at that gap's own rate. Sized the other way, review
  // promised a 33 s edit and handed over a 30.4 s one, then called it short.
  const free = minus(dead.map(g => [edge(g.start) ? g.start : g.start + PAD, edge(g.end) ? g.end : g.end - PAD]), block)
    .filter(([a, b]) => b - a >= MIN_CUT)
    .map(([a, b]) => ({ a, b, out: outSeconds(k, a, b) }))
    .filter(g => g.out > 0)
  free.sort((x, y) => y.out - x.out)
  const cuts = []
  let left = Number.isFinite(want) ? want : Infinity
  for (const g of free) {
    if (left < MIN_CUT) break
    if (g.out <= left + slack) { cuts.push([g.a, g.b]); left -= g.out; continue }
    // the end of a piece has nothing speaking after it, so the seconds come off there
    const src = left * (g.b - g.a) / g.out
    cuts.push(edge(g.b) ? [r2(g.b - src), g.b] : [g.a, r2(g.a + src)])
    left = 0
  }
  return { cuts: mergeSpans(cuts), free: r2(free.reduce((n, g) => n + g.out, 0)) }
}

// The seconds the finished video spends on a stretch of the recording. `across` counts
// the recording's own, which is the right unit for "how much of this card is drawn" and
// the wrong one for "how much shorter does cutting this make the video".
const outSeconds = (k, a, b) => across(k, a, b)
  .reduce((n, p) => n + p.seconds * 2 / (p.piece.rate[0] + p.piece.rate[1]), 0)

// What a proposed edit would cost the work. Every clips list review hands over is
// measured by this before it leaves, and one that costs a second of a card is not
// offered: by construction nothing here chooses such a cut, so this is the net under
// the arithmetic rather than a decision of its own.
function damage(keeps, pieces) {
  const out = []
  for (const w of keeps) {
    const drawn = across(pieces, w.start, w.end).reduce((n, p) => n + p.seconds, 0)
    const lost = r2(Math.min(w.drawn, w.end - w.start) - drawn)
    if (lost > 0.05) out.push({ ...w, lost })
  }
  return out
}

// The output seconds the work itself takes up: the floor under any length this edit can
// be asked for and still be the thing it is for.
const workSeconds = (keeps, k) => r2(mergeSpans(keeps.map(w => [w.start, w.end]))
  .reduce((n, [a, b]) => n + across(k, a, b)
    .reduce((m, p) => m + p.seconds * 2 / (p.piece.rate[0] + p.piece.rate[1]), 0), 0))

// ── the rubric ──────────────────────────────────────────────────────────────
// Rank inside a severity. The order is what a person would fix first: the promise they
// made (what must be hidden, the shape, the words), then the length, then the clutter.
// The picture's own rules are in the same list, in the same order of promise first: a
// rule missing from it sorts above everything, which is not a ranking, it is a bug.
const RANK = ['redactions', 'soft-redaction', 'aspect', 'group-unframed', 'captions', 'burn-in',
  'must-keep', 'rule-words', 'clipped', 'length', 'dead-air', 'never-drawn', 'spans-a-cut', 'double-chrome',
  'device-fit', 'focus-share', 'focus-clash', 'subject', 'breathe', 'zoom-density', 'hand-aimed',
  'blank-bar', 'ground', 'resolution', 'no-zooms', 'no-brief']
const WEIGHT = { blocking: 0, should: 1, note: 2 }

// A judgement the agent made and wrote down closes a `should`. Without this a finding
// it correctly refuses holds the verdict at "nearly" for ever, so "review is clean" is
// a state that job can never reach and the word stops carrying information.
//
// It does not close a blocking one, and the agent saying so is exactly why: an agent
// that can turn "not ready" into "ready" on its own say-so is marking its own paper,
// and "ready" has to keep meaning an edit with nothing blocking left in it. A blocking
// item declined drops to `should` and carries `lowered`, so the judgement counts for
// something and the finding is still on the list. A redaction the brief asked for does
// not move at all: it is the one failure that ships something private.
const NEVER_DECLINED = ['redactions']

/**
 * The order, the verdict and the number, from the list alone. One function for a
 * recording and for a capture, because a picture judged by a second set of weights is
 * how "ready, 10" ends up said about a frame with two title bars in it. Sorts `items`
 * in place and returns what the summary is written from.
 */
// The words the product's rules avoid, where the edit's own words use them (the bridge
// reads them with ui/guidelines.js check and hands them in as input.rules). A finding
// like any other, so it holds the verdict at nearly until it is fixed or declined.
function ruleWords(input, add, call) {
  const w = input.rules && arr(input.rules.words)
  if (!w || !w.length) return
  const said = w.map(x => `"${x.term}"${x.instead ? ` (say "${x.instead}")` : ''}`).join(', ')
  add('rule-words', 'should', `The product's rules avoid ${said}, and the words on this edit use ${w.length === 1 ? 'it' : 'them'}.`,
    call('get_edit', {}, 'find the texts, captions and labels that use it, and change them with apply_edit'))
}

function settle(items, asked) {
  const declined = arr(asked).map(x => String(x).trim().toLowerCase())
  for (const i of items) {
    if (!declined.includes(i.rule) || NEVER_DECLINED.includes(i.rule)) continue
    if (i.severity === 'blocking') { i.severity = 'should'; i.lowered = true }
    else i.declined = true
  }
  items.sort((a, b) => (WEIGHT[a.severity] - WEIGHT[b.severity]) ||
    (RANK.indexOf(a.rule) - RANK.indexOf(b.rule)) || ((a.at || 0) - (b.at || 0)))
  const live = items.filter(i => !i.declined)
  const bad = live.filter(i => i.severity === 'blocking').length
  const should = live.filter(i => i.severity === 'should').length
  // Review's own measure, so a fix can be shown to have helped rather than said to
  // have: ten is nothing the rubric can name, and applying a fix has to move it up.
  return { live, bad, should, off: items.length - live.length,
    verdict: bad ? 'not ready' : should ? 'nearly' : 'ready',
    score: r2(Math.max(0, 10 - live.reduce((n, i) => n + (PENALTY[i.severity] || 0), 0))) }
}

/**
 * review({ doc, brief, levels, beats, looks, path })
 *
 *   doc     the edit document (ui/fetchdoc.js), times in recording seconds
 *   brief   the job's brief (ui/director.js): { seconds, aspect, where, audience,
 *           must_keep, must_hide }. Absent is allowed and says so.
 *   levels  { lo, hi } from ui/compositor/levels.js, the take's own black and white
 *           points, already measured for this take
 *   beats   [{ id, start, end, label }], used for dead air when there are no cues and
 *           for naming a moment worth looking at
 *   looks   list_looks' entries, each { name, label, for, look }, so a look is named by
 *           what it is for rather than guessed at by its name
 *   path    the recording, so every fix is a call that can be made as it stands
 *   rules   { words: [{ term, rule, instead }] }: the words the product's rules avoid that
 *           the edit uses (ui/guidelines.js check, read by the bridge)
 *   declined  rule names the agent has judged and written off through direct's note.
 *           They stay in the list, marked, and stop counting towards the verdict, so a
 *           correct refusal does not hold an edit at "nearly" for ever.
 *
 * Returns { verdict, score, summary, items, look_at, measured }. Every item carries
 * { rule, severity, what, at, fix: { tool, args, why } }, and an item whose decision
 * has more than one defensible answer also carries `choices`, of which `fix` is the
 * one that is safe to apply without reading the others. `score` is out of ten and is
 * what a fix has to raise.
 */
function review(input = {}) {
  const doc = input.doc || {}
  // A capture says what it is (ui/shot.js) and is judged as a picture rather than as a
  // take of one frame. One entry point: a caller holding either document calls this.
  if (doc.kind === 'shot') return still(input)
  const path = input.path || (doc.src || null)
  const brief = input.brief || null
  const spec = whereSpec(brief && brief.where)
  const look = doc.look || {}
  const k = kept(doc)
  const seconds = r2(outLength(k))
  const speech = speechSpans(doc, input.beats)
  // With no cues and no beats nothing says where anybody spoke, so every kept clip
  // would read as one long silence and both the finding and the number under it would
  // be a measurement with no evidence. The captions rule says the real thing instead.
  const heard = speech.length > 0
  const zooms = arr(doc.zooms)
  const marks = arr(doc.marks)
  const redactions = marks.filter(m => m && (m.kind === 'redact' || m.kind === 'blur'))
  const cues = arr(doc.cues)
  // What the edit is for, worked out before anything is measured about it, because
  // every call below is checked against it.
  const keeps = work(doc, brief, k, cues)
  // Dead air with the picture switched on, for any set of pieces: a gap a card or a
  // lift or a fade covers is a beat to be read, not a silence to be cut.
  const deadOn = pieces => (heard
    ? uncovered(deadAir(pieces, speech), covered(look, pieces, keeps, outLength(pieces)), pieces)
    : [])
  const dead = deadOn(k)
  const deadTotal = r2(sumSpans(dead))
  const deadCovered = heard ? r2(sumSpans(deadAir(k, speech)) - deadTotal) : null
  const aspect = field(look, 'frame.aspect', 'auto')
  // 'auto' is not "no shape": it is the take's own, and the take's own is often exactly
  // what was asked for. Calling it wrong made every edit nobody had set a shape on
  // block forever, and both callers already hold the width and height to answer with.
  const cropBox = doc.crop && +doc.crop.w > 0 && +doc.crop.h > 0 ? doc.crop : null
  const shape = cropBox ? [+cropBox.w, +cropBox.h]
    : +input.width > 0 && +input.height > 0 ? [+input.width, +input.height] : null
  const takeAspect = shape ? Math.round((shape[0] / shape[1]) * 10000) / 10000 : null
  const shown = aspect === 'auto' ? takeAspect : aspectNumber(aspect)
  const burn = !!field(look, 'captions.show', true)
  const target = brief && Number.isFinite(+brief.seconds) && +brief.seconds > 0
    ? +brief.seconds
    : (spec && spec.seconds) || null
  const want = (brief && brief.aspect) || (spec && spec.aspect) || null

  const items = []
  const add = (rule, severity, what, fix, at = null) => { items.push({ rule, severity, what, at, fix }) }
  const call = (tool, args, why) => ({ tool, args: { ...(path ? { path } : {}), ...args }, why })
  // A moment worth aiming a search at: the middle of the longest beat, else of the edit
  const bigBeat = arr(input.beats).slice().sort((a, b) => (b.end - b.start) - (a.end - a.start))[0]
  const midEdit = k.length ? r2(k[0].start + Math.min(k[0].end - k[0].start, seconds / 2)) : 0
  const somewhere = bigBeat ? r2((+bigBeat.start + +bigBeat.end) / 2) : midEdit

  // Nothing was asked for. Everything below that needs a target is skipped, and this is
  // the finding: an edit with no brief cannot be wrong, which is the problem.
  if (!brief) {
    add('no-brief', 'note', 'No brief for this take, so the length, the shape and what must be hidden are nobody\'s call yet.',
      call('direct', { brief: { seconds: null, aspect: null, where: null } },
        'write what was asked for first, then review measures against it'))
  }

  // What must not be seen is the one thing never quietly dropped.
  const hide = arr(brief && brief.must_hide).filter(Boolean)
  // Only the ones the export actually draws. A redact sitting on material the edit cut
  // away hides nothing, and counting it cleared the one rule that is never meant to be
  // quietly dropped. One mark is also not three things hidden: a brief naming three
  // needs three, or the rule is asserting something it has not checked.
  const drawnHides = redactions.filter(m => +m.end > +m.start && across(k, +m.start, +m.end).length)
  if (hide.length && drawnHides.length < hide.length) {
    const none = !drawnHides.length
    const missed = hide.slice(drawnHides.length)
    add('redactions', 'blocking',
      none
        ? `The brief says to hide ${hide.slice(0, 3).join(', ')}, and nothing this edit draws is redacted or blurred.`
        : `The brief names ${plural(hide.length, 'thing')} to hide and this edit draws ${plural(drawnHides.length, 'redaction')}. ` +
          `Nothing covers ${missed.slice(0, 3).join(', ')}.`,
      call('find_on_screen', { at: somewhere, query: String(missed[0] || hide[0]) },
        'find it at that moment, then apply_edit a redact mark on its box; blur softens and can be undone, so redact anything private'),
      somewhere)
  }

  // The shape of the deliverable.
  if (want && shown !== aspectNumber(want)) {
    const is = aspect === 'auto'
      ? (takeAspect === null ? 'the take\'s own shape' : `the take's own shape, ${r2(takeAspect)} to 1`)
      : aspect
    add('aspect', 'blocking',
      `The edit is ${is} and ${brief && brief.aspect ? 'the brief asks for' : `${spec.where} wants`} ${want}.`,
      call('apply_look', { look: { frame: { aspect: want } } },
        'the space round the take is filled by the background, never black bars'))
  }

  // The words, and whether they are on the picture.
  const muted = !!(spec && spec.muted)
  // A take with no cues is untranscribed, not silent: only the caller knows there is no
  // audio at all, and a demo that reaches a muted page without captions is the commonest
  // way this job comes out wrong.
  if (!cues.length && input.silent !== true) {
    add('captions', muted ? 'blocking' : 'should',
      muted
        ? `There are no captions, and ${spec.why}.`
        : 'There are no captions on this take.',
      call('transcribe', {}, 'then apply_edit the cues, or let the transcript land and set captions.show'))
  } else if (cues.length && muted && !burn) {
    add('burn-in', 'blocking',
      `The captions are not burned in, and ${spec.why}.`,
      call('apply_look', { look: { captions: { show: true } } }, 'burned captions are drawn on the picture itself'))
  }

  // The work put back, the length, the silence: all three move the same number, so
  // they are one decision and review hands over one call for it. Two calls that each
  // retime the edit are two halves of a choice the agent was never shown, and a pair of
  // them walked a real job in a circle.
  const one = decide({
    doc, k, seconds, target, keeps, dead, deadTotal, deadOn, spec, call, cues,
    phrases: arr(brief && brief.must_keep).filter(Boolean), beats: arr(input.beats),
  })
  if (one) items.push(one)

  // Objects the export never draws, because the edit cut their moment away.
  for (const z of zooms) {
    if (!z || !z.id || !(+z.end > +z.start)) continue
    if (across(k, +z.start, +z.end).length) continue
    add('never-drawn', 'should', `${z.id} (${secs(r2(+z.start))} to ${secs(r2(+z.end))}) is on material this edit cuts out, so it is never drawn.`,
      call('apply_edit', { doc: { remove: [z.id] } }, 'or move it onto a kept piece'))
  }
  for (const m of marks) {
    if (!m || !m.id || !(+m.end > +m.start)) continue
    if (across(k, +m.start, +m.end).length) continue
    const hidden = m.kind === 'redact' || m.kind === 'blur'
    add('never-drawn', hidden ? 'note' : 'should',
      `${m.id} (${m.kind}, ${secs(r2(+m.start))} to ${secs(r2(+m.end))}) is on material this edit cuts out, so it is never drawn` +
      `${hidden ? ', and what it hid is not in the export either' : ''}.`,
      call('apply_edit', { doc: { remove: [m.id] } }, hidden ? 'nothing is exposed; it is clutter in the document' : 'or move it onto a kept piece'))
  }

  // A lift or a spotlight that runs over a cut: whatever it was aimed at cannot be under
  // it for the whole span, because the frame under it changes at the join.
  for (const m of marks) {
    if (!m || !m.id || !FOCUS.includes(m.kind) || !(+m.end > +m.start)) continue
    const parts = across(k, +m.start, +m.end)
    if (!parts.length) continue
    const held = parts.reduce((n, p) => n + p.seconds, 0)
    // Two pieces means the frame under it changes at the join. One piece and a short
    // measure means the cut took the rest of its span away, which the orphan check
    // never saw because the mark was not orphaned, only shortened.
    if (parts.length < 2 && held >= (+m.end - +m.start) * WHOLE - 0.01) continue
    const best = parts.slice().sort((a, b) => b.seconds - a.seconds)[0]
    const start = r2(Math.max(+m.start, best.piece.start)), end = r2(Math.min(+m.end, best.piece.end))
    add('spans-a-cut', 'should',
      parts.length > 1
        ? `${m.id} (${m.kind}) runs across a cut, so its element is only under it for part of the span.`
        : `${m.id} (${m.kind}) is drawn for ${secs(r2(held))} of its ${secs(r2(+m.end - +m.start))}: the edit cuts the rest of its span away.`,
      call('apply_edit', { doc: { marks: [{ id: m.id, start, end }] } },
        'marks merge by id, so this retimes that one and leaves the rest alone'),
      r2(+m.start))
  }

  // Two of them on the same place at the same time.
  for (const c of focusClashes(marks)) {
    add('focus-clash', 'should',
      `${c.a} and ${c.b} (${c.kinds.join(' and ')}) cover the same place from ${secs(c.start)} to ${secs(c.end)}, so one dims the other.`,
      call('apply_edit', { doc: { remove: [c.b] } }, 'keep the one the person asked for and say which went'),
      c.start)
  }

  // How much the camera moves, against how long the thing is.
  const budget = Math.max(2, Math.round(seconds / ZOOM_EVERY))
  if (zooms.length > budget) {
    const extra = zooms.filter(z => z && z.id)
      .slice()
      .sort((a, b) => (+a.end - +a.start) - (+b.end - +b.start))
      .slice(0, zooms.length - budget)
      .map(z => z.id)
    add('zoom-density', 'should',
      `${plural(zooms.length, 'zoom')} in ${secs(seconds)} of output, about one every ${secs(r2(seconds / zooms.length))}. ` +
      `At this length ${budget} is the ceiling: past it the camera never rests and nothing on screen is read.`,
      call('apply_edit', { doc: { remove: extra } }, 'the shortest ones first; keep the zooms that land on a step'))
  } else if (!zooms.length && !doc.autoZoom && seconds > 20) {
    add('no-zooms', 'note', `${secs(seconds)} of output and the camera never moves.`,
      call('find_on_screen', { at: somewhere, ...(bigBeat && bigBeat.label ? { query: String(bigBeat.label) } : {}) },
        'find what the moment is about, then apply_edit a zoom with element: its E id'), somewhere)
  }

  // Zooms nobody aimed at anything.
  for (const z of handAimed(zooms)) {
    const at = r2(+z.start + Math.min(1, (+z.end - +z.start) / 3))
    add('hand-aimed', 'note',
      `${z.id} is centred on ${r2(+z.x)}, ${r2(+z.y)} at ${r2(+z.scale)}x, which is a point somebody worked out rather than a thing on screen.`,
      call('find_on_screen', { at }, 'send the zoom back with element: its E id and Fetch fits the scale to it'), at)
  }

  // The ground against the take's own ends, which levels.js already measured.
  const lv = input.levels
  const bg = field(look, 'background.kind', 'none')
  const ground = bg === 'solid' ? luma(field(look, 'background.color', null)) : null
  if (lv && Number.isFinite(+lv.lo) && Number.isFinite(+lv.hi) && ground !== null && +lv.hi > +lv.lo) {
    const near = Math.abs(ground - +lv.lo) < EDGE ? 'black point' : Math.abs(ground - +lv.hi) < EDGE ? 'white point' : null
    if (near) {
      const dark = near === 'black point'
      const suited = pickLook(input.looks, dark ? 'light' : 'dark')
      add('ground', 'note',
        `The ground is within 24 levels of the take's own ${near} (${r2(ground)} against ${r2(near === 'black point' ? +lv.lo : +lv.hi)}), ` +
        'so the take\'s edge is carried by the hairline alone.',
        suited
          ? call('apply_look', { preset: suited.name }, `${suited.label} is for ${suited.for || 'the other end of the scale'}`)
          : call('apply_look', { look: { background: { kind: 'solid', color: dark ? '#EDE6DA' : '#1A1714' } } },
            'a ground the take stands off, rather than one it sinks into'))
    }
  }

  ruleWords(input, add, call)
  const { bad, should, off, verdict, score } = settle(items, input.declined)
  const summary = (bad || should
    ? `${verdict === 'not ready' ? 'Not ready' : 'Nearly'}: ` +
      [bad ? `${plural(bad, 'thing')} to fix` : '', should ? `${plural(should, 'thing')} worth fixing` : '']
        .filter(Boolean).join(', ') + '.'
    : `Ready: ${secs(seconds)}${target ? ` against the ${secs(target)} asked for` : ''}, nothing the rubric can name.`) +
    (off ? ` ${plural(off, 'item')} declined.` : '')

  return {
    verdict,
    score,
    summary,
    items,
    look_at: lookAt(items, k, input.beats, seconds),
    measured: {
      seconds,
      target,
      aspect: aspect === 'auto' ? 'auto' : aspect,
      wanted_aspect: want,
      where: spec ? spec.where : null,
      clips: k.length,
      zooms: zooms.length,
      zoom_ceiling: budget,
      marks: marks.length,
      redactions: redactions.length,
      redactions_drawn: drawnHides.length,
      captions: cues.length,
      captions_burned: burn,
      // `gaps` is the head of the list and `more` says how much of it is not shown: a
      // truncated list that does not say so is a sentence and a table disagreeing.
      dead_air: heard
        ? { seconds: deadTotal, covered: deadCovered, gaps: dead.slice(0, 6), more: Math.max(0, dead.length - 6) }
        : { seconds: null, covered: null, gaps: [], more: 0, why: 'nothing says where anybody spoke: no captions and no beats' },
      // The work, and how much of each of it this edit actually draws. An agent that
      // wants to check review kept its promise reads this and nothing else.
      must_keep: keeps.map(w => ({ id: w.id, what: w.what, seconds: r2(w.end - w.start), drawn: w.drawn })),
      // A phrase the brief named that nobody said is a promise nothing is holding, and
      // silence about it reads as "the brief named nothing".
      must_keep_unmatched: arr(keeps.unmatched),
      ground: ground === null ? null : r2(ground),
      take_levels: lv && Number.isFinite(+lv.lo) ? { lo: r2(+lv.lo), hi: r2(+lv.hi) } : null,
    },
  }
}


// ── the one call that retimes the edit ──────────────────────────────────────
/**
 * The single finding that changes what the edit keeps. Putting the work back, the
 * length, the silence: every one of them moves the same number, so review decides
 * between them once instead of handing over two calls that pull opposite ways.
 *
 * Three rules hold over every answer below. Nothing it offers shortens a span in
 * `keeps`, and `damage` is what says so rather than the wording. Nothing it offers
 * takes the edit past the number it was asked to reach: cuts are sized against the
 * target and the last one is trimmed to the second. And where more than one answer is
 * defensible it says so in `choices`, with `fix` set to the one that is safe to apply
 * without reading the rest.
 *
 * Returns the one item, or null when nothing about the length or the silence is worth
 * a call.
 */
function decide(c) {
  const { doc, k, seconds, target, keeps, dead, deadTotal, deadOn, spec, call, phrases, beats } = c
  const dur = +doc.dur > 0 ? +doc.dur : (k.length ? k[k.length - 1].end : 0)
  const near = target ? Director.tolerance(target) : 0
  const tight = !spec || spec.tight
  const lost = keeps.filter(w => w.restore && w.drawn < (w.end - w.start) * WHOLE - 0.01)
  // What fit_to_length has to be told to keep: the phrases the brief named and the id
  // of every beat holding a piece of the work, which is the one argument fit reads.
  const guard = [...phrases.map(String),
    ...beats.filter(b => b && b.id && keeps.some(w => Math.min(+b.end, w.end) - Math.max(+b.start, w.start) > 0.1))
      .map(b => b.id)]

  // 1. The work, cut out or cut into. Nothing else is decided until it is back: an edit
  //    missing its closing card is not a short edit, it is the wrong video.
  if (lost.length) {
    const gone = lost.filter(w => w.drawn <= 0.01)
    const head = gone.length ? gone : lost
    const detail = head.slice(0, 3).map(w => (gone.length
      ? `${w.what}, which is in the take at ${secs(w.start)}`
      : `${w.what}: ${secs(w.drawn)} of its ${secs(r2(w.end - w.start))} is drawn`)).join(', ')
    const rest = lost.length > head.length
      ? ` ${lost.length - head.length} more of the work is clipped by the same cuts.` : ''
    let pieces = including(k, lost.map(w => [w.start - BREATH, w.end + BREATH]), dur)
    let tail = ''
    // Putting it back makes the edit longer, and the silence is what pays for that.
    if (target && outLength(pieces) > target + near) {
      const { cuts } = silenceCuts(pieces, deadOn(pieces), keeps, r2(outLength(pieces) - target), near)
      const cut = without(pieces, cuts)
      if (!damage(keeps, cut).length) pieces = cut
      const now = r2(outLength(pieces))
      tail = now > target + near
        ? ` With it back the edit runs ${secs(now)}, still over the ${secs(target)} asked for: fit_to_length is the next call, and keep names what has to survive it.`
        : ` What it costs comes out of the silence, so the edit lands on ${secs(now)}.`
    }
    return {
      rule: gone.length ? 'must-keep' : 'clipped',
      severity: lost.some(w => w.promised) ? 'blocking' : 'should',
      what: `${gone.length ? 'This edit does not draw' : 'A cut leaves only part of'} ${detail}.${rest}${tail}`,
      at: r2(lost[0].start),
      fix: call('apply_edit', { doc: { clips: pieces.map(clipOf) } },
        'clips is the whole list, so this is the edit exactly as it stands with the work put back'),
    }
  }

  // 2. Longer than the brief asked for. The silence pays first, and it pays exactly
  //    what is owed: the old advice cut an edit eleven seconds past its own target.
  if (target && seconds - target > near) {
    const over = r2(seconds - target)
    const far = over > target * 0.25
    const { cuts, free } = silenceCuts(k, dead, keeps, over, near)
    const floor = workSeconds(keeps, k)
    if (free >= over - 0.01 && cuts.length) {
      const pieces = without(k, cuts)
      if (!damage(keeps, pieces).length) {
        return {
          rule: 'length', severity: far ? 'blocking' : 'should',
          what: `The edit runs ${secs(seconds)} against the ${secs(target)} asked for, ${secs(over)} long, and ` +
            `${secs(free)} of it is silence nobody is speaking over.`,
          at: r2(cuts[0][0]),
          fix: call('apply_edit', { doc: { clips: pieces.map(clipOf) } },
            `this takes ${secs(over)} out of the pauses, nothing out of the cards, the lifts or the words, and lands on ${secs(r2(outLength(pieces)))}`),
        }
      }
    }
    // The target cannot be reached without cutting into the work itself. That is a
    // choice somebody has to make, not a cut review makes quietly on their behalf.
    if (target < floor + 1) {
      const room = Math.ceil(floor + 1)
      const move = call('direct', { brief: { seconds: room } },
        `${secs(room)} is the shortest this edit can be and still be what it is for`)
      // The cheapest thing to give up if the number is the thing that cannot move: the
      // shortest piece of the work, named, because "cut into them" is not a call.
      const cheapest = keeps.filter(w => w.id).sort((a, b) => (a.end - a.start) - (b.end - b.start))[0]
      return {
        rule: 'length', severity: 'should',
        what: `The edit runs ${secs(seconds)} against the ${secs(target)} asked for, and ${secs(floor)} of it is the cards, ` +
          `the lifts and the words the brief named. ${secs(target)} cannot be reached without cutting into them, so this is ` +
          'one decision and not two: move the target, or say which of them may go.',
        at: null,
        fix: move,
        ...(cheapest ? { choices: [
          { what: `move the target to ${secs(room)}`, fix: move },
          { what: `hold the target and give up ${cheapest.what}`,
            fix: call('apply_edit', { doc: { remove: [cheapest.id] } },
              'take out the one you are willing to lose, then ask for the length again') },
        ] } : {}),
      }
    }
    return {
      rule: 'length', severity: far ? 'blocking' : 'should',
      what: `The edit runs ${secs(seconds)} against the ${secs(target)} asked for, ${secs(over)} long. ` +
        `${secs(free)} of that can come out of the silence and the rest has to come out of what is said.`,
      at: null,
      fix: call('fit_to_length', { seconds: target, ...(guard.length ? { keep: guard } : {}) },
        'it cuts the fillers and the pauses first, then whole beats, and keep names what has to survive the cut'),
    }
  }

  // 3. Shorter than the brief asked for. Only material can answer this, and the take
  //    either has some or it does not.
  if (target && target - seconds > near) {
    const short = r2(target - seconds)
    const spare = r2(Math.max(0, dur - k.reduce((n, p) => n + (p.end - p.start), 0)))
    if (spare > 1) {
      const pieces = fillTo(k, dur, target)
      const now = r2(outLength(pieces))
      return {
        rule: 'length', severity: short > target * 0.25 ? 'blocking' : 'should',
        what: `The edit runs ${secs(seconds)} against the ${secs(target)} asked for, ${secs(short)} short. ` +
          `There is ${secs(spare)} of the take not in it.`,
        at: null,
        fix: call('apply_edit', { doc: { clips: pieces.map(clipOf) } },
          `this puts back the material nearest the cuts and lands on ${secs(now)}, rather than restoring the whole take and cutting it again`),
      }
    }
    // The whole take is in and it is still short. Nothing can cut its way to the
    // number, so either the target moves or the take is played slower, and the first of
    // those is the one that cannot be wrong.
    const accept = call('direct', { brief: { seconds: Math.round(seconds) } },
      'the take is not long enough for the brief: change the target, record more, or hold the number with ' +
      'fit_to_length as far as the stretch.reach it names')
    // The old second choice was a rate on every clip, which slows the narration, and
    // slowing a voice is the one thing fit refuses to do. fit_to_length slows the
    // moments already holding with nobody speaking over them and nothing else, and it
    // says in stretch.reach how far that honestly goes, so a target past it comes back
    // as "record more" rather than as a drawled demo.
    const hold = call('fit_to_length', { seconds: target, ...(guard.length ? { keep: guard } : {}) },
      'this spends the missing seconds on the moments already holding still, never on the words; ' +
      'stretch.reach in its result is the longest this edit can honestly be')
    return {
      rule: 'length', severity: 'should',
      what: `The edit runs ${secs(seconds)} against the ${secs(target)} asked for, ${secs(short)} short, and the whole take ` +
        'is already in it. Nothing can cut its way to the number, so either the target moves or the moments ' +
        'already holding still hold longer.',
      at: null,
      fix: accept,
      choices: [
        { what: `take ${secs(r2(seconds))} as the length`, fix: accept },
        { what: `hold the ${secs(target)} by dwelling longer on what is already holding`, fix: hold },
      ],
    }
  }

  // 4. The length is what was asked for, or nobody asked. What is left is the silence,
  //    and what can come out of it is what the number can spare.
  if (!dead.length || !tight || deadTotal < DEAD_GAP) return null
  // The edge of the tolerance, not the target itself: silence the length can afford to
  // lose comes out now, and not one second past that. Cutting past this edge is how a
  // 60 second demo came back at 44.8 s on review's own advice.
  const budget = target ? r2(seconds - (target - near)) : Infinity
  const { cuts, free } = silenceCuts(k, dead, keeps, budget)
  const worst = dead.slice().sort((a, b) => (b.end - b.start) - (a.end - a.start))[0]
  const line = `${secs(deadTotal)} of the edit has nobody speaking, in ${plural(dead.length, 'gap')}, the longest ` +
    `${secs(r2(worst.end - worst.start))} at ${secs(worst.start)}.`
  if (cuts.length) {
    const pieces = without(k, cuts)
    if (!damage(keeps, pieces).length) {
      const after = r2(outLength(pieces))
      const took = r2(seconds - after)
      const left = r2(free - took)
      return {
        rule: 'dead-air', severity: 'should',
        what: line + (target && left >= MIN_CUT
          ? ` ${secs(took)} of it can come out with the edit still on the ${secs(target)} asked for, and the last ${secs(left)} only if the target moves with it.`
          : ''),
        at: worst.start,
        fix: call('apply_edit', { doc: { clips: pieces.map(clipOf) } },
          `this takes ${secs(took)} of silence out and leaves ${secs(after)}; the cards, the lifts and the words are untouched`),
      }
    }
  }
  // Nothing can come out and leave the length where the brief wants it. Silence worth
  // less than the tolerance is not a decision at all, and a rubric that keeps naming
  // one is a rubric an agent learns to ignore.
  if (!target || free <= near) return null
  // So the silence and the length are one decision, and saying so is what stops the
  // pair of calls that used to walk an edit back and forth for ever.
  const all = without(k, silenceCuts(k, dead, keeps, Infinity).cuts)
  const bottom = r2(outLength(all))
  // Rounded up, never down: a target under what the silence can pay for is a target the
  // next call cannot reach without cutting into what was said.
  const move = call('direct', { brief: { seconds: Math.ceil(bottom) } },
    `${secs(bottom)} is what this edit is once the silence is out of it; set that and the cut is the next call`)
  return {
    rule: 'dead-air', severity: 'note',
    what: `${line} Taking it out leaves ${secs(bottom)}, ${secs(r2(target - bottom))} under the ${secs(target)} asked for, ` +
      'so the silence and the length are one decision: move the target with the cut, or leave the silence in and say why.',
    at: worst.start,
    fix: move,
    choices: [
      { what: `tighten to ${secs(bottom)} and move the target with it`, fix: move },
      { what: 'leave the silence in',
        fix: call('direct', { note: 'the pauses are the demo breathing and stay' },
          'a judgement written down closes the item; review is handed it as declined and the verdict stops turning on it') },
    ],
  }
}

// ── the rubric for a picture ────────────────────────────────────────────────
//
// A still goes through this file and not through the rules above. Every one of those is
// about a clock: how long the edit runs, how much of it nobody speaks over, how often
// the camera moves, whether a mark outlives the material under it. On one frame they
// all pass, which is how review came to answer "ready, 10" for an untouched capture on
// a gradient and, word for word and to the same ten, for that capture wearing two title
// bars, a blank address field and a lift over the whole page. A checker that says ten
// to everything is worse than no checker, and this file learned that once already.
//
// What is judged instead is the picture, off the plan the compositor draws it from.
// prepare() is run here, once, and every geometric finding is read off it: the box each
// capture was given, the shell drawn round it, where each mark landed, and which marks
// the plan dropped for want of room. So the judge and the renderer cannot disagree
// about where anything is, for the same reason review and the export cannot disagree
// about a length. Where a plan cannot be made the rules that need only the document
// still run, and `measured.planned` says which half of the rubric was asked.
//
// No pixel is read. What a capture is a picture of is not in the document, so every
// rule here is something the document can prove: nothing on the frame says what to look
// at, something private under a blur rather than a redaction, a shell that does not fit
// what it frames, a ground sitting where the capture's own ends are, a subject too
// small to be worth the treatment laid over everything else.

const { GRADIENTS, MESHES } = require('./look-schema')

// The compositor's own ceiling for a still (ui/compositor/index.js, SHOT_SCALES): the
// plan is drawn at one, two or three times its size. Past that the file grows and the
// picture does not, so a box that cannot carry a capture's pixels at three cannot carry
// them at all.
const TOP_SCALE = 3
// A raised thing under this share of the capture it sits on, and small in both
// directions, is a fragment. A lift dims and blurs everything outside itself, and at
// this size what is left reads as a tooltip floating over a softened page rather than
// as the thing the picture is about. A row across a window is about a thirtieth of it
// by area and is not a fragment at all, which is why the long side has a say: a mark
// reaching LONG of either side of the capture is a shape rather than a scrap.
const SUBJECT_MIN = 0.03
const LONG = 0.5
// And over this share it is not raising a thing on the page, it is raising the page.
const SUBJECT_MAX = 0.5
// The room the drawn picture keeps off the edge of the frame, as a share of the shorter
// side. Under this the shadow has nowhere to fall and the composition reads as a crop.
const GUTTER = 0.015
// What a blur has to destroy is a stroke of type, and a stroke is the same few pixels
// whether the box round it is one account row or half the page. So the ruler is a line
// of type in the capture's own pixels and never the box: measured against the box, a
// 576 px decorative blur at sigma 60 was called weak, and blocking, while a 38 px blur
// over an account row at sigma 5 passed, which is the wrong answer on both. Sigma in
// capture pixels, under which the words keep their shape, and a shape is most of a word.
const SOFT_BLUR = 12
// Which of the plan's mark lists a document mark is drawn into (ui/compositor/marks.js).
const DRAWN_AS = { redact: 'redact', blur: 'blur', lift: 'focus', spotlight: 'focus', step: 'steps', loupe: 'loupe', arrow: 'arrow' }
// The lists themselves, once each: a lift and a spotlight are both drawn into focus,
// and counting that list twice made two marks out of one.
const DRAWN_LISTS = [...new Set(Object.values(DRAWN_AS))]
// The rules that are about a clock, named in the result rather than quietly skipped. An
// agent reads this as a contract, and a promise kept in spirit and broken in the letter
// is broken.
const NOT_ABOUT_A_PICTURE = [
  ['length', 'one frame has no length, so the seconds a brief asks for are not about this picture'],
  ['dead-air', 'nobody is speaking over a still, so there is no silence in it to cut'],
  ['captions', 'a capture carries no sound and nothing to transcribe'],
  ['burn-in', 'there are no captions on one frame to burn in'],
  ['zoom-density', 'the camera does not move on one frame'],
  ['no-zooms', 'the camera does not move on one frame'],
  ['hand-aimed', 'a still has no zooms to aim'],
  ['spans-a-cut', 'there are no cuts for a mark to run across'],
  ['must-keep', 'nothing is cut out of one frame, so nothing the brief named can be missing from it'],
]

// A crop held as fractions, in the capture's own pixels. The plan answers this where
// there is one; this is the same answer for a document nothing could be planned from.
const cropPx = (crop, w, h) => (crop && +crop.w > 0 && +crop.h > 0
  ? { x: Math.round(+crop.x * w), y: Math.round(+crop.y * h), w: Math.round(+crop.w * w), h: Math.round(+crop.h * h) }
  : { x: 0, y: 0, w: +w || 0, h: +h || 0 })

// The share of its own capture a box covers. A mark's box is already fractions of the
// capture it is drawn on, so this is its area and nothing has to be divided by anything.
const shareOf = b => (b && b.w > 0 && b.h > 0 ? r2(b.w * b.h) : 0)
const stemOf = p => String(p || '').split('/').pop().replace(/\.[^.]+$/, '') || null

/**
 * The plan the picture is drawn from, or null where one cannot be made.
 *
 * Required here rather than at the top of the file: an export of a recording loads this
 * module to be judged by it and has no business loading the planner to do so. prepare()
 * is pure and reads no pixels, so this stays a module a test can state a case against.
 */
function planOf(shot) {
  try {
    const Shot = require('./shot')
    const Plan = require('./compositor/plan')
    if (!(+shot.w > 0 && +shot.h > 0)) return null
    return Plan.prepare(Shot.toExportOpts(shot), Shot.toMeta(shot), {})
  } catch { return null }
}

// Whether the picture draws this one mark at all, asked by planning it on its own. The
// plan carries no ids, so counting says one was dropped and this says which: an arrow
// with no clear room beside the box it points at is left out by the mark pass, and a
// finding that cannot name the mark is not a finding an agent can act on.
function draws(shot, m) {
  const p = planOf({ ...shot, group: null, marks: [m] })
  return !!(p && arr(p.marks[DRAWN_AS[m.kind]]).length)
}

/**
 * What the capture is standing on, as a range of luma.
 *
 * A solid is one number. A sweep and a mesh are a range, and a range with one end clear
 * of the capture's own ends gives the take somewhere to stand, so both are carried and
 * the rule asks for both before it speaks. An image ground, and a ground made of the
 * take's own blur, are pictures nobody has measured: a number invented for them would
 * be worse than the null they get.
 */
function groundRange(look) {
  const kind = field(look, 'background.kind', 'none')
  if (kind === 'solid') {
    const g = luma(field(look, 'background.color', null))
    return g === null ? null : { lo: g, hi: g, what: 'the ground' }
  }
  if (kind === 'gradient') {
    const ends = (GRADIENTS[field(look, 'background.gradient', 'dusk')] || []).map(luma).filter(v => v !== null)
    return ends.length ? { lo: Math.min(...ends), hi: Math.max(...ends), what: 'the sweep' } : null
  }
  if (kind === 'mesh') {
    const pts = (MESHES[field(look, 'background.mesh', 'dusk')] || []).map(p => luma(p[3])).filter(v => v !== null)
    return pts.length ? { lo: Math.min(...pts), hi: Math.max(...pts), what: 'the mesh' } : null
  }
  return null
}

/**
 * review on a capture: one frame, judged as a picture.
 *
 * It takes the shot document itself (ui/shot.js) rather than a projection of it, because
 * what a still has and an edit does not, a group, the capture's own size, marks with no
 * times, is exactly what there is to judge. review() routes here on `doc.kind`, so a
 * caller holding either document calls one function and reads one shape back.
 *
 *   doc     the shot, marks placed and never timed
 *   brief   the job's brief; its shape and what it says to hide are what mean anything
 *           on a picture, and its length is named under not_judged rather than measured
 *   levels  { lo, hi }, the capture's own black and white points
 *   looks   list_looks' entries, so a ground is named by what it is for
 *   path    the capture, so every fix is a call that can be made as it stands
 *
 * Returns what review returns, plus `not_judged`.
 */
function still(input = {}) {
  const shot = input.doc || {}
  const path = input.path || shot.src || null
  const brief = input.brief || null
  const where = whereSpec(brief && brief.where)
  const look = shot.look || {}
  const own = arr(shot.marks)
  const members = shot.group ? arr(shot.group.members).filter(Boolean) : []
  const plan = planOf(shot)
  const lv = input.levels

  const items = []
  const add = (rule, severity, what, fix, extra = {}) => items.push({ rule, severity, what, at: null, fix, ...extra })
  const call = (tool, args, why) => ({ tool, args: { ...(path ? { path } : {}), ...args }, why })
  // One frame, so there is one moment, and find_on_screen asks for one either way.
  const AT = 0

  // What is in the picture, each with the box the plan gave it and the marks drawn on
  // it. A group of one is a take, so a lone capture is this list with one entry and
  // every rule below is written once. A group draws the shot's own marks on its first
  // capture (ui/compositor/plan.js), so that is where they are judged.
  const captures = plan && plan.group
    ? plan.group.map((m, i) => ({
      id: (members[i] && members[i].id) || `C${i + 1}`,
      what: `the capture in ${(members[i] && members[i].id) || `C${i + 1}`}`,
      src: m.src, shown: m.crop, box: m.rect, device: m.device || null, drawn: m.marks,
      marks: [...arr(members[i] && members[i].marks), ...(i === 0 ? own : [])],
    }))
    : [{
      id: shot.id || null, what: 'the capture',
      src: { w: +shot.w || 0, h: +shot.h || 0 },
      shown: plan ? plan.crop : cropPx(shot.crop, +shot.w || 0, +shot.h || 0),
      box: plan ? plan.rect : null,
      device: plan ? plan.device : null, drawn: plan ? plan.marks : null, marks: own,
    }]
  const marks = captures.flatMap(c => c.marks.map(m => ({ ...m, on: c })))
  const focus = marks.filter(m => m && FOCUS.includes(m.kind))
  const hides = marks.filter(m => m && HIDES.includes(m.kind))

  // Nothing was asked for, so nothing about this picture can be wrong, which is the
  // finding. A still has no length, so the one field that says what it is for is `what`.
  if (!brief) {
    add('no-brief', 'note', 'No brief for this capture, so what the picture is for, its shape and what must be hidden are nobody\'s call yet.',
      call('direct', { brief: { what: null, aspect: null, where: null } },
        'write what the picture is for first, then review measures against it'))
  }

  // ── what must not be seen ──
  const hide = arr(brief && brief.must_hide).filter(Boolean)
  const covered = hides.filter(m => rect(m))
  if (hide.length && covered.length < hide.length) {
    const missed = hide.slice(covered.length)
    add('redactions', 'blocking',
      covered.length
        ? `The brief names ${plural(hide.length, 'thing')} to hide and the picture draws ${plural(covered.length, 'redaction')}. ` +
          `Nothing covers ${missed.slice(0, 3).join(', ')}.`
        : `The brief says to hide ${hide.slice(0, 3).join(', ')}, and nothing on this picture is redacted or blurred.`,
      call('find_on_screen', { at: AT, query: String(missed[0] || hide[0]) },
        'find it on the capture, then apply_edit a redact mark on its box; a still is read close, so redact anything private rather than blurring it'))
  }
  // A blur is a filter over the words and a redaction is a hole where they were. On a
  // recording the difference is small, because the frame is gone in a thirtieth of a
  // second; on a still somebody can sit in front of it. So every blur is measured, in
  // sigma against a stroke of type, and only the ones that leave a word its shape are
  // named. A strong blur over something the brief called private is not a finding: it
  // did the job, and offering to convert it replaced a soft 576 px field with an opaque
  // slab on a picture that was already right. The old arm fired on every blur in the
  // document whenever the brief named anything at all, near it or not.
  //
  // One finding and one call for the lot of them. Marks merge by id, so turning three
  // blurs into three redactions is one apply_edit, and three items that each say the
  // same sentence about a different id is a list an agent stops reading.
  const soft = []
  for (const m of hides) {
    if (m.kind !== 'blur' || !m.id) continue
    const b = rect(m)
    // The plan's own sigma where it drew this one, so the strength judged is the
    // strength rendered rather than the one the document happens to hold.
    const drawn = b && m.on.drawn ? arr(m.on.drawn.blur)
      .find(x => Math.abs(x.w / m.on.shown.w - b.w) < 0.02 && Math.abs(x.h / m.on.shown.h - b.h) < 0.02) : null
    const sigma = drawn ? +drawn.sigma : +m.strength
    const side = b ? Math.min(b.w * m.on.shown.w, b.h * m.on.shown.h) : 0
    if (side > 0 && Number.isFinite(sigma) && sigma < SOFT_BLUR) {
      soft.push({ id: m.id, side: Math.round(side), sigma: r2(sigma) })
    }
  }
  if (soft.length) {
    add('soft-redaction', hide.length ? 'blocking' : 'should',
      `${soft.map(s => s.id).join(', ')} ${soft.length === 1 ? 'blurs a box' : 'blur boxes'} about ${soft[0].side} px across at strength ` +
      `${soft[0].sigma}, which is under the ${SOFT_BLUR} px of blur it takes to lose a stroke of type in a capture, so the words keep ` +
      `their shape. A blur softens and can be undone, and a still is looked at for as long as somebody likes.`,
      call('apply_edit', { doc: { marks: soft.map(s => ({ id: s.id, kind: 'redact' })) } },
        'marks merge by id, so this turns those into redactions on the same boxes and leaves everything else alone'),
      { choices: [
        { what: 'make them holes rather than filters',
          fix: call('apply_edit', { doc: { marks: soft.map(s => ({ id: s.id, kind: 'redact' })) } },
            'marks merge by id, so this turns those into redactions on the same boxes and leaves everything else alone') },
        { what: 'keep the blur and turn it up past a stroke of type',
          fix: call('apply_edit', { doc: { marks: soft.map(s => ({ id: s.id, strength: SOFT_BLUR * 2 })) } },
            'twice the floor, which is a word gone rather than softened; preview_frame to read what is left') },
      ] })
  }

  // ── the shape of the deliverable ──
  const aspect = field(look, 'frame.aspect', 'auto')
  const boxShape = captures.length > 1 && plan ? plan.rect : captures[0].shown
  const ownAspect = boxShape && boxShape.h > 0 ? Math.round((boxShape.w / boxShape.h) * 10000) / 10000 : null
  // Under 'auto' the shape that ships is the plan's own frame and not the capture's
  // crop: backdropGeometry adds one square margin on every side, so a 1920x1080 capture
  // goes out 1920x1170. Measured off the crop, a blocking rule cleared a file that was
  // never 16:9, in the same result whose `measured.picture` said so.
  const outShape = aspect === 'auto' && plan && plan.H > 0
    ? Math.round((plan.W / plan.H) * 10000) / 10000 : ownAspect
  const shown = aspect === 'auto' ? outShape : aspectNumber(aspect)
  const want = (brief && brief.aspect) || (where && where.aspect) || null
  if (want && shown !== aspectNumber(want)) {
    const is = aspect === 'auto'
      ? (outShape === null ? 'whatever shape the capture and its margins come to' : `${r2(outShape)} to 1, the capture and its margins`)
      : aspect
    add('aspect', 'blocking',
      `The picture is ${is} and ${brief && brief.aspect ? 'the brief asks for' : `${where.where} wants`} ${want}.`,
      call('apply_look', { look: { frame: { aspect: want } } },
        'the space round the capture is filled by the background, never black bars'))
  }

  // ── more than one capture, and only one of them drawn ──
  // A group is laid out in the room the composition gives it, and a look with no
  // background gives it none: the take goes edge to edge and the other captures are not
  // in the picture at all (ui/compositor/plan.js, groupSpec is made only where framed).
  if (members.length > 1 && plan && !plan.group) {
    add('group-unframed', 'blocking',
      `This shot holds ${plural(members.length, 'capture')} and the look has no background, so the picture is the first of them edge to edge ` +
      'and the rest are not drawn. A group is laid out in the room the ground leaves round it.',
      call('apply_look', { look: { background: { kind: 'gradient' } } },
        'any ground but none gives the group somewhere to stand; list_looks names the seven that ship'))
  }

  // ── what the picture is of ──
  // Nothing here reads a pixel, so this is not "the subject is wrong", it is "nothing in
  // the document says there is one". A capture on a ground is a screenshot with a
  // margin; what makes it a picture of something is a mark on it, a crop to it, a second
  // capture to read it against, or a line of type saying what it is. `texts` is counted
  // whether or not a shot can carry one yet: a rule that has to be edited the day a
  // field arrives is a rule that will be wrong for a while first.
  const cropped = captures.some(c => c.shown.w * c.shown.h < c.src.w * c.src.h * 0.98)
  // Only the marks that point. A redaction and a blur say what not to look at, and a
  // picture whose one mark is a hole over an account name is exactly the screenshot with
  // a margin round it this rule exists to name: silenced by it, the rule was answering
  // ten for the case it was written for.
  const points = marks.filter(m => m && !HIDES.includes(m.kind))
  if (!points.length && !cropped && captures.length < 2 && members.length < 2 && !arr(shot.texts).length) {
    add('subject', 'should',
      'Nothing on this picture says what to look at: no mark, no crop to the thing, one capture, no words. It is a screenshot with a margin round it.',
      call('find_on_screen', { at: AT, ...(brief && brief.what ? { query: String(brief.what) } : {}) },
        'name the thing the picture is about and send the id back as a lift, a spotlight or a crop; a group of two is also an answer'))
  }

  // ── the subject against everything done to the rest of the frame ──
  for (const m of focus) {
    if (!m.id) continue
    const b = rect(m)
    if (!b) continue
    const share = shareOf(b)
    const small = share < SUBJECT_MIN && Math.max(b.w, b.h) < LONG
    if (!small && share <= SUBJECT_MAX) continue
    const under = hides.filter(h => h.on === m.on && rect(h) && !inside(rect(h), b)).length
    add('focus-share', 'should',
      small
        ? `${m.id} (${m.kind}) is ${Math.round(share * 100)} percent of ${m.on.what}, and the other ${Math.round((1 - share) * 100)} is dimmed and ` +
          'softened behind it. On one frame that treatment is the picture rather than a moment in it: what is left reads as a blurred page ' +
          `with a fragment over it${under ? `, and the ${plural(under, 'redaction')} out there cannot be seen to have done anything` : ''}.`
        : `${m.id} (${m.kind}) covers ${Math.round(share * 100)} percent of ${m.on.what}, so it raises the page rather than a thing on it, ` +
          'and there is nothing left for it to be raised against.',
      call('find_on_screen', { at: AT, ...(brief && brief.what ? { query: String(brief.what) } : {}) },
        small
          ? 'aim it at the whole of the thing, a card rather than a line of one, and send the id back as element; or crop the picture to it, which needs no dimming at all'
          : 'aim it at the thing itself and send the id back as element, so the lift has a page to stand off'),
      { at: null })
  }

  // ── two of them on one place ──
  for (const c of focusClashes(marks.map(m => ({ ...m, start: 0, end: 1 })))) {
    add('focus-clash', 'should',
      `${c.a} and ${c.b} (${c.kinds.join(' and ')}) cover the same place, so one dims the other.`,
      call('apply_edit', { doc: { remove: [c.b] } }, 'keep the one the person asked for and say which went'))
  }

  // ── a mark the picture does not draw ──
  // The still's own never-drawn: not a moment the edit cut away, but a place with no
  // room in it. An arrow stands outside the box it points at and is dropped where there
  // is nowhere to stand (ui/look-schema.js, focus.arrow).
  for (const c of captures) {
    if (!c.drawn) continue
    for (const list of DRAWN_LISTS) {
      const asked = c.marks.filter(m => m && DRAWN_AS[m.kind] === list)
      if (asked.length <= arr(c.drawn[list]).length) continue
      for (const m of asked) {
        if (!m.id || draws(shot, m)) continue
        const drop = call('apply_edit', { doc: { remove: [m.id] } },
          'nothing goes out of the picture that was ever in it; the document simply stops claiming a mark the frame does not carry')
        add('never-drawn', 'should',
          `${m.id} (${m.kind}) is in the document and not in the picture: there is no clear room beside the box it is aimed at, so the mark pass leaves it out.`,
          drop,
          { choices: [
            { what: `drop ${m.id}`, fix: drop },
            { what: 'aim it at something with room beside it',
              fix: call('find_on_screen', { at: AT, ...(brief && brief.what ? { query: String(brief.what) } : {}) },
                'send the id back as element and Fetch fits the mark to it, clear of the edges') },
          ] })
      }
    }
  }

  // ── the frame the capture is hung in ──
  const dev = captures.map(c => c.device).filter(Boolean)
  const shellKinds = new Set(dev.map(d => d.kind))
  // A drawn shell over a capture that already carries its own is two title bars, and
  // frame.chrome cannot help: it crops where Fetch knows the page's place, and on a
  // still it never does (viewport is what a recording's agent reported and a capture has
  // no such thing). So the question the document can answer is whether anything has been
  // taken off the top of the capture at all. `captured.kind` would answer it exactly,
  // since only a window capture brings a title bar with it; a shot does not carry what
  // it was a capture of, so the rule reads it where it is there and speaks where it is
  // not, which is the way round that cannot ship the fault silently.
  // The chrome question is asked of each capture, because on a group each member is its
  // own capture and carries its own answer: a display capture of one Mac standing beside
  // a window capture of another is two different questions. Read off the shot alone, the
  // whole group was judged by whatever the shot itself happened to be.
  const capturedOf = c => {
    const m = members.find(x => x && x.id === c.id)
    return (m && m.captured) || (captures.length < 2 ? shot.captured : null) || null
  }
  const doubled = captures.filter(c => {
    const d = c.device
    // phone is here now that a simulator window is a capture Fetch understands: a drawn
    // phone round a capture that still carries the device's own outline is a phone
    // inside a phone, which is the same doubling and the same fix.
    if (!d || !['browser', 'window', 'laptop', 'phone'].includes(d.kind) || d.own) return false
    // a shell that stood down drew no bar at all (ui/compositor/plan.js, ownChrome), so
    // what is left to warn about is the capture Fetch was told nothing about
    const cap = capturedOf(c)
    if (cap && cap.kind && cap.kind !== 'window') return false
    // A phone is the one shell that is right over a capture Fetch knows nothing about:
    // a handset screenshot has no title bar and wants a handset drawn round it. It
    // doubles only where the capture is known to be of a window, which is what a
    // simulator's capture is, and there the device's own outline is in the picture
    // already. Silent otherwise, rather than telling somebody off for a bar their phone
    // shot never had.
    if (d.kind === 'phone' && !(cap && cap.kind === 'window')) return false
    return c.shown.y <= c.src.h * 0.01
  })
  if (doubled.length && !shot.viewport) {
    const kinds = [...new Set(doubled.map(c => c.device.kind))]
    // On a group the look's own device is not what drew these shells: each member carries
    // its own `device` string and groupSpec builds the shell from that, so apply_look
    // changes nothing and the finding comes back byte for byte. The group goes back whole
    // with the offending members bare, which is the shape device-fit already uses.
    const bare = new Set(doubled.map(c => c.id))
    const off = captures.length > 1
      ? call('apply_edit', { doc: { group: { gap: shot.group.gap, align: shot.group.align,
        members: members.map(m => (bare.has(m.id) ? { ...m, device: 'none' } : m)) } } },
        'the group goes back whole with those members bare, so the captures keep their own chrome and nothing else in the picture moves')
      : call('apply_look', { look: { device: { kind: 'none' } } },
        'one title bar: the capture\'s own, which is the one with the real window in it')
    add('double-chrome', 'should',
      `A ${kinds.join(' and ')} frame is drawn round ${doubled.length > 1 ? `${doubled.map(c => c.id).join(' and ')}, captures` : doubled[0].what} nothing has been cropped off the top of. ` +
      'Where the capture is of a window it already carries its own title bar, and the picture then has two. Nothing about a still tells Fetch where the ' +
      'page begins, so frame.chrome cannot take the first one off.',
      off,
      { choices: [
        { what: 'drop the drawn frame and keep the capture\'s own chrome', fix: off },
        { what: 'keep the drawn frame and crop the capture\'s own bar away',
          fix: captures.length > 1
            ? call('apply_edit', { doc: { group: { gap: shot.group.gap, align: shot.group.align,
              members: members.map(m => (bare.has(m.id) ? { ...m, crop: { x: 0, y: 0.04, w: 1, h: 0.96 } } : m)) } } },
              'a group is laid out from its members, so the crop goes on the member; preview_frame to see how much of a bar there was')
            : call('apply_edit', { doc: { crop: { x: 0, y: 0.04, w: 1, h: 0.96 } } },
              'take the top off the capture so the drawn shell is the only chrome; preview_frame to see how much of it there was') },
      ] })
  }
  for (const c of captures) {
    const d = c.device
    if (!d || !d.kind || d.kind === 'none') continue
    const tall = c.shown.h > c.shown.w
    // A phone over a capture that still carries the device it was of is the doubling
    // double-chrome names, so the shape argument does not get to recommend it.
    if (tall && d.own) continue
    if ((d.kind === 'phone') === tall) continue
    add('device-fit', 'should',
      `${c.what} is ${tall ? 'taller than it is wide' : 'wider than it is tall'} and it is hung in a ${d.kind} frame, which is cut the other way. ` +
      'The shell and the thing inside it disagree about which way up the picture is.',
      captures.length > 1
        ? call('apply_edit', { doc: { group: { gap: shot.group.gap, align: shot.group.align,
          members: members.map(m => (m.id === c.id ? { ...m, device: tall ? 'phone' : 'window' } : m)) } } },
          'the group goes back whole with that one member reframed, so nothing else in it moves')
        : call('apply_look', { look: { device: { kind: tall ? 'phone' : 'window' } } },
          'a frame cut for the shape the capture actually is'))
  }
  for (const c of captures) {
    const d = c.device
    if (!d || !d.kind || !['browser', 'window'].includes(d.kind) || String(d.title || '').trim()) continue
    const stem = stemOf(path)
    add('blank-bar', 'note',
      `The ${d.kind} frame round ${c.what} has an empty address, so the picture ships with a blank bar in it, which reads as an unfinished mockup.`,
      call('apply_look', { look: { device: { title: stem || 'the address or the window title' } } },
        stem ? 'the capture is already named after the window it came from, and that name is the honest thing to put in the bar'
          : 'whatever the window is called, or the address a reader would type'))
    break
  }

  // ── room round the picture ──
  if (plan) {
    const b = captures.length > 1 || !captures[0].device ? plan.rect : captures[0].device.extent
    const room = Math.min(b.x, b.y, plan.W - b.x - b.w, plan.H - b.y - b.h) / Math.min(plan.W, plan.H)
    if (field(look, 'background.kind', 'none') !== 'none' && room < GUTTER) {
      add('breathe', 'should',
        `The drawn picture stands ${Math.max(0, Math.round(room * Math.min(plan.W, plan.H)))} px off the edge of a ${plan.W}x${plan.H} frame. ` +
        'There is nowhere for the shadow to fall and the ground reads as a hairline rather than as a margin.',
        call('apply_look', { look: { frame: { padding: 0.06 } } },
          'the default margin, which is where the shadow and the corners were drawn to sit'))
    }
  }

  // ── the ground against the capture's own ends ──
  const g = groundRange(look)
  if (g && lv && Number.isFinite(+lv.lo) && Number.isFinite(+lv.hi) && +lv.hi > +lv.lo) {
    // Both ends, because a range with one end clear gives the capture somewhere to
    // stand. A solid has one end and answers this on its own.
    const near = Math.abs(g.lo - +lv.lo) < EDGE && Math.abs(g.hi - +lv.lo) < EDGE ? 'black point'
      : Math.abs(g.lo - +lv.hi) < EDGE && Math.abs(g.hi - +lv.hi) < EDGE ? 'white point' : null
    if (near) {
      const dark = near === 'black point'
      const suited = pickLook(input.looks, dark ? 'light' : 'dark')
      add('ground', 'note',
        `${g.what.charAt(0).toUpperCase()}${g.what.slice(1)} sits within 24 levels of the capture's own ${near} ` +
        `(${r2(g.lo)} to ${r2(g.hi)} against ${r2(near === 'black point' ? +lv.lo : +lv.hi)}), so the capture's edge is carried by the hairline alone.`,
        suited
          ? call('apply_look', { preset: suited.name }, `${suited.label} is for ${suited.for || 'the other end of the scale'}`)
          : call('apply_look', { look: { background: { kind: 'solid', color: dark ? '#EDE6DA' : '#1A1714' } } },
            'a ground the capture stands off, rather than one it sinks into'))
    }
  }

  // ── the pixels the box can carry ──
  // A screenshot is read close and often on a retina display, so the number that decides
  // whether it is a deliverable is how many of the capture's own pixels survive into it.
  // The picture is drawn at one, two or three times its plan, so the box only has to
  // carry the capture at one of those, and which one is the renderer's call and not this
  // rubric's. What is reported is the number and the size it asks for; what is a finding
  // is a box that throws away a third of the capture even at the largest size a still is
  // drawn, which is a shape and a margin spending the picture on ground.
  const dense = captures.map(c => ({ id: c.id, what: c.what,
    per_px: c.box && c.box.w > 0 ? r2(c.shown.w / c.box.w) : null }))
  const worst = dense.filter(d => d.per_px !== null).sort((a, b) => b.per_px - a.per_px)[0]
  // A few percent of softening is invisible, which is the same slack the renderer gives
  // itself when it picks a size (ui/compositor/index.js, shotScale).
  const needs = worst ? Math.max(1, Math.ceil(worst.per_px / 1.05)) : 1
  if (worst && worst.per_px > TOP_SCALE * 1.4) {
    const padding = +field(look, 'frame.padding', 0.06)
    // Never a finding without a call, and never a call that makes another rule fire: the
    // margin comes down to where `breathe` is still satisfied and no further.
    const fix = padding > 0.03
      ? call('apply_look', { look: { frame: { padding: 0.03 } } },
        'a tighter margin gives the capture a bigger box, and the box is what carries its pixels')
      : aspect !== 'auto'
        ? call('apply_look', { look: { frame: { aspect: 'auto' } } },
          'the capture\'s own shape wastes none of the frame on ground the picture does not need')
        : null
    if (fix) {
      add('resolution', 'note',
        `${worst.what} has ${worst.per_px} of its own pixels for every pixel of the box the picture gives it. At ${TOP_SCALE}x, ` +
        `which is the largest a still is drawn, that is still ${r2(worst.per_px / TOP_SCALE)} to one: a third of what was captured ` +
        'does not reach the file, and small text goes first.',
        fix)
    }
  }

  ruleWords(input, (rule, sev, what, fix) => add(rule, sev, what, fix), call)
  const { live, bad, should, off, verdict, score } = settle(items, input.declined)
  // What it is, in the numbers that decide it, and then what is left. A note is counted
  // out loud rather than swept under "nothing the rubric can name": a summary that says
  // nothing while the list under it says three things is how a ten gets believed.
  const notes = live.length - bad - should
  const what = `${captures.length > 1 ? plural(captures.length, 'capture') : `a ${captures[0].src.w}x${captures[0].src.h} capture`}` +
    `${plan ? ` in a ${plan.W}x${plan.H} picture` : ''}, ${plural(marks.length, 'mark')}`
  const summary = (bad || should
    ? `${verdict === 'not ready' ? 'Not ready' : 'Nearly'}: ${what}. ` +
      [bad ? `${plural(bad, 'thing')} to fix` : '', should ? `${plural(should, 'thing')} worth fixing` : '']
        .filter(Boolean).join(', ') + '.'
    : notes
      ? `Ready: ${what}, nothing to fix. ${plural(notes, 'note')} worth reading.`
      : `Ready: ${what}, nothing the rubric can name.`) +
    (off ? ` ${plural(off, 'item')} declined.` : '')

  return {
    verdict,
    score,
    summary,
    items,
    // A still has one moment and every finding is already named against the mark or the
    // capture it is about, so there is no list of times to hand over. preview_frame
    // draws the picture, and it is the whole of what there is to look at.
    look_at: [],
    not_judged: NOT_ABOUT_A_PICTURE.map(([rule, why]) => ({ rule, why })),
    measured: {
      kind: 'shot',
      planned: !!plan,
      capture: `${captures[0].src.w}x${captures[0].src.h}`,
      shown: `${captures[0].shown.w}x${captures[0].shown.h}`,
      picture: plan ? `${plan.W}x${plan.H}` : null,
      // How many of the capture's own pixels land in one pixel of the box it was given,
      // and the smallest size the picture can ship at and still carry them all.
      capture_per_px: worst ? worst.per_px : null,
      needs_scale: worst ? needs : null,
      aspect: aspect === 'auto' ? 'auto' : aspect,
      wanted_aspect: want,
      where: where ? where.where : null,
      captures: captures.map((c, i) => ({ id: c.id, capture: `${c.src.w}x${c.src.h}`,
        box: c.box ? `${c.box.w}x${c.box.h}` : null, per_px: dense[i].per_px,
        device: c.device ? c.device.kind : null, marks: c.marks.length })),
      marks: marks.length,
      drawn: captures.reduce((n, c) => n + (c.drawn ? DRAWN_LISTS
        .reduce((k, list) => k + arr(c.drawn[list]).length, 0) : 0), 0),
      redactions: hides.length,
      must_hide: hide,
      subject: focus.filter(m => m.id && rect(m)).map(m => ({ id: m.id, kind: m.kind, share: shareOf(rect(m)) })),
      ground: g ? { lo: r2(g.lo), hi: r2(g.hi) } : null,
      take_levels: lv && Number.isFinite(+lv.lo) ? { lo: r2(+lv.lo), hi: r2(+lv.hi) } : null,
    },
  }
}


// The look whose ground sits at the end this take needs, named by what it is for rather
// than by what it is called. Falls back to nothing, and the caller names a colour.
function pickLook(looks, end) {
  const want = end === 'light'
  const rows = arr(looks).map(l => {
    const g = field(l && l.look, 'background.kind', 'none') === 'solid'
      ? luma(field(l.look, 'background.color', null)) : null
    return g === null ? null : { name: l.name, label: l.label || l.name, for: l.for || l.doc || null, ground: g }
  }).filter(Boolean)
  if (!rows.length) return null
  rows.sort((a, b) => (want ? b.ground - a.ground : a.ground - b.ground))
  const top = rows[0]
  return want ? (top.ground > 0.5 ? top : null) : (top.ground < 0.2 ? top : null)
}

// The moments to look at, in both clocks: `at` for preview_frame and find_on_screen,
// `out` for contact_sheet. Findings first, then the edit spread out, because an agent
// that has been told what is wrong still has to see the rest of it.
function lookAt(items, k, beats, seconds) {
  const out = []
  const push = (at, why) => {
    if (!Number.isFinite(at) || out.length >= 6) return
    if (out.some(o => Math.abs(o.at - at) < 0.4)) return
    out.push({ at: r2(at), out: outAt(k, at), why })
  }
  for (const i of items) if (i.at !== null && i.at !== undefined) push(+i.at, i.rule)
  for (const b of arr(beats)) push((+b.start + +b.end) / 2, b.label ? `beat ${b.id || ''}`.trim() : 'a beat')
  if (k.length) for (const f of [0.1, 0.5, 0.9]) {
    const o = seconds * f
    let at = null
    for (const c of k) { if (o <= c.out + (c.end - c.start) + 1e-6) { at = c.start + (o - c.out); break } }
    push(at, 'the edit')
  }
  return out.sort((a, b) => a.at - b.at)
}

/** The items an export result carries: what has to be fixed before this is the thing asked for. */
const blocking = r => (r && arr(r.items).filter(i => i.severity === 'blocking' && !i.declined)) || []

module.exports = { review, still, blocking, whereSpec, WHERE, kept, outAt, outLength, deadAir, focusClashes, handAimed,
  luma, groundRange, work, damage, covered, silenceCuts, without, including, DEAD_GAP, ZOOM_EVERY, WHOLE, PENALTY,
  SUBJECT_MIN, SUBJECT_MAX, SOFT_BLUR, TOP_SCALE, NOT_ABOUT_A_PICTURE }
