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
  let sum = 0, max = 0
  for (let k = 0; k < a.length; k++) { const d = Math.abs(a[k] - b[k]); sum += d; if (d > max) max = d }
  return { mean: +(sum / a.length).toFixed(4), max }
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
        'auto-level', 'auto-level-hard', 'treat-furniture', 'treat-all', 'device-browser', 'tilt-device', 'loupe', 'arrow', 'keys-chord']) {
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
