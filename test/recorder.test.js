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

// ── sound on the picture's clock ─────────────────────────────────────────
// A simulator take's sound started 2.3 s after its picture. The file was honest about
// it through an edit list, and every ffmpeg graph that trims the track or decodes it to
// a wav put the first sample at zero, so the export, the transcript and the waveform
// all had the sound 2.3 s early. The writer also dropped audio while a still window
// held its interleave, and AAC packs what is left, so every take drifted early by
// 20 ms at a time. These pin the fix in the source, then measure it in a written file.
console.log('\nsound on the picture\'s clock')
is('a window take opens its sound before its picture',
  rec.indexOf('if let sf = soundFilter { await openSoundStream(sf) }') < rec.indexOf('stream = try await openStream(filter)'), true)
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
