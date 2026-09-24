// The fonts a project ships, so a picture of somebody's app can be typeset in that
// app's own face.
//
// Fetch's font list was seven files under /System/Library, which is every face macOS
// has and none of the ones that matter: the product being filmed sets its headings in
// something it carries with it, and a title card in SF Pro beside a screen set in Onest
// reads as a stock template over somebody's work. The project is already named on the
// job, and the fonts are sitting inside it.
//
// The family name is read out of the file rather than guessed from it. A file called
// Onest-VF.ttf is the Onest family and a file called DMSans-VF.ttf is "DM Sans", and no
// rule over the filename gets both right, so this parses the name table: nameID 16 (the
// typographic family) where a font has one, else nameID 1.
const fs = require('fs')
const path = require('path')

const EXT = /\.(ttf|otf|ttc)$/i
// Nothing under here is a product's own typeface: these hold dependencies, build
// output and caches, and walking them costs seconds on a real repository.
const SKIP = new Set(['node_modules', '.git', '.build', 'DerivedData', 'Pods', 'Carthage',
  'dist', 'build', 'vendor', '.next', 'target', '.venv', 'venv', '__pycache__'])
// A project is walked this far down and no further. Fonts live near the top of a
// repository (Resources/, Assets/, Fonts/) or inside a built bundle; a font twelve
// levels down is somebody's dependency, whatever the folder is called.
const MAX_DEPTH = 6
const MAX_FILES = 64

function tableDir(buf, at = 0) {
  if (buf.length < at + 12) return null
  const n = buf.readUInt16BE(at + 4), out = {}
  for (let i = 0; i < n; i++) {
    const r = at + 12 + i * 16
    if (r + 16 > buf.length) return out
    const tag = buf.toString('latin1', r, r + 4)
    const off = buf.readUInt32BE(r + 8), len = buf.readUInt32BE(r + 12)
    if (off + len <= buf.length) out[tag] = buf.subarray(off, off + len)
  }
  return out
}

// The name table, read for one id. Windows/Unicode records are UTF-16BE and Macintosh
// records are single byte; both are read, and the Windows one wins where a font has
// both, because that is the one carrying the full name on every font measured here.
function readName(name, want) {
  if (!name || name.length < 6) return null
  const count = name.readUInt16BE(2), strOff = name.readUInt16BE(4)
  let mac = null, win = null
  for (let i = 0; i < count; i++) {
    const r = 6 + i * 12
    if (r + 12 > name.length) break
    const platform = name.readUInt16BE(r), nameId = name.readUInt16BE(r + 6)
    if (nameId !== want) continue
    const len = name.readUInt16BE(r + 8), off = strOff + name.readUInt16BE(r + 10)
    if (off + len > name.length) continue
    const raw = name.subarray(off, off + len)
    if (platform === 3 || platform === 0) win = raw.toString('utf16le').split('').length
      ? Buffer.from(raw).swap16().toString('utf16le') : null
    else if (platform === 1) mac = raw.toString('latin1')
  }
  const out = win || mac
  return out ? out.replace(/\0/g, '').trim() || null : null
}

/** The family name inside a font file, or null where the file is not one Fetch reads. */
function familyOf(file) {
  let buf
  try { buf = fs.readFileSync(file) } catch { return null }
  if (buf.length < 12) return null
  const tag = buf.readUInt32BE(0)
  // 'ttcf': a collection. Its first face names the family; the rest are its cuts.
  const at = tag === 0x74746366 ? (buf.length >= 16 ? buf.readUInt32BE(12) : 0) : 0
  const t = tableDir(buf, at)
  if (!t || !t.name) return null
  return readName(t.name, 16) || readName(t.name, 1)
}

function walk(dir, depth, out) {
  if (depth > MAX_DEPTH || out.length >= MAX_FILES) return
  let entries = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    if (out.length >= MAX_FILES) return
    const name = e.name
    if (name.startsWith('.') && name !== '.') continue
    const full = path.join(dir, name)
    // a built .app is walked into: that is where a shipped app keeps its faces
    if (e.isDirectory()) {
      if (SKIP.has(name)) continue
      walk(full, depth + 1, out)
    } else if (EXT.test(name)) out.push(full)
  }
}

/**
 * Every font a project carries, as { family, file }, one entry per family.
 *
 * Where a family ships several files (a regular and a bold, or a variable font beside
 * static cuts) the first found wins and the rest are dropped: the renderer picks a
 * weight off one file, and two entries with one name would be a list with a duplicate
 * in it rather than a choice anybody could make.
 */
function fontsIn(root) {
  if (!root || typeof root !== 'string') return []
  let real = null
  try { real = fs.statSync(root).isDirectory() ? root : null } catch { return [] }
  if (!real) return []
  const files = []
  walk(real, 0, files)
  const seen = new Map()
  for (const file of files.sort()) {
    const family = familyOf(file)
    if (!family || seen.has(family)) continue
    seen.set(family, { family, file })
  }
  return [...seen.values()]
}

module.exports = { fontsIn, familyOf }
