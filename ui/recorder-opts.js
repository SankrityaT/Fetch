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
// **Nothing is asked of the person.** System audio rides the Screen Recording grant the
// take already cannot start without (ui/record-policy.js, screenAccess); macOS 15 calls
// that pane Screen and System Audio Recording for exactly this reason. No second dialog,
// no second pane, no microphone permission. The microphone is the one that needs its own
// grant and its own asking, and it stays off unless the agent asks for it: the room is
// never in a take nobody asked to be in.
//
// **Other apps' windows are not in the file, and that is all the exclusion is.**
// Recorder.swift takes a window take's audio from the display with every other
// application excluded by process id, and the list is built once, at start, from apps
// that own windows. Measured on this Mac: while the person's own browser played a video
// out of the speakers, a window take of a different window came back at -91.0 dB mean
// and peak, which is digital silence. What the list cannot hold is an app opened after
// the take began (a call answered mid take) or a process with no window at all, and
// both are in the file. The sentences below say that scope and no wider one.
//
// **What does reach it is a process with no window.** The same measurement caught a
// windowless host audio process at -22.7 dB and transcribed it word perfect. That is not
// a leak, it is the mechanism: a simulator's guest app renders through CoreSimulator's
// own host audio process, which has no window and so cannot be excluded by one. The cost
// to state plainly is that a second booted simulator, or any background process making a
// sound with no window of its own, is in the file too.
//
// **Only on Fetch's own recorder.** Where it cannot run (it is missing, or the mic is
// asked for below macOS 15), a take goes through the browser capture, whose system
// audio is the whole Mac's output: the person's call, music and meeting. A default
// nobody asked for never goes there. On that path a simulator take whose sound was only
// the default is recorded silent (ui/app.js buildStream reads __sysNativeOnly), and the
// result says why. An agent that passed system_audio true asked in so many words.
//
// **Weight.** One AAC stereo track at 48 kHz, about a megabyte a minute.
//
// **When it is refused.** It cannot be refused on its own. If Screen Recording is off the
// take never starts and screenAccess says which pane to turn it on in. What can still
// happen is the sound capture failing by itself: Recorder.swift opens a second, tiny
// stream for a window take's audio and, if that one will not start, it writes a line to
// stderr and lets the take go on rather than losing the picture too. That take lands with
// video and no track, and takeAudio() is what says so in the result instead of leaving
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
function startedAudio(plan = {}) {
  const from = []
  if (plan.systemAudio) {
    from.push(plan.simulator ? 'the device, through the window it sits in' : 'the window being recorded')
  }
  if (plan.mic) from.push('the microphone')

  const room = plan.mic ? ' The microphone is on as well, so the room is in the file too.' : ''
  let note
  if (plan.systemAudio) {
    note = (plan.simulator && plan.asked === 'default'
      ? 'System audio is on by default for a simulator take, because the sound is the ' +
        'whole reason Fetch records the window rather than the device\'s framebuffer. ' + SCOPE_SAID(true) +
        ' ' + FALLBACK_SAID
      : 'System audio is on. ' + SCOPE_SAID(plan.simulator)) +
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

  return { system_audio: !!plan.systemAudio, mic: !!plan.mic, ...(from.length ? { from } : {}), note }
}

// What reaches the file when system audio is on, in the scope Recorder.swift actually
// has: its exclusion is a list of apps with windows, taken once at the start.
function SCOPE_SAID(simulator) {
  return `What reaches the file is the sound of the ${simulator ? 'device' : 'window being recorded'}, and also any ` +
    'process with no window of its own (another booted simulator is one) and any app opened after the take ' +
    'started. Apps whose windows were open when it started are left out.'
}

const FALLBACK_SAID = 'That is on Fetch\'s own recorder. Where this Mac cannot use it, the take is ' +
  'kept silent rather than record everything the Mac plays.'

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
          ? '; or this Mac recorded it without Fetch\'s own recorder, where a default simulator take is kept silent rather than record everything the Mac plays'
          : '') +
        `. ${TRACK_READERS}, so they have nothing to ` +
        'read. Tell the person the take is silent, or record it again with system_audio true.'
      : plan.simulator
        ? `This take was recorded with system_audio false, so it has no audio track. ${TRACK_READERS}.`
        : `This take has no audio track. ${TRACK_READERS}.`
    return { track: false, note }
  }

  const out = { track: true, tracks: tracks || 1, ...(meta.acodec ? { codec: meta.acodec } : {}) }
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

// ── the sentences the tool descriptions are made of ──────────────────────
// Here rather than typed into mcp/index.js and ui/agent-bridge.js, because three copies
// of this claim drifted from the code once already. A description that reads a constant
// cannot promise a track the default does not wire.
const SIM_AUDIO_SAID =
  'System audio is on by default for a simulator take: the sound is what a capture of ' +
  'the device framebuffer has no track for at all, and it is what the transcript, the ' +
  'beats and the captions are built from. What reaches the file is the device\'s sound ' +
  'and any sound from a process with no window of its own, another booted simulator ' +
  'among them, and from any app opened after the take started; apps whose windows were ' +
  'open at the start are left out. Where Fetch\'s own recorder cannot run, a default ' +
  'take is kept silent rather than record everything the Mac plays. Pass system_audio ' +
  'false to record it silent. What actually landed is on the result, not here.'

const SYS_AUDIO_ARG_SAID =
  'Include the sound of what is being recorded. Default off, and on for a simulator take.'

const SIM_LIST_SAID =
  'the take carries the device\'s sound by default, where a capture of the device ' +
  'framebuffer has no audio track at all'

const READY_NEXT_SAID = 'records that window, with system audio on by default'

module.exports = { audioFor, startedAudio, takeAudio, SILENT_DB,
  SIM_AUDIO_SAID, SYS_AUDIO_ARG_SAID, SIM_LIST_SAID, READY_NEXT_SAID }
