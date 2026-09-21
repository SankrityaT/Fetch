// Every screen a wrong-element tap would cost someone something on.
//   node test/guard-breaches.test.js
//
// Each scenario is two screens with a hidden truth under every element, so the test knows
// which item an id really lands on, not just whether an id was kept. They were found by an
// adversarial judge trying to make Fetch approve the wrong amount, refund the wrong order,
// cancel the wrong appointment or delete the wrong recipe, and every one of them happened
// before ui/guard.js counted figures as part of an item's identity.
//
// Two matchers run each scenario. The real one is ui/targets.js. The other carries every
// id to whatever now sits nearest the same place, which is the dumbest thing a matcher
// could do: it is here to ask whether the guard still stops an action when the matcher is
// wrong, because the guard exists precisely so that safety does not depend on the matcher.
//
// Two rules, and they are different on purpose:
//   the real matcher must never land an action on a different item. Zero, always.
//   the dumb matcher's wrong carries that slip past the guard may not grow. Today three
//   screens let some through (a card whose amount changed, a photo grid that shifted, a
//   turned device); closing one lowers PLACE_CEILING, and nothing may raise it.

const PLACE_CEILING = 8
const results = []

// harness: screens as items with a hidden truth, real matcher and a by-place matcher, real ledger
const R = require('path').join(__dirname, '..', 'ui') + '/'
const T = require(R + 'targets'), G = require(R + 'guard')
const iou = (a, b) => { const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y), x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h)
  const i = Math.max(0, x1 - x0) * Math.max(0, y1 - y0); return i / (a.w * a.h + b.w * b.h - i) }
// item: {t, x, y, w, h, chip, truth} text; {rect:{x,y,w,h}, truth, edges} shape/card
function raw(items, frame = { width: 1290, height: 2796 }) {
  const texts = [], rects = [], truths = []
  for (const it of items) {
    if (it.rect) { rects.push({ box: it.rect, conf: 1, bg: it.bg || '#EEEEEE', edges: it.edges !== false }); truths.push({ box: it.rect, truth: it.truth }); continue }
    const box = { x: it.x, y: it.y, w: it.w || 0.012 * it.t.length + 0.02, h: it.h || 0.022 }
    const t = { text: it.t, conf: 1, box, bg: it.chip ? '#222222' : '#FFFFFF' }
    if (it.chip) t.container = { x: box.x - 0.01, y: box.y - 0.008, w: box.w + 0.02, h: box.h + 0.016 }
    texts.push(t); truths.push({ box: t.container || box, truth: it.truth || 'txt:' + it.t })
  }
  return { raw: { ...frame, texts, rects }, truths }
}
const truthOf = (el, truths) => { let best = null, bv = 0.5; for (const t of truths) { const v = iou(el.box, t.box); if (v > bv) { bv = v; best = t.truth } } return best }
function byPlace(a, bRaw) {
  const b = T.elementsFrom(bRaw), used = new Set(); let seq = Math.max(...a.map(e => +e.id.slice(1)))
  const SORT = { text: 'w', chip: 'w', icon: 'w', card: 'c', shape: 'c', panel: 'p', grid: 'g' }
  const out = b.map(e => { let best = null, bd = 0.06
    for (const p of a) { if (used.has(p.id) || SORT[p.kind] !== SORT[e.kind]) continue
      const d = Math.hypot(p.box.x - e.box.x, p.box.y - e.box.y); if (d < bd) { bd = d; best = p } }
    if (best) used.add(best.id); return { ...e, id: best ? best.id : 'E' + (++seq) } })
  Object.defineProperty(out, 'frame', { value: b.frame }); return out
}
function run(name, A, B, o = {}) {
  const res = {}
  for (const how of ['real', 'place']) {
    const L = G.ledger(), ra = raw(A, o.fa), rb = raw(B, o.fb)
    const a = L.record(T.elementsFrom(ra.raw), { frame: { width: ra.raw.width, height: ra.raw.height } }).list
    const bl = how === 'real' ? T.elementsFrom(rb.raw, a) : byPlace(a, rb.raw)
    const b = L.record(bl, { frame: { width: rb.raw.width, height: rb.raw.height } }).list
    const wrong = [], kept = [], refused = []
    for (const e of a) {
      const v = L.check(e.id, b, { frame: { width: rb.raw.width, height: rb.raw.height }, act: 'tap' })
      const was = truthOf(e, ra.truths)
      if (!v.ok) { refused.push(`${e.id}:${v.reason}`); continue }
      const now = truthOf(v.element, rb.truths)
      if (was !== now) wrong.push(`${e.id} "${e.text}" [${was}] -> "${v.element.text}" [${now}]`)
      else kept.push(e.id)
    }
    res[how] = { wrong, kept: kept.length, refused: refused.length }
  }
  results.push({ name, real: res.real, place: res.place })
  return res
}



{
const tabs = [['Home', 0.1], ['Search', 0.4], ['Profile', 0.7]].map(([t, x]) => ({ t, x, y: 0.93, chip: true, truth: 'tab:' + t }))
const body = [{ t: 'Notes', x: 0.1, y: 0.5, truth: 'b1' }, { t: 'Bring the referral letter', x: 0.1, y: 0.55, truth: 'b2' }, { t: 'Arrive ten minutes early', x: 0.1, y: 0.6, truth: 'b3' }]
// H1 approval queue, one row, same person, another amount
const q = (amt, tag) => [{ t: 'Approvals', x: 0.3, y: 0.05, h: 0.035, truth: 'title' },
  { t: 'Maya Chen', x: 0.1, y: 0.2, truth: 'name:' + tag }, { t: amt, x: 0.45, y: 0.2, truth: 'amt:' + tag }, { t: 'Approve', x: 0.72, y: 0.2, chip: true, truth: 'approve:' + tag }, ...tabs]
run('H1 approval queue: Maya $120 approved, Maya $80 slides into the row', q('$120.00', 'x1'), q('$80.00', 'x2'))
run('H1b same, row in a card', [...q('$120.00', 'x1'), { rect: { x: 0.04, y: 0.19, w: 0.92, h: 0.05 }, truth: 'card:x1' }], [...q('$80.00', 'x2'), { rect: { x: 0.04, y: 0.19, w: 0.92, h: 0.05 }, truth: 'card:x2' }])
// H2 weekly appointment, cancel moves on to next week's
const appt = (date, tag) => [{ t: 'Appointment', x: 0.3, y: 0.05, h: 0.04, truth: 'nav' }, { t: 'Dr. Patel', x: 0.1, y: 0.12, h: 0.03, truth: 'doc' },
  { t: date, x: 0.1, y: 0.3, truth: 'date:' + tag }, { t: '10:00', x: 0.1, y: 0.35, truth: 'time:' + tag }, ...body,
  { t: 'Cancel appointment', x: 0.25, y: 0.85, chip: true, truth: 'cancel:' + tag }, ...tabs]
run('H2 weekly appointment: Tue 14 Oct cancelled, Tue 21 Oct shown', appt('Tue 14 Oct', 'a14'), appt('Tue 21 Oct', 'a21'))
run('H2b date in the top quarter, small', appt('Tue 14 Oct', 'a14').map(e => e.truth === 'date:a14' ? { ...e, y: 0.17, h: 0.016 } : e), appt('Tue 21 Oct', 'a21').map(e => e.truth === 'date:a21' ? { ...e, y: 0.17, h: 0.016 } : e))
// H3 receipt emails from one sender
const mail = (date, amt, tag) => [{ t: 'Inbox', x: 0.1, y: 0.05, truth: 'nav' }, { t: 'Your ride receipt', x: 0.1, y: 0.12, h: 0.03, truth: 'subj:' + tag },
  { t: 'Rides', x: 0.1, y: 0.18, truth: 'from' }, { t: date, x: 0.6, y: 0.18, truth: 'date:' + tag }, { t: 'Total ' + amt, x: 0.1, y: 0.35, h: 0.03, truth: 'total:' + tag },
  { t: 'Thanks for riding with us', x: 0.1, y: 0.42, truth: 'b' }, { t: 'Archive', x: 0.1, y: 0.88, chip: true, truth: 'arch:' + tag }, { t: 'Reply', x: 0.5, y: 0.88, chip: true, truth: 'reply:' + tag }]
run('H3 receipt mail archived, next receipt from the same sender', mail('Sep 12', '$14.20', 'm1'), mail('Sep 19', '$9.80', 'm2'))
// H4 order detail, number only in figures
const order = (num, tag) => [{ t: 'Order', x: 0.4, y: 0.05, h: 0.04, truth: 'nav' }, { t: num, x: 0.1, y: 0.12, h: 0.018, truth: 'num:' + tag },
  { t: 'Oat milk', x: 0.1, y: 0.3, truth: 'i1' }, { t: 'Bread', x: 0.1, y: 0.35, truth: 'i2' }, { t: 'Refund order', x: 0.3, y: 0.85, chip: true, truth: 'refund:' + tag }]
run('H4 order detail: #1042 refunded, #1043 same items shown', order('#1042', 'o42'), order('#1043', 'o43'))
// H5 photo grid, one photo deleted, all shift
const grid = ids => [{ t: 'Photos', x: 0.35, y: 0.05, h: 0.035, truth: 'title' }, { t: 'Select', x: 0.8, y: 0.05, truth: 'select' },
  ...ids.map((id, i) => ({ rect: { x: 0.02 + (i % 3) * 0.33, y: 0.15 + Math.floor(i / 3) * 0.16, w: 0.3, h: 0.15 }, bg: '#88' + (40 + i) + '88', edges: false, truth: 'photo:' + id })), ...tabs]
run('H5 photo grid: first photo deleted, the rest shift up one', grid(['p1', 'p2', 'p3', 'p4', 'p5', 'p6']), grid(['p2', 'p3', 'p4', 'p5', 'p6', 'p7']))
// H6 rows with repeated names, differing only in amount
const tx = rows => [{ t: 'Activity', x: 0.35, y: 0.05, h: 0.035, truth: 'title' }, ...rows.flatMap(([id, n, amt], i) => [{ t: n, x: 0.1, y: 0.2 + i * 0.06, truth: 'n:' + id }, { t: amt, x: 0.45, y: 0.2 + i * 0.06, truth: 'amt:' + id }, { t: 'Refund', x: 0.75, y: 0.2 + i * 0.06, chip: true, truth: 'refund:' + id }]), ...tabs]
run('H6 two Coffee Bar rows, first refunded and gone', tx([['t1', 'Coffee Bar', '$4.50'], ['t2', 'Coffee Bar', '$6.20'], ['t3', 'Bakery', '$3.00']]), tx([['t2', 'Coffee Bar', '$6.20'], ['t3', 'Bakery', '$3.00']]))
run('H6b one Coffee Bar row, refunded, next Coffee Bar row scrolls into its place', tx([['t1', 'Coffee Bar', '$4.50'], ['t3', 'Bakery', '$3.00']]), tx([['t2', 'Coffee Bar', '$6.20'], ['t3', 'Bakery', '$3.00']]))
// H7 the device turned: another frame shape, the next recipe
const det = (name) => [{ t: 'Recipes', x: 0.3, y: 0.05, h: 0.04, truth: 'nav' }, { t: name, x: 0.1, y: 0.12, h: 0.03, truth: 'name:' + name }, { t: 'Delete recipe', x: 0.3, y: 0.85, chip: true, truth: 'del:' + name }]
run('H7 turned sideways and moved to the next recipe', det('Shakshuka'), det('Pancakes'), { fb: { width: 2796, height: 1290 } })
// H8 toggle rows: settings with switches (shapes), rows reorder
const sw = rows => [{ t: 'Settings', x: 0.35, y: 0.05, h: 0.035, truth: 'title' }, ...rows.flatMap((n, i) => [{ t: n, x: 0.1, y: 0.2 + i * 0.06, truth: 'n:' + n }, { rect: { x: 0.8, y: 0.195 + i * 0.06, w: 0.12, h: 0.035 }, bg: '#33CC55', edges: false, truth: 'sw:' + n }])]
run('H8 settings rows reordered, switches have no words', sw(['Wi-Fi', 'Bluetooth', 'Airplane']), sw(['Bluetooth', 'Wi-Fi', 'Airplane']))
}
{
const tabs = [['Home', 0.1], ['Search', 0.4], ['Profile', 0.7]].map(([t, x]) => ({ t, x, y: 0.93, chip: true, truth: 'tab:' + t }))
const q = rows => [{ t: 'Approvals', x: 0.3, y: 0.05, h: 0.035, truth: 'title' }, ...rows.flatMap(([id, n, amt], i) => [{ t: n, x: 0.1, y: 0.2 + i * 0.06, truth: 'n:' + id }, { t: amt, x: 0.45, y: 0.2 + i * 0.06, truth: 'amt:' + id }, { t: 'Approve', x: 0.72, y: 0.2 + i * 0.06, chip: true, truth: 'ap:' + id }]), ...tabs]
run('H1c two rows: Maya $120 approved, Maya $80 arrives in its place, Tom stays', q([['m1', 'Maya Chen', '$120.00'], ['t', 'Tom Ruiz', '$45.00']]), q([['m2', 'Maya Chen', '$80.00'], ['t', 'Tom Ruiz', '$45.00']]))
run('H1d three rows, Maya $80 was below Tom and moves up to the top on approve', q([['m1', 'Maya Chen', '$120.00'], ['t', 'Tom Ruiz', '$45.00'], ['s', 'Sam Oh', '$12.00']]), q([['t', 'Tom Ruiz', '$45.00'], ['m2', 'Maya Chen', '$80.00'], ['s', 'Sam Oh', '$12.00']]))
// with a date line instead of an amount
const q2 = rows => [{ t: 'Timesheets', x: 0.3, y: 0.05, h: 0.035, truth: 'title' }, ...rows.flatMap(([id, n, d], i) => [{ t: n, x: 0.1, y: 0.2 + i * 0.06, truth: 'n:' + id }, { t: d, x: 0.45, y: 0.2 + i * 0.06, h: 0.018, truth: 'd:' + id }, { t: 'Approve', x: 0.72, y: 0.2 + i * 0.06, chip: true, truth: 'ap:' + id }]), ...tabs]
run('H1e timesheets: Maya week of 7 Sep approved, Maya week of 14 Sep in its place', q2([['m1', 'Maya Chen', 'Week of 7 Sep'], ['t', 'Tom Ruiz', 'Week of 7 Sep']]), q2([['m2', 'Maya Chen', 'Week of 14 Sep'], ['t', 'Tom Ruiz', 'Week of 7 Sep']]))
}
{
const ev = (date, tag) => [{ t: 'Calendar', x: 0.05, y: 0.05, truth: 'back' }, { t: 'Team standup', x: 0.1, y: 0.12, h: 0.035, truth: 'title' },
  { t: date, x: 0.1, y: 0.17, h: 0.018, truth: 'date:' + tag }, { t: '9:30 to 9:45', x: 0.1, y: 0.2, h: 0.018, truth: 'time' },
  { t: 'Repeats every weekday', x: 0.1, y: 0.3, truth: 'rep' }, { t: 'Room 4, second floor', x: 0.1, y: 0.35, truth: 'room' },
  { t: 'Delete event', x: 0.3, y: 0.85, chip: true, truth: 'del:' + tag }]
run('H9 recurring event: Tue 14 Oct deleted, the view moves to Wed 15 Oct', ev('Tuesday 14 October', 'd14'), ev('Wednesday 15 October', 'd15'))
run('H9b same weekday next week', ev('Tuesday 14 October', 'd14'), ev('Tuesday 21 October', 'd21'))
}

let bad = 0
const wrongReal = results.filter(r => r.real.wrong.length)
for (const r of results) {
  const ok = !r.real.wrong.length
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${r.name}` + (r.real.wrong.length ? '\n       ' + r.real.wrong.join('\n       ') : ''))
  if (!ok) bad++
}
const placeWrong = results.reduce((n, r) => n + r.place.wrong.length, 0)
const leaky = results.filter(r => r.place.wrong.length).map(r => r.name)
console.log(`\ndumb matcher: ${placeWrong} wrong carries got past the guard (ceiling ${PLACE_CEILING})` +
  (leaky.length ? '\n  ' + leaky.join('\n  ') : ''))
if (placeWrong > PLACE_CEILING) { console.log(`FAIL the guard lets more through than it did (${placeWrong} > ${PLACE_CEILING})`); bad++ }
if (placeWrong < PLACE_CEILING) console.log(`note: fewer than the ceiling, so lower PLACE_CEILING to ${placeWrong}`)

console.log(`\n${results.length - wrongReal.length} of ${results.length} screens safe with the real matcher, ${bad ? bad + ' failed' : '0 failed'}`)
process.exit(bad ? 1 : 0)
