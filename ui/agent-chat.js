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
//   network through this pane. An allowlist of eight named tools is a much easier
//   promise to keep than a sandbox.
//
//   Nothing is auto-approved beyond that list. If a model asks for anything else the
//   run simply will not have it.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

const connect = require('./agent-connect')

// Exactly the tools the MCP server exposes. Kept literal rather than globbed so
// adding a tool is a deliberate decision about what the in-app chat may do.
const ALLOWED = [
  'record_start', 'record_stop', 'record_status',
  'list_windows', 'list_displays', 'list_recordings',
  'probe', 'transcribe',
  'get_edit', 'apply_edit', 'list_beats', 'export',
].map(t => `mcp__fetch__${t}`)

let current = null          // the one running turn, if any

// The conversation this pane is in. Without it every message was a stranger: each
// send spawned a fresh CLI that had never heard of the last one, so "now transcribe
// it" had no idea what "it" was. Claude Code reports a session_id on every result and
// takes --resume; Codex has its own resume. One id per engine, since they are
// separate conversations on separate services.
const sessions = { claude: null, codex: null }
const newConversation = () => { sessions.claude = null; sessions.codex = null }

function mcpConfigPath() {
  const p = path.join(os.tmpdir(), 'fetch-mcp-chat.json')
  fs.writeFileSync(p, JSON.stringify({
    mcpServers: { fetch: { command: connect.nodeBin(), args: [connect.shimPath()] } },
  }))
  return p
}

function argsFor(engine, prompt, model) {
  if (engine === 'codex') {
    // Codex streams JSONL from `exec --json`. Its MCP servers come from the user's
    // own config, which the Connect screen already wrote.
    const a = ['exec', '--json']
    if (sessions.codex) a.push('resume', sessions.codex)
    if (model) a.push('--model', model)
    a.push(prompt)
    return a
  }
  const a = [
    '-p', prompt,
    '--output-format', 'stream-json', '--verbose',
    '--mcp-config', mcpConfigPath(),
    '--allowedTools', ALLOWED.join(','),
  ]
  // Carry the thread. Without this each turn starts from nothing and a follow-up
  // like "now caption that one" refers to something the agent never saw.
  if (sessions.claude) a.push('--resume', sessions.claude)
  if (model) a.push('--model', model)
  return a
}

/**
 * Run one turn. `onEvent` receives normalised events so the renderer never has to
 * know which CLI produced them:
 *
 *   { kind: 'text',   text }
 *   { kind: 'tool',   id, name, input }
 *   { kind: 'result', id, ok, summary }
 *   { kind: 'done',   ms, ok, error }
 */
function send({ engine = 'claude', model = null, prompt }, onEvent) {
  if (current) throw new Error('already working on something')

  const bin = connect.binFor(engine)
  if (!bin) throw new Error(`${engine === 'codex' ? 'Codex' : 'Claude Code'} is not installed`)

  const t0 = Date.now()
  const child = spawn(bin, argsFor(engine, prompt, model), {
    stdio: ['ignore', 'pipe', 'pipe'],
    // A login shell's PATH, because the CLI shells out to node and git itself.
    env: { ...process.env, PATH: `${path.dirname(connect.nodeBin())}:${process.env.PATH || ''}` },
  })
  current = child

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
    if (!current) return
    current = null
    onEvent({ kind: 'done', ms: Date.now() - t0, ok, error: error || null })
  }
  child.on('error', e => finish(false, e.message))
  child.on('close', code => {
    if (code === 0) finish(true, null)
    else finish(false, (stderr.trim().split('\n').pop() || `exited ${code}`))
  })

  return { cancel: () => { try { child.kill('SIGTERM') } catch {} } }
}

// Both CLIs emit their own shapes. Normalising here keeps the renderer honest: it
// renders events, not vendor formats.
function translate(m, onEvent, started) {
  // Claude Code
  if (m.type === 'assistant' && m.message) {
    for (const b of m.message.content || []) {
      if (b.type === 'text' && b.text && b.text.trim()) onEvent({ kind: 'text', text: b.text })
      if (b.type === 'tool_use') {
        // Only Fetch's own tools. Claude Code calls its internal ToolSearch to find
        // them first, and surfacing that would make the pane a log of the CLI's
        // housekeeping rather than of what happened to this Mac.
        if (!isFetchTool(b.name)) continue
        started.set(b.id, Date.now())
        onEvent({ kind: 'tool', id: b.id, name: prettyTool(b.name), input: b.input })
      }
    }
    return
  }
  if (m.type === 'user' && m.message) {
    for (const b of m.message.content || []) {
      if (b.type !== 'tool_result') continue
      const began = started.get(b.tool_use_id)
      if (began === undefined) continue      // a tool we filtered out on the way in
      onEvent({
        kind: 'result', id: b.tool_use_id,
        ok: !b.is_error,
        ms: began ? Date.now() - began : null,
        summary: summarise(b.content),
      })
    }
    return
  }

  // Both report their session on the final frame, which is what makes the next turn
  // a continuation rather than a stranger.
  if (m.type === 'result' && m.session_id) sessions.claude = m.session_id
  if (m.type === 'session.created' && m.session_id) sessions.codex = m.session_id
  if (m.type === 'thread.started' && m.thread_id) sessions.codex = m.thread_id

  // Codex
  if (m.type === 'item.completed' && m.item) {
    const it = m.item
    if (it.type === 'agent_message' && it.text) onEvent({ kind: 'text', text: it.text })
    if (it.type === 'mcp_tool_call') {
      onEvent({ kind: 'tool', id: it.id, name: prettyTool(it.tool || it.name), input: it.arguments })
      onEvent({ kind: 'result', id: it.id, ok: it.status !== 'failed', ms: null, summary: '' })
    }
  }
}

const isFetchTool = name => String(name || '').startsWith('mcp__fetch__')
const prettyTool = name => String(name || '').replace(/^mcp__fetch__/, '').replace(/_/g, ' ')

// One line, never a payload. A tool result pasted into the transcript is thousands
// of characters of JSON that nobody reads.
function summarise(content) {
  let text = ''
  if (typeof content === 'string') text = content
  else if (Array.isArray(content)) text = content.map(c => (c && c.text) || '').join(' ')
  text = text.trim()
  if (!text) return ''
  try {
    const j = JSON.parse(text)
    if (Array.isArray(j)) return `${j.length} result${j.length === 1 ? '' : 's'}`
    if (j && typeof j === 'object') {
      const keys = Object.keys(j)
      if (keys.length <= 3) return keys.map(k => `${k} ${j[k]}`).join(', ')
      return `${keys.length} fields`
    }
  } catch {}
  return text.length > 90 ? text.slice(0, 90) + '…' : text
}

const cancel = () => { if (current) { try { current.kill('SIGTERM') } catch {} } }
const busy = () => !!current

module.exports = { send, cancel, busy, newConversation, ALLOWED }
