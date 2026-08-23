const p = require('../processor.js')
const fs = require('fs'), path = require('path')
const { execFileSync } = require('child_process')
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
    const src = '/tmp/qrt/' + f
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
      const r = await p.convert('/tmp/qrt/in.mov', { format: fmt.id, quality: 'balanced' })
      const o = probe(r.file)
      const bad = fmt.video && !fmt.gif && !o.v ? 'no video stream' : (!fmt.video && !o.a ? 'no audio stream' : null)
      rows.push(['convert→' + fmt.id, bad ? 'FAIL' : 'OK', `${path.basename(r.file)} ${r.mb}MB ${o.v||'-'}/${o.a||'-'} ${o.dur.toFixed(1)}s${bad ? ': ' + bad : ''}`])
      fs.unlinkSync(r.file)
    } catch (e) { rows.push(['convert→' + fmt.id, 'FAIL', e.message.slice(0, 70)]) }
  }

  console.log('=== OUTPUT formats via editor export (trim+text) ===')
  for (const fmt of p.formatList()) {
    try {
      const r = await p.applyEdit('/tmp/qrt/in.mov', {
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
    const r = await p.importFile('/tmp/qrt/in.mkv')
    const listed = p.listRecordings().some(x => x.path === '/tmp/qrt/in.mkv')
    rows.push(['importFile', listed ? 'OK' : 'FAIL', `kind=${r.kind} ext=${r.ext} shows in library=${listed}`])
    p.forgetFile('/tmp/qrt/in.mkv')
    const gone = !p.listRecordings().some(x => x.path === '/tmp/qrt/in.mkv')
    rows.push(['forgetFile', gone ? 'OK' : 'FAIL', 'removed from library=' + gone])
  } catch (e) { rows.push(['importFile', 'FAIL', e.message.slice(0, 70)]) }

  try { await p.importFile('/tmp/qrt/notes.txt') ; rows.push(['import rejects non-media','FAIL','accepted a .txt']) }
  catch (e) { rows.push(['import rejects non-media', 'OK', e.message.slice(0, 50)]) }

  console.log()
  for (const [n, st, d] of rows) console.log(`  ${st === 'OK' ? 'PASS' : 'FAIL'}  ${n.padEnd(26)} ${d}`)
  const f = rows.filter(r => r[1] !== 'OK').length
  console.log(`\n${rows.length - f}/${rows.length} passed`)
})()
