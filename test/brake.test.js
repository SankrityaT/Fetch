// The menu bar and the brake. Loads main.js under a stub electron, runs whenReady,
// and proves every shortcut through its registered accelerator and its click path,
// and Esc through the function globalShortcut holds for it. No key is pressed, no
// socket is opened, nothing is written outside a temporary home.
const Module = require('module'), path = require('path'), os = require('os'), fs = require('fs')
const ROOT = path.join(__dirname, '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-brake-'))
process.env.HOME = tmp
const sent = [], globals = new Map(), ipcOn = new Map(), ipcHandle = new Map()
let appMenu = null, readyFns = []
const noop = () => {}
class Win { constructor() { this.webContents = { send: (...a) => sent.push(a), once: noop, on: noop, executeJavaScript: async () => {} } }
  isDestroyed() { return false } loadFile() {} on() {} once() {} show() {} hide() {} showInactive() {} focus() {} setAlwaysOnTop() {}
  setVisibleOnAllWorkspaces() {} setContentProtection() {} setIgnoreMouseEvents() {} setBounds() {} getBounds() { return { x: 0, y: 0, width: 1, height: 1 } } destroy() {} }
const electron = {
  app: { setPath: noop, getPath: () => tmp, whenReady: () => ({ then: fn => { readyFns.push(fn) } }), on: noop, quit: noop,
    isReady: () => true, isPackaged: true, getVersion: () => '0', dock: { hide: noop, show: noop }, requestSingleInstanceLock: () => true,
    setAboutPanelOptions: noop, commandLine: { appendSwitch: noop, hasSwitch: () => false } },
  BrowserWindow: Win, desktopCapturer: {}, session: { defaultSession: { setPermissionCheckHandler: noop, setDisplayMediaRequestHandler: noop, setPermissionRequestHandler: noop } },
  ipcMain: { on: (c, f) => ipcOn.set(c, f), handle: (c, f) => ipcHandle.set(c, f), removeHandler: noop },
  dialog: {}, screen: { getAllDisplays: () => [], getPrimaryDisplay: () => ({ bounds: {}, workArea: {} }), on: noop },
  shell: {}, systemPreferences: { getMediaAccessStatus: () => 'granted' },
  globalShortcut: { register: (k, f) => { globals.set(k, f); return true }, isRegistered: k => globals.has(k), unregister: k => globals.delete(k), unregisterAll: () => globals.clear() },
  Tray: class { setToolTip() {} setContextMenu() {} setImage() {} on() {} },
  Menu: { buildFromTemplate: t => ({ template: t }), setApplicationMenu: m => { appMenu = m } },
  nativeImage: { createFromPath: () => ({ isEmpty: () => false, setTemplateImage: noop }), createFromNamedImage: () => ({}) },
}
const load = Module._load
Module._load = function (req, parent, ...r) {
  if (req === 'electron') return electron
  if (req === 'electron-updater') return { autoUpdater: { on: noop, checkForUpdates: async () => {} } }
  return load.call(this, req, parent, ...r)
}
// the socket and every child process stay down: only the tables are under test
const bridge = require(path.join(ROOT, 'ui/agent-bridge'))
let deps = null
bridge.start = d => { deps = d }
const chat = require(path.join(ROOT, 'ui/agent-chat'))
let chatBusy = false, cancelled = 0
chat.busy = () => chatBusy; chat.cancel = () => { cancelled++; chatBusy = false }
const act = require(path.join(ROOT, 'ui/activity-log'))
const acts = []; act.record = e => { acts.push(e); return e }
const hooks = ['telemetry', 'updater', 'simctl', 'agent-connect']
for (const h of hooks) { try { const m = require(path.join(ROOT, 'ui', h)); for (const k of Object.keys(m)) if (typeof m[k] === 'function') m[k] = () => Promise.resolve({}) } catch {} }
require(path.join(ROOT, 'main.js'))
let readyErr = null
for (const f of readyFns) { try { f() } catch (e) { readyErr = e } }

let pass = 0, fail = 0
const is = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); ok ? pass++ : fail++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`) }
if (readyErr) console.log('whenReady threw after the menu (expected under a stub):', readyErr.message)
const items = (m => { const out = []; const walk = (t, top) => t.forEach(i => { out.push({ ...i, top }); if (Array.isArray(i.submenu)) walk(i.submenu, i.label || i.role) }); walk(m.template, null); return out })
const all = () => items(appMenu)
const byAcc = acc => all().filter(i => i.accelerator === acc)
const click = acc => { sent.length = 0; byAcc(acc)[0].click(); return sent.map(a => a.slice(0, 2)) }

is('an application menu is set', !!appMenu, true)
// no two items claim one key
const accs = all().filter(i => i.accelerator).map(i => i.accelerator)
is('no accelerator is claimed twice', accs.length, new Set(accs).size)
// the stock reload that ate an edit is gone in a packaged build
is('no reload role in a packaged build', all().some(i => i.role === 'reload' || i.role === 'forceReload'), false)
for (const [acc, want] of [['Command+1', 'view:record'], ['Command+2', 'view:library'], ['Command+3', 'view:editor'],
  ['Command+4', 'view:activity'], ['Command+F', 'search'], ['Command+Y', 'history'], ['Command+,', 'settings'], ['Command+O', 'import']]) {
  const it = byAcc(acc)[0]
  is(`${acc} is registered (${it && it.label})`, !!it && it.registerAccelerator !== false, true)
  is(`${acc} sends ${want}`, click(acc), [['shortcut', want]])
}
// keys another file already handles are shown, not registered twice
for (const acc of ['Command+J', 'Alt+Shift+Command+R', 'Alt+Shift+Command+P']) {
  const it = byAcc(acc)[0]
  is(`${acc} is shown with registerAccelerator off`, !!it && it.registerAccelerator === false, true)
}
is('Cmd+J click still opens the chat', click('Command+J'), [['shortcut', 'chat']])
is('the edit menu keeps its roles (Cmd+Z in the editor)', all().some(i => i.role === 'editMenu'), true)

// the brake
const brakeItem = () => byAcc('Command+.')[0]
is('Command+. is in the menu', !!brakeItem(), true)
is('and disabled with no agent at work', brakeItem().enabled, false)
is('Esc is not claimed while nothing drives', globals.has('Escape'), false)

// an agent call: every op is wrapped, and the wrap marks it driving
is('every bridge op is gated', Object.values(bridge.ops).every(f => f.braked === true), true)


const sleep = ms => new Promise(r => setTimeout(r, ms))
const lastBrake = () => (sent.filter(a => a[0] === 'agent-brake').pop() || [])[1] || {}
const continueItem = () => all().find(i => /Continue/.test(i.label || ''))

;(async () => {
  const ctx = { client: 'Claude Code' }
  try { await bridge.ops['recordings.list']({}, ctx) } catch {}
  is('an agent call makes it driving: Esc is claimed system wide', globals.has('Escape'), true)
  is('the menu names who and enables Stop', [brakeItem().label, brakeItem().enabled], ['Stop Claude Code', true])
  is('the window is told, for the pill', [lastBrake().driving, lastBrake().by, lastBrake().esc], [true, 'Claude Code', true])
  sent.length = 0
  globals.get('Escape')()
  is('Esc holds the agent', lastBrake().held && lastBrake().held.by, 'Claude Code')
  is('and gives Esc back to the Mac', globals.has('Escape'), false)
  is('the stop is in the activity log as the person', acts.filter(a => a.op === 'agent.stop').map(a => [a.title, a.by || null]), [['Stopped Claude Code', null]])
  let err = null
  try { await bridge.ops['recordings.list']({}, ctx) } catch (e) { err = e.message }
  is('the next call is refused with the sentence', /pressed Esc to stop you/.test(err || ''), true)
  let err2 = null
  try { await bridge.ops['sim.do']({ action: 'tap' }, ctx) } catch (e) { err2 = e.message }
  is('a tap is refused too', /pressed Esc to stop you/.test(err2 || ''), true)
  let pong = null
  try { pong = await bridge.ops['ping']({}, ctx) } catch (e) { pong = e.message }
  is('ping still answers while held', /pressed Esc/.test(String(pong)), false)
  is('the bridge is told it is held, for a late yes', deps && deps.held(), true)
  is('Command+. is off while held, Let continue is on', [brakeItem().enabled, continueItem().enabled], [false, true])

  // A message to the in-app chat is the person talking to the chat's agent, not letting
  // a stopped terminal agent go on
  chat.send = () => {}
  ipcOn.get('chat-send')({ sender: { send: noop } }, { display: { text: 'why did it stop?' } })
  is('a chat message does not release a terminal agent', continueItem().enabled, true)
  let err3 = null
  try { await bridge.ops['recordings.list']({}, ctx) } catch (e) { err3 = e.message }
  is('whose next call is still refused', /pressed Esc/.test(err3 || ''), true)
  // the menu item, clicked as Electron clicks it (with arguments), does release
  continueItem().click({}, null, {})
  let err4 = null
  try { await bridge.ops['recordings.list']({}, ctx) } catch (e) { err4 = e.message }
  is('after Let it continue, calls go through again', /pressed Esc/.test(err4 || ''), false)

  // Between calls an agent is thinking, not gone. Esc goes back to the app in front after
  // a few seconds, so a terminal's own Esc works, but the brake stays armed
  await sleep(3300)
  is('between calls Esc is not taken from the app in front', globals.has('Escape'), false)
  is('but the pill still shows, with Stop', [lastBrake().driving, lastBrake().esc], [true, false])
  is('and Agent > Stop is still on', brakeItem().enabled, true)
  ipcOn.get('agent-stop')({}, 'button')
  is('the pill stops an agent that is thinking', continueItem().enabled, true)
  let err5 = null
  try { await bridge.ops['recordings.list']({}, ctx) } catch (e) { err5 = e.message }
  is('and its next call is refused', /pressed Esc/.test(err5 || ''), true)
  ipcOn.get('agent-release')()
  // its socket closing is it done
  deps.clientGone(ctx)
  is('an agent whose socket closed leaves the brake unarmed', [lastBrake().driving, brakeItem().enabled], [false, false])

  // The in-app chat's own agent: a message to the chat lets it go on
  const chatCtx = { client: 'Claude Code' }
  await bridge.ops.hello({ client: 'Claude Code', chat: true }, chatCtx)
  chatBusy = true
  try { await bridge.ops['recordings.list']({}, chatCtx) } catch {}
  is('a chat turn claims Esc', globals.has('Escape'), true)
  byAcc('Command+.')[0].click()
  is('Command+. cancels the chat turn', cancelled, 1)
  is('and holds', continueItem().enabled, true)
  ipcOn.get('chat-send')({ sender: { send: noop } }, { display: { text: 'go on' } })
  is('a new message lets the chat\'s own agent go on', continueItem().enabled, false)
  chatBusy = false
  deps.clientGone(chatCtx)

  // A take whose start was on its way when Esc landed goes live after the stop
  const tctx = { client: 'Codex' }
  try { await bridge.ops['recordings.list']({}, tctx) } catch {}
  ipcOn.get('agent-stop')({}, 'Esc')
  deps.setQuiet(true, true)
  sent.length = 0
  ipcOn.get('rec-state')({}, 'recording')
  is('a take a stopped agent started is stopped the moment it goes live', sent.some(a => a[0] === 'hotkey' && a[1] === 'stop'), true)
  sent.length = 0
  ipcOn.get('rec-state')({}, 'paused')
  is('once, not again on a pause', sent.some(a => a[0] === 'hotkey' && a[1] === 'stop'), false)
  ipcOn.get('rec-state')({}, 'idle')
  ipcOn.get('agent-release')()
  deps.clientGone(tctx)
  is('with nothing at work, Esc is not claimed', globals.has('Escape'), false)

  // the renderer's fallback: Esc in Fetch's own window, for the whole armed stretch
  const appSrc = fs.readFileSync(path.join(ROOT, 'ui/app.js'), 'utf8')
  is('the window listens for Esc in the capture phase', /e\.key !== 'Escape'[\s\S]{0,120}brakeState\.driving[\s\S]{0,200}ipcRenderer\.send\('agent-stop', 'Esc'\)\n\}, true\)/.test(appSrc), true)
  is('and the pill says Esc is taken from the app in front', /Esc in any app stops it here/.test(appSrc), true)
  // the chat's shim names itself, so the brake can tell it from a terminal's
  const chatSrc = fs.readFileSync(path.join(ROOT, 'ui/agent-chat.js'), 'utf8')
  is('both chat engines start the shim with --chat', (chatSrc.match(/--chat/g) || []).length >= 2, true)
  is('and the shim says so in hello', /IN_CHAT \? \{ chat: true \}/.test(fs.readFileSync(path.join(ROOT, 'mcp/bridge.js'), 'utf8')), true)
  const bsrc = fs.readFileSync(path.join(ROOT, 'ui/agent-bridge.js'), 'utf8')
  is('record.start checks the brake before it starts a take', /if \(deps\.held && deps\.held\(\)\) \{[\s\S]{0,200}\n\s*deps\.toRenderer\('start'\)/.test(bsrc), true)
  fs.rmSync(tmp, { recursive: true, force: true })
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
})()
