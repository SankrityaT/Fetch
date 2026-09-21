// From a project to the window worth recording.
//
// "@majuro record a demo of the lasso" names a folder, and Fetch records windows. This
// is the step between: what is running from that folder, which window it owns, and
// whether that window is the thing the person meant. Three kinds of answer:
//
//   app        a process started from the project (its executable is inside the folder,
//              or it was built there by Xcode, or it runs with the folder as its working
//              directory) and a window it owns. "electron ." is this: the executable is
//              node_modules/electron inside the project and the working directory is the
//              project itself.
//   simulator  the project builds an app for a device, that app is running on a
//              simulator, and the simulator's window is on screen.
//   browser    a process in the project listens on a local port, and a browser window's
//              title is that server's page title.
//
// Recording the wrong window is worse than recording nothing, so this refuses to pick
// more often than it guesses: a pick needs evidence tying a process to the folder, not a
// window title that happens to contain the project's name (a terminal or an editor open
// on the project says its name all day and is never the demo). When two things are
// equally likely, nothing is picked and both are named.
//
// rank() is pure. make() gathers what rank() needs from the Mac with its system calls
// injected, so the whole of it runs under node in the tests. What it reads, and what
// each read costs, measured on this Mac with about 1,400 processes:
//
//   ps -axo pid=,ppid=,comm=     the process table: pid, parent and executable path.
//                                Never the arguments, which is where a token passed on a
//                                command line would be. About 0.1 s.
//   lsof -a -d cwd -p <pids>     working directories, for only the processes that own a
//                                window, their parents, and the ones listening on a port.
//                                lsof asks the kernel (proc_pidinfo, the vnode path of
//                                the process's cwd); it answers for the person's own
//                                processes and not for root's, which is all this needs.
//                                About 0.06 s for a few dozen pids, 0.6 s for all of them.
//   lsof -nP -iTCP -sTCP:LISTEN  who listens on which local port. About 0.3 s.
//   CoreGraphics window list     every on-screen window with its owner's pid, read with
//                                CGWindowListCopyWindowInfo through osascript: no
//                                ScreenCaptureKit, so the capture service is never asked
//                                for anything. About 0.4 s, most of it osascript starting.
//                                Titles need Screen Recording, which Fetch already has.
//   DerivedData info.plist       which Xcode build folder belongs to which project, read
//                                only when the project has an Xcode project or a
//                                Package.swift at its top.
//   GET http://127.0.0.1:<port>/ the page title of a dev server in the project, read only
//                                from a process with no window of its own whose
//                                executable is a known web runtime, over loopback, 1.5 s
//                                at most. Nothing leaves the Mac.
//
// Nothing here starts, stops, focuses or captures anything.

const path = require('path')

// ---------- small pure pieces ----------

// Inside a folder, on a path-segment boundary: /a/foo is not inside /a/fo.
function within(p, root) {
  if (!p || !root) return false
  const a = String(p), r = String(root).replace(/\/+$/, '')
  return a === r || a.startsWith(r + '/')
}

// A project root broad enough to contain everything is not a project. Home, or anything
// above it, would match every terminal and editor on the Mac.
function tooBroad(root, home) {
  const r = String(root || '').replace(/\/+$/, '')
  if (!r || r === '/') return true
  if (home && within(String(home).replace(/\/+$/, ''), r)) return true
  return r.split('/').filter(Boolean).length < 2
}

// Where an installed app lives. A process from one of these bundles with the project as
// its working directory is an app opened from a terminal in that folder (an editor, a
// second terminal), not the project's own build. Only app bundles: node from Homebrew
// running a dev server in the project is exactly the project's own process.
const INSTALLED = /^(\/Applications|\/System|\/Users\/[^/]+\/Applications|\/opt\/homebrew\/Caskroom|\/usr\/local\/Caskroom)\/.*\.app\//
const installed = exe => !!exe && INSTALLED.test(exe)

// Executables that serve a web page from a project folder.
const WEB_RUNTIMES = new Set(['node', 'bun', 'deno', 'python', 'python3', 'ruby', 'php',
  'hugo', 'caddy', 'uvicorn', 'gunicorn', 'rails', 'puma', 'air'])

const BROWSERS = new Set(['Google Chrome', 'Google Chrome Canary', 'Chromium', 'Safari',
  'Safari Technology Preview', 'Firefox', 'Firefox Developer Edition', 'Arc', 'Brave Browser',
  'Microsoft Edge', 'Vivaldi', 'Opera', 'Orion', 'Zen', 'Dia'])

// Page titles a starter template ships with. Two projects on one Mac can both be "Vite
// App", so a window with this title is a guess about which one it is showing.
const GENERIC_TITLES = new Set(['', 'vite app', 'react app', 'vite + react', 'vite + react + ts',
  'vite + vue', 'vite + svelte', 'create next app', 'next.js', 'document', 'home', 'localhost',
  'svelte app', 'astro', 'welcome', 'index', 'untitled'])

// Background helper windows, by the rule WindowList.swift drops them with: no title and
// an exact square up to 512, or no title and a strip. Real content almost never is.
function helper(w) {
  if (String(w.title || '')) return false
  const a = +w.width || 0, b = +w.height || 0
  if (a === b && a <= 512) return true
  return Math.max(a, b) / Math.max(1, Math.min(a, b)) > 5
}

// Windows that are the app's tools, not the app.
const TOOL_TITLES = /^(devtools|developer tools)\b|^devtools -|web inspector/i

// ps -axo pid=,ppid=,comm=  ->  Map pid -> { pid, ppid, exe }
function parsePs(text) {
  const out = new Map()
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/)
    if (m) out.set(+m[1], { pid: +m[1], ppid: +m[2], exe: m[3] })
  }
  return out
}

// lsof -F output as records: every 'p' line opens one, the lines after it fill it.
function lsofRecords(text) {
  const out = []
  let cur = null
  for (const line of String(text || '').split('\n')) {
    if (!line) continue
    const k = line[0], v = line.slice(1)
    if (k === 'p') { cur = { pid: +v, files: [] }; out.push(cur) }
    else if (!cur) continue
    else if (k === 'c') cur.command = v
    else if (k === 'f') cur.files.push({ fd: v })
    else if (k === 'n') { if (!cur.files.length) cur.files.push({}); cur.files[cur.files.length - 1].name = v }
  }
  return out
}

// lsof -a -d cwd -p ... -Fpn  ->  { pid: cwd }
function parseCwds(text) {
  const out = {}
  for (const r of lsofRecords(text)) {
    const f = r.files.find(x => x.name)
    if (f) out[r.pid] = f.name
  }
  return out
}

// lsof -nP -iTCP -sTCP:LISTEN -Fpcn  ->  [{ pid, command, host, port }], one per port
function parseListen(text) {
  const out = [], seen = new Set()
  for (const r of lsofRecords(text)) {
    for (const f of r.files) {
      const m = String(f.name || '').match(/^(.*):(\d+)$/)
      if (!m) continue
      const key = `${r.pid}:${m[2]}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ pid: r.pid, command: r.command || '', host: m[1], port: +m[2] })
    }
  }
  return out
}

// A process's executable as an absolute path. ps prints what the process was started
// as, so "electron ." run through npm shows node_modules/electron/... relative to the
// folder it was started in, which is its working directory unless it moved.
function exeOf(proc, cwd) {
  const e = proc && proc.exe
  if (!e) return null
  if (e.startsWith('/')) return e
  return cwd ? path.join(cwd, e) : null
}

// An app running on a simulator: its executable sits in that device's data folder.
// .../CoreSimulator/Devices/<UDID>/data/Containers/Bundle/Application/<id>/<Name>.app/<Name>
const SIM_APP = /\/CoreSimulator\/Devices\/([0-9A-F-]{36})\/data\/Containers\/Bundle\/Application\/[^/]+\/([^/]+)\.app\//i
function simAppOf(exe) {
  const m = String(exe || '').match(SIM_APP)
  return m ? { udid: m[1].toUpperCase(), app: m[2] } : null
}

// A DerivedData info.plist (XML) to the workspace it was built from.
function workspaceOf(plistXml) {
  const m = String(plistXml || '').match(/<key>WorkspacePath<\/key>\s*<string>([^<]+)<\/string>/)
  return m ? m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>') : null
}

// The first <title> of a page, trimmed, or null.
function titleOf(html) {
  const m = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  if (!m) return null
  const t = m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim()
  return t || null
}

// A browser window is showing a page when its title is the page's title, or the page's
// title followed by the browser's own suffix ("Lasso - Google Chrome").
function showsPage(windowTitle, pageTitle) {
  const w = String(windowTitle || '').trim(), p = String(pageTitle || '').trim()
  if (!w || !p) return false
  if (w === p) return true
  return w.startsWith(p) && /^\s+[-\u2013\u2014|]\s+\S/.test(w.slice(p.length))
}

// What would start the project, from which files it has at its top (their names only;
// no file here is opened). Fetch never runs it.
function startHint(files, o = {}) {
  const has = n => (files || []).includes(n)
  const hasExt = ext => (files || []).some(f => f.endsWith(ext))
  const ways = []
  if (o.buildsForDevice) ways.push('build and run it on a simulator from Xcode (simulator with action ready boots one)')
  else if (hasExt('.xcodeproj') || hasExt('.xcworkspace')) ways.push('build and run it from Xcode')
  if (has('package.json')) ways.push('its own start script (npm start, or npm run dev for a dev server)')
  if (has('Package.swift') && !o.buildsForDevice) ways.push('swift run')
  if (has('Cargo.toml')) ways.push('cargo run')
  if (has('go.mod')) ways.push('go run .')
  if (has('manage.py')) ways.push('python manage.py runserver')
  if (!ways.length) return 'Start it the way it is usually started, then ask again.'
  return `Start it with ${ways.join(', or ')}, then ask again.`
}

// ---------- the ranking ----------

// Scores. The gaps are wide on purpose: a tie means two things are equally likely, and
// a tie is refused, so near-ties between different kinds of evidence must not happen.
const SCORE = {
  exe: 100,         // the executable is inside the project, or Xcode built it from there
  simulator: 95,    // the project's own app on a simulator whose window is on screen
  cwd: 90,          // started in the project folder, from an executable that is not an installed app
  parent: 80,       // started by a process running in the project (npm run dev, then its app)
  browser: 70,      // a browser window titled like a page this project serves
  installed: 20,    // an installed app started from the project folder: an editor, a terminal
  server: 10,       // serving, but no window shows it
}

/**
 * Rank what is running from a project. Every input is plain data, so the tests hand in
 * what this Mac printed and nothing is spawned here.
 *
 * inp.project    { name, path }  path already resolved (realpath)
 * inp.windows    [{ id, pid, app, title, width, height }]  on-screen windows
 * inp.procs      Map or array of { pid, ppid, exe }  (parsePs)
 * inp.cwds       { pid: cwd }  (parseCwds)
 * inp.listeners  [{ pid, host, port }]  (parseListen)
 * inp.pages      { port: title }  page titles already read
 * inp.built      [{ workspace, root, products: [{ name, platform }] }]  DerivedData folders
 *                whose workspace is anywhere on the Mac, so a clash of app names is seen
 * inp.sims       simulator.simulators() records ({ udid, name, booted, window })
 * inp.files      names at the project's top, for the hint when nothing runs
 * inp.selfPid    the Fetch doing the recording
 * inp.home       the person's home folder
 */
function rank(inp = {}) {
  const project = inp.project || {}
  const root = String(project.path || '').replace(/\/+$/, '')
  const name = project.name || path.basename(root) || 'this project'
  const base = { project: { name, path: root } }
  if (tooBroad(root, inp.home)) {
    return { ok: false, ...base, pick: null, candidates: [],
      why: `${root || 'That path'} holds far more than one project, so anything running under it would match. Tag the project's own folder.` }
  }

  const procs = inp.procs instanceof Map ? inp.procs
    : new Map((inp.procs || []).map(p => [+p.pid, p]))
  const cwds = inp.cwds || {}
  const windows = (inp.windows || []).filter(w => w && w.id != null && !helper(w))
  const selfPid = inp.selfPid != null ? +inp.selfPid : null

  // Build folders that belong to this project, and every app name built anywhere, so two
  // checkouts of one repo building the same app are told apart or refused.
  const mine = [], builtBy = new Map()
  for (const b of inp.built || []) {
    const ours = within(b.workspace, root)
    if (ours && b.root) mine.push(b.root)
    for (const p of b.products || []) {
      if (!builtBy.has(p.name)) builtBy.set(p.name, { ours: false, others: new Set(), device: false })
      const e = builtBy.get(p.name)
      if (ours) { e.ours = true; if (/simulator|iphone|appletv|watch|xr/i.test(p.platform || '')) e.device = true }
      else e.others.add(b.workspace)
    }
  }
  const buildsForDevice = [...builtBy.values()].some(e => e.ours && e.device)

  // What ties one process to the project, strongest first, or null.
  const tie = (pid, seen = new Set()) => {
    const p = procs.get(+pid)
    if (!p || seen.has(+pid) || +pid <= 1) return null
    seen.add(+pid)
    const cwd = cwds[pid] || null
    const exe = exeOf(p, cwd)
    const short = exe ? path.basename(exe) : `pid ${pid}`
    if (exe && within(exe, root)) {
      return { score: SCORE.exe, why: `${short} runs from inside ${name} (${path.relative(root, exe)})` }
    }
    const built = exe && mine.find(r => within(exe, r))
    if (built) return { score: SCORE.exe, why: `${short} is the app Xcode built from ${name}` }
    if (cwd && within(cwd, root)) {
      if (installed(exe)) {
        return { score: SCORE.installed, why: `${short} is an installed app opened from the ${name} folder, most likely an editor or a terminal, not ${name}'s own app` }
      }
      return { score: SCORE.cwd, why: `${short} runs with ${name} as its working directory${cwd !== root ? ` (${path.relative(root, cwd)})` : ''}` }
    }
    if (installed(exe)) return null
    const up = tie(p.ppid, seen)
    if (up && up.score >= SCORE.cwd) {
      const parent = procs.get(+p.ppid)
      return { score: SCORE.parent, why: `${short} was started by ${parent ? path.basename(exeOf(parent, cwds[p.ppid]) || parent.exe) : 'a process'} (pid ${p.ppid}), which ${up.why.replace(/^\S+ /, '')}` }
    }
    return null
  }

  const view = w => ({ id: w.id, app: w.app || '', title: w.title || '', width: w.width || 0, height: w.height || 0,
    ...(w.onScreen === false ? { onScreen: false } : {}) })
  const cands = []

  // 1. Windows owned by a process tied to the project.
  const tieOf = new Map()
  for (const w of windows) {
    if (w.pid == null) continue
    if (!tieOf.has(w.pid)) tieOf.set(w.pid, tie(w.pid))
    const t = tieOf.get(w.pid)
    if (!t) continue
    const tool = TOOL_TITLES.test(w.title || '')
    const c = { kind: 'app', pid: +w.pid, window: view(w), score: t.score - (tool ? 30 : 0),
      evidence: [t.why], recordable: true }
    if (tool) c.evidence.push(`its title, ${w.title}, is the app's developer tools rather than the app`)
    if (selfPid != null && +w.pid === selfPid) {
      c.recordable = false
      c.self = true
      c.note = 'this is the Fetch doing the recording. It hides its own window while a take runs, so it cannot record itself. Record it from a second copy of Fetch (the installed one).'
    }
    if (t.score <= SCORE.installed) c.recordable = false
    cands.push(c)
  }

  // 2. The project's own app on a simulator.
  const simsByUdid = new Map((inp.sims || []).map(s => [String(s.udid).toUpperCase(), s]))
  const seenSim = new Set()
  for (const p of procs.values()) {
    const hit = simAppOf(p.exe)
    if (!hit) continue
    const e = builtBy.get(hit.app)
    if (!e || !e.ours) continue
    const key = `${hit.udid}:${hit.app}`
    if (seenSim.has(key)) continue
    seenSim.add(key)
    const sim = simsByUdid.get(hit.udid)
    const device = sim ? sim.name : hit.udid
    const c = { kind: 'simulator', pid: p.pid, window: sim && sim.window ? view({ ...sim.window, app: 'Simulator', width: sim.window.w, height: sim.window.h }) : null,
      device: { udid: hit.udid, name: device }, score: SCORE.simulator,
      evidence: [`${hit.app}.app is running on ${device}, and Xcode builds ${hit.app}.app from ${name}`], recordable: !!(sim && sim.window) }
    if (e.others.size) {
      c.score -= 40
      c.evidence.push(`another checkout (${[...e.others].map(x => path.dirname(x)).join(', ')}) builds an app of the same name, so this could be its build`)
    }
    if (!sim) c.note = `Fetch could not see ${device}'s window. simulator with action list says which devices are on screen.`
    else if (!sim.window) c.note = `${device} has no window on screen. simulator with action ready and device ${sim.name} opens it.`
    cands.push(c)
  }

  // 3. Servers in the project, and a browser window showing one.
  const windowPids = new Set(windows.map(w => w.pid).filter(p => p != null).map(Number))
  const pages = inp.pages || {}
  const served = new Map()
  for (const l of inp.listeners || []) {
    if (windowPids.has(+l.pid) || served.has(l.port)) continue
    const t = tie(l.pid)
    if (!t || t.score < SCORE.cwd) continue
    served.set(l.port, { ...l, why: t.why })
  }
  const browserWins = windows.filter(w => BROWSERS.has(w.app))
  const shown = new Set()
  for (const [port, s] of served) {
    const title = pages[port]
    if (!title) continue
    const hits = browserWins.filter(w => showsPage(w.title, title))
    for (const w of hits) {
      if (cands.some(c => c.window && c.window.id === w.id)) continue
      shown.add(port)
      const generic = GENERIC_TITLES.has(title.toLowerCase())
      const c = { kind: 'browser', pid: w.pid != null ? +w.pid : null, window: view(w), url: `http://localhost:${port}/`,
        score: SCORE.browser - (generic ? 40 : 0) - (hits.length > 1 ? 10 : 0),
        evidence: [s.why.replace(/ runs /, ` serves localhost:${port} and runs `), `this ${w.app} window's title is that page's title, ${title}`],
        recordable: true }
      if (generic) c.evidence.push(`${title} is the title a starter template ships with, so another project's page could have it too`)
      if (hits.length > 1) c.evidence.push(`${hits.length} browser windows have that title`)
      cands.push(c)
    }
  }
  for (const [port, s] of served) {
    if (shown.has(port)) continue
    cands.push({ kind: 'server', pid: +s.pid, window: null, url: `http://localhost:${port}/`, score: SCORE.server,
      evidence: [s.why.replace(/ runs /, ` serves localhost:${port} and runs `)], recordable: false,
      note: `no browser window is showing it. Open http://localhost:${port}/ and ask again.` })
  }

  // Strongest first; then one that is showing over one that is not, since a take of a
  // window off screen gets no frames and Fetch brings nothing forward; then among one
  // process's windows the largest, since that is its main one.
  const area = c => c.window ? c.window.width * c.window.height : 0
  const showing = c => (c.window && c.window.onScreen !== false ? 1 : 0)
  cands.sort((a, b) => b.score - a.score || (b.recordable - a.recordable) || showing(b) - showing(a) || area(b) - area(a))
  cands.forEach((c, i) => { c.rank = i + 1 })

  const strong = cands.filter(c => c.recordable && c.score >= SCORE.browser)
  const rest = cands.map(c => { const { score, ...out } = c; return out })
  const say = c => `${c.window ? `window ${c.window.id} (${c.window.app}${c.window.title ? `, ${c.window.title}` : ''})` : c.url || c.kind}`

  if (!strong.length) {
    const self = cands.find(c => c.self)
    const server = cands.find(c => c.kind === 'server')
    const sim = cands.find(c => c.kind === 'simulator')
    const weak = cands.find(c => c.recordable)
    let why
    if (self) why = `${name} is running, but its window is this Fetch's own: ${self.note}`
    else if (sim) why = `${name}'s app is running on ${sim.device.name}, but ${sim.note}`
    else if (server) why = `${name} is running a server at ${server.url}, but ${server.note}`
    else if (weak) why = `Something in ${name} may be showing, ${say(weak)}, but the only link to ${name} is weak: ${weak.evidence.slice(-1)[0]}. Name the window to record it.`
    else why = `Nothing from ${name} is running, so there is nothing of it to record. ${startHint(inp.files, { buildsForDevice })}`
    return { ok: true, ...base, pick: null, why, candidates: rest }
  }

  const first = strong[0], second = strong[1]
  const firstOut = rest[cands.indexOf(first)]
  if (second && second.score === first.score) {
    // Two processes as likely as each other: ask. Two windows of one app: ask only when
    // a sibling that is as visible as the first is nearly as large, so a big window on
    // another Space never blocks the one that is showing.
    const tied = strong.filter(c => c !== first && c.score === first.score)
    const sameApp = first.kind === 'app' && tied.every(c => c.pid === first.pid)
    const close = tied.some(c => showing(c) === showing(first) && area(c) >= area(first) * 0.8)
    if (!sameApp || close) {
      return { ok: true, ...base, pick: null, candidates: rest,
        why: `${strong.filter(c => c.score === first.score).length} windows are equally likely to be ${name}: ` +
          `${strong.filter(c => c.score === first.score).map(say).join('; ')}. Say which one, by its id.` }
    }
  }
  let why = `${say(first)} is first because ${first.evidence[0]}`
  if (second) {
    const siblings = strong.filter(c => c.pid === first.pid)
    why += second.pid === first.pid && first.kind === 'app'
      ? (showing(first) && siblings.some(c => !showing(c) && area(c) > area(first))
        ? `; it is the largest of that app's windows on screen, of ${siblings.length}.`
        : `; it is the largest of that app's ${siblings.length} windows.`)
      : `; next is ${say(second)}, because ${second.evidence[0]}.`
  } else why += '.'
  // Found, and not showing. Fetch brings nothing forward on its own, and a take of a
  // window that is not on screen gets no frames, so the person is told before, not after.
  if (first.window && first.window.onScreen === false) {
    firstOut.note = 'it is not on screen right now (on another Space, minimised, or behind a full-screen app). A take of it gets no frames until it is showing.'
    why += ` It is not on screen right now, so bring it forward before recording.`
  }
  return { ok: true, ...base, pick: firstOut, why, candidates: rest }
}

// ---------- the Mac ----------

// CoreGraphics' window list, through osascript's bridge, as JSON. Every window in the
// normal layer, on screen or not (another Space, minimised, behind a full-screen app),
// at least the size WindowList lists, with each owner's pid and whether it is showing.
const CG_WINDOWS = `
ObjC.import('CoreGraphics');
const raw = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(16, 0))) || [];
JSON.stringify(raw.filter(w => w.kCGWindowLayer === 0 && (w.kCGWindowAlpha == null || w.kCGWindowAlpha > 0.05))
  .map(w => ({ id: w.kCGWindowNumber, pid: w.kCGWindowOwnerPID, app: w.kCGWindowOwnerName || '',
    title: w.kCGWindowName || '', width: Math.round((w.kCGWindowBounds || {}).Width || 0),
    height: Math.round((w.kCGWindowBounds || {}).Height || 0), onScreen: !!w.kCGWindowIsOnscreen }))
  .filter(w => w.width >= 140 && w.height >= 120));
`

/**
 * The gathering half. Every system call comes in through deps, so a test hands in text
 * this Mac printed and nothing runs.
 *
 * deps.exec(file, args, { timeout }) -> Promise<stdout>   default: child_process.execFile
 * deps.fs        { realpath, readdir, readFile, stat }    promise-returning; default fs.promises
 * deps.windows   () -> Promise<windows with pid>          default: CG_WINDOWS through osascript
 * deps.simModel  () -> Promise<simulators() records>      default: none (agent-bridge's simModel
 *                                                          is the one to pass)
 * deps.pageTitle (host, port) -> Promise<string|null>     default: one GET over loopback
 * deps.selfPid, deps.home
 * deps.helper   WindowList's path, or null for none      default: the built one, when exec is not
 *                                                          injected and the binary knows --owners
 */
// WindowList's CoreGraphics-only --owners and proc_pidinfo --cwd modes, when the built
// helper has them: no osascript to start and no lsof to walk. A helper built before them
// takes an unknown flag as a request for its ScreenCaptureKit list, which asks the capture
// service for something, so it is used only when its own binary names the flag.
const helperKnows = new Map()
function defaultHelper() {
  const fs = require('fs')
  const where = [process.resourcesPath && path.join(process.resourcesPath, 'WindowList'), path.join(__dirname, '..', 'WindowList')]
  for (const bin of where.filter(Boolean)) {
    let st
    try { st = fs.statSync(bin) } catch { continue }
    const key = bin + '\0' + st.mtimeMs
    if (!helperKnows.has(key)) {
      let knows = false
      try { knows = fs.readFileSync(bin).includes('--owners') && fs.readFileSync(bin).includes('--cwd') } catch {}
      helperKnows.set(key, knows)
    }
    return helperKnows.get(key) ? bin : null
  }
  return null
}

function make(deps = {}) {
  const cp = require('child_process')
  const fsp = deps.fs || require('fs').promises
  const home = deps.home || require('os').homedir()
  const exec = deps.exec || ((file, args, o = {}) => new Promise(resolve => {
    cp.execFile(file, args, { timeout: o.timeout || 10000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => resolve(String(stdout || '')))
  }))
  const helper = deps.helper !== undefined ? deps.helper : (deps.exec ? null : defaultHelper())
  const listWindows = deps.windows || (async () => {
    if (helper) {
      try { const got = JSON.parse((await exec(helper, ['--owners'], { timeout: 5000 })).trim()); if (Array.isArray(got)) return got } catch {}
    }
    const out = await exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', CG_WINDOWS], { timeout: 8000 })
    try { return JSON.parse(out.trim() || '[]') } catch { return [] }
  })
  const readCwds = async pids => {
    if (!pids.length) return {}
    if (helper) {
      try {
        const got = JSON.parse((await exec(helper, ['--cwd', pids.join(',')], { timeout: 5000 })).trim())
        if (got && typeof got === 'object' && !Array.isArray(got)) return got
      } catch {}
    }
    return parseCwds(await exec('/usr/sbin/lsof', ['-a', '-d', 'cwd', '-p', pids.join(','), '-Fpn'], { timeout: 8000 }))
  }
  const pageTitle = deps.pageTitle || ((host, port) => new Promise(resolve => {
    const h = /^\[?::1\]?$/.test(host) ? '::1' : '127.0.0.1'
    const req = require('http').get({ host: h, port, path: '/', timeout: 1500,
      headers: { accept: 'text/html' } }, res => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', d => { body += d; if (body.length > 65536) req.destroy() })
      res.on('close', () => resolve(titleOf(body)))
    })
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve(null))
  }))
  const selfPid = deps.selfPid != null ? deps.selfPid : process.pid

  async function built(root, files) {
    const xcode = files.some(f => f.endsWith('.xcodeproj') || f.endsWith('.xcworkspace') || f === 'Package.swift')
    if (!xcode) return []
    const dd = path.join(home, 'Library/Developer/Xcode/DerivedData')
    let dirs = []
    try { dirs = await fsp.readdir(dd) } catch { return [] }
    const out = []
    for (const d of dirs) {
      if (d.startsWith('CMAKE_TRY_COMPILE') || d.startsWith('.')) continue
      let xml
      try { xml = await fsp.readFile(path.join(dd, d, 'info.plist'), 'utf8') } catch { continue }
      const workspace = workspaceOf(xml)
      if (!workspace) continue
      const products = []
      const prodRoot = path.join(dd, d, 'Build/Products')
      let plats = []
      try { plats = await fsp.readdir(prodRoot) } catch {}
      for (const plat of plats) {
        let apps = []
        try { apps = await fsp.readdir(path.join(prodRoot, plat)) } catch {}
        for (const a of apps) if (a.endsWith('.app')) products.push({ name: a.slice(0, -4), platform: plat })
      }
      out.push({ workspace, root: path.join(dd, d), products })
    }
    return out
  }

  async function find(project = {}) {
    let root
    try { root = await fsp.realpath(project.path) } catch {
      return { ok: false, project: { name: project.name || null, path: project.path || null }, pick: null, candidates: [],
        why: `${project.path || 'That project'} is not a folder on this Mac any more.` }
    }
    let files = []
    try { files = await fsp.readdir(root) } catch {}
    const [windows, psOut, listenOut] = await Promise.all([
      listWindows().catch(() => []),
      exec('/bin/ps', ['-axo', 'pid=,ppid=,comm=']),
      exec('/usr/sbin/lsof', ['-nP', '-a', '-iTCP', '-sTCP:LISTEN', '-Fpcn'], { timeout: 8000 }),
    ])
    const procs = parsePs(psOut)
    const listeners = parseListen(listenOut)

    // Working directories for the window owners, everything above them, and listeners.
    const want = new Set()
    const up = pid => { for (let p = +pid, n = 0; p > 1 && n < 32 && !want.has(p); n++) { want.add(p); p = procs.get(p) ? procs.get(p).ppid : 0 } }
    for (const w of windows) if (w.pid != null) up(w.pid)
    for (const l of listeners) up(l.pid)
    const pids = [...want].filter(p => procs.has(p))
    const cwds = await readCwds(pids)

    const builtList = await built(root, files)
    const hasSimApp = [...procs.values()].some(p => simAppOf(p.exe))
    let sims = []
    if (hasSimApp && deps.simModel) { try { sims = await deps.simModel() } catch { sims = [] } }

    // Page titles, only for servers in the project with no window of their own, run by a
    // web runtime.
    const windowPids = new Set(windows.map(w => +w.pid))
    const pages = {}
    for (const l of listeners) {
      if (windowPids.has(+l.pid) || pages[l.port] !== undefined) continue
      const p = procs.get(+l.pid)
      const cwd = cwds[l.pid]
      const exe = exeOf(p, cwd)
      if (!cwd || !within(cwd, root) || !exe || !WEB_RUNTIMES.has(path.basename(exe))) continue
      if (!/^(\*|127\.0\.0\.1|localhost|\[?::1\]?|\[::\])$/.test(l.host)) continue
      pages[l.port] = await pageTitle(l.host, l.port).catch(() => null)
    }

    return rank({ project: { name: project.name, path: root }, windows, procs, cwds, listeners, pages,
      built: builtList, sims, files, selfPid, home })
  }

  return { find }
}

module.exports = {
  rank, make,
  within, tooBroad, installed, parsePs, parseCwds, parseListen, exeOf, simAppOf, workspaceOf,
  titleOf, showsPage, startHint, SCORE, CG_WINDOWS,
}
