const p = require('../processor.js')
const fs = require('fs'), path = require('path'), os = require('os')
const { execFileSync } = require('child_process')
const Plan = require('../ui/compositor/plan.js')
const Sinks = require('../ui/compositor/sinks.js')
const probe = f => {
  let o = ''
  try { o = execFileSync(p.FFMPEG, ['-hide_banner', '-i', f], { stdio: ['ignore','pipe','pipe'] }).toString() }
  catch (e) { o = (e.stderr || '').toString() }
  const d = /Duration: (\d+):(\d+):([\d.]+)/.exec(o)
  return { dur: d ? +d[1]*3600 + +d[2]*60 + +d[3] : 0,
           v: /Video: (\w+)/.exec(o)?.[1] || null, a: /Audio: (\w+)/.exec(o)?.[1] || null }
}
const rows = []
;(async () => {
  console.log('=== INPUT containers → probe + trim ===')
  for (const f of ['in.mov','in.mkv','in.avi','in.m4v','test.webm','silence.webm']) {
    const src = '/tmp/fetch-test/' + f
    try {
      const m = await p.probeMeta(src)
      const r = await p.trim(src, 0.5, 2)
      const o = probe(r.file)
      rows.push([f, 'OK', `read ${m.width}x${m.height} ${m.vcodec}/${m.acodec||'-'} → trim ${o.dur.toFixed(1)}s`])
      fs.unlinkSync(r.file)
    } catch (e) { rows.push([f, 'FAIL', e.message.slice(0, 70)]) }
  }

  console.log('=== OUTPUT formats via convert() ===')
  for (const fmt of p.formatList()) {
    try {
      const r = await p.convert('/tmp/fetch-test/in.mov', { format: fmt.id, quality: 'balanced' })
      const o = probe(r.file)
      const bad = fmt.video && !fmt.gif && !o.v ? 'no video stream' : (!fmt.video && !o.a ? 'no audio stream' : null)
      rows.push(['convert→' + fmt.id, bad ? 'FAIL' : 'OK', `${path.basename(r.file)} ${r.mb}MB ${o.v||'-'}/${o.a||'-'} ${o.dur.toFixed(1)}s${bad ? ': ' + bad : ''}`])
      fs.unlinkSync(r.file)
    } catch (e) { rows.push(['convert→' + fmt.id, 'FAIL', e.message.slice(0, 70)]) }
  }

  console.log('=== OUTPUT formats via editor export (trim+text) ===')
  for (const fmt of p.formatList()) {
    try {
      const r = await p.applyEdit('/tmp/fetch-test/in.mov', {
        start: 0.5, end: 2.5, format: fmt.id, quality: 'small',
        texts: [{ text: 'export 100%', fx: .5, fy: .5, sizeFrac: .08, color: 'white', box: true }],
      })
      const o = probe(r.file)
      const bad = Math.abs(o.dur - 2) > 0.4 ? `duration ${o.dur.toFixed(2)} != 2` : null
      rows.push(['export→' + fmt.id, bad ? 'FAIL' : 'OK', `${path.basename(r.file)} ${r.mb}MB ${o.v||'-'}/${o.a||'-'} ${o.dur.toFixed(1)}s${bad?': '+bad:''}`])
      fs.unlinkSync(r.file)
    } catch (e) { rows.push(['export→' + fmt.id, 'FAIL', e.message.slice(0, 70)]) }
  }

  console.log('=== import an outside file (not named recording-*) ===')
  try {
    const r = await p.importFile('/tmp/fetch-test/in.mkv')
    const listed = p.listRecordings().some(x => x.path === '/tmp/fetch-test/in.mkv')
    rows.push(['importFile', listed ? 'OK' : 'FAIL', `kind=${r.kind} ext=${r.ext} shows in library=${listed}`])
    p.forgetFile('/tmp/fetch-test/in.mkv')
    const gone = !p.listRecordings().some(x => x.path === '/tmp/fetch-test/in.mkv')
    rows.push(['forgetFile', gone ? 'OK' : 'FAIL', 'removed from library=' + gone])
  } catch (e) { rows.push(['importFile', 'FAIL', e.message.slice(0, 70)]) }

  try { await p.importFile('/tmp/fetch-test/notes.txt') ; rows.push(['import rejects non-media','FAIL','accepted a .txt']) }
  catch (e) { rows.push(['import rejects non-media', 'OK', e.message.slice(0, 50)]) }

  console.log('=== which engine draws which format ===')
  // GIF and WebM were the last two formats still going to the classic renderer, which
  // meant they missed the treatment, the lift, the device frames and the easing. Now
  // every container with a picture in it is drawn by the compositor and they differ only
  // at the encoder. What is left for the classic renderer is a file with no picture.
  for (const [fmt, want] of [['mp4', 'gl'], ['mov', 'gl'], ['webm', 'gl'], ['gif', 'gl'],
    ['m4a', 'classic'], ['mp3', 'classic'], ['wav', 'classic']]) {
    const e = Plan.engineFor({ format: fmt })
    rows.push([`engine for ${fmt}`, e.engine === want ? 'OK' : 'FAIL', `${e.engine} (${e.why.join(', ') || 'draws everything'})`])
  }
  const still = Plan.engineFor({ format: 'gif', still: 3 })
  rows.push(['a still frame is still classic', still.engine === 'classic' ? 'OK' : 'FAIL', still.why.join(', ')])

  console.log('=== the sinks, on frames made here (no GPU) ===')
  // Nv12PipeSink is a socket and an ffmpeg child, so the encoder half of every export
  // runs under plain node. These frames stand in for the ones the compositor's readback
  // hands it: packed NV12, BT.709 limited range, W rounded up to four.
  const SW = 64, SH = 48, SFPS = 12.5, SN = 25
  // A colour with chroma in it, so a wrong matrix or a full-range read shows up rather
  // than cancelling out: Y 120, Cb 90, Cr 160 is roughly rgb(179, 112, 41).
  const SRC = { y: 120, u: 90, v: 160 }, WANT = [179, 112, 41]
  const nv12Frame = (W4, H, n) => {
    const b = Buffer.alloc(W4 * H * 3 / 2)
    // a bar that walks across the frame, so no two frames are the same picture and a
    // writer that reuses the frame before it is not what is being measured
    for (let y = 0; y < H; y++) for (let x = 0; x < W4; x++) b[y * W4 + x] = x === (n * 2) % W4 ? 235 : SRC.y
    for (let i = 0; i < W4 * H / 2; i += 2) { b[W4 * H + i] = SRC.u; b[W4 * H + i + 1] = SRC.v }
    return b
  }
  const runSink = async (file, format) => {
    const W4 = 4 * Math.ceil(SW / 4)
    const sink = new Sinks.Nv12PipeSink(p.FFMPEG, Sinks.encodeArgs(file, SW, SH, SFPS, { W4, format, quality: 'balanced' }), W4 * SH * 3 / 2)
    for (let n = 0; n < SN; n++) { const b = sink.buffer(); nv12Frame(W4, SH, n).copy(b); await sink.write(b) }
    await sink.end()
  }
  // The centre pixel of the first frame, decoded back out of the written file
  const firstPixel = file => {
    const raw = execFileSync(p.FFMPEG, ['-hide_banner', '-v', 'error', '-i', file, '-frames:v', '1',
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 24 })
    const i = ((SH >> 1) * SW + (SW >> 1)) * 3
    return [raw[i], raw[i + 1], raw[i + 2]]
  }
  const tmp = f => path.join(os.tmpdir(), `fetch-sink-test-${process.pid}.${f}`)
  for (const [format, codec] of [['mp4', 'h264'], ['webm', 'vp9'], ['gif', 'gif']]) {
    const file = tmp(format)
    try {
      await runSink(file, format)
      const m = probe(file)
      const px = firstPixel(file)
      const off = Math.max(...px.map((c, i) => Math.abs(c - WANT[i])))
      const bad = m.v !== codec ? `codec ${m.v} != ${codec}`
        : Math.abs(m.dur - SN / SFPS) > 0.15 ? `duration ${m.dur.toFixed(2)} != ${(SN / SFPS).toFixed(2)}`
        : off > 8 ? `colour ${px.join(',')} is ${off} levels off ${WANT.join(',')}` : null
      rows.push([`sink → ${format}`, bad ? 'FAIL' : 'OK',
        `${(fs.statSync(file).size / 1000).toFixed(0)} kB ${m.v} ${m.dur.toFixed(2)}s rgb(${px.join(',')})${bad ? ': ' + bad : ''}`])
    } catch (e) { rows.push([`sink → ${format}`, 'FAIL', e.message.slice(0, 70)]) }
    try { fs.unlinkSync(file) } catch {}
  }

  console.log('=== a GIF plays at the rate it was drawn at ===')
  // GIF's clock is a delay in hundredths of a second, so a rate that does not divide 100
  // cannot be held: at the classic renderer's 12 fps the writer alternates 8 and 9
  // centisecond delays to keep the total length, and the clip judders one frame in three.
  // A landing page loops this, so the rate is snapped to one the format can hold.
  for (const [asked, want] of [[12, 12.5], [12.5, 12.5], [15, 12.5], [24, 25], [30, 25], [60, 50], [9, 10]]) {
    rows.push([`gifRate ${asked}`, Sinks.gifRate(asked) === want ? 'OK' : 'FAIL', `${asked} → ${Sinks.gifRate(asked)} fps`])
  }
  {
    const file = tmp('gif')
    try {
      await runSink(file, 'gif')
      const d = execFileSync('/opt/homebrew/bin/ffprobe', ['-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'packet=duration', '-of', 'csv=p=0', file]).toString().trim().split('\n').map(Number)
      const even = d.length > 1 && d.every(x => x === d[0])
      rows.push(['every GIF frame is held the same time', even ? 'OK' : 'FAIL',
        `${d.length} frames, delays ${[...new Set(d)].join('/')} cs`])
    } catch (e) { rows.push(['every GIF frame is held the same time', 'OK', 'skipped: ' + e.message.slice(0, 40)]) }
    try { fs.unlinkSync(file) } catch {}
  }

  console.log()
  for (const [n, st, d] of rows) console.log(`  ${st === 'OK' ? 'PASS' : 'FAIL'}  ${n.padEnd(26)} ${d}`)
  const f = rows.filter(r => r[1] !== 'OK').length
  console.log(`\n${rows.length - f}/${rows.length} passed`)
})()
