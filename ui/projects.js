// The project index: every project the person's coding tools know about, as one list,
// so @ in the chat can point at one and the agent is handed its name, path, branch and
// what it is, instead of the person pasting a path.
//
// Three tools, three places:
//   Conductor    ~/conductor/workspaces/<repo>/<workspace>, ~/conductor/repos/<repo>, and
//                its database (workspaces and repos tables), which knows branches, repos
//                kept outside ~/conductor, which workspaces are archived, and when each
//                was last worked in
//   Orca         ~/orca/projects/<project> and ~/orca/workspaces/<project>/<workspace>
//   Claude Code  ~/.claude/projects/<folder>, a folder per working directory, named for
//                its path with every / (and every other non-letter) turned into a dash
//
// One folder known to two tools is one project, named by the tool that knows most about
// it (Conductor, then Orca, then Claude Code). A path that no longer exists is left out.
// Most recently worked in comes first.
//
// ── What this reads, and what it never opens ────────────────────────────
// This walks other tools' data about other projects, so it reads the least that
// answers the question:
//   - folder names, and stat() for dates
//   - per project, the first 4 KB of one of README, PRODUCT.md, CLAUDE.md or AGENTS.md
//   - per project, .git/HEAD for the branch and the git config for the remote URL
//     (credentials in a URL are cut before it leaves this file)
//   - Conductor's database, read only (sqlite3 -readonly, mode=ro), and only these
//     columns: workspaces.workspace_path, directory_name, workspace_name, branch, state,
//     updated_at, repository_id, and repos.id, name, root_path, remote_url
// Every file open goes through readHead, which refuses anything named like a secret
// (.env of any kind, key, secret, token, credential, password, keypair, SSH and GPG
// material) and anything that is a symlink, so a README pointing at a .env is not
// followed. Claude Code's folders are listed and stat()ed, never opened: they hold chat
// history. Nothing here writes, and nothing leaves the machine.
//
// ── How stale it can be ──────────────────────────────────────────────────
// projectIndex() keeps what it built for MAX_AGE (30 s). Within that it rebuilds early
// if the folders the tools create projects in have changed, which costs a few dozen
// stat() calls, so a new workspace or a new Claude Code folder shows at once. What can
// be up to 30 s old: a branch switched inside an existing project, an edited README,
// and the recency order. Pass { fresh: true } to skip the cache. projectIndexAsync(),
// which main should use, builds on a worker thread and serves a stale list while it
// rebuilds, so there the stalest case is 30 s plus one build (a few hundred ms).
//
// Pure apart from the filesystem and the sqlite3 runner, both injectable, so
// test/projects.test.js runs it under node against a fake home.

'use strict'

const path = require('path')
const crypto = require('crypto')

const MAX_AGE = 30000
const HEAD_BYTES = 4096
const ABOUT_MAX = 220
const SOURCE_RANK = { conductor: 0, orca: 1, claude: 2 }
// README first because it says what the thing is; the agent files say how to work on it
const ABOUT_FILES = ['readme.md', 'readme', 'readme.markdown', 'readme.txt', 'product.md', 'claude.md', 'agents.md']

// ── the gate ──────────────────────────────────────────────────────────────

// A name that could hold a secret. Tested on every part of the path, so a README inside
// a folder called secrets is not opened either. "key" stands alone as a word so a
// project called monkey or keyboard still gets its description.
const SECRET_NAME = new RegExp([
  '(^|\\.)env($|\\.)', '\\.env', 'envrc',
  '(^|[^a-z])keys?([^a-z]|$)', 'apikey', 'privkey', 'pubkey', 'keypair', 'keychain', 'keystore',
  'secret', 'token', 'credential', 'passw', 'auth\\.json', 'netrc',
  '^id_(rsa|dsa|ecdsa|ed25519)', '\\.(pem|p12|pfx|gpg|pgp|asc|kdbx|jsonl)$',
].join('|'), 'i')
const SECRET_DIR = /^\.(ssh|gnupg|gpg|aws|kube|docker|password-store)$/i

function mayOpen(file, home) {
  const parts = path.resolve(file).split(path.sep).filter(Boolean)
  if (parts.some(p => SECRET_NAME.test(p) || SECRET_DIR.test(p))) return false
  // Claude Code's per-project folders are chat history, and never opened
  if (home) {
    const chats = path.join(home, '.claude', 'projects') + path.sep
    if (path.resolve(file).startsWith(chats)) return false
  }
  return true
}

// What was read last time, kept while the file's date and size stand, so a rebuild
// stat()s a README instead of reading it again. Per fs, so a test's fake stays apart.
const heads = new WeakMap()

// The first bytes of a file, or null. The only way this module opens a file.
//
// The name check runs twice: on the path as asked, and on the path it really is, with
// every folder on the way resolved. A worktree's .git file can name a gitdir anywhere,
// and a symlinked folder earlier in the path (lnk -> ~/.ssh) would otherwise carry the
// open past a check that only saw ".../lnk/config". roots, when given, are the folders
// the real path has to stay inside. Opened with O_NOFOLLOW and checked to be the same
// file that was looked at, so nothing is swapped in between.
function readHead(fs, file, bytes, home, roots) {
  if (!mayOpen(file, home)) return null
  let st
  try { st = fs.lstatSync(file) } catch { return null }
  if (!st.isFile()) return null                     // a symlink or a folder is not followed
  let real
  try { real = fs.realpathSync(file) } catch { return null }
  if (!mayOpen(real, home) || (home && !mayOpen(real, realOf(fs, home)))) return null
  if (roots && !roots.some(r => r && (real === r || real.startsWith(r + path.sep)))) return null
  if (!heads.has(fs)) heads.set(fs, new Map())
  const memo = heads.get(fs), key = real + '\0' + bytes, had = memo.get(key)
  if (had && had.m === st.mtimeMs && had.s === st.size && had.i === st.ino) return had.text
  const C = fs.constants || require('fs').constants
  let fd = null, text = null
  try {
    fd = fs.openSync(real, C.O_RDONLY | C.O_NOFOLLOW)
    const now = fs.fstatSync(fd)
    if (!now.isFile() || now.ino !== st.ino || now.dev !== st.dev) return null
    const buf = Buffer.alloc(Math.min(bytes, now.size))
    const n = fs.readSync(fd, buf, 0, buf.length, 0)
    text = buf.slice(0, n).toString('utf8')
  } catch { return null } finally { if (fd != null) try { fs.closeSync(fd) } catch {} }
  memo.set(key, { m: st.mtimeMs, s: st.size, i: st.ino, text })
  return text
}

const statOf = (fs, p) => { try { return fs.statSync(p) } catch { return null } }
const isDir = (fs, p) => { const s = statOf(fs, p); return !!(s && s.isDirectory()) }
const mtimeOf = (fs, p) => { const s = statOf(fs, p); return s ? s.mtimeMs : 0 }
const listDirs = (fs, dir) => {
  let names
  try { names = fs.readdirSync(dir) } catch { return [] }
  return names.filter(n => !n.startsWith('.') && isDir(fs, path.join(dir, n)))
}
const realOf = (fs, p) => { try { return fs.realpathSync(p) } catch { return path.resolve(p) } }

// ── what a project says it is ─────────────────────────────────────────────

// Anything shaped like a pasted key in the first lines of a README is cut, since the
// description is handed to an agent. Cleaning is the second line of defence: a first
// paragraph that talks about a password, a token, a key or a secret at all is dropped
// whole (SECRETISH), because a 12 character password has no shape to find. Then a URL
// with a user or password in it, or with a query, goes; then any run of 20 or more
// characters with letters and digits in it, dots, slashes, plus and equals included, so a
// key split into parts, a JWT or a webhook path goes as one; then a long base64 run.
const SECRETISH = /\b(passw(or)?ds?|passphrases?|secrets?|tokens?|api[\s_-]?keys?|access[\s_-]?keys?|private[\s_-]?keys?|bearer|authorization|credentials?)\b|BEGIN\b/i
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>()"']+/gi
const RUN_RE = /[A-Za-z0-9+/=._~-]{20,}/g
const KEYISH = /\b(?=[A-Za-z0-9_\-]*\d)(?=[A-Za-z0-9_\-]*[A-Za-z])[A-Za-z0-9_\-]{32,}\b/g
const B64_RE = /(?=[A-Za-z0-9+/=_-]*[a-z])(?=[A-Za-z0-9+/=_-]*[A-Z])[A-Za-z0-9+/=_-]{40,}/g
const mixed = t => /\d/.test(t) && /[A-Za-z]/.test(t)
function scrub(t) {
  return t
    .replace(URL_RE, u => (/^[^/]*\/\/[^/]*@/.test(u) || /[?#]/.test(u) || (u.match(RUN_RE) || []).some(mixed)) ? '…' : u)
    .replace(RUN_RE, r => mixed(r) ? '…' : r)
    .replace(KEYISH, '…')
    .replace(B64_RE, '…')
}

// The line every agent file opens with, which says nothing about the project
const BOILERPLATE = /^this file (provides|gives|contains|is) (guidance|instructions|context)\b/i

// One or two lines from the top of a markdown file: the first paragraph of prose, with
// headings, badges, HTML, code and front matter skipped. The first heading stands in
// when there is no prose.
function aboutFrom(text) {
  if (!text) return null
  let s = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  s = s.replace(/^---\n[\s\S]*?\n---\n/, '')                    // front matter
  s = s.replace(/<!--[\s\S]*?(-->|$)/g, '')                      // comments
  // A paragraph that is only a quote is a tagline (> Record it. Fetch it.): kept in case
  // nothing better follows, but the prose after it says what the thing is.
  let heading = null, tagline = null, para = [], quoted = true, fence = false
  const end = () => {
    if (!para.length) return false
    if (quoted && !tagline) { tagline = para.join(' '); para = []; quoted = true; return false }
    if (BOILERPLATE.test(para.join(' '))) { para = []; quoted = true; return false }
    return true
  }
  for (const raw of s.split('\n')) {
    const line = raw.trim()
    if (/^(```|~~~)/.test(line)) { fence = !fence; if (end()) break; continue }
    if (fence) continue
    if (!line) { if (end()) break; continue }
    const h = /^#{1,6}\s+(.*)$/.exec(line)
    if (h) { if (end()) break; if (!heading) heading = h[1]; continue }
    if (/^(<[^>]+>\s*)+$/.test(line) || /^\[?!\[/.test(line) || /^(\||[-=*_]{3,}$)/.test(line)) { if (end()) break; continue }
    if (/^([-*+]|\d+\.)\s/.test(line) && !para.length) continue  // a list before any prose
    if (!/^>/.test(line)) quoted = false
    para.push(line.replace(/^>\s?/, ''))
  }
  if (para.length && quoted && !tagline) { tagline = para.join(' '); para = [] }
  const clean = t => t
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[*_`]+/g, '')
    .replace(/\s+/g, ' ').trim()
  let out = clean(para.join(' ')) || (tagline ? clean(tagline) : '') || (heading ? clean(heading) : '')
  if (!out || SECRETISH.test(out)) return null
  out = scrub(out).replace(/…(\s*…)+/g, '…')
  if (!/[A-Za-z]{2}/.test(out.replace(/…/g, ''))) return null
  // two sentences at most, and never past the cap
  const two = /^(.+?[.!?])\s+(.+?[.!?])(\s|$)/.exec(out)
  if (two && two[1].length + two[2].length + 1 < out.length) out = two[1] + ' ' + two[2]
  if (out.length > ABOUT_MAX) out = out.slice(0, ABOUT_MAX - 1).replace(/\s+\S*$/, '') + '…'
  return out
}

function aboutOf(fs, dir, home) {
  let names
  try { names = fs.readdirSync(dir) } catch { return null }
  const byLower = new Map(names.map(n => [n.toLowerCase(), n]))
  for (const want of ABOUT_FILES) {
    const name = byLower.get(want)
    if (!name) continue
    const a = aboutFrom(readHead(fs, path.join(dir, name), HEAD_BYTES, home, [dir]))
    if (a) return a
  }
  return null
}

// ── git, read from its files rather than by running git ───────────────────

// A remote keeps its host and path only: a user, a password, a query (?token=...) and a
// fragment are all cut. A URL the parser refuses (https://user:ab/cd@host/..., where the
// password holds a slash) loses everything up to its last @.
function cleanRemote(url) {
  if (!url) return null
  url = String(url).trim()
  const scheme = /^([a-z][a-z0-9+.-]*:\/\/)(.*)$/i.exec(url)
  if (scheme) {
    try {
      const u = new URL(url)
      if (!u.pathname.includes('@') && !u.host.includes('@')) {
        u.username = ''; u.password = ''; u.search = ''; u.hash = ''
        return u.toString()
      }
    } catch {}
    let rest = scheme[2].replace(/[?#].*$/, '')
    const at = rest.lastIndexOf('@')
    if (at >= 0) rest = rest.slice(at + 1)
    return scheme[1] + rest
  }
  // scp form, git@host:owner/repo, or a folder. A bare user before the @ stays (it is
  // git's own); anything with a colon or a slash before it is not a user and goes.
  let s = url.replace(/[?#].*$/, '')
  const at = s.lastIndexOf('@')
  if (at >= 0 && /[:/\s]/.test(s.slice(0, at))) s = s.slice(at + 1)
  return s
}

// owner/repo from a GitHub-style remote, for a person to read
function remoteShort(url) {
  const m = /[:/]([^/:]+\/[^/]+?)(\.git)?\/?$/.exec(url || '')
  return m ? m[1] : null
}

// A git folder a project may read from: inside the project, or a real git folder's own
// worktrees or modules (a Conductor worktree's gitdir is <repo>/.git/worktrees/<name>).
// Resolved for real first, so a symlink cannot make ~/.ssh look like either.
const GIT_SHAPE = /(^|\/)[^/]*\.git\/(worktrees|modules)\//
const realStrict = (fs, p) => { try { return fs.realpathSync(p) } catch { return null } }
const inside = (p, root) => p === root || p.startsWith(root + path.sep)

function gitInfo(fs, dir, home) {
  const dotgit = path.join(dir, '.git')
  let st
  try { st = fs.lstatSync(dotgit) } catch { return null }
  let gitdir
  if (st.isFile()) {                                // a worktree: .git names the real one
    const m = /^gitdir:\s*(.+)$/m.exec(readHead(fs, dotgit, 1024, home, [dir]) || '')
    if (!m) return null
    gitdir = realStrict(fs, path.resolve(dir, m[1].trim()))
    if (!gitdir || !(inside(gitdir, dir) || GIT_SHAPE.test(gitdir + '/'))) return null
  } else if (st.isDirectory()) {
    gitdir = realStrict(fs, dotgit)
    if (!gitdir || !inside(gitdir, dir)) return null
  } else return null
  if (!mayOpen(gitdir, home)) return null
  // commondir only ever points up: to the git folder this worktree's folder sits in
  const cd = readHead(fs, path.join(gitdir, 'commondir'), 1024, home, [gitdir])
  let common = gitdir
  if (cd) {
    const c = realStrict(fs, path.resolve(gitdir, cd.trim()))
    if (!c || !inside(gitdir, c) || !(inside(c, dir) || /\.git$/.test(c)) || !mayOpen(c, home)) return null
    common = c
  }
  const head = (readHead(fs, path.join(gitdir, 'HEAD'), 512, home, [gitdir]) || '').trim()
  const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head)
  const branch = ref ? ref[1] : null
  const detached = !ref && /^[0-9a-f]{7,}$/.test(head) ? head.slice(0, 7) : null
  let remote = null
  const config = readHead(fs, path.join(common, 'config'), 65536, home, [common]) || ''
  const sections = config.split(/^\s*\[/m)
  const pick = name => {
    const sec = sections.find(s => new RegExp(`^remote\\s+"${name}"\\s*\\]`).test(s))
    const u = sec && /^\s*url\s*=\s*(.+)$/m.exec(sec)
    return u ? u[1].trim() : null
  }
  remote = pick('origin')
  if (!remote) { const any = /^remote\s+"([^"]+)"/m.exec(sections.find(s => /^remote\s+"/.test(s)) || ''); if (any) remote = pick(any[1]) }
  remote = cleanRemote(remote)
  // when it was last touched: the index moves on status, add and commit, HEAD's log on
  // checkout and commit
  const at = Math.max(mtimeOf(fs, path.join(gitdir, 'index')), mtimeOf(fs, path.join(gitdir, 'logs', 'HEAD')), mtimeOf(fs, path.join(gitdir, 'HEAD')))
  return { branch, detached, remote, at }
}

// ── Claude Code's folder names back to paths ──────────────────────────────

// Claude Code names a folder for its working directory with every character that is not
// a letter or digit turned into a dash (older versions kept spaces). A dash in the real
// name is therefore ambiguous, so the path is found by walking the disk: at each level,
// the entry whose own encoding starts what is left. Longest name first, and a path that
// holds a git repo beats one that does not when both exist.
const encodeSeg = s => String(s).replace(/[^A-Za-z0-9]/g, '-')

function decodeClaudeFolder(fs, folder) {
  const want = encodeSeg(folder)
  if (!want.startsWith('-')) return null
  const found = []
  const walk = (dir, rest, depth) => {
    if (found.length > 3 || depth > 40) return
    if (rest === '') { found.push(dir); return }
    let names
    try { names = fs.readdirSync(dir) } catch { return }
    const hits = []
    for (const n of names) {
      const e = '-' + encodeSeg(n)
      if (rest === e || rest.startsWith(e + '-')) hits.push([n, e])
    }
    hits.sort((a, b) => b[1].length - a[1].length)
    for (const [n, e] of hits) {
      const next = path.join(dir, n)
      if (isDir(fs, next)) walk(next, rest.slice(e.length), depth + 1)
    }
  }
  walk(path.sep, want, 0)
  if (!found.length) return null
  return found.find(p => statOf(fs, path.join(p, '.git'))) || found[0]
}

// A Claude Code folder's last activity is the folder's own date, which moves when a
// session starts in it. Not the newest session file's: this Mac has 2,600 of them and
// stat()ing each costs most of a second, while a project in active use is dated by its
// git index or by Conductor anyway. The files are chat history and are never opened.
const claudeActivity = (fs, dir) => mtimeOf(fs, dir)

// ── Conductor's database ──────────────────────────────────────────────────

const CONDUCTOR_SQL =
  'SELECT w.workspace_path AS path, w.directory_name AS dir, w.workspace_name AS wname, ' +
  'w.branch AS branch, w.state AS state, w.updated_at AS updated, ' +
  'r.name AS repo, r.root_path AS root, r.remote_url AS remote ' +
  'FROM workspaces w LEFT JOIN repos r ON r.id = w.repository_id ' +
  'UNION ALL ' +
  "SELECT NULL, NULL, NULL, NULL, 'repo', NULL, r.name, r.root_path, r.remote_url FROM repos r"

// The real runner: the system sqlite3, read only twice over, with a short timeout so a
// locked or huge database costs the picker nothing but its Conductor half.
function sqliteRunner(db, sql) {
  const { execFileSync } = require('child_process')
  const uri = 'file:' + encodeURI(db).replace(/\?/g, '%3F').replace(/#/g, '%23') + '?mode=ro'
  const out = execFileSync('/usr/bin/sqlite3', ['-readonly', '-json', uri, sql],
    { encoding: 'utf8', timeout: 2000, maxBuffer: 8 << 20, stdio: ['ignore', 'pipe', 'ignore'] })
  return out.trim() ? JSON.parse(out) : []
}

function conductorRows(fs, home, sqlite) {
  const db = path.join(home, 'Library', 'Application Support', 'com.conductor.app', 'conductor.db')
  if (!statOf(fs, db)) return []
  try { return (sqlite || sqliteRunner)(db, CONDUCTOR_SQL) || [] } catch { return [] }
}

// ── building the list ─────────────────────────────────────────────────────

const idFor = p => 'P' + crypto.createHash('sha1').update(p).digest('hex').slice(0, 6)

function collect(fs, home, sqlite) {
  const seen = []                                   // { source, path, name, repo, workspace, branch, remote, at }
  const add = x => { if (x.path) seen.push(x) }

  // Conductor: the database first, since it knows repos kept outside ~/conductor and
  // which workspaces are archived; the folders as well, for when it cannot be read
  const archived = new Set()
  for (const r of conductorRows(fs, home, sqlite)) {
    if (r.state === 'repo') {
      if (r.root && r.repo) add({ source: 'conductor', path: r.root, name: r.repo, repo: r.repo, remote: r.remote })
      continue
    }
    const ws = r.wname || r.dir
    const p = r.path || (r.repo && r.dir ? path.join(home, 'conductor', 'workspaces', r.repo, r.dir) : null)
    if (!p) continue
    if (r.state === 'archived') { archived.add(path.resolve(p)); continue }
    const at = Date.parse(r.updated ? (/[zZ]|[+-]\d\d:?\d\d$/.test(r.updated) ? r.updated : r.updated.replace(' ', 'T') + 'Z') : '') || 0
    add({ source: 'conductor', path: p, name: r.repo && ws ? `${r.repo}/${ws}` : ws, repo: r.repo, workspace: ws, branch: r.branch, remote: r.remote, at })
  }
  const cws = path.join(home, 'conductor', 'workspaces')
  for (const repo of listDirs(fs, cws)) {
    for (const ws of listDirs(fs, path.join(cws, repo))) {
      const p = path.join(cws, repo, ws)
      if (!archived.has(path.resolve(p))) add({ source: 'conductor', path: p, name: `${repo}/${ws}`, repo, workspace: ws })
    }
  }
  const crepos = path.join(home, 'conductor', 'repos')
  for (const repo of listDirs(fs, crepos)) add({ source: 'conductor', path: path.join(crepos, repo), name: repo, repo })

  // Orca: projects, and workspaces inside each
  const oproj = path.join(home, 'orca', 'projects')
  for (const p of listDirs(fs, oproj)) add({ source: 'orca', path: path.join(oproj, p), name: p, repo: p })
  const ows = path.join(home, 'orca', 'workspaces')
  for (const p of listDirs(fs, ows)) {
    for (const w of listDirs(fs, path.join(ows, p))) add({ source: 'orca', path: path.join(ows, p, w), name: `${p}/${w}`, repo: p, workspace: w })
  }

  // Claude Code: a folder per working directory it has been run in
  const cc = path.join(home, '.claude', 'projects')
  let folders = []
  try { folders = fs.readdirSync(cc) } catch {}
  for (const f of folders) {
    const where = path.join(cc, f)
    if (!isDir(fs, where)) continue
    const p = decodeClaudeFolder(fs, f)
    if (p) add({ source: 'claude', path: p, name: path.basename(p), at: claudeActivity(fs, where) })
  }
  return seen
}

// Not a project, even if a tool was run there: the home folder itself, the disk's root,
// app data under ~/Library, and scratch space outside home.
function notAProject(p, home) {
  if (p === path.sep || p === home) return true
  if (p.startsWith(path.join(home, 'Library') + path.sep)) return true
  if (!p.startsWith(home + path.sep) && /^\/(private\/)?(tmp|var\/folders|var\/tmp)(\/|$)/.test(p)) return true
  return false
}

function build({ home, fs, sqlite }) {
  const realHome = realOf(fs, home)
  const byPath = new Map()
  for (const x of collect(fs, home, sqlite)) {
    if (!isDir(fs, x.path)) continue                // gone from disk: left out
    const key = realOf(fs, x.path)
    if (notAProject(key, realHome) || notAProject(path.resolve(x.path), home)) continue
    const had = byPath.get(key)
    if (!had) { byPath.set(key, { ...x, path: key, sources: [x.source] }); continue }
    // one folder, two tools: the higher ranked names it, the rest fill gaps
    const [a, b] = SOURCE_RANK[x.source] < SOURCE_RANK[had.source] ? [x, had] : [had, x]
    byPath.set(key, {
      ...b, ...Object.fromEntries(Object.entries(a).filter(([, v]) => v != null && v !== '')),
      path: key,
      sources: [...new Set([...had.sources, x.source])].sort((m, n) => SOURCE_RANK[m] - SOURCE_RANK[n]),
      at: Math.max(a.at || 0, b.at || 0),
    })
  }

  const list = []
  for (const x of byPath.values()) {
    const git = gitInfo(fs, x.path, home) || {}
    const remote = git.remote || cleanRemote(x.remote) || null
    const at = Math.max(x.at || 0, git.at || 0)
    list.push({
      id: idFor(x.path),
      name: x.name,
      source: x.sources[0],
      sources: x.sources,
      path: x.path,
      repo: x.repo || null,
      workspace: x.workspace || null,
      branch: git.branch || (git.detached ? null : x.branch) || null,
      detached: git.detached || null,
      remote,
      remoteShort: remoteShort(remote),
      about: aboutOf(fs, x.path, home),
      lastUsed: at || mtimeOf(fs, x.path),
    })
  }

  // A folder inside another project is named from it (rec/majuro/mcp, not mcp), when
  // no tool gave it a name of its own
  const sorted = [...list].sort((a, b) => a.path.length - b.path.length)
  for (const p of list) {
    if (p.source !== 'claude') continue
    const parent = sorted.filter(q => q !== p && p.path.startsWith(q.path + path.sep)).pop()
    if (parent) p.name = parent.name + '/' + path.relative(parent.path, p.path)
  }

  // What a person can type after @ to mean it: the name, its last part, the workspace,
  // and a repo name for a repo's own folder. handle is the shortest of these no other
  // project answers to. Two projects can share every one (an Orca foo and a Claude Code
  // ~/code/foo), and a handle both answer to is one record_start refuses, so then the
  // handle grows the folders above it (code/foo, then more) until it is the only one,
  // and is added to what that project answers to.
  for (const p of list) {
    const last = p.name.split('/').pop()
    p.aliases = [...new Set([p.name, last, p.workspace, path.basename(p.path)].filter(Boolean).map(s => s.toLowerCase()))]
  }
  const count = new Map()
  for (const p of list) for (const a of p.aliases) count.set(a, (count.get(a) || 0) + 1)
  const taken = new Set(count.keys())
  for (const p of list) {
    const own = p.aliases.filter(a => count.get(a) === 1).sort((a, b) => a.length - b.length)
    if (own.length) { p.handle = own[0]; continue }
    const parts = p.path.split(path.sep).filter(Boolean).map(s => s.toLowerCase())
    let h = null
    for (let n = 2; n <= parts.length && !h; n++) {
      const c = parts.slice(-n).join('/')
      if (!taken.has(c)) h = c
    }
    p.handle = h || p.id.toLowerCase()
    taken.add(p.handle)
    if (!p.aliases.includes(p.handle)) p.aliases.push(p.handle)
  }

  list.sort((a, b) => b.lastUsed - a.lastUsed || a.name.localeCompare(b.name))
  return list
}

// ── the cache ─────────────────────────────────────────────────────────────

// The folders a new project appears in. Their dates change the moment one is added or
// removed, so checking them costs a few stat() calls and saves a stale list.
function fingerprint(fs, home) {
  const dirs = [
    path.join(home, 'conductor', 'workspaces'), path.join(home, 'conductor', 'repos'),
    path.join(home, 'orca', 'projects'), path.join(home, 'orca', 'workspaces'),
    path.join(home, '.claude', 'projects'),
  ]
  const parts = []
  for (const d of dirs) {
    parts.push(mtimeOf(fs, d))
    if (d.endsWith('workspaces')) for (const sub of listDirs(fs, d)) parts.push(mtimeOf(fs, path.join(d, sub)))
  }
  return parts.join(',')
}

let cache = null

// Every project, most recent first. Options: home, fs, sqlite (a (db, sql) => rows
// runner), now, maxAge, fresh.
function projectIndex(opts = {}) {
  const fs = opts.fs || require('fs')
  const home = path.resolve(opts.home || require('os').homedir())
  const now = opts.now != null ? opts.now : Date.now()
  const maxAge = opts.maxAge != null ? opts.maxAge : MAX_AGE
  const fp = fingerprint(fs, home)
  if (!opts.fresh && cache && cache.home === home && cache.fs === fs && now - cache.at < maxAge && cache.fp === fp) return cache.list
  const list = build({ home, fs, sqlite: opts.sqlite })
  cache = { home, fs, at: now, fp, list }
  return list
}

function forget() { cache = null; inflight = null }

// The same list without holding up the caller: main asks this as someone types, and a
// build can take a few hundred milliseconds on a busy disk (most of it sqlite3 starting
// and git files read cold). The build runs on a worker thread; where one cannot start,
// it runs here as before.
//   - fresh cache: that list, at once
//   - a project folder appeared or went: wait for the rebuild, so a new workspace is
//     there the moment it is asked for
//   - only older than MAX_AGE: the list it has, at once, and a rebuild behind it, so the
//     next ask is current. Stalest case: MAX_AGE plus one build.
let inflight = null
function projectIndexAsync(opts = {}) {
  if (opts.fs || opts.sqlite) return Promise.resolve(projectIndex(opts))   // injected: tests stay synchronous
  const fs = require('fs')
  const home = path.resolve(opts.home || require('os').homedir())
  const now = opts.now != null ? opts.now : Date.now()
  const maxAge = opts.maxAge != null ? opts.maxAge : MAX_AGE
  const fp = fingerprint(fs, home)
  const same = cache && cache.home === home && cache.fs === fs && cache.fp === fp
  if (!opts.fresh && same && now - cache.at < maxAge) return Promise.resolve(cache.list)
  const run = inflight || (inflight = buildOffThread(home).then(list => {
    cache = { home, fs, at: Date.now(), fp, list }
    return list
  }).finally(() => { inflight = null }))
  if (!opts.fresh && same) return Promise.resolve(cache.list)              // stale but same projects
  return run
}

function buildOffThread(home) {
  return new Promise(resolve => {
    const here = () => resolve(build({ home, fs: require('fs') }))
    let W
    try { W = require('worker_threads').Worker } catch { return here() }
    let w
    try { w = new W(__filename, { workerData: { projectIndexFor: home } }) } catch { return here() }
    let done = false
    w.once('message', list => { done = true; resolve(list); w.terminate() })
    w.once('error', () => { if (!done) { done = true; here() } })
    w.once('exit', () => { if (!done) { done = true; here() } })
  })
}

// On the worker: build once, hand the list back, and end.
{
  let wt = null
  try { wt = require('worker_threads') } catch {}
  if (wt && !wt.isMainThread && wt.workerData && wt.workerData.projectIndexFor) {
    wt.parentPort.postMessage(build({ home: wt.workerData.projectIndexFor, fs: require('fs') }))
  }
}

// ── using it ──────────────────────────────────────────────────────────────

// Projects that answer what was typed after @: a name or alias exactly, then the start
// of one, then the start of any part of one (rec/ma, majuro-mcp), then anywhere.
// Recency breaks ties, since the list is already in that order.
function findProjects(query, list, limit) {
  const q = String(query || '').replace(/^@/, '').trim().toLowerCase()
  if (!q) return list.slice(0, limit || list.length)
  const rank = p => {
    const al = p.aliases || [String(p.name).toLowerCase()]
    if (al.includes(q) || p.handle === q) return 0
    if (al.some(a => a.startsWith(q))) return 1
    if (al.some(a => a.split(/[/\-_. ]/).some(w => w.startsWith(q)))) return 2
    if (al.some(a => a.includes(q)) || (p.branch && p.branch.toLowerCase().includes(q))) return 3
    return -1
  }
  return list.map((p, i) => ({ p, r: rank(p), i })).filter(o => o.r >= 0)
    .sort((a, b) => a.r - b.r || a.i - b.i).slice(0, limit || list.length).map(o => o.p)
}

// The project a folder belongs to: its own, or the nearest one it sits inside. For
// matching a running process's working directory to what was tagged.
function projectForPath(p, list) {
  if (!p) return null
  const at = path.resolve(p)
  let best = null
  for (const x of list) if ((at === x.path || at.startsWith(x.path + path.sep)) && (!best || x.path.length > best.path.length)) best = x
  return best
}

module.exports = {
  projectIndex, projectIndexAsync, forget, findProjects, projectForPath,
  // for tests and for pieces that need one part
  build, aboutFrom, cleanRemote, remoteShort, decodeClaudeFolder, encodeSeg, mayOpen, readHead,
  sqliteRunner, CONDUCTOR_SQL, MAX_AGE,
}
