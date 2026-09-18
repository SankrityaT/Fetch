// The chat pane's memory. Main-process module, modelled on ui/activity-log.js.
//
// The conversation used to live only in the renderer's DOM and the agent's session
// id only in a variable, so quitting Fetch forgot both: the pane came back empty and
// the next message reached a CLI that had never heard of the last one. Two files fix
// that:
//
//   chat.jsonl          every user turn (what was typed, tagged and attached) and
//                       every normalised event, in order, so the pane can replay it
//   chat-session.json   { claude, codex } session ids, so --resume survives a restart
//
// Append-only JSONL for the same reason as the activity log: a crash mid-write costs
// one line, not the thread.

const fs = require('fs')
const path = require('path')

let app
try { ({ app } = require('electron')) } catch {}

const MAX_LINES = 3000          // hundreds of turns, trimmed on write
let trimCounter = 0

// FETCH_CHAT_DIR is for the tests, which run outside Electron.
function dir() {
  const d = process.env.FETCH_CHAT_DIR || (app ? app.getPath('userData') : require('os').tmpdir())
  try { fs.mkdirSync(d, { recursive: true }) } catch {}
  return d
}
const logPath = () => path.join(dir(), 'chat.jsonl')
const sessionPath = () => path.join(dir(), 'chat-session.json')

// A tool result is kept whole for its card, but a few carry lists nobody reads back
// (apply_edit returns every installed font). Anything that large is dropped from the
// saved copy only; the live event keeps it. A long list of edit objects (forty clips
// after a dead-air pass) keeps its ids, so the card still counts them after a restart.
const BIG = 4000
function slim(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data
  const out = {}
  for (const [k, v] of Object.entries(data)) {
    let n = 0
    try { n = JSON.stringify(v).length } catch {}
    if (n <= BIG) out[k] = v
    else if (Array.isArray(v) && v.every(x => x && typeof x === 'object' && x.id)) out[k] = v.map(x => ({ id: x.id }))
  }
  return out
}

function append(entry) {
  const e = { at: Date.now(), ...entry }
  if (e.data) e.data = slim(e.data)
  try {
    fs.appendFileSync(logPath(), JSON.stringify(e) + '\n')
    if (++trimCounter % 200 === 0) trim()
  } catch (err) {
    console.error('chat not saved:', err.message)
  }
  return e
}

// Oldest first, because it is replayed top to bottom. Starts on a user turn so the
// pane never opens on half an answer whose question was trimmed away.
function read(limit = 600) {
  let text = ''
  try { text = fs.readFileSync(logPath(), 'utf8') } catch { return [] }
  const out = []
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const l = lines[i].trim()
    if (!l) continue
    try { out.push(JSON.parse(l)) } catch {}   // a torn line is skipped, not fatal
  }
  out.reverse()
  const first = out.findIndex(e => e.kind === 'user')
  // one turn longer than the whole window still shows, rather than an empty pane
  return first < 0 ? out : out.slice(first)
}

function trim() {
  try {
    const lines = fs.readFileSync(logPath(), 'utf8').split('\n').filter(Boolean)
    if (lines.length <= MAX_LINES) return
    fs.writeFileSync(logPath(), lines.slice(-MAX_LINES).join('\n') + '\n')
  } catch {}
}

function loadSessions() {
  try {
    const j = JSON.parse(fs.readFileSync(sessionPath(), 'utf8'))
    return { claude: j.claude || null, codex: j.codex || null }
  } catch { return { claude: null, codex: null } }
}

function saveSessions(s) {
  try { fs.writeFileSync(sessionPath(), JSON.stringify({ claude: s.claude || null, codex: s.codex || null })) } catch {}
}

// A new chat starts clean on both sides. The previous thread is kept as one backup
// rather than deleted, since "New chat" is one click and easy to hit by mistake.
function rotate() {
  try { fs.renameSync(logPath(), path.join(dir(), 'chat.prev.jsonl')) } catch {}
  try { fs.unlinkSync(sessionPath()) } catch {}
}

module.exports = { append, read, trim, rotate, loadSessions, saveSessions, logPath, sessionPath, dir, MAX_LINES }
