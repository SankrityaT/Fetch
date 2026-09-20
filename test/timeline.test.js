// Time in an edit (ui/timeline.js): kept ranges, the output clock and the way back.
const T = require('../ui/timeline')

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
