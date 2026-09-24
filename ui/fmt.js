// One formatter for every value a person reads.
//
// Before this, each panel picked its own words: 1.0 with a times sign in Captions and "1.0x" in Look for
// the same setting, "8.0s" in the editor and "4.3 s" in chat and "1 min" in Activity,
// "New folder..." beside "Type something…". Every number, unit, duration, size and
// ellipsis now comes from here, so two places that show the same thing show it the same.
//
// The rules, in short (the full list is in .context/survey/pol-f0.md):
//   units are joined, never spaced: 6px 50% 1.5s 830ms 12° +3dB 1.7x 12.3MB
//     (in a mono field one space is a whole digit wide, so "6 px" reads as a gap)
//   decimals follow the control's step, at most 2, trailing zeros dropped: 0s, 2.5px, 6.2%
//   a multiplier always keeps one decimal, and is written with x: 1.0x 1.7x 1.04x
//   a signed control shows its sign: -30% 0% +30%, and a hyphen-minus so it parses back
//   clock times are m:ss, h:mm:ss past an hour; elapsed durations 830ms 4.3s 12s 1m 4s 1h 2m
//   sizes stay "1440 x 900"; the separator is " · "; the ellipsis is the one glyph "…"
//
// Pure, no DOM, no state. Loads under node (require('./fmt')) and in the renderer, either
// required or as a plain <script>, where it is window.Fmt.

;(function (root) {
  'use strict'

  const ELL = '\u2026'
  const SEP = ' \u00B7 '

  // The most decimals any value shows, and the most a unit shows when no step is given
  const MAX_DP = 2
  const DEFAULT_DP = { '%': 0, px: 0, s: 1, ms: 0, deg: 1, dB: 1, x: 2, MB: 1, '': 2 }
  // What the stored value is multiplied by before it is shown: a percent is stored 0..1
  const DEFAULT_SCALE = { '%': 100 }
  const SUFFIX = { deg: '\u00B0' }

  const finite = v => v != null && v !== '' && Number.isFinite(+v)

  // How many decimals it takes to write n exactly, capped at MAX_DP: 0.5 is 1, 0.05 is 2
  function decimalsOf(n) {
    n = Math.abs(+n)
    for (let d = 0; d < MAX_DP; d++) {
      const k = n * Math.pow(10, d)
      if (Math.abs(k - Math.round(k)) < 1e-6) return d
    }
    return MAX_DP
  }

  // n to at most dp decimals, trailing zeros dropped, never "-0"; keep at least minDp
  function num(n, dp, minDp) {
    dp = Math.max(0, Math.min(MAX_DP, dp == null ? MAX_DP : dp))
    minDp = Math.min(dp, minDp || 0)
    let s = (+n).toFixed(dp)
    if (dp > minDp) {
      s = s.replace(new RegExp('(\\.\\d{' + minDp + '}\\d*?)0+$'), '$1').replace(/\.$/, '')
    }
    if (/^-0(\.0*)?$/.test(s)) s = s.slice(1)
    return s
  }

  // A value with its unit. o: { unit, step, scale, signed }
  //   unit    '%' | 'px' | 's' | 'ms' | 'deg' | 'dB' | 'x' | 'MB' | '' (a bare number)
  //   step    the control's step in stored units; sets how many decimals show
  //   scale   stored value times this is what shows (default 100 for %, else 1)
  //   signed  a control that goes both ways: shows + on positives (dB is always signed)
  function value(v, o) {
    if (!finite(v)) return ''
    o = o || {}
    const unit = o.unit || ''
    const scale = o.scale != null ? +o.scale : (DEFAULT_SCALE[unit] || 1)
    const shown = +v * scale
    const dp = o.step != null && +o.step > 0
      ? decimalsOf(+o.step * scale)
      : (unit in DEFAULT_DP ? DEFAULT_DP[unit] : MAX_DP)
    const minDp = unit === 'x' ? 1 : 0
    let s = num(shown, Math.max(dp, minDp), minDp)
    const signed = o.signed || unit === 'dB'
    if (signed && +s > 0) s = '+' + s
    return s + (SUFFIX[unit] != null ? SUFFIX[unit] : unit)
  }

  // And back, from what a person types into a number box: "6%" is 0.06, "1.5x" is 1.5.
  // Accepts the real minus sign as well as a hyphen. null when there is no number in it.
  function parse(s, o) {
    o = o || {}
    const unit = o.unit || ''
    const scale = o.scale != null ? +o.scale : (DEFAULT_SCALE[unit] || 1)
    const t = String(s == null ? '' : s).replace(/\u2212/g, '-').replace(/[^\d.+-]/g, '')
    const n = parseFloat(t)
    if (!Number.isFinite(n)) return null
    return n / scale
  }

  // The shorthands every panel calls
  const px = (v, step) => value(v, { unit: 'px', step })
  const pct = (v, o) => value(v, Object.assign({ unit: '%' }, o))            // v is 0..1
  const pctOf = (v, min, max, o) =>                                          // a dial with no unit
    max > min && finite(v) ? pct((+v - min) / (max - min), o) : ''
  const mult = (v, step) => value(v, { unit: 'x', step })
  const secs = (v, step) => value(v, { unit: 's', step })
  const deg = (v, step) => value(v, { unit: 'deg', step })
  const db = (v, step) => value(v, { unit: 'dB', step: step == null ? 1 : step })

  // A position on a clock: 0:08, 12:34, 1:02:03. Floored, so it never shows a second
  // that has not yet begun, and matches the playhead.
  function clock(sec) {
    if (!finite(sec)) sec = 0
    let t = Math.max(0, Math.floor(+sec))
    const h = Math.floor(t / 3600); t -= h * 3600
    const m = Math.floor(t / 60), s = t % 60
    const ss = String(s).padStart(2, '0')
    return h ? h + ':' + String(m).padStart(2, '0') + ':' + ss : m + ':' + ss
  }

  // How long something took, from milliseconds: 830ms 4.3s 12s 1m 4s 2m 1h 2m
  function dur(ms) {
    if (!finite(ms)) return ''
    ms = Math.max(0, +ms)
    const r = Math.round(ms)
    if (r < 1000) return r + 'ms'
    const tenths = Math.round(ms / 100) / 10
    if (tenths < 10) return num(tenths, 1) + 's'
    let s = Math.round(ms / 1000)
    if (s < 60) return s + 's'
    const h = Math.floor(s / 3600); s -= h * 3600
    const m = Math.floor(s / 60); s -= m * 60
    if (h) return h + 'h' + (m ? ' ' + m + 'm' : '')
    return m + 'm' + (s ? ' ' + s + 's' : '')
  }
  const durSec = sec => finite(sec) ? dur(+sec * 1000) : ''

  // Pixel dimensions: "1440 x 900", a plain x with a space each side, as it always was
  const size = (w, h) => finite(w) && finite(h) ? Math.round(+w) + ' x ' + Math.round(+h) : ''

  // A file's size, in decimal units as Finder shows them: 840KB 12.3MB 1.2GB
  function bytes(n) {
    if (!finite(n)) return ''
    n = Math.max(0, +n)
    if (n < 1e6) return Math.max(1, Math.round(n / 1e3)) + 'KB'
    if (n < 1e9) return num(n / 1e6, n < 1e8 ? 1 : 0) + 'MB'
    return num(n / 1e9, 1) + 'GB'
  }

  // How many of how many: "0 / 5000". Whole numbers, no grouping, so it lines up in mono
  const count = (n, max) => {
    const a = finite(n) ? Math.round(+n) : 0
    return max == null ? String(a) : a + ' / ' + Math.round(+max)
  }

  // The real ellipsis wherever three dots were typed: "New folder..." is "New folder…"
  const ell = s => String(s == null ? '' : s).replace(/\.{3}/g, ELL)

  // Sentence case for a sub label: the first letter raised, nothing else touched, so
  // names inside it ("SF Pro", "ElevenLabs", ids like Z1) keep their own case.
  // A first word that already carries a capital inside it (iPhone, macOS) is a name and
  // is left as it is.
  const sentence = s => String(s == null ? '' : s)
    .replace(/^(\s*["'(\u201C]?)(\p{Ll})(\S*)/u, (m, a, c, rest) => /\p{Lu}/u.test(rest) ? m : a + c.toUpperCase() + rest)

  // Meta parts on one line: "You · 1:13 PM". Empty parts drop out.
  const join = (...parts) => [].concat(...parts)
    .filter(p => p != null && p !== '' && p !== false).map(String).join(SEP)

  const Fmt = {
    ELL, SEP, value, parse, px, pct, pctOf, mult, secs, deg, db,
    clock, dur, durSec, size, bytes, count, ell, sentence, join,
    _decimalsOf: decimalsOf, _num: num,
  }

  if (typeof module === 'object' && module && module.exports) module.exports = Fmt
  if (root && typeof root === 'object') root.Fmt = Fmt
})(typeof window !== 'undefined' ? window : null)
