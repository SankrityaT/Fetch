// What an agent is allowed to record. Pure, no Electron, no filesystem, so the rules
// can be unit tested without a running app.
//
// This module exists because the alternative was a sentence in an MCP tool description
// asking a model not to record your password manager. A rule that is not enforced by
// code is a suggestion, and it gets dropped under pressure exactly when it matters. So
// every path that starts a take goes through decide() first.
//
// Two enforcement points, because a display capture sees everything on screen:
//
//   window target  -> refuse outright if the window belongs to a protected app
//   display target -> allow, but hand the protected windows to the recorder so
//                     ScreenCaptureKit leaves them out of the frame
//
// Without the second one the promise would be a lie: an agent could record the whole
// display and pick up a Messages window that happened to be open.

// Seeded, not empty. An empty list teaches nothing and the first thing a person should
// feel on this screen is that the obvious dangers are already handled.
//
// Matching is by application name, which is the weak part of this design: an app that
// is not on the list is recorded silently, so a miss costs privacy rather than a
// feature. Keep this generous and prefer a false positive, which a person can simply
// remove, over a silent gap they will never notice.
const DEFAULT_NEVER = [
  '1Password', 'Bitwarden', 'Dashlane', 'LastPass', 'Proton Pass', 'Keychain Access',
  'Messages', 'WhatsApp', 'Signal', 'Telegram',
  'Mail', 'System Settings', 'System Preferences',
]

// 'ask'      every agent take needs a person to approve it
// 'allowed'  only apps on the allow list, everything else refused
// 'open'     anything except the never list
const MODES = ['ask', 'allowed', 'open']

const norm = s => String(s || '').trim().toLowerCase()

// Substring both ways, so "1Password" matches the window owner "1Password 8" and a
// person typing "1password 8" still matches the seeded "1Password".
function nameMatches(appName, entry) {
  const a = norm(appName), e = norm(entry)
  if (!a || !e) return false
  return a === e || a.includes(e) || e.includes(a)
}

const isProtected = (appName, neverRecord) =>
  (neverRecord || []).some(n => nameMatches(appName, n))

// ── a simulator is a second machine inside one window ────────────────────
// Every simulator on the Mac belongs to the same application, so the app-name rule above
// cannot tell one device from another, and a device is where the data is: a signed-in
// account, a push token, a photo library, a pasteboard synced from the Mac. "Never record
// the device with my real account on it" cannot be said in app names. The lever is the
// UDID, and it sits beside the never-record list rather than inside it.
//
// Empty rather than seeded, unlike the app list. No UDID is dangerous on every Mac, and a
// made-up one would teach a person that the list already knows something it does not.
const DEFAULT_NEVER_DEVICES = []
const SIMULATOR_APP = 'Simulator'

const udidOf = s => String(s || '').trim().toUpperCase()
const deviceLabel = d => (d && (d.name || d.udid)) || 'that device'

// A UDID is matched whole. The substring rule that is right for app names would let a
// three-character entry match every device on the Mac. A person who wrote the device's
// name instead still gets the name rule, because a miss here costs privacy and a false
// positive costs one line in Settings.
function deviceMatches(device, entry) {
  const dev = typeof device === 'string' ? { udid: device } : (device || {})
  const e = typeof entry === 'string' ? entry : (entry && (entry.udid || entry.name))
  if (!e) return false
  const u = udidOf(dev.udid)
  if (u && udidOf(e) === u) return true
  return nameMatches(dev.name, e)
}

const isDeviceProtected = (device, neverDevices) =>
  (neverDevices || DEFAULT_NEVER_DEVICES).some(n => deviceMatches(device, n))

// What to say when the question in 'ask' mode has nobody to answer it. It lives beside
// the rule rather than at either caller, because both of them mean the same thing and an
// agent that reads two different sentences will think it hit two different faults.
const UNANSWERED = 'Recording access is set to ask, so a person at the Mac has to say ' +
  'yes to this one and nobody did. Ask them to allow it, or to set Recording access to ' +
  'open in Fetch\'s Settings.'

/**
 * Should this take be allowed to start?
 *
 * @param {object} req
 *   @param {'agent'|'human'} req.by      human takes are never gated, it is their Mac
 *   @param {'window'|'display'|'simulator'} req.kind
 *   @param {string} [req.app]            owning app, required when kind is 'window'
 *   @param {string} [req.udid]           the device, required when kind is 'simulator'
 *   @param {string} [req.device]         that device's name, for the sentence
 * @param {object} policy  { mode, neverRecord[], neverRecordDevices[], allowedApps[] }
 * @returns {{allow: boolean, reason?: string, needsApproval?: boolean, unanswered?: string}}
 */
function decide(req = {}, policy = {}) {
  const mode = MODES.includes(policy.mode) ? policy.mode : 'ask'
  const never = policy.neverRecord || DEFAULT_NEVER
  const neverDevices = policy.neverRecordDevices || DEFAULT_NEVER_DEVICES
  const allowed = policy.allowedApps || []

  // A person pressing record is not something to police.
  if (req.by !== 'agent') return { allow: true }

  // A simulator is judged as the window it is, and then as the machine inside it. Both,
  // never one: the app rules still decide whether Simulator may be recorded at all.
  const sim = req.kind === 'simulator'
  // Stated here as well as in the tool, because a region of the device screen is judged
  // as a display (it sees whatever is under it) and an occluded region gives frozen
  // pixels. A simulator is always the whole window, and the crop happens in the picture.
  if (sim && req.region) {
    return { allow: false, reason: 'a simulator is recorded as a window, never as a region of the screen' }
  }
  const kind = sim ? 'window' : req.kind
  const app = sim ? (req.app || SIMULATOR_APP) : req.app

  if (kind === 'window') {
    if (!app) return { allow: false, reason: 'cannot tell which app that window belongs to' }
    if (isProtected(app, never)) {
      return { allow: false, reason: `${app} is on the never record list` }
    }
    // Unattributable is refused, the same way a window with no owner is. A simulator
    // whose device could not be resolved is exactly the one that might be the device the
    // person put on the list.
    if (sim && !req.udid) {
      return { allow: false, reason: 'cannot tell which device that simulator window is showing' }
    }
    // Any caller that knows the device gets the device check, whatever kind it claimed,
    // so naming a simulator window as a plain window is not a way around the list.
    if (req.udid && isDeviceProtected({ udid: req.udid, name: req.device }, neverDevices)) {
      return { allow: false, reason: `${deviceLabel({ udid: req.udid, name: req.device })} is on the never record devices list` }
    }
    if (mode === 'allowed' && !allowed.some(a => nameMatches(app, a))) {
      return { allow: false, reason: `${app} is not on the allowed apps list` }
    }
  }

  if (kind === 'display' && mode === 'allowed') {
    // A display shows every app at once, so "allowed apps only" cannot be honoured by
    // excluding windows. Refusing is the only truthful answer.
    return { allow: false, reason: 'recording a whole display is off while access is set to allowed apps only' }
  }

  if (mode === 'ask') return { allow: true, needsApproval: true, unanswered: UNANSWERED }
  return { allow: true }
}

// ── the system's own grant, which outranks every rule above ──────────────
// Screen Recording belongs to macOS and is given by a person in System Settings. Reading
// the state is free and raises nothing; capturing without it is what raises a dialog,
// and a dialog is the worst thing that can happen to an unattended agent: it waits on a
// question it cannot see and cannot answer, forever. So the state is read first and a
// capture that cannot work is refused with the sentence that says what to do.
//
// Never a request. CGRequestScreenCaptureAccess would put that dialog on the person's
// screen on an agent's behalf, which is their call and not the agent's.
//
// This one grant covers the sound as well as the picture. ScreenCaptureKit's audio is
// part of screen capture, which is why macOS 15 names the pane Screen and System Audio
// Recording, so a take that may be recorded may record what it is recording. Nothing
// else needs asking for and nothing else should be added here: the microphone is the
// separate grant, and the microphone is off unless somebody asks for it.
//
// @param {string} status  systemPreferences.getMediaAccessStatus('screen')
// @param {'agent'|'human'} by
const PRIVACY_PANE = 'System Settings, Privacy and Security, Screen Recording'
function screenAccess(status, by = 'agent') {
  // A person is never refused here, whatever the reading says, and that is the whole of
  // this rule. Electron's screen status is backed by a boolean preflight, so a Mac that
  // was never asked reads as 'denied' and is indistinguishable from one that said no. A
  // person can settle either: the system's own prompt is raised by the read the helper
  // makes, and Fetch may not be listed in that pane until it has been. Refusing them on
  // the reading deleted the first-run prompt and named a switch that did not exist yet.
  // They go through to the helper, which does not preflight for a person, and a refusal
  // that is real comes back from macOS itself, naming the pane and the restart.
  if (by !== 'agent') return { allow: true }
  if (status === 'denied' || status === 'restricted') {
    return { allow: false, reason: `screen recording permission is turned off for Fetch, ` +
      `ask the person to turn it on in ${PRIVACY_PANE} and then restart Fetch` }
  }
  // Not determined is the state a fresh Mac ships in, and the state this fault was found
  // in. An agent cannot answer the system prompt, so for an agent it is a refusal.
  if (status === 'not-determined') {
    return { allow: false, reason: `screen recording permission has not been granted, ` +
      `ask the person to grant it to Fetch in ${PRIVACY_PANE} and then restart Fetch` }
  }
  // 'granted', and anything we could not read. A state nobody could measure is not
  // grounds to refuse a capture that would have worked; the helper says what went wrong.
  return { allow: true }
}

/**
 * Window ids to keep out of a display capture. Passed to ScreenCaptureKit as
 * excludingWindows, so protected apps are absent from the frame rather than blurred
 * afterwards: nothing sensitive is ever written to disk.
 *
 * This can only exclude what it was shown. The list a picker draws is filtered
 * (WindowList.swift drops anything under 140x120 and deduplicates on app, title and
 * size), so a password manager's small quick-access panel, or a second window of the
 * same size and title, is not in it and cannot be named here. Prefer appsToExclude
 * wherever the helper can enumerate the windows itself.
 *
 * A window carrying a `device` block is a simulator, and a device on the never list goes
 * out of a display capture too. This is the one place that rule can be honoured by id
 * alone: appsToExclude speaks in app names and every simulator answers to the same one,
 * so a protected device inside a window Fetch did not enumerate cannot be named. Keep the
 * device list short and record simulators as windows.
 */
function windowsToExclude(windows, policy = {}) {
  const never = policy.neverRecord || DEFAULT_NEVER
  const neverDevices = policy.neverRecordDevices || DEFAULT_NEVER_DEVICES
  return (windows || [])
    .filter(w => isProtected(w.app, never) || (w.device && isDeviceProtected(w.device, neverDevices)))
    .map(w => w.id)
}

/**
 * The app names to keep out of a capture, for a helper that enumerates the windows
 * itself. Names rather than window ids, because a list built for a person to read must
 * never be what decides which pixels are written: every window of a protected app goes,
 * including the ones no picker would ever show.
 */
const appsToExclude = (policy = {}) => (policy.neverRecord || DEFAULT_NEVER)
  .map(x => (typeof x === 'string' ? x : x && x.app)).filter(Boolean)

// ── conduct: what an agent may do to a simulator ─────────────────────────
// Driving another machine is a bigger deal than recording one, so the line is drawn here
// rather than in a tool description. A rule a model reads is a rule it can talk itself
// out of, and this one has to hold on the turn where the model is trying hard to finish
// the job. Every caller checks simDecide() before it spawns anything.
//
// Three sizes of act, and the difference between them is what the person loses if it was
// wrong. Reading somebody's simulators costs them nothing. Booting one changes what their
// Mac is doing. Installing a build changes what is on the device. Erasing it takes
// something back they cannot get. So: reads are free, mutations need their word, and the
// two that destroy are refused to everyone.

// Normalised so a caller may say the tool's action or simctl's own verb, with a space,
// an underscore or a hyphen between the words.
const simAct = a => String(a || '').trim().toLowerCase().replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ')

const SIM_ALIAS = {
  'list device types': 'list devicetypes',
  'list devices': 'list',
  'list runtimes': 'list',
  'io screenconfig geometry': 'screenconfig geometry',
  'screenconfig': 'screenconfig geometry',
  'geometry': 'screenconfig geometry',
  'appearance': 'ui appearance',
  'appearance read': 'ui appearance read',
  'content size': 'ui content size',
  'increase contrast': 'ui increase contrast',
  'statusbar list': 'status bar list',
  'status bar': 'status bar override',
  'open a simulator': 'open simulator',
  'open simulator app': 'open simulator',
  'io recordvideo': 'recordvideo',
  'io screenshot': 'screenshot',
}

// Free. Every one of these is a read, and reading costs the person nothing. `restore` is
// here because putting an override back is never the wrong move: a simulator left stuck
// at 9:41 is Fetch's mess, not the person's.
const SIM_FREE = [
  'list', 'list devicetypes', 'listapps', 'appinfo', 'get app container',
  'io enumerate', 'status bar list', 'ui appearance read', 'restore',
]

// Asked. Needs the person's word in this conversation, in so many words. "Make me a
// demo" is not consent to boot a device, and a booted device is not consent to install.
const SIM_ASK = [
  'boot', 'bootstatus', 'shutdown', 'install', 'install app data', 'launch', 'terminate',
  'openurl', 'go', 'push', 'addmedia', 'location', 'privacy', 'privacy grant',
  'privacy revoke', 'privacy reset', 'keychain', 'pbcopy', 'pbpaste', 'spawn',
  'screenconfig geometry', 'tap', 'ready',
]

// Just inside the asked line, and only for the reason written next to it: these change
// what is on the person's device, and they are free without asking only while Fetch is
// the thing recording or shooting it, and only because the old value was stashed and
// goes back. Take the restore away and they are ordinary mutations again.
//
// A bare 'ui appearance' or 'status bar' reads as the write, not the read, because an
// ambiguous name has to fail towards the stricter rule. The read is 'ui appearance read'.
const SIM_WHILE_CAPTURING = [
  'status bar override', 'status bar clear',
  'ui appearance', 'ui content size', 'ui increase contrast',
]

// What `ready` performs, so one yes to `ready` carries the steps inside it and nothing
// else. It does not carry a tap, a deep link, a push or a shutdown: those are their own
// acts and get their own word.
const READY_SEQUENCE = [
  'boot', 'bootstatus', 'open simulator', 'install', 'launch',
  'status bar override', 'ui appearance', 'ui content size',
]

// Opening Simulator.app is launching an app on somebody's Mac, which Fetch does not
// otherwise do. It is allowed in exactly one place because `simctl boot` is headless and
// produces no window at all, so a boot the person asked for would happen invisibly, and
// an invisible boot is worse than a visible one.
const SIM_ONLY_IN_READY = ['open simulator']

const REFUSED_DEVICE_LIFE = 'Fetch does not create or destroy somebody\'s devices or an ' +
  'app\'s data, so this is refused to everyone, including the person through an agent. ' +
  'That one belongs at a command line.'
const REFUSED_OWN_PIXELS = 'that writes pixels straight from the device without passing ' +
  'Fetch\'s never record check, and the file it makes has no audio track. Record the ' +
  'simulator\'s window instead.'
const REFUSED_FRONT = 'Fetch never brings a window to the front. A simulator is recorded ' +
  'where it sits, occluded or not.'
const REFUSED_THIS_MAC = 'Fetch never moves this Mac\'s mouse, presses its keyboard or ' +
  'makes a sound. A simulator tap goes into the device\'s own input path, not this one.'
const REFUSED_NO_GESTURE = 'nothing on this Mac can send that to a simulator: simctl has ' +
  'no gesture of any kind, and Fetch draws a tap and nothing else. Record the person ' +
  'doing it instead.'

// Refused always, to anyone. Consent does not reach this table, which is the point of it.
const SIM_REFUSED = {
  create: REFUSED_DEVICE_LIFE, clone: REFUSED_DEVICE_LIFE, erase: REFUSED_DEVICE_LIFE,
  delete: REFUSED_DEVICE_LIFE, upgrade: REFUSED_DEVICE_LIFE, uninstall: REFUSED_DEVICE_LIFE,
  recordvideo: REFUSED_OWN_PIXELS, screenshot: REFUSED_OWN_PIXELS,
  'raise window': REFUSED_FRONT, activate: REFUSED_FRONT, 'bring to front': REFUSED_FRONT,
  front: REFUSED_FRONT, focus: REFUSED_FRONT,
  mouse: REFUSED_THIS_MAC, 'move mouse': REFUSED_THIS_MAC, 'mac click': REFUSED_THIS_MAC,
  keyboard: REFUSED_THIS_MAC, keystroke: REFUSED_THIS_MAC, sound: REFUSED_THIS_MAC,
  beep: REFUSED_THIS_MAC, volume: REFUSED_THIS_MAC,
  swipe: REFUSED_NO_GESTURE, pinch: REFUSED_NO_GESTURE, 'long press': REFUSED_NO_GESTURE,
  drag: REFUSED_NO_GESTURE, type: REFUSED_NO_GESTURE, text: REFUSED_NO_GESTURE,
  key: REFUSED_NO_GESTURE, 'key sequence': REFUSED_NO_GESTURE, button: REFUSED_NO_GESTURE,
}

// One table the tests can walk, so a verb added to this file cannot quietly land in no
// class at all and an unknown verb is never the permissive answer.
const SIM_ACTIONS = {}
for (const a of SIM_FREE) SIM_ACTIONS[a] = 'free'
for (const a of SIM_ASK) SIM_ACTIONS[a] = 'ask'
for (const a of SIM_WHILE_CAPTURING) SIM_ACTIONS[a] = 'capturing'
for (const a of SIM_ONLY_IN_READY) SIM_ACTIONS[a] = 'ready'
for (const a of Object.keys(SIM_REFUSED)) SIM_ACTIONS[a] = 'refused'

// Did the person say yes to this? `true` is a yes to this call and the caller is the one
// holding the answer. A list of names is a yes to those acts, and 'ready' carries the
// sequence it performs, because a person who asked for a device to be made ready did not
// want to be asked again about the boot inside it.
const consentNames = c =>
  (Array.isArray(c) ? c : (c && c !== true ? [c] : [])).map(simAct)

function simConsented(consent, action) {
  if (consent === true) return true
  const names = consentNames(consent)
  if (names.includes(action)) return true
  return names.includes('ready') && READY_SEQUENCE.includes(action)
}

/**
 * May an agent do this to a simulator, right now, without asking?
 *
 * `consent` is the person's word in this conversation and the caller is responsible for
 * having heard it. It is never a field an agent passes through from its own tool call:
 * an agent that can set its own consent flag has no consent rule at all.
 *
 * Fails closed everywhere. An unknown verb is refused, an ambiguous one reads as the
 * stricter of its two meanings, and a refusal is `allow: false` rather than a flag a
 * caller can forget to read.
 *
 * @param {string} action   a tool action ('ready', 'tap') or a simctl verb ('boot')
 * @param {object} opts
 *   @param {true|string|string[]} [opts.consent]  what the person said yes to
 *   @param {string} [opts.udid]        the device it is aimed at
 *   @param {string} [opts.device]      that device's name, for the sentence
 *   @param {boolean} [opts.capturing]  Fetch is recording or shooting this device now
 *   @param {boolean} [opts.restores]   the caller stashed the old value and will put it back
 * @param {object} policy  { neverRecordDevices[] }
 * @returns {{allow: boolean, reason?: string, needsConsent?: boolean, mustRestore?: boolean, mustSay?: boolean}}
 */
function simDecide(action, opts = {}, policy = {}) {
  const raw = String(action || '').trim()
  const a0 = simAct(raw)
  const a = SIM_ALIAS[a0] || a0
  const shown = raw || 'that'

  if (!a || !SIM_ACTIONS[a]) {
    return { allow: false, reason: `${shown} is not something Fetch does to a simulator. ` +
      `It knows list, ready, go, tap and restore.` }
  }

  // Above consent, because a list a person's own yes could unlock is not a never list.
  if (SIM_REFUSED[a]) return { allow: false, reason: `${shown}: ${SIM_REFUSED[a]}` }

  // Putting an override back is allowed even on a device that has since gone onto the
  // never list. Refusing here would leave that device stuck at whatever Fetch set.
  if (a !== 'restore' && opts.udid) {
    const dev = { udid: opts.udid, name: opts.device }
    if (isDeviceProtected(dev, policy.neverRecordDevices)) {
      return { allow: false, reason: `${deviceLabel(dev)} is on the never record devices ` +
        `list, so Fetch does not touch it at all` }
    }
  }

  if (SIM_ACTIONS[a] === 'free') return { allow: true }

  if (SIM_ACTIONS[a] === 'ready') {
    // Named consent only. A blanket yes to the call in hand is not a yes to this, because
    // this one is allowed by where it sits and not by what it costs.
    if (consentNames(opts.consent).includes('ready')) return { allow: true, consented: true, mustSay: true }
    return { allow: false, needsConsent: true, reason: `Fetch does not launch apps on this ` +
      `Mac. Simulator is opened only inside a ready the person asked for, because a boot ` +
      `on its own leaves no window to record.` }
  }

  if (SIM_ACTIONS[a] === 'capturing') {
    // Free while Fetch is holding the camera, because the person sees the result and the
    // value goes back. Outside that it is an edit to their device like any other.
    if (opts.capturing && opts.restores) return { allow: true, mustRestore: true, mustSay: true }
    if (simConsented(opts.consent, a)) return { allow: true, consented: true, mustRestore: true, mustSay: true }
    return { allow: false, needsConsent: true, reason: `${shown} changes the person's ` +
      `device, so it is free only while Fetch is recording it and will put the old value ` +
      `back. Otherwise ask them first.` }
  }

  if (simConsented(opts.consent, a)) {
    return { allow: true, consented: true, ...(READY_SEQUENCE.includes(a) ? { mustSay: true } : {}) }
  }
  return { allow: false, needsConsent: true, reason: `${shown} needs the person's word in ` +
    `this conversation, in so many words. Ask them, then try again.` }
}

// ── settings an agent may change ─────────────────────────────────────────
// HUMAN_ONLY is the part that makes the rest of this file mean anything: an agent
// that could set recordAccess to 'always' or empty the never-record list would pass
// every check above. Telemetry is here because sharing anything is a person's call.
const AGENT_PREFS = ['saveDir', 'camera', 'mic', 'systemAudio', 'countdown',
  'openEditorAfter', 'keepOriginal', 'quickRecord', 'autoConvertMp4', 'autoUpdate', 'agentNames']
// neverRecordDevices is here for the same reason neverRecord is: the list is the whole
// protection, so an agent that could edit it would pass every check in this file.
const HUMAN_ONLY_PREFS = ['recordAccess', 'neverRecord', 'neverRecordDevices', 'allowedRecordApps', 'telemetry', 'agentTakesVisible',
  // an agent that can write its own standing permission has no permission rule at all
  'alwaysAllow']

// A settings patch from an agent, checked and coerced. Throws on the first problem
// and refuses the patch as a whole, so nothing is half applied. `dirExists` is passed
// in to keep this module free of the filesystem.
function checkSettingsPatch(patch, dirExists = () => true) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('settings must be an object')
  const keys = Object.keys(patch)
  const refused = keys.filter(k => HUMAN_ONLY_PREFS.includes(k))
  if (refused.length) throw new Error(`${refused.join(', ')} can only be changed by a person, in Fetch's Settings`)
  const unknown = keys.filter(k => !AGENT_PREFS.includes(k))
  if (unknown.length) throw new Error(`not a setting: ${unknown.join(', ')}`)
  const out = {}
  for (const k of keys) {
    const v = patch[k]
    if (k === 'countdown') {
      if (![0, 3, 5].includes(v)) throw new Error('countdown must be 0, 3 or 5')
      out[k] = v
    } else if (k === 'saveDir') {
      if (v !== null && !(typeof v === 'string' && dirExists(v))) throw new Error('saveDir must be an existing folder, or null for ~/Movies/Fetch')
      out[k] = v
    } else {
      if (typeof v !== 'boolean') throw new Error(`${k} must be true or false`)
      out[k] = v
    }
  }
  return out
}

module.exports = { decide, screenAccess, UNANSWERED, windowsToExclude, appsToExclude, isProtected, DEFAULT_NEVER, MODES,
  AGENT_PREFS, HUMAN_ONLY_PREFS, checkSettingsPatch,
  simDecide, isDeviceProtected, DEFAULT_NEVER_DEVICES, SIMULATOR_APP, SIM_ACTIONS, READY_SEQUENCE }
