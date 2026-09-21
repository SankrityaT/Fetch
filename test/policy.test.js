const p = require('../ui/record-policy')
let pass = 0, fail = 0
const is = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}` + (ok ? '' : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`))
}

// a human is never gated, whatever the mode
is('human window on a protected app', p.decide({ by:'human', kind:'window', app:'1Password' }, { mode:'allowed' }).allow, true)

// protected apps refused for agents in every mode
for (const mode of ['ask','allowed','open']) {
  is(`agent + 1Password refused (${mode})`, p.decide({ by:'agent', kind:'window', app:'1Password 8' }, { mode }).allow, false)
}
is('refusal names the app', p.decide({ by:'agent', kind:'window', app:'Messages' }, { mode:'open' }).reason, 'Messages is on the never record list')

// open mode lets ordinary apps through
is('agent + Chrome in open mode', p.decide({ by:'agent', kind:'window', app:'Google Chrome' }, { mode:'open' }).allow, true)

// ask mode flags approval rather than refusing
is('ask mode needs approval', p.decide({ by:'agent', kind:'window', app:'Google Chrome' }, { mode:'ask' }).needsApproval, true)

// allowed mode is default-deny
is('allowed mode denies unlisted', p.decide({ by:'agent', kind:'window', app:'Google Chrome' }, { mode:'allowed', allowedApps:['Simulator'] }).allow, false)
is('allowed mode permits listed', p.decide({ by:'agent', kind:'window', app:'Simulator' }, { mode:'allowed', allowedApps:['Simulator'] }).allow, true)
is('allowed mode refuses whole displays', p.decide({ by:'agent', kind:'display' }, { mode:'allowed', allowedApps:['Simulator'] }).allow, false)

// a window we cannot attribute is refused, not waved through
is('unknown owner refused', p.decide({ by:'agent', kind:'window' }, { mode:'open' }).allow, false)

// display captures exclude protected windows instead of refusing
is('exclusion picks protected windows only',
  p.windowsToExclude([
    { id: 1, app: 'Google Chrome' }, { id: 2, app: 'Messages' },
    { id: 3, app: '1Password 8' },   { id: 4, app: 'iTerm2' },
  ], {}),
  [2, 3])

// matching is symmetric on substrings both ways
is('owner longer than entry', p.isProtected('1Password 8', ['1Password']), true)
is('entry longer than owner', p.isProtected('Mail', ['Mail']), true)
is('case insensitive', p.isProtected('messages', ['Messages']), true)
is('no false positive', p.isProtected('Google Chrome', p.DEFAULT_NEVER), false)

// an unknown mode must not silently become permissive
is('garbage mode falls back to ask', p.decide({ by:'agent', kind:'window', app:'Chrome' }, { mode:'nonsense' }).needsApproval, true)

// ---- settings an agent may change ----
const throws = (fn) => { try { fn(); return null } catch (e) { return e.message } }
is('agent cannot open recording access',
  /only be changed by a person/.test(throws(() => p.checkSettingsPatch({ recordAccess: 'always' }))), true)
is('agent cannot empty the never-record list',
  /only be changed by a person/.test(throws(() => p.checkSettingsPatch({ neverRecord: [] }))), true)
is('agent cannot allow apps',
  /only be changed by a person/.test(throws(() => p.checkSettingsPatch({ allowedRecordApps: ['1Password'] }))), true)
is('agent cannot change telemetry',
  /only be changed by a person/.test(throws(() => p.checkSettingsPatch({ telemetry: true }))), true)
is('a refused key sinks the whole patch, nothing half applied',
  /recordAccess/.test(throws(() => p.checkSettingsPatch({ camera: false, recordAccess: 'always' }))), true)
is('agent cannot make its own takes invisible or visible',
  /only be changed by a person/.test(throws(() => p.checkSettingsPatch({ agentTakesVisible: true }))), true)
is('unknown keys are refused', /not a setting/.test(throws(() => p.checkSettingsPatch({ theme: 'light' }))), true)
is('countdown only takes 0, 3 or 5', /countdown/.test(throws(() => p.checkSettingsPatch({ countdown: 4 }))), true)
is('booleans are not coerced from strings', /true or false/.test(throws(() => p.checkSettingsPatch({ mic: 'no' }))), true)
is('a missing folder is refused', /saveDir/.test(throws(() => p.checkSettingsPatch({ saveDir: '/nope' }, () => false))), true)
is('null folder means ~/Movies/Fetch', p.checkSettingsPatch({ saveDir: null }), { saveDir: null })
is('a good patch passes through', p.checkSettingsPatch({ camera: false, countdown: 0 }), { camera: false, countdown: 0 })

// ---- the system's own grant, which is the only one a take needs ----
// One grant covers the picture and the sound both: ScreenCaptureKit's audio is part of
// screen capture, which is why macOS 15 names that pane Screen and System Audio
// Recording. So a simulator take having system audio on by default asks the person for
// nothing they were not already asked. A second check added here would be a second
// dialog an unattended agent cannot answer, which is the fault this function exists for.
console.log('\nthe system\'s own grant')
is('a granted Mac records', p.screenAccess('granted').allow, true)
is('a denied one is refused', p.screenAccess('denied').allow, false)
is('and so is a restricted one', p.screenAccess('restricted').allow, false)
// The state a fresh Mac ships in. An agent cannot answer the system's own prompt, so
// for an agent it is a refusal rather than a dialog nobody is there to press.
is('not determined is a refusal for an agent', p.screenAccess('not-determined').allow, false)
is('the refusal names the pane', /Privacy and Security, Screen Recording/.test(p.screenAccess('denied').reason), true)
is('and says to restart', /restart Fetch/.test(p.screenAccess('denied').reason), true)
is('no em dashes in it', /\u2014/.test(p.screenAccess('not-determined').reason), false)
// A person is never refused on the reading: their own prompt comes from the helper, and
// refusing them here deleted the first run and named a switch that did not exist yet.
for (const s of ['denied', 'restricted', 'not-determined', 'unknown']) {
  is(`a person goes through on ${s}`, p.screenAccess(s, 'human').allow, true)
}
// A state nobody could read is not grounds to refuse a capture that would have worked.
is('an unreadable state is not a refusal', p.screenAccess('unknown').allow, true)
is('and neither is nothing at all', p.screenAccess(undefined).allow, true)

// ---- a simulator is a window, plus the machine inside it ----
// Every simulator on the Mac is the same application, so the app rule cannot tell the
// device with a real account on it from a throwaway. The lever is the UDID.
console.log('\na simulator as a recording target')
const UD = '2321BA9C-16CE-4E5A-B466-1CFBA0E25142'
const OTHER = '9A3F2A47-5868-4956-B3AB-7531342B9347'
const sim = (req, pol) => p.decide({ by: 'agent', kind: 'simulator', udid: UD, ...req }, pol || { mode: 'open' })

is('a simulator window records in open mode', sim({}).allow, true)
is('the app rules still apply to it', sim({ app: 'Simulator' }, { mode: 'open', neverRecord: ['Simulator'] }).allow, false)
// Unattributable is refused, the same as a window with no owner: the device nobody could
// name is exactly the one that might be on the list.
is('a simulator whose device is unknown is refused', p.decide({ by: 'agent', kind: 'simulator' }, { mode: 'open' }).allow, false)
is('and the refusal says which half failed',
  /which device/.test(p.decide({ by: 'agent', kind: 'simulator' }, { mode: 'open' }).reason), true)

const withDev = { mode: 'open', neverRecordDevices: [UD] }
is('a device on the never list is refused', sim({}, withDev).allow, false)
is('the refusal names the device', sim({ device: 'Work-iPhone' }, withDev).reason, 'Work-iPhone is on the never record devices list')
is('and falls back to the udid when there is no name', sim({}, withDev).reason, `${UD} is on the never record devices list`)
is('another device on the same Mac still records', sim({ udid: OTHER }, withDev).allow, true)
is('a udid matches whatever its case', sim({ udid: UD.toLowerCase() }, withDev).allow, false)
// A UDID is matched whole. The substring rule that is right for app names would let a
// short entry match every device on the Mac.
is('a udid is never matched on a fragment', p.isDeviceProtected({ udid: UD }, ['2321']), false)
is('a person who wrote the device name is still covered',
  p.isDeviceProtected({ udid: OTHER, name: 'Yolk-ProMax' }, ['Yolk-ProMax']), true)
is('an empty device list protects nothing', p.isDeviceProtected({ udid: UD }, []), false)

// The device check is not tied to the kind, so naming a simulator window as a plain
// window is not a way around the list.
is('a window target carrying a udid gets the device check too',
  p.decide({ by: 'agent', kind: 'window', app: 'Simulator', udid: UD }, withDev).allow, false)
// A region of the device screen is judged as a display and an occluded region gives
// frozen pixels. A simulator is the whole window, always.
is('a simulator is never a region', sim({ region: { x: 0, y: 0, w: 10, h: 10 } }).allow, false)
is('the mode rules are untouched by any of this', sim({}, { mode: 'allowed', allowedApps: ['Simulator'] }).allow, true)
is('and allowed mode still denies an unlisted Simulator', sim({}, { mode: 'allowed', allowedApps: ['Xcode'] }).allow, false)
is('ask mode still asks for a simulator', sim({}, { mode: 'ask' }).needsApproval, true)
is('a person is never gated on their own device',
  p.decide({ by: 'human', kind: 'simulator', udid: UD }, withDev).allow, true)

// A display capture sees every window, so a protected device goes out of that frame too.
is('a display capture leaves a protected device out',
  p.windowsToExclude([
    { id: 1, app: 'Simulator', device: { udid: OTHER, name: 'Yolk-ProMax' } },
    { id: 2, app: 'Simulator', device: { udid: UD, name: 'Work-iPhone' } },
    { id: 3, app: 'Messages' },
  ], withDev),
  [2, 3])

// ---- conduct: what an agent may do to a simulator ----
console.log('\nwhat an agent may do to a simulator')
const sd = (action, opts, pol) => p.simDecide(action, opts, pol)
const free = a => sd(a, {}).allow === true
const asks = a => { const r = sd(a, {}); return r.allow === false && r.needsConsent === true }

// Reading somebody's simulators costs them nothing.
for (const a of ['list', 'list devices', 'list runtimes', 'listapps', 'appinfo', 'get_app_container', 'io enumerate', 'status_bar list', 'ui appearance read']) {
  is(`${a} is free`, free(a), true)
}
// Putting an override back is never the wrong move.
is('restore is free', free('restore'), true)

// An unknown verb is refused, not waved through, so a verb added to the wrapper and not
// to this table fails closed.
is('an unknown action is refused', sd('frobnicate', { consent: true }).allow, false)
is('and says what Fetch does know', /list, ready, go, tap and restore/.test(sd('frobnicate', {}).reason), true)

// Booting is not installing, and installing is not what a demo request asked for.
for (const a of ['boot', 'shutdown', 'install', 'install_app_data', 'launch', 'terminate', 'openurl', 'push', 'addmedia', 'location', 'privacy grant', 'keychain', 'pbcopy', 'spawn', 'screenConfig geometry', 'tap', 'ready']) {
  is(`${a} needs the person's word`, asks(a), true)
}
is('and the sentence says where the word has to come from',
  /in this conversation/.test(sd('boot', {}).reason), true)
is('a yes lets it through', sd('boot', { consent: true }).allow, true)
is('a yes to booting is not a yes to installing', sd('install', { consent: 'boot' }).allow, false)
is('a yes to ready carries the boot inside it', sd('boot', { consent: 'ready' }).allow, true)
is('and the install and launch it performs', sd('launch', { consent: 'ready' }).allow, true)
is('and the result has to name them', sd('install', { consent: 'ready' }).mustSay, true)
is('but not a tap', sd('tap', { consent: 'ready' }).allow, false)
is('not a deep link', sd('go', { consent: 'ready' }).allow, false)
is('not a push', sd('push', { consent: 'ready' }).allow, false)
is('and not a shutdown', sd('shutdown', { consent: 'ready' }).allow, false)

// Refused to everyone, including the person through an agent. Consent does not reach
// this table, which is the whole point of it.
for (const a of ['create', 'clone', 'erase', 'delete', 'upgrade', 'uninstall']) {
  is(`${a} is refused even with a yes`, sd(a, { consent: true }).allow, false)
}
is('and says whose job it is', /command line/.test(sd('erase', { consent: true }).reason), true)
// simctl's own capture would write pixels that never passed decide(), and its file has
// no audio track, which kills the transcript every other feature reads.
is('simctl recordVideo is refused', sd('io recordVideo', { consent: true }).allow, false)
is('and says why', /no audio track/.test(sd('io recordVideo', { consent: true }).reason), true)
is('simctl screenshot is refused', sd('io screenshot', { consent: true }).allow, false)
is('and says the check it skips', /never record check/.test(sd('io screenshot', { consent: true }).reason), true)

// Never, by construction, and asserted here anyway.
is('nothing is brought to the front', sd('raise window', { consent: true }).allow, false)
is('and the refusal says a simulator is filmed where it sits', /where it sits/.test(sd('activate', { consent: true }).reason), true)
is('nothing moves this Mac\'s mouse', sd('move mouse', { consent: true }).allow, false)
is('nothing presses its keyboard', sd('keyboard', { consent: true }).allow, false)
is('nothing makes a sound', sd('beep', { consent: true }).allow, false)
// simctl has no gesture of any kind, so these refuse by name rather than by silence.
for (const a of ['swipe', 'pinch', 'long press', 'type']) {
  is(`${a} is refused by name`, /no gesture of any kind/.test(sd(a, { consent: true }).reason || ''), true)
}

// Status bar, appearance and Dynamic Type sit just inside the asked line, and only
// because the old value is stashed and goes back.
const shooting = { capturing: true, restores: true }
is('the house status bar is free while Fetch is recording', sd('status_bar override', shooting).allow, true)
is('and the caller is told to put it back', sd('status_bar override', shooting).mustRestore, true)
is('and to say that it did', sd('status_bar override', shooting).mustSay, true)
is('with no restore wired it is an ordinary mutation', sd('status_bar override', { capturing: true }).allow, false)
is('and outside a take it is too', sd('status_bar override', { restores: true }).allow, false)
is('appearance rides the same rule', sd('ui appearance', shooting).allow, true)
is('so does Dynamic Type', sd('ui content_size', shooting).allow, true)
// An ambiguous name reads as the stricter of its two meanings.
is('a bare appearance reads as the write, not the read', sd('ui appearance', {}).allow, false)
is('the read is its own name', sd('ui appearance read', {}).allow, true)
is('a bare status bar reads as the override', sd('status_bar', {}).allow, false)
is('reading the status bar is free', sd('status_bar list', {}).allow, true)

// simctl boot is headless, so a boot the person asked for would otherwise happen with no
// window at all. That is the one place Fetch opens an app on this Mac.
is('opening Simulator is not a standalone act', sd('open simulator', { consent: true }).allow, false)
is('it happens only inside a ready', sd('open simulator', { consent: 'ready' }).allow, true)
is('and the refusal says why it exists', /leaves no window to record/.test(sd('open simulator', {}).reason), true)

// The never list outranks the person's word, because a list a yes can unlock is not one.
const devPol = { neverRecordDevices: [UD] }
is('a never-listed device is not booted, consent or not', sd('boot', { consent: true, udid: UD }, devPol).allow, false)
is('nor installed to', sd('install', { consent: true, udid: UD }, devPol).allow, false)
is('nor read from', sd('listapps', { udid: UD }, devPol).allow, false)
is('and the refusal names it', /Work-iPhone is on the never record devices list/.test(
  sd('boot', { consent: true, udid: UD, device: 'Work-iPhone' }, devPol).reason), true)
is('another device is unaffected', sd('boot', { consent: true, udid: OTHER }, devPol).allow, true)
// Refusing this one would leave somebody's device stuck at 9:41.
is('restore still runs on a device that went onto the list', sd('restore', { udid: UD }, devPol).allow, true)

// Every verb in the table lands in exactly one class, so a verb added here and nowhere
// else cannot become the permissive answer.
const classes = Object.keys(p.SIM_ACTIONS)
is('every known action has a class', classes.every(a => ['free', 'ask', 'capturing', 'ready', 'refused'].includes(p.SIM_ACTIONS[a])), true)
is('and decides the way its class says', classes.every(a => {
  const r = p.simDecide(a, { consent: [a, 'ready'], capturing: true, restores: true })
  return r.allow === (p.SIM_ACTIONS[a] !== 'refused')
}), true)
const TOUCHES_THIS_MAC = /^(mouse|move mouse|mac click|keyboard|keystroke|sound|beep|volume|raise window|activate|bring to front|front|focus)$/
is('nothing an agent may do touches this Mac or makes a sound',
  classes.filter(a => p.SIM_ACTIONS[a] !== 'refused' && TOUCHES_THIS_MAC.test(a)), [])

// The list is the whole protection, so an agent editing it would pass every check above.
is('agent cannot edit the never-record devices list',
  /only be changed by a person/.test(throws(() => p.checkSettingsPatch({ neverRecordDevices: [] }))), true)

// ── what a window take hears, which is the reason simctl's own capture is refused ──
// A framebuffer capture is a file with no audio track at all, and with it go the
// transcript, the beats, the captions, fit_to_length and remove_dead_air. So Fetch
// records the Mac window instead, and what that take hears has to be the app and not
// the room. Measured on this Mac while the person's own browser played to the speakers
// through a Simulator window take: -91.0 dB mean and -91.0 dB peak, which is the noise
// floor and nothing else. The other application's sound is not in the file.
//
// The rule lives in Recorder.swift and is read here rather than restated: a window
// take's system audio comes from the display with every other application excluded by
// process id, so the target app, its helpers and system sounds reach the file and
// nothing else on the Mac does. Delete that filter and the measurement above stops
// being true without a single test noticing, which is what this one is for.
const rec = require('fs').readFileSync(require('path').join(__dirname, '..', 'Recorder.swift'), 'utf8')
is('a window take hears its own app and no other application on the Mac',
  /content\.applications\.filter \{ \$0\.processID != win\.owningApplication\?\.processID \}/.test(rec) &&
  /excludingApplications: others/.test(rec), true)
is('and only a window take gets that filter, since a display take cannot honour it',
  /SCContentFilter\(desktopIndependentWindow: win\)/.test(rec), true)

console.log(`\n  ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
