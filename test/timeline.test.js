// Time in an edit (ui/timeline.js): kept ranges, the output clock, the speed each
// surviving piece runs at, and the way back. The document's own face on that clock
// (ui/fetchdoc.js, clips[].rate) and the filters it becomes (processor.js) are here
// too, because all three have to say the same thing about one second of a take.
const T = require('../ui/timeline')
const FD = require('../ui/fetchdoc')
const proc = require('../processor')

let pass = 0, fail = 0
const is = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}` +
    (ok ? '' : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`))
}
const r3 = n => Math.round(n * 1000) / 1000

console.log('kept ranges')
is('no cuts keeps the trim', T.keepRanges([], 1, 9), [[1, 9]])
is('a cut splits it', T.keepRanges([[3, 4]], 0, 10), [[0, 3], [4, 10]])
is('overlapping cuts merge', T.keepRanges([[3, 5], [4, 6]], 0, 10), [[0, 3], [6, 10]])
is('a cut past the trim is clipped', T.keepRanges([[8, 20]], 0, 10), [[0, 8]])
is('a sliver under 50 ms between cuts is dropped', T.keepRanges([[2, 4], [4.03, 6]], 0, 10), [[0, 2], [6, 10]])
is('a cut under 20 ms is ignored', T.keepRanges([[5, 5.01]], 0, 10), [[0, 10]])

console.log('the output clock')
{
  const clock = T.outClock([[3, 5]], 1, 9)
  is('trim start is output zero', clock(1), 0)
  is('before a cut runs straight', clock(2.5), 1.5)
  is('inside a cut lands where it closed', clock(4), 2)
  is('after a cut the cut is taken out', clock(6), 3)
  is('kept says whether a moment survives', [clock.kept(4), clock.kept(6)], [false, true])
  // the round trip, on every kept moment
  const keep = clock.keep
  const bad = []
  for (let t = 1; t <= 9; t += 0.137) if (clock.kept(t) && Math.abs(T.srcTime(keep, clock(t)) - t) > 1e-9) bad.push(r3(t))
  is('srcTime(clock(t)) is t on kept ranges', bad, [])
  is('past the end holds the last moment', T.srcTime(keep, 100), 9)
  is('the output is as long as what is kept', T.outLength(keep), 6)
}

console.log('speed')
{
  // A document that never asked for speed is the document it was: bare pairs, and
  // every number the same as before. This is the whole compatibility claim.
  is('no rates, no third element', T.outClock([[3, 5]], 1, 9, null).keep, [[1, 3], [5, 9]])
  is('rate 1 is written as nothing', T.applyRates([[0, 10]], [[0, 10, 1, 1]]), [[0, 10]])

  // held at a rate
  const fast = T.outClock([], 0, 20, [[0, 20, 4, 4]])
  is('a 4x take is a quarter as long', T.outLength(fast.keep), 5)
  is('and lands four source seconds an output second', [fast(4), fast(20)], [1, 5])
  is('back again', [T.srcTime(fast.keep, 1), T.srcTime(fast.keep, 5)], [4, 20])
  const slow = T.outClock([], 0, 4, [[0, 4, 0.5, 0.5]])
  is('half speed is twice as long', T.outLength(slow.keep), 8)

  // a ramp: the mean rate is what its length is made of, and the inverse is exact
  const ramp = T.outClock([], 0, 10, [[0, 10, 1, 4]])
  is('a 1x to 4x ramp runs at its mean', r3(T.outLength(ramp.keep)), 4)
  is('it starts at 1 and ends at 4', [r3(T.rateAt(ramp.keep, 0)), r3(T.rateAt(ramp.keep, 4))], [1, 4])
  is('and the rate is linear in output seconds', r3(T.rateAt(ramp.keep, 2)), 2.5)

  // the round trip, which is the rule the whole clock exists to keep, across a cut,
  // a slow piece, a held fast piece and a ramp all in one document
  const mixed = T.outClock([[6, 9]], 0, 24,
    [[0, 6, 0.5, 0.5], [9, 15, 1, 1], [15, 20, 4, 4], [20, 24, 1, 6]])
  const bad = []
  for (let t = 0; t <= 24; t += 0.0137) {
    if (mixed.kept(t) && Math.abs(T.srcTime(mixed.keep, mixed(t)) - t) > 1e-9) bad.push(r3(t))
  }
  is('srcTime(clock(t)) is t through every rate', bad, [])
  const bad2 = []
  const span = T.outLength(mixed.keep)
  for (let u = 0; u <= span; u += 0.0071) {
    const back = mixed(T.srcTime(mixed.keep, u))
    if (Math.abs(back - u) > 1e-9) bad2.push(r3(u))
  }
  is('and clock(srcTime(u)) is u the other way', bad2, [])
  is('the output is as long as the pieces say',
    r3(span), r3(12 + 6 + 5 / 4 + 2 * 4 / 7))
  is('and a rate change inside one kept range splits it',
    mixed.keep.map(k => [k[0], k[1]]), [[0, 6], [9, 15], [15, 20], [20, 24]])

  // two clips meeting with no gap: no cut at all, and the second clip's speed still
  // has to survive, which is the case a whole-range rate would quietly lose
  const abut = T.outClock([], 0, 12, [[0, 6, 1, 1], [6, 12, 4, 4]])
  is('abutting clips at different speeds are two ranges', abut.keep, [[0, 6], [6, 12, 4]])
  is('and the second one is a quarter as long', T.outLength(abut.keep), 7.5)

  // a cut landing inside a ramp: the piece that survives is still a ramp, and it is
  // the same map restricted, not a fresh one from the same two end rates
  const whole = T.outClock([], 0, 10, [[0, 10, 1, 4]])
  const half = T.outClock([[0, 5]], 0, 10, [[0, 10, 1, 4]])
  is('a sliced ramp keeps the rates it really had',
    [r3(half.keep[0][2]), r3(half.keep[0][3])], [r3(whole.rate(5)), 4])
  is('and the piece is as long as it was inside the whole',
    r3(T.outLength(half.keep)), r3(whole(10) - whole(5)))

  // sample and hold through speed: an output frame still holds the last source frame
  // at or before its own moment, which is what keeps a still screen still
  const frames = Array.from({ length: 241 }, (_, i) => i / 24)
  const k4 = T.outClock([], 0, 10, [[0, 10, 4, 4]]).keep
  is('a 4x section steps four source frames an output frame at 24 fps',
    [0, 1, 2, 3].map(n => r3(T.frameAt(k4, 24, n, frames))), [0, r3(4 / 24), r3(8 / 24), r3(12 / 24)])
  is('and never invents a frame the take does not have',
    [0, 7, 23, 60].every(n => frames.includes(T.frameAt(k4, 24, n, frames))), true)

  // a rate is clamped by the document, not here, but nonsense must not make NaN
  is('a zero rate is read as no rate', T.outLength(T.applyRates([[0, 4]], [[0, 4, 0, 0]])), 4)
}

console.log('frames')
{
  is('60 fps for a 60 fps take, 30 below 45', [T.outFps({ fps: 59.94 }), T.outFps({ fps: 30 }), T.outFps({})], [60, 30, 30])
  // A ScreenCaptureKit take has no one rate: it writes a frame when the screen changes,
  // so the average ffmpeg reports is the refresh less every still passage. The rate is
  // read off the take's own frame times instead (see .context/survey/m5-timing.md).
  const pts = (n, step, holes = []) => {
    const out = []
    for (let i = 0, t = 0; i < n; i++, t += step) if (!holes.some(([a, b]) => i >= a && i < b)) out.push(+t.toFixed(6))
    return out
  }
  is('a clean 60 fps take reads 60', Math.round(T.takeFps(pts(200, 1 / 60))), 60)
  is('a clean 30 fps take reads 30', Math.round(T.takeFps(pts(200, 1 / 30))), 30)
  // 3 s of 60 Hz screen and two long stills: the average is 26, the cadence is 60
  const still = pts(600, 1 / 60, [[100, 340], [400, 520]])
  is('a 60 Hz take that stands still for half of it still reads 60', Math.round(T.takeFps(still)), 60)
  is('...where its own average would say 30',
    T.outFps({ fps: (still.length - 1) / (still[still.length - 1] - still[0]) }), 30)
  is('...and the cadence takes it to 60', T.outFps({ fps: 26, cadence: 60 }), 60)
  // and it cannot be talked up: a take that really does deliver every other frame is 30
  is('a take that delivers every other 60 Hz frame reads 30',
    Math.round(T.takeFps(pts(400, 1 / 60).filter((_, i) => i % 2 === 0 || i % 17 === 0))), 30)
  is('too few frames to say is no answer at all', [T.takeFps([]), T.takeFps(pts(10, 1 / 60))], [0, 0])
  // a native take writes a frame only when the screen changes: sample and hold
  const frames = [0, 0.5, 0.52, 2.0, 2.4]
  const keep = [[0, 3]]
  is('output frames hold the last source frame', [0, 15, 16, 59, 60, 72].map(n => T.frameAt(keep, 30, n, frames)), [0, 0.5, 0.52, 0.52, 2, 2.4])
  is('across a cut the frame comes from after it', T.frameAt([[0, 1], [2, 3]], 30, 45, frames), 2.4)
}

console.log('speed, from the document to the graph')
{
  const doc = FD.normalize({ v: 2, src: '/x.mov', dur: 24, clips: [
    { id: 'C1', start: 0, end: 8 },
    { id: 'C2', start: 9, end: 17, rate: 4 },
    { id: 'C3', start: 17, end: 24, rate: [1, 3] },
  ] }, '/x.mov', 24)
  is('the finished video is as long as the clips at their own speeds',
    r3(FD.outDuration(doc)), r3(8 + 2 + 7 * 2 / 4))
  const opts = FD.toExportOpts(doc)
  is('the cuts are the gaps and the rates come beside them',
    [opts.cuts, opts.rates], [[[8, 9]], [[9, 17, 4, 4], [17, 24, 1, 3]]])
  is('and the sound of a sped-up piece is muted unless asked otherwise', opts.speedAudio, 'mute')

  // a document that never asked for speed carries none, which is the whole
  // compatibility promise
  const plain = FD.normalize({ v: 2, src: '/x.mov', dur: 10, clips: [{ id: 'C1', start: 0, end: 4 }, { id: 'C2', start: 6, end: 10 }] }, '/x.mov', 10)
  is('no rate, no rates', FD.toExportOpts(plain).rates, null)
  is('and a rate of 1 is not a rate', FD.normalize({ v: 2, src: '/x.mov', dur: 4, clips: [{ id: 'C1', start: 0, end: 4, rate: 1 }] }, '/x.mov', 4).clips[0], { id: 'C1', start: 0, end: 4 })
  is('a rate out of range is pulled back into it',
    [FD.cleanRate(500), FD.cleanRate(0.001), FD.cleanRate('nonsense')], [[20, 20], [0.1, 0.1], null])

  // the filters, which is where the clock stops being arithmetic
  is('a piece at its own rate is the plain reset it always was', proc.ratePts([0, 8]), 'setpts=PTS-STARTPTS')
  is('a held rate is one division', proc.ratePts([0, 8, 2, 2]), 'setpts=(PTS-STARTPTS)/2.000000')
  is('a ramp is the quadratic inverse, read off the range it belongs to',
    /^setpts='\(sqrt\(.+\*\(T-STARTT\)\).+\/TB'$/.test(proc.ratePts([0, 8, 1, 4])), true)
  is('atempo is chained past double and half',
    [proc.atempoChain(4), proc.atempoChain(0.25), proc.atempoChain(1)],
    [['atempo=2', 'atempo=2'], ['atempo=0.5', 'atempo=0.5'], []])
  // every piece is pinned to its own output length rather than trusted to come out
  // right, so what atempo's resampling loses is one piece's rounding and never a
  // drift that grows to the end of the video
  is('a sped-up piece is pinned to exactly the picture it goes with',
    proc.rateAudio([0, 8, 4, 4]).filter(f => /^(apad|atrim)/.test(f)), ['apad=whole_dur=2', 'atrim=end=2'])
  is('and it is muted by default', proc.rateAudio([0, 8, 4, 4], { mute: true }).slice(-1), ['volume=0'])
  const ak = proc.audioKeep([[0, 8], [8, 16, 1, 4], [16, 24, 2]], 'mute')
  is('a ramp is cut into pieces one atempo can cover', ak.length > 3, true)
  is('the sound is as long as the picture to the microsecond',
    r3(ak.reduce((n, { seg }) => n + T.outSpan(seg), 0)),
    r3(T.outLength([[0, 8], [8, 16, 1, 4], [16, 24, 2]])))
  is('a piece at 1 is neither retimed nor muted', [ak[0].mute, proc.rateAudio(ak[0].seg)], [false, []])
  is('a slow piece keeps its sound', proc.audioKeep([[0, 8, 0.5, 0.5]], 'mute')[0].mute, false)
  is('and keep means keep', proc.audioKeep([[0, 8, 4, 4]], 'keep')[0].mute, false)
}

console.log('the camera take')
{
  const cam = { camStartedAt: 1000, screenStartedAt: 1500, gaps: [[4000, 6000]] }
  is('the camera started first, so it runs ahead by the skew', T.camTime(cam, 1), 1.5)
  is('a pause the screen left out is skipped on the camera', T.camTime(cam, 4), 6.5)
  is('a camera that started late has nothing yet', T.camTime({ camStartedAt: 3000, screenStartedAt: 1000 }, 1), null)
  is('no camera, no time', T.camTime(null, 1), null)
}

console.log(`\n  ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
