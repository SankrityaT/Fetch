// A product's standing rules: what it is called, who a demo is for, what never goes on
// screen, how it looks, the words it avoids. Who may put one in force, and where it is
// read.
//   node test/guidelines.test.js
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const G = require('../ui/guidelines')
const M = require('../ui/memory')

let n = 0
const t = (name, fn) => { fn(); n++; console.log('ok', name) }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-guidelines-'))
let homes = 0
const home = () => { const r = path.join(dir, 'home' + (++homes)); fs.mkdirSync(r, { recursive: true }); return r }
const take = (name = 'Songscription · Library Tour') => {
  const f = path.join(dir, name, 'Original', name + '.mov')
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, 'not really a movie')
  return f
}
const NOW = 1_700_000_000_000
const S = 'Songscription'

console.log('guidelines: the rules an agent reads before it acts')

t('a sentence files itself under what it governs', () => {
  const cases = [
    ['the product is called Songscription, said song-scription', 'name'],
    ['it is pronounced song-scription', 'name'],
    ['the demo is for piano teachers who cannot read a lead sheet', 'audience'],
    ['never show the admin panel, it is internal only', 'never'],
    ['keep the billing page off screen', 'never'],
    ['screenshots sit on a warm cream background with the device frame on', 'look'],
    ["say 'song', not 'track'", 'words'],
    ["never say 'simply'", 'words'],
  ]
  for (const [line, want] of cases) assert.strictEqual(G.sectionOf(line), want, line)
  assert.strictEqual(G.sectionOf('the weather was lovely'), null)
})

t("the person's own words are in force at once, and head the memory block every briefing already prints", () => {
  const root = home()
  const src = take()
  M.remember({ root, take: src }, 'the pricing page is at /plans', { now: NOW })
  const r = G.write({ root, take: src }, { rule: 'never show the admin panel, it is internal only', from: 'person' }, { now: NOW + 1 })
  assert.ok(r.ok)
  assert.strictEqual(r.written[0].draft, false)
  assert.strictEqual(r.written[0].section, 'never')
  assert.ok(!r.next, 'nothing to show when the person wrote it')
  // the same reader agent-chat and the bridge already call, untouched
  const block = M.recallFor({ root, take: src })
  assert.strictEqual(block.lines[0], `Rules for ${S}, before planning, capturing or styling anything:`)
  assert.ok(block.lines[1].endsWith('never on screen: never show the admin panel, it is internal only'))
  assert.ok(block.text.indexOf('admin panel') < block.text.indexOf('/plans'), 'rules before facts')
  assert.strictEqual(block.rules.length, 1)
  // and it is a memory row, pinned: one file, one id space
  const row = M.read(root).facts.find(f => f.rule)
  assert.ok(/^F\d+$/.test(row.id))
  assert.strictEqual(row.pin, true)
  assert.strictEqual(row.about, S)
})

t('an agent draft is never in a briefing until the person has seen it and said yes', () => {
  const root = home()
  const where = { root, product: S }
  const w = G.write(where, [
    { rule: 'the audience is piano teachers', from: 'help', evidence: 'songscription.com/help/getting-started' },
    { rule: 'screenshots use the dark theme with the sidebar open', from: 'screen', evidence: 'Library screen' },
  ], { now: NOW })
  assert.deepStrictEqual(w.written.map(x => x.draft), [true, true])
  assert.ok(/show F1, F2/.test(w.next))
  const before = M.recallFor({ root }, { about: S })
  assert.ok(!before.text.includes('piano teachers'), 'a draft is not used')
  assert.ok(before.text.includes('2 drafted rules wait for the person: F1, F2'))

  // unshown: refused, whatever seal is offered
  const guess = G.sealOf(S, M.read(root).facts)
  assert.strictEqual(G.adopt(where, { ids: ['F1'], seal: guess }, { now: NOW + 1 }).refused.kind, 'unshown')

  const shown = G.show(where, { now: NOW + 2 })
  assert.ok(shown.text.startsWith(`Drafted for ${S}. None of these is used until you say yes:`))
  assert.ok(shown.text.includes('F1 · Audience: the audience is piano teachers (from its help pages, songscription.com/help/getting-started)'))
  assert.ok(shown.text.includes('(from its own screens, Library screen)'))
  assert.strictEqual(G.adopt(where, { ids: ['F1'], seal: 'nope' }, { now: NOW + 3 }).refused.kind, 'seal')
  // the seal covers exactly the drafts adopted, so adopting a subset needs its own showing
  assert.strictEqual(G.adopt(where, { ids: ['F1'], seal: shown.seal }, { now: NOW + 3 }).refused.kind, 'seal')
  const one = G.show(where, { ids: ['F1'], now: NOW + 4 })
  const yes = G.adopt(where, { ids: ['F1'], seal: one.seal }, { now: NOW + 5 })
  assert.ok(yes.ok)
  assert.deepStrictEqual(yes.adopted, ['F1'])
  const after = M.recallFor({ root }, { about: S })
  assert.ok(after.text.includes('F1 · audience: the audience is piano teachers'))
  assert.ok(!after.text.includes('dark theme'))
  assert.ok(after.text.includes('1 drafted rule waits for the person: F2'))
  assert.strictEqual(M.read(root).facts.find(f => f.id === 'F1').by, 'person')
})

t('a draft whose words changed after it was shown has to be shown again', () => {
  const root = home()
  const where = { root, product: S }
  G.write(where, { rule: 'screenshots use the light theme', from: 'screen' }, { now: NOW })
  const shown = G.show(where, { now: NOW + 1 })
  G.write(where, { rule: 'screenshots use the light theme with the sidebar closed', from: 'screen' }, { now: NOW + 2 })
  assert.strictEqual(M.read(root).facts.length, 1, 'a refined draft is the same draft')
  assert.strictEqual(G.adopt(where, { ids: ['F1'], seal: shown.seal }, { now: NOW + 3 }).refused.kind, 'unshown')
  const again = G.show(where, { now: NOW + 4 })
  assert.ok(G.adopt(where, { ids: ['F1'], seal: again.seal }, { now: NOW + 5 }).ok)
})

t('a draft that would change a rule in force sits beside it, and on yes the old rule takes the words and keeps its id', () => {
  const root = home()
  const where = { root, product: S }
  G.write(where, { rule: 'the product is called Songscription', from: 'person' }, { now: NOW })
  const d = G.write(where, { rule: 'it is called Lyricly now', from: 'screen', evidence: 'window title' }, { now: NOW + 1 })
  assert.strictEqual(d.written[0].replaces, 'F1')
  // the briefing still says what the person said
  let block = M.recallFor({ root }, { about: S })
  assert.ok(block.text.includes('called Songscription'))
  assert.ok(!block.text.includes('Lyricly'))
  const shown = G.show(where, { now: NOW + 2 })
  assert.ok(shown.text.includes('would replace F1: the product is called Songscription'))
  assert.strictEqual(shown.drafts[0].replacing, 'the product is called Songscription')
  const yes = G.adopt(where, { ids: [d.written[0].id], seal: shown.seal }, { now: NOW + 3 })
  assert.deepStrictEqual(yes.adopted, ['F1'], 'the id an agent may already hold is the one that changes')
  const facts = M.read(root).facts
  assert.strictEqual(facts.length, 1)
  assert.strictEqual(facts[0].text, 'it is called Lyricly now')
  assert.strictEqual(facts[0].was, 'the product is called Songscription')
  block = M.recallFor({ root }, { about: S })
  assert.ok(block.text.includes('Lyricly') && !block.text.includes('Songscription is'))
})

t('two products never share rules', () => {
  const root = home()
  G.write({ root, product: S }, { rule: 'never show the admin panel', from: 'person' }, { now: NOW })
  G.write({ root, product: 'Lyricly' }, { rule: 'never show the billing page', from: 'person' }, { now: NOW + 1 })
  const a = M.recallFor({ root, take: take('Songscription · Onboarding') })
  assert.ok(a.text.includes('admin panel') && !a.text.includes('billing page'))
  const b = M.recallFor({ root, take: take('Lyricly · Checkout') })
  assert.ok(b.text.includes('billing page') && !b.text.includes('admin panel'))
  // no product named and two with rules: neither is printed, both are named
  const none = M.recallFor({ root })
  assert.ok(!none.text.includes('admin panel') && !none.text.includes('billing page'))
  assert.ok(none.text.includes('Rules are kept for Songscription, Lyricly'))
  // and a rule with no product is refused rather than filed for everyone
  const orphan = G.write({ root }, { rule: 'never show the settings page', from: 'person' })
  assert.strictEqual(orphan.refused.kind, 'unplaced')
  assert.deepStrictEqual(orphan.products.sort(), ['Lyricly', 'Songscription'])
  assert.strictEqual(G.read({ root }).refused.kind, 'unplaced')
})

t('with one product that has rules and none named, its rules print under its own name', () => {
  const root = home()
  G.write({ root, product: S }, { rule: 'never show the admin panel', from: 'person' }, { now: NOW })
  const block = M.recallFor({ root })
  assert.ok(block.text.startsWith(`Rules for ${S},`))
})

t('a secret is refused as a rule exactly as it is as a fact, and never quoted back', () => {
  const root = home()
  const key = 'sk_' + 'live_51H8aBcDeFgHiJkLmNoP'
  const r = G.write({ root, product: S }, { rule: `never show the key ${key}`, from: 'person' })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.written[0].refused.kind, 'secret')
  assert.ok(!JSON.stringify(r).includes('51H8aBcDeFgHiJkLmNoP'))
  assert.strictEqual(M.read(root).facts.length, 0)
  // evidence is a label: a secret in it is dropped and the rule stands
  const e = G.write({ root, product: S }, { rule: 'never show the API keys page', from: 'screen',
    evidence: `settings, where it shows ${key}` })
  assert.ok(e.ok)
  assert.ok(!fs.readFileSync(M.storePath(root), 'utf8').includes('51H8aBcDeFgHiJkLmNoP'))
  // an edit on the way in is judged too
  const shown = G.show({ root, product: S })
  const bad = G.adopt({ root, product: S }, { ids: ['F1'], seal: shown.seal, edits: { F1: `hide ${key}` } })
  assert.strictEqual(bad.refused.kind, 'secret')
  assert.ok(M.read(root).facts[0].draft, 'nothing went into force')
})

t('a rule is standing by its section, but a single word is still not a rule', () => {
  const root = home()
  // "that looks great" style chatter would be refused as a fact; filed as a look rule it
  // is an order about every screenshot
  const r = G.write({ root, product: S }, { rule: 'screenshots look great on the cream background', section: 'look', from: 'person' })
  assert.ok(r.ok)
  const thin = G.write({ root, product: S }, { rule: 'beta', section: 'words', from: 'person' })
  assert.strictEqual(thin.written[0].refused.kind, 'thin')
  const unfiled = G.write({ root, product: S }, { rule: 'the weather was lovely today', from: 'person' })
  assert.strictEqual(unfiled.written[0].refused.kind, 'unfiled')
})

t('what the person told remember and what the rulebook files are one row, not two', () => {
  const root = home()
  const src = take()
  const said = M.remember({ root, take: src }, 'never show the admin panel, it is internal only', { now: NOW })
  assert.strictEqual(said.fact.rule, undefined)
  const r = G.write({ root, take: src }, { rule: 'never show the admin panel, it is internal only', from: 'person' }, { now: NOW + 1 })
  assert.strictEqual(r.written[0].id, said.fact.id)
  const facts = M.read(root).facts
  assert.strictEqual(facts.length, 1)
  assert.strictEqual(facts[0].rule, 'never')
  // and the agent drafting the same sentence changes nothing
  const again = G.write({ root, take: src }, { rule: 'never show the admin panel, it is internal only', from: 'screen' }, { now: NOW + 2 })
  assert.strictEqual(again.written[0].same, true)
  assert.strictEqual(M.read(root).facts.filter(f => f.draft).length, 0)
})

t('an agent that does not say where a rule came from wrote a draft', () => {
  const root = home()
  const r = G.write({ root, product: S }, 'the demo is for piano teachers')
  assert.strictEqual(r.written[0].draft, true)
  assert.strictEqual(M.read(root).facts[0].from, 'agent')
})

t('the person saying a drafted rule in their own words is their yes to it', () => {
  const root = home()
  G.write({ root, product: S }, { rule: 'the demo is for piano teachers', from: 'help' }, { now: NOW })
  const r = G.write({ root, product: S }, { rule: 'the demo is for piano teachers', from: 'person' }, { now: NOW + 1 })
  assert.strictEqual(r.written[0].draft, false)
  assert.strictEqual(M.read(root).facts.length, 1)
  assert.ok(M.recallFor({ root }, { about: S }).text.includes('piano teachers'))
})

t('a remember never puts a draft in force, however like it the sentence is', () => {
  const root = home()
  const d = G.write({ root, product: S }, { rule: 'Never show the customer emails page', from: 'screen' }, { now: NOW }).written[0]
  const r = M.remember({ root, about: S }, { fact: 'Always show the customer emails page first', scope: 'product', about: S }, { now: NOW + 1 })
  const draft = M.read(root).facts.find(f => f.id === d.id)
  assert.strictEqual(draft.draft, true, 'a remember put the draft in force')
  assert.strictEqual(draft.text, 'Never show the customer emails page', 'a remember rewrote the draft')
  assert.notStrictEqual(r.fact.id, d.id)
  assert.ok(!M.recallFor({ root }, { about: S }).text.includes('Never on screen: Always'))
  // the draft's own words, said to remember, leave it waiting and say so
  const root2 = home()
  const d2 = G.write({ root: root2, product: S }, { rule: 'Never show the customer emails page', from: 'screen' }, { now: NOW }).written[0]
  const same = M.remember({ root: root2, about: S }, { fact: 'Never show the customer emails page', scope: 'product', about: S }, { now: NOW + 2 })
  assert.strictEqual(M.read(root2).facts.find(f => f.id === d2.id).draft, true)
  assert.match(same.waiting, /stays a draft/)
})

t('no is only for drafts: a rule in force is taken back with forget', () => {
  const root = home()
  const where = { root, product: S }
  G.write(where, { rule: 'never show the admin panel', from: 'person' })
  G.write(where, { rule: 'screenshots use the dark theme', from: 'screen' })
  const r = G.reject(where, ['F1', 'F2'])
  assert.deepStrictEqual(r.rejected, ['F2'])
  assert.strictEqual(M.read(root).facts.length, 1)
  assert.deepStrictEqual(M.forget({ root, about: S }, 'F1').gone, ['F1'])
})

t('a full drawer of facts never pushes a rule out of the briefing, nor evicts it', () => {
  const root = home()
  G.write({ root, product: S }, { rule: 'never show the admin panel', from: 'person' }, { now: NOW })
  let s = M.read(root)
  for (let i = 0; i < 60; i++) {
    s = M.add(s, { fact: `alpha${i} beta${i} gamma${i} is how the ${'long '.repeat(8)}thing works`, scope: 'product', about: S }, NOW + 1 + i).store
  }
  M.write(root, s)
  const block = M.recallFor({ root }, { about: S })
  assert.ok(block.text.includes('never show the admin panel'))
  assert.ok(M.read(root).facts.some(f => f.rule === 'never'))
})

t('a pile of unanswered drafts never evicts a fact the person said', () => {
  const root = home()
  M.remember({ root, about: S }, 'the pricing page is at /plans', { now: NOW })
  const many = Array.from({ length: M.DRAFT_CAP + 10 }, (_, i) => ({ rule: `never show delta${i} epsilon${i} zeta${i}`, from: 'screen' }))
  G.write({ root, product: S }, many, { now: NOW + 1 })
  const facts = M.read(root).facts
  assert.ok(facts.some(f => f.text === 'the pricing page is at /plans'))
  assert.strictEqual(facts.filter(f => f.draft).length, M.DRAFT_CAP)
})

t('the words a product avoids are found in a caption, with what to say instead', () => {
  assert.deepStrictEqual(G.termsOf("say 'song', not 'track'"), [{ term: 'track', instead: 'song' }])
  assert.deepStrictEqual(G.termsOf("don't say 'simply' or 'just'").map(x => x.term), ['simply', 'just'])
  assert.deepStrictEqual(G.termsOf('avoid simply, just and easy').map(x => x.term), ['simply', 'just', 'easy'])
  const rules = [{ id: 'F3', section: 'words', text: "say 'song', not 'track'" }, { id: 'F4', section: 'words', text: 'avoid simply' }]
  const hits = G.avoidedIn('Simply drop a track in', rules)
  assert.deepStrictEqual(hits.map(h => [h.term, h.rule, h.instead || null]), [['track', 'F3', 'song'], ['simply', 'F4', null]])
  assert.deepStrictEqual(G.avoidedIn('soundtrack and simplyfied', rules), [], 'whole words only')
})

t('what must never be seen is found among the labels read off a frame', () => {
  const rules = [
    { id: 'F1', section: 'never', text: 'never show the admin panel, it is internal only' },
    { id: 'F2', section: 'never', text: 'customer email addresses must never be on screen' },
    { id: 'F3', section: 'never', text: 'keep the billing page off screen' },
  ]
  const hits = G.onScreen(['Admin Panel', 'Admin', 'Email addresses', 'Billing page', 'Library', { id: 'E4', label: 'Admin panels' }], rules)
  assert.deepStrictEqual(hits.map(h => [h.label, h.rule]), [
    ['Admin Panel', 'F1'], ['Admin panels', 'F1'], ['Email addresses', 'F2'], ['Billing page', 'F3']])
  assert.strictEqual(hits[1].id, 'E4')
})

t('a check holds work to the rules in force and never to a draft', () => {
  const root = home()
  const where = { root, product: S }
  G.write(where, { rule: "say 'song', not 'track'", from: 'person' })
  G.write(where, { rule: 'never show the admin panel', from: 'screen' })
  const r = G.check(where, { text: 'Drop a track in', labels: ['Admin panel'] })
  assert.strictEqual(r.clean, false)
  assert.deepStrictEqual(r.words.map(h => h.term), ['track'])
  assert.deepStrictEqual(r.onScreen, [], 'a draft fails nobody')
})

t('read says what is missing as the question to ask', () => {
  const root = home()
  G.write({ root, product: S }, { rule: 'the product is called Songscription', from: 'person' })
  const r = G.read({ root, product: S })
  assert.deepStrictEqual(r.gaps.map(g => g.section), ['audience', 'never', 'look', 'words'])
  assert.ok(r.text.includes('Still to ask: Who is a demo of it for?'))
  assert.strictEqual(r.rules.name.length, 1)
})

t('one entry point, the way a tool calls it', () => {
  const root = home()
  const src = take()
  const w = G.op({ root, take: src }, { action: 'write', rules: [{ rule: 'the demo is for piano teachers', from: 'help' }] })
  assert.strictEqual(w.guidelines.product, S)
  const shown = G.op({ root, take: src }, { action: 'show' })
  assert.ok(G.op({ root, take: src }, { action: 'adopt', ids: ['F1'], seal: shown.seal }).ok)
  assert.strictEqual(G.op({ root }, { product: S }).rules.audience.length, 1)
  assert.throws(() => G.op({ root, take: src }, { action: 'burn' }), /action is one of/)
})

// ── checks, not advice ──────────────────────────────────────────────────────
// A rule an agent only reads is followed when the model remembers to. These hold the
// work to the rules the way review does: what broke, where, and the call that fixes it,
// and a rule that could not be checked is said to be unchecked, never passed.

const B = "Biscuit's Pantry"
const pantry = () => {
  const where = { root: home(), product: B }
  for (const [rule, section] of [
    ["avoid 'simply', say 'just'", 'words'],
    ["avoid 'dish', say 'recipe'", 'words'],
    ['never show an email address', 'never'],
    ['screenshots on warm cream', 'look'],
    [`always "${B}" with the apostrophe`, 'name'],
  ]) assert.ok(G.write(where, { rule, section, from: 'person' }).ok, rule)
  return where
}
const rule = (where, section) => G.read(where).rules[section][0].id
const still = (texts = [], look = {}, marks = []) => ({ kind: 'shot', src: '/tmp/pantry.png', w: 1600, h: 1000, look, texts, marks })

t('a never-rule about a kind of thing finds the thing by its shape, not the words of the rule', () => {
  const where = pantry()
  const F = rule(where, 'never')
  const frame = { elements: [
    { id: 'E2', text: 'Email address', box: { x: 0.1, y: 0.1, w: 0.2, h: 0.04 } },
    { id: 'E3', text: 'maya@biscuit.test', box: { x: 0.1, y: 0.16, w: 0.2, h: 0.04 } },
  ] }
  const r = G.check(where, { doc: still(), frames: [frame] })
  const never = r.findings.filter(f => f.rule === 'rule-never')
  assert.deepStrictEqual(never.map(f => [f.guideline, f.where.id, f.severity]), [[F, 'E3', 'blocking']],
    'the address, not the field name')
  assert.deepStrictEqual(never[0].fix, { tool: 'apply_edit', why: never[0].fix.why,
    args: { path: '/tmp/pantry.png', doc: { marks: [{ kind: 'redact', element: 'E3' }] } } })
  assert.ok(!JSON.stringify(r.findings).includes('maya@'), 'a check never repeats the thing it keeps off screen')
  assert.strictEqual(r.verdict, 'refuse')
  // the list find_on_screen already reads gets the address too, masked, beside the field
  // name it already caught (a screen about email addresses is worth a word as it is looked at)
  const seen = G.onScreen(frame.elements, G.read(where).rules.never)
  assert.deepStrictEqual(seen.map(h => [h.id, h.label, h.kind || null]), [['E2', 'Email address', null], ['E3', 'an email address', 'email']])
})

t('what is under a redaction is covered; a blur is not enough for a card number, and one thing on five frames is one finding', () => {
  const where = { root: home(), product: S }
  G.write(where, { rule: 'keep phone numbers off screen', from: 'person' })
  G.write(where, { rule: 'never show card numbers', from: 'person' })
  const [phone, card] = G.read(where).rules.never.map(x => x.id)
  const doc = { v: 2, src: '/t.mov', dur: 20, clips: [{ id: 'C1', start: 0, end: 20 }], look: {}, texts: [], cues: [], marks: [
    { id: 'M1', kind: 'blur', x: 0.5, y: 0.5, w: 0.3, h: 0.1, start: 0, end: 20 },
    { id: 'M2', kind: 'redact', x: 0, y: 0.8, w: 0.3, h: 0.1, start: 0, end: 20 },
  ] }
  const els = [
    { id: 'E1', text: 'Call +44 20 7946 0958', box: { x: 0, y: 0, w: 0.2, h: 0.05 } },
    { id: 'E2', text: '4242 4242 4242 4242', box: { x: 0.55, y: 0.52, w: 0.1, h: 0.04 } },
    { id: 'E4', text: '(555) 010-4477', box: { x: 0.05, y: 0.82, w: 0.1, h: 0.04 } },
    { id: 'E5', text: '2026-09-21 at 10:30, 1,234,567 views' },
  ]
  const r = G.check(where, { doc, frames: [2, 6, 10, 14, 18].map(at => ({ at, elements: els })) })
  assert.deepStrictEqual(r.findings.map(f => [f.guideline, f.where.id]), [[phone, 'E1'], [card, 'E2']])
  assert.deepStrictEqual(r.findings[0].where.frames, [2, 6, 10, 14, 18])
  assert.deepStrictEqual(r.findings[0].fix.args.doc.marks, [{ kind: 'redact', element: 'E1', start: 0, end: 20 }])
  assert.deepStrictEqual(r.findings[1].fix.args.doc.marks, [{ id: 'M1', kind: 'redact' }], 'the blur becomes a redaction')
  assert.ok(r.covered.every(c => c.id === 'E4' && c.by === 'M2'))
  assert.deepStrictEqual(r.unchecked, [], 'five frames four seconds apart read the whole take')
})

t('a never-rule that cannot be checked says so and does not pass', () => {
  const where = { root: home(), product: S }
  G.write(where, { rule: 'never show an email address', from: 'person' })
  G.write(where, { rule: "never show customers' real names", from: 'person' })
  const [email, names] = G.read(where).rules.never.map(x => x.id)
  // nothing read off the picture
  const blind = G.check(where, { doc: still() })
  assert.strictEqual(blind.clean, false)
  assert.strictEqual(blind.verdict, 'unchecked')
  assert.ok(blind.unchecked.some(u => u.guideline === email && u.fix.tool === 'find_on_screen'))
  // a kind with no shape
  const u = blind.unchecked.find(x => x.guideline === names)
  assert.ok(/no shape of its own/.test(u.why) && /has not passed/.test(u.why))
  // a take read on two frames far apart: the stretches between them are named
  const doc = { v: 2, src: '/t.mov', dur: 30, clips: [{ id: 'C1', start: 0, end: 30 }], look: {}, texts: [], cues: [], marks: [] }
  const r = G.check(where, { doc, frames: [{ at: 2, elements: ['Library'] }, { at: 20, elements: ['Library'] }] })
  const gaps = r.unchecked.find(x => x.where && x.where.gaps)
  assert.deepStrictEqual(gaps.where.gaps, [[4, 18], [22, 30]])
  assert.deepStrictEqual(gaps.fix, { tool: 'find_on_screen', args: { path: '/t.mov', at: 11 }, why: gaps.fix.why })
})

t('the gate refuses an export with a never-thing on it, and lets the rest travel with the yes', () => {
  const where = pantry()
  const frame = { elements: [{ id: 'E3', text: 'maya@biscuit.test', box: { x: 0.1, y: 0.16, w: 0.2, h: 0.04 } }] }
  const no = G.gate(where, { doc: still([{ id: 'T1', text: 'Plan the week' }]), frames: [frame], for: 'still' })
  assert.strictEqual(no.ok, false)
  assert.strictEqual(no.refused.kind, 'never-on-screen')
  assert.ok(/before this still is saved/.test(no.refused.why))
  const hidden = still([{ id: 'T1', text: 'Plan the week' }], { background: { kind: 'solid', color: '#F3EADB' } },
    [{ id: 'M1', kind: 'redact', x: 0.09, y: 0.15, w: 0.22, h: 0.06 }])
  const yes = G.gate(where, { doc: hidden, frames: [frame], for: 'still' })
  assert.strictEqual(yes.ok, true)
  assert.deepStrictEqual(yes.findings, [])
  assert.deepStrictEqual(yes.covered.map(c => [c.id, c.by]), [['E3', 'M1']])
  assert.strictEqual(G.op(where, { action: 'gate', doc: hidden, frames: [frame] }).ok, true)
})

t("a name rule reads the name, and finds every other way of writing it", () => {
  assert.deepStrictEqual(G.nameOf(`always "${B}" with the apostrophe`), { name: B, old: [] })
  assert.deepStrictEqual(G.nameOf('the product is called Lyricly, never Lyrically'), { name: 'Lyricly', old: ['Lyrically'] })
  assert.deepStrictEqual(G.nameOf('Songscription, formerly Scorely'), { name: 'Songscription', old: ['Scorely'] })
  assert.strictEqual(G.nameOf('say it the way the founders do'), null)
  const r = { id: 'F1', text: 'the product is called Songscription, formerly Scorely' }
  const said = h => h.map(x => x.said)
  assert.deepStrictEqual(said(G.misnamed('Song Scription, Songsciption, songscription and Scorely', r)),
    ['Song Scription', 'Songsciption', 'songscription', 'Scorely'])
  assert.deepStrictEqual(G.misnamed("Songscription's library, SONGSCRIPTION, Songscription", r), [], 'possessive, capitals and the name itself')
  const fetch = { id: 'F2', text: "the product is called 'Fetch'" }
  assert.deepStrictEqual(said(G.misnamed('fetch the file with Fetch, or FEtch', fetch)), ['FEtch'], 'a short ordinary word in lower case is a verb')
})

t('the words and the name are checked on the edit, and one call makes every rewrite', () => {
  const where = pantry()
  const texts = [{ id: 'T1', text: 'Biscuits Pantry keeps the week' }, { id: 'T2', text: 'Simply add your favourite dish' }]
  const r = G.check(where, { doc: still(texts, { background: { kind: 'solid', color: '#F3EADB' } }), frames: [{ elements: ['Recipes'] }] })
  assert.deepStrictEqual(r.findings.map(f => [f.rule, f.where.id]).sort(),
    [['rule-name', 'T1'], ['rule-words', 'T2'], ['rule-words', 'T2']])
  const fixes = new Set(r.findings.map(f => JSON.stringify(f.fix)))
  assert.strictEqual(fixes.size, 1, 'the list is replaced whole, so every finding in it carries the same call')
  const fixed = r.findings[0].fix.args.doc.texts
  assert.deepStrictEqual(fixed.map(x => x.text), [`${B} keeps the week`, 'Just add your favourite recipe'])
  const again = G.check(where, { doc: still(fixed, { background: { kind: 'solid', color: '#F3EADB' } }), frames: [{ elements: ['Recipes'] }] })
  assert.strictEqual(again.clean, true, JSON.stringify(again))
  // the judge's line, on a caption and on a mark's label
  const cap = G.check(where, { doc: { ...still(), marks: [{ id: 'M4', kind: 'arrow', label: 'Biscuits Pantry keeps the week' }] } })
  const m = cap.findings.find(f => f.rule === 'rule-name')
  assert.deepStrictEqual(m.fix.args.doc.marks, [{ id: 'M4', label: `${B} keeps the week` }])
})

t('a name rule with no name in it is unchecked, not passed', () => {
  const where = { root: home(), product: S }
  G.write(where, { rule: 'the product is pronounced the way the founders say it', section: 'name', from: 'person' })
  const r = G.check(where, { text: 'Songsciption is here' })
  assert.deepStrictEqual(r.findings, [])
  assert.strictEqual(r.unchecked[0].rule, 'rule-name')
  assert.strictEqual(r.clean, false)
})

t("a look rule is read clause by clause into the look's own fields, and held to them", () => {
  const w = G.lookWants('screenshots on warm cream, with the device frame, no shadow and square corners; 16:9; feels calm')
  assert.deepStrictEqual(w.map(x => x.path || null), ['background', 'device.kind', 'frame.shadow', 'frame.radius', 'frame.aspect', null])
  assert.ok(/feels calm/.test(w[5].unchecked))

  const where = pantry()
  const look = rule(where, 'look')
  const bad = G.check(where, { doc: still([], {}) }).findings.find(f => f.rule === 'rule-look')
  assert.strictEqual(bad.guideline, look)
  assert.deepStrictEqual(bad.fix, { tool: 'apply_look', why: bad.fix.why,
    args: { path: '/tmp/pantry.png', look: { background: { kind: 'solid', color: '#F3EADB' } } } })
  const dusk = G.check(where, { doc: still([], { background: { kind: 'gradient', gradient: 'dusk' } }) })
  assert.ok(dusk.findings.some(f => f.rule === 'rule-look' && /dusk/.test(f.what)))
  const cream = G.check(where, { doc: still([], { background: { kind: 'solid', color: '#F5EBDC' } }) })
  assert.ok(!cream.findings.some(f => f.rule === 'rule-look'))
  // a picture's tone that is in its pixels is not guessed at
  const img = G.check(where, { doc: still([], { background: { kind: 'image' } }) })
  assert.ok(img.unchecked.some(u => u.rule === 'rule-look' && /pixels/.test(u.why)))
  // a screenshot rule does not hold a video to it
  const video = { v: 2, src: '/t.mov', dur: 5, clips: [], look: {}, texts: [], cues: [], marks: [] }
  assert.ok(!G.check(where, { doc: video }).findings.some(f => f.rule === 'rule-look'))
})

t("a shape rule needs the take's own shape when the look keeps it, and says so without it", () => {
  const where = { root: home(), product: S }
  G.write(where, { rule: 'demos are 16:9 with captions at the bottom', section: 'look', from: 'person' })
  assert.strictEqual(G.check(where, { look: { frame: { aspect: 'auto' } }, width: 1920, height: 1080 }).clean, true)
  const tall = G.check(where, { look: { frame: { aspect: 'auto' } }, width: 1080, height: 1920 })
  assert.deepStrictEqual(tall.findings.map(f => f.fix.args.look), [{ frame: { aspect: '16:9' } }])
  const blind = G.check(where, { look: { frame: { aspect: 'auto' } } })
  assert.ok(blind.unchecked.some(u => /width and height were not given/.test(u.why)))
  const top = G.check(where, { look: { frame: { aspect: '16:9' }, captions: { position: 'top' } } })
  assert.deepStrictEqual(top.findings.map(f => f.fix.args.look), [{ captions: { position: 'bottom' } }])
})

// What design_direction writes when somebody picks one of the three. The op itself is
// exercised in test/tools.test.js and by hand against a real take; what matters here is
// the pair of properties the once per product promise rests on, which belong to the
// rulebook rather than to the op.
t('a picked direction is in force at once, and a second pick replaces it', () => {
  const where = { root: home(), product: S }
  const pick = label => G.write(where, { section: 'look', from: 'person', key: 'direction',
    rule: `The look direction for ${S} is ${label}.` })
  const inForce = () => { const sheet = G.read(where); return (sheet.ok && sheet.rules.look) || [] }

  // from: 'person' is a click, and a click does not then have to be shown to the person
  // and said yes to. Anything else would be asking them twice.
  const first = pick('Press')
  assert.strictEqual(first.written[0].draft, false, 'a pick is in force, not drafted')
  assert.deepStrictEqual(inForce().map(r => r.text), [`The look direction for ${S} is Press.`])

  // and changing their mind replaces the rule rather than stacking a second one that
  // contradicts it, which is what key: 'direction' is for
  pick('On a stage')
  assert.deepStrictEqual(inForce().map(r => r.text), [`The look direction for ${S} is On a stage.`],
    'a second pick replaces the first rather than stacking under it')
})

t('no em dash in the rulebook, its memory or this file', () => {
  const dash = String.fromCharCode(0x2014)
  for (const f of ['../ui/guidelines.js', '../ui/memory.js', __filename]) {
    assert.ok(!fs.readFileSync(path.resolve(__dirname, f), 'utf8').includes(dash), f)
  }
})

fs.rmSync(dir, { recursive: true, force: true })
console.log(`\n${n} guidelines tests passed`)
