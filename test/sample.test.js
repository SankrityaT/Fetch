// The sample library: someone tries all of Fetch without recording anything, and their
// own library is never touched. ui/sample.js against real files in a temporary folder,
// with a real save folder beside it standing in for the person's, and one real export
// of the sample take through the processor.
//
//   node test/sample.test.js
const fs = require('fs'), os = require('os'), path = require('path')
const Sample = require('../ui/sample')
const Lib = require('../ui/library')
const p = require('../processor.js')
const { groupTakes } = require('../ui/take-list')

let pass = 0, fail = 0
const is = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}` + (ok ? '' : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`))
}
const yes = (name, v, why = '') => is(name + (v ? '' : ` ${why}`), !!v, true)

;(async () => {
  const A = Sample.ASSETS
  const m = Sample.manifest()

  console.log('=== what ships ===')
  is('three pieces: a Mac take, a phone take, a screenshot', m.items.map(i => [i.kind, i.platform]),
    [['take', 'Mac'], ['take', 'Phone'], ['shot', 'Mac']])
  const files = m.items.flatMap(i => [i.file, ...Object.values(i.sidecars || {})])
  yes('every file the manifest names is there', files.every(f => fs.existsSync(path.join(A, f))))
  const bytes = m.items.reduce((n, i) => n + fs.statSync(path.join(A, i.file)).size, 0)
  yes(`small enough not to bloat the app (${(bytes / 1e6).toFixed(2)} MB, under 2.5)`, bytes < 2.5e6)
  const notice = fs.readFileSync(path.join(A, 'NOTICE.md'), 'utf8')
  yes('a notice says who made it and under what license', /made by Fetch itself/.test(notice) && /GPL-3\.0-or-later/.test(notice) && /Open Font License/.test(notice))
  yes('the generator that drew it ships beside it', fs.existsSync(path.join(A, 'make', 'make.js')) && fs.existsSync(path.join(A, 'make', 'scene.html')))
  yes('every title is the made up product', m.items.every(i => i.title.startsWith(m.product + ' · ')))
  // the house rule, on every file this piece wrote
  const ours = [path.join(A, 'sample.json'), path.join(A, 'NOTICE.md'), path.join(A, 'make', 'make.js'), path.join(A, 'make', 'scene.html'),
    path.join(__dirname, '..', 'ui', 'sample.js'), __filename]
  is('no em dash in anything the sample wrote', ours.filter(f => fs.readFileSync(f, 'utf8').includes(String.fromCharCode(0x2014))).map(f => path.basename(f)), [])

  console.log('=== the pieces are real media ===')
  const mac = await p.probeMeta(path.join(A, 'pantry-recipe.mp4'))
  is('the Mac take is a window, 1920 by 1200', [mac.width, mac.height], [1920, 1200])
  yes('ten seconds long, with a sound track', Math.abs(mac.duration - 10) < 0.1 && mac.hasAudio, JSON.stringify(mac))
  const phone = await p.probeMeta(path.join(A, 'pantry-phone.mp4'))
  is('the phone take is its window, bezel and all', [phone.width, phone.height], [828, 1736])
  yes('eight seconds long, with a sound track', Math.abs(phone.duration - 8) < 0.1 && phone.hasAudio)
  const png = fs.readFileSync(path.join(A, 'pantry-card.png'))
  is('the screenshot is a 2x window, 2560 by 1600', [png.readUInt32BE(16), png.readUInt32BE(20)], [2560, 1600])
  is('with an alpha channel, so its corners can be cut out', png[25], 6)

  console.log('=== the pointer lands on what the picture shows ===')
  for (const [file, dur] of [['pantry-recipe', 10], ['pantry-phone', 8]]) {
    const ptr = JSON.parse(fs.readFileSync(path.join(A, file + '.pointer.json'), 'utf8'))
    const pts = ptr.points
    yes(`${file}: points in time order, inside the take`, pts.every((q, i) => q.t >= 0 && q.t <= dur && (!i || q.t > pts[i - 1].t)))
    yes(`${file}: every point inside the picture`, pts.every(q => q.x > 0 && q.x < 1 && q.y > 0 && q.y < 1))
    yes(`${file}: presses to zoom on and to draw`, pts.filter(q => q.click).length >= 4)
  }
  const doc = JSON.parse(fs.readFileSync(path.join(A, 'pantry-phone.fetchdoc.json'), 'utf8'))
  const g = doc.viewport
  const taps = JSON.parse(fs.readFileSync(path.join(A, 'pantry-phone.pointer.json'), 'utf8')).points.filter(q => q.click)
  yes('every tap on the phone is on its glass', taps.every(q => q.x > g.x && q.x < g.x + g.w && q.y > g.y && q.y < g.y + g.h))
  yes('the glass corner is written, so it is never measured off the bezel', g.corner > 0.1 && g.corner < 0.2)
  is('a made up phone: no maker, no family', [doc.device.name, 'family' in doc.device], ['Sample phone', false])

  // ── a person with a library of their own ─────────────────────────────────
  const box = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-sample-test-'))
  const save = path.join(box, 'Movies', 'Fetch')
  const own = path.join(save, 'Launch demo', 'Original')
  fs.mkdirSync(path.join(own, '.fetch'), { recursive: true })
  fs.writeFileSync(path.join(own, 'Launch demo.mov'), 'their take')
  fs.writeFileSync(path.join(own, '.fetch', 'Launch demo.fetchdoc.json'), '{"v":2}')
  fs.writeFileSync(path.join(save, 'Launch demo', 'Launch demo.mp4'), 'their export')
  const support = path.join(box, 'Application Support', 'Fetch')
  fs.mkdirSync(support, { recursive: true })
  const theirFiles = ['collections.json', 'library.json', 'prefs.json'].map(f => path.join(support, f))
  fs.writeFileSync(theirFiles[0], JSON.stringify({ folders: [{ id: 'f1', name: 'Launch', paths: [path.join(own, 'Launch demo.mov')] }], sources: {} }))
  fs.writeFileSync(theirFiles[2], JSON.stringify({ saveDir: save, systemAudio: true }))
  const before = Sample.fingerprint([save], theirFiles)
  const root = path.join(box, 'Fetch Sample')

  try {
    console.log('=== where the sample may live ===')
    yes('not inside the save folder', /inside/.test(Sample.refusal(path.join(save, 'Sample'), [save])))
    yes('not in a folder that holds the save folder', /holds/.test(Sample.refusal(path.join(box, 'Movies'), [save])))
    yes('not the save folder itself', !!Sample.refusal(save, [save]))
    yes('not a home folder', !!Sample.refusal(os.homedir(), []))
    yes('not a relative path', !!Sample.refusal('Fetch Sample', []))
    const theirsElse = path.join(box, 'Projects')
    fs.mkdirSync(theirsElse); fs.writeFileSync(path.join(theirsElse, 'notes.txt'), 'mine')
    yes('not a folder already holding something else', /not the sample/.test(Sample.refusal(theirsElse, [save])))
    let threw = null
    try { Sample.open({ root: path.join(save, 'Sample'), theirs: [save] }) } catch (e) { threw = e.message }
    yes('open refuses, and says why', /holds your own takes/.test(threw || ''))
    is('and made nothing there', fs.existsSync(path.join(save, 'Sample')), false)
    is('close will not delete a folder that is not the sample', Sample.close(theirsElse, [save]).removed, false)
    is('which is left exactly as it was', fs.readFileSync(path.join(theirsElse, 'notes.txt'), 'utf8'), 'mine')

    console.log('=== opening it ===')
    const s = Sample.open({ root, theirs: [save], now: Date.parse('2026-09-21T10:00:00Z') })
    is('three take folders, named for the product and what happens', fs.readdirSync(root).filter(f => !f.startsWith('.')).sort(),
      m.items.map(i => i.title).sort())
    yes('laid out as a take is: <Take>/Original/<Take>', s.items.every(i => i.path === path.join(root, i.title, 'Original', i.title + path.extname(i.path))))
    yes('each with its sidecars in .fetch', fs.existsSync(path.join(root, m.items[1].title, 'Original', '.fetch', m.items[1].title + '.pointer.json')))
    const phoneItem = s.items.find(i => i.id === 'phone')
    const read = p.readDoc(phoneItem.path, 8)
    is('the phone take opens knowing where its glass is', [read.viewport && read.viewport.corner, read.device && read.device.name], [g.corner, 'Sample phone'])
    is('and its edit names the copy, not the asset', read.src, phoneItem.path)
    is('the agent\'s pointer is read as the take\'s', (p.pointerTrack(s.items[0].path) || { points: [] }).points.length,
      JSON.parse(fs.readFileSync(path.join(A, 'pantry-recipe.pointer.json'), 'utf8')).points.length)

    console.log('=== the Library while it is open ===')
    const list = Sample.list(root)
    is('it lists the sample and nothing of the person\'s', list.length, 3)
    yes('every entry is inside the sample', list.every(e => Sample.within(root, e.path) && e.sample))
    const groups = groupTakes(list)
    is('three cards, newest first in the order they were made up', groups.map(x => path.basename(x.take)), m.items.map(i => i.title))
    is('two recordings and a screenshot', groups.map(x => Lib.kindOf(x)), ['take', 'take', 'shot'])
    is('the phone reads as a phone', groups.map(x => Lib.platformOf(x)), ['Mac', 'Phone', 'Mac'])
    is('the count says so', Lib.countLabel(groups), '1 shot · 2 takes')
    is('a list asked for with no sample open is empty, never the person\'s', Sample.list(path.join(box, 'nowhere')), [])

    console.log('=== an export lands inside the sample ===')
    is('a take\'s deliverable is its own sample folder', p.deliverablePath(s.items[0].path, 'mp4'),
      path.join(root, s.items[0].title, s.items[0].title + '.mp4'))
    is('and a screenshot\'s too', p.deliverablePath(s.items[2].path, 'png'), path.join(root, s.items[2].title, s.items[2].title + '.png'))
    // a real export of the sample take, through the same processor an agent's goes through
    const out = await p.applyEdit(s.items[0].path, { start: 1.2, end: 4.2, scale: 720, loudnorm: false, format: 'mp4' })
    const file = (out && (out.file || out.out || out.path)) || p.deliverablePath(s.items[0].path, 'mp4')
    yes('a cut of the sample take exports', fs.existsSync(file), JSON.stringify(out))
    yes('into the sample, beside nothing of the person\'s', Sample.within(root, file))
    const made = await p.probeMeta(file)
    yes('three seconds of it, with its sound', Math.abs(made.duration - 3) < 0.2 && made.hasAudio, JSON.stringify(made))
    const after1 = groupTakes(Sample.list(root))
    is('and the Library shows it as that take\'s export', after1[0].derived.map(d => path.basename(d.path)), [s.items[0].title + '.mp4'])
    is('still three cards', after1.length, 3)

    console.log('=== the Library\'s folders are set aside, then put back ===')
    Lib._setFolders([{ id: 'f1', name: 'Launch', paths: ['/theirs/Launch demo.mov'] }])
    Lib._setSources({ '/theirs/b.png': { path: '/theirs/Launch demo.mov', at: 3 } })
    Lib._setView({ query: 'launch', sort: 'name' })
    Lib.enterSample(root)
    is('the sample starts with no folders', Lib._folders(), [])
    is('and a view of everything', [Lib._view().query, Lib._view().sort], ['', 'new'])
    is('it knows it is in the sample', [Lib.inSample(), Lib.sampleRoot()], [true, root])
    Lib._setFolders([{ id: 'x', name: 'Sample folder', paths: [s.items[0].path] }])
    Lib.leaveSample()
    is('leaving puts the person\'s folders back exactly', Lib._folders(), [{ id: 'f1', name: 'Launch', paths: ['/theirs/Launch demo.mov'] }])
    is('and where each thing came from', Lib._sources(), { '/theirs/b.png': { path: '/theirs/Launch demo.mov', at: 3 } })
    is('and the view they had', [Lib._view().query, Lib._view().sort], ['launch', 'name'])
    is('and it is out of the sample', Lib.inSample(), false)
    Lib.leaveSample()
    is('leaving twice changes nothing', Lib._folders().length, 1)
    // a duplicate made inside the sample stays in the sample
    Lib.enterSample(root)
    const dup = await Lib.duplicate(groups[2], { taken: groups.map(x => path.basename(x.take)) })
    yes('a duplicate made in the sample lands in the sample', Sample.within(root, dup.path), dup.path)
    Lib.leaveSample()

    console.log('=== reopening starts clean ===')
    const again = Sample.open({ root, theirs: [save] })
    is('what an earlier visit made is gone', fs.readdirSync(root).filter(f => !f.startsWith('.')).length, 3)
    is('its export too', fs.existsSync(p.deliverablePath(again.items[0].path, 'mp4')), false)

    console.log('=== leaving ===')
    is('close deletes the sample', Sample.close(root, [save]), { removed: true })
    is('nothing of it is left', fs.existsSync(root), false)
    is('closing again says so and does nothing', Sample.close(root, [save]).removed, false)
    const after = Sample.fingerprint([save], theirFiles)
    is('the person\'s save folder and settings are exactly as before', after.digest, before.digest)
    yes('and the fingerprint looked at their files', after.entries >= 6, String(after.entries))
    // the fingerprint notices a change, or it would prove nothing
    fs.writeFileSync(path.join(save, 'Launch demo', 'Launch demo.mp4'), 'their export, again')
    yes('a changed file changes the fingerprint', Sample.fingerprint([save], theirFiles).digest !== before.digest)

    console.log('=== a late export after leaving ===')
    // An export still running when the sample was deleted remakes its take's folders
    // (processor sidecarOut) with no marker. The next open clears that, not refuses it.
    const late = Sample.open({ root, theirs: [save] })
    Sample.close(root, [save])
    fs.mkdirSync(path.join(root, late.items[0].title, 'Original', '.fetch'), { recursive: true })
    is('a folder a late export remade is the sample\'s leftover', Sample.leftover(root), true)
    is('and the sample opens over it again', Sample.open({ root, theirs: [save] }).items.length, 3)
    Sample.close(root, [save])
    fs.mkdirSync(path.join(root, 'Not a sample take'), { recursive: true })
    yes('a folder holding anything else is still refused', /not the sample/.test(Sample.refusal(root, [save]) || ''))
    fs.rmSync(root, { recursive: true, force: true })

    console.log('=== the activity log ===')
    const Act = require('../ui/activity-log')
    const log = Act.logPath(), was = fs.existsSync(log) ? fs.readFileSync(log) : null
    try {
      fs.writeFileSync(log, '{"at":1,"op":"export","title":"theirs","by":null}\n')
      const plain = fs.readFileSync(log, 'utf8')
      Act.sampleOpen(true)
      Act.record({ op: 'edit.export', title: 'Exported the sample', by: 'Claude Code' })
      yes('a row while the sample is open is marked as the sample\'s', Act.read(1)[0].sample === true)
      is('leaving drops it', Act.sampleOpen(false), 1)
      is('and leaves the log as it was, byte for byte', fs.readFileSync(log, 'utf8'), plain)
      Act.record({ op: 'x', title: 'after' })
      is('a row after leaving is not marked', Act.read(1)[0].sample, undefined)
    } finally { if (was) fs.writeFileSync(log, was); else fs.rmSync(log, { force: true }) }
  } finally {
    fs.rmSync(box, { recursive: true, force: true })
  }

  console.log(`\n  ${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
})().catch(e => { console.error(e); process.exit(1) })
