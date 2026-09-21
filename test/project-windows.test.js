// From a project to the window worth recording (ui/project-windows.js).
//
// The fixtures are shaped like what this Mac printed on Sep 21: the development Fetch
// running from the Conductor workspace rec/majuro as pid 51115, started as "electron ."
// so ps shows its executable relative to the workspace, with one window, 36610, owned by
// "Electron" and titled Fetch.
//
//   node test/project-windows.test.js
//   PROJECT_WINDOWS_LIVE=1 node test/project-windows.test.js   also reads this Mac (no
//       capture: ps, lsof and CoreGraphics' window list) and looks for this repo's window
const P = require('../ui/project-windows')

let pass = 0, fail = 0
const is = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}` +
    (ok ? '' : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`))
}
const ok = (name, cond) => is(name, !!cond, true)

const HOME = '/Users/sankiii'
const ROOT = `${HOME}/conductor/workspaces/rec/majuro`
const ELECTRON = 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
const HELPER = `${ROOT}/node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron Helper (Renderer).app/Contents/MacOS/Electron Helper (Renderer)`

const PS = [
  '    1     0 /sbin/launchd',
  '  900     1 /Applications/Conductor.app/Contents/MacOS/Conductor',
  '  901   900 /bin/zsh',
  '  950     1 /Applications/Visual Studio Code.app/Contents/MacOS/Electron',
  '  960     1 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  `51115     1 ${ELECTRON}`,
  `51147 51115 ${HELPER}`,
].join('\n')

const CWDS = { 1: '/', 900: '/', 901: ROOT, 950: ROOT, 960: '/', 51115: ROOT, 51147: ROOT }

const W_FETCH = { id: 36610, pid: 51115, app: 'Electron', title: 'Fetch', width: 1240, height: 800 }
const W_CONDUCTOR = { id: 100, pid: 900, app: 'Conductor', title: 'rec / majuro', width: 1600, height: 1000 }
const W_EDITOR = { id: 200, pid: 950, app: 'Code', title: 'main.js - majuro', width: 1400, height: 900 }
const W_CHROME = { id: 300, pid: 960, app: 'Google Chrome', title: 'Inbox', width: 1400, height: 900 }

const base = over => ({
  project: { name: 'majuro', path: ROOT }, home: HOME, selfPid: 7,
  procs: P.parsePs(PS), cwds: CWDS, files: ['package.json', 'main.js', 'README.md'],
  windows: [W_CONDUCTOR, W_EDITOR, W_CHROME, W_FETCH], ...over,
})

console.log('\nthe small pieces')
{
  ok('a folder is inside itself', P.within(ROOT, ROOT))
  ok('and a file below it is inside', P.within(`${ROOT}/node_modules/x`, ROOT))
  ok('a sibling that shares a prefix is not', !P.within(`${ROOT}-2/main.js`, ROOT))
  ok('home is too broad to be a project', P.tooBroad(HOME, HOME))
  ok('so is anything above it', P.tooBroad('/Users', HOME))
  ok('and the root', P.tooBroad('/', HOME))
  ok('a workspace is not', !P.tooBroad(ROOT, HOME))

  const ps = P.parsePs(PS)
  is('ps keeps an executable path with spaces in it', ps.get(51147).exe, HELPER)
  is('and the parent', ps.get(51147).ppid, 51115)
  is('a relative executable resolves against the working directory',
    P.exeOf(ps.get(51115), ROOT), `${ROOT}/${ELECTRON}`)
  is('and without one it is unknown rather than guessed', P.exeOf(ps.get(51115), null), null)
  ok('an installed app bundle is installed', P.installed('/Applications/Visual Studio Code.app/Contents/MacOS/Electron'))
  ok('Homebrew node is not an installed app', !P.installed('/opt/homebrew/bin/node'))

  is('lsof working directories', P.parseCwds(`p51115\nfcwd\nn${ROOT}\np960\nfcwd\nn/\n`), { 51115: ROOT, 960: '/' })
  is('lsof listeners, one per port', P.parseListen('p4847\ncnode\nf12\nn127.0.0.1:5173\nf13\nn[::1]:5173\np728\ncControlCenter\nf9\nn*:7000\n'),
    [{ pid: 4847, command: 'node', host: '127.0.0.1', port: 5173 }, { pid: 728, command: 'ControlCenter', host: '*', port: 7000 }])
  is('a simulator app from its executable',
    P.simAppOf(`${HOME}/Library/Developer/CoreSimulator/Devices/A1EDEC56-560D-4E95-A19C-87F2FC438103/data/Containers/Bundle/Application/0F1B/Boop.app/Boop`),
    { udid: 'A1EDEC56-560D-4E95-A19C-87F2FC438103', app: 'Boop' })
  is('and nothing from a Mac app', P.simAppOf('/Applications/Boop.app/Contents/MacOS/Boop'), null)
  is('a DerivedData info.plist to its workspace',
    P.workspaceOf('<?xml version="1.0"?><plist><dict><key>LastAccessedDate</key><date>2026-06-01T22:56:27Z</date><key>WorkspacePath</key><string>/Users/sankiii/iOSLocal/selfmade-ios/Boop.xcodeproj</string></dict></plist>'),
    '/Users/sankiii/iOSLocal/selfmade-ios/Boop.xcodeproj')
  is('a page title, entities and all', P.titleOf('<head><title> Lasso &amp; Lab </title></head>'), 'Lasso & Lab')
  ok('a window titled like the page shows it', P.showsPage('Lasso Lab', 'Lasso Lab'))
  ok('with the browser suffix too', P.showsPage('Lasso Lab - Google Chrome', 'Lasso Lab'))
  ok('but not a longer title that starts the same', !P.showsPage('Lasso Lab Pro', 'Lasso Lab'))
}

console.log('\nthe live example: a development Fetch started with electron . in rec/majuro')
{
  const r = P.rank(base())
  is('its window is the pick', r.pick && r.pick.window.id, 36610)
  is('as an app', r.pick && r.pick.kind, 'app')
  ok('because its executable is inside the project', /runs from inside majuro \(node_modules\/electron/.test(r.why))
  ok('the terminal the project is open in is not a candidate', !r.candidates.some(c => c.window && c.window.id === 100))
  ok('nor a browser that happens to be open', !r.candidates.some(c => c.window && c.window.id === 300))
  const ed = r.candidates.find(c => c.window && c.window.id === 200)
  ok('an editor opened from the folder is listed', ed)
  ok('but never recordable', ed && !ed.recordable)
  ok('and says what it most likely is', ed && /editor or a terminal/.test(ed.evidence[0]))
  is('ranked below the app', ed && ed.rank, 2)
  ok('and no score leaks into the answer', !('score' in r.pick))
}

console.log('\nfound, but not on screen')
{
  const bubble = { id: 36618, pid: 51115, app: 'Electron', title: '', width: 500, height: 500, onScreen: false }
  const r = P.rank(base({ windows: [bubble, { ...W_FETCH, onScreen: false }] }))
  is('still the pick', r.pick && r.pick.window.id, 36610)
  ok('an untitled square helper window is not a candidate', !r.candidates.some(c => c.window && c.window.id === 36618))
  ok('and the answer says to bring it forward', /not on screen right now/.test(r.why) && /no frames/.test(r.pick.note))
  is('which is carried on the window', r.pick.window.onScreen, false)
}

console.log('\nwhen the Fetch doing the recording is the project')
{
  const r = P.rank(base({ selfPid: 51115 }))
  is('nothing is picked', r.pick, null)
  ok('and it says why in words', /this Fetch's own/.test(r.why) && /cannot record itself/.test(r.why))
  const c = r.candidates.find(x => x.window && x.window.id === 36610)
  ok('the window is still named', c && c.self && !c.recordable)
}

console.log('\na sibling folder with the same prefix')
{
  const r = P.rank(base({ project: { name: 'majuro-2', path: `${ROOT}-2` } }))
  is('owns nothing of majuro', r.pick, null)
  ok('and says nothing is running', /Nothing from majuro-2 is running/.test(r.why))
}

console.log('\nnothing running')
{
  const r = P.rank(base({ windows: [W_CONDUCTOR, W_CHROME] }))
  is('no pick', r.pick, null)
  ok('says so plainly', /^Nothing from majuro is running, so there is nothing of it to record\./.test(r.why))
  ok('with what would start it', /npm start, or npm run dev/.test(r.why))
  ok('and never claims Fetch starts it', !/Fetch (will|starts)/.test(r.why))
  is('an Xcode project is told to build and run', P.startHint(['Boop.xcodeproj']), 'Start it with build and run it from Xcode, then ask again.')
  is('an unknown one is told to start it as usual', P.startHint([]), 'Start it the way it is usually started, then ask again.')
}

console.log('\nhome is not a project')
{
  const r = P.rank(base({ project: { name: 'sankiii', path: HOME } }))
  is('refused', r.ok, false)
  ok('in a sentence', /holds far more than one project/.test(r.why))
}

console.log('\na window whose owner is unknown is not guessed at')
{
  const r = P.rank(base({ windows: [{ ...W_FETCH, pid: undefined }] }))
  is('no pick', r.pick, null)
}

// A dev server: node from Homebrew, working directory in the project, on 5173.
const WEB = `${HOME}/code/lasso-lab`
const webBase = over => ({
  project: { name: 'lasso-lab', path: WEB }, home: HOME, selfPid: 7,
  procs: P.parsePs(['    1     0 /sbin/launchd', '  960     1 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ' 4847   901 /opt/homebrew/bin/node', '  901     1 /bin/zsh'].join('\n')),
  cwds: { 960: '/', 4847: WEB, 901: WEB },
  listeners: [{ pid: 4847, host: '127.0.0.1', port: 5173 }],
  pages: { 5173: 'Lasso Lab' }, files: ['package.json'],
  windows: [{ id: 301, pid: 960, app: 'Google Chrome', title: 'Lasso Lab', width: 1400, height: 900 },
    { id: 302, pid: 960, app: 'Google Chrome', title: 'Inbox', width: 1400, height: 900 }],
  ...over,
})

console.log('\na dev server and the browser tab showing it')
{
  const r = P.rank(webBase())
  is('the tab showing the page is the pick', r.pick && r.pick.window.id, 301)
  is('as a browser window', r.pick && r.pick.kind, 'browser')
  is('with the address it shows', r.pick && r.pick.url, 'http://localhost:5173/')
  ok('because the project serves it and the title matches', /serves localhost:5173/.test(r.why))
  ok('the other tab is not a candidate', !r.candidates.some(c => c.window && c.window.id === 302))
}

console.log('\na starter template title is a guess')
{
  const r = P.rank(webBase({ pages: { 5173: 'Vite App' },
    windows: [{ id: 301, pid: 960, app: 'Google Chrome', title: 'Vite App', width: 1400, height: 900 }] }))
  is('not picked', r.pick, null)
  ok('named as weak, with the reason', /may be showing/.test(r.why) && /starter template/.test(r.why))
}

console.log('\na server nobody is looking at')
{
  const r = P.rank(webBase({ windows: [{ id: 302, pid: 960, app: 'Google Chrome', title: 'Inbox', width: 1400, height: 900 }] }))
  is('not picked', r.pick, null)
  ok('says where it is and what to do', /running a server at http:\/\/localhost:5173\//.test(r.why) && /Open http:\/\/localhost:5173\//.test(r.why))
}

console.log('\nan Electron app and the dev server feeding it')
{
  const procs = P.parsePs([PS, ' 4847 51115 /opt/homebrew/bin/node'].join('\n'))
  const r = P.rank(base({ procs, cwds: { ...CWDS, 4847: ROOT }, listeners: [{ pid: 4847, host: '127.0.0.1', port: 5173 }],
    pages: { 5173: 'Fetch' }, windows: [W_FETCH, { id: 303, pid: 960, app: 'Google Chrome', title: 'Fetch', width: 1400, height: 900 }] }))
  is('the app is first', r.pick && r.pick.window.id, 36610)
  ok('and the tab is next, said as next', /next is window 303/.test(r.why))
}

console.log('\ntwo copies running from one project')
{
  const procs = P.parsePs([PS, `52000     1 ${ELECTRON}`].join('\n'))
  const r = P.rank(base({ procs, cwds: { ...CWDS, 52000: ROOT },
    windows: [W_FETCH, { id: 36700, pid: 52000, app: 'Electron', title: 'Fetch', width: 1240, height: 800 }] }))
  is('neither is picked', r.pick, null)
  ok('both are named by id', /36610/.test(r.why) && /36700/.test(r.why) && /Say which one/.test(r.why))
}

console.log('\none app, several windows')
{
  const tools = { id: 36611, pid: 51115, app: 'Electron', title: 'DevTools - localhost', width: 1300, height: 900 }
  const r = P.rank(base({ windows: [W_FETCH, tools] }))
  is('the app over its developer tools', r.pick && r.pick.window.id, 36610)
  const small = { id: 36612, pid: 51115, app: 'Electron', title: 'Look', width: 500, height: 400 }
  const r2 = P.rank(base({ windows: [small, W_FETCH] }))
  is('the largest is the main window', r2.pick && r2.pick.window.id, 36610)
  ok('and it says so', /largest of that app's 2 windows/.test(r2.why))
  const twin = { id: 36613, pid: 51115, app: 'Electron', title: 'Fetch 2', width: 1200, height: 800 }
  const r3 = P.rank(base({ windows: [W_FETCH, twin] }))
  is('two windows of about one size is a question, not a pick', r3.pick, null)
}

console.log('\none app, a big window on another Space and a smaller one showing')
{
  const away = { id: 36620, pid: 51115, app: 'Electron', title: 'Fetch', width: 1600, height: 1000, onScreen: false }
  const here = { id: 36621, pid: 51115, app: 'Electron', title: 'Look', width: 800, height: 600 }
  const r = P.rank(base({ windows: [away, here] }))
  is('the one on screen is the pick', r.pick && r.pick.window.id, 36621)
  ok('and nothing says it is not on screen', !/not on screen/.test(r.why))
  ok('it says it is the largest showing', /largest of that app's windows on screen/.test(r.why))
  const r2 = P.rank(base({ windows: [away] }))
  ok('with only the one away it still says so', r2.pick && /not on screen/.test(r2.why))
}

console.log('\nstarted by something in the project')
{
  const app = '/private/tmp/build/Lasso'
  const procs = P.parsePs(['    1     0 /sbin/launchd', ' 4847     1 /opt/homebrew/bin/node', ` 4900  4847 ${app}`].join('\n'))
  const r = P.rank(base({ procs, cwds: { 4847: ROOT, 4900: '/' },
    windows: [{ id: 5, pid: 4900, app: 'Lasso', title: 'Lasso', width: 900, height: 700 }] }))
  is('its window is the pick', r.pick && r.pick.window.id, 5)
  ok('because of its parent', /started by node \(pid 4847\)/.test(r.why))
}

// The project's own iOS app on a simulator.
const IOS = `${HOME}/iOSLocal/selfmade-ios`
const UDID = 'A1EDEC56-560D-4E95-A19C-87F2FC438103'
const SIM_EXE = `${HOME}/Library/Developer/CoreSimulator/Devices/${UDID}/data/Containers/Bundle/Application/0F1B/Boop.app/Boop`
const simBase = over => ({
  project: { name: 'selfmade-ios', path: IOS }, home: HOME, selfPid: 7,
  procs: P.parsePs(['    1     0 /sbin/launchd', ` 7000     1 ${SIM_EXE}`].join('\n')), cwds: { 7000: '/' },
  built: [{ workspace: `${IOS}/Boop.xcodeproj`, root: `${HOME}/Library/Developer/Xcode/DerivedData/Boop-ern`,
    products: [{ name: 'Boop', platform: 'Debug-iphonesimulator' }] }],
  sims: [{ udid: UDID, name: 'Round-Shots-16PM', booted: true, window: { id: 88, w: 396, h: 856, title: 'Round-Shots-16PM' } }],
  windows: [{ id: 88, pid: 6000, app: 'Simulator', title: 'Round-Shots-16PM', width: 396, height: 856 }],
  files: ['Boop.xcodeproj'], ...over,
})

console.log('\nthe project\'s app on a simulator')
{
  const r = P.rank(simBase())
  is('the device window is the pick', r.pick && r.pick.window.id, 88)
  is('with the device', r.pick && r.pick.device, { udid: UDID, name: 'Round-Shots-16PM' })
  ok('because Xcode builds that app from the project', /Boop.app is running on Round-Shots-16PM/.test(r.why))

  const r2 = P.rank(simBase({ built: [...simBase().built,
    { workspace: `${HOME}/conductor/workspaces/boop/other/Boop.xcodeproj`, root: '/dd/Boop-x', products: [{ name: 'Boop', platform: 'Debug-iphonesimulator' }] }] }))
  is('another checkout building the same app makes it a guess', r2.pick, null)
  ok('and it names the other checkout', r2.candidates[0] && /another checkout/.test(r2.candidates[0].evidence[1]))

  const r3 = P.rank(simBase({ sims: [{ udid: UDID, name: 'Round-Shots-16PM', booted: true, window: null }], windows: [] }))
  is('with its window closed there is nothing to record', r3.pick, null)
  ok('and it says how to open it', /simulator with action ready and device Round-Shots-16PM/.test(r3.why))

  const r4 = P.rank(simBase({ procs: P.parsePs('    1     0 /sbin/launchd'), windows: [] }))
  ok('nothing running says to run it on a simulator', /build and run it on a simulator/.test(r4.why))
}

console.log('\nmake(): the gathering half, with every call injected')
;(async () => {
  const calls = []
  const exec = async (file, args) => {
    calls.push([file, ...args])
    if (file === '/bin/ps') return PS
    if (args.includes('-sTCP:LISTEN')) return 'p728\ncControlCenter\nf9\nn*:7000\n'
    if (args.includes('cwd')) {
      const want = args[args.indexOf('-p') + 1].split(',').map(Number)
      return want.map(p => CWDS[p] ? `p${p}\nfcwd\nn${CWDS[p]}\n` : '').join('')
    }
    return ''
  }
  const fs = { realpath: async p => p, readdir: async p => p === ROOT ? ['package.json', 'main.js'] : [], readFile: async () => { throw new Error('no') } }
  let titles = 0
  const pw = P.make({ exec, fs, home: HOME, selfPid: 7, windows: async () => [W_CONDUCTOR, W_FETCH],
    pageTitle: async () => { titles++; return null } })
  const r = await pw.find({ name: 'majuro', path: ROOT })
  is('finds the development Fetch', r.pick && r.pick.window.id, 36610)
  const ps = calls.find(c => c[0] === '/bin/ps')
  is('reads the process table without arguments', ps.slice(1), ['-axo', 'pid=,ppid=,comm='])
  const cwd = calls.find(c => c.includes('cwd'))
  is('asks for working directories of window owners, their parents and listeners it knows only',
    cwd[cwd.indexOf('-p') + 1].split(',').map(Number).sort((a, b) => a - b), [900, 51115])
  is('asks no page a title when nothing in the project serves one', titles, 0)

  const gone = await P.make({ exec, fs: { ...fs, realpath: async () => { throw new Error('ENOENT') } }, home: HOME, windows: async () => [] })
    .find({ name: 'old', path: '/nope/old' })
  ok('a folder that is gone is said, not thrown', gone.ok === false && /not a folder on this Mac/.test(gone.why))

  // With a WindowList that knows --owners and --cwd, neither osascript nor lsof runs.
  {
    const hc = []
    const hexec = async (file, args) => {
      hc.push([file, ...args])
      if (file === '/bin/ps') return PS
      if (file === '/x/WindowList' && args[0] === '--owners') return JSON.stringify([W_CONDUCTOR, W_FETCH])
      if (file === '/x/WindowList' && args[0] === '--cwd') {
        const out = {}
        for (const p of args[1].split(',')) if (CWDS[p]) out[p] = CWDS[p]
        return JSON.stringify(out).replace(/\//g, '\\/')
      }
      if (args.includes('-sTCP:LISTEN')) return ''
      return ''
    }
    const r2 = await P.make({ exec: hexec, fs, home: HOME, selfPid: 7, helper: '/x/WindowList', pageTitle: async () => null })
      .find({ name: 'majuro', path: ROOT })
    is('the helper finds the same window', r2.pick && r2.pick.window.id, 36610)
    ok('and neither osascript nor lsof -d cwd ran', !hc.some(c => c[0] === '/usr/bin/osascript' || c.includes('cwd')))
    // an injected exec with no helper named never guesses one
    const r3 = await P.make({ exec, fs, home: HOME, selfPid: 7, windows: async () => [W_FETCH] }).find({ name: 'majuro', path: ROOT })
    is('an injected exec reads by lsof as before', r3.pick && r3.pick.window.id, 36610)
  }

  if (process.env.PROJECT_WINDOWS_LIVE) {
    console.log('\nlive: this Mac, this repo (ps, lsof and the CoreGraphics window list; nothing captured)')
    const t0 = Date.now()
    const live = await P.make({ selfPid: process.pid }).find({ name: 'majuro', path: require('path').resolve(__dirname, '..') })
    console.log(`       ${Date.now() - t0} ms`)
    console.log(`       pick: ${JSON.stringify(live.pick)}`)
    console.log(`       why:  ${live.why}`)
    ok('live: something from this repo was found', live.pick || live.candidates.length)
  }

  console.log(`\n  ${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
})()
