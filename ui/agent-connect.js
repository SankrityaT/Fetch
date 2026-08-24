// Connecting Fetch to whichever agent CLI someone already pays for.
// Main-process module, required from main.js.
//
// Six clients, four config shapes, two file formats. Handing people a snippet to
// paste is how this becomes a support queue, so Fetch writes the config itself and
// then reads it back to confirm. Status is always derived from the client's own file,
// never from remembering that we wrote it, so editing by hand stays truthful.
//
// Nothing here touches credentials. The person stays logged into their own client;
// Fetch never sees a key, a token or a model name.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFile } = require('child_process')

const SERVER_NAME = 'fetch'
const home = p => path.join(os.homedir(), p)

// The shim ships inside the app so there is no npm install to get wrong and no
// version skew between the app and the server that drives it.
function shimPath() {
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, 'app', 'mcp', 'index.js') : null,
    path.join(__dirname, '..', 'mcp', 'index.js'),
  ].filter(Boolean)
  for (const c of candidates) if (fs.existsSync(c)) return c
  return candidates[candidates.length - 1]
}

// A GUI app's PATH is not a login shell's, and nvm installs in particular will not be
// on it, so binaries have to be resolved through a login shell. That shell costs real
// time to start (a developer's zsh profile is rarely cheap), so all of them are asked
// for in ONE invocation, asynchronously, and the answers cached for the process.
//
// Doing this synchronously per binary would block the main process for as long as it
// takes to source someone's .zshrc, several times over, and freeze the window.
const BINS = ['node', 'claude', 'codex']
const whichCache = new Map()
let priming = null

function primeWhich() {
  if (whichCache.size) return Promise.resolve()
  if (!priming) {
    // One line per binary, blank where it is missing, so the order maps back cleanly.
    const script = BINS.map(b => `command -v ${b} || echo`).join('\n')
    priming = new Promise(resolve => {
      execFile('/bin/zsh', ['-lc', script], { timeout: 15000 }, (err, stdout) => {
        const lines = String(stdout || '').split('\n')
        BINS.forEach((b, i) => {
          const p = (lines[i] || '').trim()
          whichCache.set(b, p && fs.existsSync(p) ? p : null)
        })
        resolve()
      })
    }).finally(() => { priming = null })
  }
  return priming
}

// Only ever reads the cache, so it is safe to call from anywhere once primed.
const which = bin => whichCache.get(bin) || null

// Absolute path, because the client spawns this itself and inherits none of our
// environment. Falls back to the usual install sites before giving up on a bare name.
function nodeBin() {
  return which('node')
    || ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node'].find(g => fs.existsSync(g))
    || 'node'
}

const run = (file, args) => new Promise(resolve => {
  execFile(file, args, { timeout: 20000 }, (err, stdout, stderr) =>
    resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || err && err.message || '') }))
})

const readJson = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null } }
function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n')
}

// ---------- clients ----------
// Each knows how to say whether it is installed, whether we are connected, and how to
// connect. Anything CLI-driven goes through the CLI so its own validation runs.
const CLIENTS = [
  {
    id: 'claude', label: 'Claude Code', kind: 'cli',
    file: home('.claude.json'),
    detect: () => !!which('claude') || fs.existsSync(home('.claude.json')),
    async connected() {
      // Read the config rather than shell out. `claude mcp list` spawns every server
      // it knows about to health-check them, which took eleven seconds on this
      // machine: far too slow for a screen that should feel instant.
      const j = readJson(this.file)
      if (!j) return false
      if (j.mcpServers && j.mcpServers[SERVER_NAME]) return true
      // Registered per-project by an earlier install still counts as connected, so
      // the row does not claim otherwise while the tools plainly work.
      return Object.values(j.projects || {})
        .some(pr => pr && pr.mcpServers && pr.mcpServers[SERVER_NAME])
    },
    async connect() {
      // user scope, so it works in every project rather than only where it was added
      const r = await run(which('claude'),
        ['mcp', 'add', '--scope', 'user', SERVER_NAME, '--', nodeBin(), shimPath()])
      return r.ok ? { ok: true } : { ok: false, error: (r.stderr || r.stdout).trim().split('\n')[0] }
    },
  },
  {
    id: 'codex', label: 'Codex', kind: 'cli',
    file: home('.codex/config.toml'),
    detect: () => !!which('codex') || fs.existsSync(home('.codex/config.toml')),
    async connected() {
      // Same reasoning as Claude: read the TOML, do not pay for a health check.
      try { return new RegExp(`^\\[mcp_servers\\.${SERVER_NAME}\\]`, 'm')
        .test(fs.readFileSync(this.file, 'utf8')) } catch { return false }
    },
    async connect() {
      const r = await run(which('codex'),
        ['mcp', 'add', SERVER_NAME, '--', nodeBin(), shimPath()])
      if (!r.ok) return { ok: false, error: (r.stderr || r.stdout).trim().split('\n')[0] }
      // Codex kills a tool call at 60s by default, which would cut off any real
      // recording mid-take. Fixing it here beats letting someone discover it later.
      raiseCodexTimeout()
      return { ok: true, note: 'raised tool_timeout_sec so long recordings are not cut off' }
    },
  },
  {
    id: 'cursor', label: 'Cursor', kind: 'file',
    file: home('.cursor/mcp.json'),
    detect() { return fs.existsSync(this.file) || fs.existsSync('/Applications/Cursor.app') },
    async connected() {
      const j = readJson(this.file)
      return !!(j && j.mcpServers && j.mcpServers[SERVER_NAME])
    },
    async connect() {
      const j = readJson(this.file) || {}
      j.mcpServers = j.mcpServers || {}
      j.mcpServers[SERVER_NAME] = { type: 'stdio', command: nodeBin(), args: [shimPath()] }
      writeJson(this.file, j)
      return { ok: true }
    },
  },
  {
    id: 'windsurf', label: 'Windsurf', kind: 'file',
    file: home('.codeium/windsurf/mcp_config.json'),
    detect() { return fs.existsSync(this.file) || fs.existsSync('/Applications/Windsurf.app') },
    async connected() {
      const j = readJson(this.file)
      return !!(j && j.mcpServers && j.mcpServers[SERVER_NAME])
    },
    async connect() {
      const j = readJson(this.file) || {}
      j.mcpServers = j.mcpServers || {}
      j.mcpServers[SERVER_NAME] = { command: nodeBin(), args: [shimPath()] }
      writeJson(this.file, j)
      return { ok: true }
    },
  },
  {
    id: 'zed', label: 'Zed', kind: 'file',
    file: home('.config/zed/settings.json'),
    detect() { return fs.existsSync(this.file) || fs.existsSync('/Applications/Zed.app') },
    async connected() {
      const j = readJson(this.file)
      // Zed calls them context_servers, not mcpServers
      return !!(j && j.context_servers && j.context_servers[SERVER_NAME])
    },
    async connect() {
      const j = readJson(this.file) || {}
      j.context_servers = j.context_servers || {}
      j.context_servers[SERVER_NAME] = { command: nodeBin(), args: [shimPath()] }
      writeJson(this.file, j)
      return { ok: true }
    },
  },
]

// Codex config is TOML and we only need one key, so edit the line rather than pull in
// a TOML library to rewrite a file someone else owns.
function raiseCodexTimeout() {
  const p = home('.codex/config.toml')
  let text = ''
  try { text = fs.readFileSync(p, 'utf8') } catch { return }
  const header = `[mcp_servers.${SERVER_NAME}]`
  const i = text.indexOf(header)
  if (i < 0) return
  const rest = text.slice(i)
  const endRel = rest.indexOf('\n[', 1)
  const section = endRel < 0 ? rest : rest.slice(0, endRel)
  if (/tool_timeout_sec\s*=/.test(section)) return
  const patched = section.replace(header, `${header}\ntool_timeout_sec = 900`)
  fs.writeFileSync(p, text.slice(0, i) + patched + (endRel < 0 ? '' : rest.slice(endRel)))
}

// ---------- api ----------
// In parallel: `claude mcp list` and `codex mcp list` each take a second or two, and
// run serially that is a screen sitting on a spinner for no reason.
async function detect() {
  await primeWhich()
  const clients = await Promise.all(CLIENTS.map(async c => {
    let installed = false
    try { installed = !!c.detect() } catch {}
    let connected = false
    if (installed) { try { connected = !!(await c.connected()) } catch {} }
    return { id: c.id, label: c.label, installed, connected }
  }))
  return { clients, command: `${nodeBin()} ${shimPath()}` }
}

async function connect(id) {
  const c = CLIENTS.find(x => x.id === id)
  if (!c) return { ok: false, error: `unknown client: ${id}` }
  await primeWhich()
  if (c.kind === 'cli' && !which(c.id)) return { ok: false, error: `${c.label} is not installed` }
  let r
  try { r = await c.connect() } catch (e) { return { ok: false, error: e.message } }
  if (!r.ok) return r
  // Read it back. A tick should mean verified, not attempted.
  let confirmed = false
  try { confirmed = !!(await c.connected()) } catch {}
  return confirmed ? { ok: true, note: r.note } : { ok: false, error: 'wrote the config but could not read it back' }
}

module.exports = { detect, connect, shimPath, nodeBin, SERVER_NAME }
