// Naming a take with the person's own agent, after it lands. Main-process module,
// required from main.js.
//
// A take already has a name from the app that was in front while it recorded
// (nameTake in app.js). One with speech then gets a better one: its opening words
// are transcribed on device and the agent CLI the person already has (Claude Code on
// Haiku, or Codex) is asked for "Product · What happens". Only the app, the window
// title and the first 80 words go to it, never the video, the audio or a path.
//
// A take is renamed only while its name is still one Fetch gave it (naming.isAutoName),
// checked again just before the rename, so a name typed in the meantime always wins.
// One take at a time: a Library full of old takes must not start ten transcribers.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const naming = require('./naming')
const connect = require('./agent-connect')

// Seconds of audio for the quick path: about 150 spoken words, enough for the first 80
const HEAD = 60
const ASK_MS = 60000
// Longest an automatic rename waits for other jobs on the take before giving up
const BUSY_MS = 10 * 60e3
// A short system prompt, in place of Claude Code's own: it is most of the cost of a
// one-line answer, and a namer needs none of it.
const SYSTEM = 'You name screen recordings. Reply with the name only.'

let deps = null           // { proc, getPrefs, rename(file, stem) -> new path, follow(p) -> p, log, busy() }
let chain = Promise.resolve()

function init(d) { deps = d }

// The CLI to ask, or null: Claude Code when it is installed (Haiku is quick and
// cheap), else Codex. Nothing when neither is connected to Fetch, since that is what
// "on when an agent is connected" means for a default nobody chose.
async function engine() {
  await connect.primeWhich()
  const det = await connect.detect().catch(() => ({ clients: [] }))
  const any = det.clients.some(c => (c.id === 'claude' || c.id === 'codex') && c.connected)
  const chosen = deps.getPrefs().agentNames
  if (chosen === false || (chosen !== true && !any)) return null
  if (connect.binFor('claude')) return 'claude'
  if (connect.binFor('codex')) return 'codex'
  return null
}

// The take's words: a transcript made already covers the whole take, else the opening
// minute, transcribed on its own and thrown away (no sidecars for a name).
async function openingWords(file) {
  try {
    const t = fs.readFileSync(deps.proc.sidecarIn(file, '.txt'), 'utf8').trim()
    if (t) return t
  } catch {}
  const meta = await deps.proc.probeMeta(file).catch(() => null)
  if (!meta || !meta.hasAudio) return ''
  try {
    const r = await deps.proc.transcribe(file, { quick: true, head: HEAD }, null, 'name-' + Date.now())
    return String(r && r.text || '').trim()
  } catch { return '' }
}

// One answer from the CLI, as text, or null. No tools, no MCP servers, no session
// kept, run from the temp folder so no project's instructions are read.
function ask(engineId, prompt) {
  const bin = connect.binFor(engineId)
  if (!bin) return Promise.resolve(null)
  const out = path.join(os.tmpdir(), `fetch-name-${Date.now()}.txt`)
  const args = engineId === 'codex'
    ? ['exec', '--skip-git-repo-check', '--ephemeral', '-s', 'read-only',
        '-c', 'model_reasoning_effort="low"', '-c', 'mcp_servers={}', '-o', out, prompt]
    : ['-p', prompt, '--model', 'haiku', '--tools', '', '--strict-mcp-config',
        '--no-session-persistence', '--output-format', 'text', '--system-prompt', SYSTEM]
  return new Promise(resolve => {
    let text = '', done = false
    const child = spawn(bin, args, {
      cwd: os.tmpdir(), stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, PATH: `${path.dirname(connect.nodeBin())}:${process.env.PATH || ''}` },
    })
    const finish = v => { if (done) return; done = true; clearTimeout(timer); resolve(v) }
    const timer = setTimeout(() => { try { child.kill() } catch {} finish(null) }, ASK_MS)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', d => { text += d })
    child.on('error', () => finish(null))
    child.on('close', code => {
      if (engineId === 'codex') {
        try { text = fs.readFileSync(out, 'utf8') } catch {}
        try { fs.unlinkSync(out) } catch {}
      }
      finish(code === 0 ? text.trim() : null)
    })
  })
}

const label = id => id === 'codex' ? 'Codex' : 'Claude Code'
// what a new note carries over from the old one
const keep = note => note && note.front ? { front: note.front } : {}

/**
 * Names one take. Resolves to { from, to, was, name } when it renamed, or
 * { skipped } saying why not. `opts.local` allows a name without an agent (the
 * Library's action, the editor): the app in front plus the first beat, when there is
 * a transcript. `opts.upgrade` leaves a name the agent gave alone.
 */
async function nameOne(file, opts = {}) {
  file = deps.follow(file)
  if (!file || !fs.existsSync(file)) return { skipped: 'gone' }
  const note = deps.proc.readNameNote(file) || {}
  const was = deps.proc.takeName(file)
  if (!naming.isAutoName(was, note)) return { skipped: 'named by a person' }
  // the editor's transcript arriving is no reason to replace the agent's own name
  if (opts.upgrade && note.by === 'agent' && was === note.auto) return { skipped: 'named by the agent' }
  const front = note.front || {}

  let name = null, by = null
  const eng = await engine()
  if (eng) {
    const words = await openingWords(file)
    if (words.split(/\s+/).filter(Boolean).length >= 4) {
      const t0 = Date.now()
      const reply = await ask(eng, naming.namePrompt({ ...front, words }))
      name = naming.parseAgentName(reply)
      if (name) by = eng
      else if (deps.log) deps.log({ op: 'recordings.name', title: 'Could not name a recording', detail: was,
        by: label(eng), ms: Date.now() - t0, ok: false, error: reply ? 'the reply was not a name' : 'no reply' })
    }
  }
  if (!name && opts.local) {
    // beats from speech only: without a transcript beatsFor falls back to the pointer
    const spoken = fs.existsSync(deps.proc.sidecarIn(file, '.words.json'))
    const beats = spoken ? (() => { try { return deps.proc.beatsFor(file) || [] } catch { return [] } })() : []
    name = naming.smartName({ ...front, said: beats[0] && beats[0].label })
    by = 'app'
  }
  if (!name) {
    // asked for from the Library and nothing better found: not offered again
    if (opts.local && !opts.upgrade) deps.proc.writeNameNote(file, was, note.by || 'app', { ...keep(note), tried: true })
    return { skipped: eng ? 'no speech' : 'no agent' }
  }

  // A job still working on the take (its MP4 copy, a transcript an agent asked for)
  // writes under the path it started with, so a take renamed under it loses that work.
  // A name nobody asked for waits for them to finish; one asked for does not.
  if (!opts.local && deps.busy) {
    const until = Date.now() + BUSY_MS
    while (deps.busy() && Date.now() < until) await new Promise(r => setTimeout(r, 1000))
    if (deps.busy()) return { skipped: 'busy' }
  }

  // Transcribing and asking take a while: the take may have moved, or been named by
  // hand, since this started
  file = deps.follow(file)
  if (!fs.existsSync(file)) return { skipped: 'gone' }
  const now = deps.proc.takeName(file)
  if (!naming.isAutoName(now, deps.proc.readNameNote(file) || note)) return { skipped: 'named by a person' }
  // "Songscription 2" is already this name, made unique beside another Songscription
  const lo = name.toLowerCase(), nowLo = now.toLowerCase()
  if (nowLo === lo || (nowLo.startsWith(lo + ' ') && /^\d+$/.test(nowLo.slice(lo.length + 1)))) {
    // nothing to move, but it has been named: the Library does not offer it again
    deps.proc.writeNameNote(file, now, by === 'app' ? 'app' : 'agent', { ...keep(note), ...(by === 'app' ? { tried: true } : {}) })
    return { skipped: 'same name' }
  }

  const to = await deps.rename(file, name)
  const got = deps.proc.takeName(to)
  deps.proc.writeNameNote(to, got, by === 'app' ? 'app' : 'agent', { ...keep(note), ...(opts.local && by === 'app' ? { tried: true } : {}) })
  if (deps.log && by !== 'app') deps.log({ op: 'recordings.rename', title: 'Named a recording', detail: got, by: label(by), ok: true })
  return { from: file, to, was: now, name: got, by, note }
}

// Queued, so takes are named one after another however many are asked for at once
function name(file, opts) {
  const run = chain.then(() => nameOne(file, opts)).catch(e => ({ skipped: 'failed', error: e.message }))
  chain = run
  return run
}

// Puts names back, for the Library's undo: the old name, and the old note with it, so
// a name Fetch gave stays one it may improve later
async function restore(entries = []) {
  let n = 0
  for (const e of entries) {
    const file = deps.follow(e.to)
    if (!file || !fs.existsSync(file) || !e.was) continue
    try {
      const back = await deps.rename(file, e.was)
      if (e.note && e.note.auto) deps.proc.writeNameNote(back, deps.proc.takeName(back), e.note.by || 'app', keep(e.note))
      else { try { fs.unlinkSync(deps.proc.sidecarIn(back, '.name.json')) } catch {} }
      n++
    } catch {}
  }
  return n
}

module.exports = { init, name, restore, engine, ask }
