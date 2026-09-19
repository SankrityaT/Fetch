// Where on the frame an edit should land. An agent told "zoom on the black chip" used
// to look at one frame, guess coordinates and zoom on the wrong thing. Now it asks
// find_on_screen, which reads the frame with Vision (Elements.swift), and gets back
// numbered elements with boxes; a zoom or a mark then takes that box as it is.
//
// Three pure pieces: the raw detections made into elements, those elements ranked
// against what the person said, and a box turned into the zoom that frames it.
// No filesystem, no DOM: processor.js runs the helper, fetchdoc.js resolves boxes.

const round = n => Math.round(n * 10000) / 10000

// ── colour ──────────────────────────────────────────────────────────────────
function rgbOf(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''))
  return m ? m[1].match(/../g).map(v => parseInt(v, 16)) : null
}

// 0 to 1, weighted the way the eye reads brightness
function luminance(hex) {
  const c = rgbOf(hex)
  return c ? round((0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255) : null
}

const tone = hex => { const l = luminance(hex); return l == null ? null : l < 0.3 ? 'dark' : l > 0.72 ? 'light' : 'mid' }

// A name someone would say out loud: "black", "white", "yellow". Near-greys are named
// by lightness, anything with real colour by hue.
function colourName(hex) {
  const c = rgbOf(hex)
  if (!c) return null
  const [r, g, b] = c.map(v => v / 255)
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min
  const sat = max ? d / max : 0
  if (sat < 0.16 || d < 0.07) {
    if (max < 0.16) return 'black'
    if (max < 0.35) return 'dark grey'
    if (max < 0.75) return 'grey'
    if (max < 0.9) return 'light grey'
    return 'white'
  }
  let h = 0
  if (max === r) h = ((g - b) / d) % 6
  else if (max === g) h = (b - r) / d + 2
  else h = (r - g) / d + 4
  h = (h * 60 + 360) % 360
  if (max < 0.22) return 'black'
  // warm and dark reads as brown, not orange
  if (h >= 15 && h < 50 && max < 0.55) return 'brown'
  if (h < 15 || h >= 345) return 'red'
  if (h < 40) return 'orange'
  if (h < 66) return 'yellow'
  if (h < 150) return 'green'
  if (h < 190) return 'teal'
  if (h < 250) return 'blue'
  if (h < 290) return 'purple'
  return 'pink'
}

// ── elements ────────────────────────────────────────────────────────────────
const area = b => b.w * b.h
function iou(a, b) {
  const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
  const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
  const i = x * y
  return i ? i / (area(a) + area(b) - i) : 0
}
const inside = (p, b, slack = 0.004) => p.x >= b.x - slack && p.y >= b.y - slack &&
  p.x + p.w <= b.x + b.w + slack && p.y + p.h <= b.y + b.h + slack
const centre = b => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 })

// What the thing around a line of text is. A container hugging the text (a pill, a
// button, a toast) is a chip; one well beyond it is a card; a glyph or two on its own
// fill is an icon button.
function kindOf(textBox, cont, text) {
  if (!cont) return 'text'
  const short = String(text || '').replace(/\s+/g, '').length <= 2
  if (short && cont.w / Math.max(1e-6, cont.h) < 2.2) return 'icon'
  return cont.h <= textBox.h * 3.2 && cont.h < 0.1 ? 'chip' : 'card'
}

/**
 * Raw detections (Elements.swift) to elements an agent can pick from: E1, E2... in
 * reading order. Lines on one chip or card become one element, so the dark rounded
 * toast around "Tonight: ..." comes back as a single thing, box and all.
 */
function elementsFrom(raw) {
  const texts = (raw && raw.texts) || []
  const groups = []
  for (const t of texts) {
    if (!t || !t.box || !String(t.text || '').trim()) continue
    const cont = t.container || null
    const kind = kindOf(t.box, cont, t.text)
    const same = cont && groups.find(g => g.container && iou(g.container, cont) > 0.85)
    if (same) { same.lines.push(t); continue }
    groups.push({ container: cont, kind, lines: [t], bg: t.bg })
  }
  const out = groups.map(g => {
    g.lines.sort((a, b) => (Math.abs(a.box.y - b.box.y) > 0.006 ? a.box.y - b.box.y : a.box.x - b.box.x))
    const tb = g.lines.reduce((u, l) => union(u, l.box), null)
    const box = g.container || tb
    const conf = g.lines.reduce((n, l) => Math.min(n, l.conf == null ? 1 : l.conf), 1)
    return {
      text: g.lines.map(l => l.text).join(' '),
      kind: g.kind,
      box: roundBox(box),
      ...(g.container ? { text_box: roundBox(tb) } : {}),
      background: { hex: g.bg || null, luminance: luminance(g.bg), tone: tone(g.bg), colour: colourName(g.bg) },
      confidence: round(conf),
    }
  })
  // Shapes Vision found that no text container already covers: a panel, a card, a
  // thumbnail. Named by the text inside them, if any.
  const rects = ((raw && raw.rects) || []).filter(r => r && r.box)
  for (const r of rects) {
    if (area(r.box) < 0.002) continue
    if (out.some(e => iou(e.box, r.box) > 0.6)) continue
    // Vision reads a column of separate cards as one tall rectangle (TEMPO, LENGTH and
    // HANDS came back as one "card"); when the cards' own edges were found, and they
    // fill it, the rectangle is only them
    if (!r.edges) {
      const parts = rects.filter(o => o.edges && inside(o.box, r.box) && area(o.box) < area(r.box) * 0.8)
      if (parts.length >= 2 && parts.reduce((n, o) => n + area(o.box), 0) >= area(r.box) * 0.6) continue
    }
    const words = out.filter(e => e.kind !== 'card' && inside(e.text_box || e.box, r.box)).map(e => e.text)
    out.push({
      text: words.join(' ').slice(0, 160),
      kind: words.length ? 'card' : 'shape',
      box: roundBox(r.box),
      background: { hex: r.bg || null, luminance: luminance(r.bg), tone: tone(r.bg), colour: colourName(r.bg) },
      confidence: round(r.conf == null ? 1 : r.conf),
    })
  }
  // A container holding two or more cards or chips is a panel (a details pane, a
  // sidebar), the thing someone means by "the details card"
  for (const e of out) {
    if ((e.kind === 'card' || e.kind === 'shape') && area(e.box) >= 0.02 &&
        out.filter(o => o !== e && ['card', 'chip', 'icon'].includes(o.kind) && area(o.box) < area(e.box) * 0.6 && inside(o.box, e.box)).length >= 2) {
      e.kind = 'panel'
    }
  }
  out.push(...gridsOf(out))
  out.sort((a, b) => (Math.abs(a.box.y - b.box.y) > 0.01 ? a.box.y - b.box.y : a.box.x - b.box.x))
  const withIds = out.map((e, i) => ({ id: 'E' + (i + 1), ...e }))
  // what each one sits in, so an agent can step out from a card to its grid or panel
  for (const e of withIds) {
    const home = withIds.filter(o => o !== e && CONTAINERS.has(o.kind) && area(o.box) > area(e.box) * 1.2 && inside(e.box, o.box))
      .sort((a, b) => area(a.box) - area(b.box))[0]
    if (home) e.in = home.id
  }
  return withIds
}

const CONTAINERS = new Set(['card', 'panel', 'grid', 'chip'])

// Cards of one size in a row or a column with small gaps between them (a stats grid,
// a row of plans) are also offered together, as one grid. Nothing on screen draws that
// box, so it is the union of the cards.
function gridsOf(els) {
  const cards = els.filter(e => e.kind === 'card')
  const near = (a, b) => {
    const A = a.box, B = b.box
    const alike = Math.abs(A.w - B.w) <= 0.25 * Math.max(A.w, B.w) && Math.abs(A.h - B.h) <= 0.25 * Math.max(A.h, B.h)
    if (!alike) return false
    const gx = Math.max(A.x, B.x) - Math.min(A.x + A.w, B.x + B.w), gy = Math.max(A.y, B.y) - Math.min(A.y + A.h, B.y + B.h)
    const row = Math.abs(A.y - B.y) <= 0.015 && gx >= -0.003 && gx <= 0.03
    const col = Math.abs(A.x - B.x) <= 0.015 && gy >= -0.003 && gy <= 0.03
    return row || col
  }
  const seen = new Set(), out = []
  for (const c of cards) {
    if (seen.has(c)) continue
    const group = [c]
    seen.add(c)
    for (let i = 0; i < group.length; i++) {
      for (const o of cards) if (!seen.has(o) && near(group[i], o)) { seen.add(o); group.push(o) }
    }
    if (group.length < 3) continue
    const box = group.reduce((u, g) => union(u, g.box), null)
    // a panel or card already drawn round exactly these is that thing, not a new one
    if (els.some(e => iou(e.box, box) > 0.8)) continue
    group.sort((a, b) => (Math.abs(a.box.y - b.box.y) > 0.01 ? a.box.y - b.box.y : a.box.x - b.box.x))
    out.push({ text: group.map(g => g.text).join(' · ').slice(0, 160), kind: 'grid', box: roundBox(box),
      background: group[0].background, confidence: round(Math.min(...group.map(g => g.confidence || 1))), cards: group.length })
  }
  return out
}

function union(a, b) {
  if (!a) return { ...b }
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y)
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y }
}
const roundBox = b => ({ x: round(b.x), y: round(b.y), w: round(b.w), h: round(b.h) })

// ── ranking ─────────────────────────────────────────────────────────────────
// What each word someone might use asks of an element's fill
const COLOURS = {
  black: ['black'], dark: ['black', 'dark grey'], white: ['white'], light: ['white', 'light grey'],
  grey: ['grey', 'light grey', 'dark grey'], gray: ['grey', 'light grey', 'dark grey'],
  yellow: ['yellow'], gold: ['yellow', 'orange'], amber: ['orange', 'yellow'], orange: ['orange'],
  red: ['red'], green: ['green', 'teal'], teal: ['teal', 'green'], blue: ['blue'], purple: ['purple'],
  violet: ['purple'], pink: ['pink'], brown: ['brown'],
}
// ...and what each kind word asks of its shape
const KINDS = {
  chip: ['chip'], pill: ['chip'], badge: ['chip', 'icon'], tag: ['chip'], toast: ['chip'],
  notification: ['chip', 'card'], banner: ['chip', 'card'], snackbar: ['chip'], tooltip: ['chip'],
  button: ['chip', 'icon'], btn: ['chip', 'icon'], cta: ['chip'], icon: ['icon'],
  card: ['card', 'panel'], panel: ['panel', 'card'], section: ['panel', 'card', 'grid'], pane: ['panel'],
  grid: ['grid'], stats: ['grid', 'card'], details: ['panel', 'card'], thumbnail: ['shape', 'card'], image: ['shape', 'card'],
  picture: ['shape', 'card'], artwork: ['shape', 'card'], cover: ['shape', 'card'], row: ['card', 'chip'], box: ['card', 'chip'],
  sidebar: ['panel', 'card'], modal: ['panel', 'card'], dialog: ['panel', 'card'], popup: ['card', 'chip'], popover: ['card', 'chip'],
  label: ['text', 'chip'], heading: ['text'], title: ['text'], text: ['text'], link: ['text'],
}
const STOP = new Set(['the', 'a', 'an', 'on', 'in', 'at', 'of', 'to', 'that', 'this', 'with', 'and', 'for',
  'zoom', 'into', 'onto', 'thing', 'one', 'please', 'me', 'my', 'it', 'is', 'where', 'says', 'saying',
  'which', 'reads', 'shows', 'little', 'big', 'small', 'there', 'here', 'bit', 'part', 'area', 'spot', 'coloured', 'colored',
  'needs', 'need', 'zoomed', 'highlight', 'show', 'focus', 'add', 'put', 'so', 'we', 'can', 'see'])
// "the Pick for me section": words before one of these name the place the thing is in,
// not the thing, so the Pick for me button is not what "the chip in the Pick for me
// section" means
const PLACES = new Set(['section', 'area', 'part', 'region', 'bit'])
const EDGE = new Set(['the', 'a', 'an', 'in', 'on', 'at', 'of', 'from', 'under', 'near', 'by', 'inside', 'within', 'below', 'above'])

const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
const tokens = s => norm(s).split(/[^\p{L}\p{N}#]+/u).filter(Boolean)

// What a query asks for: the colours, the kinds and the words on the thing itself.
// Quoted text is words on the thing, always, even "Pick for me". A quote opens and
// closes only at a word's edge, so the apostrophes in "the user's chip, it's dark"
// are letters, not quote marks.
const QUOTE = /(^|[^\p{L}\p{N}])["“”'‘’]([^"“”]{2,}?)["“”'‘’](?=$|[^\p{L}\p{N}])/gu
function parseQuery(q) {
  const quoted = []
  const rest = String(q || '').replace(QUOTE, (_, pre, s) => { quoted.push(s); return pre + ' ' })
    // a time in the request ("at 0:35") is when, not what: it would match a "0:35" on screen
    .replace(/\b\d{1,2}:\d{2}(\.\d+)?\b/g, ' ')
  const colours = new Set(), kinds = new Set(), words = [], context = []
  let many = false
  const all = tokens(rest), skip = new Set()
  all.forEach((t, i) => {
    if (!PLACES.has(t)) return
    let j = i - 1
    while (j >= 0 && !EDGE.has(all[j]) && !PLACES.has(all[j])) j--
    if (j === i - 1) return
    for (let n = j + 1; n <= i; n++) skip.add(n)
    context.push(...all.slice(j + 1, i))
  })
  for (const [i, t] of all.entries()) {
    if (skip.has(i)) continue
    if (COLOURS[t]) COLOURS[t].forEach(c => colours.add(c))
    else if (KINDS[t] || KINDS[t.replace(/s$/, '')]) {
      (KINDS[t] || KINDS[t.replace(/s$/, '')]).forEach(k => kinds.add(k))
      // "the stat cards" is the cards together
      if (!KINDS[t] && ['card', 'chip', 'tile', 'box'].includes(t.replace(/s$/, ''))) { kinds.add('grid'); many = true }
    }
    // the "s" left of "user's" says nothing about the thing
    else if (!STOP.has(t) && (t.length > 1 || /\d/.test(t))) words.push(t)
  }
  for (const s of quoted) words.push(...tokens(s))
  // "the Pick for me section" on its own is asking for that section
  if (context.length && !colours.size && !kinds.size && !words.length && !quoted.length) {
    words.push(...context.filter(t => !STOP.has(t))); context.length = 0; KINDS.section.forEach(k => kinds.add(k))
  }
  // "the details card" is the pane a list item opens beside the list; "the sidebar" is
  // the one down the left. Both say where the thing is docked, not what it reads.
  const said = new Set(all)
  const side = ['details', 'detail', 'info', 'inspector', 'properties'].some(w => said.has(w)) ? 'right'
    : ['sidebar', 'nav', 'navigation'].some(w => said.has(w)) ? 'left' : null
  const whole = [...said].some(w => WHOLE_WORDS.has(w.replace(/s$/, '')))
  return { colours, kinds, words, phrase: quoted.length ? norm(quoted.join(' ')) : null, context, side, whole, many }
}

// A pane docked to one side of the frame: tall, narrow, against that edge
function sidePane(e) {
  const b = e.box
  if (!['panel', 'card'].includes(e.kind) || b.h < 0.45 || b.w > 0.42) return null
  return b.x + b.w >= 0.9 && b.x > 0.5 ? 'right' : b.x <= 0.1 && b.x + b.w < 0.5 ? 'left' : null
}
// Words for a container someone points at as a whole ("the details card"), and the
// least of the frame such a thing covers: a header strip is not a details pane
const WHOLE_WORDS = new Set(['panel', 'pane', 'section', 'sidebar', 'detail', 'inspector', 'modal', 'dialog'])
const WHOLE = 0.04

// How well an element's text carries the query's words, 0 to 1
function textScore(el, words, phrase) {
  const t = norm(el.text)
  if (!words.length && !phrase) return 0
  const have = tokens(t)
  // word for word, so punctuation the recogniser read ("Tonight: “Fantaisie") is no bar
  const said = phrase ? tokens(phrase).join(' ') : ''
  if (said && (' ' + have.join(' ') + ' ').includes(' ' + said + ' ')) return 1
  let hit = 0
  for (const w of words) {
    if (have.includes(w)) hit += 1
    // an ending ("songs" for "song"), not another word that starts the same ("songscription")
    else if (w.length >= 3 && have.some(h => (h.startsWith(w) && h.length <= w.length + 3) || (h.length >= 4 && w.startsWith(h)))) hit += 0.7
    else if (w.length >= 5 && t.includes(w)) hit += 0.5
  }
  return words.length ? hit / words.length : 0
}

/**
 * Elements ranked against a query, best first, each with its score. Words on the
 * element count most, then its colour, then its kind. With no query the order is
 * reading order.
 */
function rank(elements, query) {
  const list = (elements || []).slice()
  if (!String(query || '').trim()) return list.map(e => ({ ...e, score: 0 }))
  const q = parseQuery(query)
  // asked for a panel, a pane or a section, the thing is a sizeable container
  const wantsWhole = q.whole && !q.kinds.has('chip') && !q.kinds.has('text')
  const scored = list.map((e, i) => {
    let s = 0
    // A container's text is everything inside it, so any word matches somewhere in the
    // main panel ("song" in a column header) and the panel would outrank the card that
    // actually says it. Words found among many count for less.
    let ts = textScore(e, q.words, q.phrase)
    if (CONTAINERS.has(e.kind) && e.kind !== 'chip' && tokens(e.text).length > 12) ts *= 0.4
    s += 3 * ts
    const col = e.background && e.background.colour
    if (q.colours.size) {
      if (col && q.colours.has(col)) s += 1.6
      else if (col && [...q.colours].some(c => c.split(' ').pop() === col.split(' ').pop())) s += 0.6
      else s -= 0.4
    }
    if (q.kinds.size) {
      const small = wantsWhole && area(e.box) < WHOLE
      if (q.kinds.has(e.kind) && !small) s += 1
      else if (wantsWhole && ['text', 'chip', 'icon'].includes(e.kind)) s -= 1
      else if (!q.kinds.has(e.kind)) s -= 0.5
    }
    // docked where the words say: the details pane on the right, the sidebar on the left
    if (q.side && sidePane(e) === q.side) s += 1.5
    // "the stat cards", plural, are the cards together
    if (q.many && e.kind === 'grid') s += 0.5
    // a container covering most of the frame is the page itself, not a thing on it
    if (wantsWhole && area(e.box) > 0.5) s -= 1.5
    // the place's own label (the Pick for me button, for "the chip in the Pick for me
    // section") is where the thing is, not the thing, once something else is asked for
    if (q.context.length && (q.kinds.size || q.colours.size || q.words.length || q.phrase) &&
        textScore(e, q.context, null) >= 0.99 && tokens(e.text).length <= q.context.length + 2) s -= 1.5
    // a colour or a kind alone describes a filled thing: the fill has to be the
    // element's own, not the page behind a line of text
    if ((q.colours.size || q.kinds.size) && !q.words.length && e.kind === 'text') s -= 0.8
    // among equals, the one with something to read and a sure reading
    s += Math.min(0.3, String(e.text || '').length / 200) + 0.1 * (e.confidence || 0)
    return { e: { ...e, score: round(s) }, i }
  })
  scored.sort((a, b) => b.e.score - a.e.score || a.i - b.i)
  return scored.map(x => x.e)
}

/**
 * What find_on_screen hands back for a query: the best `limit`, then what the first
 * few sit in (their card, grid or panel), and every panel and grid when the words ask
 * for one. Asked for "the song details card", the details panel has no words of its
 * own to match, so without this the agent never saw it and drew a box by eye.
 */
function pick(elements, query, limit = 8) {
  const ranked = rank(elements, query)
  const list = ranked.slice(0, limit)
  const has = new Set(list.map(e => e.id))
  const add = e => { if (e && !has.has(e.id)) { has.add(e.id); list.push(e) } }
  const byId = new Map(ranked.map(e => [e.id, e]))
  for (const e of list.slice(0, 3)) {
    let up = byId.get(e.in)
    for (let n = 0; up && n < 3; n++, up = byId.get(up.in)) add(up)
  }
  const q = parseQuery(query)
  if (q.kinds.has('panel') || q.kinds.has('grid')) ranked.filter(e => e.kind === 'panel' || e.kind === 'grid').forEach(add)
  return list
}

// ── a box as a zoom ─────────────────────────────────────────────────────────
// A box framed with room around it: a quarter of its size clear on every side, so the
// thing reads as the subject with its context, not as a crop of itself. A big thing (a
// details pane, a card grid) is already its own context and gets a hair of room, down
// to 6 percent by the time it covers a tenth of the frame: at a quarter a pane's worth of
// empty column filled half the zoom beside it. Never past
// 2.6x, where a 1080p frame turns soft, and never under 1.2x, where a zoom stops
// reading as a move.
const BOX_MARGIN = 0.25, BOX_MAX = 2.6, BOX_MIN = 1.2

/**
 * The zoom that frames `box` (fractions of the frame after the crop): { x, y, scale }.
 * The zoom keeps the frame's own shape (zoompan scales both axes alike), so the
 * scale is whichever axis is tighter. x, y is the box's centre, moved in only as far
 * as the frame edge forces, which is where the export would clamp it anyway.
 */
function boxZoom(box, o = {}) {
  const b = cleanBox(box)
  if (!b) return null
  // big by area, so a long thin chip still gets its room
  const big = Math.max(0, Math.min(1, (Math.sqrt(b.w * b.h) - 0.12) / 0.18))
  const m = o.margin != null ? o.margin : BOX_MARGIN - (BOX_MARGIN - 0.06) * big
  const fit = Math.min(1 / (b.w * (1 + 2 * m)), 1 / (b.h * (1 + 2 * m)))
  // rounded before the clamp, so the centre is held in by the scale the export uses
  const scale = Math.round((o.scale > 0 ? +o.scale : Math.max(BOX_MIN, Math.min(BOX_MAX, fit))) * 100) / 100
  const half = 1 / scale / 2
  const c = centre(b)
  const clamp = (v) => Math.max(half, Math.min(1 - half, v))
  return { x: round(clamp(c.x)), y: round(clamp(c.y)), scale }
}

// A box as sent, or null if it is not one: numbers, inside the frame, not empty
function cleanBox(box) {
  if (!box || typeof box !== 'object') return null
  let x = +box.x, y = +box.y, w = +box.w, h = +box.h
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null
  x = Math.max(0, Math.min(1, x)); y = Math.max(0, Math.min(1, y))
  w = Math.min(1 - x, w); h = Math.min(1 - y, h)
  return w > 0 && h > 0 ? { x, y, w, h } : null
}

// ── when a box holds its element ────────────────────────────────────────────
// A lift timed to the narration starts before the card it lifts has opened, and raises
// a strip of whatever was there before (the song table under the details pane). Small
// grey thumbnails of the box across the span say when the element is really there.
const SAME = 20      // mean difference, 0 to 255, under which two thumbnails are one picture
const HOLD = 3       // samples in a row that must agree, so one flicker is not an arrival

const diff = (a, b) => {
  let d = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) d += Math.abs(a[i] - b[i])
  return n ? d / n : 0
}

/**
 * The part of [start, end] where a box shows the element it was aimed at, from samples
 * [{ t, v }] of the box's pixels. The element is the picture most of the span agrees
 * on (or the sample nearest `at`, the moment it was found). Only the ends move: what
 * happens inside the element while it is there (a playhead, a hover) is its own business.
 * Returns { start, end, moved, present } where present is false when the element never
 * settles, so nothing can be said.
 */
function presentSpan(samples, start, end, o = {}) {
  const s = (samples || []).filter(x => x && x.v && x.v.length)
  const same = o.same || SAME, hold = o.hold || HOLD
  const out = { start, end, moved: false, present: true }
  if (s.length < hold + 1) return out
  let ref
  if (o.at != null) ref = s.reduce((b, x) => Math.abs(x.t - o.at) < Math.abs(b.t - o.at) ? x : b)
  else {
    // the medoid: the sample that the most others look like
    let best = -1
    for (const x of s) {
      const n = s.reduce((k, y) => k + (diff(x.v, y.v) < same ? 1 : 0), 0)
      if (n > best) { best = n; ref = x }
    }
    if (best < Math.max(hold, s.length * 0.4)) return { ...out, present: false }
  }
  const ok = s.map(x => diff(x.v, ref.v) < same)
  const run = i => ok.slice(i, i + hold).length === hold && ok.slice(i, i + hold).every(Boolean)
  let a = 0
  while (a < s.length && !run(a)) a++
  let b = s.length - 1
  while (b >= 0 && !(ok[b] && ok.slice(Math.max(0, b - hold + 1), b + 1).every(Boolean))) b--
  if (a >= s.length || b < a) return { ...out, present: false }
  // a sample stands for the time up to the next one, so an arrival between samples
  // lands on the first one that shows it
  const ns = a > 0 ? s[a].t : start
  const ne = b < s.length - 1 ? s[b].t : end
  const r = x => Math.round(x * 100) / 100
  if (ns - start > 0.12) { out.start = r(ns); out.moved = true }
  if (end - ne > 0.12) { out.end = r(ne); out.moved = true }
  return out
}

// ── what a lift can raise ───────────────────────────────────────────────────
// A lift raises the whole piece a few percent over a soft shadow, so it needs air on
// every side. The song details pane, a hair from the frame's right edge and scrolled so
// its last cards were cut off at its foot, came out as a slab flush with the video's
// edge ending on half a card. A designer lifts the stats grid inside it instead.
const LIFT_CLEAR = 0.012     // air left between the raised piece and the frame edge
const LIFT_GROW = 0.02       // half of what a lift adds to its own size, at most
const CUT_SLACK = 0.006      // text this close to a container's edge runs past it

/** The frame edges a lift of `box` would crowd, raised and with its shadow. */
function liftEdges(box) {
  const b = cleanBox(box)
  if (!b) return []
  const gx = LIFT_CLEAR + LIFT_GROW * b.w, gy = LIFT_CLEAR + LIFT_GROW * b.h
  return [b.x < gx && 'left', b.y < gy && 'top', b.x + b.w > 1 - gx && 'right', b.y + b.h > 1 - gy && 'bottom'].filter(Boolean)
}

/** The edges of a container its own content runs past: a scrolled list, a cut-off card. */
function cutEdges(el, all) {
  const b = el && el.box
  if (!b) return []
  const out = new Set()
  for (const o of all || []) {
    if (!o || o === el || o.id === el.id || !['text', 'chip'].includes(o.kind)) continue
    // the words themselves: a chip's own fill may hug the card's edge
    const t = o.text_box || o.box
    // words that start inside the container
    if (!(t.x >= b.x - 0.004 && t.y >= b.y - 0.004 && t.x < b.x + b.w && t.y < b.y + b.h)) continue
    if (t.y + t.h > b.y + b.h - CUT_SLACK && t.y > b.y + b.h * 0.5) out.add('bottom')
    if (t.x + t.w > b.x + b.w - CUT_SLACK && t.x > b.x + b.w * 0.5) out.add('right')
  }
  return [...out]
}

/**
 * Why an element should not be lifted, in words, or null: { why, instead } where
 * instead is the largest card, grid or panel inside it that can be.
 */
function liftBlock(el, all) {
  if (!el || !el.box) return null
  const edges = liftEdges(el.box), cut = cutEdges(el, all)
  if (!edges.length && !cut.length) return null
  const why = [edges.length ? `it runs to the ${edges.join(' and ')} edge of the frame` : null,
    cut.length ? `its content is cut off at its ${cut.join(' and ')}` : null].filter(Boolean).join(', and ')
  const ok = e => e !== el && ['card', 'grid', 'panel'].includes(e.kind) && inside(e.box, el.box) &&
    area(e.box) < area(el.box) * 0.9 && area(e.box) >= 0.004 && !liftEdges(e.box).length && !cutEdges(e, all).length
  // what sits directly in it first (the details pane's stats grid, not a card of it)
  const direct = e => e.in === el.id ? 1 : 0
  const instead = (all || []).filter(ok).sort((a, b) => direct(b) - direct(a) || area(b.box) - area(a.box))[0] || null
  // how much of it that is: a stats grid stands for the details pane, one "0:34" cell
  // does not stand for the whole song list
  return { why, instead, share: instead ? round(area(instead.box) / area(el.box)) : 0 }
}

module.exports = {
  presentSpan, liftEdges, cutEdges, liftBlock, LIFT_CLEAR, LIFT_GROW,
  luminance, tone, colourName, elementsFrom, parseQuery, rank, pick, boxZoom, cleanBox,
  BOX_MARGIN, BOX_MAX, BOX_MIN,
}
