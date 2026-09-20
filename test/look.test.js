// The Look spec (ui/look-schema.js) and what is built on it (ui/look.js), plus the v2
// edit document's migration and routing (ui/fetchdoc.js). Plain node, no Electron.
const fs = require('fs')
const os = require('os')
const path = require('path')
const S = require('../ui/look-schema')
const L = require('../ui/look')
const FD = require('../ui/fetchdoc')

let pass = 0, fail = 0
const is = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}` +
    (ok ? '' : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`))
}

console.log('the schema')
{
  const bad = []
  for (const x of S.FIELDS) {
    if (!x.label || !x.doc) bad.push(`${x.path}: no label or doc`)
    if (!S.SECTIONS.some(s => s.id === x.section)) bad.push(`${x.path}: unknown section`)
    if (x.type === 'number') {
      if (!(x.min < x.max)) bad.push(`${x.path}: no range`)
      if (x.default !== null && !(x.default >= x.min && x.default <= x.max)) bad.push(`${x.path}: default out of range`)
      if (x.default === null && !x.nullable) bad.push(`${x.path}: null default but not nullable`)
    }
    if (x.type === 'enum' && !x.options.includes(x.default)) bad.push(`${x.path}: default not an option`)
    if (x.type === 'color' && !/^#[0-9A-F]{6}$/.test(x.default)) bad.push(`${x.path}: default not #RRGGBB`)
    if (/\u2014/.test(x.doc + x.label)) bad.push(`${x.path}: em dash`)
  }
  is('every field is labelled, documented, ranged, with its default in range', bad, [])
  is('paths are unique', new Set(S.FIELDS.map(x => x.path)).size, S.FIELDS.length)
  is('every section has a field', S.SECTIONS.every(s => S.FIELDS.some(x => x.section === s.id)), true)
}

console.log('validate, merge, diff')
{
  const d = L.defaults()
  is('defaults validate clean', L.validate(d).warnings, [])
  const r = L.validate({ frame: { padding: 0.5, radius: -3 }, 'captions.colour': 'abc', bogus: 1 })
  is('out of range numbers are clamped', [r.look.frame.padding, r.look.frame.radius], [0.22, 0])
  is('and each clamp is named', r.warnings.filter(w => /range/.test(w)).length, 2)
  is('a short colour is expanded', r.look.captions.colour, '#AABBCC')
  is('an unknown field is named and dropped', [r.warnings.some(w => /^bogus is not a look field/.test(w)), 'bogus' in r.look], [true, false])
  is('a near miss is suggested', L.validate({ frame: { corners: 3 }, padding: 0.1 }).warnings.some(w => /frame\.padding/.test(w)), true)
  is('a bad enum keeps the default', L.validate({ background: { kind: 'plaid' } }).look.background.kind, 'none')
  is('aspect takes a number, a ratio or a name', ['16:9', 0.5625, '1/1', 'auto', 4 / 5].map(v => L.validate({ frame: { aspect: v } }).look.frame.aspect),
    ['16:9', '9:16', '1:1', 'auto', '4:5'])

  const base = L.merge(d, { background: { kind: 'gradient', gradient: 'ink' }, frame: { padding: 0.1 } }).look
  const m = L.merge(base, { frame: { radius: 20 } }).look
  is('merge keeps what the patch leaves out', [m.frame.padding, m.frame.radius, m.background.gradient], [0.1, 20, 'ink'])
  is('null resets one field', L.merge(m, { frame: { padding: null } }).look.frame.padding, 0.06)
  is('a null section resets the section', L.merge(m, { frame: null }).look.frame, d.frame)
  is('flat paths work too', L.merge(m, { 'frame.shadow': 0.2 }).look.frame.shadow, 0.2)
  const film = L.merge(m, { preset: 'film', frame: { radius: 30 } }).look
  is('a preset rebases, then the rest applies', [film.preset, film.background.kind, film.frame.radius, film.frame.padding], ['film', 'video-blur', 30, 0.06])
  is('an unknown preset is named', L.merge(m, { preset: 'glitter' }).warnings.some(w => /glitter/.test(w)), true)
  is('diff is what changed', L.diff(base, m), { frame: { radius: 20 } })
  is('diff of equal looks is empty', L.diff(m, JSON.parse(JSON.stringify(m))), {})
  is('compact is the preset and its diff', L.compact(film), { preset: 'film', changes: { frame: { radius: 30 } } })
  is('resolve fills a partial look', L.resolve({ frame: { padding: 0.1 } }).captions.font, 'SF Pro')
  const studio = L.merge(L.merge(d, { preset: 'studio' }).look, { frame: { padding: 0.15 } }).look
  is('null puts a field back to its preset, not the default', L.merge(studio, { frame: { padding: null } }).look.frame.padding, 0.07)
  is('and a null section to the preset\'s section', L.merge(studio, { frame: null }).look.frame.radius, 18)
}

console.log('presets')
{
  const all = L.list()
  is('the seven built-in looks ship', all.map(p => p.name), ['fetch-default', 'clean', 'studio', 'film', 'noir', 'paper', 'mono-print'])
  const bad = all.filter(p => L.validate(p.look).warnings.length).map(p => p.name)
  is('every preset validates without a warning', bad, [])
  is('the default preset is the defaults', L.diff(L.defaults(), L.merge(L.defaults(), { preset: 'fetch-default' }).look), {})
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-looks-'))
  const mine = L.merge(L.defaults(), { preset: 'studio', frame: { radius: 24 } }).look
  const saved = L.save(dir, 'My Launch', mine)
  is('a saved look is a diff on defaults', saved.look.frame.radius, 24)
  is('and lists after the built-in ones', L.list(dir).map(p => p.name).slice(-1), ['my-launch'])
  is('and applies by name', L.merge(L.defaults(), { preset: 'my-launch' }, { userDir: dir }).look.frame.radius, 24)
  let threw = false
  try { L.save(dir, 'studio', mine) } catch { threw = true }
  is('a built-in name cannot be overwritten', threw, true)
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log('warnings and the engine that will draw them')
{
  const film = L.merge(L.defaults(), { preset: 'film' }).look
  // The compositor draws the stage and every MP4 and MOV, so with no engine in the ctx
  // a look that it draws says nothing. This is the bug that told agents the Film look
  // was not drawn on the very exports that drew it.
  is('a look the renderer draws is not warned about', L.warnings(film), [])
  is('no shipped preset warns against itself on the engine that will draw it',
    L.list().filter(p => L.warnings(L.merge(L.defaults(), { preset: p.name }).look).length).map(p => p.name), [])
  is('a GIF names the renderer that will draw it and what it leaves out',
    L.warnings(film, { format: 'gif' }).some(w => /GIF output is drawn by the classic renderer/.test(w) && /grain\.film/.test(w)), true)
  is('and an engine picked already says the same', L.warnings(film, { engine: 'classic' }).length, 1)
  is('a still frame is the classic renderer too', L.warnings(film, { still: 2 }).length, 1)
  is('an MP4 or a MOV leaves the whole look alone', [L.warnings(film, { format: 'mp4' }), L.warnings(film, { format: 'mov' })], [[], []])
  // a loupe would simply not appear there, which is the silence worth breaking
  is('a loupe on a GIF is named with the fields',
    L.warnings(L.defaults(), { format: 'gif', marks: [{ id: 'M2', kind: 'loupe' }] }).some(w => /the loupe M2/.test(w)), true)
  is('and on an MP4 it is not', L.warnings(L.defaults(), { format: 'mp4', marks: [{ id: 'M2', kind: 'loupe' }] }), [])
  is('an option only the compositor draws is named by its value',
    L.warnings(L.merge(L.defaults(), { frame: { chrome: 'clean' } }).look, { format: 'webm' }).some(w => /frame\.chrome clean/.test(w)), true)
  // the five dead fields are the ones the old flag was accidentally right about
  is('a field nothing draws is named whatever runs',
    ['mp4', 'gif'].map(format => L.warnings(L.merge(L.defaults(), { frame: { scale: 0.9 } }).look, { format })
      .some(w => /frame\.scale/.test(w) && /nothing draws/.test(w))), [true, true])
  is('the default look warns about nothing', L.warnings(L.defaults()), [])
  const shaped = L.merge(L.defaults(), { frame: { aspect: '9:16' } }).look
  is('a shape with no background says it is filled, never black', L.warnings(shaped).some(w => /never black/.test(w)), true)
  is('chrome remove with no known page says so', L.warnings(L.defaults(), { browser: true, viewport: false }).some(w => /chrome/.test(w)), true)
  // clean crops for the same reason remove does, so it fails on the same take, and
  // there the drawn browser would sit round the real one
  const clean = L.merge(L.defaults(), { frame: { chrome: 'clean' } }).look
  is('and so does clean, which would otherwise draw two browsers',
    L.warnings(clean, { browser: true, viewport: false }).some(w => /chrome clean/.test(w) && /two browsers/.test(w)), true)
  is('with the page\'s place known it says nothing about it', L.warnings(clean, { browser: true, viewport: true }).some(w => /two browsers/.test(w)), false)
  const img = L.merge(L.defaults(), { background: { kind: 'image', image: 'img:nope.jpg' } }).look
  is('an image nobody has is named', L.warnings(img, { images: ['img:meadow.jpg'] }).some(w => /img:nope\.jpg/.test(w)), true)
  is('an image in the list is not', L.warnings(img, { images: ['img:nope.jpg'] }).some(w => /img:nope/.test(w)), false)
  const c = L.toClassic(L.merge(L.defaults(), { background: { kind: 'solid', color: '#102030' }, frame: { aspect: '16:9' } }).look)
  is('a solid background reaches the renderer', [c.backdrop, c.backdropAspect], ['color:#102030', 1.7778])
  is('background ids round trip', ['blur', 'ink', 'img:x.jpg', null, 'color:#AABBCC'].map(id => L.backdropId({ background: L.backgroundFromId(id) })),
    ['blur', 'ink', 'img:x.jpg', null, 'color:#AABBCC'])
}

console.log('the inspector and the agent docs')
{
  // The stage is drawn by the compositor, so that is the engine the Look tab answers
  // to. 39 of 63 fields were hidden from it by a flag that meant the opposite.
  const secs = L.sections()
  is('the inspector shows only what the renderer draws', secs.every(s => s.fields.every(x => L.draws(x, 'gl') && !x.hidden)), true)
  is('and that is every field but the five nothing draws and the two dragged on the stage',
    secs.reduce((n, s) => n + s.fields.length, 0), S.FIELDS.length - 7)
  is('including the whole of Treatment, grain, device and focus',
    ['treatment', 'grain', 'device', 'focus'].map(id => (secs.find(s => s.id === id) || { fields: [] }).fields.length),
    ['treatment', 'grain', 'device', 'focus'].map(id => S.FIELDS.filter(x => x.section === id).length))
  is('and offers clean browser chrome, which the compositor draws',
    secs.find(s => s.id === 'frame').fields.find(x => x.path === 'frame.chrome').options.includes('clean'), true)
  is('a mesh background is offered, now that the compositor draws it', secs.find(s => s.id === 'background').fields[0].options.includes('mesh'), true)
  // and the same question asked of the other engine gets the other answer
  const cl = L.sections({ engine: 'classic' })
  is('asked about the classic renderer it drops what ffmpeg cannot draw', cl.some(s => s.id === 'treatment' || s.id === 'device'), false)
  is('and the options it cannot draw', cl.find(s => s.id === 'frame').fields.find(x => x.path === 'frame.chrome').options, ['keep', 'remove'])
  const doc = L.describe()
  is('every field is described, including the two a person drags', S.FIELDS.every(x => doc.includes(x.path)), true)
  is('and each says which engine draws it', [/captions\.fx/.test(doc), /treatment\.bloom \(0 to 1, default 0\) \[gif\]/.test(doc),
    /frame\.scale .*\[undrawn\]/.test(doc)], [true, true, true])
  // about 4 characters a token: the whole schema stays inside a couple of thousand of
  // them. It grew a section at M5 (the drawn device), which is what the extra buys.
  is('the agent docs fit a token budget', doc.length < 9000, true)
  is('no em dashes in the agent docs', /\u2014/.test(doc), false)
  is('when hides a field that does not apply', L.visible(S.BY_PATH.get('background.color'), L.defaults()), false)
  is('the advanced fields are a handful, so one disclosure holds them',
    secs.reduce((n, s) => n + s.fields.filter(x => x.advanced).length, 0) <= 6, true)
}

console.log('the presets say what they are for')
{
  const bad = L.list().filter(p => !p.for || p.for.length > 80 || /\u2014/.test(p.for)).map(p => p.name)
  is('every shipped look names the take it suits, in one short line', bad, [])
}

console.log('v1 documents')
{
  const v1 = { v: 1, src: '/x.mov', dur: 10, clips: [{ id: 'C1', start: 0, end: 10 }],
    look: { zoomAmt: 2, bdInset: 0.1, bdRadius: 20, burnCaps: false, denoise: true, loudnorm: false, gain: 3, fadeIn: 0.5, fadeOut: 1, music: 'warm' },
    capStyle: { font: 'Georgia', colour: '#FFD9A0', position: 'top' }, backdrop: 'ink', outAspect: 16 / 9, hideMacCursor: true }
  const d = FD.normalize(v1, '/x.mov', 10)
  is('migrates to v2', d.v, 2)
  is('the look fields move', [d.look.frame.padding, d.look.frame.radius, d.look.motion.zoomDepth, d.look.frame.aspect, d.look.background.gradient],
    [0.1, 20, 2, '16:9', 'ink'])
  is('captions move', [d.look.captions.show, d.look.captions.font, d.look.captions.position], [false, 'Georgia', 'top'])
  // the four the v1 look carried, by name: the audio bag has gained fields since
  is('the sound moves to audio', ['denoise', 'loudnorm', 'gain', 'music'].map(k => d.audio[k]), [true, false, 3, 'warm'])
  is('the Mac pointer setting moves', d.look.cursor.hideSystem, 'hide')
  is('no v1 field is left at the top', ['backdrop', 'backdropFile', 'outAspect', 'capStyle', 'hideMacCursor'].filter(k => k in d), [])
  is('an old take keeps its chrome', d.look.frame.chrome, 'keep')
  is('migration is idempotent', JSON.stringify(FD.normalize(d, '/x.mov', 10)), JSON.stringify(d))
  const o1 = FD.toExportOpts(v1), o2 = FD.toExportOpts(d)
  is('a v1 document exports the same as its migration', JSON.stringify(o1), JSON.stringify(o2))
  is('and as it did before', [o2.backdrop, o2.backdropAspect, o2.inset, o2.radius, o2.captions, o2.gain, o2.hideMacCursor, o2.captionStyle.font],
    ['ink', 1.7778, 0.1, 20, false, 3, true, 'Georgia'])
  const blank = FD.normalize({ v: 1 }, '/y.mov', 4)
  is('an empty v1 document gets the default look', L.diff(L.defaults(), blank.look), { frame: { chrome: 'keep' } })
}

console.log('patches in either shape')
{
  const d = FD.normalize({}, '/x.mov', 10)
  const m = FD.mergeDoc(d, { backdrop: 'blur', outAspect: 1, capStyle: { font: 'Helvetica' }, look: { gain: 2, denoise: true }, hideMacCursor: false })
  is('v1 keys land in their v2 place', [m.look.background.kind, m.look.frame.aspect, m.look.captions.font, m.audio.gain, m.audio.denoise, m.look.cursor.hideSystem],
    ['video-blur', '1:1', 'Helvetica', 2, true, 'keep'])
  const n = FD.mergeDoc(m, { look: { preset: 'studio' }, audio: { music: 'calm' } })
  is('a preset rebases the look and keeps the sound', [n.look.background.gradient, n.audio.gain, n.audio.music], ['dusk', 2, 'calm'])
  is('and keeps the shape and the captions', [n.look.frame.aspect, n.look.captions.font], ['1:1', 'Helvetica'])
  is('backdrop null is no background', FD.mergeDoc(m, { backdrop: null }).look.background.kind, 'none')
  is('lookPatchOf ignores a patch without look', FD.lookPatchOf({ zooms: [] }), { look: null, audio: null })
}

console.log('browser chrome')
{
  const vp = { x: 0, y: 0.11, w: 1, h: 0.89 }
  const d = FD.normalize({ v: 2, viewport: vp }, '/x.mov', 10)
  is('a known page crops the chrome off, once', [d.crop, d.viewportApplied], [vp, true])
  is('clearing that crop sticks', FD.normalize({ ...d, crop: null }, '/x.mov', 10).crop, null)
  const keep = FD.mergeDoc(d, { look: { frame: { chrome: 'keep' } } })
  is('chrome keep puts the chrome back', keep.crop, null)
  is('and remove takes it off again', FD.mergeDoc(keep, { look: { frame: { chrome: 'remove' } } }).crop, vp)
  const hand = { x: 0.1, y: 0.2, w: 0.5, h: 0.5 }
  is('a crop drawn by hand is never touched', FD.mergeDoc({ ...d, crop: hand }, { look: { frame: { chrome: 'keep' } } }).crop, hand)
  is('it reaches the exporter as the crop', FD.toExportOpts(d).crop, vp)
}

console.log('the render spec')
{
  const d = FD.normalize({ v: 2, clips: [{ start: 0, end: 4 }, { start: 6, end: 10 }] }, '/x.mov', 10)
  const spec = FD.toRenderSpec(d)
  is('keeps the ranges and the length', [spec.keep, spec.length], [[[0, 4], [6, 10]], 8])
  is('carries the whole look', spec.look.frame.padding, 0.06)
  is('cursor.show off draws no cursor', FD.toExportOpts(FD.mergeDoc(d, { look: { cursor: { show: false } } })).pointer, [])
}

console.log(`\n  ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
