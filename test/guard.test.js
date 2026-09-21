// The guard (ui/guard.js): every id an action uses is held, at that moment, against what
// it was minted for, and refused when it does not match or cannot be told.
//
// Screens are described as rows with a hidden truth for every element, drawn into the
// detections Elements.swift hands back, and read by the real matcher (targets.js
// elementsFrom with the earlier list as prior). The promise checked is the one an id
// makes: every id the guard lets through on the second picture names the element it
// named on the first. The matcher is allowed to be wrong; the guard is not.
//   node test/guard.test.js
const T = require('../ui/targets')
const G = require('../ui/guard')

let pass = 0, fail = 0
const is = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}` +
    (ok ? '' : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`))
}

// ── screens with a truth under every element ────────────────────────────────
const iou = (a, b) => {
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y), x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h)
  const i = Math.max(0, x1 - x0) * Math.max(0, y1 - y0)
  return i / (a.w * a.h + b.w * b.h - i)
}
function render(scr) {
  const texts = [], rects = [], truths = []
  const W = (text, x, y, w, h, truth, container) => {
    const t = { text, conf: 1, box: { x, y, w, h }, bg: container ? '#222222' : '#FFFFFF' }
    if (container) t.container = container
    texts.push(t)
    truths.push({ box: container || t.box, truth })
  }
  const chip = (text, x, y, w, h, truth) => W(text, x, y, w, h, truth, { x: x - 0.01, y: y - 0.008, w: w + 0.02, h: h + 0.016 })
  if (scr.title) W(scr.title, 0.35, 0.05, 0.3, 0.035, 'title:' + scr.title)
  if (scr.sub) W(scr.sub, 0.1, 0.12, 0.3, 0.02, 'sub:' + scr.sub)
  let y = scr.y0
  for (const r of scr.rows) {
    const h = r.h || 0.07
    if (r.card) {
      const box = { x: 0.04, y: y - 0.01, w: 0.92, h: h - 0.005 }
      rects.push({ box, conf: 1, bg: '#EEEEEE', edges: true })
      truths.push({ box, truth: 'card:' + r.id })
    }
    if (r.name != null) W(r.name, 0.1, y, 0.04 + 0.012 * r.name.length, 0.022, 'name:' + r.id)
    if (r.meta != null) W(r.meta, 0.45, y, 0.1, 0.018, 'meta:' + r.id)
    ;(r.btns || []).forEach((b, k) => (r.chips ? chip : W)(b, 0.62 + k * 0.14, y, 0.1, 0.022, 'btn:' + r.id + ':' + b + ':' + k))
    if (r.thumb) {
      const box = { x: 0.02, y, w: 0.06, h: 0.04 }
      rects.push({ box, conf: 1, bg: '#888888' })
      truths.push({ box, truth: 'thumb:' + r.id })
    }
    y += h
  }
  for (const [i, t] of (scr.tabs || []).entries()) chip(t, 0.1 + i * 0.3, 0.93, 0.1, 0.02, 'tab:' + t)
  for (const x of scr.extra || []) (x.chip ? chip : W)(x.text, x.x, x.y, x.w, x.h || 0.02, x.truth || 'extra:' + x.text)
  return { raw: { width: 1290, height: 2796, texts, rects }, truths }
}
const truthOf = (el, truths) => {
  let best = null, bv = 0.5
  for (const t of truths) { const v = iou(el.box, t.box); if (v > bv) { bv = v; best = t.truth } }
  return best
}

// The worst matcher there could be, short of a random one: every element on the new
// picture takes the id of whatever of its kind sat most nearly in its place, whatever
// its words. It makes every mistake the judgement found (a reordered panel, a Delete
// closed up into a deleted row's place, a toolbar carried to the next recipe's page)
// and more, so the guard is tested against a matcher that is wrong on purpose rather
// than against whichever mistakes today's matcher still makes.
function byPlace(a, bRaw) {
  const b = T.elementsFrom(bRaw)
  const used = new Set()
  let seq = Math.max(...a.map(e => +e.id.slice(1)))
  const out = b.map(e => {
    const best = a.filter(o => o.kind === e.kind && !used.has(o.id))
      .map(o => ({ o, v: iou(o.box, e.box) })).filter(x => x.v > 0.3).sort((p, q) => q.v - p.v)[0]
    if (best) { used.add(best.o.id); return { ...e, id: best.o.id } }
    return { ...e, id: 'E' + (++seq) }
  })
  const ids = new Map(b.map((e, i) => [e.id, out[i].id]))
  return out.map(e => e.in ? { ...e, in: ids.get(e.in) } : e)
}

// The other blind matcher: the nth of each kind in reading order takes the old nth's
// id, which is what ids were before any matcher at all (E1, E2... on every picture).
function byOrder(a, bRaw) {
  const b = T.elementsFrom(bRaw)
  let seq = Math.max(...a.map(e => +e.id.slice(1)))
  const seen = new Map()
  const out = b.map(e => {
    const n = seen.get(e.kind) || 0
    seen.set(e.kind, n + 1)
    const o = a.filter(x => x.kind === e.kind)[n]
    return { ...e, id: o ? o.id : 'E' + (++seq) }
  })
  const ids = new Map(b.map((e, i) => [e.id, out[i].id]))
  return out.map(e => e.in ? { ...e, in: ids.get(e.in) } : e)
}
const MATCHERS = { real: 'by targets.js', place: 'by place alone', order: 'by reading order' }

// Two pictures through a matcher and the guard. Every id on B that A also showed is
// checked: `wrong` are ids the guard let through onto a different element (the promise
// broken), `kept` those it let through onto the same one, `refused` everything else.
// `how` is 'real' for targets.js, 'place' or 'order' for the blind matchers above.
function pair(A, B, how = 'real') {
  const ra = render(A), rb = render(B)
  const a = T.elementsFrom(ra.raw)
  const b = how === 'place' ? byPlace(a, rb.raw) : how === 'order' ? byOrder(a, rb.raw) : T.elementsFrom(rb.raw, a)
  const L = G.ledger()
  L.record(a)
  const ta = new Map(a.map(e => [e.id, truthOf(e, ra.truths)]))
  const out = { a, b, L, wrong: [], kept: [], refused: [], carriedWrong: 0, verdicts: new Map() }
  for (const e of b) {
    if (!ta.has(e.id)) continue
    const v = L.check(e.id, b, { act: 'tap' })
    out.verdicts.set(e.id, v)
    const sameThing = ta.get(e.id) === truthOf(e, rb.truths)
    if (!sameThing) out.carriedWrong++
    if (!v.ok) out.refused.push(e.id)
    else if (sameThing) out.kept.push(e.id)
    else out.wrong.push(`${e.id} ${ta.get(e.id)} -> ${truthOf(e, rb.truths)} [${e.kind} "${e.text}"]`)
  }
  return out
}
const idOf = (list, text, kind) => (list.find(e => e.text === text && (!kind || e.kind === kind)) || {}).id
const recipeCard = (id, name) => ({ id, name, btns: ['Edit', 'Delete'], chips: true, card: true })
const RECIPES = {
  title: 'Recipes', y0: 0.2, tabs: ['Home', 'Search', 'Profile'],
  rows: [recipeCard('oats', 'Morning oats'), recipeCard('shak', 'Shakshuka'), recipeCard('toast', 'French toast'), recipeCard('pan', 'Pancakes')],
}
const withRows = (scr, rows, more = {}) => ({ ...scr, rows, ...more })

console.log('guard: an id names the element it was minted for, or nothing')

// ── the rule, both sides ────────────────────────────────────────────────────
console.log('\nthe same element, and not')
is('"Delete" to "Deleting..." is the same button', G.sameLabel('Delete', 'Deleting...'), true)
is('"Follow" to "Following" is the same button', G.sameLabel('Follow', 'Following'), true)
is('"Save" to "Saved" is the same button', G.sameLabel('Save', 'Saved'), true)
is('a count ticking over is the same label', G.sameLabel('Comments 12', 'Comments 13'), true)
is('"Shakshuka" to "Morning oats" is not', G.sameLabel('Shakshuka', 'Morning oats'), false)
is('"Stephen" to "Stephanie" is not, however alike they start', G.sameLabel('Stephen', 'Stephanie'), false)
is('"Delete" to "Delete all" is not: a word was added', G.sameLabel('Delete', 'Delete all'), false)
is('"Add" to "Added" is the same button', G.sameLabel('Add', 'Added'), true)
is('where figures tell rows apart, "Step 1" to "Step 2" is not', G.sameLabel('Step 1', 'Step 2', true), false)
is('a price with no letters holds its figures', G.sameLabel('$12', '$14'), false)

{
  // a panel whose title changed, at exactly the same place, is another panel
  const A = RECIPES
  const B = withRows(A, A.rows.map(r => r.id === 'shak' ? { ...r, name: 'Pancakes' } : r.id === 'pan' ? { ...r, name: 'Waffles' } : r))
  const ra = render(A), a = T.elementsFrom(ra.raw)
  const panel = a.find(e => e.kind === 'panel' && /Shakshuka/.test(e.text))
  const b = T.elementsFrom(render(B).raw).map(e => ({ ...e }))
  // hand the old id to the panel in the same place, the way a position-only match does
  const there = b.find(e => e.kind === 'panel' && /Pancakes/.test(e.text) && Math.abs(e.box.y - panel.box.y) < 0.001)
  b.forEach(e => { if (e.id === panel.id) e.id = 'E99' })
  there.id = panel.id
  const w = G.identify(panel, a)
  const v = G.judge(w, b, { act: 'open' })
  is('a card whose title went from one recipe to another is refused, whatever its position', [v.ok, v.reason], [false, 'words'])
  is('the refusal says what it was and what to do', /the "Shakshuka Edit Delete" panel.*Call find_on_screen again/.test(v.say), true)

  // the same panel with a stat ticking over is the same panel
  const S = withRows(A, A.rows.map(r => ({ ...r, meta: r.id === 'shak' ? '3 cooks' : null })))
  const S2 = withRows(A, A.rows.map(r => ({ ...r, meta: r.id === 'shak' ? '4 cooks' : null })))
  const sa = T.elementsFrom(render(S).raw), sb = T.elementsFrom(render(S2).raw)
  const sp = sa.find(e => e.kind === 'panel' && /Shakshuka/.test(e.text))
  const np = sb.find(e => e.kind === 'panel' && /Shakshuka/.test(e.text))
  const moved = sb.map(e => e === np ? { ...e, id: sp.id } : e.id === sp.id ? { ...e, id: 'E98' } : e)
  is('a panel whose stat ticked over keeps its id', G.judge(G.identify(sp, sa), moved).ok, true)
}

// ── the judgement's cases ───────────────────────────────────────────────────
console.log('\na reordered list of panels')
{
  const top = pair(RECIPES, withRows(RECIPES, [RECIPES.rows[3], RECIPES.rows[0], RECIPES.rows[1], RECIPES.rows[2]]), 'place')
  is('Pancakes favourited to the top: no id passes onto a different element', top.wrong, [])
  is('... though the matcher by place handed ids to the wrong recipes', top.carriedWrong > 0, true)
  const sh = idOf(top.a, 'Shakshuka Edit Delete', 'panel')
  is('... the Shakshuka panel\'s id is refused on its own words', top.verdicts.get(sh) && top.verdicts.get(sh).reason, 'words')
  is('... the title and tabs keep theirs', ['Recipes', 'Home', 'Search', 'Profile'].every(t => top.kept.includes(idOf(top.a, t))), true)
  for (const how of ['real', 'place']) {
    const drag = pair(RECIPES, withRows(RECIPES, [RECIPES.rows[0], RECIPES.rows[1], RECIPES.rows[3], RECIPES.rows[2]]), how)
    is(`Pancakes dragged up one, matched ${how === 'real' ? 'by targets.js' : 'by place'}: no id passes onto a different element`, drag.wrong, [])
  }
  // the ledger turns the matcher's mistake into an id that died
  const r = top.L.record(top.b)
  is('the ledger reissues every id the matcher gave to another recipe', r.reissued.length, top.carriedWrong)
  is('... and none of the reissued ids is still on the list', r.list.some(e => r.reissued.some(x => x.from === e.id)), false)
  is('... and the old id says it was spent', top.L.check(sh, r.list).reason, 'spent')
  const fresh = r.list.find(e => e.kind === 'panel' && /Shakshuka/.test(e.text))
  is('... and the Shakshuka panel\'s new id is good on the next look', top.L.check(fresh.id, r.list).ok, true)
  is('... numbered past every id handed out', +fresh.id.slice(1) > Math.max(...top.a.map(e => +e.id.slice(1))), true)
}

console.log('\na taller nav title')
{
  const w = (text, x, y, ww, h = 0.02) => ({ text, conf: 1, box: { x, y, w: ww, h }, bg: '#FFFFFF' })
  const chip = (text, x, y, ww, h = 0.022) => ({ ...w(text, x, y, ww, h), container: { x: x - 0.01, y: y - 0.008, w: ww + 0.02, h: h + 0.016 }, bg: '#222222' })
  const page = (name, time, nameY = 0.14) => ({ width: 1290, height: 2796, texts: [w('Recipes', 0.3, 0.05, 0.4, 0.04),
    w(name, 0.1, nameY, 0.4, 0.028), w(time, 0.1, nameY + 0.05, 0.12, 0.018), w('Ingredients', 0.1, 0.6, 0.3),
    chip('Edit', 0.1, 0.85, 0.2), chip('Delete recipe', 0.55, 0.85, 0.3)] })
  const through = (A, B, text, how = 'place') => {
    const a = T.elementsFrom(A), b = how === 'place' ? byPlace(a, B) : T.elementsFrom(B, a), L = G.ledger()
    L.record(a)
    const id = idOf(a, text)
    return { carried: idOf(b, text) === id, v: L.check(id, b, { act: 'tap' }), a, b, L }
  }
  const nav = through(page('Shakshuka', '25 min'), page('Pancakes', '15 min'), 'Delete recipe')
  is('Shakshuka\'s "Delete recipe" carried to Pancakes\' page by a matcher', nav.carried, true)
  is('... is refused: the screen shows another recipe', [nav.v.ok, nav.v.reason], [false, 'screen'])
  is('... and the sentence names both', /showing "Shakshuka", and that place now shows "Pancakes"/.test(nav.v.say), true)
  is('... and by targets.js it is refused or not carried at all',
    (x => !x.carried || !x.v.ok)(through(page('Shakshuka', '25 min'), page('Pancakes', '15 min'), 'Delete recipe', 'real')), true)
  const low = through(page('Shakshuka', '25 min', 0.45), page('Pancakes', '15 min', 0.45), 'Delete recipe')
  is('with the name below a hero image, well out of the top quarter, still refused', [low.v.ok, low.v.reason], [false, 'screen'])
  const edit = through(page('Shakshuka', '25 min'), page('Shakshuka', '30 min'), 'Delete recipe')
  // This used to keep the id. It refuses now, on purpose: the rule that stops "#1042"
  // turning into "#1043" and an approval for $120 turning into one for $80 is that a
  // changed figure may be a different item, and nothing on this screen tells a recipe
  // whose time was edited from another recipe that shares its name. A refusal costs the
  // agent one call to find it again; letting it through could delete the wrong recipe.
  is('the same recipe with its time edited is refused rather than trusted', [edit.v.ok, edit.v.reason && typeof edit.v.reason], [false, 'string'])
  const noNav = { width: 1290, height: 2796, texts: [w('Recipes', 0.3, 0.05, 0.4, 0.04), w('Shakshuka', 0.1, 0.14, 0.4, 0.028),
    chip('Delete recipe', 0.55, 0.85, 0.3)] }
  const scrolled = { width: 1290, height: 2796, texts: [w('Recipes', 0.3, 0.05, 0.4, 0.04), chip('Delete recipe', 0.55, 0.85, 0.3)] }
  is('the name scrolled away with nothing in its place is not a new screen',
    through(noNav, scrolled, 'Delete recipe').v.ok, true)
  const fav = (who) => ({ width: 1290, height: 2796, texts: [w('Favourites', 0.1, 0.05, 0.4, 0.04), w(who, 0.1, 0.3, 0.3), chip('Call', 0.7, 0.3, 0.1)] })
  const call = through(fav('Alice Smith'), fav('Bob Jones'), 'Call')
  is('the only Call on a one-row list, its name changed from Alice to Bob, is refused', [call.v.ok, call.v.reason], [false, 'row'])
}

console.log('\na deleted row')
{
  const del = pair(RECIPES, withRows(RECIPES, RECIPES.rows.filter(r => r.id !== 'shak')))
  is('Shakshuka deleted: no id passes onto a different element', del.wrong, [])
  const shDelete = del.a.filter(e => e.text === 'Delete')[1].id
  is('... Shakshuka\'s Delete names nothing now', del.L.check(shDelete, del.b).ok, false)
  const toastDelete = del.a.filter(e => e.text === 'Delete')[2].id
  const tv = del.L.check(toastDelete, del.b)
  is('... French toast\'s Delete, closed up into the gap, is still French toast\'s or refused, never another\'s',
    tv.ok ? /French toast/.test(del.b.find(e => e.id === tv.element.in).text) : true, true)
  // a matcher that lost its row rule entirely: hand every Delete the id of the one at its place
  const a = del.a, b = del.b.map(e => ({ ...e }))
  const olds = a.filter(e => e.text === 'Delete'), news = b.filter(e => e.text === 'Delete')
  news.forEach((e, i) => { b.forEach(x => { if (x.id === olds[i].id && x !== e) x.id = 'X' + i }); e.id = olds[i].id })
  const v = G.judge(G.identify(olds[1], a), b, { act: 'tap' })
  is('Shakshuka\'s Delete handed by position to French toast\'s is refused by its home', [v.ok, v.reason], [false, 'home'])
  const flat = { title: 'Recipes', y0: 0.2, rows: ['Morning oats', 'Shakshuka', 'French toast'].map((n, i) => ({ id: 'f' + i, name: n, btns: ['Delete'] })) }
  const fa = T.elementsFrom(render(flat).raw)
  const fb = T.elementsFrom(render(withRows(flat, flat.rows.filter(r => r.id !== 'f1'))).raw).map(e => ({ ...e }))
  const fo = fa.filter(e => e.text === 'Delete'), fn = fb.filter(e => e.text === 'Delete')
  fn.forEach((e, i) => { fb.forEach(x => { if (x.id === fo[i].id && x !== e) x.id = 'Y' + i }); e.id = fo[i].id })
  const fv = G.judge(G.identify(fo[1], fa), fb)
  is('on a flat list with no cards, the row it sat in refuses it', [fv.ok, fv.reason], [false, 'row'])
  const notes = { title: 'Notes', y0: 0.2, rows: [0, 1, 2].map(i => recipeCard('n' + i, 'Untitled')) }
  const un = pair(notes, withRows(notes, notes.rows.slice(1)))
  is('three "Untitled" cards, the first deleted: no id passes onto a different card', un.wrong, [])
}

console.log('\ntwo identical buttons')
{
  const bar = { title: 'Album', y0: 0.3, rows: [{ id: 'bar', btns: ['Share', 'Share'], chips: true }] }
  const w = (text, x, y, ww, h = 0.022) => ({ text, conf: 1, box: { x, y, w: ww, h }, bg: '#222222', container: { x: x - 0.01, y: y - 0.008, w: ww + 0.02, h: h + 0.016 } })
  const a = T.elementsFrom(render(bar).raw)
  const [s1, s2] = a.filter(e => e.text === 'Share')
  is('both Shares pass on the picture they were minted on', [G.judge(G.identify(s1, a), a).ok, G.judge(G.identify(s2, a), a).ok], [true, true])
  const swapped = a.map(e => e === s1 ? { ...e, id: s2.id } : e === s2 ? { ...e, id: s1.id } : e)
  const v = G.judge(G.identify(s1, a), swapped)
  is('the first Share\'s id handed to the second is refused', [v.ok, v.reason], [false, 'order'])
  const one = { width: 1290, height: 2796, texts: [{ text: 'Album', conf: 1, box: { x: 0.35, y: 0.05, w: 0.3, h: 0.035 }, bg: '#FFFFFF' }, w('Share', 0.62, 0.3, 0.1)] }
  const b = T.elementsFrom(one).map(e => e.text === 'Share' ? { ...e, id: s1.id } : e)
  const v1 = G.judge(G.identify(s1, a), b)
  is('one of two gone: the one left is not known to be the first, so it is refused', [v1.ok, v1.reason], [false, 'order'])
}

console.log('\na row that scrolled')
{
  const sc = pair(RECIPES, withRows(RECIPES, RECIPES.rows, { y0: 0.15 }))
  is('the list scrolled 0.05: no id passes onto a different element', sc.wrong, [])
  const deletes = sc.a.filter(e => e.text === 'Delete').map(e => e.id)
  is('... every Delete the matcher carried keeps its id, held by its card\'s name',
    deletes.filter(id => sc.b.some(e => e.id === id)).every(id => sc.kept.includes(id)), true)
  is('... every recipe panel keeps its id', sc.a.filter(e => e.kind === 'panel').every(e => sc.kept.includes(e.id)), true)
  const notes = { title: 'Notes', y0: 0.2, rows: [0, 1, 2].map(i => recipeCard('n' + i, 'Untitled')) }
  const na = T.elementsFrom(render(notes).raw)
  const nb = T.elementsFrom(render({ ...notes, y0: 0.15 }).raw)
  const card = na.filter(e => e.kind === 'panel')[1]
  const there = nb.filter(e => e.kind === 'panel')[1]
  const nb2 = nb.map(e => e === there ? { ...e, id: card.id } : e.id === card.id ? { ...e, id: 'E97' } : e)
  const v = G.judge(G.identify(card, na), nb2)
  is('an "Untitled" card, named by nothing but its place, is refused once it scrolled', [v.ok, v.reason], [false, 'place'])
}

// ── the attacks on the guard itself ───────────────────────────────────────
// Each one a case where the guard let an id through onto a different element, from the
// round that attacked it (/tmp/majuro-attack, /tmp/atk-nav, /tmp/attack-guard). Every
// one failed before its fix.
console.log('\nattacks on the guard')
{
  const W = (text, x, y, ww, h, container) => ({ text, conf: 1, box: { x, y, w: ww, h }, bg: container ? '#222222' : '#FFFFFF', ...(container ? { container } : {}) })
  const chip = (text, x, y, ww = 0.2) => W(text, x, y, ww, 0.022, { x: x - 0.01, y: y - 0.008, w: ww + 0.02, h: 0.038 })
  // A picture, then the next one read by the real matcher (or by place alone), both held
  // to one ledger the way the bridge holds them. The id is checked as a tap would be.
  const across = (A, B, pickA, how = 'real') => {
    const L = G.ledger()
    const a = L.record(T.elementsFrom(A), { frame: { width: A.width, height: A.height } }).list
    const bRaw = how === 'place' ? byPlace(a, B) : T.elementsFrom(B, a)
    const b = L.record(bRaw, { frame: { width: B.width, height: B.height } }).list
    const id = pickA(a).id
    return { a, b, id, v: L.check(id, b, { act: 'tap' }) }
  }
  const refused = x => x.v.ok ? `let through onto "${x.v.element.text}"` : 'refused'

  // 1. An item named by a number, under a hero picture: Invoice 1042 deleted, the app
  // moves on to Invoice 1043. The number is what names it.
  const invoice = (num, amount, due) => ({ width: 1290, height: 2796, rects: [], texts: [
    W('Invoices', 0.3, 0.06, 0.4, 0.04), W('Invoice ' + num, 0.08, 0.40, 0.4, 0.03),
    W('Acme Corp', 0.08, 0.46, 0.25, 0.022), W(amount, 0.08, 0.51, 0.2, 0.022), W('Due ' + due, 0.08, 0.56, 0.2, 0.022),
    chip('Mark as paid', 0.1, 0.9), chip('Delete invoice', 0.6, 0.9)] })
  const delInv = l => l.find(e => e.text === 'Delete invoice')
  is('"Delete invoice" on Invoice 1042 is refused on Invoice 1043\'s page',
    refused(across(invoice('1042', '$1,200.00', 'Oct 3'), invoice('1043', '$880.00', 'Oct 17'), delInv)), 'refused')
  is('... and when the two invoices are for the same sum, due the same day',
    refused(across(invoice('1042', '$1,200.00', 'Oct 3'), invoice('1043', '$1,200.00', 'Oct 3'), delInv)), 'refused')
  is('... and with a matcher that carries everything by place',
    refused(across(invoice('1042', '$1,200.00', 'Oct 3'), invoice('1043', '$1,200.00', 'Oct 3'), delInv, 'place')), 'refused')
  is('... and "Invoice 1042" itself, carried by place onto "Invoice 1043"',
    refused(across(invoice('1042', '$1,200.00', 'Oct 3'), invoice('1043', '$1,200.00', 'Oct 3'), l => l.find(e => e.text === 'Invoice 1042'), 'place')), 'refused')
  const queue = num => ({ width: 1290, height: 2796, rects: [], texts: [
    W('Refunds', 0.3, 0.06, 0.4, 0.04), W('Order #' + num, 0.08, 0.42, 0.3, 0.03), W('Maya Chen', 0.08, 0.47, 0.3, 0.022),
    chip('Approve refund', 0.1, 0.9), chip('Decline', 0.6, 0.9)] })
  is('a refund queue: "Approve refund" on Order #1042 is refused on Maya\'s next order',
    refused(across(queue('1042'), queue('1043'), l => l.find(e => e.text === 'Approve refund'))), 'refused')
  is('... while the same order read again keeps it',
    refused(across(queue('1042'), queue('1042'), l => l.find(e => e.text === 'Approve refund'))), 'let through onto "Approve refund"')

  // 2. Rows told apart by a numbered name and a day: Order 1044 (Wed) deleted, Order 1045,
  // also a Wednesday, scrolls into its place.
  const orders = rows => ({ width: 1290, height: 2796, rects: [], texts: [W('Orders', 0.35, 0.05, 0.3, 0.035),
    ...rows.flatMap(([n, day], i) => { const y = 0.2 + i * 0.07
      return [W('Order ' + n, 0.1, y, 0.2, 0.022), W(day, 0.42, y, 0.08, 0.022), chip('Delete', 0.76, y, 0.1)] })] })
  const third = l => l.filter(e => e.text === 'Delete')[2]
  is('Order 1044\'s Delete is refused beside Order 1045, though both rows say Wed',
    refused(across(orders([['1042', 'Mon'], ['1043', 'Tue'], ['1044', 'Wed']]), orders([['1042', 'Mon'], ['1043', 'Tue'], ['1045', 'Wed']]), third)), 'refused')
  is('... and the same rows read again keep it',
    refused(across(orders([['1042', 'Mon'], ['1043', 'Tue'], ['1044', 'Wed']]), orders([['1042', 'Mon'], ['1043', 'Tue'], ['1044', 'Wed']]), third)), 'let through onto "Delete"')

  // 6. Row words held exactly, and two rows that now both carry them
  const list = (names, btns) => ({ width: 1290, height: 2796, rects: [], texts: [W('Items', 0.35, 0.05, 0.3, 0.035),
    ...names.flatMap((n, i) => { const y = 0.2 + i * 0.07
      return [W(n, 0.1, y, 0.04 + 0.012 * n.length, 0.022), ...btns.map((b, k) => chip(b, 0.62 + k * 0.14, y, 0.1))] })] })
  const beside = (name, btn) => l => { const n = l.find(e => e.text === name); return l.find(e => e.text === btn && Math.abs(e.box.y - n.box.y) < 0.01) }
  is('Shakshuka\'s Delete, carried by place into Green shakshuka\'s row, is refused',
    refused(across(list(['Shakshuka', 'Pancakes', 'Green shakshuka'], ['Edit', 'Delete']),
      list(['Green shakshuka', 'Shakshuka', 'Pancakes'], ['Edit', 'Delete']), beside('Shakshuka', 'Delete'), 'place')), 'refused')
  is('Anne Lee\'s Refund, carried by place beside Ann Lee, is refused',
    refused(across(list(['Anne Lee', 'Ross Hall', 'Ann Lee'], ['Refund']), list(['Ann Lee', 'Anne Lee', 'Ross Hall'], ['Refund']),
      beside('Anne Lee', 'Refund'), 'place')), 'refused')
  is('a "Notes" label carried by place onto "Note" is refused',
    refused(across(list(['Notes', 'Drafts'], ['Delete']), list(['Note', 'Drafts'], ['Delete']), l => l.find(e => e.text === 'Notes'), 'place')), 'refused')
  is('a "Bake" label carried by place onto "Baked" as the list moved is refused',
    refused(across(list(['Bake', 'Drafts', 'Note'], ['Delete']), list(['Baked', 'Drafts', 'Note', 'Notes'], ['Delete']), l => l.find(e => e.text === 'Bake'), 'place')), 'refused')
  {
    const L = G.ledger(), a = T.elementsFrom(list(['Pancakes'], ['Save']))
    L.record(a)
    const save = a.find(e => e.text === 'Save')
    const b = T.elementsFrom(list(['Pancakes'], ['Saved'])).map(e => e.text === 'Saved' ? { ...e, id: save.id } : e.id === save.id ? { ...e, id: 'E90' } : e)
    is('"Save" showing "Saved" in place on a screen that stayed still passes', L.check(save.id, b).ok, true)
  }

  // 7 and 15. A detail screen whose item name has company on its line, or is small
  const hero = (name, meta, lines) => {
    const texts = [W('Recipes', 0.04, 0.06, 0.2, 0.022), W('Edit', 0.86, 0.06, 0.1, 0.022),
      W(name, 0.06, 0.31, 0.025 * name.length, 0.03), W(meta, 0.7, 0.315, 0.12, 0.022)]
    lines.forEach((l, i) => texts.push(W(l, 0.08, 0.43 + i * 0.06, 0.012 * l.length + 0.05, 0.022)))
    texts.push({ ...W('Delete recipe', 0.3, 0.9, 0.4, 0.022, { x: 0.1, y: 0.885, w: 0.8, h: 0.05 }), bg: '#CC2222' })
    return { width: 1290, height: 2796, texts, rects: [{ box: { x: 0, y: 0.09, w: 1, h: 0.2 }, conf: 1, bg: '#886644' },
      { box: { x: 0.04, y: 0.4, w: 0.92, h: 0.3 }, conf: 1, bg: '#F2F2F2', edges: true }] }
  }
  const delRecipe = l => l.find(e => e.text === 'Delete recipe')
  for (const how of ['real', 'place']) {
    is(`"Delete recipe" under a hero, the name beside its time, is refused on the next recipe (${how})`,
      refused(across(hero('Shakshuka', '25 min', ['2 eggs', '1 can tomatoes', '1 onion']),
        hero('Pancakes', '15 min', ['2 cups flour', '1 egg', '1 cup milk']), delRecipe, how)), 'refused')
  }
  const small = (name, mins) => ({ width: 1290, height: 2796, rects: [], texts: [
    W('Recipes', 0.3, 0.05, 0.4, 0.035), W(`${name} · ${mins} min`, 0.08, 0.12, 0.4, 0.016),
    W('Edit recipe', 0.08, 0.3, 0.3, 0.022), W('Add to meal plan', 0.08, 0.36, 0.4, 0.022),
    W('Share recipe', 0.08, 0.42, 0.3, 0.022), W('Delete recipe', 0.08, 0.48, 0.32, 0.022)] })
  for (const how of ['real', 'place']) {
    is(`"Delete recipe" under a small subtitle is refused once it names the next recipe (${how})`,
      refused(across(small('Shakshuka', 20), small('Pancakes', 15), delRecipe, how)), 'refused')
  }
  // refused for the same reason as the edited time above: a changed figure may be a
  // different item, and one more call is cheaper than the wrong recipe
  is('... and refused when only the minutes changed', refused(across(small('Shakshuka', 20), small('Shakshuka', 25), delRecipe)), 'refused')
  const beside2 = (name, body) => ({ width: 1290, height: 2796, rects: [], texts: [
    W('Recipes', 0.3, 0.05, 0.4, 0.035), W(name, 0.08, 0.14, 0.3, 0.03), chip('Favourite', 0.75, 0.14, 0.1),
    ...body.map((b, i) => W(b, 0.08, 0.25 + i * 0.05, 0.5, 0.018)), W('Delete recipe', 0.35, 0.92, 0.3, 0.022)] })
  is('a title sharing its line with a chip, carried by place, is refused',
    refused(across(beside2('Shakshuka', ['Eggs in tomato sauce', 'Serves two people']),
      beside2('Pancakes', ['Fluffy stack with syrup', 'Serves four people']), delRecipe, 'place')), 'refused')
  const inCard = (name, body) => ({ width: 1290, height: 2796, texts: [
    W('Recipes', 0.3, 0.05, 0.4, 0.035), W(name, 0.1, 0.2, 0.3, 0.03), W(body, 0.1, 0.26, 0.5, 0.022),
    W('Delete recipe', 0.35, 0.92, 0.3, 0.022)], rects: [{ box: { x: 0.05, y: 0.15, w: 0.9, h: 0.2 }, conf: 1, bg: '#EEEEEE', edges: true }] })
  is('a title inside a hero card, carried by place, is refused',
    refused(across(inCard('Shakshuka', 'Eggs in tomato sauce'), inCard('Pancakes', 'Fluffy stack with syrup'), delRecipe, 'place')), 'refused')
}

// The attack's own fuzzer (/tmp/majuro-attack/fuzz.js): rows from pools built to collide
// (names one letter apart, numbered names, plurals), with a hidden identity per row,
// read by the real matcher and by one that carries by place alone. Held to zero wrong.
console.log('\nthe attack\'s rows, fuzzed')
{
  let seed = 1
  const rnd = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296 }
  const pick = a => a[Math.floor(rnd() * a.length)]
  const W = (text, x, y, ww, h, container) => ({ text, conf: 1, box: { x, y, w: ww, h }, bg: container ? '#222222' : '#FFFFFF', ...(container ? { container } : {}) })
  const chip = (text, x, y) => W(text, x, y, 0.1, 0.022, { x: x - 0.01, y: y - 0.008, w: 0.12, h: 0.038 })
  const POOLS = {
    stems: ['Ann Lee', 'Anne Lee', 'Ross Hall', 'Rose Hall', 'Dan Park', 'Dane Park', 'Jan Wu', 'Jane Wu'],
    orders: ['Order 1042', 'Order 1043', 'Order 1044', 'Order 1045', 'Order 1046', 'Order 1047'],
    mixed: ['Maya Chen 1042', 'Maya Chen 1043', 'Omar Ali 1040', 'Lee Kim 1039', 'Maya Chen 1044'],
    recipes: ['Pancakes', 'Banana pancakes', 'Shakshuka', 'Green shakshuka', 'Oats', 'Baked oats', 'Morning oats'],
    plurals: ['Note', 'Notes', 'Draft', 'Drafts', 'Baked', 'Bake', 'Baking'],
  }
  const screen = (rows, style) => {
    const texts = [W('Items', 0.35, 0.05, 0.3, 0.035)], rects = []
    rows.forEach((r, i) => { const y = 0.2 + i * 0.07
      if (style.card) rects.push({ box: { x: 0.04, y: y - 0.01, w: 0.92, h: 0.065 }, conf: 1, bg: '#EEEEEE', edges: true })
      texts.push(W(r.name, 0.1, y, 0.04 + 0.012 * r.name.length, 0.022))
      if (style.meta) texts.push(W(r.meta, 0.42, y, 0.1, 0.022))
      for (const [k, b] of style.buttons.entries()) texts.push(chip(b, 0.62 + k * 0.14, y)) })
    return { width: 1290, height: 2796, texts, rects }
  }
  const who = (e, rows) => {
    if (e.box.y < 0.15) return 'top'
    const r = rows[Math.floor((e.box.y + e.box.h / 2 - 0.19) / 0.07)]
    if (!r) return '?'
    return r.uid + ':' + (e.kind === 'panel' || e.kind === 'card' || e.kind === 'grid' ? e.kind : (e.text === r.name ? 'name' : e.text))
  }
  const RUNS = Math.max(400, Math.round((+process.env.GUARD_SEEDS || 1500) * 0.8))
  const tally = { real: { acts: 0, wrong: [] }, place: { acts: 0, wrong: [] } }
  for (const how in tally) {
    seed = 1
    for (let n = 0; n < RUNS; n++) {
      const pool = POOLS[pick(Object.keys(POOLS))]
      const style = { card: rnd() < 0.6, meta: rnd() < 0.4, buttons: pick([['Delete'], ['Edit', 'Delete'], ['Share', 'Share'], ['Refund']]) }
      let uid = 0
      const mk = name => ({ name, uid: ++uid, meta: pick(['3 min', 'Draft', 'Mon', '$40']) })
      const names = pool.slice().sort(() => rnd() - 0.5)
      const shown = 3 + Math.floor(rnd() * 3)
      const A = names.slice(0, shown).map(mk), spare = names.slice(shown).map(mk)
      let B = A.slice()
      const op = pick(['delete', 'insert', 'swap', 'totop', 'rename', 'delete+scroll', 'shuffle'])
      if (op === 'delete') B.splice(Math.floor(rnd() * B.length), 1)
      if (op === 'insert' && spare.length) B.splice(Math.floor(rnd() * B.length), 0, spare[0])
      if (op === 'swap') { const i = Math.floor(rnd() * (B.length - 1)); [B[i], B[i + 1]] = [B[i + 1], B[i]] }
      if (op === 'totop') { const i = 1 + Math.floor(rnd() * (B.length - 1)); B = [B[i], ...B.filter((_, j) => j !== i)] }
      if (op === 'rename' && spare.length) { const i = Math.floor(rnd() * B.length); B[i] = { ...B[i], name: spare[0].name } }
      if (op === 'delete+scroll' && spare.length) { B.splice(Math.floor(rnd() * B.length), 1); B.push(spare[0]) }
      if (op === 'shuffle') B = B.slice().sort(() => rnd() - 0.5)
      const L = G.ledger(), frame = { width: 1290, height: 2796 }
      const a = L.record(T.elementsFrom(screen(A, style)), { frame }).list
      const b = L.record(how === 'place' ? byPlace(a, screen(B, style)) : T.elementsFrom(screen(B, style), a), { frame }).list
      const idA = new Map(a.map(e => [e.id, who(e, A)]))
      for (const e of b) {
        if (!idA.has(e.id)) continue
        const v = L.check(e.id, b, { frame })
        if (!v.ok) continue
        tally[how].acts++
        const was = idA.get(e.id), now = who(v.element, B)
        if (was !== now && tally[how].wrong.length < 3) tally[how].wrong.push(`${n} ${op} ${e.id} ${was} -> ${now} "${v.element.text}"`)
      }
    }
    console.log(`  ${MATCHERS[how]}: ${tally[how].acts} ids let through over ${RUNS} pairs`)
    is(`${MATCHERS[how]}, colliding rows: no id let through onto a different element`, tally[how].wrong, [])
  }
}

console.log('\nwhat the guard lets through')
{
  const still = pair(RECIPES, withRows(RECIPES, RECIPES.rows, { extra: [{ text: 'Synced', x: 0.7, y: 0.12, w: 0.1 }] }))
  is('a screen that only gained a small note keeps every id', still.refused, [])
  const a = T.elementsFrom(render(RECIPES).raw)
  const L = G.ledger()
  L.record(a)
  is('every id passes on the picture it was minted on', a.every(e => L.check(e.id, a).ok), true)
  is('an id never shown is refused, not guessed', L.check('E400', a).reason, 'unknown')
  const btn = { title: 'Recipes', y0: 0.2, rows: [recipeCard('shak', 'Shakshuka')] }
  const ba = T.elementsFrom(render(btn).raw)
  const del = ba.find(e => e.text === 'Delete')
  const bb = T.elementsFrom(render(withRows(btn, [{ ...btn.rows[0], btns: ['Edit', 'Deleting...'] }])).raw)
    .map(e => e.text === 'Deleting...' ? { ...e, id: del.id } : e)
  is('a Delete showing "Deleting..." in the same card passes', G.judge(G.identify(del, ba), bb).ok, true)
  const moved = pair(RECIPES, withRows(RECIPES, [RECIPES.rows[3], RECIPES.rows[0], RECIPES.rows[1], RECIPES.rows[2]]), 'order')
  const sentences = [...moved.verdicts.values()].filter(v => !v.ok).map(v => v.say)
  is('refusals were made to read', sentences.length > 0, true)
  is('no sentence carries a long dash', sentences.some(x => /[\u2013\u2014]/.test(x)), false)
  is('every refusal says to call find_on_screen again', sentences.every(x => /Call find_on_screen again/.test(x)), true)
  let thrown = null
  try { L.confirm('E400', a, { act: 'tap' }) } catch (err) { thrown = err }
  is('confirm throws the sentence, with its reason, for a caller that acts', [!!thrown, thrown && thrown.reason], [true, 'unknown'])
}

// ── the promise, fuzzed ─────────────────────────────────────────────────────
// The judgement's own generator, on a fixed range of seeds: row styles (unique names,
// all "Untitled", no names, "Step N", mixed), buttons, chips or plain words, cards,
// thumbnails, metas, and ten operations. Held to zero ids let through onto a different
// element, which the matcher alone failed on panels.
console.log('\nthe promise, over seeded screens')
{
  let rnd = 1
  const R = () => (rnd = (rnd * 16807) % 2147483647) / 2147483647
  const pick = a => a[Math.floor(R() * a.length)]
  const names = ['Morning oats', 'Shakshuka', 'French toast', 'Pancakes', 'Granola', 'Congee', 'Porridge', 'Waffles']
  let runs = 0
  const tally = { real: null, place: null, order: null }
  for (const how in tally) tally[how] = { wrong: 0, carriedWrong: 0, kept: 0, seen: 0, first: [] }
  const SEEDS = +process.env.GUARD_SEEDS || 1500
  for (let seed = 1; seed <= SEEDS; seed++) {
    rnd = seed * 7919 % 2147483647 || 1
    const n = 2 + Math.floor(R() * 5)
    const style = pick(['uniq', 'dupname', 'noname', 'counted', 'mixed'])
    const btns = pick([['Delete'], ['Edit', 'Delete'], ['Share', 'Share'], ['Delete', 'Delete']])
    const chips = R() < 0.5, card = R() < 0.4, thumb = R() < 0.3, meta = pick([null, 'count', 'same', 'uniq'])
    const rows = Array.from({ length: n }, (_, i) => ({ id: 'r' + i,
      name: style === 'uniq' ? names[i] : style === 'dupname' ? 'Untitled' : style === 'noname' ? null
        : style === 'counted' ? 'Step ' + (i + 1) : (i % 2 ? names[i] : 'Untitled'),
      meta: meta === 'count' ? (i + 2) + ' min' : meta === 'same' ? 'Draft' : meta === 'uniq' ? ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][i] : null,
      btns: btns.slice(), chips, card, thumb }))
    const A = { title: pick(['Recipes', null]), sub: R() < 0.3 ? 'Breakfast' : null, y0: 0.2, rows, tabs: R() < 0.5 ? ['Home', 'Search', 'Profile'] : [] }
    const op = pick(['delete', 'delete', 'insertTop', 'swap', 'scroll', 'rename', 'renumber', 'retitle', 'deleteLastScrollIn', 'moveToTop'])
    const k = Math.floor(R() * n)
    const B = JSON.parse(JSON.stringify(A))
    if (op === 'delete') B.rows.splice(k, 1)
    if (op === 'insertTop') B.rows.unshift({ ...B.rows[0], id: 'new', name: A.rows[0].name == null ? null : style === 'uniq' ? 'Brand new' : A.rows[0].name, meta: A.rows[0].meta })
    if (op === 'swap' && n > 1) { const j = (k + 1) % n; [B.rows[k], B.rows[j]] = [B.rows[j], B.rows[k]] }
    if (op === 'scroll') B.y0 -= pick([0.07, 0.035, 0.14, 0.01])
    if (op === 'rename') B.rows[k].name = B.rows[k].name == null ? null : 'Renamed'
    if (op === 'renumber') { B.rows.splice(k, 1); if (style === 'counted') B.rows.forEach((r, i) => { r.name = 'Step ' + (i + 1) }) }
    if (op === 'retitle') { B.title = A.title ? 'Dinner' : null; B.rows = B.rows.map((r, i) => ({ ...r, id: 'o' + i })) }
    if (op === 'deleteLastScrollIn') { B.rows.splice(k, 1); B.rows.push({ ...A.rows[n - 1], id: 'in', name: style === 'uniq' ? 'Waffles' : A.rows[n - 1].name }) }
    if (op === 'moveToTop') { const [r] = B.rows.splice(k, 1); B.rows.unshift(r) }
    if (JSON.stringify(render(A).raw) === JSON.stringify(render(B).raw)) continue
    runs++
    for (const how in tally) {
      const p = pair(A, B, how), t = tally[how]
      t.wrong += p.wrong.length; t.carriedWrong += p.carriedWrong; t.kept += p.kept.length; t.seen += p.verdicts.size
      if (p.wrong.length && t.first.length < 3) t.first.push(`seed ${seed} ${style}/${op}: ${p.wrong[0]}`)
    }
  }
  for (const how in tally) {
    const t = tally[how]
    console.log(`  matched ${MATCHERS[how]}: ${t.seen} carried ids over ${runs} pairs, ` +
      `${t.carriedWrong} on a different element. The guard kept ${t.kept} of the ${t.seen - t.carriedWrong} right ones ` +
      `and let ${t.wrong} wrong ones through`)
    is(`matched ${MATCHERS[how]}, no id is let through onto a different element`, t.first, [])
  }
  is('the blind matchers are wrong often enough to test the guard', tally.place.carriedWrong > 1000 && tally.order.carriedWrong > 1000, true)
  is('... and of the ids targets.js carried rightly, the guard keeps nearly all',
    tally.real.kept >= 0.95 * (tally.real.seen - tally.real.carriedWrong), true)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
