// A shot is a take of one frame. These tests hold the two claims that makes: the look
// crosses between a shot and a recording with nothing lost, and the shared code that
// plans marks never learns what a still is, because a shot lends it a clock.

const S = require('../ui/shot')
const FD = require('../ui/fetchdoc')
const Look = require('../ui/look')
const Marks = require('../ui/compositor/marks')

let pass = 0, fail = 0
const is = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}` +
    (ok ? '' : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`))
}
const ok = (name, got) => is(name, !!got, true)

// ---- the document ----
{
  const s = S.emptyShot('/tmp/a.png', { w: 2560, h: 1600 }, 'SH3')
  is('a shot says what it is', s.kind, 'shot')
  is('it keeps its own id', s.id, 'SH3')
  is('it says its size, having no duration to stand in for it', [s.w, s.h], [2560, 1600])
  is('it starts on the default look', s.look.frame.padding, Look.defaults().frame.padding)
  is('and with nothing on it', s.marks, [])
  is('a shot has no timeline to hold', ['clips', 'cues', 'beats', 'zooms', 'pointer', 'audio'].filter(k => k in s), [])
}

is('a shot id is short and cannot be read as a subtitle', S.shotId(7), 'SH7')
is('and is recognised back', [S.isShotId('sh7'), S.isShotId('S7'), S.isShotId('M1')], [true, false, false])

// ---- marks are placed, never timed ----
{
  const s = S.normalize({ marks: [
    { kind: 'lift', x: 0.2, y: 0.2, w: 0.3, h: 0.2, start: 1, end: 4 },
    { kind: 'step', box: { x: 0.6, y: 0.1, w: 0.1, h: 0.1 }, n: 1 },
    { kind: 'nonsense', x: 0.1, y: 0.1 },
  ] }, '/tmp/a.png', { w: 1920, h: 1080 })
  is('marks get M ids', s.marks.map(m => m.id), ['M1', 'M2'])
  is('a time sent with a mark is dropped, not kept and ignored',
    Object.keys(s.marks[0]).filter(k => k === 'start' || k === 'end'), [])
  is('a step numbers the box top left, as it does in an edit', [s.marks[1].x, s.marks[1].y], [0.6, 0.1])
  is('a kind nothing draws is refused', s.marks.length, 2)
  is('the counter advanced past what it minted', s.nextId.M, 3)
}

// The rule the M ids exist for: one must never be reused after a delete.
{
  const s = S.normalize({ marks: [{ kind: 'blur', x: 0.1, y: 0.1, w: 0.2, h: 0.1 }] }, '/a.png', { w: 100, h: 100 })
  s.marks = []
  is('an id is never handed out twice', S.mintId(s), 'M2')
}

// ---- times that do not apply ----
is('timing a mark gives it the one span', S.timed([{ kind: 'lift' }])[0], { kind: 'lift', start: 0, end: S.SPAN })
is('and untiming it takes both away', S.untimed([{ kind: 'lift', start: 0, end: 4 }])[0], { kind: 'lift' })
ok('the instant drawn is inside the span', S.HOLD > 0 && S.HOLD < S.SPAN)
is('and it is the one instant renderStills is asked for', S.times(), [S.HOLD])

// The point of the lent clock: marks planned on a shot are fully arrived and not yet
// leaving at HOLD. A step and an arrow are the two the planner drops outright when the
// span is too short, so their presence is the proof the span is real.
{
  const marks = S.timed([
    { kind: 'lift', id: 'M1', x: 0.2, y: 0.2, w: 0.3, h: 0.2 },
    { kind: 'step', id: 'M2', x: 0.7, y: 0.3, n: 1 },
    { kind: 'arrow', id: 'M3', x: 0.4, y: 0.6, w: 0.2, h: 0.1 },
    { kind: 'redact', id: 'M4', x: 0.1, y: 0.8, w: 0.2, h: 0.05 },
  ])
  const plan = Marks.planMarks(marks, { W: 1920, H: 1080, px: 1, clock: t => t, span: S.SPAN, zooms: [], ease: 'smooth' })
  const at = Marks.at(plan, S.HOLD)
  is('a lift is fully in at the instant drawn', at.focus.length && +at.focus[0].level.toFixed(3), 1)
  is('a step badge is drawn and settled', [at.steps.length, +at.steps[0].op.toFixed(3), +at.steps[0].scale.toFixed(3)], [1, 1, 1])
  is('an arrow survives the span', at.arrow.length, 1)
  is('a redaction is on', at.redact.length, 1)
}

// ---- the look crosses both ways ----
{
  // A look someone saved off a recording: a fade, a tilt, a device, a grain.
  const take = Look.merge(Look.defaults(), {
    'motion.fadeIn': 2, 'motion.fadeOut': 1.5, 'motion.reveal': 'rise',
    'background.kind': 'mesh', 'background.mesh': 'studio',
    'device.kind': 'browser', 'frame.tilt': 6, 'grain.film': 0.3,
  }).look

  const s = S.mergeShot(S.emptyShot('/a.png', { w: 1920, h: 1080 }), { look: take })
  is('a look from a recording lands on a shot whole', Look.diff(take, s.look), {})

  // and back, unchanged, which is what "the other way round" has to mean
  const back = FD.mergeDoc(FD.emptyDoc('/a.mov', 10), { look: s.look })
  is('and goes back to a recording with the fade intact',
    [back.look.motion.fadeIn, back.look.motion.fadeOut, back.look.motion.reveal], [2, 1.5, 'rise'])
  is('nothing about it changed in the crossing', Look.diff(take, back.look), {})

  // the stored look keeps the fade; only what is drawn pins it
  const still = S.stillLook(s.look)
  is('the still pins what one frame cannot mean',
    [still.motion.fadeIn, still.motion.fadeOut, still.motion.reveal, still.motion.loop,
      still.motion.cutTransition, still.treatment.motionBlur],
    [0, 0, 'none', false, 'none', 0])
  is('and touches nothing else', still.background.mesh + ' ' + still.device.kind + ' ' + still.frame.tilt + ' ' + still.grain.film,
    'studio browser 6 0.3')
  is('the shot still holds the fade it was given', s.look.motion.fadeIn, 2)
  is('every pinned path is a real field of the schema',
    Object.keys(S.STILL_PINS).filter(p => !require('../ui/look-schema').BY_PATH.has(p)), [])
}

// A preset saved from either document is one preset: the shot and the edit hold the
// same object at .look, so assignment is the whole of the interchange.
{
  const d = FD.emptyDoc('/a.mov', 10)
  const s = S.emptyShot('/a.png', { w: 100, h: 100 })
  is('both documents start from the same look', Look.diff(d.look, s.look), {})
}

// ---- marks merged by id, the edit document's rule ----
{
  let s = S.normalize({ marks: [
    { kind: 'redact', id: 'M1', x: 0.1, y: 0.1, w: 0.2, h: 0.05 },
    { kind: 'blur', id: 'M2', x: 0.3, y: 0.4, w: 0.2, h: 0.1 },
  ] }, '/a.png', { w: 1920, h: 1080 })
  // an agent adding a step and sending only that must not drop the redaction
  s = S.mergeShot(s, { marks: [{ kind: 'step', x: 0.5, y: 0.5, n: 1 }] })
  is('a mark not sent stays', s.marks.map(m => m.id), ['M1', 'M2', 'M3'])
  s = S.mergeShot(s, { marks: [{ id: 'M2', strength: 0.8 }] })
  is('a mark sent with an id changes only what it names',
    [s.marks[1].strength, s.marks[1].x, s.marks[1].w], [0.8, 0.3, 0.2])
  s = S.mergeShot(s, { remove: ['M1'] })
  is('and the one way to delete is to name it', s.marks.map(m => m.id), ['M2', 'M3'])
}

// ---- focus, decided on screen because there is no when ----
{
  const prev = [{ kind: 'spotlight', id: 'M1', x: 0.2, y: 0.2, w: 0.4, h: 0.3 }]
  const next = [...prev, { kind: 'lift', x: 0.22, y: 0.22, w: 0.36, h: 0.26 }]
  const out = S.settleFocus(prev, next)
  is('a new lift replaces the spotlight it covers', out.replaced, ['M1'])
  is('leaving just the lift', out.marks.map(m => m.kind), ['lift'])
  is('and it comes back untimed', out.marks.every(m => !('start' in m)), true)

  const apart = S.settleFocus(prev, [...prev, { kind: 'lift', x: 0.7, y: 0.7, w: 0.2, h: 0.2 }])
  is('one somewhere else leaves it alone', apart.replaced, [])
}
{
  const clash = S.focusClashes([
    { kind: 'lift', id: 'M1', x: 0.2, y: 0.2, w: 0.3, h: 0.3 },
    { kind: 'spotlight', id: 'M2', x: 0.3, y: 0.3, w: 0.3, h: 0.3 },
  ])
  is('two that still share screen are reported without a when', clash, [{ a: 'M1', b: 'M2', kinds: ['lift', 'spotlight'] }])
}
{
  // a lift running to the frame's edge is refused here for the reason it is in an edit
  let threw = ''
  try { S.settleFocus([], [{ kind: 'lift', x: 0, y: 0.2, w: 0.5, h: 0.3 }]) } catch (e) { threw = e.message }
  ok('a lift at the frame edge is refused, and says what to do instead', /edge of the frame/.test(threw))
}

// ---- one renderer ----
{
  const s = S.mergeShot(S.emptyShot('/a.png', { w: 2560, h: 1600 }), {
    look: { 'background.kind': 'gradient', 'background.gradient': 'dusk', 'motion.fadeIn': 2 },
    marks: [{ kind: 'lift', x: 0.2, y: 0.2, w: 0.3, h: 0.2 }],
  })
  const spec = S.toRenderSpec(s)
  const doc = FD.toRenderSpec(FD.emptyDoc('/a.mov', 10))
  is('the render spec is the shape an edit\'s is',
    Object.keys(doc).filter(k => !(k in spec)), [])
  is('the whole of it is kept', spec.keep, [[0, S.SPAN]])
  is('the instant to draw rides along', spec.still, { at: S.HOLD, w: 2560, h: 1600 })
  is('no cursor at all, which is not the same as the recorded track', spec.pointer, [])
  is('and no sound to speak of', [spec.audio, spec.clipAudio], [null, null])
  is('the marks reach the compositor with the lent span', spec.marks.map(m => [m.start, m.end]), [[0, S.SPAN]])

  const opts = S.toExportOpts(s)
  const docOpts = FD.toExportOpts(FD.emptyDoc('/a.mov', 10))
  is('the options bag is the shape Plan.prepare already takes',
    Object.keys(docOpts).filter(k => !(k in opts)), [])
  is('the fade is pinned off on the way out', [opts.fadeIn, opts.fadeOut], [0, 0])
  is('the background carries', opts.backdrop, FD.toExportOpts(FD.mergeDoc(FD.emptyDoc('/a.mov', 10),
    { look: { 'background.kind': 'gradient', 'background.gradient': 'dusk' } })).backdrop)
  is('an extra wins, as it does for an edit', S.toExportOpts(s, { scale: 720 }).scale, 720)
  is('the meta is the one Plan.prepare would have read off a take', S.toMeta(s), { width: 2560, height: 1600, duration: S.SPAN })
}

// ---- a take of one frame, and back ----
{
  const doc = FD.mergeDoc(FD.emptyDoc('/a.mov', 20), {
    look: { 'background.kind': 'image', 'device.kind': 'window', 'motion.fadeIn': 1 },
    crop: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 },
    marks: [
      { kind: 'lift', start: 2, end: 8, x: 0.2, y: 0.2, w: 0.3, h: 0.2 },
      { kind: 'redact', start: 12, end: 16, x: 0.5, y: 0.5, w: 0.2, h: 0.1 },
    ],
  })
  const s = S.fromTake(doc, { src: '/a.png', w: 1920, h: 1080, at: 5 })
  is('a shot off a recording keeps the look', Look.diff(doc.look, s.look), {})
  is('and the crop', s.crop, { x: 0.1, y: 0.1, w: 0.8, h: 0.8 })
  is('and only the marks alive at that moment', s.marks.map(m => m.kind), ['lift'])
  is('with their times gone', 'start' in s.marks[0], false)

  const patch = S.toTake(s, 3, 9)
  is('back the other way the marks get a stretch to play over',
    patch.marks.map(m => [m.kind, m.start, m.end]), [['lift', 3, 9]])
  is('and the look goes unpinned, because the recording still means its fade', patch.look.motion.fadeIn, 1)
  const again = FD.mergeDoc(FD.emptyDoc('/b.mov', 30), patch)
  is('an edit takes the patch as it stands', [again.look.device.kind, again.marks.length, again.crop.w],
    ['window', 1, 0.8])
}

// ---- repair ----
{
  is('nonsense opens as an empty shot', S.normalize(null, '/a.png', { w: 10, h: 10 }).kind, 'shot')
  const s = S.normalize({ kind: 'shot', crop: { x: 'no' }, cropAR: 'banana', marks: 'nope', nextId: { M: -4 } },
    '/a.png', { w: 10, h: 10 })
  is('a corrupt field costs that field, not the capture', [s.crop, s.cropAR, s.marks, s.nextId.M], [null, 'free', [], 1])
}
{
  // frame.chrome clean crops to the page once, the same rule an edit gets
  const s = S.normalize({ kind: 'shot', viewport: { x: 0, y: 0.1, w: 1, h: 0.9 },
    look: { frame: { chrome: 'clean' } } }, '/a.png', { w: 1920, h: 1080 })
  is('the page\'s place crops the chrome off once', s.crop, { x: 0, y: 0.1, w: 1, h: 0.9 })
  const back = S.mergeShot(s, { look: { 'frame.chrome': 'keep' } })
  is('and switching back takes the crop away again', back.crop, null)
}

// A v1 look bag, the shape an old recording saved, lands on a shot without a migration
// of its own: Look.resolve reads both.
{
  const s = S.mergeShot(S.emptyShot('/a.png', { w: 10, h: 10 }), { backdrop: 'mint', outAspect: '1:1' })
  is('a v1 look field is routed, not refused', [s.look.background.kind, s.look.background.gradient, s.look.frame.aspect],
    ['gradient', 'mint', '1:1'])
}

// A still of a device keeps the glass corner too, both when made and when opened
{
  const vp = { x: 0.1, y: 0.1, w: 0.5, h: 0.5, corner: 0.2 }
  is('a shot opened keeps the glass corner', S.normalize({ src: '/a.png', w: 10, h: 10, viewport: vp }).viewport.corner, 0.2)
  is('a shot made from a take keeps it', S.fromTake({ viewport: vp }, { src: '/a.png', w: 10, h: 10 }).viewport.corner, 0.2)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
