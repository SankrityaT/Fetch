// Which renderer drew a preview, said out loud.
//
// preview_frame draws with the compositor, the renderer the export uses, and falls back
// to the classic one when that fails. The fallback was silent: the result carried a
// path and a time and nothing about where the picture came from. A classic frame is not
// the frame the export makes. It draws the agent's arrow where the compositor draws a
// finger, and it leaves out every look field marked classic, so an agent checking its
// own edit sees a picture the file will never hold, decides the edit is wrong and
// changes something that was right. Measured on a touch take: one moment came back with
// an arrow on it through the fallback and with the tap disc through the compositor.
const fs = require('fs'), path = require('path')
const ROOT = path.join(__dirname, '..')
const src = fs.readFileSync(path.join(ROOT, 'ui/agent-bridge.js'), 'utf8')
const host = fs.readFileSync(path.join(ROOT, 'ui/render-host.js'), 'utf8')

let pass = 0, fail = 0
const is = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`)
}

// the whole of the preview op, so a match cannot come from somewhere else in the file
const from = src.indexOf("async 'edit.preview'")
const op = from < 0 ? src.slice(src.indexOf('preview_frame')) : src.slice(from, src.indexOf('\n  },', from) + 4)
is('the preview op was found', op.length > 200, true)

is('every frame says which renderer drew it', /frames: frames\.map\(r => \(\{ image: r\.file, at: r\.at, engine \}\)\)/.test(op), true)
is('and so does the result', /const out = \{ image: frames\[0\]\.file, at: frames\[0\]\.at, engine,/.test(op), true)
is('the engine is read off the frame, never assumed', /frames\[0\]\.engine === 'gl' \? 'gl' : 'classic'/.test(op), true)
is('a fallback is named as not the export', /not_the_export/.test(op), true)
is('and says the taps come out as an arrow', /drawn as the agent\\?'s arrow rather than as a finger/.test(op), true)
is('and carries why the compositor could not draw it', /if \(fell\) out\.why = fell/.test(op), true)
is('it only says so when the two disagree', /if \(engine !== pick\.engine\)/.test(op), true)
is('the fallback is still silent on the happy path', /out\.not_the_export = /.test(op) && !/always/.test(op), true)

// the compositor's own frames have to carry the tag this reads
is('previewFrames marks its frames gl', /engine: 'gl' \}\)\)/.test(host), true)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
