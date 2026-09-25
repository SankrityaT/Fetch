// How a project starts, and starting it.
//
// project-windows could already tell somebody how: startHint reads the files at a
// project's top and says "npm run dev", "cargo run", "build and run it from Xcode".
// Then it stopped, and the person went and did it by hand. For a tool whose whole claim
// is that an agent drives it, being told to go and start your own dev server is the
// thing not working.
//
// So the hint becomes a command. The planning is here, pure and separately testable,
// because what to run is the part that can be wrong in a way nobody notices until a
// recording is of the wrong thing: a script called "dev" in one repo is a watcher that
// never serves, and "start" in another is a production build.
//
// Two rules this file keeps.
//
// Never invent a command. Only a script the project actually declares is ever run, read
// out of its own package.json, and where there is none this says so and refuses rather
// than guessing at `npm run dev` and handing back whatever npm prints.
//
// Never run anything without the person's word. Starting a dev server runs a repo's own
// code on somebody's Mac, which is a larger thing than recording a window, and it is
// gated on its own consent in the bridge. This module spawns nothing until told.
const fs = require('fs')
const path = require('path')

// The scripts worth starting, best first. A dev server is what a browser take needs, so
// the watch-and-serve names come before the ones that build for production.
const WEB_SCRIPTS = ['dev', 'start', 'serve', 'develop', 'dev:web', 'storybook']
// Scripts that are never a running product, whatever they are called: they finish and
// leave nothing to record, and a few of them write to the repository.
const NEVER = /^(build|test|lint|format|typecheck|tsc|prepare|postinstall|deploy|publish|release|clean|eject|migrate|seed)/i

// The package manager a repository already uses, read off its lockfile rather than
// chosen. Running pnpm's scripts with npm in a workspace repo fails in ways that read
// as the project being broken.
const LOCKS = [
  ['bun.lockb', 'bun'], ['bun.lock', 'bun'],
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
]

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

function managerFor(root, names) {
  for (const [lock, mgr] of LOCKS) if (names.includes(lock)) return mgr
  return 'npm'
}

// `npm run dev` needs the run; `yarn dev` and `bun dev` do not, and `npm start` is its
// own verb. Written out rather than composed, because each of these is a real spelling
// somebody's repository depends on.
function argvFor(mgr, script) {
  if (mgr === 'npm') return script === 'start' ? ['start'] : ['run', script]
  if (mgr === 'yarn') return [script]
  if (mgr === 'pnpm') return script === 'start' ? ['start'] : ['run', script]
  if (mgr === 'bun') return ['run', script]
  return ['run', script]
}

/**
 * What would start this project, or null with a reason.
 *
 * Returns { cmd, args, cwd, script, manager, kind, says } where kind is 'web' for
 * something that serves a page a browser can show, and says is the command written out
 * the way a person would type it, for the question they are asked before it runs.
 */
function planStart(root, { names = null, pkg = null } = {}) {
  if (!root) return { ok: false, why: 'no project folder' }
  let list = names
  if (!list) { try { list = fs.readdirSync(root) } catch { return { ok: false, why: `${root} could not be read` } } }

  if (list.includes('package.json')) {
    const json = pkg || readJson(path.join(root, 'package.json'))
    const scripts = (json && json.scripts && typeof json.scripts === 'object') ? json.scripts : null
    if (!scripts || !Object.keys(scripts).length) {
      return { ok: false, why: `${path.basename(root)} has a package.json with no scripts in it, so there is nothing declared to start.` }
    }
    const named = WEB_SCRIPTS.find(s => typeof scripts[s] === 'string' && scripts[s].trim() && !NEVER.test(s))
    if (!named) {
      const offered = Object.keys(scripts).filter(s => !NEVER.test(s))
      return { ok: false,
        why: offered.length
          ? `${path.basename(root)} declares no dev server script. It has ${offered.slice(0, 6).map(s => `"${s}"`).join(', ')}; name one to run it.`
          : `${path.basename(root)}'s scripts are all builds and checks, none of which leaves anything running to record.` }
    }
    const manager = managerFor(root, list)
    return { ok: true, cmd: manager, args: argvFor(manager, named), cwd: root, script: named,
      manager, kind: 'web', declared: scripts[named],
      says: `${manager} ${argvFor(manager, named).join(' ')}` }
  }

  if (list.includes('Cargo.toml')) return { ok: true, cmd: 'cargo', args: ['run'], cwd: root, kind: 'web', script: 'run', manager: 'cargo', says: 'cargo run' }
  if (list.includes('go.mod')) return { ok: true, cmd: 'go', args: ['run', '.'], cwd: root, kind: 'web', script: 'run', manager: 'go', says: 'go run .' }
  if (list.includes('manage.py')) return { ok: true, cmd: 'python3', args: ['manage.py', 'runserver'], cwd: root, kind: 'web', script: 'runserver', manager: 'django', says: 'python3 manage.py runserver' }

  // An Xcode project is a build, not a command: it needs a scheme, a destination and a
  // simulator, and guessing any of those puts somebody's app on the wrong device. The
  // simulator tool already does this properly, given a built .app, so say that rather
  // than shelling out to xcodebuild and hoping.
  if (list.some(f => f.endsWith('.xcodeproj') || f.endsWith('.xcworkspace'))) {
    return { ok: false, xcode: true,
      why: `${path.basename(root)} is an Xcode project, so starting it is a build for a chosen scheme and device rather than a command. Build it once, then simulator with action ready installs and launches the .app and Fetch records that.` }
  }
  return { ok: false, why: `nothing at the top of ${path.basename(root)} says how it starts.` }
}

// The first http URL a dev server prints. Every one of these prints one, and it is the
// only thing that says which port it really took: a server asked for 3000 and given
// 3001 because 3000 was busy is the single most common way a recording ends up of the
// wrong page.
const URL_RE = /(https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?:\/\S*)?)/i
function urlIn(text) {
  const m = URL_RE.exec(String(text || ''))
  if (!m) return null
  // 0.0.0.0 is a bind address, not somewhere a browser goes
  return m[1].replace('0.0.0.0', 'localhost').replace('[::1]', 'localhost').replace(/[.,)]$/, '')
}

module.exports = { planStart, urlIn, WEB_SCRIPTS, NEVER }

// ── running it ──────────────────────────────────────────────────────────
//
// The child is started detached from Fetch's own stdio and kept, so whoever asked for
// it can stop it again: a dev server Fetch started and then forgot is a port somebody
// has to hunt for later. Resolution is the URL it prints, and nothing else. Waiting on
// a port to open instead would answer as soon as the socket binds, which on every
// bundler measured here is a second or two before the page can be served, and a take
// started then is a take of a blank tab.
const { spawn } = require('child_process')

const START_WAIT_MS = 90000

/**
 * Start a project from a plan, and settle when it says where it is serving.
 *
 * Resolves { url, pid, stop, output } or rejects with what the server printed, which is
 * the useful part: a missing dependency or a port clash is in those lines and nowhere
 * else, and handing back "it did not start" alone leaves nobody anywhere to go.
 */
function run(plan, { timeoutMs = START_WAIT_MS, env = null } = {}) {
  return new Promise((resolve, reject) => {
    let child
    try {
      // detached so the child leads its own process group, which is the only way to
      // stop what it starts: `npm run dev` is a shell that spawns the real server, and
      // killing the npm alone leaves that server holding the port. Measured: a stop
      // that looked clean left a dev server on 3001 that outlived the app.
      child = spawn(plan.cmd, plan.args, { cwd: plan.cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
        env: { ...process.env, ...(env || {}), FORCE_COLOR: '0', BROWSER: 'none' } })
    } catch (e) { return reject(new Error(`${plan.says} would not start: ${e.message}`)) }

    const lines = []
    let done = false
    // the group first, then the child: the group is what holds the server, and the
    // child alone is what used to be killed
    const stop = () => {
      try { process.kill(-child.pid, 'SIGTERM') } catch {}
      try { child.kill('SIGTERM') } catch {}
      setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL') } catch {} }, 2000).unref()
    }
    const finish = (err, url) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (err) { stop(); reject(err) } else resolve({ url, pid: child.pid, stop, output: lines.join('') })
    }
    const timer = setTimeout(() => finish(new Error(
      `${plan.says} ran for ${Math.round(timeoutMs / 1000)} s without printing an address to open, so Fetch does not know ` +
      `what to record. What it printed:\n${lines.join('').slice(-800) || '(nothing)'}`)), timeoutMs)

    const read = buf => {
      const text = String(buf)
      lines.push(text)
      // bounded, because a watcher prints forever and this is only ever read for a URL
      if (lines.length > 400) lines.splice(0, lines.length - 400)
      const url = urlIn(text)
      if (url) finish(null, url)
    }
    child.stdout.on('data', read)
    child.stderr.on('data', read)
    child.on('error', e => finish(new Error(`${plan.says} would not start: ${e.message}`)))
    child.on('exit', code => finish(new Error(
      `${plan.says} exited${code == null ? '' : ` with code ${code}`} instead of serving. What it printed:\n` +
      `${lines.join('').slice(-800) || '(nothing)'}`)))
  })
}

module.exports.run = run
module.exports.START_WAIT_MS = START_WAIT_MS
