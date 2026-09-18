const p = require('../processor')

let pass = 0, fail = 0
const is = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}` +
    (ok ? '' : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`))
}

// words arrive as {word, startTime, endTime}; end times are padded so nothing may rely on them
const W = (word, t) => ({ word, startTime: t, endTime: t + 5 })

// One speech run, one pause at 4.0-5.2, a second run.
const words = [
  W('Now', 0.4), W('open', 0.8), W('the', 1.1), W('filter', 1.4),
  W('and', 5.3), W('pick', 5.7), W('only', 6.0), W('family', 6.4),
]
const speech = [[0.3, 4.0], [5.2, 7.0]]

{
  const b = p.buildBeats(words, speech, 10)
  is('a real pause makes two beats', b.length, 2)
  is('labels come from what was said', b.map(x => x.label), ['Now open the filter', 'And pick only family'])
  is('beats tile with no gaps', [b[0].end, b[1].start], [b[1].start, b[1].start])
  is('the last beat runs to the end', b[1].end, 10)
  is('the first beat starts at the first word', b[0].start, 0.4)
}

{
  // the same words with no silence between them must stay one beat
  const b = p.buildBeats(words, [[0.3, 7.0]], 10)
  is('no pause means one beat', b.length, 1)
}

{
  // a pause shorter than the threshold is a breath, not a subject change
  const b = p.buildBeats(words, [[0.3, 4.0], [4.5, 7.0]], 10)
  is('a 0.5s gap does not break a beat', b.length, 1)
}

// Measured on a narrated take: a soft last word ("how hard it is") sits right where
// the amplitude detector says the silence begins, and the recogniser hears the next
// word ("Listen") 0.38s before the detector says the silence ends. The same pause used
// to qualify on both sides of "is", leaving a beat that was just the word "Is".
{
  const w = [W('how', 22.3), W('hard', 22.5), W('it', 22.9), W('is', 23.36),
             W('Listen', 23.92), W('plays', 24.4), W('it', 24.7)]
  const b = p.buildBeats(w, [[21.0, 23.33], [24.3, 26.0]], 30)
  is('one pause makes one break, not two', b.length, 2)
  is('a soft last word stays in its sentence', b.map(x => x.label), ['How hard it is', 'Listen plays it'])
  is('the break lands on the first word after the pause', b[1].start, 23.92)
}
{
  // "exactly where you left off." then a long pause, then the next line
  const w = [W('exactly', 37.9), W('where', 38.3), W('you', 38.5), W('left', 38.7), W('off', 39.36),
             W('That', 41.37), W('is', 41.6)]
  const b = p.buildBeats(w, [[34.0, 39.3], [41.75, 44.0]], 46)
  is('a sentence end is not pushed into the next beat', b.map(x => x.label), ['Exactly where you left off', 'That is'])
}

// ---- captions, from the same narrated take ----
{
  const w = [W('Close', 34.8), W('the', 35.0), W('song', 35.2), W('and', 35.5), W('you', 35.7), W('are', 35.9),
             W('right', 36.1), W('back', 36.4), W('in', 36.64), W('the', 36.8), W('library,', 37.0),
             W('exactly', 37.9), W('where', 38.3), W('you', 38.5), W('left', 38.7), W('off.', 39.36),
             W('That', 41.37), W('is', 41.6)].map(x => ({ ...x, endTime: x.startTime + 0.3 }))
  const cues = p.buildCues(w, [[34.5, 39.6], [41.75, 44.0]])
  const texts = cues.map(c => c.text)
  is('no caption is a single stranded word', texts.some(t => t.split(' ').length === 1), false)
  is('the sentence end stays with its sentence', texts.some(t => /left off\.$/.test(t)), true)
  is('the next sentence starts its own caption', texts[texts.length - 1], 'That is')
  is('captions never run backwards', cues.every((c, i) => c.end > c.start && (!cues[i + 1] || cues[i + 1].start >= c.start)), true)
}
{
  const w = [W('how', 22.3), W('hard', 22.5), W('it', 22.9), W('is.', 23.36), W('Listen,', 23.92), W('plays', 24.4)]
    .map(x => ({ ...x, endTime: x.startTime + 0.3 }))
  const texts = p.buildCues(w, [[21.0, 23.33], [24.3, 26.0]]).map(c => c.text)
  is('a soft last word is not its own caption', texts, ['how hard it is.', 'Listen, plays'])
}

is('no words gives no beats', p.buildBeats([], [], 10), [])
is('null input is survivable', p.buildBeats(null, null, 10), [])

{
  const b = p.buildBeats([W('hello', 0.5)], [[0.4, 1.0]], 8)
  is('a single word still labels', b[0].label, 'Hello')
}

{
  // trailing punctuation would read badly on a timeline chip
  const b = p.buildBeats([W('Right,', 0.2), W('done.', 0.6)], [[0.1, 1.0]], 3)
  is('trailing punctuation is trimmed', b[0].label, 'Right, done')
}

{
  // a monologue with no pauses must not become one beat spanning everything
  const many = []
  for (let i = 0; i < 80; i++) many.push(W('word' + i, i * 0.5))
  const b = p.buildBeats(many, [[0, 40]], 40)
  is('a long unbroken run is still split', b.length > 1, true)
}

{
  // silent recordings still deserve a timeline
  const pts = []
  for (let i = 0; i < 400; i++) pts.push([i * 50, 100 + (i > 200 ? 600 : 0), 100])
  const b = p.beatsFromCursor({ points: pts }, 20)
  is('cursor fallback produces beats', b.length > 0, true)
  is('cursor beats start at zero', b[0].start, 0)
  is('cursor beats reach the end', b[b.length - 1].end, 20)
}
is('cursor fallback needs real data', p.beatsFromCursor({ points: [] }, 10), [])

console.log(`\n  ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
