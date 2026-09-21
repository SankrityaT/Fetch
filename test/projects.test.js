// The project index (ui/projects.js), against a fake home built here: Conductor, Orca
// and Claude Code laid out as they are on a real Mac, with the things the index must
// never open planted beside the things it reads. Every file the index opens is logged
// through a wrapped fs, so the privacy rule is checked, not described.
//
//   node test/projects.test.js

const fsReal = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto')
const { execFileSync } = require('child_process')
const P = require('../ui/projects')

let pass = 0, fail = 0
const is = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}` + (ok ? '' : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`))
}

// ── the fake home ─────────────────────────────────────────────────────────
const HOME = fsReal.realpathSync(fsReal.mkdtempSync(path.join(os.tmpdir(), 'fetch-projects-')))
const at = (...p) => path.join(HOME, ...p)
const put = (file, text) => { fsReal.mkdirSync(path.dirname(file), { recursive: true }); fsReal.writeFileSync(file, text) }
const dir = d => fsReal.mkdirSync(d, { recursive: true })
const touch = (file, when) => { const t = new Date(when); fsReal.utimesSync(file, t, t) }
const DAY = 86400000, NOW = Date.parse('2026-09-21T12:00:00Z')

// Things that must never be opened. The words inside are markers, so a leak would show
// in the output too.
const PLANTED = 'PLANTED-DO-NOT-READ'
const forbidden = []
const plant = file => { put(file, PLANTED + '\n'); forbidden.push(file) }

// Conductor: repo rec with a worktree workspace majuro, the way Conductor lays it out
const REC = at('conductor', 'repos', 'rec')
put(path.join(REC, '.git', 'HEAD'), 'ref: refs/heads/main\n')
put(path.join(REC, '.git', 'config'),
  '[core]\n\tbare = false\n[remote "origin"]\n\turl = https://someone@github.com/SankrityaT/Fetch.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n')
put(path.join(REC, 'README.md'), '# Fetch\n\n> Record it. Fetch it. Ship it.\n\nA macOS screen recorder and video editor. Screen, audio and a camera bubble. Then more words that are not needed.\n')
const MAJ = at('conductor', 'workspaces', 'rec', 'majuro')
const WT = path.join(REC, '.git', 'worktrees', 'majuro')
put(path.join(MAJ, '.git'), `gitdir: ${WT}\n`)
put(path.join(WT, 'HEAD'), 'ref: refs/heads/SankrityaT/lasso-demo\n')
put(path.join(WT, 'commondir'), '../..\n')
put(path.join(WT, 'index'), 'x')
put(path.join(MAJ, 'README.md'), '<p align="center"><img src="x.png"></p>\n\n# Fetch\n\n[![build](https://x/badge.svg)](https://x)\n\n> Record it.\n\nA macOS **screen recorder** and [video editor](https://x). Runs on-device.\n')
plant(path.join(MAJ, '.env'))
plant(path.join(MAJ, '.env.local'))
plant(path.join(MAJ, '.env.production'))
plant(path.join(MAJ, 'keypair.json'))
plant(path.join(MAJ, 'credentials.json'))
plant(path.join(MAJ, 'secrets.yaml'))
plant(path.join(MAJ, 'api_key.txt'))
plant(path.join(MAJ, 'token'))
plant(path.join(MAJ, 'password.txt'))
plant(path.join(MAJ, 'id_ed25519'))
plant(path.join(MAJ, 'server.pem'))
dir(path.join(MAJ, 'mcp'))
put(path.join(MAJ, 'mcp', 'README.md'), 'The MCP server half.\n')

// a second workspace whose README is a symlink to its .env: never followed
const SEO = at('conductor', 'workspaces', 'rec', 'seoul')
plant(path.join(SEO, '.env'))
fsReal.symlinkSync(path.join(SEO, '.env'), path.join(SEO, 'README.md'))
put(path.join(SEO, 'AGENTS.md'), '# Agents\n\nHow to work on the launch review.\n')

// archived in the database but still on disk: left out
dir(at('conductor', 'workspaces', 'rec', 'oldtown'))
// in the database but gone from disk: left out
// a repo Conductor keeps outside ~/conductor, known only to the database
const YOLK = at('iOSLocal', 'yolkling')
put(path.join(YOLK, 'CLAUDE.md'), '# CLAUDE.md\n\nThis file provides guidance to agents working with code in this repository.\n\nYolkling is an egg timer.\n')
// a project whose own folder is named like a secret: indexed, README not opened
const SEC = at('conductor', 'workspaces', 'vault', 'secrets-manager')
plant(path.join(SEC, 'README.md'))
// a "key" project name that is not a secret: its README is read
const MONKEY = at('conductor', 'workspaces', 'monkey', 'keyboard-app')
put(path.join(MONKEY, 'README.md'), 'Typing practice.\n')

// Conductor's own app data: the database (built below) and planted neighbours
const CAPP = at('Library', 'Application Support', 'com.conductor.app')
plant(path.join(CAPP, 'local-storage.subsystem.composer-drafts.json'))
dir(CAPP)

// Orca, and its end-to-end keypair, which must never be opened
put(at('orca', 'projects', 'Tend', 'AGENTS.md'), '# Tend\n\nA spreadsheet workspace for recurring monthly reports.\n')
plant(at('orca', 'projects', 'Tend', '.env.example'))
put(at('orca', 'projects', 'Tend', '.git', 'HEAD'), 'ref: refs/heads/main\n')
put(at('orca', 'projects', 'Tend', '.git', 'config'), '[remote "upstream"]\n\turl = git@github.com:SankrityaT/tend.git\n')
dir(at('orca', 'workspaces', 'Tend', 'timingila'))
dir(at('orca', 'workspaces', 'Tend', '.orca-worktree-trash', 'dead'))
plant(at('Library', 'Application Support', 'orca', 'orca-e2ee-keypair.json'))
plant(at('Library', 'Application Support', 'orca', 'agent-session-authority.key'))

// SSH and GPG material
plant(at('.ssh', 'id_rsa'))
plant(at('.ssh', 'config'))
plant(at('.gnupg', 'pubring.kbx'))

// Claude Code: folders named for paths, holding chat history
const enc = p => p.replace(/[^A-Za-z0-9]/g, '-')
const CC = at('.claude', 'projects')
plant(at('.claude', 'history.jsonl'))
const ccFolder = (p, when) => {
  const f = path.join(CC, enc(p)); dir(f)
  const s = path.join(f, crypto.randomUUID() + '.jsonl'); plant(s)
  if (when) touch(s, when)
  return f
}
ccFolder(MAJ, NOW - 60000)                                     // same folder as the Conductor workspace
ccFolder(path.join(MAJ, 'mcp'), NOW - 5 * DAY)                // inside it
// a dash in a real folder name, with a decoy that only matches half of it
const PL = at('code', 'moving-parts', 'port-louis'); dir(PL)
dir(at('code', 'moving', 'nothing-here'))
ccFolder(PL, NOW - 2 * DAY)
// truly ambiguous: both code/a-b and code/a/b exist, and only one is a git repo
dir(at('code', 'a-b'))
put(at('code', 'a', 'b', '.git', 'HEAD'), 'ref: refs/heads/dev\n')
ccFolder(at('code', 'a', 'b'), NOW - 3 * DAY)
// a space in the name, kept by older Claude Code
const SPACE = at('code', 'Spring 2026', 'CSE 575'); dir(SPACE)
fsReal.mkdirSync(path.join(CC, `${enc(at('code'))}-Spring 2026-CSE 575`))
// the home folder itself, and a path that is gone: neither is a project
ccFolder(HOME, NOW)
ccFolder(at('code', 'deleted-long-ago'))
ccFolder('/private/tmp/scratch')

// The Conductor database, a real sqlite file with columns the index must not select
const DB = path.join(CAPP, 'conductor.db')
const iso = t => new Date(t).toISOString()
execFileSync('/usr/bin/sqlite3', [DB, `
CREATE TABLE repos (id TEXT PRIMARY KEY, remote_url TEXT, name TEXT, root_path TEXT, custom_prompt_general TEXT, updated_at TEXT);
CREATE TABLE workspaces (local_id TEXT PRIMARY KEY, repository_id TEXT, directory_name TEXT, branch TEXT, state TEXT,
  updated_at TEXT, workspace_path TEXT, workspace_name TEXT, notes TEXT, pr_description TEXT);
INSERT INTO repos VALUES ('r1', 'https://github.com/SankrityaT/Fetch.git', 'rec', '${REC}', '${PLANTED}', '2026-09-21 18:42:15');
INSERT INTO repos VALUES ('r2', 'https://github.com/SankrityaT/yolkling-ios.git', 'yolkling', '${YOLK}', '${PLANTED}', '2026-09-21 18:42:15');
INSERT INTO workspaces VALUES ('w1', 'r1', 'majuro', 'db-branch-is-older', 'ready', '${iso(NOW - 10 * DAY)}', '${MAJ}', NULL, '${PLANTED}', '${PLANTED}');
INSERT INTO workspaces VALUES ('w2', 'r1', 'seoul', 'SankrityaT/launch-review', 'ready', '${iso(NOW - 1 * DAY)}', '${SEO}', NULL, '${PLANTED}', NULL);
INSERT INTO workspaces VALUES ('w3', 'r1', 'oldtown', 'x', 'archived', '${iso(NOW)}', '${at('conductor', 'workspaces', 'rec', 'oldtown')}', NULL, NULL, NULL);
INSERT INTO workspaces VALUES ('w4', 'r1', 'gone', 'x', 'ready', '${iso(NOW)}', '${at('conductor', 'workspaces', 'rec', 'gone')}', NULL, NULL, NULL);
`])
const dbBefore = crypto.createHash('sha1').update(fsReal.readFileSync(DB)).digest('hex')

// dates the recency order is built from: everything old, then the few that say otherwise
const age = p => { for (const n of fsReal.readdirSync(p)) { const f = path.join(p, n); if (fsReal.lstatSync(f).isDirectory()) age(f); touch(f, NOW - 30 * DAY) } }
age(HOME)
// a Claude Code folder is dated by the folder, which moves when a session starts in it
for (const f of fsReal.readdirSync(CC)) touch(path.join(CC, f), NOW - 60000 * (f === enc(MAJ) ? 1 : 60 * 24 * (f === enc(PL) ? 2 : 5)))
touch(path.join(WT, 'index'), NOW - 20 * DAY)
touch(path.join(WT, 'HEAD'), NOW - 20 * DAY)

// ── an fs that logs every open and refuses every write ────────────────────
const opened = [], writes = []
const OPENERS = ['openSync', 'readFileSync', 'createReadStream', 'open', 'readFile', 'copyFileSync', 'cpSync']
const WRITERS = ['writeFileSync', 'appendFileSync', 'mkdirSync', 'rmSync', 'unlinkSync', 'renameSync', 'utimesSync', 'symlinkSync', 'truncateSync', 'writeSync']
const spyFs = new Proxy(fsReal, {
  get(t, k) {
    const v = t[k]
    if (typeof v !== 'function') return v
    if (OPENERS.includes(k)) return (...a) => { opened.push(String(a[0])); return v.apply(t, a) }
    if (WRITERS.includes(k)) return (...a) => { writes.push(`${k} ${a[0]}`); throw new Error('the index must not write') }
    return v.bind(t)
  },
})
// the real runner, logged: it opens the database through sqlite3, read only
const sqlCalls = []
const sqlite = (db, sql) => { sqlCalls.push({ db, sql }); opened.push(db); return P.sqliteRunner(db, sql) }

const list = P.projectIndex({ home: HOME, fs: spyFs, sqlite, now: NOW, fresh: true })
const by = name => list.find(p => p.name === name)

console.log('=== the privacy rule ===')
const openedReal = new Set(opened.map(f => { try { return fsReal.realpathSync(f) } catch { return f } }))
is('the spy sees opens (majuro\'s README, its HEAD, the database)',
  [path.join(MAJ, 'README.md'), path.join(WT, 'HEAD'), DB].every(f => opened.includes(f)), true)
is('no planted file was opened', forbidden.filter(f => openedReal.has(f) || opened.includes(f)).map(f => path.relative(HOME, f)), [])
const ALLOWED = new Set(['README.md', 'README', 'PRODUCT.md', 'CLAUDE.md', 'AGENTS.md', 'HEAD', 'config', 'commondir', '.git', 'conductor.db'])
is('everything opened is a readme, an agent file, git HEAD or config, or the database',
  opened.filter(f => !ALLOWED.has(path.basename(f))).map(f => path.relative(HOME, f)), [])
is('nothing under Claude Code\'s projects folder was opened', opened.filter(f => f.startsWith(CC)), [])
is('the orca keypair was not opened', opened.some(f => /keypair/.test(f)), false)
is('the index wrote nothing', writes, [])
is('no planted text reached the index', JSON.stringify(list).includes(PLANTED), false)
is('the symlinked README was not followed', opened.includes(path.join(SEO, 'README.md')), false)
is('a folder named like a secret has no README read', [by('vault/secrets-manager').about, opened.includes(path.join(SEC, 'README.md'))], [null, false])
is('but monkey/keyboard-app is not a secret', by('monkey/keyboard-app').about, 'Typing practice.')
is('the database was queried once, read only', sqlCalls.length, 1)
is('and only for the columns it needs', /notes|pr_description|custom_prompt|\*/.test(sqlCalls[0].sql), false)
is('it selects and nothing else', /\b(insert|update|delete|create|drop|attach|pragma)\b/i.test(sqlCalls[0].sql), false)
is('the database is byte for byte unchanged', crypto.createHash('sha1').update(fsReal.readFileSync(DB)).digest('hex'), dbBefore)
is('a user and password in a remote URL are cut', P.cleanRemote('https://someone@github.com/o/r.git'), 'https://github.com/o/r.git')
is('the scp form is left as it is', P.cleanRemote('git@github.com:o/r.git'), 'git@github.com:o/r.git')
is('mayOpen refuses the named shapes',
  ['.env', '.env.local', 'prod.env', '.envrc', 'orca-e2ee-keypair.json', 'credentials', 'client_secret.json', 'api-keys.txt',
    'token.txt', 'passwords.csv', 'id_ed25519', 'x.pem', 'history.jsonl', '.npmrc-auth.json', '.netrc'].filter(n => P.mayOpen('/x/' + n)), [])
is('and allows the ones it reads', ['README.md', 'PRODUCT.md', 'CLAUDE.md', 'AGENTS.md', 'HEAD', 'config'].every(n => P.mayOpen('/x/proj/' + n)), true)
is('nothing inside .ssh or .gnupg', [P.mayOpen('/h/.ssh/config'), P.mayOpen('/h/.gnupg/gpg.conf')], [false, false])
is('a long key-shaped run in a README is cut', P.aboutFrom('Run it with ' + 'a1'.repeat(20) + ' set.'), 'Run it with … set.')

console.log('=== one list, named for a person ===')
const names = list.map(p => p.name).sort()
is('every project, and nothing else', names, [
  'Spring 2026/CSE 575'.split('/').pop(),
  'Tend', 'Tend/timingila', 'b', 'monkey/keyboard-app', 'port-louis', 'rec', 'rec/majuro', 'rec/majuro/mcp', 'rec/seoul',
  'vault/secrets-manager', 'yolkling',
].sort())
const maj = by('rec/majuro')
is('a Conductor workspace is repo/workspace', [maj.repo, maj.workspace], ['rec', 'majuro'])
is('one folder known to two tools is one project', maj.sources, ['conductor', 'claude'])
is('named by Conductor, the tool that knows most', maj.source, 'conductor')
is('its branch comes from git, not an old database row', maj.branch, 'SankrityaT/lasso-demo')
is('the worktree finds its remote in the shared config', [maj.remote, maj.remoteShort], ['https://github.com/SankrityaT/Fetch.git', 'SankrityaT/Fetch'])
is('its description skips the logo, badge and tagline', maj.about, 'A macOS screen recorder and video editor. Runs on-device.')
is('the repo root says two sentences at most', by('rec').about, 'A macOS screen recorder and video editor. Screen, audio and a camera bubble.')
is('a README that is a symlink falls to AGENTS.md', by('rec/seoul').about, 'How to work on the launch review.')
is('the database branch stands in when git has none', by('rec/seoul').branch, 'SankrityaT/launch-review')
is('a repo outside ~/conductor comes from the database', [by('yolkling').path, by('yolkling').remoteShort], [YOLK, 'SankrityaT/yolkling-ios'])
is('CLAUDE.md past its heading and its boilerplate line', by('yolkling').about, 'Yolkling is an egg timer.')
is('archived and gone workspaces are left out', [by('rec/oldtown'), by('rec/gone')], [undefined, undefined])
is('Orca projects and workspaces', [by('Tend').source, by('Tend/timingila').source], ['orca', 'orca'])
is('any remote when there is no origin', by('Tend').remote, 'git@github.com:SankrityaT/tend.git')
is('Orca\'s trash is not a workspace', list.some(p => /orca-worktree-trash/.test(p.path)), false)
is('a Claude Code folder is named by its last part', [by('port-louis').path, by('port-louis').source], [PL, 'claude'])
is('a folder inside another project is named from it', by('rec/majuro/mcp').path, path.join(MAJ, 'mcp'))
is('a space kept in a Claude Code folder name', list.some(p => p.path === SPACE), true)
is('home, scratch and gone folders are not projects', list.some(p => p.path === HOME || /scratch|deleted-long-ago/.test(p.path)), false)
is('ids are stable and short', [maj.id, /^P[0-9a-f]{6}$/.test(maj.id)], [P.build({ home: HOME, fs: fsReal, sqlite: () => [] }).find(p => p.path === MAJ).id, true])
is('ids are unique', new Set(list.map(p => p.id)).size, list.length)

console.log('=== Claude Code folder names back to paths ===')
is('a dash in a real name, past a decoy', P.decodeClaudeFolder(fsReal, enc(PL)), PL)
is('two real readings: the git repo wins', P.decodeClaudeFolder(fsReal, enc(at('code', 'a', 'b'))), at('code', 'a', 'b'))
is('only a-b exists: that one', (() => { const f = at('code', 'c-d'); dir(f); return P.decodeClaudeFolder(fsReal, enc(f)) })(), at('code', 'c-d'))
is('a hidden folder', (() => { const f = at('.config', 'tool'); dir(f); return P.decodeClaudeFolder(fsReal, enc(f)) })(), at('.config', 'tool'))
is('a path that is not there', P.decodeClaudeFolder(fsReal, enc(at('nope', 'nothing'))), null)

console.log('=== most recent first ===')
is('the newest Claude Code session puts majuro first', list[0].name, 'rec/majuro')
is('then the database\'s own dates', list.findIndex(p => p.name === 'rec/seoul') < list.findIndex(p => p.name === 'port-louis'), true)
is('lastUsed is a date for every one', list.every(p => p.lastUsed > 0), true)

console.log('=== typing after @ ===')
is('@majuro', P.findProjects('majuro', list).map(p => p.name), ['rec/majuro', 'rec/majuro/mcp'])
is('@rec/ma', P.findProjects('@rec/ma', list)[0].name, 'rec/majuro')
is('@tim finds an Orca workspace', P.findProjects('tim', list)[0].name, 'Tend/timingila')
is('handles are the shortest name no one else answers to', [maj.handle, by('rec/majuro/mcp').handle, by('Tend/timingila').handle], ['majuro', 'mcp', 'timingila'])
is('a branch finds its project', P.findProjects('lasso-demo', list)[0].name, 'rec/majuro')
is('nothing typed is the list', P.findProjects('', list, 3).length, 3)
is('no match is nothing', P.findProjects('zzzz', list), [])
is('a running app\'s folder finds its project', P.projectForPath(path.join(MAJ, 'ui'), list).name, 'rec/majuro')
is('the nearest project wins', P.projectForPath(path.join(MAJ, 'mcp', 'src'), list).name, 'rec/majuro/mcp')
is('a folder in no project', P.projectForPath('/Applications', list), null)

console.log('=== the cache ===')
{
  const opts = { home: HOME, fs: fsReal, sqlite: () => [] }
  const a = P.projectIndex({ ...opts, now: NOW, fresh: true })
  is('a second ask within the window is the same list', P.projectIndex({ ...opts, now: NOW + 1000 }) === a, true)
  let t = process.hrtime.bigint(); P.projectIndex({ ...opts, now: NOW + 2000 })
  const cachedMs = Number(process.hrtime.bigint() - t) / 1e6
  is('and costs under 5 ms', cachedMs < 5, true)
  // an edited README inside the window is not seen: that is the stated staleness
  put(path.join(PL, 'README.md'), 'Now it has a readme.\n')
  is('an edit inside the window can be stale', P.projectIndex({ ...opts, now: NOW + 3000 }).find(p => p.name === 'port-louis').about, null)
  is('and is seen once the window passes', P.projectIndex({ ...opts, now: NOW + P.MAX_AGE + 1 }).find(p => p.name === 'port-louis').about, 'Now it has a readme.')
  // a new workspace shows at once, since the folder it lands in changes
  const b = P.projectIndex({ ...opts, now: NOW + P.MAX_AGE + 2 })
  dir(at('conductor', 'workspaces', 'rec', 'lima'))
  const c = P.projectIndex({ ...opts, now: NOW + P.MAX_AGE + 3 })
  is('a new workspace shows without waiting', [c !== b, c.some(p => p.name === 'rec/lima')], [true, true])
  const d = at('code', 'new-thing'); dir(d); fsReal.mkdirSync(path.join(CC, enc(d)))
  is('so does a new Claude Code folder', P.projectIndex({ ...opts, now: NOW + P.MAX_AGE + 4 }).some(p => p.name === 'new-thing'), true)
  t = process.hrtime.bigint(); P.projectIndex({ ...opts, fresh: true })
  const coldMs = Number(process.hrtime.bigint() - t) / 1e6
  console.log(`       a full rebuild of the fake home: ${coldMs.toFixed(1)} ms`)
  P.forget()
}

console.log('=== the database, when it cannot be read ===')
{
  const l = P.projectIndex({ home: HOME, fs: fsReal, sqlite: () => { throw new Error('locked') }, fresh: true })
  is('the folders still give the workspaces', l.some(p => p.name === 'rec/majuro'), true)
  is('but not a repo kept elsewhere', l.some(p => p.name === 'yolkling'), false)
  P.forget()
}

// What a review found, each held here. A worktree's .git file can name a gitdir anywhere,
// and a symlinked folder earlier in the path used to carry the open past the name check.
console.log('=== a gitdir or commondir that leads somewhere else ===')
{
  const H = fsReal.realpathSync(fsReal.mkdtempSync(path.join(os.tmpdir(), 'fetch-projects-sym-')))
  const h = (...p) => path.join(H, ...p)
  put(h('.ssh', 'config'), 'Host x\n  url = https://LEAKED@example.com/o/r.git\n[remote "origin"]\n\turl = https://LEAKED.example/o/r.git\n')
  put(h('.ssh', 'HEAD'), 'ref: refs/heads/LEAKED\n')
  const W = h('conductor', 'workspaces', 'w', 'a'); dir(W)
  fsReal.symlinkSync(h('.ssh'), path.join(W, 'lnk'))
  put(path.join(W, '.git'), 'gitdir: lnk\n')
  // commondir climbing out of a real worktree folder into ~/.ssh
  const R = h('conductor', 'repos', 'r'), WT2 = path.join(R, '.git', 'worktrees', 'b')
  put(path.join(R, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  put(path.join(WT2, 'HEAD'), 'ref: refs/heads/feature\n')
  put(path.join(WT2, 'commondir'), '../../../../../../.ssh\n')
  const B = h('conductor', 'workspaces', 'w', 'b')
  put(path.join(B, '.git'), `gitdir: ${WT2}\n`)
  // a README reached through a symlinked folder
  const C = h('conductor', 'workspaces', 'w', 'c'); dir(C)
  fsReal.symlinkSync(h('.ssh'), path.join(C, 'docs'))
  const opened2 = []
  const spy2 = new Proxy(fsReal, { get(t, k) {
    const v = t[k]
    if (typeof v !== 'function') return v
    if (['openSync', 'readFileSync'].includes(k)) return (f, ...r) => { opened2.push(String(f)); return v.call(t, f, ...r) }
    return v.bind(t)
  } })
  const l = P.projectIndex({ home: H, fs: spy2, sqlite: () => [], fresh: true })
  const one = n => l.find(p => p.name === n) || {}
  is('nothing under ~/.ssh was opened', opened2.filter(f => f.includes(path.sep + '.ssh' + path.sep)), [])
  is('a gitdir through a symlink gives no branch and no remote', [one('w/a').branch, one('w/a').remote], [null, null])
  is('a commondir that climbs out gives nothing', [one('w/b').branch, one('w/b').remote], [null, null])
  is('no LEAKED text anywhere', JSON.stringify(l).includes('LEAKED'), false)
  is('readHead refuses a file whose real path is a secret', P.readHead(fsReal, path.join(C, 'docs', 'config'), 100, H), null)
  put(h('elsewhere', 'README.md'), 'Elsewhere.\n')
  is('and a file outside the roots it was given', [P.readHead(fsReal, h('elsewhere', 'README.md'), 100, H, [W]), P.readHead(fsReal, h('elsewhere', 'README.md'), 100, H, [h('elsewhere')])], [null, 'Elsewhere.\n'])
  P.forget()
  fsReal.rmSync(H, { recursive: true, force: true })
}

console.log('=== secrets in a README, in any shape ===')
{
  const cut = t => P.aboutFrom(t)
  const has = (t, bit) => String(cut(t) || '').includes(bit)
  const AKID = 'AKIA' + 'IOSFODNN7EXAMPLE'
  const SPLIT = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY'
  is('an access key id of 20 characters goes', has(`Deploy with ${AKID} and go.`, AKID), false)
  is('a 40 character secret split by / and + goes', has(`It uses ${SPLIT} for storage.`, 'K7MDENG'), false)
  is('a paragraph that names a password is dropped whole', cut('Log in as admin, password hunter2 works.'), null)
  is('so is one naming a token, a secret or an api key', ['Set the token first.', 'The secret lives here.', 'Your API key goes in.', 'Send a Bearer header.'].map(cut), [null, null, null, null])
  is('a database URL with a password in it goes', has('Connects to postgres://app:s3cr3tpw@db.local:5432/main by default.', 's3cr3tpw'), false)
  is('a webhook URL with a path token goes', has('Posts to https://hooks.example.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX when done.', 'T00000000'), false)
  const JWT = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'].join('.')
  is('a JWT goes', has(`Try ${JWT} to see it.`, 'eyJ'), false)
  is('a dotted key goes', has('Paste sk.abc12.def34.ghi56.jkl78 into it.', 'abc12'), false)
  is('ordinary prose stays', cut('A macOS screen recorder and video editor. It runs on the Mac.'), 'A macOS screen recorder and video editor. It runs on the Mac.')
  is('a plain link stays', cut('Docs at https://example.com/docs for more.'), 'Docs at https://example.com/docs for more.')
}

console.log('=== a remote keeps no credentials ===')
is('a password with a slash in it is cut', P.cleanRemote('https://user:ab/cd@github.com/o/r.git'), 'https://github.com/o/r.git')
is('a numeric password with a slash is cut', P.cleanRemote('https://user:12/cd@github.com/o/r.git'), 'https://github.com/o/r.git')
is('a user and password are cut', P.cleanRemote('https://user:pw@github.com/o/r.git'), 'https://github.com/o/r.git')
is('a query token is cut', P.cleanRemote('https://host.example/o/r.git?token=abc123'), 'https://host.example/o/r.git')
is('a fragment is cut', P.cleanRemote('https://host.example/o/r.git#frag'), 'https://host.example/o/r.git')
is('ssh keeps host and path', P.cleanRemote('ssh://git@github.com/o/r.git'), 'ssh://github.com/o/r.git')
is('a scp form with a password before the @ is cut', P.cleanRemote('user:pw@host.example:o/r.git'), 'host.example:o/r.git')

console.log('=== two projects that share every name ===')
{
  const H = fsReal.realpathSync(fsReal.mkdtempSync(path.join(os.tmpdir(), 'fetch-projects-dup-')))
  dir(path.join(H, 'orca', 'projects', 'foo'))
  const CF = path.join(H, 'code', 'foo'); dir(CF)
  dir(path.join(H, '.claude', 'projects', CF.replace(/[^A-Za-z0-9]/g, '-')))
  const l = P.projectIndex({ home: H, fs: fsReal, sqlite: () => [], fresh: true })
  const hs = l.map(p => p.handle)
  is('both are listed', l.length, 2)
  is('each has a handle of its own', new Set(hs).size, 2)
  is('and each answers to its own handle', l.every(p => p.aliases.includes(p.handle)), true)
  is('no other project answers to a handle', l.every(p => l.filter(q => q.aliases.includes(p.handle)).length === 1), true)
  P.forget()
  fsReal.rmSync(H, { recursive: true, force: true })
}

// The off-thread build, as main uses it: a worker walks the fake home with the real fs
// and the real sqlite3.
;(async () => {
  console.log('=== asked as someone types ===')
  const sync = P.projectIndex({ home: HOME, fresh: true }).map(p => p.name)
  P.forget()
  const a = await P.projectIndexAsync({ home: HOME })
  is('the worker builds the same list', a.map(p => p.name), sync)
  is('a fresh cache answers at once', (await P.projectIndexAsync({ home: HOME })) === a, true)
  let t = Date.now()
  const b = await P.projectIndexAsync({ home: HOME, now: Date.now() + P.MAX_AGE + 1 })
  is('a stale one is served while it rebuilds', [b === a, Date.now() - t < 50], [true, true])
  await new Promise(r => setTimeout(r, 50))
  for (let i = 0; i < 100 && (await P.projectIndexAsync({ home: HOME })) === a; i++) await new Promise(r => setTimeout(r, 30))
  is('and the next ask has the rebuild', (await P.projectIndexAsync({ home: HOME })) !== a, true)
  dir(at('orca', 'workspaces', 'Tend', 'marlin'))
  is('a new project waits for the rebuild rather than missing', (await P.projectIndexAsync({ home: HOME })).some(p => p.name === 'Tend/marlin'), true)
  P.forget()

  fsReal.rmSync(HOME, { recursive: true, force: true })
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
})()
