// Picking on the editor's stage (ui/stage-pick.js). The lasso is only as good as this
// arithmetic: every case below is a point on a canvas that has to land on one pixel of
// the recording, through a crop, a zoom, a caption band and a title card.
const P = require('../ui/stage-pick')
const Layout = require('../ui/compositor/layout')

let pass = 0, fail = 0
const is = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}` +
    (ok ? '' : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`))
}
const r4 = n => Math.round(n * 10000) / 10000
const box4 = b => b && { x: r4(b.x), y: r4(b.y), w: r4(b.w), h: r4(b.h) }

// The recording, and the edit's crop into it. The same take throughout, so a pixel
// answer in one case can be compared with a pixel answer in another.
const SOURCE = { width: 1600, height: 900 }
const CROP = { x: 0.2, y: 0.1, w: 0.6, h: 0.8 }

// Section 1 of the lasso contract: a box of the cropped frame, into the recording's
// own pixels. Held here so the test proves the whole chain, not just its first half.
function contentPx(f, crop = CROP) {
  const c = crop || { x: 0, y: 0, w: 1, h: 1 }
  return { x: Math.round(SOURCE.width * (c.x + c.w * f.x)),
    y: Math.round(SOURCE.height * (c.y + c.h * f.y)) }
}

// A stage of any size: the canvas's client rect, and the output the compositor draws.
const stage = (left, top, w, h) => ({ left, top, width: w, height: h })

console.log('\nstage-pick: a point on the canvas, into the recording')

{
  // 1. No frame, no shape: the output is the cropped take at its own size, the rect is
  // the whole canvas, and local is simply where in the picture the pointer is.
  const spec = { W: 1280, H: 900 }
  const geom = { rect: { x: 0, y: 0, w: 1280, h: 900 }, inner: { x: 0, y: 0, w: 1, h: 1 },
    view: [0, 0, 1, 1], W: spec.W, H: spec.H }
  // the stage is half the export and starts 100 in from the window's left edge
  const rect = stage(100, 50, 640, 450)
  const p = P.toOutput({ x: 100 + 480, y: 50 + 112.5 }, rect, spec)
  is('a stage smaller than the export scales the point up', p, { x: 960, y: 225 })
  const f = P.toFrac(p, geom)
  is('three quarters across, a quarter down', { x: r4(f.x), y: r4(f.y) }, { x: 0.75, y: 0.25 })
  is('and that is a pixel of the recording, through the crop', contentPx(f), { x: 1040, y: 270 })
}

{
  // 2. A device pixel ratio of 2 changes the backing store and nothing else. The point
  // goes from the client rect straight to output pixels, so the same click on a stage
  // of 640 CSS px and on one of 1280 is the same pixel of the recording.
  const spec = { W: 1280, H: 900 }
  const geom = { rect: { x: 0, y: 0, w: 1280, h: 900 }, inner: { x: 0, y: 0, w: 1, h: 1 },
    view: [0, 0, 1, 1], W: spec.W, H: spec.H }
  const dpr = 2
  const small = stage(0, 0, 640, 450)          // backing 1280 by 900 at dpr 2
  const big = stage(0, 0, 1280, 900)           // backing 2560, capped to the file's own W
  is('the backing store is the only thing dpr touches', small.width * dpr, spec.W)
  const a = contentPx(P.toFrac(P.toOutput({ x: 160, y: 90 }, small, spec), geom))
  const b = contentPx(P.toFrac(P.toOutput({ x: 320, y: 180 }, big, spec), geom))
  is('the same click on the picture is the same pixel at either size', a, b)
  is('and it is the pixel under the pointer', a, { x: 560, y: 234 })
}

{
  // 3. Framed, with burned captions: the take hangs from the top margin and the band
  // takes what is left (ui/compositor/layout.js:60), so rect.y is not centred. This is
  // the case that catches a hit test written against a centred rect.
  const g = Layout.backdropGeometry(1200, 900, { inset: 0.06, band: 0.18, outWidth: 1920, outAspect: 16 / 9 })
  const centred = Math.round((g.outH - g.vidH) / 2)
  is('the caption band pushes the take off centre', g.oy < centred, true)
  const spec = { W: g.outW, H: g.outH }
  const geom = { rect: { x: g.ox, y: g.oy, w: g.vidW, h: g.vidH }, inner: { x: 0, y: 0, w: 1, h: 1 },
    view: [0, 0, 1, 1], W: spec.W, H: spec.H }
  const rect = stage(0, 0, spec.W, spec.H)     // stage at export size, so client px are output px
  const mid = P.toFrac(P.toOutput({ x: g.ox + g.vidW / 2, y: g.oy + g.vidH / 2 }, rect, spec), geom)
  is('the middle of the take is the middle of the frame', { x: r4(mid.x), y: r4(mid.y) }, { x: 0.5, y: 0.5 })
  const band = P.toFrac(P.toOutput({ x: spec.W / 2, y: g.oy + g.vidH + 20 }, rect, spec), geom)
  is('a point down in the caption band is not on the take', band, null)
}

{
  // 4. A zoom in force. The view is what Plan.viewAt says at this output moment, so a
  // click in the middle of a 2x zoom centred low and right is not the middle of the
  // frame. A window margin is trimmed inside the frame at the same time.
  const spec = { W: 1000, H: 1000 }
  const geom = { rect: { x: 0, y: 0, w: 1000, h: 1000 },
    inner: { x: 0.05, y: 0.05, w: 0.9, h: 0.9 },
    view: [0.25, 0.4, 0.5, 0.5], W: spec.W, H: spec.H }
  const rect = stage(0, 0, 500, 500)
  const f = P.toFrac(P.toOutput({ x: 250, y: 250 }, rect, spec), geom)
  // local 0.5 -> q 0.5 -> the view's own centre
  is('the centre of a zoomed stage is the centre of the view', { x: r4(f.x), y: r4(f.y) }, { x: 0.5, y: 0.65 })
  const tl = P.toFrac(P.toOutput({ x: 0, y: 0 }, rect, spec), geom)
  is('its top-left corner is the view through the trimmed margin', { x: r4(tl.x), y: r4(tl.y) }, { x: 0.275, y: 0.425 })
  is('and that is a pixel of the recording', contentPx(tl), { x: 584, y: 396 })
  // the band is drawn from the same numbers, so it lands back where it was picked
  const back = P.fromFrac(tl, geom)
  is('forward again is the point it came from', { x: r4(back.x), y: r4(back.y) }, { x: 0, y: 0 })
}

{
  // 5. A title card is up, so the take is scaled about its centre and dropped. Without
  // undoing the move the pick is off for as long as the card is on screen.
  const rect = { x: 0, y: 0, w: 1000, h: 1000 }
  const moved = P.movedRect(rect, { k: 0.8, dy: 40 })
  is('the move scales about the centre and drops it', moved, { x: 100, y: 140, w: 800, h: 800 })
  const spec = { W: 1000, H: 1000 }
  const geom = { rect: moved, inner: { x: 0, y: 0, w: 1, h: 1 }, view: [0, 0, 1, 1], W: spec.W, H: spec.H }
  const client = stage(0, 0, 1000, 1000)
  const f = P.toFrac(P.toOutput({ x: 500, y: 540 }, client, spec), geom)
  is('the lifted take still picks true at its centre', { x: r4(f.x), y: r4(f.y) }, { x: 0.5, y: 0.5 })
  is('a point beside the lifted take is on the backdrop', P.toFrac({ x: 50, y: 500 }, geom), null)
  is('unmoved, the same rect is left alone', P.movedRect(rect, null), { x: 0, y: 0, w: 1000, h: 1000 })
}

{
  // 6. The drag itself.
  is('a drag up and to the left is the same box', box4(P.rectOf({ x: 0.6, y: 0.5 }, { x: 0.2, y: 0.1 })),
    { x: 0.2, y: 0.1, w: 0.4, h: 0.4 })
  is('a drag down and to the right agrees with it', box4(P.rectOf({ x: 0.2, y: 0.1 }, { x: 0.6, y: 0.5 })),
    { x: 0.2, y: 0.1, w: 0.4, h: 0.4 })
  is('a box that runs off the frame is brought back in', box4(P.clampBox({ x: 0.8, y: -0.2, w: 0.5, h: 0.5 })),
    { x: 0.8, y: 0, w: 0.2, h: 0.5 })
  is('a box with no area is not a box', P.clampBox({ x: 0.5, y: 0.5, w: 0, h: 0.2 }), null)
  is('a flick is a click', P.tooSmall({ x: 0.5, y: 0.5, w: 0.01, h: 0.3 }), true)
  is('so is a thin line', P.tooSmall({ x: 0.5, y: 0.5, w: 0.3, h: 0.019 }), true)
  is('two percent each way is an area', P.tooSmall({ x: 0.5, y: 0.5, w: 0.02, h: 0.02 }), false)
  is('nothing drawn is too small', P.tooSmall(null), true)
}

// ── the lasso catches up with the Elements pass ─────────────────────────
// Section 2 of the lasso contract: the timing, not the arithmetic. The pass that
// names what is under the band lands about a second after it is asked for, and a
// person who arms the tool and drags straight away is done before it. Everything
// below is the shipped block of ui/editor.js run for real: the file is the editor's
// DOM shell and cannot be required outside Electron, so its lasso section is lifted
// whole and given a stage, a canvas and an ipcRenderer to talk to.
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const EDITOR = fs.readFileSync(path.join(__dirname, '..', 'ui', 'editor.js'), 'utf8')
function lassoSource() {
  const a = EDITOR.indexOf('// \u2500\u2500 the lasso \u2500')
  const b = EDITOR.indexOf('\n// \u2500\u2500 ', a + 20)
  if (a < 0 || b < 0) throw new Error('the lasso block moved in ui/editor.js: move this test with it')
  // the block keeps its own scope, so what the test drives is handed out by name
  return EDITOR.slice(a, b) + `
;globalThis.out = { setLasso, lassoDown, lassoMove, lassoUp,
  get drag() { return lassoDrag }, get band() { return lassoBand } }
`
}

const OUT = 1000                 // a square export at stage size, so a client pixel is an output pixel
// one card on screen, and a drag that misses its edges by a few pixels either way
const CARD = { id: 'E1', kind: 'card', text: 'Sign in', box: { x: 0.3, y: 0.3, w: 0.4, h: 0.2 } }
const DRAG = { from: [310, 305], to: [690, 495] }
const DRAWN = { x: 0.31, y: 0.305, w: 0.38, h: 0.19 }

function fakeEl() {
  const el = { style: {}, hidden: true, isConnected: true, innerHTML: '', firstChild: { innerHTML: '' } }
  const on = new Set()
  el.classList = { add: c => on.add(c), remove: c => on.delete(c), contains: c => on.has(c),
    toggle: (c, want) => (want ? on.add(c) : on.delete(c)) }
  el.remove = () => { el.isConnected = false }
  el.on = on
  return el
}

// A take on the stage with the lasso armed, and the Elements pass held in the test's
// hand. `cap` stands in for the 2 s the real wait is bounded by.
function armed({ cap = 400 } = {}) {
  const calls = []
  const regions = []
  let land = null
  const video = { currentTime: 3, paused: true, addEventListener() {} }
  const frame = { dataset: { gl: 'on' }, appendChild() {}, addEventListener() {} }
  const canvas = { offsetLeft: 0, offsetTop: 0, offsetWidth: OUT, offsetHeight: OUT,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: OUT, height: OUT }) }
  const ctx = {
    console,
    setTimeout: (fn, ms) => setTimeout(fn, ms >= 1000 ? cap : ms),
    clearTimeout,
    ed: { src: '/x/Take.mov', lasso: false, tab: 'focus' },
    stageGL: { clock: t => t,
      spec: { W: OUT, H: OUT, inner: { x: 0, y: 0, w: 1, h: 1 }, rect: { x: 0, y: 0, w: OUT, h: OUT } } },
    $: id => ({ stageFrame: frame, edVideo: video, stageGL: canvas }[id] || null),
    escHtml: v => String(v),
    toast: () => {},
    seek: () => {},
    paintAim: () => {},
    document: { addEventListener() {}, removeEventListener() {}, createElement: () => fakeEl() },
    window: { addEventListener() {}, fetchLasso: { add: r => regions.push(r), onDrop() {} } },
    ipcRenderer: {
      invoke(ch, args) {
        calls.push({ ch, args })
        // the pass is held: nothing lands until the test says so, which is the window
        // a quick drag lives inside
        if (ch === 'lasso-elements') return new Promise(done => { land = done })
        return Promise.resolve({ id: 'R1', path: args.path, at: args.at, box: args.box,
          element: args.element, kind: args.kind, label: args.label })
      },
    },
    require: name => (name === './ui/compositor/plan'
      ? { framePlan: () => ({ move: null }), viewAt: () => [0, 0, 1, 1] }
      : require(path.join(__dirname, '..', name.replace(/^\.\//, '')))),
  }
  vm.createContext(ctx)
  vm.runInContext(lassoSource(), ctx, { filename: 'ui/editor.js (the lasso)' })
  const L = ctx.out
  L.setLasso(true)
  const at = (p, ev) => ({ button: 0, buttons: 1, type: ev || 'mousedown', clientX: p[0], clientY: p[1],
    target: {}, preventDefault() {} })
  return {
    L, calls, regions,
    passes: () => calls.filter(c => c.ch === 'lasso-elements').length,
    minted: () => calls.filter(c => c.ch === 'lasso-region').map(c => c.args)[0] || null,
    land: els => { const done = land; land = null; done({ elements: els }) },
    down: () => L.lassoDown(at(DRAG.from)),
    move: () => L.lassoMove(at(DRAG.to, 'mousemove')),
    tag: () => (L.band ? L.band.firstChild.innerHTML : null),
  }
}

const tick = () => new Promise(done => setTimeout(done, 0))

async function lassoCases() {
  {
    // 7. The reported fault. The drag happens inside the window the pass is still out,
    // so the band is free form and the area is called "Area". When the pass lands the
    // rectangle is judged again, under the pointer, without another mousemove.
    const s = armed()
    s.down(); s.move()
    is('a drag ahead of the pass snaps to nothing', s.L.drag.kind, 'free')
    is('and has only the fallback name', s.L.drag.label, 'Area')
    is('so the band says so', s.tag(), 'Free')
    s.land([CARD])
    await tick()
    is('the pass landing snaps the band to the card', box4(s.L.drag.box), CARD.box)
    is('and names it', s.L.drag.label, 'Sign in')
    is('and the id is the one the agent aims at', s.L.drag.element, 'E1')
    is('the band caught up under the pointer', /E1/.test(s.tag()) && /Sign in/.test(s.tag()), true)
  }

  {
    // 8. One moment, one pass: arming asks for the frame on screen and the mousedown
    // behind it lands on the same key, so the drag rides the answer already coming.
    const s = armed()
    s.down(); s.move()
    is('the moment is asked for once', s.passes(), 1)
  }

  {
    // 9. Quicker than the pass: the button is up before any answer exists. The chip is
    // minted once, so this is the last moment the name can be got right.
    const s = armed()
    s.down(); s.move()
    const up = s.L.lassoUp()
    is('nothing is minted while the answer is still out', s.minted(), null)
    s.land([CARD])
    await up
    const sent = s.minted()
    is('release waits for the pass and mints the element', sent && sent.element, 'E1')
    is('with the element box, not the hand-drawn one', box4(sent && sent.box), CARD.box)
    is('and the name the person can read', sent && sent.label, 'Sign in')
    is('the chip in the composer carries it', s.regions.length && s.regions[0].label, 'Sign in')
  }

  {
    // 10. A pass that never lands costs its say and not the gesture: the area still
    // reaches the composer, free form and under the fallback name.
    const s = armed({ cap: 1 })
    s.down(); s.move()
    await s.L.lassoUp()
    const sent = s.minted()
    is('a pass that hangs still mints the area', box4(sent && sent.box), DRAWN)
    is('free form', sent && sent.kind, 'free')
    is('under the fallback name', sent && sent.label, 'Area')
  }
}

lassoCases().then(() => {
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}, err => { console.error(err); process.exit(1) })
