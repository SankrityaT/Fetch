// The check every action passes through before it touches anything an id names.
//
// An id from find_on_screen makes one promise: it resolves to the same element or to
// nothing. The matcher that carries ids from picture to picture (targets.js carryIds)
// has been patched case by case twice and each time there was another case: a panel
// carried by its place alone after a reorder, a "Delete recipe" carried to the next
// recipe's page under a nav title that stayed. A matcher that guesses identity across
// pictures will always have another case, so it is no longer what keeps the promise.
// This is.
//
// When an id is shown to an agent, what it names is written down: its words, its kind,
// the words of what it sits in, the words of its row, its place among things that read
// the same, its box, and the loose words of the screen around it. At the moment an
// action uses the id, the element the newest picture gives that id is held against what
// was written down, and anything that does not match, or cannot be told, is refused
// with a sentence that says to call find_on_screen again. There is no "close enough".
// A matcher mistake then costs the agent one call instead of costing the person the
// wrong row's data.
//
// ── what counts as the same element ────────────────────────────────────────
//
// Words are compared as they are spelt. Figures are held apart: a count inside a card
// or a row is allowed to tick over ("Comments 12" to "Comments 13"), but where figures
// are what tell things apart they have to match: a run of numbered labels ("Step 1",
// "Step 2"), a label on its own ("Invoice 1042"), a list row's name ("Maya Chen 1043"),
// the first line of a card, and the numbered words of a row.
//
// 1. Its own words.
//    - A label (text, a chip, an icon) keeps the same words, or a verb among them
//      changes form where it stands on a screen that is otherwise the same:
//      "Delete" to "Deleting...", "Follow" to "Following", "Save" to "Saved". Never a
//      plural or a dropped letter ("Note" and "Notes", "Ann" and "Anne" are other
//      names), never a list row's name, and "Delete" to "Delete all" gained a word.
//    - A card, panel or grid keeps every word it had, gains no word that names it, and
//      keeps its first line's figures. A stat further down may tick over, but a card
//      whose title went from one recipe to another, or from one order number to the
//      next, is another card wherever it sits.
// 2. The same sort of thing, the same size. Words, chips and icons are one sort, since
//    Vision finds a button's fill on one frame and not the next. A label's height is
//    its type size and holds; its width may change with its words.
// 3. What it belongs to, which is where a repeated control takes its identity from.
//    - Its home (the smallest card, panel or grid round it) keeps its name, the words
//      no other card of its sort on that screen carries, gains no new one, and keeps
//      its first line's figures. The Delete in Shakshuka's card is refused once that
//      card says Morning oats.
//    - Its row (the words level with it in the same home) keeps every word that named
//      it, gains none ("Shakshuka" to "Green shakshuka" is another row), and keeps its
//      numbered words, figures and all ("Order 1044  Wed" to "Order 1045  Wed"). The
//      Call beside "Alice Smith" is refused beside "Bob Jones", even though it is the
//      only Call on either screen. Two rows that would each pass for its row leave it
//      unsure, whichever one it is in.
//    - Its place among things that read the same, in its row (or its home, for cards):
//      the second of two Shares is the second of two, and one gone leaves the other
//      unsure, so both are refused.
// 4. The screen it is on. The screen's own words (every word that names itself, of any
//    size, with company on its line or without, in no card or in the only card of its
//    sort, less the names of a list's rows) that went, with other words standing in
//    their place, mean the screen shows another item: "Shakshuka" became "Pancakes"
//    under a "Recipes" nav title that stayed, beside its "25 min" or in a small
//    subtitle, and the toolbar's "Delete recipe" is Pancakes' now. For a heading, other
//    figures are enough ("Invoice 1042" to "Invoice 1043"). A heading that only moved,
//    shrank or scrolled away with nothing new in its place does not count.
// 5. Something that names nothing (a word repeated with no named home or row, an
//    untitled card, a bare thumbnail) has only its place, and is refused the moment
//    the place, the frame's shape, the number of things like it in its home, or any
//    word beside it changes. A scroll or a row inserted above it is enough.
// 6. Two on the screen now match what one id was minted for: refused, whichever one
//    the matcher handed the id to.
//
// A ledger keeps the first identity each id was shown with, for as long as a run of
// ids lasts. A later picture that hands an id to something that fails the check does
// not get to keep it: the id is spent and the element gets a new one, so the listing an
// agent reads never shows an old id on a different thing. That is the matcher's mistake
// turned into an id that died, which is the one failure the promise allows.
//
// Pure: no filesystem, no DOM. The bridge records every list it hands an agent and
// confirms every id an action uses.

const SORT = { text: 'words', chip: 'words', icon: 'words', card: 'card', shape: 'card', panel: 'panel', grid: 'grid' }
const HOMES = new Set(['card', 'panel'])   // what a thing sits in. A grid is only its cards
const LABEL_H = 1.35      // a label's height, its type size, read twice
const LABEL_W = 1.5       // a label's width with the same words
const BLOCK = 1.25        // a card, panel or grid, either side
const ASPECT = 0.02       // two frames whose shapes differ by more are not one layout
const LOOSE_MAX = 60      // loose words kept per screen, more than any screen shows
const SHORT = 40
// A time of day ticks while a screen is open, so it is the one figure that does not make
// an element another element. Every other figure does: see rowCounted.
const CLOCK = /^\d{1,2}:\d{2}(\s?[ap]m)?$/i

// ── words ───────────────────────────────────────────────────────────────────
const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
const tokens = s => norm(s).split(/[^\p{L}\p{N}#]+/u).filter(Boolean)
const hasFigure = t => /\p{N}/u.test(t)
const hasLetter = t => /\p{L}/u.test(t)
const ENDINGS = ['ings', 'ing', 'ed', 'es', 's', 'd', 'e']
function stem(w) {
  if (!/^\p{L}+$/u.test(w)) return w
  for (const end of ENDINGS) if (w.endsWith(end) && w.length - end.length >= 3) return w.slice(0, -end.length)
  return w
}
// A word's letters as they are spelt: "Anne" is not "Ann", "Notes" is not "Note". Only
// a label's own words are allowed another form of themselves, and only a verb's
// (sameLabel below).
const letters = s => tokens(s).filter(t => hasLetter(t) && !hasFigure(t))
const figures = s => tokens(s).filter(hasFigure)
const keyOf = e => tokens(e && e.text).join(' ')
const skeletonOf = e => tokens(e && e.text).map(t => hasFigure(t) ? '#' : t).join(' ')
const sortOf = e => SORT[e.kind] || e.kind
const isWords = e => sortOf(e) === 'words'
const trim = s => String(s || '').replace(/\s+/g, ' ').trim()
const short = s => { s = trim(s); return s.length <= SHORT ? s : s.slice(0, SHORT - 3).trim() + '...' }
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])
const sorted = a => a.slice().sort()
// Another form of the same word: one stem, one of them the word itself and the other its
// -ing or -ed form.
// "Delete" and "Deleting", "Save" and "Saved", "Follow" and "Following". Never a plural
// or a dropped e, which is how "Notes" came to pass for "Note" and "Anne" for "Ann".
const VERB = /(?:ings?|ed)$/
const formOf = (x, y) => x !== y && stem(x) === stem(y) && VERB.test(x) !== VERB.test(y)
// whether `n` was among `had`, as it is or in another form (a new word is a new name;
// "Deleting" on the button of a card that had "Delete" is not)
const among = (n, had) => had.some(o => o === n || formOf(o, n))

// ── boxes ───────────────────────────────────────────────────────────────────
const area = b => b.w * b.h
const inside = (p, b, slack = 0.004) => p.x >= b.x - slack && p.y >= b.y - slack &&
  p.x + p.w <= b.x + b.w + slack && p.y + p.h <= b.y + b.h + slack
const centre = b => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 })
const faceOf = e => e.text_box || e.box
const within = (a, b, r) => Math.max(a, b) <= Math.min(a, b) * r + 1e-4
const level = (A, B) => {
  const ca = A.y + A.h / 2, cb = B.y + B.h / 2
  return (ca >= B.y && ca <= B.y + B.h) || (cb >= A.y && cb <= A.y + A.h)
}
const across = (A, B) => Math.min(A.x + A.w, B.x + B.w) > Math.max(A.x, B.x)
// how far a thing that names nothing may sit from where it was: under half its own
// height, so the one a row down is never in reach, and never more than 0.03 of the frame
const reach = (a, b) => Math.min(0.03, Math.max(0.008, 0.4 * Math.min(a.h, b.h)))
const shapeOf = f => f && f.width > 0 && f.height > 0 ? f.width / f.height : null
const sameShape = (a, b) => { const p = shapeOf(a), q = shapeOf(b); return !(p && q) || Math.abs(p / q - 1) <= ASPECT }

/**
 * Whether two labels are one control's, by rule 1 above. `counted` is whether the old
 * one's figures were what told it from its neighbours, in which case they must match.
 */
function sameLabel(was, now, counted = false) { return !!labelMatch(was, now, counted) }
// The same, saying how: 'same' for the same words, 'form' where a word only changed
// form, null for another label.
function labelMatch(was, now, counted = false) {
  const a = letters(was), b = letters(now)
  if (!a.length) return !b.length && same(figures(was), figures(now)) ? 'same' : null
  if (a.length !== b.length) return null
  let how = 'same'
  for (let k = 0; k < a.length; k++) {
    if (a[k] === b[k]) continue
    if (!formOf(a[k], b[k])) return null
    how = 'form'
  }
  if (counted && !same(figures(was), figures(now))) return null
  return how
}

// ── one screen, read ────────────────────────────────────────────────────────
// Everything the check needs about a list of elements: for each one its home, its own
// words and name, its row, and its place among things that read the same. Read once
// per list and kept, since a list is never changed once an Elements pass hands it back.
const READ = new WeakMap()
function survey(list) {
  if (Array.isArray(list) && READ.has(list)) return READ.get(list)
  const els = (Array.isArray(list) ? list : []).filter(e => e && e.box)
  const all = els.map((_, i) => i)
  const holds = (o, e) => o !== e && area(o.box) > area(e.box) * 1.2 && inside(e.box, o.box)
  const home = els.map(e => {
    let best = -1
    els.forEach((o, j) => {
      if (HOMES.has(o.kind) && holds(o, e) && (best < 0 || area(o.box) < area(els[best].box))) best = j
    })
    return best
  })
  const count = new Map()
  const bump = k => count.set(k, (count.get(k) || 0) + 1)
  els.forEach(e => { bump(sortOf(e) + '|' + keyOf(e)); if (isWords(e) && tokens(e.text).some(hasFigure)) bump('#' + skeletonOf(e)) })
  // figures are what tells it apart: another label on this screen reads the same, numbers aside
  const counted = els.map(e => isWords(e) && tokens(e.text).some(hasFigure) && count.get('#' + skeletonOf(e)) > 1)
  // A card's own words: its lines and the words sitting directly in it, less anything
  // held in a card inside it. A list panel's own words are its header, never its rows,
  // and a grid (a union of cards) has none, so neither changes name when a row goes.
  const own = els.map((e, i) => {
    if (isWords(e)) return new Set(letters(e.text))
    const out = new Set([...letters(e.text), ...all.filter(j => home[j] === i && isWords(els[j])).flatMap(j => letters(els[j].text))])
    for (const j of all) if (!isWords(els[j]) && holds(e, els[j])) for (const w of letters(els[j].text)) out.delete(w)
    return out
  })
  // Its name. A label names itself when it has letters, reads that way once and is not
  // one of a counted run. A card is named by its own words that no other card of its
  // sort beside it (neither inside the other) carries.
  const name = els.map((e, i) => {
    if (isWords(e)) return own[i].size && count.get('words|' + keyOf(e)) === 1 && !counted[i] ? [...own[i]] : []
    return [...own[i]].filter(w => !all.some(k => k !== i && sortOf(els[k]) === sortOf(e) &&
      !holds(e, els[k]) && !holds(els[k], e) && own[k].has(w)))
  })
  // A card's title: the first line of words in it, top to bottom. Its figures are the
  // card's own ("Maya Chen 1043"), where a stat further down ("3 cooks") may tick over.
  const titleFigures = els.map((e, i) => {
    if (isWords(e)) return null
    const lines = all.filter(j => home[j] === i && isWords(els[j]) && letters(els[j].text).length)
      .sort((p, q) => faceOf(els[p]).y - faceOf(els[q]).y || faceOf(els[p]).x - faceOf(els[q]).x)
    return lines.length ? sorted(figures(els[lines[0]].text)) : []
  })
  // its row: the words level with it in the same home. Cards, panels and grids have none.
  const mates = els.map((e, i) => HOMES.has(e.kind) || e.kind === 'grid' ? [] : all
    .filter(j => j !== i && isWords(els[j]) && home[j] === home[i] && keyOf(els[j]) && level(faceOf(e), faceOf(els[j]))))
  const row = mates.map(m => [...new Set(m.flatMap(j => name[j]))])
  const rowWords = mates.map(m => new Set(m.flatMap(j => [...own[j]])))
  // the numbered words beside it that name something or are one of a counted run
  // ("Order 1044" among "Order 1042" and "Order 1043"), figures and all: in a list
  // named that way the number is the row's name, and the only thing that tells 1044's
  // Wed from 1045's
  // Every figure beside it is part of its row, a lone amount or date included, not only
  // one that names the row. Two approvals for one person differing only in the amount are
  // two transactions, and carrying Approve from $120 onto $80 approves money nobody
  // looked at. A clock is the exception, because it moves while the row stays put.
  const rowCounted = mates.map(m => [...new Set(m.filter(j => tokens(els[j].text).some(hasFigure) &&
    !CLOCK.test(trim(els[j].text))).map(j => keyOf(els[j])))])
  const mateKeys = mates.map(m => new Set(m.map(j => keyOf(els[j]))))
  // its place among things of its sort that read the same in its home (and its row,
  // for anything that is not a card)
  const sibKey = i => sortOf(els[i]) + '|' + (counted[i] ? '#' + skeletonOf(els[i]) : keyOf(els[i]))
  const order = els.map((e, i) => {
    const sib = all.filter(j => sibKey(j) === sibKey(i) && home[j] === home[i] &&
      (HOMES.has(e.kind) || e.kind === 'grid' || level(faceOf(e), faceOf(els[j]))))
    sib.sort((p, q) => faceOf(els[p]).x - faceOf(els[q]).x || faceOf(els[p]).y - faceOf(els[q]).y)
    return { at: sib.indexOf(i), of: sib.length }
  })
  // The screen's own words: what says which item a screen is about. Every word that
  // names itself, of any size, with company on its line or not, in no card or in the
  // only card of its sort (a hero), except the names of a list's rows: a word a
  // repeated control takes its row from is the row's, and rule 3 holds it there.
  // `tall` is a heading's size or more, where a number changing is a new item too.
  const heights = els.filter(isWords).map(e => faceOf(e).h).sort((p, q) => p - q)
  const body = heights.length ? heights[Math.floor(heights.length / 2)] : 0
  const listy = new Set()
  els.forEach((e, i) => { if (isWords(e) && !name[i].length && mates[i].length) for (const j of mates[i]) listy.add(j) })
  const solo = h => els.filter(o => o.kind === els[h].kind).length === 1
  // A word made only of figures, standing alone, is the screen's too: an order number or
  // a date is often the only thing telling this detail screen from the next one, so
  // "#1042" becoming "#1043" means Refund now refunds a different order.
  const figOnly = i => !letters(els[i].text).length && tokens(els[i].text).some(hasFigure) && !counted[i] &&
    !CLOCK.test(trim(els[i].text)) && count.get(sortOf(els[i]) + '|' + keyOf(els[i])) === 1 && !mates[i].length
  const loose = all.filter(i => isWords(els[i]) && (name[i].length || figOnly(i)) && !listy.has(i) && (home[i] < 0 || solo(home[i])))
    .slice(0, LOOSE_MAX)
    .map(i => ({ text: els[i].text, key: keyOf(els[i]), box: faceOf(els[i]), tall: faceOf(els[i]).h >= body * 0.95 }))
  // a label on its own: in no card and with nothing level with it. Its figures are part
  // of its name ("Invoice 1042"), since there is nothing else to tell it by. So are a
  // list row's name's ("Maya Chen 1043"): a row's name is the item, not a count.
  const alone = els.map((e, i) => isWords(e) && home[i] < 0 && !mates[i].length && tokens(e.text).some(hasFigure))
  const words = all.filter(i => isWords(els[i]) && keyOf(els[i]))
    .map(i => ({ key: keyOf(els[i]), box: faceOf(els[i]), text: els[i].text, ...(listy.has(i) ? { listy: true } : {}) }))
  const keys = new Set(words.map(x => x.key))
  const out = { els, home, own, name, titleFigures, listy, row, rowWords, rowCounted, mateKeys, order, counted, alone, loose, words, keys,
    index: new Map(els.map((e, i) => [e.id, i])) }
  if (Array.isArray(list)) READ.set(list, out)
  return out
}

// Whether every word on a screen is where it was: as many of them, each one with the
// same words within reach of its old place. What something that names nothing needs.
function unmoved(was, now) {
  if (was.length !== now.length) return false
  const used = new Set()
  return was.every(p => {
    const a = centre(p.box)
    const j = now.findIndex((q, k) => !used.has(k) && q.key === p.key &&
      Math.hypot(centre(q.box).x - a.x, centre(q.box).y - a.y) <= reach(p.box, q.box))
    if (j < 0) return false
    used.add(j)
    return true
  })
}

// The words of a home that are its name, in the case they were read in.
function nameText(text, name) {
  const want = new Set(name)
  const words = String(text || '').split(/\s+/).filter(w => letters(w).some(x => want.has(x)))
  return short(words.join(' ') || text)
}

/**
 * What an element is, written down when its id is shown. `list` is the whole list it
 * came in (its neighbours are part of what it is); `o.frame` the picture's
 * { width, height }, else the list's own.
 */
function identify(el, list, o = {}) {
  const s = survey(list)
  const i = s.index.get(el.id)
  if (i == null) throw new Error(`${el.id} is not in the list it was said to come from`)
  const e = s.els[i], h = s.home[i]
  return {
    id: e.id, text: e.text || '', kind: e.kind, box: e.box, face: faceOf(e),
    frame: o.frame || (list && list.frame) || null,
    counted: s.counted[i],
    alone: s.alone[i],
    listy: s.listy.has(i),
    own: [...s.own[i]],
    name: s.name[i],
    figures: s.titleFigures[i],
    home: h < 0 ? null : { kind: s.els[h].kind, text: s.els[h].text || '', name: s.name[h], own: [...s.own[h]],
      figures: s.titleFigures[h] },
    row: s.row[i],
    rowAll: [...s.rowWords[i]],
    rowCounted: s.rowCounted[i],
    order: s.order[i],
    screen: { loose: s.loose, keys: s.keys, words: s.words },
  }
}

/** Every element of a list, identified, by id. */
function mintAll(list, o = {}) {
  const out = new Map()
  for (const e of survey(list).els) if (e.id) out.set(e.id, identify(e, list, o))
  return out
}

// Whether element j's row is the row `w` was minted in. A thing that names itself needs
// its row's naming words still beside it; one that takes its identity from its row
// needs them still naming that row. Either way the row may not gain a word that names
// something it did not have ("Shakshuka" to "Green shakshuka"), and its numbered words
// keep their figures ("Order 1044" to "Order 1045" is another row, whatever day it says).
function rowFits(w, s, j) {
  const has = w.name.length ? s.rowWords[j] : new Set(s.row[j])
  if (!w.row.every(n => has.has(n))) return false
  if (!s.row[j].every(n => (w.rowAll || []).includes(n))) return false
  return (w.rowCounted || []).every(k => s.mateKeys[j].has(k))
}

// Whether two screens hold the same words in the same places but for words that only
// changed form where they stood ("Delete" showing "Deleting...", "Save" showing
// "Saved"). A list's row names are never allowed that: "Bake" deleted and "Baked"
// scrolled into its place is another row, and nothing on the screen could say so.
function onlyForms(was, now) {
  if (was.length !== now.length) return false
  const used = new Set(), left = []
  for (const p of was) {
    const a = centre(p.box)
    const j = now.findIndex((q, k) => !used.has(k) && q.key === p.key &&
      Math.hypot(centre(q.box).x - a.x, centre(q.box).y - a.y) <= reach(p.box, q.box))
    if (j < 0) left.push(p)
    else used.add(j)
  }
  return left.every(p => {
    if (p.listy) return false
    const a = centre(p.box)
    const j = now.findIndex((q, k) => !used.has(k) && Math.hypot(centre(q.box).x - a.x, centre(q.box).y - a.y) <= reach(p.box, q.box) &&
      labelMatch(p.text, q.text, true) === 'form')
    if (j < 0) return false
    used.add(j)
    return true
  })
}

// How the check describes the thing an id was minted for.
function describe(w) {
  const what = w.text ? `the "${short(w.text)}" ${w.kind}` : `the ${w.kind} without words`
  if (!w.home) return what
  return w.home.name.length ? `${what} in the "${nameText(w.home.text, w.home.name)}" ${w.home.kind}` : what
}
const nth = n => ['first', 'second', 'third', 'fourth', 'fifth'][n] || `number ${n + 1}`

/**
 * Whether the element `list` gives this id now is the one `w` (from identify) was
 * minted for. Returns { ok: true, element } or { ok: false, id, reason, say }, where
 * reason is one word for a test to read and say is the sentence for the agent.
 * `o.frame` is the new picture's { width, height }; `o.act` the verb for the sentence.
 */
function judge(w, list, o = {}) {
  const id = w.id
  const s = survey(list)
  const i = s.index.get(id)
  const refuse = (reason, why) => ({
    ok: false, id, reason,
    say: `${id} was ${describe(w)}${why}. Fetch did not ${o.act || 'act on'} it, because an id names one ` +
      'element or nothing. Call find_on_screen again on the newest screen and use the id it hands back.',
  })
  if (i == null) return refuse('gone', ', and it is not on this screen')
  const e = s.els[i], face = faceOf(e)
  const frame = o.frame || (list && list.frame) || null
  const still = sameShape(w.frame, frame)
  const now = e.text ? `"${short(e.text)}"` : 'no words'
  const label = SORT[w.kind] === 'words'
  // a word that changed form is allowed only on a screen that is the same but for such words
  let settled = null
  const forms = () => settled == null ? (settled = still && onlyForms(w.screen.words, s.words)) : settled
  const had = (n, words) => words.includes(n) || (forms() && among(n, words))
  const has = (n, set) => set.has(n) || (forms() && among(n, [...set]))

  // 2. the same sort of thing, the same size
  if (sortOf(e) !== (SORT[w.kind] || w.kind)) return refuse('kind', `, and here that id is a ${e.kind} reading ${now}`)
  if (still) {
    const fits = label
      ? within(w.face.h, face.h, LABEL_H) && (keyOf(w) !== keyOf(e) || within(w.face.w, face.w, LABEL_W))
      : within(w.box.w, e.box.w, BLOCK) && within(w.box.h, e.box.h, BLOCK)
    if (!fits) return refuse('size', `, and here that id is a different size, reading ${now}`)
  }
  // 1. its own words
  if (label) {
    const how = labelMatch(w.text, e.text, w.counted || w.alone || w.listy)
    if (!how) return refuse('words', `, and here that id reads ${now}`)
    // A word in another form ("Save" to "Saved") is the same control only where it
    // stayed put on a screen that did not change round it: "Bake" to "Baked" is as
    // like as "Save" to "Saved", and a list that moved is where the one becomes the other.
    if (how === 'form' && !forms()) {
      return refuse('words', `, and here that id reads ${now} on a screen that changed round it`)
    }
  } else if (w.name.length) {
    // every word it had, no new word naming it, and its title's figures: "Maya Chen
    // 1043" and "Maya Chen 1042" are two orders, however alike their words
    if (!w.own.every(x => has(x, s.own[i])) || !s.name[i].every(x => had(x, w.own)) ||
      (w.figures && !same(w.figures, s.titleFigures[i] || []))) return refuse('words', `, and here that id reads ${now}`)
  } else if (keyOf(w) !== keyOf(e)) {
    // a card that names nothing is told by all of its words, figures too
    return refuse('words', `, and here that id reads ${now}`)
  }
  // 6. two now fit what one id was minted for: by its own name, or, for one named by
  // its row, two rows that would each pass for its row
  if (w.name.length) {
    const twin = s.els.some((x, j) => j !== i && sortOf(x) === sortOf(e) && (label
      ? sameLabel(w.text, x.text, w.counted) : w.name.every(n => s.own[j].has(n))))
    if (twin) return refuse('twin', ', and this screen has two things that read that way')
  } else if (label && w.row.length) {
    // one in the same row is its neighbour, which its place among its like tells apart
    const twin = s.els.some((x, j) => j !== i && sortOf(x) === sortOf(e) && sameLabel(w.text, x.text, w.counted) &&
      !(s.home[j] === s.home[i] && level(face, faceOf(x))) && rowFits(w, s, j))
    if (twin) return refuse('twin', ', and this screen has two rows that read the way its row did')
  }
  // 3. what it belongs to: its home's name, its row, its place among its like
  if (w.home && w.home.name.length) {
    const h = s.home[i]
    if (h < 0 || !w.home.name.every(n => has(n, s.own[h])) || !s.name[h].every(n => had(n, w.home.own)) ||
      (w.home.figures && !same(w.home.figures, s.titleFigures[h] || []))) {
      return refuse('home', h < 0 ? ', and here it sits in nothing'
        : `, and here it sits in the "${short(s.els[h].text)}" ${s.els[h].kind}`)
    }
  }
  // A thing that names itself needs its row's words still beside it. One that takes
  // its identity from its row needs them to still name that row, once on the screen:
  // two rows reading "Step 1 Mon" leave its Delete unsure, whichever row it is in.
  if (!rowFits(w, s, i)) {
    return refuse('row', s.rowWords[i].size ? ', and here its row reads differently' : ', and here nothing that names its row is beside it')
  }
  if (w.order.of > 1 || s.order[i].of > 1) {
    if (s.order[i].of !== w.order.of) {
      return refuse('order', `, the ${nth(w.order.at)} of ${w.order.of} alike there, and there are ${s.order[i].of} now, ` +
        'so which is which cannot be told')
    }
    if (s.order[i].at !== w.order.at) {
      return refuse('order', `, the ${nth(w.order.at)} of ${w.order.of} alike there, and here that id is the ${nth(s.order[i].at)}`)
    }
  }
  // 5. named by nothing: its place, on a screen where nothing else moved either
  const named = w.name.length || (w.home && w.home.name.length) || w.row.length
  if (!named) {
    const bare = ' with nothing to name it but its place'
    if (!still) return refuse('place', `${bare}, and this picture is another shape`)
    const a = centre(w.face), b = centre(face)
    if (Math.hypot(a.x - b.x, a.y - b.y) > reach(w.face, face)) return refuse('place', `${bare}, and it has moved`)
    if (!unmoved(w.screen.words, s.words)) return refuse('place', `${bare}, and the words around it have changed`)
  }
  // 4. the screen shows another item: loose words that went, new words in their place
  if (still) {
    const had = w.screen.keys, has = s.keys
    const gone = w.screen.loose.filter(x => !has.has(x.key))
    const came = s.loose.filter(x => !had.has(x.key))
    for (const p of gone) {
      // another word in its place: other letters, or, for a heading, other figures too
      // ("Invoice 1042" to "Invoice 1043"). A small "25 min" becoming "30 min" is the
      // same recipe with its time edited.
      const q = came.find(n => within(p.box.h, n.box.h, LABEL_H) && across(p.box, n.box) &&
        Math.abs(centre(p.box).y - centre(n.box).y) <= Math.max(p.box.h, n.box.h) / 2 &&
        // figures always count here, not only on a tall title: a small date line is how a
        // recurring event tells this week's from next week's
        !sameLabel(p.text, n.text, true))
      if (q) return refuse('screen', ` on a screen showing "${short(p.text)}", and that place now shows "${short(q.text)}"`)
    }
  }
  return { ok: true, id, element: e }
}

/** judge, for a caller that acts: the element, or an Error carrying the sentence. */
function confirm(w, list, o = {}) {
  const v = judge(w, list, o)
  if (!v.ok) { const err = new Error(v.say); err.reason = v.reason; err.id = v.id; throw err }
  return v.element
}

// ── the ledger: one per run of ids ──────────────────────────────────────────
const eNum = id => /^E\d+$/.test(String(id)) ? +String(id).slice(1) : 0

/**
 * The identity each id was first shown with, for one run of ids (one device's screens,
 * or one recording's passes). A run ends where its numbering restarts; call reset then.
 */
function ledger() {
  const known = new Map(), spent = new Map()
  let top = 0
  return {
    /**
     * A list about to be shown. Each id already known is held against its first
     * identity; one that fails is spent and its element takes a new id past every
     * number handed out. Returns { list, reissued: [{ from, to, reason }] }, the list
     * keeping its seq, frame and carried with the new ids counted in.
     */
    record(list, o = {}) {
      const frame = o.frame || (list && list.frame) || null
      const src = Array.isArray(list) ? list : []
      top = Math.max(top, +(list && list.seq) || 0, ...src.map(e => eNum(e && e.id)))
      const swap = new Map(), reissued = []
      for (const e of src) {
        if (!e || !e.id || !known.has(e.id)) continue
        const v = judge(known.get(e.id), list, { frame })
        if (v.ok) continue
        const to = 'E' + (++top)
        swap.set(e.id, to)
        spent.set(e.id, known.get(e.id))
        reissued.push({ from: e.id, to, reason: v.reason })
      }
      let out = list
      if (swap.size) {
        out = src.map(e => {
          if (!e) return e
          const id = swap.get(e.id) || e.id, inn = e.in && swap.get(e.in)
          return id === e.id && !inn ? e : { ...e, id, ...(inn ? { in: inn } : {}) }
        })
        const carried = Math.max(0, (+(list && list.carried) || 0) - swap.size)
        Object.defineProperty(out, 'seq', { value: top })
        Object.defineProperty(out, 'frame', { value: frame })
        Object.defineProperty(out, 'carried', { value: carried })
      }
      for (const e of out) if (e && e.id && !known.has(e.id)) known.set(e.id, identify(e, out, { frame }))
      return { list: out, reissued }
    },
    identity: id => known.get(String(id || '').trim().toUpperCase()) || null,
    /** whether this run ever handed the id out, live or spent */
    knows: id => { const k = String(id || '').trim().toUpperCase(); return known.has(k) || spent.has(k) },
    /** judge an id against the list the action is about to land on */
    check(id, list, o = {}) {
      const k = String(id || '').trim().toUpperCase()
      if (spent.has(k)) {
        return { ok: false, id: k, reason: 'spent', say: `${k} was ${describe(spent.get(k))}, and a later screen gave ` +
          `that id to something else, so it names nothing now. Fetch did not ${o.act || 'act on'} it. Call ` +
          'find_on_screen again on the newest screen and use the id it hands back.' }
      }
      const w = known.get(k)
      if (!w) {
        return { ok: false, id: k, reason: 'unknown', say: `${k} was never shown on this screen, so Fetch cannot ` +
          `tell what it names and did not ${o.act || 'act on'} it. Call find_on_screen and use an id it hands back.` }
      }
      return judge(w, list, o)
    },
    confirm(id, list, o = {}) {
      const v = this.check(id, list, o)
      if (!v.ok) { const err = new Error(v.say); err.reason = v.reason; err.id = v.id; throw err }
      return v.element
    },
    reset() { known.clear(); spent.clear(); top = 0 },
    get size() { return known.size },
  }
}

module.exports = { identify, mintAll, judge, confirm, sameLabel, ledger, stem, survey }
