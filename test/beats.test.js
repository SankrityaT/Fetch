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
