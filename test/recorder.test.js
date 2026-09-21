// What record_stop tells an agent about a window that sent no new frames.
const { stillNote, occludedTake } = require('../ui/agent-bridge.js')

let pass = 0, fail = 0
const is = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}` + (ok ? '' : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`))
}

console.log('still window note')
is('nothing said for a take that kept changing', stillNote(0), null)
is('nothing said without a figure', stillNote(undefined), null)
is('a short pause on a static page is normal', stillNote(2900), null)
const n = stillNote(6130)
is('a long frozen stretch is reported', typeof n, 'string')
is('with its length', /6\.1 s/.test(n), true)
is('and the likely cause', /covered/.test(n), true)
is('no em dashes', /\u2014/.test(n), false)

console.log('a covered window before the take')
is('an uncovered window records', occludedTake({ covered: 0, by: [], x: 0, y: 0, width: 800, height: 600 }), null)
is('a sliver in front is fine', occludedTake({ covered: 0.05, by: ['Dock'], x: 0, y: 0, width: 800, height: 600 }), null)
is('off screen or unknown, it goes ahead', occludedTake(null), null)
const o = occludedTake({ covered: 0.42, by: ['Safari'], x: 100, y: 50, width: 800, height: 600 })
is('a covered window is refused with a status', [o.recording, o.status, o.covered, o.covered_by], [false, 'occluded', 0.42, ['Safari']])
is('it says what covers it and the way round', /Safari/.test(o.note) && /record_start/.test(o.note) && /crop/.test(o.note), true)
is('no em dashes there either', /\u2014/.test(o.note), false)

// ── what a take listens to, and what its result says it heard ────────────
// A simulator take came back silent while three tool descriptions promised it a track,
// because system_audio defaulted off on every path. These pin both halves of the fix:
// the default, and the sentence that has to be true whichever way the default went.
const Opts = require('../ui/recorder-opts.js')
const fs = require('fs')
const path = require('path')
const at = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')

console.log('\nwhat a take is asked to listen to')
const sim = (args, o) => Opts.audioFor(args || {}, { simulator: true, ...(o || {}) })
const mac = (args, o) => Opts.audioFor(args || {}, o || {})

is('a simulator take gets system audio without being asked', sim({}).systemAudio, true)
is('an ordinary window take does not', mac({}).systemAudio, false)
is('a whole display take does not either', mac({}, { simulator: false }).systemAudio, false)
is('asking for it on a Mac take still works', mac({ system_audio: true }).systemAudio, true)
is('and a simulator take can be recorded silent on purpose', sim({ system_audio: false }).systemAudio, false)
// The microphone is the grant that has to be asked for separately, so it is never on by
// accident: the room is not in a take nobody asked to be in.
is('the microphone stays off on a simulator take', sim({}).mic, false)
is('and comes on only when asked', sim({ mic: true }).mic, true)
is('the camera is untouched by any of this', sim({}).camera, false)

// The person's own default answers a question nobody asked, and nothing else. This is
// read to turn sound off, never to turn anything on: an agent take that fell back to
// their preferences is how a browser recording once switched on their camera and mic.
const off = { prefs: { systemAudio: false } }
is('their System audio switch turns the default back off', sim({}, off).systemAudio, false)
is('and the result knows that is why', sim({}, off).vetoed, true)
is('but an agent that asked in so many words still gets it', sim({ system_audio: true }, off).systemAudio, true)
is('and that is not a veto', sim({ system_audio: true }, off).vetoed, false)
is('their switch being on changes nothing', sim({}, { prefs: { systemAudio: true } }).systemAudio, true)
is('a mic preference is never read for a mic', sim({}, { prefs: { mic: true } }).mic, false)
is('and no preferences at all is the plain default', sim({}, { prefs: null }).systemAudio, true)

console.log('\nwhat record_start may say about sound')
const startSim = Opts.startedAudio(sim({}))
is('it says system audio is on', startSim.system_audio, true)
is('and where the sound comes from, the whole Mac', startSim.from, ['everything this Mac plays, the device among it'])
is('it does not promise a track before the file exists', /track/.test(startSim.note) && /landed/.test(startSim.note), true)
// No capture names an app any more (Recorder.swift start: a filter that names apps is
// what took replayd down), so a take with system audio hears everything the Mac plays,
// and no sentence may promise it leaves anything out.
const NARROW = /left out|windows were open|process with no window|opened after the take started|only the window|Only (this|that) window/i
is('it never says only the window\'s own sound reaches the file', /Only (this|that) window/.test(startSim.note), false)
is('it says the whole Mac is heard', /everything this Mac plays/.test(startSim.note), true)
is('and names the person\'s music and a call', /music or a call/.test(startSim.note), true)
is('and promises no exclusion', NARROW.test(startSim.note), false)
is('a window take says the same scope', /everything this Mac plays/.test(Opts.startedAudio(mac({ system_audio: true })).note) &&
  !NARROW.test(Opts.startedAudio(mac({ system_audio: true })).note), true)
is('and that the default is kept silent off Fetch\'s own recorder', /only the default is kept silent/.test(startSim.note), true)
is('without a reason that is no longer a difference', /rather than record everything the Mac plays/.test(startSim.note), false)
is('the description says the same scope', /everything this Mac plays/.test(Opts.SIM_AUDIO_SAID) && !NARROW.test(Opts.SIM_AUDIO_SAID), true)
is('and so does the argument', /this Mac plays/.test(Opts.SYS_AUDIO_ARG_SAID), true)
is('a missing track does not give the old reason either',
  /rather than record everything/.test(Opts.takeAudio(sim({}), { hasAudio: false }).note), false)
// A microphone is a track: saying "no audio track" of a take with mic true is wrong.
const micOnly = Opts.startedAudio(mac({ mic: true }))
is('a take with the mic on is never told it has no audio track', /no audio track/.test(micOnly.note), false)
is('it is told it has a microphone track', /microphone track/.test(micOnly.note), true)
is('and so is a simulator take with system sound off and the mic on',
  /microphone track/.test(Opts.startedAudio(sim({ mic: true, system_audio: false })).note), true)
is('no em dashes', /\u2014/.test(startSim.note), false)

const startSilent = Opts.startedAudio(sim({ system_audio: false }))
is('a silent simulator take says so at the start', startSilent.system_audio, false)
is('and names what has nothing to read', /transcribe, list_beats/.test(startSilent.note), true)
is('and how to get a track', /Leave system_audio out/.test(startSilent.note), true)
const startVetoed = Opts.startedAudio(sim({}, off))
is('a take held silent by their own setting says whose choice it was',
  /turned System audio off in Fetch's Settings/.test(startVetoed.note), true)
const startMac = Opts.startedAudio(mac({}))
is('a plain silent take says it plainly', startMac.note, 'This take has no audio track: system_audio and mic are both off. transcribe, list_beats, the captions and fit_to_length all read that track.')
is('both sources are named when both are on', Opts.startedAudio(sim({ mic: true })).from,
  ['everything this Mac plays, the device among it', 'the microphone'])

console.log('\nwhat record_stop says the file actually has')
const planOn = sim({})
const landed = Opts.takeAudio(planOn, { hasAudio: true, acodec: 'aac', audioTracks: 1 })
is('a track that landed is reported as one', [landed.track, landed.codec, landed.tracks], [true, 'aac', 1])
is('and a take that worked gets no lecture', landed.note, undefined)
is('two tracks are counted', Opts.takeAudio(planOn, { hasAudio: true, audioTracks: 2 }).tracks, 2)

// Sound was wired and none arrived. That is a fault on this Mac, not a setting to
// explain, and an agent should not learn it from transcribe.
const missing = Opts.takeAudio(planOn, { hasAudio: false, audioTracks: 0 })
is('sound asked for and none in the file is reported as a fault', missing.track, false)
is('it says the wiring was on', /System audio was on/.test(missing.note), true)
is('it says the picture is fine and the sound is not', /without stopping the picture/.test(missing.note), true)
is('and what to tell the person', /take is silent/.test(missing.note), true)
is('no em dashes there either', /\u2014/.test(missing.note), false)

const chose = Opts.takeAudio(sim({ system_audio: false }), { hasAudio: false })
is('a take recorded silent on purpose is not reported as a fault', /was on/.test(chose.note), false)
is('and says what turned it off', /system_audio false/.test(chose.note), true)

// A track at the floor and broken wiring both come back from transcribe as no speech,
// so the level is the only thing that tells them apart.
const quiet = Opts.takeAudio(planOn, { hasAudio: true, acodec: 'aac', audioTracks: 1 }, { meanDb: -91 })
is('a track at the noise floor says so', quiet.level, '-91.0 dB')
is('and says nothing on screen made a sound', /nothing on screen made a sound/.test(quiet.note), true)
is('and where a device demo\'s spine comes from instead', /voiceover/.test(quiet.note), true)
is('an app that was actually playing gets no note',
  Opts.takeAudio(planOn, { hasAudio: true, audioTracks: 1 }, { meanDb: -22.7 }).note, undefined)
is('an unmeasured take is not called silent',
  Opts.takeAudio(planOn, { hasAudio: true, audioTracks: 1 }, {}).note, undefined)
is('a measurement that found nothing over the meter\'s gate is the floor too',
  /noise floor/.test(Opts.takeAudio(planOn, { hasAudio: true, audioTracks: 1 }, { floor: true }).note), true)
is('with both wired, a track at the floor says the system half came through empty',
  /came through empty/.test(Opts.takeAudio(sim({ mic: true }), { hasAudio: true, audioTracks: 1 }, { meanDb: -91 }).note), true)
is('and a working mixed track says it cannot vouch for each half',
  /one track/.test(Opts.takeAudio(sim({ mic: true }), { hasAudio: true, audioTracks: 1 }, { meanDb: -20 }).mixed), true)
is('nor is one whose measurement failed',
  Opts.takeAudio(planOn, { hasAudio: true, audioTracks: 1 }, { meanDb: -Infinity }).note, undefined)

console.log('\nthe sentences the tool descriptions are made of')
for (const [k, s] of Object.entries(Opts).filter(([k]) => /_SAID$/.test(k))) {
  is(`${k} has no em dash`, /\u2014/.test(s), false)
  is(`${k} says something`, typeof s === 'string' && s.length > 20, true)
}
is('the description does not promise a track, it promises a default',
  /on by default/.test(Opts.SIM_AUDIO_SAID) && /What actually landed is on the result/.test(Opts.SIM_AUDIO_SAID), true)
is('and the argument says where the default differs',
  /Default off, and on for a simulator take/.test(Opts.SYS_AUDIO_ARG_SAID), true)
// record_start's description said the default was on, full stop. audioFor() lets the
// person's own Settings switch turn it off, so an agent that read "on by default" and
// passed nothing got a silent take it was told it would not get.
is('record_start\'s description names the person\'s switch beside the default',
  /on by default for a simulator take, unless the person turned System audio off/.test(Opts.SIM_AUDIO_SAID), true)
is('and so does the argument', /unless the person turned System audio off/.test(Opts.SYS_AUDIO_ARG_SAID), true)
is('and that is what the code does', sim({}, off).systemAudio === false && /unless/.test(Opts.SIM_AUDIO_SAID), true)
// system_audio false with mic true still lands a track
is('it no longer says system_audio false records a take silent', /record it silent/.test(Opts.SIM_AUDIO_SAID), false)
is('it says the microphone still records', /microphone is still recorded if mic is true/.test(Opts.SIM_AUDIO_SAID), true)

// A default that never reaches the recorder is a comment. These pin the two lines
// between audioFor() and a track in the file: main.js builds the argv, Recorder.swift
// reads it and opens the writer input. Drop either and every test above still passes
// while every take comes back silent again.
console.log('\nthe default has to reach the recorder')
is('main.js turns systemAudio into the recorder\'s own flag',
  /if \(opts\.systemAudio\) args\.push\('--system-audio'\)/.test(at('main.js')), true)
const rec = at('Recorder.swift')
is('Recorder.swift reads that flag', /case "--system-audio": o\.systemAudio = true/.test(rec), true)
is('and turns it into a capture and a track',
  /cfg\.capturesAudio = opts\.systemAudio/.test(rec) && /if opts\.systemAudio \{[\s\S]{0,200}?AVAssetWriterInput\(mediaType: \.audio/.test(rec), true)
// Losing the sound must never lose the take: a window take's audio comes from a second
// stream, and a failure there is written down and stepped over.
is('a sound stream that will not open does not take the picture with it',
  /catch \{[\s\S]{0,160}no system audio for this window/.test(rec), true)

// ── one app's sound, through a tap and not through replayd ───────────────
// A window take's sound became everything the Mac plays when the app-naming filter came
// out. A Core Audio process tap narrows it again without ScreenCaptureKit. It needs macOS
// 14.4 and the person's yes to System Audio Recording, and a take must never ask for that.
console.log('\nwhose sound a take has, and saying so')
const say = (scope, planned) => Opts.takeAudio(planned || planOn, { hasAudio: true, audioTracks: 1 }, { sound: scope })
const macSaid = say([{ track: 'system', scope: 'mac', why: 'permission unknown', tailMs: 40 }])
is('a whole-Mac take says it is one', macSaid.scope, 'mac')
is('and names what else is in it', /music, a notification or a call/.test(macSaid.heard), true)
is('and why nothing narrower', /System Audio Recording/.test(macSaid.heard) && /never asks/.test(macSaid.heard), true)
const devSaid = say({ scope: 'device', from: ['com.fetch.demo'] })
is('a device take says only the device was heard', devSaid.scope === 'device' && /only the device's own sound/.test(devSaid.heard), true)
is('and whose it was', /com\.fetch\.demo/.test(devSaid.heard), true)
is('an app take says only the app and what it answers for',
  /only the window's app/.test(say({ scope: 'app' }, mac({ system_audio: true })).heard), true)
is('a display take says why it is the whole Mac', /whole display/.test(say({ scope: 'mac', why: 'display' }).heard), true)
is('a tap that would not start says so', /would not start \(the tap was refused/.test(say({ scope: 'mac', why: 'tap failed: the tap was refused (-1)' }).heard), true)
is('with no report, nothing is claimed', say(null).scope, undefined)
is('a mic-only take claims no system scope', Opts.takeAudio(mac({ mic: true }), { hasAudio: true, audioTracks: 1 }, { sound: { scope: 'app' } }).scope, undefined)
is('an unknown scope is not repeated', Opts.scopeOf({ scope: 'everything' }), null)
is('the scope is read off the system track only', Opts.scopeOf([{ track: 'mic', scope: 'app' }, { track: 'system', scope: 'mac', why: 'display' }]).why, 'display')
is('the start says the tap exists and what it needs', /System Audio Recording \(macOS 14\.4 or later\)/.test(startSim.note), true)
is('and the description says the same, still saying the whole Mac first',
  /everything this Mac plays/.test(Opts.SIM_AUDIO_SAID) && /only the device's own sound is taken instead/.test(Opts.SIM_AUDIO_SAID), true)
// the bridge hands the recorder's report to takeAudio (agent-bridge afterTake), so the
// promise is kept, and record_stop's result carries the scope
is('the description says record_stop says which, now the bridge passes it', /record_stop says which/.test(Opts.SIM_AUDIO_SAID), true)
is('and the bridge does pass the recorder\'s report', /const sound = \(r && r\.sound\) \|\| \(deps\.takeSound \? deps\.takeSound\(\) : null\)[\s\S]{0,120}Opts\.takeAudio\(heard, meta, \{ \.\.\.level, sound \}\)/.test(at('ui/agent-bridge.js')), true)
// every sentence that promises the default sound also says the person's switch, which
// audioFor obeys, or it promises a track the take does not get
for (const [k, v] of Object.entries({ SIM_LIST_SAID: Opts.SIM_LIST_SAID, READY_NEXT_SAID: Opts.READY_NEXT_SAID, SIM_AUDIO_SAID: Opts.SIM_AUDIO_SAID })) {
  is(`${k} says the person can turn the default off`, /turned (System audio|it) off in Fetch's Settings/.test(v), true)
}
// at start, the scope the recorder started with is said as it said it
const startTap = Opts.startedAudio({ ...sim({}), scope: { scope: 'device' } })
is('a take that started tapped says the device\'s own sound at start', [startTap.scope, /only the device's own sound/.test(startTap.note), /everything this Mac plays/.test(startTap.note)], ['device', true, false])
const startWide = Opts.startedAudio({ ...mac({ system_audio: true }), scope: { scope: 'mac', why: 'permission unknown' } })
is('and one that started wide says why', [startWide.scope, /System Audio Recording/.test(startWide.note)], ['mac', true])
is('two booted devices sharing the audio service is said in words', /more than one simulator is booted, and the audio service they share/.test(
  Opts.takeAudio({ systemAudio: true, simulator: true }, { hasAudio: true, audioTracks: 1 }, { sound: { scope: 'mac', why: 'shared service' } }).heard || ''), true)
for (const t of [macSaid.heard, devSaid.heard]) is('no em dash in what was heard', /\u2014/.test(t), false)

console.log('\nthe tap in the recorder')
const tapSrc = rec.slice(rec.indexOf('// ---------- one app\'s sound ----------'), rec.indexOf('// ---------- a generated take ----------'))
is('it is a Core Audio process tap', /AudioHardwareCreateProcessTap\(d, &tapID\)/.test(tapSrc), true)
is('it is private, and the person keeps hearing what they heard', /d\.isPrivate = true/.test(tapSrc) && /d\.muteBehavior = \.unmuted/.test(tapSrc), true)
is('it never waits for the first sound to start', /kAudioAggregateDeviceTapAutoStartKey: false/.test(tapSrc), true)
is('it only runs on macOS 14.4 or later', /guard #available\(macOS 14\.4, \*\) else \{ return mac\("macos"\) \}/.test(tapSrc) &&
  /@available\(macOS 14\.4, \*\)\s*final class AppSound/.test(tapSrc), true)
is('it looks the permission up and takes the whole Mac without it',
  /guard access == "granted" else \{ return mac\("permission/.test(tapSrc), true)
// A tap made without the permission delivers silence and raises a dialog, so a take
// must only ever look, never ask
const askAt = [...rec.matchAll(/AudioAccess\.request\b/g)].map(m => m.index)
is('only --audio-access request asks, never a take',
  askAt.length === 1 && rec.lastIndexOf('if argAfter("--audio-access") == "request"', askAt[0]) > rec.indexOf('// ---------- main ----------'), true)
is('two booted devices and none named is not guessed', /sims\.count == 1 else \{ return mac\(/.test(tapSrc), true)
is('with two booted, a named device is not said to be heard alone through the service they share',
  /guard sims\.count == 1 else \{ return mac\("shared service"\) \}/.test(tapSrc), true)
// the aggregate's first buffers are the clock device's own inputs (a headset's microphone)
is('the tap\'s buffers are read past the clock device\'s inputs, never the first buffer', /let first = list\[skip\]/.test(tapSrc) &&
  !/list\.first/.test(tapSrc) && /skip = inputBuffers\(of: output\)/.test(tapSrc) && /kAudioObjectPropertyScopeInput/.test(tapSrc), true)
is('only the tap\'s own buffers go into the sample', /bufferList: own\.unsafePointer/.test(tapSrc) && !/bufferList: input\)/.test(tapSrc), true)
is('a buffer of the wrong channel count is never read as the tap', /mNumberChannels\) == per/.test(tapSrc), true)
is('main.js names the device a simulator take is for', /args\.push\('--sound-device', String\(soundDevice\)\)/.test(at('main.js')), true)
is('a device\'s sound is its launchd_sim\'s processes', /Procs\.ancestors\(pid\)\.contains\(s\)/.test(tapSrc) && /launchd_sim/.test(tapSrc), true)
is('an app\'s sound is it, its children and what it answers for',
  /pid == o \|\| Procs\.ancestors\(pid\)\.contains\(o\) \|\| Procs\.responsible\(pid\) == o/.test(tapSrc), true)
is('its buffers go through the same road as a stream\'s', /AppSound\(plan: plan, queue: sampleQueue\) \{ \[weak self\] sb in self\?\.route\(sb, \.audio\) \}/.test(rec), true)
is('on the host clock the pictures are stamped with', /CMClockMakeHostTimeFromSystemUnits\(time\.pointee\.mHostTime\)/.test(tapSrc), true)
is('everything it made is taken down', ['AudioDeviceStop', 'AudioDeviceDestroyIOProcID', 'AudioHardwareDestroyAggregateDevice',
  'AudioHardwareDestroyProcessTap', 'AudioObjectRemovePropertyListenerBlock'].every(k => tapSrc.includes(k + '(')), true)
const stSrc = rec.slice(rec.indexOf('func start() async'), rec.indexOf('private func setUpWriter'))
is('with a tap there is no sound stream in replayd at all',
  /if tapPlan == nil \{ soundFilter = SCContentFilter\(display: d, excludingWindows: \[\]\) \}/.test(stSrc), true)
is('a tap that will not start falls back to the display\'s sound, once',
  /if let plan = tapPlan, !openAppSound\(plan\), let d = fallbackDisplay \{\s*soundFilter = SCContentFilter\(display: d, excludingWindows: \[\]\)\s*\}\s*if let sf = soundFilter \{ await openSoundStream\(sf\) \}/.test(stSrc), true)
is('and the tap is stopped first, with the sound', /func stopSound\(\) async \{\s*if #available\(macOS 14\.4, \*\), let a = appSound as\? AppSound \{\s*appSound = nil\s*a\.stop\(\)/.test(rec), true)
is('started says whose sound it is', /"soundScope": soundScopeFacts\(\)\]\)/.test(stSrc), true)
is('and so does stopped, on its own and on the system track',
  /"soundScope": soundScopeFacts\(\)/.test(rec.slice(rec.indexOf('func finish() async'))) && /r\.merge\(scope\)/.test(rec), true)

// ── never the thing that takes replayd down ──────────────────────────────
// replayd, the daemon behind all screen capture on a Mac, crashed 25 times between Sep 18
// and Sep 21 in its audio queue's input callback (_SCAudioCapture_handleInputBuffer),
// calling into a capture it had already freed. It watches every process a filter's audio
// names, and rebuilds the queue when one of them changes state; the newest report has
// that process monitor freeing the capture session on the next thread over. Each crash
// took screen capture away from the whole Mac for up to 20 minutes. These pin the four
// things the recorder does so as never to walk it down that path.
console.log('\nnever the thing that takes replayd down')
is('no capture names apps to hear or to leave out',
  !/excludingApplications|including: \[?\w*[Aa]pp/.test(rec), true)
is('and it never asks replayd to leave this process out, which is watched the same way',
  !/excludesCurrentProcessAudio = true/.test(rec) && /excludesCurrentProcessAudio = false/.test(rec), true)
is('a window take\'s sound comes from the display alone',
  /soundFilter = SCContentFilter\(display: d, excludingWindows: \[\]\)/.test(rec), true)
is('only one stream captures sound: the picture\'s does only on a display take',
  /cfg\.capturesAudio = opts\.systemAudio && opts\.windowID == nil/.test(rec) &&
  /if cfg\.capturesAudio \{ try s\.addStreamOutput\(self, type: \.audio/.test(rec), true)
const fin = rec.slice(rec.indexOf('func finish() async'))
is('Stop brings the streams down one at a time, the sound first',
  fin.indexOf('await stopSound()') > 0 && fin.indexOf('await stopSound()') < fin.indexOf('await stop(s, "picture"'), true)
// Stop, a closed stdin or main.js's SIGTERM at 6 s can land while start() is still inside
// startCapture. Exiting then leaves a start replayd has not answered, and a failed picture
// start and a Stop could both stop the one sound stream at once.
is('Stop waits for a start still in progress before it stops anything',
  fin.indexOf('await waitForStart()') > 0 && fin.indexOf('await waitForStart()') < fin.indexOf('await stopSound()'), true)
is('and that wait is bounded, so a start replayd never answers cannot hold the take for ever',
  /func waitForStart\(\) async \{\s*for _ in 0\.\.<\d+/.test(rec), true)
const st = rec.slice(rec.indexOf('func start() async'), rec.indexOf('private func setUpWriter'))
is('start says when it is done however it ends', /defer \{ markStartDone\(\) \}/.test(st), true)
is('a start that finds the take stopped stops what it opened, the sound first',
  /openSoundStream\(sf\) \}\s*if isFinished\(\) \{ await stopSound\(\); return \}/.test(st) &&
  /if isFinished\(\) \{\s*await stopSound\(\)\s*await stop\(s, "picture"/.test(st), true)
is('the sound stream is let go of when it is stopped, so it is never stopped twice',
  /func stopSound\(\) async \{[\s\S]{0,300}?let s = soundStream\s*soundStream = nil/.test(rec), true)
// recover() used to reopen the window's stream up to six times, 0.5 s apart, every failure
// swallowed, and the likeliest reason the stream stopped was replayd going down.
const rv = rec.slice(rec.indexOf('private func recover(from'), rec.indexOf('static func serviceGone'))
is('a capture service that went away is not reopened', /!Recorder\.serviceGone\(error\)/.test(rv) &&
  /-3805/.test(rec) && /-3817/.test(rec), true)
is('a window that comes back is started once, never in a loop',
  (rv.match(/openStream\(/g) || []).length === 1 && !/for [^\n]*\{[^}]*openStream/.test(rv) && !/try\? await openStream/.test(rv), true)
is('and a start that fails there is written down', /its capture did not start/.test(rv), true)
is('no stop is swallowed', !/try\? await [\w?.]*stopCapture/.test(rec) && /did not stop cleanly/.test(rec), true)
is('outputs come off only after the stream has stopped',
  /try await s\.stopCapture\(\)[\s\S]{0,300}?removeStreamOutput/.test(rec), true)
is('a picture that will not start does not leave the sound running',
  /catch \{[\s\S]{0,260}?await stopSound\(\)[\s\S]{0,80}?fail\("could not start capture/.test(rec), true)
is('a sound stream that fails is heard about, and not reopened',
  /configuration: soundOnly\(\), delegate: self/.test(rec) && /stream === soundStream \{[\s\S]{0,200}?return/.test(rec), true)
is('no em dashes in the recorder', /\u2014/.test(rec), false)

// ── sound on the picture's clock ─────────────────────────────────────────
// A simulator take's sound started 2.3 s after its picture. The file was honest about
// it through an edit list, and every ffmpeg graph that trims the track or decodes it to
// a wav put the first sample at zero, so the export, the transcript and the waveform
// all had the sound 2.3 s early. The writer also dropped audio while a still window
// held its interleave, and AAC packs what is left, so every take drifted early by
// 20 ms at a time. These pin the fix in the source, then measure it in a written file.
console.log('\nsound on the picture\'s clock')
is('a window take opens its sound before its picture',
  rec.indexOf('if let sf = soundFilter { await openSoundStream(sf) }') < rec.indexOf('s = try await openStream(filter)'), true)
is('sound that arrives while the writer is full waits rather than being dropped',
  /default:\s*queueSound\(sb, at: shifted/.test(rec) && !/sysAudioIn, a\.isReadyForMoreMediaData else \{ return \}/.test(rec), true)
is('a hole before a sample is filled with silence before the sample goes in',
  /fillSilence\(input, fmt, from: next, to: t\)/.test(rec), true)
is('and the sound runs to Stop', /soundTail\[k\] = fillSilence\(input, fmt, from: next, to: end\)/.test(rec), true)
is('what it took is reported on stopped', /"sound": soundReport\(\)/.test(rec), true)
// Reset to each buffer's own stamp, the written position forgot every correction, so a
// sound clock 2000 ppm off the host clock was 116 ms out by a minute with gaps 0.
is('the written position is the sum of what was written, not the last stamp',
  /soundNext\[key\] = CMTimeAdd\(next, soundLength\(piece, fmt\)\)/.test(rec) && !/soundNext\[key\] = CMTimeAdd\(t, soundLength/.test(rec), true)
is('and a file ahead of its sound lets the head of a buffer go', /headCut\(sb, fmt, seconds: over/.test(rec), true)

async function measured() {
  const { execFileSync, spawn, spawnSync } = require('child_process')
  const os = require('os')
  const FF = fs.existsSync(path.join(__dirname, '..', 'vendor', 'ffmpeg')) ? path.join(__dirname, '..', 'vendor', 'ffmpeg') : '/opt/homebrew/bin/ffmpeg'
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-sync-'))
  const bin = path.join(dir, 'Recorder'), out = path.join(dir, 'take.mov')
  try {
    try { execFileSync('swiftc', ['-Onone', path.join(__dirname, '..', 'Recorder.swift'), '-o', bin], { stdio: 'ignore' }) }
    catch { console.log('  skip swiftc is not here to build the recorder'); return }
    // a generated take: a white frame and a click together at 3 s and 7 s, the sound
    // starting 2.3 s late and stalling for a second in the middle. Nothing is played.
    // Stop counted from the first frame, not from the spawn: on a loaded Mac the recorder
    // took seconds to start, and a take stopped by the spawn's clock lost its 7 s flash
    const take = (spec, ms) => new Promise(resolve => {
      const p = spawn(bin, ['--out', out, '--system-audio', '--fps', '30', '--test-source', spec])
      let buf = '', timer = null
      p.stdout.on('data', d => {
        buf += d
        if (!timer && /firstFrame/.test(buf)) timer = setTimeout(() => p.stdin.write('stop\n'), ms)
      })
      setTimeout(() => { if (!timer) timer = setTimeout(() => p.stdin.write('stop\n'), 0) }, ms + 20000)
      p.on('close', () => resolve(buf.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return {} } }).find(e => e.event === 'stopped')))
    })
    // Whose sound a take would get, asked of the built recorder. No tap is made and no
    // capture opened: this reads the permission (without asking) and Core Audio's list
    // of processes, and nothing else.
    const plan = (...a) => { try { return JSON.parse(execFileSync(bin, ['--sound-plan', ...a], { encoding: 'utf8', timeout: 20000 }).trim().split('\n').pop()) } catch (e) { return { error: e.message } } }
    const own = plan('--pid', 'self')
    is('the plan says what the permission is, without asking', ['granted', 'denied', 'unknown'].includes(own.access), true)
    is('and never a narrow scope without it', own.access === 'granted' || own.scope === 'mac', true)
    is('and why, when it is the whole Mac', own.scope !== 'mac' || typeof own.why === 'string', true)
    is('an app is found in Core Audio\'s process list by its pid', own.target === 'app' && own.members.some(m => m.pid > 0), true)
    const ghost = plan('--bundle', 'com.apple.iphonesimulator', '--sound-device', '00000000-0000-0000-0000-00000000F4C3')
    is('a device that is not booted is not guessed at', [ghost.target, ghost.targetWhy, ghost.members.length], ['mac', 'device not booted', 0])
    is('the whole Mac can be asked for by name', plan('--pid', 'self', '--whole-mac-sound').why, 'asked')

    const stopped = await take('lead=2.3,gap=4.5-5.5', 9000)
    const flashes = () => {
      const r = spawnSync(FF, ['-hide_banner', '-nostdin', '-i', out, '-map', '0:v:0', '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 1 << 26 })
      const t = []; let pts = null
      for (const l of r.stdout.split('\n')) {
        let m = /pts_time:([\d.]+)/.exec(l); if (m) pts = +m[1]
        m = /YAVG=([\d.]+)/.exec(l); if (m && +m[1] > 128) t.push(pts)
      }
      return t
    }
    // samples from zero, the way a trim graph, a wav and the waveform read a track
    const clicks = () => {
      const b = execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', out, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'], { maxBuffer: 1 << 26 })
      const t = []; let last = -1e9
      for (let i = 0; i < b.length / 4; i++) if (Math.abs(b.readFloatLE(i * 4)) > 0.3) { if (i - last > 4800) t.push(i / 48000); last = i }
      return t
    }
    const v = flashes(), a = clicks()
    const sound = stopped && stopped.sound && stopped.sound[0]
    is('the generated take has both flashes', v.map(x => +x.toFixed(3)), [3, 7])
    is('and a click with each', a.length, 2)
    const off = v.map((x, i) => Math.round(((a[i] ?? 99) - x) * 1000))
    is('the click lands on its frame, to the millisecond, before and after a stall', off.every(o => Math.abs(o) <= 1), true)
    if (!off.every(o => Math.abs(o) <= 1)) console.log(`       offsets ${off.join(', ')} ms`)
    is('the recorder says what it padded', [sound && Math.round(sound.leadMs / 100), sound && sound.gaps], [23, 1])
    const lens = spawnSync(FF, ['-hide_banner', '-i', out], { encoding: 'utf8' }).stderr
    is('and the sound starts with the picture', /Audio: aac/.test(lens) && execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-i', out, '-map', '0:a:0', '-frames:a', '1', '-f', 'framecrc', '-']).toString().split('\n').find(l => l && l[0] !== '#').split(',')[2].trim(), '0')
    // A sound clock that runs slow, then fast, against the host clock. Uncorrected the
    // click at 9 s is 18 ms out and growing; corrected it stays inside the 5 ms slack.
    for (const ppm of [2000, -2000]) {
      const ev = await take(`drift=${ppm},flash=3:9`, 10000)
      const fv = flashes(), fa = clicks()
      const o = fv.map((x, i) => Math.round(((fa[i] ?? 99) - x) * 1000))
      is(`a sound clock ${ppm > 0 ? 'slow' : 'fast'} by ${Math.abs(ppm)} ppm stays on the picture`, fv.length === 2 && o.every(x => Math.abs(x) <= 6), true)
      if (!o.every(x => Math.abs(x) <= 6)) console.log(`       offsets ${o.join(', ')} ms, flashes ${fv.join(', ')}`)
      const s0 = ev && ev.sound && ev.sound[0]
      is(`and says how it kept it there (${ppm > 0 ? 'filled' : 'trimmed'})`, !!s0 && (ppm > 0 ? s0.gapMs > 0 : s0.trimMs > 0), true)
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}

measured().catch(e => { fail++; console.log('  FAIL the measured take: ' + e.message) }).finally(() => {
  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
})
