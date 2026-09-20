// The GL harness, run so the shell hears the run's own verdict.
//   npm run test:gl
//
// The harness draws real frames in a hidden Electron window with a live GPU context.
// Tearing that down on macOS sometimes aborts Electron itself (SIGTRAP, SIGSEGV) after
// the run has already finished and printed "0 failed", and the electron wrapper turns a
// signal into exit 1. A gate reading that code saw a passing suite as a failure, which
// is worse than no gate: it teaches everyone to ignore the number.
//
// So the harness writes what it counted the moment it has finished counting, and this
// exits on that rather than on how Electron happened to die. A run that stops before it
// has counted leaves no verdict and still fails, which is the case the exit code is
// actually for.
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const VERDICT = '/tmp/fetch-gl/verdict.json'
try { fs.rmSync(VERDICT, { force: true }) } catch {}

const r = spawnSync(require('electron'), [path.join(__dirname, 'harness.js'), ...process.argv.slice(2)],
  { stdio: 'inherit', env: { ...process.env, FETCH_GL_TESTS: '1' } })

let v = null
try { v = JSON.parse(fs.readFileSync(VERDICT, 'utf8')) } catch {}
if (!v) {
  console.log(`\nthe harness stopped before it had counted (${r.signal || `exit ${r.status}`}), so this run failed`)
  process.exit(1)
}
if (r.signal) {
  console.log(`Electron aborted on the way out (${r.signal}) after the run had finished. The count above stands.`)
}
process.exit(v.fail ? 1 : 0)
