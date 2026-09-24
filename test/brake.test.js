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
is('no chord is claimed while nothing drives', globals.has('Shift+Command+Escape'), false)
is('and plain Esc is never claimed system wide', globals.has('Escape'), false)

// an agent call: every op is wrapped, and the wrap marks it driving
is('every bridge op is gated', Object.values(bridge.ops).every(f => f.braked === true), true)


const sleep = ms => new Promise(r => setTimeout(r, ms))
const lastBrake = () => (sent.filter(a => a[0] === 'agent-brake').pop() || [])[1] || {}
const continueItem = () => all().find(i => /Continue/.test(i.label || ''))

;(async () => {
  const ctx = { client: 'Claude Code' }
  try { await bridge.ops['recordings.list']({}, ctx) } catch {}
  is('an agent call makes it driving: the chord is claimed system wide', globals.has('Shift+Command+Escape'), true)
  is('and plain Esc is left to the app in front, a terminal included', globals.has('Escape'), false)
  is('the menu names who and enables Stop', [brakeItem().label, brakeItem().enabled], ['Stop Claude Code', true])
  is('the window is told, for the pill', [lastBrake().driving, lastBrake().by, lastBrake().esc], [true, 'Claude Code', true])
  sent.length = 0
  globals.get('Shift+Command+Escape')()
  is('Esc holds the agent', lastBrake().held && lastBrake().held.by, 'Claude Code')
  is('and gives the chord back to the Mac', globals.has('Shift+Command+Escape'), false)
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
  is('between calls the chord is not claimed', globals.has('Shift+Command+Escape'), false)
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
  is('a chat turn claims the chord', globals.has('Shift+Command+Escape'), true)
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
  is('with nothing at work, the chord is not claimed', globals.has('Shift+Command+Escape'), false)

  // An agent's jobs through main.js as it submits them: one id for the queue and the
  // processor, the person's Cancel reaching them, and Esc stopping them.
  {
    const Q = require(path.join(ROOT, 'ui/job-queue'))
    const P = require(path.join(ROOT, 'processor'))
    const RH = require(path.join(ROOT, 'ui/render-host'))
    const pending = new Map(), cancels = [], ids = []
    const stoppable = id => new Promise((_res, rej) => pending.set(id, () => rej(Object.assign(new Error('cancelled'), { cancelled: true }))))
    const realCancel = P.cancel, realSilence = P.removeSilence, realExport = RH.exportEdit
    P.cancel = id => { cancels.push(id); const f = pending.get(id); if (f) { pending.delete(id); f() } return !!f }
    P.removeSilence = (src, o, _p, id) => { ids.push(id); return stoppable(id) }
    RH.exportEdit = (src, o, _p, id) => { ids.push(id); Q.onCancel(() => P.cancel(id)); return stoppable(id) }
    const until = async fn => { for (let i = 0; i < 100 && !fn(); i++) await sleep(10) }
    // bounded, so a stop that never comes fails here rather than leaving node to exit quietly
    const settled = p => Promise.race([p.then(() => 'done', e => (e && e.cancelled ? 'cancelled' : 'failed: ' + (e && e.message))),
      sleep(2000).then(() => 'still running after 2 s')])
    try {
      const ex = settled(deps.exportDoc('/tmp/none.mov', {}, 'agent:export:k9'))
      await until(() => Q.jobs().running.includes('agent:export:k9'))
      is('an agent export runs under the bridge\'s own key, in the queue and the processor alike', [Q.jobs().running, ids], [['agent:export:k9'], ['agent:export:k9']])
      is('the person\'s Cancel reaches an agent\'s running export', await ipcHandle.get('cancel-job')({}, 'agent:export:k9'), true)
      is('  and it stops', await ex, 'cancelled')
      await until(() => !Q.jobs().stopping.length)
      ids.length = 0
      const op = settled(deps.runOp('silence', '/tmp/none.mov', {}))
      await until(() => ids.length === 1)
      is('dead air runs under one counted id for the queue and the processor', /^agent:silence:\d+$/.test(ids[0]) && Q.jobs().running.includes(ids[0]), true)
      const ex2 = settled(deps.exportDoc('/tmp/none.mov', {}))
      is('an export with no key is counted, never stamped with the clock', /^agent:export:\d{1,6}$/.test(Q.jobs().queued[0] || ''), true)
      try { await bridge.ops['recordings.list']({}, { client: 'Claude Code' }) } catch {}
      globals.get('Shift+Command+Escape')()
      is('Esc stops an agent\'s dead air mid run, through its own stop', [await op, cancels.includes(ids[0])], ['cancelled', true])
      is('  and its queued export', await ex2, 'cancelled')
      ipcOn.get('agent-release')()
    } finally { P.cancel = realCancel; P.removeSilence = realSilence; RH.exportEdit = realExport }

    // A cancelled job keeps its lane until the work behind the "cancelled" answer settles
    let stop, started = false
    const work = new Promise(r => { stop = r })
    const a = Q.submit({ id: 'lane:a', op: 'export', run: () => { Q.working(work); return Promise.race([work, new Promise((_r, j) => Q.onCancel(() => j(Object.assign(new Error('cancelled'), { cancelled: true }))))]) } })
    a.catch(() => {})
    const b = Q.submit({ id: 'lane:b', op: 'export', onStart: () => { started = true }, run: async () => 'b' })
    await sleep(5)
    Q.cancel('lane:a')
    is('a cancelled job answers at once', await settled(a), 'cancelled')
    await sleep(20)
    is('  but the next job does not start beside its work', [started, Q.jobs().stopping], [false, ['lane:a']])
    stop()
    is('  and starts the moment that work stops', await settled(b), 'done')
  }

  // The sample, as main.js holds it: the Library lists it and nothing else while it is open
  {
    const Sample = require(path.join(ROOT, 'ui/sample'))
    const P = require(path.join(ROOT, 'processor'))
    const realList = P.listRecordings
    P.listRecordings = (dir) => dir ? realList(dir, []) : [{ path: path.join(tmp, 'Theirs.mov') }]
    const sroot = path.join(tmp, 'Sample Here')
    const s = Sample.open({ root: sroot, theirs: [path.join(tmp, 'Movies', 'Fetch')] })
    try {
      is('with no sample open the Library lists the person\'s own takes', (await ipcHandle.get('list-recordings')()).map(e => path.basename(e.path)), ['Theirs.mov'])
      await ipcHandle.get('sample-root')({}, s.root)
      const listed = await ipcHandle.get('list-recordings')()
      is('while it is open, the sample and nothing else', [listed.length > 0, listed.every(e => e.sample && e.path.startsWith(s.root))], [true, true])
      await ipcHandle.get('sample-root')({}, null)
      is('after it closes, the person\'s own again', (await ipcHandle.get('list-recordings')()).map(e => path.basename(e.path)), ['Theirs.mov'])
    } finally { P.listRecordings = realList; Sample.close(s.root, []) }
  }

  // The Guidelines card: the person writing rules and saying yes to an agent's draft
  {
    const G = require(path.join(ROOT, 'ui/guidelines'))
    const g = (a) => ipcHandle.get('guidelines')({}, a)
    const w = await g({ action: 'write', product: 'Yolk', section: 'never', rule: 'Never show the admin panel' })
    is('a rule the person writes in Settings is in force at once', w.written[0].draft, false)
    const d = G.write({ root: tmp, product: 'Yolk' }, { rule: 'Screenshots sit on cream', section: 'look', from: 'screen' }).written[0]
    is('an agent\'s draft waits in the card', (await g({ action: 'read', product: 'Yolk' })).drafts.map(x => x.id), [d.id])
    const yes = await g({ action: 'yes', product: 'Yolk', id: d.id })
    is('the person\'s Yes puts it in force', [yes.ok, (await g({ action: 'read', product: 'Yolk' })).rules.look.map(r => r.id)], [true, [d.id]])
    const d2 = G.write({ root: tmp, product: 'Yolk' }, { rule: 'Say planner, never app', section: 'words', from: 'help' }).written[0]
    await g({ action: 'no', product: 'Yolk', id: d2.id })
    is('and their No drops a draft', (await g({ action: 'read', product: 'Yolk' })).drafts.length, 0)
    await g({ action: 'forget', product: 'Yolk', id: w.written[0].id })
    is('a rule in force can be removed', (await g({ action: 'read', product: 'Yolk' })).rules.never.length, 0)
    is('the products with rules are listed', (await g({ action: 'products' })).products, ['Yolk'])
  }

  // System Audio Recording is read without asking, and asked for from one place only
  const access = await ipcHandle.get('audio-access')()
  is('the permission one app\'s sound needs is read, never asked, for Settings', ['granted', 'denied', 'unknown', 'unavailable'].includes(access.state), true)
  const setSrc = fs.readFileSync(path.join(ROOT, 'ui/settings.js'), 'utf8')
  const asks = [...(fs.readFileSync(path.join(ROOT, 'ui/app.js'), 'utf8') + setSrc).matchAll(/'audio-access-request'/g)].length
  is('only the person turning the Settings switch on asks for it', [asks, /if \(!want \|\| state === 'denied'\)[\s\S]{0,300}audio-access-request/.test(setSrc)], [1, true])

  // the renderer's fallback: Esc in Fetch's own window, for the whole armed stretch
  const appSrc = fs.readFileSync(path.join(ROOT, 'ui/app.js'), 'utf8')
  is('the window listens for Esc in the capture phase', /e\.key !== 'Escape'[\s\S]{0,120}brakeState\.driving[\s\S]{0,200}ipcRenderer\.send\('agent-stop', 'Esc'\)\n\}, true\)/.test(appSrc), true)
  is('and the pill names both: Esc here, the chord anywhere', /Esc here, or Shift-Cmd-Esc from any app/.test(appSrc), true)
  is('and the pill never claims plain Esc works from any app', /Esc in any app/.test(appSrc), false)
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
