// simctl, wrapped. Argv, exit codes and sentences, nothing else.
//
// Everything a simulator can be told to do already ships with Xcode, so Fetch
// reimplements none of it: no boot logic, no install logic, no status bar model. What
// Fetch adds is the refusal. `xcrun simctl` fails with a shell error and a domain code,
// and an agent handed "exit 149, code=405" cannot act on it. Every function here comes
// back as {ok:true, value} or {ok:false, fault, reason}, where `reason` is one sentence
// naming what happened and what to do about it.
//
// Two rules the surveys paid for and this file enforces:
//
//   Never pass the literal `booted`. With two devices up it picks an unspecified one,
//   and a take of the wrong phone looks exactly like a take of the right one.
//
//   Never read stdout on failure. simctl prints usage there, so a parser that reads it
//   will happily describe a usage banner as a device.
//
// The exit code is not the whole story either, which is the correction this file was
// written around. Measured on this Mac: an install of a missing path exits 2, a
// terminate of an app that is not running exits 3, a launch of an app that is not
// installed exits 4, an openurl nothing handles exits 115. Only CoreSimulator's own
// faults come back as 149. So classification reads the domain and the code out of
// stderr, and the exit code is a hint, not the answer.
//
// No process here is long lived and none of them is `io recordVideo`, which is refused
// outright elsewhere, so a timeout may kill its child without corrupting anything.

const UDID_RE = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i

// How long each shape of call waits before Fetch stops waiting. Reads measured 0.08 to
// 0.14 s and a boot measured 9.9 s here, with a logged tail to 32 s, so a boot gets a
// minute before anyone calls it a failure and everything else gets seconds.
const BUDGET = { read: 15000, act: 20000, shutdown: 30000, boot: 60000, install: 120000 }

// The first call of a session is not a fast call. The simctl shim version checks
// CoreSimulator and can run `xcodebuild -runFirstLaunch`, which blocks and may ask for
// an admin password, so the first call waits much longer and says so if it runs out.
const FIRST_MS = 180000
const SLOW_FIRST_MS = 3000

const FIRST_NOTE = 'this was the first simctl call in this session and it was slow, ' +
  'which is usually Xcode checking itself rather than the device being slow.'

// Every status bar flag simctl documents, with what it will accept. Checked before the
// spawn so a bad value is a sentence rather than NSPOSIXErrorDomain code 22.
const BAR_FLAGS = {
  time: { flag: '--time', text: true },
  dataNetwork: { flag: '--dataNetwork', one: ['hide', 'wifi', '3g', '4g', 'lte', 'lte-a', 'lte+', '5g', '5g+', '5g-uwb', '5g-uc'] },
  wifiMode: { flag: '--wifiMode', one: ['searching', 'failed', 'active'] },
  wifiBars: { flag: '--wifiBars', range: [0, 3] },
  cellularMode: { flag: '--cellularMode', one: ['notSupported', 'searching', 'failed', 'active'] },
  cellularBars: { flag: '--cellularBars', range: [0, 4] },
  operatorName: { flag: '--operatorName', text: true },
  batteryState: { flag: '--batteryState', one: ['charging', 'charged', 'discharging'] },
  batteryLevel: { flag: '--batteryLevel', range: [0, 100] },
}

// The house preset from the plan. It lives here rather than in a look because it is a
// property of the source and not of the picture: no edit can change it after the fact.
const HOUSE_BAR = {
  time: '9:41', dataNetwork: 'wifi', wifiMode: 'active', wifiBars: 3,
  cellularMode: 'active', cellularBars: 4, operatorName: '',
  batteryState: 'charged', batteryLevel: 100,
}

// `status_bar list` prints numbers, not the words the flags take, so putting somebody's
// own override back means inverting them. These tables were measured by setting every
// documented value on a device and reading the list back.
const DATA_NET = { 6: '3g', 7: '4g', 8: 'lte', 9: 'lte-a', 10: 'lte+', 11: '5g', 12: '5g+', 13: '5g-uwb', 14: '5g-uc' }
const WIFI_MODE = { 1: 'searching', 2: 'failed', 3: 'active' }
const CELL_MODE = { 0: 'notSupported', 1: 'searching', 2: 'failed', 3: 'active' }
const BATTERY_STATE = { 0: 'discharging', 1: 'charging', 2: 'charged' }

// Known third party HID tools, discovered on PATH and never installed by Fetch. The
// argv is per tool because each one spells a tap differently. A name that is not in
// here is not guessed at: an invented command line against somebody's binary is worse
// than saying there is nothing to drive.
const TAP_TOOLS = {
  axe: { args: (udid, x, y) => ['tap', '-x', String(x), '-y', String(y), '--udid', udid] },
  idb: { args: (udid, x, y) => ['ui', 'tap', '--udid', udid, String(x), String(y)] },
}

const NO_TAP = 'nothing on this Mac can send a touch to a simulator. simctl has no tap. ' +
  'Record the person tapping, or install a HID tool and try again.'

const ok = value => ({ ok: true, value })
const fail = (fault, reason) => ({ ok: false, fault, reason })

// The domain and code CoreSimulator puts in its own error line. Read from stderr, never
// from stdout, and never from the exit code alone.
function simError(err) {
  const m = /domain=([^,\s]+),\s*code=(-?\d+)/.exec(String(err || ''))
  return m ? { domain: m[1], code: Number(m[2]) } : null
}

// The useful half of a simctl failure. The domain preamble says nothing a person can
// act on, the underlying error repeats itself, and the specific line is the last one:
// "Simulator device failed to complete the requested operation." then "Invalid argument".
function detail(err) {
  const lines = String(err || '').split('\n').map(s => s.trim()).filter(Boolean)
  const said = lines.filter(l => !/^An error was encountered/.test(l) && !/^Underlying error/.test(l))
  const sharp = said.filter(l => !/^Simulator device failed to/.test(l))
  return sharp[sharp.length - 1] || said[said.length - 1] || lines[0] || ''
}

/**
 * Turn a finished simctl run into a sentence.
 *
 * Pure, so the whole table is testable with no device on the machine.
 *
 * @param {string} verb   what was being attempted, for the sentence
 * @param {object} r      {code, out, err, timedOut, spawnError, ms}
 * @param {object} ctx    {udid, bundle, path, url, waited}
 */
function classify(verb, r, ctx = {}) {
  const err = String(r.err || '')
  const who = ctx.udid ? `device ${ctx.udid}` : 'that device'

  if (r.spawnError || /xcrun:\s*error|unable to find utility|requires Xcode/i.test(err)) {
    return fail('no-xcode', 'xcrun cannot find simctl on this Mac, so Xcode is either not ' +
      'installed or the command line tools are pointed somewhere else. Install Xcode, open ' +
      'it once, then point the tools at it with xcode-select before trying again.')
  }

  if (r.timedOut) {
    const secs = Math.round((ctx.waited || 0) / 1000)
    if (ctx.first) {
      return fail('timeout', `Fetch waited ${secs}s to ${verb} and it did not finish, and it was the first simctl ` +
        'call in this session. Xcode runs its own first launch setup on that call, which can ' +
        'block and can ask for an admin password. Run xcodebuild -runFirstLaunch in a terminal, ' +
        'finish whatever it asks for, then try again.')
    }
    return fail('timeout', `Fetch waited ${secs}s to ${verb} on ${who} and stopped rather than ` +
      'hanging. The device may still be working on it: read its state with a list and try again.')
  }

  if (/Unrecognized subcommand|Unknown subcommand/i.test(err) || (r.code === 1 && /^usage: simctl/m.test(String(r.out || '')))) {
    return fail('old-xcode', `this Mac's simctl cannot ${verb}, which means Xcode is ` +
      'older than the one this was built against. Update Xcode and try again.')
  }

  if (r.code === 148) {
    if (/No devices are booted/i.test(err)) {
      return fail('none-booted', 'no simulator is booted, so there is nothing to talk to. ' +
        'Boot the device you mean first, and pass its udid.')
    }
    return fail('no-device', `no simulator on this Mac has the id ${ctx.udid || 'you passed'}. ` +
      'List the devices and pass a udid from that list, not a name.')
  }

  const e = simError(err)

  // 405 is wrong state, and in practice it is always "not booted". It is the most common
  // failure an agent will hit, so it gets the most direct instruction.
  if (e && e.code === 405) {
    if (/current state: Shutdown/i.test(err)) {
      return fail('not-booted', `${who} is not booted, so Fetch could not ${verb}. Boot it first, ` +
        'then try again.')
    }
    return fail('wrong-state', `${who} is busy changing state, so Fetch could not ${verb} yet. ` +
      `Wait for the boot or the shutdown to finish, then try again. simctl said: ${detail(err)}`)
  }

  // A runtime that is not on the machine. Text matched rather than code matched, because
  // reproducing it means removing somebody's runtime, which Fetch does not do.
  if (/runtime (is )?(not |un)avail|Unable to find a matching runtime|failed to (find|load) runtime/i.test(err)) {
    return fail('no-runtime', `${who} needs an iOS runtime that is not installed on this Mac, so ` +
      'it cannot boot. Install that runtime in Xcode under Settings, Components, then try again.')
  }

  if (/^launch/.test(verb) && e && /FBSOpenApplication/i.test(e.domain)) {
    return fail('no-app', `${ctx.bundle || 'that app'} is not installed on ${who}, so there was ` +
      'nothing to launch. Install the built .app first, or list the apps on the device to find ' +
      'the bundle id that is actually there.')
  }

  if (/^install/.test(verb) && /lstat of .* failed|No such file or directory/i.test(err)) {
    return fail('no-path', `there is no app bundle at ${ctx.path || 'that path'}. Pass the path ` +
      'to a built .app for the simulator, not an .ipa and not a project folder.')
  }

  if (/^open the link/.test(verb) && e && /LSApplicationWorkspace/i.test(e.domain)) {
    return fail('no-handler', `nothing installed on ${who} opens ${ctx.url || 'that link'}. ` +
      'Install the app that claims the scheme, or check the link, then try again.')
  }

  if (e && e.code === 22) {
    return fail('bad-argument', `simctl refused an argument when Fetch tried to ${verb}. ${detail(err) || 'Invalid argument'}.`)
  }

  const said = detail(err)
  return fail('simctl', `Fetch could not ${verb} on ${who}${said ? `: ${said}` : `, and simctl said nothing about why (exit ${r.code})`}.`)
}

// Everything that reaches the outside world is behind this factory, so the tests drive
// the whole file with a spawn that never starts a process.
function make(deps = {}) {
  const spawn = deps.spawn || require('child_process').spawn
  const now = deps.now || Date.now
  const fsx = deps.fs || require('fs')
  const stashPath = deps.stashPath || (() => {
    const path = require('path'), os = require('os')
    return path.join(os.homedir(), 'Library', 'Application Support', 'Fetch', 'sim-status-bar.json')
  })()

  // A device's entry in the stash holds every override Fetch is currently wearing on it,
  // not just the status bar. The appearance used to be held in memory in the bridge,
  // which meant a crash lost it and the device stayed dark forever, while the tool
  // description promised record_stop puts it back. Anything Fetch changes goes on disk,
  // because disk is what survives the thing that loses it.

  // Budgets are injectable so the tests can watch a timeout happen in milliseconds
  // instead of a minute.
  const B = { ...BUDGET, ...(deps.budget || {}) }
  const firstMs = deps.firstMs == null ? FIRST_MS : deps.firstMs

  let firstDone = false

  // One child, its output, and a deadline. The child is killed on the deadline so an
  // agent waiting on a boot that will never finish gets a sentence instead of a hang.
  function run(args, budget, bin = 'xcrun', argv0 = ['simctl']) {
    const first = !firstDone
    firstDone = true
    const waited = first ? Math.max(budget, firstMs) : budget
    const started = now()
    return new Promise(resolve => {
      let out = '', err = '', done = false
      let child = null
      const finish = extra => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve({ out, err, ms: now() - started, first, waited, code: null, ...extra })
      }
      const timer = setTimeout(() => {
        try { child.kill('SIGTERM') } catch {}
        setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, 2000).unref?.()
        finish({ timedOut: true })
      }, waited)
      try {
        // An args array, never a shell: an empty --operatorName has to survive as a real
        // empty argument, and through a shell it silently eats the next flag instead.
        child = spawn(bin, [...argv0, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (e) {
        return finish({ spawnError: String(e && e.message || e) })
      }
      child.stdout?.setEncoding?.('utf8')
      child.stderr?.setEncoding?.('utf8')
      child.stdout?.on('data', d => { out += d })
      child.stderr?.on('data', d => { err += d })
      child.on('error', e => finish({ spawnError: String(e && e.message || e) }))
      child.on('close', code => finish({ code }))
    })
  }

  // A result that carries the first call warning when the first call was slow, so the
  // person reads "Xcode was checking itself" rather than "Fetch is slow".
  const withNote = (res, r) =>
    (r.first && r.ms > SLOW_FIRST_MS && res.ok) ? { ...res, note: FIRST_NOTE } : res

  // Never pass `booted`, never pass a name. Checked before any spawn, because a wrong
  // device is the one failure that looks like success.
  function device(udid) {
    const s = String(udid == null ? '' : udid).trim()
    if (!s) return fail('no-udid', 'no device was named. List the simulators and pass the udid of the one you mean.')
    if (s.toLowerCase() === 'booted') {
      return fail('no-udid', 'Fetch never passes "booted", because it picks an unspecified device ' +
        'when two are up. List the simulators and pass the udid of the one you mean.')
    }
    if (!UDID_RE.test(s)) {
      return fail('no-udid', `"${s}" is a name, not a udid. List the simulators and pass the udid printed beside that name.`)
    }
    return null
  }

  // The shape every verb shares: check the device, spawn, and either hand back the value
  // or hand back a sentence.
  async function verb(name, udid, args, budget, ctx, value = () => ({})) {
    const bad = device(udid)
    if (bad) return bad
    const r = await run(args, budget)
    if (r.code !== 0) {
      const soft = ctx && ctx.softFail && ctx.softFail(r)
      if (soft) return withNote(ok(soft), r)
      return classify(name, r, { udid, ...ctx, waited: r.waited, first: r.first })
    }
    return withNote(ok(value(r)), r)
  }

  // ---- reads. Free, per the plan: reading somebody's simulators costs them nothing ----

  async function listJson(what) {
    const r = await run(['list', what, '-j'], B.read)
    if (r.code !== 0) return classify(`list the ${what}`, r, { waited: r.waited, first: r.first })
    try { return withNote(ok(JSON.parse(r.out)), r) } catch {
      return fail('bad-json', `simctl's ${what} list did not come back as JSON, which usually means ` +
        'Xcode is part way through an update. Try again in a moment.')
    }
  }

  const listDevices = () => listJson('devices')
  const listRuntimes = () => listJson('runtimes')
  const listDeviceTypes = () => listJson('devicetypes')

  // ---- state. Asked for, per the plan, and enforced by the policy before it gets here ----

  // One process boots and waits. `boot` alone returns before the device is usable, which
  // is how a screenshot of a black screen happens. Booting a booted device errors with
  // 405 and that is the state that was asked for, so it is success with changed false.
  const boot = udid => verb('boot', udid, ['bootstatus', String(udid), '-b'], B.boot, {
    softFail: r => /already booted|current state: Booted/i.test(String(r.err) + String(r.out)) ? { udid, changed: false } : null,
  }, () => ({ udid, changed: true }))

  const shutdown = udid => verb('shut down', udid, ['shutdown', String(udid)], B.shutdown, {
    softFail: r => /current state: Shutdown/i.test(String(r.err)) ? { udid, changed: false } : null,
  }, () => ({ udid, changed: true }))

  const install = (udid, appPath) => verb('install the app', udid, ['install', String(udid), String(appPath || '')], B.install,
    { path: appPath }, () => ({ udid, app: appPath }))

  // `--terminate-running-process` is what makes a demo repeatable: the same call gets a
  // clean launch whether or not the app was already up.
  const launch = (udid, bundle, opts = {}) => verb('launch the app', udid,
    ['launch', ...(opts.relaunch === false ? [] : ['--terminate-running-process']), String(udid), String(bundle || '')],
    B.act, { bundle },
    r => ({ udid, bundle, pid: Number((/:\s*(\d+)\s*$/m.exec(r.out) || [])[1]) || null }))

  // Nothing to terminate is the state that was asked for, so it is not a failure.
  const terminate = (udid, bundle) => verb('terminate the app', udid, ['terminate', String(udid), String(bundle || '')], B.act, {
    bundle,
    softFail: r => /found nothing to terminate/i.test(String(r.err)) ? { udid, bundle, changed: false } : null,
  }, () => ({ udid, bundle, changed: true }))

  // The one navigation primitive simctl does hand us, and the reliable one: a deep link
  // lands on the screen every time where a tap script does not.
  const openurl = (udid, url) => verb('open the link', udid, ['openurl', String(udid), String(url || '')], B.act,
    { url }, () => ({ udid, url }))

  // Reading appearance is not gated on a booted device and never errors: `unknown`
  // almost always means the device is not booted rather than anything being wrong.
  const appearance = udid => verb('read the appearance', udid, ['ui', String(udid), 'appearance'], B.act, {},
    r => ({ udid, appearance: String(r.out).trim() || 'unknown' }))

  function setAppearance(udid, style) {
    const s = String(style || '').toLowerCase()
    if (s !== 'light' && s !== 'dark') {
      return Promise.resolve(fail('bad-argument', `appearance is light or dark, not "${style}".`))
    }
    return verb('set the appearance', udid, ['ui', String(udid), 'appearance', s], B.act, {},
      () => ({ udid, appearance: s }))
  }

  /**
   * Set the appearance, having first written down what it was.
   *
   * Same rule as the status bar and for the same reason: an override Fetch cannot undo
   * is somebody's device left dark, and it is left dark silently, because the appearance
   * is not a thing they see change on a clock. `put` is false when the read came back
   * `unknown`, which is what a device that is not booted says, and then there is nothing
   * honest to put back and nothing is written down.
   */
  async function dressAppearance(udid, style) {
    const bad = device(udid)
    if (bad) return bad
    const was = await appearance(udid)
    const had = was.ok && /^(light|dark)$/i.test(was.value.appearance) ? was.value.appearance.toLowerCase() : null
    const r = await setAppearance(udid, style)
    if (!r.ok) return r
    if (had && had !== String(style).toLowerCase()) {
      const all = readStash()
      const at = all[udid] || (all[udid] = { at: now() })
      // First one wins, as with the bar: a second override before the restore would
      // otherwise write Fetch's own value down as the person's.
      if (at.appearance == null) { at.appearance = had; try { writeStash(all) } catch {} }
    }
    return ok({ ...r.value, was: had, restores: had ? `the appearance back to ${had}` : 'nothing' })
  }

  // ---- the status bar, which Fetch sets and Fetch puts back ----

  // Values checked here rather than by simctl, so a typo is a sentence instead of
  // "Invalid argument" with no clue which argument.
  function barArgs(fields) {
    const args = []
    const names = Object.keys(fields || {})
    if (!names.length) return fail('bad-argument', 'a status bar override needs at least one field to set.')
    for (const k of names) {
      const spec = BAR_FLAGS[k]
      if (!spec) return fail('bad-argument', `${k} is not a status bar field. The fields are ${Object.keys(BAR_FLAGS).join(', ')}.`)
      const v = fields[k]
      if (spec.one && !spec.one.includes(String(v))) {
        return fail('bad-argument', `${k} is one of ${spec.one.join(', ')}, not "${v}".`)
      }
      if (spec.range && !(Number.isInteger(Number(v)) && Number(v) >= spec.range[0] && Number(v) <= spec.range[1])) {
        return fail('bad-argument', `${k} is a whole number from ${spec.range[0]} to ${spec.range[1]}, not "${v}".`)
      }
      // An empty operator name is a real empty argument, and it is the one that makes the
      // carrier slot blank. It only survives because there is no shell in the way.
      args.push(spec.flag, String(v == null ? '' : v))
    }
    return { ok: true, value: args }
  }

  // What `status_bar list` prints, read back into the words the flags take. Anything the
  // numbers cannot name is listed rather than guessed: DataNetworkType 0 is both `hide`
  // and `wifi`, measured, so it is never put back as either.
  function parseBar(text) {
    const lines = String(text || '').split('\n').map(s => s.trim())
    const fields = {}, unmapped = []
    let any = false
    const num = (re, line) => { const m = re.exec(line); return m ? Number(m[1]) : null }
    for (const line of lines) {
      if (/^Time:/.test(line)) { fields.time = line.slice(5).trim(); any = true }
      else if (/^DataNetworkType:/.test(line)) {
        any = true
        const n = num(/(-?\d+)/, line)
        if (DATA_NET[n]) fields.dataNetwork = DATA_NET[n]
        else unmapped.push('the data network, which reads back as a number that means either hidden or wifi')
      } else if (/^WiFi Mode:/.test(line)) {
        any = true
        const mode = WIFI_MODE[num(/WiFi Mode:\s*(-?\d+)/, line)]
        const bars = num(/WiFi Bars:\s*(-?\d+)/, line)
        if (mode) fields.wifiMode = mode; else unmapped.push('the wifi mode')
        if (bars != null) fields.wifiBars = bars
      } else if (/^Cell Mode:/.test(line)) {
        any = true
        const mode = CELL_MODE[num(/Cell Mode:\s*(-?\d+)/, line)]
        const bars = num(/Cell Bars:\s*(-?\d+)/, line)
        if (mode) fields.cellularMode = mode; else unmapped.push('the cellular mode')
        if (bars != null) fields.cellularBars = bars
      } else if (/^Operator Name:/.test(line)) { fields.operatorName = line.slice(14).trim(); any = true }
      else if (/^Battery State:/.test(line)) {
        any = true
        const st = BATTERY_STATE[num(/Battery State:\s*(-?\d+)/, line)]
        const lvl = num(/Battery Level:\s*(-?\d+)/, line)
        if (st) fields.batteryState = st; else unmapped.push('the battery state')
        if (lvl != null) fields.batteryLevel = lvl
      }
    }
    return { any, fields, unmapped }
  }

  // The result has to say what changed, in words, because the person will notice the
  // clock and a tool that edits their machine quietly is one they stop trusting.
  function describeBar(fields) {
    const said = []
    const f = fields || {}
    if (f.time != null) said.push(`the clock at ${f.time}`)
    if (f.dataNetwork != null) said.push(f.dataNetwork === 'hide' ? 'the data network hidden' : `the data network on ${f.dataNetwork}`)
    if (f.wifiMode != null || f.wifiBars != null) said.push(`wifi ${f.wifiMode || 'set'}${f.wifiBars != null ? ` at ${f.wifiBars} bars` : ''}`)
    if (f.cellularMode != null || f.cellularBars != null) said.push(`cellular ${f.cellularMode || 'set'}${f.cellularBars != null ? ` at ${f.cellularBars} bars` : ''}`)
    if (f.operatorName != null) said.push(f.operatorName === '' ? 'no carrier name' : `the carrier reading ${f.operatorName}`)
    if (f.batteryState != null || f.batteryLevel != null) said.push(`the battery ${f.batteryState || 'set'}${f.batteryLevel != null ? ` at ${f.batteryLevel}` : ''}`)
    if (!said.length) return 'nothing'
    return said.length === 1 ? said[0] : `${said.slice(0, -1).join(', ')} and ${said[said.length - 1]}`
  }

  const statusBarList = udid => verb('read the status bar', udid, ['status_bar', String(udid), 'list'], B.act, {},
    r => ({ udid, raw: r.out, ...parseBar(r.out) }))

  const statusBarClear = udid => verb('clear the status bar', udid, ['status_bar', String(udid), 'clear'], B.act, {
    // Measured: an override does not survive a shutdown, so a shut device has nothing
    // left to clear and asking again would be a failure about nothing.
    softFail: r => /current state: Shutdown/i.test(String(r.err)) ? { udid, changed: false, gone: true } : null,
  }, () => ({ udid, changed: true }))

  function readStash() {
    try { return JSON.parse(fsx.readFileSync(stashPath, 'utf8')) || {} } catch { return {} }
  }

  function writeStash(all) {
    const path = require('path')
    try { fsx.mkdirSync(path.dirname(stashPath), { recursive: true }) } catch {}
    fsx.writeFileSync(stashPath, JSON.stringify(all, null, 2))
  }

  /**
   * Set the status bar, having first written down what was there.
   *
   * The read comes first and the stash is written to disk before the override, so the
   * person's own override survives Fetch crashing mid take. If the stash cannot be
   * written, the override does not happen at all: an override Fetch cannot undo is
   * somebody's simulator stuck at 9:41 forever.
   */
  async function setStatusBar(udid, fields = HOUSE_BAR) {
    const bad = device(udid)
    if (bad) return bad
    const args = barArgs(fields)
    if (!args.ok) return args

    const before = await statusBarList(udid)
    if (!before.ok) return before

    const all = readStash()
    // Keep the first stash of a session. A second override before the restore would
    // otherwise write Fetch's own values down as the person's.
    if (!all[udid]) all[udid] = { at: now(), had: before.value.any, fields: before.value.fields, unmapped: before.value.unmapped, raw: before.value.raw }
    try { writeStash(all) } catch (e) {
      return fail('no-stash', 'Fetch could not write down what your status bar looked like, so it ' +
        'did not change it. An override it cannot undo would leave your simulator stuck. ' +
        `Check that Fetch can write to its support folder (${String(e && e.message || e)}).`)
    }

    const r = await verb('set the status bar', udid, ['status_bar', String(udid), 'override', ...args.value], B.act, {},
      () => ({ udid, set: fields, said: describeBar(fields) }))
    if (!r.ok) return r
    return ok({ ...r.value, restores: all[udid].had ? 'your own override' : 'no override' })
  }

  /**
   * Put the status bar back. Called on stop, on failure, and on next launch.
   *
   * Their override is re-applied where the numbers `status_bar list` prints can be read
   * back as flags, and where one cannot the result names it rather than guessing.
   */
  // A debt that can never be paid is not a debt. A device the person deleted, or a key
  // that is not a udid at all, fails every restore with the same fault forever: the
  // entry outlives the device, every launch spends a simctl call on it, and the launch
  // log counts it as put back. Dropped instead, once, on the two faults that mean the
  // device is gone.
  const UNPAYABLE = new Set(['no-device', 'no-udid'])

  async function restoreStatusBar(udid) {
    const bad = device(udid)
    if (bad) {
      const all = readStash()
      if (all[udid] !== undefined) { delete all[udid]; try { writeStash(all) } catch {} }
      return bad
    }
    const all = readStash()
    const stash = all[udid]
    const drop = () => { delete all[udid]; try { writeStash(all) } catch {} }
    const gone = r => { if (UNPAYABLE.has(r.fault)) drop(); return r }

    if (!stash) return ok({ udid, restored: 'nothing', note: 'Fetch had not changed this one.' })

    // The appearance first, because it is the one the person cannot see is wrong.
    const back = []
    if (stash.appearance) {
      const a = await setAppearance(udid, stash.appearance)
      if (a.ok) { back.push(`the appearance back to ${stash.appearance}`); delete stash.appearance; try { writeStash(all) } catch {} }
      else if (UNPAYABLE.has(a.fault)) { drop(); return a }
    }
    const said = r => (back.length ? { ...r, also: back } : r)

    // An entry that never carried a bar at all: Fetch changed the appearance on this
    // device and nothing else, so there is no override to clear. `had: false` is a
    // different thing, and means they had none and Fetch's has to come off.
    if (!('had' in stash)) {
      drop()
      return ok(said({ udid, restored: back.length ? 'theirs' : 'nothing' }))
    }

    const cleared = await statusBarClear(udid)
    if (!cleared.ok) return gone(cleared)
    if (cleared.value.gone) { drop(); return ok(said({ udid, restored: 'nothing', note: 'the device is shut down, and an override does not survive that.' })) }

    if (!stash.had) { drop(); return ok(said({ udid, restored: 'cleared', said: 'the status bar is back to the device\'s own.' })) }

    const args = barArgs(stash.fields || {})
    if (!args.ok) { drop(); return ok(said({ udid, restored: 'cleared', note: 'your own override could not be read back from the numbers simctl prints, so the status bar is now the device\'s own.' })) }
    const put = await verb('put the status bar back', udid, ['status_bar', String(udid), 'override', ...args.value], B.act, {},
      () => ({ udid, restored: 'theirs', said: describeBar(stash.fields) }))
    if (!put.ok) return gone(put)
    drop()
    const missed = (stash.unmapped || [])
    return ok(said({ ...put.value, ...(missed.length ? { note: `${missed.join(' and ')} could not be read back from the numbers simctl prints, so ${missed.length > 1 ? 'those are' : 'that is'} the device's own now.` } : {}) }))
  }

  // Every device Fetch still owes a restore, usually because it died mid take. Run on
  // launch, before anything else touches a simulator.
  async function restorePending() {
    const all = readStash()
    const out = []
    for (const udid of Object.keys(all)) out.push({ udid, result: await restoreStatusBar(udid) })
    // Counted apart from attempted, because the launch log used to print "put the status
    // bar back on 1 device" for an entry that failed every time and was never put back.
    return ok({ restored: out, ok: out.filter(r => r.result && r.result.ok && r.result.value &&
      (r.result.value.restored !== 'nothing' || (r.result.value.also || []).length)).length })
  }

  // ---- touch, which is the refusal ----

  // Looked for on PATH, every time, and never installed or bundled by Fetch. Absence is
  // the normal case and every other function in this file works through it.
  function tapAdapter() {
    const path = require('path')
    const dirs = String(process.env.PATH || '').split(':').filter(Boolean)
    for (const name of Object.keys(TAP_TOOLS)) {
      for (const dir of dirs) {
        const full = path.join(dir, name)
        try { fsx.accessSync(full, (fsx.constants && fsx.constants.X_OK) || 1); return { name, path: full } } catch {}
      }
    }
    return null
  }

  /**
   * Send a touch, if anything on this Mac can.
   *
   * simctl has no tap, no swipe and no type: forty two subcommands and no gesture of any
   * kind. Fetch does not write a HID injector either, so with no tool on PATH this
   * returns a sentence rather than a stub, and the take is still recorded and the disc is
   * still drawn where the person touched.
   */
  async function tap(udid, x, y) {
    const bad = device(udid)
    if (bad) return bad
    // Number(null) is 0, so a missing point would otherwise tap the corner.
    const point = v => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) && Number.isFinite(Number(v))
    if (!point(x) || !point(y)) {
      return fail('bad-argument', 'a tap needs a point in device points. Aim it with find_on_screen rather than reading numbers off a picture.')
    }
    const tool = tapAdapter()
    if (!tool) return fail('no-tap', NO_TAP)
    const r = await run(TAP_TOOLS[tool.name].args(String(udid), x, y), B.act, tool.path, [])
    if (r.timedOut) {
      return fail('timeout', `${tool.name} did not answer in ${Math.round(r.waited / 1000)}s, so Fetch stopped waiting. ` +
        'It drives a private path into the simulator and that path changes with Xcode. Record the person tapping instead.')
    }
    if (r.code !== 0) {
      return fail('tap-failed', `${tool.name} could not send that touch, and Fetch did not write it, so there is ` +
        `nothing here to fix: ${detail(r.err) || `it exited ${r.code}`}. Record the person tapping instead.`)
    }
    return ok({ udid, x: Number(x), y: Number(y), by: tool.name })
  }

  return {
    listDevices, listRuntimes, listDeviceTypes,
    boot, shutdown, install, launch, terminate, openurl,
    appearance, setAppearance, dressAppearance,
    statusBarList, statusBarClear, setStatusBar, restoreStatusBar, restorePending,
    tap, tapAdapter,
    barArgs, parseBar, describeBar, device,
  }
}

module.exports = {
  make, classify, simError,
  HOUSE_BAR, BAR_FLAGS, BUDGET, FIRST_MS, NO_TAP, UDID_RE,
  ...make(),
}
