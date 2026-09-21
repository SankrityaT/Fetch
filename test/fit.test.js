// Hitting a length from the transcript (ui/fit.js): fillers, pauses, whole beats.
const F = require('../ui/fit')

let pass = 0, fail = 0
const is = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}` +
    (ok ? '' : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`))
}
const ok = (name, cond) => is(name, !!cond, true)
const r2 = n => Math.round(n * 100) / 100

// Word timings as the sidecar keeps them: a start time and nothing else.
const W = (s, from = 0, step = 0.4) => s.split(' ').map((w, i) => ({ w, t: +(from + i * step).toFixed(3) }))

console.log('filler spans')
{
  const words = [{ w: 'now', t: 1.0 }, { w: 'um', t: 1.4 }, { w: 'open', t: 2.2 }, { w: 'it', t: 2.5 }]
  const s = F.fillerSpans(words, { dur: 5 })
  is('one um, one cut', s.length, 1)
  is('the cut runs to just before the next word', [s[0].start, s[0].end], [1.4, 2.12])
  ok('no lead is taken off a word that follows closely', s[0].start === 1.4)
}
{
  // a filler after a real gap gets a touch of lead, since nothing is running into it
  const s = F.fillerSpans([{ w: 'right', t: 1.0 }, { w: 'uh', t: 2.0 }, { w: 'so', t: 2.4 }], { dur: 5 })
  is('lead is taken where there is a gap to take it from', s[0].start, 1.95)
}
{
  const s = F.fillerSpans([{ w: 'and', t: 1.0 }, { w: 'um', t: 1.4 }], { dur: 9 })
  is('a filler with nothing after it is capped at a second', [s[0].start, s[0].end], [1.4, 2.4])
}
{
  const s = F.fillerSpans([{ w: 'it', t: 1.0 }, { w: 'you', t: 1.3 }, { w: 'know', t: 1.5 }, { w: 'works', t: 2.4 }], { dur: 5 })
  is('"you know" is one cut, not two', s.length, 1)
  is('and it spans both words', [s[0].start, s[0].end], [1.3, 2.32])
}
{
  const words = [{ w: 'It', t: 1.0 }, { w: 'Um,', t: 1.4 }, { w: 'works', t: 2.4 }]
  is('case and punctuation still match', F.fillerSpans(words, { dur: 5 }).length, 1)
}
{
  const words = [{ w: 'it', t: 1.0 }, { w: 'like', t: 1.4 }, { w: 'works', t: 2.4 }]
  is('"like" is left alone by default', F.fillerSpans(words, { dur: 5 }).length, 0)
  is('and taken when asked for', F.fillerSpans(words, { dur: 5, extra: ['like'] }).length, 1)
}
{
  // words 0.1s apart leave nothing worth cutting once the next attack is protected
  const words = [{ w: 'it', t: 1.0 }, { w: 'um', t: 1.4 }, { w: 'works', t: 1.46 }]
  is('a cut too short to be seen is not made', F.fillerSpans(words, { dur: 5 }).length, 0)
}

console.log('dead air')
{
  const s = F.deadSpans([[2, 4], [6, 8]], { dur: 10 })
  is('the head runs from zero to the first word', [s[0].start, s[0].end], [0, 1.85])
  is('a gap keeps a breath on each side', [s[1].start, s[1].end], [4.15, 5.85])
  is('the tail runs to the end', [s[2].start, s[2].end], [8.15, 10])
}
is('a short gap stays', F.deadSpans([[0, 4], [4.4, 10]], { dur: 10 }).length, 0)
is('no speech, no cuts', F.deadSpans([], { dur: 10 }).length, 0)
is('the threshold is the caller\'s', F.deadSpans([[0, 4], [4.4, 10]], { dur: 10, minSilence: 0.3 }).length, 1)

console.log('clips and spans')
{
  const clips = [{ id: 'C1', start: 0, end: 10, rate: 2 }]
  is('a split clip keeps its other fields, and only the first piece keeps the id',
    F.subtract(clips, [{ start: 4, end: 5 }]).map(c => [c.id || null, c.start, c.end, c.rate]),
    [['C1', 0, 4, 2], [null, 5, 10, 2]])
  is('a rate halves what a clip is worth on the output', F.outLength(clips), 5)
  is('and no rate reads as 1', F.outLength([{ start: 0, end: 10 }]), 10)
}
is('a sliver is not left behind', F.subtract([{ start: 0, end: 10 }], [{ start: 0, end: 9.97 }]).length, 0)

// ── two takes to fit ────────────────────────────────────────────────────────
// Both are 60 seconds and six beats of 10.
//
// The first is mostly pauses: a short line in each beat and eight seconds of nothing
// after it, which is the take the pause pass is for.
function take() {
  const beats = [], words = [], speech = []
  const said = ['open the filter now', 'um pick the family plan', 'the total updates here',
    'now uh press checkout', 'the receipt arrives fast', 'and that is the whole flow']
  said.forEach((line, i) => {
    const at = i * 10
    beats.push({ id: `B${i + 1}`, start: at, end: at + 10, label: line })
    words.push(...W(line, at + 0.5, 0.5))
    speech.push([at + 0.4, at + 0.5 + line.split(' ').length * 0.5])
  })
  return {
    doc: { dur: 60, clips: [], beats, zooms: [], marks: [], texts: [], cues: [] },
    words, speech,
  }
}

// The second talks the whole way through, at six different speeds, so nothing is free
// and a target can only be met by dropping beats. B4 is the thinnest, B1 and B6 the
// ends. An um sits in the middle of B2 and of B4.
function dense() {
  const counts = [18, 10, 20, 6, 16, 12]
  const names = ['intro', 'filter', 'total', 'checkout', 'receipt', 'outro']
  const beats = [], words = [], speech = []
  counts.forEach((n, i) => {
    const at = i * 10
    const step = 9.2 / n
    for (let k = 0; k < n; k++) {
      const w = k === 0 ? names[i] : (k === 2 && (i === 1 || i === 3)) ? 'um' : `word${k}`
      words.push({ w, t: +(at + 0.2 + k * step).toFixed(3) })
    }
    beats.push({ id: `B${i + 1}`, start: at, end: at + 10, label: `${names[i]} step` })
    speech.push([at + 0.1, at + 9.6])
  })
  return {
    doc: { dur: 60, clips: [], beats, zooms: [], marks: [], texts: [], cues: [] },
    words, speech,
  }
}

console.log('fitting')
{
  const t = take()
  const before = JSON.stringify(t.doc)
  const r = F.fit(t.doc, { seconds: 30, words: t.words, speech: t.speech })
  is('the document is not touched', JSON.stringify(t.doc), before)
  is('it started at the full take', r.was, 60)
  ok('it lands on the number', r.hit && Math.abs(r.now - 30) <= r.tolerance + 0.001)
  ok('the pauses did most of the work', r.cut.dead.count > 0)
  ok('the clips add up to what it says', Math.abs(F.outLength(r.clips) - r.now) < 0.001)
  ok('the same call twice gives the same clips', JSON.stringify(F.fit(t.doc, { seconds: 30, words: t.words, speech: t.speech }).clips) === JSON.stringify(r.clips))
}
{
  // an easy target: the fillers and the pauses reach it, so every beat survives
  const t = take()
  const r = F.fit(t.doc, { seconds: 45, words: t.words, speech: t.speech })
  is('no beat is dropped when the free cuts are enough', r.cut.beats.length, 0)
  ok('the ums went', r.cut.fillers.count === 2)
  is('and it says which words', r.cut.fillers.words.sort(), ['uh', 'um'])
}
{
  // nothing is free on this one, so beats have to go, and the named one stays
  const t = dense()
  const r = F.fit(t.doc, { seconds: 30, words: t.words, speech: t.speech, keep: ['checkout'] })
  ok('beats were dropped', r.cut.beats.length > 0)
  ok('the beat that was named survives', !r.cut.beats.some(b => b.id === 'B4'))
  is('the term is reported as matched', r.keep.matched, ['checkout'])
  ok('a dropped beat says what it was worth', r.cut.beats.every(b => b.seconds > 0 && b.label))
  ok('it lands on the number anyway', r.hit)
  ok('the ends are the last to go', !r.cut.beats.some(b => b.id === 'B1'))
}
{
  const t = dense()
  const r = F.fit(t.doc, { seconds: 30, words: t.words, speech: t.speech })
  is('the thinnest beat goes first', r.cut.beats[0].id, 'B4')
  ok('whole beats, never half of one', r.cut.beats.every(b => b.end - b.start === 10))
}
{
  const t = dense()
  const r = F.fit(t.doc, { seconds: 30, words: t.words, speech: t.speech, keep: ['B4', 'the moon'] })
  is('a keep term that matched nothing is named', r.keep.unmatched, ['the moon'])
  ok('an id keeps its beat', !r.cut.beats.some(b => b.id === 'B4'))
}
{
  // a zoom is somebody aiming: the beat under it is worth more than a bare one
  const t = dense()
  const bare = F.fit(dense().doc, { seconds: 50, words: t.words, speech: t.speech })
  t.doc.zooms = [{ id: 'Z1', start: 32, end: 36, scale: 2, x: 0.5, y: 0.5 }]
  const aimed = F.fit(t.doc, { seconds: 50, words: t.words, speech: t.speech })
  ok('the bare run drops B4', bare.cut.beats.some(b => b.id === 'B4'))
  ok('the zoomed run keeps it and drops the next thinnest', !aimed.cut.beats.some(b => b.id === 'B4') && aimed.cut.beats.some(b => b.id === 'B2'))
}
{
  const t = dense()
  t.doc.marks = [{ id: 'M1', kind: 'redact', start: 32, end: 36, x: 0.1, y: 0.1, w: 0.2, h: 0.1 }]
  const r = F.fit(t.doc, { seconds: 50, words: t.words, speech: t.speech })
  ok('a redaction does not protect its beat: the footage going hides more', r.cut.beats.some(b => b.id === 'B4'))
  is('and the mark left without footage is named', r.orphans.marks, ['M1'])
}
{
  // two seconds owed and nothing left under four: the take is not butchered for it
  const t = dense()
  const r = F.fit(t.doc, { seconds: 56, words: t.words, speech: t.speech })
  is('a beat worth more than twice what is owed is left alone', r.cut.beats.length, 0)
  ok('and the caller is told what dropping one would cost', r.next && r.next.seconds > 0 && r.next.leaves < 56)
  ok('the line names it', r.why.includes(r.next.id))
}
{
  // output seconds, not source seconds: a clip at 2x is worth half of itself
  const t = dense()
  t.doc.clips = [{ id: 'C1', start: 0, end: 60, rate: 2 }]
  const r = F.fit(t.doc, { seconds: 20, words: t.words, speech: t.speech })
  is('a rate is counted before the target is', r.was, 30)
  ok('and it still lands', r.hit && r.now <= 20 + r.tolerance)
}
{
  const t = dense()
  const r = F.fit(t.doc, { seconds: 2, words: t.words, speech: t.speech })
  ok('an impossible target never returns an empty edit', r.clips.length > 0 && r.now > 0)
  ok('and it says it missed', r.hit === false && r.over_by > 0)
}
{
  const t = take()
  const r = F.fit(t.doc, { seconds: 120, words: t.words, speech: t.speech })
  is('nothing is dropped to reach a longer target', r.clips.length, 1)
  is('a take with nothing to dwell on stays short', r.short, true)
  ok('and it is not called a hit', r.hit === false)
  ok('the line says there is nothing holding still to slow', /nothing to slow/.test(r.why))
  ok('and it says what to do instead', /record more/.test(r.why))
}
{
  const r = F.fit({ dur: 30, clips: [], beats: [], cues: [] }, { seconds: 10 })
  ok('no transcript says what to do about it', /Transcribe this take first/.test(r.why))
}
{
  // an existing trim survives: fit subtracts from the clips that are there
  const t = take()
  t.doc.clips = [{ id: 'C1', start: 5, end: 55 }]
  const r = F.fit(t.doc, { seconds: 30, words: t.words, speech: t.speech })
  ok('nothing outside the trim comes back', r.clips.every(c => c.start >= 5 && c.end <= 55))
  is('the first piece keeps its id', r.clips[0].id, 'C1')
}
{
  // with no speech runs the captions stand in, so a document alone finds the pauses
  const t = take()
  const cues = t.speech.map(([a, b], i) => ({ id: `S${i + 1}`, start: a, end: b, text: 'x' }))
  const r = F.fit({ ...t.doc, cues }, { seconds: 40, words: t.words })
  ok('captions stand in for the silences', r.cut.dead.count > 0)
}
{
  const t = take()
  const r = F.fit(t.doc, { seconds: 45, words: t.words, speech: t.speech })
  ok('dead air it did not need is reported, not taken', r.cut.dead.left >= 0)
}

// ── reaching a longer target ────────────────────────────────────────────────
// 30 seconds, talking from 3 to 10 and from 20 to 27. A title card opens it, a zoom
// holds over the silence in the middle, and a lift sits under the second sentence: the
// first two are moments to dwell on and the third is not, because somebody is talking
// over it.
function slowable() {
  return {
    doc: {
      dur: 30, clips: [], beats: [],
      texts: [{ id: 'T1', start: 0, end: 3, text: 'Fetch' }],
      zooms: [{ id: 'Z1', start: 11, end: 19, scale: 2, x: 0.5, y: 0.5 }],
      marks: [{ id: 'M1', kind: 'lift', start: 21, end: 26, x: 0.2, y: 0.2, w: 0.5, h: 0.4 }],
      cues: [],
    },
    speech: [[3, 10], [20, 27]],
  }
}

console.log('the moments worth dwelling on')
{
  const t = slowable()
  const d = F.dwellSpans(t.doc, { speech: t.speech })
  is('two moments, and not the one under speech', d.map(m => m.on.join('+')), ['T1', 'Z1'])
  is('a card is clear of its own fade, and of the speech after it', [d[0].start, d[0].end], [0.6, 2.4])
  is('a zoom is clear of its own travel', [d[1].start, d[1].end], [11.8, 18.2])
  is('and each one says what is holding there', d.map(m => m.what), ['card', 'zoom'])
}
{
  const t = slowable()
  t.doc.zooms.push({ id: 'Z2', start: 11.5, end: 18, scale: 3, x: 0.2, y: 0.2 })
  const d = F.dwellSpans(t.doc, { speech: t.speech })
  is('two things aimed at one moment is one moment', d.length, 2)
  is('and both are named', d[1].on, ['Z1', 'Z2'])
}
{
  const t = slowable()
  t.doc.zooms = [{ id: 'Z1', start: 12, end: 13.5, scale: 2 }]
  is('a hold too short to dwell in is not one', F.dwellSpans(t.doc, { speech: t.speech }).length, 1)
}
{
  const t = slowable()
  t.doc.marks = [{ id: 'M2', kind: 'redact', start: 11, end: 19, x: 0.1, y: 0.1, w: 0.2, h: 0.2 }]
  t.doc.zooms = []
  is('a redaction is not something to dwell on', F.dwellSpans(t.doc, { speech: t.speech }).map(m => m.on.join('+')), ['T1'])
}
{
  const t = slowable()
  const d = F.dwellSpans(t.doc, { speech: [[0, 30]] })
  is('talking the whole way through leaves nothing to slow', d.length, 0)
}

console.log('stretching to a longer target')
{
  const t = slowable()
  const before = JSON.stringify(t.doc)
  const r = F.fit(t.doc, { seconds: 34, speech: t.speech })
  is('the document is not touched', JSON.stringify(t.doc), before)
  ok('it lands on the number', r.hit && Math.abs(r.now - 34) <= r.tolerance + 0.001)
  is('nothing was cut', [r.cut.fillers.count, r.cut.dead.count, r.cut.beats.length], [0, 0, 0])
  is('every source second is still there', r.clips.reduce((n, c) => n + (c.end - c.start), 0), 30)
  is('and in one unbroken run', r.clips.every((c, i) => i === 0 || c.start === r.clips[i - 1].end), true)
  is('only the dwelling moments carry a rate', r.clips.filter(c => c.rate).map(c => [c.start, c.end]), [[0.6, 2.4], [11.8, 18.2]])
  is('one rate everywhere, the gentlest that reaches it', new Set(r.clips.filter(c => c.rate).map(c => c.rate)).size, 1)
  ok('the clips add up to what it says', Math.abs(F.outLength(r.clips) - r.now) < 0.001)
  ok('it is no longer short', r.short === false && r.under_by === 0)
  ok('the same call twice gives the same clips', JSON.stringify(F.fit(t.doc, { seconds: 34, speech: t.speech }).clips) === JSON.stringify(r.clips))
}
{
  const t = slowable()
  const r = F.fit(t.doc, { seconds: 34, speech: t.speech })
  is('the line says what it slowed and that it cut nothing', /slowed to .*x, .*added. Nothing was cut/.test(r.why), true)
  is('the moments are reported with what each is worth', r.stretch.moments.map(m => m.seconds), [1.8, 6.4])
  is('and the longest this edit can honestly be', r.stretch.reach, 38.2)
}
{
  // exactly at the floor: every dwelling moment at half speed and not a frame slower
  const t = slowable()
  const r = F.fit(t.doc, { seconds: 38.2, speech: t.speech })
  is('the floor is half speed', r.stretch.rate, 0.5)
  ok('which is where reach comes from', Math.abs(r.now - r.stretch.reach) < 0.001)
  ok('and it counts as hit', r.hit)
}
{
  const t = slowable()
  const r = F.fit(t.doc, { seconds: 45, speech: t.speech })
  ok('past reach it refuses', r.stretch.rate === null && r.hit === false && r.short === true)
  is('and changes nothing', r.clips.length, 1)
  is('it says how far it is', r.under_by, 15)
  ok('the line names the reach and says record more', r.why.includes('38.2') && /record more/.test(r.why))
}
{
  // words but no speech runs: nothing says where the voice is, so nothing is slowed
  const t = slowable()
  const r = F.fit(t.doc, { seconds: 34, words: W('this is the whole take', 4, 0.5) })
  ok('with no speech runs it slows nothing', r.stretch.rate === null && r.clips.length === 1)
  ok('and says to transcribe rather than guessing', /transcribe this take/.test(r.why))
}
{
  const t = slowable()
  const r = F.fit(t.doc, { seconds: 34, speech: t.speech, slow: false })
  ok('slowing can be turned off', !r.stretch && r.now === 30 && r.short)
  ok('and then it says so rather than pretending', /slowing was turned off/.test(r.why))
}
{
  // a target inside the tolerance is already met, so nothing is slowed for it
  const t = slowable()
  const r = F.fit(t.doc, { seconds: 30.4, speech: t.speech })
  ok('a target within tolerance changes nothing', !r.stretch && r.now === 30 && r.hit)
}
{
  // a clip that already runs fast is slowed relative to itself, never to 1
  const t = slowable()
  t.doc.clips = [{ id: 'C1', start: 0, end: 30, rate: 2 }]
  const r = F.fit(t.doc, { seconds: 18, speech: t.speech })
  is('it starts from what the rate left', r.was, 15)
  ok('the fast pieces still run fast', r.clips.filter(c => c.rate === 2).length === 3)
  ok('a slowed piece is slowed against the speed it had, never down to 1',
    r.clips.filter(c => c.rate !== 2).every(c => c.rate > 1 && c.rate < 2))
  ok('and it lands', r.hit && Math.abs(r.now - 18) <= r.tolerance + 0.001)
}
{
  // one clock. fit does its own arithmetic to stay pure, so it has to agree with the
  // clock the stage and the export read, or a stretch is two lengths for one edit.
  const Timeline = require('../ui/timeline')
  const Fetchdoc = require('../ui/fetchdoc')
  const t = slowable()
  const r = F.fit(t.doc, { seconds: 34, speech: t.speech })
  const seg = c => (Array.isArray(c.rate) ? [c.start, c.end, c.rate[0], c.rate[1]]
    : c.rate ? [c.start, c.end, c.rate] : [c.start, c.end])
  ok('the timeline reads the same length off the same clips',
    Math.abs(r.clips.reduce((n, c) => n + Timeline.outSpan(seg(c)), 0) - F.outLength(r.clips)) < 1e-9)
  const kept = Fetchdoc.normalize({ ...t.doc, clips: r.clips }).clips
  is('and the document keeps every rate as written, unclamped',
    kept.map(c => c.rate), r.clips.map(c => c.rate))
  ok('so the document agrees on the length too',
    Math.abs(Fetchdoc.outDuration({ clips: kept }) - F.outLength(r.clips)) < 1e-9)
}
{
  // a ramp keeps its shape: both ends slowed by the same factor
  const t = slowable()
  t.doc.clips = [{ id: 'C1', start: 0, end: 30, rate: [1, 3] }]
  const r = F.fit(t.doc, { seconds: 20, speech: t.speech })
  const ramped = r.clips.filter(c => Array.isArray(c.rate))
  ok('a slowed piece of a ramp is still a ramp', ramped.length > 0 && ramped.every(c => c.rate[0] < c.rate[1]))
  ok('and the whole thing still adds up', Math.abs(F.outLength(r.clips) - r.now) < 0.001)
}
{
  // shorter still works the way it always did: a target under the length only cuts
  const t = take()
  const r = F.fit(t.doc, { seconds: 30, words: t.words, speech: t.speech })
  ok('a shorter target is still a cut and never a stretch', !r.stretch && r.clips.every(c => !c.rate))
}

console.log('fillers on their own')
{
  const t = take()
  const r = F.cutFillers(t.doc, { words: t.words })
  is('two ums go', r.cut.fillers.count, 2)
  is('and no pause does', r.cut.dead.count, 0)
  ok('the take is shorter by what they were worth', r2(r.was - r.now) === r2(r.cut.fillers.seconds))
}

console.log('ranking')
{
  const t = dense()
  const rank = F.rankBeats(t.doc, { words: t.words })
  is('every beat is ranked', rank.beats.length, 6)
  is('least first', rank.beats.map(b => b.id), ['B4', 'B2', 'B5', 'B6', 'B3', 'B1'])
  ok('the ends carry a bonus', rank.beats[5].id === 'B1')
  ok('fillers are not counted as words', rank.beats.find(b => b.id === 'B2').words === 9)
}

// ── the cheap cuts stop going through the work ──────────────────────────────
// The judged take, in shape: a 55.55 s tour with a title card over the head silence
// and a closing URL card over the tail silence. Asked for 45 s, both used to go, and
// the only word about it was orphans.texts.
console.log('a card over silence is not a pause')
{
  const cards = {
    dur: 55.55,
    clips: [{ id: 'C1', start: 0, end: 55.55 }],
    texts: [{ id: 'T1', text: 'Songscription', start: 0, end: 2.7 },
      { id: 'T2', text: 'songscription-library.vercel.app', start: 53.85, end: 55.55 }],
    marks: [{ id: 'M1', kind: 'lift', start: 20, end: 24, x: 0.3, y: 0.3, w: 0.2, h: 0.2 }],
    beats: Array.from({ length: 5 }, (_, i) => ({ id: 'B' + (i + 1), start: 3 + i * 10, end: 13 + i * 10 })),
    cues: Array.from({ length: 5 }, (_, i) => ({ start: 3 + i * 10, end: 12 + i * 10, text: 'talking' })),
  }
  const speech = cards.cues.map(c => [c.start, c.end])
  const r = F.fit(cards, { seconds: 45, speech })
  const drawn = (a, b) => r.clips.reduce((n, c) => n + Math.max(0, Math.min(b, c.end) - Math.max(a, c.start)), 0)
  is('the opening card is drawn whole', r2(drawn(0, 2.7)), 2.7)
  is('and the closing URL card is still there', r2(drawn(53.85, 55.55)), 1.7)
  is('no card is orphaned', r.orphans.texts, [])
  ok('and the seconds come out of the pauses and a beat instead', r.hit && r.cut.dead.count > 0)
  // the same rule for a mark somebody aimed: a lift is the point of its moment
  is('a lift is not cut through either', r2(drawn(20, 24)), 4)
}

// ── half speed is a promise about the rate, not about the factor ────────────
console.log('a hold the person already slowed')
{
  const doc = {
    dur: 30,
    clips: [{ id: 'C1', start: 0, end: 10 }, { id: 'C2', start: 10, end: 16, rate: 0.8 }, { id: 'C3', start: 16, end: 30 }],
    texts: [{ id: 'T1', text: 'Fetch', start: 11, end: 15 }],
    cues: [{ start: 0, end: 9, text: 'talking' }, { start: 17, end: 29, text: 'talking' }],
  }
  const speech = [[0, 9], [17, 29]]
  const reach = F.fit(doc, { seconds: 999, speech }).stretch.reach
  const r = F.fit(doc, { seconds: reach, speech })
  const slowest = Math.min(...r.clips.map(c => Math.min(...[].concat(c.rate == null ? 1 : c.rate))))
  ok('nothing is slowed past half speed, whatever speed it was already at', slowest >= F.SLOW_MIN - 1e-9)
  ok('and reach is a number it can actually arrive at', Math.abs(r.now - reach) <= r.tolerance)
}

{
// ── a length on a take with no voice ─────────────────────────────────────────
// A device take is often silent: nobody narrates an onboarding flow. Its spine is the
// taps. These lived in test/director.test.js for a round because that round did not own
// this file; nothing about them is director shaped.

console.log('a length on a take with nobody talking')

const assert = require('assert')
// Each one is a handful of asserts, counted as one check, as it was where it came from.
const t = (name, fn) => { try { fn(); ok(name, true) } catch (e) { ok(`${name}: ${e.message}`, false) } }
// The judged take: 202 s of silent onboarding, four taps on the track, and a
// deliverable that will not take anything over 30 s.
const silent = (taps, dur = 202.3) => ({
  dur, clips: [{ start: 0, end: dur }],
  pointer: taps.map(at => ({ t: at, x: 0.5, y: 0.8, click: true })),
})

t('a silent device take is fit on its taps, in one call, with no transcript anywhere', () => {
  const r = F.fit(silent([6, 61.4, 118.9, 171.2]), { seconds: 28 })
  assert.strictEqual(r.spine, 'taps')
  assert.strictEqual(r.hit, true)
  assert.ok(Math.abs(r.now - 28) <= r.tolerance)
  assert.ok(r.why.includes('waits between taps'), r.why)
})

t('every tap and the screen answering it survives the cut', () => {
  const taps = [6, 61.4, 118.9, 171.2]
  const r = F.fit(silent(taps), { seconds: 28 })
  const kept = t0 => r.clips.some(c => c.start <= t0 && c.end >= t0)
  for (const at of taps) {
    assert.ok(kept(at), `the tap at ${at} went`)
    assert.ok(kept(at + 0.9), `the screen answering the tap at ${at} went`)
  }
})

t('a take with a voice on it is still cut on the voice, and the taps only protect themselves', () => {
  const doc = { ...silent([5]), cues: [[0, 0]] }
  doc.cues = [{ start: 1, end: 4 }, { start: 8, end: 30 }]
  const r = F.fit(doc, { seconds: 20 })
  assert.strictEqual(r.spine, 'speech')
  assert.ok(r.why.includes('pause') || !r.why.includes('taps'), r.why)
})

t('a take with neither a voice nor a tap still says so, and says it the old way', () => {
  const r = F.fit({ dur: 202.3, clips: [{ start: 0, end: 202.3 }] }, { seconds: 28 })
  assert.strictEqual(r.spine, null)
  assert.strictEqual(r.why, 'No transcript, so there is nothing to choose from. Transcribe this take first.')
})

t('a silent take asked for longer is told to record more, never to transcribe silence', () => {
  const r = F.fit(silent([2, 8], 12), { seconds: 30 })
  assert.ok(r.why.includes('record more of the flow'), r.why)
  assert.ok(!r.why.includes('transcribe'), 'transcribing silence returns silence')
})

t('the tap runs are the press and the screen answering it, merged when two taps overlap', () => {
  assert.deepStrictEqual(F.tapRuns(silent([10]), { dur: 60 }), [[9.65, 11.2]])
  assert.deepStrictEqual(F.tapRuns(silent([10, 10.6]), { dur: 60 }), [[9.65, 11.8]])
  assert.deepStrictEqual(F.tapRuns(silent([0.1]), { dur: 60 }), [[0, 1.3]], 'a tap at the head is not cut back past zero')
  assert.deepStrictEqual(F.tapRuns(silent([59.8]), { dur: 60 }), [[59.45, 60]], 'and not past the end either')
  assert.deepStrictEqual(F.tapRuns({ pointer: [{ t: 3, x: 0, y: 0 }] }, { dur: 60 }), [], 'a point with no press is not a tap')
})

}

console.log(`\n  ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
