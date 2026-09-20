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
  is('already under the target, nothing is dropped', r.clips.length, 1)
  is('and it says so', r.short, true)
  ok('the line says a target is a ceiling', /ceiling/.test(r.why))
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

console.log(`\n  ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
