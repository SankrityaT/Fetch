// Pin a TrueType variable font to one static instance, for ffmpeg's drawtext.
//
// drawtext loads a font through FreeType and never sets its variation axes, so a
// variable font always renders at its default instance. For New York that default
// is opsz 256, the largest display cut, where every horizontal stroke is a hairline
// 10 units thick: at video sizes hyphens and dashes vanish entirely. CoreText (and so
// the editor's preview) picks the optical size from the point size, so the export has
// to do the same. This writes a static copy at the wanted coordinates, once, and
// caches it.
//
// Scope is deliberately small: glyf/gvar outlines and advances, avar mapping. Kerning
// and other metric variations stay at the default instance.

const fs = require('fs')
const os = require('os')
const path = require('path')

const F2 = v => Math.round(v * 16384) / 16384      // coords are quantised to F2Dot14

// `at` is the table directory's offset: 0 for a plain font, per face in a .ttc
// (whose table offsets are from the start of the file either way)
function tables(buf, at = 0) {
  const n = buf.readUInt16BE(at + 4), out = {}
  for (let i = 0; i < n; i++) {
    const r = at + 12 + i * 16
    out[buf.toString('latin1', r, r + 4)] = buf.subarray(buf.readUInt32BE(r + 8), buf.readUInt32BE(r + 8) + buf.readUInt32BE(r + 12))
  }
  return out
}

function axes(fvar) {
  const off = fvar.readUInt16BE(4), count = fvar.readUInt16BE(8), size = fvar.readUInt16BE(10)
  const list = []
  for (let i = 0; i < count; i++) {
    const r = off + i * size
    list.push({ tag: fvar.toString('latin1', r, r + 4), min: fvar.readInt32BE(r + 4) / 65536,
      def: fvar.readInt32BE(r + 8) / 65536, max: fvar.readInt32BE(r + 12) / 65536 })
  }
  return list
}

// user coordinates -> normalised, through avar if the font has one
function normalise(list, want, avar) {
  const coords = list.map(a => {
    const v = Math.max(a.min, Math.min(a.max, want[a.tag] != null ? +want[a.tag] : a.def))
    return v < a.def ? (v - a.def) / (a.def - a.min) : v > a.def ? (v - a.def) / (a.max - a.def) : 0
  })
  if (avar) {
    let p = 8
    for (let i = 0; i < list.length; i++) {
      const n = avar.readUInt16BE(p); p += 2
      const map = []
      for (let k = 0; k < n; k++) map.push([avar.readInt16BE(p + k * 4) / 16384, avar.readInt16BE(p + k * 4 + 2) / 16384])
      p += n * 4
      const v = coords[i]
      for (let k = 1; k < map.length; k++) {
        if (v <= map[k][0]) {
          const [a0, b0] = map[k - 1], [a1, b1] = map[k]
          coords[i] = a1 === a0 ? b1 : b0 + (v - a0) * (b1 - b0) / (a1 - a0)
          break
        }
      }
    }
  }
  return coords.map(F2)
}

function tupleScalar(coords, peak, lo, hi) {
  let s = 1
  for (let i = 0; i < coords.length; i++) {
    const p = peak[i], v = coords[i]
    if (p === 0) continue
    if (v === 0) return 0
    const a = lo ? lo[i] : Math.min(0, p), b = hi ? hi[i] : Math.max(0, p)
    if (v < a || v > b) return 0
    if (v < p) s *= (v - a) / (p - a)
    else if (v > p) s *= (b - v) / (b - p)
  }
  return s
}

// packed point numbers; null means every point
function readPoints(buf, p) {
  let n = buf[p++]
  if (n === 0) return [null, p]
  if (n & 0x80) n = ((n & 0x7f) << 8) | buf[p++]
  const pts = []
  let last = 0
  while (pts.length < n) {
    const ctl = buf[p++], run = (ctl & 0x7f) + 1, words = ctl & 0x80
    for (let k = 0; k < run && pts.length < n; k++) {
      last += words ? buf.readUInt16BE(p) : buf[p]
      p += words ? 2 : 1
      pts.push(last)
    }
  }
  return [pts, p]
}

function readDeltas(buf, p, n) {
  const out = []
  while (out.length < n) {
    const ctl = buf[p++], run = (ctl & 0x3f) + 1
    for (let k = 0; k < run && out.length < n; k++) {
      if (ctl & 0x80) out.push(0)
      else if (ctl & 0x40) { out.push(buf.readInt16BE(p)); p += 2 }
      else { out.push(buf.readInt8(p)); p += 1 }
    }
  }
  return [out, p]
}

// Interpolate untouched points of one contour from their touched neighbours, the
// way a renderer does when a tuple only lists some points.
function iup(orig, dx, dy, touched, s, e) {
  const idx = []
  for (let i = s; i <= e; i++) if (touched[i]) idx.push(i)
  if (!idx.length) return
  if (idx.length === 1) {
    for (let i = s; i <= e; i++) if (!touched[i]) { dx[i] = dx[idx[0]]; dy[i] = dy[idx[0]] }
    return
  }
  const seg = (r1, r2, i) => {
    for (const [ax, d] of [[0, dx], [1, dy]]) {
      let x1 = orig[r1][ax], x2 = orig[r2][ax], d1 = d[r1], d2 = d[r2]
      const x = orig[i][ax]
      if (x1 === x2) { d[i] = d1 === d2 ? d1 : 0; continue }
      if (x1 > x2) { [x1, x2] = [x2, x1]; [d1, d2] = [d2, d1] }
      d[i] = x <= x1 ? d1 : x >= x2 ? d2 : d1 + (x - x1) * (d2 - d1) / (x2 - x1)
    }
  }
  for (let k = 0; k < idx.length; k++) {
    const r1 = idx[k], r2 = idx[(k + 1) % idx.length]
    for (let i = r1 + 1; ; i++) {
      if (i > e) i = s
      if (i === r2) break
      seg(r1, r2, i)
    }
  }
}

function parseGlyph(g) {
  if (!g.length) return { empty: true, pts: [] }
  const nc = g.readInt16BE(0)
  if (nc >= 0) {
    const ends = []
    for (let i = 0; i < nc; i++) ends.push(g.readUInt16BE(10 + i * 2))
    let p = 10 + nc * 2
    const il = g.readUInt16BE(p); const ins = g.subarray(p + 2, p + 2 + il); p += 2 + il
    const n = nc ? ends[nc - 1] + 1 : 0
    const flags = []
    while (flags.length < n) {
      const f = g[p++]; flags.push(f)
      if (f & 8) { let r = g[p++]; while (r--) flags.push(f) }
    }
    const pts = flags.map(() => [0, 0])
    for (const [ax, short, same] of [[0, 2, 16], [1, 4, 32]]) {
      let v = 0
      for (let i = 0; i < n; i++) {
        const f = flags[i]
        if (f & short) { const b = g[p++]; v += (f & same) ? b : -b }
        else if (!(f & same)) { v += g.readInt16BE(p); p += 2 }
        pts[i][ax] = v
      }
    }
    return { simple: true, ends, ins, flags, pts }
  }
  // composite: one "point" per component, its offset
  const comps = []
  let p = 10, more = true, hasIns = false
  while (more) {
    const flags = g.readUInt16BE(p), glyph = g.readUInt16BE(p + 2); p += 4
    let a, b
    if (flags & 1) { a = g.readInt16BE(p); b = g.readInt16BE(p + 2); p += 4 }
    else { a = (flags & 2) ? g.readInt8(p) : g[p]; b = (flags & 2) ? g.readInt8(p + 1) : g[p + 1]; p += 2 }
    const xl = (flags & 8) ? 2 : (flags & 0x40) ? 4 : (flags & 0x80) ? 8 : 0
    comps.push({ flags, glyph, a, b, scale: g.subarray(p, p + xl) }); p += xl
    more = !!(flags & 0x20); if (flags & 0x100) hasIns = true
  }
  let ins = Buffer.alloc(0)
  if (hasIns) { const il = g.readUInt16BE(p); ins = g.subarray(p + 2, p + 2 + il) }
  return { comps, ins, pts: comps.map(c => [c.a, c.b]), head: g.subarray(0, 10) }
}

function writeGlyph(gl) {
  if (gl.empty) return Buffer.alloc(0)
  if (gl.simple) {
    const n = gl.pts.length
    const xs = gl.pts.map(q => q[0]), ys = gl.pts.map(q => q[1])
    const head = Buffer.alloc(10)
    head.writeInt16BE(gl.ends.length, 0)
    head.writeInt16BE(n ? Math.min(...xs) : 0, 2); head.writeInt16BE(n ? Math.min(...ys) : 0, 4)
    head.writeInt16BE(n ? Math.max(...xs) : 0, 6); head.writeInt16BE(n ? Math.max(...ys) : 0, 8)
    const body = Buffer.alloc(gl.ends.length * 2 + 2 + gl.ins.length + n + n * 4)
    let p = 0
    for (const e of gl.ends) { body.writeUInt16BE(e, p); p += 2 }
    body.writeUInt16BE(gl.ins.length, p); p += 2; gl.ins.copy(body, p); p += gl.ins.length
    // every coordinate as a plain int16 delta: bigger, but nothing to get wrong
    for (let i = 0; i < n; i++) body[p++] = gl.flags[i] & 0x41
    for (const arr of [xs, ys]) {
      let prev = 0
      for (let i = 0; i < n; i++) { body.writeInt16BE(arr[i] - prev, p); prev = arr[i]; p += 2 }
    }
    return Buffer.concat([head, body])
  }
  const parts = [gl.head]
  gl.comps.forEach((c, i) => {
    const b = Buffer.alloc(8)
    b.writeUInt16BE(c.flags | 1, 0); b.writeUInt16BE(c.glyph, 2)
    b.writeInt16BE(gl.pts[i][0], 4); b.writeInt16BE(gl.pts[i][1], 6)
    parts.push(b, c.scale)
  })
  if (gl.ins.length) { const l = Buffer.alloc(2); l.writeUInt16BE(gl.ins.length); parts.push(l, gl.ins) }
  return Buffer.concat(parts)
}

function checksum(b) {
  let s = 0
  const padded = b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - b.length % 4)]) : b
  for (let i = 0; i < padded.length; i += 4) s = (s + padded.readUInt32BE(i)) >>> 0
  return s
}

function instantiate(buf, want) {
  const T = tables(buf)
  if (!T.fvar || !T.gvar || !T.glyf) return null
  const list = axes(T.fvar)
  const coords = normalise(list, want, T.avar)
  const gv = T.gvar, head = Buffer.from(T.head), hhea = Buffer.from(T.hhea)
  const nG = T.maxp.readUInt16BE(4), longLoca = head.readInt16BE(50) === 1
  const loca = i => longLoca ? T.loca.readUInt32BE(i * 4) : T.loca.readUInt16BE(i * 2) * 2
  const nH = hhea.readUInt16BE(34)
  const adv = [], lsb = []
  for (let i = 0; i < nG; i++) {
    adv.push(T.hmtx.readUInt16BE(Math.min(i, nH - 1) * 4))
    lsb.push(i < nH ? T.hmtx.readInt16BE(i * 4 + 2) : T.hmtx.readInt16BE(nH * 4 + (i - nH) * 2))
  }

  const axisCount = gv.readUInt16BE(4), sharedCount = gv.readUInt16BE(6)
  const sharedOff = gv.readUInt32BE(8), gFlags = gv.readUInt16BE(14), dataOff = gv.readUInt32BE(16)
  const shared = []
  const gOff = i => (gFlags & 1) ? gv.readUInt32BE(20 + i * 4) : gv.readUInt16BE(20 + i * 2) * 2
  const tuple = (b, p) => { const t = []; for (let a = 0; a < axisCount; a++) t.push(b.readInt16BE(p + a * 2) / 16384); return t }
  for (let i = 0; i < sharedCount; i++) shared.push(tuple(gv, sharedOff + i * axisCount * 2))

  const glyphs = []
  for (let gi = 0; gi < nG; gi++) {
    const gl = parseGlyph(T.glyf.subarray(loca(gi), loca(gi + 1)))
    glyphs.push(gl)
    const s0 = gOff(gi), s1 = gOff(gi + 1)
    const xMin = gl.simple && gl.pts.length ? Math.min(...gl.pts.map(q => q[0])) : gl.head ? gl.head.readInt16BE(2) : 0
    const pp1 = xMin - lsb[gi]
    // the four phantom points carry the advance width
    const orig = [...gl.pts.map(q => [q[0], q[1]]), [pp1, 0], [pp1 + adv[gi], 0], [0, 0], [0, 0]]
    const N = orig.length
    const sumX = new Array(N).fill(0), sumY = new Array(N).fill(0)
    if (s1 > s0) {
      const d = gv.subarray(dataOff + s0, dataOff + s1)
      const tc = d.readUInt16BE(0), count = tc & 0x0fff
      let hp = 4, sp = d.readUInt16BE(2), sharedPts = null
      if (tc & 0x8000) [sharedPts, sp] = readPoints(d, sp)
      for (let k = 0; k < count; k++) {
        const size = d.readUInt16BE(hp), ti = d.readUInt16BE(hp + 2); hp += 4
        let peak, lo = null, hi = null
        if (ti & 0x8000) { peak = tuple(d, hp); hp += axisCount * 2 }
        else peak = shared[ti & 0x0fff]
        if (ti & 0x4000) { lo = tuple(d, hp); hi = tuple(d, hp + axisCount * 2); hp += axisCount * 4 }
        const scalar = tupleScalar(coords, peak, lo, hi)
        const start = sp; sp += size
        if (!scalar) continue
        let p = start, pts = sharedPts
        if (ti & 0x2000) [pts, p] = readPoints(d, p)
        const n = pts ? pts.length : N
        let xs, ys
        ;[xs, p] = readDeltas(d, p, n)
        ;[ys, p] = readDeltas(d, p, n)
        const dx = new Array(N).fill(0), dy = new Array(N).fill(0), touched = new Array(N).fill(!pts)
        for (let i = 0; i < n; i++) {
          const at = pts ? pts[i] : i
          if (at >= N) continue
          dx[at] = xs[i]; dy[at] = ys[i]; touched[at] = true
        }
        if (pts && gl.simple) {
          let s = 0
          for (const e of gl.ends) { iup(orig, dx, dy, touched, s, e); s = e + 1 }
        }
        for (let i = 0; i < N; i++) { sumX[i] += dx[i] * scalar; sumY[i] += dy[i] * scalar }
      }
    }
    gl.pts = gl.pts.map((q, i) => [Math.round(q[0] + sumX[i]), Math.round(q[1] + sumY[i])])
    const np = gl.pts.length
    const newPp1 = Math.round(pp1 + sumX[np])
    adv[gi] = Math.max(0, Math.round(pp1 + adv[gi] + sumX[np + 1]) - newPp1)
    const newXMin = gl.simple && gl.pts.length ? Math.min(...gl.pts.map(q => q[0])) : gl.head ? xMin : 0
    lsb[gi] = newXMin - newPp1
  }

  // glyf and a long loca
  const bodies = glyphs.map(g => { const b = writeGlyph(g); return b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - b.length % 4)]) : b })
  const newLoca = Buffer.alloc((nG + 1) * 4)
  let off = 0
  bodies.forEach((b, i) => { newLoca.writeUInt32BE(off, i * 4); off += b.length })
  newLoca.writeUInt32BE(off, nG * 4)
  const hmtx = Buffer.alloc(nG * 4)
  for (let i = 0; i < nG; i++) { hmtx.writeUInt16BE(adv[i], i * 4); hmtx.writeInt16BE(lsb[i], i * 4 + 2) }
  hhea.writeUInt16BE(nG, 34); hhea.writeUInt16BE(Math.max(...adv), 10)
  head.writeInt16BE(1, 50); head.writeUInt32BE(0, 8)

  const DROP = new Set(['fvar', 'gvar', 'avar', 'HVAR', 'VVAR', 'MVAR', 'STAT', 'cvar', 'DSIG'])
  const out = { ...T, glyf: Buffer.concat(bodies), loca: newLoca, hmtx, hhea, head }
  for (const t of DROP) delete out[t]
  return sfnt(out)
}

// Tables to a font file, with the directory and checksums rebuilt
function sfnt(out, version = 0x00010000) {
  const tags = Object.keys(out).sort()
  const n = tags.length
  let es = 0; while ((2 << es) <= n) es++
  const dir = Buffer.alloc(12 + n * 16)
  dir.writeUInt32BE(version, 0); dir.writeUInt16BE(n, 4)
  dir.writeUInt16BE(16 << es, 6); dir.writeUInt16BE(es, 8); dir.writeUInt16BE(n * 16 - (16 << es), 10)
  const chunks = []
  let pos = dir.length
  tags.forEach((t, i) => {
    const b = out[t]
    dir.write(t, 12 + i * 16, 'latin1')
    dir.writeUInt32BE(checksum(b), 16 + i * 16)
    dir.writeUInt32BE(pos, 20 + i * 16); dir.writeUInt32BE(b.length, 24 + i * 16)
    const pad = (4 - b.length % 4) % 4
    chunks.push({ t, b, pos }); pos += b.length + pad
  })
  const file = Buffer.alloc(pos)
  dir.copy(file, 0)
  for (const c of chunks) c.b.copy(file, c.pos)
  const hp = chunks.find(c => c.t === 'head').pos
  file.writeUInt32BE((0xB1B0AFBA - checksum(file)) >>> 0, hp + 8)
  return file
}

// Cached by source file, its mtime and the coordinates, so an OS font update or a
// different size gets a fresh copy and everything else is a stat call.
function staticInstance(fontFile, want) {
  const key = Object.keys(want).sort().map(k => `${k}${want[k]}`).join('-')
  return cached(fontFile, key, buf => instantiate(buf, want))
}

function cached(fontFile, key, make) {
  const st = fs.statSync(fontFile)
  const dir = path.join(os.tmpdir(), 'fetch-fonts')
  const out = path.join(dir, `${path.parse(fontFile).name}-${Math.round(st.mtimeMs)}-${key}.ttf`)
  if (fs.existsSync(out)) return out
  const data = make(fs.readFileSync(fontFile))
  if (!data) return fontFile
  fs.mkdirSync(dir, { recursive: true })
  const tmp = out + '.' + process.pid
  fs.writeFileSync(tmp, data)
  fs.renameSync(tmp, out)             // never let a half-written font reach ffmpeg
  return out
}

// The style name (nameID 2, "Bold") from a name table
function subfamily(name) {
  if (!name) return ''
  const count = name.readUInt16BE(2), strings = name.readUInt16BE(4)
  // the English record: Mac Roman language 0, or Windows US English (others are localised)
  for (let i = 0; i < count; i++) {
    const r = 6 + i * 12
    if (name.readUInt16BE(r + 6) !== 2) continue
    const plat = name.readUInt16BE(r), lang = name.readUInt16BE(r + 4)
    const len = name.readUInt16BE(r + 8), off = strings + name.readUInt16BE(r + 10)
    const raw = name.subarray(off, off + len)
    if (plat === 1 && lang === 0) return raw.toString('latin1')
    if (plat === 3 && lang === 0x409) return Buffer.from(raw).swap16().toString('utf16le')
  }
  return ''
}

// drawtext always loads the first face of a .ttc, so the bold cut of Helvetica or
// Avenir Next is out of its reach. Copy the named face out as a font of its own.
function collectionFace(fontFile, style) {
  return cached(fontFile, style.replace(/\W+/g, ''), buf => {
    if (buf.toString('latin1', 0, 4) !== 'ttcf') return null
    for (let i = 0, n = buf.readUInt32BE(8); i < n; i++) {
      const at = buf.readUInt32BE(12 + i * 4), T = tables(buf, at)
      if (subfamily(T.name) !== style) continue
      const head = Buffer.from(T.head); head.writeUInt32BE(0, 8)
      return sfnt({ ...T, head }, buf.readUInt32BE(at))
    }
    return null
  })
}

module.exports = { staticInstance, instantiate, collectionFace }
