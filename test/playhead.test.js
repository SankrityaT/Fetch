// Where the playhead sits when a saved edit opens.
//
// The editor opens a clip, sets the playhead to zero, then reads the saved document and
// restores the trim from it. Restoring the trim did not move the playhead, so a take
// trimmed to begin at 0:33 opened parked thirty three seconds before its own first
// frame: press play and it runs through footage that is not in the export, and the
// filmstrip under it is of the part that was cut.
//
// The rule is not "seek to the start on open". An agent changing something mid-session
// goes through the same function, and yanking the playhead away from whatever the
// person is looking at would be its own fault. It moves only when it is outside the
// range, and then only as far as the nearest edge.
const fs = require('fs'), path = require('path')
const ROOT = path.join(__dirname, '..')
const src = fs.readFileSync(path.join(ROOT, 'ui/editor.js'), 'utf8')

let pass = 0, fail = 0
const is = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`)
}

const from = src.indexOf('function docToEd(')
const fn = src.slice(from, src.indexOf('\n  }', from) + 4)
is('docToEd was found', fn.length > 200, true)
is('the trim is restored from the document', /ed\.in = whole \? 0 : t\.start/.test(fn), true)
is('and the playhead is put inside it', /seek\(Math\.max\(ed\.in, Math\.min\(ed\.cur, ed\.out\)\)\)/.test(fn), true)
is('only when it is outside the range', /ed\.cur < ed\.in \|\| ed\.cur > ed\.out/.test(fn), true)
is('never on a shot, which has no clock', /!ed\.shot &&/.test(fn), true)

// the guard has to sit after the trim is set, or it clamps against the old range
const setAt = fn.indexOf('ed.in = whole ?')
const seekAt = fn.indexOf('seek(Math.max(ed.in')
is('the playhead is moved after the range is known', setAt > -1 && seekAt > setAt, true)

// ── and the pill is not on top of the timeline ──────────────────────────
const appJs = fs.readFileSync(path.join(ROOT, 'ui/app.js'), 'utf8')
const appCss = fs.readFileSync(path.join(ROOT, 'ui/app.css'), 'utf8')
is('the open view is on the document', /document\.documentElement\.dataset\.view = view/.test(appJs), true)
is('and the editor moves the pill off the bottom', /html\[data-view="editor"\] \.agent-brake \{ bottom:auto;/.test(appCss), true)
is('the pill is otherwise still bottom left', /\.agent-brake \{[\s\S]{0,120}bottom:var\(--s-5\)/.test(appCss), true)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
