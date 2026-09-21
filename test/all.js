// Every suite, each on its own, then one line for all of them.
//
// npm test used to chain the suites with &&, so the first real failure hid every suite
// after it, and a night's run could come back with one red line and thirty suites that
// never ran. This runs them all whatever happens, one after another (several at once
// would fight over ffmpeg and, in shot.test.js, over the capture service), prints each
// suite's own last line, and exits 1 if any of them failed. A suite that exits 2 ran
// nothing wrong but could not check its live half (shot.test.js with the capture service
// down); that is said apart from a failure, and the run exits 2 when it is all there is.
//
//   node test/all.js              every suite
//   node test/all.js tools shot   only the suites whose names contain these words

const { spawnSync } = require('child_process')
const path = require('path')

const SUITES = [
  'simulator', 'policy', 'simctl', 'fetchdoc', 'shot-doc', 'look', 'levels', 'timeline',
  'plan', 'fit', 'director', 'review', 'memory', 'trackedit', 'focus', 'beats', 'naming',
  'zoom', 'overlays', 'zoomview', 'motion', 'stage-pick', 'targets', 'lasso', 'pointer',
  'touch', 'chat', 'assist', 'takes', 'recorder', 'library',
  ['engine', '/tmp/fetch-test/test.webm'],
  'formats', 'tools', 'shot', 'shot-stage', 'sizes', 'history', 'brake',
]

const only = process.argv.slice(2)
const picked = SUITES.map(s => Array.isArray(s) ? s : [s])
  .filter(([name]) => !only.length || only.some(w => name.includes(w)))

// The last line a suite prints that carries a count, which is its own summary in
// whatever words it uses.
const summaryOf = out => {
  const lines = String(out).split('\n').map(l => l.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) if (/\d+ (passed|checks|tool surface)/.test(lines[i])) return lines[i]
  return lines[lines.length - 1] || ''
}

const rows = []
for (const [name, ...args] of picked) {
  const file = path.join(__dirname, `${name}.test.js`)
  const t = Date.now()
  const r = spawnSync(process.execPath, [file, ...args], { encoding: 'utf8', maxBuffer: 64 << 20, env: process.env })
  const out = (r.stdout || '') + (r.stderr || '')
  const code = r.status == null ? (r.signal || 'killed') : r.status
  // a suite skipped something only if it says how many and that is not none, or prints
  // a skip line of its own; "0 SKIPPED" in a summary is a clean run, not a skip
  const skipped = /\b[1-9]\d* SKIPPED\b/.test(out) || /^\s*SKIPPED\b/m.test(out)
  const unchecked = code === 2 && skipped
  rows.push({ name, code, skipped, unchecked, ms: Date.now() - t })
  const mark = code === 0 ? (skipped ? 'skip' : 'ok  ') : unchecked ? 'NOT CHECKED' : 'FAIL'
  console.log(`${mark} ${name.padEnd(12)} ${summaryOf(out)}  (${((Date.now() - t) / 1000).toFixed(1)} s)`)
  if (code !== 0 && !unchecked) {
    // the failing suite's own words, so nobody has to run it again to see what broke
    const fails = out.split('\n').filter(l => /FAIL|Error|assert|not ok/i.test(l)).slice(0, 12)
    for (const l of fails) console.log('       ' + l.trim())
  }
}

const failed = rows.filter(r => r.code !== 0 && !r.unchecked)
const unchecked = rows.filter(r => r.unchecked)
const skipped = rows.filter(r => r.code === 0 && r.skipped)
console.log(`\n${rows.length} suites: ${rows.length - failed.length - unchecked.length} passed, ${failed.length} failed` +
  (unchecked.length ? `, ${unchecked.length} NOT CHECKED (${unchecked.map(r => r.name).join(', ')})` : '') +
  (skipped.length ? `, ${skipped.length} with SKIPPED checks (${skipped.map(r => r.name).join(', ')})` : ''))
if (failed.length) console.log('failed: ' + failed.map(r => `${r.name} (${r.code})`).join(', '))
process.exit(failed.length ? 1 : unchecked.length ? 2 : 0)
