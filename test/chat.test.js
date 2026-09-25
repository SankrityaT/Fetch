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

// ── @ a project ──────────────────────────────────────────────────────────
// The picker's logic is pure and sits above the DOM in ui/chat.js, so it runs here.
const Mention = require('../ui/chat.js')
const HOUR = 3600e3, now = Date.now()
const recs = [
  { name: 'lasso-demo', path: '/r/lasso-demo.mov', mtime: now - 3 * HOUR },
  { name: 'onboarding', path: '/r/onboarding.mov', mtime: now - 50 * HOUR },
]
const projects = [
  { source: 'conductor', name: 'majuro', repo: 'rec', path: '/u/conductor/workspaces/rec/majuro/',
    branch: 'SankrityaT/mac-screen-recorder', about: 'Fetch is a Mac capture tool.\n\nIt records.', at: now - 1 * HOUR },
  { source: 'claude', name: 'majuro', path: '/u/conductor/workspaces/rec/majuro', lastUsed: now - 0.5 * HOUR },
  { source: 'orca', name: 'lagos', path: '/u/orca/workspaces/lagos', branch: 'main', at: now - 10 * HOUR },
  { source: 'claude', name: 'site', path: '/u/code/site', mtime: now - 100 * HOUR },
  { source: 'claude', path: '/u/code/no-name', mtime: now - 200 * HOUR },
  { source: 'conductor', name: 'nowhere' },
]

t('one folder seen by two tools is one project, named by the one that knows most', () => {
  const ps = Mention.normProjects(projects)
  const m = ps.filter(p => p.path === '/u/conductor/workspaces/rec/majuro')
  assert.strictEqual(m.length, 1)
  assert.strictEqual(m[0].source, 'conductor')
  assert.strictEqual(m[0].branch, 'SankrityaT/mac-screen-recorder')
  assert.strictEqual(m[0].at, now - 0.5 * HOUR, 'the latest use by either tool')
  assert.strictEqual(m[0].about, 'Fetch is a Mac capture tool. It records.', 'one line, for a one-line row')
  assert.ok(!ps.some(p => p.name === 'nowhere'), 'no path, nothing to point at')
  assert.strictEqual(ps.find(p => p.path === '/u/code/no-name').name, 'no-name')
  assert.deepStrictEqual(Mention.normProjects({ projects }).length, ps.length, 'a wrapped list reads the same')
  assert.deepStrictEqual(Mention.normProjects(null), [])
})

t('@ alone lists projects and recordings together, the most recent first', () => {
  const items = Mention.mentionItems(recs, projects, '', 8)
  assert.deepStrictEqual(items.map(x => x.name), ['majuro', 'lasso-demo', 'lagos', 'onboarding', 'site', 'no-name'])
  assert.deepStrictEqual(items.map(x => x.kind).slice(0, 3), ['project', 'recording', 'project'])
})

t('typing narrows it: the start of a name, then anywhere in it, then repo or branch', () => {
  assert.deepStrictEqual(Mention.mentionItems(recs, projects, 'la', 8).map(x => x.name), ['lasso-demo', 'lagos'])
  assert.deepStrictEqual(Mention.mentionItems(recs, projects, 'MAJ', 8).map(x => x.name), ['majuro'])
  // a branch finds its workspace even when the name does not say it
  assert.deepStrictEqual(Mention.mentionItems(recs, projects, 'mac-screen', 8).map(x => x.name), ['majuro'])
  assert.deepStrictEqual(Mention.mentionItems(recs, projects, 'rec', 8).map(x => x.name), ['majuro'])
  assert.deepStrictEqual(Mention.mentionItems(recs, projects, 'zzz', 8), [])
  assert.strictEqual(Mention.mentionItems(recs, projects, '', 3).length, 3)
})

t('no project index, and the picker is the recordings it always was', () => {
  const items = Mention.mentionItems(recs, undefined, '', 8)
  assert.deepStrictEqual(items.map(x => x.name), ['lasso-demo', 'onboarding'])
})

t('a recording tag is still name and path, exactly as before', () => {
  const r = Mention.mentionItems(recs, projects, 'onb', 8)[0]
  assert.deepStrictEqual(Mention.tagFor(r), { name: 'onboarding', path: '/r/onboarding.mov' })
})

t('a tagged project tells the agent where it is and to record it by project', () => {
  const p = Mention.mentionItems(recs, projects, 'majuro', 8)[0]
  const tag = Mention.tagFor(p)
  // the tag is written to chat.jsonl, so it keeps what the chip draws and nothing of
  // another tool's data: no description, no remote
  assert.deepStrictEqual(Object.keys(tag).sort(), ['branch', 'kind', 'name', 'path', 'source'])
  const r = Mention.tagFor(recs[0])
  const s = Mention.tagPrompt([r, tag])
  assert.ok(s.includes('Recordings the user tagged:\n- lasso-demo: /r/lasso-demo.mov'), s)
  assert.ok(s.includes('Projects the user tagged:\n- majuro: /u/conductor/workspaces/rec/majuro\n' +
    '  Conductor, branch SankrityaT/mac-screen-recorder'), s)
  assert.ok(!/description|Fetch is a Mac capture tool/.test(s), 'the description comes from main at send time')
  // the same doctrine the system prompt gives, and not list_windows, which cannot see a
  // dev Electron build
  assert.ok(/record_start or take_shot with project set to its path/.test(s) && !/list_windows/.test(s), s)
  assert.ok(/Do not ask the person for a path/.test(s), s)
  assert.ok(!/—/.test(s), 'no em dash')
  // recordings alone read exactly as they did before this round
  assert.strictEqual(Mention.tagPrompt([r]), '\n\nRecordings the user tagged:\n- lasso-demo: /r/lasso-demo.mov')
  assert.strictEqual(Mention.tagPrompt([]), '')
})

t('"@majuro record a demo" typed straight through still tags majuro', () => {
  const got = Mention.bareMentions('@majuro record a demo of the lasso, and @lasso-demo.', recs, projects)
  assert.deepStrictEqual(got.map(t => [t.kind || 'recording', t.name]), [['project', 'majuro'], ['recording', 'lasso-demo']])
  assert.strictEqual(got[0].path, '/u/conductor/workspaces/rec/majuro')
  // an address is not a mention, and a partial name is not a guess worth making
  assert.deepStrictEqual(Mention.bareMentions('mail me@majuro or @maj', recs, projects), [])
  // two things with one name: ambiguous, so neither
  const twins = projects.concat([{ source: 'orca', name: 'majuro', path: '/u/orca/workspaces/majuro' }])
  assert.deepStrictEqual(Mention.bareMentions('@majuro', recs, twins), [])
})

t('a typed @word matches a handle or alias the way the bridge does, and refuses a shared one', () => {
  const idx = [
    { id: 'P1', source: 'conductor', name: 'rec/majuro', handle: 'rec/majuro', aliases: ['rec/majuro', 'majuro'], path: '/u/conductor/workspaces/rec/majuro' },
    { id: 'P2', source: 'orca', name: 'Tend/timingila', handle: 'timingila', aliases: ['tend/timingila', 'timingila'], path: '/u/orca/workspaces/Tend/timingila' },
  ]
  // the handle or an alias tags it, typed straight through
  assert.deepStrictEqual(Mention.bareMentions('@timingila record it', [], idx).map(t => t.path), ['/u/orca/workspaces/Tend/timingila'])
  assert.deepStrictEqual(Mention.bareMentions('@majuro record it', [], idx).map(t => t.path), ['/u/conductor/workspaces/rec/majuro'])
  // a Claude-only ~/code/majuro whose name is majuro: two projects answer, so neither is
  // tagged, exactly as resolveProject would refuse it
  const both = idx.concat([{ id: 'P3', source: 'claude', name: 'majuro', handle: 'code/majuro', aliases: ['majuro', 'code/majuro'], path: '/u/code/majuro' }])
  assert.deepStrictEqual(Mention.bareMentions('@majuro record a demo', [], both), [])
  assert.deepStrictEqual(Mention.bareMentions('@code/majuro record a demo', [], both).map(t => t.path), ['/u/code/majuro'])
  // handle and aliases survive the merge of one folder seen by two tools
  const merged = Mention.normProjects(idx.concat([{ source: 'claude', name: 'majuro', path: '/u/conductor/workspaces/rec/majuro' }]))
  const m = merged.find(p => p.path === '/u/conductor/workspaces/rec/majuro')
  assert.deepStrictEqual([m.handle, m.aliases.includes('majuro'), m.id], ['rec/majuro', true, 'P1'])
})

// The lassoed area's picture keeps the area's own shape (a fix from an earlier round),
// and this round rewrote the chips beside it. Run the real function from the file.
t('a lassoed area thumbnail still keeps its shape', () => {
  const src = fs.readFileSync(path.join(__dirname, '../ui/chat.js'), 'utf8')
  const body = /function regionThumb\(r, h\) \{[\s\S]*?\n  \}/.exec(src)
  assert.ok(body, 'regionThumb is still there')
  const regionThumb = new Function('esc', 'fileUrl', body[0] + '\nreturn regionThumb')(x => x, x => 'file://' + x)
  const wide = regionThumb({ image: '/a.png', px: { w: 400, h: 100 } }, 18)
  assert.ok(wide.includes('width="47"') && wide.includes('height="18"'), wide)
  assert.ok(regionThumb({ image: '/a.png', px: { w: 100, h: 100 } }, 18).includes('width="18"'))
  assert.ok(regionThumb({ image: '/a.png' }, 16).includes('width="24"'), 'no size known: 3 by 2')
})

// A question can now offer rendered frames instead of descriptions, and the choice
// that has no frame has to come out of this byte for byte as it always did.
t('a choice draws its shot, and a choice without one draws what it always drew', () => {
  const src = fs.readFileSync(path.join(__dirname, '../ui/chat.js'), 'utf8')
  const body = /function pickHtml\(c\) \{[\s\S]*?\n  \}/.exec(src)
  assert.ok(body, 'pickHtml is still there')
  const pickHtml = new Function('esc', 'fileUrl', body[0] + '\nreturn pickHtml')(x => x, x => 'file://' + x)

  const plain = pickHtml({ id: 'wide', label: 'Wide', hint: 'Shows the dock' })
  assert.strictEqual(plain, '<button type="button" class="chat-pick" data-choice="wide">' +
    '<span class="chat-pick-lab">Wide</span><span class="chat-pick-hint">Shows the dock</span></button>')

  const shown = pickHtml({ id: 'tight', label: 'Tight', shot: '/tmp/fetch/a.png' })
  assert.ok(shown.includes('<span class="chat-pick-shot"><img alt="" src="file:///tmp/fetch/a.png">'), shown)
  assert.ok(shown.includes('class="chat-pick-txt"') && shown.includes('data-choice="tight"'), shown)
  // the image drops itself when the file is gone, exactly as the proposal's preview does
  assert.ok(/chat-pick-shot img[\s\S]{0,120}onerror/.test(src), 'a missing shot removes its own box')
  const css = fs.readFileSync(path.join(__dirname, '../ui/chat.css'), 'utf8')
  assert.ok(css.includes('.chat-pick-shot'), 'the shot has somewhere to sit')
})

t('every chip the composer draws is still drawn', () => {
  const src = fs.readFileSync(path.join(__dirname, '../ui/chat.js'), 'utf8')
  for (const k of ['class="chat-tag"', 'chat-region-chip', 'data-unregion', 'data-untag', 'chat-me-tags', 'chat-me-regions', 'data-unattach']) {
    assert.ok(src.includes(k), k)
  }
  const css = fs.readFileSync(path.join(__dirname, '../ui/chat.css'), 'utf8')
  assert.ok(css.includes('.chat-tag-branch') && css.includes('.chat-mention-branch'))
  assert.ok(!/—/.test(src + css), 'no em dash in the chat')
})

fs.rmSync(dir, { recursive: true, force: true })
console.log(`\n${n} chat checks passed`)
