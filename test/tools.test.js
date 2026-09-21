// The tool surface, checked against itself.
//   node test/tools.test.js
//
// Three lists have to say the same thing and have no way to notice when they stop:
// the ops ui/agent-bridge.js answers, the tools mcp/index.js registers over them, and
// the ALLOWED list ui/agent-chat.js hands the in-app agent. record.pause sat in the
// bridge for months with no tool on it, so the app could pause a take and no agent
// could; the pane and the server drifting apart is the same bug pointed the other way,
// and it ends here.
//
// mcp/index.js is ESM and starts a stdio server when it is the program, so it is
// imported for its build() and nothing reads stdin (see isTheProgram there).

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

// the pane's module writes its thread beside the app's own; the test gets a temp one
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-tools-'))
process.env.FETCH_CHAT_DIR = dir

const bridge = require('../ui/agent-bridge')
const agentChat = require('../ui/agent-chat')
const SRC = fs.readFileSync(path.join(__dirname, '..', 'mcp', 'index.js'), 'utf8')

let n = 0
const t = (name, fn) => { fn(); n++; console.log('ok', name) }

// Ops the shim sends to the app and no model ever calls: who is driving, whether the
// app is up, and that a call its client cancelled should stop where it runs (the MCP
// server sends job.cancel itself, keyed by the job it minted for that call). Everything
// else is a thing Fetch can do and needs a tool on it.
const PLUMBING = new Set(['hello', 'ping', 'job.cancel'])

// The one tool the in-app pane deliberately does not get, with the reason, so the
// exception is a decision somebody made rather than a list that drifted. Anything
// named here still has to exist, or this list is the thing that has gone stale.
const NOT_IN_PANE = {
  pointer: 'the pane\'s agent has Fetch\'s tools and nothing else, so it drives no other app ' +
    'and has no pointer of its own to report during a take',
}

// What each tool drives, read off the source, since a registered tool keeps no note of
// it. Pairs a name with every op its handler calls.
function toolsInSource() {
  const out = []
  for (const chunk of SRC.split('server.registerTool(').slice(1)) {
    const name = chunk.match(/^\s*'([a-z_]+)'/)
    assert.ok(name, 'every registerTool call names its tool on the next line: ' + chunk.slice(0, 60))
    const ops = [...chunk.slice(0, chunk.indexOf('server.registerTool(') + 1 || undefined)
      .matchAll(/drive\('([a-z.]+)'/g)].map(m => m[1])
    out.push({ name: name[1], ops: [...new Set(ops)] })
  }
  return out
}

const source = toolsInSource()
const bare = agentChat.ALLOWED.map(x => x.replace(/^mcp__fetch__/, ''))

let registered = null

async function main() {
  const mcp = await import('../mcp/index.js')
  const server = mcp.build()
  registered = Object.keys(server._registeredTools || {})

  t('the source and the built server register the same tools', () => {
    // the parse above is what the ops check reads; if it ever goes stale it says so
    // here rather than passing every other check by finding nothing
    assert.deepStrictEqual(source.map(s => s.name).sort(), registered.slice().sort())
    assert.ok(registered.length >= 34, `${registered.length} tools registered`)
  })

  t('every tool drives an op the app answers', () => {
    for (const { name, ops } of source) {
      assert.ok(ops.length, `${name} drives nothing`)
      for (const op of ops) {
        assert.ok(typeof bridge.ops[op] === 'function',
          `${name} drives ${op}, which ui/agent-bridge.js does not answer`)
      }
    }
  })

  t('every op the app answers has a tool on it', () => {
    const driven = new Set(source.flatMap(s => s.ops))
    for (const op of Object.keys(bridge.ops)) {
      if (PLUMBING.has(op)) continue
      assert.ok(driven.has(op), `${op} is in the bridge and no tool reaches it, so nothing can call it`)
    }
  })

  t('the in-app agent is allowed exactly the tools the server registers', () => {
    // Both directions. A name in one list only is either a feature the pane cannot
    // reach or a name the pane allows that nothing answers to.
    const missing = registered.filter(x => !bare.includes(x) && !NOT_IN_PANE[x])
    const extra = bare.filter(x => !registered.includes(x))
    for (const name of Object.keys(NOT_IN_PANE)) {
      assert.ok(registered.includes(name), `${name} is held back from the pane and no longer exists`)
      assert.ok(!bare.includes(name), `${name} is in ALLOWED; if that is right, take it out of NOT_IN_PANE`)
    }
    assert.deepStrictEqual(missing, [], 'registered but not in ALLOWED (ui/agent-chat.js)')
    assert.deepStrictEqual(extra, [], 'in ALLOWED (ui/agent-chat.js) but not registered')
    assert.ok(agentChat.ALLOWED.every(x => x.startsWith('mcp__fetch__')), 'each one is prefixed for the CLI')
    assert.strictEqual(new Set(bare).size, bare.length, 'no name twice')
  })

  t('this round\'s eight tools are on the surface', () => {
    for (const name of ['record_pause', 'contact_sheet', 'direct', 'review',
      'fit_to_length', 'revert_my_edit', 'list_voices', 'voiceover']) {
      assert.ok(registered.includes(name), name + ' is not registered')
    }
  })

  t('every tool says what it is for, in the voice the others use', () => {
    for (const [name, tool] of Object.entries(server._registeredTools)) {
      const d = tool.description || ''
      assert.ok(d.length > 40, `${name} has no useful description`)
      // BRAND.md: no em dashes anywhere, and no mascot in a tool description, which is
      // read by a model choosing a tool rather than by a person.
      assert.ok(!/[—–]/.test(d), `${name} has an em dash in its description`)
      assert.ok(!/biscuit/i.test(d), `${name} names the mascot at a model`)
    }
  })

  // ── the doctrine, for the clients that are not this app ──────────────────
  // Everything the product knows about how to work reached the in-app agent, through
  // --append-system-prompt, and nobody else: mcp/index.js set no instructions, which is
  // the one field MCP has for it. These three hold the fix in place and hold it honest.
  t('the server tells an agent that never opened this app how a job goes', () => {
    const say = server.server._instructions || ''
    assert.ok(say.length > 200, 'no instructions on the server, so every outside client starts from nothing')
    // Short enough to be read rather than skipped. This is the shape of a job; what a
    // tool takes and gives back belongs in that tool's own description, where it cannot
    // fall out of step with the tool.
    assert.ok(say.length < 2000, `${say.length} characters is a manual, not a doctrine`)
    assert.ok(!/[\u2014\u2013]/.test(say), 'an em dash in the instructions')
    assert.ok(!/biscuit/i.test(say), 'the instructions name the mascot at a model')
  })

  t('the outside agent and the in-app one are handed the same loop', () => {
    // Two copies of one doctrine is one copy quietly going wrong. The pane's agent gets
    // EditAssist's LOOP as a system prompt and the server carries it word for word;
    // this is the only thing that would notice if either moved.
    const prompt = require('../ui/edit-assist').systemPrompt().split('\n')
    const head = prompt.indexOf('How a job goes, every time:')
    assert.ok(head >= 0, 'ui/edit-assist.js no longer heads its loop "How a job goes, every time:"')
    const loop = prompt.slice(head, prompt.indexOf('', head))
    assert.ok(loop.length >= 7, `${loop.length} lines of loop found, heading and all`)
    const say = server.server._instructions || ''
    for (const line of loop) {
      assert.ok(say.includes(line), `the pane's agent is told "${line}" and an outside agent is not`)
    }
  })

  t('the instructions name no tool this server does not register', () => {
    // The one way a sentence there rots is by naming a tool that was renamed or taken
    // out. Anything shaped like a tool name has to be one.
    const say = server.server._instructions || ''
    for (const word of new Set(say.match(/\b[a-z]+_[a-z_]+\b/g) || [])) {
      assert.ok(registered.includes(word), `the instructions name ${word}, which this server does not register`)
    }
    // and the ones named by a plain English word, which no pattern picks out of prose:
    // listed here so a rename breaks this rather than the sentence
    for (const name of ['direct', 'review', 'remember', 'ask', 'propose', 'guidelines']) {
      assert.ok(registered.includes(name), `the instructions say to call ${name}, which is not registered`)
      assert.ok(new RegExp(`\\b${name}\\b`).test(say), `${name} is listed here and the instructions no longer name it`)
    }
  })

  t('this round\'s work reached the tool surface too', () => {
    // The same rule as the check below, a round later: a thing the app can now do that
    // no outside agent would find, because the only place it is written down is the
    // description beside it.
    const doc = name => SRC.split(`'${name}',`)[1] || ''
    assert.ok(/clips \[\{id,start,end,rate,audio\}\]/.test(doc('apply_edit')), 'apply_edit does not name a clip\'s own sound')
    assert.ok(/motion\.loop/.test(doc('apply_edit')), 'apply_edit does not name the loop')
    assert.ok(/keys/.test(doc('apply_edit')), 'apply_edit does not name the keys section of the look')
    const ex = doc('export')
    assert.ok(/MP4, MOV, WebM and GIF are all drawn by the compositor/.test(ex),
      'export still tells an agent that a GIF or a WebM goes to the classic renderer')
    assert.ok(/loudness/.test(doc('probe')), 'probe does not offer the measurement that answers "this bit is too quiet"')
    assert.ok(/source/.test(doc('can_loop')), 'can_loop does not say the recording\'s own half is the agent\'s to check')
  })

  // ── a simulator is a window with a machine inside it ─────────────────────
  // The round that made a simulator a thing Fetch knows cost one tool and four
  // arguments, and the reason it could is that the command line it drives already does
  // everything except the touch. These checks hold both halves: the surface stays one
  // tool, and nothing on it reimplements a verb that ships with Xcode.
  const SIM_SRC = fs.readFileSync(path.join(__dirname, '..', 'ui', 'agent-bridge.js'), 'utf8')

  t('the one tool a simulator adds is the simulator', () => {
    assert.ok(registered.includes('simulator'), 'simulator is not registered')
    const drives = source.find(s => s.name === 'simulator').ops
    assert.deepStrictEqual(drives, ['sim.do'], 'simulator drives ' + drives.join(', '))
    // Five actions behind one op. Six tools for six command line verbs would be six
    // descriptions of prose in every context window for one capability.
    const simOps = Object.keys(bridge.ops).filter(op => /^sim\./.test(op))
    assert.deepStrictEqual(simOps, ['sim.do'],
      'the bridge answers ' + simOps.join(', ') + '; a simulator is another subject, not another surface')
    const chunk = SRC.split("'simulator',")[1] || ''
    const head = chunk.slice(0, chunk.indexOf('async args') + 1 || 4000)
    for (const a of ['list', 'ready', 'go', 'tap', 'restore']) {
      assert.ok(new RegExp(`'${a}'`).test(head), `the simulator tool does not offer ${a}`)
      assert.ok(new RegExp(`'${a}: `).test(head), `${a} is offered and never explained`)
    }
  })

  t('the surface reimplements nothing that ships with Xcode', () => {
    // The whole plan rests on this: Fetch builds argv, reads an exit code and says a
    // sentence (ui/simctl.js), and every other file stays out of it. A second place
    // building a command line is where the two go out of step with each other.
    for (const [name, src] of [['mcp/index.js', SRC], ['ui/agent-bridge.js', SIM_SRC]]) {
      assert.ok(!/xcrun/.test(src), `${name} spawns a command line of its own`)
      assert.ok(!/recordVideo|'screenshot'/.test(src),
        `${name} names simctl's own capture, which writes pixels with no audio track and no policy check`)
      for (const verb of ['erase', 'uninstall', ' clone ']) {
        assert.ok(!new RegExp(`simctl[^\\n]*${verb}`).test(src), `${name} reaches for ${verb.trim()}`)
      }
    }
  })

  t('a tap aims at a box, and its consent is never the agent\'s to give', () => {
    const chunk = SRC.split("'simulator',")[1] || ''
    const head = chunk.slice(0, chunk.indexOf('async args') + 1 || 4000)
    assert.ok(/element: z\.string\(\)[\s\S]{0,200}find_on_screen/.test(head),
      'the simulator tool does not say a tap is aimed with find_on_screen')
    assert.ok(/never a coordinate/.test(head), 'the tool no longer refuses a coordinate by name')
    // Nothing on the surface takes consent as an argument. An agent that can set its own
    // consent flag has no consent rule at all, so the flag is minted where the person is
    // asked and nowhere else.
    assert.ok(!/consent/.test(head), 'the simulator tool takes consent as an argument')
    assert.ok(!/consent: args|consent: String\(args/.test(SIM_SRC),
      'the bridge hands the policy a consent the agent passed in')
    const ask = SIM_SRC.slice(SIM_SRC.indexOf('async function simAsk('))
    assert.ok(/askPerson\(/.test(ask.slice(0, ask.indexOf('\n}'))),
      'the bridge no longer asks the person before driving their device')
  })

  t('a simulator take is judged as a device and put back as it was', () => {
    // Both halves of the promise, in the one place that can keep them: the never-record
    // list is per device, because every simulator answers to one app name, and anything
    // Fetch changed goes back when the take stops.
    assert.ok(/neverRecordDevices: prefs.neverRecordDevices/.test(SIM_SRC),
      'the access check no longer carries the never record devices list')
    assert.ok(/kind: \(sim \|\| unresolved\) \? 'simulator'/.test(SIM_SRC), 'a simulator take is judged as a plain window')
    // A window named by its id has to go through the device join too, or the never
    // record devices list is bypassed by naming the window instead of the device: an
    // agent reads the Simulator window id out of list_windows and records it.
    assert.ok(/attachDevices\(\[hit\], \{ strict: true \}\)/.test(SIM_SRC),
      'record_start aimed by window id never asks which device is inside that window')
    assert.ok(/'udid:' \+ sim.udid/.test(SIM_SRC),
      'one yes to Simulator is a yes to every device on the Mac: the session key is not the device')
    const stop = SIM_SRC.slice(SIM_SRC.indexOf("async 'record.stop'"), SIM_SRC.indexOf("async 'record.pointer'"))
    assert.ok(/afterTake\(/.test(stop) && /simUndress\(/.test(stop),
      'a take of a device can end without the status bar going back')
    // Every way out of a stop goes through the one function that says what the file has
    // and puts the device back, and that one goes through the device's own.
    const after = SIM_SRC.slice(SIM_SRC.indexOf('async function afterTake('))
    const body = after.slice(0, after.indexOf('\n}\n'))
    assert.ok(/simAfterTake\(/.test(body), 'the end of a take no longer runs the device\'s own ending')
    assert.ok(/Opts\.takeAudio\(/.test(body),
      'the end of a take does not read the written file, so an agent learns a take is silent from transcribe')
    assert.ok(typeof require('../ui/record-policy').simDecide === 'function',
      'ui/record-policy.js answers no simDecide, so nothing is checked before a spawn')
  })

  t('a tap lands where the element was, on the device measured on this Mac', () => {
    // The one piece of arithmetic between an id and a touch, run rather than read, on the
    // window this Mac really reports for an iPhone 16 Pro Max: 397 x 859 points of window
    // over a 1320 x 2868 screen at scale 3, with the glass measured off a capture of it
    // (.context/survey/st-t0.md). Measured, because the fit that used to stand in for it
    // is what sent a tap 80 points above the button near the top of the screen.
    const Sim = require('../ui/simulator')
    const screen = { w: 1320, h: 2868, scale: 3, points: { w: 440, h: 956 } }
    const win = { w: 397, h: 859 }
    const glass = { capture: { w: 794, h: 1718 }, px: { x: 44, y: 154, w: 706, h: 1534 },
      rect: { x: 44 / 794, y: 154 / 1718, w: 706 / 794, h: 1534 / 1718 }, agree: 0.995 }
    const viewport = Sim.viewport(win, screen, { glass })
    const sim = { name: 'Round-Shots-16PM', screen, viewport }
    const mid = bridge.devicePoint(sim, viewport.x + viewport.w / 2, viewport.y + viewport.h / 2)
    assert.ok(Math.abs(mid.x - 220) < 0.5 && Math.abs(mid.y - 478) < 0.5,
      `the middle of the glass came out at ${mid.x}, ${mid.y} in device points`)
    // and back again through the map the touch disc is drawn with, so an injected tap
    // and a drawn one are the same place rather than two places that agree by habit
    const back = Sim.pointToFrame(sim, mid.x, mid.y)
    assert.ok(Math.abs(back.x - (viewport.x + viewport.w / 2)) < 0.001, 'the tap and the mark disagree across the frame')
    assert.ok(Math.abs(back.y - (viewport.y + viewport.h / 2)) < 0.001, 'the tap and the mark disagree down the frame')
    // A box on the Mac's part of the window is not tapped at the edge of the glass: a
    // touch a whole element away from what was asked for is worse than a refusal.
    assert.throws(() => bridge.devicePoint(sim, -0.2, 0.5), /off a 440 by 956 point screen/)

    // The judged miss, in numbers. Fetch's own arithmetic put the Close button at
    // (165, 571) and the tap did nothing; the glass measured off the pixels puts the same
    // place on the frame 27 points higher, which is the judgement's "27 points on a 60
    // point target" and why the alert stayed up.
    const fit = Sim.viewport(win, screen)
    const fx = fit.x + (165 / 440) * fit.w, fy = fit.y + (571 / 956) * fit.h
    const was = bridge.devicePoint({ ...sim, viewport: fit }, fx, fy)
    const now = bridge.devicePoint(sim, fx, fy)
    assert.ok(Math.abs(was.y - 571) < 0.5, `the fit aimed at ${was.y}, not the 571 the judge saw`)
    assert.ok(Math.abs((was.y - now.y) - 27) < 1.5, `the measurement moved the aim ${(was.y - now.y).toFixed(1)} points, not 27`)
    // and the density the store gate reads: 0.53 of the device's own pixels, not 0.60.
    assert.strictEqual(Sim.density(win, screen, { glass }), 0.53)
    // Nothing is aimed with the arithmetic any more: with no measurement there is no
    // rectangle, and a tap says so rather than landing somewhere nobody pointed.
    const bare = Sim.simulators({ devices: [], runtimes: {}, windows: [] })
    assert.deepStrictEqual(bare, [], 'the model answered something for no devices at all')
  })

  t('nothing in the bridge aims at a rectangle nobody measured', () => {
    // The fault that made the rest of the round not matter: the glass was worked out
    // from the window's shape, which is 12 percent out on a phone with a notch and 19
    // percent out on one with a home button. Every rectangle now comes off a capture.
    assert.ok(/Sim\.measureGlass\(/.test(SIM_SRC), 'the bridge measures no capture, so no viewport is ever real')
    assert.ok(!/scaleOf/.test(SIM_SRC), 'the model is still handed a display scale, which a measured glass replaced')
    assert.ok(/glassOf/.test(SIM_SRC), 'the model is no longer handed what a capture measured')
    // and the three calls that rely on a rectangle take the measurement themselves
    for (const fn of ['simReady', 'simTap']) {
      const from = SIM_SRC.indexOf(`async function ${fn}(`)
      assert.ok(from > 0, `${fn} is gone from the bridge`)
      const body = SIM_SRC.slice(from, from + SIM_SRC.slice(from).indexOf('\n}\n'))
      assert.ok(/simMeasured\(|readGlass\(/.test(body), `${fn} relies on a rectangle it never measures`)
    }
    const start = SIM_SRC.slice(SIM_SRC.indexOf("async 'record.start'"), SIM_SRC.indexOf("async 'record.stop'"))
    assert.ok(/simMeasured\(sim\)/.test(start), 'a take of a device starts without measuring the glass it crops to')
    // A flow is many of the same question, so the session answer is the one under the
    // person's hand. Nine dialogs for one job is an agent that cannot be left alone.
    const tap = SIM_SRC.slice(SIM_SRC.indexOf('async function simTap('))
    const tapBody = tap.slice(0, tap.indexOf('\n}\n'))
    assert.ok(/sessionFirst: true/.test(tapBody),
      'the tap dialog still offers "this one" first, so a ten tap flow asks ten times')
    // idb takes whole points and refuses a float, so every tap aimed at an element failed
    assert.ok(/x: Math\.round\(aimed\.x\), y: Math\.round\(aimed\.y\)/.test(tapBody),
      'a tap is sent in fractional points, which the one touch tool on the judged Mac refuses')
    // and the capture that aims it comes after the person's yes, not before
    assert.ok(tapBody.indexOf("simAsk('tap'") < tapBody.indexOf('simMeasured('),
      'a tap measures the window, which is a capture, before the person has said yes to it')
  })

  t('a simulator take is recorded with its sound, and the result says what landed', () => {
    // The judged fault: record_start returned hasAudio false while three descriptions
    // promised a track. Both halves are checked here, the decision by running it.
    const Opts = require('../ui/recorder-opts')
    assert.strictEqual(Opts.audioFor({}, { simulator: true }).systemAudio, true, 'a simulator take is silent again')
    assert.strictEqual(Opts.audioFor({}, {}).systemAudio, false, 'every other take turned its sound on')
    assert.strictEqual(Opts.audioFor({}, { simulator: true }).mic, false, 'the room is in a take nobody asked for')
    // and the sentences are the constant rather than a fourth copy of the claim
    const rec = String(server._registeredTools.record_start.description || '')
    assert.ok(rec.includes(Opts.SIM_AUDIO_SAID), 'record_start no longer says what the default actually does')
    assert.strictEqual(String(server._registeredTools.record_start.inputSchema.shape.system_audio.description || ''),
      Opts.SYS_AUDIO_ARG_SAID, 'the system_audio argument and the default disagree again')
    for (const [where, src] of [['mcp/index.js', SRC], ['ui/agent-bridge.js', SIM_SRC]]) {
      assert.ok(!/the take has an audio track/.test(src),
        `${where} promises a track in prose instead of reading ui/recorder-opts.js`)
    }
    assert.ok(SIM_SRC.includes('Opts.SIM_LIST_SAID') && SIM_SRC.includes('Opts.READY_NEXT_SAID'),
      'the simulator list and ready still type the claim out by hand')
  })

  t('export can write the app preview the named job is for', () => {
    // "export cannot make an app preview at all" was where the job ended. The refusal is
    // gone, the plan is what draws it, and the file is measured after it is written.
    assert.ok(!/will not hand you a file and call it one/.test(SIM_SRC),
      'export still refuses every store size on a recording')
    const from = SIM_SRC.indexOf("async 'edit.export'")
    const body = SIM_SRC.slice(from, from + SIM_SRC.slice(from).indexOf('\n  },'))
    assert.ok(/Sizes\.preview\(/.test(body), 'export plans no preview, so nothing decides its shape before it is drawn')
    assert.ok(/clipVerdict\(/.test(body), 'export never measures the file it wrote, and the store measures the file')
    // The pair of integers, through the geometry that actually draws it. A preview one
    // pixel out is rejected on upload, so this is arithmetic rather than a promise.
    const Layout = require('../ui/compositor/layout')
    const Sizes = require('../ui/sizes')
    for (const p of Sizes.list().filter(x => x.kind === 'video')) {
      for (const g of [Layout.plainGeometry(1000, 2000, { outAspect: p.w / p.h }),
        Layout.backdropGeometry(1000, 2000, { outAspect: p.w / p.h, outWidth: 1920 })]) {
        const k = Math.min(1, p.w / g.outW)
        const drawn = { w: Layout.even(g.outW * k), h: Layout.even(g.outH * k) }
        assert.deepStrictEqual(drawn, { w: p.w, h: p.h },
          `${p.id} would be drawn ${drawn.w}x${drawn.h} and the store measures ${p.w}x${p.h}`)
      }
    }
    // and the renderer is told the pair rather than a resolution
    const host = fs.readFileSync(path.join(__dirname, '..', 'ui', 'render-host.js'), 'utf8')
    assert.ok(/opts\.size/.test(host), 'the export host knows nothing about an exact size')
    assert.ok(/\+opts\.fps > 0/.test(host), 'the export host cannot be told the frame rate the store caps')
  })

  t('a store size is refused before it is drawn, and the file is measured after', () => {
    // The half of the exact sizes that is mine and works today, run rather than read.
    // On the window M0 measured, 792 x 1712, every store size is an upscale, and that
    // refusal is the common case: a default Simulator window is at 0.6 of the device.
    assert.throws(() => bridge.storeSize('app-store-6.9', { w: 792, h: 1712 }),
      /does not upscale into a store size/)
    assert.throws(() => bridge.storeSize('app-store-6.9', { w: 792, h: 1712 }), /Pixel Accurate/)
    // The one size nobody may ask for is refused by its own name rather than as a typo,
    // and names what to use: 9:16 round a phone is a bar, and Fetch never draws one.
    assert.throws(() => bridge.storeSize('app-preview-1080', { w: 1320, h: 2868 }), /app-preview-6\.9/)
    // A video size on a still says so instead of writing a PNG at a preview's shape
    assert.throws(() => bridge.storeSize('app-preview-6.9', { w: 1320, h: 2868 }), /video size/)

    // A capture that is the device's own pixels goes through, and the verdict is read
    // off the written file rather than off the plan, because the store measures the file.
    const want = bridge.storeSize('6.9', { w: 1320, h: 2868 })
    assert.deepStrictEqual(want.size, { w: 1320, h: 2868 }, 'the preset is not a pair of integers')
    assert.strictEqual(bridge.sizeVerdict(want, { w: 1320, h: 2868 }).exact, true)
    const off = bridge.sizeVerdict(want, { w: 1320, h: 2867 })
    assert.strictEqual(off.exact, false, 'a file one pixel out passed as a store file')
    assert.ok(/will not call this a store file/.test(off.not_the_store_size),
      'a file the store would reject comes back with nothing said about it')
  })

  t('what the round\'s review found stays fixed, read where it lives', () => {
    const body = fn => {
      const from = SIM_SRC.indexOf(fn)
      assert.ok(from > 0, `${fn} is gone from the bridge`)
      return SIM_SRC.slice(from, from + SIM_SRC.slice(from).indexOf('\n}\n'))
    }
    // A dark screen measured as the glass, or one that could not be measured, used to
    // replace a good rectangle for the same window size and refuse every tap after it.
    const rg = body('async function readGlass(')
    assert.ok(/Sim\.glassViewport\(glass, screen\)/.test(rg), 'a rectangle of the wrong shape is kept as the glass')
    assert.ok(/glass \|\| \(had && had\.glass\)/.test(rg), 'a failed measurement throws away the last one that passed')
    // The screen handed back is only ever off a capture this call made.
    assert.ok(/held\.at >= \(\+o\.since \|\| 0\)/.test(body('async function simScreen(')),
      'a failed capture hands back the last screen\'s ids as the new one')
    for (const fn of ['async function simTap(', 'async function simGo(', 'async function simReady(']) {
      assert.ok(/simScreen\([^)]*since/.test(body(fn)), `${fn} names a screen without saying which capture it must be off`)
    }
    // An id with no path falls back to the device's screen only while that is the newest pass.
    assert.ok(/seenHere === lastFoundOn/.test(body('async function simPoint(')),
      'a tap by id with no path resolves against a frame an agent has since stopped reading')
    // record_stop writes the newest rectangle that passed, and says what it wrote.
    const stop = body('async function simAfterTake(')
    assert.ok(/simOnDoc\(sim\)/.test(stop) && !/simOnDoc\(held\.sim\)/.test(stop), 'the take keeps record_start\'s measurement only')
    assert.ok(/wrote = sim\.viewport/.test(stop), 'record_stop says the crop happens where nothing was measured')
    assert.ok(/sim\.note \|\| Sim\.glassNote\(sim\)/.test(body('function simFacts(')), 'a device with no rectangle does not say why')
    // Export reads the family the take records and the take's cadence.
    const ex = SIM_SRC.slice(SIM_SRC.indexOf("async 'edit.export'"))
    const exBody = ex.slice(0, ex.indexOf('\n  },'))
    assert.ok(/args\.family \|\| \(dev && dev\.family\)/.test(exBody), 'an iPhone take is drawn into an iPad preview')
    assert.ok(/fps: meta\.cadence \|\| meta\.fps/.test(exBody), 'a preview is timed off the header\'s average')
    assert.ok(/share: drawnShare\(doc\)/.test(exBody), 'the upscale is judged at a share the look never draws')
    // Sound nobody asked for by name never takes the whole Mac's output.
    assert.ok(/sysNativeOnly/.test(body('async function applySetup(')), 'a default simulator take can fall back to loopback')
    const appSrc = fs.readFileSync(path.join(__dirname, '..', 'ui', 'app.js'), 'utf8')
    assert.ok(/setup\.sys && !window\.__sysNativeOnly/.test(appSrc), 'the browser capture still records the whole Mac for it')
    // The person is told a take has sound, and a yes to a silent take is not a yes to one with it.
    const ask = body('async function enforceAccess(')
    assert.ok(/', with sound'/.test(ask) && /'\|sound:'/.test(ask), 'the approval never mentions sound')
    // A track at the floor is measured, so it is said.
    assert.ok(/clipLevels\(src, null\)/.test(body('async function afterTake(')), 'the level is never measured, so a silent track reads as fine')
    // A scratch capture is a temp file, not a folder in the Library then the Trash.
    const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
    assert.ok(/opts\.scratch === true && by === 'agent'/.test(main) && /scratch: true, kind/.test(main),
      'every measurement still writes a shot folder into the person\'s Library')
  })

  t('the named job is five calls, plus the brief, the length and the review', () => {
    // "Boot an iPhone, open my app, tap through the onboarding and record it": ready,
    // record_start, a tap a screen, record_stop, export. That is the five, and the loop
    // this product is built on adds direct, fit_to_length and review to every job there
    // is. Judged, it took nineteen, six of them on faults and five of them spent finding
    // out what the call before had just changed.
    for (const name of ['simulator', 'record_start', 'record_stop', 'export', 'find_on_screen',
      'direct', 'fit_to_length', 'review']) {
      assert.ok(registered.includes(name), name + ' is not registered')
    }
    for (const name of ['record_start', 'take_shot']) {
      const chunk = SRC.split(`'${name}',`)[1] || ''
      const head = chunk.slice(0, chunk.indexOf('async args') + 1 || 4000)
      assert.ok(/simulator: z\.string\(\)\.optional\(\)/.test(head),
        `${name} does not take a simulator where it takes a window`)
      assert.ok(/status_bar: z\.boolean\(\)/.test(head), `${name} cannot be told to leave the status bar alone`)
    }
    const ex = SRC.split("'export',")[1] || ''
    assert.ok(/size: z\.string\(\)\.optional\(\)/.test(ex.slice(0, ex.indexOf('async args'))),
      'export takes no store size, so Fetch still draws every part of a store screenshot and cannot save one')
    // Read off the built tool rather than off the source, because the ids come from
    // ui/sizes.js at import: a second copy of a table in a description goes stale
    // silently, and this one is read before a tool is chosen.
    const sizeDoc = String(server._registeredTools.export.inputSchema.shape.size.description || '')
    for (const P of require('../ui/sizes').list()) {
      assert.ok(sizeDoc.includes(P.id) && sizeDoc.includes(`${P.w}x${P.h}`),
        `export never names ${P.id}, so nothing leads a model to it`)
    }
    // and the sizes themselves live in one table, not in a tool description
    const Sizes = require('../ui/sizes')
    for (const p of Sizes.list()) {
      assert.ok(/^\d+$/.test(String(p.w)) && /^\d+$/.test(String(p.h)), `${p.id} is not a pair of integers`)
    }

    // The plan a brief naming a device gets back carries the call every step is, and
    // every one of those calls has to be a tool this server registers: a step naming a
    // tool that does not exist is a call an agent cannot make.
    const Director = require('../ui/director')
    const steps = Director.outline({ device: 'Yolk-ProMax', app: 'com.yolkling.ios', seconds: 28, size: 'app-preview-6.9' })
    assert.ok(steps.length >= 5, `${steps.length} steps for a device job`)
    for (const step of steps) {
      assert.ok(registered.includes(step.tool), `a device job's plan says to call ${step.tool}, which is not registered`)
      assert.ok(step.what && step.what.length > 8, `${step.tool} is a step with nothing said about it`)
    }
    assert.ok(steps.some(x => x.tool === 'export' && x.args.size === 'app-preview-6.9'),
      'the export step does not carry the size the brief asked for, so the enum is guessed at again')
  })

  // Which device to boot and how many seconds the deliverable runs are decided before
  // record_start. The judged run wrote its brief after the fact, which is how a 202
  // second take was recorded for a deliverable that refuses anything over 30. Run rather
  // than read: the op itself, against a temporary folder of its own.
  await (async () => {
    const Director = require('../ui/director')
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-job-'))
    const was = os.tmpdir
    os.tmpdir = () => home
    let out = null
    try {
      out = await bridge.ops['edit.direct']({ brief: { what: 'the onboarding of my app', device: 'Yolk-ProMax', size: 'app-preview-6.9' } })
    } finally { os.tmpdir = was }
    t('a job that films a device is directed before there is anything to direct', () => {
      assert.strictEqual(out.waiting, true, 'a job with no take under it was not held anywhere')
      assert.strictEqual(out.brief.seconds, 30, 'a size with a length window left the length nobody\'s call')
      assert.ok((out.plan.steps || []).some(x => x.call && x.call.tool === 'record_start'),
        'the device job came back without the call that records it')
      const pend = Director.readPending(home)
      assert.ok(pend && pend.brief.device === 'Yolk-ProMax', 'nothing is waiting for the take to exist')
    })
    fs.rmSync(home, { recursive: true, force: true })
  })()

  // ── a shot is a take of one frame ────────────────────────────────────────
  // The whole of this round on the tool surface is one new tool and a set of old ones
  // that now take a capture. These four hold that shape: they fail if stills grow a
  // second surface, and they fail if a tool a shot can be the subject of stops saying so.
  t('the one tool stills add is the capture', () => {
    assert.ok(registered.includes('take_shot'), 'take_shot is not registered')
    const drives = source.find(s => s.name === 'take_shot').ops
    assert.deepStrictEqual(drives, ['shot.take'], 'take_shot drives ' + drives.join(', '))
    // Everything else a shot needs is an op a take already had. A second op named for
    // stills is the near-duplicate this round exists to avoid.
    const shotOps = Object.keys(bridge.ops).filter(op => /^shot\./.test(op))
    assert.deepStrictEqual(shotOps, ['shot.take'],
      'the bridge answers ' + shotOps.join(', ') + '; a shot is another subject, not another surface')
  })

  t('every tool a shot is a subject of says so where the path is described', () => {
    // The path argument is where an agent looks to find out what a tool takes, so a
    // tool that quietly accepts a capture is one no agent will ever point at one.
    for (const name of ['get_edit', 'apply_edit', 'apply_look', 'find_on_screen', 'preview_frame',
      'review', 'export', 'contact_sheet', 'get_frame', 'direct', 'revert_my_edit']) {
      const chunk = SRC.split(`'${name}',`)[1] || ''
      const head = chunk.slice(0, chunk.indexOf('async args') + 1 || 4000)
      assert.ok(/path: z\.string\(\)[\s\S]{0,140}or to a shot/.test(head),
        `${name} takes a shot and its path does not say so`)
    }
  })

  t('a shot is refused only where the question is about time, and never bare', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'ui', 'agent-bridge.js'), 'utf8')
    const from = src.indexOf('const SHOT_INSTEAD =')
    assert.ok(from > 0, 'the bridge no longer has one sentence for what to do with a shot instead')
    const say = src.slice(from, src.indexOf('\n', src.indexOf('notOnAShot =', from)))
    for (const name of ['apply_look', 'apply_edit', 'preview_frame', 'export']) {
      assert.ok(new RegExp(`\\b${name}\\b`).test(say) && registered.includes(name),
        `the refusal on a shot does not name ${name}, or that tool is gone`)
    }
    // Every refusal goes through that one sentence, so none of them can be a bare no.
    for (const m of src.matchAll(/if \(isShot\(args\.path\)\) throw ([a-zA-Z]+)/g)) {
      assert.strictEqual(m[1], 'notOnAShot', 'a shot is refused somewhere without saying what to do instead')
    }
  })

  t('the rubric run on a still raises nothing the tool surface has not accounted for', () => {
    // review routes on the document: a shot says what it is and ui/review.js judges it
    // as a picture. Two risks, and this is both directions of the one invariant. A rule
    // about a clock reported as a failure would tell an agent a screenshot is twenty six
    // seconds short. A rule about the picture that named a tool this server does not
    // register would be advice nobody can take.
    const Shot = require('../ui/shot')
    const Review = require('../ui/review')
    const shot = Shot.normalize({ marks: [{ kind: 'lift', x: 0.2, y: 0.2, w: 0.3, h: 0.1 }],
      look: { background: { kind: 'solid', color: '#101010' }, device: { kind: 'browser' } } },
    '/tmp/shot.png', { w: 2720, h: 1560 })
    const r = Review.review({ doc: shot, path: '/tmp/shot.png', looks: [],
      brief: { what: 'a help centre hero', seconds: 30, aspect: '16:9', must_hide: ['the email address'] } })
    assert.strictEqual(r.measured.kind, 'shot', 'a shot went down the edit rubric, which passes every rule on one frame')
    const CLOCK = new Set(Review.NOT_ABOUT_A_PICTURE.map(([rule]) => rule))
    for (const i of r.items) {
      assert.ok(!CLOCK.has(i.rule), `the rubric reported ${i.rule} on a still, and it is about a clock`)
    }
    // and the other way: every one of them is named, so the promise the tool description
    // makes about not_judged is kept in the letter and not only in the spirit
    const named = new Set((r.not_judged || []).map(x => x.rule))
    for (const rule of CLOCK) assert.ok(named.has(rule), `${rule} is not named under not_judged`)
    for (const x of r.not_judged || []) assert.ok(x.why && x.why.length > 10, `${x.rule} is dropped without a reason`)

    // Every fix is a call an agent here can make. This is the check that catches a
    // rubric growing advice the tool surface cannot carry out.
    const fixes = r.items.flatMap(i => [i.fix, ...(i.choices || []).map(c => c.fix)]).filter(Boolean)
    assert.ok(fixes.length >= 3, `${fixes.length} fixes on a picture with a brief, a lift and a drawn frame`)
    for (const f of fixes) {
      assert.ok(registered.includes(f.tool), `a still finding says to call ${f.tool}, which this server does not register`)
      assert.ok(f.args && f.args.path, `a ${f.tool} fix on a still carries no path, so it cannot be made as it stands`)
      assert.ok(f.why && f.why.length > 10, `a ${f.tool} fix on a still says what to do and not why`)
    }

    // A bare capture on a gradient used to come back "ready, 10", and so did a picture
    // with two title bars in it. A judge that cannot tell those apart is worse than none.
    const bare = Shot.normalize({ look: { background: { kind: 'gradient', gradient: 'ink' } } },
      '/tmp/bare.png', { w: 2720, h: 1560 })
    const b = Review.review({ doc: bare, path: '/tmp/bare.png', looks: [], brief: { what: 'a hero' } })
    assert.ok(b.score < 10, `an untouched capture on a ground scores ${b.score}, so the number means nothing`)
    assert.ok(b.score !== r.score, 'a styled picture and a bare capture score the same')
  })

  t('a capture dropped in the pane is a subject, not a picture to look at', () => {
    // The pane sends every image to the model as an image, because it allows Fetch's
    // tools and nothing that opens a file. A shot is a PNG, so the person's own capture
    // went that way too: the agent could see it and could not style it, since every tool
    // that takes a shot takes its path. It now goes both ways.
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-att-'))
    fs.mkdirSync(path.join(d, 'Original'))
    fs.mkdirSync(path.join(d, '.fetch'))
    const capture = path.join(d, 'Original', 'Library.png')
    const styled = path.join(d, 'Library.png')
    const theirs = path.join(d, 'a-photo.jpg')
    const clip = path.join(d, 'take.mov')
    for (const f of [capture, styled, theirs, clip]) fs.writeFileSync(f, 'x')
    fs.writeFileSync(path.join(d, '.fetch', 'Library.fetchshot.json'), '{}')

    const a = agentChat.splitAttachments([capture, styled, theirs, clip])
    assert.deepStrictEqual(a.shots, [capture, styled], 'a capture Fetch made is not offered as a path to work on')
    assert.ok(a.images.includes(capture) && a.images.includes(theirs), 'a shot stopped going as a picture too')
    assert.ok(!a.shots.includes(theirs), 'an image Fetch did not make is claimed as a shot')
    assert.deepStrictEqual(a.others, [clip], 'a recording no longer travels as a path')
    fs.rmSync(d, { recursive: true, force: true })
  })

  t('no tool asks a still for a moment it does not have', () => {
    // Three tools required `at` and their own descriptions said it was ignored on a
    // shot, so a client that believed the description got an InputValidationError and
    // a client that did not invented a number. One wasted call each, every time, on
    // three of the six tools an agent uses most on a capture.
    for (const name of ['get_frame', 'find_on_screen', 'preview_frame']) {
      const chunk = SRC.split(`'${name}',`)[1] || ''
      const head = chunk.slice(0, chunk.indexOf('async args') + 1 || 4000)
      assert.ok(/at: z\.[\s\S]{0,200}?\.optional\(\)\s*\.describe\(/.test(head),
        `${name} requires at, and its own description says a shot ignores it`)
      assert.ok(!/Ignored on a shot/.test(head), `${name} still calls an argument it demands "ignored"`)
    }
    const step = (SRC.split("'apply_look',")[1] || '').split('async args')[0]
    assert.ok(/step: z\.string\(\)\.optional\(\)/.test(step),
      'apply_look takes no step, so the one change tool that cannot close a plan step is the one a look job starts with')
    const ex = SRC.split("'export',")[1] || ''
    assert.ok(/density/.test(ex.slice(0, ex.indexOf('inputSchema'))),
      'export never says density, so nothing tells a deliverable from a preview')
    const take = SRC.split("'take_shot',")[1] || ''
    assert.ok(/r\.preview && r\.preview\.image/.test(take.slice(0, take.indexOf('server.registerTool') + 1 || undefined)),
      'take_shot hands back no picture of the only artefact it makes')
  })

  t('a still carries a headline, which is what makes a capture a hero', () => {
    // The round's largest single fault: "make it a help centre hero" came back as a
    // window on a gradient, because a hero is the thing with the headline and a shot
    // refused texts by name. Nine of the ten things that refusal listed are about a
    // clock and a title is not one of them. This holds the whole path open, from the
    // sentence a person says to the pixels the compositor sets.
    const Shot = require('../ui/shot')
    const Plan = require('../ui/compositor/plan')
    const src = fs.readFileSync(path.join(__dirname, '..', 'ui', 'agent-bridge.js'), 'utf8')

    // the refusal, which is where it was stopped
    const list = src.slice(src.indexOf('const SHOT_HAS_NO ='), src.indexOf('async function applyToShot'))
    assert.ok(!/\btexts:/.test(list), 'texts is refused on a shot again, so a still cannot carry a headline')
    for (const k of ['clips', 'zooms', 'cues', 'pointer']) {
      assert.ok(new RegExp(`\\b${k}:`).test(list), `${k} is no longer refused on a shot, and one frame has no clock`)
    }

    // the surface, which is where a model has to find it without being told the names
    const edit = SRC.split("'apply_edit',")[1] || ''
    for (const word of ['headline', 'caption', 'callout', 'subtitle', 'hero']) {
      assert.ok(new RegExp(`\\b${word}\\b`).test(edit), `apply_edit never says ${word}, so nothing leads a model from "a hero" to the argument`)
    }
    assert.ok(/texts/.test(edit.split('ON A SHOT')[1] || ''), 'apply_edit\'s shot paragraph does not name texts')
    assert.ok(/brief.what|what: z\.string/.test(SRC.split("'direct',")[1] || ''),
      'direct takes no what, so the one field that says what a picture is for cannot be written down')

    // the pixels, which is where it ends: the compositor lays the type out against the
    // picture rather than against the clock, so a still's text has no times at all
    const shot = Shot.normalize({ look: { preset: 'studio', frame: { aspect: '16:9' } } },
      '/tmp/hero.png', { w: 2880, h: 1720 })
    const line = { id: 'T1', text: 'Find any take in one search', style: 'headline',
      subtitle: 'Every window you recorded, searchable' }
    const plan = Plan.prepare({ ...Shot.toExportOpts(shot), texts: [{ ...line, start: 0, end: Shot.SPAN }] },
      Shot.toMeta(shot), {})
    const drawn = (plan.text && plan.text.still && plan.text.still.runs) || []
    assert.ok(drawn.some(r => r.text === line.text), 'the compositor draws no headline on a still')
    assert.ok(drawn.some(r => r.text === line.subtitle), 'the quieter line under the headline is not drawn')
    assert.ok(plan.text.still.room.top > 0 || plan.text.still.place !== 'above',
      'the headline was given no room, so it would lie over the product')

    // and the document in the middle. Either it carries the text through to what the
    // renderer is handed, or applyToShot says outright that this build dropped it. Both
    // are honest; only the first makes a hero, and a picture with no words and no word
    // said about it is the one outcome this check exists to forbid.
    const carried = Shot.toExportOpts(Shot.mergeShot(shot, { texts: [line] })).texts || []
    assert.ok(carried.length || /keeps no text on a shot/.test(src),
      'a shot drops its texts and nothing says so, so a hero comes back as a capture with no words on it')

    // and the one composition that has nowhere to put type says so rather than drawing
    // none: a look with no ground is the capture edge to edge, and type on that is type
    // on the product.
    assert.ok(!Shot.toExportOpts(Shot.normalize({}, '/tmp/flat.png', { w: 100, h: 100 })).backdrop,
      'the default look now has a ground, so the warning below is aimed at the wrong thing')
    assert.ok(/no ground for the words to stand on/.test(src),
      'a headline on a look with no ground is dropped without a word said')
  })

  // The answer path, run rather than read. A window the person could have seen, a
  // question put into it, the answer sent back the way the pane sends it, and the result
  // the tool hands the agent. Nothing here touches a real window or a real CLI.
  await (async () => {
    const seen = []
    const win = { isDestroyed: () => false, isVisible: () => true,
      webContents: { send: (ch, ev) => seen.push(ev) } }
    bridge.start({ getWindow: () => win, proc: require('../processor'), isRecording: () => false })
    try {
      const asked = bridge.ops['chat.ask']({ question: 'The whole sidebar, or just the button?',
        choices: [{ label: 'The whole sidebar' }, { label: 'Just the Practice button' }] })
      await new Promise(r => setImmediate(r))
      const card = seen.find(e => e.kind === 'ask')
      t('a question reaches the pane as a card with its choices', () => {
        assert.ok(card, 'no ask event reached the window')
        assert.deepStrictEqual(card.choices.map(c => c.id), ['the_whole_sidebar', 'just_the_practice_button'])
        assert.ok(card.timeoutMs > 0, 'a question with no deadline is a turn that never ends')
      })
      assert.ok(bridge.settleWait(card.id, 'answered', 'just_the_practice_button'))
      const out = await asked
      t('the answer comes back as the choice the agent named, with what to do next', () => {
        assert.strictEqual(out.answered, true)
        assert.strictEqual(out.choice, 'just_the_practice_button')
        assert.ok(/do not ask about it again/i.test(out.do_next), 'nothing stops it asking the same thing twice')
      })
      t('the same answer twice settles nothing twice', () => {
        assert.strictEqual(bridge.settleWait(card.id, 'answered', 'the_whole_sidebar'), false)
      })
    } finally { bridge.stop() }
  })()

  t('a tool that waits on a person cannot hang the turn', () => {
    // ask and propose are the only two ops that wait on somebody, so they are the only
    // two that could hold a turn open for ever. Three ways out, all in the source: a
    // window nobody can see resolves at once, a backstop clock runs behind the pane's
    // own, and the end of the turn settles whatever is left.
    const src = fs.readFileSync(path.join(__dirname, '..', 'ui', 'agent-bridge.js'), 'utf8')
    const from = src.indexOf('function putToPane(')
    assert.ok(from > 0, 'the bridge no longer has one place where a card is put to the person')
    const body = src.slice(from, from + src.slice(from).indexOf('\n}\n'))
    assert.ok(/unattended/.test(body), 'a question nobody could see is not answered at once')
    assert.ok(/setTimeout\(/.test(body), 'nothing frees the op if the pane never answers')
    assert.ok(/onTurnEnd\(/.test(src), 'a card can outlive the turn that asked for it')
    for (const op of ['chat.ask', 'chat.propose']) {
      assert.ok(typeof bridge.ops[op] === 'function', `${op} is not in the bridge`)
    }
  })

  t('this round\'s work reached the tool surface', () => {
    // Each of these is a thing the app can now do that no outside agent would find,
    // because the only place it is written down is the description beside it.
    const doc = name => SRC.split(`'${name}',`)[1] || ''
    const edit = doc('apply_edit')
    assert.ok(/camera \{on, x, y, size, keys\}/.test(edit), 'apply_edit does not name the camera\'s keys')
    assert.ok(/\barrow\b/.test(edit), 'apply_edit does not name the arrow mark kind')
    const fit = doc('fit_to_length')
    assert.ok(/stretch\.reach/.test(fit), 'fit_to_length still reads as a tool that can only remove')
    assert.ok(!/a target is a ceiling/.test(fit), 'fit_to_length still calls a target a ceiling')
    assert.ok(/declined: z\.array/.test(doc('review')), 'review takes no declined, so a call the agent made on purpose holds the verdict for ever')
    assert.ok(typeof bridge.ops['memory.remember'] === 'function', 'nothing answers memory.remember')
  })

  t('every tool that works on a recording takes an absolute path', () => {
    for (const { name } of source) {
      const chunk = SRC.split(`'${name}',`)[1] || ''
      const head = chunk.slice(0, chunk.indexOf('async args') + 1 || 4000)
      if (!/path: z\.string\(\)/.test(head)) continue
      assert.ok(/Absolute path/.test(head), `${name} does not say its path is absolute`)
    }
  })

  t('a refusal names what to do instead', () => {
    // A refusal that only says no costs the agent a turn and the person a wait. Every
    // one this round names a call to make or says whose decision it is. An argument
    // check ("path is required") names the argument it wants, which is the same thing.
    const src = fs.readFileSync(path.join(__dirname, '..', 'ui', 'agent-bridge.js'), 'utf8')
    // a tool on this same surface, or whose call it is: those are the only two ways
    // out of a refusal, and one of them has to be in the sentence
    const named = new RegExp(`\\b(${registered.join('|')})\\b|the person`, 'i')
    const dsrc = fs.readFileSync(path.join(__dirname, '..', 'ui', 'director.js'), 'utf8')
    const consts = {
      NO_VOICE_ACCOUNT: (src.match(/const NO_VOICE_ACCOUNT = ([\s\S]*?)\n\n/) || [])[1] || '',
      'Director.NO_BRIEF': (dsrc.match(/const NO_BRIEF = (.*)/) || [])[1] || '',
    }
    for (const op of ['edit.fit', 'edit.revert', 'voice.speak', 'record.pause', 'edit.direct', 'edit.versions']) {
      const from = src.indexOf(`async '${op}'(`)
      assert.ok(from > 0, `${op} is not in the bridge`)
      const body = src.slice(from, from + src.slice(from).indexOf('\n  },'))
      const msgs = [...body.matchAll(/throw new Error\(([\s\S]*?)\)\n/g)]
        .map(m => consts[m[1].trim()] != null ? consts[m[1].trim()] : m[1])
        .filter(m => !/is required/.test(m))
      assert.ok(msgs.length, `${op} refuses nothing that needed saying`)
      for (const msg of msgs) {
        assert.ok(named.test(msg), `${op} refuses without naming a way forward: ${msg}`)
      }
    }
  })

  // Beats are worked out from the take rather than stored on the document, so an op
  // that ranks or drops them has to ask for them. edit.fit read doc.beats alone and
  // got an empty list, so its whole-beat stage had nothing to drop and it stopped 8.7 s
  // over its target while review, which calls beatsFor, saw them fine. This is a source
  // check like the refusal one above: it cannot run the op, but it can insist that
  // whatever hands a document to Fit has fetched the beats first.
  t('an op that fits a length fetches the beats itself', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'ui', 'agent-bridge.js'), 'utf8')
    const from = src.indexOf("async 'edit.fit'")
    assert.ok(from > 0, 'edit.fit is gone from the bridge')
    const body = src.slice(from, from + src.slice(from).indexOf('\n  },'))
    assert.ok(/Fit\.fit\(/.test(body), 'edit.fit no longer calls Fit.fit')
    assert.ok(/beatsFor\(/.test(body), 'edit.fit hands Fit a document whose beats it never fetched')
  })

  // The same shape, found by looking for it. Captions live in a .srt that transcribe
  // writes; they reach the document only when the editor opens the take and saves it
  // back. So every op that reads a document off disk and then reasons about what was
  // said was reading an empty list: review told an agent to transcribe a take it had
  // just transcribed, voiceover refused to speak a script that was already there, and
  // direct counted no captions. The renderers were never affected, because both of them
  // fall back to the .srt themselves.
  t('an op that reasons about the captions fetches them itself', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'ui', 'agent-bridge.js'), 'utf8')
    assert.ok(/function withCues\([\s\S]*?readCues\(/.test(src), 'withCues no longer reads the .srt')
    for (const op of ['edit.review', 'edit.direct', 'edit.fit', 'voice.speak']) {
      const from = src.indexOf(`async '${op}'(`)
      assert.ok(from > 0, `${op} is not in the bridge`)
      const body = src.slice(from, from + src.slice(from).indexOf('\n  },'))
      assert.ok(/withCues\(/.test(body), `${op} reads a document's cues and never fetches them`)
    }
  })

  // ── this round: identifiers, versions, the preview, the sound ─────────────
  // The judged device job's one wasted call: direct wrote a bundle id into ready's app,
  // which takes a path to a built .app, and ready found out after the person said yes
  // and the device booted. Every simulator argument takes one kind of identifier, and
  // the form of each is read before anything is asked or spawned.
  t('a bundle id sent as app is launched as bundle, and the result says it moved', () => {
    const r = bridge.simArgs('ready', { action: 'ready', device: 'Yolk-ProMax', app: 'com.yolkling.ios' })
    assert.strictEqual(r.args.bundle, 'com.yolkling.ios')
    assert.strictEqual(r.args.app, undefined)
    assert.match(r.moved[0], /app takes the path to a built \.app/)
    // two different ids in the two places is not a thing Fetch can settle for anyone
    assert.throws(() => bridge.simArgs('ready', { app: 'com.a.b', bundle: 'com.c.d' }), /send it as bundle.*Nothing was asked/s)
  })

  t('a built .app sent as bundle is installed as app, and one that is not there is refused before the dialog', () => {
    const built = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-app-')) + '/Yolkling.app'
    fs.mkdirSync(built)
    try {
      const r = bridge.simArgs('ready', { bundle: built })
      assert.strictEqual(r.args.app, built)
      assert.strictEqual(r.args.bundle, undefined)
      assert.match(r.moved[0], /installed as app/)
      assert.throws(() => bridge.simArgs('ready', { app: built + '-gone.app' }),
        /no app bundle at .*send\s+bundle to launch an app already on the device\. Nothing was asked/s)
      assert.throws(() => bridge.simArgs('ready', { app: 'build/Yolkling.app' }), /absolute path to a built \.app/)
      assert.throws(() => bridge.simArgs('ready', { app: 'Yolkling' }), /absolute path to a built \.app, and "Yolkling" is not one/)
    } finally { fs.rmSync(path.dirname(built), { recursive: true, force: true }) }
  })

  t('the other simulator arguments are read for their kind of identifier too', () => {
    assert.throws(() => bridge.simArgs('go', { url: 'com.yolkling.ios' }), /url takes a link with a scheme.*ready with bundle launches/s)
    assert.doesNotThrow(() => bridge.simArgs('go', { url: 'yolkling://onboarding' }))
    assert.throws(() => bridge.simArgs('tap', { element: 'Sign in with Apple' }), /element takes an id like E12.*find_on_screen/s)
    assert.doesNotThrow(() => bridge.simArgs('tap', { element: 'e18' }))
    assert.doesNotThrow(() => bridge.simArgs('tap', { element: 'R2' }))
    assert.match(bridge.deviceHint('com.yolkling.ios'), /bundle id: device takes a UDID or the device's name/)
    assert.match(bridge.deviceHint('4312'), /window id from list_windows/)
    assert.strictEqual(bridge.deviceHint('Yolk-ProMax'), '')
    // before anything is asked or spawned, in the op itself
    const src = fs.readFileSync(path.join(__dirname, '..', 'ui', 'agent-bridge.js'), 'utf8')
    const from = src.indexOf("async 'sim.do'(")
    const body = src.slice(from, from + src.slice(from).indexOf('\n  },'))
    assert.ok(body.indexOf('simArgs(') > 0 && body.indexOf('simArgs(') < body.indexOf('simModel('),
      'the identifiers are read after simctl is spawned')
    const ready = src.slice(src.indexOf('async function simReady('))
    assert.ok(ready.indexOf('bundleIdOf(') < ready.indexOf('simAsk('), 'a built app is asked about before its id is known')
  })

  t('each identifier argument says in its description what it takes and what it is not', () => {
    const chunk = SRC.split("'simulator',")[1]
    assert.match(chunk, /app: z\.string\(\)[\s\S]{0,260}Not a bundle id: that is bundle/)
    assert.match(chunk, /bundle: z\.string\(\)[\s\S]{0,200}Not a path: that is app/)
    assert.match(chunk, /url: z\.string\(\)[\s\S]{0,200}with its scheme/)
    assert.match(chunk, /element: z\.string\(\)[\s\S]{0,260}never the words on the button/)
    const direct = SRC.split("'direct',")[1]
    assert.match(direct, /app: z\.string\(\)[\s\S]{0,400}a bundle id as bundle, a path as app/)
  })

  // Version history, reachable by an agent: list, look, restore, run against the real
  // history log (ui/history.js) behind a stand-in editor, the way ui/autosave.js holds it.
  await (async () => {
    const vm = require('vm')
    const History = require('../ui/history')
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-versions-'))
    const take = path.join(home, 'Onboarding.mov')
    fs.writeFileSync(take, '')
    let text = '', clock = 1.79e12
    const log = History.createLog({ io: { read: () => text, append: x => { text += x }, replace: x => { text = x } }, now: () => clock })
    const base = { v: 1, src: take, dur: 10, clips: [{ id: 'C1', start: 0, end: 10 }], zooms: [], marks: [], texts: [], look: {} }
    let live = base
    log.open(live)
    clock += 60e3
    live = { ...live, zooms: [{ id: 'Z1', start: 1, end: 3, scale: 2, x: 0.5, y: 0.5 }], nextId: { Z: 2 } }
    log.person(live); log.flush()
    clock += 60e3
    const before = live
    live = { ...live, zooms: [...live.zooms, { id: 'Z2', start: 5, end: 7, scale: 1.6, x: 0.3, y: 0.4 }], nextId: { Z: 3 } }
    log.agent(before, live, 'Claude Code')
    const restoredBy = []
    const context = vm.createContext({ window: {
      fetchDoc: { src: () => take, get: () => live },
      fetchHistory: {
        src: () => take, rows: () => log.rows(), flush: () => log.flush(), version: n => log.version(n),
        restore: (n, o) => { restoredBy.push(o && o.by); const r = log.restore(n, live, { exists: () => true, by: o.by }); if (r) live = r.doc; return r },
      },
    }, openInEditor: () => {} })
    const win = { isDestroyed: () => false, isVisible: () => true, webContents: { send: () => {},
      executeJavaScript: expr => Promise.resolve(JSON.parse(JSON.stringify(vm.runInContext(expr, context) ?? null))) } }
    bridge.start({ getWindow: () => win, proc: require('../processor'), isRecording: () => false })
    try {
      const list = await bridge.ops['edit.versions']({ path: take }, { client: 'Codex' })
      t('versions lists every version newest first, with who made it', () => {
        assert.deepStrictEqual(list.versions.map(v => v.id), ['V3', 'V2', 'V1'])
        assert.deepStrictEqual(list.versions.map(v => v.by), ['Claude Code', 'the person', 'the person'])
        assert.match(list.versions[0].line, /Added Z2/)
        assert.match(list.how, /V3 is the edit as it stands now/)
      })
      const look = await bridge.ops['edit.versions']({ path: take, action: 'look', version: 'v2' }, { client: 'Codex' })
      t('look shows a version and what restoring it would change, and changes nothing', () => {
        assert.strictEqual(look.version.id, 'V2')
        assert.match(look.restoring_it_would, /^removed Z2/)
        assert.deepStrictEqual(look.edit.zooms.map(z => z.id), ['Z1'])
        assert.ok(look.preview && (look.preview.image || look.preview.error), 'no frame and no word about why')
        assert.deepStrictEqual(live.zooms.map(z => z.id), ['Z1', 'Z2'], 'looking changed the edit')
        assert.strictEqual(log.rows().length, 3, 'looking wrote a version')
      })
      const back = await bridge.ops['edit.versions']({ path: take, action: 'restore', version: 'V2' }, { client: 'Codex' })
      t('restore is a new version on top, by the agent, and names the call that takes it back', () => {
        assert.strictEqual(back.restored, 'V2')
        assert.strictEqual(back.as, 'V4')
        assert.deepStrictEqual(restoredBy, ['Codex'])
        assert.deepStrictEqual(log.rows().map(r => r.id), ['V4', 'V3', 'V2', 'V1'], 'something ahead of it was lost')
        assert.strictEqual(log.rows()[0].by, 'Codex')
        assert.match(back.undo, /version: 'V3'/)
        assert.deepStrictEqual(back.edit.zooms.map(z => z.id), ['Z1'])
        assert.strictEqual(live.nextId.Z, 3, 'the id counter went backwards, so Z2 could name two zooms')
      })
      let refused = null
      try { await bridge.ops['edit.versions']({ path: take, action: 'look', version: 'V9' }) } catch (e) { refused = e.message }
      t('a version that is not there is refused with the ones that are', () => {
        assert.match(refused || '', /"V9" is not a version of this take: versions with action list names them.*V4 is now and V1/s)
      })
    } finally { bridge.stop(); fs.rmSync(home, { recursive: true, force: true }) }
  })()

  t('an agent\'s change is recorded under its own name, not "Agent"', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'ui', 'agent-bridge.js'), 'utf8')
    const applies = [...src.matchAll(/\.apply\(\$\{JSON\.stringify\([^`]*`/g)].map(m => m[0])
    assert.ok(applies.length >= 4, `${applies.length} applies found`)
    for (const a of applies) assert.ok(/byArg\(ctx\)/.test(a), 'an apply with no author: ' + a)
    assert.ok(/fetchUndo\.undo\([^`]*byArg\(ctx\)/.test(src), 'revert_my_edit is recorded as nobody in particular')
    // fit_to_length, an accepted proposal and voiceover apply through edit.apply; without
    // ctx their versions were credited to "Agent"
    const calls = src.split("ops['edit.apply'](").slice(1)
    assert.strictEqual(calls.length, 3)
    for (const c of calls) assert.ok(/\}\s*\}?,\s*ctx\)/.test(c.slice(0, 260)), 'an edit.apply with no client: ' + c.slice(0, 80))
    // and while the person looks at an old version, the bridge reads the edit held aside
    assert.ok(!/inEditor\([^)]*'window\.fetchDoc\.get\(\)'\)/.test(src) && /window\.fetchHistory\.current\(\)/.test(src), 'a read of the stage while peeking')
  })

  // The app preview, as the file is: its length and its rate are read off what was
  // written, the take is drawn at the box the gate judged, and one refusal names all.
  t('export reports the written file and holds it to the edit and the rate', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'ui', 'agent-bridge.js'), 'utf8')
    const from = src.indexOf("async 'edit.export'(")
    const body = src.slice(from, from + src.slice(from).indexOf('\n  },'))
    assert.ok(/opts\.box = \{ \.\.\.want\.box \}/.test(body), 'the take is not drawn at plan.box')
    assert.ok(/clipVerdict\(want, r && r\.file,\s*\{ expect: FD\.outDuration\(doc\), kbps:/.test(body), 'store is not held to the edit and the rate')
    assert.ok(/r\.written\.frames/.test(body), 'seconds is the plan\'s, not the file\'s')
    assert.ok(/lengthPlan\(/.test(body), 'an upscale refusal holds back the length for a second call')
    assert.ok(/stepFor\(/.test(body), 'the deliverable does not close the plan')
    const verdict = src.slice(src.indexOf('async function clipVerdict('))
    assert.ok(/expect: made\.expect, bps: made\.kbps/.test(verdict.slice(0, 1200)))
  })

  t('what a take\'s sound says about sync is what was measured', () => {
    const late = bridge.soundSync({ hasAudio: true, audioLead: 2.303 }, null)
    assert.strictEqual(late.starts_s, 2.303)
    assert.match(late.said, /starts 2\.303 s after its picture.*puts that start back at its own time/s)
    assert.strictEqual(late.in_sync, null, 'a start put back is not sync until the end is measured')
    // The judged take: its sound starts 2.303 s late and ends 1.71 s early. The start is put
    // back on every export, and the loss inside the file is not, so it is not in sync.
    const judged = bridge.soundSync({ hasAudio: true, audioLead: 2.303, duration: 38, fps: 60, audioEnd: 36.286 }, null)
    assert.strictEqual(judged.in_sync, false, 'sound lost inside the file was called in sync')
    assert.strictEqual(judged.ends_early_s, 1.714)
    assert.match(judged.said, /ends 1\.71 s before the picture.*drifts ahead/s)
    const whole = bridge.soundSync({ hasAudio: true, audioLead: 0, duration: 8.873, fps: 30, audioEnd: 8.873 }, null)
    assert.strictEqual(whole.in_sync, true)
    assert.match(whole.said, /starts with the picture and ends with it/)
    const tail = bridge.soundSync({ hasAudio: true, audioLead: 0, duration: 10, fps: 60, audioEnd: 9.96 }, null)
    assert.strictEqual(tail.in_sync, true, 'the 40 ms a stream loses at Stop is not drift')
    const padded = bridge.soundSync({ hasAudio: true, audioLead: 0 },
      [{ track: 'system', leadMs: 14, gaps: 2, gapMs: 40, lostMs: 0, tailMs: 38 }])
    assert.strictEqual(padded.filled_ms, 54)
    assert.match(padded.said, /started 14 ms after the first frame.*2 stretches \(40 ms\)/s)
    assert.strictEqual(padded.lost_ms, undefined)
    assert.match(bridge.soundSync({ hasAudio: true, audioLead: 0 }, null).said, /starts with the picture/)
    assert.strictEqual(bridge.soundSync({ hasAudio: false }, null), null, 'a take with no sound has no sync to report')
    const lost = bridge.soundSync({ hasAudio: true, audioLead: 0 }, [{ leadMs: 0, lostMs: 120 }])
    assert.match(lost.said, /120 ms of sound was let go/)
  })

  t('a silent take stays silent to review, and a late yes does not act for a stopped agent', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'ui', 'agent-bridge.js'), 'utf8')
    assert.ok(/heardSilent\.has\(file\)/.test(src), 'review still offers transcribe on a take record_stop called silent')
    const ask = src.slice(src.indexOf('async function askPerson('))
    assert.ok(/deps\.held && deps\.held\(\)/.test(ask.slice(0, 2400)), 'a yes after Esc still acts')
    assert.strictEqual(typeof bridge.forgetConsent, 'function')
    assert.ok(/still: doc && doc\.kind === 'shot' \? true : null/.test(src), 'a recording is called a still frame')
  })

  // ── this round: the capture service, ids that stay put, a Stop that ends ──────
  // replayd crashed 25 times under window takes with sound. The fix took the list of
  // apps out of the sound's filter (Recorder.swift start), so a window take's sound is
  // now everything the Mac plays. Every sentence a person or a model reads about that
  // scope has to say so, in both directions: nothing may promise the old exclusion, and
  // the recorder has to really have given it up before anything says it did.
  t('what a take is said to hear is the scope the recorder has now', () => {
    const rec = fs.readFileSync(path.join(__dirname, '..', 'Recorder.swift'), 'utf8')
    const namesApps = /excludingApplications|including:\s*\[?SCRunningApplication|SCContentFilter\([^)]*applications/.test(rec)
    const OLD = /windows were open (at the start|when it started)|not in the exclusion list|apps whose windows|the window's own sound|that window\\'s own sound|leaves\s+other apps out/i
    const bridgeSrc = fs.readFileSync(path.join(__dirname, '..', 'ui', 'agent-bridge.js'), 'utf8')
    if (!namesApps) {
      for (const [where, src] of [['mcp/index.js', SRC], ['ui/agent-bridge.js', bridgeSrc]]) {
        assert.ok(!OLD.test(src), `${where} still promises a window take leaves other apps out of its sound, which ` +
          'Recorder.swift no longer does: ' + (src.match(OLD) || [''])[0])
      }
      // the question the person answers says the scope they are agreeing to
      const ask = bridgeSrc.slice(bridgeSrc.indexOf('const heardSaid'), bridgeSrc.indexOf('const answer = await askPerson('))
      assert.ok(/everything this Mac plays/.test(ask), 'the approval asks about a narrower sound than the take records')
      assert.match(String(server._registeredTools.simulator.description), /everything this Mac plays while it records/)
    } else {
      assert.ok(!/everything this Mac plays/.test(bridgeSrc.slice(bridgeSrc.indexOf('const heardSaid'), bridgeSrc.indexOf('const answer = await askPerson('))),
        'the approval says the whole Mac is heard and Recorder.swift names apps again')
    }
    // The shared sentences live in ui/recorder-opts.js, and record_start's description and
    // result read them, so they are held to the same scope.
    const Opts = require('../ui/recorder-opts')
    const stale = ['SIM_AUDIO_SAID', 'SYS_AUDIO_ARG_SAID'].filter(k => !namesApps && OLD.test(Opts[k] || ''))
      .concat(!namesApps && /windows were open|left out/.test(Opts.startedAudio({ systemAudio: true }).note) ? ['SCOPE_SAID'] : [])
    assert.deepStrictEqual(stale, [], 'ui/recorder-opts.js says a window take leaves other apps out of its sound, and ' +
      'Recorder.swift no longer does: ' + stale.join(', '))
    if (!namesApps) {
      assert.match(Opts.SIM_AUDIO_SAID, /everything this Mac plays/, 'record_start\'s description does not say the scope')
      assert.match(String(server._registeredTools.record_start.description), /everything this Mac plays/)
    }
  })

  t('a pass that kept numbering on is told from one that started again at E1', () => {
    const T = require('../ui/targets')
    const words = (text, y) => ({ text, conf: 1, box: { x: 0.3, y, w: 0.3, h: 0.018 }, bg: '#FFFFFF', bgShare: 0.9 })
    const A = { width: 1400, height: 2900, texts: [words('Tip', 0.05), words('Yolk', 0.2), words('Continue', 0.7), words('Sign in with Apple', 0.77)] }
    const B = { width: 1400, height: 2900, texts: [words('Yolk', 0.2), words('Continue', 0.7), words('Sign in with Apple', 0.77)] }
    const a = T.elementsFrom(A)
    assert.strictEqual(bridge.carriedOn(a, T.elementsFrom(B, a)), true, 'a carried list is not taken as carried')
    assert.strictEqual(bridge.carriedOn(a, T.elementsFrom(B)), false, 'a list numbered from E1 again is taken as carried')
    assert.strictEqual(bridge.carriedOn(null, T.elementsFrom(B)), false)
    // nothing in common, still numbered on: every id is new, and none is reused
    const C = { width: 1400, height: 2900, texts: [words('Settings', 0.2)] }
    assert.strictEqual(bridge.carriedOn(a, T.elementsFrom(C, a)), true)
    // through JSON, where seq is gone and the ids are all there is
    const b = T.elementsFrom(B, a)
    assert.strictEqual(bridge.carriedOn(JSON.parse(JSON.stringify(a)), b), true)
    // A screen where nothing was found, then one numbered from E1: the empty list handed
    // out nothing, so the E1 list is not a carry, and an id held from before is not trusted.
    const empty = T.elementsFrom({ width: 1400, height: 2900, texts: [] })
    assert.strictEqual(bridge.carriedOn(empty, T.elementsFrom(B)), false, 'a list after an empty one is taken as carried')
    // the same empty screen, reached by a pass that kept the count, keeps the run going
    const emptyOn = T.elementsFrom({ width: 1400, height: 2900, texts: [] }, a)
    assert.strictEqual(bridge.carriedOn(a, emptyOn), true, 'an empty screen that kept the count broke the run')
    assert.strictEqual(bridge.carriedOn(emptyOn, T.elementsFrom(B, emptyOn)), true)
    assert.ok(T.elementsFrom(B, emptyOn).every(e => +e.id.slice(1) > a.length), 'ids after an empty screen reuse old numbers')
  })

  // find_on_screen twice on one moment, against a processor that honours prior and one
  // that does not, with the judged screens: E18 on the first picture, one line gone above
  // it on the second.
  await (async () => {
    const T = require('../ui/targets')
    const words = (text, x, y, w, h = 0.018) => ({ text, conf: 1, box: { x, y, w, h }, bg: '#FFFFFF', bgShare: 0.9 })
    const base = [words('Yolk', 0.44, 0.2, 0.12, 0.04), words('Breakfast, planned for you', 0.3, 0.26, 0.4),
      words('Continue with Google', 0.3, 0.7, 0.4), words('Sign in with Apple', 0.3, 0.77, 0.4)]
    const READY = { width: 1400, height: 2900, texts: [words('Save screen', 0.8, 0.05, 0.08), ...base] }
    const LATER = { width: 1400, height: 2900, texts: base }
    let raw = READY, honour = true
    const stub = {
      probeMeta: async () => ({ duration: 10 }),
      readDoc: () => ({}),
      findOnScreen: async (p, at, o = {}) => {
        const all = T.elementsFrom(raw, honour ? o.prior : null)
        return { image: '/tmp/none.jpg', at, width: raw.width, height: raw.height, found: all.length, elements: all, all }
      },
    }
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-ids-'))
    const take = path.join(home, 'Yolk.mov')
    fs.writeFileSync(take, '')
    const win = { isDestroyed: () => false, isVisible: () => true, webContents: { send: () => {}, executeJavaScript: async () => null } }
    bridge.start({ getWindow: () => win, proc: stub, isRecording: () => false })
    try {
      const idOf = (r, name) => (r.elements.find(e => e.text === name) || {}).id
      const first = await bridge.ops.find({ path: take, at: 2 })
      raw = LATER
      const second = await bridge.ops.find({ path: take, at: 2.4 })
      t('a second find_on_screen of the same moment keeps the id of what it finds again', () => {
        assert.strictEqual(idOf(first, 'Sign in with Apple'), 'E5')
        assert.strictEqual(idOf(second, 'Sign in with Apple'), 'E5', 'the button was renumbered by a line going above it')
        assert.ok(!second.elements.some(e => e.id === idOf(first, 'Save screen')), 'a gone element\'s id went to another')
      })
      // a moment far off is another screen, and is numbered afresh as it always was
      honour = true; raw = READY
      await bridge.ops.find({ path: take, at: 2 })
      raw = LATER
      const far = await bridge.ops.find({ path: take, at: 8 })
      t('a search of another moment is not handed the earlier list', () => {
        assert.strictEqual(idOf(far, 'Sign in with Apple'), 'E4')
      })
    } finally { bridge.stop(); fs.rmSync(home, { recursive: true, force: true }) }
  })()

  t('every picture of a device is handed the last one, and a tap trusts only a run that really carried', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'ui', 'agent-bridge.js'), 'utf8')
    const screen = src.slice(src.indexOf('async function simScreen('), src.indexOf('async function simScreen(') + 2400)
    assert.ok(/findOnScreen\(file, 0, \{[^}]*prior \}\)/.test(screen), 'simScreen mints each device screen afresh')
    assert.ok(/joinRun\(sim\.udid, file, prior,/.test(screen), 'simScreen never checks the carry happened')
    const point = src.slice(src.indexOf('async function simPoint('), src.indexOf('function devicePoint('))
    assert.ok(/chainOf\.get\(lastFoundOn\) === sim\.udid/.test(point), 'a bare id is trusted off a picture outside the run')
    assert.ok(/!holds\(foundBy\.get\(seenHere\), id\)/.test(point), 'an id the newest screen lacks is not refused by name')
    const find = src.slice(src.indexOf('  async find('), src.indexOf("  async 'edit.preview'("))
    assert.ok(/foundBy\.get\(args\.path\)/.test(find) && !/foundFor\.get\(args\.path\)/.test(find),
      'find is handed a background pass\'s list, which would carry ids the agent never saw')
  })

  t('a take whose sound stopped part way says so, though its track runs to the end', () => {
    // The recorder fills a track to Stop with silence, so a sound stream that dropped
    // mid take ends with the picture and nothing else would notice.
    const clean = bridge.soundSync({ hasAudio: true, audioLead: 0, duration: 3.01, fps: 30, audioEnd: 3.01 },
      [{ track: 'system', leadMs: 0, gaps: 0, gapMs: 0, lostMs: 0, tailMs: 53 }])
    assert.strictEqual(clean.silent_end_ms, undefined, 'a clean Stop\'s last buffers were called a sound that stopped')
    assert.strictEqual(clean.in_sync, true)
    const cut = bridge.soundSync({ hasAudio: true, audioLead: 0, duration: 30, fps: 30, audioEnd: 30 },
      [{ track: 'system', leadMs: 0, gaps: 0, gapMs: 0, lostMs: 0, tailMs: 21400 }])
    assert.strictEqual(cut.silent_end_ms, 21400)
    assert.match(cut.said, /system sound stopped arriving 21\.40 s before the take was stopped/)
    assert.match(String(server._registeredTools.record_stop.description), /audio\.sync\.silent_end_ms/)
  })

  // Stop in the pane is over in bounded time, even under a CLI that will not go. The
  // stand-in ignores SIGTERM the way a CLI sitting on a tool call can.
  await (async () => {
    const connect = require('../ui/agent-connect')
    const was = connect.binFor
    const fake = path.join(dir, 'stubborn-cli')
    const armed = path.join(dir, 'stubborn-armed')
    // it says when SIGTERM is ignored, so a slow start under load is not read as a Stop
    fs.writeFileSync(fake, `#!/bin/sh\ntrap "" TERM\ntouch '${armed}'\nexec sleep 30\n`, { mode: 0o755 })
    connect.binFor = () => fake
    try {
      const done = new Promise(resolve => {
        agentChat.send({ engine: 'claude', prompt: 'hold' }, ev => { if (ev.kind === 'done') resolve(ev) })
      })
      for (let i = 0; i < 100 && !fs.existsSync(armed); i++) await new Promise(r => setTimeout(r, 50))
      const t0 = Date.now()
      agentChat.cancel()
      const bound = agentChat.STOP_KILL_MS + agentChat.STOP_END_MS
      const ev = await Promise.race([done, new Promise(r => setTimeout(() => r(null), bound + 1500))])
      const took = Date.now() - t0
      t('Stop ends the turn in bounded time when the CLI ignores being asked', () => {
        assert.ok(ev, `the turn was still running ${bound + 1500} ms after Stop`)
        assert.strictEqual(ev.cancelled, true, 'a Stop ended as an error')
        assert.ok(took >= agentChat.STOP_KILL_MS - 100 && took <= bound + 500, `${took} ms`)
        assert.strictEqual(agentChat.busy(), false, 'the pane is still busy after Stop')
      })
    } finally { connect.binFor = was }
  })()

  // ── this round: rules before acting, a sample to try, an export that stops ──
  // Three things the pieces built that no agent could reach until they were wired here:
  // a product's rules (ui/guidelines.js), the sample library (ui/sample.js) and a cancel
  // that reaches a running export (ui/job-queue.js). Each is held both ways, like the
  // rest of the surface: the tool exists, and what it promises really happens.
  t('the rules and the sample are on the surface, and the pane has them', () => {
    assert.deepStrictEqual(source.find(s => s.name === 'guidelines').ops, ['memory.guidelines'])
    assert.deepStrictEqual(source.find(s => s.name === 'sample').ops, ['sample.do'])
    for (const name of ['guidelines', 'sample']) assert.ok(bare.includes(name), name + ' is not in the pane')
    const say = server.server._instructions || ''
    assert.match(say, /guidelines before you plan, capture or style/, 'an outside agent is not told to read the rules first')
    // a draft is the agent's, and the description says it is nothing until the person says yes
    const g = String(server._registeredTools.guidelines.description)
    assert.match(g, /show that text to the person, and adopt only the ids they said yes to/)
  })

  t('a cancelled call stops its export where it runs', () => {
    // job.cancel is the server's own and no model's, so it is plumbing and has no tool
    assert.ok(typeof bridge.ops['job.cancel'] === 'function')
    assert.ok(!registered.includes('job_cancel'))
    const chunk = SRC.split("'export',")[1] || ''
    assert.ok(/stoppable\(job => drive\('edit\.export', \{ \.\.\.args, job \}/.test(chunk.slice(0, 9000)),
      'export does not hand the app a key to stop it by')
    const build = SRC.slice(SRC.indexOf('const stoppable'), SRC.indexOf('server.registerTool('))
    assert.ok(/addEventListener\('abort', stop/.test(build) && /drive\('job\.cancel', \{ job \}\)/.test(build),
      'a client\'s cancel never reaches the app')
    assert.ok(/did not answer/.test(build), 'an export this side gave up on is left running')
  })

  // The three behaviours, against the real queue, the real rulebook and a real sample
  // folder, with only the processor and the window stood in.
  await (async () => {
    const Q = require('../ui/job-queue')
    const FD = require('../ui/fetchdoc')
    const Sample = require('../ui/sample')
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-round-'))
    const root = path.join(home, 'Fetch Sample')
    fs.mkdirSync(root)
    fs.writeFileSync(path.join(root, Sample.MARK), '{}\n')
    const title = 'Biscuit\'s Pantry · Adding a recipe'
    const take = path.join(root, title, 'Original', title + '.mp4')
    fs.mkdirSync(path.dirname(take), { recursive: true })
    fs.writeFileSync(take, '')
    const theirs = path.join(home, 'Theirs.mp4')
    fs.writeFileSync(theirs, '')
    // Outside Electron the bridge's own memory folder is tmpdir. Put back whatever was
    // there, so a regression that files the sample's rules there does not outlive the run.
    const theirMemory = path.join(os.tmpdir(), 'memory.json')
    const memoryWas = fs.existsSync(theirMemory) ? fs.readFileSync(theirMemory) : null
    let docs = new Map(), wrote = [], exported = [], stopped = 0
    let texts = []
    const stub = {
      probeMeta: async () => ({ duration: 10 }),
      readDoc: p => docs.get(p) || FD.normalize({}, p, 10),
      writeDoc: (p, d) => { wrote.push({ p, d }); docs.set(p, d) },
      findOnScreen: async (p, at) => {
        const all = texts.map((t, i) => ({ id: 'E' + (i + 1), text: t, kind: 'text', box: { x: 0.1, y: 0.1 * (i + 1), w: 0.3, h: 0.05 },
          background: {}, confidence: 1 }))
        return { image: '/tmp/none.jpg', at, width: 1000, height: 1000, found: all.length, elements: all, all }
      },
    }
    const win = { isDestroyed: () => false, isVisible: () => true, webContents: { send: () => {}, executeJavaScript: async () => null } }
    // an export as main.js submits one, whose work only ends when it is stopped
    const exportDoc = (src, opts) => Q.submit({ id: 'agent:export:' + Date.now() + Math.random(), op: 'export',
      run: () => new Promise((resolve, reject) => {
        exported.push({ src, opts })
        if (opts && opts.hold === false) return resolve({ file: null })
        Q.onCancel(() => { stopped++; reject(Object.assign(new Error('cancelled'), { cancelled: true })) })
      }) })
    let hold = true, personSays = true, asked = []
    bridge.start({ getWindow: () => win, proc: stub, isRecording: () => false,
      confirmRules: async (product, texts) => { asked.push({ product, texts }); return personSays },
      exportDoc: (src, opts, key) => exportDoc(src, { ...opts, hold }, key) })
    try {
      // the rules: what the person says is in force at once, and kept with the sample
      const w = await bridge.ops['memory.guidelines']({ path: take,
        rules: [{ rule: 'Never show the admin panel', section: 'never', from: 'person' },
          { rule: 'Avoid "simply", say "just"', section: 'words', from: 'person' },
          { rule: 'Screenshots sit on a warm cream background', section: 'look', from: 'screen', evidence: 'the landing page' }] })
      t('a rule the person gives is in force, and one the agent read off the product is a draft', () => {
        assert.strictEqual(w.ok, true)
        const by = Object.fromEntries(w.written.map(x => [x.section, x]))
        assert.strictEqual(by.never.draft, false)
        assert.strictEqual(by.look.draft, true, 'a rule read off a screen went into force without the person')
        assert.match(w.guidelines.text, /Rules for Biscuit's Pantry/)
      })
      t('a rule sent as the person\'s is put to the person in Fetch, word for word, before it is in force', () => {
        assert.deepStrictEqual(asked.map(a => a.texts), [['Never show the admin panel', 'Avoid "simply", say "just"']])
      })
      // the person says no: nothing goes into force on the agent's word alone
      personSays = false
      const vouched = await bridge.ops['memory.guidelines']({ path: take,
        rules: [{ rule: 'Never show the billing page', section: 'never', from: 'person' }] })
      const shown = await bridge.ops['memory.guidelines']({ path: take, action: 'show' })
      const forced = await bridge.ops['memory.guidelines']({ path: take, action: 'adopt', ids: shown.drafts.map(d => d.id), seal: shown.seal })
      t('a rule the person did not confirm is a draft, and an adopt they did not confirm is refused', () => {
        assert.strictEqual(vouched.written[0].draft, true, 'the agent\'s word put a rule in force')
        assert.match(vouched.unconfirmed, /kept as drafts/)
        assert.strictEqual(forced.ok, false)
        assert.strictEqual(forced.refused.kind, 'person')
        const inForce = require('../ui/guidelines').read({ root, product: 'Biscuit\'s Pantry' }).rules
        assert.ok(!Object.values(inForce).flat().some(r => /billing page/.test(r.text)), 'the unconfirmed rule is in force')
      })
      personSays = true
      t('what is kept about the sample is kept in the sample, and never in the person\'s memory', () => {
        assert.ok(fs.existsSync(path.join(root, 'memory.json')), 'the sample\'s rules were not kept in the sample')
        const mine = path.join(os.tmpdir(), 'memory.json')
        const txt = fs.existsSync(mine) ? fs.readFileSync(mine, 'utf8') : ''
        assert.ok(!/admin panel/.test(txt), 'a rule about the made up product went into the person\'s own memory')
      })
      texts = ['Recipes', 'Admin panel', 'Settings']
      const seen = await bridge.ops.find({ path: take, at: 1 })
      texts = ['Recipes', 'Settings']
      const clean = await bridge.ops.find({ path: take, at: 1 })
      t('a thing the rules keep off screen is named the moment an agent looks at it', () => {
        assert.ok(seen.never_on_screen && seen.never_on_screen.some(h => h.label === 'Admin panel' && h.id === 'E2'),
          JSON.stringify(seen.never_on_screen))
        assert.match(seen.rule, /must never be on screen/)
        assert.strictEqual(clean.never_on_screen, undefined, 'a clean picture was said to break a rule')
      })
      const guard = await bridge.ops['memory.guidelines']({ path: take, action: 'check', text: 'Simply tap Save' })
      t('the words an edit uses are held to the words the product avoids', () => {
        assert.strictEqual(guard.clean, false)
        assert.strictEqual(guard.words[0].instead, 'just')
      })

      // a corner stored wrong is not drawn, and is taken off the document
      docs.set(theirs, FD.normalize({ viewport: { x: 0.05, y: 0.05, w: 0.9, h: 0.9, corner: 0.0535 },
        device: { name: 'iPhone 16 Pro Max', screen: { w: 1320, h: 2868, scale: 3 } } }, theirs, 10))
      hold = false
      await bridge.ops['edit.export']({ path: theirs })
      t('a stored corner that fails the check is not drawn and not kept', () => {
        const drawn = exported[exported.length - 1].opts
        assert.ok(drawn.viewport && !(+drawn.viewport.corner > 0), 'the export drew a third of the real corner: ' + JSON.stringify(drawn.viewport))
        // dropped where the document is read (ui/fetchdoc.js cleanViewport), so no reader
        // is ever handed it again, the person's own export and the editor included
        assert.ok(docs.get(theirs).viewport && docs.get(theirs).viewport.corner == null, 'the wrong corner is still on the document as read')
        const last = wrote.filter(x => x.p === theirs).pop()
        assert.ok(!last || !last.d.viewport || last.d.viewport.corner == null, 'a wrong corner was written back')
      })
      docs.set(theirs, FD.normalize({ viewport: { x: 0.05, y: 0.05, w: 0.9, h: 0.9, corner: 0.1578 },
        device: { name: 'iPhone 16 Pro Max', screen: { w: 1320, h: 2868, scale: 3 } } }, theirs, 10))
      await bridge.ops['edit.export']({ path: theirs })
      t('a stored corner that passes is drawn as it is', () => {
        assert.strictEqual(+exported[exported.length - 1].opts.viewport.corner, 0.1578)
      })

      // leaving the sample stops an export of a sample take, and never one of the person's
      hold = true
      const within = (p, ms) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(`still running ${ms} ms after the stop`)), ms))])
      {
        const inSample = bridge.ops['edit.export']({ path: take }); inSample.catch(() => {})
        const mine = bridge.ops['edit.export']({ path: theirs }); mine.catch(() => {})
        for (let i = 0; i < 40 && Q.jobs().running.length + Q.jobs().queued.length < 2; i++) await new Promise(r => setTimeout(r, 10))
        const hit = bridge.stopSampleJobs(root)
        const [a, b] = await Promise.allSettled([within(inSample, 2000), within(mine, 300)])
        t('leaving the sample stops an agent\'s export of a sample take, and not one of the person\'s', () => {
          assert.strictEqual(hit.length, 1, JSON.stringify(hit))
          assert.ok(a.status === 'rejected' && /stopped before it finished/.test(a.reason.message), a.status)
          assert.ok(b.status === 'rejected' && !/stopped before it finished/.test(String(b.reason && b.reason.message)), 'the person\'s export was stopped too')
        })
        bridge.stopAgentJobs()
        await within(mine, 2000).catch(() => {})
        stopped = 0
      }

      // an export the client cancels stops, and says so in words
      hold = true
      const running = bridge.ops['edit.export']({ path: theirs, job: 'k1' })
      running.catch(() => {})
      for (let i = 0; i < 40 && Q.jobs().running.length === 0; i++) await new Promise(r => setTimeout(r, 10))
      const t0 = Date.now()
      const c = await bridge.ops['job.cancel']({ job: 'k1' })
      // bounded, so a cancel that does not reach the work fails here rather than hanging
      let err = null
      try { await within(running, 2000) } catch (e) { err = e }
      const again = await bridge.ops['job.cancel']({ job: 'k1' })
      t('a cancelled export is stopped where it runs, and the agent is told in a sentence', () => {
        assert.strictEqual(c.cancelled, true)
        assert.ok(err && /stopped before it finished/.test(err.message), err && err.message)
        assert.strictEqual(stopped, 1, 'the work was never told to stop')
        assert.ok(Date.now() - t0 < 1000)
        assert.strictEqual(again.cancelled, false, 'a finished key still cancels something')
      })
      // Esc: every export an agent has running or queued
      const a = bridge.ops['edit.export']({ path: theirs, job: 'k2' }); a.catch(() => {})
      const b = bridge.ops['edit.export']({ path: theirs, job: 'k3' }); b.catch(() => {})
      for (let i = 0; i < 40 && Q.jobs().running.length === 0; i++) await new Promise(r => setTimeout(r, 10))
      bridge.forgetConsent()
      const out = await Promise.allSettled([within(a, 2000), within(b, 2000)])
      t('Esc stops every export an agent started, running or queued', () => {
        assert.ok(out.every(o => o.status === 'rejected' && /stopped before it finished/.test(o.reason.message)),
          JSON.stringify(out.map(o => o.status)))
        assert.deepStrictEqual(Q.jobs().queued, [])
      })
    } finally {
      bridge.stop()
      fs.rmSync(home, { recursive: true, force: true })
      if (memoryWas) fs.writeFileSync(theirMemory, memoryWas)
      else fs.rmSync(theirMemory, { force: true })
    }
  })()

  // While the sample is open, a fact that names no take and no product is the sample's:
  // written to the person's memory it would reach every real product's briefing later.
  await (async () => {
    const Sample = require('../ui/sample')
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-unplaced-'))
    const root = path.join(home, 'Fetch Sample')
    fs.mkdirSync(root)
    fs.writeFileSync(path.join(root, Sample.MARK), '{}\n')
    const theirMemory = path.join(os.tmpdir(), 'memory.json')
    const memoryWas = fs.existsSync(theirMemory) ? fs.readFileSync(theirMemory) : null
    let open = root
    bridge.start({ proc: { probeMeta: async () => ({}) }, isRecording: () => false, sampleRoot: () => open })
    try {
      await bridge.ops['memory.remember']({ fact: 'The product is called Pantry Planner Plus', scope: 'product' })
      const txt = f => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '')
      t('a fact with no take and no product, said while the sample is open, is kept in the sample', () => {
        assert.match(txt(path.join(root, 'memory.json')), /Pantry Planner Plus/)
        assert.ok(!/Pantry Planner Plus/.test(txt(theirMemory)), 'the made up product went into the person\'s own memory')
      })
      open = null
      await bridge.ops['memory.remember']({ fact: 'Demos are for the finance team at Acme', scope: 'product', about: 'Ledgerly' })
      t('and once it is closed, facts are the person\'s again', () => {
        assert.match(txt(theirMemory), /finance team at Acme/)
        assert.ok(!/finance team/.test(txt(path.join(root, 'memory.json'))))
      })
    } finally {
      bridge.stop()
      fs.rmSync(home, { recursive: true, force: true })
      if (memoryWas) fs.writeFileSync(theirMemory, memoryWas)
      else fs.rmSync(theirMemory, { force: true })
    }
  })()

  // One device's run, driven without a device: a Delete tapped, the id retried off the
  // older picture, and a late search of an older picture handing out a number.
  await (async () => {
    const T = require('../ui/targets')
    const R = bridge.deviceRun
    R.reset()
    const w = (text, x, y, ww, h = 0.02) => ({ text, conf: 1, box: { x, y, w: ww, h }, bg: '#FFFFFF' })
    const F = texts => ({ width: 1290, height: 2796, texts })
    const list = names => F([w('Recipes', 0.4, 0.08, 0.2, 0.03), ...names.flatMap((n, i) => [w(n, 0.1, 0.2 + i * 0.08, 0.3), w('Delete', 0.75, 0.2 + i * 0.08, 0.12)])])
    const sim = { udid: 'RUN-1', name: 'Test phone', screen: { points: { w: 390, h: 844 } }, viewport: { x: 0, y: 0, w: 1, h: 1 } }
    // S0: ready. S1: the tap's screen after Shakshuka was deleted.
    const s0 = T.elementsFrom(list(['Shakshuka', 'Pancakes', 'Oats']))
    R.see(sim.udid, '/run/s0.png'); R.joinRun(sim.udid, '/run/s0.png', null, s0); R.noteFound('/run/s0.png', 0, s0, s0)
    const p1 = R.runPrior(sim.udid)
    const s1 = T.elementsFrom(list(['Pancakes', 'Oats']), p1)
    R.see(sim.udid, '/run/s1.png'); R.joinRun(sim.udid, '/run/s1.png', p1, s1); R.noteFound('/run/s1.png', 0, s1, s1)
    const del = (l, name) => { const n = l.find(e => e.text === name); return l.find(e => e.text === 'Delete' && Math.abs(e.box.y - n.box.y) < 0.01).id }
    const gone = del(s0, 'Shakshuka')
    let refused = null
    try { await R.simPoint(sim, { element: gone, path: '/run/s0.png' }) } catch (e) { refused = e.message }
    t('an id retried with an older picture\'s path is refused when the newest screen lacks it', () => {
      assert.ok(refused && /not on Test phone's newest screen/.test(refused), refused)
      assert.ok(!/Send that picture's path/.test(refused), 'the refusal still tells the agent to send the older path')
    })
    const kept = del(s0, 'Pancakes')
    const aimed = await R.simPoint(sim, { element: kept, path: '/run/s0.png' })
    const box = s1.find(e => e.id === kept).box
    t('an id held from an older picture is aimed at its box on the newest screen', () => {
      assert.strictEqual(kept, del(s1, 'Pancakes'))
      assert.ok(Math.abs(aimed.y - (box.y + box.h / 2) * 844) < 1, JSON.stringify(aimed))
    })
    // a late search of the older picture: a control only it shows is numbered past the run
    const late = T.elementsFrom(F([...list(['Pancakes', 'Oats']).texts, w('Undo', 0.4, 0.9, 0.2)]), R.runPrior(sim.udid))
    R.joinRun(sim.udid, '/run/s0.png', R.runPrior(sim.udid), late)
    const undo = late.find(e => e.text === 'Undo').id
    const s2 = T.elementsFrom(F([...list(['Pancakes', 'Oats']).texts, w('Saved', 0.4, 0.95, 0.2)]), R.runPrior(sim.udid))
    t('a late search of an older picture moves the run\'s count on, so the next screen never reuses its number', () => {
      assert.ok(+undo.slice(1) > s1.seq, `${undo} against ${s1.seq}`)
      assert.ok(!s2.some(e => e.id === undo), `${undo} was handed to ${(s2.find(e => e.id === undo) || {}).text}`)
    })
    R.reset()
  })()

  fs.rmSync(dir, { recursive: true, force: true })
  console.log(`\n${n} tool surface checks passed`)
}

main().catch(err => {
  fs.rmSync(dir, { recursive: true, force: true })
  console.error(err && err.message ? err.message : err)
  process.exit(1)
})
