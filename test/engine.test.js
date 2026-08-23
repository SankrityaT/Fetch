const p = require('../processor.js')
const fs = require('fs'), path = require('path'), os = require('os')
const { execFileSync } = require('child_process')

const SRC = process.argv[2]
const results = []
const ff = (...a) => execFileSync(p.FFMPEG, ['-hide_banner', ...a], { stdio: ['ignore', 'pipe', 'pipe'] }).toString()

function probe(f) {
  let out = ''
  try { out = execFileSync(p.FFMPEG, ['-hide_banner', '-i', f], { stdio: ['ignore', 'pipe', 'pipe'] }).toString() }
  catch (e) { out = (e.stderr || '').toString() }
  const d = /Duration: (\d+):(\d+):([\d.]+)/.exec(out)
  return {
    dur: d ? (+d[1] * 3600 + +d[2] * 60 + +d[3]) : 0,
    v: /Video: (\w+)/.exec(out)?.[1] || null,
    a: /Audio: (\w+)/.exec(out)?.[1] || null,
    dims: /, (\d+)x(\d+)/.exec(out)?.slice(1, 3).join('x') || null,
  }
}

async function test(name, fn, check) {
  const t0 = Date.now()
  try {
    const r = await fn()
    const secs = ((Date.now() - t0) / 1000).toFixed(1)
    const problem = check ? check(r) : null
    results.push({ name, ok: !problem, detail: problem || summarize(r), secs })
  } catch (e) {
    results.push({ name, ok: false, detail: 'THREW: ' + e.message, secs: ((Date.now() - t0) / 1000).toFixed(1) })
  }
}
const summarize = r => {
  if (r && r.file) { const m = probe(r.file); return `${path.basename(r.file)} ${m.dur.toFixed(1)}s ${m.v || '-'}/${m.a || '-'} ${m.dims || ''}` }
  return JSON.stringify(r).slice(0, 90)
}
const cleanup = []

;(async () => {
  console.log('source:', path.basename(SRC))
  const meta = await p.probeMeta(SRC)
  console.log('raw header duration:', meta.duration, '(0 = headerless, needs remux)\n')

  await test('probeMeta (via seekable)', async () => {
    const s = await require('../processor.js').probeMeta(SRC)
    return s
  })

  await test('waveform', () => p.waveform(SRC, { buckets: 300 }),
    r => !r.peaks.length ? 'no peaks' : (r.peaks.length < 50 ? 'too few peaks: ' + r.peaks.length : null))

  await test('thumbnail @1s', () => p.thumbnail(SRC, 1),
    r => { cleanup.push(r.file); return fs.existsSync(r.file) && fs.statSync(r.file).size > 5000 ? null : 'png missing/tiny' })

  await test('toMp4', () => p.toMp4(SRC),
    r => { cleanup.push(r.file); const m = probe(r.file); return m.v === 'h264' && m.a === 'aac' && m.dur > 1 ? null : 'bad output ' + JSON.stringify(m) })

  await test('trim 1s→3s', () => p.trim(SRC, 1, 3),
    r => { cleanup.push(r.file); const m = probe(r.file); return Math.abs(m.dur - 2) < 0.2 ? null : `duration ${m.dur} != 2` })

  await test('toGif', () => p.toGif(SRC, { start: 0, duration: 2, width: 320 }),
    r => { cleanup.push(r.file); return fs.existsSync(r.file) && fs.statSync(r.file).size > 10000 ? null : 'gif missing/tiny' })

  await test('enhanceAudio', () => p.enhanceAudio(SRC, { denoise: true, loudnorm: true, gain: 2 }),
    r => { cleanup.push(r.file); const m = probe(r.file); return m.a === 'aac' && m.dur > 1 ? null : 'bad ' + JSON.stringify(m) })

  // synthetic clip: tone 0-2, 4-6, 8-10 with silence between → expect 4 kept segments, ~6.9s
  await test('removeSilence (ground truth)', () => p.removeSilence('/tmp/fetch-test/silence.webm', {}),
    r => { cleanup.push(r.file); const m = probe(r.file)
           if (r.cuts !== 4) return `kept ${r.cuts} segments, expected 4`
           if (Math.abs(m.dur - 6.9) > 0.6) return `duration ${m.dur}, expected ~6.9`
           if (Math.abs(r.savedPct - 43) > 6) return `savedPct ${r.savedPct}, expected ~43`
           return null })

  await test('removeSilence (no silence → friendly error)', async () => {
    try { await p.removeSilence(SRC, {}); return { threw: false } }
    catch (e) { return { threw: true, msg: e.message } }
  }, r => !r.threw ? 'should have refused' : (/dead air/.test(r.msg) ? null : 'unclear message: ' + r.msg))

  // --- the big one: full editor export ---
  await test('applyEdit: trim+crop+scale+text+fades+audio', () => p.applyEdit(SRC, {
    start: 0.5, end: 3,
    crop: { x: 0.1, y: 0.1, w: 0.8, h: 0.6 },
    scale: 720,
    texts: [{ text: "Dog's \"best\" clip: 100%", fx: 0.5, fy: 0.2, sizeFrac: 0.08, color: 'white', box: true, start: 0.5, end: 3 }],
    fadeIn: 0.3, fadeOut: 0.3, denoise: true, loudnorm: true, gain: 1,
  }), r => {
    cleanup.push(r.file)
    const m = probe(r.file)
    if (!fs.existsSync(r.file)) return 'no output'
    if (Math.abs(m.dur - 2.5) > 0.2) return `duration ${m.dur} != 2.5`
    if (m.v !== 'h264' || m.a !== 'aac') return 'bad codecs ' + JSON.stringify(m)
    const h = +m.dims.split('x')[1]
    if (h !== 720) return `height ${h} != 720`
    return null
  })

  await test('applyEdit: text with % " \' :', () => p.applyEdit(SRC, {
    start: 0, end: 2,
    texts: [{ text: 'saved 100% "it\'s" 3:15', fx: 0.5, fy: 0.5, sizeFrac: 0.06, color: 'white', box: true }],
  }), r => { cleanup.push(r.file); return probe(r.file).dur > 1 ? null : 'no output' })

  await test('applyEdit: no trim (whole clip)', () => p.applyEdit(SRC, { loudnorm: false }),
    r => { cleanup.push(r.file); const m = probe(r.file); return m.dur > 1 ? null : 'bad ' + JSON.stringify(m) })

  await test('cancel mid-export', async () => {
    const jobId = 999
    const big = require('fs').readdirSync(require('os').homedir() + '/Desktop')
      .filter(f => /^recording-.*\.webm$/.test(f))
      .map(f => require('os').homedir() + '/Desktop/' + f)
      .sort((a, b) => require('fs').statSync(b).size - require('fs').statSync(a).size)[0]
    const pr = p.applyEdit(big, { scale: 1080 }, null, jobId)
    await new Promise(r => setTimeout(r, 700))
    const killed = p.cancel(jobId)
    let threw = null
    try { await pr } catch (e) { threw = e }
    if (threw) { try { require('fs').unlinkSync(big.replace(/\.[^.]+$/, '-edit.mp4')) } catch {} }
    return { killed, cancelled: threw ? !!threw.cancelled : false, err: threw ? threw.message : 'no throw' }
  }, r => !r.killed ? 'cancel() found no running job' : (!r.cancelled ? 'killed but error not flagged cancelled: ' + r.err : null))

  console.log('op'.padEnd(46), 'time'.padStart(6), '  result')
  console.log('-'.repeat(110))
  for (const r of results) {
    console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name.padEnd(38), (r.secs + 's').padStart(6), '  ' + r.detail)
  }
  const bad = results.filter(r => !r.ok)
  console.log('\n' + (results.length - bad.length) + '/' + results.length + ' passed')
  cleanup.forEach(f => { try { fs.unlinkSync(f) } catch {} })
  process.exit(bad.length ? 1 : 0)
})()
