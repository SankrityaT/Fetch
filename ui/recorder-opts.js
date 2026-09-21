// What a take listens to, and what its result is allowed to say it heard.
//
// Pure: no Electron, no ffmpeg, no filesystem, so both halves can be tested without a
// Mac and without a device. The decision belongs to record_start and the sentence
// belongs to record_stop, and they live in one file because the fault this was written
// for is the two of them disagreeing. Three tool descriptions promised a simulator take
// an audio track, `system_audio` defaulted off, and the agent found out from transcribe
// that the file was silent. A description is not where a result lives.
//
// The whole rule, in two lines:
//
//   a simulator take gets system audio unless somebody says otherwise
//   every take's result says what it actually got, off the written file
//
// ── why the default is on rather than the promise taken out ──────────────
//
// Fetch records the Simulator's window instead of the device's framebuffer, and the
// only thing that buys is the sound: a framebuffer capture has no audio track at all,
// so transcribe, list_beats, the captions, fit_to_length and remove_dead_air are dead on
// one. With system audio off, a window take is the same silent file with more steps.
// Leaving the default off and deleting the sentences would have been honest and would
// have thrown the reason for the feature away.
//
// ── what it costs, measured rather than assumed ──────────────────────────
//
// **Nothing is asked of the person by a take.** Whole-Mac sound rides the Screen
// Recording grant the take already cannot start without (ui/record-policy.js,
// screenAccess); macOS 15 calls that pane Screen and System Audio Recording for exactly
// this reason. One app's sound (below) needs a second permission, System Audio Recording,
// and a take never asks for it: Recorder.swift looks it up without asking and, without
// it, takes the whole Mac's sound and says so. The microphone needs its own grant and its
// own asking too, and it stays off unless the agent asks for it: the room is never in a
// take nobody asked to be in.
//
// **What reaches the file is everything this Mac plays while the take runs, unless the
// recorder could tap the one app's sound.** It used to be narrower: Recorder.swift took a
// window take's sound from the display with every other app that owned a window left out
// by process id. A filter that names apps is what took macOS's screen capture service
// down (replayd crashed 25 times, a use after free in its audio input callback, because
// naming processes makes it rebuild its audio queue whenever one of them changes state),
// so no capture names an app any more. The narrow scope is back through a Core Audio
// process tap (Recorder.swift SoundPlan and AppSound), which coreaudiod serves and replayd
// never sees: a window take hears its app and the processes it started or answers for, a
// simulator take hears that device's own processes. It is had only on macOS 14.4 or later,
// with the person's yes to System Audio Recording already given, and with a target that is
// not a guess (Simulator.app's window with two devices booted and none named is a guess).
// Anywhere else the take has the whole Mac's sound: the person's music, a call, a second
// booted simulator. The recorder reports which on started and on stopped (`soundScope`,
// and on the system track of `sound`), and takeAudio() says it on the result when it is
// handed that report (o.sound); the descriptions promise no more than that. Proven by
// the build and the plan it prints, not by a live take: see .context/survey/q-q4.md.
//
// **The device's sound is in it because the Mac plays it.** A simulator's guest app is a
// host process of its own, under that device's launchd_sim, and plays to the Mac's output
// (sim-m0 read it off Core Audio's process list); a process of exactly that shape was
// captured and transcribed word perfect. That is also why a tap can find it: it has a
// process id, where it has no window and no app to name.
//
// **Why the default stays on.** The sound is the whole reason to record the window, and
// an agent's take is never started without the person's yes, which says "with sound" and
// names their music and a call. A person who records their own demo sets their own switch.
// So the default is still on, and every surface says what it hears.
//
// **Only on Fetch's own recorder.** Where it cannot run (it is missing, or the mic is
// asked for below macOS 15), a take goes through the browser capture. The default is
// Fetch's own recorder's, and the browser capture is only given sound somebody asked for,
// so a simulator take whose sound was only the default is recorded silent there
// (ui/app.js buildStream reads __sysNativeOnly), and the result says why. An agent that
// passed system_audio true asked in so many words.
//
// **Weight.** One AAC stereo track at 48 kHz, about a megabyte a minute.
//
// **When it is refused.** It cannot be refused on its own. If Screen Recording is off the
// take never starts and screenAccess says which pane to turn it on in. What can still
// happen is the sound capture failing by itself: Recorder.swift opens a second, tiny
// stream (or a tap) for a window take's audio and, if that one will not start or stops
// part way, it writes a line to stderr and lets the take go on rather than losing the
// picture too. A tap that will not start falls back to the stream, once.
// That take lands with video and no track (or a track that goes silent part way), and takeAudio() is what says so in the result instead of leaving
// transcribe to break the news.

// The person's own default for their own takes. Read here only to turn the default off,
// never to turn anything on: an agent take that fell back to the person's preferences is
// how a browser recording once switched on their camera and their microphone. It is a
// default and not a lock, so it is not protection; the never record lists are, and the
// honest result is what makes a silent take visible either way.
const prefSaysNo = prefs => !!prefs && prefs.systemAudio === false

// Under this, a track is there and carries nothing. The floor a take of a silent app
// measures is -91 dB, and an app playing anything at all clears -60 by a wide margin,
// so the gap is not a judgement call.
const SILENT_DB = -60

const TRACK_READERS = 'transcribe, list_beats, the captions and fit_to_length all read ' +
  'that track'

/**
 * What the recorder is asked for. Everything unspecified is off, except system audio on
 * a simulator take.
 *
 * @param {object} args   the tool's own arguments: mic, system_audio, camera
 * @param {object} o
 *   @param {boolean} [o.simulator]  this take is aimed at a device
 *   @param {object}  [o.prefs]      the person's saved preferences, read for a veto only
 * @returns {{systemAudio: boolean, mic: boolean, camera: boolean, simulator: boolean,
 *           asked: 'on'|'off'|'default', vetoed: boolean}}
 */
function audioFor(args = {}, o = {}) {
  const simulator = !!o.simulator
  const asked = args.system_audio === true ? 'on'
    : args.system_audio === false ? 'off' : 'default'
  // Their preference only ever answers a question nobody asked. An agent that named
  // system_audio true asked for sound in so many words, and that outranks a default.
  const vetoed = asked === 'default' && simulator && prefSaysNo(o.prefs)
  const systemAudio = asked === 'on' ? true : asked === 'off' ? false : (simulator && !vetoed)
  return { systemAudio, mic: args.mic === true, camera: args.camera === true,
    simulator, asked, vetoed }
}

/**
 * What record_start may say about sound, which is what was wired and not what landed.
 * The file does not exist yet, so nothing here claims a track: that claim is takeAudio's
 * and it is read off the written file.
 */
// `plan.scope` is the recorder's own word at start (its started event's soundScope, which
// main.js hands the bridge), and where it is there the scope is said as the recorder
// said it rather than as the widest it could be.
function startedAudio(plan = {}) {
  const from = []
  const at = plan.systemAudio ? scopeOf(plan.scope) : null
  if (plan.systemAudio) {
    from.push(at && at.scope === 'device' ? 'the device\'s own sound'
      : at && at.scope === 'app' ? 'the window\'s app\'s sound'
      : plan.simulator ? 'everything this Mac plays, the device among it' : 'everything this Mac plays')
  }
  if (plan.mic) from.push('the microphone')

  const room = plan.mic ? ' The microphone is on as well, so the room is in the file too.' : ''
  let note
  if (plan.systemAudio) {
    note = (plan.simulator && plan.asked === 'default'
      ? 'System audio is on by default for a simulator take, because the sound is the ' +
        'whole reason Fetch records the window rather than the device\'s framebuffer. ' + (at ? startSaid(at, plan) : SCOPE_SAID(true)) +
        ' ' + FALLBACK_SAID
      : 'System audio is on. ' + (at ? startSaid(at, plan) : SCOPE_SAID(plan.simulator))) +
      room + ' record_stop reads the finished file and says whether a track landed.'
  } else if (plan.mic) {
    // A microphone is a track. Saying "no audio track" of a take with the mic on is the
    // lie this file was written to stop, pointed the other way.
    note = `System sound is off, so this take has a microphone track and nothing the ${plan.simulator ? 'device' : 'window'} ` +
      'plays' + (plan.vetoed ? ': the person turned System audio off in Fetch\'s Settings and a simulator take keeps their default' : '') +
      '. record_stop reads the finished file and says whether it landed.'
  } else if (plan.vetoed) {
    note = 'This take has no audio track: the person turned System audio off in Fetch\'s ' +
      `Settings and a simulator take keeps their default. ${TRACK_READERS}. Pass ` +
      'system_audio true if they asked for the sound.'
  } else if (plan.simulator) {
    note = `system_audio is false, so this take has no audio track. ${TRACK_READERS}, ` +
      'and a capture of a device with no sound on it is what every other tool gives you. ' +
      'Leave system_audio out and a simulator take gets a track.'
  } else {
    note = `This take has no audio track: system_audio and mic are both off. ${TRACK_READERS}.`
  }

  return { system_audio: !!plan.systemAudio, mic: !!plan.mic, ...(at ? { scope: at.scope } : {}), ...(from.length ? { from } : {}), note }
}

// The scope the recorder started with, in the present tense of a take under way
function startSaid(s, plan = {}) {
  const what = plan.simulator ? 'device' : 'window'
  if (s.scope === 'mac') {
    return `What reaches the file is everything this Mac plays while the take runs, the ${what} among it, so music, ` +
      `a notification or a call on this Mac is in it too, because ${whySaid(s.why)}.`
  }
  return s.scope === 'device'
    ? 'What reaches the file is only the device\'s own sound: nothing else this Mac plays.'
    : 'What reaches the file is only the window\'s app and the processes it started or answers for: nothing else this Mac plays.'
}

// What reaches the file when system audio is on, in the scope Recorder.swift actually
// has: the display's sound, with no app left out (its start() says why), unless it could
// tap the one app's or device's sound. Said as the widest it can be, since at start
// nothing has said which yet; record_stop says which.
function SCOPE_SAID(simulator) {
  return `What reaches the file is everything this Mac plays while the take runs: the ${simulator ? 'device' : 'window'}, ` +
    'and any other sound on the Mac, music or a call included. ' + TAP_SAID(simulator)
}

function TAP_SAID(simulator) {
  return `Where the person has given Fetch System Audio Recording (macOS 14.4 or later)${simulator ? ' and it is the only simulator booted' : ''}, ` +
    `${simulator ? 'only the device\'s own sound' : 'just the sound of the window\'s app'} is taken instead, and record_stop says which the take got.`
}

const FALLBACK_SAID = 'That default is Fetch\'s own recorder\'s. Where this Mac cannot use it, a take ' +
  'whose sound was only the default is kept silent, because the browser capture is only given sound somebody asked for.'

/**
 * What the finished file actually has, said in the result rather than left for the next
 * tool to discover.
 *
 * @param {object} plan   what audioFor() decided for this take
 * @param {object} meta   probeMeta: { hasAudio, acodec, audioTracks }
 * @param {object} o
 *   @param {number} [o.meanDb]  the track's mean level, where anybody measured it
 */
function takeAudio(plan = {}, meta = {}, o = {}) {
  const tracks = Number(meta.audioTracks || 0)
  const track = meta.hasAudio === true || tracks > 0

  if (!track) {
    // The wiring asked for sound and the file has none. That is a fault on this Mac, not
    // a setting to explain, so it reads as one.
    const note = plan.systemAudio
      ? 'System audio was on for this take and no track reached the file. A window take ' +
        'gets its sound from a second capture of the display, and that one can fail on ' +
        'its own without stopping the picture' +
        (plan.simulator && plan.asked === 'default'
          ? '; or this Mac recorded it without Fetch\'s own recorder, where a take whose sound was only the default is kept silent'
          : '') +
        `. ${TRACK_READERS}, so they have nothing to ` +
        'read. Tell the person the take is silent, or record it again with system_audio true.'
      : plan.simulator
        ? `This take was recorded with system_audio false, so it has no audio track. ${TRACK_READERS}.`
        : `This take has no audio track. ${TRACK_READERS}.`
    return { track: false, note }
  }

  const out = { track: true, tracks: tracks || 1, ...(meta.acodec ? { codec: meta.acodec } : {}) }
  // Whose sound it is, off what the recorder reported rather than what was hoped for
  const scope = plan.systemAudio ? scopeOf(o.sound || o.scope) : null
  if (scope) Object.assign(out, scopeSaid(scope, plan))
  // A track at the floor is its own answer, and without it an agent cannot tell a silent
  // app from broken wiring: both come back from transcribe as no speech. Only said where
  // somebody measured a level, since measuring one costs a pass over the file. floor is
  // a measurement that found nothing over the meter's own gate, which is the same answer.
  const atFloor = o.floor === true ||
    (typeof o.meanDb === 'number' && isFinite(o.meanDb) && o.meanDb <= SILENT_DB)
  if (atFloor) {
    out.level = typeof o.meanDb === 'number' && isFinite(o.meanDb) ? `${o.meanDb.toFixed(1)} dB` : `under ${SILENT_DB} dB`
    out.note = plan.systemAudio && plan.mic
      ? 'There is a track and it is at the noise floor, so neither the microphone nor the ' +
        `${plan.simulator ? 'device' : 'window'} made a sound. transcribe will find no speech. If something was playing, ` +
        'the system sound was wired and came through empty: tell the person, or record it again.'
      : `There is a track and it is at the noise floor, so nothing on screen made ` +
        `a sound. transcribe will find no speech and list_beats will be empty. A device ` +
        `demo's spine comes from a voice: record the person narrating with mic true, or ` +
        `write one with voiceover.`
    return out
  }
  // The microphone and the system sound land as two tracks and are folded into one when
  // the take is committed (processor.js flattenAudio), so a file with a track cannot say
  // on its own whether the system half carried anything. Said, rather than implied.
  if (plan.systemAudio && plan.mic) {
    out.mixed = 'the device and the microphone are one track in this file, so a system sound that failed on its ' +
      'own would still leave a track here. transcribe hears both.'
  }
  return out
}

/**
 * The recorder's word on whose sound a take has, from either the stopped event's
 * `soundScope` or its `sound` array (the system track carries the same fields). null
 * where this build's recorder said nothing, so nothing is claimed.
 */
function scopeOf(sound) {
  if (!sound) return null
  const s = Array.isArray(sound) ? sound.find(t => t && t.track === 'system' && t.scope) : sound
  if (!s || !SCOPES.includes(s.scope)) return null
  return { scope: s.scope, ...(s.why ? { why: String(s.why) } : {}),
    ...(Array.isArray(s.from) && s.from.length ? { from: s.from.map(String) } : {}) }
}
const SCOPES = ['app', 'device', 'mac']

// Why a take got the whole Mac, in words, for each reason Recorder.swift gives
function whySaid(why = '') {
  if (why === 'display') return 'a whole display take hears the whole Mac'
  if (why === 'asked') return 'the whole Mac\'s sound was asked for'
  if (why === 'macos') return 'one app\'s sound needs macOS 14.4 or later'
  if (/^permission/.test(why)) return 'the person has not given Fetch System Audio Recording, which one app\'s sound needs, ' +
    'and a take never asks for it'
  if (why === 'which device') return 'more than one simulator is booted and the take did not say which one\'s sound it was'
  if (why === 'device not booted') return 'that device\'s processes were not found running'
  if (why === 'shared service') return 'more than one simulator is booted, and the audio service they share could carry the other one\'s sound'
  if (why === 'no owner') return 'the window\'s app could not be told'
  if (/^tap failed/.test(why)) return 'the tap of one app\'s sound would not start (' + why.replace(/^tap failed:\s*/, '') + ')'
  return why ? `the recorder said: ${why}` : 'the recorder gave no reason'
}

function scopeSaid(s, plan = {}) {
  const what = plan.simulator ? 'device' : 'window'
  if (s.scope === 'mac') {
    return { scope: 'mac', heard: `everything this Mac played while the take ran, the ${what} among it, so music, ` +
      `a notification or a call on this Mac is in the file too, because ${whySaid(s.why)}.` }
  }
  const from = s.from ? ` (${s.from.slice(0, 6).join(', ')}${s.from.length > 6 ? ', and more' : ''})` : ''
  return { scope: s.scope, heard: s.scope === 'device'
    ? `only the device's own sound${from}: nothing else this Mac played is in the file.`
    : `only the window's app and the processes it started or answers for${from}: nothing else this Mac played is in the file.` }
}

// ── the sentences the tool descriptions are made of ──────────────────────
// Here rather than typed into mcp/index.js and ui/agent-bridge.js, because three copies
// of this claim drifted from the code once already. A description that reads a constant
// cannot promise a track the default does not wire.
// Two sentences here used to be false. "On by default" left out the person's own switch,
// which audioFor() obeys: with System audio off in their Settings, an agent that read this
// and passed nothing got a silent take. And "system_audio false records it silent" is not
// so with mic true, which still lands a track.
const SIM_AUDIO_SAID =
  'System audio is on by default for a simulator take, unless the person turned System ' +
  'audio off in Fetch\'s Settings: the sound is what a capture of ' +
  'the device framebuffer has no track for at all, and it is what the transcript, the ' +
  'beats and the captions are built from. What reaches the file is everything this Mac ' +
  'plays while the take runs, the device among it, so music or a call on this Mac is in ' +
  'it too. ' + TAP_SAID(true) + ' Where Fetch\'s own recorder cannot run, a take whose sound was only the ' +
  'default is kept silent. Pass system_audio false to leave the device\'s sound out (the ' +
  'microphone is still recorded if mic is true). What actually ' +
  'landed is on the result, not here.'

const SYS_AUDIO_ARG_SAID =
  'Include what this Mac plays while it records. Default off, and on for a simulator take ' +
  'unless the person turned System audio off in Fetch\'s Settings.'

// Both say the person's own switch as well: audioFor() keeps a simulator take silent by
// default when they turned System audio off, and a sentence that left it out promised a
// track the take did not get.
const SIM_LIST_SAID =
  'the take carries the device\'s sound by default (unless the person turned System audio off in ' +
  'Fetch\'s Settings), where a capture of the device framebuffer has no audio track at all'

const READY_NEXT_SAID = 'records that window, with system audio on by default unless the person turned it off in Fetch\'s Settings'

module.exports = { audioFor, startedAudio, takeAudio, scopeOf, SILENT_DB,
  SIM_AUDIO_SAID, SYS_AUDIO_ARG_SAID, SIM_LIST_SAID, READY_NEXT_SAID }
