// The in-app chat, running on the agent CLI the person already pays for.
// Main-process module, required from main.js.
//
// Fetch does not talk to a model. It spawns Claude Code or Codex, which are already
// installed and already signed in, and hands them the Fetch MCP server. So there is
// no API key anywhere in this app, no bill, and the same plan and limits the person
// already has. That is the whole reason this is worth building rather than wiring up
// a provider SDK.
//
// Two things are deliberately narrow:
//
//   The tool list is explicit. The spawned agent is given Fetch's own tools and
//   nothing else, so it cannot run a shell, read arbitrary files or reach the
//   network through this pane. A short list of named tools is a much easier promise
//   to keep than a sandbox.
//
//   That takes three flags, not one: --allowedTools only pre-approves, it does not
//   take anything away, so Bash and Read were still there and the person's other MCP
//   servers (mail, calendar) were loaded too. --tools "" removes every built-in tool
//   and --strict-mcp-config loads the Fetch server alone.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn, spawnSync } = require('child_process')

const connect = require('./agent-connect')

// Exactly the tools the MCP server exposes. Kept literal rather than globbed so
// adding a tool is a deliberate decision about what the in-app chat may do.
const ALLOWED = [
  'record_start', 'record_stop', 'record_status',
  'list_windows', 'list_displays', 'list_recordings',
  'probe', 'transcribe',
  'get_edit', 'apply_edit', 'list_beats', 'export', 'rename_recording',
  'get_frame', 'find_on_screen', 'preview_frame', 'remove_dead_air', 'enhance_audio', 'get_settings', 'set_settings', 'delete_recording',
  'get_look_schema', 'list_looks', 'apply_look', 'save_look',
].map(t => `mcp__fetch__${t}`)

let current = null          // the one running turn, if any

// The conversation this pane is in. Without it every message was a stranger: each
// send spawned a fresh CLI that had never heard of the last one, so "now transcribe
// it" had no idea what "it" was. Claude Code reports a session_id on every result and
// takes --resume; Codex has its own resume. One id per engine, since they are
// separate conversations on separate services. Saved to disk (ui/chat-log.js) so the
// thread survives quitting Fetch, not only closing the pane.
const chatLog = require('./chat-log')
const sessions = chatLog.loadSessions()
const newConversation = () => { sessions.claude = null; sessions.codex = null; chatLog.rotate() }
const setSession = (engine, id) => {
  if (!id || sessions[engine] === id) return
  sessions[engine] = id
  chatLog.saveSessions(sessions)
}

function mcpConfigPath() {
  const p = path.join(os.tmpdir(), 'fetch-mcp-chat.json')
  fs.writeFileSync(p, JSON.stringify({
    mcpServers: { fetch: { command: connect.nodeBin(), args: [connect.shimPath()] } },
  }))
  return p
}

// ── attachments ─────────────────────────────────────────────────────────
// Images go to the model as images, not as paths: the chat allows only Fetch's tools,
// so an agent handed a path to a screenshot has nothing to open it with. Anything
// else (a recording, a document) travels as a path, which the Fetch tools can use.
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|heic|tiff?)$/i

// A Retina screenshot can be 6K wide and several MB, past what the API takes and
// pointlessly expensive. Scale to 1568 on the long edge (the size models actually
// see at), as PNG or JPEG so HEIC and TIFF work too. sips ships with macOS.
function prepareImage(file) {
  const jpeg = /\.jpe?g$/i.test(file)
  const out = path.join(os.tmpdir(), `fetch-att-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${jpeg ? 'jpg' : 'png'}`)
  const r = spawnSync('/usr/bin/sips', ['-Z', '1568', '-s', 'format', jpeg ? 'jpeg' : 'png', file, '--out', out], { stdio: 'ignore' })
  if (r.status !== 0 || !fs.existsSync(out)) return { file, type: jpeg ? 'image/jpeg' : 'image/png' }
  return { file: out, type: jpeg ? 'image/jpeg' : 'image/png' }
}

function splitAttachments(list = []) {
  const images = [], others = []
  for (const f of list) {
    if (!f || !fs.existsSync(f)) continue
    ;(IMAGE_EXT.test(f) ? images : others).push(f)
  }
  return { images: images.slice(0, 8), others }
}

function argsFor(engine, prompt, model, effort, images = []) {
  if (engine === 'codex') {
    // Codex streams JSONL from `exec --json`. Its MCP servers come from the user's
    // own config, which the Connect screen already wrote.
    // Runs in Fetch's own folder (see send), which is not a git repo.
    const a = ['exec', '--skip-git-repo-check', '--json']
    if (sessions.codex) a.push('resume', sessions.codex)
    if (model) a.push('--model', model)
    if (effort) a.push('-c', `model_reasoning_effort="${effort}"`)
    for (const im of images) a.push('-i', im.file)
    a.push(prompt)
    return a
  }
  // With images the message goes in on stdin as content blocks, so the prompt is not
  // an argument at all; see send().
  const a = images.length ? ['-p', '--input-format', 'stream-json'] : ['-p', prompt]
  a.push(
    '--output-format', 'stream-json', '--verbose',
    '--mcp-config', mcpConfigPath(), '--strict-mcp-config',
    '--tools', '',
    '--allowedTools', ALLOWED.join(','),
  )
  // Carry the thread. Without this each turn starts from nothing and a follow-up
  // like "now caption that one" refers to something the agent never saw.
  if (sessions.claude) a.push('--resume', sessions.claude)
  if (model) a.push('--model', model)
  if (effort) a.push('--effort', effort)
  return a
}

/**
 * Run one turn. `onEvent` receives normalised events so the renderer never has to
 * know which CLI produced them:
 *
 *   { kind: 'text',   text }
 *   { kind: 'tool',   id, name, tool, input }
 *   { kind: 'result', id, ok, summary, tool, data }
 *   { kind: 'done',   ms, ok, error, cancelled }
 *
 * `name` is for reading ("remove dead air"), `tool` is the raw name the renderer
 * switches on, and `data` is the tool's parsed JSON so a result can be drawn as a
 * card with its file rather than as one squashed line.
 */
// Model and effort are checked against the catalogue before they reach argv: the
// renderer is trusted, but a stale saved choice for a model that has since gone away
// should fall back to the CLI's own default, not fail the turn.
function checked(engine, model, effort) {
  const eng = require('./models').catalogue([engine])[0]
  const m = eng && eng.models.find(x => x.id === model)
  if (!m) return { model: null, effort: null }
  return { model: m.id, effort: m.efforts.includes(effort) ? effort : null }
}

function send({ engine = 'claude', model = null, effort = null, prompt, attachments = [], retried = false }, onEvent) {
  if (current) throw new Error('already working on something')
  const again = { engine, model, effort, prompt, attachments, retried: true }
  const resumed = sessions[engine === 'codex' ? 'codex' : 'claude']

  const bin = connect.binFor(engine)
  if (!bin) throw new Error(`${engine === 'codex' ? 'Codex' : 'Claude Code'} is not installed`)

  const t0 = Date.now()
  const pick = checked(engine, model, effort)
  const att = splitAttachments(attachments)
  if (att.others.length) {
    prompt += '\n\nFiles the user attached:\n' + att.others.map(f => `- ${f}`).join('\n')
  }
  const images = att.images.map(prepareImage)
  const viaStdin = engine !== 'codex' && images.length > 0
  const child = spawn(bin, argsFor(engine, prompt, pick.model, pick.effort, images), {
    stdio: [viaStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    // Claude Code files its sessions under the working directory, so a --resume from
    // wherever Fetch happened to be launched found nothing after a restart. One fixed
    // place, Fetch's own, and never a project the agent could read.
    cwd: chatLog.dir(),
    // A login shell's PATH, because the CLI shells out to node and git itself.
    // Tool search off: with it on, Claude Code hides MCP tools behind a lookup step
    // and smaller models (Haiku) never get as far as calling a Fetch tool.
    env: { ...process.env, PATH: `${path.dirname(connect.nodeBin())}:${process.env.PATH || ''}`, ENABLE_TOOL_SEARCH: 'false' },
  })
  current = child
  if (viaStdin) {
    const content = images.map(im => ({ type: 'image',
      source: { type: 'base64', media_type: im.type, data: fs.readFileSync(im.file).toString('base64') } }))
    content.push({ type: 'text', text: prompt })
    child.stdin.end(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n')
  }

  let buf = ''
  let stderr = ''
  const started = new Map()      // tool id -> when it began, for the elapsed time

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    buf += chunk
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1)
      if (!line.trim()) continue
      let m
      try { m = JSON.parse(line) } catch { continue }   // a partial line is not fatal
      try { translate(m, onEvent, started) } catch {}
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', d => { stderr += d })

  const finish = (ok, error) => {
    if (current !== child) return
    current = null
    // Stopped on purpose is not a failure, so it does not carry the CLI's exit noise.
    if (child.cancelled) onEvent({ kind: 'done', ms: Date.now() - t0, ok: false, cancelled: true, error: null })
    else onEvent({ kind: 'done', ms: Date.now() - t0, ok, error: error || null })
  }
  child.on('error', e => finish(false, e.message))
  child.on('close', code => {
    if (code === 0) return finish(true, null)
    // Claude Code clears old sessions (after 30 days by default), and a saved id it no
    // longer has would fail every turn from then on. Forget it and ask once more as a
    // fresh conversation.
    if (resumed && !retried && !child.cancelled && current === child &&
        /no conversation found|session not found|no rollout found|thread not found/i.test(stderr)) {
      sessions[engine === 'codex' ? 'codex' : 'claude'] = null
      chatLog.saveSessions(sessions)
      current = null
      try { send(again, onEvent) } catch (e) { onEvent({ kind: 'done', ms: Date.now() - t0, ok: false, error: e.message }) }
      return
    }
    finish(false, (stderr.trim().split('\n').pop() || `exited ${code}`))
  })

  return { cancel }
}

// Both CLIs emit their own shapes. Normalising here keeps the renderer honest: it
// renders events, not vendor formats.
function translate(m, onEvent, started) {
  // Claude Code
  if (m.type === 'assistant' && m.message) {
    for (const b of m.message.content || []) {
      if (b.type === 'text' && b.text && b.text.trim()) onEvent({ kind: 'text', text: b.text })
      if (b.type === 'tool_use') {
        // Only Fetch's own tools. Nothing else is loaded (see argsFor), and anything
        // the CLI does for its own housekeeping is not what happened to this Mac.
        if (!isFetchTool(b.name)) continue
        started.set(b.id, { at: Date.now(), tool: rawTool(b.name) })
        onEvent({ kind: 'tool', id: b.id, name: prettyTool(b.name), tool: rawTool(b.name), input: b.input })
      }
    }
    return
  }
  if (m.type === 'user' && m.message) {
    for (const b of m.message.content || []) {
      if (b.type !== 'tool_result') continue
      const t = started.get(b.tool_use_id)
      if (t === undefined) continue      // a tool we filtered out on the way in
      onEvent({
        kind: 'result', id: b.tool_use_id,
        ok: !b.is_error,
        ms: t.at ? Date.now() - t.at : null,
        tool: t.tool,
        summary: summarise(b.content),
        data: b.is_error ? null : parsed(b.content),
      })
    }
    return
  }

  // Both report their session on the final frame, which is what makes the next turn
  // a continuation rather than a stranger.
  if (m.type === 'result' && m.session_id) setSession('claude', m.session_id)
  if (m.type === 'session.created' && m.session_id) setSession('codex', m.session_id)
  if (m.type === 'thread.started' && m.thread_id) setSession('codex', m.thread_id)

  // Codex
  if (m.type === 'item.completed' && m.item) {
    const it = m.item
    if (it.type === 'agent_message' && it.text) onEvent({ kind: 'text', text: it.text })
    if (it.type === 'mcp_tool_call') {
      const tool = rawTool(it.tool || it.name)
      const ok = it.status !== 'failed'
      const content = it.result && (it.result.content || it.result)
      onEvent({ kind: 'tool', id: it.id, name: prettyTool(it.tool || it.name), tool, input: it.arguments })
      onEvent({ kind: 'result', id: it.id, ok, ms: null, tool,
        summary: content ? summarise(content) : '', data: ok && content ? parsed(content) : null })
    }
  }
}

const isFetchTool = name => String(name || '').startsWith('mcp__fetch__')
const rawTool = name => String(name || '').replace(/^mcp__fetch__/, '')
const prettyTool = name => rawTool(name).replace(/_/g, ' ')

const textOf = content => typeof content === 'string' ? content
  : Array.isArray(content) ? content.map(c => (c && c.type !== 'image' && c.text) || '').join(' ') : ''

// The tool's own JSON, for the result card. Only text blocks: get_frame also returns
// the frame as base64, and that is a payload, not something to keep.
function parsed(content) {
  const text = textOf(content).trim()
  if (!text) return null
  try {
    const j = JSON.parse(text)
    return j && typeof j === 'object' ? j : null
  } catch { return null }
}

// One line, never a payload. A tool result pasted into the transcript is thousands
// of characters of JSON that nobody reads.
function summarise(content) {
  const text = textOf(content).trim()
  if (!text) return ''
  try {
    const j = JSON.parse(text)
    if (Array.isArray(j)) return `${j.length} result${j.length === 1 ? '' : 's'}`
    if (j && typeof j === 'object') {
      // A file is named, not spelled out: the full path is the card's job, and on a
      // one-line row it only ever showed "path /Users/...".
      const file = typeof j.path === 'string' ? j.path
        : Object.values(j).find(v => typeof v === 'string' && v.startsWith('/'))
      if (file) return path.basename(file)
      const keys = Object.keys(j)
      // a list is its length and a look its preset, never "[object Object]"
      const val = v => typeof v === 'string' && v.startsWith('/') ? path.basename(v)
        : Array.isArray(v) ? v.length
        : v && typeof v === 'object' ? (typeof v.preset === 'string' ? v.preset : `${Object.keys(v).length} fields`) : v
      if (keys.length <= 3) return keys.map(k => `${k.replace(/_/g, ' ')} ${val(j[k])}`).join(', ')
      return `${keys.length} fields`
    }
  } catch {}
  return text.length > 90 ? text.slice(0, 90) + '…' : text
}

// Marked before the kill, so the turn ends as "Stopped" rather than as an error.
const cancel = () => { if (current) { current.cancelled = true; try { current.kill('SIGTERM') } catch {} } }
const busy = () => !!current

module.exports = { send, cancel, busy, newConversation, translate, argsFor, ALLOWED }
