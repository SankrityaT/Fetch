// Auto level's measurement (ui/compositor/levels.js): the two numbers the treatment
// stretches every frame of a take between, and the ways reading a take can go wrong.
//
// ffmpeg is stood in for here, so this needs no fixture and no codec: a small
// executable writes the grey bytes the real one would write, and as much to stderr as a
// take with decode trouble writes. That is the case this is really for. A child whose
// stderr nobody reads stops at the pipe's 64 KB, never closes, and the promise never
// settles, which is an export and an editor stage that wait for ever.
const fs = require('fs')
const os = require('os')
const path = require('path')
const proc = require('../processor')
const Levels = require('../ui/compositor/levels')

let pass = 0, fail = 0
const is = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}` +
    (ok ? '' : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`))
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-levels-'))
const real = proc.FFMPEG

// A stand-in for ffmpeg. `noise` lines of stderr first, written synchronously so the
// pipe blocks it exactly as the real one blocks; then `pixels`, a byte value repeated,
// on stdout; then it waits while `hang` says to, which is the take that never ends.
function fake({ noise = 0, pixels = [], hang = 0 } = {}) {
  const file = path.join(dir, `ffmpeg-${noise}-${pixels.join('_')}-${hang}`)
  fs.writeFileSync(file, `#!/usr/bin/env node
const fs = require('fs')
fs.writeFileSync(${JSON.stringify(file + '.args')}, JSON.stringify(process.argv.slice(2)))
for (let i = 0; i < ${noise}; i++) fs.writeSync(2, '[h264 @ 0x0] error concealing 500 DC, 500 AC, 500 MV errors in I frame ' + i + '\\n')
for (const [v, n] of ${JSON.stringify(pixels)}) fs.writeSync(1, Buffer.alloc(n, v))
if (${hang}) setTimeout(() => {}, ${hang})
`)
  fs.chmodSync(file, 0o755)
  proc.FFMPEG = file
  return file
}
const argsOf = file => JSON.parse(fs.readFileSync(file + '.args', 'utf8'))

// Every case gets a bound of its own, well under measure's own 20 s guard: a case that
// hangs is the bug this file exists for, and it has to fail rather than sit there.
const within = (ms, p) => Promise.race([p, new Promise(r => setTimeout(() => r('never settled'), ms))])

async function main() {
  console.log('auto level, measured once per take')
  {
    // 4000 lines is about 280 KB, four times over what a pipe holds unread
    const f = fake({ noise: 4000, pixels: [[40, 4608], [200, 4608]] })
    const t0 = Date.now()
    const r = await within(8000, Levels.measure('take.mov', {}))
    is('a take ffmpeg has plenty to say about still settles', r, { lo: 40 / 255, hi: 200 / 255 })
    is('and settles on its own, not on the guard', Date.now() - t0 < 8000, true)
    is('keyframes only, at 64x36 grey', argsOf(f).join(' ').includes('-skip_frame nokey -i take.mov -vf scale=64:36:flags=bilinear,format=gray'), true)
  }
  {
    // the crop the export will use, rounded as plan.prepare rounds it: 1920 x 1080 with
    // a crop of 0.3 across and 0.55 down gives 576x594 at 574,594
    const f = fake({ pixels: [[128, 9216]] })
    await within(8000, Levels.measure('take.mov', { crop: { x: 0.299, y: 0.55, w: 0.3, h: 0.55 }, width: 1920, height: 1080 }))
    const a = argsOf(f)
    is('the crop is the one the export will draw', a[a.indexOf('-vf') + 1].split(',')[0], 'crop=576:594:574:486')
  }
  {
    // the cap on the black and white points used to be taken before this check, which
    // put every take at least 106 apart and left the flat one nothing to refuse with
    fake({ pixels: [[128, 9216]] })
    is('a flat take has nothing worth stretching', await within(8000, Levels.measure('take.mov', {})), null)
  }
  {
    fake({ pixels: [[2, 4608], [253, 4608]] })
    is('a take that already fills the range is left alone', await within(8000, Levels.measure('take.mov', {})), null)
  }
  {
    fake({ pixels: [[40, 512]] })
    is('one small frame is not a take', await within(8000, Levels.measure('take.mov', {})), null)
  }
  {
    // the black point never lifts past a quarter and the white point never falls below
    // two thirds, or an evenly exposed take comes back looking like another recording
    fake({ pixels: [[90, 4608], [160, 4608]] })
    is('a narrow take is held to a quarter and two thirds', await within(8000, Levels.measure('take.mov', {})), { lo: 64 / 255, hi: 170 / 255 })
  }
  {
    fake({ pixels: [[40, 4608], [200, 4608]], hang: 30000 })
    // The stand-in is a node script, and on a loaded Mac (load 14, npm test running the
    // suites one after another) starting node alone took longer than the 400 ms this gave
    // it, so it was given up on before it wrote a pixel and the suite failed one check in
    // four runs. 2 s is still a fifteenth of the take's 30 s hang.
    const t0 = Date.now()
    const r = await within(8000, Levels.measure('take.mov', { timeout: 2000 }))
    is('a take that never ends is given up on', r, { lo: 40 / 255, hi: 200 / 255 })
    is('and gives up when it said it would', Date.now() - t0 < 5000, true)
  }
  {
    proc.FFMPEG = path.join(dir, 'no-ffmpeg-here')
    is('no ffmpeg at all draws without levels', await within(8000, Levels.measure('take.mov', {})), null)
  }
  proc.FFMPEG = real
  fs.rmSync(dir, { recursive: true, force: true })
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}
main()
