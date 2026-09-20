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

// ── the library holds two kinds ───────────────────────────────────────────
// ui/library.js required with no DOM: headless it draws nothing, reads none of the
// person's folders and writes none of them, so these run anywhere.
const Lib = require('../ui/library')

const T = ms => new Date(ms).getTime()
const NOW = new Date('2026-09-18T15:00:00-07:00')
const DAY = 86400000
const item = (over = {}) => ({ name: 'Demo.mov', path: '/Users/me/Movies/Fetch/Demo/Original/Demo.mov', ext: 'mov', mb: 12, mtime: NOW.getTime(), ...over })
const g = (over = {}, derived = []) => ({ take: null, original: item(over), derived, copy: null })
const shot = (over = {}, derived = []) => g({ name: 'Shot.png', path: '/Users/me/Movies/Fetch/Shot/Shot.png', ext: 'png', mb: 1.4, ...over }, derived)
const reset = () => { Lib._setFolders([]); Lib._setView({ folder: 'all', kind: 'all', platform: 'all', query: '', sort: 'new' }) }

console.log('=== a shot and a take are told apart by what was captured ===')
reset()
is('a video is a recording', Lib.kindOf(g()), 'take')
is('a still is a screenshot', Lib.kindOf(shot()), 'shot')
is('a JPEG too', Lib.kindOf(shot({ name: 'Shot.jpg', ext: 'jpg' })), 'shot')
is('a styled screenshot is still a screenshot', Lib.kindOf(shot({}, [item({ name: 'Shot-styled.png', ext: 'png' })])), 'shot')
is('an edited take is still a recording', Lib.kindOf(g({}, [item({ name: 'Demo.mp4', ext: 'mp4' })])), 'take')
is('a capture that says what it is is believed', Lib.kindOf(g({ kind: 'shot', ext: '' })), 'shot')
is('a bare item works as well as a card', Lib.kindOf(item({ ext: 'png' })), 'shot')
is('no extension at all is a recording, as the library always was', Lib.kindOf(g({ name: 'Demo', ext: '' })), 'take')

console.log('=== platform is a tag, and it never names a make ===')
is('what Fetch captured came off this Mac', Lib.platformOf(shot()), 'Mac')
is('an import claims nothing', Lib.platformOf(g({ imported: true })), null)
is('a handset frame is a phone', Lib.platformOf(shot({ device: 'phone' })), 'Phone')
is('a browser frame is the web', Lib.platformOf(shot({ device: 'browser' })), 'Web')
is('the capture path has the last word', Lib.platformOf(shot({ device: 'phone', platform: 'Tablet' })), 'Tablet')
is('one platform is listed once', Lib.platformsIn([shot(), g(), shot({ device: 'phone' })]), ['Mac', 'Phone'])
is('a platform nobody claims is not invented', Lib.platformsIn([g({ imported: true })]), [])

console.log('=== the gallery reads as days ===')
is('today', Lib.dayLabel(NOW.getTime(), NOW), 'Today')
is('yesterday', Lib.dayLabel(NOW.getTime() - DAY, NOW), 'Yesterday')
is('this week says which day', Lib.dayLabel(NOW.getTime() - 3 * DAY, NOW), 'Tuesday')
is('further back says the date', Lib.dayLabel(NOW.getTime() - 20 * DAY, NOW), 'Aug 29')
is('another year says which', Lib.dayLabel(T(new Date('2024-09-12T10:00:00-07:00')), NOW), 'Sep 12 2024')
is('late and early the same day are one heading',
  Lib.dayLabel(T(new Date('2026-09-18T23:30:00-07:00')), NOW), Lib.dayLabel(T(new Date('2026-09-18T00:30:00-07:00')), NOW))
{
  reset()
  const list = [shot({ mtime: NOW.getTime() }), g({ mtime: NOW.getTime() - 3600000 }), g({ mtime: NOW.getTime() - DAY })]
  const days = Lib.byDay(Lib.filterGroups(list), NOW)
  is('two days, newest first', days.map(d => [d.label, d.items.length]), [['Today', 2], ['Yesterday', 1]])
  is('the spans line up with the cards', Lib.daySpans(Lib.filterGroups(list), NOW).map(d => d.n), [2, 1])
  Lib._setView({ sort: 'name' })
  is('sorted by name there are no day headings', Lib.byDay(Lib.filterGroups(list), NOW).map(d => d.label), [''])
  reset()
}

console.log('=== sort and filter ===')
{
  const a = shot({ name: 'Alpha.png', path: '/x/Alpha.png', mtime: 300, mb: 9 })
  const b = g({ name: 'Zulu.mov', path: '/x/Zulu.mov', mtime: 200, mb: 40 })
  const c = g({ name: 'Mike.mov', path: '/x/Mike.mov', mtime: 100, mb: 1, device: 'phone' })
  const all = [a, b, c]
  const names = list => list.map(x => Lib.stemOf(x))
  reset()
  is('newest first by default', names(Lib.filterGroups(all)), ['Alpha', 'Zulu', 'Mike'])
  Lib._setView({ sort: 'old' }); is('oldest first', names(Lib.filterGroups(all)), ['Mike', 'Zulu', 'Alpha'])
  Lib._setView({ sort: 'name' }); is('by name', names(Lib.filterGroups(all)), ['Alpha', 'Mike', 'Zulu'])
  Lib._setView({ sort: 'size' }); is('largest first', names(Lib.filterGroups(all)), ['Zulu', 'Alpha', 'Mike'])
  reset()
  Lib._setView({ kind: 'shot' }); is('screenshots only', names(Lib.filterGroups(all)), ['Alpha'])
  Lib._setView({ kind: 'take' }); is('recordings only', names(Lib.filterGroups(all)), ['Zulu', 'Mike'])
  reset()
  Lib._setView({ platform: 'Phone' }); is('one platform', names(Lib.filterGroups(all)), ['Mike'])
  reset()
  Lib._setView({ query: 'ul' }); is('search matches part of a name', names(Lib.filterGroups(all)), ['Zulu'])
  Lib._setView({ query: 'ZU' }); is('and ignores case', names(Lib.filterGroups(all)), ['Zulu'])
  reset()
  // a folder holds both kinds: one product, its shots and its takes together
  Lib._setFolders([{ id: 'f1', name: 'Songscription', paths: ['/x/Alpha.png', '/x/Zulu.mov'] }])
  Lib._setView({ folder: 'f1' })
  is('a folder holds shots and takes alike', names(Lib.filterGroups(all)), ['Alpha', 'Zulu'])
  Lib._setView({ folder: 'f1', kind: 'shot' })
  is('and the kind switch cuts inside it', names(Lib.filterGroups(all)), ['Alpha'])
  Lib._setFolders([])
  Lib._setView({ folder: 'f1', kind: 'all' })
  is('a folder deleted under the view falls back to everything', names(Lib.filterGroups(all)).length, 3)
  reset()
  is('the count says what kind of library this is', Lib.countLabel(all), '1 shot · 2 takes')
  is('one kind on its own says only itself', Lib.countLabel([b, c]), '2 takes')
  is('and one of them is singular', Lib.countLabel([a]), '1 shot')
  is('an empty library still reads', Lib.countLabel([]), '0 takes')
}

console.log('=== provenance: what it came from, what came out of it ===')
{
  reset()
  const take = g({ name: 'Demo.mov', path: '/x/Demo.mov', mtime: NOW.getTime() - DAY, mb: 40 })
  const still = shot({ name: 'Tempo.png', path: '/x/Tempo.png', mb: 1.2, width: 2560, height: 1440,
    from: { path: '/x/Demo.mov', at: 74 }, mtime: NOW.getTime() })
  const rows = Lib.infoRows(still, [take, still], NOW)
  const value = label => (rows.find(r => r.label === label) || {}).value
  is('it says it is a screenshot', value('Kind'), 'Screenshot')
  is('and what it was styled from, at the second it came from', value('Styled from'), 'Demo, at 1:14')
  is('its real size in pixels', value('Size'), '2560 × 1440')
  is('what it costs on disk', value('On disk'), '1.2 MB')
  is('when the shutter went', value('Captured'), 'Sep 18, 3:00 PM')
  is('the take says what was made from it', (Lib.infoRows(take, [take, still], NOW).find(r => r.label === 'Used to make') || {}).value, 'Tempo')
  is('a take with no parent claims none', Lib.infoRows(take, [take], NOW).some(r => r.label === 'Cut from'), false)
  Lib._setFolders([{ id: 'f1', name: 'Songscription', paths: ['/x/Tempo.png'] }])
  is('and the folders it is in', (Lib.infoRows(still, [take, still], NOW).find(r => r.label === 'Folder') || {}).value, 'Songscription')
  reset()
  const edited = g({ name: 'Demo.mov', path: '/x/Demo.mov', mtime: NOW.getTime() - DAY, mb: 40 },
    [item({ name: 'Demo.mp4', path: '/x/Demo.mp4', ext: 'mp4', mb: 8, mtime: NOW.getTime() })])
  const er = Lib.infoRows(edited, [edited], NOW)
  is('a take counts its exports on disk', (er.find(r => r.label === 'On disk') || {}).value, '48 MB')
  is('and says when it last exported', (er.find(r => r.label === 'Last export') || {}).value, 'Sep 18, 3:00 PM')
  reset()
}

console.log(`\n  ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
