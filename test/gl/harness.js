// The compositor's GL tests. Electron, so behind a flag and outside npm test:
//
//   bash test/gl/fixtures.sh
//   FETCH_GL_TESTS=1 npx electron test/gl/harness.js [--update] [--only=name]
//
// What it checks, against test/gl/fixtures.sh's takes:
//   golden     one frame per pass (framed gradient with shadow, blur ground, image,
//              zoom with motion blur, camera, fade, border) against test/gl/golden/*.png
//   parity     the editor's path (a <video>) and the export's (ffmpeg NV12) draw the
//              same frame to within 2 LSB before encode
//   stateless  a frame drawn again after others is identical: no frame depends on another
//   hold       an exported file's frames are the source frames the plan picks
//              (sample and hold across a cut, on a variable-rate take off the 60 fps grid)
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
      'title': { opts: { backdrop: 'dusk', inset: 0.06, look, texts: [{ text: 'Fetch', subtitle: 'fetch.app', start: 0, end: 2.5, style: 'title' }] }, n: 36 },
      'lower-third': { opts: { backdrop: 'dusk', inset: 0.06, look, texts: [{ text: 'Library', subtitle: 'Three hundred songs', start: 7, end: 11, style: 'lower-third' },
        { text: 'New', start: 7, end: 11, fx: 0.7, fy: 0.3, style: 'label', box: true }] }, n: 270 },
    }

    if (want('golden')) {
      console.log('golden frames' + (update ? ' (updating)' : ''))
      for (const [name, c] of Object.entries(cases)) {
        const r = await call('golden', { ...base, ...c, width: 640 }, path.join(GOLD, name + '.png'), update)
        if (r.written) is(`${name} written`, true, r.size)
        else is(name, r.max <= 2 && r.mean < 0.05, `max ${r.max} LSB, mean ${r.mean}`)
      }
    }

    if (want('parity')) {
      console.log('preview path equals export path, before encode')
      for (const name of ['framed-dusk', 'framed-16x9-crop', 'blur-ground', 'zoom-hold', 'camera', 'marks', 'lift', 'pointer', 'text']) {
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
      const opts = { backdrop: 'dusk', inset: 0.08, shadow: 0.6, zooms: [{ start: 2, end: 7, scale: 1.8, x: 0.3, y: 0.35 }], fadeIn: 0.5, format: 'mp4', quality: 'high', captions: false }
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
