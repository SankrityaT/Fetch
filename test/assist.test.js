// The chat working on the take in the editor: the context each turn carries, the
// edits it offers, what an agent change touched, and undo.
//   node test/assist.test.js
const assert = require('assert')
const A = require('../ui/edit-assist')

let n = 0
const t = (name, fn) => { fn(); n++; console.log('ok', name) }

const doc = (o = {}) => ({
  clips: [{ id: 'C1', start: 0, end: 30 }], zooms: [], marks: [], texts: [], cues: [],
  look: { burnCaps: true }, backdrop: null, outAspect: null, ...o,
})

t('the header states the open take and its edit', () => {
  const h = A.contextHeader({
    open: { path: '/m/Demo/Original/Demo.mov', dur: 42, doc: doc({
      zooms: [{ id: 'Z1' }, { id: 'Z2' }], marks: [{ id: 'M1', kind: 'redact' }],
      cues: [{ start: 0, end: 1, text: 'hi' }] }) },
  })
  assert.ok(h.startsWith('<fetch_context>') && h.endsWith('</fetch_context>'))
  assert.ok(h.includes('/m/Demo/Original/Demo.mov (0:42)'))
  assert.ok(/"this" or "it" means/.test(h))
  assert.ok(h.includes('2 zooms (Z1, Z2)'))
  assert.ok(h.includes('1 mark (M1)'))
  assert.ok(h.includes('0 texts'))
  assert.ok(h.includes('captions 1 line, burned in'))
})

// The doctrine used to ride on every single message, about 600 words of instruction
// ahead of a six word request. It is doctrine, not news: it goes once, as a system
// prompt, and the header carries only what changed since the last turn.
t('the standing doctrine is the system prompt, not the header', () => {
  const sys = A.systemPrompt()
  for (const line of ['contact_sheet before you change it', 'the brief and the plan with direct',
    'apply_edit takes step', 'Call review before you reply', 'Report the plan and what changed']) {
    assert.ok(sys.includes(line), line)
  }
  assert.ok(/first call find_on_screen/.test(sys), 'aiming')
  assert.ok(/check\.preview_frame_at/.test(sys), 'checking')
  assert.ok(/Do not trust what an earlier turn said/.test(sys), 'says memory is stale')
  assert.ok(/fresh list_recordings call in this turn/.test(sys))
  assert.ok(/sensible default and make the change, rather than asking/.test(sys))
  assert.ok(/Never use an em dash/.test(sys))
  assert.ok(!/\u2014/.test(sys))
  // and none of it is repeated per message
  const h = A.contextHeader({ open: { path: '/a.mov', dur: 5, doc: doc() } })
  for (const gone of ['find_on_screen', 'preview_frame', 'list_recordings', 'em dash']) {
    assert.ok(!h.includes(gone), `${gone} is said once, in the system prompt`)
  }
})

t('the header is about 60 words, not 600', () => {
  const words = h => h.split(/\s+/).filter(Boolean).length
  const open = A.contextHeader({ open: { path: '/m/Demo.mov', dur: 42, doc: doc({ zooms: [{ id: 'Z1' }] }) } })
  assert.ok(words(open) < 90, `${words(open)} words`)
  assert.ok(words(A.contextHeader({ open: null })) < 20)
})

t('the header carries the job and where the plan stands', () => {
  const job = { brief: { seconds: 60, aspect: '16:9', where: 'a landing page' },
    steps: [{ id: 'P1', what: 'cut to the three moments', state: 'done' },
      { id: 'P2', what: 'burn in captions', state: 'todo' }] }
  const h = A.contextHeader({ open: { path: '/a.mov', dur: 90, doc: doc() }, job })
  assert.ok(h.includes('Job: 60 s, 16:9, for a landing page'))
  assert.ok(h.includes('Plan: 1 of 2 done, next P2 burn in captions'))
  assert.ok(!/Job:/.test(A.contextHeader({ open: { path: '/a.mov', dur: 9, doc: doc() } })), 'no job, no line')
})

t('planState reads a job, a bare list of steps, or a count the tool did itself', () => {
  const steps = [{ id: 'P1', what: 'cut', state: 'done' }, { id: 'P2', what: 'caption', state: 'todo' }]
  const p = A.planState({ steps, brief: { seconds: 60 } })
  assert.deepStrictEqual([p.done, p.total, p.next.id], [1, 2, 'P2'])
  assert.strictEqual(A.planState(steps).done, 1)
  assert.strictEqual(A.planState({ plan: steps }).total, 2)
  // what is left of a plan, with the closed count the tool kept
  assert.strictEqual(A.planState({ steps: [steps[1]], done: 1 }).done, 1)
  assert.strictEqual(A.planState({ steps: [steps[1]], done: 5 }).done, 0, 'a count the list cannot hold is not believed')
  // a step dropped on purpose is closed, the rule ui/director.js counts by
  const dropped = A.planState([{ id: 'P1', what: 'cut', state: 'dropped' }, { id: 'P2', what: 'caption', state: 'todo' }])
  assert.deepStrictEqual([dropped.done, dropped.next.id], [1, 'P2'])
  assert.strictEqual(A.planState(null), null)
  assert.strictEqual(A.planState({ steps: [] }), null)
})

t('a lassoed area is named in the header, and how to use it is in the doctrine', () => {
  const h = A.contextHeader({ open: { path: '/a.mov', dur: 5, doc: doc() },
    regions: [{ id: 'R1', at: 12.3, box: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, label: 'Save button', kind: 'free', path: '/a.mov' }] })
  assert.ok(h.includes('R1 at 12.30 s of /a.mov'))
  assert.ok(h.includes('"Save button"'))
  assert.ok(/work on exactly it/.test(h))
  assert.ok(/send element: that R id/.test(A.systemPrompt()))
})

t('with nothing open the header says so, and never names a take', () => {
  const h = A.contextHeader({ open: null })
  assert.ok(h.includes('No recording is open in the editor.'))
  assert.ok(!h.includes('Open in the Fetch editor'))
  assert.ok(!/\.mov|\.mp4/.test(h), 'names no file')
  const off = A.contextHeader({ omitted: true })
  assert.ok(off.includes('left the recording open in the editor out'))
})

t('no em dashes in anything a model or a person reads', () => {
  const all = A.systemPrompt() + A.contextHeader({ open: { path: '/a', dur: 3, doc: doc() } }) +
    A.suggestions(doc()).map(s => s.label + s.ask).join('') +
    A.suggestions(doc({ cues: [{}], zooms: [{ id: 'Z1' }], texts: [{ id: 'T1' }] })).map(s => s.label + s.ask).join('')
  assert.ok(!/\u2014/.test(all))
  assert.ok(!/\u2014/.test(require('fs').readFileSync(require.resolve('../ui/edit-assist'), 'utf8')))
})

// The header once named the newest take, and the model answered "what is my latest
// recording?" from it without ever reading the library, so a take that landed a
// moment earlier could be missed. The library is read by a tool call every time.
t('the header never names the newest take, and the doctrine asks for it every time', () => {
  const h = A.contextHeader({ open: { path: '/m/Open.mov', dur: 3, doc: doc() } })
  assert.ok(!/Newest recording/.test(h))
  assert.ok(/even if an earlier turn already answered it/.test(A.systemPrompt()))
})

t('plainDashes turns em dashes into commas and keeps ranges', () => {
  const D = A.plainDashes, em = '\u2014', en = '\u2013'
  assert.strictEqual(D(`Your latest recording is Suite Beta ${em} a new one since the last check.`),
    'Your latest recording is Suite Beta, a new one since the last check.')
  assert.strictEqual(D(`Done${em}the zoom is in.`), 'Done, the zoom is in.')
  assert.strictEqual(D(`Captions added ${en} 12 lines.`), 'Captions added, 12 lines.')
  assert.strictEqual(D(`Cut 1${en}3 seconds.`), `Cut 1${en}3 seconds.`)
  assert.strictEqual(D(`${em} first\nsecond ${em}.`), 'first\nsecond.')
  assert.strictEqual(D('No dashes here.'), 'No dashes here.')
  assert.strictEqual(D(null), '')
})

t('suggestions follow what the edit is missing', () => {
  const fresh = A.suggestions(doc()).map(s => s.label)
  assert.deepStrictEqual(fresh, ['Add captions', 'Tighten the pauses', 'Zoom into each step', 'Blur my name'])
  const done = A.suggestions(doc({
    clips: [{ id: 'C1' }, { id: 'C2' }], cues: [{ text: 'x' }], zooms: [{ id: 'Z1' }],
    marks: [{ id: 'M1', kind: 'blur' }] })).map(s => s.label)
  assert.ok(!done.includes('Add captions') && !done.includes('Tighten the pauses'))
  assert.ok(!done.includes('Zoom into each step') && !done.includes('Blur my name'))
  assert.ok(done.includes('16:9 on a blurred background'))
  assert.ok(done.includes('Fix caption mistakes'))
  // a silent take is not offered captions or pause trimming
  const silent = A.suggestions(doc(), { hasAudio: false }).map(s => s.label)
  assert.ok(!silent.includes('Add captions') && !silent.includes('Tighten the pauses'))
  assert.ok(A.suggestions(doc()).every(s => s.ask.length > s.label.length))
})

t('changedIds names new and changed objects only', () => {
  const a = doc({ zooms: [{ id: 'Z1', start: 1, end: 2 }], texts: [{ id: 'T1', text: 'a' }], cues: [{ text: 'x' }, { text: 'y' }] })
  const b = doc({ zooms: [{ id: 'Z1', start: 1, end: 3 }, { id: 'Z2', start: 5, end: 6 }],
    texts: [{ id: 'T1', text: 'a' }], marks: [{ id: 'M1', kind: 'redact' }], cues: [{ text: 'x' }, { text: 'why' }] })
  const c = A.changedIds(a, b)
  assert.deepStrictEqual(c.zooms, ['Z1', 'Z2'])
  assert.deepStrictEqual(c.marks, ['M1'])
  assert.deepStrictEqual(c.texts, [])
  assert.deepStrictEqual(c.cues, [1])
  assert.strictEqual(c.clips, false)
  assert.strictEqual(c.frame, false)
  assert.ok(A.anyChange(c))
  assert.ok(!A.anyChange(A.changedIds(a, a)))
  assert.strictEqual(A.changedIds(a, doc({ ...a, outAspect: 16 / 9 })).frame, true)
})

t('undo groups one burst of passes into one level', () => {
  const u = A.createUndo()
  const d0 = doc(), d1 = doc({ zooms: [{ id: 'Z1' }] }), d2 = doc({ zooms: [{ id: 'Z1' }, { id: 'Z2' }] })
  u.mark()
  u.note('/a', d0, d1, 1000)
  u.note('/a', d1, d2, 2000)          // second pass of the same turn
  assert.strictEqual(u.size('/a'), 1)
  assert.deepStrictEqual(u.peek('/a').before, d0)
  assert.deepStrictEqual(u.peek('/a').after, d2)
})

t('a new turn, a pause, or a hand edit in between each start a new level', () => {
  const u = A.createUndo({ gapMs: 5000 })
  const d = k => doc({ zooms: Array.from({ length: k }, (_, i) => ({ id: 'Z' + (i + 1) })) })
  u.note('/a', d(0), d(1), 0)
  u.mark(); u.note('/a', d(1), d(2), 100)              // new chat turn
  u.note('/a', d(2), d(3), 99999)                      // long pause
  u.note('/a', doc({ texts: [{ id: 'T1' }] }), d(4), 100000)   // the person changed it first
  assert.strictEqual(u.size('/a'), 4)
  const levels = [u.pop('/a'), u.pop('/a'), u.pop('/a'), u.pop('/a')].map(e => e.before.zooms.length)
  assert.deepStrictEqual(levels, [0, 2, 1, 0])
  assert.strictEqual(u.pop('/a'), null)
})

t('undo is per take, follows a rename, ignores no-op applies and is capped', () => {
  const u = A.createUndo({ max: 3 })
  u.note('/a', doc(), doc(), 0)
  assert.strictEqual(u.size('/a'), 0, 'nothing changed, nothing to undo')
  u.note('/a', doc(), doc({ zooms: [{ id: 'Z1' }] }), 0)
  u.mark(); u.note('/b', doc(), doc({ texts: [{ id: 'T1' }] }), 0)
  assert.strictEqual(u.size('/a'), 1); assert.strictEqual(u.size('/b'), 1)
  const lv = u.peek('/a').n
  u.rename('/a', '/a2')
  assert.strictEqual(u.size('/a'), 0); assert.strictEqual(u.peek('/a2').n, lv)
  for (let i = 0; i < 5; i++) { u.mark(); u.note('/c', doc(), doc({ marks: [{ id: 'M' + i }] }), i) }
  assert.strictEqual(u.size('/a2') + u.size('/b') + u.size('/c'), 3)
  assert.ok(u.peek('/c').n > lv, 'levels are never reused')
})

t('undo takes back the agent change and keeps what the person did since', () => {
  const before = doc({ src: '/a.mov', zooms: [], texts: [], nextId: { Z: 1, T: 1 } })
  const after = doc({ src: '/a.mov', zooms: [{ id: 'Z1' }], texts: [], nextId: { Z: 2, T: 1 } })
  // nothing touched since: exactly the old edit, counter kept
  let r = A.revert(before, after, after)
  assert.deepStrictEqual(r.doc.zooms, []); assert.strictEqual(r.doc.nextId.Z, 2); assert.deepStrictEqual(r.kept, [])
  // the person added a title and the take was renamed since: both stay
  const now = { ...after, src: '/b.mov', texts: [{ id: 'T1', text: 'Hi' }], nextId: { Z: 2, T: 2 } }
  r = A.revert(before, after, now)
  assert.deepStrictEqual(r.doc.zooms, [])
  assert.strictEqual(r.doc.texts[0].text, 'Hi'); assert.strictEqual(r.doc.src, '/b.mov')
  assert.strictEqual(r.doc.nextId.T, 2); assert.deepStrictEqual(r.kept, [])
  // the person moved the agent's own zoom: theirs wins, and the caller is told
  r = A.revert(before, after, { ...after, zooms: [{ id: 'Z1', start: 3 }] })
  assert.strictEqual(r.doc.zooms[0].start, 3); assert.deepStrictEqual(r.kept, ['zooms'])
  assert.deepStrictEqual(before.zooms, [], 'the snapshot itself is never changed')
  // the person dragged one zoom: only that one stays theirs, the agent's others go
  const b2 = doc({ zooms: [{ id: 'Z1', start: 1 }] })
  const a2 = doc({ zooms: [{ id: 'Z1', start: 1 }, { id: 'Z2', start: 5 }, { id: 'Z3', start: 9 }] })
  r = A.revert(b2, a2, doc({ zooms: [{ id: 'Z1', start: 2 }, { id: 'Z2', start: 5 }, { id: 'Z3', start: 9 }] }))
  assert.deepStrictEqual(r.doc.zooms, [{ id: 'Z1', start: 2 }]); assert.deepStrictEqual(r.kept, [])
  // a zoom the agent removed comes back, in time order, beside one the person added
  r = A.revert(a2, b2, doc({ zooms: [{ id: 'Z1', start: 1 }, { id: 'Z4', start: 7 }] }))
  assert.deepStrictEqual(r.doc.zooms.map(z => z.id), ['Z1', 'Z2', 'Z4', 'Z3'])
})

t('an undo reports what it did, including things that are now gone', () => {
  const after = doc({ zooms: [{ id: 'Z1', start: 64.2, end: 70 }] })
  assert.strictEqual(A.undoSummary(after, doc()), "Undid Biscuit's change: took out the zoom at 1:04")
  const was = doc({ marks: [{ id: 'M1', kind: 'blur', start: 1 }, { id: 'M2', kind: 'redact', start: 2 }], cues: [{ text: 'a' }] })
  const now = doc({ zooms: [{ id: 'Z1', start: 3 }], cues: [{ text: 'b' }] })
  assert.strictEqual(A.undoSummary(was, now),
    "Undid Biscuit's change: took out 2 blurs, brought back the zoom at 0:03, restored the captions")
  const mixed = doc({ marks: [{ id: 'M1', kind: 'step' }, { id: 'M2', kind: 'spotlight' }] })
  assert.ok(A.undoSummary(mixed, doc()).endsWith('took out 2 marks'))
  assert.strictEqual(A.undoSummary(doc(), doc()), "Undid Biscuit's change")
  assert.ok(!/\u2014/.test(A.undoSummary(was, now)))
})

// ── a question, and a proposal ──────────────────────────────────────────
// The agent used to guess when an ask had two readings, and a wrong guess costs an
// edit and an undo. These two kinds are the alternative: one click, or a look before
// it lands.

t('a question needs a question and two to four choices, or it is refused at the call', () => {
  assert.strictEqual(A.askSpec({ choices: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }).ok, false)
  const one = A.askSpec({ question: 'Which?', choices: [{ id: 'a', label: 'A' }] })
  assert.strictEqual(one.ok, false)
  assert.ok(/two to four/.test(one.error) && /make the change/.test(one.error), one.error)

  const r = A.askSpec({ id: 'Q1', question: 'Which part do you mean?  ', note: 'It is in the sidebar.',
    choices: [
      { label: 'The whole sidebar' },
      { id: 'Practice Button', label: 'Just the Practice button', hint: 'Leaves the rest alone' },
      { label: 'The whole sidebar' },                 // the same thing twice is one choice
      { label: '' }, { label: 'A fifth' }, { label: 'A sixth' },
    ] })
  assert.ok(r.ok)
  assert.strictEqual(r.ask.question, 'Which part do you mean?')
  assert.deepStrictEqual(r.ask.choices.map(c => c.id), ['the_whole_sidebar', 'practice_button', 'a_fifth', 'a_sixth'])
  assert.strictEqual(r.ask.choices[1].hint, 'Leaves the rest alone')
  assert.strictEqual(r.ask.choices[0].hint, null)
})

// Two looks are easier to choose between as two pictures than as two sentences, so a
// choice can carry a still Fetch rendered. Only a path this app made ever gets in.
t('a choice can carry the shot it stands for, and one without still has none', () => {
  const r = A.askSpec({ question: 'Which crop?', choices: [
    { label: 'Tight', shot: '/tmp/fetch/a.png' },
    { label: 'Wide' },
    { label: 'Odd', shot: 42 },
  ] })
  assert.strictEqual(r.ask.choices[0].shot, '/tmp/fetch/a.png')
  assert.strictEqual(r.ask.choices[1].shot, null, 'no shot is null, not missing')
  assert.strictEqual(r.ask.choices[2].shot, null, 'only a string is a path')
  const long = A.askSpec({ question: 'Which?', choices: [{ label: 'Tight', shot: '/x/' + 'y'.repeat(400) }, { label: 'Wide' }] })
  assert.strictEqual(long.ask.choices[0].shot.length, 260, 'a path is capped like every other field')
})

// A question the person never sees must not hold the agent, and an agent must not be
// able to park itself for an hour either.
t('a question always has a deadline, inside sane bounds', () => {
  const q = { question: 'Which?', choices: [{ label: 'A' }, { label: 'B' }] }
  assert.strictEqual(A.askSpec(q).ask.timeoutMs, A.ASK_MS)
  assert.strictEqual(A.askSpec({ ...q, timeoutMs: 5 }).ask.timeoutMs, 10000)
  assert.strictEqual(A.askSpec({ ...q, timeoutMs: 99999999 }).ask.timeoutMs, 600000)
  assert.strictEqual(A.proposalSpec({ title: 'x' }).proposal.timeoutMs, A.PROPOSE_MS)
})

t('every answer, and every non-answer, comes back with what to do about it', () => {
  const said = A.askResult({ how: 'answered', choice: { id: 'practice', label: 'Just the Practice button' } })
  assert.strictEqual(said.answered, true)
  assert.strictEqual(said.choice, 'practice')
  assert.ok(/do not ask about it again/i.test(said.do_next))

  for (const how of ['timeout', 'dismissed', 'unattended']) {
    const r = A.askResult({ how, timeoutMs: 90000 })
    assert.strictEqual(r.answered, false)
    assert.strictEqual(r.reason, how)
    assert.ok(r.why && /narrowest choice/.test(r.do_next), how)
    assert.ok(/they can undo it/.test(r.do_next), how)
  }
  assert.ok(/90 s/.test(A.askResult({ how: 'timeout', timeoutMs: 90000 }).why))
  // a turn the person stopped is not a question to work around
  assert.ok(/Stop here/.test(A.askResult({ how: 'cancelled' }).do_next))
})

// The whole promise of a proposal is that nothing happens until Apply, so every
// branch but Apply has to say, in the result the agent reads, that nothing was written.
t('a proposal writes nothing unless it was applied, and says so', () => {
  const yes = A.proposalResult({ how: 'apply' })
  assert.strictEqual(yes.applied, true)
  assert.ok(/do not send it again through apply_edit/i.test(yes.do_next))

  for (const how of ['discard', 'dismissed', 'timeout', 'unattended', 'cancelled']) {
    const r = A.proposalResult({ how, timeoutMs: 240000 })
    assert.strictEqual(r.applied, false, how)
    assert.ok(/Nothing was written/.test(r.why), how)
  }
  assert.ok(/do not propose the same thing again/i.test(A.proposalResult({ how: 'discard' }).do_next))
  assert.ok(/behind their back/.test(A.proposalResult({ how: 'timeout' }).do_next))
})

t('the pane has a line for every way a card can settle, and none of them blames anyone', () => {
  for (const how of ['timeout', 'dismissed', 'unattended', 'cancelled', 'stale']) {
    assert.ok(A.settleLine('ask', how), how)
    assert.ok(A.settleLine('propose', how), how)
  }
  // an answered question needs no line: the chosen button, ticked, is the record
  assert.strictEqual(A.settleLine('ask', 'answered'), '')
  assert.strictEqual(A.settleLine('propose', 'discard'), 'Discarded. Nothing was changed.')
  assert.strictEqual(A.settleLine('nonsense', 'timeout'), '')
  const all = [...Object.values(A.settleLine('ask', 'timeout')), A.settleLine('propose', 'timeout')].join('')
  assert.ok(!/\u2014/.test(all))
})

t('the doctrine says when to ask and when to just do it', () => {
  const sys = A.systemPrompt()
  assert.ok(/Ask with ask only when/.test(sys))
  assert.ok(/two or more readings/.test(sys), 'the bar is damage, not doubt')
  assert.ok(/Never ask twice about the same thing/.test(sys))
  assert.ok(/a default they can see and undo beats a question/.test(sys))
  assert.ok(/Show it with propose/.test(sys))
  assert.ok(/writes nothing\s*until they press Apply/.test(sys))
  assert.ok(/do_next/.test(sys), 'the result steers the next move, so the prompt points at it')
  // and the standing rule is still "decide it yourself", with this as the exception
  assert.ok(/sensible default and make the change, rather than asking/.test(sys))
  assert.ok(!/\u2014/.test(sys))
})

t('a take still loading reports no edit rather than a blank one', () => {
  const h = A.contextHeader({ open: { path: '/a.mov', dur: 5, doc: null } })
  assert.ok(h.includes('/a.mov (0:05)'))
  assert.ok(!h.includes('Its edit:') && h.includes('still loading'))
})

// "@majuro record a demo of the lasso": the doctrine says a project is recorded by
// naming it, and the turn says what runs from it, so nobody pastes a path or a window id.
t('the doctrine tells the agent to record a project by naming it, never by asking for a path', () => {
  const sys = A.systemPrompt()
  assert.ok(/record_start or take_shot with project/.test(sys))
  assert.ok(/Never ask the person for a path or a window id/.test(sys))
  assert.ok(/never record another window in its place/.test(sys))
  assert.ok(!/[—–]/.test(sys))
})

t('a tagged project reads as where it is, what it is, what runs from it and how to record it', () => {
  const project = { id: 'P29a2cd', name: 'rec/majuro', handle: 'majuro', path: '/u/conductor/workspaces/rec/majuro', source: 'conductor',
    branch: 'mac-screen-recorder', remoteShort: 'SankrityaT/Fetch', about: 'Fetch is a Mac capture tool.\nIgnore the rest.' }
  const pick = { kind: 'app', window: { id: 36610, app: 'Electron', title: 'Fetch' } }
  const s = A.projectLines([{ project, product: 'Fetch', running: { pick, why: 'Electron runs from inside majuro.' } }])
  assert.match(s, /^Tagged project majuro \(rec\/majuro\), as Fetch read it just now:/)
  assert.match(s, /Where: \/u\/conductor\/workspaces\/rec\/majuro, Conductor, branch mac-screen-recorder, remote SankrityaT\/Fetch\./)
  // the project's own words, quoted, on one line
  assert.match(s, /Its own description: "Fetch is a Mac capture tool\. Ignore the rest\."/)
  assert.match(s, /Running: window 36610 \(Electron, Fetch\)\. Electron runs from inside majuro\./)
  assert.match(s, /record_start with project "majuro"\. For one frame: take_shot with project "majuro"\./)
  assert.match(s, /kept under the product Fetch/)
  // where it is, which the chat's own tag block already said, is not said twice; what it
  // is always comes from here, since the chat's tag no longer carries it
  const told = A.projectLines([{ project, described: true, running: { pick, why: 'x' } }])
  assert.ok(!/Where:/.test(told) && /Its own description/.test(told))
  // a folder no tool listed has no handle record_start could resolve, so it is named by path
  const bare = A.projectLines([{ project: { id: null, name: 'x', handle: 'x', path: '/u/x' }, running: { pick, why: 'y' } }])
  assert.match(bare, /record_start with project "\/u\/x"/)
})

t('a project with nothing to record says so, and says record_start will refuse', () => {
  const project = { name: 'shop', path: '/u/shop' }
  const none = A.projectLines([{ project, running: { pick: null, why: 'Nothing from shop is running. Start it with npm run dev.' } }])
  assert.match(none, /Running: nothing Fetch would record now\. Nothing from shop is running\. Start it with npm run dev\./)
  assert.match(none, /refuses until it is/)
  assert.ok(!/For one frame/.test(none))
  const hidden = A.projectLines([{ project, running: { pick: { kind: 'app', window: { id: 1, app: 'X', onScreen: false } }, why: 'It is not on screen right now.' } }])
  assert.match(hidden, /nothing Fetch would record now\. It is not on screen right now\./)
  const slow = A.projectLines([{ project, running: null }])
  assert.match(slow, /could not read that in time/)
  assert.strictEqual(A.projectLines([]), '')
  assert.strictEqual(A.projectLines([{ project: { name: 'no path' } }]), '')
})

console.log(`\n${n} assist tests passed`)
