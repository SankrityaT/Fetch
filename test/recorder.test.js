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
is('and where the sound comes from', startSim.from, ['the device, through the window it sits in'])
is('it does not promise a track before the file exists', /track/.test(startSim.note) && /landed/.test(startSim.note), true)
// The exclusion is a list of apps with windows taken at the start, so the sentence may
// not promise more than that (finding 7 and 19 of the round's review).
is('it never says only the window\'s own sound reaches the file', /Only (this|that) window/.test(startSim.note), false)
is('it says a process with no window is in it', /process with no window/.test(startSim.note), true)
is('and an app opened after the take started', /opened after the take started/.test(startSim.note), true)
is('and that the default is kept silent off Fetch\'s own recorder', /kept silent rather than record everything the Mac plays/.test(startSim.note), true)
is('the description says the same scope', /process with no window/.test(Opts.SIM_AUDIO_SAID) && !/rest of the Mac/.test(Opts.SIM_AUDIO_SAID), true)
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
  ['the device, through the window it sits in', 'the microphone'])

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

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
