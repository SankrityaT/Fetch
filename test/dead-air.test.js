// What dead air is, and what it is never allowed to take.
//
// It used to be silence alone. So it cut whatever happened while nobody was talking: an
// animation playing out, a result landing, a screen hatching. Those are the moments a
// demo is made of, and they are exactly the ones with no narration over them. Measured
// on a real narrated take: of 12.2 s of silence, 4.1 s had the screen moving through it
// and was being deleted.
//
// Dead air is silence AND a picture that is not doing anything.
const P = require('../processor')
const fs = require('fs'), path = require('path')
const ROOT = path.join(__dirname, '..')

let pass = 0, fail = 0
const is = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`)
}
const span = (a, b) => [a, b]
const cut = (q, s, o = {}) => P.deadAir(q, s, { minSil: 0.7, pad: 0.15, dur: 100, ...o })

// ── the rule ────────────────────────────────────────────────────────────
is('silence over a still picture is dead air',
  cut([span(10, 14)], [span(0, 100)]), [[10.15, 13.85]])
is('silence over a moving picture is not touched',
  cut([span(10, 14)], []), [])
is('only the part that is both goes',
  cut([span(10, 20)], [span(15, 100)]), [[15.15, 19.85]])
is('two silences, one of them moving, cuts one',
  cut([span(10, 14), span(30, 34)], [span(28, 40)]), [[30.15, 33.85]])
is('an overlap shorter than the gap asked for is not a gap',
  cut([span(10, 14)], [span(13.5, 100)]), [])
is('cuts come back in order', cut([span(30, 34), span(10, 14)], [span(0, 100)]).map(c => c[0]), [10.15, 30.15])

// ── the padding is a breath, not an afterthought ────────────────────────
is('padding is taken off both ends', cut([span(10, 14)], [span(0, 100)], { pad: 0.5 }), [[10.5, 13.5]])
is('a cut padded out of existence is dropped', cut([span(10, 11)], [span(0, 100)], { pad: 0.5 }), [])
is('nothing runs past the end', cut([span(90, 200)], [span(0, 200)], { dur: 100 })[0][1] <= 100, true)

// ── nothing in, nothing out ─────────────────────────────────────────────
is('no silence is no cuts', cut([], [span(0, 100)]), [])
is('no stillness is no cuts', cut([span(10, 14)], []), [])
is('undefined is not a crash', [P.deadAir(undefined, undefined, {}), P.deadAir(null, null, {})], [[], []])

// ── the detector spans are read honestly ────────────────────────────────
is('a span still open at the end runs to the end', P.spansOf([{ start: 5 }], 12), [[5, 12]])
is('a negative start is clamped', P.spansOf([{ start: -2, end: 3 }], 12), [[0, 3]])
is('an empty span is dropped', P.spansOf([{ start: 5, end: 5 }], 12), [])

// ── and the source says why it chose what it chose ──────────────────────
const src = fs.readFileSync(path.join(ROOT, 'processor.js'), 'utf8')
is('both detectors run over the file', /freezedetect=n=\$\{still\}:d=\$\{minSil\}/.test(src), true)
is('a take with no picture falls back to silence alone', /const hasPicture = !!\(meta\.width && meta\.height\)/.test(src), true)
is('and the refusal explains that the screen was busy', /the picture is moving through all of it/.test(src), true)
is('the tolerance was measured, not guessed', /-60dB to -35dB/.test(src), true)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
