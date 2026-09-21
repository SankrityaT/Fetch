// Aiming an edit at what the person means (ui/targets.js): detections made into
// elements, elements ranked against their words, and a box made into the zoom that
// frames it. The detections here are shaped like Elements.swift's output on the
// Songscription take that went wrong: "zoom on the black chip" landed on the yellow
// "Pick for me" button.
const T = require('../ui/targets')
const FD = require('../ui/fetchdoc')

let pass = 0, fail = 0
const is = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}` +
    (ok ? '' : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`))
}
const near = (a, b, e = 0.002) => Math.abs(a - b) <= e

const TOAST = { x: 0.4194, y: 0.7859, w: 0.3494, h: 0.0415 }
const RAW = {
  width: 1600, height: 892,
  texts: [
    { text: 'Library', conf: 1, box: { x: 0.216, y: 0.04, w: 0.036, h: 0.02 }, bg: '#FBFAF7', bgShare: 0.95 },
    { text: 'Recently played 132', conf: 1, box: { x: 0.333, y: 0.157, w: 0.084, h: 0.02 }, bg: '#FFFFFF', bgShare: 0.9,
      container: { x: 0.3075, y: 0.148, w: 0.1169, h: 0.0404 }, outside: '#EFEDE8' },
    { text: 'Pick for me', conf: 1, box: { x: 0.653, y: 0.158, w: 0.049, h: 0.02 }, bg: '#FBE29A', bgShare: 0.9,
      container: { x: 0.6463, y: 0.1502, w: 0.0631, h: 0.037 }, outside: '#FBFAF7' },
    { text: 'Tonight: "Fantaisie-Impromptu (right hand)", a favorite you have not played yet.', conf: 0.5,
      box: { x: 0.43, y: 0.795, w: 0.33, h: 0.022 }, bg: '#141414', bgShare: 0.97, container: TOAST, outside: '#FBFAF7' },
    // two lines on one card come back as one element
    { text: 'Fantaisie-Impromptu (right hand)', conf: 1, box: { x: 0.75, y: 0.33, w: 0.2, h: 0.025 }, bg: '#FFFFFF', bgShare: 0.9,
      container: { x: 0.74, y: 0.31, w: 0.25, h: 0.12 }, outside: '#F4F2EE' },
    { text: 'Chopin', conf: 1, box: { x: 0.75, y: 0.37, w: 0.05, h: 0.02 }, bg: '#FFFFFF', bgShare: 0.9,
      container: { x: 0.741, y: 0.31, w: 0.249, h: 0.12 }, outside: '#F4F2EE' },
  ],
  rects: [
    { box: { x: 0.2613, y: 0.324, w: 0.0575, h: 0.0605 }, bg: '#101212', conf: 0.9 },   // a dark thumbnail
    { box: { x: 0.4190, y: 0.7855, w: 0.3500, h: 0.0420 }, bg: '#141414', conf: 0.8 },  // the toast again
  ],
}

console.log('elements')
const els = T.elementsFrom(RAW)
const toast = els.find(e => /^Tonight/.test(e.text))
is('ids run E1, E2... in reading order', els.map(e => e.id), els.map((_, i) => 'E' + (i + 1)))
is('the toast is one chip, box and all', [toast.kind, toast.box], ['chip', TOAST])
is('its fill is named black and dark', [toast.background.colour, toast.background.tone], ['black', 'dark'])
is('two lines on one card are one element', els.filter(e => /Chopin/.test(e.text)).map(e => e.text), ['Fantaisie-Impromptu (right hand) Chopin'])
is('a rectangle the toast already covers is not listed twice', els.filter(e => near(e.box.y, 0.786, 0.01)).length, 1)
is('a dark shape with no text is still offered', els.some(e => e.kind === 'shape' && e.background.colour === 'black'), true)

console.log('colour names')
is('near-black', T.colourName('#141414'), 'black')
is('the Pick for me yellow', T.colourName('#FBE29A'), 'yellow')
is('white', T.colourName('#FBFAF7'), 'white')
is('dark warm is brown, not orange', T.colourName('#5A3A1C'), 'brown')
is('luminance of white is 1', T.luminance('#FFFFFF'), 1)

console.log('queries')
const pq = q => { const p = T.parseQuery(q); return { colours: [...p.colours], kinds: [...p.kinds], words: p.words, phrase: p.phrase } }
is('an apostrophe is not a quote mark', pq("the user's black chip, it's the toast"),
  { colours: ['black'], kinds: ['chip'], words: ['user'], phrase: null })
is('a quoted label is words on the thing', pq('the "Pick for me" button').phrase, 'pick for me')
is('single quotes at word edges quote too', pq("the 'Pick for me' button").phrase, 'pick for me')
is('curly quotes too', pq('the yellow “Pick for me” button').words, ['pick', 'for', 'me'])
is('an apostrophe inside a quote stays in it', pq("the 'Tonight's pick' chip").phrase, "tonight's pick")

console.log('ranking')
const top = q => T.rank(els, q)[0].text.slice(0, 16)
is('"the black chip" is the toast', top('the black chip'), 'Tonight: "Fantai')
is('"pick for me" is the Pick for me button', top('pick for me'), 'Pick for me')
// the person's own request that went wrong: the section is where, the chip is what
is('the person\'s sentence lands on the toast', top('the pick for me section at 0:35 needs a zoom in on the chip'), 'Tonight: "Fantai')
is('"the chip in the Pick for me section" is the toast', top('the chip in the Pick for me section'), 'Tonight: "Fantai')
is('"the Pick for me section" alone is that section', top('the Pick for me section'), 'Pick for me')
is('a time in the request is not words on screen', pq('the chip at 0:35').words, [])
is('a shape is not a chip', T.rank(els, 'the black chip')[1].kind === 'shape' ? T.rank(els, 'the black chip')[1].score < 1.5 : true, true)
is('"the yellow button" is Pick for me', top('the yellow button'), 'Pick for me')
is('"the toast" is the toast', top('the toast'), 'Tonight: "Fantai')
is('the user\'s own words, apostrophes and all', top("the user's black chip, it's the toast"), 'Tonight: "Fantai')
is('words on the chip beat its colour', top('the Tonight chip'), 'Tonight: "Fantai')
is('no query keeps reading order', T.rank(els, '').map(e => e.id), els.map(e => e.id))

console.log('a box as a zoom')
const z = T.boxZoom(TOAST)
// 0.3494 wide with a quarter clear each side: 1 / (0.3494 * 1.5) = 1.91
is('fits the box with room around it', z.scale, 1.91)
is('centred across on the box', near(z.x, TOAST.x + TOAST.w / 2, 0.0001), true)
// the frame at 1.91x is 0.524 tall, so its centre can come no lower than 0.738
is('held inside the frame at the bottom edge', z.y, 0.7382)
is('the box is wholly in view', TOAST.y >= z.y - 0.5 / z.scale && TOAST.y + TOAST.h <= z.y + 0.5 / z.scale, true)
is('a tiny box stops at 2.6x', T.boxZoom({ x: 0.5, y: 0.5, w: 0.02, h: 0.02 }).scale, 2.6)
is('a big box still reads as a zoom, 1.2x', T.boxZoom({ x: 0.05, y: 0.05, w: 0.9, h: 0.9 }).scale, 1.2)
is('a tall box is fitted by its height', T.boxZoom({ x: 0.4, y: 0.2, w: 0.05, h: 0.4 }).scale, 1.72)
is('a small one keeps a quarter of its size clear', T.boxZoom({ x: 0.4, y: 0.4, w: 0.05, h: 0.12 }).scale, 2.6)
is('a details pane fills the zoom, not an empty column beside it', T.boxZoom({ x: 0.7475, y: 0.4597, w: 0.2257, h: 0.4183 }).scale, 2.13)
is('centred where it fits', T.boxZoom({ x: 0.4, y: 0.4, w: 0.2, h: 0.2 }), { x: 0.5, y: 0.5, scale: 2.6 })
is('a corner box is held in on both axes', T.boxZoom({ x: 0, y: 0, w: 0.4, h: 0.1 }), { x: 0.266, y: 0.266, scale: 1.88 })
is('not a box is no zoom', [T.boxZoom(null), T.boxZoom({ x: 0.1, y: 0.1, w: 0, h: 0.2 }), T.boxZoom(true)], [null, null, null])
is('a box spilling off the frame is cut to it', T.cleanBox({ x: 0.9, y: -0.1, w: 0.3, h: 0.3 }), { x: 0.9, y: 0, w: 0.09999999999999998, h: 0.3 })

console.log('box targets in the document')
const doc = FD.normalize({ zooms: [{ id: 'Z37', start: 35, end: 38.4, scale: 2, x: 0.61, y: 0.12, box: TOAST }] }, '/x/a.mov', 52)
is('a box wins over the old centre and scale', doc.zooms[0], { id: 'Z37', start: 35, end: 38.4, scale: 1.91, x: 0.5941, y: 0.7382 })
is('and is not kept, so dragging the zoom later is not undone', 'box' in doc.zooms[0], false)
const again = FD.normalize(doc, '/x/a.mov', 52)
is('normalising again changes nothing', again.zooms[0], doc.zooms[0])
const plain = FD.normalize({ zooms: [{ start: 1, end: 2, box: true }] }, '/x/a.mov', 5)
is('a zoom with a box that is not a box keeps the defaults', [plain.zooms[0].scale, plain.zooms[0].x], [1.8, 0.5])
const marks = FD.normalize({ marks: [
  { kind: 'blur', start: 0, end: 5, box: { x: 0.1, y: 0.2, w: 0.3, h: 0.05 } },
  { kind: 'step', start: 1, end: 5, box: { x: 0.4, y: 0.5, w: 0.1, h: 0.1 } },
] }, '/x/a.mov', 5).marks
is('a mark takes a box as its own region', [marks[0].x, marks[0].y, marks[0].w, marks[0].h, 'box' in marks[0]], [0.1, 0.2, 0.3, 0.05, false])
is('a step goes on the box\'s top left corner', [marks[1].x, marks[1].y, marks[1].w], [0.4, 0.5, undefined])
const text = FD.normalize({ texts: [{ text: 'Hi', box: true }] }, '/x/a.mov', 5).texts[0]
is('a text\'s box stays its pill switch', text.box, true)

console.log('panels and grids')
// The details pane at 21 s of the Songscription take: six stat cards in two columns
// inside one panel, found from its hairline edges (Elements.swift panels)
{
  const card = (label, x, y) => ({ text: label, conf: 1, box: { x: x + 0.008, y: y + 0.015, w: 0.03, h: 0.014 }, bg: '#FCFBF7', bgShare: 1,
    container: { x, y, w: 0.11, h: 0.09 }, outside: '#FFFFFF' })
  const raw = {
    width: 1600, height: 988,
    texts: [
      { text: 'Nuages gris (simplified)', conf: 1, box: { x: 0.745, y: 0.395, w: 0.142, h: 0.024 }, bg: '#FDFCF8', bgShare: 1 },
      card('KEY', 0.748, 0.522), card('TEMPO', 0.864, 0.522),
      card('METER', 0.748, 0.622), card('LENGTH', 0.864, 0.622),
      card('RANGE', 0.748, 0.722), card('HANDS', 0.864, 0.722),
    ],
    rects: [{ box: { x: 0.7363, y: 0.1852, w: 0.2488, h: 0.7905 }, bg: '#FCFBF7', conf: 0.9, edges: true }],
  }
  const E = T.elementsFrom(raw)
  const panel = E.find(e => e.kind === 'panel'), grid = E.find(e => e.kind === 'grid')
  const tempo = E.find(e => /TEMPO/.test(e.text) && e.kind === 'card')
  is('a container of cards is a panel', !!panel && near(panel.box.w, 0.2488), true)
  is('six cards in two columns are one grid', grid && [grid.cards, near(grid.box.x, 0.748), near(grid.box.y + grid.box.h, 0.812)], [6, true, true])
  is('each card stays its own element', E.filter(e => e.kind === 'card').length, 6)
  is('a card says it sits in the grid, the grid in the panel', [tempo.in, grid.in], [grid.id, panel.id])
  const picked = T.pick(E, 'the song details card', 3)
  is('asked for a details card, the panel is offered', picked.some(e => e.id === panel.id), true)
  is('the stat cards ask for the grid too', T.parseQuery('the stat cards').kinds.has('grid'), true)
  const two = T.elementsFrom({ ...raw, texts: [card('KEY', 0.748, 0.522), card('TEMPO', 0.864, 0.522)], rects: [] })
  is('two cards are not a grid', two.some(e => e.kind === 'grid'), false)
}

console.log('panels asked for by what they are')
// The frame at 22 s of the Songscription take: every word matches somewhere in the main
// panel and the sidebar ("SONG", "Your Song"), so "song details card" used to pick the
// whole main panel and put the details pane ninth
{
  const el = (id, kind, text, box) => ({ id, kind, text, box, background: { colour: 'white' }, confidence: 1 })
  const E = [
    el('E1', 'panel', "Sankritya's library Piano songscription Library 300 Folders No folders yet Jump back in Consolation No 3 Your Song (in G) River Flows in You", { x: 0.005, y: 0.012, w: 0.181, h: 0.977 }),
    el('E2', 'card', 'Library 300 songs 170:51 of music', { x: 0.1875, y: 0.0112, w: 0.3, h: 0.0717 }),
    el('E5', 'chip', '+ Add song', { x: 0.9025, y: 0.0314, w: 0.0688, h: 0.0348 }),
    el('E12', 'panel', 'KEY C LEVEL Easy All 300 Favorites 17 Recently played 131 SONG Bohemian Rhapsody Your Song (left hand) LENGTH', { x: 0.193, y: 0.085, w: 0.794, h: 0.906 }),
    el('E16', 'panel', 'Liszt Practice Listen KEY C major Declared in the file TEMPO 78 bpm Steady throughout METER 3/4', { x: 0.737, y: 0.096, w: 0.251, h: 0.881 }),
    el('E37', 'text', 'SONG', { x: 0.2613, y: 0.2758, w: 0.0225, h: 0.0135 }),
    el('E65', 'card', 'KEY C major Declared in the file', { x: 0.7488, y: 0.4742, w: 0.11, h: 0.0998 }),
    el('E88', 'text', 'Your Song (left hand)', { x: 0.3269, y: 0.6031, w: 0.1038, h: 0.0202 }),
  ]
  const top = q => T.rank(E, q)[0].id
  is('"song details card" is the pane docked on the right', top('song details card'), 'E16')
  is('so is "the details"', top('the details'), 'E16')
  is('"the sidebar" is the one on the left', top('the sidebar'), 'E1')
  is('a card that says the word beats the panel around it', top('the key card'), 'E65')
  is('a word that only starts the same is not a match', T.rank(E, 'song').find(e => e.id === 'E1').score < T.rank(E, 'song').find(e => e.id === 'E88').score, true)
}

console.log('lifts and spotlights an agent adds')
{
  const M47 = { id: 'M47', kind: 'spotlight', start: 21.2, end: 27.8, x: 0.75, y: 0.52, w: 0.226, h: 0.29 }
  const blur = { id: 'M3', kind: 'blur', start: 21, end: 28, x: 0.75, y: 0.52, w: 0.2, h: 0.2 }
  const lift = { kind: 'lift', start: 21, end: 27, box: { x: 0.7363, y: 0.1852, w: 0.2288, h: 0.7505 } }
  const r = FD.settleFocus([M47, blur], [M47, blur, lift])
  is('a new lift replaces the spotlight inside it', [r.marks.map(m => m.id || m.kind), r.replaced], [['M3', 'lift'], ['M47']])
  is('one elsewhere in time stays', FD.settleFocus([M47], [M47, { ...lift, start: 40, end: 44 }]).replaced, [])
  is('one elsewhere on screen stays', FD.settleFocus([M47], [M47, { ...lift, box: { x: 0.1, y: 0.1, w: 0.2, h: 0.1 } }]).replaced, [])
  is('sending the same list again changes nothing', FD.settleFocus([M47], [M47]).marks.length, 1)
  let err = null
  try { FD.settleFocus([], [{ id: 'M54', kind: 'lift', start: 21, end: 27, x: 0.737, y: 0.095, w: 0.253, h: 0.905 }]) } catch (e) { err = e.message }
  is('a lift run off the bottom of the frame is refused, saying why', /M54 runs to the right and bottom edge/.test(err || '') && /spotlight/.test(err), true)
  err = null
  // the song details pane as find_on_screen measured it: 1.25% from the right edge
  try { FD.settleFocus([], [{ kind: 'lift', start: 21, end: 27, box: { x: 0.7369, y: 0.0964, w: 0.2506, h: 0.8812 } }]) } catch (e) { err = e.message }
  is('so is one a hair inside the edge, which would sit flush with the video', /right and bottom edge/.test(err || ''), true)
  is('a spotlight there is fine', FD.settleFocus([], [{ kind: 'spotlight', start: 1, end: 2, x: 0.7, y: 0.1, w: 0.3, h: 0.9 }]).marks.length, 1)
  const old = { id: 'M9', kind: 'lift', start: 1, end: 2, x: 0, y: 0, w: 0.5, h: 0.5 }
  is('a lift already there is left alone', FD.settleFocus([old], [old]).marks.length, 1)

  // The agent sent every mark back without ids, as get_edit shows them (times to the
  // hundredth), plus a new lift: the old spotlight was counted as new and both stayed.
  const shown = m => { const { id, ...r } = m; return { ...r, start: Math.round(r.start * 100) / 100, end: Math.round(r.end * 100) / 100 } }
  const spot = { ...M47, start: 21.234, end: 27.808 }
  const s2 = FD.settleFocus([spot, blur], [shown(spot), shown(blur), lift])
  is('an id-less copy of the spotlight is still it, and the lift replaces it', s2.replaced, ['M47'])
  is('and the blur keeps its id', s2.marks.map(m => m.id || m.kind), ['M3', 'lift'])
  is('sent back with ids and rounded times, nothing reads as new', FD.settleFocus([spot], [{ ...shown(spot), id: 'M47' }, lift]).replaced, ['M47'])
  is('re-aimed with a box, the same id is a change', FD.sameItem(spot, { ...shown(spot), box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } }), false)
}

console.log('what a lift can raise')
{
  // The Songscription frame at 22 s: the details pane, scrolled so YOUR RECORD's cards
  // run out of its foot, and the stats grid and level card inside it
  const el = (id, kind, text, box, x = {}) => ({ id, kind, text, box, ...x })
  const all = [
    el('E12', 'panel', 'KEY C LEVEL Easy All 300', { x: 0.1931, y: 0.0852, w: 0.7944, h: 0.9058 }),
    el('E16', 'panel', 'Liszt Practice Listen KEY C major', { x: 0.7369, y: 0.0964, w: 0.2506, h: 0.8812 }, { in: 'E12' }),
    el('E40', 'card', 'Nuages gris (simplified)', { x: 0.7381, y: 0.3072, w: 0.2494, h: 0.0953 }, { in: 'E16' }),
    el('E65', 'card', 'KEY C major Declared in the file', { x: 0.7488, y: 0.4742, w: 0.11, h: 0.0998 }, { in: 'E66' }),
    el('E66', 'grid', 'KEY · TEMPO · METER', { x: 0.7488, y: 0.4742, w: 0.2268, h: 0.3195 }, { in: 'E16' }),
    el('E94', 'chip', 'About 13 bars', { x: 0.75, y: 0.639, w: 0.1088, h: 0.0437 }, { in: 'E65', text_box: { x: 0.7569, y: 0.648, w: 0.06, h: 0.017 } }),
    el('E126', 'card', 'Beginner', { x: 0.7887, y: 0.8117, w: 0.19, h: 0.0964 }, { in: 'E16' }),
    el('E142', 'text', 'YOUR RECORD', { x: 0.7469, y: 0.926, w: 0.0556, h: 0.0157 }, { in: 'E16' }),
    el('E144', 'text', 'PLAYED', { x: 0.7569, y: 0.9652, w: 0.0313, h: 0.0146 }, { in: 'E16' }),
  ]
  const by = id => all.find(e => e.id === id)
  is('the pane crowds the right and bottom edges', T.liftEdges(by('E16').box), ['right', 'bottom'])
  is('and its content runs out of its foot', T.cutEdges(by('E16'), all), ['bottom'])
  const b = T.liftBlock(by('E16'), all)
  is('so it is not lifted, and the stats grid inside it is offered', [!!b, b && b.instead.id], [true, 'E66'])
  is('the reason names both', /right and bottom edge/.test(b.why) && /cut off at its bottom/.test(b.why), true)
  is('it stands for the pane', b.share >= 0.2, true)
  is('the grid itself is fine', T.liftBlock(by('E66'), all), null)
  is('a chip whose fill hugs its card\'s foot is not cut-off content', T.cutEdges(by('E65'), all), [])
  is('a card flush with the right edge has nothing inside to offer', T.liftBlock(by('E40'), all).instead, null)

  const Bridge = require('../ui/agent-bridge')
  const seen = { at: 22, all, boxes: new Map(all.map(e => [e.id, e.box])) }
  let err = null
  try { Bridge.liftable(seen, { kind: 'lift', start: 21, end: 27, element: 'E16' }) } catch (e) { err = e.message }
  is('apply_edit refuses the pane by element, naming the grid', /Not lifting E16/.test(err || '') && /lift E66/.test(err), true)
  err = null
  try { Bridge.liftable(seen, { kind: 'lift', start: 21, end: 27, box: { ...by('E16').box } }) } catch (e) { err = e.message }
  is('and by its box', /Not lifting E16/.test(err || ''), true)
  is('the grid goes through', Bridge.liftable(seen, { kind: 'lift', start: 21, end: 27, element: 'E66' }), undefined)
  err = null
  // moving a lift by a bare box used to skip this check, so a lift dragged onto the
  // pane by an agent that had read its box went through without a word
  try { Bridge.liftable(seen, { id: 'M9', kind: 'lift', start: 1, end: 2, box: by('E16').box }) } catch (e) { err = e.message }
  is('a lift already in the edit, moved onto the pane, is judged too', /Not lifting E16/.test(err || ''), true)
  is('and one moved onto something liftable is not', Bridge.liftable(seen, { id: 'M9', kind: 'lift', start: 1, end: 2, box: by('E66').box }), undefined)
}

console.log('what a lift can raise on a still of one window')
{
  // The library window as take_shot captured it: a grid of song cards, each with its
  // duration set hard against its own right padding, and the grid scrolled so the last
  // row runs out of its foot. Asked for "the row that matters", find_on_screen marked
  // the card the person meant no_lift, saying its content was cut off at its right. It
  // is not: 0:19 is a label sitting one padding in. The rule was reading the gap as a
  // share of the frame, so a card, which is a fifth of a still of one window, had to
  // hold its own label 17 px clear of itself to count as whole.
  const r4 = n => Math.round(n * 10000) / 10000
  // the window's own layout, in the window's own pixels
  const lay = [
    ['E60', 'grid', 'Jump back in', [680, 300, 2140, 1360], null],
    ['E69', 'card', 'Someone Like You (in G) 0:19', [680, 700, 1040, 172], 'E60'],
    ['E70', 'text', 'Someone Like You (in G)', [736, 740, 560, 34], 'E69'],
    ['E71', 'text', '0:19', [1620, 748, 84, 24], 'E69'],          // right-aligned, 16 px in
    ['E72', 'card', 'Nocturne in E flat major, Op', [1780, 700, 1040, 172], 'E60'],
    ['E73', 'text', 'Nocturne in E flat', [1836, 740, 500, 34], 'E72'],
    ['E74', 'text', 'major, Op', [2360, 740, 470, 34], 'E72'],     // and the rest of it cut off
    ['E76', 'card', 'Clair de lune', [680, 1600, 1040, 172], 'E60'],
    ['E77', 'text', 'Clair de lune', [736, 1650, 560, 34], 'E76'],  // runs out of the grid's foot
  ]
  // the same window in two frames: the still, where the frame is the window itself, and
  // a recording of a whole screen with the window sitting inside it
  const frame = (fw, fh, ox, oy) => lay.map(([id, kind, text, [x, y, w, h], within]) => ({
    id, kind, text, in: within,
    box: { x: r4((ox + x) / fw), y: r4((oy + y) / fh), w: r4(w / fw), h: r4(h / fh) },
  }))
  const shot = frame(2880, 1720, 0, 0)
  const screen = frame(3840, 2160, 480, 220)
  const by = (list, id) => list.find(e => e.id === id)

  is('a duration held one padding in is a label, not a cut', T.cutEdges(by(shot, 'E69'), shot), [])
  is('so the card the person meant is lifted', T.liftBlock(by(shot, 'E69'), shot), null)
  is('a title the card really does cut off still says so', T.cutEdges(by(shot, 'E72'), shot), ['right'])
  is('and that card is still refused', !!T.liftBlock(by(shot, 'E72'), shot), true)
  // the answer is about the card and its type, so where the window sits is not part of it
  is('the same card in a frame of the whole screen answers the same', [
    T.cutEdges(by(screen, 'E69'), screen), T.cutEdges(by(screen, 'E72'), screen)], [[], ['right']])

  const grid = T.liftBlock(by(shot, 'E60'), shot)
  is('the scrolled grid is still refused, for its edge and for its foot',
    /right edge of the frame/.test(grid.why) && /cut off at its right and bottom/.test(grid.why), true)
  is('and the whole card is what it offers to lift', grid.instead.id, 'E69')
  is('one card does not stand for a grid of them, so it is offered as an example', grid.share < 0.2, true)

  const Bridge = require('../ui/agent-bridge')
  const seen = { at: 0, all: shot, boxes: new Map(shot.map(e => [e.id, e.box])) }
  const lift = { kind: 'lift', start: 0, end: 0 }
  is('apply_edit lifts it', Bridge.liftable(seen, { ...lift, element: 'E69' }), undefined)
  let err = null
  try { Bridge.liftable(seen, { ...lift, element: 'E60' }) } catch (e) { err = e.message }
  is('and refuses the grid by name, naming the card', /Not lifting E60/.test(err || '') && /E69/.test(err || ''), true)

  // the handset crop whose own text runs off its right edge: the refusal that is right
  const phone = [
    { id: 'E1', kind: 'panel', text: 'Recently played 131', box: { x: 0, y: 0, w: 1, h: 1 } },
    { id: 'E5', kind: 'text', text: 'Recently played 131', in: 'E1', box: { x: 0.7, y: 0.1744, w: 0.3, h: 0.0151 } },
    { id: 'E6', kind: 'text', text: 'All 300', in: 'E1', box: { x: 0.75, y: 0.3488, w: 0.23, h: 0.014 } },
  ]
  is('a portrait capture cut off at its right is still refused', T.cutEdges(phone[0], phone), ['right'])
  is('and a label 16 px inside that same edge is not the reason', T.cutEdges({ ...phone[0] }, [phone[0], phone[2]]), [])
}

console.log('when to look at what an edit placed')
{
  const Bridge = require('../ui/agent-bridge')
  const prev = { zooms: [{ id: 'Z1', start: 5, end: 8, x: 0.5, y: 0.5, scale: 2 }], marks: [] }
  const doc = { zooms: [...prev.zooms, { id: 'Z38', start: 35, end: 38, x: 0.6, y: 0.8, scale: 1.91 }],
    marks: [{ id: 'M60', kind: 'spotlight', start: 35, end: 38, x: 0.4, y: 0.78, w: 0.35, h: 0.04 }] }
  is('a new 3 s zoom is looked at once landed and in its middle, the old one not at all', Bridge.checkTimes(FD, prev, doc), [36, 36.5])
  is('nothing new, nothing to check', Bridge.checkTimes(FD, doc, doc), [])
}

console.log('ids an agent leaves off')
{
  const marks = [45, 46, 47].map((n, i) => ({ id: 'M' + n, kind: 'step', start: i * 3, end: i * 3 + 2, x: 0.1 * i, y: 0.2, n: i + 1 }))
  const doc = FD.normalize({ marks, nextId: { M: 53 } }, '/x', 20)
  const bare = marks.map(({ id, ...r }) => r)
  const after = FD.normalize(FD.mergeDoc(doc, { marks: [...bare, { kind: 'lift', start: 10, end: 12, x: 0.3, y: 0.3, w: 0.2, h: 0.2 }] }), '/x', 20)
  is('adding one mark keeps every other mark\'s id', after.marks.map(m => m.id), ['M45', 'M46', 'M47', 'M53'])
  is('a moved one is new', FD.adoptIds(marks, [{ ...bare[0], x: 0.5 }])[0].id, undefined)
  is('two copies of one take its id once', FD.adoptIds(marks, [bare[1], bare[1]]).map(m => m.id), ['M46', undefined])
  is('an id already sent is not handed out again', FD.adoptIds(marks, [marks[0], { ...bare[0] }]).map(m => m.id), ['M45', undefined])
  const zooms = [{ id: 'Z4', start: 34.6, end: 41.5, scale: 1.8, x: 0.594, y: 0.807 }]
  is('zooms too', FD.adoptIds(zooms, [{ start: 34.6, end: 41.5, scale: 1.8, x: 0.594, y: 0.807 }])[0].id, 'Z4')
  is('but not one named by element', FD.adoptIds(zooms, [{ start: 34.6, end: 41.5, element: 'E129' }])[0].id, undefined)
}

console.log('lifts and spotlights left on top of each other')
{
  const spot = { id: 'M47', kind: 'spotlight', start: 21.2, end: 27.8, x: 0.737, y: 0.096, w: 0.251, h: 0.3 }
  const lift = { id: 'M62', kind: 'lift', start: 21.9, end: 27, x: 0.74, y: 0.35, w: 0.24, h: 0.5 }
  is('a spotlight across a lifted card is named', FD.focusClashes([spot, lift]), [{ a: 'M47', b: 'M62', kinds: ['spotlight', 'lift'], start: 21.9, end: 27 }])
  is('apart in time they are fine', FD.focusClashes([spot, { ...lift, start: 30, end: 33 }]), [])
  is('a blur is not a focus effect', FD.focusClashes([{ ...spot, kind: 'blur' }, lift]), [])
  const z = [{ id: 'Z37', start: 35, end: 38.4 }, { id: 'Z40', start: 34.6, end: 41.5 }, { id: 'Z41', start: 42, end: 44 }]
  is('a zoom added over another is named', FD.zoomClashes(z), [{ a: 'Z40', b: 'Z37', start: 35, end: 38.4 }])
}

console.log('a spotlight left playing with a re-aimed zoom')
// Re-aiming Z37 onto the chip kept M53, the spotlight nobody had asked for, unmentioned
{
  const m53 = { id: 'M53', kind: 'spotlight', start: 35, end: 38.7, x: 0.417, y: 0.785, w: 0.354, h: 0.042 }
  const blur = { id: 'M45', kind: 'blur', start: 0, end: 52, x: 0.04, y: 0.02, w: 0.1, h: 0.05 }
  const prev = { zooms: [{ id: 'Z37', start: 35, end: 38.4, scale: 2, x: 0.61, y: 0.12 }], marks: [blur, m53] }
  const aimed = { zooms: [{ id: 'Z37', start: 35, end: 38.4, scale: 1.91, x: 0.5941, y: 0.7382 }], marks: [blur, m53] }
  is('it is named with the zoom', FD.focusAlongside(prev, aimed), [{ id: 'M53', kind: 'spotlight', start: 35, end: 38.7, zoom: 'Z37' }])
  is('an untouched zoom names nothing', FD.focusAlongside(prev, prev), [])
  is('nor a spotlight at another time', FD.focusAlongside(prev, { ...aimed, marks: [{ ...m53, start: 40, end: 44 }] }), [])
  is('nor with no edit before it', FD.focusAlongside(null, aimed), [])
}

console.log('when a box holds its element')
// The details pane opens at 20.9 s, but the lift was timed to the sentence at 20.19 s:
// until then its box shows the song table under it
{
  const pic = v => new Uint8Array(768).fill(v)
  const span = (from, to, f) => { const out = []; for (let t = from; t < to - 1e-9; t += 0.1) out.push({ t: Math.round(t * 100) / 100, v: pic(f(t)) }); return out }
  const opens = span(20.19, 28.38, t => t < 20.89 ? 60 : 200)
  is('a lift is held to when the card has opened', T.presentSpan(opens, 20.19, 28.38), { start: 20.89, end: 28.38, moved: true, present: true })
  const closes = span(27, 34, t => t < 32.45 ? 200 : 145)
  is('and ends when it closes', T.presentSpan(closes, 27, 34).end, 32.4)
  const typing = span(11, 17, t => 200 + Math.round((t - 11) * 1.5))
  is('small changes inside (typing, a playhead) move nothing', T.presentSpan(typing, 11, 17).moved, false)
  const flicker = span(20, 24, t => Math.abs(t - 20.3) < 0.05 ? 60 : 200)
  is('one odd frame at the start is not an absence', T.presentSpan(flicker, 20, 24).start <= 20.4, true)
  const churn = span(0, 4, t => Math.round(t * 10) % 2 ? 20 : 220)
  is('a box that never holds one picture says so', T.presentSpan(churn.map((x, i) => ({ ...x, v: pic((i * 37) % 255) })), 0, 4).present, false)
}

console.log('what to call an area whose middle holds nothing')
// Reported from the app: a box drawn tight round a few words read "Area". Only the
// elements whose middle the box held could name it, and a tight box holds none.
{
  const SCREEN = [
    { id: 'E1', kind: 'panel', text: 'Library', box: { x: 0.04, y: 0.06, w: 0.62, h: 0.72 } },
    { id: 'E2', kind: 'card', text: 'Details', box: { x: 0.08, y: 0.5, w: 0.3, h: 0.2 } },
    { id: 'E3', kind: 'text', text: 'Recently played 132', box: { x: 0.1, y: 0.12, w: 0.24, h: 0.024 } },
    { id: 'E4', kind: 'chip', text: 'Export', box: { x: 0.42, y: 0.12, w: 0.12, h: 0.05 } },
    { id: 'E5', kind: 'chip', text: 'Share', box: { x: 0.7, y: 0.12, w: 0.1, h: 0.05 } },
    { id: 'E6', kind: 'chip', text: 'Delete', box: { x: 0.82, y: 0.12, w: 0.1, h: 0.05 } },
  ]
  const label = b => T.regionLabel(b, SCREEN, null)
  is('a box drawn inside a card is that card', label({ x: 0.15, y: 0.56, w: 0.06, h: 0.04 }), 'Details')
  // the card is inside the panel, and both hold the whole box: the tighter one is meant
  is('not the panel the card sits in', label({ x: 0.15, y: 0.56, w: 0.06, h: 0.04 }) === 'Library', false)
  // a line of words is never snapped to, but it is exactly what a box round it is called
  is('a box round part of a line of text is that line', label({ x: 0.12, y: 0.122, w: 0.05, h: 0.02 }), 'Recently played 132')
  is('a box across two chips is the one it covers more of', label({ x: 0.76, y: 0.13, w: 0.09, h: 0.03 }), 'Share')
  is('and the answer does not turn on the order the elements arrive in',
    T.regionLabel({ x: 0.76, y: 0.13, w: 0.09, h: 0.03 }, [...SCREEN].reverse(), null), 'Share')
  is('a box over nothing at all is still Area', label({ x: 0.75, y: 0.86, w: 0.1, h: 0.08 }), 'Area')
  is('and a box that only clips two edges is too', label({ x: 0.795, y: 0.165, w: 0.06, h: 0.05 }), 'Area')
  // what it could already do, unchanged
  is('a box drawn round things is the longest of them', label({ x: 0.06, y: 0.1, w: 0.52, h: 0.12 }), 'Recently played 132')
  is('a box snapped to an element is that element', T.regionLabel(SCREEN[3].box, SCREEN, 'E4'), 'Export')
  const quiet = [{ id: 'E1', kind: 'panel', text: '', box: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } }]
  is('a box inside something with nothing written on it stays honest', T.regionLabel({ x: 0.2, y: 0.2, w: 0.05, h: 0.05 }, quiet, null), 'Area')
  is('a box that is not a box is Area', T.regionLabel({ x: 0.2, y: 0.2, w: 0, h: 0.05 }, SCREEN, null), 'Area')
}

console.log('the same control keeps the same id')
// The judged simulator job: ready listed "Sign in with Apple" as E18, record_start took
// its own picture of the same, unchanged screen and listed it as E17, and the tap sent
// with E18 was refused. One small thing above it (a tooltip over the Simulator toolbar)
// was on the first picture and not the second, and every id below it moved up by one.
{
  const words = (text, x, y, w, h = 0.018) => ({ text, conf: 1, box: { x, y, w, h }, bg: '#FFFFFF', bgShare: 0.9 })
  const chip = (text, x, y, w, h = 0.018, pad = 0.012) => ({ ...words(text, x, y, w, h),
    container: { x: x - pad, y: y - pad, w: w + 2 * pad, h: h + 2 * pad }, bg: '#111111', outside: '#FFFFFF' })
  const at = (list, name) => list.find(e => e.text === name)
  const idOf = (list, name) => (at(list, name) || {}).id
  // the Simulator window: its toolbar, the device's status bar, then the app's sign-in
  const toolbar = [words('Yolk-ProMax', 0.05, 0.012, 0.1), words('iOS 26.5', 0.05, 0.03, 0.06),
    chip('Home', 0.8, 0.015, 0.03), chip('Rotate', 0.88, 0.015, 0.04)]
  const app = [
    words('9:41', 0.1, 0.07, 0.04),
    words('Yolk', 0.44, 0.2, 0.12, 0.04),
    words('Breakfast, planned for you', 0.3, 0.26, 0.4),
    words('Recipes for the week', 0.2, 0.34, 0.3), words('Grocery list', 0.2, 0.38, 0.2),
    words('Leftovers', 0.2, 0.42, 0.15), words('Pantry', 0.2, 0.46, 0.12),
    words('Reminders', 0.2, 0.5, 0.16), words('Family sharing', 0.2, 0.54, 0.22),
    words('Nutrition', 0.2, 0.58, 0.14),
    chip('Continue with Google', 0.3, 0.7, 0.4), words('or', 0.49, 0.735, 0.02),
    chip('Sign in with Apple', 0.3, 0.77, 0.4),
    words('Terms', 0.3, 0.85, 0.08), words('Privacy', 0.6, 0.85, 0.1),
  ]
  const tip = words('Save screen', 0.8, 0.05, 0.08)
  const READY = { width: 1400, height: 2900, texts: [...toolbar, tip, ...app] }
  const RECORD = { width: 1400, height: 2900, texts: [...toolbar, ...app] }
  const ready = T.elementsFrom(READY)
  is('ready lists Sign in with Apple as E18, as it did in the job', idOf(ready, 'Sign in with Apple'), 'E18')
  is('numbered afresh, record_start\'s picture would call it E17', idOf(T.elementsFrom(RECORD), 'Sign in with Apple'), 'E17')
  const record = T.elementsFrom(RECORD, ready)
  is('carried from ready, it is still E18', idOf(record, 'Sign in with Apple'), 'E18')
  is('and so is everything else that did not change',
    record.every(e => e.id === idOf(ready, e.text)), true)
  is('the id of the tooltip that went is not handed to anything', record.some(e => e.id === idOf(ready, 'Save screen')), false)
  is('ids on one picture are still one each', new Set(record.map(e => e.id)).size, record.length)
  is('reading order is still the order of the list', record.map(e => e.text), T.elementsFrom(RECORD).map(e => e.text))
  // the same button a second time, after a tap, with nothing changed at all
  const again = T.elementsFrom(RECORD, record)
  is('a third picture of the same screen changes nothing', again.map(e => e.id), record.map(e => e.id))

  // Something appears above and pushes the rest down: a banner, an error, a keyboard bar
  const shift = 0.06
  const down = t => ({ ...t, box: { ...t.box, y: t.box.y + shift }, ...(t.container ? { container: { ...t.container, y: t.container.y + shift } } : {}) })
  const BANNER = { width: 1400, height: 2900, texts: [...toolbar, words('9:41', 0.1, 0.07, 0.04),
    chip('Check your email to finish signing up', 0.2, 0.12, 0.6), ...app.slice(1).map(down)] }
  const banner = T.elementsFrom(BANNER, record)
  is('a banner pushing the screen down renumbers nothing',
    ['Sign in with Apple', 'Continue with Google', 'Terms', 'Yolk', 'Rotate'].map(n => idOf(banner, n)),
    ['Sign in with Apple', 'Continue with Google', 'Terms', 'Yolk', 'Rotate'].map(n => idOf(record, n)))
  is('the banner is new, numbered past every id handed out', idOf(banner, 'Check your email to finish signing up'), 'E' + (record.seq + 1))
  is('everything else was carried', banner.carried, banner.length - 1)

  // An id held from any earlier picture means the same thing or nothing: the tooltip's
  // E-number, and the highest one of all, are never handed out again down the chain
  const NOAPPLE = { width: 1400, height: 2900, texts: [...toolbar, ...app.filter(t => t.text !== 'Privacy')] }
  const gone = T.elementsFrom(NOAPPLE, banner)
  const back = T.elementsFrom({ ...NOAPPLE, texts: [...NOAPPLE.texts, words('Help', 0.6, 0.85, 0.08)] }, gone)
  is('an element that went takes its id with it', gone.some(e => e.id === idOf(banner, 'Privacy')), false)
  is('a new one after it gets a number never used on this screen',
    [idOf(ready, 'Save screen'), idOf(banner, 'Check your email to finish signing up'), idOf(banner, 'Privacy')].includes(idOf(back, 'Help')), false)
  is('even when the list only came back through JSON', idOf(T.elementsFrom({ ...NOAPPLE, texts: [...NOAPPLE.texts, words('Help', 0.6, 0.85, 0.08)] },
    JSON.parse(JSON.stringify(banner))), 'Help'), 'E' + (Math.max(...banner.map(e => +e.id.slice(1))) + 1))

  // Two different buttons wrongly sharing an id is worse than one changing its id
  const OTHER = { width: 1400, height: 2900, texts: [...toolbar, words('Welcome back', 0.3, 0.2, 0.4, 0.04),
    chip('Sign in with Apple', 0.05, 0.12, 0.25, 0.012)] }
  const other = T.elementsFrom(OTHER, record)
  is('the same words at another size are another control', idOf(other, 'Sign in with Apple') === idOf(record, 'Sign in with Apple'), false)
  const renamed = T.elementsFrom({ ...RECORD, texts: RECORD.texts.map(t => t.text === 'Sign in with Apple' ? { ...t, text: 'Signed in with Apple' } : t) }, record)
  is('a label that changed is a new element', idOf(renamed, 'Signed in with Apple') === idOf(record, 'Sign in with Apple'), false)
  const turned = T.elementsFrom({ ...RECORD, width: 2900, height: 1400 }, record)
  is('a picture of another shape carries nothing', turned.carried, 0)
  is('and still numbers past what was handed out', Math.min(...turned.map(e => +e.id.slice(1))), record.seq + 1)
  const lost = T.elementsFrom({ ...RECORD, texts: RECORD.texts.map(t => t.text === 'Sign in with Apple' ? { ...t, container: undefined } : t) }, record)
  is('a button whose fill Vision missed this time is the same button', idOf(lost, 'Sign in with Apple'), idOf(record, 'Sign in with Apple'))

  // The same words on every row: a "Delete" per person. A scroll by exactly one row puts
  // Bob's Delete where Alice's was, and it must stay Bob's.
  const rows = (names, y0) => names.flatMap((n, i) => [words(n, 0.1, y0 + i * 0.06, 0.2), chip('Delete', 0.75, y0 + i * 0.06, 0.1)])
  const LIST = { width: 1400, height: 2900, texts: [words('People', 0.1, 0.1, 0.2, 0.03), ...rows(['Alice', 'Bob', 'Carol'], 0.3)] }
  const list = T.elementsFrom(LIST)
  const deletes = l => l.filter(e => e.text === 'Delete').sort((a, b) => a.box.y - b.box.y).map(e => e.id)
  const moved = T.elementsFrom({ ...LIST, texts: [LIST.texts[0], ...rows(['Bob', 'Carol', 'Dave'], 0.3)] }, list)
  is('scrolled one row, the names keep their ids', ['Bob', 'Carol'].map(n => idOf(moved, n)), ['Bob', 'Carol'].map(n => idOf(list, n)))
  is('each Delete keeps its own row\'s id, not the one of the row that was there', deletes(moved).slice(0, 2), deletes(list).slice(1))
  is('Dave\'s Delete is new', list.some(e => e.id === deletes(moved)[2]), false)
  // A row action moved from Alice's row to Carol's, and every name stayed where it was.
  // "Delete" is unique on both pictures and moved 0.16 of the frame on its own, past two
  // rows that did not move: it is Carol's Delete, and holding Alice's id must not reach it.
  const people = ['Alice', 'Bob', 'Carol', 'Dave'].map((n, i) => words(n, 0.1, 0.3 + i * 0.08, 0.15))
  const head = [words('9:41', 0.1, 0.02, 0.04), words('Contacts', 0.4, 0.1, 0.2, 0.03)]
  const onAlice = T.elementsFrom({ width: 1400, height: 2900, texts: [...head, ...people, chip('Delete', 0.75, 0.3, 0.12)] })
  const onCarol = T.elementsFrom({ width: 1400, height: 2900, texts: [...head, ...people, chip('Delete', 0.75, 0.46, 0.12)] }, onAlice)
  is('a lone control that moved past rows that stayed is a new one', idOf(onCarol, 'Delete') === idOf(onAlice, 'Delete'), false)
  is('and the rows that stayed keep theirs', ['Alice', 'Carol'].map(n => idOf(onCarol, n)), ['Alice', 'Carol'].map(n => idOf(onAlice, n)))
  // the same, with a second action riding along: two that moved together still passed rows that did not
  const pair = y => [chip('Delete', 0.75, y, 0.12), chip('Archive', 0.55, y, 0.12)]
  const twoA = T.elementsFrom({ width: 1400, height: 2900, texts: [...head, ...people, ...pair(0.3)] })
  const twoC = T.elementsFrom({ width: 1400, height: 2900, texts: [...head, ...people, ...pair(0.46)] }, twoA)
  is('nor does a pair of them that moved together', ['Delete', 'Archive'].some(n => idOf(twoC, n) === idOf(twoA, n)), false)
  // a sheet sliding up over nothing that stayed keeps its words
  const SHEET = y => ({ width: 1400, height: 2900, texts: [...head, words('Share to', 0.1, y, 0.2), chip('Copy link', 0.1, y + 0.05, 0.3)] })
  const s1 = T.elementsFrom(SHEET(0.8)), s2 = T.elementsFrom(SHEET(0.62), s1)
  is('a sheet that slid up past nothing that stayed keeps its ids', ['Share to', 'Copy link'].map(n => idOf(s2, n)), ['Share to', 'Copy link'].map(n => idOf(s1, n)))

  // with nothing unique on screen to say how it moved, repeated words are not guessed at
  const bare = { width: 1400, height: 2900, texts: [0, 1, 2].map(i => chip('Delete', 0.75, 0.3 + i * 0.06, 0.1)) }
  const bare1 = T.elementsFrom(bare)
  const bare2 = T.elementsFrom({ ...bare, texts: bare.texts.map(t => ({ ...t, box: { ...t.box, y: t.box.y + 0.03 }, container: { ...t.container, y: t.container.y + 0.03 } })) }, bare1)
  is('repeated words half a row away are not matched by guess', bare2.carried, 0)
  is('the same repeated words where they were are', T.elementsFrom(bare, bare1).map(e => e.id), bare1.map(e => e.id))

  // a card says what it sits in by the ids the list now carries
  const card = (label, x, y) => ({ text: label, conf: 1, box: { x: x + 0.008, y: y + 0.015, w: 0.03, h: 0.014 }, bg: '#FCFBF7', bgShare: 1,
    container: { x, y, w: 0.11, h: 0.09 }, outside: '#FFFFFF' })
  const PANE = { width: 1600, height: 988, texts: [card('KEY', 0.748, 0.522), card('TEMPO', 0.864, 0.522),
    card('METER', 0.748, 0.622), card('LENGTH', 0.864, 0.622), card('RANGE', 0.748, 0.722), card('HANDS', 0.864, 0.722)],
    rects: [{ box: { x: 0.7363, y: 0.1852, w: 0.2488, h: 0.7905 }, bg: '#FCFBF7', conf: 0.9, edges: true }] }
  const pane1 = T.elementsFrom(PANE)
  const pane2 = T.elementsFrom({ ...PANE, texts: [{ text: 'Now playing', conf: 1, box: { x: 0.75, y: 0.2, w: 0.1, h: 0.02 }, bg: '#FFFFFF', bgShare: 1 },
    ...PANE.texts.map(t => t.text === 'TEMPO' ? { ...t, text: 'TEMPO 96' } : t)] }, pane1)
  const kinds = l => ['panel', 'grid'].map(k => l.find(e => e.kind === k).id)
  is('a panel and a grid whose words changed inside are still themselves', kinds(pane2), kinds(pane1))
  is('and a card in it points at the carried grid', pane2.find(e => e.text === 'KEY').in, pane1.find(e => e.kind === 'grid').id)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
