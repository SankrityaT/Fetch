// The wrapper's whole value is the refusal, so most of this file is about what comes
// back when simctl says no. Every stderr fixture here was copied from a real run on this
// Mac, exit code included, because the mapping from a failure to a sentence is only
// worth anything if it matches the failures that actually happen.
//
// No device is booted by this file and no process is started: the spawn is injected.

const { EventEmitter } = require('events')
const S = require('../ui/simctl')

let pass = 0, fail = 0
const is = (name, got, want) => {
  const okay = JSON.stringify(got) === JSON.stringify(want)
  okay ? pass++ : fail++
  console.log(`  ${okay ? 'ok  ' : 'FAIL'} ${name}` + (okay ? '' : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`))
}
const has = (name, text, re) => is(name, re.test(String(text)), true)

const UD = 'A1EDEC56-560D-4E95-A19C-87F2FC438103'
const UD2 = '9F72E171-D1DD-4A7E-8C78-2CB1F540AE95'

// ---- stderr exactly as simctl wrote it here ----
const ERR = {
  invalidDevice: `Invalid device: 00000000-0000-0000-0000-000000000000\n`,
  noneBooted: `No devices are booted.\n`,
  shutdown: `An error was encountered processing the command (domain=com.apple.CoreSimulator.SimError, code=405):\nUnable to lookup in current state: Shutdown\n`,
  alreadyBooted: `An error was encountered processing the command (domain=com.apple.CoreSimulator.SimError, code=405):\nUnable to boot device in current state: Booted\n`,
  alreadyShut: `An error was encountered processing the command (domain=com.apple.CoreSimulator.SimError, code=405):\nUnable to shutdown device in current state: Shutdown\n`,
  noApp: `An error was encountered processing the command (domain=FBSOpenApplicationServiceErrorDomain, code=4):\nSimulator device failed to launch com.example.nope.\nUnderlying error (domain=FBSOpenApplicationServiceErrorDomain, code=4):\n\tThe request to open "com.example.nope" failed.\n`,
  notRunning: `An error was encountered processing the command (domain=NSPOSIXErrorDomain, code=3):\nSimulator device failed to terminate com.apple.mobilesafari.\nfound nothing to terminate\n`,
  noPath: `An error was encountered processing the command (domain=NSPOSIXErrorDomain, code=2):\nSimulator device failed to install the application.\nUnhandled error domain NSPOSIXErrorDomain, code 2\nUnderlying error (domain=NSPOSIXErrorDomain, code=2):\n\tlstat of /tmp/definitely-not-here.app failed: No such file or directory\n`,
  noHandler: `An error was encountered processing the command (domain=LSApplicationWorkspaceErrorDomain, code=115):\nSimulator device failed to open zzzz://nothing.\n`,
  badArg: `An error was encountered processing the command (domain=NSPOSIXErrorDomain, code=22):\nSimulator device failed to complete the requested operation.\nInvalid argument\n`,
  unknownSub: `Unrecognized subcommand: nosuchsub\n`,
  noXcode: `xcrun: error: missing DEVELOPER_DIR path: /nonexistent\n`,
  noRuntime: `An error was encountered processing the command (domain=com.apple.CoreSimulator.SimError, code=162):\nThe runtime is not available: iOS 12.0\n`,
}

const BAR_EMPTY = 'Current Status Bar Overrides:\n=============================\n'
const BAR_FULL = `Current Status Bar Overrides:
=============================
Time: 7:20
DataNetworkType: 8
WiFi Mode: 2, WiFi Bars: 1
Cell Mode: 3, Cell Bars: 2
Operator Name: Yaad
Battery State: 0, Battery Level: 42, Not Charging: 1
`

// A spawn that starts nothing. `script(bin, args, n)` says how the nth child behaves:
// {code, out, err, hang, error}.
function fakeSpawn(script) {
  const calls = []
  const fn = (bin, args) => {
    const child = new EventEmitter()
    for (const s of ['stdout', 'stderr']) { child[s] = new EventEmitter(); child[s].setEncoding = () => {} }
    child.killed = []
    child.kill = sig => child.killed.push(sig || 'SIGTERM')
    const n = calls.length
    calls.push({ bin, args, child })
    const r = script(bin, args, n) || {}
    if (!r.hang) {
      setImmediate(() => {
        if (r.error) return child.emit('error', new Error(r.error))
        if (r.out) child.stdout.emit('data', r.out)
        if (r.err) child.stderr.emit('data', r.err)
        child.emit('close', r.code == null ? 0 : r.code)
      })
    }
    return child
  }
  fn.calls = calls
  return fn
}

// A filesystem in a variable, so the stash can be read back and asserted on.
function fakeFs(seed = {}) {
  const files = { ...seed }
  return {
    files,
    constants: { X_OK: 1 },
    readFileSync: p => { if (!(p in files)) { const e = new Error('ENOENT'); throw e } return files[p] },
    writeFileSync: (p, v) => { if (files.__locked) throw new Error('read-only folder'); files[p] = v },
    mkdirSync: () => {},
    accessSync: p => { if (!files[`bin:${p}`]) throw new Error('ENOENT') },
  }
}

const STASH = '/tmp/fetch-test-sim-stash.json'
const mk = (script, over = {}) => S.make({
  spawn: fakeSpawn(script), fs: over.fs || fakeFs(), stashPath: STASH,
  budget: { read: 1000, act: 1000, boot: 1000, shutdown: 1000, install: 1000 },
  firstMs: 1000, ...over,
})

async function main() {
  // ---- a udid, always, and never the word booted ----
  const sim = mk(() => ({ code: 0, out: '' }))
  is('the literal booted is refused', (await sim.boot('booted')).fault, 'no-udid')
  has('and says to pass the udid', (await sim.boot('booted')).reason, /list the simulators and pass the udid/i)
  is('a device name is refused', (await sim.launch('Round-Shots-16PM', 'com.me.app')).fault, 'no-udid')
  is('nothing at all is refused', (await sim.shutdown('')).fault, 'no-udid')
  is('a udid is accepted', (await sim.appearance(UD)).ok, true)

  // ---- argv, which is most of what this file is ----
  {
    const spawn = fakeSpawn(() => ({ code: 0, out: 'light\n' }))
    const s = S.make({ spawn, fs: fakeFs(), stashPath: STASH })
    await s.boot(UD)
    is('boot is bootstatus -b, one process that boots and waits', spawn.calls[0].args, ['simctl', 'bootstatus', UD, '-b'])
    is('and it goes through xcrun', spawn.calls[0].bin, 'xcrun')
    await s.launch(UD, 'com.me.app')
    is('launch relaunches clean by default', spawn.calls[1].args, ['simctl', 'launch', '--terminate-running-process', UD, 'com.me.app'])
    await s.launch(UD, 'com.me.app', { relaunch: false })
    is('and leaves a running app alone when told to', spawn.calls[2].args, ['simctl', 'launch', UD, 'com.me.app'])
    await s.openurl(UD, 'myapp://onboarding/2')
    is('a deep link is one call', spawn.calls[3].args, ['simctl', 'openurl', UD, 'myapp://onboarding/2'])
    await s.setAppearance(UD, 'dark')
    is('appearance takes the word', spawn.calls[4].args, ['simctl', 'ui', UD, 'appearance', 'dark'])
    is('and refuses one that is not a word simctl knows', (await s.setAppearance(UD, 'sepia')).fault, 'bad-argument')
    await s.listDevices()
    is('the device list asks for json', spawn.calls[5].args, ['simctl', 'list', 'devices', '-j'])
  }

  // The empty carrier name is the argv gotcha: through a shell it eats the next flag,
  // measured. An args array keeps it as its own empty argument.
  {
    const args = S.barArgs(S.HOUSE_BAR).value
    const at = args.indexOf('--operatorName')
    is('the house preset blanks the carrier with a real empty argument', [args[at], args[at + 1]], ['--operatorName', ''])
    is('the house clock is 9:41', args[args.indexOf('--time') + 1], '9:41')
  }

  // ---- the failures, each with its own sentence ----
  const cases = [
    ['no-xcode', 'list the devices', { code: 1, err: ERR.noXcode }, {}, /xcode-select/],
    ['no-device', 'boot', { code: 148, err: ERR.invalidDevice }, { udid: UD }, /list the devices/i],
    ['none-booted', 'read the status bar of', { code: 148, err: ERR.noneBooted }, {}, /no simulator is booted/i],
    ['not-booted', 'install the app', { code: 149, err: ERR.shutdown }, { udid: UD }, /is not booted, so Fetch could not install the app/],
    ['no-app', 'launch the app', { code: 4, err: ERR.noApp }, { udid: UD, bundle: 'com.example.nope' }, /com\.example\.nope is not installed/],
    ['no-path', 'install the app', { code: 2, err: ERR.noPath }, { udid: UD, path: '/tmp/x.app' }, /not an \.ipa/],
    ['no-handler', 'open the link', { code: 115, err: ERR.noHandler }, { udid: UD, url: 'zzzz://nothing' }, /nothing installed on device .* opens zzzz:\/\/nothing/],
    ['no-runtime', 'boot', { code: 149, err: ERR.noRuntime }, { udid: UD }, /Settings, Components/],
    ['old-xcode', 'send a push', { code: 1, err: ERR.unknownSub }, {}, /Update Xcode/],
    ['bad-argument', 'set the status bar', { code: 22, err: ERR.badArg }, { udid: UD }, /Invalid argument/],
    ['simctl', 'terminate the app', { code: 7, err: 'something new and unlabelled\n' }, { udid: UD }, /something new and unlabelled/],
  ]
  for (const [fault, verb, r, ctx, says] of cases) {
    const got = S.classify(verb, r, ctx)
    is(`${fault}: named`, got.fault, fault)
    has(`${fault}: says what to do`, got.reason, says)
  }
  is('a spawn that never started reads as no Xcode', S.classify('boot', { spawnError: 'ENOENT' }, {}).fault, 'no-xcode')
  is('the exit code alone is never the answer', S.classify('launch the app', { code: 4, err: ERR.noApp }, { bundle: 'a' }).fault, 'no-app')
  is('stdout is not parsed on failure',
    S.classify('send a push', { code: 1, out: 'usage: simctl [--set <path>] ...', err: '' }).fault, 'old-xcode')

  // Every sentence is a sentence: it ends, and it is long enough to have said something.
  {
    const bad = []
    for (const [, verb, r, ctx] of cases) {
      const s = S.classify(verb, r, ctx).reason
      if (!/\.$/.test(s) || s.length < 40 || /[\u2014\u2013]/.test(s)) bad.push(s)
    }
    is('every refusal is one finished sentence, no dashes', bad, [])
  }

  // ---- the state that is already the state asked for is not a failure ----
  is('booting a booted device is success',
    await mk(() => ({ code: 149, err: ERR.alreadyBooted })).boot(UD), { ok: true, value: { udid: UD, changed: false } })
  is('shutting down a shut device is success',
    await mk(() => ({ code: 149, err: ERR.alreadyShut })).shutdown(UD), { ok: true, value: { udid: UD, changed: false } })
  is('terminating an app that is not running is success',
    (await mk(() => ({ code: 3, err: ERR.notRunning })).terminate(UD, 'com.me.app')).value.changed, false)
  is('a real boot says it changed something',
    (await mk(() => ({ code: 0 })).boot(UD)).value.changed, true)

  // ---- what comes back on success ----
  is('launch hands back the pid',
    (await mk(() => ({ code: 0, out: 'com.me.app: 34881\n' })).launch(UD, 'com.me.app')).value.pid, 34881)
  is('the device list is parsed', (await mk(() => ({ code: 0, out: '{"devices":{"iOS-26-5":[]}}' })).listDevices()).value, { devices: { 'iOS-26-5': [] } })
  is('half written json is a sentence, not a crash',
    (await mk(() => ({ code: 0, out: '{"devices"' })).listDevices()).fault, 'bad-json')
  is('appearance reads without a booted device', (await mk(() => ({ code: 0, out: 'unknown\n' })).appearance(UD)).value.appearance, 'unknown')

  // ---- timeouts. A boot takes a long time and an agent must not hang ----
  {
    const spawn = fakeSpawn(() => ({ hang: true }))
    const s = S.make({ spawn, fs: fakeFs(), stashPath: STASH, budget: { boot: 1000 }, firstMs: 1000 })
    const t0 = Date.now()
    const r = await s.boot(UD)
    is('a boot that never finishes comes back', r.ok, false)
    is('as a timeout', r.fault, 'timeout')
    has('naming the wait and what to do', r.reason, /waited 1s to boot.*try again/is)
    is('and the child is not left running', spawn.calls[0].child.killed[0], 'SIGTERM')
    is('inside its own budget', Date.now() - t0 < 3000, true)
  }
  {
    // The first call of a session waits far longer, because Xcode may be checking itself.
    const spawn = fakeSpawn(() => ({ hang: true }))
    const s = S.make({ spawn, fs: fakeFs(), stashPath: STASH, budget: { read: 10 }, firstMs: 900 })
    const r = await s.listDevices()
    has('the first call blames Xcode first launch, not the device', r.reason, /runFirstLaunch/)
  }
  is('a boot gets at least a minute before anyone calls it a failure', S.BUDGET.boot >= 60000, true)
  is('and a read does not', S.BUDGET.read <= 15000, true)
  {
    // A slow first call that worked still says why it was slow, because the first call
    // of a session can be Xcode checking itself rather than the device being slow.
    const slow = (() => { let t = 0; return () => (t += 4000) })()
    const s = S.make({ spawn: fakeSpawn(() => ({ code: 0, out: '{}' })), fs: fakeFs(), stashPath: STASH, now: slow })
    has('a slow first call explains itself', (await s.listDevices()).note, /Xcode checking itself/)
    is('and a second call carries no note', (await s.listDevices()).note, undefined)
  }

  // ---- the status bar, read back ----
  is('an empty status bar reads as empty', S.parseBar(BAR_EMPTY).any, false)
  is('an override reads back as the words the flags take', S.parseBar(BAR_FULL).fields, {
    time: '7:20', dataNetwork: 'lte', wifiMode: 'failed', wifiBars: 1,
    cellularMode: 'active', cellularBars: 2, operatorName: 'Yaad',
    batteryState: 'discharging', batteryLevel: 42,
  })
  // Measured: hide and wifi both print 0, so neither is put back as the other.
  is('a data network that could be two things is named, not guessed',
    S.parseBar('DataNetworkType: 0\n').unmapped.length, 1)
  is('and that field is left out of the fields', S.parseBar('DataNetworkType: 0\n').fields.dataNetwork, undefined)
  has('the change is said in words', S.describeBar(S.HOUSE_BAR), /the clock at 9:41.*no carrier name.*battery charged at 100/)
  is('a value simctl would refuse is refused here first', S.barArgs({ wifiBars: 9 }).fault, 'bad-argument')
  has('naming the range', S.barArgs({ wifiBars: 9 }).reason, /whole number from 0 to 3/)
  is('an unknown field is refused', S.barArgs({ carrier: 'x' }).fault, 'bad-argument')
  is('an empty override is refused', S.barArgs({}).fault, 'bad-argument')
  is('a bad enum is refused', S.barArgs({ batteryState: 'full' }).fault, 'bad-argument')

  // ---- stash and restore, which is not optional ----
  {
    const fs = fakeFs()
    const spawn = fakeSpawn((bin, args) => args.includes('list') ? { code: 0, out: BAR_EMPTY } : { code: 0 })
    const s = S.make({ spawn, fs, stashPath: STASH })
    const r = await s.setStatusBar(UD)
    is('the bar is read before it is written', spawn.calls[0].args.slice(1), ['status_bar', UD, 'list'])
    is('then set', spawn.calls[1].args.slice(0, 4), ['simctl', 'status_bar', UD, 'override'])
    is('and the result says what it set', typeof r.value.said, 'string')
    is('the stash is on disk before the override', JSON.parse(fs.files[STASH])[UD].had, false)

    const back = await s.restoreStatusBar(UD)
    is('restoring a bar nobody had overridden clears it', back.value.restored, 'cleared')
    is('and the stash is emptied', Object.keys(JSON.parse(fs.files[STASH])), [])
    is('restoring twice is not an error', (await s.restoreStatusBar(UD)).value.restored, 'nothing')
  }
  {
    // The person's own override comes back, not a cleared bar.
    const fs = fakeFs()
    const spawn = fakeSpawn((bin, args) => args.includes('list') ? { code: 0, out: BAR_FULL } : { code: 0 })
    const s = S.make({ spawn, fs, stashPath: STASH })
    await s.setStatusBar(UD, { time: '9:41' })
    is('the result says whose bar it will put back', (await s.setStatusBar(UD, { time: '9:41' })).value.restores, 'your own override')
    const back = await s.restoreStatusBar(UD)
    is('their own override is put back', back.value.restored, 'theirs')
    const put = spawn.calls[spawn.calls.length - 1].args
    is('with their own values', put[put.indexOf('--operatorName') + 1], 'Yaad')
    is('and their own clock', put[put.indexOf('--time') + 1], '7:20')
  }
  {
    // Measured: an override does not survive a shutdown, so a shut device is nothing
    // left to put back rather than a failure to report.
    const fs = fakeFs()
    const spawn = fakeSpawn((bin, args, n) => args.includes('list') ? { code: 0, out: BAR_FULL } : (n > 1 ? { code: 149, err: ERR.shutdown } : { code: 0 }))
    const s = S.make({ spawn, fs, stashPath: STASH })
    await s.setStatusBar(UD, { time: '9:41' })
    const back = await s.restoreStatusBar(UD)
    is('a shut device needs no restore', back.ok, true)
    has('and says why', back.value.note, /does not survive/)
    is('the stash is dropped anyway', Object.keys(JSON.parse(fs.files[STASH])), [])
  }
  {
    // An override Fetch cannot undo is somebody's simulator stuck at 9:41, so it does
    // not happen at all.
    const fs = fakeFs()
    fs.files.__locked = true
    const spawn = fakeSpawn(() => ({ code: 0, out: BAR_EMPTY }))
    const s = S.make({ spawn, fs, stashPath: STASH })
    const r = await s.setStatusBar(UD)
    is('no stash, no override', r.fault, 'no-stash')
    is('and nothing was set', spawn.calls.length, 1)
  }
  {
    // What a crash mid take leaves behind, put back on the next launch.
    const fs = fakeFs({ [STASH]: JSON.stringify({ [UD]: { had: false }, [UD2]: { had: false } }) })
    const s = S.make({ spawn: fakeSpawn(() => ({ code: 0 })), fs, stashPath: STASH })
    const r = await s.restorePending()
    is('every device Fetch still owes a restore is restored', r.value.restored.map(x => x.result.value.restored), ['cleared', 'cleared'])
    is('and the stash is empty afterwards', Object.keys(JSON.parse(fs.files[STASH])), [])
  }

  // ---- touch, which is the refusal ----
  {
    const s = mk(() => ({ code: 0 }))
    const r = await s.tap(UD, 100, 200)
    is('with no HID tool on this Mac a tap is refused', r.fault, 'no-tap')
    is('in the words the plan wrote', r.reason, S.NO_TAP)
    has('and simctl is named as the reason', r.reason, /simctl has no tap/)
    is('a tap still needs a device', (await s.tap('booted', 1, 2)).fault, 'no-udid')
    is('and a point', (await s.tap(UD, null, 2)).fault, 'bad-argument')
    has('aimed the way everything else is aimed', (await s.tap(UD, null, 2)).reason, /find_on_screen/)
  }
  {
    // A tool the person installed themselves is driven, never installed by Fetch.
    const fs = fakeFs({ 'bin:/opt/bin/axe': true })
    const spawn = fakeSpawn(() => ({ code: 0 }))
    const s = S.make({ spawn, fs, stashPath: STASH })
    const path0 = process.env.PATH
    process.env.PATH = '/opt/bin'
    const r = await s.tap(UD, 100, 200)
    const failed = await S.make({ spawn: fakeSpawn(() => ({ code: 1, err: 'no such target\n' })), fs, stashPath: STASH }).tap(UD, 1, 2)
    process.env.PATH = path0
    is('a discovered tool is used', r.ok, true)
    is('and named in the result', r.value.by, 'axe')
    is('the tap goes to the tool, not through simctl', spawn.calls[0].bin, '/opt/bin/axe')
    is('a tool that fails is not Fetch failing', failed.fault, 'tap-failed')
    has('and says so', failed.reason, /Record the person tapping instead/)
  }

  // ---- the refusals that are permanent ----
  {
    const names = Object.keys(S.make({ spawn: fakeSpawn(() => ({})), fs: fakeFs(), stashPath: STASH }))
    const forbidden = names.filter(n => /create|clone|erase|delete|upgrade|uninstall|recordVideo|screenshot/i.test(n))
    is('this file offers no way to destroy or manufacture a device, and no second capture path', forbidden, [])
  }
  {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'ui', 'simctl.js'), 'utf8')
    is('no em dash anywhere in the wrapper', /[\u2014]/.test(src), false)
    is('the wrapper never spells out booted as a device', /'booted'\s*\]/.test(src), false)
    is('and never opens a shell', /shell:\s*true/.test(src), false)
  }

  console.log(`\n  ${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch(e => { console.error(e); process.exit(1) })
