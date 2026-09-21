// Capturing a still: what Shot.swift writes, and what it refuses to write.
//
// The helper is the piece, so the test builds it and runs it rather than testing a
// description of it. Two halves: the refusals, which need no permission and run
// anywhere, and a real 40x30 point capture, which needs Screen Recording and says so
// and skips when it is not granted. The live half writes into /tmp and deletes what it
// wrote, because the one thing this piece promises is that a capture is a file on disk.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const root = path.join(__dirname, '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-still-'))

let pass = 0, fail = 0
const is = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}` + (ok ? '' : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`))
}

// ---------- build ----------
const bin = path.join(tmp, 'Shot')
console.log('the helper builds')
const built = spawnSync('swiftc', ['-O', path.join(root, 'Shot.swift'), '-o', bin], { encoding: 'utf8' })
is('swiftc is happy with Shot.swift', built.status, 0)
if (built.status !== 0) { console.log(built.stderr); process.exit(1) }

// One JSON object on stdout whichever way it went, so a caller never reads a log.
const shot = args => {
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 30000 })
  try { return JSON.parse(String(r.stdout).trim().split('\n').pop()) }
  catch { return { ok: false, error: 'no JSON: ' + String(r.stdout || r.stderr).slice(0, 200) } }
}

// ---------- refusals, before any pixel is read ----------
console.log('\nwhat it refuses')
const noOut = shot(['--region', '0,0,10,10'])
is('a shot with nowhere to go is refused', noOut.ok, false)
is('and says so', /--out/.test(noOut.error), true)

const badRegion = shot(['--out', path.join(tmp, 'never.png'), '--region', 'oops'])
is('a region that is not x,y,w,h is refused', badRegion.ok, false)
is('and says what it wanted', /x,y,w,h/.test(badRegion.error), true)
is('nothing was written', fs.existsSync(path.join(tmp, 'never.png')), false)

// ---------- the live half ----------
const probe = shot(['--out', path.join(tmp, 'probe.png'), '--region', '0,0,40,30'])
const granted = probe.ok === true
if (!granted && /Screen Recording|shareable content/.test(probe.error || '')) {
  console.log('\n  skipping the live capture: Screen Recording is not granted here')
} else {
  console.log('\nwhat a capture returns')
  is('it captured', probe.ok, true)
  is('a file at the path it was given', fs.existsSync(probe.path), true)
  is('the path it reports is the path it was asked for', probe.path, path.join(tmp, 'probe.png'))
  is('it says what it captured', probe.kind, 'region')
  // Field by field: the helper answers in JSON and a JSON object holds no order.
  is('and the bounds, in points, that it stood for',
    [probe.bounds.x, probe.bounds.y, probe.bounds.width, probe.bounds.height], [0, 0, 40, 30])
  is('a scale factor of at least 1', probe.scale >= 1, true)
  is('full backing resolution, not points', [probe.width, probe.height], [40 * probe.scale, 30 * probe.scale])
  is('the person\'s pointer is out unless it is the point', probe.cursor, false)
  is('it names the display it came off', typeof probe.display, 'number')
  is('and the protected windows it left out', Array.isArray(probe.excluded), true)
  is('bytes on disk', probe.bytes > 0 && probe.bytes === fs.statSync(probe.path).size, true)

  // PNG signature and IHDR: colour type 6 is RGBA, which is what lets a window keep
  // its own shape instead of arriving on a rectangle of black.
  const png = fs.readFileSync(probe.path)
  is('it really is a PNG', png.slice(0, 8).toString('hex'), '89504e470d0a1a0a')
  is('8 bit RGBA', [png.readUInt8(24), png.readUInt8(25)], [8, 6])
  is('the pixels it claimed', [png.readUInt32BE(16), png.readUInt32BE(20)], [probe.width, probe.height])

  // Never black bars: a rectangle that hangs off the screen comes back as the part of
  // it that exists, said out loud, rather than padded out to the size that was asked
  // for. The compositor is given real pixels or nothing.
  console.log('\na region that hangs off the screen')
  const over = shot(['--out', path.join(tmp, 'over.png'), '--region', '-20,100,60,40'])
  is('it captures what is there', over.ok, true)
  is('clipped to the display', [over.bounds.x, over.bounds.width], [0, 40])
  is('and says it was clipped', over.clipped, true)
  is('with no padding in the file', [over.width, over.height], [40 * over.scale, 40 * over.scale])

  const off = shot(['--out', path.join(tmp, 'off.png'), '--region', '-9000,-9000,50,50'])
  is('a region on no display at all is refused', off.ok, false)
  is('rather than written as an empty file', fs.existsSync(path.join(tmp, 'off.png')), false)

  console.log('\nwindows it cannot capture')
  const gone = shot(['--out', path.join(tmp, 'gone.png'), '--window', '999999'])
  is('a window that is not on screen is refused', gone.ok, false)
  is('and named', /999999/.test(gone.error), true)

  // Ids that closed since the list was read drop out rather than failing the shot: a
  // protected window that is already gone cannot be in the frame.
  const stale = shot(['--out', path.join(tmp, 'stale.png'), '--region', '0,0,20,20', '--exclude', '999999'])
  is('an exclusion that is no longer on screen is not a failure', stale.ok, true)
  is('and is reported as not excluded', stale.excluded, [])
}

// ---------- the never-record list runs before the helper does ----------
console.log('\nthe list is enforced in main, not asked for')
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
// The body is a named function the agent bridge is handed, with the ipc handler a
// one-line delegate over it, so take_shot and the Take a shot chip take one path.
const handler = main.slice(main.indexOf('async function takeShot('), main.indexOf('// ---------- edit / post-production'))
is('there is a still to take', handler.length > 0, true)
is('the ipc handler only delegates to it', /ipcMain\.handle\('take-shot', \(e, opts = \{\}\) => takeShot\(opts\)\)/.test(main), true)
is('and the agent bridge is handed the same function', /\n\s*takeShot,\n/.test(main), true)
is('the policy decides before anything is spawned',
  handler.indexOf('policy.decide') < handler.indexOf('runShot'), true)
is('a wider shot has the protected windows taken out of the frame',
  handler.indexOf('windowsToExclude') < handler.indexOf('runShot'), true)
// Names as well as ids. A window id can only name a window the picker listed, and that
// list is filtered: the helper matches the names against every window it can see.
is('and the never-record apps go by name, which no picker can filter away',
  handler.indexOf('appsToExclude') < handler.indexOf('runShot'), true)
is('an agent take on ask needs a person first', /needsApproval/.test(handler), true)
is('the capture lands in Original, untouched', /newShotPath/.test(handler), true)
is('a shot that failed leaves no empty folder behind', /rmSync/.test(handler), true)
// Fetch is in WindowList's skip set, so its own window can never reach --exclude: the
// only way out of a display or region shot is to be off screen while the helper runs.
is('Fetch gets itself out of a display or region shot',
  handler.indexOf('control.hide()') < handler.indexOf('runShot'), true)

console.log('\nthe helper decides what is left out, not the picker')
const swift = fs.readFileSync(path.join(root, 'Shot.swift'), 'utf8')
is('it takes the never-record apps by name', /--exclude-app/.test(swift), true)
is('and matches them against its own unfiltered enumeration',
  /o\.excludeApps\.contains \{ nameMatches\(owner, \$0\) \}/.test(swift), true)
is('a window is measured on the display it is mostly on', /max\(by: \{ overlap\(\$0\) < overlap\(\$1\) \}\)/.test(swift), true)

// ---------- a capture that cannot work fails, it does not stall ----------
// The worst failure there is has no error in it: an agent with nobody at the Mac waits
// on a permission dialog it cannot see and cannot answer, and reports nothing, forever.
// Both ends of the capture path read the grant before they read a pixel, and refuse with
// a sentence that says what to do.
console.log('\nwhat happens when Screen Recording is not granted')
const policy = require('../ui/record-policy')
const says = (r, re) => r.allow === false && re.test(r.reason)

is('granted is the only state that just works', policy.screenAccess('granted', 'agent').allow, true)
is('an agent is refused when the grant was never asked for',
  says(policy.screenAccess('not-determined', 'agent'), /has not been granted/), true)
is('and told where the person turns it on',
  /System Settings, Privacy and Security, Screen Recording/.test(policy.screenAccess('not-determined', 'agent').reason), true)
is('and that it takes a restart',
  /restart Fetch/.test(policy.screenAccess('not-determined', 'agent').reason), true)
// A person can answer the system's own prompt, and answering it is the shortest way to a
// granted Mac, so their first capture is allowed to raise it. An agent's never is.
is('a person still meets the system prompt', policy.screenAccess('not-determined', 'human').allow, true)
// Electron's screen status is a boolean preflight, so a never-asked Mac reads 'denied'
// and a person refused on it never sees the prompt that would grant it. They go through
// to the helper, which does not preflight for a person, and macOS answers for itself.
is('and a person is not refused on a reading that cannot tell never-asked from no',
  policy.screenAccess('denied', 'human').allow, true)
is('an agent is refused on the same reading', policy.screenAccess('denied', 'agent').allow, false)
is('and so is a managed Mac', policy.screenAccess('restricted', 'agent').allow, false)
// The two callers want opposite things from a Mac that was never asked, so who asked has
// to reach the one process that can raise the prompt.
is('who asked reaches the helper', /'--by', by/.test(main), true)
is('and the helper preflights for an agent alone', /o\.byAgent && !CGPreflightScreenCaptureAccess\(\)/.test(swift), true)
// A state nobody could measure is not grounds to refuse a capture that would have worked.
is('an unreadable state is not a refusal', policy.screenAccess('unknown', 'agent').allow, true)

is('the grant is read before the never-record list, before anything is spawned',
  handler.indexOf('screenAccess') < handler.indexOf('policy.decide')
  && handler.indexOf('screenAccess') < handler.indexOf('runShot'), true)
is('and the result is flagged as a permission, not a crash', /needsPermission/.test(handler), true)
is('Fetch reads the grant and never asks for it on the person\'s behalf',
  /askForMediaAccess|requestMediaAccess/.test(main), false)

// 'ask' is the shipping default, and an agent that is refused there needs the same thing:
// a sentence it can hand to the person rather than "nobody approved this".
is('the ask refusal says what to do', /Recording access to open/.test(policy.UNANSWERED), true)
is('and takeShot speaks the policy\'s own sentence', /verdict\.unanswered/.test(handler), true)

// The helper is killed at twenty seconds. That is a bounded failure, so it has to arrive
// as a reason rather than as silence.
is('a helper that never answered says what is holding it',
  /err\.killed/.test(main) && /waiting for someone to grant Fetch Screen Recording/.test(main), true)

is('the helper preflights before it reads any content',
  swift.indexOf('CGPreflightScreenCaptureAccess') < swift.indexOf('SCShareableContent.excludingDesktopWindows'), true)
is('and the preflight only reads', /CGRequestScreenCaptureAccess/.test(swift), false)

console.log('\nthe helper ships')
const build = fs.readFileSync(path.join(root, 'build.sh'), 'utf8')
is('build.sh compiles it', /swiftc -O Shot\.swift/.test(build), true)
is('and signs it', /sign "\$APP\/Contents\/Resources\/Shot"/.test(build), true)

console.log('\nhouse style')
// Built from its code point rather than written out: a literal one here would be a dash
// in a file this very check reads, and the test would fail on itself.
const emDash = String.fromCharCode(0x2014)
for (const f of ['Shot.swift', 'main.js', 'test/shot.test.js']) {
  is(`no em dashes in ${f}`, fs.readFileSync(path.join(root, f), 'utf8').includes(emDash), false)
}

try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
