// The touch track: device points into the recorded frame, a finger that is not on
// the glass between taps, and a held tap that glides.
const T = require('../ui/touch')
const P = require('../ui/pointer')

let pass = 0, fail = 0
const is = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}` +
    (ok ? '' : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`))
}
const near = (name, got, want, tol = 1e-6) => is(name, Math.abs(got - want) <= tol || got, true)
const throws = fn => { try { fn(); return false } catch { return true } }
const r3 = n => Math.round(n * 1000) / 1000

// An iPhone 16 Pro Max as piece 1 reports it: the native framebuffer and its scale,
// and the device screen sitting inside a window that has a title bar above it.
const PHONE = { w: 1320, h: 2868, scale: 3 }
const VIEW = { screen: PHONE, viewport: { x: 0, y: 0.04, w: 1, h: 0.96 } }

// ---- device points into the recorded frame ----
{
  is('the screen centre is the viewport centre', T.deviceToWindow({ x: 220, y: 478 }, VIEW), { x: 0.5, y: 0.52 })
  is('the screen origin is the viewport origin', T.deviceToWindow({ x: 0, y: 0 }, VIEW), { x: 0, y: 0.04 })
  is('the bottom of the screen is the bottom of the viewport', T.deviceToWindow({ x: 440, y: 956 }, VIEW), { x: 1, y: 1 })
  is('points are read through the device scale, not the framebuffer',
    T.deviceToWindow({ x: 110, y: 0 }, VIEW).x, 0.25)
  is('pixels are read as pixels when asked for',
    T.deviceToWindow({ x: 330, y: 0 }, { ...VIEW, units: 'pixels' }).x, 0.25)
  is('no viewport is the whole recorded frame', T.deviceToWindow({ x: 220, y: 478 }, { screen: PHONE }), { x: 0.5, y: 0.5 })

  // a disc pinned to an edge for a whole take is worse than a sentence
  is('a point off the device screen is refused', throws(() => T.deviceToWindow({ x: 900, y: 10 }, VIEW)), true)
  is('a point a hair off the edge is not', throws(() => T.deviceToWindow({ x: 440.5, y: 10 }, VIEW)), false)
  is('an unknown device screen is refused', throws(() => T.deviceToWindow({ x: 10, y: 10 }, {})), true)
  is('a viewport outside the frame is refused',
    throws(() => T.deviceToWindow({ x: 10, y: 10 }, { screen: PHONE, viewport: { x: 0.5, y: 0, w: 0.8, h: 1 } })), true)
  is('the refusal says what to send instead',
    /device points, 0 to 440 by 956/.test((() => { try { T.deviceToWindow({ x: 900, y: 10 }, VIEW) } catch (e) { return e.message } })()), true)
}

// ---- taps onto the pointer track, click derived not asked for ----
{
  const pts = T.mapTaps([
    { t: 1, x: 220, y: 478 },
    { t: 2, x: 220, y: 478, id: 'drag' },
    { t: 2.4, x: 220, y: 200, id: 'drag' },
    { t: 3, x: 44, y: 95.6 },
  ], VIEW)
  is('every landing is a click, every continuation is not',
    pts.map(p => !!p.click), [true, true, false, true])
  is('a held finger keeps its id', pts[2].id, 'drag')
  is('the track is the shape pointer.js already keeps',
    JSON.stringify(P.normalizeTrack(pts)), JSON.stringify(pts))
  is('an empty list is an empty track', T.mapTaps(null, VIEW), [])
}

// ---- what counts as a finger on the glass ----
{
  const c = T.touches([{ t: 1, x: 0.5, y: 0.5, click: true }, { t: 2, x: 0.2, y: 0.2, click: true }])
  is('two taps are two touches', c.length, 2)
  is('a tap does not reach the next one', [c[0].down, c[0].up], [1, 1])
  is('a single tap has not moved', c[0].moved, false)

  const h = T.touches([
    { t: 1, x: 0.5, y: 0.5, click: true, id: 'a' },
    { t: 1.3, x: 0.5, y: 0.2, id: 'a' },
    { t: 1.6, x: 0.5, y: 0.1, id: 'a' },
  ])
  is('a held tap that moves is one touch', h.length, 1)
  is('it is down from the first point to the last', [h[0].down, h[0].up, h[0].moved], [1, 1.6, true])

  // the absence rule at the level of the model: a move with nothing behind it is nothing
  is('a move with no finger down is dropped',
    T.touches([{ t: 1, x: 0.5, y: 0.5 }, { t: 2, x: 0.3, y: 0.3 }]).length, 0)
  is('a move under an id whose touch already ended is dropped',
    T.touches([{ t: 1, x: 0.5, y: 0.5, click: true, id: 'a' }, { t: 2, x: 0.3, y: 0.3, id: 'b' }])[0].up, 1)
  is('a second click under the same id is a second tap',
    T.touches([{ t: 1, x: 0.5, y: 0.5, click: true, id: 'a' },
      { t: 1.4, x: 0.5, y: 0.5, click: true, id: 'a' }]).length, 2)
  is('nothing reported is no plan', T.planTouch([]), null)
}

// ---- the absence rule, which is the whole difference from a cursor ----
{
  const pl = T.planTouch([{ t: 1, x: 0.5, y: 0.5, click: true }, { t: 3, x: 0.2, y: 0.2, click: true }])
  is('the plan opens on the first rise and closes on the last fall',
    [pl.start, pl.stop], [r3(1 - T.TOUCH.rise), r3(3 + T.TOUCH.hold + T.TOUCH.fall)])

  is('nothing is on the glass before the first tap', T.presenceAt(pl, 0.5), 0)
  is('nothing is on the glass between two taps', T.presenceAt(pl, 2), 0)
  is('nothing is on the glass after the last tap', T.presenceAt(pl, 4), 0)
  is('the finger is fully there at the moment it landed', T.presenceAt(pl, 1), 1)
  is('and still there through the hold', T.presenceAt(pl, 1 + T.TOUCH.hold), 1)
  near('it is halfway up halfway through the rise', T.presenceAt(pl, 1 - T.TOUCH.rise / 2), 0.5)
  near('and halfway down halfway through the fall', T.presenceAt(pl, 1 + T.TOUCH.hold + T.TOUCH.fall / 2), 0.5)

  // a cursor glides between clicks; a finger does not, and this is the test that says so
  const mid = T.discsAt(pl, 2)
  is('no disc is drawn between two taps', mid.length, 0)
}

// ---- a held tap glides, and only a held tap ----
{
  const pl = T.planTouch([
    { t: 1, x: 0.5, y: 0.8, click: true, id: 'a' },
    { t: 2, x: 0.5, y: 0.2, id: 'a' },
  ])
  is('the disc is still on the glass a second after landing', T.discsAt(pl, 2).length, 1)
  is('it starts where it landed', T.discsAt(pl, 1)[0].y, 0.8)
  near('it is halfway across at the halfway moment', T.discsAt(pl, 1.5)[0].y, 0.5)
  near('it eases in rather than stepping', T.discsAt(pl, 1.1)[0].y, 0.8 - 0.6 * P.ease(0.1))
  is('it ends where it was last reported', T.discsAt(pl, 2)[0].y, 0.2)
  is('and holds there rather than drifting on', T.discsAt(pl, 2 + T.TOUCH.hold)[0].y, 0.2)
  is('a glide is one disc, not a trail', T.discsAt(pl, 1.5).length, 1)
}

// ---- the same plan in frame pixels, which is what the compositor hands it ----
{
  // pointer.js cursorLayout has already clocked, cropped and scaled these into the
  // finished frame, so nothing here may treat a coordinate as a fraction
  const pl = T.planTouch([
    { t: 1, x: 660, y: 1434, click: true, id: 'a' },
    { t: 1.5, x: 660, y: 600, id: 'a' },
  ])
  is('a frame pixel is not clamped to a fraction', T.discsAt(pl, 1)[0].y, 1434)
  near('and it glides in pixels', T.discsAt(pl, 1.25)[0].y, 1017)
  is('a tap above the crop keeps its negative place',
    T.discsAt(T.planTouch([{ t: 1, x: 100, y: -40, click: true }]), 1)[0].y, -40)
  is('cleaning a track in fractions is the pointer\'s own cleaning',
    JSON.stringify(T.normalizeTaps([{ t: 2, x: 1.4, y: 0.5, click: true }, { t: 1, x: 0.5, y: 0.5 }])),
    JSON.stringify(P.normalizeTrack([{ t: 2, x: 1.4, y: 0.5, click: true }, { t: 1, x: 0.5, y: 0.5 }])))
}

// ---- press, and every frame drawn alone ----
{
  const pl = T.planTouch([{ t: 1, x: 0.5, y: 0.5, click: true }])
  is('the disc is unsquashed as it comes down', T.discsAt(pl, 1 - 0.05)[0].press, 1)
  is('it squashes most at the bottom of the dip', r3(T.discsAt(pl, 1 + T.DISC.dipFor)[0].press), T.DISC.dip)
  is('and comes back', T.discsAt(pl, 1 + T.DISC.dipFor + T.DISC.back)[0].press, 1)
  is('press is a closed form of the time since the tap',
    T.discsAt(pl, 1.03)[0].press, T.pressIn({ down: 0, points: [{ t: 0, x: 0, y: 0 }] }, 0.03))

  // no pass reads the previous frame: asking for the frames backwards gives the same answer
  const fwd = [], back = []
  for (let i = 0; i < 40; i++) fwd.push(r3(T.presenceAt(pl, 0.8 + i / 60)))
  for (let i = 39; i >= 0; i--) back.unshift(r3(T.presenceAt(pl, 0.8 + i / 60)))
  is('any frame can be drawn alone', back, fwd)
}

// ---- two taps closer together than the fall ----
{
  const pl = T.planTouch([{ t: 1, x: 0.2, y: 0.2, click: true }, { t: 1.1, x: 0.8, y: 0.8, click: true }])
  const d = T.discsAt(pl, 1.12)
  is('the one landing and the one lifting are both drawn', d.length, 2)
  is('the landing one is the loud one', [d[0].x, d[1].x], [0.8, 0.2])
  is('neither has travelled toward the other', [d[0].y, d[1].y], [0.8, 0.2])

  const fast = []
  for (let i = 0; i < 8; i++) fast.push({ t: 1 + i * 0.02, x: 0.1 * (i + 1), y: 0.5, click: true })
  is('a machine gun of taps is capped rather than drawn', T.discsAt(T.planTouch(fast), 1.16).length, T.MAX)
}

// ---- the disc is a real touch target, at any device ----
{
  is('44 points across a 440 point screen filling a 1320 px frame',
    T.discPixels({ screen: PHONE, W: 1320 }), 132)
  is('a screen that is nine tenths of the frame scales with it',
    r3(T.discPixels({ screen: PHONE, viewport: { x: 0.05, y: 0, w: 0.9, h: 1 }, W: 1320 })), r3(132 * 0.9))
  is('a wider device gets a smaller disc in the same frame',
    r3(T.discPixels({ screen: { w: 2064, h: 2752, scale: 2 }, W: 1320 })), r3(44 / 1032 * 1320))
  is('an unknown device screen draws no confident size', T.discPixels({ W: 1320 }), null)
  is('a frame with no width draws none either', T.discPixels({ screen: PHONE }), null)
}

// ---- two fingers held at once, which is not a pinch and is not deferred ----
{
  // Two fingers down from t=1 to t=2. Held in one slot, each reported move cleared the
  // other finger's touch, so both came out a single point long and both discs were gone
  // half a second in: the taps drew and the holds did not exist.
  const two = T.touches([
    { id: 'a', t: 1, x: 0.2, y: 0.2, click: true }, { id: 'b', t: 1, x: 0.8, y: 0.2, click: true },
    { id: 'a', t: 2, x: 0.3, y: 0.6 }, { id: 'b', t: 2, x: 0.7, y: 0.6 },
  ])
  is('two fingers held at once are two touches, each with its own glide',
    two.map(c => c.points.length), [2, 2])
  is('and both are still on the glass in the middle of the hold',
    T.discsAt(T.planTouch([
      { id: 'a', t: 1, x: 0.2, y: 0.2, click: true }, { id: 'b', t: 1, x: 0.8, y: 0.2, click: true },
      { id: 'a', t: 2, x: 0.3, y: 0.6 }, { id: 'b', t: 2, x: 0.7, y: 0.6 },
    ]), 1.5).length, 2)
  // a move under an id nothing is holding is still nothing, and still closes nobody
  const stray = T.touches([
    { id: 'a', t: 1, x: 0.2, y: 0.2, click: true }, { id: 'z', t: 1.2, x: 0.9, y: 0.9 },
    { id: 'a', t: 1.4, x: 0.4, y: 0.4 },
  ])
  is('a move with no finger behind it drops itself and nobody else',
    [stray.length, stray[0].points.length], [1, 2])
  // and a second landing under the same id is a second tap, not a continuation
  const again = T.touches([
    { id: 'a', t: 1, x: 0.2, y: 0.2, click: true }, { id: 'a', t: 1.5, x: 0.6, y: 0.6, click: true },
    { id: 'a', t: 1.7, x: 0.7, y: 0.7 },
  ])
  is('a new landing under one id is a new touch', [again.length, again[0].points.length, again[1].points.length], [2, 1, 2])
}

// ---- the cap sheds the oldest ghost, never the live finger ----
{
  // Eight taps 20 ms apart. Several are at full opacity at once, so ranking by opacity
  // alone kept whichever three came first: Fetch drew the past and hid the present
  // exactly where a demo moves fastest.
  const fast = []
  for (let i = 0; i < 8; i++) fast.push({ id: 't' + i, t: 1 + i * 0.02, x: 0.1 * (i + 1), y: 0.5, click: true })
  const pl = T.planTouch(fast)
  const at = t => T.discsAt(pl, t).map(d => r3(d.x)).sort()
  is('the three newest are the three drawn, at the instant the seventh lands', at(1.12), [0.6, 0.7, 0.8])
  is('and the tap approaching is never dropped for a ghost behind it',
    T.discsAt(pl, 1.13).some(d => r3(d.x) === 0.8), true)
  is('still capped', T.discsAt(pl, 1.16).length, T.MAX)
  is('and still handed back most opaque first',
    T.discsAt(pl, 1.16).map(d => d.op).every((v, i, a) => !i || a[i - 1] >= v), true)
}

// ---- a device on its side ----
{
  // simctl reports no orientation, so the record carries what the window's shape says
  // (ui/simulator.js orientOf). Without it every number here is taken off the portrait
  // width: the disc came out 4.7 times too small and a legitimate landscape tap at
  // x=900 was refused as off a 440 point screen.
  const land = { ...PHONE, orientation: 'landscape' }
  is('a landscape device aims in swapped points', T.screenPoints(land), { w: 956, h: 440 })
  is('and a tap across its long edge is on the glass, not off it',
    T.deviceToWindow({ x: 900, y: 200 }, { screen: land, viewport: { x: 0, y: 0, w: 1, h: 1 } }),
    { x: 0.941, y: 0.455 })
  is('and the disc is measured through the edge that is across',
    r3(T.discPixels({ screen: land, W: 1320 })), r3(44 / 956 * 1320))
}

console.log(`\n  ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
