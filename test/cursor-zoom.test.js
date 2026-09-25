// Auto zoom on clicks, and the two reasons it did nothing.
//
// One: the switch was greyed out on takes that plainly have a cursor. Whether a take
// has a pointer track was answered by looking for the .cursor.json sidecar Fetch's own
// recorder writes, and a track can just as well live in the edit document: an agent
// reports its taps onto a take, apply_edit takes a pointer array, and the compositor
// draws either one without caring where it came from. A take with eleven taps in its
// document was told "no cursor track: only recordings made by Fetch can auto zoom"
// while the finger it claimed not to have was drawn on every frame.
//
// Two: nothing repainted. Auto zoom is an edit field rather than a look field, so it
// does not go through setLook, and the handler set the value and stopped. The switch
// moved, the stage kept drawing the old thing, and the only way to find out whether it
// had done anything was to export.
const fs = require('fs'), path = require('path')
const ROOT = path.join(__dirname, '..')
const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8')
const ed = fs.readFileSync(path.join(ROOT, 'ui/editor.js'), 'utf8')

let pass = 0, fail = 0
const is = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`)
}

const from = mainSrc.indexOf("ipcMain.handle('has-cursor'")
const fn = mainSrc.slice(from, mainSrc.indexOf('\n})', from) + 3)
is('has-cursor was found', fn.length > 80, true)
is('the sidecar still counts', /sidecarIn\(String\(src\), '\.cursor\.json'\)/.test(fn), true)
is('and so does a track in the document', /Array\.isArray\(doc\.pointer\) && doc\.pointer\.length/.test(fn), true)
is('a document that cannot be read is not a crash', /catch \{ return false \}/.test(fn), true)
is('the sidecar is checked first, since it costs a stat', fn.indexOf('sidecarIn') < fn.indexOf('readDoc'), true)

is('toggling auto zoom repaints the stage', /if \(e\.target\.id !== 'autoZoom'\) return[\s\S]{0,260}paintStageGL\(\{ fresh: true \}\)/.test(ed), true)
is('and redraws the zoom track', /if \(e\.target\.id !== 'autoZoom'\) return[\s\S]{0,320}renderZooms\(\)/.test(ed), true)
is('the value is still written', /ed\.autoZoom = e\.target\.checked/.test(ed), true)
is('a repaint that throws does not break the switch', /try \{ paintStageGL\(\{ fresh: true \}\) \} catch \{\}/.test(ed), true)

// the switch is only disabled when there really is no track
is('disabled only on a definite no', /ed\.hasCursor === false \? 'disabled' : ''/.test(ed), true)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
