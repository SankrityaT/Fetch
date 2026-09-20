// The in-app chat, running on the agent CLI the person already pays for.
// Main-process module, required from main.js.
//
// Fetch does not talk to a model. It spawns Claude Code or Codex, which are already
// installed and already signed in, and hands them the Fetch MCP server. So there is
// no API key anywhere in this app, no bill, and the same plan and limits the person
// already has. That is the whole reason this is worth building rather than wiring up
// a provider SDK.
//
// Two things are deliberately narrow, and the first one is not the same promise on
// both CLIs, so the pane says which one it is keeping (ui/chat.js).
//
//   On Claude Code the tool list is explicit: Fetch's own tools and nothing else, so
//   it cannot run a shell, read arbitrary files or reach the network through this
//   pane. That takes three flags, not one: --allowedTools only pre-approves, it does
//   not take anything away, so Bash and Read were still there and the person's other
//   MCP servers (mail, calendar) were loaded too. --tools "" removes every built-in
//   tool and --strict-mcp-config loads the Fetch server alone.
//
//   Codex has no flag that drops its shell, so this does the two things it can: the
//   same single Fetch server, replacing whatever the person's own config lists, and
//   the read-only sandbox, which reaches no network and writes nothing. The shell is
//   still there and can read files, so under Codex the composer says that instead of
//   claiming "Fetch's tools only". A trust claim true for one of two engines is worse
//   than no claim.
//
//   The standing doctrine goes once per conversation, not once per message: Claude
//   Code takes --append-system-prompt, and Codex, which has no such flag, gets it on
//   the message that opens the thread, after which its own resume carries it.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn, spawnSync } = require('child_process')

const connect = require('./agent-connect')
const Assist = require('./edit-assist')
const Memory = require('./memory')

let electronApp
try { ({ app: electronApp } = require('electron')) } catch {}

// What the person has already said about themselves and this product, as one block,
// read off disk at the moment the conversation opens. A new chat used to be a stranger
// every time; this is the one place the doctrine can carry it without paying for it on
// every message. A store that cannot be read costs the turn nothing.
function memoryText(take) {
  try {
    const root = process.env.FETCH_CHAT_DIR || (electronApp ? electronApp.getPath('userData') : null)
    if (!root) return ''
    return Memory.recallFor({ root, take: take || null }).text || ''
  } catch { return '' }
}

// Exactly the tools the MCP server exposes. Kept literal rather than globbed so
// adding a tool is a deliberate decision about what the in-app chat may do.
const ALLOWED = [
  'record_start', 'record_stop', 'record_pause', 'record_status',
  'list_windows', 'list_displays', 'list_recordings',
  'probe', 'transcribe',
  'get_edit', 'apply_edit', 'list_beats', 'export', 'rename_recording',
  'get_frame', 'find_on_screen', 'preview_frame', 'contact_sheet', 'remove_dead_air', 'enhance_audio', 'get_settings', 'set_settings', 'delete_recording',
  'get_look_schema', 'list_looks', 'apply_look', 'save_look',
  // the job: plan it, hit the length, check the result, take back what was wrong
  'direct', 'fit_to_length', 'review', 'revert_my_edit',
  // whether a clip wraps with no visible jump, for a demo that autoplays on a page
  'can_loop',
  // put the fork to the person instead of guessing, and show a wide change before it lands
  'ask', 'propose',
  // what the person said that is still true next week, so a new chat is not a stranger
  'remember',
  'list_voices', 'voiceover',
].map(t => `mcp__fetch__${t}`)

let current = null          // the one running turn, if any

// A card raised by a tool rather than by the CLI's own stream: a question with buttons,
// a proposal with Apply and Discard (ui/agent-bridge.js, chat.ask and chat.propose).
// It has to join the same thread the turn is writing, or the person reads an answer to
// a question that is not above it.
//
// During a turn that is the turn's own sink, which main.js has already wrapped in the
// chat log, so the card replays after a restart. An outside agent over MCP has no turn
// running here, so the window is the only route and the log is written here instead.
// Nowhere to put it is not an error: the bridge settles the card unattended and the
// agent is told in as many words that nobody saw it.
let sink = null
const enders = []
function say(ev, win) {
  if (sink) { sink(ev); return true }
  if (!win || win.isDestroyed()) return false
  try { chatLog.append(ev) } catch {}
  try { win.webContents.send('chat-event', ev) } catch { return false }
  return true
}
// Called when a turn ends, however it ends. A question outliving its turn is a live
// button wired to a conversation that is over.
const onTurnEnd = fn => { enders.push(fn) }
const turnEnded = why => { for (const fn of enders) { try { fn(why) } catch {} } }

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

// One MCP server for Codex too, Fetch's own, in place of whatever the person's own
// config lists: without this the pane loaded their mail and calendar servers as well.
// -c parses its value as TOML, and JSON.stringify writes a valid TOML basic string.
const codexServers = () =>
  `mcp_servers={fetch={command=${JSON.stringify(connect.nodeBin())},args=[${JSON.stringify(connect.shimPath())}]}}`

function argsFor(engine, prompt, model, effort, images = [], take = null) {
  if (engine === 'codex') {
    // Codex streams JSONL from `exec --json`.
    // Runs in Fetch's own folder (see send), which is not a git repo.
    const a = ['exec', '--skip-git-repo-check', '--json', '-s', 'read-only', '-c', codexServers()]
    // The doctrine opens a thread and the thread keeps it, so a follow-up does not
    // pay for it again.
    const opening = !sessions.codex
    if (sessions.codex) a.push('resume', sessions.codex)
    if (model) a.push('--model', model)
    if (effort) a.push('-c', `model_reasoning_effort="${effort}"`)
    for (const im of images) a.push('-i', im.file)
    a.push(opening ? `${Assist.systemPrompt({ memory: memoryText(take) })}\n\n${prompt}` : prompt)
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
    // Appended, not replacing: Claude Code's own prompt is what makes its tool use
    // work, and the doctrine is a house rule on top of it.
    '--append-system-prompt', Assist.systemPrompt({ memory: sessions.claude ? '' : memoryText(take) }),
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

function send({ engine = 'claude', model = null, effort = null, prompt, attachments = [], take = null, retried = false }, onEvent) {
  if (current) throw new Error('already working on something')
  const again = { engine, model, effort, prompt, attachments, take, retried: true }
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
  const child = spawn(bin, argsFor(engine, prompt, pick.model, pick.effort, images, take), {
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
  sink = onEvent
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
    sink = null
    // Anything still waiting on the person goes with the turn: the tool that asked has
    // long since been handed its do_next and moved on.
    turnEnded(child.cancelled ? 'cancelled' : 'timeout')
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

module.exports = { send, cancel, busy, newConversation, translate, argsFor, ALLOWED,
  // a card a tool raised, into this thread, and the end of the turn it belongs to
  say, onTurnEnd }
