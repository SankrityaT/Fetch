// Export speed on a real take, compositor against the classic renderer. Electron:
//
//   FETCH_GL_TESTS=1 npx electron test/gl/bench.js [take.mov] [--full] [--sinks] [--treat]
//
// Defaults to the Songscription tour. Exports go to /tmp/fetch-gl/bench, never over the
// take's own deliverable. The compositor draws what it can of the take's edit (marks,
// text, captions and the drawn cursor are M3), and the classic renderer is timed on
// that same subset, so the two are comparable; --full also times the classic export of
// the whole edit, --sinks the other encoders, --treat the same export with every
// treatment field on. Gate: the compositor at least 1.0x real time.
const { app } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')

if (process.env.FETCH_GL_TESTS !== '1') { console.log('bench skipped: set FETCH_GL_TESTS=1'); process.exit(0) }
if (app.dock) app.dock.hide()

const args = process.argv.slice(2)
const take = args.find(a => !a.startsWith('--')) ||
  path.join(os.homedir(), 'Movies/Fetch/Songscription · Library Tour/Original/Songscription · Library Tour.mov')
const OUT = '/tmp/fetch-gl/bench'

app.whenReady().then(async () => {
  let code = 0
  try {
    fs.mkdirSync(OUT, { recursive: true })
    const proc = require('../../processor')
    const FD = require('../../ui/fetchdoc')
    const host = require('../../ui/render-host')
    const meta = await proc.probeMeta(take)
    const doc = proc.readDoc(take, meta.duration)
    if (!doc.clips.length) doc.clips = [{ id: 'C1', start: 0, end: meta.duration }]
    const full = FD.toExportOpts(doc, { format: 'mp4', quality: 'balanced' })
    // what the compositor draws today, for both
    const subset = { ...full, marks: [], texts: [], captions: false, pointer: [], hideMacCursor: false }
    console.log(`${path.basename(take)}: ${meta.width}x${meta.height}, ${meta.duration.toFixed(1)} s, ${meta.fps} fps avg`)
    const time = async (label, opts, engine) => {
      const t0 = Date.now()
      const r = await host.exportEdit(take, { ...opts, engine, dest: path.join(OUT, label + '.mp4') }, null, 'bench-' + label)
      const s = (Date.now() - t0) / 1000
      console.log(`  ${label.padEnd(16)} ${r.engine.padEnd(8)} ${s.toFixed(1).padStart(6)} s  ${(r.duration / s).toFixed(2)}x real time` +
        (r.render ? `  (picture ${r.render.pictureFps} fps at ${r.render.size}/${r.render.fps}, ${r.render.uploads} uploads, decode ${r.render.decode}, ms ${JSON.stringify(r.render.stages)})` : '') +
        (r.why && r.why.length ? `  left out: ${r.why.join(', ')}` : ''))
      return { s, r }
    }
    await host.probe()                      // the window warm, as in the app
    const gl = await time('gl', subset, 'gl')
    if (args.includes('--treat')) {
      // the same export with every treatment field asking for something at once, which
      // is what the pass costs at its worst: one extra full-screen shader, one wide
      // blur and one bright pass with its mip chain, all at a reduced size
      const Look = require('../../ui/look')
      const heavy = Look.merge(subset.look, { treatment: { brightness: 0.05, contrast: 0.1, saturation: -0.2,
        tintAmount: 0.2, haze: 0.15, blur: 0.25, bokeh: 0.4, bloom: 0.4, halation: 0.3, aberration: 0.3, vignette: 0.3 },
        grain: { film: 0.4 } }).look
      await time('gl-treatment', { ...subset, look: heavy }, 'gl')
    }
    if (args.includes('--sinks')) {
      await time('gl-vt', { ...subset, sink: 'vt' }, 'gl')
      await time('gl-webcodecs', { ...subset, sink: 'webcodecs' }, 'gl')
    }
    await time('classic-subset', subset, 'classic')
    if (args.includes('--full')) await time('classic-full', full, 'classic')
    const rt = gl.r.duration / gl.s
    console.log(rt >= 1 ? `\nok   compositor ${rt.toFixed(2)}x real time` : `\nFAIL compositor under real time (${rt.toFixed(2)}x)`)
    if (rt < 1) code = 1
  } catch (e) { console.log('FAIL ' + (e.stack || e.message)); code = 1 }
  app.exit(code)
})
