// The compositor's plan (ui/compositor/plan.js, layout.js): the same geometry as the
// classic export, frames placed on the output clock across cuts, zooms and fades, the
// source frame each output frame holds, and which engine an edit goes to.
const Plan = require('../ui/compositor/plan')
const Layout = require('../ui/compositor/layout')
const O = require('../ui/overlays')
const T = require('../ui/timeline')

let pass = 0, fail = 0
const is = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}` +
    (ok ? '' : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`))
}
const r3 = n => Math.round(n * 1000) / 1000
const r3s = a => a.map(r3)

// backdropGeometry as it was in ui/overlays.js before it moved to layout.js, kept here
// verbatim so the move is proved not to change a pixel
function referenceGeometry(srcW, srcH, opts = {}) {
  const inset = Math.min(0.22, Math.max(0.02, opts.inset ?? 0.08))

  // "Auto" keeps the source shape and adds the same margin on every side. Forcing
  // a 16:9 canvas around a 16:10 recording gives fat side margins and thin top and
  // bottom ones, which reads as the video being anchored rather than centred.
  let outW, outH
  const target = opts.outAspect   // number (w/h) when the user picks a shape
  if (!target) {
    const pad = inset * Math.max(srcW, srcH)
    outW = 2 * Math.round((srcW + pad * 2) / 2)
    outH = 2 * Math.round((srcH + pad * 2) / 2)
    // keep the canvas sane for encoding
    const cap = opts.scale === 720 ? 1280 : 1920
    if (outW > cap) {
      const k = cap / outW
      outW = 2 * Math.round((outW * k) / 2)
      outH = 2 * Math.round((outH * k) / 2)
    }
  } else {
    // outWidth is the long edge: a portrait shape 1920 wide came out 3414 tall
    const long = opts.outWidth || 1920
    outW = 2 * Math.round((target >= 1 ? long : long * target) / 2)
    outH = 2 * Math.round((target >= 1 ? long / target : long) / 2)
  }

  // band: a share of the height kept below the video for captions, in place of the
  // bottom margin, so they sit on the backdrop rather than on the product
  const band = Math.max(0, Math.min(0.25, +opts.band || 0))
  const bottom = band ? Math.max(band, inset) : inset
  const boxW = 2 * Math.round((outW * (1 - inset * 2)) / 2)
  const boxH = 2 * Math.round((outH * (1 - inset - bottom)) / 2)
  const scale = Math.min(boxW / srcW, boxH / srcH)
  const vidW = 2 * Math.round((srcW * scale) / 2)
  const vidH = 2 * Math.round((srcH * scale) / 2)
  const radius = Math.max(6, Math.round(opts.radius ?? Math.min(vidW, vidH) * 0.035))
  const ox = Math.round((outW - vidW) / 2)
  // with a band the video hangs from the top margin; the band takes what is left
  const oy = band ? Math.round(outH * inset + (boxH - vidH) / 2) : Math.round((outH - vidH) / 2)
  const blur = Math.max(4, Math.round(vidH * 0.035))
  return { outW, outH, vidW, vidH, radius, ox, oy, blur }
}

console.log('geometry is today\'s backdropGeometry')
{
  const sizes = [[2884, 1780], [3024, 1964], [1920, 1080], [1280, 720], [2880, 1598], [1080, 1920], [812, 1590], [3456, 2234]]
  const variants = [{}, { inset: 0.06 }, { inset: 0.12, radius: 18 }, { inset: 0.06, outAspect: 16 / 9, outWidth: 1920 },
    { inset: 0.06, outAspect: 9 / 16, outWidth: 1920 }, { inset: 0.08, outAspect: 1, outWidth: 1280, scale: 720 },
    { inset: 0.06, band: 0.12 }, { inset: 0.3 }, { inset: 0.001, scale: 720 }]
  let same = 0, total = 0
  for (const [w, h] of sizes) for (const v of variants) {
    total++
    if (JSON.stringify(Layout.backdropGeometry(w, h, v)) === JSON.stringify(referenceGeometry(w, h, v))) same++
  }
  is(`layout.backdropGeometry equals the old function (${total} cases)`, same, total)
  is('overlays still forwards to it', O.backdropGeometry(2884, 1780, { inset: 0.06 }), referenceGeometry(2884, 1780, { inset: 0.06 }))
}

console.log('the plan, framed')
const meta = { width: 2884, height: 1780, duration: 46.9, fps: 26.3 }
{
  const opts = { backdrop: 'dusk', inset: 0.06, radius: 18, shadow: 0.6, backdropAspect: 16 / 9, fadeIn: 0.4, fadeOut: 0.8 }
  const s = Plan.prepare(opts, meta)
  const g = referenceGeometry(2884, 1780, { inset: 0.06, radius: 18, outAspect: 16 / 9, outWidth: 1920 })
  is('output is the classic canvas', [s.W, s.H], [g.outW, g.outH])
  is('the take sits where the classic export puts it', s.rect, { x: g.ox, y: g.oy, w: g.vidW, h: g.vidH })
  is('corner radius', s.radius, g.radius)
  // wider than the classic boxblur, because DESIGN's Elevation says wide rather than
  // tight and the classic width was nine levels deep and gone inside 25 px, but capped
  // against the margin the frame leaves so the pool resolves before the canvas ends
  is('the shadow hangs 0.9 blur low', s.shadow.dy, Math.round(g.blur * 0.9))
  {
    const flat = Math.sqrt((4 * g.blur ** 2 + 4 * g.blur) / 6)
    const margin = Math.min(g.ox, g.oy, g.outW - g.ox - g.vidW, g.outH - g.oy - g.vidH)
    is('shadow sigma is the boxblur power 2 widened into the margin',
      r3(s.shadow.sigma), r3(Math.max(flat, Math.min(2.25 * flat, (margin - Math.round(g.blur * 0.9)) / 1.7))))
    // and the widening itself never puts the pool outside the gutter: a margin too
    // small even for the flat shadow keeps the flat shadow, which is the one the
    // classic renderer draws, rather than going tighter than either
    is('the widening never puts the pool outside the gutter',
      r3(s.shadow.sigma) === r3(flat) || s.shadow.sigma * 1.7 + s.shadow.dy <= margin + 0.001, true)
  }
  is('dusk runs gold to brown', s.bg.c0.map(v => Math.round(v * 255)).concat(s.bg.c1.map(v => Math.round(v * 255))), [240, 169, 60, 122, 62, 18])
  is('a variable-rate take under 45 fps exports at 30', s.fps, 30)
  is('frame count is the output length at that rate', s.frames, Math.round(46.9 * 30))
  is('fade in starts from black', Plan.framePlan(s, 0).fade, 0)
  is('fade in is linear, as ffmpeg fade', r3(Plan.framePlan(s, 0.2).fade), 0.5)
  is('full in the middle', Plan.framePlan(s, 20).fade, 1)
  is('fade out ends at black', r3(Plan.framePlan(s, 46.9).fade), 0)
}
{
  const s = Plan.prepare({ backdrop: 'dusk', inset: 0.06 }, meta, { gutter: { l: 0, t: 0, r: 0, b: 0, corner: 0.02 } })
  is('never tighter than the window\'s own corner', s.radius, Math.ceil(0.02 * s.rect.w * 1.45) + 2)
  const t = Plan.prepare({ backdrop: 'dusk', inset: 0.06 }, meta, { gutter: { l: 0.01, t: 0.02, r: 0.01, b: 0.02, corner: 0 } })
  is('a window margin is trimmed and covered, not stretched', [t.inner.x, t.inner.w, t.inner.y].map(v => Math.round(v * 100) / 100), [0.02, 0.96, 0.02])
  is('a solid colour is a flat gradient', Plan.prepare({ backdrop: 'color:#1A1714' }, meta).bg.c0, Plan.prepare({ backdrop: 'color:#1A1714' }, meta).bg.c1)
  is('an image with no file falls back to dusk', Plan.prepare({ backdrop: 'img:gone.png' }, meta).bg.kind, 'gradient')
  const b = Plan.prepare({ backdrop: 'blur', backdropAspect: 16 / 9 }, meta)
  is('blur ground is the classic 1/64 size', [b.bg.kind, b.bg.fw, b.bg.fh], ['blur', 60, 34])
  is('blurAmount 0.5 is the classic blur', r3(b.bg.sigma), r3(Math.max(2, 125 * 34 / 1080)))
}
{
  // burned captions under a framed take: the band the classic export and the editor's layers leave
  const cues = [{ start: 1, end: 2, text: 'hello' }]
  const s = Plan.prepare({ backdrop: 'dusk', inset: 0.06, captions: true, cues }, meta)
  const g = referenceGeometry(2884, 1780, { inset: 0.06, band: O.CAP_BAND })
  is('captions below a framed take leave the classic band', s.rect, { x: g.ox, y: g.oy, w: g.vidW, h: g.vidH })
  const top = Plan.prepare({ backdrop: 'dusk', inset: 0.06, captions: true, cues, captionStyle: { position: 'top' } }, meta)
  const g0 = referenceGeometry(2884, 1780, { inset: 0.06 })
  is('captions elsewhere leave none', top.rect, { x: g0.ox, y: g0.oy, w: g0.vidW, h: g0.vidH })
  is('nor does an export that draws none (ctx.cues 0)', Plan.prepare({ backdrop: 'dusk', inset: 0.06, captions: true, cues }, meta, { cues: 0 }).rect.y, g0.oy)
}

console.log('the plan, unframed')
{
  const s = Plan.prepare({}, meta)
  is('own shape keeps the take\'s size, even', [s.W, s.H, s.bg.kind], [2884, 1780, 'none'])
  is('scaled to 1080 tall', [Plan.prepare({ scale: 1080 }, meta).H, Plan.prepare({ scale: 1080 }, meta).W % 2], [1080, 0])
  const a = Plan.prepare({ backdropAspect: 16 / 9 }, meta)
  is('a chosen shape is filled by the blurred take, never black', [a.W, a.H, a.bg.kind], [1920, 1080, 'blur'])
  is('the take fits it edge to edge', a.rect.h, 1080)
  const c = Plan.prepare({ crop: { x: 0.1, y: 0.05, w: 0.5, h: 0.5 } }, meta)
  is('a crop is even-sized with an even offset', [c.crop.x % 2, c.crop.y % 2, c.crop.w, c.crop.h], [0, 0, 1442, 890])
}

console.log('time across cuts')
{
  const opts = { start: 1, end: 20, cuts: [[5, 8]], zooms: [{ start: 10, end: 14, scale: 2, x: 0.3, y: 0.4 }] }
  const s = Plan.prepare(opts, meta)
  is('kept ranges', s.keep, [[1, 5], [8, 20]])
  is('output length', s.span, 16)
  is('before the cut a frame shows its own moment', r3(Plan.framePlan(s, 2).s), 3)
  is('after the cut the cut is skipped', r3(Plan.framePlan(s, 4.5).s), 8.5)
  is('the frame where a cut closes shows the moment after it', r3(Plan.framePlan(s, 4).s), 8)
  is('the last frame holds the end', r3(Plan.srcAt(s.keep, 99)), 20)
  is('a zoom lands on the output clock', s.zooms[0].start, 6)
  const mid = Plan.framePlan(s, 8)
  is('mid zoom is zoomed', r3(mid.view0[2]), 0.5)
  is('zoomView is the one curve', mid.view0, (() => { const z = O.zoomView(s.zooms, 8); return [z.x, z.y, z.w, z.h] })())
  // the shutter is open by default now, but a held zoom is not moving, so it takes one
  // sample and the frame is what it always was
  is('a held zoom is one sample even with the shutter open', [s.motionBlur, mid.taps, mid.speed], [0.5, 1, 0])
}

console.log('time through a speed region')
{
  const m24 = { width: 1920, height: 1080, duration: 24, fps: 60 }
  const opts = { start: 0, end: 24, rates: [[8, 16, 2, 2]], zooms: [{ start: 10, end: 14, scale: 2, x: 0.3, y: 0.4 }] }
  const s = Plan.prepare(opts, m24)
  is('kept ranges carry the rate', s.keep, [[0, 8], [8, 16, 2], [16, 24]])
  is('the fast piece is half as long, so the output is 20', s.span, 20)
  is('and the frame count follows it', s.frames, 1200)
  is('two output seconds into a 2x piece is four source seconds in', r3(Plan.framePlan(s, 10).s), 12)
  is('after it the clock is back to 1', r3(Plan.framePlan(s, 13).s), 17)
  // the thing the whole feature has to not break: a zoom named a source moment, and
  // that is still the moment the frame at the zoom's start shows
  is('a zoom on a 2x section lands where the clock puts it', s.zooms[0].start, 9)
  is('and the frame there shows the source moment the zoom named', r3(Plan.srcAt(s.keep, s.zooms[0].start)), 10)
  is('and its end too', r3(Plan.srcAt(s.keep, s.zooms[0].end)), 14)
  is('the frame plan carries the rate it is on',
    [4, 10, 18].map(t => r3(Plan.framePlan(s, t).rate)), [1, 2, 1])

  // a ramp: the rate at the ends is what was asked for, and the moment in the middle
  // is the closed form's, not a step
  const ramp = Plan.prepare({ start: 0, end: 12, rates: [[0, 12, 1, 3]] }, { ...m24, duration: 12 })
  is('a 1x to 3x ramp is half as long', r3(ramp.span), 6)
  is('it starts at 1 and ends at 3', [r3(Plan.framePlan(ramp, 0).rate), r3(Plan.framePlan(ramp, 6).rate)], [1, 3])
  is('and three output seconds in it has spent 4.5 source seconds', r3(Plan.framePlan(ramp, 3).s), 4.5)

  // a rate change with no cut behind it is not a cut
  const split = Plan.prepare({ start: 0, end: 24, rates: [[12, 24, 4, 4]],
    look: { motion: { cutTransition: 'dip' } } }, m24)
  is('two pieces meeting with nothing between them', split.keep, [[0, 12], [12, 24, 4]])
  is('and no transition where the speed changes', split.cut, null)

  // a dissolve over a real cut inside a fast piece plays both sides at that piece's
  // rate, or half the transition stalls
  const x = Plan.prepare({ start: 0, end: 24, cuts: [[10, 12]],
    rates: [[0, 10, 4, 4], [12, 24, 4, 4]], look: { motion: { cutTransition: 'crossfade' } } }, m24)
  const pt = x.cut.points[0]
  is('both sides know their rate', [pt.ra, pt.rb], [4, 4])
  const before = Plan.srcPair(x, pt.t - pt.d / 2), after = Plan.srcPair(x, pt.t + pt.d / 2)
  is('the outgoing side runs on at 4x', r3(after.s - before.s), r3(pt.d * 4))
  is('and the incoming side with it', r3(after.s2 - before.s2), r3(pt.d * 4))
  is('neither side reaches past the material the cut removed',
    [after.s <= 12 + 1e-9, before.s2 >= 10 - 1e-9], [true, true])
}

console.log('motion blur scales with travel')
{
  const s = Plan.prepare({ zooms: [{ start: 1, end: 5, scale: 2.4, x: 0.8, y: 0.2 }], look: { treatment: { motionBlur: 0.5 } } }, { ...meta, fps: 60 })
  const still = Plan.framePlan(s, 3)
  is('a held zoom is one sample', still.taps, 1)
  const moving = Plan.framePlan(s, 1.3)
  is('a glide takes several samples', moving.taps > 2, true)
  is('never more than 32', moving.taps <= 32, true)
  is('the samples span the shutter', moving.view0[2] > moving.view1[2], true)
  // the smear is the zoom's own speed, not the dial: the shutter opens the same width
  // at the start of the push, at its fastest and as it settles, and what comes out is
  // the velocity of the curve at each
  const zoom = O.zoomPlan(s.zooms)[0]
  const ramp = zoom.inEnd - zoom.inStart
  const speeds = [0, 0.15, 0.5, 0.9, 1].map(k => Plan.framePlan(s, zoom.inStart + ramp * k).speed)
  is('at rest nothing smears', [speeds[0], speeds[4]], [0, 0])
  is('fastest in the middle of the push', speeds[2] > speeds[1] && speeds[2] > speeds[3], true)
  is('and the settle is quieter than the leave', speeds[3] < speeds[1], true)
  const taps = [0.15, 0.5, 0.9].map(k => Plan.framePlan(s, zoom.inStart + ramp * k).taps)
  is('the samples follow the speed', taps[1] > taps[0] && taps[1] > taps[2], true)
  // the dial is the shutter angle alone: twice the angle, about twice the smear
  const wide = Plan.prepare({ zooms: [{ start: 1, end: 5, scale: 2.4, x: 0.8, y: 0.2 }], look: { treatment: { motionBlur: 1 } } }, { ...meta, fps: 60 })
  const t2 = zoom.inStart + ramp * 0.1
  is('the dial is the shutter, not the speed', Plan.framePlan(wide, t2).speed, Plan.framePlan(s, t2).speed)
  is('a wider shutter takes more of the travel', Plan.framePlan(wide, t2).taps > Plan.framePlan(s, t2).taps, true)
  // the peak of a 2.4x push already asks for more than 32 and gets 32: the cap is what
  // the bench and the shader's loop bound were measured against
  is('and never more than 32', Plan.framePlan(wide, zoom.inStart + ramp * 0.3).taps, 32)
}

console.log('sample and hold')
{
  // frames at irregular times: a still screen writes nothing for seconds
  const pts = [0, 0.1, 0.2, 1.5, 1.52, 4.0, 4.1]
  is('the latest frame at or before', [0, 0.05, 0.1, 1.0, 1.51, 3.99, 4.0, 9].map(u => Plan.holdIndex(pts, u)), [0, 0, 1, 2, 3, 4, 5, 6])
  const s = Plan.prepare({ start: 0, end: 4.2, cuts: [[1, 3.5]] }, { width: 1920, height: 1080, duration: 4.2, fps: 60 })
  const m = Plan.screenFrames(s, pts)
  is('frame count', m.pick.length, s.frames)
  // output 1.0 s is source 3.5, where the screen still shows the frame from 1.52
  is('after a cut the held frame is the one on screen then', m.pick[60], 4)
  is('every index is a real frame', [...m.pick].every(i => i >= 0 && i < pts.length), true)
  is('decode runs cover every picked frame', [...m.pick].every(i => m.runs.some(([a, b]) => i >= a && i <= b)), true)
  // a long cut is not decoded
  const dense = Array.from({ length: 600 }, (_, i) => i / 60)
  const d = Plan.screenFrames(Plan.prepare({ start: 0, end: 10, cuts: [[2, 8]] }, { width: 1920, height: 1080, duration: 10, fps: 60 }), dense)
  is('a cut is left out of the decode', d.runs.length, 2)
  is('the run after the cut starts where it closed', d.runs[1][0], 480)
  // dead air removed: two hundred cuts, and still a select expression ffmpeg can parse
  const cuts = Array.from({ length: 200 }, (_, k) => [k * 0.5 + 0.2, k * 0.5 + 0.45])
  const many = Plan.screenFrames(Plan.prepare({ start: 0, end: 100, cuts }, { width: 1920, height: 1080, duration: 100, fps: 60 }), Array.from({ length: 6000 }, (_, i) => i / 60))
  is('never more than 64 decode runs', many.runs.length <= 64, true)
  is('and they still cover every picked frame', [...many.pick].every(i => many.runs.some(([a, b]) => i >= a && i <= b)), true)
}

console.log('the camera on its own clock')
{
  const cam = { file: '/x.cam.mov', x: 0.8, y: 0.8, size: 0.2, camStartedAt: 1000, screenStartedAt: 1500, gaps: [[3000, 4000]] }
  const s = Plan.prepare({ camera: cam, backdrop: 'dusk' }, { width: 1920, height: 1080, duration: 6, fps: 60 })
  is('the bubble is a share of the framed take', s.cam.d, 2 * Math.round(0.2 * s.rect.w / 2))
  is('never outside the take', s.cam.x + s.cam.d <= s.rect.x + s.rect.w && s.cam.y + s.cam.d <= s.rect.y + s.rect.h, true)
  is('the camera time skips its pause', r3(Plan.framePlan(s, 3).camT), r3(T.camTime(cam, 3)))
  const cpts = Array.from({ length: 300 }, (_, i) => i / 30)
  const m = Plan.cameraFrames(s, cpts)
  is('camera frames follow camTime', m.pick[180], Plan.holdIndex(cpts, T.camTime(cam, 3)))
  is('a camera that starts after the screen shows nothing yet',
    Plan.frameMap([0.5, 1], 3, n => T.camTime({ camStartedAt: 2000, screenStartedAt: 1000 }, n)).pick[0], -1)

  // The bubble's track, off the GPU. A span is the state at `start` and whatever the
  // bubble had before it at `end`, so one entry is the whole of "keep the camera small
  // while the lift is up".
  const kc = { ...cam, keys: [{ start: 2, end: 4, size: 0.1 }] }
  const sk = Plan.prepare({ camera: kc, backdrop: 'dusk' }, { width: 1920, height: 1080, duration: 6, fps: 60 })
  is('a span is two keys and the base', sk.cam.track.length, 3)
  is('the camera decodes at the biggest the bubble gets', sk.cam.d, 2 * Math.round(0.2 * sk.rect.w / 2))
  is('the bubble opens where the editor put it', r3(Plan.camAt(sk.cam, 0).d), r3(sk.cam.d))
  is('and is at the key once the move has landed', Plan.camAt(sk.cam, 3.5).d < sk.cam.d * 0.6, true)
  is('and is between the two in the middle of the move',
    Plan.camAt(sk.cam, 2.3).d < sk.cam.d && Plan.camAt(sk.cam, 2.3).d > Plan.camAt(sk.cam, 3.5).d, true)
  is('never outside the take, at rest or in flight',
    [0, 2.3, 3.5, 4.4, 5].every(t => { const b = Plan.camAt(sk.cam, t)
      return b.x >= sk.rect.x - 0.01 && b.x + b.d <= sk.rect.x + sk.rect.w + 0.01 }), true)
}

console.log('a caption over live content, and the shade that used to travel with it')
{
  const Text = require('../ui/compositor/text')
  const cues = [{ start: 1, end: 4, text: 'Every row shows the key and the tempo.' }]
  const prepared = { captions: { cues: [], busy: [], words: null } }
  // no box: the take is the whole output, which is the default look and the case that
  // draws the plate rather than a band
  const tp = Text.planText({ captions: true, captionStyle: {}, cues }, { clock: t => t, span: 10, W: 1920, H: 1080, box: null, prepared })
  const at = Text.textAt(tp, 2)
  const plate = at.frost[0]
  is('it gets a plate', !!plate, true)
  const inside = b => plate && b.x >= plate.x - plate.feather - 0.01 && b.y >= plate.y - plate.feather - 0.01 &&
    b.x + b.w <= plate.x + plate.w + plate.feather + 0.01 && b.y + b.h <= plate.y + plate.h + plate.feather + 0.01
  is('and nothing it draws reaches past it', at.items.every(i => inside(i.bounds)), true)
  // and where there is no plate the cloud is still what separates the words from the
  // picture, so it still has the room to draw one
  const band = Text.planText({ captions: true, captionStyle: {}, cues }, { clock: t => t, span: 10, W: 1920, H: 1080,
    box: { x: 100, y: 60, w: 1720, h: 800 }, prepared })
  const bandAt = Text.textAt(band, 2)
  is('a caption in the band keeps its cloud', [bandAt.frost.length, bandAt.items[0].bounds.h > at.items[0].bounds.h], [0, true])

  // The band belongs to the take's own place on the frame. A device sits in that place
  // rather than beside it, so a caption laid out from the screen inside the shell
  // walked down into the shell: a 50 px line landed on a laptop's foot.
  const m = { width: 1920, height: 1080, duration: 10, fps: 30 }
  const capAt = look => {
    const s = Plan.prepare({ backdrop: 'dusk', inset: 0.06, captions: true, cues, look }, m, { prepared })
    const it = Text.textAt(s.text, 2)
    return { s, top: Math.min(...it.items.map(i => i.bounds.y)) }
  }
  const flat = capAt({}), lap = capAt({ device: { kind: 'laptop' } })
  const d = lap.s.device
  is('a caption under a device sits where it sits without one', Math.abs(lap.top - flat.top) < 1, true)
  // and that is below the whole of what the device draws, its foot included
  const L = O.captionLayout(lap.s.W, lap.s.H, {}, lap.s.text.capBox)
  is('and clear of everything the device draws', L.y - L.px * 0.59 > d.foot.y + d.foot.h, true)
}

console.log('the frame\'s own texture: the ground\'s tooth under the film, and the film\'s clock')
{
  // Both in levels of the finished frame: the tooth is uniform, three levels either
  // side; the grain is triangular over its cell, and what it leaves on a page at the
  // end of the range is the ceiling the tooth is held to (plan.js, GRAIN_ENDS).
  const TOOTH = 6 / 219 * 255 / Math.sqrt(12)
  const grainEnds = film => film * 0.055 * 255 / Math.sqrt(6) * 0.6
  const spec = (film, fps = 30) => Plan.prepare({ backdrop: 'dusk', look: { grain: { film } } },
    { width: 1920, height: 1080, duration: 10, fps })
  is('no film, and the tooth is the ground\'s own three levels', spec(0).tooth, 1)
  for (const film of [0.12, 0.2, 0.25, 0.3, 0.5, 1]) {
    const t = spec(film).tooth
    is(`film ${film}: the tooth never stands above the grain on the picture`,
      r3(t * TOOTH) <= r3(Math.max(grainEnds(film), 0.3 * TOOTH)), true)
  }
  is('a light dial does not take the ground under the dither either', spec(0.02).tooth, 0.3)
  is('and a heavy one leaves it where it was', spec(1).tooth, 1)
  is('the film is exposed once per output frame at 30', spec(0.2, 30).grainHold, 1)
  is('and twice as slowly at 60, so a look grains the same at both', spec(0.2, 60).grainHold, 2)
}

console.log('the drawn device, and the tilt')
{
  const meta = { width: 1920, height: 1080, duration: 10, fps: 30 }
  const of = (look, extra = {}) => Plan.prepare({ backdrop: 'dusk', inset: 0.08, ...extra, look }, meta)
  const bare = of({})
  is('no device by default, and no tilt', [bare.device, bare.tilt], [null, null])
  for (const kind of ['browser', 'window', 'laptop', 'phone']) {
    const s = of({ device: { kind } })
    const d = s.device, b = d.box, sc = d.screen
    is(`${kind}: the take is the screen inside the shell`, [s.rect.x === sc.x, s.rect.y === sc.y, s.rect.w === sc.w], [true, true, true])
    is(`${kind}: the screen is inside the shell`, [sc.x >= b.x, sc.y >= b.y, sc.x + sc.w <= b.x + b.w, sc.y + sc.h <= b.y + b.h], [true, true, true, true])
    // the device takes the take's place and never more of the frame than it had
    const r = bare.rect
    is(`${kind}: and the shell is no larger than the take was`,
      [b.x >= r.x - 1, b.y >= r.y - 1, b.x + b.w <= r.x + r.w + 1, (d.foot ? d.foot.y + d.foot.h : b.y + b.h) <= r.y + r.h + 1], [true, true, true, true])
    // the take keeps its own shape inside the frame it is given
    is(`${kind}: the screen keeps the take's shape`, Math.abs(sc.w / sc.h - r.w / r.h) < 0.01, true)
    is(`${kind}: and a device answers for the take's edge itself`, s.edge, null)
  }
  // frame.chrome clean is the browser frame with no device asked for by name, and it
  // only draws where the real chrome could be cropped off: round a real browser bar it
  // would be two browsers, and Look.warnings says so in the same case
  const page = { x: 0, y: 0.12, w: 1, h: 0.88 }
  is('frame.chrome clean draws the browser frame', of({ frame: { chrome: 'clean' } }, { viewport: page }).device.kind, 'browser')
  is('and keep draws none', of({ frame: { chrome: 'keep' } }, { viewport: page }).device, null)
  is('nor does clean where the page\'s place is unknown', of({ frame: { chrome: 'clean' } }).device, null)
  is('a device asked for by name is still drawn there', of({ frame: { chrome: 'clean' }, device: { kind: 'laptop' } }).device.kind, 'laptop')

  // The shell's tone. A photo is the one ground the plan cannot read (edgeEnd calls
  // every image light, which is the safe end for the take's hairline and the wrong one
  // for a shell), so it starts on graphite and gl.js re-picks it from the decoded mean.
  const img = Plan.prepare({ backdrop: 'img:deep-space.jpg', inset: 0.08, look: { device: { kind: 'browser' } } },
    meta, { imageFile: '/tmp/deep-space.jpg' })
  is('an auto shell on a photo ground stays graphite until the picture is read', [img.bg.kind, img.device.light, img.device.auto], ['image', false, true])
  is('and a light ground it can read gets the bone one', of({ device: { kind: 'browser' } }, { backdrop: 'color:#F5F2EC' }).device.light, true)
  is('and a named theme is not re-picked', of({ device: { kind: 'browser', theme: 'light' } }).device.auto, false)
  // the shell and the hairline are the range apart, which is what lets a fixed pair of
  // tones answer for an edge nothing measured: nothing can be within the floor of both
  const tone = of({ device: { kind: 'browser' } }).device
  const lum = c => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
  is('the shell and its hairline are further apart than two edge floors',
    Math.abs(lum(Plan.rgb(tone.shell)) - lum(Plan.rgb(tone.line))) > 2 * 24 / 255, true)

  // The tilt is a plane a camera turns, and the plane is shrunk by as much as the
  // projection's near edge grows, so a tilted take asks for exactly the room the flat
  // one had and its near corner cannot reach past the frame.
  const project = (t, x, y) => {
    const s = t.D / (t.D - (x - t.cx) * t.sin)
    return [t.cx + (x - t.cx) * (t.m / t.D) * s * t.fit, t.cy + (y - t.cy) * s * t.fit]
  }
  for (const deg of [-20, -7, 5, 14, 20]) {
    const s = of({ frame: { tilt: deg } })
    const r = s.rect, t = s.tilt
    const xs = [r.x, r.x + r.w], ys = [r.y, r.y + r.h]
    const corners = xs.flatMap(x => ys.map(y => project(t, x, y)))
    is(`tilt ${deg} stays inside the take's own box`,
      corners.every(([x, y]) => x >= r.x - 0.5 && x <= r.x + r.w + 0.5 && y >= r.y - 0.5 && y <= r.y + r.h + 0.5), true)
  }
  is('a tilt of nothing is no tilt at all', of({ frame: { tilt: 0 } }).tilt, null)
  const t14 = of({ frame: { tilt: 14 } }).tilt
  // positive turns the take's right edge toward the viewer, so that edge is the taller
  const left = project(t14, of({ frame: { tilt: 14 } }).rect.x, 0)[0]
  is('and the turn is a perspective, not a skew', r3(t14.fit) < 1 && t14.sin > 0 && Number.isFinite(left), true)
}

console.log('a phone inside a phone')
{
  // The judge's own export: a simulator take in Fetch's phone shell came out as two
  // bezels, two notches and a Mac toolbar (.context/survey/sim-taste.md section 5).
  // The numbers are the ones measured off the pixels in .context/survey/st-t0.md, on
  // the device that export came from: a 794 x 1718 capture of a Simulator window whose
  // glass runs x 44 to 750 and y 154 to 1688, round a 1320 x 2868 screen at 3.
  //
  // A Simulator window is not nearly the glass, which is what the round before this
  // believed: 154 px of floating toolbar, gap and drawn bezel stand above the screen
  // and 44 px stand beside it. Nor does the window's shape give that away, since it is
  // within half a percent of the device's own aspect.
  const meta = { width: 794, height: 1718, duration: 10, fps: 30 }
  const WIN = { kind: 'window', app: 'Simulator', title: 'Yolk-ProMax' }
  const SCREEN = { w: 1320, h: 2868, scale: 3 }
  const glass = { x: 44 / 794, y: 154 / 1718, w: 706 / 794, h: 1534 / 1718 }
  const of = (look, extra = {}) => Plan.prepare({ backdrop: 'dusk', inset: 0.08, ...extra, look }, meta)
  const dev = (kind, extra) => of({ device: { kind } }, extra).device
  // the four thicknesses a shell is judged by, in pixels of the finished frame
  const sides = d => ({ top: d.screen.y - d.box.y, side: d.screen.x - d.box.x,
    foot: d.box.y + d.box.h - d.screen.y - d.screen.h })

  // A recording says nothing about what it was a capture of, which is why the round
  // before this drew the full phone here and the judge got the second bezel. What a
  // take of a device does carry is the device's own framebuffer, and that plus the
  // measured screen rectangle settles it both ways.
  const cut = of({ device: { kind: 'phone' } }, { screen: SCREEN, viewport: glass, crop: { ...glass } })
  is('a take cropped to the device\'s screen has no chrome left in it', cut.device.own, false)
  is('so the shell round it is a phone and not a frame', !!cut.device.slit, true)
  is('and the pixels drawn are the glass and nothing round it',
    [cut.crop.x, cut.crop.y, cut.crop.w, cut.crop.h], [44, 154, 706, 1534])
  const c = sides(cut.device)
  is('a phone\'s bezel and foot are a pair, and both stand off its sides',
    [Math.abs(c.top - c.foot) <= 1, c.top > c.side + 2], [true, true])

  // Nothing cropped: the Simulator's toolbar and its own drawn bezel are still in the
  // picture, so Fetch's phone would be the second one in it.
  const kept = dev('phone', { screen: SCREEN, viewport: glass })
  is('a take that kept the device\'s own window keeps its own chrome', kept.own, true)
  is('so the phone asked for over it is still drawn', !!kept.box, true)
  is('but wears no speaker slit, since the picture already has a phone in it', kept.slit, null)
  const k = sides(kept)
  is('and it is a plain frame: one thickness on all four sides',
    [Math.abs(k.top - k.side) <= 1, Math.abs(k.foot - k.side) <= 1], [true, true])
  is('which is thinner than the bezel a phone of its own gets', k.top < c.top, true)

  // No measurement is not permission to guess. A rectangle nobody measured is never
  // written onto the document (ui/simulator.js), so what reaches here is no rectangle
  // at all, and a picture that may still be a whole Simulator window gets the frame,
  // never the phone.
  is('a device take whose glass was never measured keeps its own device',
    dev('phone', { screen: SCREEN }).own, true)
  is('and so does one cropped by hand to something wider than the glass',
    dev('phone', { screen: SCREEN, viewport: glass, crop: { x: 0, y: 0.09, w: 1, h: 0.8 } }).own, true)
  is('while a crop tighter than the glass is glass too',
    dev('phone', { screen: SCREEN, viewport: glass, crop: { x: 0.1, y: 0.2, w: 0.5, h: 0.4 } }).own, false)

  // The same, on the one device measured whose window is nothing like the shape of its
  // screen: an iPhone SE, 798 x 1704 of window round 666 x 1185 of glass at x 66 y 321.
  // A rule that compared the window's shape with the screen's would pass the two
  // notched phones and catch only this one, which is why the crop is what is asked.
  const se = { width: 798, height: 1704, duration: 10, fps: 30 }
  const seGlass = { x: 66 / 798, y: 321 / 1704, w: 666 / 798, h: 1185 / 1704 }
  const seOf = extra => Plan.prepare({ backdrop: 'dusk', inset: 0.08, screen: { w: 750, h: 1334, scale: 2 },
    look: { device: { kind: 'phone' } }, ...extra }, se).device
  is('a home button phone cropped to its glass is a phone', [seOf({ viewport: seGlass, crop: { ...seGlass } }).own,
    !!seOf({ viewport: seGlass, crop: { ...seGlass } }).slit], [false, true])
  is('and one that kept its window is a plain frame', seOf({ viewport: seGlass }).own, true)

  // A shot of a simulator says both things about itself, and answers the same.
  is('a capture of a device says the same as a recording of one',
    dev('phone', { screen: SCREEN, captured: WIN, viewport: glass, crop: { ...glass } }).own, false)
  is('and the same the other way', dev('phone', { screen: SCREEN, captured: WIN, viewport: glass }).own, true)

  // frame.chrome clean crops the real frame off and draws Fetch's own in its place.
  // Which frame is what the capture was of: a browser's bar over a handset's glass is
  // the same doubling as a phone round a phone.
  is('clean over a device\'s own screen draws the phone',
    of({ frame: { chrome: 'clean' } }, { screen: SCREEN, viewport: glass, crop: { ...glass } }).device.kind, 'phone')
  is('and over a browser page still draws the browser',
    of({ frame: { chrome: 'clean' } }, { viewport: { x: 0, y: 0.12, w: 1, h: 0.88 } }).device.kind, 'browser')

  // Nothing above changes the answer for the shells that already had one. A window
  // capture with no viewport is the case the plain bezel was written for.
  const win = dev('window', { captured: WIN })
  is('a window shell round a capture with its own bar is unchanged', win.own, true)
  is('and its top is still the same bezel as its sides', Math.abs(sides(win).top - sides(win).side) <= 1, true)
  const region = dev('phone', { captured: { kind: 'region' } })
  is('a region capture never had chrome, so a phone is a phone', [region.own, !!region.slit], [false, true])
  const page = { x: 0, y: 0.12, w: 1, h: 0.88 }
  is('a browser page cropped to itself is bare', dev('browser', { captured: WIN, viewport: page, crop: page }).own, false)
  is('and one that kept its tabs is not', dev('browser', { captured: WIN, viewport: page }).own, true)

  // A member of a group answers the same question about its own capture, so a device
  // standing beside a window is drawn from the same rule as one on its own.
  const two = [{ src: '/tmp/a.png', w: 3420, h: 1780, scale: 2, device: 'window' },
    { src: '/tmp/b.png', w: 794, h: 1718, scale: 2, device: 'phone', captured: WIN, viewport: glass, crop: glass }]
  const set = Plan.prepare({ backdrop: 'dusk', inset: 0.08, backdropAspect: 16 / 9,
    group: { members: two }, look: { device: {} } }, { width: 3420, height: 1780, duration: 10, fps: 30 })
  is('a group member cropped to its screen is a phone too', !!set.group[1].device.slit, true)
  const plain = Plan.prepare({ backdrop: 'dusk', inset: 0.08, backdropAspect: 16 / 9,
    group: { members: [two[0], { ...two[1], crop: null }] }, look: { device: {} } },
  { width: 3420, height: 1780, duration: 10, fps: 30 })
  is('and one that kept its own device is a plain frame', plain.group[1].device.slit, null)
}

console.log('the picture\'s own type, and the room it takes')
{
  const meta = { width: 2560, height: 1600, duration: 60, fps: 30 }
  const framed = (texts, look = {}, more = {}) => Plan.prepare({ start: 0, end: 4, cuts: [],
    backdrop: 'ink', inset: 0.08, backdropAspect: 16 / 9, shadow: 0.6,
    look: { typography: {}, ...look }, texts, ...more }, meta, {})

  // A drawn device takes the box the layout gave the picture and hands back the screen
  // inside it. The type's room came out of the box, so the type is placed against the
  // box: placed against the screen, a headline's descenders sat on the shell's bezel and
  // at typography.headlineSize 0.026 the whole line was inside the title bar.
  const shell = framed([{ text: 'Find any take in one search', style: 'headline' }],
    { device: { kind: 'browser', title: 'songscription.app' } })
  const S = shell.text.still
  const blockH = S.runs.reduce((h, r) => h + r.lead + r.lineH, 0)
  is('a headline above a drawn frame clears the frame, not the screen inside it',
    S.top + blockH <= shell.device.box.y, true)
  is('and the small sizes clear it too', (() => {
    const sm = framed([{ text: 'Find any take in one search', style: 'headline' }],
      { device: { kind: 'browser', title: 'songscription.app' }, typography: { headlineSize: 0.026 } })
    const h = sm.text.still.runs.reduce((a, r) => a + r.lead + r.lineH, 0)
    return sm.text.still.top + h <= sm.device.box.y
  })(), true)
  is('a caption under a laptop sits under the whole laptop, foot and all', (() => {
    const lap = framed([{ text: 'The library, on a laptop', style: 'caption' }], { device: { kind: 'laptop' } })
    const foot = lap.device.foot || lap.device.box
    return lap.text.still.capTop >= foot.y + foot.h
  })(), true)

  // The column over the picture is the picture's own width, never the picture plus both
  // of its margins: 2560x1600 at inset 0.08 was given a 1536 px column over a 1248 px
  // picture, a quarter wider than the thing it names.
  const over = framed([{ text: 'Find any take in one search', style: 'headline' }], { typography: { headline: 'above' } })
  is('the column over a picture is never wider than the picture', over.text.still.col <= over.rect.w + 1, true)
  const five = framed(Array.from({ length: 5 }, (_, i) => ({ text: `Line number ${i + 1} of a long headline block`, style: 'headline' })),
    { typography: { headline: 'above' } })
  is('and it is still not wider once the type has refitted the picture', five.text.still.col <= five.rect.w + 1, true)

  // Both sides of the still question ask it of the same clock. stillRoom read the take's
  // own seconds and planText read the output's, so a title card on a trimmed edit was
  // full-span to one and mid-clip to the other: nothing was reserved, the card was
  // stripped as a headline, and the picture lost it without a word.
  const trimmed = Plan.prepare({ start: 20, end: 30, cuts: [], backdrop: 'ink', inset: 0.08,
    backdropAspect: 16 / 9, shadow: 0.6, look: { typography: {} },
    texts: [{ text: 'Songscription', style: 'title', start: 20, end: 30 }] }, meta, {})
  is('a title running the whole of a trimmed edit is drawn, as the headline it is',
    !!trimmed.text.still && trimmed.text.still.runs.length > 0, true)

  // And the still filter takes out only what the still block took. With no ground there
  // is no still block, and a full-span title taken out here as well was a title card
  // deleted from a recording with nothing said about it.
  const plain = t => Plan.prepare({ start: 0, end: 60, cuts: [], inset: 0.08,
    look: { typography: {} }, texts: [t] }, meta, {})
  is('an unframed edit keeps its full-span title card', plain({ text: 'Songscription', style: 'title', start: 0, end: 60 }).text.cards.length, 1)
  is('and a headline with no ground to stand on is drawn nowhere', plain({ text: 'A hero line', style: 'headline' }).text, null)

  // A plate given more words than two lines hold steps down a size and then ends in an
  // ellipsis. Sliced at two lines, a label dropped its last words with nothing to show
  // for it and the picture read as a finished sentence that was not one.
  const Text = require('../ui/compositor/text')
  const pinKey = text => {
    const sp = framed([{ text, style: 'label', at: { x: 0.5, y: 0.5 } }])
    return (Text.textAt(sp.text, 0).items.find(i => String(i.key).startsWith('pin|')) || {}).key || ''
  }
  const WORDY = 'This is the button that starts the recording and also stops it when you are done'
  const long = pinKey(WORDY)
  is('an over-long pinned label steps down rather than dropping its last words',
    long.endsWith(WORDY.replace(/ /g, ' ').slice(-16)) && !long.includes('…') && +long.split('|')[2] < 41, true)
  const silly = pinKey(WORDY + ' and then shows you exactly what it wrote and where it wrote it and how long it took')
  is('and at the floor it ends in an ellipsis rather than stopping mid-sentence', silly.includes('…'), true)
  is('one that fits keeps every word of itself at the size it asked for',
    pinKey('Tempo').includes('Tempo') && !pinKey('Tempo').includes('…'), true)

  // A window title is not an address. A filename is the commonest window title there is,
  // and every one of them matched a run of dotted labels ending in letters.
  const bar = title => framed([], { device: { kind: 'browser', title } }).device
  for (const name of ['README.md', 'notes.txt', 'index.html', 'build.sh', 'Fetch.xcodeproj']) {
    is(`a window called ${name} is not drawn as an address`, bar(name).address, false)
  }
  for (const a of ['songscription.app', 'app.example.com/library', 'https://x.example/a']) {
    is(`and ${a} still is`, bar(a).address, true)
  }
  // a browser's bar is taller than a window's because a field stands in it, so with no
  // field there is no toolbar. The same rule on a recording as on a capture.
  const bare = bar(''), win = framed([], { device: { kind: 'window', title: 'Library' } }).device
  is('a browser bar with nothing to put in it is a title bar', r3(bare.bar / bare.unit), r3(win.bar / win.unit))
  is('and one with an address is taller', bar('songscription.app').bar > bare.bar, true)
}

console.log('which engine')
{
  is('a framed look with zooms goes to the compositor', Plan.engineFor({ backdrop: 'dusk', zooms: [{ start: 1, end: 2 }] }).engine, 'gl')
  // M3: everything an edit places is the compositor's
  is('marks go to the compositor', Plan.engineFor({ marks: [{ kind: 'redact', start: 1, end: 2 }, { kind: 'lift', start: 1, end: 3 }] }), { engine: 'gl', why: [] })
  is('captions that would burn too', Plan.engineFor({ captions: true }, { cues: 3 }).engine, 'gl')
  is('text and the drawn cursor too', Plan.engineFor({ texts: [{ text: 'Hi' }] }, { pointer: true, macCursor: true }), { engine: 'gl', why: [] })
  is('a gif goes to the compositor', Plan.engineFor({ format: 'gif' }).engine, 'gl')
  is('a sound file stays classic', Plan.engineFor({ format: 'm4a' }).engine, 'classic')
  is('auto zoom too', Plan.engineFor({ autoZoom: true }), { engine: 'gl', why: [] })
  is('forced gl says what it leaves out', Plan.engineFor({ still: 3 }, {}, 'gl'), { engine: 'gl', why: ['a still frame'] })
  const auto = [{ start: 2, end: 4, scale: 1.7, x: 0.3, y: 0.4 }]
  const meta = { width: 1920, height: 1080, duration: 10, fps: 30 }
  is('auto zoom\'s moments become the plan\'s zooms', Plan.prepare({ autoZoom: true }, meta, { prepared: { autoZooms: auto } }).zooms, auto)
  is('zooms asked for by name win over auto zoom', Plan.prepare({ autoZoom: true, zooms: [{ start: 5, end: 7, scale: 2, x: 0.5, y: 0.5 }] }, meta,
    { prepared: { autoZooms: auto } }).zooms.map(z => z.start), [5])
  is('classic on request', Plan.engineFor({}, {}, 'classic').engine, 'classic')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
