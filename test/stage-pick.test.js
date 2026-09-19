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

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
