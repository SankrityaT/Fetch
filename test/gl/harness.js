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
//   blur       the shutter is the travel: a moving frame smears, a held one is byte for
//              byte the frame it was at any shutter angle
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

    const camera = { file: cam, x: 0.84, y: 0.78, size: 0.2, camStartedAt: 1000, screenStartedAt: 1400, gaps: [] }
    const look = { treatment: { motionBlur: 0.5 }, frame: { border: 0 }, camera: { shape: 'circle', ring: true }, grain: { dither: false } }
    const base = { ffmpeg, src: take, meta }
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
      // M3: what is drawn on the take and over the frame (this take goes out at 30 fps,
      // so frame n is n / 30 seconds in)
      'marks': { opts: { backdrop: 'ink', inset: 0.06, look, marks: [
        { kind: 'redact', start: 0, end: 12, x: 0.05, y: 0.06, w: 0.25, h: 0.14 },
        { kind: 'blur', start: 0, end: 12, x: 0.55, y: 0.7, w: 0.3, h: 0.2, strength: 20 },
        { kind: 'spotlight', start: 1, end: 11, x: 0.35, y: 0.3, w: 0.3, h: 0.3 },
        { kind: 'step', start: 1, end: 11, x: 0.35, y: 0.3 }] }, n: 150 },
      'lift': { opts: { backdrop: 'slate', inset: 0.06, look, zooms: [{ start: 1, end: 11, scale: 1.8, x: 0.5, y: 0.5 }],
        marks: [{ kind: 'lift', start: 2, end: 10, x: 0.35, y: 0.35, w: 0.3, h: 0.3 }, { kind: 'step', start: 3, end: 10, x: 0.35, y: 0.35 }] }, n: 180 },
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
      'title': { opts: { backdrop: 'dusk', inset: 0.06, look, texts: [{ text: 'Fetch', subtitle: 'fetch.app', start: 0, end: 2.5, style: 'title' }] }, n: 36 },
      'lower-third': { opts: { backdrop: 'dusk', inset: 0.06, look, texts: [{ text: 'Library', subtitle: 'Three hundred songs', start: 7, end: 11, style: 'lower-third' },
        { text: 'New', start: 7, end: 11, fx: 0.7, fy: 0.3, style: 'label', box: true }] }, n: 270 },
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
        'auto-level', 'auto-level-hard', 'treat-furniture', 'treat-all']) {
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
  app.exit(fail ? 1 : 0)
})
