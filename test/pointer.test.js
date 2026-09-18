// The agent's own cursor: coordinate mapping, clock stamping, motion, and a real
// render read back pixel by pixel to check the arrow sits where it was scripted.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const P = require('../ui/pointer')
const FD = require('../ui/fetchdoc')
const proc = require('../processor')

let pass = 0, fail = 0
const is = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}` +
    (ok ? '' : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`))
}
const near = (a, b, tol) => Math.abs(a - b) <= tol
const throws = fn => { try { fn(); return false } catch { return true } }

// ---- clock stamping ----
{
  const c = P.videoClock(1000, [[3000, 4000]])
  is('frame zero is the first frame', c(1000), 0)
  is('before the first frame snaps to it', c(500, true), 0)
  is('before the first frame is not in the video', c(500), null)
  is('a pause is taken out', c(5000), 3000)
  is('a report during a pause is dropped', c(3500), null)
  is('or lands where the video resumes', c(3500, true), 2000)
  is('a pause still open drops everything after it', P.videoClock(0, [], 2000)(2500), null)
}

// ---- where a point sits in the recorded frame ----
{
  // Chrome on macOS: no side border, 88pt of tabs and toolbar above the page
  const v = { innerWidth: 1280, innerHeight: 712, outerWidth: 1280, outerHeight: 800 }
  const f = P.pageToWindow({ x: 640, y: 356, ...v })
  is('page centre is below window centre by the chrome', [f.x, +f.y.toFixed(3)], [0.5, 0.555])
  is('page top left is under the toolbar', P.pageToWindow({ x: 0, y: 0, ...v }), { x: 0, y: 0.11 })
  // a side border, split evenly, is taken off the top chrome too
  const g = P.pageToWindow({ x: 0, y: 0, innerWidth: 1264, innerHeight: 700, outerWidth: 1280, outerHeight: 800 })
  is('side borders split evenly', [+(g.x * 1280).toFixed(3), +(g.y * 800).toFixed(3)], [8, 92])

  is('fractions pass through', P.toFraction({ x: 0.25, y: 0.75 }), { x: 0.25, y: 0.75 })
  is('viewport form maps page pixels', P.toFraction({ x: 640, y: 356,
    viewport: { inner_width: 1280, inner_height: 712, outer_width: 1280, outer_height: 800 } }), { x: 0.5, y: 0.555 })
  is('screen points map against the window', P.toFraction({ x: 300, y: 250, window_relative: false },
    { x: 100, y: 50, width: 800, height: 400 }), { x: 0.25, y: 0.5 })
  is('a pixel sent as a fraction is refused', throws(() => P.toFraction({ x: 640, y: 300 })), true)
  is('screen points with no window are refused', throws(() => P.toFraction({ x: 1, y: 1, window_relative: false })), true)
  const vp = { inner_width: 1280, inner_height: 712, outer_width: 1280, outer_height: 800 }
  is('page pixels are refused in a display take', throws(() => P.toFraction({ x: 10, y: 10, viewport: vp }, null, 'display')), true)
  is('and mapped in a window take', P.toFraction({ x: 640, y: 356, viewport: vp }, null, 'window'), { x: 0.5, y: 0.555 })
  is('just outside the edge is clamped', P.toFraction({ x: 1.02, y: -0.01 }), { x: 1, y: 0 })
}

// ---- the track ----
{
  const t = P.normalizeTrack([{ t: 2, x: 0.5, y: 0.5, click: 1 }, null, { t: 1, x: 2, y: 'a' }, { t: 1, x: 0.1, y: 0.2 }])
  is('cleaned and in time order', t, [{ t: 1, x: 0.1, y: 0.2 }, { t: 2, x: 0.5, y: 0.5, click: true }])
  const d = P.asCursorData([{ t: 1, x: 0.1, y: 0.2 }, { t: 2.5, x: 0.6, y: 0.4, click: true }])
  is('clicks feed auto-zoom', d.clicks, [[2500, 0.6, 0.4]])
  const m = proc.zoomMoments(d)
  is('auto-zoom lands on the agent\'s click', m.map(x => [x.inEnd, x.x, x.y]), [[2.5, 0.6, 0.4]])
  // a crop moves the zoom target with the content
  const mc = proc.zoomMoments(d, { crop: { x: 0.5, y: 0, w: 0.5, h: 1 } })
  is('and follows the crop', mc.map(x => [+x.x.toFixed(3), x.y]), [[0.2, 0.4]])
}

// ---- motion ----
{
  const pts = [{ t: 1, x: 100, y: 100 }, { t: 3, x: 700, y: 400, click: true }, { t: 3.1, x: 710, y: 400 }]
  const pl = P.plan(pts, { W: 960, H: 600 })
  is('nothing before the first point', P.positionAt(pl, 0.5), null)
  is('holds where it was until it has to leave', P.positionAt(pl, 1.5), { x: 100, y: 100 })
  const at = P.positionAt(pl, 3)
  is('arrives exactly when the agent acted', [at.x, at.y], [700, 400])
  const m = pl.moves[0]
  is('a glide takes a readable time', m.to - m.from >= 0.32 && m.to - m.from <= 0.8, true)
  const mid = P.positionAt(pl, (m.from + m.to) / 2)
  is('eased: halfway in time is halfway there', near(mid.x, 400, 20), true)
  const early = P.positionAt(pl, m.from + (m.to - m.from) * 0.1)
  is('eased: slow to start', early.x - 100 < 600 * 0.1, true)
  is('the path bows slightly off the straight line', Math.abs(mid.y - 250) > 2, true)
  // a move that must leave soon after a click still leaves room for a short press
  const quick = P.plan([{ t: 1, x: 0, y: 0, click: true }, { t: 1.1, x: 40, y: 0 }], { W: 960, H: 600 })
  is('a quick move after a click keeps a press', quick.moves[0].from > 1 && quick.moves[0].to === 1.1, true)
  // the cursor appearing mid-glide fades in across the pieces rather than popping
  const midAss = P.pointerAss([{ t: 0.3, x: 0.1, y: 0.1 }, { t: 0.6, x: 0.8, y: 0.8 }], { W: 960, H: 600, end: 2 })
  const fades = midAss.split('\n').filter(l => l.startsWith('Dialogue: 2')).map(l => (l.match(/\\fade\((\d+),(\d+)/) || []).slice(1).map(Number))
  is('fades in over the first pieces', fades[0][0] === 255 && fades[1][0] === fades[0][1] && fades.some(f => !f.length), true)
  is('a press finishes before the next move', pl.moves[1].from >= 3 + 0.26 - 1e-9 || pl.moves[1].to - pl.moves[1].from <= 0.18, true)

  // times in the doc are the source clock; the export maps them through the cuts
  const clock = proc.outClock([[1.5, 2.5]], 0, 10)
  const ass = P.pointerAss([{ t: 1, x: 0.1, y: 0.1 }, { t: 2, x: 0.5, y: 0.5 }, { t: 4, x: 0.5, y: 0.5, click: true }],
    { W: 960, H: 600, clock, end: 9 })
  const first = ass.split('\n').find(l => l.startsWith('Dialogue: 2,'))
  is('starts where the first point is', first.includes('\\pos(96,60)'), true)
  is('a point inside a cut is where the cursor is when the picture resumes',
    /Dialogue: 2,0:00:01\.50,[^\n]*\\pos\(480,300\)/.test(ass) && !/\\move\(96,60/.test(ass), true)
  is('a click after a cut lands on the output clock', /Dialogue: 0,0:00:03\.00,0:00:03\.56/.test(ass), true)
  // a trimmed opening keeps the cursor where the agent last put it, without its click
  const trim = P.pointerAss([{ t: 0.5, x: 0.1, y: 0.1 }, { t: 1, x: 0.25, y: 0.5, click: true }, { t: 8, x: 0.5, y: 0.5 }],
    { W: 960, H: 600, clock: proc.outClock([], 3, 10), end: 7 })
  is('a trimmed opening still has its cursor', /Dialogue: 2,0:00:00\.00,[^\n]*\\pos\(240,300\)/.test(trim), true)
  is('but not the click the trim removed', /Dialogue: 0,/.test(trim), false)
  is('nothing to draw is null', P.pointerAss([], { W: 10, H: 10 }), null)
}

// ---- the edit document ----
{
  const doc = FD.normalize({}, '/x.mov', 10)
  is('a new doc follows the recorded track', doc.pointer, null)
  const set = FD.normalize(FD.mergeDoc(doc, { pointer: [{ t: 2, x: 0.3, y: 0.4, click: true }] }), '/x.mov', 10)
  is('apply_edit can supply a track', set.pointer, [{ t: 2, x: 0.3, y: 0.4, click: true }])
  is('leaving it out keeps it', FD.mergeDoc(set, { zooms: [] }).pointer.length, 1)
  is('null goes back to the recorded track', FD.mergeDoc(set, { pointer: null }).pointer, null)
  is('[] means no cursor', FD.normalize(FD.mergeDoc(set, { pointer: [] })).pointer, [])
  is('it reaches the exporter', FD.toExportOpts(set).pointer.length, 1)
}

// ---- the Mac's pointer, baked into the pixels ----
{
  // a window take: off screen, then on at x 100, the pointer resting, moving, resting
  const data = {
    kind: 'window', display: { x: 0, y: 0, width: 1000, height: 800 },
    windowBounds: [[0, 100, 50, 800, 600, 0], [1000, 100, 50, 800, 600], [3000, 102, 50, 800, 600]],
    points: [[500, 300, 300], [1000, 500, 350], [1500, 500, 350], [2000, 500, 351], [2050, 560, 350],
      [2100, 700, 350], [2600, 700, 350], [3200, 702, 350]],
  }
  const s = P.bakedCursorSpans(data)
  is('nothing while the window was off screen', s.every(x => x.a >= 0.9), true)
  const rests = s.filter(x => x.rest)
  is('two rests', rests.length, 2)
  is('the first rest runs until it moved', near(rests[0].a, 0.94, 0.01) && near(rests[0].b, 2.11, 0.01), true)
  is('a two point nudge of the window is not a move', rests[1].b, Infinity)
  const r0 = rests[0]
  is('the box holds the hot spot', r0.x < 400 / 800 && r0.x + r0.w > 400 / 800 && r0.y < 300 / 600 && r0.y + r0.h > 300 / 600, true)
  is('the travel between is covered', s.some(x => !x.rest && x.a < 2.05 && x.b > 2.05 && x.x < 460 / 800 && x.x + x.w > 460 / 800), true)
  is('no spans for a take recorded without it', P.bakedCursorSpans({ ...data, inPicture: false }), [])
  is('nor for an agent track', P.bakedCursorSpans(P.asCursorData([{ t: 1, x: 0.5, y: 0.5 }])), [])
  is('clear elsewhere', P.clearOfCursor(s, 1.2, { x: 0, y: 0, w: 0.1, h: 0.1 }), true)
  is('not clear under it', P.clearOfCursor(s, 1.2, { x: 0.49, y: 0.49, w: 0.02, h: 0.02 }), false)

  // a Space switch: the window slides in under a pointer that never moves on screen
  const slide = P.bakedCursorSpans({
    kind: 'window', display: { x: 0, y: 0, width: 1500, height: 1000 },
    windowBounds: [[0, 60, 30, 1400, 900, 0], [1000, -600, 30, 1400, 900], [1050, -200, 30, 1400, 900], [1100, 60, 30, 1400, 900]],
    points: [[1000, 900, 400], [1050, 900, 400], [1100, 900, 400], [1150, 900, 400], [3000, 900, 400]],
  })
  is('a window sliding under a still pointer is one span, patched as a whole', slide.filter(x => x.slide).map(x => [x.pieces.length > 1, x.w > 0.2]), [[true, true], [true, true]])
  is('it still rests where the window landed', slide.some(x => x.rest && near(x.x + 0.0071, (900 - 60) / 1400, 0.01)), true)
}

// ---- clean plates ----
{
  // a 20x20 region, the box 6..14; the resting frame is the clean one darkened by 8
  // (a hover) with a black pointer at 8..10
  const reg = { w: 20, h: 20, bx: 6, by: 6, bw: 8, bh: 8 }
  const clean = Buffer.alloc(20 * 20 * 3, 240)
  clean[(3 * 20 + 3) * 3] = 0                                   // a detail outside the box
  const here = Buffer.from(clean.map(v => v - 8))
  here[(3 * 20 + 3) * 3] = 0
  for (let y = 8; y < 11; y++) for (let x = 8; x < 11; x++) for (let c = 0; c < 3; c++) here[(y * 20 + x) * 3 + c] = 0
  const fit = P.plateFit(here, clean, reg)
  is('a tint fits', fit.residual < 1, true)
  is('and is carried into the box', near(fit.corr[0], -8, 0.5), true)
  const other = Buffer.from(clean)
  for (let x = 0; x < 20; x += 2) for (let c = 0; c < 3; c++) other[(5 * 20 + x) * 3 + c] = 30   // text along the edge
  is('a changed screen does not', P.plateFit(here, other, reg).residual > 3, true)
  const px = P.platePixels([here], clean, fit.corr, reg, { grow: 1 })
  const alpha = (x, y) => px[((y - 6) * 8 + (x - 6)) * 4 + 3]
  is('opaque over the pointer', alpha(9, 9), 255)
  is('clear away from it', alpha(6, 13), 0)
  is('and the patch is tinted to match', near(px[((9 - 6) * 8 + 3) * 4], 232, 1), true)
  const moved = P.boxMoved(new Uint8Array(64), here, clean, reg)
  is('a changed pointer shape is marked', moved[(9 - 6) * 8 + 3], 1)
}

// ---- the filters that lift it out ----
{
  const spans = [{ a: 1, b: 3, x: 0.5, y: 0.5, w: 0.05, h: 0.05, rest: true }, { a: 5, b: 5.2, x: 0.99, y: 0.1, w: 0.01, h: 0.05 }]
  const plates = { 0: [{ a: 1, b: 2, png: '/tmp/p.png', x: 1000, y: 500 }] }
  const clock = proc.outClock(null, 0, 10)
  const f = proc.cursorEraseFilters(spans, plates, clock, { width: 2000, height: 1000, duration: 10 }, null, { w: 2000, h: 1000 }, 10)
  is('a patch where there is one', f.filter(x => x.includes('movie=')).length, 1)
  is('filled for the rest of the rest', f.some(x => x.startsWith('delogo') && x.includes('between(t,2.000,3.000)')), true)
  is('a box at the edge stays a pixel inside', f.filter(x => x.startsWith('delogo')).every(x => {
    const m = x.match(/x=(\d+):y=(\d+):w=(\d+):h=(\d+)/); return +m[1] >= 1 && +m[1] + +m[3] <= 1999 }), true)
  const cropped = proc.cursorEraseFilters(spans, {}, clock, { width: 2000, height: 1000, duration: 10 },
    { x: 0, y: 0, w: 0.4, h: 1 }, { w: 800, h: 1000 }, 10)
  is('a box cropped away is dropped', cropped.length, 0)
}

// ---- Fetch's own cursor: a macOS arrow, Biscuit's badge, the tag on the click ----
{
  const track = [{ t: 1, x: 0.1, y: 0.1 }, { t: 2, x: 0.5, y: 0.5, click: true }, { t: 5, x: 0.2, y: 0.8 }]
  const ass = P.pointerAss(track, { W: 960, H: 600, end: 6 })
  const arrowLine = ass.split('\n').find(l => l.startsWith('Dialogue: 2,'))
  is('the arrow is a near-black macOS arrow with a light edge', /\\1c&H08090A&\\3c&HF8FAFB&/.test(arrowLine), true)
  const tags = ass.split('\n').filter(l => l.startsWith('Dialogue: 5,'))
  is('the tag names the agent', tags.length > 0 && tags.every(l => l.endsWith('}Biscuit')), true)
  const secs = s => { const [h, m, x] = s.split(':'); return +h * 3600 + +m * 60 + +x }
  const span = tags.map(l => l.split(',')).map(f => [secs(f[1]), secs(f[2])])
  is('it comes up just before the click', Math.min(...span.map(s => s[0])) >= 2 - P.TAG.lead - 0.01 && Math.min(...span.map(s => s[0])) < 2, true)
  is('and fades soon after it', Math.max(...span.map(s => s[1])) <= 2 + P.TAG.hold + P.TAG.fadeOut + 0.02, true)
  is('not while the cursor is still gliding to it', tags.some(l => secs(l.split(',')[1]) < 2 - P.TAG.lead - 0.01), false)
  // the state at t: a tag only within about 0.15 s of a click, fading out once it is done
  const sp = [{ a: 2 - P.TAG.lead, b: 2 + P.TAG.hold + P.TAG.fadeOut, left: false }]
  is('no click within 0.15 s, no tag', [1.5, 1.8, 2.5, 3].map(t => P.tagOpacity(sp, t)), [0, 0, 0, 0])
  is('full on the click itself', P.tagOpacity(sp, 2), 1)
  is('half gone 0.1 s into its fade', Math.abs(P.tagOpacity(sp, 2 + P.TAG.hold + 0.1) - 0.5) < 0.01, true)
  is('not on a glide that ends without a click', tags.some(l => secs(l.split(',')[1]) > 3), false)
  const edge = P.pointerAss([{ t: 1, x: 0.5, y: 0.5 }, { t: 2, x: 0.97, y: 0.5, click: true }], { W: 960, H: 600, end: 3 })
  is('near the right edge the tag reads leftward', /Dialogue: 5,[^\n]*\\an6/.test(edge), true)

  const b = P.pointerBadge(track, { W: 960, H: 600, end: 6 }, 30)
  is('the badge is round and sized from the arrow', b.d % 2 === 0 && b.d > 8 && b.d < 40, true)
  is('it appears with the cursor', b.start, 1)
  const pl = P.plan(P.normalizeTrack(track).map(p => ({ ...p, x: p.x * 960, y: p.y * 600 })), { W: 960, H: 600 })
  const tip = P.positionAt(pl, 1.5), m = b.moves.filter(x => x[0] <= 1.5 + 1e-9).pop()
  is('it rides the tip off the tail, below and right', m[1] > tip.x && m[2] > tip.y && m[1] - tip.x < 40, true)
  is('it holds still while the cursor rests', b.moves.filter(x => x[0] > 2.3 && x[0] < 4).length, 0)
  is('nothing to draw, no badge', P.pointerBadge([], { W: 10, H: 10 }), null)

  // The overlay places the badge by b.x, b.y, ffmpeg expressions of t. Evaluated here
  // with the small part of ffmpeg's grammar they use, they must follow the tip on every
  // frame, mid-glide included (commands sent per frame once let it run ahead).
  const evalExpr = (src, t) => {
    let i = 0, reg = 0
    const peek = () => src[i], eat = c => { if (src[i] !== c) throw new Error(`want ${c} at ${i}`); i++ }
    const seq = () => { let v = sum(); while (peek() === ';') { i++; v = sum() } return v }
    const sum = () => { let v = prod(); while (peek() === '+' || peek() === '-') v = src[i++] === '+' ? v + prod() : v - prod(); return v }
    const prod = () => { let v = unary(); while (peek() === '*' || peek() === '/') v = src[i++] === '*' ? v * unary() : v / unary(); return v }
    const unary = () => { if (peek() === '-') { i++; return -unary() } return atom() }
    const atom = () => {
      if (peek() === '(') { i++; const v = seq(); eat(')'); return v }
      const m = /^(\d+\.?\d*|[a-z]+)/.exec(src.slice(i)); i += m[0].length
      if (/^\d/.test(m[0])) return +m[0]
      if (m[0] === 't') return t
      eat('('); const args = [seq()]; while (peek() === ',') { i++; args.push(seq()) } eat(')')
      if (m[0] === 'lt') return args[0] < args[1] ? 1 : 0
      if (m[0] === 'ld') return reg
      if (m[0] === 'st') return (reg = args[1])
      if (m[0] === 'if') return args[0] ? args[1] : args[2]
      throw new Error('unknown ' + m[0])
    }
    return seq()
  }
  let worst = 0
  for (let k = 30; k <= 5 * 30; k++) {
    const t = k / 30 + 1e-4, p = P.positionAt(pl, t)
    if (!p) continue
    worst = Math.max(worst, Math.abs(evalExpr(b.x, t) - (p.x + m[1] - tip.x)), Math.abs(evalExpr(b.y, t) - (p.y + m[2] - tip.y)))
  }
  is('the badge expression rides the tip on every frame', worst < 1.5, true)
}

// ---- the edit document ----
{
  is('hideMacCursor reaches the exporter', FD.toExportOpts({ ...FD.emptyDoc('/x.mov', 5), hideMacCursor: true }).hideMacCursor, true)
  is('and defaults to automatic', FD.toExportOpts(FD.emptyDoc('/x.mov', 5)).hideMacCursor, null)
}

// ---- a real render, read back ----
;(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-pointer-'))
  const src = path.join(dir, 'take.mp4')
  const W = 960, H = 600
  execFileSync(proc.FFMPEG, ['-hide_banner', '-v', 'error', '-y', '-f', 'lavfi',
    '-i', `color=c=0xF2F0EC:s=${W}x${H}:r=30:d=4`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src])
  // the take's own sidecar, the way main.js writes it
  fs.mkdirSync(path.join(dir, '.fetch'))
  const track = [{ t: 0.4, x: 0.2, y: 0.25 }, { t: 1.6, x: 0.7, y: 0.6, click: true }, { t: 3.0, x: 0.3, y: 0.7 }]
  fs.writeFileSync(path.join(dir, '.fetch', 'take.pointer.json'), JSON.stringify({ v: 1, scale: 2, points: track }))
  is('the sidecar is read', proc.pointerTrack(src).points.length, 3)

  let out
  try { out = (await proc.applyEdit(src, { format: 'mp4', quality: 'balanced' }, null, 'pointer-test')).file }
  catch (e) { is('export with a pointer track: ' + e.message, false, true); return done() }

  const frame = t => {
    const raw = execFileSync(proc.FFMPEG, ['-v', 'error', '-ss', String(t), '-i', out, '-frames:v', '1',
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: W * H * 4 })
    return (x, y) => { const i = (y * W + x) * 3; return [raw[i], raw[i + 1], raw[i + 2]] }
  }
  // the arrow's tip: the top-left of its solid dark body, one outline width inside.
  // The badge and the tag sit below and to the right of it, so they never lead.
  const solidInk = ([r, g, b]) => r < 60 && g < 60 && b < 60
  const tip = px => {
    let minX = W, minY = H
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (solidInk(px(x, y))) { if (y < minY) minY = y; if (x < minX) minX = x }
    }
    return minY < H ? [minX, minY] : null
  }
  const gold = (px, cx, cy, r) => {
    let n = 0
    for (let y = Math.max(0, cy - r); y < Math.min(H, cy + r); y++) {
      for (let x = Math.max(0, cx - r); x < Math.min(W, cx + r); x++) {
        const [R, , B] = px(x, y)
        if (R - B > 30) n++
      }
    }
    return n
  }

  is('no cursor before the first point', tip(frame(0.2)), null)
  const a = tip(frame(0.7))
  is('rests where it was scripted', a && near(a[0], 0.2 * W, 4) && near(a[1], 0.25 * H, 4), true)
  const pl = P.plan(P.normalizeTrack(track).map(p => ({ ...p, x: p.x * W, y: p.y * H })), { W, H })
  const tMid = Math.round(((pl.moves[0].from + pl.moves[0].to) / 2) * 30) / 30
  const want = P.positionAt(pl, tMid), b = tip(frame(tMid))
  is('mid-glide it is on the eased path', b && near(b[0], want.x, 8) && near(b[1], want.y, 8), true)
  // after the ripple, before the next glide leaves
  const c = tip(frame(2.2))
  is('lands on the click', c && near(c[0], 0.7 * W, 4) && near(c[1], 0.6 * H, 4), true)
  is('a ripple shows on the click', gold(frame(1.75), Math.round(0.7 * W), Math.round(0.6 * H), 40) > 30, true)
  is('and not before it', gold(frame(1.0), Math.round(0.7 * W), Math.round(0.6 * H), 40), 0)
  is('and is gone after it', gold(frame(2.9), Math.round(0.7 * W), Math.round(0.6 * H), 40), 0)

  // [] in the edit means no cursor at all
  const none = (await proc.applyEdit(src, { format: 'mp4', quality: 'balanced', pointer: [] }, null, 'pointer-test-2')).file
  const raw = execFileSync(proc.FFMPEG, ['-v', 'error', '-ss', '1.0', '-i', none, '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: W * H * 2 })
  is('an empty track draws nothing', raw.every(v => v > 150), true)

  fs.rmSync(dir, { recursive: true, force: true })
  done()
})()

function done() {
  console.log(`\n  ${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}
