// Hitting a length. "Make this a 60 second demo" is a decision about which seconds
// survive, and the product had no way to make it: the obviously named tool,
// remove_dead_air, writes a new recording beside the original and leaves the edit of it
// empty, so an agent reaching for it loses every zoom and mark it had just placed. This
// chooses clips instead. The take is never touched and Undo still works.
//
// Three cuts, cheapest first, where cheap means nobody can see it:
//
//   1. Filler words, from the word timings the transcript already kept.
//   2. The long pauses, from the silences the same pass measured.
//   3. Whole beats, worst first, and never half a beat: a cut inside a sentence is
//      heard, a cut between two sentences is not.
//
// Each pass runs only while the edit is still over the target, so a take that lands on
// 60 seconds from fillers alone keeps all of its beats. Every measurement is in output
// seconds, taken by actually subtracting the span and summing what is left, which is
// what keeps it honest once a clip can carry a rate.
//
// All three read the transcript, and a device take has none: an app's onboarding makes
// no sound. That take's spine is its touch track instead, a tap being a moment somebody
// meant, and the second cut runs off the taps where there is no voice to run off. See
// "a take with nobody talking on it".
//
// A target above the take's own length is the other direction, and it has one answer:
// spend longer on the moments the video is already dwelling on. Not the take, not the
// speech, not a move while it travels. See "the moments worth dwelling on" below, which
// is where that rule and the limit past which fit refuses are written down.
//
// Pure: no filesystem, no DOM, no Electron. The caller reads the document and the word
// timings and hands them in. test/fit.test.js is the whole of the proof.

const r3 = n => Math.round(n * 1000) / 1000
const r2 = n => Math.round(n * 100) / 100
const num = (v, d = 0) => (Number.isFinite(+v) ? +v : d)

// A cut this short is a flash rather than an edit, and ui/timeline.js drops the sliver
// it would leave anyway. Same number, for the same reason.
const MIN_CUT = 0.08
const MIN_PIECE = 0.05

// No target, and the cuts still never take the whole edit: half a second is the least
// video that is still a video.
const MIN_OUT = 0.5

// A filler is worth at most a second of screen time. Past that the pause after it
// belongs to the dead air pass, which knows where the speech actually stopped.
const MAX_FILLER = 1.0
// Room left before the next word so its attack is not clipped, and a touch of lead
// taken off the filler's own onset when there is a gap to take it from.
const TAIL = 0.08
const LEAD = 0.05

// The words a person says while thinking. Nothing on this list is ever the point of a
// sentence, and that is the bar: "like", "so", "right", "actually" and "basically"
// carry meaning often enough that cutting them by default would take the hinges out of
// real sentences, and the agent that asked would never hear it happen. They are one
// argument away (`extra`), never a default.
const FILLERS = ['um', 'umm', 'ummm', 'uhm', 'uh', 'uhh', 'uhhh', 'er', 'err', 'erm',
  'ah', 'ahh', 'mm', 'mmm', 'hmm', 'hm', 'you know', 'i mean']

const normWord = w => String(w == null ? '' : w).toLowerCase().replace(/[^a-z0-9']+/g, '')

// Word timings arrive either as the sidecar writes them ({w, t}) or as the recogniser
// hands them over ({word, startTime}). Only start times exist: processor.js deliberately
// throws the padded end times away, so the end of a cut is always read off the word that
// comes next.
function readWords(words) {
  return (words || [])
    .map(x => ({ w: normWord(x && (x.w != null ? x.w : x.word)), t: num(x && (x.t != null ? x.t : x.startTime), -1) }))
    .filter(x => x.w && x.t >= 0)
    .sort((a, b) => a.t - b.t)
}

const phraseList = o => {
  const src = (o.only && o.only.length ? o.only : FILLERS).concat(o.extra || [])
  return src.map(s => String(s).toLowerCase().split(/\s+/).map(normWord).filter(Boolean))
    .filter(p => p.length)
    .sort((a, b) => b.length - a.length)
}

/**
 * The spans a filler word occupies, ready to be cut: [{start, end, text}] in source
 * seconds. The span runs from the filler to just before the next word, so the
 * hesitation after the "um" goes with it, which is the half that is actually felt.
 */
function fillerSpans(words, o = {}) {
  const W = readWords(words)
  const phrases = phraseList(o)
  const dur = num(o.dur, W.length ? W[W.length - 1].t + MAX_FILLER : 0)
  const out = []
  let i = 0
  while (i < W.length) {
    const hit = phrases.find(p => p.every((w, k) => W[i + k] && W[i + k].w === w))
    if (!hit) { i++; continue }
    const first = W[i], last = W[i + hit.length - 1], next = W[i + hit.length]
    const prev = W[i - 1]
    // Lead is taken only where there is a gap to take it from; a word start is already
    // snapped to the audio (Overlays.snapToSpeech), so a blind 50 ms would eat the end
    // of whatever ran up to it.
    const lead = !prev || first.t - prev.t > 0.4 ? LEAD : 0
    const start = Math.max(0, first.t - lead)
    const end = Math.min(last.t + MAX_FILLER, next ? next.t - TAIL : dur)
    if (end - start >= MIN_CUT) {
      out.push({ start: r3(start), end: r3(end), text: hit.join(' '), why: 'filler' })
    }
    i += hit.length
  }
  return merge(out).map(s => ({ ...s, why: 'filler' }))
}

/**
 * Where the speaker stopped for longer than `minSilence`, as cuts that leave `pad` of
 * breath on each side. Defaults match remove_dead_air (0.7 and 0.15) so the two say the
 * same thing about the same take. The silence a take opens and closes with is taken
 * whole: there is nothing before the first word to breathe from.
 */
function deadSpans(speech, o = {}) {
  const dur = num(o.dur)
  const minSilence = num(o.minSilence, 0.7)
  const pad = Math.max(0, num(o.pad, 0.15))
  const runs = (speech || []).map(s => [num(s && s[0]), num(s && s[1])])
    .filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0])
  if (!runs.length || dur <= 0) return []
  const gaps = []
  let t = 0
  for (const [a, b] of runs) { if (a - t >= minSilence) gaps.push([t, a]); t = Math.max(t, b) }
  if (dur - t >= minSilence) gaps.push([t, dur])
  const out = []
  for (const [a, b] of gaps) {
    const head = a <= 0.001, tail = b >= dur - 0.001
    const start = head ? 0 : a + pad
    const end = tail ? dur : b - pad
    if (end - start >= MIN_CUT) out.push({ start: r3(start), end: r3(end), why: 'dead' })
  }
  return merge(out).map(s => ({ ...s, why: 'dead' }))
}

// ── a take with nobody talking on it ────────────────────────────────────────
// An app's onboarding makes no sound, so a device take has no transcript, no captions
// and no beats, and every pass above this line reads nothing. Asked for a length, fit
// used to hand the whole two hundred seconds straight back with "transcribe this take
// first", which on a silent take buys nothing: transcribing silence returns silence.
//
// What did happen on that take is on the touch track. A tap is a moment somebody meant,
// and the seconds around it are the press and the screen answering it. Those runs are
// the take's spine, exactly the way speech runs are a narrated take's, and everything
// between two taps is the same dead air a pause is. `deadSpans` takes them unchanged.
//
// The window is short on the way in and long on the way out because a tap's meaning is
// what it caused, not the finger landing. 0.35 s is the disc rising (ui/pointer.js);
// 1.2 s is a screen pushing, settling and being read.
const TAP = { before: 0.35, after: 1.2 }

function tapRuns(doc = {}, o = {}) {
  const src = Array.isArray(o.taps) ? o.taps : Array.isArray(doc.pointer) ? doc.pointer : []
  const dur = num(o.dur)
  const runs = src
    .filter(p => p && (p.click || p.tap) && Number.isFinite(+p.t) && +p.t >= 0)
    .map(p => ({ start: Math.max(0, +p.t - TAP.before), end: dur > 0 ? Math.min(+p.t + TAP.after, dur) : +p.t + TAP.after }))
  return merge(runs).map(s => [r3(s.start), r3(s.end)])
}

// ── clips and spans ─────────────────────────────────────────────────────────

function merge(spans) {
  const s = (spans || []).map(x => ({ ...x, start: num(x.start), end: num(x.end) }))
    .filter(x => x.end > x.start).sort((a, b) => a.start - b.start)
  const out = []
  for (const x of s) {
    const last = out[out.length - 1]
    if (last && x.start <= last.end) last.end = Math.max(last.end, x.end)
    else out.push({ ...x })
  }
  return out
}

// A clip's rate as the two ends of its ramp, the shape Fetchdoc.rateOf keeps: a number
// is held, a pair ramps, anything else runs at the take's own speed.
const rateEnds = c => {
  const r = c && c.rate
  if (Array.isArray(r)) {
    const a = +r[0] > 0 ? +r[0] : 1
    return [a, +r[1] > 0 ? +r[1] : a]
  }
  const a = +r > 0 ? +r : 1
  return [a, a]
}

// A clip's length on the output clock. A ramp's mean rate is exactly (r0 + r1) / 2, so
// its output span is 2 * (b - a) / (r0 + r1), which is Timeline.outSpan's own form and
// at r0 === r1 is the plain (b - a) / r. Reading `rate` as a scalar instead measured a
// ramped clip at 1 and sent fit hunting seconds an edit had already spent.
const clipOut = c => {
  const [r0, r1] = rateEnds(c)
  return 2 * Math.max(0, num(c && c.end) - num(c && c.start)) / (r0 + r1)
}

// A piece of a ramp is a ramp, restricted: rate runs linearly in output seconds, so a
// piece keeps the rates it actually had at its own ends. Timeline.slice does the same
// arithmetic on a kept range and this has to agree with it or fit and the export would
// report two lengths for one cut.
function sliceRate(c, a, b) {
  const [r0, r1] = rateEnds(c)
  if (r0 === r1) return r0 === 1 ? undefined : r0
  const s = num(c.start), e = num(c.end)
  const span = 2 * (e - s) / (r0 + r1)
  // source time reached tau output seconds in: s + r0*tau + m*tau^2/2, inverted
  const m = (r1 - r0) / span
  const at = x => {
    const d = Math.max(0, Math.min(e, x) - s)
    return r0 + m * ((Math.sqrt(Math.max(0, r0 * r0 + 2 * m * d)) - r0) / m)
  }
  const ra = at(a), rb = at(b)
  return Math.abs(ra - rb) < 1e-6 ? (Math.abs(ra - 1) < 1e-6 ? undefined : r3(ra)) : [r3(ra), r3(rb)]
}

const outLength = clips => (clips || []).reduce((n, c) => n + clipOut(c), 0)

/**
 * The clips left once `spans` are taken out. A split clip keeps every other field it
 * had (its rate, and whatever a later round adds); the first piece keeps the id and the
 * rest are minted by the document, because two clips answering to C2 is worse than a
 * gap in the sequence.
 */
function subtract(clips, spans) {
  const cuts = merge(spans)
  const out = []
  for (const c of clips || []) {
    let pieces = [[num(c.start), num(c.end)]]
    for (const cut of cuts) {
      const next = []
      for (const [a, b] of pieces) {
        if (cut.end <= a || cut.start >= b) { next.push([a, b]); continue }
        if (cut.start > a) next.push([a, cut.start])
        if (cut.end < b) next.push([cut.end, b])
      }
      pieces = next
    }
    pieces.filter(([a, b]) => b - a > MIN_PIECE).forEach(([a, b], i) => {
      const { id, ...rest } = c
      const rate = sliceRate(c, a, b)
      if (rate === undefined) delete rest.rate; else rest.rate = rate
      out.push(i === 0 && id ? { ...rest, id, start: r3(a), end: r3(b) } : { ...rest, start: r3(a), end: r3(b) })
    })
  }
  return out
}

// The edit as clips: what the document says, or the whole take when it says nothing yet.
function clipsOf(doc) {
  const cs = (doc.clips || []).filter(c => c && num(c.end) > num(c.start))
  if (cs.length) return cs.slice().sort((a, b) => num(a.start) - num(b.start)).map(c => ({ ...c }))
  const dur = num(doc.dur)
  return dur > 0 ? [{ start: 0, end: r3(dur) }] : []
}

const overlaps = (a, b, x, y) => Math.min(b, y) - Math.max(a, x)

// ── what the cheap cuts may not go through ──────────────────────────────────
// The beat pass has always ranked around the work: a beat something is aimed at is
// worth twice as much and a beat named in `keep` is never dropped at all. The filler
// and the pause passes read none of it, so they took the head and the tail silence
// whole, which is exactly where a title card and a closing URL card live, and said so
// only afterwards under orphans.texts. A 55 s take asked for 45 s came back without
// either card. Same judgement, now made by all three passes.
//
// A card's fade lives inside its own span (ui/overlays.js, cards: the fade is capped
// at a third of the span), so the span is the whole of what has to survive.
function drawnSpans(doc = {}) {
  return merge([
    ...(doc.texts || []),
    ...(doc.marks || []).filter(m => m && AIMED.includes(m.kind)),
  ].filter(x => x && num(x.end) > num(x.start))
    .map(x => ({ start: num(x.start), end: num(x.end) })))
}

// One candidate cut with the protected stretches taken out of it: nothing, one piece
// or two, each still long enough to be an edit rather than a flash.
function clearOf(span, blocked) {
  let parts = [{ ...span, start: num(span.start), end: num(span.end) }]
  for (const b of blocked) {
    const next = []
    for (const p of parts) {
      if (b.end <= p.start || b.start >= p.end) { next.push(p); continue }
      if (b.start > p.start) next.push({ ...p, end: r3(b.start) })
      if (b.end < p.end) next.push({ ...p, start: r3(b.end) })
    }
    parts = next
  }
  return parts.filter(p => p.end - p.start >= MIN_CUT)
}

// ── the moments worth dwelling on ───────────────────────────────────────────

// Reaching a number above the take's own length means spending longer on something, and
// almost everything is the wrong thing to spend it on. Slowing a whole take is slow
// motion; slowing speech makes a person sound drunk; slowing a move changes the move
// somebody composed. What is left is the moment a move has already arrived at and
// nobody is talking over: a zoom holding, a lift open with its chips on screen, a title
// card up. The picture is still, so a slower rate there is not read as an effect, it is
// read as the frame getting the beat it deserved. Both halves of the rule carry weight:
// something aimed at, holding, and silence over it. A silence with nothing on screen is
// dead air, and stretching dead air is the embarrassing version of this feature.
//
// Half speed is the floor. PRODUCT.md already calls 0.5 "a slow look", one atempo pass
// covers it without moving pitch, and under it a held frame stops reading as a hold that
// lasts longer and starts reading as slow motion nobody asked for. So the longest an
// edit can honestly become is its own length plus what its dwelling moments are worth at
// that floor, which is `stretch.reach`, and past `reach` fit refuses and says the take is
// too short rather than slowing something that should not be slowed.
const SLOW_MIN = 0.5

// How far from its own ends a moment has to sit before it counts as holding. A zoom, a
// lift, a spotlight and a loupe travel to get where they are going, and the longest of
// those eases is Overlays.easeSpan at 4x, 0.8 s. A card or a step chip is drawn over a
// picture that is not moving and only fades, capped at 0.6 s (ui/overlays.js, cards). A
// rate that changes this far inside is a rate that changes while nothing travels, which
// is the whole reason the change cannot be seen.
const HOLD_MOVE = 0.8, HOLD_DRAW = 0.6

// A hold shorter than this is not worth the change: even at the floor it is under a
// second, and a beat that short reads as a hitch rather than as dwelling.
const MIN_DWELL = 0.4

// Room left around speech, the same 0.15 the pause pass keeps, because the ends of a
// speech run are the recogniser's opinion and a slowed syllable is exactly the thing
// this must never produce.
const QUIET_PAD = 0.15

// Fetchdoc.cleanRate clamps a rate into this, and a rate fit reported that the document
// would not keep is two lengths for one edit.
const RATE_FLOOR = 0.1

// A step chip and a card are drawn, not flown; everything else here moves the picture.
const holdOf = what => (what === 'card' || what === 'step' ? HOLD_DRAW : HOLD_MOVE)

// Where nobody is speaking, speech padded out by QUIET_PAD at both ends.
function quietRuns(speech, dur, pad = QUIET_PAD) {
  const said = merge((speech || []).map(x => ({ start: num(x && x[0]) - pad, end: num(x && x[1]) + pad })))
  const out = []
  let t = 0
  for (const r of said) {
    if (r.start > t) out.push([t, Math.min(r.start, dur)])
    t = Math.max(t, r.end)
  }
  if (dur > t) out.push([t, dur])
  return out.filter(([a, b]) => b > a)
}

/**
 * The moments this edit could dwell on: [{start, end, on, what}] in source seconds,
 * each one a stretch where something Fetch aimed is holding still and nobody is
 * speaking over it. `on` is every id holding there, because two things aimed at one
 * moment is still one moment.
 *
 * A redaction is not something to dwell on and is not in AIMED, which is the same call
 * the beat ranking makes for the same reason.
 */
function dwellSpans(doc = {}, o = {}) {
  const dur = num(o.dur, num(doc.dur))
  const aimed = [
    ...(doc.zooms || []).map(z => ({ ...z, what: 'zoom' })),
    ...(doc.marks || []).filter(m => m && AIMED.includes(m.kind)).map(m => ({ ...m, what: m.kind })),
    ...(doc.texts || []).map(t => ({ ...t, what: 'card' })),
  ].filter(x => x && num(x.end) > num(x.start))
  if (!aimed.length || dur <= 0) return []
  const quiet = quietRuns(o.speech, dur)
  const parts = []
  for (const x of aimed) {
    const h = holdOf(x.what)
    const a = num(x.start) + h, b = num(x.end) - h
    if (b - a < MIN_DWELL) continue
    for (const [qa, qb] of quiet) {
      const s0 = Math.max(a, qa), e0 = Math.min(b, qb)
      if (e0 - s0 >= MIN_DWELL) parts.push({ start: r3(s0), end: r3(e0), on: x.id || null, what: x.what })
    }
  }
  return merge(parts).map(m => ({
    start: m.start, end: m.end, what: m.what, why: 'dwell',
    on: [...new Set(parts.filter(p => overlaps(m.start, m.end, p.start, p.end) > 0).map(p => p.on).filter(Boolean))],
  }))
}

// A piece of a ramp slowed by k is the same ramp with both ends slowed: rate runs
// linearly in output seconds either way, so the shape survives and only the clock under
// it stretches.
function slowRate(c, a, b, k) {
  const [r0, r1] = rateEnds({ rate: sliceRate(c, a, b) })
  // Half speed is a promise about the rate the viewer sees, not about the factor: a
  // clip the person already set to 0.8x taken to half of that plays at 0.4x, past the
  // floor this file says it never crosses, and it made `reach` a number the tool could
  // not honestly reach. Never slower than the floor, and never faster than the clip
  // already was, so a hold someone deliberately put under it is left alone.
  const lo = r => (k < 1 ? Math.max(RATE_FLOOR, Math.min(r, SLOW_MIN)) : RATE_FLOOR)
  const s0 = Math.max(lo(r0), r3(r0 * k)), s1 = Math.max(lo(r1), r3(r1 * k))
  if (Math.abs(s0 - s1) < 1e-6) return Math.abs(s0 - 1) < 1e-6 ? undefined : s0
  return [s0, s1]
}

/**
 * The clips again with `spans` running at `k` times the speed they ran at before.
 * Nothing is removed and nothing moves in source time, so every zoom, mark, caption and
 * beat keeps the footage it was placed on: a stretch is one change to the time map.
 */
function slowInside(clips, spans, k) {
  const zones = merge(spans)
  if (!zones.length || !(k > 0) || Math.abs(k - 1) < 1e-6) return (clips || []).map(c => ({ ...c }))
  const out = []
  for (const c of clips || []) {
    const s = num(c.start), e = num(c.end)
    let pieces = [[s, e, false]]
    for (const z of zones) {
      // A remainder too short to be a piece is not one, so the zone takes the clip's
      // own edge instead of leaving a sliver at a different rate beside it.
      const za = z.start - s < MIN_PIECE ? s : z.start
      const zb = e - z.end < MIN_PIECE ? e : z.end
      const next = []
      for (const piece of pieces) {
        const [a, b, slow] = piece
        if (slow || zb <= a || za >= b) { next.push(piece); continue }
        if (za > a) next.push([a, za, false])
        next.push([Math.max(a, za), Math.min(b, zb), true])
        if (zb < b) next.push([zb, b, false])
      }
      pieces = next
    }
    pieces.filter(([a, b]) => b > a).forEach(([a, b, slow], i) => {
      const { id, ...rest } = c
      const rate = slow ? slowRate(c, a, b, k) : sliceRate(c, a, b)
      if (rate === undefined) delete rest.rate; else rest.rate = rate
      out.push(i === 0 && id ? { ...rest, id, start: r3(a), end: r3(b) } : { ...rest, start: r3(a), end: r3(b) })
    })
  }
  return out
}

// ── which beat is worth the least ───────────────────────────────────────────

const AIMED = ['lift', 'spotlight', 'step', 'loupe', 'arrow']

/**
 * The beats ranked by what they are worth, least first. Worth is speech density: real
 * words per second, fillers not counted, since a beat that is mostly air is the one a
 * person would cut. Three things lift it: the opening and the closing beat carry the
 * ends of the video, a beat somebody aimed a zoom or an emphasis mark at was chosen on
 * purpose, and a beat the caller named in `keep` is never dropped at all.
 *
 * A redaction is not emphasis and does not protect its beat: dropping the footage is a
 * stronger redaction than blurring it.
 */
function rankBeats(doc = {}, o = {}) {
  const beats = (doc.beats || []).filter(b => b && num(b.end) > num(b.start))
  const W = readWords(o.words)
  const fillers = phraseList(o)
  const isFiller = w => fillers.some(p => p.length === 1 && p[0] === w)
  const terms = (o.keep || []).map(t => String(t).toLowerCase().trim()).filter(Boolean)
  // Captions as well as word timings. A keep term is a phrase the person said, and a
  // take with cues and no .words.json sidecar had no text to match it against at all,
  // so review could name a phrase as cut and hand over a call that matched nothing.
  const cues = (o.cues && o.cues.length ? o.cues : (doc.cues || []))
    .filter(c => c && num(c.end) > num(c.start))
  const aimed = [
    ...(doc.zooms || []),
    ...(doc.marks || []).filter(m => m && AIMED.includes(m.kind)),
    ...(doc.texts || []),
  ].filter(x => x && num(x.end) > num(x.start))

  const matched = new Set()
  const ranked = beats.map((b, i) => {
    const start = num(b.start), end = num(b.end)
    const inside = W.filter(w => w.t >= start && w.t < end)
    const said = inside.map(w => w.w).join(' ')
    const real = inside.filter(w => !isFiller(w.w)).length
    const takes = aimed.filter(x => overlaps(start, end, num(x.start), num(x.end)) > 0.1).map(x => x.id).filter(Boolean)
    const spoken = cues.filter(c => overlaps(start, end, num(c.start), num(c.end)) > 0.05)
      .map(c => String(c.text == null ? '' : c.text).toLowerCase()).join(' ')
    const hits = terms.filter(t =>
      t === String(b.id || '').toLowerCase() ||
      String(b.label || '').toLowerCase().includes(t) ||
      said.includes(t) || spoken.includes(t))
    hits.forEach(t => matched.add(t))
    let value = real / Math.max(end - start, 0.5)
    if (i === 0 || i === beats.length - 1) value *= 1.35
    if (takes.length) value *= 2
    return {
      id: b.id || null, label: b.label || null, start: r3(start), end: r3(end),
      words: real, value: r2(value), takes, keep: hits.length > 0,
    }
  })
  ranked.sort((a, b) => (a.value - b.value) || ((b.end - b.start) - (a.end - a.start)))
  return { beats: ranked, matched: [...matched], unmatched: terms.filter(t => !matched.has(t)) }
}

// ── the job ─────────────────────────────────────────────────────────────────

function line(res) {
  const s = n => `${r2(n)}s`
  if (res.why) return res.why
  if (res.target == null) return `${s(res.was)} to ${s(res.now)}.`
  const st = res.stretch
  if (st && st.rate) {
    const n = st.moments.length
    return `${s(res.was)} to ${s(res.now)} against ${s(res.target)}: ${n} moment${n === 1 ? '' : 's'} ` +
      `already holding still ${n === 1 ? 'was' : 'were'} slowed to ${st.rate}x, ${s(st.seconds)} added. Nothing was cut.`
  }
  if (st) {
    if (!st.heard) {
      // A device take is silent on purpose, so telling it to transcribe is an errand
      // that comes back empty. The honest answer there is more of the flow.
      if (st.taps) {
        return `This edit is ${s(res.was)} and ${s(res.target)} is not in it. Nobody is talking on this take, ` +
          `so the only moments in it are the taps and holding one longer than the finger held it reads as a ` +
          `stall: record more of the flow, or ask for ${s(res.was)} or less.`
      }
      return `This edit is ${s(res.was)} and ${s(res.target)} is not in it. Nothing here says where the ` +
        `talking is, and slowing a voice is the one thing this must not do: transcribe this take, ` +
        `or ask for ${s(res.was)} or less.`
    }
    return st.moments.length
      ? `This edit is ${s(res.was)} and ${s(res.target)} is not in it: the most it can honestly hold is ` +
        `${s(st.reach)}, from ${st.moments.length} moment${st.moments.length === 1 ? '' : 's'} worth dwelling on, ` +
        `and nothing is slowed past ${st.floor}x. Ask for ${s(st.reach)} or less, or record more.`
      : `This edit is ${s(res.was)} and ${s(res.target)} is not in it: nothing in it is holding still with ` +
        `nobody talking over it, so there is nothing to slow. Ask for ${s(res.was)} or less, or record more.`
  }
  if (res.short) return `This edit is ${s(res.was)}, already under ${s(res.target)}, and slowing was turned off. Nothing was changed.`
  const took = []
  if (res.cut.fillers.count) took.push(`${res.cut.fillers.count} filler${res.cut.fillers.count === 1 ? '' : 's'}`)
  // On a take with no voice the same span is not a pause, it is the wait between two
  // taps, and calling it a pause would have the sentence describe a take nobody made.
  if (res.cut.dead.count) took.push(res.spine === 'taps'
    ? `${res.cut.dead.count} wait${res.cut.dead.count === 1 ? '' : 's'} between taps`
    : `${res.cut.dead.count} pause${res.cut.dead.count === 1 ? '' : 's'}`)
  if (res.cut.beats.length) took.push(`${res.cut.beats.length} beat${res.cut.beats.length === 1 ? '' : 's'}`)
  const what = took.length ? took.join(', ') : 'nothing'
  const floor = res.held_back
    ? ` ${res.held_back} more cut${res.held_back === 1 ? '' : 's'} stayed: taking them would have left under half a second of video.`
    : ''
  if (res.hit) return `${s(res.was)} to ${s(res.now)} against ${s(res.target)}: ${what} went.${floor}`
  const rest = res.next
    ? ` The next thing to drop is ${res.next.id || 'a beat'}${res.next.label ? ` (${res.next.label})` : ''}, which would leave it at ${s(res.next.leaves)}.`
    : ' What is left is speech somebody asked to keep.'
  if (res.held_back) return `${s(res.was)} to ${s(res.now)} against ${s(res.target)}: ${what} went.${floor}`
  return `${s(res.was)} to ${s(res.now)}, still ${s(res.over_by)} over ${s(res.target)}: ${what} went.${rest}`
}

/**
 * Choose the clips that land this edit on `seconds`.
 *
 * `doc` is the edit document (clips, dur, beats, zooms, marks). `o.words` is the word
 * timings from the transcript, `o.speech` the speech runs beside them; with no speech
 * runs the caption spans stand in, so a document alone is enough to find the pauses.
 * `o.keep` is a list of beat ids or phrases that must survive, and a term that matched
 * nothing comes back under `keep.unmatched` rather than being quietly ignored.
 *
 * A target above the edit's own length cuts nothing and slows the moments it is already
 * dwelling on instead (`o.slow: false` turns that off). It comes back under `stretch`,
 * with `reach`, the longest this edit can honestly be, whether it got there or not.
 *
 * Nothing here mutates `doc`.
 */
function fit(doc = {}, o = {}) {
  const clips0 = clipsOf(doc)
  const was = outLength(clips0)
  const target = o.seconds == null ? null : Math.max(0, num(o.seconds))
  const tol = Math.max(0.2, num(o.tolerance, target == null ? 0.5 : Math.max(0.5, target * 0.02)))
  const dur = num(doc.dur) || (clips0.length ? num(clips0[clips0.length - 1].end) : 0)

  const W = readWords(o.words)
  const speech = (o.speech && o.speech.length) ? o.speech
    : (doc.cues || []).filter(c => c && num(c.end) > num(c.start)).map(c => [num(c.start), num(c.end)])
  // The taps stand in only where there is no voice at all. A take with both is a
  // narrated one and its own words say which seconds matter; a take with neither is
  // the sentence at the bottom of this function.
  const taps = (speech.length || W.length) ? [] : tapRuns(doc, { ...o, dur })
  // What the pause pass measures against. The stretch pass is deliberately not given
  // the taps: dwelling is about holding a moment for a viewer who is listening, and
  // the gaps between taps are the part of a device take with nothing in them.
  const timed = speech.length ? speech : taps

  const spans = []
  const at = () => outLength(subtract(clips0, spans))
  const need = () => (target == null ? Infinity : at() - target)
  const room = () => target == null || need() > tol
  const gainOf = span => at() - outLength(subtract(clips0, spans.concat([span])))

  // The floor every pass answers to. The beat pass refused to take an edit further
  // under the target than it was over it, but only counted beats, so the filler and
  // dead air passes could take every second between them and the whole thing still
  // reported the number hit. One floor now, checked the way the passes check
  // everything else: on what is actually left once the span comes out.
  const floor = MIN_OUT
  let held = 0
  const allows = span => {
    if (outLength(subtract(clips0, spans.concat([span]))) >= floor - 1e-6) return true
    held++
    return false
  }

  const cut = { fillers: { count: 0, seconds: 0, words: [] }, dead: { count: 0, seconds: 0, left: 0 }, beats: [] }
  let why = null

  // The cards and the emphasis marks, which the two cheap passes carve their candidate
  // cuts around rather than through.
  // A tap is work drawn on screen the same way a card is, and a cut through one leaves
  // half a disc, so the cheap passes carve around the taps as well.
  const blocked = merge([...drawnSpans(doc), ...taps.map(([a, b]) => ({ start: a, end: b }))])

  // 1. The fillers. Cheapest cut in the product: the sentence is unchanged. All of them
  // go once the pass runs at all, because half the ums left in is worse than either end
  // of that choice.
  const wantFillers = o.fillers != null ? !!o.fillers : true
  if (wantFillers && room() && W.length) {
    for (const s of fillerSpans(W, { ...o, dur }).flatMap(s => clearOf(s, blocked))) {
      const g = gainOf(s)
      if (g <= 0) continue
      if (!allows(s)) continue
      spans.push(s)
      cut.fillers.count++
      cut.fillers.seconds = r3(cut.fillers.seconds + g)
      if (!cut.fillers.words.includes(s.text)) cut.fillers.words.push(s.text)
    }
  }

  // 2. The pauses, longest first, so each cut buys the most seconds. With a target the
  // pass stops the moment it lands; the dead air still in the edit is reported rather
  // than taken, because the ask was a length and not a scrub.
  const wantDead = o.deadAir != null ? !!o.deadAir : true
  if (wantDead && room()) {
    const dead = deadSpans(timed, { dur, minSilence: o.minSilence, pad: o.padding != null ? o.padding : o.pad })
      .flatMap(s => clearOf(s, blocked))
      .sort((a, b) => (b.end - b.start) - (a.end - a.start))
    for (const s of dead) {
      const g = gainOf(s)
      if (g <= MIN_CUT) continue
      if (!room()) { cut.dead.left = r3(cut.dead.left + g); continue }
      let span = s, took = g
      if (target != null && g > need() + tol) {
        // Take only as much of this pause as the number still needs, from its front, so
        // the breath before the next word survives. A pause half taken is still a pause
        // taken, and it is what lands the edit on the target rather than under it.
        const end = s.start + (s.end - s.start) * (Math.max(0, need()) / g)
        if (end - s.start < MIN_CUT) { cut.dead.left = r3(cut.dead.left + g); continue }
        span = { start: r3(s.start), end: r3(end), why: 'dead' }
        took = gainOf(span)
        cut.dead.left = r3(cut.dead.left + (g - took))
      }
      if (!allows(span)) { cut.dead.left = r3(cut.dead.left + took); continue }
      spans.push(span)
      cut.dead.count++
      cut.dead.seconds = r3(cut.dead.seconds + took)
    }
  }

  // 3. Whole beats, worst first, and every drop has to land the edit nearer the number
  // than leaving it did: a beat worth more than twice what is still owed takes the edit
  // further under the target than it was over it, and butchering a take to satisfy a
  // number is not what was asked. When nothing left qualifies the pass stops and says
  // what the next one would have cost, which is a decision for the caller to make.
  const rank = rankBeats(doc, { ...o, words: W })
  const wantBeats = o.beats != null ? !!o.beats : true
  let next = null
  if (wantBeats && target != null) {
    const taken = new Set()
    let guard = 0
    while (need() > tol && guard++ < 400) {
      const live = rank.beats.filter(b => !taken.has(b) && !b.keep && gainOf(b) > MIN_CUT)
      // Never return an empty edit. One beat survives whatever the number says.
      if (!live.length || rank.beats.filter(b => !taken.has(b)).length <= 1) break
      const pick = live.find(b => gainOf(b) < 2 * need())
      if (!pick) {
        const cheapest = live.slice().sort((a, b) => gainOf(a) - gainOf(b))[0]
        next = { id: cheapest.id, label: cheapest.label, seconds: r3(gainOf(cheapest)), leaves: r3(at() - gainOf(cheapest)) }
        break
      }
      const g = gainOf(pick)
      taken.add(pick)
      if (!allows({ start: pick.start, end: pick.end, why: 'beat' })) continue
      spans.push({ start: pick.start, end: pick.end, why: 'beat' })
      cut.beats.push({ id: pick.id, label: pick.label, start: pick.start, end: pick.end, seconds: r3(g), value: pick.value, takes: pick.takes })
    }
  }

  // 4. The other direction. Asked for more than the take holds, nothing is cut: the
  // moments that are already dwelling are slowed, all of them by the same factor, and
  // that factor is the gentlest one that reaches the number. One rate everywhere keeps
  // the take's own rhythm, and choosing which hold deserves more than another is a
  // judgement the product has no ground to make.
  const wantSlow = o.slow != null ? !!o.slow : true
  let clips = subtract(clips0, spans)
  let stretch = null
  if (target != null && was < target - tol && wantSlow) {
    // Without speech runs there is no evidence of where the talking is, and a stretch
    // that guesses wrong is a slowed voice. Nothing is dwelt on until something says.
    const heard = speech.length > 0
    const dwell = heard ? dwellSpans(doc, { dur, speech }) : []
    // Measured, never predicted: the moments are worth what the clips actually come
    // out at with them slowed, which is how the rest of this file counts seconds.
    const worth = m => r3(outLength(slowInside(clips, [m], SLOW_MIN)) - was)
    const moments = dwell.map(m => ({ ...m, seconds: worth(m) })).filter(m => m.seconds > 0)
    const most = moments.reduce((n, m) => n + m.seconds, 0)
    const reach = r3(was + most)
    // gain(k) is most * (1 / k - 1), so the rate that lands on the number is exact.
    const rate = most > 0 && target <= reach + tol
      ? Math.max(SLOW_MIN, r3(most / (most + (target - was)))) : null
    if (rate) clips = slowInside(clips, moments, rate)
    stretch = { rate, seconds: 0, reach, floor: SLOW_MIN, heard, taps: taps.length > 0, moments }
  }

  const now = outLength(clips)
  if (stretch) stretch.seconds = r3(now - was)
  const keptRanges = clips.map(c => [num(c.start), num(c.end)])
  // What no longer has any frames to play over. The caller is told, never quietly left
  // with a zoom on footage that went.
  const gone = x => !keptRanges.some(([a, b]) => overlaps(num(x.start), num(x.end), a, b) > MIN_PIECE)
  const orphans = {
    zooms: (doc.zooms || []).filter(z => z && gone(z)).map(z => z.id).filter(Boolean),
    marks: (doc.marks || []).filter(m => m && gone(m)).map(m => m.id).filter(Boolean),
    texts: (doc.texts || []).filter(t => t && gone(t)).map(t => t.id).filter(Boolean),
    cues: (doc.cues || []).filter(c => c && gone(c)).length,
  }

  if (!W.length && !speech.length && !taps.length && !(doc.beats || []).length) {
    why = 'No transcript, so there is nothing to choose from. Transcribe this take first.'
  }

  // A pass that ran into the floor is said out loud. An edit cut to nothing that
  // reports the number hit is the one result an agent cannot recover from, because it
  // reads as success.
  const floored = held > 0

  // Short means short after the stretch, not before it: the field is what the caller
  // has to act on, and a take that reached the number by dwelling has nothing left to
  // act on. Reported short, the answer is a smaller number or more footage.
  const startedShort = target != null && was < target - tol
  const stillShort = startedShort && now < target - tol
  const res = {
    target, tolerance: r3(tol),
    was: r3(was), now: r3(now),
    // Which evidence said where the seconds worth keeping are. The caller needs it:
    // "3 waits between taps went" and "3 pauses went" are two different takes, and an
    // agent that reads `taps` here knows transcribe is not the missing call.
    spine: speech.length ? 'speech' : taps.length ? 'taps' : null,
    short: stillShort,
    // A cut the floor refused means the edit is sitting on the floor rather than on
    // the number, and calling that a hit is how an agent ships an empty video. Four and
    // a half seconds under the number is not a hit either, which is what this used to
    // report for every take too short to reach the brief.
    hit: target == null ? !held
      : startedShort ? now >= target - tol && now <= target + tol
      : now <= target + tol && !held,
    over_by: target == null ? 0 : r3(Math.max(0, now - target)),
    under_by: target == null ? 0 : r3(Math.max(0, target - now)),
    clips, cut, next, ...(stretch ? { stretch } : {}),
    ...(floored ? { held_back: held } : {}),
    keep: { matched: rank.matched, unmatched: rank.unmatched },
    spans: merge(spans).map(s => [s.start, s.end]),
    orphans, why,
  }
  res.why = line(res)
  return res
}

/**
 * The fillers alone, with no length in mind. Same operation as the first rung of fit,
 * and it is what "take the ums out" means on its own.
 */
const cutFillers = (doc = {}, o = {}) => fit(doc, { ...o, seconds: null, fillers: true, deadAir: false, beats: false })

module.exports = { FILLERS, SLOW_MIN, TAP, fillerSpans, deadSpans, tapRuns, dwellSpans, rankBeats, fit, cutFillers, subtract, slowInside, outLength, merge }
