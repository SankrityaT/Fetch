// The editor previews explicit zooms with Overlays.zoomView. It has to show the move
// the export makes, so it is checked against processor.js's own zoompan expression.
const O = require('../ui/overlays')
const P = require('../processor')

let pass = 0, fail = 0
const is = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}` +
    (ok ? '' : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`))
}
const r3 = n => Math.round(n * 1000) / 1000

// ffmpeg's expression functions, enough to evaluate what zoomExpr builds
const fns = {
  if: (c, a, b) => (c ? a : b), lt: (a, b) => (a < b ? 1 : 0),
  between: (x, a, b) => (x >= a && x <= b ? 1 : 0), min: Math.min, max: Math.max, exp: Math.exp,
}
// `if` is a keyword in JS, so it is renamed on the way in
const evalAt = (expr, t) => Function('F', 'in_time', `return ${expr.replace(/\b(if|lt|between|min|max|exp)\(/g, 'F.$1(')}`)(fns, t)

// the export's window at t: zoom level and the crop zoompan takes, as 0..1 of the frame
function exported(zooms, t, curve) {
  const f = P.explicitZoomFilter(zooms, { width: 1000, height: 1000, fps: 30 }, x => x, { w: 1000, h: 1000 }, curve).filter
  const z = evalAt(/z='([^']+)'/.exec(f)[1], t)
  // x='iw*(1-1/zoom)*(n)': n is the fraction of its own travel the window sits at, so
  // the origin is that fraction of 1 - w and there is no clamp left to apply
  const pick = k => /\(1-1\/zoom\)\*\((.+)\)$/.exec(new RegExp(`:${k}='([^']+)'`).exec(f)[1])[1]
  const nx = evalAt(pick('x'), t), ny = evalAt(pick('y'), t), w = 1 / z
  return { s: r3(z), x: r3((1 - w) * nx), y: r3((1 - w) * ny) }
}
const view = (zooms, t, curve) => { const v = O.zoomView(zooms, t, curve); return { s: r3(v.s), x: r3(v.x), y: r3(v.y) } }

const Z = [
  { id: 'Z1', start: 0, end: 2, scale: 1.8, x: 0.3, y: 0.4 },
  { id: 'Z2', start: 5, end: 5.5, scale: 2.4, x: 0.95, y: 0.05 },
  { id: 'Z3', start: 8, end: 12, scale: 1.5 },
]
let same = true, worst = null
for (let t = 0; t <= 13; t += 0.05) {
  const a = view(Z, t), b = exported(Z, t)
  if (Math.abs(a.s - b.s) > 0.002 || Math.abs(a.x - b.x) > 0.002 || Math.abs(a.y - b.y) > 0.002) { same = false; worst = { t, a, b } }
}
is('the preview follows the exported zoom frame by frame', worst, null)
is('...and did check', same, true)

is('outside every zoom the whole frame shows', O.zoomView(Z, 3), { s: 1, x: 0, y: 0, w: 1, h: 1 })
is('no zooms, no zoom', O.zoomView(null, 1).s, 1)
is('Z1 at 0:01 is fully in, centred on its point', view(Z, 1), { s: 1.8, x: r3(0.3 - 0.5 / 1.8), y: r3(0.4 - 0.5 / 1.8) })
// Half the ramp is well past half the distance: the move is over early and the rest of
// it is the arrival. Geometric, so halfway "in" is the square root of the scale, 1.342.
const ease1 = O.easeSpan(1, 1.8, 'smooth')
const mid = O.zoomView(Z, ease1 / 2).s
is('the push is over early and the rest of it is the settle', [r3(ease1), r3(mid)], [0.454, 1.512])
is('a deeper zoom is given longer to get there', O.easeSpan(1, 4) > O.easeSpan(1, 1.2) * 2, true)
// every option leaves rest and arrives at rest, and none of them passes the target
for (const k of Object.keys(O.EASES)) {
  let over = 0, back = 0, last = 0
  for (let p = 0; p <= 1.0001; p += 0.002) {
    const v = O.easeAt(p, k)
    if (v > 1 + 1e-12) over++
    if (v < last - 1e-12) back++
    last = v
  }
  is(`${k} never overshoots and never goes back`, [over, back, O.easeAt(0, k), O.easeAt(1, k),
    r3(O.easeVel(0, k)), r3(O.easeVel(1, k)), r3(O.easeAcc(0, k)), r3(O.easeAcc(1, k))], [0, 0, 0, 1, 0, 0, 0, 0])
}
is('a zoom aimed at the corner stops at the frame edge', view(Z, 5.25).x + 1 / 2.4 <= 1.0005 && view(Z, 5.25).y === 0, true)
is('an unset point centres the zoom', view(Z, 10), { s: 1.5, x: r3(0.5 - 0.5 / 1.5), y: r3(0.5 - 0.5 / 1.5) })
is('scale is clamped as the export clamps it', r3(O.zoomView([{ start: 0, end: 4, scale: 9 }], 2).s), 4)

// Zooms back to back pan across instead of pulling out and pushing back in
const PAN = [
  { start: 1, end: 4, scale: 1.7, x: 0.8, y: 0.7 },
  { start: 4, end: 7, scale: 1.5, x: 0.2, y: 0.2 },
  { start: 7.5, end: 9, scale: 2, x: 0.5, y: 0.5 },
  { start: 12, end: 14, scale: 1.6 },
]
let panSame = true, panWorst = null, lowest = 9
for (let t = 0; t <= 15; t += 0.05) {
  const a = view(PAN, t), b = exported(PAN, t)
  if (Math.abs(a.s - b.s) > 0.002 || Math.abs(a.x - b.x) > 0.002 || Math.abs(a.y - b.y) > 0.002) { panSame = false; panWorst = { t, a, b } }
  if (t > 1.5 && t < 8.5) lowest = Math.min(lowest, a.s)
}
is('a pan between zooms previews as it exports', panWorst, null)
is('...and did check', panSame, true)
is('zooms under a second apart never drop to the whole frame between them', lowest > 1.1, true)
// far apart (0.8, 0.7 to 0.2, 0.2), the camera eases back while it travels, and lands
const pan1 = O.zoomPlan(PAN)[1]
const far = [O.zoomView(PAN, pan1.inStart).s, O.zoomView(PAN, (pan1.inStart + pan1.inEnd) / 2).s, O.zoomView(PAN, pan1.inEnd).s]
is('a far pan eases back mid-move and lands on the second zoom', [r3(far[0]), far[1] < 1.4, r3(far[2])], [1.7, true, 1.5])
const NEAR = [{ start: 1, end: 4, scale: 1.7, x: 0.5, y: 0.5 }, { start: 4, end: 7, scale: 1.5, x: 0.6, y: 0.55 }]
const near1 = O.zoomPlan(NEAR)[1]
const mid2 = O.zoomView(NEAR, (near1.inStart + near1.inEnd) / 2).s
is('a near pan starts where the second zoom does and eases between the two scales',
  mid2 < 1.7 && mid2 > 1.5 && r3(O.zoomView(NEAR, near1.inStart - 0.001).s) === 1.7, true)
is('a zoom well after the last still pushes in from the whole frame', r3(O.zoomView(PAN, 11.9).s), 1)

// motion.zoomEase is drawn by both engines, not only by the compositor: the ffmpeg
// expression carries the same S(g(p)) the stage evaluates, bias and all
for (const curve of Object.keys(O.EASES)) {
  let bad = null, checked = 0, apart = 0
  for (let t = 0; t <= 15; t += 0.05) {
    const a = view(PAN, t, curve), b = exported(PAN, t, curve)
    checked++
    if (Math.abs(a.s - b.s) > 0.002 || Math.abs(a.x - b.x) > 0.002 || Math.abs(a.y - b.y) > 0.002) bad = { t, a, b }
    apart = Math.max(apart, Math.abs(a.s - view(PAN, t, 'gentle').s))
  }
  is(`${curve} exports as it previews`, [bad, checked > 250], [null, true])
  if (curve !== 'gentle') is(`...and ${curve} is a different move from gentle`, apart > 0.05, true)
}
const plan = O.zoomPlan(PAN)
is('the pans are planned from the zoom before', plan.map(m => !!m.from), [false, true, true, false])

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
