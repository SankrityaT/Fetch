// What the compositor draws over the take (M3), as plain numbers: lifts and spotlights
// (ui/compositor/focus.js), marks, steps and the agent's cursor at a moment (marks.js),
// and captions, title cards and labels (text.js). The pixels are the GL harness's.
const Focus = require('../ui/compositor/focus')
const Marks = require('../ui/compositor/marks')
const Text = require('../ui/compositor/text')
const Plan = require('../ui/compositor/plan')
const O = require('../ui/overlays')
const T = require('../ui/timeline')

let pass = 0, fail = 0
const is = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}` +
    (ok ? '' : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`))
}
const r2 = n => Math.round(n * 100) / 100
const W = 2880, H = 1720, px = 0.56   // a Retina window take framed into 1080
const clock = T.outClock([], 0, 60)

console.log('a lift')
{
  const big = Focus.shape({ kind: 'lift', x: 0.7, y: 0.4, w: 0.25, h: 0.45 }, W, H, px)
  const chip = Focus.shape({ kind: 'lift', x: 0.4, y: 0.8, w: 0.04, h: 0.03 }, W, H, px)
  is('a big card rises 3 percent, a chip 6', [big.lift, chip.lift], [1.03, 1.06])
  is('both lie inside the scale the brief allows', [big.lift, chip.lift].every(k => k >= 1.03 && k <= 1.06), true)
  is('two shadows, the key wider and further down than the contact', big.key.sigma > big.contact.sigma && big.key.dy > big.contact.dy, true)
  is('the page dims less by the piece than far from it', big.near < 1 && big.near > 0, true)
  const own = Focus.shape({ kind: 'lift', x: 0.5, y: 0.5, w: 0.2, h: 0.2, radius: 20 }, W, H, px)
  is('a measured corner is kept, concentric with the pad', r2(own.r), r2(20 + 3 / px))
  is('a look can set the scale', Focus.shape({ kind: 'lift', x: 0.5, y: 0.5, w: 0.2, h: 0.2 }, W, H, px, { lift: 1.1 }).lift, 1.1)
  is('the default look lets size decide', Focus.shape({ kind: 'lift', x: 0.5, y: 0.5, w: 0.2, h: 0.2 }, W, H, px, { lift: 1.04 }).lift > 1.03, true)
  is('a spotlight takes the look\'s dim', Focus.shape({ kind: 'spotlight', x: 0.5, y: 0.5, w: 0.2, h: 0.2 }, W, H, px, { dim: 0.6 }).dim, 0.6)
}

console.log('the composition rule')
{
  const m = { kind: 'lift', x: 0.7475, y: 0.457, w: 0.2267, h: 0.422 }
  const tm = { a: 23.6, b: 28.4, Tin: 0.45, Tout: 0.45 }
  const shape = Focus.shape(m, W, H, px * 2.13)
  // a zoom aimed at the card, so tight the card fills it edge to edge
  const tight = { start: 22.4, end: 28.6, scale: 2.13, x: 0.7653, y: 0.6688 }
  const [z] = Focus.reframe([tight], [{ tm, box: m, shape }], W, H)
  is('a zoom too tight for the raised card is pulled back', z.reframed === true && z.scale < 2.13, true)
  const vw = 1 / z.scale, vx = Math.max(0, Math.min(1 - vw, z.x - vw / 2)), vy = Math.max(0, Math.min(1 - vw, z.y - vw / 2))
  is('and holds the card inside the view', m.y >= vy && m.y + m.h <= vy + vw && m.x >= vx, true)
  is('with air above and below it', m.y - vy > 0.02 && vy + vw - (m.y + m.h) > 0.02, true)
  const away = { start: 22.4, end: 28.6, scale: 2, x: 0.2, y: 0.2 }
  is('a zoom elsewhere is left alone', Focus.reframe([away], [{ tm, box: m, shape }], W, H)[0], away)
  const inner = { kind: 'lift', x: 0.4, y: 0.4, w: 0.2, h: 0.2 }
  const loose = { start: 22.4, end: 28.6, scale: 1.5, x: 0.5, y: 0.5 }
  is('a zoom that already frames it with air is left exactly as it is',
    Focus.reframe([loose], [{ tm, box: inner, shape: Focus.shape(inner, W, H, px * 1.5) }], W, H)[0], loose)
  const later = { start: 40, end: 45, scale: 2.13, x: 0.7653, y: 0.6688 }
  is('a zoom at another time is left alone', Focus.reframe([later], [{ tm, box: m, shape }], W, H)[0], later)
  const rider = Focus.reach({ ...shape, margin: 60 })
  is('a step badge riding the card counts in its reach', rider.t >= 60 && rider.l >= 60, true)
}

console.log('a card at the frame\'s edge')
{
  const s = Focus.shape({ kind: 'lift', x: 0.75, y: 0.3, w: 0.245, h: 0.4 }, W, H, px)
  const n = Focus.nudge(s, { x: 0, y: 0, w: 1, h: 1 }, W, H)
  is('comes up and a little in, not flush with the edge', n.dx < 0, true)
  is('never more than a sixth of itself', Math.abs(n.dx) <= s.w / 6 + 0.1, true)
  const mid = Focus.shape({ kind: 'lift', x: 0.4, y: 0.4, w: 0.2, h: 0.2 }, W, H, px)
  is('a card in the open stays where it is', Focus.nudge(mid, { x: 0, y: 0, w: 1, h: 1 }, W, H), { dx: 0, dy: 0 })
}

console.log('marks at a moment')
{
  const marks = [
    { kind: 'redact', start: 1, end: 5, x: 0.1, y: 0.1, w: 0.1, h: 0.05 },
    { kind: 'blur', start: 2, end: 8, x: 0.3, y: 0.1, w: 0.1, h: 0.05 },
    { kind: 'lift', start: 10, end: 16, x: 0.4, y: 0.4, w: 0.2, h: 0.2 },
    { kind: 'step', start: 11, end: 15, x: 0.45, y: 0.45 },
    { kind: 'step', start: 20, end: 25, x: 0.9, y: 0.9 },
  ]
  const pm = Marks.planMarks(marks, { W, H, px, clock, span: 60, zooms: [] })
  const at = t => Marks.at(pm, t)
  is('a redaction is whole from its first frame', at(1.01).redact.length, 1)
  is('and never fades', at(4.99).redact.length, 1)
  is('a blur eases in', r2(at(2.1).blur[0].op) < 1 && at(2.1).blur[0].op > 0, true)
  is('and is whole after its ease', at(4).blur[0].op, 1)
  is('a lift is not up before it starts', at(9.9).focus.length, 0)
  is('it rises on the zoom\'s curve', at(10.2).focus[0].level > 0 && at(10.2).focus[0].level < 1, true)
  is('and is fully up in the middle', at(13).focus[0].level, 1)
  const s = pm.focus[0].shape, st = at(13).steps[0]
  const k = s.lift, ccx = s.x + s.w / 2
  is('a step on the lifted card rises with it', r2(st.cx), r2(ccx + (0.45 * W - ccx) * k + s.nudge.dx))
  is('steps count in order among the steps', pm.steps.map(q => q.label), ['1', '2'])
  is('a step pops in', at(11.05).steps[0].scale < 1, true)
  is('sized for the finished frame, 60 px at 1080', r2(pm.steps[1].D * px), r2(Math.round(60 / px) * px))
}

console.log('the Mac\'s pointer lifted out')
{
  const spans = [{ a: 1, b: 3, x: 0.5, y: 0.5, w: 0.02, h: 0.03, rest: true }]
  const plates = { 0: [{ a: 1, b: 2, file: '/tmp/p.png', x: 1440, y: 860, w: 60, h: 52 }] }
  const e = Marks.planErase(spans, plates, { src: { w: W, h: H }, crop: { x: 0, y: 0 }, content: { w: W, h: H }, clock, end: 60, span: 60 })
  is('a clean patch where the rest has one', e.filter(q => q.plate).map(q => [q.a, q.b]), [[1, 2]])
  is('filled from the edges for the rest of it', e.filter(q => q.fill).map(q => [q.a, q.b]), [[2, 3]])
}

console.log('the agent\'s cursor')
{
  const points = [{ t: 1, x: 0.2, y: 0.2 }, { t: 3, x: 0.6, y: 0.5, click: true }, { t: 6, x: 0.45, y: 0.45 }]
  const P = Marks.planPointer(points, { W, H, clock, crop: null, scale: 2, span: 60, px, zooms: [] })
  const pm = { ...Marks.planMarks([], { W, H, px, clock, span: 60, zooms: [] }), pointer: P }
  const at = t => Marks.at(pm, t).pointer
  is('not there before its first point', at(0.5), null)
  is('about 30 px tall at 1080', r2(P.size * px), 30)
  is('at the click on time', [r2(at(3).x / W), r2(at(3).y / H)], [0.6, 0.5])
  is('pressing just after the click', at(3.03).press < 1, true)
  is('a gold ripple from the click', at(3.1).ripples.length, 1)
  is('Biscuit\'s badge shows round the click', at(3).badge > 0.9, true)
  is('and the name tag', !!at(3).tag, true)
  is('a larger cursor from the look', r2(Marks.planPointer(points, { W, H, clock, span: 60, px, zooms: [], size: 1.5 }).size * px), 45)
  const lifted = { ...Marks.planMarks([{ kind: 'lift', start: 5, end: 9, x: 0.4, y: 0.4, w: 0.2, h: 0.2 }], { W, H, px, clock, span: 60, zooms: [] }), pointer: P }
  const f = lifted.focus[0].shape, q = Marks.at(lifted, 7).pointer
  const cx = f.x + f.w / 2
  is('resting on a lifted card it rises with the card', r2(q.x), r2(cx + (0.45 * W - cx) * f.lift + f.nudge.dx))
}

console.log('prepared marks')
{
  const mark = { kind: 'lift', start: 2, end: 6, x: 0.4, y: 0.4, w: 0.2, h: 0.2 }
  const fitted = { ...mark, x: 0.39, w: 0.22, radius: 12, k0: Plan.markKey(mark) }
  const opts = { marks: [mark], backdrop: 'dusk' }
  const meta = { width: W, height: H, duration: 20, fps: 60 }
  const a = Plan.prepare(opts, meta, { prepared: { marks: [fitted] } })
  is('the plan draws the mark as the take fitted it', a.marks.focus[0].shape.w / W > 0.215, true)
  const moved = { ...mark, x: 0.1 }
  const b = Plan.prepare({ ...opts, marks: [moved] }, meta, { prepared: { marks: [fitted] } })
  is('a mark edited since is drawn as it now is', b.marks.focus[0].shape.x / W < 0.2 && b.marks.focus[0].shape.w / W < 0.21, true)
}

console.log('text')
{
  const measure = Text.estimate
  const cues = [{ start: 1, end: 3, text: 'This is Songscription, my piano library.' }, { start: 4, end: 6, text: 'Three hundred songs.' }]
  const words = { words: [{ w: 'This', t: 1 }, { w: 'is', t: 1.3 }, { w: 'Songscription,', t: 1.5 }, { w: 'my', t: 2.1 },
    { w: 'piano', t: 2.3 }, { w: 'library.', t: 2.6 }, { w: 'Three', t: 4 }, { w: 'hundred', t: 4.4 }, { w: 'songs.', t: 4.9 }] }
  const opts = { captions: true, cues, captionStyle: {}, texts: [
    { text: 'Songscription', subtitle: 'A piano library', start: 0, end: 2.5, style: 'title', fx: 0.5, fy: 0.5 },
    { text: 'Key and tempo', start: 7, end: 9, style: 'lower-third' },
    { text: 'New', start: 7, end: 9, style: 'label', fx: 0.3, fy: 0.3, box: true },
  ] }
  // framed, with the caption band below the take
  const box = { x: 160, y: 40, w: 1600, h: 880 }
  const tp = Text.planText(opts, { clock, span: 12, W: 1920, H: 1080, box, prepared: { captions: { cues, words, busy: [] } } })
  is('phrases from the spoken words', tp.phrases.length >= 2, true)
  is('an opening title card, and the lower third and label as labels', [tp.cards.length, tp.labels.length], [1, 2])
  is('captions wait for the opening card to hand over', tp.phrases[0].show >= 2.5 - 0.6, true)
  const open = Text.textAt(tp, 1, measure)
  is('the opening card has its scrim', open.ground && !open.ground.blurred, true)
  is('and its title and the line under it', open.items.filter(i => i.key.startsWith('title') || i.key.startsWith('sub')).length, 2)
  const mid = Text.textAt(tp, 4.45, measure)
  const words2 = mid.items.find(i => i.key.endsWith('|words'))
  is('a caption on screen, the spoken word tinted gold', !!words2 && words2.tint && words2.tint.colour, Text.GOLD)
  is('in the band under a framed take there is no glass', mid.frost.length, 0)
  const top = Text.planText({ ...opts, captionStyle: { position: 'top' } }, { clock, span: 12, W: 1920, H: 1080, box, prepared: { captions: { cues, words, busy: [] } } })
  is('over the take, a framed caption sits on frosted glass', Text.textAt(top, 4.45, measure).frost.length, 1)
  const plain = Text.planText({ ...opts, captionStyle: { highlight: 'pill' } }, { clock, span: 12, W: 1920, H: 1080, box: null, prepared: { captions: { cues, words, busy: [] } } })
  const p = Text.textAt(plain, 4.45, measure)
  is('a pill behind the spoken word, the word in ink', [p.items.some(i => i.key.startsWith('pill')), p.items.find(i => i.key.endsWith('|words')).tint.colour], [true, Text.INK])
  const lab = Text.textAt(tp, 8, measure).items.map(i => i.key.split('|')[0])
  is('the lower third and the label are drawn', lab.sort(), ['label', 'lt'])
  is('a label rises in', Text.textAt(tp, 7.05, measure).items.find(i => i.key.startsWith('label')).dy > 0, true)
  // the framed take under an opening card: not there, then rising into place
  is('under the opening card the take waits', Text.frameMove(tp, 0.5, 1080).alpha, 0)
  const land = Text.frameMove(tp, 2.49, 1080)
  is('and has risen into place as the card clears', land.alpha === 1 && land.k > 0.999, true)
  const dodge = Text.planText({ ...opts, texts: [] }, { clock, span: 12, W: 1920, H: 1080, box: null, prepared: { captions: { cues, words, busy: [1.5] } } })
  is('a caption over the product\'s own toast goes to the top', dodge.phrases[0].at, 'top')
}

console.log('the loupe')
{
  const plan = (m, look) => Marks.planMarks([{ kind: 'loupe', start: 2, end: 8, ...m }], { W, H, px, clock, span: 60, zooms: [], look })
  const one = (m, look) => plan(m, look).loupe[0]
  const g = one({ x: 0.1, y: 0.1, w: 0.1, h: 0.08 })
  is('the inset is the area magnified by the look\'s own dial', r2(g.box.w / g.src.w), 2.2)
  is('and it sits beside the area, not over it', g.box.x >= g.src.x + g.src.w, true)
  is('with a gap between them', r2(g.box.x - (g.src.x + g.src.w)) > 0, true)
  // the side with the most room: an area against the right edge sends the inset left
  const right = one({ x: 0.82, y: 0.4, w: 0.1, h: 0.08 })
  is('an area at the right edge puts its inset on the left', right.box.x + right.box.w <= right.src.x, true)
  const low = one({ x: 0.4, y: 0.86, w: 0.1, h: 0.1 })
  is('and one at the foot keeps its inset inside the frame', low.box.y + low.box.h <= H, true)
  is('the dial says how far it magnifies', r2(one({ x: 0.1, y: 0.1, w: 0.1, h: 0.08 }, { loupe: 3 }).box.w / g.src.w), 3)
  // a loupe of half the picture is a zoom with extra steps, so the magnification gives way
  const big = one({ x: 0.05, y: 0.05, w: 0.5, h: 0.4 })
  is('a large area is magnified only as far as the frame allows', big.box.w <= 0.63 * W && big.mag < 2.2, true)
  is('and one that cannot be magnified at all is not drawn', plan({ x: 0, y: 0, w: 0.9, h: 0.9 }).loupe.length, 0)
  // A zoom carries the loupe with it, so the inset is placed against what that zoom
  // shows and not against the recording: picked against the whole frame, an inset on a
  // 2x window went off the side of it and the viewer saw a cut sliver.
  {
    const zooms = [{ start: 0, end: 60, scale: 2, x: 0.3, y: 0.5 }]
    const z = Marks.planMarks([{ kind: 'loupe', start: 2, end: 8, x: 0.45, y: 0.45, w: 0.07, h: 0.05 }],
      { W, H, px, clock, span: 60, zooms, look: {} }).loupe[0]
    const v = O.zoomView(zooms, 5)
    is('a loupe inside a zoom keeps its inset inside the window',
      [z.box.x >= v.x * W - 0.5, z.box.x + z.box.w <= (v.x + v.w) * W + 0.5,
        z.box.y >= v.y * H - 0.5, z.box.y + z.box.h <= (v.y + v.h) * H + 0.5], [true, true, true, true])
    is('and is never wider than the window it is seen through', z.box.w < v.w * W, true)
  }
  // it arrives and leaves like everything else Fetch draws over the recording
  const m = Marks.planMarks([{ kind: 'loupe', start: 2, end: 8, x: 0.1, y: 0.1, w: 0.1, h: 0.08 }], { W, H, px, clock, span: 60, zooms: [] })
  const at = t => Marks.at({ ...m, erase: [], pointer: null }, t).loupe[0]
  is('it is not there before it starts', Marks.at({ ...m, erase: [], pointer: null }, 1.9).loupe.length, 0)
  is('it arrives', at(2.1).op > 0 && at(2.1).op < 1, true)
  is('it is whole in the middle', at(5).op, 1)
  is('and it settles out rather than blinking', at(7.9).op < 1 && at(7.9).op > 0, true)
  is('the inset grows the last of the way in as it arrives', at(2.1).scale < at(5).scale, true)
}

// ── arrows ──────────────────────────────────────────────────────────────────
// The light way to point at something: it stands outside the box, so the three ways it
// can go wrong are all about where it is and how big, never about what it covers.
console.log('an arrow')
{
  const plan = (m, o = {}) => Marks.planMarks([{ kind: 'arrow', start: 2, end: 9, ...m }],
    { W, H, px, clock, span: 60, zooms: [], look: {}, ...o }).arrow
  const box = { x: 0.45, y: 0.4, w: 0.14, h: 0.1 }

  // the dial the look schema advertises reaches this far or it is connected to nothing
  const plain = plan(box)[0]
  const big = plan(box, { look: { arrow: 1.8 } })[0]
  is('focus.arrow makes the arrow longer', r2(big.len / plain.len), 1.8)

  // Sized by the window it is seen in at its own hold, not by the deepest zoom anywhere
  // in its life: a half second push at 4x used to draw a seven second arrow at a quarter
  // size for all seven seconds.
  const flash = plan(box, { zooms: [{ start: 2, end: 2.5, scale: 4, x: 0.5, y: 0.5 }] })[0]
  is('a zoom that has gone by the arrow\'s hold does not shrink it', r2(flash.len), r2(plain.len))
  const held = plan(box, { zooms: [{ start: 0, end: 20, scale: 2, x: 0.5, y: 0.5 }] })[0]
  is('and a zoom it is actually seen through does', r2(held.len * 2), r2(plain.len))

  // The tip has to be inside what is on screen, along the way it points and across it.
  // Picked on the room behind the tip alone, an arrow on a box outside a 2x window was
  // drawn entirely off the window, or clamped 500 px away from the box it aimed at.
  is('a box below what a zoom shows gets no arrow rather than one pointing at nothing',
    plan({ x: 0.5, y: 0.92, w: 0.06, h: 0.05 }, { zooms: [{ start: 0, end: 20, scale: 2, x: 0.5, y: 0.2 }] }).length, 0)
  is('and a box off the side of it gets none either',
    plan({ x: 0.9, y: 0.5, w: 0.06, h: 0.05 }, { zooms: [{ start: 0, end: 20, scale: 2, x: 0.2, y: 0.5 }] }).length, 0)

  // and the ordinary case still points at the middle of the box's nearest edge
  is('the tip stands off the box it points at, outside it',
    [plain.dir, plain.tip.x < box.x * W, r2(plain.tip.y)], ['left', true, r2((box.y + box.h / 2) * H)])
  const inside = plan({ x: 0.28, y: 0.42, w: 0.08, h: 0.06 },
    { zooms: [{ start: 0, end: 20, scale: 2, x: 0.5, y: 0.5 }] })[0]
  const v = O.zoomView([{ start: 0, end: 20, scale: 2, x: 0.5, y: 0.5 }], 5.5)
  is('a box hard against the left of a window is pointed at from a side with room',
    [inside.dir, inside.tip.x >= v.x * W, inside.tip.x <= (v.x + v.w) * W,
      inside.tip.y >= v.y * H, inside.tip.y <= (v.y + v.h) * H], ['top', true, true, true, true])
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
