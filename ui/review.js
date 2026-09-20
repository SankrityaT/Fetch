// The house rubric, measured rather than asserted: what is wrong with this edit, ranked,
// with the exact call that fixes each one. It is how an agent checks its own work instead
// of declaring success, and the export runs it too, so nobody can say "done" without
// having been handed the list.
//
// Pure. It runs inside an export, inside the bridge and under plain node, and it takes
// a document and a few measured numbers, never a path: a module that reads the disk or
// spawns ffmpeg is a module no test can state a case for. The one thing it does import
// is ui/timeline.js, which reads nothing either and owns the map from source seconds to
// output seconds. Every length in here is an output length, and a clip can carry a
// rate, so copying that map rather than calling it is how review and the export end up
// reporting two different numbers for one edit.
//
// One clock: every time in a finding, and every time in a fix, is a second of the
// original recording, the clock the document and apply_edit already use, so a fix can be
// sent back exactly as it was read. An output length says so by name (seconds, target),
// and look_at carries both, because contact_sheet reads the output and preview_frame
// reads the recording.

const Timeline = require('./timeline')

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
// How far off the asked-for length still counts as hitting it. A 60 second demo at 63
// seconds is a 60 second demo; at 78 it is not the thing that was asked for.
const NEAR = { share: 0.08, floor: 2 }

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
  const src = cs.length ? cs : (dur > 0 ? [{ id: null, start: 0, end: dur, rate: [1, 1] }] : [])
  let t = 0
  return src.map(c => {
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

// ── the rubric ──────────────────────────────────────────────────────────────
// Rank inside a severity. The order is what a person would fix first: the promise they
// made (what must be hidden, the shape, the words), then the length, then the clutter.
const RANK = ['redactions', 'aspect', 'captions', 'burn-in', 'must-keep', 'length',
  'dead-air', 'never-drawn', 'spans-a-cut', 'focus-clash', 'zoom-density', 'hand-aimed',
  'ground', 'no-zooms', 'no-brief']
const WEIGHT = { blocking: 0, should: 1, note: 2 }

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
 *
 * Returns { verdict, summary, items, look_at, measured }. Every item carries
 * { rule, severity, what, at, fix: { tool, args, why } }.
 */
function review(input = {}) {
  const doc = input.doc || {}
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
  const dead = heard ? deadAir(k, speech) : []
  const zooms = arr(doc.zooms)
  const marks = arr(doc.marks)
  const redactions = marks.filter(m => m && (m.kind === 'redact' || m.kind === 'blur'))
  const cues = arr(doc.cues)
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

  // A phrase the brief said to keep, cut out of the edit.
  const keepers = arr(brief && brief.must_keep).filter(Boolean)
  for (const phrase of keepers.slice(0, 6)) {
    const needle = String(phrase).toLowerCase().trim()
    const hits = cues.filter(c => c && String(c.text || '').toLowerCase().includes(needle))
    if (!hits.length) continue                                 // never said: not a cut
    if (hits.some(c => across(k, +c.start, +c.end).length)) continue
    const at = r2(+hits[0].start)
    // fit_to_length only ever removes material, so handing it back here was a call that
    // could not clear its own finding. Put the span back first: clips is the whole list,
    // so the fix is what is kept now plus the piece the phrase is in.
    const from = r2(Math.max(0, +hits[0].start - 0.3))
    const to = r2(Math.min(+doc.dur || +hits[hits.length - 1].end, +hits[hits.length - 1].end + 0.3))
    const clips = mergeSpans([...k.map(c => [c.start, c.end]), [from, to]])
      .map(([a, b]) => ({ start: r2(a), end: r2(b) }))
    add('must-keep', 'should', `"${phrase}" is in the take at ${secs(at)} and the edit cuts it out.`,
      call('apply_edit', { doc: { clips } },
        `this puts ${secs(from)} to ${secs(to)} back in; fit_to_length with keep: ["${phrase}"] then takes the length out of elsewhere`), at)
  }

  // The length asked for.
  if (target) {
    const room = Math.max(NEAR.floor, target * NEAR.share)
    const off = seconds - target
    if (Math.abs(off) > room) {
      const far = Math.abs(off) > target * 0.25
      if (off > 0) {
        add('length', far ? 'blocking' : 'should',
          `The edit runs ${secs(seconds)} against the ${secs(target)} asked for, ${secs(r2(off))} long.`,
          call('fit_to_length', { seconds: target, ...(keepers.length ? { keep: keepers } : {}) },
            'it cuts from the beats and the silences and writes clips, so the edit stays editable'))
      } else {
        const spare = r2((+doc.dur || 0) - seconds)
        add('length', far ? 'blocking' : 'should',
          `The edit runs ${secs(seconds)} against the ${secs(target)} asked for, ${secs(r2(-off))} short.` +
          (spare > 1 ? ` There is ${secs(spare)} of the take not in it.` : ' The whole take is already in it.'),
          spare > 1
            ? call('apply_edit', { doc: { clips: [{ start: 0, end: r2(+doc.dur || 0) }] } },
              'put the take back whole, then cut to the length with fit_to_length')
            : call('direct', { brief: { seconds: Math.round(seconds) } },
              'the take is not long enough for the brief: change the target, or record more'))
      }
    }
  }

  // Dead air the edit still carries.
  const deadTotal = r2(dead.reduce((n, g) => n + (g.end - g.start), 0))
  if (dead.length && (!spec || spec.tight) && deadTotal >= DEAD_GAP) {
    const worst = dead.slice().sort((a, b) => (b.end - b.start) - (a.end - a.start))[0]
    add('dead-air', 'should',
      `${secs(deadTotal)} of the edit has nobody speaking, in ${plural(dead.length, 'gap')}, the longest ` +
      `${secs(r2(worst.end - worst.start))} at ${secs(worst.start)}.`,
      // Never the brief's own length: fit_to_length is a ceiling, so a 45 s edit asked to
      // fit 60 s drops nothing and the finding comes back word for word on the next
      // review. The target is what the edit is once the silence is out of it.
      call('fit_to_length', { seconds: Math.max(1, Math.round(seconds - deadTotal)) },
        'it cuts the silences first, and writes clips rather than a new file'),
      worst.start)
  }

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
    if (parts.length < 2) continue
    const best = parts.slice().sort((a, b) => b.seconds - a.seconds)[0]
    const start = r2(Math.max(+m.start, best.piece.start)), end = r2(Math.min(+m.end, best.piece.end))
    add('spans-a-cut', 'should',
      `${m.id} (${m.kind}) runs across a cut, so its element is only under it for part of the span.`,
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

  items.sort((a, b) => (WEIGHT[a.severity] - WEIGHT[b.severity]) ||
    (RANK.indexOf(a.rule) - RANK.indexOf(b.rule)) || ((a.at || 0) - (b.at || 0)))

  const bad = items.filter(i => i.severity === 'blocking').length
  const should = items.filter(i => i.severity === 'should').length
  const verdict = bad ? 'not ready' : should ? 'nearly' : 'ready'
  const summary = bad || should
    ? `${verdict === 'not ready' ? 'Not ready' : 'Nearly'}: ` +
      [bad ? `${plural(bad, 'thing')} to fix` : '', should ? `${plural(should, 'thing')} worth fixing` : '']
        .filter(Boolean).join(', ') + '.'
    : `Ready: ${secs(seconds)}${target ? ` against the ${secs(target)} asked for` : ''}, nothing the rubric can name.`

  return {
    verdict,
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
      dead_air: heard ? { seconds: deadTotal, gaps: dead.slice(0, 4) } : { seconds: null, gaps: [], why: 'nothing says where anybody spoke: no captions and no beats' },
      ground: ground === null ? null : r2(ground),
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
const blocking = r => (r && arr(r.items).filter(i => i.severity === 'blocking')) || []

module.exports = { review, blocking, whereSpec, WHERE, kept, outAt, outLength, deadAir, focusClashes, handAimed, luma, DEAD_GAP, ZOOM_EVERY }
