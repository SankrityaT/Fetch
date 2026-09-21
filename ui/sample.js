// Fetch: the sample library, so someone can try the whole product before they record.
//
// Three things Fetch made itself (assets/sample/, see its NOTICE.md): a Mac window take
// an agent drove, a simulator take of a phone and a window screenshot, all of one made
// up product, Biscuit's Pantry. Opening the sample copies them into a scratch folder of
// their own, laid out exactly as real takes are (<Take>/Original/<Take>.mp4 with its
// sidecars in .fetch/), so the editor, the agent's tools and every export treat them as
// takes and write where a take's exports go: inside the sample, never beside anything
// of the person's.
//
// The promise is that the person's own library is never touched, and that leaving the
// sample puts everything back exactly. So:
//
//   - the scratch folder is never the save folder, never inside it and never holds it
//     (open refuses, and says which)
//   - it is only ever deleted when it carries the marker this file wrote into it, so a
//     wrong path can never take a folder of the person's with it
//   - while the sample is open the Library's own folders and provenance are set aside
//     in memory and collections.json is not written (ui/library.js enterSample)
//   - fingerprint() reads the person's save folder and the files beside it, and leaving
//     compares it with the one taken on the way in, so "untouched" is measured rather
//     than said
//
// The file-level half (open, list, close, fingerprint) is plain node with no DOM, and
// test/sample.test.js drives it against a real save folder in a temporary directory.
// The session half (enter, leave) runs in the renderer and is reached from the chip
// ui/library.js draws in the Library bar.

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')

const ASSETS = path.join(__dirname, '..', 'assets', 'sample')
const MARK = '.fetch-sample'
const SIDE_DIR = '.fetch'
const ORIGINAL = 'Original'
const DEFAULT_SAVE = path.join(os.homedir(), 'Movies', 'Fetch')

// The scratch folder, per user and per machine. tmpdir on macOS is already the user's
// own (/var/folders/...), and a sample left there by a crash is cleared the next time
// one is opened.
const defaultRoot = () => path.join(os.tmpdir(), 'Fetch Sample')

function manifest(assets = ASSETS) {
  const m = JSON.parse(fs.readFileSync(path.join(assets, 'sample.json'), 'utf8'))
  if (!m || !Array.isArray(m.items) || !m.items.length) throw new Error('the sample has nothing in it')
  return m
}

// ── where it may live ───────────────────────────────────────────────────────
// A folder that is not there yet is resolved through the nearest one that is: on macOS
// /var is /private/var, and comparing one spelling with the other would wave a sample
// straight into the person's folder.
const real = p => {
  let at = path.resolve(p)
  const rest = []
  for (;;) {
    try { return path.join(fs.realpathSync(at), ...rest) } catch {}
    const up = path.dirname(at)
    if (up === at) return path.resolve(p)
    rest.unshift(path.basename(at))
    at = up
  }
}
// true when b is a or anywhere under it, after symlinks (/var is /private/var on macOS)
const within = (a, b) => {
  const A = real(a), B = real(b)
  const rel = path.relative(A, B)
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * Why a scratch folder cannot hold the sample, or null when it can. The person's
 * folders are the save folder and every other folder Fetch reads takes from; the
 * sample may be none of them, inside none of them and hold none of them.
 */
function refusal(root, theirs = []) {
  if (!root || !path.isAbsolute(String(root))) return 'the sample needs a folder of its own, by full path'
  const r = path.resolve(root)
  if (r === path.parse(r).root || r === os.homedir()) return 'the sample will not live at the top of a disk or a home folder'
  for (const t of theirs.filter(Boolean)) {
    if (within(t, r)) return `the sample will not go inside ${t}, which holds your own takes`
    if (within(r, t)) return `the sample will not go in a folder that holds ${t}`
  }
  // a folder that is already there and is not a sample is somebody's
  if (fs.existsSync(r) && !isSample(r) && !leftover(r) && fs.readdirSync(r).length) return `${r} already holds something that is not the sample`
  return null
}

const isSample = root => { try { return fs.statSync(path.join(root, MARK)).isFile() } catch { return false } }

// What a late export leaves when the sample was deleted under it: processor's sidecar
// write makes <root>/<Title>/Original/.fetch again with no marker, and the next open
// would refuse the folder for good. A folder holding only the sample's own take folders
// (by title), each holding only an Original folder, is that, and is the sample's to clear.
function leftover(root, assets) {
  try {
    const titles = new Set(manifest(assets).items.map(it => String(it.title)))
    const names = fs.readdirSync(root).filter(n => n !== '.DS_Store')
    return names.length > 0 && names.every(n => titles.has(n) && fs.statSync(path.join(root, n)).isDirectory() &&
      fs.readdirSync(path.join(root, n)).every(m => m === ORIGINAL || m === '.DS_Store'))
  } catch { return false }
}

// ── open ────────────────────────────────────────────────────────────────────
/**
 * Lay the sample out as take folders under `root`, fresh. Returns
 * { root, product, items: [{ id, kind, platform, title, path, take, try }] }.
 *
 * @param {object} [opts]
 *   @param {string}   [opts.root]    the scratch folder; defaultRoot() otherwise
 *   @param {string[]} [opts.theirs]  the person's folders, which the sample stays out of
 *   @param {string}   [opts.assets]  where the sample's files are; assets/sample otherwise
 *   @param {number}   [opts.now]     the clock, so the cards read as just made
 */
function open(opts = {}) {
  const root = path.resolve(opts.root || defaultRoot())
  const theirs = opts.theirs || [DEFAULT_SAVE]
  const why = refusal(root, theirs)
  if (why) throw new Error(why)
  const m = manifest(opts.assets)
  const assets = opts.assets || ASSETS
  // what an earlier sample left is its own, and it goes: every open starts clean
  if (isSample(root) || leftover(root, opts.assets)) fs.rmSync(root, { recursive: true, force: true })
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, MARK), JSON.stringify({ v: 1, product: m.product, opened: new Date().toISOString(), pid: process.pid }) + '\n')

  const now = Number.isFinite(opts.now) ? opts.now : Date.now()
  const items = m.items.map((it, i) => {
    const title = String(it.title)
    const take = path.join(root, title)
    const orig = path.join(take, ORIGINAL)
    fs.mkdirSync(path.join(orig, SIDE_DIR), { recursive: true })
    const file = path.join(orig, title + path.extname(it.file))
    fs.copyFileSync(path.join(assets, it.file), file)
    for (const [ext, from] of Object.entries(it.sidecars || {})) {
      const to = path.join(orig, SIDE_DIR, title + ext)
      let txt = fs.readFileSync(path.join(assets, from), 'utf8')
      // an edit document names its own take, and a copy must name the copy
      if (ext === '.fetchdoc.json') { const d = JSON.parse(txt); d.src = file; txt = JSON.stringify(d, null, 2) }
      fs.writeFileSync(to, txt)
    }
    // a minute apart, first item newest, so the Library draws them in the manifest's order
    const t = new Date(now - i * 60000)
    for (const p of [file, take]) fs.utimesSync(p, t, t)
    return { id: it.id, kind: it.kind, platform: it.platform, title, path: file, take, try: it.try || '' }
  })
  return { root, product: m.product, items }
}

// ── list ────────────────────────────────────────────────────────────────────
/**
 * What the Library and list_recordings show while the sample is open: the sample's
 * files and nothing else, in exactly the shape processor.listRecordings returns, each
 * marked `sample` and carrying its platform. Exports an agent made land in the same
 * take folders and are listed with them.
 */
function list(root, proc) {
  if (!root || !isSample(root)) return []
  const p = proc || require('../processor')
  let m = null
  try { m = manifest() } catch {}
  const byTitle = new Map(((m && m.items) || []).map(it => [it.title, it]))
  return p.listRecordings(root, [])
    .filter(e => e && e.path && within(root, e.path))
    .map(e => {
      const it = e.take ? byTitle.get(path.basename(e.take)) : null
      // the kind stays the processor's (video, audio): a shot is read off its extension
      return { ...e, sample: true, ...(it && it.platform ? { platform: it.platform } : {}) }
    })
}

// ── close ───────────────────────────────────────────────────────────────────
/**
 * Delete the sample, everything an agent made inside it included. Only a folder that
 * carries the sample's marker is ever deleted; anything else is refused and left.
 */
function close(root, theirs = [DEFAULT_SAVE]) {
  if (!root) return { removed: false, reason: 'no sample is open' }
  const r = path.resolve(root)
  if (!fs.existsSync(r)) return { removed: false, reason: 'the sample is already gone' }
  if (!isSample(r)) return { removed: false, reason: `${r} is not the sample, so it was left alone` }
  for (const t of theirs.filter(Boolean)) {
    if (within(t, r) || within(r, t)) return { removed: false, reason: `${r} overlaps ${t}, so it was left alone` }
  }
  fs.rmSync(r, { recursive: true, force: true })
  return { removed: !fs.existsSync(r) }
}

// ── proof that nothing of theirs moved ──────────────────────────────────────
/**
 * A digest of every file under the person's folders (its path, size and modified
 * time) plus the contents of the loose files that describe the library
 * (collections.json, library.json). Stat only for media, so a library of long takes
 * costs a directory walk and not a read of every take.
 *
 * @param {string[]} dirs   folders to walk
 * @param {string[]} files  files whose contents count
 */
function fingerprint(dirs = [], files = [], cap = 50000) {
  const h = crypto.createHash('sha256')
  let n = 0
  const walk = d => {
    let names
    try { names = fs.readdirSync(d).sort() } catch { return }
    for (const name of names) {
      if (n >= cap) return
      const full = path.join(d, name)
      let st
      try { st = fs.lstatSync(full) } catch { continue }
      n++
      h.update(`${full}\0${st.isDirectory() ? 'd' : st.size}\0${Math.round(st.mtimeMs)}\n`)
      if (st.isDirectory()) walk(full)
    }
  }
  for (const d of dirs.filter(Boolean)) { h.update(`dir ${d}\n`); walk(d) }
  for (const f of files.filter(Boolean)) {
    h.update(`file ${f}\n`)
    try { h.update(fs.readFileSync(f)) } catch { h.update('absent') }
  }
  return { digest: h.digest('hex'), entries: n }
}

// ── the session, in the renderer ────────────────────────────────────────────
// The main process owns the list the Library and the agent read (main.js list-recordings
// and agent-bridge recordings.list). It is told where the sample is through
// 'sample-root', and until it answers to that, the Library reads the list from here.
let session = null
const headless = typeof document === 'undefined'
const ipc = () => { try { return require('electron').ipcRenderer } catch { return null } }
const say = (msg, kind, ms) => { if (!headless && typeof window.toast === 'function') window.toast(msg, kind, ms) }
const again = () => { if (!headless && typeof window.refreshLibrary === 'function') window.refreshLibrary() }

function theirFolders() {
  const out = [DEFAULT_SAVE]
  try {
    const prefs = ipc() && ipc().sendSync('prefs-get-sync')
    if (prefs && prefs.saveDir) out.unshift(prefs.saveDir)
  } catch {}
  return [...new Set(out)]
}
const APP_SUPPORT = path.join(os.homedir(), 'Library', 'Application Support', 'Fetch')
// the Library's folders and provenance, its import index, the person's settings, what
// Fetch remembers about them and their products, and the activity log (whose sample rows
// main.js drops before this is read on the way out). The chat's own transcript is not
// here: what they say to the agent while trying the sample is their conversation.
const theirFiles = () => ['collections.json', 'library.json', 'prefs.json', 'memory.json', 'activity.jsonl'].map(f => path.join(APP_SUPPORT, f))

async function enter(opts = {}) {
  if (session) return session
  const theirs = opts.theirs || theirFolders()
  const before = fingerprint(theirs, opts.files || theirFiles())
  const s = open({ ...opts, theirs })
  session = { ...s, theirs, files: opts.files || theirFiles(), before }
  require('./library').enterSample(s.root)
  const r = ipc()
  if (r) { try { await r.invoke('sample-root', s.root) } catch {} }
  again()
  return session
}

async function leave() {
  if (!session) return { left: false }
  const s = session
  session = null
  const r = ipc()
  if (r) { try { await r.invoke('sample-root', null) } catch {} }
  require('./library').leaveSample()
  // an editor holding a sample take closes on the refresh below, once its file is gone
  const gone = close(s.root, s.theirs)
  const after = fingerprint(s.theirs, s.files)
  const untouched = after.digest === s.before.digest
  // A take the person recorded while it was open changes their folders, and that is
  // theirs, not the sample's: it is said, never undone.
  if (!gone.removed) say(`Left the sample. ${gone.reason}`, 'bad', 6000)
  else if (!untouched) say('Left the sample. Your own folders changed while it was open, and the sample did not change them.', 'ok', 6000)
  else say('Left the sample. Your library is exactly as you left it.', 'ok')
  again()
  return { left: true, removed: !!gone.removed, untouched }
}

// Listed from here while the sample is open, for a main process that does not yet
// answer 'sample-root' itself. The processor is required on first use only.
const current = () => (session ? list(session.root) : null)

module.exports = {
  ASSETS, MARK, defaultRoot, manifest, refusal, isSample, leftover, within,
  open, list, close, fingerprint,
  enter, leave, current,
  active: () => !!session,
  root: () => (session ? session.root : null),
  items: () => (session ? session.items.map(i => ({ ...i })) : []),
  product: () => (session ? session.product : null),
}
