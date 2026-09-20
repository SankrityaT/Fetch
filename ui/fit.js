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

// ── which beat is worth the least ───────────────────────────────────────────

const AIMED = ['lift', 'spotlight', 'step', 'loupe']

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
  if (res.short) return `This edit is ${s(res.was)}, already under ${s(res.target)}. Nothing was dropped: a target is a ceiling, not a stretch.`
  const took = []
  if (res.cut.fillers.count) took.push(`${res.cut.fillers.count} filler${res.cut.fillers.count === 1 ? '' : 's'}`)
  if (res.cut.dead.count) took.push(`${res.cut.dead.count} pause${res.cut.dead.count === 1 ? '' : 's'}`)
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

  // 1. The fillers. Cheapest cut in the product: the sentence is unchanged. All of them
  // go once the pass runs at all, because half the ums left in is worse than either end
  // of that choice.
  const wantFillers = o.fillers != null ? !!o.fillers : true
  if (wantFillers && room() && W.length) {
    for (const s of fillerSpans(W, { ...o, dur })) {
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
    const dead = deadSpans(speech, { dur, minSilence: o.minSilence, pad: o.padding != null ? o.padding : o.pad })
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

  const clips = subtract(clips0, spans)
  const now = outLength(clips)
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

  if (!W.length && !speech.length && !(doc.beats || []).length) {
    why = 'No transcript, so there is nothing to choose from. Transcribe this take first.'
  }

  // A pass that ran into the floor is said out loud. An edit cut to nothing that
  // reports the number hit is the one result an agent cannot recover from, because it
  // reads as success.
  const floored = held > 0

  const res = {
    target, tolerance: r3(tol),
    was: r3(was), now: r3(now),
    short: target != null && was < target - tol,
    // A cut the floor refused means the edit is sitting on the floor rather than on
    // the number, and calling that a hit is how an agent ships an empty video.
    hit: target == null ? !held : now <= target + tol && (!held || was < target - tol),
    over_by: target == null ? 0 : r3(Math.max(0, now - target)),
    clips, cut, next,
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

module.exports = { FILLERS, fillerSpans, deadSpans, rankBeats, fit, cutFillers, subtract, outLength, merge }
