// What makes an export look edited rather than annotated: captions, title cards,
// labels and numbered steps, written as ASS (libass) events, and the geometry of lifts
// and spotlights.
//
// Two scripts per export, because the two kinds of overlay live in different spaces:
//
//   content  steps belong to the recording (as lifts and spotlights do, which change
//            pixels and are drawn by processor.js from focusShape). Drawn before any
//            zoom, so a zoom moves them with the thing they point at.
//   frame    captions, titles and labels belong to the finished frame. They are drawn
//            last, on the 1920x1080 composite, so a zoom never enlarges a caption and
//            a title can sit on the backdrop.
//
// Two curves, one per kind of motion. Anything that travels from one rest to another
// (the camera's zoom and pan, the agent's cursor, a spotlight riding a zoom) uses MOVE,
// the smoothstep zoompan evaluates in processor.js, so they read as one move. Anything
// that appears or leaves (captions, titles, labels, badges) uses the app's own
// cubic-bezier(.2,.8,.2,1) in and (.4,0,1,1) out. Both are baked into short events a
// frame apart: libass animates \t linearly and \move only in straight lines.
//
// Pure: no filesystem, no DOM. The editor preview uses the same phrasing and styles.
// All times are seconds on the output clock unless a function says otherwise.

// ── curves ──────────────────────────────────────────────────────────────────
function bezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by
  const X = t => ((ax * t + bx) * t + cx) * t
  const Y = t => ((ay * t + by) * t + cy) * t
  const dX = t => (3 * ax * t + 2 * bx) * t + cx
  return p => {
    if (p <= 0) return 0
    if (p >= 1) return 1
    let t = p
    for (let i = 0; i < 8; i++) {
      const e = X(t) - p, d = dX(t)
      if (Math.abs(e) < 1e-5 || !d) break
      t -= e / d
    }
    return Y(Math.min(1, Math.max(0, t)))
  }
}
const EASE_IN = bezier(0.2, 0.8, 0.2, 1)      // entering, the app's --ease-in
const EASE_OUT = bezier(0.4, 0, 1, 1)         // leaving, the app's --ease-out
const MOVE = p => (p <= 0 ? 0 : p >= 1 ? 1 : p * p * (3 - 2 * p))   // travelling, zoompan's smoothstep
// how long a zoom takes to push in and to pull back (processor.js explicitZoomFilter)
const ZOOM_EASE = 0.45
// A small overshoot, for the one thing allowed to pop: a step badge landing
const POP = p => { const c = 1.9, q = p - 1; return p >= 1 ? 1 : 1 + (c + 1) * q * q * q + c * q * q }

// ── ASS primitives ──────────────────────────────────────────────────────────
const FONT = { caption: 'Fetch Caption', title: 'Fetch Title', sub: 'Fetch Subtitle', num: 'Fetch Rounded' }
const GOLD = '#F0A93C', INK = '#1A1714', WHITE = '#FBFAF8'
const hex2 = n => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0').toUpperCase()
function rgb(hex) {
  const named = { white: '#FFFFFF', black: '#000000' }
  const m = /^#?([0-9a-f]{6})$/i.exec(named[String(hex).toLowerCase()] || String(hex || ''))
  return m ? m[1].match(/../g).map(v => parseInt(v, 16)) : [255, 255, 255]
}
const colour = hex => { const [r, g, b] = rgb(hex); return `&H${hex2(b)}${hex2(g)}${hex2(r)}&` }
// ASS alpha is transparency: 0 is opaque
const alpha = opacity => `&H${hex2(255 * (1 - Math.max(0, Math.min(1, opacity))))}&`
const n1 = v => (Math.round(v * 10) / 10).toString()
const cs = t => Math.max(0, Math.round(t * 100))
function stamp(c) {
  const h = Math.floor(c / 360000), m = Math.floor(c / 6000) % 60, s = Math.floor(c / 100) % 60, f = c % 100
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(f).padStart(2, '0')}`
}
// user text is literal: braces would open an override block, a backslash a tag
const esc = s => String(s == null ? '' : s).replace(/\\/g, '\u29F5').replace(/[{}]/g, '').replace(/\r?\n/g, ' ')

// An event list that knows how to write itself. Times are in centiseconds so two
// events meant to touch share the exact boundary.
function events() {
  const list = []
  return {
    list,
    add(layer, a, b, text) { this.addCs(layer, cs(a), cs(b), text) },     // seconds
    addCs(layer, A, B, text) { if (B > A) list.push({ layer, a: A, b: B, text }) },
    // Samples fn over [t0, t0 + dur] a frame apart, one event per sample, then holds
    // the last value until `until` (seconds). fn gets p in 0..1 and returns the text.
    bake(layer, t0, dur, fn, until, step = 1 / 30) {
      const n = Math.max(1, Math.round(dur / step))
      for (let k = 0; k < n; k++) {
        this.addCs(layer, cs(t0 + (k * dur) / n), cs(t0 + ((k + 1) * dur) / n), fn((k + 0.5) / n))
      }
      if (until != null) this.addCs(layer, cs(t0 + dur), cs(until), fn(1))
    },
  }
}

function script(W, H, evs) {
  const head = [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${W}`, `PlayResY: ${H}`,
    'WrapStyle: 2', 'ScaledBorderAndShadow: yes', 'YCbCr Matrix: None', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, ' +
      'BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, ' +
      'BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    // One neutral style; every event sets its own font, size and colour inline
    `Style: F,${FONT.caption},48,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1`,
    '', '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ]
  const body = evs.list
    .slice().sort((x, y) => x.a - y.a || x.layer - y.layer)
    .map(e => `Dialogue: ${e.layer},${stamp(e.a)},${stamp(e.b)},F,,0,0,0,,${e.text}`)
  return head.concat(body).join('\n') + '\n'
}

// A rounded rectangle as an ASS drawing, clockwise, or counter-clockwise for a hole
function roundRect(x, y, w, h, r, ccw = false) {
  r = Math.max(0, Math.min(r, w / 2, h / 2))
  const k = r * 0.4477          // 1 - 0.5523: how far a quarter-circle's handles sit from the corner
  const X1 = x + w, Y1 = y + h
  const f = v => n1(v)
  if (!ccw) {
    return `m ${f(x + r)} ${f(y)} l ${f(X1 - r)} ${f(y)} b ${f(X1 - k)} ${f(y)} ${f(X1)} ${f(y + k)} ${f(X1)} ${f(y + r)} ` +
      `l ${f(X1)} ${f(Y1 - r)} b ${f(X1)} ${f(Y1 - k)} ${f(X1 - k)} ${f(Y1)} ${f(X1 - r)} ${f(Y1)} ` +
      `l ${f(x + r)} ${f(Y1)} b ${f(x + k)} ${f(Y1)} ${f(x)} ${f(Y1 - k)} ${f(x)} ${f(Y1 - r)} ` +
      `l ${f(x)} ${f(y + r)} b ${f(x)} ${f(y + k)} ${f(x + k)} ${f(y)} ${f(x + r)} ${f(y)}`
  }
  return `m ${f(x + r)} ${f(y)} b ${f(x + k)} ${f(y)} ${f(x)} ${f(y + k)} ${f(x)} ${f(y + r)} ` +
    `l ${f(x)} ${f(Y1 - r)} b ${f(x)} ${f(Y1 - k)} ${f(x + k)} ${f(Y1)} ${f(x + r)} ${f(Y1)} ` +
    `l ${f(X1 - r)} ${f(Y1)} b ${f(X1 - k)} ${f(Y1)} ${f(X1)} ${f(Y1 - k)} ${f(X1)} ${f(Y1 - r)} ` +
    `l ${f(X1)} ${f(y + r)} b ${f(X1)} ${f(y + k)} ${f(X1 - k)} ${f(y)} ${f(X1 - r)} ${f(y)} l ${f(x + r)} ${f(y)}`
}
// from 0,0: libass centres a drawing on \\pos by its box measured from the origin
const circle = R => roundRect(0, 0, 2 * R, 2 * R, R)

// Width of a string, when the caller has no real font metrics to offer. SF Pro Bold
// averages a little over half an em per character in running text.
const estimate = (text, px) => String(text).length * px * 0.56

// ── captions ────────────────────────────────────────────────────────────────
const normWord = w => String(w || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '')

/**
 * Timed tokens for the caption text. The words on screen come from the cues, which a
 * person may have corrected ("Songscription", "Easy in C"); the timing comes from
 * the transcriber's words. The two are matched per cue by longest common subsequence
 * of normalised words, and a word with no match is placed between its neighbours.
 * Times here are source seconds. words is [{w, t}] as in .words.json.
 */
function alignWords(cues, words) {
  const all = (words || []).filter(x => x && isFinite(+x.t)).map(x => ({ n: normWord(x.w), t: +x.t }))
    .sort((a, b) => a.t - b.t)
  const out = []
  let from = 0
  for (const c of cues || []) {
    const text = String(c.text || '').trim()
    if (!text || !(c.end > c.start)) continue
    const toks = text.split(/\s+/)
    let lo = from
    while (lo < all.length && all[lo].t < c.start - 0.25) lo++
    let hi = lo
    while (hi < all.length && all[hi].t < c.end - 0.02) hi++
    const cand = all.slice(lo, hi)
    from = hi
    const times = new Array(toks.length).fill(null)
    if (cand.length) {
      const A = toks.map(normWord), B = cand.map(x => x.n)
      const L = Array.from({ length: A.length + 1 }, () => new Array(B.length + 1).fill(0))
      for (let i = A.length - 1; i >= 0; i--) {
        for (let j = B.length - 1; j >= 0; j--) {
          L[i][j] = A[i] && A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1])
        }
      }
      let i = 0, j = 0
      while (i < A.length && j < B.length) {
        if (A[i] && A[i] === B[j]) { times[i] = cand[j].t; i++; j++ }
        else if (L[i + 1][j] >= L[i][j + 1]) i++
        else j++
      }
      // same count and nothing matched (a rewritten cue): take the words in order
      if (times.every(t => t == null) && A.length === B.length) cand.forEach((x, k) => { times[k] = x.t })
    }
    // Fill the gaps. With no timing at all, share the cue out by word length, which
    // is roughly how long a word takes to say.
    const weight = toks.map(t => t.length + 2)
    const known = times.map((t, i) => t != null ? i : -1).filter(i => i >= 0)
    for (let i = 0; i < toks.length; i++) {
      if (times[i] != null) continue
      const prev = known.filter(k => k < i).pop(), next = known.find(k => k > i)
      const t0 = prev != null ? times[prev] : c.start, i0 = prev != null ? prev : -1
      const t1 = next != null ? times[next] : c.end, i1 = next != null ? next : toks.length
      let wsum = 0, wat = 0
      for (let k = i0 + 1; k < i1; k++) { wsum += weight[k]; if (k < i) wat += weight[k] }
      const span = Math.max(0, t1 - t0), lead = prev != null ? weight[prev] : 0
      times[i] = t0 + span * (wat + lead * (prev != null ? 1 : 0)) / (wsum + (prev != null ? lead : 0) || 1)
    }
    for (let i = 0; i < toks.length; i++) {
      const start = Math.max(c.start, Math.min(c.end, times[i]))
      out.push({ text: toks[i], start, end: 0, cueEnd: c.end })
    }
  }
  out.sort((a, b) => a.start - b.start)
  for (let i = 0; i < out.length; i++) {
    const next = out[i + 1]
    // a word lasts until the next one starts, but not through a pause
    const limit = Math.min(out[i].cueEnd, out[i].start + 0.9)
    out[i].end = Math.max(out[i].start + 0.08, next ? Math.min(next.start, limit) : limit)
    delete out[i].cueEnd
  }
  return out
}

/**
 * Word start times moved onto the speech the audio actually holds. The recogniser
 * reports words about a third of a second before they are heard (measured against
 * the waveform on real takes, up to half a second), so a caption and its highlighted
 * word ran ahead of the voice at every sentence. times are seconds, speech is
 * [[a, b]] from silencedetect (transcribe's speechRegions). Each region's first word
 * starts on its onset and every word is kept inside its region. Returns
 * { times, at }, at mapping any other time (a cue's edge) the same way. Idempotent:
 * aligned words move no further.
 */
function snapToSpeech(times, speech, { reach = 0.6, fine = 0.2 } = {}) {
  const R = (speech || []).filter(r => r && r[1] > r[0]).slice().sort((x, y) => x[0] - y[0])
  const ts = (times || []).map(Number)
  const same = { times: ts.slice(), at: t => t }
  if (!R.length || !ts.length) return same
  // A word inside a region is in it. One in the silence before a region is that
  // region's first word reported early; failing that, a last word run long.
  const regionOf = t => {
    for (let i = 0; i < R.length; i++) {
      if (t >= R[i][0] && t <= R[i][1]) return i
      if (t < R[i][0]) return R[i][0] - t <= reach ? i : i > 0 && t - R[i - 1][1] <= reach ? i - 1 : -1
    }
    return t - R[R.length - 1][1] <= reach ? R.length - 1 : -1
  }
  const of = ts.map(regionOf)
  // Within a region the lead is not constant: the word heard after a silence is
  // reported early, the words at its end about on time. So each region is mapped
  // onto itself with its first word moved to the onset and its end held still, which
  // draws the early words in and leaves the late ones where they were.
  const maps = R.map(([a, b], i) => {
    const mine = ts.filter((t, j) => of[j] === i)
    if (!mine.length) return t => t
    const t0 = Math.max(a - reach, Math.min(a + fine, Math.min(...mine)))
    const k = b - t0 > 0.05 ? (b - a) / (b - t0) : 1
    return t => a + (t - t0) * k
  })
  const out = ts.map((t, j) => {
    const i = of[j]
    if (i < 0) return t
    const [a, b] = R[i]
    return Math.max(a, Math.min(b, maps[i](t)))
  })
  for (let j = 1; j < out.length; j++) if (out[j] < out[j - 1] && ts[j] >= ts[j - 1]) out[j] = out[j - 1]
  const at = t => { const i = regionOf(t); return i < 0 ? t : maps[i](t) }
  return { times: out.map(t => Math.round(t * 1000) / 1000), at }
}

// alignWords on a take's .words.json ({ words, speech }), its words and the cues'
// edges first moved onto the speech, so the export and the editor time captions alike
function spokenWords(cues, wordsDoc) {
  const words = wordsDoc && Array.isArray(wordsDoc.words) ? wordsDoc.words : null
  if (!words || !Array.isArray(wordsDoc.speech) || !wordsDoc.speech.length) return alignWords(cues, words)
  const s = snapToSpeech(words.map(w => w.t), wordsDoc.speech)
  const moved = (cues || []).map(c => {
    const a = s.at(+c.start)
    return { ...c, start: a, end: Math.max(a + 0.1, s.at(+c.end)) }
  })
  return alignWords(moved, words.map((w, i) => ({ ...w, t: s.times[i] })))
}

const SENTENCE_END = /[.!?\u2026]["'\u201D\u2019)]*$/
const CLAUSE_END = /[,;:\u2014]["'\u201D\u2019)]*$/
// A phrase should not end on a word that leans on the next one
const LEANS = new Set(['a', 'an', 'the', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'for', 'with',
  'my', 'your', 'our', 'their', 'his', 'her', 'its', 'is', 'are', 'was', 'i', 'you', 'we', 'it', 'if',
  'that', 'this', 'from', 'by', 'as', 'so', 'into', 'what', 'which'])
// Words that bind to the noun after them, so a break never follows one ("every | song")
const BINDS = new Set(['every', 'each', 'some', 'any', 'no', 'these', 'those', 'its', 'own'])

/**
 * Tokens into on-screen phrases: short, breaking where speech does (a sentence end,
 * a clause, a pause) rather than wherever a cue happened to end, so "300" and
 * "songs" are never on different screens. Each phrase is one or two lines.
 */
function captionPhrases(tokens, o = {}) {
  const maxChars = o.maxChars || 42, maxDur = o.maxDur || 3.6, gap = o.gap || 0.55
  const wrapAt = o.wrapAt || 32
  const toks = (tokens || []).map(t => ({ ...t, text: String(t.text).trim() })).filter(t => t.text)
  // Sentence case: the first word of each sentence capitalised, a lone "i" too
  let startOfSentence = true
  for (const t of toks) {
    if (startOfSentence) t.text = t.text.replace(/^(["'\u201C\u2018(]*)(\p{Ll})/u, (m, q, c) => q + c.toUpperCase())
    if (/^i('|\u2019|$)/.test(t.text)) t.text = 'I' + t.text.slice(1)
    startOfSentence = SENTENCE_END.test(t.text)
  }
  const phrases = []
  let cur = []
  const chars = list => list.reduce((n, t) => n + t.text.length + 1, -1)
  const flush = () => { if (cur.length) phrases.push(cur); cur = [] }
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i], prev = cur[cur.length - 1]
    if (prev) {
      // a word that closes the clause may run a little over, so "the MIDI" and "file,"
      // are not split across screens with the break one word short of the comma
      const closes = (SENTENCE_END.test(t.text) || CLAUSE_END.test(t.text)) &&
        chars(cur) + 1 + t.text.length <= maxChars + 8
      const long = !closes && (chars(cur) + 1 + t.text.length > maxChars || t.end - cur[0].start > maxDur)
      if (SENTENCE_END.test(prev.text) || t.start - prev.end > gap) flush()
      else if (CLAUSE_END.test(prev.text) && chars(cur) >= 14) flush()
      else if (long) {
        // Break where the words part: weighed over the rest of this clause, the split
        // that balances the two phrases without stranding "its own | piano roll" or
        // "you haven't | played yet". Words after the break carry over.
        let e = i
        while (e < toks.length - 1 && e - i < 8 && !SENTENCE_END.test(toks[e].text) &&
               !CLAUSE_END.test(toks[e].text) && toks[e + 1].start - toks[e].end <= gap) e++
        const seg = cur.concat(toks.slice(i, e + 1))
        let best = cur.length, bestW = Infinity
        for (let k = 2; k <= cur.length; k++) {
          const a = chars(seg.slice(0, k)), b = chars(seg.slice(k))
          if (a > maxChars + 4) continue
          const last = normWord(seg[k - 1].text)
          const w = Math.max(a, b) + (LEANS.has(last) || BINDS.has(last) ? 12 : 0) +
            (BINDS.has(normWord(seg[k - 2].text)) ? 12 : 0)
          if (w < bestW) { bestW = w; best = k }
        }
        const carry = cur.slice(best)
        cur = cur.slice(0, best)
        flush(); cur = carry
      }
    }
    cur.push(t)
  }
  flush()
  // a one-word tail is lonely; give it to the phrase before when that still fits
  for (let i = phrases.length - 1; i > 0; i--) {
    const p = phrases[i], q = phrases[i - 1]
    if (p.length === 1 && !SENTENCE_END.test(q[q.length - 1].text) && p[0].start - q[q.length - 1].end < 0.3 &&
        chars(q) + 1 + p[0].text.length <= maxChars + 6) {
      q.push(p[0]); phrases.splice(i, 1)
    }
  }
  return phrases.map(words => {
    const text = words.map(w => w.text).join(' ')
    // two balanced lines when one would be long
    let lines = [words.length]
    if (text.length > wrapAt && words.length > 1) {
      let best = 1, bestW = Infinity
      for (let k = 1; k < words.length; k++) {
        const a = chars(words.slice(0, k)), b = chars(words.slice(k))
        // balanced, but never a lone word on a line, and rather not a leaning one at the end
        const w = Math.max(a, b) + (LEANS.has(normWord(words[k - 1].text)) ? 2 : 0) +
          (k === 1 || k === words.length - 1 ? 8 : 0)
        if (w < bestW) { bestW = w; best = k }
      }
      lines = [best, words.length - best]
    }
    return { start: words[0].start, end: words[words.length - 1].end, words, lines, text }
  })
}

// The phrase on screen at t, with how long it stays: until its last word ends plus a
// short hold, never past the next phrase.
function phraseTimes(phrases) {
  const show = phrases.map(p => Math.max(0, p.start - 0.06, p.from || 0))
  return phrases.map((p, i) => {
    const end = Math.min(p.end + 0.35, i + 1 < phrases.length ? show[i + 1] : Infinity)
    return { ...p, show: show[i], hide: Math.max(show[i] + 0.2, end), cut: end < p.end + 0.34 }
  })
}

// The caption's size and anchor on a W x H frame. Kept in one place so the editor
// preview and the export agree.
// box is where the video sits on a framed canvas: captions keep clear of its edge
// rather than straddling it.
function captionLayout(W, H, st = {}, box = null) {
  const px = Math.round(H * 0.043 * Math.max(0.6, Math.min(1.8, +st.scale || 1)))
  const b = box || { x: 0, y: 0, w: W, h: H }
  if (st.fx != null && st.fy != null) return { px, an: 5, x: st.fx * W, y: st.fy * H }
  if (st.position === 'top') return { px, an: 8, x: W / 2, y: Math.max(H * 0.07, b.y + H * 0.045) }
  if (st.position === 'middle') return { px, an: 5, x: W / 2, y: H / 2 }
  // A framed video that leaves a caption band below it (backdropGeometry's band): the
  // caption sits in that band on the backdrop, off the product's own text entirely
  const below = H - (b.y + b.h)
  if (box && below >= H * CAP_BAND * 0.9) {
    return { px: Math.min(px, Math.round(below * 0.36)), an: 5, x: W / 2, y: b.y + b.h + below * 0.47, band: true }
  }
  return { px, an: 2, x: W / 2, y: Math.min(H * 0.925, b.y + b.h - H * 0.045) }
}
// How much of the frame's height a framed export keeps below the video for captions
const CAP_BAND = 0.12

// Where a framed video sits on its backdrop: the canvas, the video's size and offset,
// its corner radius and shadow blur, in pixels. The export builds its filter from this
// and the editor lays out its stage from it, so the two frame a take alike.
function backdropGeometry(srcW, srcH, opts = {}) {
  const inset = Math.min(0.22, Math.max(0.02, opts.inset ?? 0.08))

  // "Auto" keeps the source shape and adds the same margin on every side. Forcing
  // a 16:9 canvas around a 16:10 recording gives fat side margins and thin top and
  // bottom ones, which reads as the video being anchored rather than centred.
  let outW, outH
  const target = opts.outAspect   // number (w/h) when the user picks a shape
  if (!target) {
    const pad = inset * Math.max(srcW, srcH)
    outW = 2 * Math.round((srcW + pad * 2) / 2)
    outH = 2 * Math.round((srcH + pad * 2) / 2)
    // keep the canvas sane for encoding
    const cap = opts.scale === 720 ? 1280 : 1920
    if (outW > cap) {
      const k = cap / outW
      outW = 2 * Math.round((outW * k) / 2)
      outH = 2 * Math.round((outH * k) / 2)
    }
  } else {
    // outWidth is the long edge: a portrait shape 1920 wide came out 3414 tall
    const long = opts.outWidth || 1920
    outW = 2 * Math.round((target >= 1 ? long : long * target) / 2)
    outH = 2 * Math.round((target >= 1 ? long / target : long) / 2)
  }

  // band: a share of the height kept below the video for captions, in place of the
  // bottom margin, so they sit on the backdrop rather than on the product
  const band = Math.max(0, Math.min(0.25, +opts.band || 0))
  const bottom = band ? Math.max(band, inset) : inset
  const boxW = 2 * Math.round((outW * (1 - inset * 2)) / 2)
  const boxH = 2 * Math.round((outH * (1 - inset - bottom)) / 2)
  const scale = Math.min(boxW / srcW, boxH / srcH)
  const vidW = 2 * Math.round((srcW * scale) / 2)
  const vidH = 2 * Math.round((srcH * scale) / 2)
  const radius = Math.max(6, Math.round(opts.radius ?? Math.min(vidW, vidH) * 0.035))
  const ox = Math.round((outW - vidW) / 2)
  // with a band the video hangs from the top margin; the band takes what is left
  const oy = band ? Math.round(outH * inset + (boxH - vidH) / 2) : Math.round((outH - vidH) / 2)
  const blur = Math.max(4, Math.round(vidH * 0.035))
  return { outW, outH, vidW, vidH, radius, ox, oy, blur }
}
// In the band a phrase has the whole width, so it stays on one line
const BAND_WRAP = 60

/**
 * The window's own margin round its content, as fractions of the frame to trim from
 * each side ({ l, t, r, b }). A browser that draws its page as a rounded card inside
 * the window left a pale rim with a second rounded corner inside the frame's own.
 * px is a w x h grey frame. An edge is trimmed only where it is a run of flat lines of
 * one tone that ends on a line that differs (the content's own edge), and never by
 * more than 3 percent: a flat run with no edge behind it is the product's own margin.
 */
function gutterInsets(px, w, h) {
  const out = { l: 0, t: 0, r: 0, b: 0 }
  if (!px || px.length < w * h || w < 64 || h < 64) return out
  // a line d in from one side, over its middle 80 percent, as [mean, spread]
  const line = (side, d) => {
    const horiz = side === 't' || side === 'b'
    const n = horiz ? w : h, a = Math.round(n * 0.1), z = Math.round(n * 0.9)
    const fixed = side === 't' ? d : side === 'b' ? h - 1 - d : side === 'l' ? d : w - 1 - d
    let lo = 255, hi = 0, sum = 0
    for (let i = a; i < z; i++) {
      const v = horiz ? px[fixed * w + i] : px[i * w + fixed]
      if (v < lo) lo = v
      if (v > hi) hi = v
      sum += v
    }
    return [sum / (z - a), hi - lo]
  }
  for (const side of ['l', 't', 'r', 'b']) {
    const n = side === 't' || side === 'b' ? h : w, max = Math.round(n * 0.03)
    const [m0, s0] = line(side, 0)
    if (s0 > 8) continue
    let d = 1
    for (; d <= max; d++) {
      const [m, sp] = line(side, d)
      if (sp > 8 || Math.abs(m - m0) > 4) break
    }
    if (d >= 2 && d <= max) out[side] = d / n
  }
  return out
}

/**
 * The recorded window's own corner radius, as a fraction of the frame's width, or 0.
 * macOS captures a window's rounded corners as black, so a framed take masked with a
 * smaller radius showed a black nick at each corner. Measured as the run of near-black
 * pixels along the top and bottom rows from each corner, where the row further in is
 * light (so a dark UI that simply reaches the corner is not taken for one).
 */
function windowCorner(px, w, h) {
  if (!px || px.length < w * h || w < 64 || h < 64) return 0
  const at = (x, y) => px[y * w + x]
  let best = 0
  for (const y of [0, h - 1]) {
    for (const [x0, dx] of [[0, 1], [w - 1, -1]]) {
      let n = 0
      while (n < w / 8 && at(x0 + dx * n, y) < 40) n++
      const beyond = at(x0 + dx * Math.min(w - 1, n + 4), y)
      if (n >= 3 && n < w / 8 && beyond > 90) best = Math.max(best, n)
    }
  }
  return best / w
}

// Where a phrase's words sit: its lines, the widest line and the top of the block
function captionBlock(p, L, lineH, measure) {
  const lines = []
  let k = 0
  for (const n of p.lines) { lines.push(p.words.slice(k, k + n)); k += n }
  const n = lines.length
  const lw = Math.max(...lines.map(l => measure(l.map(w => w.text).join(' '), L.px, 'caption')))
  const top = L.an === 2 ? L.y - n * lineH : L.an === 8 ? L.y : L.y - (n * lineH) / 2
  return { lines, lw, top, h: n * lineH }
}
// A rounded rect around a block, padded by fractions of the caption size
const blockRect = (L, B, px, py) => ({ x: L.x - B.lw / 2 - L.px * px, y: B.top - L.px * py,
  w: B.lw + L.px * px * 2, h: B.h + L.px * py * 2 })
// A phrase handing straight on to the next fades all the way out before the next
// fades in: the two crossing left a grey ghost of both over a dim or a light UI.
const CAP_IN = 0.15, CAP_OUT = 0.16, CAP_HANDOFF = 0.12
const capOut = p => (p.cut ? CAP_HANDOFF : CAP_OUT)
const capFade = p => `\\fad(${Math.round(CAP_IN * 1000)},${Math.round(capOut(p) * 1000)})`
// The shadow fades in slower and out sooner than the words over the same span, so it
// is never darker than the words are legible: it read as a dark blob a frame early
const shadeFade = p => `\\fad(${Math.round(CAP_IN * 1600)},${Math.round(capOut(p) * 1600)})`
// The shadow under the words, drawn from the glyphs themselves so it follows the
// letters and has no shape of its own: a measured cloud behind the block read as a
// grey rectangle on a light UI. A wide faint glow, then a closer one. Over a frosted
// patch (captionFrost) the UI below is already mush, so the glow only has to lift
// white off a light ground; without one it has to push the UI's letters back too.
const GLOW = { frosted: { wide: 0.3, near: 0.42 }, plain: { wide: 0.52, near: 0.66 } }
// The glass hugs the words. Padded 2.4 captions wide it reached the product's words
// beside the caption and left them half soft, a smudge rather than an edit.
const FROST_PAD = [0.45, 0.22], FROST_FEATHER = 0.3
// phrases closer than this share one continuous patch of glass (captionFrost)
const FROST_JOIN = 0.3
// A phrase placed at the top, clear of something the product put up at the bottom
const layoutFor = (p, W, H, st, box) => captionLayout(W, H, p.at === 'top' && st.fx == null ? { ...st, position: 'top' } : st, box)
// ...and smaller when a line would not fit across the frame: one long unbroken token
// (a spoken URL) cannot wrap, and a caption running off both edges reads as a mistake
function fitLayout(p, W, H, st, box, measure) {
  const L = layoutFor(p, W, H, st, box)
  const lw = captionBlock(p, L, Math.round(L.px * 1.18), measure).lw
  return lw > W * 0.9 ? { ...L, px: Math.max(12, Math.floor(L.px * (W * 0.9) / lw)) } : L
}

function captionEvents(evs, phrases, W, H, st = {}, measure = estimate, box = null, frosted = false) {
  const fill = colour(st.colour || '#FFFFFF')
  const hex = String(st.colour || '#FFFFFF').replace('#', '')
  const inkText = /^[0-9a-f]{6}$/i.test(hex) &&
    (0.2126 * parseInt(hex.slice(0, 2), 16) + 0.7152 * parseInt(hex.slice(2, 4), 16) + 0.0722 * parseInt(hex.slice(4, 6), 16)) / 255 < 0.25
  const hl = st.highlight === 'none' ? null : st.highlight === 'pill' ? 'pill' : 'word'
  const IN = CAP_IN
  const glow = frosted ? GLOW.frosted : GLOW.plain
  for (const p of phraseTimes(phrases)) {
    const L = fitLayout(p, W, H, st, box, measure)
    const lineH = Math.round(L.px * 1.18)
    const base = `\\an${L.an}\\pos(${n1(L.x)},${n1(L.y)})\\fn${FONT.caption}\\fs${L.px}\\bord0\\shad0\\fsp${n1(L.px * -0.005)}`
    const a = p.show, b = p.hide
    const fadeOut = capOut(p)      // straight on to the next phrase, or fade away
    const blk = captionBlock(p, L, lineH, measure), lines = blk.lines
    const plain = lines.map(l => l.map(w => esc(w.text)).join(' ')).join('\\N')
    const fad = capFade(p), sfad = shadeFade(p)
    // in the band the ground is the soft backdrop, so the words need only a lift
    const g = L.band ? GLOW.frosted : glow
    const shade = (op, bord, blur, dy) => evs.add(0, a, b, `{${base}${sfad}\\1c&H0A0908&\\1a${alpha(op)}` +
      `\\bord${n1(L.px * bord)}\\3c&H0A0908&\\3a${alpha(op)}\\blur${n1(L.px * blur)}` +
      `\\pos(${n1(L.x)},${n1(L.y + L.px * dy)})}${plain}`)
    // Dark words (on a light ground) take no dark glow, which only muddies them, and
    // a fainter drop: the look turns captions ink on paper-light backgrounds
    if (!inkText) { shade(g.wide, 0.34, 0.75, 0.06); shade(g.near, 0.1, 0.24, 0.04) }
    evs.add(1, a, b, `{${base}${sfad}\\1c&H000000&\\1a&H${inkText ? 'D8' : '60'}&\\blur${n1(L.px * 0.07)}` +
      `\\pos(${n1(L.x)},${n1(L.y + L.px * 0.05)})}${plain}`)
    // The crisp words, one event per stretch of speech so the spoken word can differ
    const cuts = [a, b]
    for (const w of p.words) cuts.push(w.start, w.end)
    const edges = [...new Set(cuts.map(cs))].filter(c => c >= cs(a) && c <= cs(b)).sort((x, y) => x - y)
    const k1 = a + IN, k2 = b - fadeOut           // where the fade in ends and the fade out starts
    const op = t => Math.max(0, Math.min(1, (t - a) / IN, (b - t) / fadeOut))
    for (let i = 0; i + 1 < edges.length; i++) {
      const A = edges[i], B = edges[i + 1], mid = (A + B) / 200
      const active = hl ? p.words.findIndex(w => mid >= w.start && mid < w.end) : -1
      const tintOf = hl === 'pill' ? colour(INK) : colour(GOLD)
      const line = lines.map(l => l.map(w => p.words.indexOf(w) === active
        ? `{\\1c${tintOf}}${esc(w.text)}{\\1c${fill}}` : esc(w.text)).join(' ')).join('\\N')
      // One fade across all the slices: this slice's share of it, as \fade knots
      const t0 = A / 100, t1 = B / 100, d = (B - A) * 10
      const a0 = Math.round(255 * (1 - op(t0))), a1 = Math.round(255 * (1 - op(t1)))
      // Knots where the fade in ends and the fade out starts, clamped to the slice, so a
      // slice shorter than the fade (the first 60 ms before a word) ends where the next
      // one begins instead of flashing fully opaque.
      let fade = ''
      if (a0 || a1) {
        const u = Math.round(Math.max(0, Math.min(d, (k1 - t0) * 1000)))
        const v = Math.round(Math.max(u, Math.min(d, (k2 - t0) * 1000)))
        const am = Math.round(255 * (1 - op(t0 + u / 1000)))
        fade = `\\fade(${a0},${am},${a1},0,${u},${v},${d})`
      }
      if (hl === 'pill' && active >= 0) {
        evs.addCs(2, A, B, `{\\an7\\pos(0,0)\\p1\\bord0\\shad0\\1c${colour(GOLD)}\\1a&H10&${fade}}` +
          `${pillFor(p, lines, active, L, lineH, measure)}{\\p0}`)
      }
      evs.addCs(3, A, B, `{${base}\\1c${fill}${fade}}${line}`)
    }
  }
}

// A soft pill behind the spoken word, placed by measuring the line it sits in
function pillFor(p, lines, active, L, lineH, measure) {
  let li = 0, k = 0
  for (; li < lines.length; li++) { if (active < k + lines[li].length) break; k += lines[li].length }
  const line = lines[li], w = p.words[active]
  const text = line.map(x => x.text).join(' ')
  const before = line.slice(0, line.indexOf(w)).map(x => x.text + ' ').join('')
  const lw = measure(text, L.px, 'caption'), bx = measure(before, L.px, 'caption'), ww = measure(w.text, L.px, 'caption')
  const n = lines.length
  const top = L.an === 2 ? L.y - n * lineH : L.an === 8 ? L.y : L.y - (n * lineH) / 2
  const x0 = L.x - lw / 2 + bx, y0 = top + li * lineH
  const padX = L.px * 0.16, padY = L.px * 0.02
  return roundRect(x0 - padX, y0 + padY, ww + padX * 2, lineH - padY * 2, (lineH - padY * 2) / 2)
}

/**
 * A frosted patch under each caption: the frame itself, blurred, behind the words, so
 * a caption over a dense table reads as text on glass rather than text on text. libass
 * cannot blur what is under it, so this is a mask for processor.js to blur the frame
 * through: white where the frost is, feathered to nothing, fading with its caption.
 * Returns { script, y, h, bands }: a W x h script for the band of the frame the frost
 * can touch, starting y pixels down (both even), or null when there are no captions.
 * Captions moved to the top (placeCaptions) get a band of their own in bands, so the
 * blur never has to cover the whole frame between the two.
 */
function captionFrost({ W, H, phrases, capStyle, measure = estimate, box = null }) {
  if (!phrases || !phrases.length) return null
  const st = capStyle || {}
  const groups = {}
  for (const p of phraseTimes(phrases)) {
    const L = fitLayout(p, W, H, st, box, measure)
    if (L.band) continue           // on the backdrop already: there is no UI to frost
    const lineH = Math.round(L.px * 1.18)
    const key = p.at === 'top' && st.fx == null ? 'top' : 'main'
    ;(groups[key] = groups[key] || []).push({ p, L, r: blockRect(L, captionBlock(p, L, lineH, measure), FROST_PAD[0], FROST_PAD[1]) })
  }
  const bands = []
  for (const key of ['main', 'top']) {
    const rects = groups[key]
    if (!rects) continue
    const feather = rects[0].L.px * FROST_FEATHER
    const y0 = Math.min(...rects.map(({ r }) => r.y - feather * 2.5)), y1 = Math.max(...rects.map(({ r }) => r.y + r.h + feather * 2.5))
    const y = Math.max(0, 2 * Math.floor(y0 / 2)), h = Math.min(H, 2 * Math.ceil(y1 / 2)) - y
    if (!(h >= 2)) continue
    // drawn in the band's own coordinates, so the mask is only as big as the band
    const evs = events()
    rects.forEach(({ p, L, r }, i) => {
      // Straight on to the next phrase, the glass stays until the next one's has faded
      // in over it and only then fades: each fading on its own let the sharp UI show
      // through for a few frames at every phrase change, a flicker on a light screen.
      const next = rects[i + 1]
      const on = next && next.p.show - p.hide < FROST_JOIN
      const b = on ? next.p.show + CAP_IN + CAP_OUT : p.hide
      const fad = on ? `\\fad(${Math.round(CAP_IN * 1000)},${Math.round(CAP_OUT * 1000)})` : capFade(p)
      evs.add(0, p.show, b, `{\\an7\\pos(0,0)\\p1\\bord0\\shad0${fad}\\1c&HFFFFFF&\\1a&H00&\\blur${n1(feather)}}` +
        `${roundRect(r.x, r.y - y, r.w, r.h, L.px * 0.6)}{\\p0}`)
    })
    bands.push({ script: script(W, h, evs), y, h })
  }
  return bands.length ? { ...bands[0], bands } : null
}

// ── keeping captions off the product's own text ─────────────────────────────
// Where the captions sit, as fractions of the picture on screen: across the middle
// of the bottom, where a two-line caption reaches, and a band across the middle of
// the frame to tell a local change from a scroll or a new page.
const CAP_ZONE = { x0: 0.2, x1: 0.8, y0: 0.78, y1: 0.98 }
const REST_ZONE = { x0: 0, x1: 1, y0: 0.12, y1: 0.66 }

// Mean and spread of a zone of a w x h grey frame, and the frame's pixels in it
function zoneOf(px, w, h, v, z) {
  const X0 = Math.floor((v.x + v.w * z.x0) * w), X1 = Math.ceil((v.x + v.w * z.x1) * w)
  const Y0 = Math.floor((v.y + v.h * z.y0) * h), Y1 = Math.ceil((v.y + v.h * z.y1) * h)
  const idx = []
  for (let y = Math.max(0, Y0); y < Math.min(h, Y1); y++) for (let x = Math.max(0, X0); x < Math.min(w, X1); x++) idx.push(y * w + x)
  let s = 0, s2 = 0
  for (const i of idx) { s += px[i]; s2 += px[i] * px[i] }
  const n = idx.length || 1, mean = s / n
  return { idx, spread: Math.sqrt(Math.max(0, s2 / n - mean * mean)) }
}
const zoneDiff = (a, b, idx) => { let d = 0; for (const i of idx) d += Math.abs(a[i] - b[i]); return d / (idx.length || 1) }

/**
 * When the product itself put something where the captions go: a toast, a snackbar,
 * a bottom sheet. Those arrive on their own, so they show as a change in the caption
 * zone while the middle of the frame holds still (a scroll or a new page changes
 * both), and they add contrast rather than take it away (so the frames after the
 * toast leaves are not flagged). frames are low-res grey frames of the recorded
 * picture, [{ t, px }] with px w x h bytes, t on the output clock; view(t) is the
 * part of the frame on screen then ({x, y, w, h} fractions, a zoom's window), or
 * null while the camera is moving. Returns the times of the flagged frames.
 */
function captionClutter(frames, w, h, view = () => ({ x: 0, y: 0, w: 1, h: 1 }), o = {}) {
  const reach = o.reach || 3, minDiff = o.minDiff || 7, minGain = o.minGain || 4
  const out = []
  for (let k = 0; k < frames.length; k++) {
    const f = frames[k], v = view(f.t)
    if (!v) continue
    const cap = zoneOf(f.px, w, h, v, CAP_ZONE), rest = zoneOf(f.px, w, h, v, REST_ZONE)
    for (let j = 0; j < frames.length; j++) {
      const g = frames[j]
      if (j === k || Math.abs(g.t - f.t) > reach) continue
      const vg = view(g.t)
      // only frames seen through the same window compare pixel for pixel
      if (!vg || Math.abs(vg.x - v.x) + Math.abs(vg.y - v.y) + Math.abs(vg.w - v.w) > 0.01) continue
      const dCap = zoneDiff(f.px, g.px, cap.idx), dRest = zoneDiff(f.px, g.px, rest.idx)
      if (dCap < minDiff || dRest > Math.max(2.5, dCap * 0.2)) continue
      if (cap.spread - zoneOf(g.px, w, h, v, CAP_ZONE).spread < minGain) continue
      out.push(f.t)
      break
    }
  }
  return out
}

/**
 * Phrases on screen while the caption zone is taken move to the top of the frame, so
 * a caption never lands on the product's own text. Phrases in a short stretch between
 * two that moved go with them, so the captions make one move up and one back down
 * rather than hopping. Not a phrase spoken inside a zoom, though (framed, [{ a, b }]
 * on the output clock): a zoom frames what the narration is about, often up at the
 * top, and the toast it hides is off screen, so there the bottom is free and a caption
 * carried up would frost over the very thing the zoom is showing. The captions follow
 * the camera down and back up, which reads as part of the move.
 */
function placeCaptions(phrases, cluttered, framed = []) {
  const times = (cluttered || []).slice().sort((a, b) => a - b)
  const shown = phraseTimes(phrases || [])
  const top = shown.map(p => times.some(t => t >= p.show - 0.25 && t <= p.hide + 0.1))
  const zoomed = p => (framed || []).some(z => Math.min(p.hide, z.b) - Math.max(p.show, z.a) > (p.hide - p.show) * 0.5)
  for (let i = 0, last = -1; i < top.length; i++) {
    if (!top[i]) continue
    if (last >= 0 && i - last > 1 && shown[i].show - shown[last].hide < 4.5) {
      for (let k = last + 1; k < i; k++) if (!zoomed(shown[k])) top[k] = true
    }
    last = i
  }
  return (phrases || []).map((p, i) => (top[i] ? { ...p, at: 'top' } : p))
}

// ── titles and labels ───────────────────────────────────────────────────────
// A title is a sentence split into a headline and a quieter line under it
function titleParts(t) {
  const raw = String(t.text || '').trim()
  if (t.subtitle) return { title: raw, subtitle: String(t.subtitle).trim() }
  const m = raw.split(/\s*\n\s*/)
  if (m.length > 1) return { title: m[0], subtitle: m.slice(1).join(' ') }
  const sep = raw.split(/\s+[·|\u2022\u2014\u2013-]\s+/)
  if (sep.length > 1) {
    const sub = sep.slice(1).join(' ')
    return { title: sep[0], subtitle: sub.charAt(0).toUpperCase() + sub.slice(1) }
  }
  return { title: raw, subtitle: '' }
}

// What a text layer is for. An explicit style wins. Without one, a centred text that
// opens or closes the video is its title card, and anything else is a label, so a
// document written before styles existed still exports as an edit.
function textStyle(t, span) {
  if (t.style === 'title' || t.style === 'lower-third' || t.style === 'label') return t.style
  const timed = t.start != null && t.end != null && t.end > t.start
  const centred = Math.abs((t.fx != null ? +t.fx : 0.5) - 0.5) <= 0.12
  // a card hides the video, so only a short one at either end is read as a title
  const short = timed && t.end - t.start <= Math.min(8, span * 0.4)
  if (short && centred && span > 0 && String(t.text || '').length <= 80 &&
      (t.start <= 1.0 || t.end >= span - 1.0)) return 'title'
  return 'label'
}

/**
 * Title cards in the output: when each one shows and whether it opens or closes the
 * video. The exporter draws the blurred, dimmed frame behind these, and the framed
 * video rises into place as an opening card clears.
 */
function titleCards(texts, span) {
  const cards = []
  for (const t of texts || []) {
    if (!t || !String(t.text || '').trim() || textStyle(t, span) !== 'title') continue
    const a = Math.max(0, +t.start || 0)
    let b = Math.min(span || Infinity, t.end != null ? +t.end : span)
    if (!(b > a + 0.3)) continue
    const opens = a <= 1.0
    // a closing card that stops just short of the end holds to it, rather than
    // clearing for a few frames of video before the end
    if (!opens && span && b >= span - 0.5) b = span
    cards.push({ t, a: opens ? 0 : a, b, text: a, opens, fade: Math.min(0.6, (b - a) / 3) })
  }
  // A closing card that is only an address signs off under the product's name from
  // the opening card, so it has the same two levels rather than one line of URL
  const open = cards.find(k => k.opens)
  const name = open && titleParts(open.t).title
  for (const k of cards) {
    const { subtitle } = titleParts(k.t)
    if (k.opens || !name || subtitle || !URLISH.test(String(k.t.text).trim())) continue
    k.t = { ...k.t, text: name, subtitle: String(k.t.text).trim(), url: true, sizeFrac: open.t.sizeFrac }
  }
  return cards
}
const URLISH = /^(https?:\/\/)?[\w-]+(\.[\w-]+)+(\/\S*)?$/i

// How long an opening card takes to hand over: its ground clears, the title is still
// leaving and the framed video scales in, all at once, ending as the card does
const cardLanding = card => Math.min(0.55, card.b * 0.3)

// Captions wait for an opening card to hand over: the voice often starts on the card,
// and "This is Songscription," under a large "Songscription" names the product twice.
// A phrase that starts under the card shows from the handover (its early words already
// spoken, the highlight on the word being said); one that ends before it is dropped.
function clearOfTitles(phrases, cards) {
  const open = (cards || []).find(k => k.opens)
  if (!open || !phrases) return phrases
  const from = open.b - cardLanding(open)
  return phrases.filter(p => p.end + 0.35 - Math.max(p.start, from) >= 0.6)
    .map(p => (p.start < from ? { ...p, from } : p))
}

// A title card set like a product film's: a large semibold name tracked in a little,
// a quieter line under it, each rising a few pixels out of a blur on the entering
// curve, the second a beat after the first. An address signing off is the one thing
// on a card to act on, so it is a gold pill with an arrow rather than body text.
const TITLE_SIZE = 0.1          // of the frame's height: 108 px at 1080
function titleEvents(evs, card, W, H, measure = estimate) {
  const { t } = card
  const { title, subtitle } = titleParts(t)
  const url = !!subtitle && (!!t.url || URLISH.test(subtitle))
  let px = Math.round(H * Math.max(0.06, Math.min(0.12, +t.sizeFrac || TITLE_SIZE)))
  // never wider than most of the frame
  const tw = measure(title, px, 'title') * 0.98
  if (tw > W * 0.84) px = Math.floor(px * (W * 0.84) / tw)
  const u = H / 1080
  // the line under it about a third of the name's size (36 px at 1080), so the step
  // down reads as hierarchy rather than as a caption lost under a headline
  const sp = Math.round(Math.max(H * 0.0335, px * 0.34))
  const gap = Math.round((url ? 24 : 18) * u)
  const pillFs = Math.round(30 * u), pillH = Math.round(pillFs * 2)
  const subText = url ? `${subtitle}  →` : subtitle
  const pillW = url ? Math.round(measure(subText, pillFs, 'sub') + pillH * 0.95) : 0
  const subH = !subtitle ? 0 : url ? pillH : Math.round(sp * 1.2)
  const lineT = Math.round(px * 1.05)
  const blockH = lineT + (subtitle ? gap + subH : 0)
  const cx = W * (t.fx != null ? +t.fx : 0.5)
  const cy = H * (t.fy != null && +t.fy !== 0.5 ? +t.fy : 0.47)
  const top = cy - blockH / 2
  const ty = top + lineT / 2
  const sy = top + lineT + gap + subH / 2
  const fillT = colour(t.color && t.color !== 'white' ? t.color : WHITE)

  const IN = 0.5, OUT = 0.36, stagger = 0.12
  const rise = 16 * u, blurIn = 8 * u
  // a closing title waits for most of its ground, so it never sits on readable UI
  const inAt = card.opens ? Math.max(0.2, card.text) : card.a + card.fade
  // an opening one starts to leave just before the product scales in, so the two
  // moves overlap into one handover instead of leaving a beat of empty ground
  const outAt = card.opens ? card.b - cardLanding(card) - 0.32
    : (card.b < (card.span || Infinity) - 0.05 ? card.b - OUT : null)
  // layers is a list of (op, dy, blur) => text, drawn together as one piece
  const piece = (layer, draws, delay) => {
    const at = inAt + delay
    const end = outAt != null ? Math.max(at + IN, outAt + delay * 0.5) : card.b
    draws.forEach((draw, i) => {
      evs.bake(layer + i, at, IN, p => { const e = EASE_IN(p); return draw(Math.min(1, e * 1.2), rise * (1 - e), blurIn * (1 - e)) }, end)
      if (outAt != null) evs.bake(layer + i, end, OUT, p => { const e = EASE_OUT(p); return draw(1 - e, -rise * 0.4 * e, blurIn * 0.75 * e) })
    })
  }
  const text = (x, y, size, font, extra) => (op, dy, blur) =>
    `{\\an5\\pos(${n1(x)},${n1(y + dy)})\\fn${font}\\fs${size}\\bord0\\shad0${extra(op)}\\blur${n1(blur)}}`
  // the name, over a soft shadow of itself so it holds on a light blurred ground
  const tsp = `\\fsp${n1(px * -0.02)}`
  piece(4, [
    (op, dy, blur) => text(cx, ty + px * 0.03, px, FONT.title, o => `${tsp}\\1c&H0A0908&\\1a${alpha(o * 0.34)}`)(op, dy, blur + px * 0.2) + esc(title),
    (op, dy, blur) => text(cx, ty, px, FONT.title, o => `${tsp}\\1c${fillT}\\1a${alpha(o)}`)(op, dy, blur) + esc(title),
  ], 0)
  if (!subtitle) return
  if (url) {
    piece(6, [
      (op, dy, blur) => `{\\an7\\pos(${n1(cx - pillW / 2)},${n1(sy - pillH / 2 + dy + 4 * u)})\\p1\\bord0\\shad0\\1c&H000000&` +
        `\\1a${alpha(op * 0.3)}\\blur${n1(blur + 10 * u)}}${roundRect(0, 0, pillW, pillH, pillH / 2)}{\\p0}`,
      (op, dy, blur) => `{\\an7\\pos(${n1(cx - pillW / 2)},${n1(sy - pillH / 2 + dy)})\\p1\\bord0\\shad0\\1c${colour(GOLD)}` +
        `\\1a${alpha(op)}\\blur${n1(Math.max(0.6, blur))}}${roundRect(0, 0, pillW, pillH, pillH / 2)}{\\p0}`,
      (op, dy, blur) => text(cx, sy, pillFs, FONT.title, o => `\\fsp${n1(pillFs * -0.005)}\\1c${colour(INK)}\\1a${alpha(o)}`)(op, dy, blur) + esc(subText),
    ], stagger)
    return
  }
  // quieter by colour and size, not by weight alone: 70 percent white, tracked out a hair
  piece(6, [
    (op, dy, blur) => text(cx, sy, sp, FONT.sub, o => `\\fsp${n1(sp * 0.01)}\\1c${fillT}\\1a${alpha(o * 0.7)}`)(op, dy, blur) + esc(subtitle),
  ], stagger)
}

// A label is a short line of text over the video; a lower third names what is on
// screen from the bottom left, with a gold rule.
function labelEvents(evs, t, style, W, H, span, measure = estimate) {
  const a = t.start != null ? Math.max(0, +t.start) : 0
  const b = t.end != null && t.end > t.start ? Math.min(+t.end, span || Infinity) : (span || a + 3600)
  if (!(b > a + 0.1)) return
  const IN = Math.min(0.32, (b - a) / 3), OUT = Math.min(0.24, (b - a) / 4)
  const fill = colour(t.color && t.color !== 'white' ? t.color : '#FFFFFF')
  if (style === 'lower-third') {
    const { title, subtitle } = titleParts(t)
    const px = Math.round(H * Math.max(0.03, Math.min(0.07, +t.sizeFrac || 0.044)))
    const sp = Math.round(px * 0.62)
    const x = W * (t.fx != null && t.fx !== 0.5 ? +t.fx : 0.07), y = H * (t.fy != null && t.fy !== 0.5 ? +t.fy : 0.8)
    const barH = px * 1.05 + (subtitle ? sp * 1.3 : 0)
    const draw = (op, dx) => [
      `{\\an7\\pos(${n1(x + dx - px * 0.45)},${n1(y - px * 0.1)})\\p1\\bord0\\shad0\\1c${colour(GOLD)}\\1a${alpha(op)}}` +
        `${roundRect(0, 0, Math.max(3, px * 0.09), barH, px * 0.045)}{\\p0}`,
      `{\\an7\\pos(${n1(x + dx)},${n1(y - px * 0.16)})\\fn${FONT.title}\\fs${px}\\fsp${n1(px * -0.015)}\\bord${n1(px * 0.3)}` +
        `\\3c&H0A0908&\\3a${alpha(op * 0.45)}\\blur${n1(px * 0.45)}\\shad0\\1c${fill}\\1a${alpha(op)}}${esc(title)}` +
        (subtitle ? `\\N{\\fn${FONT.sub}\\fs${sp}\\fsp0\\1a${alpha(op * 0.8)}}${esc(subtitle)}` : ''),
    ]
    for (let i = 0; i < 2; i++) {
      evs.bake(10 + i, a, IN, p => draw(EASE_IN(p), -px * 0.4 * (1 - EASE_IN(p)))[i], b - OUT)
      evs.bake(10 + i, b - OUT, OUT, p => draw(1 - EASE_OUT(p), 0)[i])
    }
    return
  }
  const px = Math.max(12, Math.round(H * Math.max(0.02, Math.min(0.16, +t.sizeFrac || 0.05))))
  const an = t.align === 'left' ? 4 : t.align === 'right' ? 6 : 5
  // a label typed on two lines (the editor's box is a textarea) keeps them
  const rows = String(t.text).split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  const text = rows.map(esc).join('\\N')
  const w = Math.max(...rows.map(r => measure(r, px, t.family || 'caption')))
  // kept whole inside the frame, pill and all, wherever it was dropped
  const m = W * 0.03 + (t.box ? px * 0.55 : 0)
  const lo = an === 4 ? m : an === 6 ? m + w : m + w / 2, hi = an === 4 ? W - m - w : an === 6 ? W - m : W - m - w / 2
  const x = Math.min(Math.max(lo, W * (t.fx != null ? +t.fx : 0.5)), Math.max(lo, hi))
  const half = px * (0.5 + rows.length / 2)          // half the pill, one line tall per row
  const y = Math.min(Math.max(half, H * (t.fy != null ? +t.fy : 0.5)), H - half)
  const draw = (op, dy) => {
    const pos = `\\an${an}\\pos(${n1(x)},${n1(y + dy)})`
    const words = `{${pos}\\fn${t.family || FONT.caption}\\fs${px}\\fsp${n1(px * -0.01)}\\bord0\\shad0\\1c${fill}\\1a${alpha(op)}}${text}`
    if (t.box) {
      const padX = px * 0.55, h = half * 2
      const left = an === 4 ? x - padX : an === 6 ? x - w - padX : x - w / 2 - padX
      const pill = `{\\an7\\pos(${n1(left)},${n1(y + dy - h / 2)})\\p1\\bord0\\shad0\\1c&H0F1114&\\1a${alpha(op * 0.74)}}` +
        `${roundRect(0, 0, w + padX * 2, h, h / 2)}{\\p0}`
      return [pill, words]
    }
    const bloom = `{${pos}\\fn${t.family || FONT.caption}\\fs${px}\\fsp${n1(px * -0.01)}\\1c&H000000&\\1a${alpha(op * 0.33)}` +
      `\\bord${n1(px * 0.3)}\\3c&H000000&\\3a${alpha(op * 0.2)}\\blur${n1(px * 0.4)}\\shad0}${text}`
    return [bloom, words]
  }
  for (let i = 0; i < 2; i++) {
    evs.bake(8 + i, a, IN, p => draw(EASE_IN(p), px * 0.25 * (1 - EASE_IN(p)))[i], b - OUT)
    evs.bake(8 + i, b - OUT, OUT, p => draw(1 - EASE_OUT(p), 0)[i])
  }
}

// ── content space: steps and spotlights ─────────────────────────────────────
// A numbered step is a gold disc with a thin white ring, centred on the point it
// numbers (the corner of a card, the edge of a button), so it marks the thing
// without covering its label. It lands with a small overshoot and fades away.
// A step with no number of its own counts in order among the steps, as it did before
// badges were drawn here; every step reading "1" numbers nothing.
const stepLabel = (m, k) => String(m.n != null && m.n !== '' ? m.n : k).replace(/[^0-9A-Za-z]/g, '').slice(0, 3) || String(k)

// A badge's diameter on an H tall picture, and the ring round it. With out, finished
// pixels per pixel here through the zoom it is seen in, it is sized for the finished
// frame (60 px at 1080): sized to the recording, a 2x zoom drew it twice as large,
// over the labels and across the gutter to the next card.
const stepSize = (H, out = 0) => {
  const D = out > 0 ? Math.max(12, Math.round(60 / out)) : Math.max(26, Math.round(H * 0.046))
  return { D, ring: Math.max(out > 0 ? 1.8 / out : 1.5, D * 0.05) }
}

function stepEvents(evs, m, W, H) {
  const a = m.start, b = m.end
  if (!(b > a + 0.1)) return
  const { D, ring } = stepSize(H, m.out)
  const R = D / 2
  const edge = R + D * 0.2
  // On a card's corner found in the picture (stepCorner) the badge sits a little up and
  // out from it, the same on every card, so it holds the corner and clears the label
  const ox = m.corner ? -D * 0.18 : 0, oy = m.corner ? -D * 0.18 : 0
  const cx = Math.min(W - edge, Math.max(edge, (+m.x || 0) * W + ox))
  const cy = Math.min(H - edge, Math.max(edge, (+m.y || 0) * H + oy))
  const n = String(m.n != null ? m.n : '').replace(/[^0-9A-Za-z]/g, '').slice(0, 3) || '1'
  const IN = Math.min(0.34, (b - a) / 3), OUT = Math.min(0.22, (b - a) / 4)
  const fs = Math.round(D * (n.length > 1 ? 0.46 : 0.56))
  const draw = (s, op) => {
    const sc = `\\fscx${n1(s * 100)}\\fscy${n1(s * 100)}`
    return [
      `{\\an5\\pos(${n1(cx)},${n1(cy + D * 0.07)})${sc}\\p1\\bord0\\shad0\\1c&H000000&\\1a${alpha(op * 0.36)}\\blur${n1(D * 0.16)}}${circle(R + ring)}{\\p0}`,
      `{\\an5\\pos(${n1(cx)},${n1(cy)})${sc}\\p1\\bord${n1(ring)}\\3c${colour('#FFFFFF')}\\3a${alpha(op)}\\shad0` +
        `\\1c${colour(GOLD)}\\1a${alpha(op)}}${circle(R)}{\\p0}`,
      `{\\an5\\pos(${n1(cx)},${n1(cy + D * 0.01)})${sc}\\fn${FONT.num}\\fs${fs}\\bord0\\shad0\\1c${colour(INK)}\\1a${alpha(op)}}${n}`,
    ]
  }
  for (let i = 0; i < 3; i++) {
    evs.bake(20 + i, a, IN, p => draw(0.35 + 0.65 * POP(p), Math.min(1, p * 2.2))[i], b - OUT)
    evs.bake(20 + i, b - OUT, OUT, p => { const e = EASE_OUT(p); return draw(1 - 0.18 * e, 1 - e)[i] })
  }
}

/**
 * Where a step badge sits so it does not crowd its neighbours. An agent names a card's
 * corner from a screenshot, and between a row of buttons and a grid of cards the gap is
 * narrower than the badge: centred on the point it covered the edge of the next button.
 * The badge may slide up to three quarters of its radius (the point stays under it) to
 * where it covers the least of the picture's edges and text, the corner itself not
 * counted since that is what it marks. px is a w x h grey frame of the picture the
 * step is drawn on, H that picture's height. Returns { x, y } fractions, the mark's
 * own unless moving clearly helps.
 */
function stepSpot(px, w, h, m, H) {
  const { D, ring } = stepSize(H)
  const R = (D / 2 + ring) * (h / H), cx = (+m.x || 0) * w, cy = (+m.y || 0) * h
  const keep = { x: +m.x || 0, y: +m.y || 0 }
  if (!(R >= 3) || !px || px.length < w * h) return keep
  const reach = R * 1.12, core = R * 0.45
  // a little contrast is anti-aliasing and gradients, not an edge
  const ink = (x, y) => {
    if (x < 0 || y < 0 || x >= w - 1 || y >= h - 1) return 0
    const i = y * w + x, v = px[i], d = Math.max(Math.abs(v - px[i + 1]), Math.abs(v - px[i + w]))
    return d < 6 ? 0 : d
  }
  const cover = (ox, oy) => {
    let s = 0
    for (let y = Math.floor(oy - reach); y <= Math.ceil(oy + reach); y++) {
      for (let x = Math.floor(ox - reach); x <= Math.ceil(ox + reach); x++) {
        if ((x - ox) ** 2 + (y - oy) ** 2 > reach * reach || (x - cx) ** 2 + (y - cy) ** 2 <= core * core) continue
        s += ink(x, y)
      }
    }
    return s
  }
  // each step away costs as much as covering a faint line across the badge, so it
  // only moves for something real
  const toll = Math.PI * reach * reach
  const c0 = cover(cx, cy)
  let best = { c: c0, dx: 0, dy: 0 }
  for (let dy = -0.75; dy <= 0.751; dy += 0.1) {
    for (let dx = -0.75; dx <= 0.751; dx += 0.1) {
      const d = Math.hypot(dx, dy)
      if (d > 0.751 || d < 0.01) continue
      const c = cover(cx + dx * R, cy + dy * R) + toll * d * d
      if (c < best.c) best = { c, dx, dy }
    }
  }
  if (!(best.c < c0 * 0.85)) return keep
  // the frame edges clamp later (stepEvents), so only the nudge is returned here
  return { x: (cx + best.dx * R) / w, y: (cy + best.dy * R) / h }
}

/**
 * The card corner a step names, found in the picture: an agent reads a corner off a
 * screenshot a few pixels out, sometimes in the gutter between two cards, and badges
 * placed where it said sat at different heights and over the neighbour's corner. Looks
 * within a badge's width of the point for the top-left corner of a box: an edge running
 * down from it and one running right, both straight for more than a badge's length
 * past the corner's rounding. px is a w x h grey frame, H the picture's height the step
 * is drawn on. Returns { x, y } fractions of the corner, or null when none reads.
 */
function stepCorner(px, w, h, m, H) {
  const { D } = stepSize(H)
  const d = D * (h / H)
  if (!px || px.length < w * h || !(d >= 6)) return null
  const x0 = (+m.x || 0) * w, y0 = (+m.y || 0) * h
  // Within a third of a badge: layouts align things, and a wider look found the card's
  // left side meeting the bottom of a button above it as a stronger corner
  const reach = Math.round(d * 0.35), skip = Math.round(d * 0.45), len = Math.round(d * 1.5)
  const at = (x, y) => px[y * w + x]
  // How surely a straight edge runs from (x, y) along one axis: the median step across
  // it, signed. A card's hairline steps the same way at every pixel of its length; text
  // steps hard but here and there, and both ways, so its median is nothing.
  const step = new Array(len)
  const med = () => { step.sort((a, b) => a - b); return Math.abs(step[len >> 1]) }
  const down = (x, y) => { for (let j = 0; j < len; j++) step[j] = at(x, y + skip + j) - at(x - 1, y + skip + j); return med() }
  const right = (x, y) => { for (let i = 0; i < len; i++) step[i] = at(x + skip + i, y) - at(x + skip + i, y - 1); return med() }
  let best = null
  for (let y = Math.max(1, Math.round(y0 - reach)); y <= Math.min(h - skip - len - 1, Math.round(y0 + reach)); y++) {
    for (let x = Math.max(1, Math.round(x0 - reach)); x <= Math.min(w - skip - len - 1, Math.round(x0 + reach)); x++) {
      // both edges, so the weaker decides: a lone line of text or a divider is not a
      // corner. Past a clear hairline, strength is no reason to go further from the point
      const s = Math.min(8, down(x, y), right(x, y)) - 2 * Math.hypot(x - x0, y - y0) / reach
      if (!best || s > best.s) best = { s, x, y }
    }
  }
  // a hairline on a light page steps by a couple of levels; less than that is noise
  if (!best || best.s < 2) return null
  return { x: best.x / w, y: best.y / h }
}

/**
 * Steps on one grid of cards share their rows and columns: corners within half a badge
 * of each other take one x (or one y), so 1 and 2 sit on a line and 3 sits under 1.
 * list is steps in fractions of a W x H picture; returns the list re-placed.
 */
function stepGrid(list, W, H) {
  const { D } = stepSize(H)
  const out = list.map(m => ({ ...m }))
  for (const [key, size] of [['x', W], ['y', H]]) {
    const done = new Set()
    for (const m of out) {
      if (done.has(m)) continue
      const near = out.filter(o => !done.has(o) && Math.abs(o[key] - m[key]) * size <= D / 2)
      const mean = near.reduce((a, o) => a + o[key], 0) / near.length
      for (const o of near) { o[key] = mean; done.add(o) }
    }
  }
  return out
}

/**
 * A spotlight's window pulled in to the thing it lights. An agent draws the rectangle
 * from a screenshot with room to spare, and on a light UI that spare page stays lit
 * as a pale ring round the target, which reads as a glow rather than a cutout. The
 * rectangle's own edge is taken as the ground; when it is even (the rectangle sits on
 * plain page, not across other content), the window becomes the box of everything
 * inside that differs from it, when that is one solid thing. px is a w x h grey
 * frame, m the mark in fractions.
 * Returns { x, y, w, h } fractions, the mark's own unless pulling in clearly helps.
 */
function spotFit(px, w, h, m) {
  const keep = { x: +m.x || 0, y: +m.y || 0, w: +m.w || 0.2, h: +m.h || 0.1 }
  if (!px || px.length < w * h) return keep
  const X0 = Math.max(0, Math.round(keep.x * w)), Y0 = Math.max(0, Math.round(keep.y * h))
  const X1 = Math.min(w - 1, Math.round((keep.x + keep.w) * w)), Y1 = Math.min(h - 1, Math.round((keep.y + keep.h) * h))
  if (X1 - X0 < 8 || Y1 - Y0 < 6) return keep
  const ring = []
  for (let x = X0; x <= X1; x++) ring.push(px[Y0 * w + x], px[Y1 * w + x], px[(Y0 + 1) * w + x], px[(Y1 - 1) * w + x])
  for (let y = Y0; y <= Y1; y++) ring.push(px[y * w + X0], px[y * w + X1], px[y * w + X0 + 1], px[y * w + X1 - 1])
  ring.sort((a, b) => a - b)
  const bg = ring[ring.length >> 1]
  // the edge crosses other content: nothing to pull in to
  const off = ring.filter(v => Math.abs(v - bg) > 14).length
  if (off > ring.length * 0.08) return keep
  // rows and columns holding more than a speck of something that is not the ground
  const rows = new Array(Y1 - Y0 + 1).fill(0), cols = new Array(X1 - X0 + 1).fill(0)
  for (let y = Y0 + 2; y <= Y1 - 2; y++) for (let x = X0 + 2; x <= X1 - 2; x++) {
    if (Math.abs(px[y * w + x] - bg) > 14) { rows[y - Y0]++; cols[x - X0]++ }
  }
  const first = (a, n) => a.findIndex(v => v >= n), lastOf = (a, n) => a.length - 1 - a.slice().reverse().findIndex(v => v >= n)
  const r0 = first(rows, 2), c0 = first(cols, 2)
  if (r0 < 0 || c0 < 0) return keep
  const r1 = lastOf(rows, 2), c1 = lastOf(cols, 2)
  // Only a solid thing (a toast, a filled button) has its own edge to pull in to. Text
  // and cards on a near-white page are mostly ground: their box is the text, and
  // pulling in to it cut the cards' own light edges off.
  let solid = 0
  for (let y = Y0 + r0; y <= Y0 + r1; y++) for (let x = X0 + c0; x <= X0 + c1; x++) if (Math.abs(px[y * w + x] - bg) > 14) solid++
  if (solid < (r1 - r0 + 1) * (c1 - c0 + 1) * 0.5) return keep
  const fit = { x: (X0 + c0 - 1) / w, y: (Y0 + r0 - 1) / h, w: (c1 - c0 + 3) / w, h: (r1 - r0 + 3) / h }
  // only a clear pull in, never out, and never to a sliver of what was asked
  const gain = 1 - (fit.w * fit.h) / (keep.w * keep.h)
  if (gain < 0.06 || fit.w < keep.w * 0.4 || fit.h < keep.h * 0.4) return keep
  return fit
}

// A spotlight steps everything else back: a soft-edged, round-cornered window at
// full brightness in a frame dimmed to about half. It eases in and out on the same
// curve as a zoom, and when a zoom starts or ends close by, it moves with that zoom
// so the two read as a single move rather than a dim that lands on its own.
const SPOT_DIM = 0.46
// How far a spotlight edge reaches for a zoom's. Outside the spotlight a zoom just
// beside it is the same beat. Inside it, a zoom that starts a few seconds after the
// dim (or ends a few before the light returns) is the move the dim was waiting for:
// dimming, holding still, then zooming reads as two edits, so the dim waits for the
// zoom. Further in than that, the spotlight is its own beat and keeps its time.
const SPOT_SNAP = 1.2, SPOT_RIDE = 3
// A spotlight that ends just as a zoom elsewhere begins (or starts just as one ends) is
// a hand-off: lifting the dim, a beat of nothing, then a push reads as a hitch. Within
// this gap the dim lifts during the push (or lands during the pull) instead.
const SPOT_HAND = 0.6
/**
 * When a spotlight actually dims, given the zooms: { a, b, Ta, Tb }, Ta and Tb the
 * zoom's push and pull when an edge rides one (null otherwise). Shared with the
 * editor preview so both agree.
 */
function spotlightSpan(m, zooms = []) {
  let a = +m.start, b = +m.end, Ta = null, Tb = null
  // riding a zoom, the dim takes exactly as long as the push and the pull
  const zEase = z => Math.min(ZOOM_EASE, Math.max(0, (z.end - z.start) / 2))
  const reach = (edge, inside) => Math.abs(edge) <= SPOT_SNAP || (inside && Math.abs(edge) <= SPOT_RIDE)
  let da = Infinity, db = Infinity, handIn = null, handOut = null
  for (const z of zooms || []) {
    if (!(z && z.end > z.start)) continue
    // an edge only moves inward while at least a second of spotlight is left, so the
    // spotlight is never cut down to a sliver of itself
    const sa = z.start - m.start, eb = m.end - z.end
    if (reach(sa, sa > 0 && z.start < m.end - 1) && Math.abs(sa) < da) { da = Math.abs(sa); a = z.start; Ta = zEase(z) }
    if (reach(eb, eb > 0 && z.end > m.start + 1) && Math.abs(eb) < db) { db = Math.abs(eb); b = z.end; Tb = zEase(z) }
    const gOut = z.start - m.end, gIn = m.start - z.end
    if (gOut >= -zEase(z) && gOut <= SPOT_HAND && z.start > m.start + 1) handOut = z
    if (gIn >= -zEase(z) && gIn <= SPOT_HAND && z.end < m.end - 1) handIn = z
  }
  // a riding edge already moves with a zoom; a hand-off only times a free one
  if (Tb == null && handOut) { Tb = zEase(handOut); b = handOut.start + Tb }
  if (Ta == null && handIn) { Ta = zEase(handIn); a = handIn.end - Ta }
  return { a, b, Ta, Tb }
}
// ── content space: lift and spotlight ───────────────────────────────────────
// Two ways of saying "look here", in one visual language. Both cut the thing out as a
// rounded rectangle hugging its box and step the rest of the frame back, dimmed and
// lightly blurred, never with a hard edge. A spotlight's cutout is feathered and
// breathes a little round its target. A lift raises the piece itself: a soft wide
// shadow under it and a few percent of scale, a card coming off the page. Both ease
// on the zoom's own curve and timing (spotlightSpan), so a zoom and a lift on the same
// thing read as one move, and both are drawn in the recording's space before any zoom.
//
// processor.js focusFilters draws them from masks made once per mark (focusExprs);
// focusAt is the same geometry point by point, for the tests and the editor preview.
// dim is the share of light taken from the rest of the frame, blur its Gaussian sigma
// in finished pixels (light: the page stays recognisable, it only stops competing),
// shadow how dark a lift's shadow is at its heart.
const FOCUS = {
  spotlight: { dim: SPOT_DIM, blur: 1.6, shadow: 0 },
  lift: { dim: 0.3, blur: 2.4, shadow: 0.6 },
}
const FOCUS_KINDS = Object.keys(FOCUS)

/**
 * A lift or spotlight's cutout on a W x H picture, in its pixels: { kind, x, y, w, h,
 * r, feather, dim, blur, lift, shadow: { dy, soft, alpha, ring } }. The box plus a little room
 * (a spotlight's pad), never snapped out through the frame's edge, so there is no L
 * and no band. Everything is sized in pixels of the finished frame, through the zoom
 * it is seen in, so a 2x zoom does not double the feather.
 *   o.px      finished-frame pixels per pixel here, before any zoom
 *   o.seen    the zoom scale the mark is mostly seen through
 *   o.radius  the element's own corner radius in pixels here, when measured (cornerRadius)
 */
function focusShape(m, W, H, o = {}) {
  const kind = FOCUS[m && m.kind] ? m.kind : 'spotlight', f = FOCUS[kind]
  const out = (o.px > 0 ? o.px : 1080 / H) * Math.max(1, +o.seen || 1)
  const c01 = v => Math.max(0, Math.min(1, +v || 0))
  const bx = c01(m.x) * W, by = c01(m.y) * H
  const bw = Math.max(2, Math.min(W - bx, (+m.w > 0 ? +m.w : 0.2) * W)), bh = Math.max(2, Math.min(H - by, (+m.h > 0 ? +m.h : 0.1) * H))
  // a short wide thing (a toast, a button, a search field) is a pill: its own round
  // ends read, so it is hugged closer
  const pill = bh * out < 100 && bw > bh * 2.5
  // a pill's pad is a hair: a wider ring of lit page round a dark toast reads as a glow.
  // A lifted card keeps a few pixels of its page on every side, so its own border comes
  // up whole and evenly framed rather than on the cut, where it read as a clipped screenshot.
  const pad = (kind === 'lift' ? (pill ? 1 : 4) : pill ? 3 : 12) / out
  const x = Math.max(0, bx - pad), y = Math.max(0, by - pad)
  const w = Math.min(W, bx + bw + pad) - x, h = Math.min(H, by + bh + pad) - y
  // the element's own corners where measured, concentric with the pad; else a pill's
  // round ends, or a card's corners sized to the card
  const own = +o.radius > 0 ? +o.radius + pad : null
  const r = Math.min(w / 2, h / 2, own != null ? own : pill ? h / 2 : Math.max(8 / out, Math.min(18 / out, Math.min(bw, bh) * 0.06)) + pad)
  // A lift grows by at most 2 percent about its own centre: the shadow and the page
  // stepping back do the lifting. At 5 percent a card grid's outer cards moved ten
  // pixels off their own blurred copy and read as a pasted screenshot.
  const lift = kind === 'lift' ? 1 + Math.max(0.012, Math.min(0.02, 12 / (Math.max(bw, bh) * out))) : 1
  const big = !pill && bh * out > 120
  // Round a small lifted thing the page steps further back, toward a dark neutral: at
  // the card's 30 percent a light UI round a toast went a flat pale grey, not lifted
  const dim = kind === 'lift' && !big ? 0.45 : f.dim
  return {
    kind, x, y, w, h, r,
    feather: kind === 'lift' ? 1 : (pill ? 6 : 12) / out,
    dim, blur: f.blur / out,
    // Round a lift the page steps back softly: no dim at the piece's edge, full dim
    // about 40 finished pixels out, and a little more with distance, so it reads as
    // light falling off the piece rather than a flat grey wash with a hole in it
    fall: kind === 'lift' ? { near: 40 / out, far: 420 / out } : null,
    lift,
    // a key shadow below, and a tight ambient one all round: without it the blurred
    // copy of a dark element under the piece shows past its top edge as a grey ridge.
    // Small pieces get a shadow as wide as a card's, or they sit flat on the page.
    shadow: { dy: (big ? 16 : 10) / out, soft: (big ? 44 : 32) / out, alpha: f.shadow, ring: (big ? 10 : 8) / out },
  }
}

// Signed distance from (X, Y) to a shape's rounded rectangle: negative inside
function focusDist(s, X, Y, dy = 0, grow = 1) {
  const cx = s.x + s.w / 2, cy = s.y + s.h / 2 + dy
  const hw = s.w * grow / 2, hh = s.h * grow / 2, r = s.r * grow
  const qx = Math.abs(X - cx) - (hw - r), qy = Math.abs(Y - cy) - (hh - r)
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
}
/**
 * When a lift or spotlight is in, on the output clock: { a, b, Tin, Tout }, the ease
 * in starting at a and the ease out ending at b. Riding a zoom it takes the zoom's own
 * push and pull; on its own, the zoom's length of ease.
 */
function focusTiming(m, zooms = []) {
  const { a, b, Ta, Tb } = spotlightSpan(m, zooms)
  if (!(b > a + 0.2)) return null
  const T0 = Math.min(ZOOM_EASE, (b - a) / 3)
  const Tin = Math.min(Ta != null && Ta > 0.04 ? Ta : T0, (b - a) / 2)
  const Tout = Math.min(Tb != null && Tb > 0.04 ? Tb : T0, (b - a) - Tin)
  return { a, b, Tin, Tout }
}
// How far in a lift or spotlight is at t, 0 to 1, on the zoom's curve
function focusLevel(tm, t) {
  if (!tm || t <= tm.a || t >= tm.b) return 0
  return MOVE(Math.min((t - tm.a) / tm.Tin, (tm.b - t) / tm.Tout, 1))
}
const smooth01 = v => { const p = Math.max(0, Math.min(1, v)); return p * p * (3 - 2 * p) }

/**
 * The masks at one point, fully in: { a, shade, piece }. a is how much of the stepped
 * back frame shows (0 in a spotlight's cutout, 1 elsewhere; a lift's piece covers its
 * own hole), shade what that frame is multiplied by (the dim, and a lift's shadow),
 * piece how opaque the lifted piece is.
 */
function focusAt(s, X, Y) {
  const d = focusDist(s, X, Y)
  const a = s.kind === 'lift' ? 1 : smooth01(d / s.feather + 0.5)
  let sh = 0
  if (s.shadow.alpha) {
    const key = s.shadow.alpha * (1 - smooth01(focusDist(s, X, Y, s.shadow.dy, s.lift) / s.shadow.soft + 0.5))
    const amb = s.shadow.alpha * 0.55 * (1 - smooth01(focusDist(s, X, Y, 0, s.lift) / s.shadow.ring))
    sh = 1 - (1 - key) * (1 - amb)
  }
  const dim = s.fall ? s.dim * smooth01(d / s.fall.near) * (0.72 + 0.28 * smooth01(d / s.fall.far)) : s.dim
  return { a, shade: (1 - dim) * (1 - sh), piece: Math.max(0, Math.min(1, 0.5 - d)) }
}

/**
 * The same masks as ffmpeg expressions of X and Y (geq), on a copy scaled by k:
 * { a, shade, piece }, each 0 to 1. Evaluated once per mark on a still, never per frame.
 * piece is in the lifted piece's own crop, whose top left is (ox, oy) here.
 */
function focusExprs(s, k = 1, ox = 0, oy = 0) {
  const f = v => (Math.round(v * 1000) / 1000).toString()
  const dist = (dy, grow, sc, x0, y0) => {
    const cx = (s.x + s.w / 2 - x0) * sc, cy = (s.y + s.h / 2 + dy - y0) * sc
    const hw = s.w * grow / 2 * sc, hh = s.h * grow / 2 * sc, r = s.r * grow * sc
    const qx = `(abs(X-${f(cx)})-${f(hw - r)})`, qy = `(abs(Y-${f(cy)})-${f(hh - r)})`
    return `(hypot(max(${qx},0),max(${qy},0))+min(max(${qx},${qy}),0)-${f(r)})`
  }
  const sm = e => `(clip(${e},0,1)*clip(${e},0,1)*(3-2*clip(${e},0,1)))`
  const a = s.kind === 'lift' ? '1' : sm(`${dist(0, 1, k, 0, 0)}/${f(s.feather * k)}+0.5`)
  const key = `${f(s.shadow.alpha)}*(1-${sm(`${dist(s.shadow.dy, s.lift, k, 0, 0)}/${f(s.shadow.soft * k)}+0.5`)})`
  const amb = `${f(s.shadow.alpha * 0.55)}*(1-${sm(`${dist(0, s.lift, k, 0, 0)}/${f(s.shadow.ring * k)}`)})`
  const sh = s.shadow.alpha ? `(1-(1-${key})*(1-${amb}))` : '0'
  const d0 = dist(0, 1, k, 0, 0)
  const dim = s.fall
    ? `${f(s.dim)}*${sm(`${d0}/${f(s.fall.near * k)}`)}*(0.72+0.28*${sm(`${d0}/${f(s.fall.far * k)}`)})`
    : f(s.dim)
  return { a, shade: `(1-${dim})*(1-${sh})`, piece: `clip(0.5-${dist(0, 1, 1, ox, oy)},0,1)` }
}

/**
 * An element's own corner radius, in pixels of a w x h grey frame, or null. Walks in
 * along each corner's diagonal from the box's corner until the pixels turn to the
 * element's fill: a corner of radius r keeps the page for r(1 - 1/sqrt 2) of the way
 * in. The median of the corners that read, so one corner under a shadow or an icon
 * does not decide it. m is the box in fractions, and must hug the element: a box
 * with page along its edges measures nothing.
 */
function cornerRadius(px, w, h, m) {
  if (!px || px.length < w * h) return null
  const X0 = Math.round((+m.x || 0) * w), Y0 = Math.round((+m.y || 0) * h)
  const X1 = Math.round(((+m.x || 0) + (+m.w || 0)) * w) - 1, Y1 = Math.round(((+m.y || 0) + (+m.h || 0)) * h) - 1
  if (X1 - X0 < 8 || Y1 - Y0 < 8 || X0 < 0 || Y0 < 0 || X1 >= w || Y1 >= h) return null
  const at = (x, y) => px[y * w + x]
  const reach = Math.floor(Math.min(X1 - X0, Y1 - Y0) / 2)
  const found = []
  for (const [x, y, sx, sy] of [[X0, Y0, 1, 1], [X1, Y0, -1, 1], [X0, Y1, 1, -1], [X1, Y1, -1, -1]]) {
    // the fill: a step in along both edges from this corner, past any rounding
    const fill = at(x + sx * reach, y + sy * Math.min(3, reach))
    const fill2 = at(x + sx * Math.min(3, reach), y + sy * reach)
    if (Math.abs(fill - fill2) > 10) continue
    const page = at(x, y)
    if (Math.abs(page - fill) < 14) continue            // no contrast at this corner
    // a loose box has page along its edges too, and would read as a huge radius
    const half = Math.abs(page - fill) / 2, mx = (X0 + X1) >> 1, my = (Y0 + Y1) >> 1
    if (Math.abs(at(mx, y) - fill) > half || Math.abs(at(x, my) - fill) > half) continue
    let d = -1
    for (let i = 0; i <= reach; i++) {
      if (Math.abs(at(x + sx * i, y + sy * i) - fill) <= Math.abs(page - fill) / 2) { d = i; break }
    }
    if (d >= 0) found.push(d / (1 - Math.SQRT1_2))
  }
  if (found.length < 2) return null
  found.sort((p, q) => p - q)
  return found[found.length >> 1]
}

/**
 * A lift's box grown out to the element's own outer edge, on a grey picture px (w x h)
 * with a few pixels of page round the box: { x, y, w, h } in the same fractions, or
 * null when nothing moved. find_on_screen measures at 1600 wide and keeps the inside of
 * a hairline, so a stats grid lifted on its box came out with its bottom and right
 * borders sliced off while the top and left kept theirs. Each side steps out over rows
 * (or columns) that differ from the page beyond them, up to that page, never in.
 */
function edgeFit(px, w, h, m) {
  if (!px || px.length < w * h) return null
  const X0 = Math.round((+m.x || 0) * w), Y0 = Math.round((+m.y || 0) * h)
  const X1 = Math.round(((+m.x || 0) + (+m.w || 0)) * w) - 1, Y1 = Math.round(((+m.y || 0) + (+m.h || 0)) * h) - 1
  if (X1 - X0 < 16 || Y1 - Y0 < 16 || X0 < 0 || Y0 < 0 || X1 >= w || Y1 >= h) return null
  const at = (x, y) => px[y * w + x]
  // the middle of each side only: rounded corners are page there
  const ix = Math.round((X1 - X0) * 0.15), iy = Math.round((Y1 - Y0) * 0.15)
  const line = (horiz, k) => {
    const v = []
    if (horiz) for (let x = X0 + ix; x <= X1 - ix; x++) v.push(at(x, k))
    else for (let y = Y0 + iy; y <= Y1 - iy; y++) v.push(at(k, y))
    return v
  }
  const median = v => v.slice().sort((a, b) => a - b)[v.length >> 1]
  // from just outside the box to the picture's edge, which is page
  const grow = (horiz, from, to, dir) => {
    if ((to - from) * dir < 1) return from
    const page = median(line(horiz, to))
    let edge = from, gap = 0
    for (let k = from + dir; (to - k) * dir >= 1; k += dir) {
      const v = line(horiz, k)
      if (v.filter(p => Math.abs(p - page) > 6).length >= v.length * 0.5) { edge = k; gap = 0; continue }
      // a box can stop a pixel or two short of the line, with the card's own fill between
      if (edge !== from || ++gap > 2) break
    }
    return edge
  }
  const t = grow(true, Y0, 0, -1), b = grow(true, Y1, h - 1, 1)
  const l = grow(false, X0, 0, -1), r = grow(false, X1, w - 1, 1)
  if (t === Y0 && b === Y1 && l === X0 && r === X1) return null
  return { x: l / w, y: t / h, w: (r - l + 1) / w, h: (b - t + 1) / h }
}

// ── the two scripts ─────────────────────────────────────────────────────────
/**
 * The frame-space script: captions, title cards and labels on the finished W x H
 * frame. Returns null when there is nothing to draw.
 *   phrases  from captionPhrases, already on the output clock
 *   texts    text layers with start and end on the output clock
 *   span     output length in seconds
 *   box      where the video sits on a framed canvas, {x, y, w, h}, or null
 *   frosted  captions sit on a captionFrost patch, so their dark cloud can be lighter
 */
function frameScript({ W, H, phrases, capStyle, texts, span, measure, box, frosted }) {
  const evs = events()
  if (phrases && phrases.length) captionEvents(evs, phrases, W, H, capStyle || {}, measure, box, !!frosted)
  for (const card of titleCards(texts, span)) titleEvents(evs, { ...card, span }, W, H, measure)
  for (const t of texts || []) {
    if (!t || !String(t.text || '').trim()) continue
    const style = textStyle(t, span)
    if (style !== 'title') labelEvents(evs, t, style, W, H, span, measure)
  }
  return evs.list.length ? script(W, H, evs) : null
}

// The content-space script: numbered steps, marks already on the output clock. Lifts
// and spotlights change pixels, so processor.js draws them (focusFilters).
function contentScript({ W, H, marks, zooms, px = null }) {
  const evs = events()
  let k = 0
  for (const m of marks || []) {
    if (!m) continue
    // counted before the time check, so a step cut away keeps the others' numbers
    const n = m.kind === 'step' ? stepLabel(m, ++k) : null
    if (!(m.end > m.start)) continue
    if (m.kind !== 'step') continue
    // sized through the zoom it is mostly seen in, as a lift's edges are
    const seen = Math.max(1, ...(zooms || []).filter(z => z && Math.min(z.end, m.end) - Math.max(z.start, m.start) > 0.3).map(z => +z.scale || 1))
    stepEvents(evs, { ...m, n, out: px > 0 ? px * seen : 0, ...stepOnLift(m, marks, zooms, W, H, px) }, W, H)
  }
  return evs.list.length ? script(W, H, evs) : null
}

// A step numbering a card that is lifted goes up with it: the piece grows a few
// percent about its centre, which would slide the card's own label under a badge
// left where the card was. Judged at the step's start, so one that pops in once the
// lift is up lands on the raised card; the move is the same scale about the same centre.
function stepOnLift(st, marks, zooms, W, H, px) {
  const x = +st.x || 0, y = +st.y || 0, slack = 0.02
  for (const m of marks || []) {
    if (!m || m.kind !== 'lift' || !(+m.w > 0 && +m.h > 0)) continue
    if (x < m.x - slack || x > m.x + m.w + slack || y < m.y - slack || y > m.y + m.h + slack) continue
    const tm = focusTiming(m, zooms)
    if (!tm || st.start < tm.a + tm.Tin / 2 || st.start >= tm.b) continue
    const seen = Math.max(1, ...(zooms || []).filter(z => z && Math.min(z.end, tm.b) - Math.max(z.start, tm.a) > 0.3).map(z => +z.scale || 1))
    const s = focusShape(m, W, H, { px: px || undefined, seen, radius: m.radius })
    const cx = (s.x + s.w / 2) / W, cy = (s.y + s.h / 2) / H
    return { x: cx + (x - cx) * s.lift, y: cy + (y - cy) * s.lift }
  }
  return null
}

/**
 * The window an explicit zoom shows at time t, as 0..1 of the frame: { s, x, y, w, h }.
 * Mirrors processor.js explicitZoomFilter and zoompan (same ease, same smoothstep,
 * the focus held centred and clamped at the frame edge), so the editor previews the
 * move the export makes. Overlapping zooms: the earliest one wins, as there.
 */
function zoomView(zooms, t) {
  for (const m of zoomPlan(zooms)) {
    if (t < m.inStart || t > m.outEnd) continue
    let s, fx = m.x, fy = m.y
    if (m.from && t < m.inEnd) {
      // panning across from the zoom before: focus and scale move together
      const q = MOVE((t - m.inStart) / (m.inEnd - m.inStart))
      s = m.from.scale + (m.scale - m.from.scale) * q - (m.from.dip || 0) * 4 * q * (1 - q)
      fx = m.from.x + (m.x - m.from.x) * q; fy = m.from.y + (m.y - m.from.y) * q
    } else {
      const p = t < m.inEnd ? (t - m.inStart) / (m.inEnd - m.inStart)
        : t > m.outStart ? (m.outEnd - t) / (m.outEnd - m.outStart) : 1
      s = 1 + (m.scale - 1) * MOVE(isFinite(p) ? p : 1)
    }
    const w = 1 / s
    return { s, x: Math.max(0, Math.min(1 - w, fx - w / 2)), y: Math.max(0, Math.min(1 - w, fy - w / 2)), w, h: w }
  }
  return { s: 1, x: 0, y: 0, w: 1, h: 1 }
}

// Explicit zooms as moves: { inStart, inEnd, outStart, outEnd, x, y, scale, from }.
// Two zooms less than ZOOM_SETTLE apart do not pull out to the whole frame and push
// straight back in, which reads as a bounce: the first holds, then the camera pans
// across to the second over ZOOM_PAN, on the same curve, as auto-zoom does.
// processor.js explicitZoomFilter renders exactly this plan.
// Two targets far apart (more than about half a view between them) are not joined by
// a long diagonal slide across the page, which reads as busy: the camera eases back
// while it travels (from.dip, taken off the scale at the middle of the move, on a
// parabola so it still starts and lands on the one curve), over a little longer.
const ZOOM_SETTLE = 0.8, ZOOM_PAN = 0.7, ZOOM_PAN_FAR = 1.0
function zoomPlan(zooms) {
  const list = (zooms || []).filter(z => z && z.end > z.start).slice().sort((a, b) => a.start - b.start)
  const plan = list.map(z => {
    const e = Math.min(ZOOM_EASE, Math.max(0, (z.end - z.start) / 2))
    return { inStart: z.start, inEnd: z.start + e, outStart: z.end - e, outEnd: z.end,
      x: z.x != null ? z.x : 0.5, y: z.y != null ? z.y : 0.5, scale: Math.max(1.05, Math.min(4, z.scale || 1.8)) }
  })
  for (let i = 1; i < plan.length; i++) {
    const p = plan[i - 1], n = plan[i]
    if (n.inStart - p.outEnd >= ZOOM_SETTLE) continue
    const at = Math.max(p.inEnd, Math.min(p.outEnd, n.inStart))
    // room for the pan and for the second zoom's own pull back
    if (n.outStart - at < 0.2) continue
    const lo = Math.min(p.scale, n.scale), d = Math.hypot(n.x - p.x, n.y - p.y)
    const far = d * lo > 0.6
    // never all the way out: that would be the bounce this pan exists to avoid
    const mid = far ? Math.max(1 + (lo - 1) * 0.3, Math.min(lo, 0.6 / d)) : null
    const dip = far ? Math.max(0, (p.scale + n.scale) / 2 - mid) : 0
    // the longer move starts earlier where the zoom before has the room
    const start = far ? Math.max(p.inEnd, at - (ZOOM_PAN_FAR - ZOOM_PAN) / 2) : at
    n.inStart = start
    n.inEnd = start + Math.min(far ? ZOOM_PAN_FAR : ZOOM_PAN, n.outStart - start)
    p.outStart = p.outEnd = start
    n.from = { x: p.x, y: p.y, scale: p.scale, dip }
  }
  return plan
}

module.exports = {
  bezier, EASE_IN, EASE_OUT, MOVE, ZOOM_EASE, POP, FONT, GOLD, zoomView, zoomPlan,
  alignWords, snapToSpeech, spokenWords, captionPhrases, phraseTimes, captionLayout, CAP_BAND, BAND_WRAP, backdropGeometry, titleParts, textStyle, titleCards,
  cardLanding, clearOfTitles, gutterInsets, windowCorner, frameScript, contentScript, captionFrost, spotlightSpan, roundRect, SPOT_DIM,
  FOCUS, FOCUS_KINDS, focusShape, focusTiming, focusLevel, focusAt, focusExprs, focusDist, cornerRadius, edgeFit, stepLabel, stepSize, stepSpot, stepCorner, stepGrid, spotFit,
  captionClutter, placeCaptions, CAP_ZONE,
}
