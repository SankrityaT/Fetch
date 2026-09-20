// The zoom's move, judged as a move rather than as a frame. Everything else about the
// compositor is checked one still at a time, and a still cannot tell you whether the
// camera arrived or was caught.
//
// No GPU here on purpose: what moves is the window, and the window is Plan.framePlan's
// view0 at every frame of the output. Sampling that gives the scale and the centre per
// frame, and differencing it gives velocity and acceleration in frames, which is the
// unit the eye actually judges. A jolt is a step in the second difference.
const O = require('../ui/overlays')
const Plan = require('../ui/compositor/plan')

let pass = 0, fail = 0
const is = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}` +
    (ok ? '' : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`))
}
const r = (n, k = 4) => Math.round(n * 10 ** k) / 10 ** k
const meta = { width: 1920, height: 1080, duration: 20, fps: 60 }

// Every frame of a plan: scale, centre, and the differences between neighbours.
// d1 is per frame, so it is directly what the frame after this one moves by.
function march(spec, fps, from, to) {
  const f = []
  for (let n = Math.round(from * fps); n <= Math.round(to * fps); n++) {
    const p = Plan.framePlan(spec, n / fps)
    const [x, y, w] = p.view0
    f.push({ n, t: n / fps, s: 1 / w, cx: x + w / 2, cy: y + w / 2, taps: p.taps, speed: p.speed })
  }
  const diff = (list, k) => list.map((v, i) => (i ? v[k] - list[i - 1][k] : 0))
  // in the log, because what the eye reads of a zoom is the rate of magnification
  const ls = f.map(v => Math.log(v.s))
  const d1 = ls.map((v, i) => (i ? v - ls[i - 1] : 0))
  const d2 = d1.map((v, i) => (i ? v - d1[i - 1] : 0))
  const d3 = d2.map((v, i) => (i ? v - d2[i - 1] : 0))
  return { f, d1, d2, d3, dx: diff(f, 'cx'), dy: diff(f, 'cy') }
}
const peak = a => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0)
// A fixed shuffle rather than Math.random, so a failure here comes back the same way
// the next time it is run.
const shuffle = (list, seed = 20250919) => {
  const a = [...list]
  let s = seed >>> 0
  for (let i = a.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0
    const j = s % (i + 1)
    const t = a[i]; a[i] = a[j]; a[j] = t
  }
  return a
}

// ── the curves, before anything reads them ──────────────────────────────────
// Every section below this reads a curve through a plan, and a plan can hide a fault
// in a curve behind a clamp: a jump the frame grid happens to step over, a velocity
// that is not the derivative of the value it is sold as. So the curves are judged
// first, as functions of progress, on a grid 20,000 steps fine. That is about 300
// samples per frame of the longest ramp any ease can ask for, so nothing the eye could
// land on is between two samples.

console.log('the ease is a curve before it is a move')
{
  const N = 20000, h = 1e-4
  for (const kind of Object.keys(O.EASES)) {
    let back = 0, over = 0, vBack = 0, stepV = 0, stepD = 0, pv = 0, pa = 0, atPv = 0
    let last = O.easeAt(0, kind), lastD = O.easeVel(0, kind)
    for (let i = 1; i <= N; i++) {
      const p = i / N, v = O.easeAt(p, kind), d = O.easeVel(p, kind)
      if (v < last - 1e-12) back++
      if (v > 1 + 1e-12) over++
      if (d < -1e-12) vBack++
      stepV = Math.max(stepV, Math.abs(v - last))
      stepD = Math.max(stepD, Math.abs(d - lastD))
      if (d > pv) { pv = d; atPv = p }
      pa = Math.max(pa, Math.abs(O.easeAcc(p, kind)))
      last = v; lastD = d
    }
    is(`${kind}: starts at 0, lands on 1, and is at rest at both ends`,
      [O.easeAt(0, kind), O.easeAt(1, kind), O.easeVel(0, kind), O.easeVel(1, kind),
        O.easeAcc(0, kind), O.easeAcc(1, kind)], [0, 1, 0, 0, 0, 0])
    // no overshoot is a decision, not an accident: DESIGN.md gives bounce to Biscuit
    // and to nothing else, so a camera that passes its target and comes back is a bug
    is(`${kind}: monotone in progress, and it never passes its target`, [back, over, vBack], [0, 0, 0])
    // continuity, stated as a bound rather than by eye: over a step of 1/N a continuous
    // curve moves at most its own peak slope over N, and a jump would be orders above it
    is(`${kind}: continuous in value and in velocity`, [stepV < 4 * pv / N, stepD < 4 * pa / N], [true, true])
    // and the velocity has to be the derivative of the value, because the motion blur
    // spends its samples on it: a velocity that is a curve of its own smears the wrong
    // frames by the wrong amount and nothing on screen would say so
    let eV = 0, eA = 0
    for (let i = 1; i < 2000; i++) {
      const p = i / 2000
      eV = Math.max(eV, Math.abs((O.easeAt(p + h, kind) - O.easeAt(p - h, kind)) / (2 * h) - O.easeVel(p, kind)))
      eA = Math.max(eA, Math.abs((O.easeVel(p + h, kind) - O.easeVel(p - h, kind)) / (2 * h) - O.easeAcc(p, kind)))
    }
    is(`${kind}: the analytic velocity is the value's own derivative`, [eV < 1e-5, eA < 1e-4], [true, true])
    console.log(`       ${kind.padEnd(7)} peak E' ${r(pv, 3)} at p ${r(atPv, 2)}, peak E'' ${r(pa, 2)}, ` +
      `largest step ${stepV.toExponential(2)} in value and ${stepD.toExponential(2)} in velocity, ` +
      `derivative off by ${eV.toExponential(2)}`)
  }
  // the four are four moves and not one with three aliases
  const apart = (a, b) => { let m = 0; for (let i = 0; i <= 100; i++) m = Math.max(m, Math.abs(O.easeAt(i / 100, a) - O.easeAt(i / 100, b))); return m }
  is('the four options are four different moves', Object.keys(O.EASES).every((a, i, all) =>
    all.slice(i + 1).every(b => apart(a, b) > 0.03)), true)
}

console.log('the same progress gives the same number, whenever it is asked')
{
  // the rule the whole engine rests on, at the smallest scale it can be checked at:
  // a curve read out of order is the same curve. Nothing here caches, integrates or
  // remembers, and this is what says so.
  const ps = Array.from({ length: 1001 }, (_, i) => i / 1000)
  for (const kind of Object.keys(O.EASES)) {
    const inOrder = ps.map(p => [O.easeAt(p, kind), O.easeVel(p, kind), O.easeAcc(p, kind)])
    const out = new Array(ps.length)
    for (const i of shuffle([...ps.keys()])) out[i] = [O.easeAt(ps[i], kind), O.easeVel(ps[i], kind), O.easeAcc(ps[i], kind)]
    // and again, to catch anything that only settles on the second reading
    const twice = ps.map(p => [O.easeAt(p, kind), O.easeVel(p, kind), O.easeAcc(p, kind)])
    is(`${kind}: asked out of order, and asked twice, it is the same curve`,
      [JSON.stringify(out) === JSON.stringify(inOrder), JSON.stringify(twice) === JSON.stringify(inOrder)], [true, true])
  }
}

console.log('a dissolve rides the same quintic, unwarped')
{
  // the warp is what makes a zoom a shot rather than a slide, and it is exactly what a
  // dissolve must not have: the crossover has to land on the boundary the timeline
  // names, and that is the unwarped curve's own symmetry
  is('it is exactly half at the middle of the window', O.easeS(0.5), 0.5)
  is('and at rest at both ends', [O.easeS(0), O.easeS(1), O.easeSVel(0), O.easeSVel(1)], [0, 1, 0, 0])
  let back = 0, over = 0, sym = 0, last = 0
  for (let i = 0; i <= 20000; i++) {
    const u = i / 20000, v = O.easeS(u)
    if (v > 1 + 1e-12) over++
    if (i && v < last - 1e-12) back++
    sym = Math.max(sym, Math.abs(v + O.easeS(1 - u) - 1))
    last = v
  }
  is('monotone, no overshoot, and symmetric about the middle', [back, over, sym < 1e-12], [0, 0, true])
}

console.log('a zoom leaves rest, covers its distance and settles')
{
  const spec = Plan.prepare({ zooms: [{ start: 1, end: 6, scale: 2.2, x: 0.25, y: 0.3 }] }, meta)
  const m = march(spec, 60, 0.5, 6.5)
  const z = O.zoomPlan(spec.zooms)[0]

  is('the curve starts at rest and ends at rest',
    [r(m.d1[1], 6), r(m.d1[m.d1.length - 1], 6)], [0, 0])
  is('and it really did travel', r(Math.max(...m.f.map(v => v.s)), 3), 2.2)

  // continuity: no frame moves much more than the one beside it. The numbers are the
  // peak of each difference, in log-scale per frame, and the peak of the next one over.
  const v = peak(m.d1), a = peak(m.d2), j = peak(m.d3)
  console.log(`       peak velocity ${r(v, 5)}/frame, acceleration ${r(a, 5)}, jerk ${r(j, 5)}`)
  console.log(`       acceleration as a share of velocity ${r(a / v, 4)}, jerk of acceleration ${r(j / a, 4)}`)
  // a gate against getting worse, not a law: at 60 fps over a ramp this long the
  // acceleration a frame carries is a seventh of its velocity and the jerk a third of
  // that, which is a curve the eye reads as one move
  is('acceleration is small against velocity', a / v < 0.2, true)
  is('jerk is small against acceleration', j / a < 0.5, true)

  // a jolt is a step in the second difference at the moment of arrival. Smoothstep put
  // the whole of its acceleration there, one frame wide; the quintic arrives with none.
  const frameAt = t => m.f.findIndex(q => q.t >= t - 1e-9)
  const atArrival = Math.abs(m.d2[frameAt(z.inEnd)])
  const atLeave = Math.abs(m.d2[frameAt(z.inStart) + 1])
  console.log(`       acceleration at the leave ${r(atLeave, 6)}, at the arrival ${r(atArrival, 6)}, peak ${r(a, 6)}`)
  is('nothing lands on the arrival', atArrival < a * 0.05, true)
  is('and nothing on the leave', atLeave < a * 0.05, true)

  // the old curve, for the record: smoothstep's acceleration at the ends is 6/T^2,
  // which is its own peak. This is the jolt the round was called for.
  const T = z.inEnd - z.inStart, fr = 1 / 60
  const smoothAcc = Math.log(2.2) * 6 * fr * fr / (T * T)
  console.log(`       the old smoothstep would have put ${r(smoothAcc, 6)} on both, which was its peak`)
  is('the old curve put its peak acceleration on both ends', atArrival < smoothAcc * 0.05, true)
}

console.log('nothing jumps between adjacent frames, anywhere in the take')
{
  // two zooms that pan across, one far enough to dip, and a third well after
  const zooms = [{ start: 1, end: 4, scale: 1.7, x: 0.8, y: 0.7 },
    { start: 4, end: 7, scale: 1.5, x: 0.2, y: 0.2 },
    { start: 8.5, end: 11, scale: 2.4, x: 0.5, y: 0.5 }]
  for (const ease of Object.keys(O.EASES)) {
    const spec = Plan.prepare({ zooms, look: { motion: { zoomEase: ease } } }, meta)
    const m = march(spec, 60, 0, 12)
    const v = peak(m.d1), a = peak(m.d2), j = peak(m.d3)
    const c = Math.max(peak(m.dx), peak(m.dy))
    is(`${ease}: velocity, acceleration and jerk all stay bounded`,
      [a / v < 0.3, j / a < 0.75, c < 0.05], [true, true, true])
    console.log(`       ${ease.padEnd(7)} peak v ${r(v, 5)}  a ${r(a, 5)}  j ${r(j, 5)}  a/v ${r(a / v, 4)}  centre ${r(c, 5)}/frame`)
    // the handover between two moments is the one place the plan could tear
    let worst = 0
    for (let i = 1; i < m.d1.length; i++) worst = Math.max(worst, Math.abs(m.d2[i]))
    is(`${ease}: no single frame steps out of line`, worst < 4 * a / 3, true)
  }
}

console.log('a zoom the frame edge holds in still changes speed like one it does not')
{
  // The fault the motion pass measured (.context/survey/motion-taste.md): where a zoom
  // asks for a focus a window that wide cannot reach, the view sits against the frame's
  // edge and then comes off it, and on the one frame it comes off the picture changed
  // speed by 11 to 19 percent. The constraint is right; reading it as a clamp at every
  // instant is what was not continuous. These are the three moves that showed it, at
  // the numbers the edit they were measured on actually uses.
  const held = [{ start: 1, end: 5, scale: 2.2, x: 0.594, y: 0.78 },
    { start: 7, end: 11, scale: 1.94, x: 0.4425, y: 0.2575 },
    { start: 13, end: 17, scale: 1.72, x: 0.4955, y: 0.4405 }]
  // and one whose focus is well inside the frame, which never touched the edge and so
  // never had the fault: it is the yardstick for what a smooth ramp at 60 fps measures
  const free = [{ start: 1, end: 5, scale: 1.71, x: 0.5, y: 0.5 }]
  const worstKink = zooms => {
    const spec = Plan.prepare({ zooms }, meta)
    const tr = [], N = Math.round(19 * 60)
    for (let n = 1; n <= N; n++) tr[n] = Plan.travel(spec, Plan.viewAt(spec, (n - 1) / 60), Plan.viewAt(spec, n / 60))
    let out = 0, peak = 0, kink = 0
    for (let n = 2; n < N; n++) {
      const v = Plan.viewAt(spec, n / 60)
      out = Math.max(out, -Math.min(v[0], v[1], 1 - v[0] - v[2], 1 - v[1] - v[3]))
      peak = Math.max(peak, tr[n])
      if (tr[n] > 0.02) kink = Math.max(kink, Math.abs(tr[n] - (tr[n - 1] + tr[n + 1]) / 2))
    }
    return { kink: kink / peak, out, peak }
  }
  const a = worstKink(held), b = worstKink(free)
  is('a move the edge holds in has no frame of its own out of line', r(a.kink, 4) < 0.05, true)
  is('...no worse than a move the edge never touches', a.kink < b.kink * 2.5, true)
  is('and the window is still inside the frame on every frame of it', a.out <= 1e-9, true)
  console.log(`       held in ${r(100 * a.kink, 1)}% of ${r(a.peak, 1)} px, free ${r(100 * b.kink, 1)}% of ${r(b.peak, 1)} px`)
}

console.log('the shutter reads the move, not the dial')
{
  const spec = Plan.prepare({ zooms: [{ start: 1, end: 6, scale: 2.2, x: 0.25, y: 0.3 }] }, meta)
  const m = march(spec, 60, 0.5, 6.5)
  const moving = m.f.filter(q => q.speed > 0)
  const held = m.f.filter(q => q.speed === 0)
  is('a held frame takes one sample', held.every(q => q.taps === 1), true)
  is('a moving frame takes more', moving.some(q => q.taps > 8), true)
  is('and never more than the shader draws', m.f.every(q => q.taps <= 32), true)
  // the taps follow the speed, which is the whole claim
  const byTap = [...moving].sort((a, b) => a.speed - b.speed)
  is('the samples rise with the speed', byTap.every((q, i) => i === 0 || q.taps >= byTap[i - 1].taps - 1), true)
  const fastest = moving.reduce((p, q) => (q.speed > p.speed ? q : p))
  console.log(`       fastest frame ${r(fastest.speed, 0)} px/s, ${fastest.taps} samples; ` +
    `held frames ${held.length} at 1 sample`)
}

console.log('depth is a fit, and auto zoom gets the same move')
{
  const proc = require('../processor')
  const display = { x: 0, y: 0, width: 1440, height: 900 }
  // the anchor: 1.7 is the depth at which a thing two fifths of the picture across sits
  // at the 70 percent fit ui/targets.js frames a named box with
  is('the dial read as a fit', [r(O.fitScale(0.41, 1.7), 3), r(O.fitScale(0.2, 2.4), 3), r(O.fitScale(0.45, 2.4), 3)],
    [1.7, 2.4, 1.556])

  // a run of clicks across a toolbar: the moment frames the run rather than diving in
  const across = [[2000, 300, 300], [2400, 470, 305], [2800, 640, 300], [3200, 810, 305]]
  const wide = proc.zoomMoments({ kind: 'display', display, clicks: across }, { zoom: 2.4 })
  const tight = proc.zoomMoments({ kind: 'display', display, clicks: [[2000, 700, 300], [2300, 706, 304]] }, { zoom: 2.4 })
  is('a wide run pulls back, a tight one takes the dial', [r(wide[0].scale, 2), r(tight[0].scale, 2)], [1.98, 2.4])
  is('the wide run spans about 70 percent of its view', r((810 - 300) / 1440 * wide[0].scale, 2), 0.7)
  is('and the dial is a ceiling, never a floor',
    r(proc.zoomMoments({ kind: 'display', display, clicks: across })[0].scale, 2), 1.7)

  // and the compositor draws that moment whole, ramps, pan and all
  const spec = Plan.prepare({ autoZoom: true }, meta, { prepared: { autoZooms: wide.map(q => ({
    start: q.inStart, end: q.outEnd, inEnd: q.inEnd, outStart: q.outStart, scale: q.scale, x: q.x, y: q.y })) } })
  is('auto zoom reaches the plan', spec.zooms.length, 1)
  const planned = O.zoomPlan(spec.zooms)[0]
  is('with the ramps zoomMoments decided, not a second copy of them',
    [r(planned.inEnd, 3), r(planned.outStart, 3), r(planned.scale, 3)],
    [r(wide[0].inEnd, 3), r(wide[0].outStart, 3), r(wide[0].scale, 3)])
  const m = march(spec, 60, wide[0].inStart - 0.2, wide[0].outEnd + 0.2)
  const v = peak(m.d1), a = peak(m.d2)
  is('and it moves on the same curve', [r(m.d1[1], 6), a / v < 0.2], [0, true])
}

// ── cuts, and the take arriving ─────────────────────────────────────────────
// A transition is a piece of time either side of a boundary, and the only way to judge
// one is to walk the frames through it. Everything below comes out of Plan.framePlan
// at 60 fps, the same call the compositor makes for the frame it is about to draw.

const cutSpec = (kind, cuts = [[5, 9]], extra = {}) =>
  Plan.prepare({ cuts, backdrop: 'dusk', inset: 0.08, ...extra, look: { motion: { cutTransition: kind, ...(extra.motion || {}) } } }, meta)
// every frame of an output, with what the plan says about the cut on it
const walk = (spec, from, to) => {
  const out = []
  for (let n = Math.round(from * 60); n <= Math.round(to * 60); n++) {
    const p = Plan.framePlan(spec, n / 60)
    out.push({ n, t: n / 60, s: p.s, s2: p.s2, mix: p.mix, alpha: p.move.alpha, w: Plan.viewAt(spec, n / 60)[2],
      v0: p.view0[2], v1: p.view1[2], taps: p.taps, speed: p.speed })
  }
  return out
}

console.log('a dissolve crosses over on the cut, to the frame')
{
  const spec = cutSpec('crossfade')
  const f = walk(spec, 4.8, 5.2)
  const inside = f.filter(v => v.mix > 0)
  is('the window is whole frames of the output', [inside.length, r(spec.cut.points[0].d, 6)], [11, 0.1])
  is('and it is centred on the boundary the timeline names',
    [r(inside[0].t, 4), r(inside[inside.length - 1].t, 4), spec.cut.points[0].t], [4.9167, 5.0833, 5])
  is('the weight never turns back', inside.every((v, i) => i === 0 || v.mix > inside[i - 1].mix), true)
  const at = f.find(v => r(v.t, 6) === 5)
  is('and it is exactly half at the cut, on the frame the cut lands on', r(at.mix, 9), 0.5)
  is('the two sides are the two sides', [r(at.s, 6), r(at.s2, 6)], [5, 9])
  // both sides run at the take's own rate: a dissolve is two clips playing, not two
  // frozen frames laid over each other
  is('and both of them are playing', inside.every((v, i) => i === 0 ||
    (r(v.s - inside[i - 1].s, 6) === r(1 / 60, 6) && r(v.s2 - inside[i - 1].s2, 6) === r(1 / 60, 6))), true)
  // and it is made of what the cut removed: the outgoing side runs on into the gap and
  // the incoming side starts inside it, so no output time is added and nothing the
  // viewer already saw is shown twice
  // the outgoing side runs on no further than the gap's far end and the incoming side
  // starts no earlier than its near one, so the dissolve is entirely removed material
  is('made of the frames the cut removed', inside.every(v => v.s <= 9 && v.s2 >= 5) &&
    inside[inside.length - 1].s > 5 && inside[0].s2 < 9, true)
  console.log('       ' + f.filter(v => v.n >= 293 && v.n <= 307).map(v => `${v.n}:${r(v.mix, 3)}`).join(' '))

  // the frame either side of the window is the hard cut it always was
  const before = f.find(v => v.n === 294), after = f.find(v => v.n === 306)
  is('and outside it nothing has changed', [before.mix, before.s, after.mix, r(after.s, 4)], [0, 4.9, 0, 9.1])
}

console.log('a dissolve is only ever as long as the cut can pay for')
{
  // the gap, and half of either piece, in that order: a cut with 60 ms behind it stays
  // hard rather than dissolving material the viewer already saw
  is('a short gap shortens it', r(cutSpec('crossfade', [[5, 5.05]]).cut.points[0].d, 4), 0.05)
  is('a gap under two frames leaves the cut hard', cutSpec('crossfade', [[5, 5.02]]).cut, null)
  is('a short piece shortens it too', r(cutSpec('crossfade', [[5, 9], [9.1, 12]]).cut.points[1].d, 4), 0.05)
  is('and none of it exists at the default', cutSpec('none').cut, null)
  is('two cuts, two boundaries', cutSpec('dip', [[5, 9], [11, 12]]).cut.points.map(p => p.t), [5, 7])
}

console.log('a dip is a hole, and the hole is on the cut')
{
  const spec = cutSpec('dip')
  const f = walk(spec, 4.85, 5.15)
  const inside = f.filter(v => v.alpha < 1)
  is('the same window as the dissolve', inside.length, 11)
  const at = f.find(v => r(v.t, 6) === 5)
  is('the take is not on screen at all on the frame the cut lands on', r(at.alpha, 9), 0)
  is('and the cut is still exactly where it was', [r(at.s, 4), r(f.find(v => v.n === 299).s, 4)], [9, 4.9833])
  const down = inside.filter(v => v.t <= 5), up = inside.filter(v => v.t >= 5)
  is('down without turning back', down.every((v, i) => i === 0 || v.alpha < down[i - 1].alpha), true)
  is('and up the same way', up.every((v, i) => i === 0 || v.alpha > up[i - 1].alpha), true)
  is('symmetric about the cut', down.map(v => r(v.alpha, 6)).reverse().join() === up.map(v => r(v.alpha, 6)).join(), true)
  console.log('       ' + inside.map(v => r(v.alpha, 3)).join(' '))
}

console.log('a push lands tight and settles out')
{
  const spec = cutSpec('zoom')
  const f = walk(spec, 4.9, 5.45)
  const inside = f.filter(v => v.w < 1)
  is('it lives after the cut alone', [r(inside[0].t, 4), r(inside[inside.length - 1].t, 4)], [5, 5.3333])
  is('and it never asks for more picture than the frame has', f.every(v => v.w <= 1), true)
  is('the deepest it goes is the boundary frame', r(1 / inside[0].w, 3), 1.06)
  is('and it settles back without turning round', inside.every((v, i) => i === 0 || v.w > inside[i - 1].w), true)
  // the shutter reads the push's own velocity, so a cut with no zoom in the edit still
  // blurs while it moves and stops the moment it lands
  const moving = inside.filter(v => v.speed > 1)
  const peakPx = Math.max(...inside.map(v => v.speed))
  // it leaves the cut at rest and arrives at rest: the last frame of the push is at
  // three percent of the peak and the first frame past it is at nothing
  is('the shutter is open while it moves and shut at both ends',
    [inside[0].speed, inside[inside.length - 1].speed / peakPx < 0.05, moving.length > 10,
      f[f.length - 1].speed, f[f.length - 1].taps], [0, true, true, 0, 1])
  // and it never spans the cut: the view jumps there, and an exposure across it would
  // smear the boundary itself
  const on = f.find(v => r(v.t, 6) === 5)
  is('the shutter never spans the cut', [on.taps, r(on.v0 - on.v1, 9)], [1, 0])
  console.log(`       peak ${r(Math.max(...inside.map(v => v.speed)), 0)} px/s, ${Math.max(...inside.map(v => v.taps))} samples`)
}

console.log('the take arrives and leaves')
{
  const spec = cutSpec('none')
  const f = walk(spec, 0, 0.45)
  is('it starts small, low and not there', [r(f[0].alpha, 6), r(Plan.framePlan(spec, 0).move.k, 4)], [0, 0.965])
  is('and it never turns back on the way in', f.every((v, i) => i === 0 || v.alpha >= f[i - 1].alpha), true)
  const landed = f.find(v => v.alpha === 1 && Plan.framePlan(spec, v.t).move.k === 1)
  is('landed on the first frame at or after 0.36 s', [landed.n, r(landed.t, 4)], [22, 0.3667])
  is('and 0.36 s is where the plan said it would land', [Math.ceil(0.36 * 60), spec.reveal.in], [22, 0.36])
  const out = walk(spec, spec.span - 0.4, spec.span - 1 / 60)
  is('it leaves the same way', out.every((v, i) => i === 0 || v.alpha <= out[i - 1].alpha), true)
  is('and it is all but gone on the last frame', r(out[out.length - 1].alpha, 3) < 0.02, true)
  // a take with nothing behind it has nowhere to arrive from, so it opens hard
  is('a take with no ground opens on a hard frame',
    Plan.prepare({ cuts: [[5, 9]] }, meta).reveal, null)
  is('and so does one told not to',
    Plan.prepare({ backdrop: 'dusk', inset: 0.08, look: { motion: { reveal: 'none' } } }, meta).reveal, null)
}

console.log('a far pan eases back, and never past the frame')
{
  // The dip is what makes a long pan one travel rather than a slide across the page:
  // octaves come off the scale in the middle of the move. Taken too far it took the
  // window wider than the frame itself, which is a picture that does not exist: the
  // compositor clamped to the crop's edge and smeared the border rows, ffmpeg's zoompan
  // clipped the zoom at 1 and clamped x to 0, and preview and export showed different
  // frames at exactly the moment the frame ran out.
  let worstS = 9, worstIn = 9, dipped = 0, pairs = 0
  for (const s1 of [1.05, 1.3, 1.8, 2.5, 4]) for (const s2 of [1.05, 1.3, 1.8, 2.5, 4])
    for (const d of [0, 0.2, 0.5, 0.8]) for (const gap of [0, 0.2, 0.6]) {
      pairs++
      const zooms = [{ start: 1, end: 3, scale: s1, x: 0.1, y: 0.1 }, { start: 3 + gap, end: 6, scale: s2, x: 0.1 + d, y: 0.1 + d * 0.9 }]
      const m = O.zoomPlan(zooms)[1]
      if (m && m.from && m.from.dip > 0) dipped++
      for (let t = 0; t <= 6.5; t += 0.004) {
        const v = O.zoomWindow(zooms, t)
        worstS = Math.min(worstS, v.s)
        worstIn = Math.min(worstIn, v.x, v.y, 1 - v.w - v.x, 1 - v.h - v.y)
      }
    }
  is(`${pairs} pairs of zooms: the camera never pulls back past 1x`, worstS >= 1, true)
  is('and the window never leaves the frame', worstIn >= -1e-9, true)
  // and the ease-back is still there to be seen: bounding it is not turning it off
  is('the far pans still ease back', dipped > pairs / 3, true)
  console.log(`       least scale ${r(worstS, 6)}, least margin ${r(worstIn, 6)}, ${dipped} of ${pairs} ease back`)
  // the one pair the round was reported on
  const far = [{ start: 1, end: 3, scale: 1.05, x: 0.15, y: 0.5 }, { start: 3.2, end: 6, scale: 4, x: 0.95, y: 0.5 }]
  let least = 9
  for (let t = 0; t <= 6; t += 0.002) least = Math.min(least, O.zoomWindow(far, t).s)
  is('1.05x to 4x across most of the page stays at 1x or over', [least >= 1, r(least, 4)], [true, 1])
}

console.log('re-framing a zoom takes the one after it with it')
{
  // Auto zoom's moments arrive whole, each one carrying where the camera was when the
  // one before handed over (`from`). A lift re-frames the zoom it rides, and if the
  // next moment is left panning from a position that no longer exists the window jumps
  // on the handover frame, which is the one place in a plan that can tear.
  const Focus = require('../ui/compositor/focus')
  const W = 1920, H = 1080
  const moments = () => [
    { start: 1, end: 4, inEnd: 1.5, outStart: 4, outEnd: 4, scale: 3.2, x: 0.62, y: 0.42 },
    { start: 4, end: 8, inEnd: 4.7, outStart: 7, outEnd: 8, scale: 2.2, x: 0.2, y: 0.8,
      from: { x: 0.62, y: 0.42, scale: 3.2, dip: O.panDip(3.2, 2.2, Math.hypot(0.42, 0.38)) } }]
  const box = { x: 0.4, y: 0.22, w: 0.36, h: 0.4 }
  const shape = Focus.shape({ kind: 'lift', ...box }, W, H, 3.2)
  const out = Focus.reframe(moments(), [{ tm: { a: 1.4, b: 3.8, Tin: 0.3, Tout: 0.3 }, box, shape }], W, H)
  is('the lift pulled its zoom back', out[0].reframed === true && out[0].scale < 3.2, true)
  is('and the pan after it starts from where that zoom actually landed',
    [out[1].from.x, out[1].from.y, out[1].from.scale], [out[0].x, out[0].y, out[0].scale])
  const jump = list => { const a = O.zoomView(list, 4 - 1e-6), b = O.zoomView(list, 4 + 1e-6)
    return Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y), Math.abs(b.s - a.s) / 10) }
  // the same list with the old `from` left on it, which is what this section is about
  const stale = moments().map((z, i) => (i === 0 ? out[0] : z))
  is('so nothing moves at the handover', jump(out) < 1e-9, true)
  is('...and it did move before', jump(stale) > 0.05, true)
  console.log(`       ${r(jump(stale), 5)} of the frame with the old position, ${r(jump(out), 6)} with the one it landed on`)
  // every frame of it, which is what the eye reads
  const spec = Plan.prepare({ autoZoom: true }, meta, { prepared: { autoZooms: out } })
  const m = march(spec, 60, 3.6, 5.2)
  is('and no frame of the handover steps out of line',
    [peak(m.d2) / peak(m.d1) < 0.3, Math.max(peak(m.dx), peak(m.dy)) < 0.05], [true, true])
}

console.log('a mark riding a zoom takes that zoom\'s own ramp')
{
  // A lift on a zoom is one move, so its dim comes up over exactly the zoom's push.
  // The push is the ease's own length at that depth, which is a different number for
  // each of the four: read with the default ease, a snappy zoom had landed 0.12 s
  // before the lift it was carrying had finished arriving.
  for (const ease of Object.keys(O.EASES)) {
    const spec = Plan.prepare({ backdrop: 'dusk', inset: 0.08, zooms: [{ start: 2, end: 8, scale: 1.7, x: 0.5, y: 0.5 }],
      marks: [{ kind: 'lift', start: 2, end: 8, x: 0.35, y: 0.35, w: 0.3, h: 0.3 }], look: { motion: { zoomEase: ease } } }, meta)
    const tm = spec.marks.focus[0].tm
    const z = O.zoomPlan(spec.zooms, ease)[0]
    is(`${ease}: the lift is up when the camera arrives`, [r(tm.Tin, 4), r(tm.Tout, 4)],
      [r(z.inEnd - z.inStart, 4), r(z.outEnd - z.outStart, 4)])
  }
}

console.log('the shutter never spans a cut, wherever the cut falls')
{
  // cutAt reads the boundary as already pushed, so an exposure that reaches it exactly
  // put the whole six percent jump on the last frame before the cut. A boundary almost
  // never lands on a frame, so this walks it across one frame period.
  let smeared = 0, worst = 0
  for (let k = 1; k < 100; k++) {
    const spec = cutSpec('zoom', [[5 + k / 100 / 60, 9]])
    const f = Plan.framePlan(spec, 5)
    if (f.taps > 1 || Math.abs(f.view0[2] - f.view1[2]) > 1e-9) smeared++
    worst = Math.max(worst, Math.abs(f.view0[2] - f.view1[2]))
  }
  is('the last frame before the push is the frame it was, at every one of 99 offsets', [smeared, r(worst, 9)], [0, 0])
  // and the frames the push does own still smear: this is a clamp, not a shutter closed
  const on = walk(cutSpec('zoom', [[5.003, 9]]), 5.0167, 5.25)
  is('while the push itself is still exposed', on.some(v => v.taps > 1), true)
  console.log(`       most samples through the push ${Math.max(...on.map(v => v.taps))}`)
}

console.log('a dissolve never shows what the edit hides')
{
  // The one transition made of the material a cut removed, and every mark is placed on
  // the output clock, where that material has no time at all. So each side reads its
  // marks from its own side of the boundary, and the window stops short of anything
  // the edit begins or stops hiding inside the frames it shows.
  const redact = (a, b) => [{ kind: 'redact', start: a, end: b, x: 0.1, y: 0.1, w: 0.2, h: 0.1 }]
  const cut = marks => Plan.prepare({ cuts: [[10.5, 14]], backdrop: 'dusk', inset: 0.08, marks,
    look: { motion: { cutTransition: 'crossfade' } } }, meta)
  const covering = cut(redact(10, 12))
  is('a redaction over the cut leaves the dissolve alone', r(covering.cut.points[0].d, 4), 0.1)
  // the outgoing side is playing 10.5 to 10.6, which the redaction covers in the source
  // and the output clock has already ended
  const f = Plan.framePlan(covering, 10.55)
  is('and the outgoing side, playing on into the gap, is still redacted',
    [f.marks.redact.length, r(f.s, 4)], [1, 10.55])
  is('while the incoming side, which that redaction never reached, is not',
    [f.marks2.redact.length, r(f.s2, 4)], [0, 14.05])
  const every = walk(covering, 10.4, 10.6).filter(v => v.mix > 0)
  is('every frame of the window, on the side that is in the removed material',
    every.every(v => Plan.framePlan(covering, v.t).marks.redact.length === 1), true)
  // what no instant of the output clock can speak for: a mark that starts or stops
  // inside the frames the dissolve shows. The window stops short of it, or goes.
  is('a redaction starting just inside the gap shortens the window', r(cut(redact(10.55, 12)).cut.points[0].d, 4), 0.05)
  is('one ending just before the far side comes in shortens it too', r(cut(redact(11, 13.95)).cut.points[0].d, 4), 0.05)
  is('and one ending exactly where the incoming piece starts leaves the cut hard', cut(redact(11, 14)).cut, null)
  is('while one a second into the gap changes nothing', r(cut(redact(11.5, 12)).cut.points[0].d, 4), 0.1)
  // the sides are still solved from t alone
  is('and both sides of a frame are still a function of its own time',
    JSON.stringify(Plan.framePlan(covering, 10.55)) === JSON.stringify(Plan.framePlan(covering, 10.55)), true)
}

console.log('every frame still draws alone')
{
  // the whole point of solving a transition from t rather than from the frame before:
  // an export can render out of order and a scrub can land in the middle of one
  const spec = cutSpec('crossfade')
  const ns = [300, 12, 299, 940, 301, 0, 295]
  const one = n => JSON.stringify(Plan.framePlan(spec, n / 60))
  const first = ns.map(one)
  const shuffled = [...ns].reverse().map(one).reverse()
  is('a frame asked for out of order is the same frame', first.join('|') === shuffled.join('|'), true)
  const dip = cutSpec('dip'), push = cutSpec('zoom')
  is('and so is a dip and a push', [one(300) === JSON.stringify(Plan.framePlan(spec, 5)),
    JSON.stringify(Plan.framePlan(dip, 5)) === JSON.stringify(Plan.framePlan(dip, 300 / 60)),
    JSON.stringify(Plan.framePlan(push, 5.1)) === JSON.stringify(Plan.framePlan(push, 306 / 60))], [true, true, true])

  // the same claim over a whole moving take rather than seven frames of one: a zoom, a
  // pan, a cut with a transition on it and both ends of the reveal, every frame of the
  // first eight seconds planned in order and then planned again in a shuffled order
  const busy = Plan.prepare({ cuts: [[5, 9]], backdrop: 'dusk', inset: 0.08,
    zooms: [{ start: 1, end: 4, scale: 2.2, x: 0.25, y: 0.3 }, { start: 4, end: 6.5, scale: 1.5, x: 0.8, y: 0.7 }],
    look: { motion: { cutTransition: 'crossfade' } } }, meta)
  const all = Array.from({ length: 8 * 60 }, (_, n) => n)
  const inOrder = all.map(n => JSON.stringify(Plan.framePlan(busy, n / 60)))
  const again = new Array(all.length)
  for (const n of shuffle(all)) again[n] = JSON.stringify(Plan.framePlan(busy, n / 60))
  const differ = all.filter(n => again[n] !== inOrder[n])
  is(`${all.length} frames of a moving take, planned in a shuffled order, are the same frames`,
    differ.length, 0)
  // and it is a moving take: a plan that never changes would pass the check above
  is('...and did move', new Set(inOrder).size > all.length * 0.9, true)
}

console.log('everything that arrives has a way to leave')
{
  // The fault motion-taste.md named: five badges that arrived a beat apart all went out
  // on one frame, and the alpha rode --ease-out, which is an accelerate and so spends
  // half its window above 0.68 and crosses the readable range in the last third.
  const Marks = require('../ui/compositor/marks')
  const steps = [1, 2, 3, 4, 5].map((n, i) => ({ kind: 'step', n, x: 0.3 + 0.1 * i, y: 0.4, start: 2 + i * 0.5, end: 9 }))
  const m = Marks.planMarks(steps, { W: 1920, H: 1080, px: 1, clock: t => t, span: 12, zooms: [] })
  const opsAt = t => Marks.at(m, t).steps.map(s => r(s.op, 3))
  is('five badges that end together do not leave together',
    new Set(m.steps.map(s => r(s.gone, 3))).size, 5)
  is('and they leave in the order they arrived',
    m.steps.map(s => s.gone).every((g, i, a) => i === 0 || g > a[i - 1]), true)
  // every badge: how many frames at 60 its alpha spends between 0.9 and 0.1, and the
  // worst one frame step in it
  const leave = (s) => {
    const v = []
    for (let n = Math.round((s.gone - s.OUT - 0.05) * 60); n <= Math.round(s.gone * 60); n++) {
      const one = Marks.at(m, n / 60).steps.find(x => x.label === s.label)
      v.push(one ? one.op : 0)
    }
    const hi = v.findIndex(x => x < 0.9), lo = v.findIndex(x => x < 0.1)
    return { frames: lo - hi, step: Math.max(...v.slice(1).map((x, i) => v[i] - x)) }
  }
  const worst = m.steps.map(leave)
  is('a badge crosses the readable range in six frames or more at 60',
    Math.min(...worst.map(w => w.frames)) >= 6, true)
  is('and no frame of it moves more than a seventh of the badge',
    r(Math.max(...worst.map(w => w.step)), 3) <= 0.145, true)
  // the leave is quicker than the arrival, and never instant
  is('the leave is quicker than the arrival and not instant',
    m.steps.every(s => s.OUT < s.IN && s.OUT >= 0.12), true)

  // captions: the arrival is the longer of the pair and both ends are eased
  const Text = require('../ui/compositor/text')
  const cues = [{ start: 1, end: 3, text: 'one two three' }, { start: 5, end: 7, text: 'four five six' }]
  const tp = Text.planText({ captions: true, cues, captionStyle: {} },
    { clock: Object.assign(t => t, { kept: () => true }), span: 10, W: 1920, H: 1080 })
  const capOp = t => { const it = Text.textAt(tp, t).items.filter(i => /^cap\|/.test(i.key) && !/shade$/.test(i.key)); return it.length ? it[0].op : 0 }
  const p0 = tp.phrases[0]
  is('a caption arrives over longer than it leaves',
    [r(capOp(p0.show + 0.1), 2) < 0.6, r(capOp(p0.hide - 0.08), 2) < 0.6], [true, true])
  is('and neither end of it is a corner',
    [capOp(p0.show + 0.005) < 0.01, capOp(p0.hide - 0.005) < 0.01], [true, true])
  // the plate is still there after the words have gone
  is('the glass closes after the words do',
    Text.textAt(tp, p0.hide + 0.02).frost.length > 0 && capOp(p0.hide + 0.02) === 0, true)

  // A phrase floored at its shortest on-screen time (phraseTimes) is exactly one
  // arrival long, and a caption that spends all of itself arriving never reaches full.
  // Both fades are cut to the phrase instead, here and in the ASS the classic renderer
  // writes (ui/overlays.js capFades), so the stage and that file still agree.
  const quick = [{ start: 1, end: 1.12, text: 'Right.' }, { start: 1.15, end: 1.4, text: 'Now' }]
  const qp = Text.planText({ captions: true, cues: quick, captionStyle: {} },
    { clock: Object.assign(t => t, { kept: () => true }), span: 10, W: 1920, H: 1080 })
  const q0 = qp.phrases[0]
  const qOp = t => { const it = Text.textAt(qp, t).items.filter(i => /^cap\|/.test(i.key) && !/shade$/.test(i.key)); return it.length ? it[0].op : 0 }
  const peak = Math.max(...Array.from({ length: 201 }, (_, i) => qOp(q0.show + i * (q0.hide - q0.show) / 200)))
  is('a floored phrase still comes all the way up', r(peak, 2), 1)
  is('and still leaves rather than cutting', qOp(q0.hide - 0.005) < 0.2, true)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
