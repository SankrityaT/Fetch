// The compositor's GL tests. Electron, so behind a flag and outside npm test:
//
//   bash test/gl/fixtures.sh
//   FETCH_GL_TESTS=1 npx electron test/gl/harness.js [--update] [--only=name]
//
// What it checks, against test/gl/fixtures.sh's takes:
//   golden     one frame per pass against test/gl/golden/*.png: the frame and its
//              grounds, what is drawn on the take, the text, each treatment effect on
//              its own, the grade held to the recording while Fetch's own furniture sits
//              outside it, the whole stack together, and one frame per built-in look
//   presets    every field a built-in look declares moves a pixel: the same frame with
//              that one field back at its default has to differ
//   parity     the editor's path (a <video>) and the export's (ffmpeg NV12) draw the
//              same frame before encode, treatment stack and all: 1 LSB everywhere but
//              auto level, the one field with a gain on it, which reaches 3 at its
//              steepest with a contrast over the top
//   stateless  a frame drawn again after others is identical: no frame depends on
//              another, grain and aberration included, and a moving sequence drawn in
//              a shuffled order is the same pixels as the sequence drawn in order
//   hold       an exported file's frames are the source frames the plan picks
//              (sample and hold across a cut, on a variable-rate take off the 60 fps grid)
//   cuts       what a transition does where two pieces meet, and how a take arrives:
//              a dissolve at a dead air cut against the hard cut it is supposed to be
//              invisible beside, and the dip, the push, the dissolve and the reveal
//              frame by frame off the GPU, each landing on the frame the timeline names
//   loop       a clip that autoplays and repeats forever: what the plan says about the
//              hand-over from the last frame to the first, measured against the pixels,
//              and the frame index wrapping so a looping preview draws the file's frames
//   keys       the keys as they were pressed: what is drawn for a chord, a run of typing
//              and a run Fetch cannot vouch for, where the strip sits, and how long a
//              key stays up
//   blur       the shutter is the travel: a moving frame smears, a held one is byte for
//              byte the frame it was at any shutter angle
//   sheet      the contact sheet an agent sees motion in: every cell is the frame
//              preview_frame draws at the output time burned into it, the cells move,
//              and a cut out of the middle is nowhere on the sheet
//   shots      a screenshot, which is a take of one frame: a styled still against its
//              golden, the same plan at 1x, 2x and 3x, the gold keyline and the
//              capture's own text at each of them, a redaction that still destroys at
//              3x, and the file that comes out
//   type       the type a finished picture carries: a headline, a subhead, a caption
//              under the image, a label pinned in the picture and a callout that points
//              at one, each against its golden, and the rule under all of them, that the
//              type stands clear of the product and the picture gives up exactly the
//              room the type took
//   chrome     the frame round a capture that already has one: a capture with its own
//              chrome framed, the same one with that chrome cropped off, and a drawn
//              bar with an address in it and one with nothing to put there
//   group      more than one capture in one picture: two devices, three, and a group
//              where one capture has forty times the pixels of the other, each at its
//              real size in millimetres, on one line, under one light, under one grade,
//              on one ground that wears its tooth once
//   sinks      each encoder (WebCodecs, VideoToolbox through ffmpeg, x264) keeps the
//              bars' colours, and the canvas encoder one frame per slot
//   audio      the sound (cuts, fades, an added track, a music bed) is as long as the
//              picture; a trimmed .mov
//   cancel     a cancelled export stops, the next one still draws, and a take the
//              compositor cannot read falls back to the classic renderer
//   classic    the compositor's export against the classic ffmpeg export of the same
//              edit, SSIM
// Windows are hidden and never focused. Exits 1 on any failure.
const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')
const fs = require('fs')
const { spawnSync } = require('child_process')

const args = process.argv.slice(2)
const update = args.includes('--update')
const only = (args.find(a => a.startsWith('--only=')) || '').slice(7)
const FIX = '/tmp/fetch-gl'
const GOLD = path.join(__dirname, 'golden')
const OUT = '/tmp/fetch-gl/out'
// what the run counted, for test/gl/run.js; see the note where it is written
const VERDICT = '/tmp/fetch-gl/verdict.json'

if (process.env.FETCH_GL_TESTS !== '1') {
  console.log('GL tests skipped: set FETCH_GL_TESTS=1 (they start a hidden Electron window)')
  process.exit(0)
}
if (app.dock) app.dock.hide()

let pass = 0, fail = 0
const is = (name, ok, detail) => {
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`)
}
const want = name => !only || only.split(',').includes(name)
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i)
// A fixed shuffle rather than Math.random: a run of frames that fails in one order has
// to fail again the next time it is asked for.
const shuffle = (list, seed = 20250919) => {
  const a = [...list]
  let s = seed >>> 0
  for (let i = a.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0
    const j = s % (i + 1)
    const t = a[i]; a[i] = a[j]; a[j] = t
  }
  return a
}

// Grey frames of a file by index, small, for comparing pictures (every frame decoded
// once: a select expression with a hundred terms is past what ffmpeg's parser takes)
function greyFrames(file, idx, w = 360, h = 225) {
  const r = spawnSync('/opt/homebrew/bin/ffmpeg', ['-v', 'error', '-i', file, '-vf', `scale=${w}:${h}:flags=area,format=gray`,
    '-fps_mode', 'passthrough', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 30 })
  const max = Math.max(...idx)
  if (!r.stdout || r.stdout.length < (max + 1) * w * h) throw new Error('could not read frames of ' + file + ': ' + String(r.stderr || r.error).slice(0, 300))
  return idx.map(i => r.stdout.subarray(i * w * h, (i + 1) * w * h))
}
function psnr(a, b) {
  let se = 0
  for (let k = 0; k < a.length; k++) { const d = a[k] - b[k]; se += d * d }
  const mse = se / a.length
  return mse ? 10 * Math.log10(255 * 255 / mse) : 99
}

// A frame the page wrote, as RGB bytes at full size. The page's own diff compares two
// draws of one frame; a seam is the step between two different frames, so the loop
// group reads the frames back here and measures the steps itself.
function rgbOf(file) {
  const r = spawnSync('/opt/homebrew/bin/ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 30 })
  if (!r.stdout || !r.stdout.length) throw new Error('could not read ' + file + ': ' + String(r.stderr || r.error).slice(0, 300))
  return r.stdout
}
// One step between two frames, in levels: what the eye gets is the mean, what a single
// speck of noise gets is the max, and a seam has to be judged on both.
function step(a, b) {
  if (a.length !== b.length) return { mean: 255, max: 255, sizeChanged: true }
  let sum = 0, max = 0
  for (let k = 0; k < a.length; k++) { const d = Math.abs(a[k] - b[k]); sum += d; if (d > max) max = d }
  return { mean: +(sum / a.length).toFixed(4), max }
}

// ---- stills ----------------------------------------------------------------
// A screenshot is read close and often at 2x or 3x, so the measurements below are about
// the two things a still has that a frame of a clip does not: it exists at more than one
// size, and nothing stands between the drawn frame and the file someone opens.

const lumaAt = (rgb, W, x, y) => { const p = 3 * (y * W + x); return 0.2126 * rgb[p] + 0.7152 * rgb[p + 1] + 0.0722 * rgb[p + 2] }
const median = a => (a.length ? [...a].sort((p, q) => p - q)[a.length >> 1] : 0)

/**
 * How long a light-to-dark step takes, over a box: for every monotone run along a row
 * whose two ends are at least `min` levels apart, how many of its samples sit between a
 * tenth and nine tenths of the way across. That is the rise, and it is about one pixel
 * for anything rasterised at the size it is drawn at, whatever that size is. A picture
 * enlarged into its pixels takes as many as it was enlarged by, and a run rather than a
 * rise would measure the width of a glyph's stroke instead of the sharpness of its edge.
 * Returns the median rise, the median contrast across a step, and how many it found.
 */
function stepRuns(rgb, W, box, min = 40) {
  const rises = [], tall = []
  const x1 = box.x + box.w - 1
  for (let y = box.y; y < box.y + box.h; y++) {
    let x = box.x
    while (x < x1) {
      const dir = Math.sign(lumaAt(rgb, W, x + 1, y) - lumaAt(rgb, W, x, y))
      if (!dir) { x++; continue }
      let e = x
      while (e < x1 && Math.sign(lumaAt(rgb, W, e + 1, y) - lumaAt(rgb, W, e, y)) === dir) e++
      const a = lumaAt(rgb, W, x, y), b = lumaAt(rgb, W, e, y), total = Math.abs(b - a)
      if (total >= min) {
        const lo = Math.min(a, b) + 0.1 * total, hi = Math.min(a, b) + 0.9 * total
        let mid = 0
        for (let q = x; q <= e; q++) { const v = lumaAt(rgb, W, q, y); if (v > lo && v < hi) mid++ }
        rises.push(mid); tall.push(total)
      }
      x = e
    }
  }
  return { rise: median(rises), contrast: +median(tall).toFixed(1), n: rises.length }
}

/**
 * The finest thing inside a box, in pixels: the share of neighbouring pairs along a row
 * that differ at all, read back as the distance between them. A redaction replaces what
 * is under it with cells of one colour, so this is how big those cells are on the
 * delivered picture, and nothing smaller than one survived.
 */
function finest(rgb, W, box) {
  let pairs = 0, moved = 0
  for (let y = box.y; y < box.y + box.h; y++) {
    for (let x = box.x; x < box.x + box.w - 1; x++) {
      pairs++
      if (Math.abs(lumaAt(rgb, W, x + 1, y) - lumaAt(rgb, W, x, y)) > 2) moved++
    }
  }
  return moved ? +(pairs / moved).toFixed(1) : Infinity
}

/**
 * Fetch's own gold, measured as a line: every horizontal run of gold pixels in the
 * frame, and how many part-gold pixels stand at the start of one. A keyline the plan
 * draws 2 px wide is 2k pixels at scale k, and its edge is still about a pixel, because
 * it was drawn at that size rather than enlarged into it.
 */
function goldRuns(rgb, W, H) {
  const gold = p => rgb[p] - rgb[p + 2] > 70 && rgb[p] > 120 && rgb[p + 1] > 80
  const part = p => rgb[p] - rgb[p + 2] > 15 && rgb[p] - rgb[p + 2] <= 70
  const runs = [], edges = []
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W;) {
      if (!gold(3 * (y * W + x))) { x++; continue }
      let e = x
      while (e < W && gold(3 * (y * W + e))) e++
      runs.push(e - x)
      let soft = 0
      while (soft < 8 && x - 1 - soft >= 0 && part(3 * (y * W + x - 1 - soft))) soft++
      edges.push(soft)
      x = e
    }
  }
  return { width: median(runs), rise: median(edges), n: runs.length }
}

// A captured window, the way a screenshot arrives: a light app UI at 3420 by 1780,
// which is a 1710 point window on a 2x display. Flat fields, 2 px hairlines (one point)
// and small text are exactly what a still has to carry close up, and the synthetic take
// the other groups use has none of them. Built here because the stills are this round's
// work and test/gl/fixtures.sh is not this round's file.
const SHOT_SRC = path.join(FIX, 'shot.png')
function shotFixture() {
  if (fs.existsSync(SHOT_SRC)) return SHOT_SRC
  const W = 3420, H = 1780, ROW = 140, TOP = 160
  const box = (x, y, w, h, c) => `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=${c}:t=fill`
  const text = (t, x, y, px, c) => `drawtext=text='${t}':x=${x}:y=${y}:fontsize=${px}:fontcolor=${c}`
  const f = [
    box(0, 0, 520, H, '0xF2EFEA'), box(520, 0, 2, H, '0xDDD6CD'),
    box(522, 0, W, 120, '0xFFFFFF'), box(522, 118, W, 2, '0xDDD6CD'),
    text('Library', 60, 48, 42, '0x2A2520'), text('312 songs', 60, 140, 30, '0x8E857C'),
    text('Title', 600, 44, 30, '0x8E857C'), text('Tempo', 2280, 44, 30, '0x8E857C'), text('Key', 2760, 44, 30, '0x8E857C'),
  ]
  const rows = ['Nocturne in E flat', 'Prelude no 4', 'Etude in C sharp', 'Gymnopedie no 1', 'Arabesque no 1',
    'Reverie', 'Clair de lune', 'Valse in A minor', 'Mazurka no 3', 'Berceuse']
  for (let i = 0; i < rows.length; i++) {
    const y = TOP + i * ROW
    f.push(box(522, y + ROW - 2, W, 2, '0xE6E0D8'))
    f.push(text(rows[i], 600, y + 48, 34, '0x2A2520'))
    f.push(text(`${96 + i * 7} BPM`, 2280, y + 48, 34, '0x8E857C'))
    // one row carries an address, because a redaction has to have something to destroy.
    // Plainly not a real one: nothing shaped like a live secret belongs in a fixture.
    f.push(text(i === 1 ? 'ada at example.test' : 'D minor', 2760, y + 48, 34, '0x8E857C'))
  }
  const r = spawnSync('/opt/homebrew/bin/ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=0xFBFAF8:s=${W}x${H}`, '-vf', f.join(','), '-frames:v', '1', SHOT_SRC])
  if (!fs.existsSync(SHOT_SRC)) throw new Error('could not draw the shot fixture: ' + String(r.stderr || r.error).slice(0, 300))
  return SHOT_SRC
}

// The same capture with the chrome a window capture actually brings with it: a title bar
// above the page, three buttons in a flat grey and the window's own name centred on it.
// Generic by construction, the way every device Fetch draws is. The buttons are square
// and uncoloured: nothing here is traced from anybody's desktop, and a fixture that was
// would put trade dress into a golden.
const CHROME_SRC = path.join(FIX, 'shot-chrome.png')
const CHROME_BAR = 96
function chromeFixture() {
  if (fs.existsSync(CHROME_SRC)) return CHROME_SRC
  const page = shotFixture()
  const B = CHROME_BAR
  const f = [`pad=iw:ih+${B}:0:${B}:color=0xEDE8E1`,
    `drawbox=x=0:y=${B - 2}:w=iw:h=2:color=0xD8D1C7:t=fill`]
  for (let i = 0; i < 3; i++) {
    f.push(`drawbox=x=${40 + i * 44}:y=${Math.round(B / 2) - 9}:w=18:h=18:color=0xB6AEA4:t=fill`)
  }
  f.push(`drawtext=text='Songscription Library':x=(w-text_w)/2:y=${Math.round(B / 2) - 17}:fontsize=32:fontcolor=0x6E655C`)
  const r = spawnSync('/opt/homebrew/bin/ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-i', page, '-vf', f.join(','), '-frames:v', '1', CHROME_SRC])
  if (!fs.existsSync(CHROME_SRC)) throw new Error('could not draw the chrome fixture: ' + String(r.stderr || r.error).slice(0, 300))
  return CHROME_SRC
}

// ---- a group ---------------------------------------------------------------
// More than one capture in one picture. The three below are the captures a group is
// actually made of: a wide light window off a 2x desktop, a tall handset at 3x, and a
// 5K desktop beside a capture with a fortieth of its pixels. Built here rather than in
// test/gl/fixtures.sh, which is not this round's file.

// A flat page of rows with hairlines and small text: what a capture is made of, at
// whatever size and density the caller asks for. px is the text size in the capture's
// own pixels, so a 3x handset and a 1x window both come out legible at their own scale.
function pageFixture(file, W, H, o = {}) {
  if (fs.existsSync(file)) return file
  const px = o.px || Math.round(W / 100)
  const ink = o.ink || '0x2A2520', dim = o.dim || '0x8E857C'
  const bg = o.bg || '0xFBFAF8', line = o.line || '0xE6E0D8'
  const top = Math.round(H * (o.top || 0.14)), row = Math.round(H * (o.row || 0.075))
  const left = Math.round(W * (o.left || 0.07)), rail = o.rail ? Math.round(W * o.rail) : 0
  const box = (x, y, w, h, c) => `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=${c}:t=fill`
  const text = (t, x, y, size, c) => `drawtext=text='${t}':x=${x}:y=${y}:fontsize=${size}:fontcolor=${c}`
  const f = []
  if (rail) f.push(box(0, 0, rail, H, '0xF2EFEA'), box(rail, 0, 2, H, '0xDDD6CD'))
  f.push(box(rail, 0, W, Math.round(top * 0.6), '0xFFFFFF'), box(rail, Math.round(top * 0.6) - 2, W, 2, '0xDDD6CD'))
  f.push(text(o.title || 'Library', left, Math.round(top * 0.2), Math.round(px * 1.3), ink))
  const rows = o.rows || ['Nocturne in E flat', 'Prelude no 4', 'Etude in C sharp', 'Gymnopedie no 1',
    'Arabesque no 1', 'Reverie', 'Clair de lune', 'Valse in A minor']
  for (let i = 0; i < rows.length && top + (i + 1) * row < H; i++) {
    const y = top + i * row
    f.push(box(rail, y + row - 2, W, 2, line))
    f.push(text(rows[i], left, y + Math.round(row * 0.3), px, ink))
    f.push(text(`${96 + i * 7} BPM`, Math.round(W * 0.74), y + Math.round(row * 0.3), px, dim))
  }
  const r = spawnSync('/opt/homebrew/bin/ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=${bg}:s=${W}x${H}`, '-vf', f.join(','), '-frames:v', '1', file])
  if (!fs.existsSync(file)) throw new Error('could not draw ' + file + ': ' + String(r.stderr || r.error).slice(0, 300))
  return file
}

// The members of the three groups, each with what is known about how big the real thing
// is. scale is the capture's backing scale, which with the frame the look asks for is
// all Fetch needs to put a handset beside a window at the size a handset really is.
const GROUP_PICS = {
  // 1710 points wide on a 2x display: an ordinary app window on a desk
  desk: { file: path.join(FIX, 'g-desk.png'), w: 3420, h: 1780, scale: 2, device: 'window',
    opts: { px: 34, rail: 0.15, title: 'Library' } },
  // 393 points on a 3x handset, which is about 62 mm of real glass
  hand: { file: path.join(FIX, 'g-hand.png'), w: 1179, h: 2556, scale: 3, device: 'phone',
    opts: { px: 42, top: 0.09, row: 0.062, left: 0.09, title: 'Today' } },
  // a 1280 point browser page on the same desk
  web: { file: path.join(FIX, 'g-web.png'), w: 2560, h: 1600, scale: 2, device: 'browser',
    opts: { px: 28, left: 0.06, title: 'Releases', rows: ['2.0 Shots', '1.9 Loop', '1.8 Keys', '1.7 Grain'] } },
  // a 5K desktop: 2560 points, and eight and a half pixels to the millimetre
  wall: { file: path.join(FIX, 'g-wall.png'), w: 5120, h: 2880, scale: 2, device: 'window',
    opts: { px: 44, rail: 0.14, title: 'Sessions' } },
  // and a capture with a fortieth of its pixels: 800 points at 1x, four and a third
  // pixels to the millimetre, which is the case a group has to survive
  // Its text is drawn at the same real size as the 5K capture's, about five
  // millimetres: 44 px at 8.66 px per mm, 22 px at 4.33. So on the finished frame the
  // two have to land at the same size, whatever their pixel counts say.
  tiny: { file: path.join(FIX, 'g-tiny.png'), w: 800, h: 500, scale: 1, device: 'window',
    opts: { px: 22, top: 0.2, row: 0.15, left: 0.06, title: 'Notes',
      rows: ['Ada', 'Grace', 'Alan', 'Edsger', 'Barbara'] } },
}
const member = (name, extra = {}) => {
  const p = GROUP_PICS[name]
  pageFixture(p.file, p.w, p.h, p.opts)
  return { src: p.file, w: p.w, h: p.h, scale: p.scale, device: p.device, ...extra }
}

// Where a member's shell stands on the finished frame, in the pixels the file was
// written at: the plan's own numbers scaled by how far the plan was scaled.
const extentOf = (r, i) => {
  const e = r.group[i].extent, k = r.W / r.planW
  return { x: Math.round(e.x * k), y: Math.round(e.y * k), w: Math.round(e.w * k), h: Math.round(e.h * k) }
}
const screenOf = (r, i) => {
  const b = r.group[i].rect, k = r.W / r.planW
  return { x: Math.round(b.x * k), y: Math.round(b.y * k), w: Math.round(b.w * k), h: Math.round(b.h * k) }
}
// a box a fraction in from each side of another, so a measurement is of the thing and
// not of its own edge
const inset = (b, f) => ({ x: Math.round(b.x + b.w * f), y: Math.round(b.y + b.h * f),
  w: Math.round(b.w * (1 - 2 * f)), h: Math.round(b.h * (1 - 2 * f)) })
const meanLuma = (rgb, W, b) => {
  let s = 0, n = 0
  for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) { s += lumaAt(rgb, W, x, y); n++ }
  return n ? s / n : 0
}
// How saturated a box is, at most: the largest channel spread of any pixel in it. A
// monochrome grade takes this to nothing; a ground the grade never reached keeps it.
const maxChroma = (rgb, W, b) => {
  let m = 0
  for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) {
    const p = 3 * (y * W + x)
    const d = Math.max(rgb[p], rgb[p + 1], rgb[p + 2]) - Math.min(rgb[p], rgb[p + 1], rgb[p + 2])
    if (d > m) m = d
  }
  return m
}
// The noise on a flat field: the mean absolute step between neighbours along a row. The
// ground's tooth is three levels of it, and a ground that wore it once per member of a
// group would measure two or three times this.
const grit = (rgb, W, b) => {
  let s = 0, n = 0
  for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w - 1; x++) {
    s += Math.abs(lumaAt(rgb, W, x + 1, y) - lumaAt(rgb, W, x, y)); n++
  }
  return n ? +(s / n).toFixed(3) : 0
}
// How far a shadow reaches under an object: walking straight down from the bottom of
// its extent, the first row at which the ground is back within a level of the ground
// well clear of everything. One light means one of these, whatever the object's size.
function shadowReach(rgb, W, H, ext, clear) {
  const x = Math.round(ext.x + ext.w / 2)
  let y = Math.min(H - 2, ext.y + ext.h)
  const dark = lumaAt(rgb, W, x, y)
  if (clear - dark < 1) return 0
  for (; y < H - 1; y++) if (clear - lumaAt(rgb, W, x, y) < 1) break
  return y - (ext.y + ext.h)
}

app.whenReady().then(async () => {
  try {
    if (!fs.existsSync(path.join(FIX, 'take.mov'))) throw new Error('run bash test/gl/fixtures.sh first')
    fs.mkdirSync(OUT, { recursive: true })
    const proc = require('../../processor')
    const Plan = require('../../ui/compositor/plan')
    const host = require('../../ui/render-host')
    const take = path.join(FIX, 'take.mov'), cam = path.join(FIX, 'cam.mov')
    const meta = await proc.probeMeta(take)
    const ffmpeg = proc.FFMPEG

    const page = new BrowserWindow({
      show: false, width: 320, height: 200, focusable: false, skipTaskbar: true, paintWhenInitiallyHidden: true,
      webPreferences: { nodeIntegration: true, nodeIntegrationInWorker: true, contextIsolation: false, sandbox: false, backgroundThrottling: false },
    })
    if (process.env.FETCH_DEBUG_RENDER) page.webContents.on('console-message', (_e, _l, m) => console.log('[page]', m))
    const pageReady = new Promise(r => ipcMain.once('page:ready', r))
    page.loadFile(path.join(__dirname, 'page.html'))
    await pageReady
    const call = (fn, ...a) => page.webContents.executeJavaScript(`${fn}(...${JSON.stringify(a)})`)

    // R3 T5: the keys. plan.js is not this round's file, and the one line it needs is in
    // .context/survey/r3-t5.md; until that lands the page gets it here, off the finished
    // spec, so the goldens draw what the compositor will draw the moment it does. It
    // fills a spec.keys nobody set, so it becomes a no-op rather than a second opinion.
    const mod = p => JSON.stringify(path.join(__dirname, '../..', p))
    await page.webContents.executeJavaScript(`(() => {
      const Plan = require(${mod('ui/compositor/plan')})
      const Marks = require(${mod('ui/compositor/marks')})
      const Timeline = require(${mod('ui/timeline')})
      const prepare = Plan.prepare
      Plan.prepare = (opts, meta, ctx) => {
        const s = prepare(opts, meta, ctx)
        const K = (opts.look && opts.look.keys) || {}
        if (!s.keys && opts.keys) s.keys = Marks.planKeys(opts.keys, {
          W: s.W, H: s.H, box: s.framed ? s.rect : { x: 0, y: 0, w: s.W, h: s.H },
          capBox: s.framed ? s.rect : null, caption: opts.captions ? (opts.captionStyle || {}) : null,
          clock: Timeline.outClock(opts.cuts, s.start, s.end, opts.rates), span: s.span,
          place: K.place || 'left', size: K.size == null ? 1 : K.size, show: K.show !== false })
        return s
      }
    })()`)

    // More than one capture in one picture, drawn by the one renderer. compositor/
    // index.js renderShot fills one slot from one picture; a group fills one per member
    // and draws the same plan through the same compositor, which is the whole of the
    // difference and is written out in .context/survey/s-s6.md for the file that owns it.
    // It lives here because ui/compositor/index.js is not this round's file.
    await page.webContents.executeJavaScript(`(() => {
      const fs = require('fs'), path = require('path')
      const { Compositor, SLOTS } = require(${mod('ui/compositor/gl')})
      const Plan = require(${mod('ui/compositor/plan')})
      const { loadAssets } = require(${mod('ui/compositor/index')})
      const pic = file => new Promise((res, rej) => {
        const i = new Image()
        i.onload = () => res(i); i.onerror = () => rej(new Error('could not read ' + file))
        i.src = 'file://' + file
      })
      let comp = null
      window.group = async (job, file) => {
        const spec = Plan.prepare(job.opts, job.meta, job.ctx || {})
        const k = job.width ? job.width / spec.W : 1
        const W = Math.round(spec.W * k), H = Math.round(spec.H * k)
        if (!comp) comp = new Compositor(W, H, { preserve: true })
        comp.resize(W, H)
        if (spec.bg.kind === 'image') comp.setImage(spec.bg.file, await pic(spec.bg.file))
        await loadAssets(comp, spec)
        // one capture is a take and fills the one slot a take fills; several fill one
        // slot each, which is the whole of what a group asks of the caller
        const list = spec.group || [{ file: job.opts.group.members[0].src, src: spec.src, crop: spec.crop }]
        for (let i = 0; i < list.length; i++) {
          const p = await pic(list[i].file)
          comp.uploadImage(SLOTS[i], p, p.width, p.height)
        }
        const s0 = spec.src, c0 = spec.crop
        const cropUV = spec.group ? null : [c0.x / s0.w, c0.y / s0.h, c0.w / s0.w, c0.h / s0.h]
        const at = job.at == null ? spec.span / 2 : job.at
        const n = Math.max(0, Math.min(spec.frames - 1, Math.round(at * spec.fps)))
        if (!comp.render(spec, Plan.framePlan(spec, n / spec.fps), { n, ...(cropUV ? { cropUV } : {}) })) throw new Error('nothing to draw')
        const px = comp.readRGBA()
        if (file) {
          const cv = document.createElement('canvas'); cv.width = comp.W; cv.height = comp.H
          cv.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(px.buffer, px.byteOffset, comp.W * comp.H * 4), comp.W, comp.H), 0, 0)
          const blob = await new Promise(r => cv.toBlob(r, 'image/png'))
          fs.mkdirSync(path.dirname(file), { recursive: true })
          fs.writeFileSync(file, Buffer.from(await blob.arrayBuffer()))
        }
        return { W: comp.W, H: comp.H, planW: spec.W, planH: spec.H, rect: spec.rect,
          group: (spec.group || []).map(m => ({ mm: m.mm, rect: m.rect, crop: m.crop, src: m.src,
            kind: m.device ? m.device.kind : null, extent: m.device ? m.device.extent : m.rect })) }
      }
    })()`)

    const camera = { file: cam, x: 0.84, y: 0.78, size: 0.2, camStartedAt: 1000, screenStartedAt: 1400, gaps: [] }
    // A keyframed bubble. The first entry is the one an agent writes: a stretch of the
    // take where the face is not the point, said as a size and a corner and nothing
    // else, so everything it leaves out stays where the editor put it. The second is a
    // bare key, which is a state the bubble starts moving to at its own time.
    // Both moves take their length from the zooms' own measures (plan.js camPlan): the
    // span's move is 1.15 s and lands at 4.15 s, the way back is clamped to the 1 s gap
    // and lands exactly on 9 s, and the move into the last key is 1.15 s from there.
    const camKeyed = { ...camera, keys: [
      { start: 3, end: 8, size: 0.1, x: 0.12 },
      { t: 9, size: 0.34, x: 0.5, y: 0.5, shape: 'rounded' },
    ] }
    const look = { treatment: { motionBlur: 0.5 }, frame: { border: 0 }, camera: { shape: 'circle', ring: true }, grain: { dither: false } }
    const base = { ffmpeg, src: take, meta }

    // R3, the loop: a take whose screen never changes is a recording that does come back
    // to where it began, so everything left moving between two of its frames is Fetch's
    // own. 6 s at 30 fps, which is 180 output frames, and the film's clock divides it.
    // The look turns the grain and the dither on, because they are what a loop is said
    // to flash at, and the ground is a gradient so the tooth is on the frame too.
    // motion.reveal is off, and that is the point rather than an aside: on, the take
    // settles out at the end and rises in at the start, and the ordinary steps near the
    // ends are that move rather than the noise, which would let the wrap hide behind it.
    const loopSrc = path.join(FIX, 'still.mov')
    const loopMeta = await proc.probeMeta(loopSrc)
    const loopLook = { treatment: { motionBlur: 0.5 }, frame: { border: 0 }, motion: { reveal: 'none' }, grain: { film: 0.4, dither: true } }
    const loopOpts = { backdrop: 'dusk', inset: 0.08, look: loopLook }
    // the same edit with the switch on, which is the only thing that differs: motion.loop
    // puts the loop's length on the plan and nothing else in the frame moves for it
    const loopLoop = { ...loopOpts, look: { ...loopLook, motion: { ...loopLook.motion, loop: true } } }
    const loopBase = { ffmpeg, src: loopSrc, meta: loopMeta }
    const LOOP_N = 180
    // Someone typing, at about eleven characters a second, each key carrying the
    // character it typed because the capture knew the field was safe to show. The same
    // presses without those characters are what Fetch has when it cannot tell.
    const TYPED = 'fetch the take'.split('').map((c, i) => ({ t: 2.6 + i * 0.09, key: c === ' ' ? 'space' : c, char: c }))
    // A simulator standing in the middle of this 1440 x 900 desktop take: the device M0
    // measured, a 1320 x 2868 screen at scale 3 and so 440 points across, and the
    // rectangle its glass occupies in the recorded frame. The two together are what size
    // the disc, since 44 points is a tenth of that screen's width at any capture scale.
    // The screen's own aspect fixes the height: 0.276 of 1440 is 397 px across, and 397
    // times 956 / 440 is 863, which is 0.959 of 900.
    const SIM = { screen: { w: 1320, h: 2868, scale: 3 }, viewport: { x: 0.362, y: 0.02, w: 0.276, h: 0.959 } }
    const TOUCH = { ...SIM, look: { ...look, cursor: { style: 'touch' } } }
    const cases = {
      'framed-dusk': { opts: { backdrop: 'dusk', inset: 0.08, shadow: 0.6, look }, n: 90 },
      'framed-16x9-crop': { opts: { backdrop: 'ink', inset: 0.06, backdropAspect: 16 / 9, crop: { x: 0.1, y: 0.1, w: 0.7, h: 0.6 }, look }, n: 200 },
      'blur-ground': { opts: { backdrop: 'blur', inset: 0.06, backdropAspect: 16 / 9, look }, n: 300 },
      'plain-9x16': { opts: { backdropAspect: 9 / 16, look }, n: 300 },
      'image': { opts: { backdrop: 'img:bg.jpg', inset: 0.07, look: { ...look, background: { imageBlur: 0.3, imageDim: 0.2 } } }, ctx: { imageFile: path.join(FIX, 'bg.jpg') }, n: 120 },
      'zoom-glide': { opts: { backdrop: 'slate', inset: 0.06, zooms: [{ start: 1, end: 6, scale: 2.2, x: 0.25, y: 0.3 }], look }, n: 36 },
      'zoom-hold': { opts: { backdrop: 'slate', inset: 0.06, zooms: [{ start: 1, end: 6, scale: 2.2, x: 0.25, y: 0.3 }], look }, n: 200 },
      'camera': { opts: { backdrop: 'mint', inset: 0.08, camera, look }, n: 240 },
      'fade': { opts: { backdrop: 'dusk', inset: 0.08, fadeIn: 1, look }, n: 30 },
      'border': { opts: { backdrop: 'violet', inset: 0.1, radius: 28, look: { ...look, frame: { border: 3, borderColor: '#F0A93C' } } }, n: 60 },
      'cut': { opts: { backdrop: 'dusk', inset: 0.08, cuts: [[3, 7]], look }, n: 190 },
      // The cut transitions, each on the boundary the timeline names (this take goes out
      // at 30 fps and the cut removes 3 s to 7 s, so the boundary is output frame 90).
      // A dissolve is two source frames in one output frame, which is why it is in
      // parity as well: both sides have to come down both decode paths and agree.
      'cut-dissolve': { opts: { backdrop: 'dusk', inset: 0.08, cuts: [[3, 7]], look: { ...look, motion: { cutTransition: 'crossfade' } } }, n: 90 },
      'cut-dip': { opts: { backdrop: 'dusk', inset: 0.08, cuts: [[3, 7]], look: { ...look, motion: { cutTransition: 'dip' } } }, n: 89 },
      'cut-push': { opts: { backdrop: 'dusk', inset: 0.08, cuts: [[3, 7]], look: { ...look, motion: { cutTransition: 'zoom' } } }, n: 93 },
      // The take arriving: 0.1 s in, on its way up into its frame
      'reveal': { opts: { backdrop: 'dusk', inset: 0.08, look }, n: 3 },
      // And the camera bubble riding it. The bubble is a thing lying on the take, so it
      // arrives with it and goes with it: drawn in its landed place it sat at full size
      // and full opacity over a take that had not arrived, and a dip left it lit over
      // bare ground on the one frame the take is not on screen (output frame 90 here).
      'camera-reveal': { opts: { backdrop: 'mint', inset: 0.08, camera, look }, n: 3 },
      'camera-dip': { opts: { backdrop: 'mint', inset: 0.08, camera, cuts: [[3, 7]], look: { ...look, motion: { cutTransition: 'dip' } } }, n: 90 },
      // R6: the bubble keyframed. Three frames, because the three things that can be
      // wrong are different: where a key puts it, where the ease puts it between two
      // keys, and what a shape change looks like while it is happening.
      //
      // At a key (output frame 150, 5 s): the span is in and the move into it landed at
      // 4.15 s, so the bubble is small and over on the left, at rest. A bubble that
      // ignored its keys draws the large one in the right corner here.
      'camera-key': { opts: { backdrop: 'mint', inset: 0.08, camera: camKeyed, look }, n: 150 },
      // Between keys (frame 105, 3.5 s): 0.435 of the way through the move that started
      // at 3 s, so the bubble is in flight and part way down in size, on the same ease
      // the zooms use. Drawn without an ease it would be 0.435 of the way along a
      // straight line instead, which is a different picture.
      'camera-tween': { opts: { backdrop: 'mint', inset: 0.08, camera: camKeyed, look }, n: 105 },
      // At a shape change (frame 285, 9.5 s): 0.435 through the move into the last key,
      // which turns the circle into the rounded square while it grows and crosses the
      // frame. The corner is a share of the diameter, so this is a morph rather than a
      // switch: the golden is a squircle, neither of the two shapes the look names.
      'camera-shape': { opts: { backdrop: 'mint', inset: 0.08, camera: camKeyed, look }, n: 285 },
      // M3: what is drawn on the take and over the frame (this take goes out at 30 fps,
      // so frame n is n / 30 seconds in)
      'marks': { opts: { backdrop: 'ink', inset: 0.06, look, marks: [
        { kind: 'redact', start: 0, end: 12, x: 0.05, y: 0.06, w: 0.25, h: 0.14 },
        { kind: 'blur', start: 0, end: 12, x: 0.55, y: 0.7, w: 0.3, h: 0.2, strength: 20 },
        { kind: 'spotlight', start: 1, end: 11, x: 0.35, y: 0.3, w: 0.3, h: 0.3 },
        { kind: 'step', start: 1, end: 11, x: 0.35, y: 0.3 }] }, n: 150 },
      'lift': { opts: { backdrop: 'slate', inset: 0.06, look, zooms: [{ start: 1, end: 11, scale: 1.8, x: 0.5, y: 0.5 }],
        marks: [{ kind: 'lift', start: 2, end: 10, x: 0.35, y: 0.35, w: 0.3, h: 0.3 }, { kind: 'step', start: 3, end: 10, x: 0.35, y: 0.35 }] }, n: 180 },
      // M5: a thing leaving, which every other case only ever catches arriving. Four
      // badges that arrived a beat apart and share an end at 9 s: they clear in arrival
      // order, 1/15 s apart, so at output frame 262 (8.733 s, this take goes out at 30)
      // the group is a gradient rather than a light switch. The first is most of the way
      // out, the second part way, the last two still up, and each carries the scale its
      // own alpha goes with. A group that blinked would draw four full badges here, or
      // none.
      'leave': { opts: { backdrop: 'ink', inset: 0.06, look, marks: [
        { kind: 'step', start: 2, end: 9, x: 0.2, y: 0.32 },
        { kind: 'step', start: 3, end: 9, x: 0.4, y: 0.32 },
        { kind: 'step', start: 4, end: 9, x: 0.6, y: 0.32 },
        { kind: 'step', start: 5, end: 9, x: 0.8, y: 0.32 }] }, n: 262 },
      'pointer': { opts: { backdrop: 'dusk', inset: 0.06, look, pointer: [{ t: 0.5, x: 0.2, y: 0.3 }, { t: 3, x: 0.6, y: 0.5, click: true }, { t: 6, x: 0.4, y: 0.7 }] }, n: 92 },
      'text': { opts: { backdrop: 'dusk', inset: 0.06, look, captions: true, captionStyle: {},
        cues: [{ start: 3, end: 6, text: 'Every row shows the key and the tempo.' }],
        texts: [{ text: 'Fetch', subtitle: 'A test card', start: 0, end: 2, style: 'title' },
          { text: 'Library', subtitle: 'Three hundred songs', start: 7, end: 11, style: 'lower-third' },
          { text: 'New', start: 7, end: 11, fx: 0.7, fy: 0.3, style: 'label', box: true }] },
        ctx: { prepared: { captions: { cues: [], busy: [], words: { words: [{ w: 'Every', t: 3 }, { w: 'row', t: 3.3 }, { w: 'shows', t: 3.6 }, { w: 'the', t: 4 },
          { w: 'key', t: 4.2 }, { w: 'and', t: 4.6 }, { w: 'the', t: 4.8 }, { w: 'tempo.', t: 5 }] } } } }, n: 128 },
      // M5: a caption over the take on a look with no ground. The frame pass leaves it
      // no band and no backdrop to sit on, so this is the one case that draws the plate
      // (pass 11's glass plus its scrim) rather than the band, and the one the default
      // look actually ships. The blur mark's own plate is in `marks`.
      'caption-plate': { opts: { backdropAspect: 16 / 9, look, captions: true, captionStyle: {},
        cues: [{ start: 3, end: 6, text: 'Every row shows the key and the tempo.' }] },
        ctx: { prepared: { captions: { cues: [], busy: [], words: { words: [{ w: 'Every', t: 3 }, { w: 'row', t: 3.3 }, { w: 'shows', t: 3.6 }, { w: 'the', t: 4 },
          { w: 'key', t: 4.2 }, { w: 'and', t: 4.6 }, { w: 'the', t: 4.8 }, { w: 'tempo.', t: 5 }] } } } }, n: 128 },
      // M5: the same caption on its way out, at output frame 186 (6.2 s), which is two
      // thirds through the 160 ms the words get. The words are well down the S and the
      // glass is still nearly up, because the plate outlasts them by 60 ms: a caption is
      // words inside a piece of glass, and the two switching off together is what read
      // as a cut. A caption that blinked, or a plate that went with its words, draws a
      // different frame here.
      'caption-leave': { opts: { backdropAspect: 16 / 9, look, captions: true, captionStyle: {},
        cues: [{ start: 3, end: 6, text: 'Every row shows the key and the tempo.' }] },
        ctx: { prepared: { captions: { cues: [], busy: [], words: { words: [{ w: 'Every', t: 3 }, { w: 'row', t: 3.3 }, { w: 'shows', t: 3.6 }, { w: 'the', t: 4 },
          { w: 'key', t: 4.2 }, { w: 'and', t: 4.6 }, { w: 'the', t: 4.8 }, { w: 'tempo.', t: 5 }] } } } }, n: 186 },
      'title': { opts: { backdrop: 'dusk', inset: 0.06, look, texts: [{ text: 'Fetch', subtitle: 'fetch.app', start: 0, end: 2.5, style: 'title' }] }, n: 36 },
      'lower-third': { opts: { backdrop: 'dusk', inset: 0.06, look, texts: [{ text: 'Library', subtitle: 'Three hundred songs', start: 7, end: 11, style: 'lower-third' },
        { text: 'New', start: 7, end: 11, fx: 0.7, fy: 0.3, style: 'label', box: true }] }, n: 270 },
      // M5: the drawn devices, one case each, because each has its own shape. What is
      // being looked at is the shell, its two hairlines, the take inside the hole and
      // the shadow coming off the shell rather than off the screen.
      'device-browser': { opts: { backdrop: 'ink', inset: 0.07, look: { ...look, device: { kind: 'browser', title: 'songscription.app' } } }, n: 150 },
      // A browser frame with nothing to put in its address field. It is the same rule as
      // the still's and it is not a flag for stills: a browser's bar is taller than a
      // window's for exactly one reason, which is the field standing in it, so with no
      // field there is no toolbar and what is left is a title bar. Every other browser
      // golden here carries a host-shaped title, which is how this escaped them.
      'device-browser-bare': { opts: { backdrop: 'ink', inset: 0.07, look: { ...look, device: { kind: 'browser' } } }, n: 150 },
      'device-window': { opts: { backdrop: 'slate', inset: 0.07, look: { ...look, device: { kind: 'window', title: 'Library' } } }, n: 150 },
      'device-laptop': { opts: { backdrop: 'dusk', inset: 0.07, look: { ...look, device: { kind: 'laptop' } } }, n: 150 },
      'device-phone': { opts: { backdrop: 'mint', inset: 0.07, look: { ...look, device: { kind: 'phone' } } }, n: 150 },
      // frame.chrome clean is the browser frame on its own: the real chrome cropped off
      // where the page's place is known, and one of Fetch's own drawn in its place. The
      // viewport is that place, and the crop is what the document made of it: with no
      // viewport nothing is cropped and Fetch draws no browser at all (devicePlan).
      'chrome-clean': { opts: { backdrop: 'ink', inset: 0.07, crop: { x: 0, y: 0.12, w: 1, h: 0.88 }, viewport: { x: 0, y: 0.12, w: 1, h: 0.88 },
        look: { ...look, frame: { border: 0, chrome: 'clean' }, device: { title: 'fetch.app', theme: 'light' } } }, n: 150 },
      // A burned caption under a device. The band is the room the layout left under the
      // take, and the device sits in the take's own place rather than beside it, so the
      // caption belongs in that band and not on the shell: laid out from the screen
      // inside the shell it came down onto a laptop's foot.
      'device-caption': { opts: { backdrop: 'dusk', inset: 0.06, captions: true, captionStyle: {},
        cues: [{ start: 3, end: 6, text: 'Every row shows the key and the tempo.' }],
        look: { ...look, device: { kind: 'laptop' } } },
        ctx: { prepared: { captions: { cues: [], busy: [], words: { words: [{ w: 'Every', t: 3 }, { w: 'row', t: 3.3 }, { w: 'shows', t: 3.6 }, { w: 'the', t: 4 },
          { w: 'key', t: 4.2 }, { w: 'and', t: 4.6 }, { w: 'the', t: 4.8 }, { w: 'tempo.', t: 5 }] } } } }, n: 128 },
      // The tilt: a real turn in perspective, so the mask, the border and the shadow
      // follow it. A device with it, since the two are the same plane.
      'tilt': { opts: { backdrop: 'violet', inset: 0.08, look: { ...look, frame: { border: 2, borderColor: '#F0A93C', tilt: 14 } } }, n: 150 },
      'tilt-device': { opts: { backdrop: 'studio', inset: 0.07, look: { ...look, frame: { border: 0, tilt: -11 }, device: { kind: 'laptop' } } }, n: 150 },
      // R7: the arrow. The light way to point at something, so the take under it is the
      // picture it was: it stands outside the box it aims at, a gap off the middle of
      // the nearest edge. This take goes out at 30 fps, and the arrow runs 2 s to 9 s.
      //
      // Holding (frame 150, 5 s): full size, at rest, from the left, which is the side
      // the eye is already travelling along and the first one with room. The box is
      // untouched: what is under an arrow is what was recorded.
      'arrow': { opts: { backdrop: 'ink', inset: 0.06, look, marks: [
        { kind: 'arrow', start: 2, end: 9, x: 0.45, y: 0.4, w: 0.14, h: 0.1 }] }, n: 150 },
      // Arriving (frame 65, 2.167 s): 0.49 through the 340 ms it lands in. It comes in
      // along its own line from 18 percent of its length further out and grows about
      // its tip, so the tip travels toward the thing and stops at the gap. Drawn with a
      // badge's centre pop instead, the head would be somewhere else entirely, and one
      // that grew from nothing would be a third of this length here.
      'arrow-in': { opts: { backdrop: 'ink', inset: 0.06, look, marks: [
        { kind: 'arrow', start: 2, end: 9, x: 0.45, y: 0.4, w: 0.14, h: 0.1 }] }, n: 65 },
      // Leaving (frame 267, 8.9 s): 0.51 through the 204 ms it clears in, backing off
      // the way it came on --ease-out while the alpha rides the S, which is the badge's
      // own leave. A blink draws it whole here, or not at all.
      'arrow-out': { opts: { backdrop: 'ink', inset: 0.06, look, marks: [
        { kind: 'arrow', start: 2, end: 9, x: 0.45, y: 0.4, w: 0.14, h: 0.1 }] }, n: 267 },
      // The same box, aimed from above: from names the side it comes in from, so this
      // one points down. The picture is the arrow turned, not a sprite tipped over: the
      // head, the round tail and the keyline are all drawn along the way it points.
      'arrow-top': { opts: { backdrop: 'ink', inset: 0.06, look, marks: [
        { kind: 'arrow', start: 2, end: 9, x: 0.45, y: 0.4, w: 0.14, h: 0.1, from: 'top' }] }, n: 150 },
      // And a box hard against the left of what a 2x zoom shows. The side is picked
      // inside that window rather than inside the recording, so the arrow comes down
      // from above instead of standing off the left where the window has no room for
      // it, and it is sized through the zoom, so it is the same arrow on screen as the
      // one above rather than twice the size.
      'arrow-zoom': { opts: { backdrop: 'ink', inset: 0.06, look, zooms: [{ start: 0, end: 11, scale: 2, x: 0.5, y: 0.5 }],
        marks: [{ kind: 'arrow', start: 2, end: 9, x: 0.28, y: 0.42, w: 0.08, h: 0.06 }] }, n: 150 },
      // The loupe: a magnified inset of a small area, beside the area it magnifies. The
      // redaction is there on purpose: what the edit hides has to stay hidden inside it.
      'loupe': { opts: { backdrop: 'ink', inset: 0.06, look, marks: [
        { kind: 'loupe', start: 1, end: 11, x: 0.12, y: 0.18, w: 0.16, h: 0.10 },
        { kind: 'redact', start: 0, end: 12, x: 0.14, y: 0.20, w: 0.06, h: 0.04 }] }, n: 150 },
      // M4: the treatment pass and the grain, one or two fields each so a failure names
      // the part that moved. Every other case leaves treatment at its defaults, which is
      // what holds those goldens still while this pass exists.
      'treat-grade': { opts: { backdrop: 'ink', inset: 0.06, look: { ...look, treatment: { motionBlur: 0.5, saturation: -1, contrast: 0.2, vignette: 0.35 } } }, n: 150 },
      'treat-tint': { opts: { backdrop: 'dusk', inset: 0.06, look: { ...look, treatment: { motionBlur: 0.5, tint: '#F0A93C', tintAmount: 0.5, haze: 0.35, brightness: 0.06 } } }, n: 90 },
      'treat-soft': { opts: { backdrop: 'slate', inset: 0.06, look: { ...look, treatment: { motionBlur: 0.5, blur: 0.4 } } }, n: 90 },
      'grain': { opts: { backdrop: 'dusk', inset: 0.08, look: { ...look, grain: { film: 0.5, dither: false } } }, n: 60 },
      // M4: the glow family off one bright pass, the aperture on the background, and
      // the mesh. Same rule: one or two fields a case.
      'glow': { opts: { backdrop: 'ink', inset: 0.06, look: { ...look, treatment: { motionBlur: 0.5, bloom: 0.5, halation: 0.45 } } }, n: 150 },
      'aberration': { opts: { backdrop: 'slate', inset: 0.06, look: { ...look, treatment: { motionBlur: 0.5, aberration: 1 } } }, n: 150 },
      'bokeh-photo': { opts: { backdrop: 'img:bg.jpg', inset: 0.07, look: { ...look, treatment: { motionBlur: 0.5, bokeh: 0.6 } } },
        ctx: { imageFile: path.join(FIX, 'bg.jpg') }, n: 120 },
      'bokeh-ground': { opts: { backdrop: 'blur', inset: 0.06, backdropAspect: 16 / 9, look: { ...look, treatment: { motionBlur: 0.5, bokeh: 0.7 } } }, n: 300 },
      'mesh': { opts: { backdrop: 'violet', inset: 0.08, look: { ...look, background: { kind: 'mesh', mesh: 'violet' } } }, n: 90 },
      // Auto level is the one branch of the treatment pass with no picture of its own:
      // its two numbers are measured once per take by levels.js and reach the plan
      // through prepare.js, so the case hands them over in that same shape.
      'auto-level': { opts: { backdrop: 'ink', inset: 0.06, look: { ...look, treatment: { motionBlur: 0.5, autoLevel: true } } },
        ctx: { prepared: { levels: { lo: 0.12, hi: 0.78 } } }, n: 150 },
      // The steepest stretch levels.js can hand over (its black point caps at 64, its
      // white point floors at 170: a gain of 2.4) with a contrast over the top. Auto
      // level is the one field that multiplies whatever the two decode paths disagree
      // about, so this case is in parity as well as in the goldens.
      'auto-level-hard': { opts: { backdrop: 'ink', inset: 0.06, look: { ...look, treatment: { motionBlur: 0.5, autoLevel: true, contrast: 0.3 } } },
        ctx: { prepared: { levels: { lo: 64 / 255, hi: 170 / 255 } } }, n: 150 },
      // The grade is held to the recording and Fetch's own furniture is drawn outside it,
      // so this case puts the two together: a look that takes every bit of colour out of
      // the take, with a step badge and the agent's cursor on the recording and a caption
      // on the ground. The ground has to stay the colour the look asked for, the badge and
      // the cursor have to stay gold, and the take between them has to go grey.
      'treat-furniture': { opts: { backdrop: 'ink', inset: 0.06, captions: true, captionStyle: {},
        look: { ...look, treatment: { motionBlur: 0.5, saturation: -1, contrast: 0.15, vignette: 0.3 } },
        cues: [{ start: 3, end: 6, text: 'Every row shows the key and the tempo.' }],
        marks: [{ kind: 'step', start: 1, end: 11, x: 0.35, y: 0.3 }],
        pointer: [{ t: 0.5, x: 0.2, y: 0.3 }, { t: 3, x: 0.6, y: 0.5, click: true }, { t: 6, x: 0.4, y: 0.7 }] },
        ctx: { prepared: { captions: { cues: [], busy: [], words: { words: [{ w: 'Every', t: 3 }, { w: 'row', t: 3.3 }, { w: 'shows', t: 3.6 }, { w: 'the', t: 4 },
          { w: 'key', t: 4.2 }, { w: 'and', t: 4.6 }, { w: 'the', t: 4.8 }, { w: 'tempo.', t: 5 }] } } } }, n: 128 },
      // The whole Treatment section at once, dither included, which is the frame someone
      // gets when they turn it all on. Every case above moves one part so a failure names
      // it; this one is what parity and stateless are held to, because an effect that
      // only misbehaves beside another would slip past all of them.
      'treat-all': { opts: { backdrop: 'blur', inset: 0.06, backdropAspect: 16 / 9, look: { ...look,
        treatment: { motionBlur: 0.5, brightness: 0.05, contrast: 0.12, saturation: -0.25, tint: '#F0A93C', tintAmount: 0.25,
          haze: 0.15, blur: 0.15, bokeh: 0.5, bloom: 0.4, halation: 0.3, aberration: 0.5, vignette: 0.3 },
        grain: { film: 0.4, dither: true } } }, n: 150 },
      // R3: the two frames a loop hands to each other, on a take whose screen never
      // changes. Everything that moves between them is Fetch's own (the ground's tooth,
      // the film and the dither, each seeded by the frame's place inside the loop), so
      // the pair is the hand-over itself. Both ends, because a golden of one of them
      // holds still while the other one drifts.
      'loop-first': { ...loopBase, opts: loopOpts, n: 0 },
      'loop-last': { ...loopBase, opts: loopOpts, n: LOOP_N - 1 },
      // R3 T5: the keys as they were pressed. This take goes out at 30 fps, so frame 105
      // is 3.5 s, half a second into a press made at 3 s: every one of these is a group
      // at rest, which is the frame someone actually reads.
      //
      // One key: a named key gets the word rather than the Mac's glyph, because a clip
      // on a landing page is read at a glance and by people who are not on a Mac.
      'keys-key': { opts: { backdrop: 'ink', inset: 0.06, look, keys: [{ t: 3, key: 'enter' }] }, n: 105 },
      // A chord: the modifiers in the Mac's own order (⇧⌘) as glyphs, then the key that
      // acted, on the step badge's gold. The gold is the whole of how a chord reads at a
      // glance as modifiers and one key.
      'keys-chord': { opts: { backdrop: 'ink', inset: 0.06, look, keys: [{ t: 3, key: 'p', mods: ['cmd', 'shift'] }] }, n: 105 },
      // A run of typing the capture vouched for: one pill in the mono face, holding what
      // had been typed by this frame and not a letter of what comes after it.
      'keys-run': { opts: { backdrop: 'ink', inset: 0.06, look, keys: TYPED }, n: 105 },
      // The same run with nothing vouched for, which is what a password looks like from
      // here: the pill says someone is typing and never what. Fetch draws a character
      // only where the event carries one, so this is the default rather than a mode.
      'keys-secret': { opts: { backdrop: 'ink', inset: 0.06, look, keys: TYPED.map(e => ({ t: e.t, key: e.key })) }, n: 105 },
      // And the placement ladder: a 9:16 output leaves a deep ground under the take, so
      // the strip stands on it, outside the picture entirely, where it can cover nothing
      // at all. Centred here, which is the one place a 9:16 clip has room for it.
      'keys-ground': { opts: { backdrop: 'ink', inset: 0.08, backdropAspect: 9 / 16,
        look: { ...look, keys: { place: 'centre' } }, keys: [{ t: 3, key: 'k', mods: ['cmd'] }] }, n: 105 },
      // The touch disc: where a finger went on a device Fetch was filming. Four moments
      // rather than four settings, because the mark is a function of the plan and the
      // time like everything else here. This take goes out at 30 fps, so frame n is
      // n / 30 seconds, and every tap is inside SIM's screen rectangle.
      //
      // One tap, caught 33 ms after contact: full strength and part way into the squash,
      // which is the frame that says the disc presses rather than appears.
      'touch-tap': { opts: { ...TOUCH, backdrop: 'dusk', inset: 0.06,
        pointer: [{ t: 3, x: 0.5, y: 0.4, click: true }] }, n: 91 },
      // A held tap, half a second into a one second glide: one finger still down, drawn
      // where the ease has carried it, not a trail and not two discs. The second point
      // carries the first one's id, which is the whole of how a hold is told from a tap.
      'touch-glide': { opts: { ...TOUCH, backdrop: 'dusk', inset: 0.06,
        pointer: [{ id: 'f1', t: 3, x: 0.44, y: 0.3, click: true }, { id: 'f1', t: 4, x: 0.56, y: 0.62 }] }, n: 105 },
      // Two fingers on the glass 50 ms apart, read at 3.1 s: the first is settling out of
      // its press and the second is at the bottom of its own. A plan that held one disc
      // would draw either a flicker or a glide between two places nothing travelled.
      'touch-two': { opts: { ...TOUCH, backdrop: 'dusk', inset: 0.06,
        pointer: [{ id: 'a', t: 3, x: 0.43, y: 0.34, click: true }, { id: 'b', t: 3.05, x: 0.57, y: 0.58, click: true }] }, n: 93 },
      // And a tap inside a zoom that has landed. The disc is drawn on the recording
      // rather than over the finished frame, so the zoom carries it and scales it the
      // way it carries the thing that was tapped. A disc drawn over the frame would sit
      // at the same size beside a control twice the size it was.
      'touch-zoom': { opts: { ...TOUCH, backdrop: 'slate', inset: 0.06,
        zooms: [{ start: 1, end: 6, scale: 2, x: 0.5, y: 0.4 }],
        pointer: [{ t: 4, x: 0.5, y: 0.4, click: true }] }, n: 123 },
    }

    // Every built-in look, drawn end to end: the preset as the editor and the MCP
    // surface hand it over (Look.toClassic for the classic options, the resolved look
    // for the compositor), so a field a preset declares and no pass draws shows up here
    // as a frame that does not change when the preset does.
    const Look = require('../../ui/look')
    const lookOpts = L => { const c = Look.toClassic(L)
      return { backdrop: c.backdrop, backdropAspect: c.backdropAspect, inset: c.inset, radius: c.radius, shadow: c.shadow, captions: false, look: L } }
    for (const pr of Look.list()) {
      cases['preset-' + pr.name] = { opts: lookOpts(Look.merge(Look.defaults(), { preset: pr.name }).look), n: 150 }
    }

    if (want('golden')) {
      console.log('golden frames' + (update ? ' (updating)' : ''))
      for (const [name, c] of Object.entries(cases)) {
        const r = await call('golden', { ...base, ...c, width: 640 }, path.join(GOLD, name + '.png'), update)
        if (r.written) is(`${name} written`, true, r.size)
        else is(name, r.max <= 2 && r.mean < 0.05, `max ${r.max} LSB, mean ${r.mean}`)
      }
    }

    if (want('presets')) {
      console.log('every field a built-in look declares reaches a pixel')
      const D = Look.defaults()
      for (const pr of Look.list()) {
        const paths = Object.entries(pr.look).flatMap(([sec, vals]) => Object.keys(vals).map(k => [sec, k]))
        if (!paths.length) { is(`${pr.name} declares nothing and draws the take edge to edge`, true); continue }
        const full = Look.merge(D, { preset: pr.name }).look
        // A field a preset writes at its own default value pins that default: it cannot
        // move a pixel by construction, and it is there so the preset keeps its look if
        // the default ever changes. Named, not asked to draw anything.
        const pinned = paths.filter(([sec, k]) => JSON.stringify(pr.look[sec][k]) === JSON.stringify(D[sec][k]))
        const asks = paths.filter(x => !pinned.includes(x))
        if (pinned.length) is(`${pr.name} pins ${pinned.length} default${pinned.length === 1 ? '' : 's'}`, true, pinned.map(x => x.join('.')).join(', '))
        // and the rest, one at a time, against the same frame with that one field back
        // at its default: a field a preset asks for and no pass draws fails here
        const variants = asks.map(([sec, k]) => ({ ...base, opts: lookOpts(Look.merge(full, { [sec]: { [k]: D[sec][k] } }).look), n: 150, width: 640 }))
        const rs = await call('moved', { ...base, opts: lookOpts(full), n: 150, width: 640 }, variants)
        asks.forEach(([sec, k], i) => is(`${pr.name}: ${sec}.${k} reaches a pixel`, rs[i].max > 0,
          `max ${rs[i].max} LSB${rs[i].size ? ', frame ' + rs[i].size : ''}`))
      }
    }

    if (want('parity')) {
      console.log('preview path equals export path, before encode')
      // zoom-glide is here now that the shutter is open by default: it is the one case
      // that draws through the multi-tap blur, and preview and export have to agree on it
      for (const name of ['framed-dusk', 'framed-16x9-crop', 'blur-ground', 'bokeh-ground', 'zoom-hold', 'zoom-glide', 'cut-dissolve', 'reveal', 'camera', 'marks', 'lift', 'pointer', 'text', 'caption-plate', 'glow',
        'auto-level', 'auto-level-hard', 'treat-furniture', 'treat-all', 'device-browser', 'tilt-device', 'loupe', 'arrow', 'keys-chord', 'touch-glide']) {
        const c = cases[name]
        const r = await call('parity', { ...base, ...c })
        // A crop's first and last rows can differ at a sharp colour edge: the <video>
        // holds the chroma row beyond the crop, the cropped decode does not. So a few
        // pixels in ten thousand may; the rest must be within 3 LSB.
        is(`${name} (source frame ${r.i})`, (r.max <= 3 || r.over2 < 0.05) && r.mean < 0.05, `max ${r.max} LSB at ${r.at}, mean ${r.mean}, over 2 LSB ${r.over2}%`)
      }
    }

    if (want('stateless')) {
      console.log('any frame alone')
      const r = await call('stateless', { ...base, ...cases['zoom-glide'] }, [10, 400, 3])
      is('a frame drawn after others is the same frame', r.max === 0, `max ${r.max}`)
      const b = await call('stateless', { ...base, ...cases['blur-ground'] }, [20, 500])
      is('the blur ground too', b.max === 0, `max ${b.max}`)
      // grain is seeded by the frame index alone, so a frame drawn out of order carries
      // the same grain it would have carried drawn in order
      const g = await call('stateless', { ...base, ...cases['grain'] }, [30, 120, 7])
      is('film grain is the frame\'s own', g.max === 0, `max ${g.max}`)
      // bloom and halation come off this frame's own bright pass, so they carry nothing
      // from the frame before
      const w = await call('stateless', { ...base, ...cases['glow'] }, [40, 300, 11])
      is('the glow is this frame\'s own too', w.max === 0, `max ${w.max}`)
      // and the whole stack together, grain and aberration on: grain is seeded by the
      // frame index alone and aberration only re-samples this frame, so a frame drawn
      // out of turn has to come back byte for byte
      const t = await call('stateless', { ...base, ...cases['treat-all'] }, [50, 260, 5])
      is('the whole treatment stack, grain and aberration on', t.max === 0, `max ${t.max}`)
      // A drawn device is one picture kept between frames and a loupe reads a target of
      // its own, so both are places where a frame could carry something from the one
      // before it. Neither does: the picture is a function of the plan and the size, and
      // the loupe's target is written whole every time it is used.
      const dv = await call('stateless', { ...base, ...cases['tilt-device'] }, [60, 200])
      is('a drawn device and a tilt', dv.max === 0, `max ${dv.max}`)
      const lp = await call('stateless', { ...base, ...cases['loupe'] }, [40, 250, 9])
      is('a loupe, over its own marks', lp.max === 0, `max ${lp.max}`)
      // an arrow is a picture kept by its size and direction and placed from the frame's
      // own output time, so a frame in the middle of its arrival comes back byte for byte
      const ar = await call('stateless', { ...base, ...cases['arrow-in'] }, [65, 150, 267])
      is('an arrow part way through arriving', ar.max === 0, `max ${ar.max}`)
      // the bubble's track is read at the frame's own output time, so a frame in the
      // middle of one of its moves is the same frame drawn out of turn
      const cb = await call('stateless', { ...base, ...cases['camera-tween'] }, [90, 285, 20])
      is('a camera bubble in the middle of a move', cb.max === 0, `max ${cb.max}`)
      // a key cap is a picture kept by its label and its size, and the pill's own word is
      // read off the frame's output time, so a frame in the middle of a typed word comes
      // back byte for byte drawn out of turn
      const ky = await call('stateless', { ...base, ...cases['keys-run'] }, [92, 150, 40])
      is('a key cap, and a typing pill part way through its word', ky.max === 0, `max ${ky.max}`)
      // a dissolve draws the frame twice and mixes the two: still the frame's own time
      // and nothing else, so it comes back byte for byte after other frames
      const d = await call('stateless', { ...base, ...cases['cut-dissolve'] }, [30, 91, 200])
      is('a frame in the middle of a dissolve', d.max === 0, `max ${d.max}`)
      // the touch disc is a closed form of the time since its own tap: where the finger
      // is, how present it is and how far it has squashed all read t and nothing else,
      // so a frame in the middle of a held glide comes back byte for byte out of turn
      const tc = await call('stateless', { ...base, ...cases['touch-glide'] }, [80, 105, 118])
      is('a touch disc part way along a held glide', tc.max === 0, `max ${tc.max}`)

      // A dissolve asked for with no far side to mix in. The near side alone is the
      // frame, and it is the same frame whatever was drawn before it: reading the side
      // off fp.mix alone, this stashed the near side, wrote nothing to the output and
      // left whatever the target was holding on the stage for the whole window.
      const one = await call('oneSided', { ...base, ...cases['cut-dissolve'], width: 640 }, 40)
      is('a dissolve with no far side draws the near side, not the frame before',
        one.same.max === 0 && one.stale.max > 0 && one.mixed.max > 0,
        `the same frame twice ${one.same.max} LSB, against the frame before ${one.stale.max}, against the mixed frame ${one.mixed.max} at mix ${one.mix}`)

      // A single frame redrawn is the smallest version of the claim. The whole of it is
      // a sequence that moves: a zoom through its ramp, a dissolve through its window
      // and the take arriving, each drawn in order and then drawn again in a shuffled
      // order. Motion is solved from the output time alone, so the two runs are the same
      // pixels, and that is what lets the export render out of order and the stage scrub
      // into the middle of a move. A move that integrated anything would show here and
      // nowhere else.
      for (const [name, ns] of [['zoom-glide', range(32, 43)], ['cut-dissolve', range(86, 94)], ['reveal', range(0, 11)]]) {
        const rs = await call('permute', { ...base, ...cases[name], width: 640 }, ns, shuffle(ns))
        const worst = rs.reduce((m, q) => (q.max > m.max ? q : m), rs[0])
        is(`${ns.length} moving frames of ${name}, drawn in a shuffled order`, rs.every(q => q.max === 0),
          `max ${worst.max} LSB on frame ${worst.n}, order ${shuffle(ns).join(' ')}`)
      }
    }

    if (want('loop')) {
      console.log('a clip that loops with no seam')
      const GL = require('../../ui/compositor/gl')
      const check = o => GL.loopCheck(Plan.prepare(o, loopMeta, {}))
      const capCtx = { prepared: { captions: { cues: [], busy: [], words: { words: [{ w: 'Every', t: 4.6 }, { w: 'row', t: 5.0 }, { w: 'shows', t: 5.4 }, { w: 'the', t: 5.8 }] } } } }

      // The plan half, with nothing drawn. Every pass is a function of the plan and the
      // time, so what the hand-over shows can be read off the plan before a pixel is:
      // the step from the last frame to the first, against the steps either side of it.
      // Each case leaves exactly one thing running across the wrap, or does not.
      const checks = [
        ['a still take with nothing over it', loopOpts, true, null],
        ['a redaction over the whole clip', { ...loopOpts, marks: [{ kind: 'redact', start: 0, end: 9, x: 0.05, y: 0.06, w: 0.25, h: 0.14 }] }, true, null],
        ['a zoom that lands and releases inside the clip', { ...loopOpts, zooms: [{ start: 1, end: 4, scale: 2, x: 0.5, y: 0.5 }] }, true, null],
        ['a caption that ends before the last frame', { ...loopOpts, captions: true, captionStyle: {}, cues: [{ start: 1, end: 3, text: 'Every row shows the' }] }, true, null, capCtx],
        ['the take rising in and settling out, which is the default', { ...loopOpts, look: { ...loopLook, motion: { reveal: 'rise' } } }, false, 'reveal'],
        ['a fade in alone', { ...loopOpts, fadeIn: 0.5 }, false, 'fade'],
        ['a fade at both ends', { ...loopOpts, fadeIn: 0.5, fadeOut: 0.5 }, false, 'fade'],
        ['a zoom still moving at the last frame', { ...loopOpts, zooms: [{ start: 5.5, end: 6, scale: 2, x: 0.5, y: 0.5 }] }, false, 'taps'],
        ['a step badge up at the end and not at the start', { ...loopOpts, marks: [{ kind: 'step', start: 5, end: 9, x: 0.35, y: 0.3 }] }, false, 'marks.steps'],
        ['an arrow up at the end and not at the start', { ...loopOpts, marks: [{ kind: 'arrow', start: 5, end: 9, x: 0.45, y: 0.4, w: 0.14, h: 0.1 }] }, false, 'marks.arrow'],
        ['a caption mid-phrase at the last frame', { ...loopOpts, captions: true, captionStyle: {}, cues: [{ start: 4.5, end: 7, text: 'Every row shows the' }] }, false, 'text', capCtx],
        ['the cursor somewhere else at the end', { ...loopOpts, pointer: [{ t: 0.5, x: 0.2, y: 0.3 }, { t: 3, x: 0.6, y: 0.5, click: true }, { t: 6, x: 0.4, y: 0.7 }] }, false, 'marks.pointer'],
        ['a tap still on screen at the last frame', { ...loopOpts, look: { ...loopLook, cursor: { style: 'touch' } },
          pointer: [{ t: 5.9, x: 0.5, y: 0.4, click: true }] }, false, 'marks.touch'],
        ['a tap that is gone well before the wrap', { ...loopOpts, look: { ...loopLook, cursor: { style: 'touch' } },
          pointer: [{ t: 2, x: 0.5, y: 0.4, click: true }] }, true, null],
        ['the take still settling under a closing title card', { ...loopOpts, texts: [{ text: 'Fetch', subtitle: 'fetch.app', start: 0, end: 2, style: 'title' }] }, false, 'move'],
      ]
      for (const [label, opts, loops, id, ctx] of checks) {
        const r = GL.loopCheck(Plan.prepare(opts, loopMeta, ctx || {}))
        is(`${label}: ${loops ? 'loops' : 'refused'}`, r.loops === loops && (!id || r.faults.some(f => f.id === id)),
          r.loops ? 'no faults' : r.faults.map(f => `${f.id}${f.step != null ? ` (${f.step} against ${f.ordinary})` : ''}: ${f.what}`).join('; '))
      }
      // And what stops it is said in words, with something to do about it: an answer
      // worth more than a forced loop, and the reason nothing here rewrites an edit.
      const said = GL.loopCheck(Plan.prepare({ ...loopOpts, fadeIn: 0.5, fadeOut: 0.5 }, loopMeta, {}))
      is('a refusal says what is stopping it and what to do', said.faults.every(f => f.what && f.fix),
        said.faults.map(f => `${f.what} -> ${f.fix}`).join('; '))
      // The recording's own half, which the plan cannot answer and does not pretend to
      is('and it hands back the take\'s time at both ends rather than guessing at the pixels',
        said.source.start === 0 && said.source.end > 5.9, JSON.stringify(said.source))

      // The seeding. A looping preview counts frames on past the end for as long as the
      // page is open, and the file holds L of them, so the index the grain, the tooth
      // and the dither are seeded by is the frame's place inside the loop.
      is('the frame index wraps at the loop, and passes through where there is none',
        [0, 1, 179, 180, 181, 359, 360].map(n => GL.loopIndex(n, LOOP_N)).join(' ') === '0 1 179 0 1 179 0' &&
        [0, 180, 361].map(n => GL.loopIndex(n, 0)).join(' ') === '0 180 361',
        [0, 1, 179, 180, 181, 359, 360].map(n => GL.loopIndex(n, LOOP_N)).join(' '))

      // The pixels. A run of frames either side of the hand-over, each drawn alone, read
      // back and stepped here: a seam is the step between two different frames, which is
      // not a thing the page's own diff of one frame against itself can see.
      // seed is the frame index the texture is seeded by, left out where it is n itself.
      // Nothing here wraps it by hand: the plan's own spec.loop is what the compositor
      // wraps it in, so these frames come off the chain an export and a stage use.
      const frameAt = async (tag, opts, n, seed, ctx) => {
        const f = path.join(OUT, `loop-${tag}-${n}-${seed == null ? 'n' : seed}.png`)
        await call('shot', { ...loopBase, opts, ctx, n, ...(seed == null ? {} : { seed }), width: 640 }, f)
        return rgbOf(f)
      }
      const NS = [0, 1, 2, LOOP_N - 3, LOOP_N - 2, LOOP_N - 1]
      const PAIRS = [[0, 1], [1, 2], [LOOP_N - 3, LOOP_N - 2], [LOOP_N - 2, LOOP_N - 1]]
      const measure = async (tag, opts, ctx) => {
        const px = new Map()
        for (const n of NS) px.set(n, await frameAt(tag, opts, n, null, ctx))
        const wrap = step(px.get(LOOP_N - 1), px.get(0))
        const ord = PAIRS.map(([a, b]) => step(px.get(a), px.get(b)))
        return { px, wrap, worst: ord.reduce((m, x) => (x.mean > m.mean ? x : m)), ord }
      }
      // A loop is seamless when the wrap is no bigger a step than a normal one. On a
      // take that never changes, every ordinary step is the grain, the tooth and the
      // dither renewing, and so is the wrap: that is the whole claim, in levels.
      const clean = await measure('clean', loopOpts)
      is('the wrap is no bigger a step than an ordinary frame to frame one',
        clean.wrap.mean <= clean.worst.mean * 1.05 && clean.wrap.max <= clean.worst.max + 2,
        `wrap mean ${clean.wrap.mean} max ${clean.wrap.max}, ordinary up to mean ${clean.worst.mean} max ${clean.worst.max}`)
      console.log('  (ordinary steps ' + clean.ord.map(o => o.mean).join(' ') + ', wrap ' + clean.wrap.mean + ')')

      // And the check is holding up the pixels rather than an opinion about them: an
      // edit it refuses has a hand-over the measurement can see from across the room.
      const bad = await measure('fade', { ...loopOpts, fadeIn: 0.5 })
      is('an edit the check refuses has a wrap the measurement finds',
        !check({ ...loopOpts, fadeIn: 0.5 }).loops && bad.wrap.mean > bad.worst.mean * 4,
        `wrap mean ${bad.wrap.mean} max ${bad.wrap.max}, ordinary up to mean ${bad.worst.mean} max ${bad.worst.max}`)

      // The switch, end to end. motion.loop is what puts the loop's length on the plan
      // (plan.js), and the plan is what the compositor wraps the index in, so the whole
      // chain is one assertion rather than arithmetic checked on its own.
      is('the look asking for a loop is what puts its length on the plan',
        Plan.prepare(loopLoop, loopMeta, {}).loop === LOOP_N && Plan.prepare(loopOpts, loopMeta, {}).loop === 0,
        `${Plan.prepare(loopLoop, loopMeta, {}).loop} with the switch on, ${Plan.prepare(loopOpts, loopMeta, {}).loop} with it off`)

      // The second cycle. A stage playing the clip round again counts on past the end,
      // and the frame it draws has to be the frame the file holds, or the editor is
      // showing something no export ever wrote. Frame 12 of the file, the same frame a
      // cycle later with the raw count, and the same frame a cycle later with the same
      // raw count and the loop switched on, which is the compositor doing the wrapping.
      const a = await frameAt('cycle', loopOpts, 12, 12)
      const raw = await frameAt('cycle', loopOpts, 12, 12 + LOOP_N)
      const wrapped = await frameAt('cycle', loopLoop, 12, 12 + LOOP_N)
      const drift = step(a, raw)
      is('a second cycle counted straight on is not the frame the file holds', drift.mean > 0.2, `mean ${drift.mean}, max ${drift.max} levels`)
      is('and with the loop on the compositor wraps it back to the file\'s own frame, to the bit',
        step(a, wrapped).max === 0, `max ${step(a, wrapped).max} LSB`)
      // Frame L is frame 0 again, which is the hand-over itself in pixels.
      const handOver = await frameAt('cycle', loopLoop, 0, LOOP_N)
      is('frame L of a looping clip is frame 0 again', step(clean.px.get(0), handOver).max === 0,
        `max ${step(clean.px.get(0), handOver).max} LSB`)

      // The rule the loop work was most likely to break, so it is checked on the loop's
      // own terms: a third cycle's frames, drawn in a shuffled order, are the frames the
      // file holds. t mod L is a function of the frame's own time like the index it
      // replaces, so nothing here reads another frame to know what to draw.
      const third = new Map()
      for (const n of shuffle(NS)) third.set(n, await frameAt('cycle3', loopLoop, n, n + 2 * LOOP_N))
      const off = NS.map(n => step(clean.px.get(n), third.get(n))).reduce((m, x) => (x.max > m.max ? x : m))
      is('a third cycle drawn in a shuffled order is the file\'s own frames, byte for byte', off.max === 0,
        `max ${off.max} LSB, order ${shuffle(NS).join(' ')}`)
    }

    if (want('keys')) {
      console.log('the keys as they were pressed')
      const GL = require('../../ui/compositor/gl')
      const Marks = require('../../ui/compositor/marks')
      const Timeline = require('../../ui/timeline')
      const clock = Timeline.outClock(null, 0, 12, null)
      // a 1080p frame with a framed take in it, which is what the plan hands over
      const box = { x: 115, y: 65, w: 1690, h: 890 }
      const plan = (keys, o = {}) => Marks.planKeys(keys, { W: 1920, H: 1080, box, capBox: box, clock, span: 12, ...o })
      const said = (K, t) => ((Marks.keysAt(K, t) || { caps: [] }).caps.map(c => c.label))

      // The privacy rule first, because it is the one thing here that has to be right
      // the first time. A character is drawn only where the event carries one.
      const run = plan(TYPED)
      is('a run the capture vouched for is typed out as it was typed',
        JSON.stringify([said(run, 2.65), said(run, 3.5), said(run, 3.94)]) === JSON.stringify([['f'], ['fetch the t'], ['fetch the take']]),
        JSON.stringify([said(run, 2.65), said(run, 3.5), said(run, 3.94)]))
      const secret = plan(TYPED.map(e => ({ t: e.t, key: e.key })))
      is('the same keys with nothing vouched for say someone is typing and never what',
        [2.65, 3.5, 3.94].every(t => JSON.stringify(said(secret, t)) === JSON.stringify(['typing…'])), JSON.stringify(said(secret, 3.5)))
      // A password field is not always a whole run of its own: the letters either side of
      // one key nobody vouched for are the rest of the same secret.
      const mixed = plan(TYPED.map((e, i) => (i === 4 ? { t: e.t, key: e.key } : e)))
      is('one unvouched key in a run hides the whole run', JSON.stringify(said(mixed, 3.94)) === JSON.stringify(['typing…']), JSON.stringify(said(mixed, 3.94)))
      is('and nothing infers a character from the key it was',
        !JSON.stringify(said(plan([{ t: 3, key: 'a' }]), 3.3)).includes('A'), JSON.stringify(said(plan([{ t: 3, key: 'a' }]), 3.3)))

      // What a chord looks like. A modified key is a command rather than content, so it
      // is named from the key itself, in the Mac's own order and the Mac's own glyphs.
      is('a chord is the modifiers in the Mac\'s order and then the key that acted',
        JSON.stringify(said(plan([{ t: 3, key: 'p', mods: ['cmd', 'shift'] }]), 3.5)) === JSON.stringify(['⇧', '⌘', 'P']),
        JSON.stringify(said(plan([{ t: 3, key: 'p', mods: ['cmd', 'shift'] }]), 3.5)))
      is('and the gold is on that key alone, so a chord reads as modifiers and one key',
        (Marks.keysAt(plan([{ t: 3, key: 'k', mods: ['cmd'] }]), 3.5).caps.filter(c => c.role === 'action').length === 1))
      // A key held down, or hit three times in half a second: one cap with a count,
      // rather than the same cap flashing three times.
      is('a repeat is one cap with a count on it',
        JSON.stringify(said(plan([{ t: 3, key: 'down' }, { t: 3.2, key: 'down' }, { t: 3.4, key: 'down' }]), 3.6)) === JSON.stringify(['↓ ×3']),
        JSON.stringify(said(plan([{ t: 3, key: 'down' }, { t: 3.2, key: 'down' }, { t: 3.4, key: 'down' }]), 3.6)))

      // How long one stays up, and that only one is ever up: the strip is one object in
      // one place, so a new press pushes the last one out rather than landing on it.
      const two = plan([{ t: 3, key: 'k', mods: ['cmd'] }, { t: 3.4, key: 'enter' }])
      let both = 0, up = 0
      for (let t = 2.8; t < 5; t += 1 / 120) {
        const l = said(two, t)
        if (l.includes('K') && l.includes('Return')) both++
        if (l.length) up++
      }
      is('one group is on screen at a time', both === 0, `${both} frames of both`)
      is('a key stays up long enough to read and not long enough to be in the way',
        said(two, 4.2).length === 1 && said(two, 4.5).length === 0, `up for ${(up / 120).toFixed(2)} s over two presses`)
      // It arrives the way everything else in the house does: it comes up from under its
      // own line while it fades, rather than switching on.
      const one = plan([{ t: 3, key: 'enter' }])
      const mid = Marks.keysAt(one, 3.07).caps[0], rest = Marks.keysAt(one, 3.5).caps[0]
      is('and arrives by coming up into place rather than switching on',
        mid.op > 0.05 && mid.op < 0.95 && mid.y > rest.y && mid.grow < 1, `op ${mid.op.toFixed(2)}, ${(mid.y - rest.y).toFixed(1)} px low`)

      // Where it sits. Never on the thing being demonstrated: on the ground under the
      // take where the look leaves room, inside its bottom corner where it does not, and
      // above a burned-in caption either way.
      const tall = Marks.planKeys([{ t: 3, key: 'enter' }], { W: 1080, H: 1920, box: { x: 40, y: 600, w: 1000, h: 562 }, clock, span: 12 })
      is('a deep ground under the take puts the strip on it, outside the picture', tall.y - tall.capH > 1162, `${(tall.y - tall.capH).toFixed(0)} px down, take ends at 1162`)
      const capped = plan([{ t: 3, key: 'enter' }], { box: { x: 0, y: 0, w: 1920, h: 1080 }, capBox: { x: 0, y: 0, w: 1920, h: 1080 }, caption: {} })
      const capY = require('../../ui/overlays').captionLayout(1920, 1080, {}, { x: 0, y: 0, w: 1920, h: 1080 })
      is('a caption inside the take pushes the strip above it', capY.y - capped.y > capY.px * 2, `caption bottom ${capY.y.toFixed(0)}, cap bottom ${capped.y.toFixed(0)}`)

      // And what a loop makes of it: a key still on screen at the last frame is the same
      // fault as a badge that is, and is named the same way rather than fixed quietly.
      const spec = Plan.prepare(loopOpts, loopMeta, {})
      // the one line plan.js needs, applied here (see the shim above)
      spec.keys = Marks.planKeys([{ t: 5.9, key: 'k', mods: ['cmd'] }], { W: spec.W, H: spec.H, box: spec.rect, clock: Timeline.outClock(null, 0, 6, null), span: spec.span })
      const lc = GL.loopCheck(spec)
      is('a key still on screen at the last frame stops the loop, by name',
        !lc.loops && lc.faults.some(f => f.id === 'keys'), lc.faults.map(f => `${f.id}: ${f.what}`).join('; ') || 'no faults')
      const clear = Plan.prepare(loopOpts, loopMeta, {})
      clear.keys = Marks.planKeys([{ t: 1, key: 'k', mods: ['cmd'] }], { W: clear.W, H: clear.H, box: clear.rect, clock: Timeline.outClock(null, 0, 6, null), span: clear.span })
      is('and a chord that is over before the end does not', GL.loopCheck(clear).loops, GL.loopCheck(clear).faults.map(f => f.id).join(' ') || 'no faults')
    }

    if (want('touch')) {
      console.log('what was tapped')
      const Marks = require('../../ui/compositor/marks')
      const Timeline = require('../../ui/timeline')
      const clock = Timeline.outClock(null, 0, 12, null)
      // the recording's own pixels, which is what the disc is sized and placed in
      const W = 1440, H = 900
      const plan = (pts, o = {}) => Marks.planPointer(pts, { W, H, clock, crop: null, scale: null, span: 12, px: 1, zooms: [], style: 'touch', ...o })
      const discs = (P, t) => Marks.at({ erase: [], redact: [], blur: [], focus: [], steps: [], loupe: [], arrow: [], pointer: P }, t).touch
      const tap = [{ t: 3, x: 0.5, y: 0.4, click: true }]

      // The size is a measurement, not a taste. 44 points is a tenth of a 440 point
      // screen, and the screen is 0.276 of this frame, so the disc is 0.0276 of it
      // whatever the capture was scaled at. Sized against the frame instead it would be
      // right on one device and wrong on every other.
      const real = plan(tap, { device: SIM })
      is('the disc is a 44 point touch target, measured through the device\'s own screen',
        Math.abs(real.disc - 0.0276 * W) < 0.01, `${real.disc.toFixed(2)} px of ${W}, wanted ${(0.0276 * W).toFixed(2)}`)
      // and it follows the screen rather than the frame: the same device in half the
      // window is half the disc
      const half = plan(tap, { device: { screen: SIM.screen, viewport: { ...SIM.viewport, w: SIM.viewport.w / 2 } } })
      is('and it follows the screen rather than the frame', Math.abs(half.disc * 2 - real.disc) < 0.01,
        `${half.disc.toFixed(2)} against ${real.disc.toFixed(2)}`)
      // With no device the honest answer is the mark Fetch already draws where a click
      // landed, sized off the frame. Never a physical size asserted confidently.
      const blind = plan(tap)
      const arrow = plan(tap, { style: 'arrow' })
      is('with no device it falls back to the click ripple\'s own diameter, not a guess',
        Math.abs(blind.disc - 2 * arrow.ripple) < 1e-9, `${blind.disc.toFixed(2)} px against a ripple ${arrow.ripple.toFixed(2)} across`)

      // The absence rule, which is the whole difference between a finger and a cursor.
      const two = plan([{ t: 3, x: 0.4, y: 0.35, click: true }, { t: 5, x: 0.6, y: 0.55, click: true }])
      is('nothing is on the glass between two taps',
        !discs(two, 2.8).length && discs(two, 3).length === 1 && !discs(two, 4).length && discs(two, 5).length === 1 && !discs(two, 5.5).length,
        [2.8, 3, 4, 5, 5.5].map(t => discs(two, t).length).join(' '))
      // and the disc replaces the cursor rather than standing beside it
      is('a touch take draws no arrow, no badge and no name tag',
        !Marks.at({ erase: [], redact: [], blur: [], focus: [], steps: [], loupe: [], arrow: [], pointer: two }, 3).pointer &&
        !two.badge.length && !two.tags.length && !two.clicks.length && two.rippleOn === false, 'pointer null')

      // A held tap is one finger, drawn where the ease has carried it. Two taps are two
      // marks that never travel toward each other.
      const held = plan([{ id: 'f1', t: 3, x: 0.3, y: 0.3, click: true }, { id: 'f1', t: 4, x: 0.7, y: 0.6 }])
      const mid = discs(held, 3.5)
      is('a held tap is one disc gliding, not two and not a trail',
        mid.length === 1 && Math.abs(mid[0].x - 0.5 * W) < 1 && Math.abs(mid[0].y - 0.45 * H) < 1,
        `${mid.length} disc at ${mid[0].x.toFixed(1)},${mid[0].y.toFixed(1)}`)
      const pair = discs(plan([{ id: 'a', t: 3, x: 0.43, y: 0.34, click: true }, { id: 'b', t: 3.05, x: 0.57, y: 0.58, click: true }]), 3.1)
      is('two fingers 50 ms apart are two discs, each where its own tap landed',
        pair.length === 2 && Math.abs(pair[0].x - pair[1].x) > 0.13 * W, `${pair.length} discs`)

      // It arrives and leaves the way the badges do, and it presses on contact: three
      // closed forms of the time since the tap, and nothing else.
      const one = plan(tap)
      const app = discs(one, 2.955)[0], land = discs(one, 3)[0], press = discs(one, 3.03)[0], gone = discs(one, 3.25)[0]
      is('it grows in as it comes down, squashes on contact and settles back as it lifts',
        app.op > 0.4 && app.op < 0.6 && app.scale < 0.93 && land.op === 1 && land.scale === 1 &&
        press.scale < 0.95 && gone.op < 0.7 && gone.scale < 1,
        `approach ${app.scale.toFixed(3)}, contact ${land.scale.toFixed(3)}, press ${press.scale.toFixed(3)}, lift ${gone.scale.toFixed(3)} at op ${gone.op.toFixed(2)}`)
      // and every one of those is a function of t alone: 40 frames asked for backwards
      // are the 40 asked for forwards, which is what the stateless golden then proves in
      // pixels as well
      const fwd = range(0, 39).map(i => JSON.stringify(discs(held, 2.9 + i / 30)))
      const back = range(0, 39).map(i => 39 - i).map(i => JSON.stringify(discs(held, 2.9 + i / 30))).reverse()
      is('and each is a closed form of t: 40 frames backwards are the 40 forwards',
        fwd.join('|') === back.join('|'), `${fwd.filter((x, i) => x !== back[i]).length} of 40 differ`)
    }

    if (want('hold')) {
      console.log('sample and hold, in the file')
      // from the start across a cut, from a trimmed start (the decode seeks), and a file
      // whose timestamps start at 1.5 s (an import or a remux: the picks count from its start)
      const offset = path.join(FIX, 'offset.mov')
      for (const [label, edit, file] of [['across a cut', { cuts: [[3.2, 6.9]] }, take], ['from a trimmed start', { start: 5.3, end: 11, cuts: [[8, 9]] }, take],
        ['a file starting at 1.5 s', { start: 2, end: 9, cuts: [[4, 5]] }, offset]]) {
        const pts = await require('../../ui/compositor/sources').framePts(ffmpeg, file)
        const fmeta = file === take ? meta : await proc.probeMeta(file)
        const opts = { ...edit, quality: 'high', format: 'mp4', dest: path.join(OUT, 'hold.mp4'), engine: 'gl' }
        const r = await host.exportEdit(file, opts, null, 'gl-test-hold')
        is(`${label}: the compositor drew it`, r.engine === 'gl', r.engine + ' ' + JSON.stringify(r.why))
        const spec = Plan.prepare(opts, fmeta)
        const map = Plan.screenFrames(spec, pts)
        const N = spec.frames
        const probe = spawnSync('/opt/homebrew/bin/ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames,r_frame_rate', '-of', 'csv=p=0', opts.dest]).stdout.toString().trim()
        is(`${label}: one frame per output slot`, probe === `${spec.fps}/1,${N}`, probe + ` want ${spec.fps}/1,${N}`)
        // 60 output frames spread over the file, each must look most like its picked frame
        const ns = Array.from({ length: 60 }, (_, k) => Math.floor((k + 0.5) * N / 60))
        const got = greyFrames(opts.dest, ns)
        const idx = [...new Set(ns.flatMap(n => [map.pick[n] - 1, map.pick[n], map.pick[n] + 1]).filter(i => i >= 0 && i < pts.length))].sort((a, b) => a - b)
        const srcFrames = greyFrames(file, idx)
        const byIdx = new Map(idx.map((i, k) => [i, srcFrames[k]]))
        let right = 0, worst = 99
        for (let k = 0; k < ns.length; k++) {
          const i = map.pick[ns[k]]
          const p = psnr(got[k], byIdx.get(i))
          worst = Math.min(worst, p)
          const others = [i - 1, i + 1].filter(j => byIdx.has(j)).map(j => psnr(got[k], byIdx.get(j)))
          if (others.every(o => p > o)) right++
        }
        is(`${label}: every sampled frame is the source frame the plan picked`, right === ns.length, `${right}/${ns.length}, worst ${worst.toFixed(1)} dB`)
        const dur = +spawnSync('/opt/homebrew/bin/ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', opts.dest]).stdout
        is(`${label}: length is the kept length`, Math.abs(dur - spec.span) < 0.05, `${dur} s, want ${spec.span.toFixed(3)}`)
      }
    }

    if (want('cuts')) {
      console.log('what a transition does at a cut, and how the take arrives')
      // A take whose screen never changes: both sides of a cut in it are the same
      // pixels, which is a dead air cut with the question the round asked settled at
      // the limit. It is also the one take where the only thing moving on the frame is
      // the transition itself, so a progression can be read straight off the pixels.
      const still = path.join(FIX, 'still.mov')
      const smeta = await proc.probeMeta(still)
      const sbase = { ffmpeg, src: still, meta: smeta, width: 640 }
      const cutOpts = kind => ({ backdrop: 'dusk', inset: 0.08, cuts: [[2, 4]], look: { ...look, motion: { cutTransition: kind } } })
      // the boundary is output frame 60: 2 s of the take kept, at 30 fps
      const rs = await call('moved', { ...sbase, opts: cutOpts('none'), n: 60 },
        [{ ...sbase, opts: cutOpts('crossfade'), n: 60 }, { ...sbase, opts: cutOpts('dip'), n: 60 }])
      is('a dissolve at a dead air cut is the hard cut, to the bit', rs[0].max === 0, `max ${rs[0].max} LSB, mean ${rs[0].mean}`)
      is('a dip at the same cut is a hole in it', rs[1].mean > 8, `max ${rs[1].max} LSB, mean ${rs[1].mean}`)
      // and the same pair on a take whose screen does change, which is what a dissolve
      // is for: the other end of the bracket, printed rather than gated
      const mv = await call('moved', { ...base, opts: { backdrop: 'dusk', inset: 0.08, cuts: [[3, 7]], look }, n: 90, width: 640 },
        [{ ...base, opts: cases['cut-dissolve'].opts, n: 90, width: 640 }])
      console.log(`  (on a moving take the same dissolve moves max ${mv[0].max} LSB, mean ${mv[0].mean})`)

      // The dip frame by frame, measured against the settled frame this take holds all
      // the way through: how far the picture has gone, per frame. It is the take's own
      // pixels that leave, so this is the transition and nothing else.
      const dip = await call('march', { ...sbase, opts: cutOpts('dip'), n: 60 }, [56, 57, 58, 59, 60, 61, 62, 63, 64], 50)
      const g = dip.map(d => d.diff)
      const top = g.indexOf(Math.max(...g))
      is('the dip is deepest on the cut, to the frame', dip[top].n === 60, dip.map(d => `${d.n}:${d.diff}`).join(' '))
      is('and monotone into it and out of it',
        g.slice(0, top + 1).every((v, i) => i === 0 || v >= g[i - 1]) && g.slice(top).every((v, i) => i === 0 || v <= g[top + i - 1]), true)
      is('and it is over by the frames the plan names', g[0] === 0 && g[1] === 0 && g[g.length - 1] === 0 && g[g.length - 2] === 0,
        `${g[0]} ${g[1]} into it, ${g[g.length - 2]} ${g[g.length - 1]} out`)

      // The push, the same way. It lives entirely after the boundary, so on this take
      // the first frame that differs from the settled one is the cut's own frame, it is
      // the deepest, and it settles out without turning round. 0.35 s at 30 fps is ten
      // frames, so frame 70 is the first one back at rest.
      const push = await call('march', { ...sbase, opts: cutOpts('zoom'), n: 60 }, range(57, 72), 50)
      const q = push.map(v => v.diff)
      is('the push starts on the frame the cut lands on, and it is the deepest there',
        q[0] === 0 && q[1] === 0 && q[2] === 0 && q[3] > 0 && push[q.indexOf(Math.max(...q))].n === 60,
        push.map(v => `${v.n}:${v.diff}`).join(' '))
      is('and it settles out without turning round', q.slice(3, 14).every((v, i) => i === 0 || v <= q[3 + i - 1]), true)
      is('and it is landed by the frame the plan names', q[13] === 0 && q[14] === 0 && q[15] === 0,
        `70: ${q[13]}, 71: ${q[14]}`)

      // The dissolve, on the moving take, where it is a picture rather than nothing.
      // Each frame of the window is drawn twice, once with the transition and once with
      // the hard cut at the same output time, so what is measured is the dissolve alone
      // and not the take's own movement. Before the boundary the hard cut is the
      // outgoing side and the dissolve carries the incoming one at `mix`; after it the
      // two swap. So the difference rises to the boundary frame, peaks there where the
      // mix is exactly half, and falls away, and it is zero outside the window.
      const hard = { backdrop: 'dusk', inset: 0.08, cuts: [[3, 7]], look }
      const cross = []
      for (const n of range(86, 94)) {
        const rs2 = await call('moved', { ...base, opts: hard, n, width: 640 },
          [{ ...base, opts: cases['cut-dissolve'].opts, n, width: 640 }])
        cross.push({ n, mean: rs2[0].mean, max: rs2[0].max })
      }
      const cm = cross.map(v => v.mean)
      const topN = cross[cm.indexOf(Math.max(...cm))].n
      is('a dissolve crosses over on the frame the timeline names', topN === 90, cross.map(v => `${v.n}:${v.mean}`).join(' '))
      is('and it rises into that frame and falls out of it',
        cm.slice(0, 5).every((v, i) => i === 0 || v >= cm[i - 1]) && cm.slice(4).every((v, i) => i === 0 || v <= cm[4 + i - 1]), true)
      is('and outside its window the frame is the hard cut, to the bit',
        cm[0] === 0 && cm[1] === 0 && cm[cm.length - 1] === 0 && cm[cm.length - 2] === 0,
        `${cm[0]} ${cm[1]} in, ${cm[cm.length - 2]} ${cm[cm.length - 1]} out`)

      // The take arriving. Against the settled frame: the difference falls every frame
      // and is gone on the first frame at or after the reveal's own length.
      const rise = await call('march', { ...sbase, opts: { backdrop: 'dusk', inset: 0.08, look }, n: 0 },
        [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 20)
      const d = rise.map(x => x.diff)
      is('the take arrives without ever turning back',
        d.every((v, i) => i === 0 || (d[i - 1] === 0 ? v === 0 : v < d[i - 1])) && d[0] > 40, d.join(' '))
      // the reveal is 0.36 s and this take goes out at 30 fps, so frame 10 is still on
      // its way and frame 11 is the first one at or after it
      is('and has landed on the frame the plan names, 0.36 s in', d[10] > 0 && d[11] === 0 && d[12] === 0, `10: ${d[10]}, 11: ${d[11]}`)
      const none = await call('moved', { ...sbase, opts: { backdrop: 'dusk', inset: 0.08, look }, n: 3 },
        [{ ...sbase, opts: { backdrop: 'dusk', inset: 0.08, look: { ...look, motion: { reveal: 'none' } } }, n: 3 }])
      is('reveal none is the hard frame it always was', none[0].max > 8, `max ${none[0].max} LSB`)
    }

    if (want('device')) {
      console.log('the drawn frame, the tilt and the loupe')
      // Every one of them against the same look without it: a device, its address, its
      // tone, a tilt and a loupe all have to reach a pixel, and the ones that cost
      // nothing when they are off have to cost nothing.
      const one = (o, n = 150) => ({ ...base, opts: { backdrop: 'ink', inset: 0.07, ...o }, n, width: 640 })
      const dev = (d, f) => one({ look: { ...look, device: d, ...(f ? { frame: { border: 0, ...f } } : {}) } })
      const kinds = ['browser', 'window', 'laptop', 'phone']
      const rs = await call('moved', one({ look }), [
        ...kinds.map(k => dev({ kind: k })),
        dev({ kind: 'browser', title: 'songscription.app' }),
        dev({ kind: 'browser', theme: 'light' }),
        one({ look: { ...look, frame: { border: 0, tilt: 12 } } }),
        one({ look: { ...look, frame: { border: 0, tilt: 0 } } }),
      ])
      kinds.forEach((k, i) => is(`device.kind ${k} draws a frame`, rs[i].max > 8, `max ${rs[i].max} LSB, mean ${rs[i].mean}`))
      // the address and the tone against the plain browser frame, not against no frame
      const br = await call('moved', dev({ kind: 'browser' }), [dev({ kind: 'browser', title: 'songscription.app' }), dev({ kind: 'browser', theme: 'light' })])
      is('device.title writes the address into the bar', br[0].max > 8, `max ${br[0].max} LSB`)
      is('device.theme light is another shell', br[1].max > 8, `max ${br[1].max} LSB`)
      // A recording reaches the no-field rule too, and should: the bar is taller than a
      // window's because an address field stands in it, and with nothing to put in the
      // field there is no field and no toolbar. Said in pixels here because every other
      // browser golden carries a host-shaped title and so could not see it. A window
      // title is not an address, which is the other half: a filename is the commonest
      // window title there is and none of them may be drawn in the pill.
      const devOf = d => Plan.prepare({ start: 0, end: 4, cuts: [], backdrop: 'ink', inset: 0.07,
        look: { ...look, device: d } }, meta, {}).device
      const barOf = t => devOf({ kind: 'browser', ...(t == null ? {} : { title: t }) })
      const bare = barOf(null), host9 = barOf('songscription.app'), win = devOf({ kind: 'window', title: 'Library' })
      is('a recording\'s browser bar with no address is a title bar, not a toolbar',
        !bare.address && Math.abs(bare.bar / bare.unit - win.bar / win.unit) < 0.001 && host9.bar > bare.bar,
        `bare ${Math.round(bare.bar)} px, window ${Math.round(win.bar)} px, with an address ${Math.round(host9.bar)} px`)
      for (const name of ['README.md', 'notes.txt', 'index.html', 'build.sh']) {
        is(`a window called ${name} is not drawn as an address`, barOf(name).address === false, 'it was')
      }
      is('and a host still is', barOf('songscription.example.com').address === true, 'it was not')
      // frame.chrome clean draws the browser frame only where the real chrome could be
      // cropped off. With no viewport nothing was cropped, so a drawn browser would sit
      // round the real one: it draws nothing, and the frame is the one it always was.
      const page = { x: 0, y: 0.12, w: 1, h: 0.88 }
      const cl = o => one({ crop: page, ...o, look: { ...look, frame: { border: 0, chrome: 'clean' } } })
      const ch = await call('moved', cl({ viewport: page }), [cl({})])
      is('frame.chrome clean draws a browser where the page\'s place is known', ch[0].max > 8, `max ${ch[0].max} LSB`)
      const kept = await call('moved', cl({}), [one({ crop: page, look: { ...look, frame: { border: 0, chrome: 'keep' } } })])
      is('and where it is not the frame is the one it always was', kept[0].max === 0, `max ${kept[0].max} LSB`)
      // The shell's tone follows the ground, and a photo ground is only known once it is
      // decoded: the plan cannot read it, so gl.js picks it there (deviceOf). This
      // fixture is a bright picture, so it takes the bone shell, and dimmed it takes the
      // graphite one, which is what four of the five backdrops we ship ask for.
      const img = (d, dim) => ({ ...base, width: 640, n: 150, ctx: { imageFile: path.join(FIX, 'bg.jpg') },
        opts: { backdrop: 'img:bg.jpg', inset: 0.07, look: { ...look, device: { kind: 'browser', ...d }, background: { imageDim: dim } } } })
      const tone = await call('moved', img({}, 0), [img({ theme: 'light' }, 0), img({ theme: 'dark' }, 0)])
      is('an auto shell on a light photo is the bone one', tone[0].max === 0 && tone[1].max > 8,
        `light ${tone[0].max} LSB, dark ${tone[1].max} LSB`)
      const dark = await call('moved', img({}, 0.7), [img({ theme: 'dark' }, 0.7), img({ theme: 'light' }, 0.7)])
      is('and on a dark one it is graphite', dark[0].max === 0 && dark[1].max > 8,
        `dark ${dark[0].max} LSB, light ${dark[1].max} LSB`)
      is('frame.tilt turns the take', rs[6].max > 8, `max ${rs[6].max} LSB, mean ${rs[6].mean}`)
      is('and a tilt of nothing is the frame it always was, to the bit', rs[7].max === 0, `max ${rs[7].max} LSB`)
      // the loupe, and the dial that says how far it magnifies
      const gl = cases['loupe'].opts
      const ls = await call('moved', { ...base, opts: { ...gl, marks: gl.marks.filter(m => m.kind !== 'loupe') }, n: 150, width: 640 },
        [{ ...base, opts: gl, n: 150, width: 640 },
          { ...base, opts: { ...gl, look: { ...look, focus: { loupe: 3.6 } } }, n: 150, width: 640 }])
      is('a loupe draws a magnified inset', ls[0].max > 8, `max ${ls[0].max} LSB, mean ${ls[0].mean}`)
      is('focus.loupe says how far it magnifies', ls[1].max > 8 && Math.abs(ls[1].mean - ls[0].mean) > 0.05,
        `max ${ls[1].max} LSB, mean ${ls[1].mean} against ${ls[0].mean}`)
      // What the edit hides stays hidden at magnification. The loupe reads the content
      // target after the redaction has destroyed what it covers, so taking the
      // redaction away has to change the inset as well as the area it copies.
      const hid = await call('moved', { ...base, opts: gl, n: 150, width: 640 },
        [{ ...base, opts: { ...gl, marks: gl.marks.filter(m => m.kind !== 'redact') }, n: 150, width: 640 }])
      is('a redaction under a loupe is redacted inside it too', hid[0].max > 8, `max ${hid[0].max} LSB`)
    }

    if (want('blur')) {
      console.log('the smear is the travel, not a setting')
      // treatment.motionBlur is the shutter angle and nothing else: what smears is the
      // zoom's own velocity at that instant. So the same frame with the shutter shut
      // says how much of the golden is the move, and a frame the zoom is holding on has
      // to come back byte for byte whatever the shutter is, because a camera at rest
      // exposes nothing but the frame it is on.
      const shut = o => ({ ...o, look: { ...look, treatment: { ...look.treatment, motionBlur: 0 } } })
      const wide = o => ({ ...o, look: { ...look, treatment: { ...look.treatment, motionBlur: 1 } } })
      const mid = cases['zoom-glide'], held = cases['zoom-hold']
      const rs = await call('moved', { ...base, ...mid, width: 640 },
        [{ ...base, ...mid, opts: shut(mid.opts), width: 640 }, { ...base, ...mid, opts: wide(mid.opts), width: 640 }])
      is('mid zoom, the shutter open against the same frame with it shut', rs[0].max > 40 && rs[0].mean > 1,
        `max ${rs[0].max} LSB, mean ${rs[0].mean}, over 2 LSB ${rs[0].over2}%`)
      is('and a 360 degree shutter smears further still', rs[1].max > 0 && rs[1].mean > rs[0].mean * 0.3,
        `max ${rs[1].max} LSB, mean ${rs[1].mean}`)
      const h = await call('moved', { ...base, ...held, width: 640 },
        [{ ...base, ...held, opts: shut(held.opts), width: 640 }, { ...base, ...held, opts: wide(held.opts), width: 640 }])
      is('a frame the zoom is holding on is the same frame at any shutter',
        h[0].max === 0 && h[1].max === 0, `shut ${h[0].max} LSB, wide open ${h[1].max} LSB`)
    }

    if (want('sheet')) {
      console.log('the whole edit in one picture')
      // A contact sheet is how an agent sees motion rather than a moment: a dozen
      // frames of the output at once, drawn by the compositor, each with its output
      // time on it. So what has to be true is that every cell is the frame the plan
      // names at the time burned into it, that the cells move (a stale compositor
      // handing back the picture before would read as an edit that never cuts), and
      // that the sheet is the edit and not the file: a cut out of the middle is
      // nowhere on it.
      const keep = [[0.5, 4], [8, 11.5]]
      const doc = {
        v: 2, src: take, dur: meta.duration,
        clips: keep.map(([start, end], i) => ({ id: 'C' + (i + 1), start, end })),
        zooms: [{ id: 'Z1', start: 1, end: 3.4, scale: 1.8, x: 0.35, y: 0.4 }],
        look: { background: { kind: 'gradient', gradient: 'dusk' }, treatment: { motionBlur: 0.5 } },
      }
      // Grey pixels of part of a picture, given as fractions of it, so a cell of the
      // sheet and a still of its own size can be compared without knowing either size
      const greyOf = (file, box, w = 192, h = 120) => {
        const vf = `crop=iw*${box.w}:ih*${box.h}:iw*${box.x}:ih*${box.y},scale=${w}:${h}:flags=area,format=gray`
        const r = spawnSync(ffmpeg, ['-v', 'error', '-i', file, '-vf', vf, '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 26 })
        if (!r.stdout || r.stdout.length < w * h) throw new Error('could not read ' + file + ': ' + String(r.stderr || r.error).slice(0, 200))
        return r.stdout.subarray(0, w * h)
      }
      const mad = (a, b) => { let s = 0; for (let k = 0; k < a.length; k++) s += Math.abs(a[k] - b[k]); return s / a.length }
      const size = f => spawnSync('/opt/homebrew/bin/ffprobe', ['-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height', '-of', 'csv=p=0', f]).stdout.toString().trim()

      const sh = await host.contactSheet(take, doc, { count: 12, width: 1200 }, 'gl-test-sheet')
      is('a sheet of the whole edit is one picture', sh.frames.length === 12 && sh.cols * sh.rows === 12
        && size(sh.file) === `${sh.width},${sh.height}`, `${sh.cols}x${sh.rows}, ${size(sh.file)}, ${sh.ms} ms`)

      // the label sits in the bottom of a cell, so only the top of one is compared
      const cellBox = i => ({
        x: (i % sh.cols) * (sh.cell.w + sh.cell.gap) / sh.width,
        y: Math.floor(i / sh.cols) * (sh.cell.h + sh.cell.gap) / sh.height,
        w: sh.cell.w / sh.width, h: sh.cell.h * 0.72 / sh.height,
      })
      const top = { x: 0, y: 0, w: 1, h: 0.72 }
      let worst = 99, where = ''
      for (const i of [0, 5, 11]) {
        const [still] = await host.previewFrames(take, doc, [sh.frames[i].source], { width: Math.round(1200 / sh.cols) })
        const p = psnr(greyOf(sh.file, cellBox(i)), greyOf(still.file, top))
        if (p < worst) { worst = p; where = `cell ${i}, ${sh.frames[i].at}s out of ${sh.frames[i].source}s in` }
      }
      is('every cell is the frame preview_frame draws at the time on it', worst > 26, `worst ${worst.toFixed(1)} dB, ${where}`)

      // A compositor kept between the stills of one job can hand back the picture
      // before, and on a sheet that reads as an edit that never moves, so no two cells
      // may be the same picture, not just no two neighbours.
      const cells = sh.frames.map((_, i) => greyOf(sh.file, cellBox(i), 288, 180))
      const pairs = cells.flatMap((c, i) => cells.slice(i + 1).map(d => mad(c, d)))
      is('the cells move: no two are the same picture', Math.min(...pairs) > 1,
        `closest pair differs by ${Math.min(...pairs).toFixed(2)} of 255`)

      is('the cut is nowhere on the sheet', sh.frames.every(f => keep.some(([a, b]) => f.source >= a - 0.05 && f.source <= b + 0.05)),
        sh.frames.map(f => f.source).join(', '))

      const win = await host.contactSheet(take, doc, { from: 2, to: 5, count: 6, width: 900 }, 'gl-test-sheet-win')
      is('from and to window the sheet, in output seconds',
        win.frames.length === 6 && win.from === 2 && win.to === 5 && win.frames.every(f => f.at >= 2 && f.at <= 5),
        `${win.from} to ${win.to} of ${win.span}: ${win.frames.map(f => f.at).join(', ')}`)

      const big = await host.contactSheet(take, doc, { count: 40, width: 1200 }, 'gl-test-sheet-max')
      is('never more than 24 frames', big.frames.length === 24 && big.cols * big.rows === 24,
        `${big.frames.length} frames, ${big.cols}x${big.rows}, ${big.ms} ms`)
    }

    if (want('shots')) {
      console.log('a screenshot is a take of one frame')
      // A still goes through the plan an export goes through and the passes an export
      // draws, in the same compositor; the only thing that differs is that the content
      // slot is filled from a captured picture rather than a decoded one. So what is
      // checked here is not the look, which the goldens above already hold: it is the
      // two things a still has and a clip has not. It exists at more than one size, and
      // nothing stands between the drawn frame and the file someone opens.
      const src = shotFixture()
      // Everything a styled screenshot is made of, in one picture: a ground, a browser
      // frame, a gold keyline, the row with the tempo lifted with its step badge, an
      // arrow at another row, a loupe on the corner, and the address redacted.
      const shotLook = { treatment: { motionBlur: 0.5 }, frame: { border: 2, borderColor: '#F0A93C' },
        grain: { dither: false }, device: { kind: 'browser', title: 'fetch.app' } }
      const shotOpts = { backdrop: 'dusk', inset: 0.07, shadow: 0.6, look: shotLook, marks: [
        { kind: 'redact', start: 0, end: 4, x: 0.79, y: 0.175, w: 0.16, h: 0.05 },
        { kind: 'lift', start: 0, end: 4, x: 0.05, y: 0.395, w: 0.62, h: 0.08 },
        { kind: 'step', start: 0, end: 4, x: 0.05, y: 0.395 },
        { kind: 'arrow', start: 0, end: 4, x: 0.70, y: 0.55, w: 0.14, h: 0.07 },
        { kind: 'loupe', start: 0, end: 4, x: 0.17, y: 0.60, w: 0.16, h: 0.06 },
      ] }
      // The same still with nothing over the take but a redaction, and nothing gold in
      // the frame but the keyline. A lift blurs and dims everything outside the row it
      // raises, which is the point of it, and a drawn device puts the take inside a
      // shell rather than across the plan's own box; both are exactly what the styled
      // still is for and both are in the way of measuring a pixel. So the measurements
      // below run on this one, where the take fills spec.rect and the ground is ink.
      const plainOpts = { backdrop: 'ink', inset: 0.07, shadow: 0.6,
        look: { treatment: { motionBlur: 0.5 }, frame: { border: 2, borderColor: '#F0A93C' }, grain: { dither: false } },
        marks: [{ kind: 'redact', start: 0, end: 4, x: 0.79, y: 0.175, w: 0.16, h: 0.05 }] }
      const { spec: shotSpec, size: cap } = host.shotPlan(src, shotOpts)
      const { spec: plainSpec } = host.shotPlan(src, plainOpts)
      const shot = (tag, out) => host.renderShot(src, shotOpts, { ...out, dest: path.join(OUT, tag) }, 'gl-test-' + tag)
      const plain = (tag, out) => host.renderShot(src, plainOpts, { ...out, dest: path.join(OUT, tag) }, 'gl-test-' + tag)

      // The golden, at the width every other golden here is kept at
      const gold = path.join(GOLD, 'shot-styled.png')
      const small = await shot('shot-styled.png', { width: 640 })
      if (update || !fs.existsSync(gold)) { fs.copyFileSync(small.file, gold); is('shot-styled written', true, `${small.w}x${small.h}`) }
      else {
        const d = step(rgbOf(small.file), rgbOf(gold))
        is('a ground, a browser frame, a lift, a loupe, an arrow and a redaction in one still',
          d.max <= 2 && d.mean < 0.05, `max ${d.max} LSB, mean ${d.mean}`)
      }

      // A store deliverable is a pair of integers, and the only reading of one that
      // counts is the file's own header. Drawn at a width and a shape, every preset but
      // the one that divides evenly came out a pixel short on the height, and a file a
      // pixel out is rejected at upload after the writing, the shooting and the styling
      // are all done, with nothing to say which step lied.
      const Sizes = require('../../ui/sizes')
      const ihdr = f => { const b = fs.readFileSync(f); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) } }
      for (const id of ['app-store-6.9', 'app-store-13']) {
        const P = Sizes.get(id)
        const made = await host.renderShot(src, { ...plainOpts, backdropAspect: P.w / P.h },
          { size: { w: P.w, h: P.h }, dest: path.join(OUT, `store-${id}.png`) }, 'gl-test-store-' + id)
        const got = ihdr(made.file)
        is(`${id} is exactly ${P.w} by ${P.h}, read from the file's own header`,
          got.w === P.w && got.h === P.h, `${got.w}x${got.h}`)
      }

      // The sizes. A plan is one plan at one size and a bigger still is that same plan
      // drawn at a multiple of it, so each has to come out at exactly k times the plan.
      const at = {}
      for (const k of [1, 2, 3]) {
        at[k] = await shot(`shot-${k}x.png`, { scale: k })
        is(`${k}x is the plan at ${k} times its own size`,
          at[k].w === shotSpec.W * k && at[k].h === shotSpec.H * k && at[k].scale === k,
          `${at[k].w}x${at[k].h}, ${(at[k].bytes / 1e6).toFixed(1)} MB, ${at[k].ms} ms`)
      }
      // native is the capture at one to one: the take's box is rect.w plan pixels wide
      // and the capture has crop.w to fill it, so that ratio is the multiple, and it is
      // not rounded down to a named size. A 3420 px capture through this plan wants about
      // 2.38, and shipping it at 2 throws away a sixth of what was captured for nothing.
      const want11 = shotSpec.crop.w / shotSpec.rect.w
      const nat = await shot('shot-native.png', {})
      is('native is the capture at one to one', Math.abs(nat.w / shotSpec.W - want11) < 0.01,
        `${(nat.w / shotSpec.W).toFixed(3)}x against ${want11.toFixed(3)}, ${nat.w}x${nat.h} from a ${cap.width}x${cap.height} capture`)

      // One picture, more pixels. Scaled back down, a bigger still has to be the small
      // one: a second layout, a second look pipeline or anything laid out in output
      // pixels rather than plan pixels would drift here and nowhere else.
      const one = rgbOf(at[1].file)
      for (const k of [2, 3]) {
        const down = path.join(OUT, `shot-${k}x-down.png`)
        spawnSync('/opt/homebrew/bin/ffmpeg', ['-v', 'error', '-y', '-i', at[k].file,
          '-vf', `scale=${shotSpec.W}:${shotSpec.H}:flags=area`, '-frames:v', '1', down])
        const d = step(one, rgbOf(down))
        is(`${k}x scaled back down is the 1x picture`, d.mean < 4, `mean ${d.mean} levels, max ${d.max}`)
      }

      // Now the plain still, at the same three sizes, where a pixel can be read.
      const pl = {}
      for (const k of [1, 2, 3]) pl[k] = await plain(`shot-plain-${k}x.png`, { scale: k })

      // Fetch's own hairline at each size. The plan draws a 2 px gold keyline round the
      // take, so at k it is 2k pixels wide and its edge is still about one pixel: drawn
      // at the size rather than enlarged into it. A line that vanished, doubled or went
      // soft would show in one of those two numbers.
      for (const k of [1, 2, 3]) {
        const g = goldRuns(rgbOf(pl[k].file), pl[k].w, pl[k].h)
        is(`${k}x keeps the gold keyline`, g.width === 2 * k && g.rise <= 1,
          `${g.width} px wide, ${g.rise} px of edge, ${g.n} runs`)
      }

      // The capture's own text and hairlines, read in a clean part of the take. What a
      // still promises is that the pixels that were captured are the pixels in the file,
      // and at native they are. At 1x the capture is area-averaged into fewer pixels,
      // which softens its contrast and is the honest thing to do with it; what must not
      // happen at any size is that a step turns into a ramp.
      const box = (spec, k, x, y, w, h) => ({
        x: Math.round((spec.rect.x + spec.rect.w * x) * k), y: Math.round((spec.rect.y + spec.rect.h * y) * k),
        w: Math.round(spec.rect.w * w * k), h: Math.round(spec.rect.h * h * k),
      })
      const takeRuns = {}
      for (const k of [1, 2, 3]) takeRuns[k] = stepRuns(rgbOf(pl[k].file), pl[k].w, box(plainSpec, k, 0.16, 0.09, 0.17, 0.22))
      is('the capture\'s own text is a step at every size, never a ramp',
        [1, 2, 3].every(k => takeRuns[k].rise <= 2 && takeRuns[k].n > 100),
        [1, 2, 3].map(k => `${k}x rises in ${takeRuns[k].rise} px over ${takeRuns[k].n} edges`).join(', '))
      is('and it carries more of its contrast the more pixels it is given',
        takeRuns[3].contrast >= takeRuns[2].contrast && takeRuns[2].contrast >= takeRuns[1].contrast,
        [1, 2, 3].map(k => `${k}x ${takeRuns[k].contrast} levels`).join(', '))

      // A redaction has to destroy what is under it, and a still at 3x is where someone
      // would go looking. What it leaves is cells of one colour, so inside its box
      // nothing is finer than a cell, and the cell grows with the size: a screenshot at
      // 3x carries no more of what was hidden than one at 1x, only bigger blocks of it.
      // a fifth in from each side, so the box is the redaction and not its own edge
      const redBox = k => box(plainSpec, k, 0.79 + 0.16 * 0.2, 0.175 + 0.05 * 0.2, 0.16 * 0.6, 0.05 * 0.6)
      const cells = [1, 2, 3].map(k => finest(rgbOf(pl[k].file), pl[k].w, redBox(k)))
      is('inside a redaction nothing is finer than its own cell, at any size',
        cells.every((c, i) => c >= 8 * (i + 1)),
        [1, 2, 3].map((k, i) => `${k}x nothing under ${cells[i]} px`).join(', '))
      // and the cell is over the words rather than beside them: the same still with the
      // mark taken off is a different picture in exactly that box
      const bare = await host.renderShot(src, { ...plainOpts, marks: [] }, { scale: 1, dest: path.join(OUT, 'shot-bare-1x.png') }, 'gl-test-shot-bare')
      const bx = redBox(1), bp = rgbOf(bare.file), rp = rgbOf(pl[1].file)
      let gone = 0, n = 0
      for (let y = bx.y; y < bx.y + bx.h; y++) for (let x = bx.x; x < bx.x + bx.w; x++) {
        gone += Math.abs(lumaAt(rp, pl[1].w, x, y) - lumaAt(bp, bare.w, x, y)); n++
      }
      is('and it is over the words rather than beside them', gone / n > 3, `${(gone / n).toFixed(1)} levels of the take replaced`)

      // The file. A PNG is the default because this pipeline draws hairlines and small
      // text on flat fields, which is where JPEG's chroma and its ringing are visible;
      // the JPEG is still the same picture, an order of magnitude smaller.
      const jpg = await shot('shot-1x.jpg', { scale: 1, format: 'jpg' })
      const dj = step(one, rgbOf(jpg.file))
      is('a JPEG of the same still is the same picture, much smaller',
        jpg.format === 'jpg' && jpg.bytes < at[1].bytes / 3 && dj.mean < 2,
        `${(jpg.bytes / 1e6).toFixed(2)} MB against ${(at[1].bytes / 1e6).toFixed(2)} MB, mean ${dj.mean} levels`)

      // And a PNG is opaque, so nobody opens a screenshot and finds a hole in it
      const alpha = spawnSync('/opt/homebrew/bin/ffmpeg', ['-v', 'error', '-i', at[1].file,
        '-vf', 'extractplanes=a', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 30 }).stdout
      is('the PNG is opaque', alpha && alpha.length > 0 && !alpha.includes(0), `${alpha ? alpha.length : 0} bytes of alpha`)

      // A still is one frame and reads nothing before it, which is the rule the whole
      // compositor is built on, said at the size a screenshot is actually delivered at.
      const again = await shot('shot-1x-again.png', { scale: 1 })
      is('a still drawn again is the same still, byte for byte', step(one, rgbOf(again.file)).max === 0,
        `max ${step(one, rgbOf(again.file)).max} LSB`)
      console.log(`  (1x ${at[1].ms} ms, 2x ${at[2].ms} ms, 3x ${at[3].ms} ms)`)

      // More than one capture in one picture, through the export's own door rather than
      // through the harness's own draw: render-host measures each member from its own
      // header and checks every file is there, and compositor/index.js fills one slot
      // per member. This is the chain the Export PNG button and the export tool take.
      const gDesk = member('desk'), gHand = member('hand')
      const groupOpts = { ...plainOpts, marks: [],
        group: { gap: 0.06, align: 'stand', members: [gDesk, gHand] } }
      const gFile = await host.renderShot(gDesk.src, groupOpts,
        { width: 900, dest: path.join(OUT, 'shot-group.png') }, 'gl-test-shot-group')
      is('a group reaches the file through the one export path', gFile.w === 900 && gFile.h > 0,
        `${gFile.w}x${gFile.h} from two captures`)
      // A member whose file is not there is said rather than drawn as a size mismatch
      // about a picture nobody asked about.
      const missing = await host.renderShot(gDesk.src,
        { ...groupOpts, group: { members: [gDesk, { ...gHand, src: '/tmp/fetch-no-such-capture.png' }] } },
        { width: 200, dest: path.join(OUT, 'shot-group-missing.png') }, 'gl-test-shot-missing')
        .then(() => null, e => e.message)
      is('and a member with no file is named by name', /fetch-no-such-capture\.png/.test(missing || ''),
        missing || 'it drew something instead')

      // native on a group is the sharpest member at one to one, which is the member
      // somebody will look at closely; the small one beside it was never going to carry
      // a hairline. Snapped to a named size inside the few percent of minifying nobody
      // can see (compositor/index.js SHOT_SOFT), and held at 3.
      const odd2 = { ...plainOpts, marks: [],
        group: { gap: 0.06, align: 'stand', members: [member('wall'), member('tiny')] } }
      const { spec: gSpec } = host.shotPlan(GROUP_PICS.wall.file, odd2)
      const gWant = Math.min(3, Math.max(...gSpec.group.map(m => m.crop.w / m.rect.w)))
      const gNat = await host.renderShot(GROUP_PICS.wall.file, odd2,
        { scale: 'native', dest: path.join(OUT, 'shot-group-native.png') }, 'gl-test-shot-native')
      is('native on a group is its sharpest capture at one to one', Math.abs(gNat.scale / gWant - 1) <= 0.05,
        `${gNat.scale.toFixed(3)}x against ${gWant.toFixed(3)}, ${gNat.w}x${gNat.h}`)
    }

    if (want('type')) {
      console.log('a still carries a line of type')
      // The fault this answers: a still could not carry text, so "make it a help centre
      // hero" came back as a window on a gradient. A hero is the thing with the headline.
      //
      // What a finished picture needs is here, one case each: a headline, a subhead under
      // it, a caption under the image, a label pinned to a point in the picture and a
      // callout that points at one. The goldens hold how it is set. The measurements
      // below hold the one thing that makes this a layout and not another pass over the
      // frame: the type never lies on the product, and the picture gets out of its way by
      // exactly the room the type took.
      const src = shotFixture()
      const phone = member('hand')
      // studio, because that ground is a light rather than a palette, so the type has to
      // read over a warm key in one corner and a deep neutral in the other
      const tBase = { backdrop: 'studio', inset: 0.07, shadow: 0.6, backdropAspect: 16 / 9,
        look: { grain: { dither: false }, treatment: { motionBlur: 0.5 } } }
      const HEAD = 'Find the moment by what was said'
      const SUB = 'Fetch transcribes on device and keeps every word’s timing, so the timeline is named from the take.'
      const LONG = 'Record the flow once, find the moment by what was actually said, and ship the clip or the picture from the very same document'
      const tCase = {
        // a wide window with the words over it, which is where auto puts them
        'shot-headline': { src, opts: { ...tBase, texts: [{ text: HEAD, style: 'headline' }] } },
        // and the same headline with the quieter line under it, and a caption under the
        // image: the three sizes of a hero's type in one picture
        'shot-headline-sub': { src, opts: { ...tBase, texts: [
          { text: HEAD, subtitle: SUB, style: 'headline' },
          { text: 'The library, a moment after a take lands', style: 'caption' }] } },
        // a handset leaves a column beside it, so auto puts the words there instead
        'shot-headline-beside': { src: phone.src, opts: { ...tBase, inset: 0.06,
          look: { ...tBase.look, device: { kind: 'phone' } },
          texts: [{ text: 'Every take, named from what was said', style: 'headline' }] } },
        // long enough that it cannot be set at the size the look asked for: it wraps to
        // its column, then steps down rather than running past it
        'shot-headline-wrap': { src, opts: { ...tBase, texts: [{ text: LONG, style: 'headline' }] } },
        // a label pinned to a point in the picture, in the take's own fractions, which is
        // where the thing it names is rather than where the canvas happens to be
        'shot-label': { src, opts: { ...tBase, texts: [
          { text: 'Tempo', style: 'label', at: { x: 0.72, y: 0.115 } }] } },
        // and a callout, which says the same and points at it
        'shot-callout': { src, opts: { ...tBase, texts: [
          { text: 'Every row carries its key', style: 'callout', at: { x: 0.86, y: 0.42 } }] } },
      }
      const drawn = {}
      for (const [name, c] of Object.entries(tCase)) {
        drawn[name] = await host.renderShot(c.src, c.opts, { width: 640, dest: path.join(OUT, name + '.png') }, 'gl-test-' + name)
        const gold = path.join(GOLD, name + '.png')
        if (update || !fs.existsSync(gold)) { fs.copyFileSync(drawn[name].file, gold); is(`${name} written`, true, `${drawn[name].w}x${drawn[name].h}`) }
        else {
          const d = step(rgbOf(drawn[name].file), rgbOf(gold))
          is(name, d.max <= 2 && d.mean < 0.05, `max ${d.max} LSB, mean ${d.mean}`)
        }
      }

      // The type is beside the picture, never on it. Measured on the plan rather than on
      // the pixels, because this is the claim the layout makes and the pixels are the
      // consequence: the block's own rectangle and the take's do not meet.
      const planOf = c => host.shotPlan(c.src, c.opts).spec
      const blockOf = S => ({ x: S.x, y: S.top, w: S.col,
        h: S.runs.reduce((h, r) => h + r.lead + r.lineH, 0) })
      const clear = []
      for (const [name, c] of Object.entries(tCase)) {
        const s = planOf(c)
        if (!s.text || !s.text.still || !s.text.still.runs.length) continue
        const b = blockOf(s.text.still), r = s.rect
        const gaps = [r.y - (b.y + b.h), r.x - (b.x + b.w), b.x - (r.x + r.w), b.y - (r.y + r.h)]
        // apart on any one axis is apart, and the gap worth printing is that one
        const gap = Math.max(...gaps)
        const apart = gap >= 0
        clear.push(`${name.slice(5)} ${apart ? gap + ' px' : 'over'}`)
        if (!apart) is(`${name}: the headline is clear of the picture`, false, 'the block lies on the take')
      }
      is('a headline stands clear of the picture in every shape', clear.length === 4, clear.join(', '))

      // And the room came out of the slack first. A wide window in a 16:9 frame already
      // leaves air above and below it, and a headline that made the picture smaller to
      // stand in room nobody was using would be a worse composition for nothing. So what
      // the picture gives up is the block and its gutter less whatever air was there.
      const bareSpec = host.shotPlan(src, tBase).spec
      const headSpec = planOf(tCase['shot-headline'])
      const S1 = headSpec.text.still
      const took = blockOf(S1).h + S1.gutter
      const slackH = headSpec.H * (1 - 2 * 0.07) - bareSpec.rect.h
      const give = Math.max(0, took - slackH)
      is('the type takes its room out of the slack first and the picture gives up the rest',
        Math.abs((bareSpec.rect.h - headSpec.rect.h) - give) <= 4,
        `${bareSpec.rect.h - headSpec.rect.h} px of picture for ${took} px of type, over ${Math.round(slackH)} px of air`)
      is('and the ground behind it did not move', bareSpec.W === headSpec.W && bareSpec.H === headSpec.H,
        `${headSpec.W}x${headSpec.H}`)

      // A headline too long for its column wraps, and then steps down a size rather than
      // running past it. Both have to happen: wrapping alone gives a wall of display type
      // and stepping down alone gives one long thin line.
      const wrapS = planOf(tCase['shot-headline-wrap']).text.still
      is('a headline too long for its column wraps and steps down',
        wrapS.runs.length > 1 && wrapS.runs[0].px < S1.runs[0].px &&
        wrapS.runs.every(r => r.text.length <= Math.ceil(wrapS.col / (r.px * 0.56))),
        `${wrapS.runs.length} lines at ${wrapS.runs[0].px} px against ${S1.runs[0].px} px on one`)
      // and it keeps stepping down rather than taking a fourth line or being cut off at
      // the room's edge, however long it is
      const silly = planOf({ src, opts: { ...tBase, texts: [{ style: 'headline',
        text: LONG + ' without ever opening another editor or leaving the window you were already working in' }] } }).text.still
      is('and it keeps stepping down however long it is',
        silly.runs.length <= 3 && silly.runs[0].px < wrapS.runs[0].px,
        `${silly.runs.length} lines at ${silly.runs[0].px} px`)

      // Beside rather than above, on a shape that leaves a column, with nobody having
      // said which. The picture keeps its height there: a handset in a 16:9 frame was
      // never going to use the width, and the words take what it left.
      const sideS = planOf(tCase['shot-headline-beside']).text.still
      is('a picture that leaves a column gets its headline beside it', sideS.place === 'left',
        `${sideS.place}, a ${sideS.col} px column`)

      // What is pinned lands on the point it names. The picture under the label is not
      // the picture without it, in a box round that point and nowhere else on that row.
      const onPoint = async (name, at, expect) => {
        const c = tCase[name], s = planOf(c)
        const bare = await host.renderShot(c.src, { ...c.opts, texts: [] },
          { width: 640, dest: path.join(OUT, name + '-bare.png') }, 'gl-test-' + name + '-bare')
        const k = drawn[name].w / s.W, W = drawn[name].w
        const px = Math.round((s.rect.x + s.rect.w * at.x) * k), py = Math.round((s.rect.y + s.rect.h * at.y) * k)
        const a = rgbOf(drawn[name].file), b = rgbOf(bare.file)
        const moved = (cx, cy, r) => {
          let d = 0, n = 0
          for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) {
            d += Math.abs(lumaAt(a, W, x, y) - lumaAt(b, W, x, y)); n++
          }
          return d / Math.max(1, n)
        }
        const here = moved(px, py, 4), away = moved(Math.round(s.rect.x * k + 12), py, 4)
        is(expect, here > 4 && away < 1, `${here.toFixed(1)} levels on the point, ${away.toFixed(1)} across the row`)
      }
      await onPoint('shot-label', { x: 0.72, y: 0.115 }, 'a pinned label sits on the point it names')
      await onPoint('shot-callout', { x: 0.86, y: 0.42 }, 'and a callout points at one')

      // Type is drawn at the size, not enlarged into it: the same plan at 1x and at 3x,
      // read across the headline's own glyphs. The edge stays about a pixel at both, and
      // the bigger one carries at least the contrast the smaller one does.
      const hs = { }
      for (const k of [1, 3]) {
        hs[k] = await host.renderShot(src, tCase['shot-headline'].opts,
          { scale: k, dest: path.join(OUT, `shot-headline-${k}x.png`) }, 'gl-test-headline-' + k)
      }
      const band = k => ({ x: Math.round(S1.x * k), y: Math.round(S1.top * k),
        w: Math.round(S1.col * k), h: Math.round(S1.runs[0].lineH * k) })
      const hr = { 1: stepRuns(rgbOf(hs[1].file), hs[1].w, band(1)), 3: stepRuns(rgbOf(hs[3].file), hs[3].w, band(3)) }
      is('the headline is drawn at the size rather than enlarged into it',
        hr[1].rise <= 2 && hr[3].rise <= 2 && hr[3].contrast >= hr[1].contrast - 2 && hr[1].n > 20,
        `1x rises in ${hr[1].rise} px over ${hr[1].n} edges, 3x in ${hr[3].rise} over ${hr[3].n}`)
    }

    if (want('chrome')) {
      console.log('one title bar, and a real address')
      // The fault this answers: a browser frame drawn round a capture that already had
      // chrome in it gave the picture two title bars and a blank address under the real
      // one. Two halves, and the cases below are one each.
      //
      // Knowing. What the capture was of settles it, and only a shot knows: a window
      // capture brings its own title bar, a region capture brings none. Where the page's
      // place is known the chrome comes off exactly, which is the document's crop; where
      // it is not, the second bar is simply not drawn and the shell wears a plain bezel.
      //
      // Saying. An address field with nothing in it reads as a mockup somebody left
      // unfinished, so the field is drawn only where there is an address for it, and the
      // bar that held it falls back to a title bar's height.
      const withChrome = chromeFixture(), noChrome = shotFixture()
      const WIN = { kind: 'window', app: 'Songscription', title: 'Songscription Library' }
      const cBase = { backdrop: 'ink', inset: 0.07, shadow: 0.6, backdropAspect: 16 / 9,
        look: { grain: { dither: false }, treatment: { motionBlur: 0.5 }, frame: { border: 0 } } }
      const browser = (title, kind = 'browser') => ({ ...cBase,
        look: { ...cBase.look, device: { kind, ...(title == null ? {} : { title }) } } })
      // the capture's own bar as a fraction of it, which is what a crop takes off
      const BAR_F = CHROME_BAR / (1780 + CHROME_BAR)
      const CUT = { x: 0, y: BAR_F, w: 1, h: 1 - BAR_F }
      const cCase = {
        // a capture that already has chrome in it, framed
        'shot-chrome-own': { src: withChrome, opts: { ...browser(), captured: WIN } },
        // the same capture with its own bar cropped away: there is one chrome to draw
        // now, and the window's own title is what goes in it
        'shot-chrome-cropped': { src: withChrome, opts: { ...browser(), captured: WIN, crop: CUT } },
        // a capture with no chrome of its own, framed, with an address to show
        'shot-bar-address': { src: noChrome, opts: { ...browser('songscription.example'), captured: { kind: 'region' } } },
        // and the same frame with nothing at all to put in the field
        'shot-bar-blank': { src: noChrome, opts: { ...browser(), captured: { kind: 'region' } } },
      }
      const cDrawn = {}
      for (const [name, c] of Object.entries(cCase)) {
        cDrawn[name] = await host.renderShot(c.src, c.opts, { width: 640, dest: path.join(OUT, name + '.png') }, 'gl-test-' + name)
        const gold = path.join(GOLD, name + '.png')
        if (update || !fs.existsSync(gold)) { fs.copyFileSync(cDrawn[name].file, gold); is(`${name} written`, true, `${cDrawn[name].w}x${cDrawn[name].h}`) }
        else {
          const d = step(rgbOf(cDrawn[name].file), rgbOf(gold))
          is(name, d.max <= 2 && d.mean < 0.05, `max ${d.max} LSB, mean ${d.mean}`)
        }
      }

      const cPlan = c => host.shotPlan(c.src, c.opts).spec
      const topOf = d => d.screen.y - d.box.y, sideOf = d => d.screen.x - d.box.x
      const own = cPlan(cCase['shot-chrome-own']).device
      const cut = cPlan(cCase['shot-chrome-cropped']).device
      // One title bar. Round a capture that has its own the shell's top is the same
      // bezel as its sides, which is the whole of "do not draw a second one": there is
      // no bar, so there is nothing on it to be a second of.
      is('a capture that already has chrome is framed in a plain bezel and not a second bar',
        Math.abs(topOf(own) - sideOf(own)) <= 1 && topOf(cut) > sideOf(cut) * 3,
        `own ${topOf(own)} px over ${sideOf(own)} px of side, cropped ${topOf(cut)} px over ${sideOf(cut)}`)
      // and the picture is bigger for the bar it did not draw, rather than the same
      // picture with an empty strip over it
      const asBefore = host.shotPlan(withChrome, browser()).spec.device
      is('and the capture is drawn larger for the bar that is not there',
        own.screen.h > asBefore.screen.h, `${own.screen.h} px against ${asBefore.screen.h}`)

      // The pixels say the same. A bar is a face a shade off the shell with buttons and
      // a title on it, so the middle of the top bezel reads differently from the middle
      // of the side bezel wherever there is one. Where the capture keeps its own chrome
      // the two are one tone, which is what a bezel is. Read away from the shell's own
      // hairline and its top sheen, which are the frame's edge and belong to every side.
      const bezelTone = async (name, c) => {
        const spec = cPlan(c)
        const r = await host.renderShot(c.src, c.opts, { width: 1440, dest: path.join(OUT, name + '-wide.png') }, 'gl-test-' + name + '-wide')
        const px = rgbOf(r.file), k = r.w / spec.W, B = spec.device.box, S = spec.device.screen
        const top = S.y - B.y, side = S.x - B.x
        const mean = (x0, y0, x1, y1) => {
          let s = 0, n = 0
          for (let y = Math.round(y0 * k); y < Math.max(Math.round(y0 * k) + 1, Math.round(y1 * k)); y++) {
            for (let x = Math.round(x0 * k); x < Math.max(Math.round(x0 * k) + 1, Math.round(x1 * k)); x++) { s += lumaAt(px, r.w, x, y); n++ }
          }
          return n ? s / n : 0
        }
        return {
          face: Math.round(mean(B.x + B.w * 0.06, B.y + top * 0.35, B.x + B.w * 0.94, B.y + top * 0.75)),
          shell: Math.round(mean(B.x + side * 0.35, S.y + S.h * 0.3, B.x + side * 0.75, S.y + S.h * 0.7)),
        }
      }
      const bOwn = await bezelTone('shot-chrome-own', cCase['shot-chrome-own'])
      const bCut = await bezelTone('shot-chrome-cropped', cCase['shot-chrome-cropped'])
      is('so the drawn frame puts nothing above the capture\'s own bar',
        Math.abs(bOwn.face - bOwn.shell) <= 2 && Math.abs(bCut.face - bCut.shell) >= 5,
        `own ${bOwn.face} against ${bOwn.shell} at the side, cropped ${bCut.face} against ${bCut.shell}`)

      // The address. A browser frame with nothing to say draws no field at all, and what
      // is left is exactly a window's title bar: the same picture, byte for byte, which
      // is the strongest way to say no empty field is drawn.
      const asWindow = await host.renderShot(noChrome, { ...browser(null, 'window'), captured: { kind: 'region' } },
        { width: 640, dest: path.join(OUT, 'shot-bar-window.png') }, 'gl-test-bar-window')
      const dWin = step(rgbOf(cDrawn['shot-bar-blank'].file), rgbOf(asWindow.file))
      is('a browser frame with no address draws no field: what is left is a title bar',
        dWin.max === 0, `max ${dWin.max} LSB`)
      // and an address gets a field, and the room for one
      const addr = cPlan(cCase['shot-bar-address']).device, blank = cPlan(cCase['shot-bar-blank']).device
      const dAddr = step(rgbOf(cDrawn['shot-bar-address'].file), rgbOf(cDrawn['shot-bar-blank'].file))
      is('an address gets a field, and the bar the height a field needs',
        addr.address && !blank.address && topOf(addr) > topOf(blank) * 1.3 && dAddr.max > 8,
        `${topOf(addr)} px of bar against ${topOf(blank)}, max ${dAddr.max} LSB apart`)
      // A window title is not an address and is never set as one: it is centred the way
      // a window's own is. This is the case a person reaches by cropping the capture's
      // bar off and keeping the drawn frame, and the title moves from one into the other.
      const noTitle = await host.renderShot(withChrome, { ...browser(), crop: CUT },
        { width: 640, dest: path.join(OUT, 'shot-chrome-untitled.png') }, 'gl-test-chrome-untitled')
      const dTitle = step(rgbOf(cDrawn['shot-chrome-cropped'].file), rgbOf(noTitle.file))
      is('the captured window\'s own title fills the drawn bar, as a title and not as an address',
        cut.title === WIN.title && cut.address === false && dTitle.max > 8,
        `"${cut.title}", max ${dTitle.max} LSB against the same frame told nothing`)

      // And the branch a recording can never take. A take says nothing about what it
      // captured, so it is framed exactly as it always was: the full browser bar, which
      // is the share DEVICES names and no other number.
      const asAlways = host.shotPlan(noChrome, browser('fetch.app')).spec.device
      is('a take that says nothing about what it captured is framed as it always was',
        asAlways.own === false && asAlways.address === true && Math.abs(topOf(asAlways) / asAlways.unit - 0.070) < 0.003,
        `bar ${(topOf(asAlways) / asAlways.unit).toFixed(3)} of the screen's own width`)
    }

    if (want('group')) {
      console.log('more than one device in one shot')
      // What a group has to be is one photograph of several things, not several
      // pictures beside each other. So the measurements below are not about the look,
      // which the goldens hold: they are the four things that make it one photograph.
      // One scale, in millimetres. One light. One grade. One ground, worn once.
      const GW = 900
      const look = { device: { theme: 'dark' }, grain: { dither: false }, frame: { radius: 14 } }
      const base = { backdrop: 'studio', inset: 0.08, shadow: 0.6, start: 0, end: 4, look }
      const draw = async (tag, members, extra = {}) => {
        const first = members[0]
        const { at, width, ...rest } = extra
        const opts = { ...base, ...rest, look: { ...look, ...(rest.look || {}) }, group: { ...(rest.group || {}), members } }
        return call('group', { opts, meta: { width: first.w, height: first.h, duration: 4, fps: 30 },
          ctx: { fps: 30 }, width: width || GW }, path.join(OUT, tag))
      }
      const goldenGroup = async (name, members, extra = {}) => {
        const r = await draw(name + '.png', members, extra)
        const gold = path.join(GOLD, name + '.png')
        const made = path.join(OUT, name + '.png')
        if (update || !fs.existsSync(gold)) { fs.copyFileSync(made, gold); is(name + ' written', true, `${r.W}x${r.H}`) }
        else {
          const d = step(rgbOf(made), rgbOf(gold))
          is(name, d.max <= 2 && d.mean < 0.05, `max ${d.max} LSB, mean ${d.mean}`)
        }
        return { ...r, file: made, px: rgbOf(made) }
      }

      // ── two: a handset beside a window ────────────────────────────────
      const two = await goldenGroup('group-two', [member('desk'), member('hand')])

      // The whole of "at their real relative sizes", in one line. Every member is drawn
      // at the same number of output pixels per millimetre of real glass, so a handset
      // beside a window is the size a handset is beside a window. Pixel count has
      // nothing to do with it and neither does the capture's own aspect.
      const perMM = r => r.group.map(m => (m.rect.w / m.mm) * (r.W / r.planW))
      const spread = a => (Math.max(...a) - Math.min(...a)) / Math.max(...a)
      is('two captures, one scale in millimetres', spread(perMM(two)) < 0.01,
        perMM(two).map((v, i) => `${two.group[i].kind} ${two.group[i].mm} mm at ${v.toFixed(3)} px/mm`).join(', '))
      // and what that comes to on the frame: a handset about a fifth of the window
      is('and the handset is a handset beside a window',
        two.group[1].rect.w / two.group[0].rect.w > 0.15 && two.group[1].rect.w / two.group[0].rect.w < 0.23,
        `${(two.group[1].rect.w / two.group[0].rect.w * 100).toFixed(1)} percent of its width`)

      // One surface. Both extents end on the same line, which is what stops two objects
      // with nothing under them reading as two pictures pasted on.
      const e0 = extentOf(two, 0), e1 = extentOf(two, 1)
      const foot = r => r.group.map(m => m.extent.y + m.extent.h)
      is('they stand on one line', Math.max(...foot(two)) - Math.min(...foot(two)) <= 2,
        foot(two).join(' and ') + ' in the plan\'s own pixels')

      // One light. Both pools have the same drop and the same softness, because both
      // come off the one spec.shadow rather than off two numbers set the same way. Read
      // off the pixels: how far the pool reaches under each object, measured against the
      // ground well clear of both.
      const clear = meanLuma(two.px, two.W, { x: 4, y: 4, w: 40, h: 40 })
      const reach = [shadowReach(two.px, two.W, two.H, e0, clear), shadowReach(two.px, two.W, two.H, e1, clear)]
      is('one light over both of them', reach[0] > 2 && Math.abs(reach[0] - reach[1]) <= Math.max(2, 0.2 * reach[0]),
        `${reach[0]} px under the window, ${reach[1]} px under the handset`)

      // One ground, worn once. The tooth is three levels of noise on the ground, and it
      // is laid on by the pass that draws the ground. A later member standing on the
      // picture the earlier ones made must not lay it on again, or the file carries two
      // or three times the noise it says it does.
      const one = await draw('group-one.png', [member('desk')])
      const patch = { x: 8, y: 8, w: 120, h: 60 }
      const g2 = grit(two.px, two.W, patch), g1 = grit(rgbOf(path.join(OUT, 'group-one.png')), one.W, patch)
      is('the ground wears its tooth once, not once per member', Math.abs(g2 - g1) < 0.25,
        `${g2} levels against ${g1} for one capture`)

      // One grade, and it stops at every capture rather than at one of them. Drained to
      // black and white, both captures have to come out monochrome while the ground
      // keeps the colour the look chose: that is the grade reaching every member and
      // being held to the recording inside each of them.
      const mono = await draw('group-mono.png', [member('desk'), member('hand')],
        { look: { treatment: { saturation: -1 } } })
      const mp = rgbOf(path.join(OUT, 'group-mono.png'))
      const chroma = [0, 1].map(i => maxChroma(mp, mono.W, inset(screenOf(mono, i), 0.12)))
      const ground = maxChroma(mp, mono.W, { x: 4, y: 4, w: 60, h: 60 })
      is('one grade over the whole set, and it stops at each capture',
        chroma[0] <= 3 && chroma[1] <= 3 && ground > 12,
        `${chroma[0]} and ${chroma[1]} levels of colour left in the captures, ${ground} on the ground`)

      // A group is still one frame that draws alone: nothing carries over between the
      // members' draws but the pixels of this frame.
      await draw('group-other.png', [member('web'), member('hand'), member('desk')])
      const againTwo = await draw('group-two-again.png', [member('desk'), member('hand')])
      is('a group drawn again after another is the same picture, byte for byte',
        step(two.px, rgbOf(path.join(OUT, 'group-two-again.png'))).max === 0 && againTwo.W === two.W,
        `max ${step(two.px, rgbOf(path.join(OUT, 'group-two-again.png'))).max} LSB`)

      // ── three: a browser, a window and a handset ──────────────────────
      const three = await goldenGroup('group-three', [member('web'), member('desk'), member('hand')])
      is('three captures, still one scale in millimetres', spread(perMM(three)) < 0.01,
        perMM(three).map((v, i) => `${three.group[i].kind} ${three.group[i].mm} mm at ${v.toFixed(3)} px/mm`).join(', '))
      const ext3 = [0, 1, 2].map(i => extentOf(three, i))
      is('and all three stand on one line', Math.max(...foot(three)) - Math.min(...foot(three)) <= 2,
        foot(three).join(', '))
      // left to right in the order they were given, which is the order they are drawn in,
      // so a member that overlaps the one before it is in front of it
      is('in the order they were given', ext3[0].x < ext3[1].x && ext3[1].x < ext3[2].x,
        ext3.map(e => e.x).join(' < '))

      // ── one capture far larger than the other ─────────────────────────
      // A 5K desktop beside a window with a fortieth of its pixels. Two things have to
      // hold, and they pull opposite ways: the big one must not be drawn big because it
      // has more pixels, and the small one must not be the thing that reads as soft
      // while the big one reads as crisp.
      const odd = await goldenGroup('group-odd', [member('wall'), member('tiny')])
      is('a capture is drawn at its real size and not at its pixel count', spread(perMM(odd)) < 0.01,
        odd.group.map((m, i) => `${(m.crop.w * m.crop.h / 1e6).toFixed(1)} MP at ${m.mm} mm`).join(', ') +
        `, ${(odd.group[0].crop.w * odd.group[0].crop.h / (odd.group[1].crop.w * odd.group[1].crop.h)).toFixed(0)}x the pixels`)
      // Read at the plan's own width rather than at the golden's, because what is being
      // measured is the capture's own text and at 900 px neither capture has any left.
      const oddFull = await draw('group-odd-full.png', [member('wall'), member('tiny')], { width: 1920 })
      oddFull.W = oddFull.planW; oddFull.H = oddFull.planH
      const fp = rgbOf(path.join(OUT, 'group-odd-full.png'))
      // How far each is minified, which is the number that decides whether it aliases
      const shrink = oddFull.group.map(m => m.crop.w / m.rect.w)
      // Both captures' own text, read on the finished file. A rise is how many samples
      // sit between a tenth and nine tenths of a step, so it is about a pixel for
      // anything rasterised at the size it is drawn at and grows with anything enlarged
      // into its pixels or aliased down into them. Both have to be a step, and the
      // fourteen megapixel one must not be the crisp one.
      const runs = [0, 1].map(i => stepRuns(fp, oddFull.W, inset(screenOf(oddFull, i), 0.08), 30))
      is('neither the fourteen megapixel capture nor the fortieth of one aliases or smears',
        runs.every(r => r.n > 40 && r.rise <= 2),
        runs.map((r, i) => `${shrink[i].toFixed(1)}x down rises in ${r.rise} px over ${r.n} edges`).join(', '))
      // and the same five millimetres of real text comes out the same height in both,
      // which is real relative size said about the content rather than about the frames
      is('and the same real text height lands at the same size in both',
        Math.abs(runs[0].contrast - runs[1].contrast) < 60,
        runs.map(r => `${r.contrast} levels of step`).join(' against '))

      // One plan at one size, drawn at whichever size is asked for: the editor's stage
      // and the file are the same renderer at the group surface too. A group laid out in
      // output pixels rather than in the plan's own would drift here and nowhere else.
      const down = path.join(OUT, 'group-odd-down.png')
      spawnSync('/opt/homebrew/bin/ffmpeg', ['-v', 'error', '-y', '-i', path.join(OUT, 'group-odd-full.png'),
        '-vf', `scale=${odd.W}:${odd.H}:flags=area`, '-frames:v', '1', down])
      const dd = step(odd.px, rgbOf(down))
      is('the same group at twice the pixels is the same picture', dd.mean < 4,
        `${oddFull.W}x${oddFull.H} down to ${odd.W}x${odd.H}, mean ${dd.mean} levels`)

      // ── overlap: two objects on one surface ───────────────────────────
      // The part that finishes the illusion. With a negative gap the handset stands in
      // front of the window, and its pool falls on the window rather than only on the
      // ground: a shadow that stopped at the ground would say the two were never in one
      // room. Measured as the same strip of the window with and without the handset.
      const over = await draw('group-over.png', [member('desk'), member('hand')], { group: { gap: -0.06 } })
      const alone = await draw('group-alone.png', [member('desk')])
      const op = rgbOf(path.join(OUT, 'group-over.png')), ap = rgbOf(path.join(OUT, 'group-alone.png'))
      const hand = extentOf(over, 1), win = screenOf(over, 0)
      // a strip of the window just left of the handset, inside the window and clear of it
      const strip = { x: Math.max(win.x + 2, hand.x - Math.round(0.05 * win.w)), y: Math.round(hand.y + hand.h * 0.5),
        w: Math.round(0.04 * win.w), h: Math.round(hand.h * 0.2) }
      const lit = meanLuma(ap, alone.W, strip), shaded = meanLuma(op, over.W, strip)
      is('a member in front casts on the member behind it', hand.x < win.x + win.w && lit - shaded > 3,
        `${(lit - shaded).toFixed(1)} levels darker where the handset stands over it`)
      is('and an overlap is still an arrangement, not one capture hidden behind another',
        over.group[1].rect.x > over.group[0].rect.x + over.group[0].rect.w * 0.5,
        `the handset starts ${((over.group[1].rect.x - over.group[0].rect.x) / over.group[0].rect.w * 100).toFixed(0)} percent across the window`)

      // ── marks, on a member and on the set itself ──────────────────────
      // A group is a still of several things, so a mark on one of them has no when to
      // give: a member's marks carry no start and no end. And the shot's own marks
      // belong to the first member, because a shot's src, crop and marks are the
      // capture it started as and a second capture standing beside it does not move
      // them. Both used to plan to an empty track and draw nothing at all, which no
      // measurement of the look would ever catch.
      const redact = (x, w) => ({ kind: 'redact', x, y: 0.25, w, h: 0.12 })
      const plain = await draw('group-marks-none.png', [member('desk'), member('hand')])
      const pp = rgbOf(path.join(OUT, 'group-marks-none.png'))
      const onMember = await draw('group-marks-member.png',
        [member('desk'), member('hand', { marks: [redact(0.1, 0.8)] })])
      const onSet = await draw('group-marks-take.png', [member('desk'), member('hand')],
        { marks: [{ ...redact(0.1, 0.5), start: 0, end: 4 }] })
      // where two frames differ, as a box, so a mark can be shown to land on the
      // capture it was drawn on rather than merely to have changed something
      const changedBox = (a, b, W) => {
        let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1
        for (let i = 0; i < a.length; i += 3) {
          if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) < 24) continue
          const q = i / 3, x = q % W, y = (q - x) / W
          if (x < x0) x0 = x; if (x > x1) x1 = x
          if (y < y0) y0 = y; if (y > y1) y1 = y
        }
        return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }
      }
      const within = (b, r) => !!b && b.x >= r.x - 3 && b.y >= r.y - 3 &&
        b.x + b.w <= r.x + r.w + 3 && b.y + b.h <= r.y + r.h + 3
      const mBox = changedBox(pp, rgbOf(path.join(OUT, 'group-marks-member.png')), plain.W)
      is('a member\'s own mark is drawn, with no start and no end, on that member',
        within(mBox, screenOf(onMember, 1)),
        mBox ? `changed ${mBox.w}x${mBox.h} at ${mBox.x},${mBox.y} inside the handset` : 'nothing changed at all')
      const sBox = changedBox(pp, rgbOf(path.join(OUT, 'group-marks-take.png')), plain.W)
      is('and the set\'s own marks are the first capture\'s', within(sBox, screenOf(onSet, 0)),
        sBox ? `changed ${sBox.w}x${sBox.h} at ${sBox.x},${sBox.y} inside the window` : 'nothing changed at all')
    }

    if (want('sinks')) {
      console.log('every encoder keeps the colour')
      const bars = path.join(FIX, 'bars.mp4')
      // the bars' seven top patches, sampled in their middles, source against export
      const patches = f => {
        const r = spawnSync('/opt/homebrew/bin/ffmpeg', ['-v', 'error', '-ss', '1', '-i', f, '-frames:v', '1', '-vf', 'scale=1920:1080,format=rgb24', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 26 })
        return [0, 1, 2, 3, 4, 5, 6].map(k => { const x = Math.round(240 + k * 1440 / 7 + 60), y = 300, o = (y * 1920 + x) * 3; return [...r.stdout.subarray(o, o + 3)] })
      }
      const want0 = patches(bars)
      for (const [label, extra] of [['webcodecs', { quality: 'balanced', sink: 'webcodecs' }], ['videotoolbox', { quality: 'balanced', sink: 'vt' }], ['x264', { quality: 'balanced' }]]) {
        const r = await host.exportEdit(bars, { format: 'mp4', dest: path.join(OUT, `bars-${label}.mp4`), engine: 'gl', ...extra }, null, 'gl-test-' + label)
        const got = patches(r.file)
        const worst = Math.max(...got.flatMap((p, k) => p.map((v, ch) => Math.abs(v - want0[k][ch]))))
        is(`${label} (${r.render && r.render.sink})`, worst <= 6, `worst channel ${worst} of 255 on the bars`)
      }
      const r = await host.exportEdit(take, { cuts: [[3.2, 6.9]], quality: 'balanced', sink: 'webcodecs', format: 'mp4', dest: path.join(OUT, 'hold-wc.mp4'), engine: 'gl' }, null, 'gl-test-hold-wc')
      const probe = spawnSync('/opt/homebrew/bin/ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames,r_frame_rate', '-of', 'csv=p=0', r.file]).stdout.toString().trim()
      const spec = Plan.prepare({ cuts: [[3.2, 6.9]] }, meta)
      is('the canvas encoder writes one frame per slot', probe === `${spec.fps}/1,${spec.frames}`, probe)
    }

    if (want('audio')) {
      console.log('sound beside the picture')
      const dur = (f, sel) => +spawnSync('/opt/homebrew/bin/ffprobe', ['-v', 'error', '-select_streams', sel, '-show_entries', 'stream=duration', '-of', 'csv=p=0', f]).stdout.toString().trim()
      const opts = { cuts: [[2, 4]], fadeIn: 0.3, fadeOut: 0.5, music: 'warm', format: 'mp4', dest: path.join(OUT, 'audio.mp4'), engine: 'gl',
        audioTrack: { file: '/tmp/fetch-test/said.aiff', volume: 0.8, offset: 1 } }
      const r = await host.exportEdit(take, opts, null, 'gl-test-audio')
      const v = dur(r.file, 'v:0'), a = dur(r.file, 'a:0')
      is('cuts, fades, an added track and a music bed', r.engine === 'gl' && Math.abs(a - v) < 0.1 && Math.abs(v - r.duration) < 0.1, `video ${v} s, audio ${a} s, ${r.engine}`)
      const m = await host.exportEdit(take, { format: 'mov', dest: path.join(OUT, 'take.mov'), engine: 'gl', start: 1, end: 5 }, null, 'gl-test-mov')
      is('a trimmed .mov', m.engine === 'gl' && Math.abs(dur(m.file, 'v:0') - 4) < 0.05 && Math.abs(dur(m.file, 'a:0') - 4) < 0.1, `${dur(m.file, 'v:0')} s`)
    }

    if (want('cancel')) {
      console.log('cancel and fall back')
      const dest = path.join(OUT, 'cancel.mp4')
      try { fs.unlinkSync(dest) } catch {}
      const run = host.exportEdit(take, { backdrop: 'dusk', format: 'mp4', dest, engine: 'gl', quality: 'high' }, null, 'gl-test-cancel')
      setTimeout(() => proc.cancel('gl-test-cancel'), 1200)
      let cancelled = false
      try { await run } catch (e) { cancelled = !!e.cancelled }
      is('a cancelled export stops and says so', cancelled)
      const again = await host.exportEdit(take, { backdrop: 'dusk', format: 'mp4', dest, engine: 'gl', end: 2 }, null, 'gl-test-after')
      is('the next export still draws', again.engine === 'gl' && fs.existsSync(dest), again.engine)
      // a MediaRecorder webm with no length: the compositor refuses, the classic path remuxes it
      const fb = await host.exportEdit('/tmp/fetch-test/test.webm', { format: 'mp4', dest: path.join(OUT, 'fallback.mp4'), captions: false }, null, 'gl-test-fb')
      is('a take the compositor cannot read goes to the classic renderer', fb.engine === 'classic' && fb.why.some(w => /compositor failed/.test(w)), JSON.stringify(fb.why))
    }

    if (want('classic')) {
      console.log('against the classic export')
      // The shutter is pinned shut on this one. The classic renderer has no motion blur
      // at all (no tblend, no minterpolate), so with the product's own 180 degrees open
      // this compares a smeared glide against a sharp one and measures the compositor's
      // extra rather than the geometry the two are supposed to agree on.
      const opts = { backdrop: 'dusk', inset: 0.08, shadow: 0.6, look: { treatment: { motionBlur: 0 } },
        zooms: [{ start: 2, end: 7, scale: 1.8, x: 0.3, y: 0.35 }], fadeIn: 0.5, format: 'mp4', quality: 'high', captions: false }
      const g = await host.exportEdit(take, { ...opts, dest: path.join(OUT, 'gl.mp4'), engine: 'gl' }, null, 'gl-test-a')
      const c = await host.exportEdit(take, { ...opts, dest: path.join(OUT, 'classic.mp4'), engine: 'classic' }, null, 'gl-test-b')
      is('engines as asked', g.engine === 'gl' && c.engine === 'classic', `${g.engine}, ${c.engine}`)
      const s = spawnSync('/opt/homebrew/bin/ffmpeg', ['-v', 'info', '-i', g.file, '-i', c.file, '-lavfi',
        '[0:v]fps=30,format=yuv420p[a];[1:v]fps=30,format=yuv420p[b];[a][b]ssim', '-f', 'null', '-'], { maxBuffer: 1 << 26 }).stderr.toString()
      const m = /All:([0-9.]+)/.exec(s)
      is('SSIM with the classic export', m && +m[1] > 0.9, m ? `SSIM ${m[1]}` : s.slice(-300))
      console.log(`  (gl ${g.render && g.render.ms} ms, realtime ${g.render && g.render.realtime}x)`)
    }
  } catch (e) {
    fail++
    console.log('  FAIL ' + (e.stack || e.message))
  }
  console.log(`\n${pass} passed, ${fail} failed`)
  // What the run counted, written the moment it has finished counting. The render host
  // keeps a warm hidden window with a live GPU context, and since the contact sheet the
  // harness uses it too; Electron sometimes aborts tearing that down on macOS (SIGTRAP,
  // SIGSEGV) after a clean run has already printed its result, and the npm wrapper turns
  // a signal into exit 1. test/gl/run.js reads this rather than that code, so a gate no
  // longer sees a passing suite as a failure, and a run that dies before it has counted
  // leaves no file here and still fails.
  try { fs.mkdirSync(path.dirname(VERDICT), { recursive: true }) } catch {}
  try { fs.writeFileSync(VERDICT, JSON.stringify({ pass, fail, at: Date.now() })) } catch {}
  try { require('../../ui/render-host').close() } catch {}
  try { for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.destroy() } catch {}
  app.exit(fail ? 1 : 0)
})
