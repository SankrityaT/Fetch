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

t('no em dash in the rulebook, its memory or this file', () => {
  const dash = String.fromCharCode(0x2014)
  for (const f of ['../ui/guidelines.js', '../ui/memory.js', __filename]) {
    assert.ok(!fs.readFileSync(path.resolve(__dirname, f), 'utf8').includes(dash), f)
  }
})

fs.rmSync(dir, { recursive: true, force: true })
console.log(`\n${n} guidelines tests passed`)
