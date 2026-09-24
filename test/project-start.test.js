// How a project starts, worked out rather than told to the person.
//
// project-windows could already say "npm run dev". Then it stopped and the person went
// and typed it. For a tool whose claim is that an agent drives it, being told to go and
// start your own dev server is the thing not working.
//
// Two rules this suite holds it to. Never invent a command: only a script the project
// itself declares is ever run. And never run a script that leaves nothing to record: a
// build finishes, and a take of a finished build is a take of a terminal.
const fs = require('fs'), path = require('path'), os = require('os')
const PS = require('../ui/project-start')
const ROOT = path.join(__dirname, '..')

let pass = 0, fail = 0
const is = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`)
}
const plan = (names, pkg) => PS.planStart('/tmp/proj', { names, pkg })

// ── the command comes off the project, never off a guess ────────────────
is('a dev script is what a browser take needs',
  (r => [r.ok, r.says])(plan(['package.json'], { scripts: { dev: 'vite', build: 'vite build' } })),
  [true, 'npm run dev'])
is('start is taken when there is no dev',
  plan(['package.json'], { scripts: { start: 'node server.js' } }).says, 'npm start')
is('dev wins over start, because start is often the production build',
  plan(['package.json'], { scripts: { start: 'node dist/server.js', dev: 'vite' } }).script, 'dev')

// the package manager is read off the lockfile: pnpm scripts run with npm fail in a
// workspace repo in ways that read as the project being broken
is('pnpm is read off its lock', plan(['package.json', 'pnpm-lock.yaml'], { scripts: { dev: 'x' } }).says, 'pnpm run dev')
is('yarn takes no run', plan(['package.json', 'yarn.lock'], { scripts: { dev: 'x' } }).says, 'yarn dev')
is('bun is read off its lock', plan(['package.json', 'bun.lockb'], { scripts: { dev: 'x' } }).says, 'bun run dev')
is('npm is the fallback, not a guess at one', plan(['package.json'], { scripts: { dev: 'x' } }).manager, 'npm')

// ── what is never started ───────────────────────────────────────────────
is('a repo whose scripts are all builds is refused, not started',
  (r => [r.ok, /none of which leaves anything running/.test(r.why)])(
    plan(['package.json'], { scripts: { build: 'tsc', test: 'jest', lint: 'eslint .' } })), [false, true])
is('and the ones it does have are named, so the person can pick',
  /"serve:prod"|"preview"/.test(plan(['package.json'], { scripts: { preview: 'vite preview', build: 'x' } }).why || ''), true)
is('a package.json with no scripts says exactly that',
  /no scripts in it/.test(plan(['package.json'], {}).why || ''), true)
is('nothing recognisable is refused with the folder named',
  (r => [r.ok, /nothing at the top of/.test(r.why)])(plan(['README.md'])), [false, true])

// An Xcode project is a build for a scheme and a device, and guessing either puts
// somebody's app on the wrong phone. Refused by name, with the thing that does work.
const x = plan(['App.xcodeproj', 'README.md'])
is('an Xcode project is not shelled out to', [x.ok, x.xcode], [false, true])
is('and it names the path that does work', /simulator with action ready/.test(x.why), true)

// ── other runtimes, only where the file that declares them is there ─────
is('cargo', plan(['Cargo.toml']).says, 'cargo run')
is('go', plan(['go.mod']).says, 'go run .')
is('django', plan(['manage.py']).says, 'python3 manage.py runserver')

// ── the address it prints is the only thing that says where it really is ─
is('a vite line', PS.urlIn('  ➜  Local:   http://localhost:5173/'), 'http://localhost:5173/')
is('a next line', PS.urlIn('- Local:        http://localhost:3000'), 'http://localhost:3000')
is('a bind address is turned into somewhere a browser can go',
  PS.urlIn('Listening on http://0.0.0.0:8080'), 'http://localhost:8080')
is('and so is a v6 loopback', PS.urlIn('serving http://[::1]:4321/'), 'http://localhost:4321/')
is('a port it was pushed onto is the one read', PS.urlIn('Port 3000 in use, using http://localhost:3001'), 'http://localhost:3001')
is('a line with no address is no address', PS.urlIn('compiled successfully'), null)
is('nothing is not an address', PS.urlIn(null), null)

// ── a real folder on this machine, read off disk ────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-start-'))
fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }))
fs.writeFileSync(path.join(tmp, 'pnpm-lock.yaml'), '')
const real = PS.planStart(tmp)
is('a folder is read from disk when no names are handed in', [real.ok, real.says, real.cwd], [true, 'pnpm run dev', tmp])
is('a folder that is not there is a reason, never a throw', PS.planStart('/no/such/place').ok, false)
fs.rmSync(tmp, { recursive: true, force: true })

// ── and the bridge gates it on its own yes ──────────────────────────────
const bridge = fs.readFileSync(path.join(ROOT, 'ui/agent-bridge.js'), 'utf8')
is('starting a project is asked for separately from recording it', /wants to start \$\{p\.handle \|\| p\.name\} to record it/.test(bridge), true)
is('and the question says the command in full before anything spawns', /It will run \$\{plan\.says\} in \$\{p\.path\}/.test(bridge), true)
is('a standing yes is offered for it', /alwaysLabel: `Always start/.test(bridge), true)
is('it is only tried when nothing of the project is running', /!running\.pick && \/\^Nothing from \/\.test\(running\.why/.test(bridge), true)
is('a refusal to start is folded into the reason, never swallowed', /Fetch tried to start it and could not/.test(bridge), true)
is('what it ran is reported back', /started: \{ ran: began\.says, url: began\.url, pid: began\.pid \}/.test(bridge), true)
is('one project is never started twice', /const live = started\.get\(p\.path\)/.test(bridge), true)
is('and servers it started go when Fetch does', /stopStartedServers/.test(bridge), true)
const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8')
is('which main calls on the way out', /stopStartedServers\(\)/.test(mainSrc), true)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
