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
const overlap = (a, b) => {
  const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
  const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
  return x * y
}
function iou(a, b) {
  const i = overlap(a, b)
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
 *
 * `prior` is the whole list an earlier pass on the same screen handed back. Given it,
 * the same control keeps the same id (carryIds) and anything new is numbered past every
 * id that list could have handed out, so an id never comes to mean something else.
 */
function elementsFrom(raw, prior) {
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
  const frame = raw && raw.width > 0 && raw.height > 0 ? { width: raw.width, height: raw.height } : null
  const carried = carryIds(prior, out, frame)
  const withIds = out.map((e, i) => ({ id: carried.ids[i], ...e }))
  // what each one sits in, so an agent can step out from a card to its grid or panel
  for (const e of withIds) {
    const home = withIds.filter(o => o !== e && CONTAINERS.has(o.kind) && area(o.box) > area(e.box) * 1.2 && inside(e.box, o.box))
      .sort((a, b) => area(a.box) - area(b.box))[0]
    if (home) e.in = home.id
  }
  // Kept on the list and out of every element, so the next pass on this screen knows the
  // highest number ever handed out and the frame the boxes were measured in. Neither
  // survives JSON, and neither has to: carryIds reads the ids themselves when they are gone.
  Object.defineProperty(withIds, 'seq', { value: carried.seq })
  Object.defineProperty(withIds, 'frame', { value: frame })
  Object.defineProperty(withIds, 'carried', { value: carried.carried })
  return withIds
}

// ── the same control, the same id ───────────────────────────────────────────
// Ids used to be positions: E1, E2... in reading order on each picture. Anything that
// shifted the layout renumbered everything below it. In the judged simulator job ready
// listed "Sign in with Apple" as E18, record_start took its own picture of the same,
// unchanged screen and listed it as E17, and the tap sent with E18 was refused.
//
// Two pictures of one screen are matched element to element, and a match keeps its
// id. Two different buttons wrongly sharing an id is far worse than one button getting
// a new one (the tap lands on the wrong thing, and nothing says so), so a match has to
// be sure and anything unsure gets a new number:
//
// - the words on it are the same, word for word. A label that changed ("Follow" to
//   "Following", a count going up) is a new element. So is anything read differently.
// - it is the same sort of thing: words, a chip and an icon are one sort, because
//   Vision finds the fill round a button on one frame and not the next; a card or a
//   shape is another; a panel and a grid are each their own.
// - it is the same size, give or take a reading. A large title and the small back
//   button carrying the same word after a push are two controls.
// - where it is agrees with how the rest of the screen moved. Words that appear once on
//   both pictures anchor the match.
// - it sits in the same row. A row is the words level with it inside the same card or
//   panel, and its own words are the ones that appear once on the picture (a recipe's
//   name, a device's name). Its row-mates that were carried have to have moved with it,
//   into its row, and a row swapped for a different one takes everything in it along.
//
// A word that appears more than once (a "Delete" on every row) and a thing with no words
// take their identity from that row and nothing else: the Delete in Shakshuka's row is
// Shakshuka's Delete, wherever Shakshuka went. The judged failure was a deleted row: the
// rows below closed up under a title that had not moved, the Deletes were expected where
// the title said, and each one took the id of the Delete from the row above. Morning
// oats' Delete then meant Shakshuka's, and a second tap on it deleted the wrong recipe.
// Now a row that went takes its Delete's id with it, a row whose words changed gets a
// new Delete, and two alike in one row (two stars, two Shares in a toolbar) are told
// apart by their order in it, and only while the row holds as many as it did.
// Repeated things in a row with no words of its own are never carried: rows that all
// read "Untitled", a cart of "Milk", a grid of bare thumbnails, or rows named only by their
// place ("Step 1", a price, a time). Delete the first of twenty and the next scrolls in,
// or delete Step 1 and Step 2 is renamed, and the same count sits in the same places.
// The agent pays one find_on_screen for it. A heading replaced in place (the recipe's
// name became another recipe's over the same toolbar) is another screen, and nothing on
// it is carried.
//
// What still cannot be told apart: a screen whose content changed with no heading to say
// so, around controls that each appear once and only vouch for each other (a one-row
// "Shakshuka [Edit] [Delete]" whose name changed below a title that stayed).
//
// When the match is ambiguous the id dies rather than moves. An agent told "that
// element is gone, find it again" loses one call; one whose Delete lands on the wrong
// row loses someone's data.
//
// New elements are numbered past the highest id the earlier list could have handed out,
// in reading order, so an id held from any earlier picture of the screen means the same
// thing here or nothing at all. It never quietly resolves to something else.
const SORT = { text: 'words', chip: 'words', icon: 'words', card: 'card', shape: 'card', panel: 'panel', grid: 'grid' }
const CARRY_NEAR = 0.2        // a lone anchor may move this far on its own, past nothing that stayed
const CARRY_TOGETHER = 0.03   // two anchors moved the same way within this, or stayed put
const CARRY_ASPECT = 0.02     // two frames whose shapes differ by more are not one layout
const HOMES = new Set(['card', 'panel', 'grid'])   // what a row sits in

const keyOf = e => tokens(e.text).join(' ')
const faceOf = e => e.text_box || e.box
const within = (a, b, r) => Math.max(a, b) <= Math.min(a, b) * r + 1e-4
// The same size, give or take a reading. Words are held tighter on their height, which
// is the type size, than on their width, which a fill found or lost can change.
function alike(p, n) {
  const a = faceOf(p), b = faceOf(n)
  return SORT[p.kind] === 'words'
    ? within(a.h, b.h, 1.35) && within(a.w, b.w, 1.5)
    : within(a.w, b.w, 1.25) && within(a.h, b.h, 1.25)
}
const moveOf = (p, n) => { const a = centre(faceOf(p)), b = centre(faceOf(n)); return { x: b.x - a.x, y: b.y - a.y } }
const far = d => Math.hypot(d.x, d.y)
const apart = (a, b) => far({ x: a.x - b.x, y: a.y - b.y })

// Whether a word that appears once on both pictures is the same control, going by how it
// moved against the other such words. Staying put is its own evidence. A move has to
// agree with the screen around it: the words that moved the same way are its block, and
// no word that moved otherwise may sit in the stretch the block travelled through. For a
// move mostly up or down that stretch runs the width of the frame, because rows run
// across the screen: a "Delete" that went from Alice's row to Carol's passed Bob's row
// and Carol's, which stayed where they were, so it is Carol's Delete and not Alice's.
// A real scroll or a banner pushing down moves everything in that stretch together.
// A block of one moved on its own and has nothing to agree with, so it is also held to
// CARRY_NEAR.
function anchored(c, cand, list, next) {
  if (far(c.d) <= CARRY_TOGETHER) return true
  const block = cand.filter(o => apart(o.d, c.d) <= CARRY_TOGETHER)
  if (block.length < 2 && far(c.d) > CARRY_NEAR) return false
  const boxes = block.flatMap(o => [faceOf(list[o.pi]), faceOf(next[o.ni])])
  const x0 = Math.min(...boxes.map(b => b.x)), x1 = Math.max(...boxes.map(b => b.x + b.w))
  const y0 = Math.min(...boxes.map(b => b.y)), y1 = Math.max(...boxes.map(b => b.y + b.h))
  const across = Math.abs(c.d.y) >= Math.abs(c.d.x)
  const inStretch = pt => pt.y > y0 && pt.y < y1 && (across || (pt.x > x0 && pt.x < x1))
  return !cand.some(o => !block.includes(o) &&
    (inStretch(centre(faceOf(list[o.pi]))) || inStretch(centre(faceOf(next[o.ni])))))
}

// The rows of one picture. For each element: the smallest card, panel or grid it sits
// in, and the other words level with it in there. Level means either one's middle falls
// within the other's height, so a button a little taller than its row's label is still
// in the row, and a tall panel beside it is not words and is never a row-mate.
function rowsOf(arr) {
  const home = arr.map(e => {
    let best = -1
    arr.forEach((o, j) => {
      if (o !== e && HOMES.has(o.kind) && area(o.box) > area(e.box) * 1.2 && inside(e.box, o.box) &&
          (best < 0 || area(o.box) < area(arr[best].box))) best = j
    })
    return best
  })
  const level = (a, b) => {
    const A = faceOf(a), B = faceOf(b), ca = A.y + A.h / 2, cb = B.y + B.h / 2
    return (ca >= B.y && ca <= B.y + B.h) || (cb >= A.y && cb <= A.y + A.h)
  }
  return arr.map((e, i) => arr.map((o, j) => j).filter(j => j !== i && SORT[arr[j].kind] === 'words' &&
    keyOf(arr[j]) && home[j] === home[i] && level(e, arr[j])))
}

// The screen's heading: the largest words with letters in the top quarter of the
// picture that appear once on it. Whether one of them went and new words of its size took
// its place, which is a different item's screen (a delete that moved on to the next
// recipe, a push to another page), however alike the rest of it looks. A clock ticking
// over has no letters, and a heading that only grew or shrank (a large title collapsing
// on scroll) kept its words, so neither counts.
function headingSwapped(list, next) {
  const top = (arr) => {
    const counts = new Map()
    arr.forEach(e => { const k = keyOf(e); if (k) counts.set(k, (counts.get(k) || 0) + 1) })
    const lettered = arr.filter(e => SORT[e.kind] === 'words' && /\p{L}/u.test(e.text || '') &&
      counts.get(keyOf(e)) === 1 && faceOf(e).y + faceOf(e).h / 2 < 0.25)
    const tall = Math.max(0, ...lettered.map(e => faceOf(e).h))
    return lettered.filter(e => faceOf(e).h >= tall * 0.9)
  }
  const had = new Set(list.map(keyOf)), has = new Set(next.map(keyOf))
  const gone = top(list).filter(e => !has.has(keyOf(e)))
  const came = top(next).filter(e => !had.has(keyOf(e)))
  const level = (a, b) => { const A = faceOf(a), B = faceOf(b); return Math.abs((A.y + A.h / 2) - (B.y + B.h / 2)) <= Math.max(A.h, B.h) / 2 }
  const across = (a, b) => { const A = faceOf(a), B = faceOf(b); return Math.min(A.x + A.w, B.x + B.w) > Math.max(A.x, B.x) }
  return gone.some(p => came.some(n => within(faceOf(p).h, faceOf(n).h, 1.35) && level(p, n) && across(p, n)))
}

/**
 * Ids for `next` (elements in reading order, without ids), carried from `prior` (an
 * earlier pass's whole list, with ids) where the element is surely the same one.
 * `frame` is the next picture's { width, height }. Returns { ids, seq, carried }, where
 * seq is the highest number handed out so far, prior's included.
 */
function carryIds(prior, next, frame) {
  const list = Array.isArray(prior) ? prior.filter(e => e && e.box && /^E\d+$/.test(String(e.id))) : []
  const seq0 = Math.max(0, +(prior && prior.seq) || 0, ...list.map(eNum))
  const ids = new Array(next.length).fill(null)
  // A picture of another shape (the device turned, a different window) is not the same
  // layout, and its boxes cannot be compared. Nothing is carried; numbering still runs on.
  const pf = prior && prior.frame
  const shape = f => f && f.width > 0 && f.height > 0 ? f.width / f.height : null
  const sameShape = !(shape(pf) && shape(frame)) || Math.abs(shape(pf) / shape(frame) - 1) <= CARRY_ASPECT
  const taken = new Set()
  const match = (pi, ni) => { ids[ni] = list[pi].id; taken.add(pi) }
  if (list.length && sameShape) {
    const sortOf = e => SORT[e.kind] || e.kind
    // what a thing is called for matching: its sort and its words, or, with no words,
    // its kind, so thumbnails are only ever matched to thumbnails
    const nameOf = e => keyOf(e) ? sortOf(e) + '|' + keyOf(e) : '#' + e.kind
    const group = arr => {
      const m = new Map()
      arr.forEach((e, i) => { const g = nameOf(e); m.set(g, (m.get(g) || []).concat(i)) })
      return m
    }
    const P = group(list), N = group(next)
    const once = (G, arr, i) => !!keyOf(arr[i]) && G.get(nameOf(arr[i])).length === 1
    // Words that only count a place ("Step 1", "Step 2", a price, a time) are unique and
    // say nothing about which row is which: delete Step 1 and the old Step 2 is relabelled
    // "Step 1" in the same place. A word whose shape, numbers aside, another unique word
    // on its picture shares is one of those, and never names a row.
    const skeleton = e => tokens(e.text).map(t => /\p{N}/u.test(t) ? '#' : t).join(' ')
    const counting = arr => {
      const seen = new Map()
      arr.forEach(e => { if (/\p{N}/u.test(e.text || '')) { const s = skeleton(e); seen.set(s, (seen.get(s) || 0) + 1) } })
      return i => /\p{N}/u.test(arr[i].text || '') && seen.get(skeleton(arr[i])) > 1
    }
    const countP = counting(list), countN = counting(next)
    // a row's own words: its members that appear once on their picture and name something
    const RP = rowsOf(list).map(r => r.filter(j => once(P, list, j) && !countP(j)))
    const RN = rowsOf(next).map(r => r.filter(j => once(N, next, j) && !countN(j)))

    // 1. anchors: words that appear exactly once on both pictures
    const cand = []
    for (const [g, ns] of N) {
      const ps = P.get(g)
      if (!ps || ps.length !== 1 || ns.length !== 1 || !keyOf(next[ns[0]])) continue
      const p = list[ps[0]], n = next[ns[0]]
      if (alike(p, n)) cand.push({ pi: ps[0], ni: ns[0], d: moveOf(p, n) })
    }
    let anchors = cand.filter(c => anchored(c, cand, list, next))
    // A heading replaced in place is another screen: "Shakshuka" became "Pancakes" over
    // the same toolbar after a delete moved on to the next recipe, and that toolbar's
    // Delete is now Pancakes' Delete. Nothing is carried from a screen that was swapped.
    if (headingSwapped(list, next)) anchors = []
    // Whether p's row is n's row, for something that does not name itself: every one of
    // p's row words was carried, into n's row, and n's row has no words of its own that
    // were not in p's. Returns the way the row moved, or null when it is not the same
    // row. A row of no words is { x: 0, y: 0, bare }.
    const sameRow = (pi, ni, to, from) => {
      const rp = RP[pi].filter(j => j !== pi), rn = RN[ni].filter(j => j !== ni)
      if (!rp.length && !rn.length) return { x: 0, y: 0, bare: true }
      if (rp.length !== rn.length || !rp.every(j => to.has(j)) || !rn.every(j => from.has(j))) return null
      const want = new Set(rn)
      if (!rp.every(j => want.has(to.get(j)))) return null
      // and the row moved as one
      const ds = rp.map(j => moveOf(list[j], next[to.get(j)]))
      if (ds.some(d => apart(d, ds[0]) > CARRY_TOGETHER)) return null
      return { x: ds.reduce((s, d) => s + d.x, 0) / ds.length, y: ds.reduce((s, d) => s + d.y, 0) / ds.length }
    }
    // Words that appear once name themselves, so their row is held more loosely: a row
    // may lose words (Alice's Delete moved away) or gain them (a badge on a tab) and
    // they keep their id. What refuses them is a row that was swapped for another: the
    // unique Delete of a one-row list whose recipe became a different recipe had row
    // words on both pictures and not one of them in common. A row-mate carried into
    // another row, or one that moved otherwise, refuses it too. Refusing one can leave
    // another without its row, so this runs until nothing changes.
    const rowHolds = (a, to) => {
      const rp = RP[a.pi].filter(j => j !== a.pi), rn = new Set(RN[a.ni].filter(j => j !== a.ni))
      const went = rp.filter(j => to.has(j))
      if (went.some(j => !rn.has(to.get(j)) || apart(moveOf(list[j], next[to.get(j)]), a.d) > CARRY_TOGETHER)) return false
      return !(rp.length && rn.size && !went.length)
    }
    for (;;) {
      const to = new Map(anchors.map(a => [a.pi, a.ni]))
      const keep = anchors.filter(a => rowHolds(a, to))
      if (keep.length === anchors.length) break
      anchors = keep
    }
    for (const a of anchors) match(a.pi, a.ni)
    const to = new Map(anchors.map(a => [a.pi, a.ni])), from = new Map(anchors.map(a => [a.ni, a.pi]))

    // how close is close: under half the thing's own height, so the "Delete" one row down
    // is never in reach, and never more than 0.03 of the frame
    const reach = (p, n) => Math.min(0.03, Math.max(0.008, 0.4 * Math.min(faceOf(p).h, faceOf(n).h)))
    // 2. repeated words, and things with no words (a thumbnail), by the row they sit in.
    // A panel or a grid with no words is never matched here: nothing names it.
    const rowKey = (R, i, map) => R[i].filter(j => j !== i).map(j => map ? map.get(j) : j).sort((a, b) => a - b).join(',')
    const byX = arr => (a, b) => faceOf(arr[a]).x - faceOf(arr[b]).x || faceOf(arr[a]).y - faceOf(arr[b]).y
    for (const [g, ps0] of P) {
      const ns0 = N.get(g)
      if (!ns0) continue
      if (ps0.length === 1 && ns0.length === 1 && keyOf(list[ps0[0]])) continue   // an anchor, or refused as one
      if (!keyOf(list[ps0[0]]) && (SORT[list[ps0[0]].kind] === 'panel' || SORT[list[ps0[0]].kind] === 'grid')) continue
      const ps = ps0.filter(i => !taken.has(i)), ns = ns0.filter(i => ids[i] == null)
      // the rows these sit in, by the next picture's indices of their words
      const rows = new Map()
      const put = (k, side, i) => { if (!rows.has(k)) rows.set(k, { ps: [], ns: [] }); rows.get(k)[side].push(i) }
      for (const pi of ps) {
        const own = RP[pi].filter(j => j !== pi)
        // a row whose words were not all carried has no counterpart: its things go with it
        if (own.length && !own.every(j => to.has(j))) continue
        put(own.length ? rowKey(RP, pi, to) : '', 'ps', pi)
      }
      for (const ni of ns) {
        const own = RN[ni].filter(j => j !== ni)
        if (own.length && !own.every(j => from.has(j))) continue
        put(own.length ? rowKey(RN, ni) : '', 'ns', ni)
      }
      for (const [k, r] of rows) {
        // As many on the row as there were, or which is which cannot be said. A row with
        // no words of its own (every row reads "Untitled", a cart of "Milk", a grid of bare
        // thumbnails) is never carried, however still the screen: delete the first of
        // twenty and the next one scrolls in, so the same count sits in the same places
        // and the deleted row's Delete would name the next row's.
        if (k === '' || !r.ps.length || r.ps.length !== r.ns.length) continue
        const d = sameRow(r.ps[0], r.ns[0], to, from)
        if (!d || d.bare) continue
        r.ps.sort(byX(list)); r.ns.sort(byX(next))
        const pairs = r.ps.map((pi, i) => ({ pi, ni: r.ns[i] }))
        const fits = ({ pi, ni }) => {
          const p = list[pi], n = next[ni], c = centre(faceOf(p))
          return alike(p, n) && (keyOf(p) || p.kind === n.kind) && sameRow(pi, ni, to, from) &&
            apart({ x: c.x + d.x, y: c.y + d.y }, centre(faceOf(n))) <= reach(p, n)
        }
        // one out of place and the order cannot be trusted for any of them
        if (pairs.every(fits)) for (const { pi, ni } of pairs) match(pi, ni)
      }
    }

    // 3. a panel or a grid whose words changed (a stat inside it ticked over) is still
    // the pane it was, when it sits where the screen says it should, nearly box for box.
    // Where it should be is where its nearest anchor went.
    const expect = p => {
      const c = centre(faceOf(p))
      const a = anchors.slice().sort((u, v) => apart(centre(faceOf(list[u.pi])), c) - apart(centre(faceOf(list[v.pi])), c))[0]
      return a ? { x: c.x + a.d.x, y: c.y + a.d.y } : c
    }
    const pane = (p, n) => p.kind === n.kind && (p.kind === 'panel' || p.kind === 'grid') && alike(p, n)
    const shifted = (pi, ni) => {
      const p = list[pi], e = expect(p), c = centre(p.box)
      const b = { ...p.box, x: p.box.x + e.x - c.x, y: p.box.y + e.y - c.y }
      return 1 - iou(b, next[ni].box)
    }
    const open = () => ({ ps: list.map((_, i) => i).filter(i => !taken.has(i)), ns: next.map((_, i) => i).filter(i => ids[i] == null) })
    const { ps, ns } = open()
    const pairs = []
    for (const ni of ns) {
      const near = ps.filter(pi => pane(list[pi], next[ni])).map(pi => ({ pi, v: shifted(pi, ni) }))
        .filter(o => o.v <= 0.24).sort((a, b) => a.v - b.v)
      // one candidate in reach, and no second anywhere near it
      if (!near.length || near[0].v > 0.12 || (near[1] && near[1].v <= 0.24)) continue
      pairs.push({ pi: near[0].pi, ni })
    }
    // and the other way round: no other new element is as good a fit for that one
    const count = new Map()
    for (const p of pairs) count.set(p.pi, (count.get(p.pi) || 0) + 1)
    for (const p of pairs) if (count.get(p.pi) === 1) match(p.pi, p.ni)
  }
  let seq = seq0
  for (let i = 0; i < ids.length; i++) if (ids[i] == null) ids[i] = 'E' + (++seq)
  return { ids, seq, carried: ids.length - (seq - seq0) }
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
// How close to a container's border words have to end before the container is cutting
// them off. Words a container clips end at its border; words it holds stop one padding
// short of it, and an app sets that padding in the same type it sets the words in. So
// the ruler is the words' own height, never a share of the frame: at 0.006 of the frame
// this was 17 px on a still of one window, wider than the padding a card keeps its own
// right-aligned label in, and every card carrying a duration, a price or a count came
// back no_lift. The container's own side caps it, so a heading cannot speak for a small
// card. A padding is square on the screen, and a box in fractions is not: a height is a
// share of the frame's height and an x a share of its width, so the type ruler is turned
// onto the x axis by the frame's own shape. Left mixed, the same card was whole on a
// 16:9 still and cut off on a 5120x1440 ultrawide, which is a fact about the display.
const CUT_TYPE = 0.25        // of the words' own height: nearer the border than this is cut
const CUT_SLACK = 0.02       // and never more than this of the container's own side

/** The frame edges a lift of `box` would crowd, raised and with its shadow. */
function liftEdges(box) {
  const b = cleanBox(box)
  if (!b) return []
  const gx = LIFT_CLEAR + LIFT_GROW * b.w, gy = LIFT_CLEAR + LIFT_GROW * b.h
  return [b.x < gx && 'left', b.y < gy && 'top', b.x + b.w > 1 - gx && 'right', b.y + b.h > 1 - gy && 'bottom'].filter(Boolean)
}

/**
 * The edges of a container its own content runs past: a scrolled list, a cut-off card.
 *
 * `aspect` is the frame's own width over its height, which is what turns the type ruler
 * from the y axis onto the x. Unknown, 16:9 is assumed, which is the shape of nearly
 * every recording and the shape this rule was measured on.
 */
const CUT_ASPECT = 16 / 9
function cutEdges(el, all, aspect) {
  const b = el && el.box
  if (!b) return []
  const perX = 1 / (+aspect > 0 ? +aspect : CUT_ASPECT)   // frame heights per frame width
  const out = new Set()
  for (const o of all || []) {
    if (!o || o === el || o.id === el.id || !['text', 'chip'].includes(o.kind)) continue
    // the words themselves: a chip's own fill may hug the card's edge
    const t = o.text_box || o.box
    // words that start inside the container
    if (!(t.x >= b.x - 0.004 && t.y >= b.y - 0.004 && t.x < b.x + b.w && t.y < b.y + b.h)) continue
    const slackY = Math.min(CUT_TYPE * t.h, CUT_SLACK * b.h)
    const slackX = Math.min(CUT_TYPE * t.h * perX, CUT_SLACK * b.w)
    if (t.y + t.h > b.y + b.h - slackY && t.y > b.y + b.h * 0.5) out.add('bottom')
    if (t.x + t.w > b.x + b.w - slackX && t.x > b.x + b.w * 0.5) out.add('right')
  }
  return [...out]
}

/**
 * Why an element should not be lifted, in words, or null: { why, instead } where
 * instead is the largest card, grid or panel inside it that can be, or { why, around }
 * where the thing to lift is the card the words sit in rather than anything inside them.
 */
function liftBlock(el, all, aspect) {
  if (!el || !el.box) return null
  // A bare line of words is never the thing a lift raises: a lift raises a whole piece of
  // the page over a shadow, and words alone come out as a floating tooltip. The smallest
  // liftable container holding them is what was meant, which is the same line snapBox
  // already holds for the lasso. Nothing around them, and the words are all there is.
  if (el.kind === 'text') {
    const box = (all || []).filter(e => ['card', 'grid', 'panel'].includes(e.kind) &&
      inside(el.box, e.box) && !liftEdges(e.box).length && !cutEdges(e, all, aspect).length)
      .sort((a, b) => area(a.box) - area(b.box))[0]
    if (box) return { why: 'a lift raises a whole piece of the page, and these are the words inside one', around: box, instead: null, share: 0 }
    return null
  }
  const edges = liftEdges(el.box), cut = cutEdges(el, all, aspect)
  if (!edges.length && !cut.length) return null
  const why = [edges.length ? `it runs to the ${edges.join(' and ')} edge of the frame` : null,
    cut.length ? `its content is cut off at its ${cut.join(' and ')}` : null].filter(Boolean).join(', and ')
  const ok = e => e !== el && ['card', 'grid', 'panel'].includes(e.kind) && inside(e.box, el.box) &&
    area(e.box) < area(el.box) * 0.9 && area(e.box) >= 0.004 && !liftEdges(e.box).length && !cutEdges(e, all, aspect).length
  // what sits directly in it first (the details pane's stats grid, not a card of it)
  const direct = e => e.in === el.id ? 1 : 0
  const instead = (all || []).filter(ok).sort((a, b) => direct(b) - direct(a) || area(b.box) - area(a.box))[0] || null
  // how much of it that is: a stats grid stands for the details pane, one "0:34" cell
  // does not stand for the whole song list
  return { why, instead, share: instead ? round(area(instead.box) / area(el.box)) : 0 }
}

// ── the rectangle a person draws, and holding an edit to what it aims at ────
// The lasso lets someone point at an area of their own video, and apply_edit stops
// taking an agent's aim on trust. Both need the same few judgements, and they are
// here because they are arithmetic on boxes and nothing else.
const SNAP_IOU = 0.55     // a drawn box that overlaps an element this much is that element
const SNAP_HOLD = 4       // a small drag inside an element snaps to it only if it is at most
                          //   4x the drawn area, so a flick inside a panel does not take the panel
const SNAP_REACH = 0.12   // how far from a point an element may be and still be what was meant
const FIT_LOW = 0.5       // a target narrower than half the view is too far away to read
const FIT_HIGH = 0.92     // wider than this and its own edges are cut off

const eNum = e => +String(e.id || '').replace(/\D/g, '') || 0
// smaller first, then the one found earlier, so the answer never depends on input order
const bySize = (a, b) => area(a.box) - area(b.box) || eNum(a) - eNum(b)

/**
 * The element a drawn rectangle means, or none. A box over a card is that card even
 * when the drag was sloppy; a small box inside a chip is the chip; the same small box
 * inside a whole panel is left as drawn, because nobody flicks at a corner to mean the
 * sidebar. Text is never snapped to: the thing around the words is what an edit lands on.
 */
function snapBox(drawn, elements) {
  const b = cleanBox(drawn)
  if (!b) return { box: null, element: null, kind: 'free', iou: 0 }
  const cand = (elements || []).filter(e => e && e.box && e.kind !== 'text')
  // rounded before comparing: two elements the drag covers equally well are a tie, not
  // a coin toss on the last bit of a float
  const over = cand.map(e => ({ e, v: round(iou(e.box, b)) })).filter(o => o.v >= SNAP_IOU)
    .sort((p, q) => q.v - p.v || bySize(p.e, q.e))
  const hit = over.length ? over[0].e
    : cand.filter(e => inside(b, e.box) && area(e.box) <= SNAP_HOLD * area(b)).sort(bySize)[0]
  if (!hit) return { box: b, element: null, kind: 'free', iou: 0 }
  return { box: roundBox(hit.box), element: hit.id, kind: hit.kind, iou: round(iou(hit.box, b)) }
}

// How far a point is from a box: 0 inside it, else the straight line to its nearest edge
function pointGap(p, b) {
  const dx = Math.max(b.x - p.x, 0, p.x - (b.x + b.w))
  const dy = Math.max(b.y - p.y, 0, p.y - (b.y + b.h))
  return Math.sqrt(dx * dx + dy * dy)
}

/**
 * The element a bare point means: the smallest one it falls in, or the nearest one
 * within `reach`. A zoom sent as a centre point is aimed at something, and this is
 * what it was aimed at.
 *
 * Text is not a candidate, for the reason snapBox refuses it: a line of words is
 * almost always inside the chip, button or card an edit lands on, and it is the
 * smallest thing round the point, so a point aimed at a control would frame a two
 * percent tall sliver of it instead.
 */
function nearPoint(point, elements, reach = SNAP_REACH) {
  const n = v => v !== null && v !== '' && Number.isFinite(+v) ? +v : null
  const p = point && n(point.x) != null && n(point.y) != null ? { x: n(point.x), y: n(point.y) } : null
  if (!p) return null
  const cand = (elements || []).filter(e => e && e.box && e.kind !== 'text')
  const held = cand.filter(e => pointGap(p, e.box) === 0).sort(bySize)
  if (held.length) return held[0]
  const near = cand.filter(e => pointGap(p, e.box) <= reach)
    .sort((a, b) => pointGap(p, a.box) - pointGap(p, b.box) || bySize(a, b))
  return near[0] || null
}

/**
 * The fraction of the view a box spans on its wider axis at this scale. A zoom scales
 * both axes alike, so the view is 1/scale of the frame each way.
 */
function zoomShare(scale, box) {
  return Math.max(box.w * scale, box.h * scale)
}

/**
 * The zoom that actually shows `box`: the one that was sent when it frames the thing
 * at a readable size, otherwise Fetch's own fit. `capped` says the fit ran into
 * boxZoom's 2.6x ceiling and still could not fill half the view, which is a fact about
 * the target, not a mistake to correct.
 */
function zoomFit(zoom, box) {
  const b = cleanBox(box)
  if (!b) return null
  const sent = zoom && Number.isFinite(+zoom.scale) ? +zoom.scale : null
  if (sent > 0) {
    const share = zoomShare(sent, b)
    if (share >= FIT_LOW && share <= FIT_HIGH) {
      return { x: zoom.x, y: zoom.y, scale: sent, changed: false, share: round(share), capped: false }
    }
  }
  const fit = boxZoom(b)
  const share = zoomShare(fit.scale, b)
  return { ...fit, changed: true, share: round(share), capped: share < FIT_LOW }
}

const LABEL_MAX = 40
const LABEL_TOUCH = 0.1   // below this the box only clips an edge, which is not aiming at it
const trim = s => String(s || '').replace(/\s+/g, ' ').trim()
const short = s => s.length <= LABEL_MAX ? s : trim(s.slice(0, LABEL_MAX - 1)) + '…'
const capital = s => s ? s[0].toUpperCase() + s.slice(1) : ''

/**
 * What to call the area someone lassoed, in their own screen's words: the element it
 * snapped to, or what the drawn box is around, in, or across, or just "Area".
 *
 * Only asking what the box holds the middle of is too strict. A tight box round a few
 * words, or a box drawn inside a card, holds no element's middle and used to come back
 * unnamed, which is the commonest way to lasso anything.
 */
function regionLabel(box, elements, element) {
  const all = (elements || []).filter(e => e && e.box)
  const id = element ? String(element).trim().toUpperCase() : null
  const el = id ? all.find(e => e.id === id) : null
  if (el) return short(trim(el.text) || capital(el.kind) || 'Area')
  const b = cleanBox(box)
  if (b) {
    const said = all.filter(e => trim(e.text))
    // Drawn round things: the longest of them, because that is the one being shown.
    const held = said.filter(e => {
      const c = centre(e.box)
      return c.x >= b.x && c.x <= b.x + b.w && c.y >= b.y && c.y <= b.y + b.h
    }).map(e => trim(e.text)).sort((p, q) => q.length - p.length)
    if (held.length) return short(held[0])
    // Drawn inside one thing or across two: the element the box shares the most with.
    // Overlap alone also answers "the smallest element containing it": every element
    // holding the whole box scores the box's area over its own, so the tightest wins.
    const over = said.filter(e => overlap(e.box, b) >= LABEL_TOUCH * Math.min(area(e.box), area(b)))
      .map(e => ({ e, v: round(iou(e.box, b)) }))
      .sort((p, q) => q.v - p.v || bySize(p.e, q.e))
    if (over.length) return short(trim(over[0].e.text))
  }
  return 'Area'
}

/**
 * Why a lift or a loupe cannot be placed, in words, or null. Both work on a piece of
 * the picture, so both need to know which piece: times alone raise nothing and magnify
 * nothing, and used to apply quietly as a mark with no geometry.
 */
function liftNeedsBox(mark) {
  const m = mark || {}
  const named = !!trim(m.element)
  const boxed = !!cleanBox(m.box)
  const rect = ['x', 'y', 'w', 'h'].every(k => Number.isFinite(+m[k]))
  if (named || boxed || rect) return null
  const start = Number.isFinite(+m.start) ? +m.start : 0
  const span = Number.isFinite(+m.end) && +m.end > start ? +m.end - start : 0
  const aim = Math.round((start + Math.min(1, span / 3)) * 100) / 100
  const what = m.kind === 'loupe' ? 'A loupe needs the box of the area it magnifies'
    : m.kind === 'arrow' ? 'An arrow needs the box of the thing it points at'
    : 'A lift needs the box of the thing it raises'
  return what + ', and this one has only a time.\n' +
    `Call find_on_screen at ${aim} s and send element: its E id, or ask the person to lasso ` +
    'the area in the editor and send element: its R id.'
}

module.exports = {
  presentSpan, liftEdges, cutEdges, liftBlock, LIFT_CLEAR, LIFT_GROW,
  luminance, tone, colourName, elementsFrom, parseQuery, rank, pick, boxZoom, cleanBox,
  BOX_MARGIN, BOX_MAX, BOX_MIN,
  snapBox, nearPoint, zoomShare, zoomFit, regionLabel, liftNeedsBox,
  SNAP_IOU, SNAP_HOLD, SNAP_REACH, FIT_LOW, FIT_HIGH,
}
