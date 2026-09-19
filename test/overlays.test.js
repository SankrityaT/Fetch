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

const spoken = s => s.split(' ').map((w, i) => ({ text: w, start: i * 0.2, end: i * 0.2 + 0.2 }))
is('a long clause breaks where it balances, not before its last two words',
  O.captionPhrases(spoken('Pick for me chooses a favorite you haven\'t played yet.')).map(p => p.text),
  ['Pick for me chooses a favorite', 'you haven\'t played yet.'])
is('a break never parts "its own" from its noun',
  O.captionPhrases(spoken('And grid view shows every song as its own piano roll, so they are easy to tell apart.'))
    .every(p => !/\b(its|its own|every)$/.test(p.text)), true)

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
// lifts and spotlights change pixels (processor.js focusFilters), so draw nothing here
is('a spotlight is not an ASS drawing any more', /\\1c&H08090A&/.test(content), false)
is('nothing to draw is no script', O.contentScript({ W: 10, H: 10, marks: [] }), null)

// ---- lift and spotlight: the cutout ----
{
  const W = 2000, H = 1000
  // the Songscription toast, a dark pill, seen through a 1.9x zoom on a 1080 frame
  const toast = { kind: 'spotlight', x: 0.4194, y: 0.7848, w: 0.3494, h: 0.0426 }
  const s = O.focusShape(toast, W, H, { px: 1080 / H, seen: 1.9 })
  const bx = toast.x * W, by = toast.y * H, bw = toast.w * W, bh = toast.h * H
  is('a spotlight hugs its box: all of it inside, a few pixels of room',
    [s.x <= bx, s.y <= by, s.x + s.w >= bx + bw, s.y + s.h >= by + bh, bx - s.x < 4, by - s.y < 4], [true, true, true, true, true, true])
  is('a pill gets round ends', s.r, s.h / 2)
  is('the middle of the thing is untouched', O.focusAt(s, bx + bw / 2, by + bh / 2).a, 0)
  is('the whole box is clear, corners aside', O.focusAt(s, bx + bh, by + 0.5).a < 0.02, true)
  is('well away from it the frame is stepped back', O.focusAt(s, 10, 10), { a: 1, shade: 1 - O.SPOT_DIM, piece: 0 })
  is('a spotlight dims to about half', O.SPOT_DIM >= 0.4 && O.SPOT_DIM <= 0.5, true)
  // feathered: the edge takes several pixels to go from clear to dim, never a step
  const ramp = []
  for (let d = -8; d <= 8; d++) ramp.push(O.focusAt(s, bx + bw / 2, s.y + s.h + d).a)
  is('the edge is feathered, rising smoothly', [ramp.every((v, i) => !i || v >= ramp[i - 1] - 1e-9), ramp.filter(v => v > 0.02 && v < 0.98).length >= 3], [true, true])

  // The L: a card near the top right used to open its cutout right through the
  // frame's edges, which dimmed the frame in an L and cut across the header.
  const card = { kind: 'spotlight', x: 0.745, y: 0.02, w: 0.235, h: 0.44 }
  const c = O.focusShape(card, W, H)
  is('near the edge the cutout is still the box plus room, never snapped through the frame',
    [c.x > card.x * W - 20, c.y >= 0, c.x + c.w <= W, c.y + c.h < 0.5 * H], [true, true, true, true])
  is('above the card the frame is still dimmed, so no band or L', O.focusAt(c, (card.x + card.w / 2) * W, card.y * H + card.h * H + 40).a, 1)
  is('a card gets card corners, not a pill', c.r > 4 && c.r < 40, true)
  is('a measured corner radius is followed', O.focusShape(card, W, H, { radius: 22 }).r, 22 + 12 * H / 1080)

  // A lift: the element itself, raised
  const lift = { kind: 'lift', x: 0.749, y: 0.474, w: 0.227, h: 0.32 }
  const L = O.focusShape(lift, W, H)
  is('a lift grows no more than 2 percent, about its own centre', L.lift > 1.005 && L.lift <= 1.02, true)
  is('a lift dims the rest by about a third', L.dim >= 0.25 && L.dim <= 0.35, true)
  // a few pixels of page on every side, the same on each, so its border comes up whole
  const room = [lift.x * W - L.x, lift.y * H - L.y, L.x + L.w - (lift.x + lift.w) * W, L.y + L.h - (lift.y + lift.h) * H]
  is('a lift hugs its element with even room', room.every(v => v >= 3 && v <= 6) && Math.max(...room) - Math.min(...room) < 0.01, true)
  const mid = O.focusAt(L, L.x + L.w / 2, L.y + L.h / 2)
  is('the piece is opaque inside, gone outside', [mid.piece, O.focusAt(L, L.x - 3, L.y + L.h / 2).piece], [1, 0])
  const below = O.focusAt(L, L.x + L.w / 2, L.y + L.h + L.shadow.dy)
  const beside = O.focusAt(L, L.x - L.shadow.soft * 1.5, L.y + L.h / 2)
  const side = O.focusAt(L, L.x - L.shadow.dy, L.y + L.h / 2)
  is('a shadow falls under it, not beside it', [below.shade < side.shade * 0.85, beside.shade >= 1 - L.dim - 0.001], [true, true])
  // the page steps back softly: barely dimmed at the piece's edge, fully a way off
  const edge = O.focusAt({ ...L, shadow: { ...L.shadow, alpha: 0 } }, L.x - 2, L.y + L.h / 2).shade
  is('the dim is feathered from the piece, not a flat wash', [edge > 0.97, Math.abs(O.focusAt(L, 5, 5).shade - (1 - L.dim)) < 0.001], [true, true])
  is('a spotlight has no shadow and no rise', [s.shadow.alpha, s.lift], [0, 1])

  // The masks are drawn from ffmpeg expressions; they must be this same geometry
  const evalExpr = (e, X, Y) => Function('X', 'Y', 'hypot', 'max', 'min', 'abs', 'clip',
    'return ' + e)(X, Y, Math.hypot, Math.max, Math.min, Math.abs, (v, a, b) => Math.max(a, Math.min(b, v)))
  const pts = [[5, 5], [bx + 3, by + 2], [bx - 4, by + bh / 2], [bx + bw / 2, by + bh + 5], [bx + bw / 2, by + bh / 2]]
  const ex = O.focusExprs(s, 1), exL = O.focusExprs(L, 0.5), exP = O.focusExprs(L, 1, 100, 60)
  const close = (p, q) => Math.abs(p - q) < 1e-3
  is('the spotlight mask expression is focusAt', pts.every(([X, Y]) => close(evalExpr(ex.a, X, Y), O.focusAt(s, X, Y).a) && close(evalExpr(ex.shade, X, Y), O.focusAt(s, X, Y).shade)), true)
  const lp = [[L.x + L.w / 2, L.y + L.h + L.shadow.dy], [L.x - 30, L.y], [L.x + 10, L.y + 10]]
  is('the lift shade expression is focusAt, at half size', lp.every(([X, Y]) => close(evalExpr(exL.shade, X * 0.5, Y * 0.5), O.focusAt(L, X, Y).shade)), true)
  is('the piece mask is focusAt, in its own crop', lp.every(([X, Y]) => close(evalExpr(exP.piece, X - 100, Y - 60), O.focusAt(L, X, Y).piece)), true)

  // timing: in and out on the zoom's curve, and with a zoom on the same thing, as one move
  const tm = O.focusTiming({ start: 35, end: 38.7 }, [{ start: 35, end: 38.4 }])
  is('a spotlight with its zoom starts and ends with it', [tm.a, tm.b, tm.Tin, tm.Tout], [35, 38.4, O.ZOOM_EASE, O.ZOOM_EASE])
  is('it eases on the zoom curve', [O.focusLevel(tm, 35), +O.focusLevel(tm, 35 + O.ZOOM_EASE / 2).toFixed(3), O.focusLevel(tm, 36.5), O.focusLevel(tm, 38.4)], [0, 0.5, 1, 0])
}

// ---- a corner radius read off the picture ----
{
  // a dark rounded card of radius 12 on a light page
  const w = 120, h = 80, R = 12, px = new Uint8Array(w * h).fill(245)
  const X0 = 20, Y0 = 15, X1 = 99, Y1 = 64
  for (let y = Y0; y <= Y1; y++) for (let x = X0; x <= X1; x++) {
    const qx = Math.max(X0 + R - x, x - (X1 - R), 0), qy = Math.max(Y0 + R - y, y - (Y1 - R), 0)
    if (Math.hypot(qx, qy) <= R) px[y * w + x] = 30
  }
  const box = { x: X0 / w, y: Y0 / h, w: (X1 - X0 + 1) / w, h: (Y1 - Y0 + 1) / h }
  const r = O.cornerRadius(px, w, h, box)
  is('a card\'s own corner radius is measured', r > 9 && r < 15, true)
  is('a square corner reads as nearly none', O.cornerRadius(new Uint8Array(w * h).map((_, i) => {
    const x = i % w, y = (i / w) | 0; return x >= X0 && x <= X1 && y >= Y0 && y <= Y1 ? 30 : 245
  }), w, h, box) < 2, true)
  is('no contrast, no reading', O.cornerRadius(new Uint8Array(w * h).fill(200), w, h, box), null)
  // Precision suite: a stats grid of light cells whose 2px hairlines are the only thing
  // off the page, and a box that stops inside the top and right lines and on the bottom one
  {
    const w = 140, h = 120, g = new Uint8Array(w * h).fill(253)
    const line = (x0, y0, x1, y1) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) g[y * w + x] = 234 }
    line(9, 6, 130, 7); line(9, 110, 130, 111); line(9, 6, 10, 111); line(129, 6, 130, 111)
    const e = O.edgeFit(g, w, h, { x: 9 / w, y: 9 / h, w: (128 - 9 + 1) / w, h: (110 - 9 + 1) / h })
    is('a lift\'s box grows out over the grid\'s own hairlines', e && [e.x * w, e.y * h, (e.x + e.w) * w, (e.y + e.h) * h].map(Math.round), [9, 6, 131, 112])
    is('a box already round the lines stays', O.edgeFit(g, w, h, { x: 8 / w, y: 5 / h, w: 124 / w, h: 108 / h }), null)
    is('a gap wider than a line is not crossed', O.edgeFit(g, w, h, { x: 20 / w, y: 20 / h, w: 100 / w, h: 80 / h }), null)
  }
  is('a loose box measures nothing', O.cornerRadius(px, w, h, { x: (X0 - 4) / w, y: (Y0 - 4) / h, w: (X1 - X0 + 9) / w, h: (Y1 - Y0 + 9) / h }), null)
}
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
  // the opening title leaves as its ground starts to clear, overlapping the product's
  // scale-in by a beat so the handover is one move, never a pause on bare backdrop
  const f = O.frameScript({ W: 1920, H: 1080, texts: [{ text: 'Songscription · your piano library', fx: 0.5, start: 0.3, end: 4.2 }], span: 46.95 })
  const lastTitle = Math.max(...f.split('\n').filter(l => /^Dialogue: [56],/.test(l)).map(l => {
    const [h, m, s] = l.split(',')[2].split(':'); return +h * 3600 + +m * 60 + +s
  }))
  const hand = cs[0].b - O.cardLanding(cs[0])
  is('the opening title is leaving as the card hands over', lastTitle > hand && lastTitle <= hand + 0.12, true)
  // and the voice's captions wait for the handover, rather than naming the product twice
  const ph = [{ start: 1.0, end: 2.0, words: [] }, { start: 3.0, end: 4.8, words: [] }, { start: 5, end: 6, words: [] }]
  const clr = O.clearOfTitles(ph, cs)
  is('a caption under the opening card shows from the handover, one wholly under it is dropped',
    [clr.length, clr[0].from, clr[1].from], [2, hand, undefined])
  is('and phraseTimes honours it', O.phraseTimes(clr)[0].show, hand)
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

// ---- a step on a lifted card goes up with it ----
{
  const lift = { kind: 'lift', start: 1, end: 6, x: 0.5, y: 0.4, w: 0.3, h: 0.3 }
  const pos = marks => {
    const l = O.contentScript({ W: 1920, H: 1080, marks }).split('\n').find(l => /Fetch Rounded/.test(l))
    return /\\pos\(([\d.]+),([\d.]+)\)/.exec(l).slice(1).map(Number)
  }
  const step = { kind: 'step', start: 2, end: 6, x: 0.5, y: 0.4 }
  const [x0, y0] = pos([step]), [x1, y1] = pos([lift, step])
  const s = O.focusShape(lift, 1920, 1080)
  is('a badge on a lifted corner moves out with the corner', [x1 < x0, y1 < y0], [true, true])
  is('by the lift\'s own scale about its centre', Math.abs(x1 - (s.x + s.w / 2 + (0.5 * 1920 - s.x - s.w / 2) * s.lift)) < 0.2, true)
  is('a badge that comes in before the lift is up stays put', pos([lift, { ...step, start: 0.5 }])[0], pos([{ ...step, start: 0.5 }])[0])
  is('a badge elsewhere stays put', pos([lift, { ...step, x: 0.1 }])[0], pos([{ ...step, x: 0.1 }])[0])
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

// ---- a step badge sits on the card corner it names ----
{
  // two cards side by side with hairline edges, a gutter between them
  const w = 600, h = 400, px = new Uint8Array(w * h).fill(252)
  const card = (x0, y0, x1, y1) => {
    for (let x = x0; x <= x1; x++) { px[y0 * w + x] = 238; px[y1 * w + x] = 238 }
    for (let y = y0; y <= y1; y++) { px[y * w + x0] = 238; px[y * w + x1] = 238 }
  }
  card(100, 100, 280, 220); card(292, 100, 472, 220)
  const H = 400
  const a = O.stepCorner(px, w, h, { x: 103 / w, y: 97 / h }, H)
  is('a point a few pixels out finds the corner', Math.hypot(a.x * w - 100, a.y * h - 100) <= 1.5, true)
  const b = O.stepCorner(px, w, h, { x: 288 / w, y: 101 / h }, H)
  is('a point in the gutter finds the card to its right', Math.hypot(b.x * w - 292, b.y * h - 100) <= 1.5, true)
  is('open page has no corner', O.stepCorner(new Uint8Array(w * h).fill(252), w, h, { x: 0.5, y: 0.5 }, H), null)
  const g = O.stepGrid([{ x: 0.2, y: 0.25 }, { x: 0.5, y: 0.253 }, { x: 0.202, y: 0.6 }], 600, 400)
  is('badges on one row share a y, and one column an x', [g[0].y === g[1].y, g[0].x === g[2].x, g[1].x !== g[0].x], [true, true, true])
  is('a badge is sized for the finished frame through its zoom',
    [O.stepSize(1000, 0.5).D, O.stepSize(1000, 1).D, O.stepSize(1000).D], [120, 60, 46])
}

// ---- the window's own margin, trimmed so the frame has one corner ----
{
  // a pale 10 px gutter round a white page card with a grey hairline border
  const w = 400, h = 400, px = new Uint8Array(w * h).fill(236)
  for (let y = 10; y < h - 10; y++) for (let x = 10; x < w - 10; x++) px[y * w + x] = (x === 10 || y === 10 || x === w - 11 || y === h - 11) ? 200 : 252
  for (let x = 40; x < 200; x += 3) for (let y = 40; y < 50; y++) px[y * w + x] = 30
  const g = O.gutterInsets(px, w, h)
  is('a window gutter is found on every side', [g.l * w, g.t * h, g.r * w, g.b * h], [10, 10, 10, 10])
  // a flat page with no edge behind its margin is the product's own margin, kept
  const flat = new Uint8Array(w * h).fill(250)
  for (let x = 60; x < 300; x += 3) for (let y = 100; y < 110; y++) flat[y * w + x] = 30
  is('a plain margin with no edge behind it is kept', O.gutterInsets(flat, w, h), { l: 0, t: 0, r: 0, b: 0 })
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
