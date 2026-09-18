// Take folders: where exports land, and what a rename moves. Runs against real files in
// a temp root, with short synthetic clips made by the bundled ffmpeg.
const p = require('../processor.js')
const fs = require('fs'), os = require('os'), path = require('path')
const { execFileSync } = require('child_process')

let pass = 0, fail = 0
const is = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}` + (ok ? '' : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`))
}
const exists = f => fs.existsSync(f)

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-takes-'))
const root = path.join(base, 'Fetch')
fs.mkdirSync(root)
p.setTakesRoot(() => root)

const clip = file => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  execFileSync(p.FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=15:d=2',
    '-f', 'lavfi', '-i', 'sine=f=440:d=2', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', file])
  return file
}
// a take as native-commit writes it, with the sidecars Fetch leaves beside it
function take(stem) {
  const raw = clip(path.join(root, stem, 'Original', stem + '.mov'))
  const side = path.join(root, stem, 'Original', '.fetch')
  fs.mkdirSync(side, { recursive: true })
  fs.writeFileSync(path.join(side, stem + '.cam.mov'), 'cam')
  fs.writeFileSync(path.join(side, stem + '.srt'), '1\n00:00:00,000 --> 00:00:01,000\nhi\n')
  fs.writeFileSync(path.join(side, stem + '.cam.json'), JSON.stringify({ file: path.join(side, stem + '.cam.mov') }))
  fs.writeFileSync(path.join(side, stem + '.fetchdoc.json'),
    JSON.stringify({ v: 1, camera: { on: true, file: path.join(side, stem + '.cam.mov') } }))
  return raw
}

;(async () => {
  try {
    console.log('=== where things land ===')
    const raw = take('recording-1789000000001')
    const t1 = path.join(root, 'recording-1789000000001')
    is('a file in Original/ belongs to its take', p.takeDir(raw), t1)
    is('the deliverable is named after the take', p.deliverablePath(raw, 'mp4'), path.join(t1, 'recording-1789000000001.mp4'))

    const ex = await p.applyEdit(raw, { loudnorm: false })
    is('export writes the deliverable on top', ex.file, path.join(t1, 'recording-1789000000001.mp4'))
    is('and nothing -edit beside the raw take', exists(path.join(t1, 'Original', 'recording-1789000000001-edit.mp4')), false)
    is('the deliverable belongs to the take too', p.takeDir(ex.file), t1)

    const again = await p.applyEdit(ex.file, { loudnorm: false, start: 0, end: 1 })
    is('re-exporting the deliverable overwrites it in place', again.file, ex.file)
    is('with no half-written file left behind', fs.readdirSync(t1).filter(f => /partial/.test(f)), [])

    // a cancelled re-export leaves the last good deliverable exactly as it was
    const before = fs.statSync(ex.file).size
    const job = p.applyEdit(raw, { loudnorm: false, zooms: [{ at: 0, dur: 2, scale: 2 }] }, null, 'cancel-me')
    // kill it the moment the encode opens its output, so it is always mid-way
    const m0 = fs.statSync(ex.file).mtimeMs
    const writing = () => fs.readdirSync(t1).some(f => /partial/.test(f)) || fs.statSync(ex.file).mtimeMs !== m0
    for (let i = 0; i < 2000 && !writing(); i++) await new Promise(r => setTimeout(r, 2))
    p.cancel('cancel-me')
    await job.catch(() => {})
    is('a cancelled export keeps the last deliverable', [exists(ex.file) && fs.statSync(ex.file).size], [before])
    is('and leaves nothing half-written', fs.readdirSync(t1).filter(f => /partial/.test(f)), [])

    const gif = await p.applyEdit(raw, { format: 'gif', loudnorm: false, start: 0, end: 1 })
    is('another format is the same name, its own extension', gif.file, path.join(t1, 'recording-1789000000001.gif'))

    const cut = await p.trim(raw, 0, 1)
    is('a working version stays in Original/', cut.file, path.join(t1, 'Original', 'recording-1789000000001-trim.mp4'))

    const conv = await p.convert(raw, { format: 'mp4' })
    is('convert never overwrites an existing deliverable', conv.file, path.join(t1, 'Original', 'recording-1789000000001-converted.mp4'))
    fs.unlinkSync(conv.file)

    const listed = p.listRecordings(root).filter(c => c.take === t1)
    is('the library finds the raw take, its working version and both deliverables',
      listed.map(c => path.relative(t1, c.path)).sort(),
      ['Original/recording-1789000000001-trim.mp4', 'Original/recording-1789000000001.mov',
       'recording-1789000000001.gif', 'recording-1789000000001.mp4'])
    is('deliverables are marked', listed.filter(c => c.deliverable).length, 2)

    console.log('=== renaming a take ===')
    const r = p.renameTake(raw, 'Linear · Triage')
    const t2 = path.join(root, 'Linear · Triage')
    is('returns the raw take at its new path', r.path, path.join(t2, 'Original', 'Linear · Triage.mov'))
    is('the old folder is gone', exists(t1), false)
    is('the deliverables follow', [exists(path.join(t2, 'Linear · Triage.mp4')), exists(path.join(t2, 'Linear · Triage.gif'))], [true, true])
    is('working versions keep their suffix', exists(path.join(t2, 'Original', 'Linear · Triage-trim.mp4')), true)
    is('sidecars move with the raw take',
      ['.cam.mov', '.srt', '.cam.json', '.fetchdoc.json'].map(e => exists(path.join(t2, 'Original', '.fetch', 'Linear · Triage' + e))),
      [true, true, true, true])
    const cam = JSON.parse(fs.readFileSync(path.join(t2, 'Original', '.fetch', 'Linear · Triage.cam.json'), 'utf8'))
    is('the camera sidecar points at the moved camera take', cam.file, path.join(t2, 'Original', '.fetch', 'Linear · Triage.cam.mov'))
    const doc = JSON.parse(fs.readFileSync(path.join(t2, 'Original', '.fetch', 'Linear · Triage.fetchdoc.json'), 'utf8'))
    is('so does the edit document', doc.camera.file, cam.file)
    is('every move is reported', r.moves.some(([a, b]) => a === raw && b === r.path), true)
    is('the edit reads back from the new path', p.readDoc(r.path, 2).camera.file, cam.file)

    const raw2 = take('recording-1789000000002')
    const auto = await p.toMp4(raw2)
    is('auto-convert writes the deliverable, not a -converted copy', auto.file,
      path.join(root, 'recording-1789000000002', 'recording-1789000000002.mp4'))
    // that MP4 is the take itself, not something the person exported
    const top = dir => p.listRecordings(root).find(c => c.take === dir && path.dirname(c.path) === dir)
    is('and it is listed as a copy, not an export', !!top(path.join(root, 'recording-1789000000002')).copy, true)
    const auto2 = await p.toMp4(raw2)
    is('but never replaces a deliverable that is already there', auto2.file,
      path.join(root, 'recording-1789000000002', 'Original', 'recording-1789000000002-converted.mp4'))
    fs.unlinkSync(auto2.file)
    const r2 = p.renameTake(raw2, 'Linear · Triage')
    is('a taken name becomes "Name 2"', r2.path, path.join(root, 'Linear · Triage 2', 'Original', 'Linear · Triage 2.mov'))
    is('it is still a copy after a rename', !!top(path.join(root, 'Linear · Triage 2')).copy, true)
    await p.applyEdit(r2.path, { loudnorm: false, start: 0, end: 1 })
    is('an export over it is an export', !!top(path.join(root, 'Linear · Triage 2')).copy, false)

    const viaDeliverable = p.renameTake(path.join(t2, 'Linear · Triage.mp4'), 'Final cut')
    is('renaming by the deliverable moves the whole take', viaDeliverable.path, path.join(root, 'Final cut', 'Final cut.mp4'))
    is('raw take included', exists(path.join(root, 'Final cut', 'Original', 'Final cut.mov')), true)

    const same = p.renameTake(path.join(root, 'Final cut', 'Original', 'Final cut.mov'), 'Final cut')
    is('renaming to the same name is a no-op', [same.path, same.moves.length], [path.join(root, 'Final cut', 'Original', 'Final cut.mov'), 0])

    const cased = p.renameTake(path.join(root, 'Final cut', 'Original', 'Final cut.mov'), 'Final Cut')
    is('a change of case is not a clash', cased.path, path.join(root, 'Final Cut', 'Original', 'Final Cut.mov'))

    let threw = null
    try { p.renameTake(cased.path, 'a/b') } catch (e) { threw = e.message }
    is('a name with a slash is refused', !!threw, true)

    console.log('=== loose files keep working ===')
    const loose = clip(path.join(base, 'Desktop', 'recording-1700000000000.mov'))
    fs.mkdirSync(path.join(base, 'Desktop', '.fetch'))
    fs.writeFileSync(path.join(base, 'Desktop', '.fetch', 'recording-1700000000000.srt'), 'x')
    is('a loose file has no take', p.takeDir(loose), null)
    const lex = await p.applyEdit(loose, { loudnorm: false, start: 0, end: 1 })
    is('its export is still a -edit copy beside it', lex.file, path.join(base, 'Desktop', 'recording-1700000000000-edit.mp4'))
    const lr = p.renameTake(loose, 'Old demo')
    is('a loose rename stays in place', lr.path, path.join(base, 'Desktop', 'Old demo.mov'))
    is('with its sidecars', exists(path.join(base, 'Desktop', '.fetch', 'Old demo.srt')), true)

    const stray = clip(path.join(base, 'Projects', 'Original', 'clip.mov'))
    is('a folder called Original elsewhere is not a take', p.takeDir(stray), null)
    // Fetch thumbnails imported files too, which leaves a .fetch folder beside them
    const imported = clip(path.join(base, 'Client', 'Original', 'interview.mov'))
    fs.mkdirSync(path.join(base, 'Client', 'Original', '.fetch'))
    is('nor is an imported file that Fetch has worked on', p.takeDir(imported), null)
    const moved = clip(path.join(base, 'Elsewhere', 'Old take', 'Original', 'Old take.mov'))
    fs.mkdirSync(path.join(base, 'Elsewhere', 'Old take', 'Original', '.fetch'))
    is('a take folder moved out of the root is still a take', p.takeDir(moved), path.join(base, 'Elsewhere', 'Old take'))
  } catch (e) {
    fail++
    console.log('  FAIL threw: ' + (e.stack || e.message))
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
})()
