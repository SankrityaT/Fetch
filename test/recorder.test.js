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

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
