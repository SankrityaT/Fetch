// The fonts a project ships, and the two things that have to be true about them.
//
// One: the family name comes out of the file, never off the filename. DMSans-VF.ttf is
// the "DM Sans" family and Onest-VF.ttf is "Onest"; a rule over the filename gets one
// of those right and the other wrong, and a family name that is wrong by a space is a
// font nothing can select.
//
// Two: a job that names a font carries the file with it. The compositor names faces by
// CSS family and a family the render window never registered falls back to system-ui
// with no error at all, so a missing file is a picture quietly in the wrong font.
const assert = require('assert'), fs = require('fs'), path = require('path'), os = require('os')
const pf = require('../ui/project-fonts')
const ROOT = path.join(__dirname, '..')

let pass = 0, fail = 0
const is = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`)
}

// ── a font file, built here, so this suite needs nothing installed ───────
// A minimal but real sfnt: a table directory with one 'name' table holding nameID 1.
function fontWith(family, id = 1) {
  const str = Buffer.from(family, 'utf16le').swap16()
  const name = Buffer.alloc(6 + 12 + str.length)
  name.writeUInt16BE(0, 0); name.writeUInt16BE(1, 2); name.writeUInt16BE(6 + 12, 4)
  name.writeUInt16BE(3, 6)           // platform 3, Windows
  name.writeUInt16BE(1, 8)           // encoding 1, UTF-16BE
  name.writeUInt16BE(0x409, 10)      // language
  name.writeUInt16BE(id, 12)         // nameID
  name.writeUInt16BE(str.length, 14)
  name.writeUInt16BE(0, 16)          // offset into the string storage
  str.copy(name, 18)
  const head = Buffer.alloc(12 + 16)
  head.writeUInt32BE(0x00010000, 0); head.writeUInt16BE(1, 4)
  head.write('name', 12, 'latin1')
  head.writeUInt32BE(0, 16)                      // checksum
  head.writeUInt32BE(head.length, 20)            // offset
  head.writeUInt32BE(name.length, 24)            // length
  return Buffer.concat([head, name])
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-fonts-'))
fs.mkdirSync(path.join(tmp, 'Resources', 'Fonts'), { recursive: true })
fs.mkdirSync(path.join(tmp, 'node_modules', 'junk'), { recursive: true })
// the filename and the family deliberately disagree, which is the whole point
fs.writeFileSync(path.join(tmp, 'Resources', 'Fonts', 'DMSans-VF.ttf'), fontWith('DM Sans'))
fs.writeFileSync(path.join(tmp, 'Resources', 'Fonts', 'Onest-VF.ttf'), fontWith('Onest'))
// a dependency's font is not the product's typeface and must not be offered
fs.writeFileSync(path.join(tmp, 'node_modules', 'junk', 'Vendored.ttf'), fontWith('Vendored'))

const found = pf.fontsIn(tmp)
const families = found.map(f => f.family).sort()
is('the family is read out of the file, not off its name', families, ['DM Sans', 'Onest'])
is('node_modules is not somebody\'s typeface', families.includes('Vendored'), false)
is('each family carries the file to load', found.every(f => fs.existsSync(f.file)), true)
is('familyOf reads one file', pf.familyOf(path.join(tmp, 'Resources', 'Fonts', 'Onest-VF.ttf')), 'Onest')
is('a file that is not a font is not one', pf.familyOf(path.join(__dirname, 'project-fonts.test.js')), null)
is('a folder that does not exist is no fonts, not a throw', pf.fontsIn(path.join(tmp, 'nope')), [])
is('nothing is not a root', pf.fontsIn(null), [])

// nameID 16, the typographic family, wins over nameID 1 where a font has both
const both = path.join(tmp, 'Resources', 'Fonts', 'Two.ttf')
fs.writeFileSync(both, fontWith('Typographic', 16))
is('the typographic family is read', pf.familyOf(both), 'Typographic')

// ── the job carries the file ─────────────────────────────────────────────
const hostSrc = fs.readFileSync(path.join(ROOT, 'ui/render-host.js'), 'utf8')
is('every render job is given the fonts it names', /send\('render:job', \{ \.\.\.msg, id, fonts: fontsWanted\(msg\) \}\)/.test(hostSrc), true)
is('a system face is never looked for in a project', /SYSTEM_FAMILY\.has\(x\)/.test(hostSrc), true)
is('a family is looked for once and the miss is kept', /fontFound\.set\(family, hit\)/.test(hostSrc), true)

const winSrc = fs.readFileSync(path.join(ROOT, 'ui/render-window.js'), 'utf8')
is('the window registers them before it draws', /if \(job\.fonts && job\.fonts\.length\) await useFonts\(job\.fonts\)/.test(winSrc), true)
is('a face that will not load is a warning, never a failed export', /console\.warn\('\[render\] font'/.test(winSrc), true)

// ── a title card uses the font it was given ──────────────────────────────
const textSrc = fs.readFileSync(path.join(ROOT, 'ui/compositor/text.js'), 'utf8')
is('the title takes the layer\'s font', /fontFor\('title', px, tt\.font\)/.test(textSrc), true)
is('and so does its subtitle', /fontFor\('sub', sp, tt\.font\)/.test(textSrc), true)
is('and the address pill', /fontFor\('title', pillFs, tt\.font\)/.test(textSrc), true)
is('a card with no font still falls back to SF Pro', /title: \{ weight: 600, family: 'SF Pro' \}/.test(textSrc), true)

// ── and an agent is told they exist ──────────────────────────────────────
const bridgeSrc = fs.readFileSync(path.join(ROOT, 'ui/agent-bridge.js'), 'utf8')
is('options.fonts offers the project faces too', /\.\.\.projectFontNames\(\)\]/.test(bridgeSrc), true)

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
