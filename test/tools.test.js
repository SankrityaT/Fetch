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
