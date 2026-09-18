// The Library reads as takes: one card per recording, titled and labelled for a
// person. Pure rules from ui/take-list.js, plus listRecordings against real files.
process.env.TZ = 'America/Los_Angeles'          // titles are local time; pin it
const { groupTakes, legacyTitle, takeTitle, takeWhere, takeRows, exportLabel, libraryColumns, dealColumns } = require('../ui/take-list')
const p = require('../processor.js')
const fs = require('fs'), os = require('os'), path = require('path')

let pass = 0, fail = 0
const is = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}` + (ok ? '' : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`))
}

console.log('=== naming a legacy take ===')
const now = new Date('2026-09-18T12:00:00-07:00')
is('a timestamp name reads as a date', legacyTitle('recording-1789696464142', now), 'Recording, Sep 17, 6:54 PM')
is('another year says which', legacyTitle('recording-1726624440000', now), 'Recording, Sep 17 2024, 6:54 PM')
is('morning is AM, noon hour is 12', legacyTitle(`recording-${new Date('2026-03-02T00:05:00-08:00').getTime()}`, now), 'Recording, Mar 2, 12:05 AM')
is('a name someone typed is not touched', legacyTitle('Launch demo', now), null)
is('nor one that only starts with recording-', legacyTitle('recording-policy-demo', now), null)
is('nor a timestamp with an export suffix', legacyTitle('recording-1789699251490-edit', now), null)
is('a take folder card uses it', takeTitle({ take: '/x/recording-1789699251490', original: { name: 'recording-1789699251490.mov' } }, now), 'Recording, Sep 17, 7:40 PM')
is('a loose card too', takeTitle({ take: null, original: { name: 'recording-1789699251490.mov' } }, now), 'Recording, Sep 17, 7:40 PM')
is('a named take keeps its name', takeTitle({ take: '/x/Linear · Issue 42', original: { name: 'Linear · Issue 42.mov' } }, now), 'Linear · Issue 42')
is('a card headed by an export still reads as a date', takeTitle({ take: null, original: { name: 'recording-1789699251490-edit.mp4' } }, now), 'Recording, Sep 17, 7:40 PM')
is('the old default prefix is not part of a typed name', takeTitle({ take: null, original: { name: 'recording-policy-demo.mp4' } }, now), 'policy-demo')

console.log('=== the masonry reads newest first, row by row ===')
is('three columns fit 1176 wide', libraryColumns(1176), 3)
is('never more than four', libraryColumns(2400), 4)
is('never fewer than one', [libraryColumns(200), libraryColumns(0)], [1, 1])
is('the columns the old CSS rule gave', [libraryColumns(595), libraryColumns(596), libraryColumns(1208)], [1, 2, 4])
is('the newest takes make the top row', dealColumns(['a', 'b', 'c', 'd', 'e', 'f', 'g'], 3).map(c => c[0]), ['a', 'b', 'c'])
is('and each column stays newest first', dealColumns(['a', 'b', 'c', 'd', 'e', 'f', 'g'], 3), [['a', 'd', 'g'], ['b', 'e'], ['c', 'f']])

console.log('=== grouping and labels ===')
const f = (full, extra = {}) => ({ name: path.basename(full), path: full, ext: path.extname(full).slice(1), mtime: 1, ...extra })
const D = '/Users/me/Desktop'
{
  const groups = groupTakes([
    f(`${D}/recording-1789699251490.mov`, { mtime: 5 }),
    f(`${D}/recording-1789699251490-converted.mp4`, { mtime: 6 }),
    f(`${D}/recording-1789699251490-edit.mp4`, { mtime: 7 }),
    f(`${D}/recording-1789699251490.mov`, { mtime: 5 }),            // listed twice
  ])
  is('a loose take and its exports are one card', groups.length, 1)
  is('the same path twice is one file', groups[0].derived.length, 2)
  is('the -edit export reads as Export', exportLabel(groups[0].derived.find(d => /edit/.test(d.name)), groups[0]), 'Export')
  is('the -converted copy reads as MP4 copy', exportLabel(groups[0].derived.find(d => /converted/.test(d.name)), groups[0]), 'MP4 copy')
  is('a loose card says where it lives', takeWhere(groups[0], '/Users/me'), 'Desktop')
  const at = dir => takeWhere({ take: null, original: { path: dir + '/a.mp4' } }, '/Users/me')
  is('an import from /tmp reads as its path, not a bare folder name', at('/tmp/nt'), '/tmp/nt')
  is('a folder in home is tilded', at('/Users/me/clips'), '~/clips')
  is('a deep folder keeps its last two parts', at('/Users/me/Projects/site/demo/clips'), '…/demo/clips')
  is('a file right in home', at('/Users/me'), '~')
}
{
  const groups = groupTakes([f(`${D}/demo.mp4`), f('/Users/me/Movies/demo.mp4')])
  is('the same name in two folders is two takes', groups.length, 2)
}
{
  const T = '/Users/me/Movies/Fetch/Demo'
  const g = groupTakes([
    f(`${T}/Original/Demo.mov`, { take: T, mtime: 1 }),
    f(`${T}/Demo.mp4`, { take: T, deliverable: true, mtime: 3 }),
    f(`${T}/Demo.gif`, { take: T, deliverable: true, mtime: 2 }),
    f(`${T}/Original/Demo-cut.mp4`, { take: T, mtime: 2 }),
  ])[0]
  is('a take folder is one card', !!g && g.original.name, 'Demo.mov')
  is('its deliverable is an Export', exportLabel(g.derived.find(d => d.name === 'Demo.mp4'), g), 'Export')
  is('a GIF deliverable says so', exportLabel(g.derived.find(d => d.name === 'Demo.gif'), g), 'GIF export')
  is('a working version says what was done', exportLabel(g.derived.find(d => /cut/.test(d.name)), g), 'Dead air removed')
  is('a take folder needs no location', takeWhere(g), '')
  is('autoConvertMp4 output is an MP4 copy', exportLabel(f(`${T}/Demo.mp4`, { take: T, copy: true }), g), 'MP4 copy')
  const withCopy = groupTakes([f(`${T}/Original/Demo.mov`, { take: T, mtime: 1 }), f(`${T}/Demo.mp4`, { take: T, deliverable: true, copy: true, mtime: 2 })])[0]
  is('a take folder lists its MP4 copy as a row', takeRows(withCopy).map(d => exportLabel(d, withCopy)), ['MP4 copy'])
  is('but it is not counted as an export', withCopy.derived.length, 0)
}

console.log('=== listRecordings: one entry per file ===')
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-lib-'))
const root = path.join(base, 'Fetch')
const loose = path.join(base, 'Loose')
p.setTakesRoot(() => root)
const touch = file => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'x'); return file }
try {
  const raw = touch(path.join(root, 'Demo', 'Original', 'Demo.mov'))
  touch(path.join(root, 'Demo', 'Original', '.fetch', 'Demo.cursor.json'))
  const deliverable = touch(path.join(root, 'Demo', 'Demo.mp4'))
  // the same files again, through a symlinked folder, as an older import left them
  const alias = path.join(base, 'alias')
  fs.symlinkSync(root, alias)
  const aliasRaw = path.join(alias, 'Demo', 'Original', 'Demo.mov')
  const aliasDel = path.join(alias, 'Demo', 'Demo.mp4')
  // a renamed loose take of Fetch's own, with its export beside it, and a real import
  const own = touch(path.join(loose, 'Standup.mov'))
  touch(path.join(loose, '.fetch', 'Standup.cursor.json'))
  const ownEdit = touch(path.join(loose, 'Standup-edit.mp4'))
  touch(path.join(loose, 'Standup notes.mp4'))                 // a different take, not an export
  const imported = touch(path.join(loose, 'client.mp4'))

  const list = p.listRecordings(root, [aliasRaw, aliasDel, own, imported])
  // the real ~/Movies/Fetch is scanned too (a "Songscription Demo" there once failed this)
  const paths = list.map(c => c.path).filter(x => x.startsWith(base))
  is('a file reached through a symlink is not listed twice', paths.filter(x => /Demo\.(mov|mp4)$/.test(x)).length, 2)
  is('the take folder spelling wins', paths.includes(raw) && paths.includes(deliverable), true)
  is('so nothing reads as imported for it', list.filter(c => /Demo/.test(c.name) && c.imported).length, 0)
  is('a renamed take of Fetch\'s own is not an import', !!list.find(c => c.path === own && !c.imported), true)
  is('its export beside it comes along', paths.includes(ownEdit), true)
  is('a file that only shares the start of its name does not', paths.some(x => /Standup notes/.test(x)), false)
  is('a real import still says so', !!list.find(c => c.path === imported && c.imported), true)
  // the real Desktop and ~/Movies/Fetch are scanned too; only this test's files count
  const cards = groupTakes(list.filter(c => c.path.startsWith(base)))
  is('the Library draws one card per take', cards.map(g => takeTitle(g)).sort(), ['Demo', 'Standup', 'client'])
} finally {
  fs.rmSync(base, { recursive: true, force: true })
}

console.log(`\n  ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
