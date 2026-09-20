// The chat's memory and its result data, without Electron or a real CLI.
//   node test/chat.test.js
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-chat-'))
process.env.FETCH_CHAT_DIR = dir
const chatLog = require('../ui/chat-log')
const agentChat = require('../ui/agent-chat')

let n = 0
const t = (name, fn) => { fn(); n++; console.log('ok', name) }

t('log round-trips user turns and events in order', () => {
  chatLog.append({ kind: 'user', text: 'export it', tags: [{ name: 'Demo', path: '/x/Demo.mov' }], attachments: [] })
  chatLog.append({ kind: 'tool', id: 't1', name: 'export', tool: 'export', input: { path: '/x/Demo.mov' } })
  chatLog.append({ kind: 'result', id: 't1', ok: true, tool: 'export', data: { path: '/x/Demo.mp4', mb: 3.1, seconds: 12 } })
  chatLog.append({ kind: 'done', ok: true, ms: 900 })
  const r = chatLog.read()
  assert.deepStrictEqual(r.map(e => e.kind), ['user', 'tool', 'result', 'done'])
  assert.strictEqual(r[0].tags[0].path, '/x/Demo.mov')
  assert.strictEqual(r[2].data.path, '/x/Demo.mp4')
  assert.ok(r.every(e => typeof e.at === 'number'))
})

t('read starts on a user turn and skips torn lines', () => {
  fs.writeFileSync(chatLog.logPath(), '{"kind":"text","text":"orphan"}\n{bad json\n{"kind":"user","text":"hi"}\n{"kind":"done","ok":true}\n')
  assert.deepStrictEqual(chatLog.read().map(e => e.kind), ['user', 'done'])
})

t('large fields are dropped from the saved copy only', () => {
  fs.writeFileSync(chatLog.logPath(), '')
  const fonts = Array.from({ length: 800 }, (_, i) => 'Font Family ' + i)
  const live = { zooms: [{ id: 'Z1' }], options: { fonts } }
  chatLog.append({ kind: 'user', text: 'x' })
  chatLog.append({ kind: 'result', id: 'a', ok: true, tool: 'apply_edit', data: live })
  const saved = chatLog.read()[1].data
  assert.deepStrictEqual(saved.zooms, [{ id: 'Z1' }])
  assert.strictEqual(saved.options, undefined)
  assert.ok(live.options, 'the live event is untouched')
})

t('a long list of edit objects keeps its ids, so the card can still count it', () => {
  fs.writeFileSync(chatLog.logPath(), '')
  const clips = Array.from({ length: 120 }, (_, i) => ({ id: 'C' + (i + 1), start: i * 1.25, end: i * 1.25 + 1.1 }))
  chatLog.append({ kind: 'user', text: 'x' })
  chatLog.append({ kind: 'result', id: 'a', ok: true, tool: 'apply_edit', data: { clips } })
  const saved = chatLog.read()[1].data
  assert.strictEqual(saved.clips.length, 120)
  assert.deepStrictEqual(saved.clips[0], { id: 'C1' })
})

t('sessions persist and rotate clears both files', () => {
  chatLog.saveSessions({ claude: 'abc', codex: null })
  assert.deepStrictEqual(chatLog.loadSessions(), { claude: 'abc', codex: null })
  chatLog.rotate()
  assert.deepStrictEqual(chatLog.loadSessions(), { claude: null, codex: null })
  assert.deepStrictEqual(chatLog.read(), [])
  assert.ok(fs.existsSync(path.join(dir, 'chat.prev.jsonl')))
})

t('translate: a Claude tool_result carries the raw tool name and parsed data', () => {
  const evs = [], started = new Map()
  const on = e => evs.push(e)
  agentChat.translate({ type: 'assistant', message: { content: [
    { type: 'tool_use', id: 'tu1', name: 'mcp__fetch__remove_dead_air', input: { path: '/x/a.mov' } },
    { type: 'tool_use', id: 'tu2', name: 'ToolSearch', input: {} },
  ] } }, on, started)
  agentChat.translate({ type: 'user', message: { content: [
    { type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: JSON.stringify({ path: '/x/a-cut.mp4', removed_percent: 22, seconds: 30 }) }] },
    { type: 'tool_result', tool_use_id: 'tu2', content: 'ignored' },
  ] } }, on, started)
  assert.strictEqual(evs.length, 2)
  assert.deepStrictEqual([evs[0].kind, evs[0].name, evs[0].tool], ['tool', 'remove dead air', 'remove_dead_air'])
  const r = evs[1]
  assert.strictEqual(r.kind, 'result')
  assert.strictEqual(r.tool, 'remove_dead_air')
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.data.path, '/x/a-cut.mp4')
  assert.ok(r.summary, 'the one-line summary is kept')
})

t('translate: get_frame keeps the JSON and not the base64 image', () => {
  const evs = [], started = new Map()
  agentChat.translate({ type: 'assistant', message: { content: [
    { type: 'tool_use', id: 'f1', name: 'mcp__fetch__get_frame', input: { path: '/x/a.mov', at: 3 } }] } }, e => evs.push(e), started)
  agentChat.translate({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'f1', content: [
    { type: 'text', text: '{"image":"/tmp/f.jpg","at":3}' },
    { type: 'image', source: { type: 'base64', data: 'AAAA' } }] }] } }, e => evs.push(e), started)
  assert.deepStrictEqual(evs[1].data, { image: '/tmp/f.jpg', at: 3 })
})

t('translate: an error result has no data', () => {
  const evs = [], started = new Map()
  agentChat.translate({ type: 'assistant', message: { content: [
    { type: 'tool_use', id: 'e1', name: 'mcp__fetch__export', input: {} }] } }, e => evs.push(e), started)
  agentChat.translate({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'e1', is_error: true, content: 'path is required' }] } }, e => evs.push(e), started)
  assert.strictEqual(evs[1].ok, false)
  assert.strictEqual(evs[1].data, null)
})

t('translate: a Claude session id is saved to disk', () => {
  agentChat.translate({ type: 'result', session_id: 'sess-42' }, () => {}, new Map())
  assert.strictEqual(chatLog.loadSessions().claude, 'sess-42')
  agentChat.newConversation()
  assert.strictEqual(chatLog.loadSessions().claude, null)
})

t('translate: a Codex tool call carries data', () => {
  const evs = []
  agentChat.translate({ type: 'item.completed', item: { type: 'mcp_tool_call', id: 'c1', tool: 'export', status: 'completed',
    arguments: { path: '/x/a.mov' }, result: { content: [{ type: 'text', text: '{"path":"/x/a.mp4","mb":2}' }] } } }, e => evs.push(e), new Map())
  assert.strictEqual(evs[1].tool, 'export')
  assert.strictEqual(evs[1].data.path, '/x/a.mp4')
  assert.strictEqual(evs[1].summary, 'a.mp4', 'a row names the file, never "path /Users/..."')
})

t('claude runs with Fetch tools only', () => {
  const a = agentChat.argsFor('claude', 'hi', null, null)
  // --allowedTools only pre-approves; these two are what actually take the rest away
  assert.ok(a.includes('--strict-mcp-config'))
  assert.strictEqual(a[a.indexOf('--tools') + 1], '')
  assert.ok(a[a.indexOf('--allowedTools') + 1].split(',').every(x => x.startsWith('mcp__fetch__')))
})

// The pane said "Fetch's tools only. No shell, no files, no network." whichever CLI
// ran, and under Codex that was three quarters false: no tool restriction, no sandbox,
// and every MCP server on the person's machine loaded. Codex has no flag that drops
// its shell, so this is the honest half: one server, and read only.
t('codex runs read only, on the Fetch server alone', () => {
  const a = agentChat.argsFor('codex', 'hi', null, null)
  assert.strictEqual(a[a.indexOf('-s') + 1], 'read-only')
  const cfg = a.filter(x => typeof x === 'string' && x.startsWith('mcp_servers='))
  assert.strictEqual(cfg.length, 1, 'the whole server table is replaced, not added to')
  assert.ok(/^mcp_servers=\{fetch=\{command=".+",args=\[".+"\]\}\}$/.test(cfg[0]), cfg[0])
})

// The doctrine is the standing rules, so it goes once per conversation: Claude Code
// takes it as a system prompt, and Codex, which has no such flag, gets it on the
// message that opens the thread and carries it on resume from there.
t('the doctrine is sent once, not on every message', () => {
  const Assist = require('../ui/edit-assist')
  const sys = Assist.systemPrompt()
  const a = agentChat.argsFor('claude', 'hi', null, null)
  // appended, never replacing: Claude Code's own prompt is what makes its tools work
  assert.strictEqual(a[a.indexOf('--append-system-prompt') + 1], sys)
  assert.ok(!a.includes('--system-prompt'))
  assert.strictEqual(a[a.indexOf('-p') + 1], 'hi', 'the message itself stays short')

  const c = agentChat.argsFor('codex', 'hi', null, null)
  assert.strictEqual(c[c.length - 1], `${sys}\n\nhi`)
  agentChat.translate({ type: 'thread.started', thread_id: 'th-7' }, () => {}, new Map())
  const again = agentChat.argsFor('codex', 'now caption it', null, null)
  assert.strictEqual(again[again.length - 1], 'now caption it', 'a resumed thread already has it')
  assert.ok(again.includes('resume') && again.includes('th-7'))
  agentChat.newConversation()
})

// record.pause sat in the bridge unregistered for months. test/tools.test.js proves
// this list and the MCP server's agree; this one proves the new names are here at all.
t('the new tools are allowed in the pane', () => {
  for (const name of ['record_pause', 'contact_sheet', 'direct', 'review', 'fit_to_length',
    'revert_my_edit', 'list_voices', 'voiceover', 'ask', 'propose']) {
    assert.ok(agentChat.ALLOWED.includes(`mcp__fetch__${name}`), name)
  }
  assert.ok(agentChat.ALLOWED.every(x => x.startsWith('mcp__fetch__')))
  assert.strictEqual(new Set(agentChat.ALLOWED).size, agentChat.ALLOWED.length, 'no name twice')
})

// A question and a proposal land in the thread as their own event kinds, so the log
// that replays the pane has to carry them and what was decided. Without the settled
// event a restart would redraw a live question wired to a conversation that is over.
t('a question, a proposal and how each was settled all survive a restart', () => {
  fs.writeFileSync(chatLog.logPath(), '')
  chatLog.append({ kind: 'user', text: 'hide the sidebar' })
  chatLog.append({ kind: 'ask', id: 'Q1', question: 'Which part?', timeoutMs: 90000,
    choices: [{ id: 'sidebar', label: 'The whole sidebar' }, { id: 'practice', label: 'Just the Practice button' }] })
  chatLog.append({ kind: 'settled', id: 'Q1', how: 'answered', choice: 'practice' })
  chatLog.append({ kind: 'propose', id: 'P1', title: 'Blur the Practice button', changes: [{ id: 'M4', line: 'Blur at 0:12' }] })
  chatLog.append({ kind: 'settled', id: 'P1', how: 'discard' })
  const r = chatLog.read()
  assert.deepStrictEqual(r.map(e => e.kind), ['user', 'ask', 'settled', 'propose', 'settled'])
  assert.strictEqual(r[1].choices.length, 2, 'the choices are what makes it answerable, so they are kept')
  assert.strictEqual(r[2].choice, 'practice')
  assert.strictEqual(r[4].how, 'discard')
})

fs.rmSync(dir, { recursive: true, force: true })
console.log(`\n${n} chat checks passed`)
