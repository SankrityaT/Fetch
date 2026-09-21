// An unlisted folder is taken as a project only where a project could live.
//   node test/project-folder.test.js
//
// Any directory used to pass, so "@~/.ssh" was accepted as a project and its file names
// were listed. This runs against a fake home, so it never goes near the real one, and it
// watches every directory listing, because refusing a secret folder after listing it
// would still have read the thing it was protecting.

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

process.env.FETCH_CHAT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-pf-chat-'))
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-pf-home-')))
const mk = (rel, files = []) => { const d = path.join(home, rel); fs.mkdirSync(d, { recursive: true }); for (const f of files) fs.writeFileSync(path.join(d, f), 'x'); return d }

const ssh = mk('.ssh', ['id_ed25519', 'known_hosts'])
const aws = mk('.aws', ['credentials'])
const keychains = mk('Library/Keychains', ['login.keychain-db'])
const buried = mk('.config/tool/project', ['package.json'])
const project = mk('code/app', ['package.json'])
const gitOnly = mk('code/other'); fs.mkdirSync(path.join(gitOnly, '.git'))
const junk = mk('Downloads/stuff', ['photo.jpg'])

// the refusal must not list a folder in order to refuse it
const listed = []
for (const fn of ['readdirSync', 'readdir', 'opendirSync', 'opendir']) {
  const orig = fs[fn]
  fs[fn] = function (p, ...rest) { listed.push(String(p)); return orig.call(this, p, ...rest) }
}
os.homedir = () => home

const { resolveProject } = require('../ui/agent-bridge')
let n = 0
const t = (name, fn) => { fn(); n++; console.log('ok', name) }
const r = p => resolveProject(p, [])

t('~/.ssh is refused', () => { const x = r(ssh); assert.strictEqual(x.ok, false); assert.match(x.why, /hidden folder/) })
t('~/.aws is refused', () => assert.strictEqual(r(aws).ok, false))
t('a project hidden inside a dot folder is refused all the same', () => assert.strictEqual(r(buried).ok, false))
t('~/Library/Keychains is refused', () => { const x = r(keychains); assert.strictEqual(x.ok, false); assert.match(x.why, /Library/) })
t('a system folder is refused', () => assert.strictEqual(r('/etc').ok, false))
t('a folder with nothing of a project in it is refused', () => { const x = r(junk); assert.strictEqual(x.ok, false); assert.match(x.why, /does not look like a project/) })
t('a real project folder is taken', () => { const x = r(project); assert.strictEqual(x.ok, true); assert.strictEqual(x.project.path, project) })
t('a folder with only .git is a project', () => assert.strictEqual(r(gitOnly).ok, true))
t('~ spelling reaches the same refusal', () => assert.strictEqual(r('~/.ssh').ok, false))

t('no secret folder was ever listed, even to refuse it', () => {
  const touched = listed.filter(p => [ssh, aws, keychains].some(s => p === s || p.startsWith(s + path.sep)))
  assert.deepStrictEqual(touched, [])
})

fs.rmSync(home, { recursive: true, force: true })
fs.rmSync(process.env.FETCH_CHAT_DIR, { recursive: true, force: true })
console.log(`\n${n} project folder checks passed`)
