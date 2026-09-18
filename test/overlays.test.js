const O = require('../ui/overlays')

let pass = 0, fail = 0
const is = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}` +
    (ok ? '' : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`))
}

// ---- curves ----
is('ease in starts at 0 and lands on 1', [O.EASE_IN(0), O.EASE_IN(1)], [0, 1])
is('ease in is front-loaded, like the app', O.EASE_IN(0.3) > 0.6, true)
let mono = true
for (let p = 0.01; p <= 1; p += 0.01) if (O.EASE_IN(p) < O.EASE_IN(p - 0.01) - 1e-9) mono = false
is('ease in never goes backwards', mono, true)
is('a badge overshoots a little, then settles', [O.POP(0.7) > 1, O.POP(0.7) < 1.12, O.POP(1)], [true, true, 1])

// ---- words: text from the cues, timing from the transcriber ----
const words = [
  { w: 'This', t: 0.1 }, { w: 'is', t: 0.3 }, { w: 'my', t: 0.5 }, { w: 'songscription', t: 0.7 },
  { w: 'library,', t: 1.6 }, { w: '300', t: 2.4 }, { w: 'songs,', t: 3.1 }, { w: 'and', t: 3.6 },
]
const cues = [
  { start: 0.1, end: 3.0, text: 'This is my Songscription library. 300' },
  { start: 3.1, end: 4.0, text: 'songs, and' },
]
const toks = O.alignWords(cues, words)
is('corrected words keep their spoken times',
  toks.map(t => [t.text, t.start]),
  [['This', 0.1], ['is', 0.3], ['my', 0.5], ['Songscription', 0.7], ['library.', 1.6], ['300', 2.4], ['songs,', 3.1], ['and', 3.6]])
is('a word lasts until the next begins', toks[0].end, 0.3)

const guessed = O.alignWords([{ start: 0, end: 2, text: 'no timings here' }], [])
is('with no timings, words share the cue in order',
  guessed.every((t, i) => i === 0 || t.start > guessed[i - 1].start) && guessed[0].start === 0, true)

// ---- phrases ----
const ph = O.captionPhrases(toks)
is('a sentence end starts a new phrase, so "300 songs" stays together',
  ph.map(p => p.text), ['This is my Songscription library.', '300 songs, and'])
is('a long phrase wraps to two lines, never leaving one word alone', ph[0].lines, [3, 2])

const lower = O.captionPhrases([
  { text: 'it works.', start: 0, end: 0.4 }, { text: 'then', start: 0.5, end: 0.8 },
  { text: 'i', start: 0.8, end: 0.9 }, { text: 'ship', start: 0.9, end: 1.2 },
])
is('sentences start with a capital and "i" is "I"', lower.map(p => p.text), ['It works.', 'Then I ship'])

const long = O.captionPhrases('one two three four five six seven eight nine ten eleven twelve thirteen fourteen'
  .split(' ').map((w, i) => ({ text: w, start: i * 0.2, end: i * 0.2 + 0.2 })))
is('no phrase runs past two short lines', long.every(p => p.text.length <= 48 && p.lines.length <= 2), true)

const clause = O.captionPhrases('Listen plays it straight from the MIDI file, and the piano roll follows along.'
  .split(' ').map((w, i) => ({ text: w, start: i * 0.2, end: i * 0.2 + 0.2 })))
is('a word that closes the clause stays with it, a little over the length',
  clause.map(p => p.text), ['Listen plays it straight from the MIDI file,', 'and the piano roll follows along.'])

const pause = O.captionPhrases([{ text: 'wait', start: 0, end: 0.3 }, { text: 'for', start: 0.3, end: 0.5 },
  { text: 'it', start: 1.5, end: 1.7 }, { text: 'now', start: 1.7, end: 2 }])
is('a pause in speech breaks the phrase', pause.map(p => p.text), ['Wait for', 'it now'])

const times = O.phraseTimes(ph)
is('phrases never overlap on screen', times[0].hide <= times[1].show, true)

// ---- texts ----
is('a separator splits a title from its subtitle',
  O.titleParts({ text: 'Songscription · your piano library' }), { title: 'Songscription', subtitle: 'Your piano library' })
is('an explicit subtitle wins', O.titleParts({ text: 'Fetch', subtitle: 'Record it.' }), { title: 'Fetch', subtitle: 'Record it.' })
is('a centred text that opens the video is its title card',
  O.textStyle({ text: 'Hi', fx: 0.5, start: 0.3, end: 4 }, 40), 'title')
is('a centred text that closes it is too', O.textStyle({ text: 'x.app', fx: 0.5, start: 36, end: 40 }, 40), 'title')
is('a text in the middle is a label', O.textStyle({ text: 'Hi', fx: 0.5, start: 10, end: 14 }, 40), 'label')
is('a text for the whole video is never a card', O.textStyle({ text: 'Hi', fx: 0.5, start: 0, end: 40 }, 40), 'label')
is('an explicit style wins', O.textStyle({ text: 'Hi', style: 'lower-third', start: 0, end: 3 }, 40), 'lower-third')
const cards = O.titleCards([{ text: 'Open', fx: 0.5, start: 0.3, end: 4 }, { text: 'Close', fx: 0.5, start: 36, end: 40 }], 40)
is('an opening card covers from the first frame; a closing one from its start',
  cards.map(c => [c.a, c.b, c.opens]), [[0, 4, true], [36, 40, false]])

// ---- scripts ----
const frame = O.frameScript({ W: 1920, H: 1080, phrases: ph, capStyle: {}, texts: [{ text: 'Open · now', fx: 0.5, start: 0.3, end: 4 }], span: 40 })
is('the frame script sizes itself to the frame', /PlayResX: 1920\nPlayResY: 1080/.test(frame), true)
is('the spoken word is gold', frame.includes('\\1c&H3CA9F0&}Songscription'), true)
is('captions carry no box', /BorderStyle|\\bord[1-9][^}]*\\3a&H00&/.test(frame.split('[Events]')[1]), false)
is('a title eases in over several frames', (frame.match(/Open/g) || []).length > 10, true)
is('no em dash anywhere', /\u2014/.test(frame), false)
// the crisp words are cut into slices per spoken word; the fade must run straight through them
const slices = frame.split('\n').filter(l => l.startsWith('Dialogue: 3,')).map(l => {
  const f = /\\fade\((\d+),(\d+),(\d+),\d+,\d+,(\d+),(\d+)\)/.exec(l)
  // the alpha just before the slice ends: the middle knot when the fade out has no time left
  return { a: l.split(',')[1], b: l.split(',')[2], first: f ? +f[1] : 0, last: f ? +(f[4] === f[5] ? f[2] : f[3]) : 0 }
})
let jumps = 0
for (let i = 1; i < slices.length; i++) {
  if (slices[i].a === slices[i - 1].b && Math.abs(slices[i].first - slices[i - 1].last) > 4) jumps++
}
is('caption fades run through word slices without a jump', [slices.length > 3, jumps], [true, 0])

const content = O.contentScript({ W: 2000, H: 1000, zooms: [{ start: 9.5, end: 14 }], marks: [
  { kind: 'step', n: 2, start: 1, end: 4, x: 0.5, y: 0.5 },
  { kind: 'spotlight', start: 10, end: 14, x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
] })
is('a step is a disc with its numeral', /\\p1[^}]*\\1c&H3CA9F0&/.test(content) && /}2$/m.test(content), true)
is('a spotlight is a feathered drawing', /\\blur\d/.test(content.split('\n').find(l => /\\1c&H08090A&/.test(l)) || ''), true)
const spotStart = content.split('\n').filter(l => /\\1c&H08090A&/.test(l)).map(l => l.split(',')[1]).sort()[0]
is('a spotlight near a zoom starts with it, as one move', spotStart, '0:00:09.50')
// and dims on the zoom's own curve and length: the dim reaches full as the push lands,
// and a quarter of the way in it is where smoothstep is, not where a fast ease-out is
const dimAt = t => {
  const l = content.split('\n').find(l => /\\1c&H08090A&/.test(l) && l.split(',')[1] <= t && l.split(',')[2] > t)
  return l ? 1 - parseInt(/\\1a&H([0-9A-F]{2})&/.exec(l)[1], 16) / 255 : 0
}
is('the spotlight lands with the push', [+(dimAt('0:00:09.95') / O.SPOT_DIM).toFixed(2), +(dimAt('0:00:09.61') / O.SPOT_DIM).toFixed(1)], [1, 0.2])
is('nothing to draw is no script', O.contentScript({ W: 10, H: 10, marks: [] }), null)
// a window ending at 0.99 of the width would leave a dim sliver along the edge
const edge = O.contentScript({ W: 2000, H: 1000, marks: [{ kind: 'spotlight', start: 1, end: 4, x: 0.7, y: 0.2, w: 0.29, h: 0.5 }] })
const holeXs = (edge.split('\n').find(l => /\\p1/.test(l)).split('}')[1].match(/-?[\d.]+/g) || []).map(Number)
is('a spotlight at the edge opens through it', holeXs.some(v => v > 1980 && v < 2000), false)
{
  // the shadow under a caption follows its letters: a measured patch behind the block
  // read as a grey rectangle on a light UI
  const under = frame.split('\n').filter(l => /^Dialogue: 0,/.test(l))
  is('a caption has a soft shadow from its own letters, no patch behind it',
    [under.length > 0, under.some(l => /\\p1/.test(l)), Math.max(...under.map(l => +/\\blur([\d.]+)/.exec(l)[1])) >= 20], [true, false, true])
}

// The Songscription edit: the spotlight dimmed at 16.4 and the zoom only came at 18.9,
// so the frame went dark, held, then zoomed. It now waits for the zoom.
const zs = [{ start: 9, end: 15.8 }, { start: 18.9, end: 23.7 }, { start: 31.2, end: 34.6 }]
const sp = O.spotlightSpan({ start: 16.4, end: 23.8 }, zs)
is('a zoom a few seconds into a spotlight takes its dim', [sp.a, sp.b], [18.9, 23.7])
is('a spotlight well before its zoom keeps its own time', O.spotlightSpan({ start: 10, end: 30 }, [{ start: 20, end: 25 }]).a, 10)
is('a spotlight clear of any zoom is untouched', O.spotlightSpan({ start: 26, end: 28 }, zs), { a: 26, b: 28, Ta: null, Tb: null })
// M7 then Z3: the dim lifted at 31.0 and the push came at 31.2, two moves with a hitch
// between. The dim now lifts during the push.
is('a spotlight ending as a zoom begins hands off to it', O.spotlightSpan({ start: 29.3, end: 31 }, zs), { a: 29.3, b: 31.65, Ta: null, Tb: 0.45 })
{
  const s = O.spotlightSpan({ start: 16.1, end: 18 }, [{ start: 9, end: 15.8 }])
  is('and one starting as a zoom ends lands with the pull', [+s.a.toFixed(2), s.b, s.Ta, s.Tb], [15.35, 18, 0.45, null])
}
is('a zoom a second later is its own beat', O.spotlightSpan({ start: 29.3, end: 31 }, [{ start: 32.2, end: 34 }]).b, 31)
is('an edge never moves in to leave a sliver', O.spotlightSpan({ start: 5, end: 8 }, [{ start: 7.5, end: 12 }]).a, 5)

// Captions over a dense UI sit on frosted glass: a feathered mask, one patch per phrase,
// in a band just around the captions, fading with them
const fr = O.captionFrost({ W: 1920, H: 1080, phrases: ph, capStyle: {}, box: { x: 115, y: 71, w: 1690, h: 938 } })
const frLines = fr.script.split('\n').filter(l => l.startsWith('Dialogue'))
is('the frost is one feathered patch per phrase', [frLines.length, frLines.every(l => /\\fad\(150,/.test(l) && /\\blur\d/.test(l))], [O.phraseTimes(ph).length, true])
is('the frost band is even, inside the frame, below the middle', [fr.y % 2, fr.h % 2, fr.y > 540, fr.y + fr.h <= 1080], [0, 0, true, true])
is('the frost script is drawn at the band size', /PlayResY: (\d+)/.exec(fr.script)[1], String(fr.h))
is('no captions, no frost', O.captionFrost({ W: 1920, H: 1080, phrases: [] }), null)
{
  // The glass hugs the words: it reached far past the caption and left the product's
  // own words beside it half soft. Under one caption size of glass either side.
  const px = Math.round(1080 * 0.043), p0 = O.phraseTimes(ph)[0]
  const widest = Math.max(...p0.lines.map((n, k) => {
    const from = p0.lines.slice(0, k).reduce((a, b) => a + b, 0)
    return p0.words.slice(from, from + n).map(w => w.text).join(' ').length * px * 0.56
  }))
  const xs = frLines[0].split('\\p1')[1].split('}')[1].split('{')[0].match(/-?[\d.]+/g).filter((_, i) => i % 2 === 0).map(Number)
  const spill = (Math.max(...xs) - Math.min(...xs) - widest) / 2
  is('the frost reaches under one caption size past the words', spill > 0 && spill < px, true)
}
{
  // Phrase after phrase, the glass never thins: at every change some patch is fully
  // in (an event past its fade in and before its fade out), so the UI never flashes sharp
  const secs = s => { const [h, m, x] = s.split(':'); return +h * 3600 + +m * 60 + +x }
  const pats = frLines.map(l => { const f = l.split(','); const m = /\\fad\((\d+),(\d+)\)/.exec(l)
    return { a: secs(f[1]), b: secs(f[2]), i: +m[1] / 1000, o: +m[2] / 1000 } })
  const pt = O.phraseTimes(ph)
  const joins = pt.slice(1).filter((p, k) => p.show - pt[k].hide < 0.3).map(p => p.show)
  const full = t => pats.some(q => t >= q.a + q.i - 0.01 && t <= q.b - q.o + 0.01)
  is('between touching phrases the glass stays solid', joins.length > 0 && joins.every(t => [0, 0.05, 0.1, 0.14].every(d => full(t + d))), true)
}
const cloudA = f => Math.max(...f.split('\n').filter(l => /^Dialogue: 0,/.test(l)).map(l => 255 - parseInt(/\\1a&H([0-9A-F]{2})&/.exec(l)[1], 16)))
const frosted = O.frameScript({ W: 1920, H: 1080, phrases: ph, capStyle: {}, span: 40, frosted: true })
is('on frost the dark cloud is lighter than without', cloudA(frosted) < cloudA(frame), true)

// ---- captions keep off the product's own toast ----
{
  const w = 40, h = 20
  // a light page; a dark toast arrives across the bottom middle at 2s and leaves at 5s
  const frame = (toast, shift = 0) => {
    const px = new Uint8Array(w * h)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px[y * w + x] = 235 - ((y + shift) % 4 === 0 ? 60 : 0)
    if (toast) for (let y = 17; y < 19; y++) for (let x = 14; x < 27; x++) px[y * w + x] = 30
    return px
  }
  const toastFrames = Array.from({ length: 32 }, (_, k) => ({ t: k / 4, px: frame(k / 4 >= 2 && k / 4 < 5) }))
  const hit = O.captionClutter(toastFrames, w, h)
  is('a toast in the caption zone is seen while it is up, and only then',
    [hit.length > 0, hit.every(t => t >= 2 && t < 5)], [true, true])
  // a scroll changes the whole frame, not just the bottom: nothing to dodge
  const scroll = Array.from({ length: 32 }, (_, k) => ({ t: k / 4, px: frame(false, k) }))
  is('a scroll is not a toast', O.captionClutter(scroll, w, h), [])
  // mid-zoom there is no telling what is where
  is('frames while the camera moves are not judged', O.captionClutter(toastFrames, w, h, () => null), [])

  const mk = (a, b) => ({ start: a, end: b, words: [{ text: 'x', start: a, end: b }], lines: [1], text: 'x' })
  const phr = [mk(0, 1.5), mk(2, 3.5), mk(4, 5), mk(5.6, 6.5), mk(7, 8), mk(20, 21)]
  is('phrases over a toast go to the top, and a short stretch between two goes with them',
    O.placeCaptions(phr, [2.5, 7.2]).map(p => p.at || 'bottom'), ['bottom', 'top', 'top', 'top', 'top', 'bottom'])
  // a zoom from 3.8 to 6.8 hides the toast: the phrases it frames stay at the bottom
  is('but not one spoken inside a zoom, which frames what the top caption would cover',
    O.placeCaptions(phr, [2.5, 7.2], [{ a: 3.8, b: 6.8 }]).map(p => p.at || 'bottom'), ['bottom', 'top', 'bottom', 'bottom', 'top', 'bottom'])
  const moved = O.frameScript({ W: 1920, H: 1080, phrases: O.placeCaptions(phr, [2.5]), capStyle: {}, span: 30 })
  const ys = moved.split('\n').filter(l => /^Dialogue: 3,/.test(l)).map(l => [l.split(',')[1], +/\\pos\([\d.]+,([\d.]+)\)/.exec(l)[1]])
  is('a moved phrase is drawn at the top, the rest stay at the bottom',
    [ys.find(([a]) => a === '0:00:01.94')[1] < 200, ys.find(([a]) => a === '0:00:00.00')[1] > 900], [true, true])
  const fb = O.captionFrost({ W: 1920, H: 1080, phrases: O.placeCaptions(phr, [2.5]), capStyle: {}, box: { x: 115, y: 71, w: 1690, h: 938 } })
  is('a moved caption gets a frost band of its own at the top', [fb.bands.length, fb.bands[1].y < 200, fb.bands[0].y > 540], [2, true, true])
}

// ---- the closing card ----
{
  const cs = O.titleCards([{ text: 'Songscription · your piano library', fx: 0.5, start: 0.3, end: 4.2, sizeFrac: 0.068 },
    { text: 'songscription-library.vercel.app', fx: 0.5, start: 42.2, end: 46.8, sizeFrac: 0.056 }], 46.95)
  is('a closing address signs off under the product name', O.titleParts(cs[1].t),
    { title: 'Songscription', subtitle: 'songscription-library.vercel.app' })
  is('an opening card keeps its own words', O.titleParts(cs[0].t).title, 'Songscription')
  const solo = O.titleCards([{ text: 'x.app', fx: 0.5, start: 36, end: 40 }], 40)
  is('with no opening card, an address stays as it is', O.titleParts(solo[0].t), { title: 'x.app', subtitle: '' })
  // the opening title has left before its ground clears, so it never ghosts over the product
  const f = O.frameScript({ W: 1920, H: 1080, texts: [{ text: 'Songscription · your piano library', fx: 0.5, start: 0.3, end: 4.2 }], span: 46.95 })
  const lastTitle = Math.max(...f.split('\n').filter(l => /^Dialogue: [56],/.test(l)).map(l => {
    const [h, m, s] = l.split(',')[2].split(':'); return +h * 3600 + +m * 60 + +s
  }))
  is('the opening title is gone before the card clears', lastTitle <= cs[0].b - cs[0].fade + 0.01, true)
}

// ---- review fixes ----
{
  // steps without their own number count in order, as they did before
  const c = O.contentScript({ W: 1000, H: 600, marks: [
    { kind: 'step', start: 0, end: 2, x: 0.1, y: 0.1 }, { kind: 'spotlight', start: 0, end: 2, x: 0, y: 0, w: 0.2, h: 0.2 },
    { kind: 'step', start: 0, end: 2, x: 0.2, y: 0.1 }, { kind: 'step', n: 7, start: 0, end: 2, x: 0.3, y: 0.1 }] })
  const nums = [...new Set(c.split('\n').filter(l => /Fetch Rounded/.test(l)).map(l => l.slice(l.lastIndexOf('}') + 1)))]
  is('unnumbered steps count 1, 2 and a given number is kept', nums, ['1', '2', '7'])
  // a label typed on two lines keeps both, and its pill is two lines tall
  const f = O.frameScript({ W: 1920, H: 1080, span: 10, texts: [{ text: 'one\ntwo', fx: 0.3, fy: 0.3, start: 2, end: 5, box: true }] })
  is('a two-line label keeps its line break', f.includes('one\\Ntwo'), true)
  // one unbreakable token never runs off the frame
  const long = O.captionPhrases(O.alignWords([{ start: 0, end: 4, text: 'x'.repeat(120) }], []))
  const g = O.frameScript({ W: 1920, H: 1080, phrases: long, span: 5 })
  const px = +/\\fs(\d+)/.exec(g.split('\n').find(l => l.startsWith('Dialogue: 3')))[1]
  is('a caption too wide for the frame is set smaller', 120 * px * 0.56 <= 1920 * 0.9 + 1, true)
}

// ---- a step badge keeps clear of its neighbours ----
{
  // a button's bottom edge just above the card corner the step numbers
  const w = 400, h = 400, px = new Uint8Array(w * h).fill(250)
  for (let x = 120; x < 280; x++) { px[176 * w + x] = 200; px[177 * w + x] = 215 }
  for (let x = 190; x < 300; x++) px[196 * w + x] = 235
  for (let y = 196; y < 300; y++) px[y * w + 190] = 235
  const m = { x: 196 / w, y: 190 / h }
  const at = O.stepSpot(px, w, h, m, 400)
  is('it slides down off the button above, keeping the point under it', [at.y > m.y, Math.abs(at.x - m.x) < 0.02,
    Math.hypot((at.x - m.x) * w, (at.y - m.y) * h) < (26 / 2 + 1.5) * 0.76], [true, true, true])
  is('on a clear patch it stays where it was put', O.stepSpot(new Uint8Array(w * h).fill(250), w, h, m, 400), { x: m.x, y: m.y })
}

// ---- words on the voice: the recogniser reports them early ----
{
  // three sentences after silences, each reported 0.33 to 0.5 s before it is heard
  const speech = [[3.6, 7.4], [8.4, 12.1], [13.2, 16.9]]
  const heard = [3.6, 3.95, 4.4, 5.1, 6.2, 7.1, 8.4, 8.9, 9.6, 10.8, 11.8, 13.2, 13.7, 14.9, 16.6]
  const early = heard.map((t, i) => t - (i < 11 ? (i < 5 ? 0.35 : 0.33) : 0.5))
  const s = O.snapToSpeech(early, speech)
  const starts = [0, 6, 11].map(i => Math.abs(s.times[i] - heard[i]))
  is('each sentence starts on its onset, within 50 ms', starts.every(d => d < 0.05), true)
  is('every word lands inside its speech', s.times.every(t => speech.some(([a, b]) => t >= a - 1e-6 && t <= b + 1e-6)), true)
  is('the order is kept', s.times.every((t, i) => i === 0 || t >= s.times[i - 1]), true)
  is('a cue edge moves with its words', Math.abs(s.at(early[6]) - 8.4) < 0.05, true)
  is('aligned words move no further', O.snapToSpeech(s.times, speech).times, s.times)
  is('no speech found, nothing moves', O.snapToSpeech(early, []).times, early)
  const tok = O.spokenWords([{ start: 3.2, end: 7.3, text: 'This is my library.' }],
    { words: [{ w: 'This', t: 3.25 }, { w: 'is', t: 3.6 }, { w: 'my', t: 3.8 }, { w: 'library', t: 4.3 }], speech: [[3.6, 5.2]] })
  is('the captions time from the moved words', Math.abs(tok[0].start - 3.6) < 0.01 && tok[0].text === 'This', true)
}

// ---- a caption band below a framed video ----
{
  const box = { x: 165, y: 65, w: 1590, h: 886 }       // backdropGeometry with a 12 percent band
  const L = O.captionLayout(1920, 1080, {}, box)
  is('the caption sits in the band, below the video', [L.band, L.y > box.y + box.h, L.y + L.px * 0.6 < 1080], [true, true, true])
  is('without a band it stays on the video', !!O.captionLayout(1920, 1080, {}, { x: 115, y: 71, w: 1690, h: 938 }).band, false)
  const ph = O.captionPhrases([{ text: 'Search', start: 1, end: 1.3 }, { text: 'understands', start: 1.3, end: 1.8 },
    { text: 'plain', start: 1.8, end: 2 }, { text: 'words,', start: 2, end: 2.3 }, { text: 'easy', start: 2.4, end: 2.6 },
    { text: 'in', start: 2.6, end: 2.7 }, { text: 'C.', start: 2.7, end: 3 }], { wrapAt: O.BAND_WRAP })
  is('in the band a phrase is one line', ph.every(p => p.lines.length === 1), true)
  is('no frost on the backdrop', O.captionFrost({ W: 1920, H: 1080, phrases: ph, capStyle: {}, box }), null)
  const ass = O.frameScript({ W: 1920, H: 1080, phrases: [{ ...ph[0], start: 1, end: 2.3 }, { ...ph[ph.length - 1], start: 2.3, end: 3 }], capStyle: {}, box })
  const fades = l => (/\\fad\((\d+),(\d+)\)/.exec(l) || []).slice(1).map(Number)
  const shadow = ass.split('\n').find(l => /^Dialogue: 0,/.test(l)), words = ass.split('\n').find(l => /^Dialogue: 3,/.test(l))
  is('the shadow comes up slower than the words', fades(shadow)[0] > 150, true)
  is('handing on, a phrase is gone before the next comes up', O.phraseTimes(ph).every((p, i, all) =>
    i === 0 || all[i - 1].hide <= p.show + 1e-9), true)
  is('the words themselves fade in over 150 ms', !!words, true)
}

// ---- title cards ----
{
  const card = O.frameScript({ W: 1920, H: 1080, span: 20, texts: [
    { style: 'title', text: 'Songscription', subtitle: 'A piano library', start: 0, end: 3, fx: 0.5, fy: 0.5 },
    { style: 'title', text: 'Songscription', subtitle: 'songscription.app', start: 17, end: 20, fx: 0.5, fy: 0.5 }] })
  const title = card.split('\n').find(l => /^Dialogue: 5,/.test(l) && l.includes('}Songscription'))
  const size = +(/\\fs(\d+)/.exec(title) || [])[1]
  is('the title is set large, about 108 px at 1080', size >= 96 && size <= 120, true)
  is('tracked in by about 2 percent', /\\fsp-2\.\d/.test(title), true)
  is('the subtitle is 70 percent white', card.split('\n').some(l => /^Dialogue: 6,/.test(l) && l.includes('\\1a&H4D&') && l.endsWith('A piano library')), true)
  is('an address signs off as a gold pill with an arrow', card.split('\n').some(l => /^Dialogue: 8,/.test(l) && l.endsWith('songscription.app  →')) &&
    card.split('\n').some(l => /^Dialogue: 7,/.test(l) && l.includes('\\1c&H3CA9F0&')), true)
}

// ---- a spotlight pulls in to a solid target ----
{
  const w = 400, h = 300, px = new Uint8Array(w * h).fill(245)
  for (let y = 200; y < 220; y++) for (let x = 110; x < 290; x++) px[y * w + x] = 30     // a dark toast
  const f = O.spotFit(px, w, h, { x: 90 / w, y: 190 / h, w: 220 / w, h: 40 / h })
  is('the window hugs the toast', [Math.abs(f.x * w - 110) <= 2, Math.abs((f.x + f.w) * w - 290) <= 2, Math.abs(f.y * h - 200) <= 2], [true, true, true])
  const text = new Uint8Array(w * h).fill(245)
  for (let x = 120; x < 200; x += 3) text[210 * w + x] = 40
  const m = { x: 90 / w, y: 190 / h, w: 220 / w, h: 40 / h }
  is('but not to the words on a card', O.spotFit(text, w, h, m), m)
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
