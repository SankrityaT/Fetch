// What the editor shows over a shot is what the PNG holds.
//
// A shot reaches the compositor twice: once for the stage the person is looking at
// (ui/editor.js, stageGLSpec) and once for the file (ui/render-host.js, shotPlan).
// Neither draws anything of its own, so the only way the two can disagree is if the
// three things they hand Plan.prepare drift apart. This holds the shipped block of
// each against the other.
//
// Both files are Electron's: the editor is a DOM shell, render-host opens a window at
// load. So each block is lifted whole and given what it needs, the way
// test/stage-pick.test.js already lifts the lasso.

const fs = require('fs')
const path = require('path')
const vm = require('vm')
const Shot = require('../ui/shot')
const Plan = require('../ui/compositor/plan')
const Look = require('../ui/look')

let pass = 0, fail = 0
const is = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}` +
    (ok ? '' : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`))
}
const ok = (name, got) => is(name, !!got, true)

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')

// ── the editor's side ───────────────────────────────────────────────────
// The block between its own heading and the next one, exactly as it ships.
function stageBlock() {
  const src = read('ui/editor.js')
  const a = src.indexOf("// ── the shot's plan ─")
  const b = src.indexOf('\n// ── ', a + 20)
  if (a < 0 || b < 0) throw new Error("the shot's plan block moved in ui/editor.js: move this test with it")
  return src.slice(a, b) + '\n;globalThis.out = shotPlanParts\n'
}

function stageParts(shot, ctx) {
  const c = { ShotLib: Shot, SHOT_FPS: 30 }
  vm.createContext(c)
  vm.runInContext(stageBlock(), c, { filename: "ui/editor.js (the shot's plan)" })
  return c.out(shot, ctx || {})
}

// ── the export's side ───────────────────────────────────────────────────
// shotPlan takes a size, so nothing here has to write a PNG to read its header back.
function exportBlock() {
  const src = read('ui/render-host.js')
  // groupSizes comes with it: a group's members are measured from their own headers
  // before the plan is made, and shotPlan's first line asks for that.
  const a = src.indexOf('function groupSizes(')
  if (a < 0) throw new Error('groupSizes moved in ui/render-host.js: move this test with it')
  const b = src.indexOf('\n}\n', src.indexOf('function shotPlan(', a))
  if (b < 0) throw new Error('shotPlan does not close in ui/render-host.js: move this test with it')
  return src.slice(a, b + 2) + '\n;globalThis.out = shotPlan\n'
}

function exportPlan(shot, extra) {
  const c = { Plan, SHOT_SPAN: Shot.SPAN, SHOT_FPS: 30 }
  vm.createContext(c)
  vm.runInContext(exportBlock(), c, { filename: 'ui/render-host.js (shotPlan)' })
  return c.out('/tmp/shot.png', Shot.toExportOpts(shot, extra || {}), { width: shot.w, height: shot.h })
}

// ── a shot worth planning ───────────────────────────────────────────────
// Every part of a styled screenshot the round is about: a background, a device frame,
// a tilt, a crop, and the marks that point at things.
function styled() {
  let s = Shot.emptyShot('/tmp/shot.png', { w: 2560, h: 1600 }, 'SH1')
  s = Shot.mergeShot(s, {
    look: {
      background: { kind: 'mesh', mesh: 'dune' },
      frame: { tilt: 0.3, padding: 0.08, aspect: '16:9' },
      // a drawn shape, never a real product
      device: { kind: 'browser', title: 'app.example' },
      treatment: { grain: 0.2, bloom: 0.3 },
      // stored, and pinned only as it is drawn: the stage and the file must pin alike
      motion: { fadeIn: 1.2, reveal: 'rise', loop: true },
    },
    crop: { x: 0.05, y: 0.04, w: 0.9, h: 0.88 },
    marks: [
      { kind: 'lift', x: 0.2, y: 0.3, w: 0.3, h: 0.1 },
      { kind: 'step', x: 0.6, y: 0.2, n: '1' },
      { kind: 'redact', x: 0.1, y: 0.7, w: 0.2, h: 0.05 },
      { kind: 'arrow', x: 0.5, y: 0.5, w: 0.2, h: 0.08 },
    ],
  })
  return s
}

// ── one plan ────────────────────────────────────────────────────────────
{
  const s = styled()
  const parts = stageParts(s)
  const stage = Plan.prepare(parts.opts, parts.meta, parts.ctx)
  const exp = exportPlan(s).spec

  is('the stage and the file are the same plan', JSON.stringify(stage), JSON.stringify(exp))
  is('drawn at the same size', [stage.W, stage.H], [exp.W, exp.H])
  is('over the same span', [stage.start, stage.end], [exp.start, exp.end])
  is('on the same frame grid', stage.fps, exp.fps)
  ok('and the frame drawn is inside it', Shot.HOLD > stage.start && Shot.HOLD < stage.end)

  // the one instant either side ever draws
  const a = Plan.framePlan(stage, Shot.HOLD)
  const b = Plan.framePlan(exp, Shot.HOLD)
  is('the same frame of it', JSON.stringify(a), JSON.stringify(b))
  is('with the take fully landed', a.move == null || JSON.stringify(a.move) === JSON.stringify(b.move), true)
  is('and nothing fading', a.fade, b.fade)
}

// ── the look one frame cannot mean ──────────────────────────────────────
// The stage must pin what the file pins, or a fade set on a recording would darken the
// editor and not the PNG, or the other way round.
{
  const s = styled()
  const parts = stageParts(s)
  is('a fade in is pinned off on the way to the stage', parts.opts.fadeIn, 0)
  is('and a fade out with it', parts.opts.fadeOut, 0)
  is('the take does not arrive', parts.opts.look.motion.reveal, 'none')
  is('nothing loops', parts.opts.look.motion.loop, false)
  is('and nothing travels, so there is no shutter', parts.opts.look.treatment.motionBlur, 0)
  is('the stored look keeps its fade all the same', s.look.motion.fadeIn, 1.2)
  is('and its arrival', s.look.motion.reveal, 'rise')
}

// ── the three things prepare takes ──────────────────────────────────────
{
  const s = styled()
  const bare = stageParts(s)
  is('the meta is the capture, on the rate the file is drawn at',
    [bare.meta.width, bare.meta.height, bare.meta.duration, bare.meta.fps],
    [2560, 1600, Shot.SPAN, 30])
  is('an empty ctx is null, never undefined',
    [bare.ctx.gutter, bare.ctx.imageFile, bare.ctx.prepared], [null, null, null])
  is('and it carries the same clock', bare.ctx.fps, 30)

  const prepared = { src: '/tmp/shot.png', levels: { black: 2, white: 250 } }
  const full = stageParts(s, { gutter: { corner: 12 }, imageFile: '/tmp/bg.jpg', prepared })
  is('the window corner reaches the plan', full.ctx.gutter.corner, 12)
  is('the backdrop file reaches the plan', full.ctx.imageFile, '/tmp/bg.jpg')
  is('the reading of the capture reaches the plan', full.ctx.prepared, prepared)

  // the export takes the same two in the options bag, which is the shape it reads them
  // in (render-host.shotPlan): opts.imageFile and opts.prepared
  const exp = exportPlan(s, { imageFile: '/tmp/bg.jpg', prepared })
  is('and the file plans on them too', [exp.spec.W > 0, exp.size.width], [true, 2560])
}

// ── a bare capture, straight off the helper ─────────────────────────────
// The first thing anyone sees: a shot with no document yet, on the default look.
{
  const s = Shot.emptyShot('/tmp/raw.png', { w: 1440, h: 900 })
  const parts = stageParts(s)
  const stage = Plan.prepare(parts.opts, parts.meta, parts.ctx)
  const exp = exportPlan(s).spec
  is('a fresh capture plans the same either side', JSON.stringify(stage), JSON.stringify(exp))
  ok('and it has a picture in it', stage.W > 0 && stage.H > 0)
  is('on the default look', s.look.frame.padding, Look.defaults().frame.padding)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
