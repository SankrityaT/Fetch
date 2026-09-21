// Time in an edit (ui/timeline.js): kept ranges, the output clock, the speed each
// surviving piece runs at, and the way back. The document's own face on that clock
// (ui/fetchdoc.js, clips[].rate) and the filters it becomes (processor.js) are here
// too, because all three have to say the same thing about one second of a take.
const T = require('../ui/timeline')
const FD = require('../ui/fetchdoc')
const proc = require('../processor')

let pass = 0, fail = 0
const is = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}` +
    (ok ? '' : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`))
}
const r3 = n => Math.round(n * 1000) / 1000

console.log('kept ranges')
is('no cuts keeps the trim', T.keepRanges([], 1, 9), [[1, 9]])
is('a cut splits it', T.keepRanges([[3, 4]], 0, 10), [[0, 3], [4, 10]])
is('overlapping cuts merge', T.keepRanges([[3, 5], [4, 6]], 0, 10), [[0, 3], [6, 10]])
is('a cut past the trim is clipped', T.keepRanges([[8, 20]], 0, 10), [[0, 8]])
is('a sliver under 50 ms between cuts is dropped', T.keepRanges([[2, 4], [4.03, 6]], 0, 10), [[0, 2], [6, 10]])
is('a cut under 20 ms is ignored', T.keepRanges([[5, 5.01]], 0, 10), [[0, 10]])

console.log('the output clock')
{
  const clock = T.outClock([[3, 5]], 1, 9)
  is('trim start is output zero', clock(1), 0)
  is('before a cut runs straight', clock(2.5), 1.5)
  is('inside a cut lands where it closed', clock(4), 2)
  is('after a cut the cut is taken out', clock(6), 3)
  is('kept says whether a moment survives', [clock.kept(4), clock.kept(6)], [false, true])
  // the round trip, on every kept moment
  const keep = clock.keep
  const bad = []
  for (let t = 1; t <= 9; t += 0.137) if (clock.kept(t) && Math.abs(T.srcTime(keep, clock(t)) - t) > 1e-9) bad.push(r3(t))
  is('srcTime(clock(t)) is t on kept ranges', bad, [])
  is('past the end holds the last moment', T.srcTime(keep, 100), 9)
  is('the output is as long as what is kept', T.outLength(keep), 6)
}

console.log('speed')
{
  // A document that never asked for speed is the document it was: bare pairs, and
  // every number the same as before. This is the whole compatibility claim.
  is('no rates, no third element', T.outClock([[3, 5]], 1, 9, null).keep, [[1, 3], [5, 9]])
  is('rate 1 is written as nothing', T.applyRates([[0, 10]], [[0, 10, 1, 1]]), [[0, 10]])

  // held at a rate
  const fast = T.outClock([], 0, 20, [[0, 20, 4, 4]])
  is('a 4x take is a quarter as long', T.outLength(fast.keep), 5)
  is('and lands four source seconds an output second', [fast(4), fast(20)], [1, 5])
  is('back again', [T.srcTime(fast.keep, 1), T.srcTime(fast.keep, 5)], [4, 20])
  const slow = T.outClock([], 0, 4, [[0, 4, 0.5, 0.5]])
  is('half speed is twice as long', T.outLength(slow.keep), 8)

  // a ramp: the mean rate is what its length is made of, and the inverse is exact
  const ramp = T.outClock([], 0, 10, [[0, 10, 1, 4]])
  is('a 1x to 4x ramp runs at its mean', r3(T.outLength(ramp.keep)), 4)
  is('it starts at 1 and ends at 4', [r3(T.rateAt(ramp.keep, 0)), r3(T.rateAt(ramp.keep, 4))], [1, 4])
  is('and the rate is linear in output seconds', r3(T.rateAt(ramp.keep, 2)), 2.5)

  // the round trip, which is the rule the whole clock exists to keep, across a cut,
  // a slow piece, a held fast piece and a ramp all in one document
  const mixed = T.outClock([[6, 9]], 0, 24,
    [[0, 6, 0.5, 0.5], [9, 15, 1, 1], [15, 20, 4, 4], [20, 24, 1, 6]])
  const bad = []
  for (let t = 0; t <= 24; t += 0.0137) {
    if (mixed.kept(t) && Math.abs(T.srcTime(mixed.keep, mixed(t)) - t) > 1e-9) bad.push(r3(t))
  }
  is('srcTime(clock(t)) is t through every rate', bad, [])
  const bad2 = []
  const span = T.outLength(mixed.keep)
  for (let u = 0; u <= span; u += 0.0071) {
    const back = mixed(T.srcTime(mixed.keep, u))
    if (Math.abs(back - u) > 1e-9) bad2.push(r3(u))
  }
  is('and clock(srcTime(u)) is u the other way', bad2, [])
  is('the output is as long as the pieces say',
    r3(span), r3(12 + 6 + 5 / 4 + 2 * 4 / 7))
  is('and a rate change inside one kept range splits it',
    mixed.keep.map(k => [k[0], k[1]]), [[0, 6], [9, 15], [15, 20], [20, 24]])

  // two clips meeting with no gap: no cut at all, and the second clip's speed still
  // has to survive, which is the case a whole-range rate would quietly lose
  const abut = T.outClock([], 0, 12, [[0, 6, 1, 1], [6, 12, 4, 4]])
  is('abutting clips at different speeds are two ranges', abut.keep, [[0, 6], [6, 12, 4]])
  is('and the second one is a quarter as long', T.outLength(abut.keep), 7.5)

  // a cut landing inside a ramp: the piece that survives is still a ramp, and it is
  // the same map restricted, not a fresh one from the same two end rates
  const whole = T.outClock([], 0, 10, [[0, 10, 1, 4]])
  const half = T.outClock([[0, 5]], 0, 10, [[0, 10, 1, 4]])
  is('a sliced ramp keeps the rates it really had',
    [r3(half.keep[0][2]), r3(half.keep[0][3])], [r3(whole.rate(5)), 4])
  is('and the piece is as long as it was inside the whole',
    r3(T.outLength(half.keep)), r3(whole(10) - whole(5)))

  // sample and hold through speed: an output frame still holds the last source frame
  // at or before its own moment, which is what keeps a still screen still
  const frames = Array.from({ length: 241 }, (_, i) => i / 24)
  const k4 = T.outClock([], 0, 10, [[0, 10, 4, 4]]).keep
  is('a 4x section steps four source frames an output frame at 24 fps',
    [0, 1, 2, 3].map(n => r3(T.frameAt(k4, 24, n, frames))), [0, r3(4 / 24), r3(8 / 24), r3(12 / 24)])
  is('and never invents a frame the take does not have',
    [0, 7, 23, 60].every(n => frames.includes(T.frameAt(k4, 24, n, frames))), true)

  // a rate is clamped by the document, not here, but nonsense must not make NaN
  is('a zero rate is read as no rate', T.outLength(T.applyRates([[0, 4]], [[0, 4, 0, 0]])), 4)
}

console.log('frames')
{
  is('60 fps for a 60 fps take, 30 below 45', [T.outFps({ fps: 59.94 }), T.outFps({ fps: 30 }), T.outFps({})], [60, 30, 30])
  // A ScreenCaptureKit take has no one rate: it writes a frame when the screen changes,
  // so the average ffmpeg reports is the refresh less every still passage. The rate is
  // read off the take's own frame times instead (see .context/survey/m5-timing.md).
  const pts = (n, step, holes = []) => {
    const out = []
    for (let i = 0, t = 0; i < n; i++, t += step) if (!holes.some(([a, b]) => i >= a && i < b)) out.push(+t.toFixed(6))
    return out
  }
  is('a clean 60 fps take reads 60', Math.round(T.takeFps(pts(200, 1 / 60))), 60)
  is('a clean 30 fps take reads 30', Math.round(T.takeFps(pts(200, 1 / 30))), 30)
  // 3 s of 60 Hz screen and two long stills: the average is 26, the cadence is 60
  const still = pts(600, 1 / 60, [[100, 340], [400, 520]])
  is('a 60 Hz take that stands still for half of it still reads 60', Math.round(T.takeFps(still)), 60)
  is('...where its own average would say 30',
    T.outFps({ fps: (still.length - 1) / (still[still.length - 1] - still[0]) }), 30)
  is('...and the cadence takes it to 60', T.outFps({ fps: 26, cadence: 60 }), 60)
  // and it cannot be talked up: a take that really does deliver every other frame is 30
  is('a take that delivers every other 60 Hz frame reads 30',
    Math.round(T.takeFps(pts(400, 1 / 60).filter((_, i) => i % 2 === 0 || i % 17 === 0))), 30)
  is('too few frames to say is no answer at all', [T.takeFps([]), T.takeFps(pts(10, 1 / 60))], [0, 0])
  // a native take writes a frame only when the screen changes: sample and hold
  const frames = [0, 0.5, 0.52, 2.0, 2.4]
  const keep = [[0, 3]]
  is('output frames hold the last source frame', [0, 15, 16, 59, 60, 72].map(n => T.frameAt(keep, 30, n, frames)), [0, 0.5, 0.52, 0.52, 2, 2.4])
  is('across a cut the frame comes from after it', T.frameAt([[0, 1], [2, 3]], 30, 45, frames), 2.4)
}

console.log('speed, from the document to the graph')
{
  const doc = FD.normalize({ v: 2, src: '/x.mov', dur: 24, clips: [
    { id: 'C1', start: 0, end: 8 },
    { id: 'C2', start: 9, end: 17, rate: 4 },
    { id: 'C3', start: 17, end: 24, rate: [1, 3] },
  ] }, '/x.mov', 24)
  is('the finished video is as long as the clips at their own speeds',
    r3(FD.outDuration(doc)), r3(8 + 2 + 7 * 2 / 4))
  const opts = FD.toExportOpts(doc)
  is('the cuts are the gaps and the rates come beside them',
    [opts.cuts, opts.rates], [[[8, 9]], [[9, 17, 4, 4], [17, 24, 1, 3]]])
  is('and the sound of a sped-up piece is muted unless asked otherwise', opts.speedAudio, 'mute')

  // a document that never asked for speed carries none, which is the whole
  // compatibility promise
  const plain = FD.normalize({ v: 2, src: '/x.mov', dur: 10, clips: [{ id: 'C1', start: 0, end: 4 }, { id: 'C2', start: 6, end: 10 }] }, '/x.mov', 10)
  is('no rate, no rates', FD.toExportOpts(plain).rates, null)
  is('and a rate of 1 is not a rate', FD.normalize({ v: 2, src: '/x.mov', dur: 4, clips: [{ id: 'C1', start: 0, end: 4, rate: 1 }] }, '/x.mov', 4).clips[0], { id: 'C1', start: 0, end: 4 })
  is('a rate out of range is pulled back into it',
    [FD.cleanRate(500), FD.cleanRate(0.001), FD.cleanRate('nonsense')], [[20, 20], [0.1, 0.1], null])

  // the filters, which is where the clock stops being arithmetic
  is('a piece at its own rate is the plain reset it always was', proc.ratePts([0, 8]), 'setpts=PTS-STARTPTS')
  is('a held rate is one division', proc.ratePts([0, 8, 2, 2]), 'setpts=(PTS-STARTPTS)/2.000000')
  is('a ramp is the quadratic inverse, read off the range it belongs to',
    /^setpts='\(sqrt\(.+\*\(T-STARTT\)\).+\/TB'$/.test(proc.ratePts([0, 8, 1, 4])), true)
  is('atempo is chained past double and half',
    [proc.atempoChain(4), proc.atempoChain(0.25), proc.atempoChain(1)],
    [['atempo=2', 'atempo=2'], ['atempo=0.5', 'atempo=0.5'], []])
  // every piece is pinned to its own output length rather than trusted to come out
  // right, so what atempo's resampling loses is one piece's rounding and never a
  // drift that grows to the end of the video
  is('a sped-up piece is pinned to exactly the picture it goes with',
    proc.rateAudio([0, 8, 4, 4]).filter(f => /^(apad|atrim)/.test(f)), ['apad=whole_dur=2', 'atrim=end=2'])
  is('and it is muted by default', proc.rateAudio([0, 8, 4, 4], { mute: true }).slice(-1), ['volume=0'])
  const ak = proc.audioKeep([[0, 8], [8, 16, 1, 4], [16, 24, 2]], 'mute')
  is('a ramp is cut into pieces one atempo can cover', ak.length > 3, true)
  is('the sound is as long as the picture to the microsecond',
    r3(ak.reduce((n, { seg }) => n + T.outSpan(seg), 0)),
    r3(T.outLength([[0, 8], [8, 16, 1, 4], [16, 24, 2]])))
  is('a piece at 1 is neither retimed nor muted', [ak[0].mute, proc.rateAudio(ak[0].seg)], [false, []])
  is('a slow piece keeps its sound', proc.audioKeep([[0, 8, 0.5, 0.5]], 'mute')[0].mute, false)
  is('and keep means keep', proc.audioKeep([[0, 8, 4, 4]], 'keep')[0].mute, false)
}

console.log('the camera take')
{
  const cam = { camStartedAt: 1000, screenStartedAt: 1500, gaps: [[4000, 6000]] }
  is('the camera started first, so it runs ahead by the skew', T.camTime(cam, 1), 1.5)
  is('a pause the screen left out is skipped on the camera', T.camTime(cam, 4), 6.5)
  is('a camera that started late has nothing yet', T.camTime({ camStartedAt: 3000, screenStartedAt: 1000 }, 1), null)
  is('no camera, no time', T.camTime(null, 1), null)
}

console.log('a clip with sound of its own')
{
  // splitAt is the knife per-clip sound needs and rates did not: two clips meeting
  // with no gap leave no cut, so the run comes back as one range.
  is('a boundary inside a range splits it', T.splitAt([[0, 10]], [4]), [[0, 4], [4, 10]])
  is('a boundary on an end changes nothing', T.splitAt([[0, 10]], [0, 10]), [[0, 10]])
  is('a boundary in a gap changes nothing', T.splitAt([[0, 4], [6, 10]], [5]), [[0, 4], [6, 10]])
  is('and the pieces are as long as what they came from',
    r3(T.outLength(T.splitAt([[0, 6, 1, 3]], [2, 5]))), r3(T.outLength([[0, 6, 1, 3]])))
  {
    // a ramp cut this way is the parent's own map restricted, exactly as a cut leaves it
    const whole = [[0, 10, 1, 4]]
    const parts = T.splitAt(whole, [5])
    is('a split ramp keeps the rates it really had',
      [r3(parts[0][3]), r3(parts[1][2])], [r3(T.rateAt(whole, T.outIn(whole[0], 5))), r3(T.rateAt(whole, T.outIn(whole[0], 5)))])
  }

  // the take's settings are what a clip that asked for nothing falls back to
  const take = { gain: 2, denoise: false }
  const spans = [[0, 4, { gain: 6 }], [4, 10, { denoise: true }]]
  const ak = proc.audioKeep([[0, 10]], 'mute', { spans, ...take })
  is('abutting clips with their own sound are separate pieces', ak.map(({ seg }) => seg), [[0, 4], [4, 10]])
  // A piece carries its clip's level as a difference from the take's, not the whole of
  // it: the take's own gain sits after loudnorm and stays there, and a piece runs before
  // loudnorm, so applying the whole of it here let loudnorm measure the lifted sound and
  // take the take's lift straight back out. +6 over a take at +2 is +4 on the piece, and
  // a clip that asked for nothing is bare.
  is('each piece carries its clip\'s level as a difference from the take\'s',
    ak.map(p => [p.gain, p.denoise]), [[4, false], [0, true]])
  is('and the level is written on the piece, not over the whole take',
    proc.rateAudio(ak[0].seg, ak[0]), ['volume=4dB'])
  // and the take's own gain is still where it was, after loudnorm, so setting one clip's
  // level cannot cancel it
  is('the take\'s own gain stays after loudnorm when a clip asks for its own sound',
    proc.audioGraph({ hasAudio: true, loudnorm: true, ...proc.takeAudioLeft({ gain: 2, denoise: true }, { spans }) }).af,
    ['loudnorm=I=-14:TP=-1:LRA=11', 'volume=2dB'])
  // A level that is not the level of the piece before it arrives as a ramp rather than a
  // step, because the step is the click a person hears at an otherwise clean join. Both
  // sides of the ramp are the same audio, so it is the level moving and not two moments
  // mixed. Measured on a steady tone through renderAudio, the join comes out the same
  // size step as the material either side of it (0.0275 against 0.0275, where the switch
  // gave 0.135 against 0.0103).
  const ramped = proc.clipAudioParts(proc.audioKeep([[0, 10]], 'mute', { spans, ...take }))
  is('a clip whose level is not its neighbour\'s ramps into it rather than switching',
    [ramped.some(x => /afade=t=out:st=0:d=0.02:curve=tri/.test(x)), ramped.some(x => /amix=inputs=2:normalize=0/.test(x))],
    [true, true])
  is('and an edit with no per-clip sound is one trim and one chain a piece, as it was',
    proc.clipAudioParts(proc.audioKeep([[0, 4], [6, 10]], 'mute')).length, 2)
  is('denoise goes before the retime, on the take\'s own timescale',
    proc.rateAudio([0, 4, 2, 2], { denoise: true, gain: 3 })[0], 'afftdn=nr=12:nf=-25:tn=1')
  is('a clip can drop its own sound outright',
    proc.audioKeep([[0, 10]], 'mute', { spans: [[4, 10, { mute: true }]], gain: 0, denoise: false })
      .map(p => p.mute), [false, true])

  // the speed question: a gain inside a slowed region rides the same piece the rate
  // does, after the pinning, so the level lands on sound that is already the length
  // of the picture it goes with
  const slow = proc.audioKeep([[0, 4, 0.5, 0.5]], 'mute', { spans: [[0, 4, { gain: 5 }]], gain: 0, denoise: false })
  is('a slowed clip is one piece and keeps its sound', [slow.length, slow[0].mute, slow[0].gain], [1, false, 5])
  is('and its level comes after the length is pinned',
    proc.rateAudio(slow[0].seg, slow[0]),
    ['atempo=0.5', 'apad=whole_dur=8', 'atrim=end=8', 'asetpts=PTS-STARTPTS', 'volume=5dB'])
  // a ramp is a staircase of pieces, and every step of one clip carries the same level
  const ramp = proc.audioKeep([[0, 8, 1, 3]], 'keep', { spans: [[0, 8, { gain: -4 }]], gain: 0, denoise: false })
  is('every step of a ramped clip is at the one level', [...new Set(ramp.map(p => p.gain))], [-4])
  is('and the sound is still as long as the picture',
    r3(ramp.reduce((n, { seg }) => n + T.outSpan(seg), 0)), r3(T.outLength([[0, 8, 1, 3]])))
  // a piece sped up past 1 is muted before its own gain can matter, as it always was
  const fast = proc.audioKeep([[0, 8, 4, 4]], 'mute', { spans: [[0, 8, { gain: 8 }]], gain: 0, denoise: false })
  is('a sped-up clip is still muted, level or no level', fast[0].mute, true)
}

console.log('the sound an older document makes, byte for byte')
{
  // The compatibility claim, not asserted but compared: these are the filter chains
  // the committed code built for the same four documents, read out of it with
  // processor.audioKeep, rateAudio and audioGraph and pasted here. A document written
  // before per-clip sound existed carries no clipAudio, so audioKeep splits nothing
  // and the take's own chain does the work: the strings have to match character for
  // character, and any change to the sound of an old edit breaks this.
  const soundOf = (doc, extra = null) => {
    const opts = FD.toExportOpts(doc), spec = FD.toRenderSpec(doc)
    const keep = spec.keep, span = spec.length
    const hasCuts = (opts.cuts || []).some(c => Array.isArray(c) && c.length === 2) || !!(opts.rates && opts.rates.length)
    const perClip = Array.isArray(opts.clipAudio) && opts.clipAudio.length
      ? { spans: opts.clipAudio, gain: opts.gain, denoise: opts.denoise } : null
    const parts = []
    const ak = proc.audioKeep(keep, opts.speedAudio, perClip)
    ak.forEach(({ seg, ...own }, i) => {
      parts.push(`[0:a]atrim=${seg[0].toFixed(6)}:${seg[1].toFixed(6)},` +
        ['asetpts=PTS-STARTPTS', ...proc.rateAudio(seg, own)].join(',') + `[ca${i}]`)
    })
    parts.push(ak.map((_, i) => `[ca${i}]`).join('') + `concat=n=${ak.length}:v=0:a=1[cuta]`)
    const level = perClip ? { gain: 0, denoise: false } : { gain: opts.gain, denoise: opts.denoise }
    const { af, extraGraph, extraMap } = proc.audioGraph({
      hasAudio: true, loudnorm: opts.loudnorm, ...level,
      fadeIn: +opts.fadeIn > 0 ? +opts.fadeIn : 0, fadeOut: +opts.fadeOut > 0 ? +opts.fadeOut : 0,
      span, extra, extraInput: 1, keep: hasCuts ? keep : null, base: '[cuta]',
    })
    if (extraGraph) { parts.push(extraGraph); return parts.join(';') + ' => ' + extraMap }
    parts.push(`[cuta]${af.length ? af.join(',') : 'anull'}[aout]`)
    return parts.join(';') + ' => [aout]'
  }
  const N = (d, dur) => FD.normalize(d, '/x.mov', dur)

  is('a whole take, untouched',
    soundOf(N({ v: 2, clips: [{ id: 'C1', start: 0, end: 10 }] }, 10)),
    '[0:a]atrim=0.000000:10.000000,asetpts=PTS-STARTPTS[ca0];[ca0]concat=n=1:v=0:a=1[cuta];' +
    '[cuta]loudnorm=I=-14:TP=-1:LRA=11[aout] => [aout]')
  is('a cut, with the take\'s denoise and gain over the whole of it',
    soundOf(N({ v: 2, audio: { denoise: true, gain: 4 }, clips: [{ id: 'C1', start: 1, end: 4 }, { id: 'C2', start: 7, end: 12 }] }, 12)),
    '[0:a]atrim=1.000000:4.000000,asetpts=PTS-STARTPTS[ca0];[0:a]atrim=7.000000:12.000000,asetpts=PTS-STARTPTS[ca1];' +
    '[ca0][ca1]concat=n=2:v=0:a=1[cuta];[cuta]afftdn=nr=12:nf=-25:tn=1,highpass=f=70,loudnorm=I=-14:TP=-1:LRA=11,volume=4dB[aout] => [aout]')
  is('a clip held at 4x, muted and pinned',
    soundOf(N({ v: 2, clips: [{ id: 'C1', start: 0, end: 4 }, { id: 'C2', start: 4, end: 12, rate: 4 }] }, 12)),
    '[0:a]atrim=0.000000:4.000000,asetpts=PTS-STARTPTS[ca0];[0:a]atrim=4.000000:12.000000,asetpts=PTS-STARTPTS,' +
    'atempo=2,atempo=2,apad=whole_dur=2,atrim=end=2,asetpts=PTS-STARTPTS,volume=0[ca1];' +
    '[ca0][ca1]concat=n=2:v=0:a=1[cuta];[cuta]loudnorm=I=-14:TP=-1:LRA=11[aout] => [aout]')
  is('an added track under a cut, mixed and limited',
    soundOf(N({ v: 2, audioTrack: { file: '/m.m4a', volume: 0.4, offset: 1 }, clips: [{ id: 'C1', start: 0, end: 5 }, { id: 'C2', start: 6, end: 12 }] }, 12),
      { file: '/m.m4a', volume: 0.4, offset: 1 }),
    '[0:a]atrim=0.000000:5.000000,asetpts=PTS-STARTPTS[ca0];[0:a]atrim=6.000000:12.000000,asetpts=PTS-STARTPTS[ca1];' +
    '[ca0][ca1]concat=n=2:v=0:a=1[cuta];[1:a]atrim=start=0,asetpts=PTS-STARTPTS,adelay=1000|1000,volume=0.40[extraRaw];' +
    '[extraRaw]asplit=2[extraSplit0][extraSplit1];[extraSplit0]atrim=0.000000:5.000000,asetpts=PTS-STARTPTS[extraCut0];' +
    '[extraSplit1]atrim=6.000000:12.000000,asetpts=PTS-STARTPTS[extraCut1];[extraCut0][extraCut1]concat=n=2:v=0:a=1[extra];' +
    '[cuta]loudnorm=I=-14:TP=-1:LRA=11[base];[base][extra]amix=inputs=2:duration=first:dropout_transition=0,alimiter=limit=0.95:latency=1[amixed] => [amixed]')

  // and one clip asking for its own level is the only thing that moves the chain
  const lifted = soundOf(N({ v: 2, audio: { loudnorm: false }, clips: [{ id: 'C1', start: 0, end: 5 }, { id: 'C2', start: 5, end: 12, audio: { gain: 6 } }] }, 12))
  is('per-clip sound writes the level onto the piece and leaves the take\'s chain empty',
    lifted,
    '[0:a]atrim=0.000000:5.000000,asetpts=PTS-STARTPTS[ca0];[0:a]atrim=5.000000:12.000000,asetpts=PTS-STARTPTS,volume=6dB[ca1];' +
    '[ca0][ca1]concat=n=2:v=0:a=1[cuta];[cuta]anull[aout] => [aout]')
}

// ---- and the same thing, rendered and measured -------------------------
// Everything above is strings. This renders two seconds of a take whose second half
// was recorded 20 dB down, once as it is and once with the quiet clip lifted, and
// measures both: the graph is only right if the level really moves, and only on the
// clip that asked. Skipped where there is no ffmpeg to render with.
async function rendered() {
  const fs = require('fs'), os = require('os'), path = require('path'), { execFileSync } = require('child_process')
  const dir = path.join(os.tmpdir(), `fetch-t4-${process.pid}`)
  const src = path.join(dir, 'take.mp4')
  console.log('rendered, and measured')
  try {
    fs.mkdirSync(dir, { recursive: true })
    // a tone at full level for three seconds, then the same tone 20 dB down
    execFileSync(proc.FFMPEG, ['-hide_banner', '-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=s=160x120:r=10:d=6',
      '-f', 'lavfi', '-i', "aevalsrc='0.5*sin(440*2*PI*t)*if(lt(t,3),1,0.1)':d=6:s=48000",
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src])
  } catch (e) {
    console.log(`  skip ffmpeg could not build the fixture (${String(e.message).split('\n')[0]})`)
    return
  }
  try {
    const meta = await proc.probeMeta(src)
    // loudnorm off, so what is measured is the clips and not the normaliser
    const base = { v: 2, src, dur: 6, audio: { loudnorm: false },
      clips: [{ id: 'C1', start: 0, end: 3 }, { id: 'C2', start: 3, end: 6 }] }
    const halves = [{ start: 0, end: 3 }, { start: 3, end: 6 }]
    const render = async (doc, name) => {
      const d = FD.normalize(doc, src, 6)
      const spec = FD.toRenderSpec(d)
      const out = path.join(dir, name)
      await proc.renderAudio(src, FD.toExportOpts(d), spec.keep, spec.length, meta, out, null)
      return proc.clipLevels(out, halves)
    }
    const flat = await render(base, 'flat.m4a')
    const gap = l => +(l.clips[0].lufs - l.clips[1].lufs).toFixed(1)
    is('the take really is recorded with its second half 20 dB down', Math.abs(gap(flat) - 20) < 1.5, true)
    is('and the two clips abut, so nothing but per-clip sound could tell them apart',
      FD.toExportOpts(FD.normalize(base, src, 6)).cuts, [])
    is('the quiet one is named as quiet, with the gain that would fix it',
      [flat.clips[1].quiet, flat.clips[1].gain > 5], [true, true])
    is('and the loud one is not', flat.clips[0].quiet, false)

    const lift = await render({ ...base, clips: [base.clips[0], { ...base.clips[1], audio: { gain: 10 } }] }, 'lift.m4a')
    is('lifting C2 by ten closes ten of the twenty', Math.abs(gap(flat) - gap(lift) - 10) < 1.5, true)
    is('and C1, which asked for nothing, is where it was',
      Math.abs(flat.clips[0].lufs - lift.clips[0].lufs) < 0.5, true)

    // the same document as it was before this round: same file, same measurement
    const again = await render(base, 'flat2.m4a')
    is('a document that asks for nothing renders the same sound twice',
      again.clips.map(c => c.lufs), flat.clips.map(c => c.lufs))

    // A clip's sound must not reach the picture. It puts the export on the trim and
    // concat graph a cut uses, so this is worth proving rather than reasoning about:
    // the same frame of the same edit, with and without a level on C2.
    const frame = async doc => {
      const shot = await proc.previewFrame(src, doc, 4)
      const bytes = fs.readFileSync(shot.file)
      try { fs.unlinkSync(shot.file) } catch {}
      return bytes
    }
    const plainFrame = await frame(base)
    const liftedFrame = await frame({ ...base, clips: [base.clips[0], { ...base.clips[1], audio: { gain: 10 } }] })
    is('and the picture of a frame inside a lifted clip is the same picture, byte for byte',
      plainFrame.equals(liftedFrame), true)
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  }
}

// A take whose sound starts after its picture: a native take recorded before the
// recorder padded its sound, where the lead was 0.03 s on a display and 0.7 to 2.3 s on
// a window or a simulator. Every reader that takes the sound as samples from zero put
// it that far ahead of the picture. Measured on a click 3 s into the picture.
async function late() {
  const fs = require('fs'), os = require('os'), path = require('path')
  const { execFileSync } = require('child_process')
  console.log('\na take whose sound starts late')
  const plain = proc.clipAudioParts(proc.audioKeep([[0, 4], [6, 10]], 'mute'))
  is('a take whose sound starts with its picture keeps the graph it had',
    plain, proc.clipAudioParts(proc.audioKeep([[0, 4], [6, 10]], 'mute'), '[0:a]', 'ca', 0.0004))
  is('a late one is put back in its place before it is trimmed',
    proc.clipAudioParts(proc.audioKeep([[0, 10]], 'mute'), '[0:a]', 'ca', 2.3)[0].startsWith('[0:a]aresample=async=1:first_pts=0,atrim='), true)
  is('the transcript\'s wav is padded the same way', proc.alignArgs({ audioLead: 2.3 }), ['-af', 'aresample=async=1:first_pts=0'])
  is('and left alone when there is nothing to pad', proc.alignArgs({ audioLead: 0 }), [])
  is('a limiter after a mix gives back its lookahead, or the mix is 5 ms late',
    /alimiter=limit=0\.95(?!:latency=1)/.test(fs.readFileSync(path.join(__dirname, '..', 'processor.js'), 'utf8')), false)

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-late-'))
  const src = path.join(dir, 'late.mov')
  try {
    try {
      execFileSync(proc.FFMPEG, ['-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=160x120:r=10:d=8',
        '-itsoffset', '2.3', '-f', 'lavfi', '-i', "aevalsrc='if(between(t,0.7,0.701),1,0)':d=5.7:s=48000",
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', src])
    } catch (e) { console.log(`  skip ffmpeg could not build the fixture (${String(e.message).split('\n')[0]})`); return }
    const clicks = f => {
      const b = execFileSync(proc.FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', f, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'], { maxBuffer: 1 << 26 })
      const t = []; let last = -1e9
      for (let i = 0; i < b.length / 4; i++) if (Math.abs(b.readFloatLE(i * 4)) > 0.3) { if (i - last > 4800) t.push(i / 48000); last = i }
      return t
    }
    const meta = await proc.probeMeta(src)
    is('the probe reads the lead', Math.abs(meta.audioLead - 2.3) < 0.05, true)
    const near = (t, want) => t.length === 1 && Math.abs(t[0] - want) < 0.002
    const whole = path.join(dir, 'whole.m4a'), cut = path.join(dir, 'cut.m4a')
    await proc.renderAudio(src, { loudnorm: false }, [[0, 8]], 8, meta, whole, null)
    is('the export\'s sound has the click at 3 s, where the picture has it', near(clicks(whole), 3), true)
    await proc.renderAudio(src, { loudnorm: false, cuts: [[1, 2]] }, [[0, 1], [2, 8]], 7, meta, cut, null)
    is('and at 2 s once a second before it is cut', near(clicks(cut), 2), true)
    const w = await proc.waveform(src, { buckets: 800 }, null, null)
    let best = 0; w.peaks.forEach((p, i) => { if (p > w.peaks[best]) best = i })
    is('the waveform draws it at 3 s too', Math.abs(best / w.peaks.length * w.duration - 3) < 0.05, true)
    // Converting is an export too: a wav has no edit list, so its first sample is zero
    for (const format of ['wav', 'mp3', 'm4a']) {
      const r = await proc.convert(src, { format }, null, null)
      is(`converting to ${format} keeps the click at 3 s`, near(clicks(r.file), 3) || clicks(r.file).map(x => +x.toFixed(3)), true)
    }
    const end = await proc.probeAudioEnd(src)
    is('the probe reads where the sound ends, on the picture\'s clock', Math.abs(end - 8) < 0.03, true)
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  }
}

rendered().then(late).then(() => {
  console.log(`\n  ${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
})
