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

// Ops the shim sends to the app and no model ever calls: who is driving, and whether
// the app is up. Everything else is a thing Fetch can do and needs a tool on it.
const PLUMBING = new Set(['hello', 'ping'])

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
    for (const name of ['direct', 'review', 'remember', 'ask', 'propose']) {
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
    for (const op of ['edit.fit', 'edit.revert', 'voice.speak', 'record.pause', 'edit.direct']) {
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

  fs.rmSync(dir, { recursive: true, force: true })
  console.log(`\n${n} tool surface checks passed`)
}

main().catch(err => {
  fs.rmSync(dir, { recursive: true, force: true })
  console.error(err && err.message ? err.message : err)
  process.exit(1)
})
