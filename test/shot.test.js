// Capturing a still: what Shot.swift writes, and what it refuses to write.
//
// The helper is the piece, so the test builds it and runs it rather than testing a
// description of it. Two halves: the refusals, which need no permission and run
// anywhere, and a real 40x30 point capture, which needs Screen Recording and a working
// capture service, and says SKIPPED, with the reason, when it has neither. The live half
// writes into /tmp and deletes what it wrote, because the one thing this piece promises
// is that a capture is a file on disk. FETCH_NO_LIVE_CAPTURE=1 skips it on purpose.
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
// Two outcomes look the same from the outside and mean opposite things. A capture that
// ran and handed back the wrong thing is a failure. A capture that never ran because the
// service was already down, or because ScreenCaptureKit said its connection went, says
// nothing about Shot.swift, so it is SKIPPED, loudly, counted apart from the passes.
//
// A skip is never a pass. What can only be Shot's own fault is a FAIL even when it looks
// like the service: a hang (a deadlock in Shot.swift reads exactly like a hung daemon), a
// ScreenCaptureKit error about what Shot asked for (a rect it did not clip is a parameter
// error, not a service one), and a replayd crash that happened while this file was
// capturing. And a run whose live half never ran exits 2, not 0, unless
// FETCH_NO_LIVE_CAPTURE says that was the point: replayd exits when the Mac is idle, and
// a suite that stays green every time for that reason has stopped checking anything.
//
// This section also stops asking once the service is gone. One capture that finds it
// down is the answer; the next four would only knock on a daemon that just fell over.
const started = Date.now()
const reports = path.join(os.homedir(), 'Library', 'Logs', 'DiagnosticReports')
// replayd's crash reports, newest first, by the time they were written.
const replaydCrashes = () => {
  try {
    return fs.readdirSync(reports).filter(f => /^replayd.*\.ips$/.test(f))
      .map(f => ({ f, t: fs.statSync(path.join(reports, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
  } catch { return [] }
}
// launchd starts replayd on demand and lets it exit under pressure, so its absence on an
// idle Mac can be ordinary. Tonight it was the only sign that capture was down across the
// whole Mac, and waking it to find out is exactly what this must not do. Absent is a skip.
const replaydRunning = () => {
  const r = spawnSync('/usr/bin/pgrep', ['-x', 'replayd'], { encoding: 'utf8' })
  return r.status === 0 ? true : r.status === 1 ? false : null
}

// Why the capture service cannot be asked right now, or null when it can. Read before any
// capture: a crash in the last fifteen minutes means the service is still coming back.
const RECENT = 15 * 60 * 1000
const serviceBefore = () => {
  if (process.env.FETCH_NO_LIVE_CAPTURE) return 'FETCH_NO_LIVE_CAPTURE is set, so no capture was asked for'
  if (replaydRunning() === false) return 'replayd, the macOS capture service, is not running'
  const last = replaydCrashes()[0]
  if (last && Date.now() - last.t < RECENT) {
    const mins = Math.round((Date.now() - last.t) / 60000)
    return `replayd crashed ${mins < 1 ? 'under a minute' : mins === 1 ? 'a minute' : mins + ' minutes'} ago (${last.f})`
  }
  return null
}

// What a helper answer says about the service rather than about Shot.swift. Only answers
// that never reached a pixel count: a hang, a refusal from ScreenCaptureKit itself, or a
// missing grant. A helper that crashed, wrote nothing it should have, or refused for a
// reason of its own is still a failure, because those are this code's to get right.
// SCStreamError's codes for the service itself: connection invalid (-3804) or interrupted
// (-3805), an internal failure (-3811), the system stopping capture (-3821). Anything else
// from SCStreamErrorDomain (-3802 failed to start, -3812 invalid parameter, a filter
// error) is about what Shot asked for, and is Shot's to fix.
const SERVICE_CODES = [-3804, -3805, -3811, -3821]
const serviceTrouble = (r, got) => {
  if (r.error && r.error.code === 'ETIMEDOUT') return null
  if (got.ok !== false) return null
  const why = String(got.error || '')
  if (/has not been granted/.test(why)) return 'Screen Recording is not granted here'
  if (/could not read shareable content/.test(why)) return 'ScreenCaptureKit would not list the screen: ' + why.split('. ')[0]
  const code = /SCStreamErrorDomain error (-?\d+)/.exec(why)
  if (code) return SERVICE_CODES.includes(+code[1]) ? 'ScreenCaptureKit lost its service: ' + why.slice(0, 160) : null
  if (/connection (was )?(interrupted|invalidated)|replayd/i.test(why)) return 'the capture service went away: ' + why.slice(0, 160)
  return null
}

// Every live capture goes through here. It returns the helper's answer, or null once the
// service is down, and each null is one capture SKIPPED.
let skipped = 0, downWhy = null
const stopped = why => why.replace(/[.)]*$/, m => m.includes(')') ? ')' : '') + '.'
const say = why => {
  console.log('\n  ' + '!'.repeat(72))
  console.log('  SKIPPED  the live capture. ' + stopped(why))
  console.log('           Nothing was captured, so nothing here says a capture works.')
  console.log('  ' + '!'.repeat(72))
}
const live = args => {
  if (downWhy) { skipped++; return null }
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 30000 })
  if (r.error && r.error.code === 'ETIMEDOUT') {
    // Shot.swift waits on a semaphore for the capture: a hang is its to answer for
    is(`the helper answers within 30 s (${args.join(' ')})`, 'hung', 'answered')
    downWhy = 'the helper hung, which is a FAIL above, and no more captures were asked for'
    return null
  }
  let got
  try { got = JSON.parse(String(r.stdout).trim().split('\n').pop()) }
  catch { got = { ok: false, error: 'no JSON: ' + String(r.stdout || r.stderr).slice(0, 200) } }
  const why = serviceTrouble(r, got)
  if (!why) return got
  downWhy = why + (replaydRunning() === false ? ', and replayd is not running' : '')
  say(downWhy)
  skipped++
  return null
}

// The judge is its own piece, so it is checked against the answers tonight's broken Mac
// gave, with no capture at all. If these slip, a down service reads as a pass again.
console.log('\nwhat counts as the service being down')
const timedOut = { error: { code: 'ETIMEDOUT' } }
is('a hang is not taken for the service: it is failed where it happens', serviceTrouble(timedOut, { ok: false, error: 'no JSON: ' }), null)
is('so is a Mac with no grant',
  serviceTrouble({}, { ok: false, error: 'Screen Recording permission has not been granted to Fetch, so there is nothing to capture.' }) !== null, true)
is('so is ScreenCaptureKit refusing to list the screen',
  serviceTrouble({}, { ok: false, error: 'could not read shareable content: The operation could not be completed. Screen Recording permission is most likely not granted to Fetch.' }) !== null, true)
is('so is ScreenCaptureKit losing its connection',
  serviceTrouble({}, { ok: false, error: 'The operation could not be completed. (com.apple.ScreenCaptureKit.SCStreamErrorDomain error -3805.)' }) !== null, true)
is('but a ScreenCaptureKit error about what Shot asked for is Shot\'s',
  serviceTrouble({}, { ok: false, error: 'The operation could not be completed. (com.apple.ScreenCaptureKit.SCStreamErrorDomain error -3802.)' }), null)
is('and so is an invalid parameter',
  serviceTrouble({}, { ok: false, error: 'The operation could not be completed. (com.apple.ScreenCaptureKit.SCStreamErrorDomain error -3812.)' }), null)
is('a capture that came back is never the service', serviceTrouble({}, { ok: true, bounds: { x: 9 } }), null)
is('nor is a refusal Shot.swift wrote for itself', serviceTrouble({}, { ok: false, error: 'that region came out empty' }), null)
is('nor a window it could not find', serviceTrouble({}, { ok: false, error: 'window 999999 is not on screen any more' }), null)
is('nor a helper that crashed without a word', serviceTrouble({ signal: 'SIGSEGV' }, { ok: false, error: 'no JSON: ' }), null)

const before = serviceBefore()
if (before) { downWhy = before; say(before) }

// Field by field, and never through a property of something that is not there: a wrong
// answer has to arrive as FAIL lines, not as a TypeError that hides the rest of the file.
const probe = live(['--out', path.join(tmp, 'probe.png'), '--region', '0,0,40,30'])
if (probe) {
  const b = probe.bounds || {}
  console.log('\nwhat a capture returns')
  is('it captured', probe.ok, true)
  is('a file at the path it was given', fs.existsSync(String(probe.path)), true)
  is('the path it reports is the path it was asked for', probe.path, path.join(tmp, 'probe.png'))
  is('it says what it captured', probe.kind, 'region')
  // Field by field: the helper answers in JSON and a JSON object holds no order.
  is('and the bounds, in points, that it stood for', [b.x, b.y, b.width, b.height], [0, 0, 40, 30])
  is('a scale factor of at least 1', probe.scale >= 1, true)
  is('full backing resolution, not points', [probe.width, probe.height], [40 * probe.scale, 30 * probe.scale])
  is('the person\'s pointer is out unless it is the point', probe.cursor, false)
  is('it names the display it came off', typeof probe.display, 'number')
  is('and the protected windows it left out', Array.isArray(probe.excluded), true)
  const onDisk = probe.ok === true && fs.existsSync(String(probe.path))
  is('bytes on disk', onDisk && probe.bytes > 0 && probe.bytes === fs.statSync(probe.path).size, true)

  // PNG signature and IHDR: colour type 6 is RGBA, which is what lets a window keep
  // its own shape instead of arriving on a rectangle of black.
  const png = onDisk ? fs.readFileSync(probe.path) : Buffer.alloc(26)
  is('it really is a PNG', png.slice(0, 8).toString('hex'), '89504e470d0a1a0a')
  is('8 bit RGBA', [png.readUInt8(24), png.readUInt8(25)], [8, 6])
  is('the pixels it claimed', [png.readUInt32BE(16), png.readUInt32BE(20)], [probe.width, probe.height])
}

// Never black bars: a rectangle that hangs off the screen comes back as the part of
// it that exists, said out loud, rather than padded out to the size that was asked
// for. The compositor is given real pixels or nothing.
const over = live(['--out', path.join(tmp, 'over.png'), '--region', '-20,100,60,40'])
if (over) {
  const b = over.bounds || {}
  console.log('\na region that hangs off the screen')
  is('it captures what is there', over.ok, true)
  is('clipped to the display', [b.x, b.width], [0, 40])
  is('and says it was clipped', over.clipped, true)
  is('with no padding in the file', [over.width, over.height], [40 * over.scale, 40 * over.scale])
}

// The refusals below are the ones a down service would fake: ok false is what they
// expect, and ok false is what a broken Mac says to everything. live() takes the broken
// Mac's answers out before they can be read as the refusal the test wanted.
const off = live(['--out', path.join(tmp, 'off.png'), '--region', '-9000,-9000,50,50'])
if (off) {
  is('a region on no display at all is refused', off.ok, false)
  is('rather than written as an empty file', fs.existsSync(path.join(tmp, 'off.png')), false)
}

const gone = live(['--out', path.join(tmp, 'gone.png'), '--window', '999999'])
if (gone) {
  console.log('\nwindows it cannot capture')
  is('a window that is not on screen is refused', gone.ok, false)
  is('and named', /999999/.test(gone.error), true)
}

// Ids that closed since the list was read drop out rather than failing the shot: a
// protected window that is already gone cannot be in the frame.
const stale = live(['--out', path.join(tmp, 'stale.png'), '--region', '0,0,20,20', '--exclude', '999999'])
if (stale) {
  is('an exclusion that is no longer on screen is not a failure', stale.ok, true)
  is('and is reported as not excluded', stale.excluded, [])
}

// A crash report written while this file was capturing fails it. Other processes use
// replayd too, so it may not be Shot's, but a run that took the Mac's screen capture down
// is not a green run, and nobody should learn of it later. Where the live half never
// asked for a capture there is nothing of this file's in it, and it is only said.
const crashed = replaydCrashes().filter(c => c.t >= started)
const asked = !before
if (crashed.length && asked) {
  is('the capture service did not crash while this file captured', crashed.map(c => c.f), [])
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
console.log(`\n${pass} passed, ${fail} failed, ${skipped} SKIPPED`)
if (skipped) {
  console.log(`SKIPPED ${skipped} live capture${skipped === 1 ? '' : 's'}: ${stopped(downWhy)}`)
  console.log('The live half of this file did not run. Run it again once capture works.')
}
if (crashed.length) {
  console.log(`WARNING: replayd crashed while this ran: ${crashed.map(c => c.f).join(', ')}. ` +
    'Screen capture may be down across this Mac.')
}
if (fail) process.exit(1)
// Nothing failed and the live half did not run: not a pass, unless that was asked for
if (skipped && !process.env.FETCH_NO_LIVE_CAPTURE) {
  console.log('exit 2: the live capture was not checked. Set FETCH_NO_LIVE_CAPTURE=1 to skip it on purpose.')
  process.exit(2)
}
