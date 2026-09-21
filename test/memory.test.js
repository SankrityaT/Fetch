// What survives "New chat": the facts the agent was told about this person and their
// product, what it refuses to write down, and the block the next conversation opens on.
//   node test/memory.test.js
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const M = require('../ui/memory')

let n = 0
const t = (name, fn) => { fn(); n++; console.log('ok', name) }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-memory-'))
const root = path.join(dir, 'userData')
fs.mkdirSync(root, { recursive: true })

const take = (name = 'Songscription · Library Tour') => {
  const f = path.join(dir, name, 'Original', name + '.mov')
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, 'not really a movie')
  return f
}
const NOW = 1_700_000_000_000
// Facts that are genuinely about different things: a generated fact that reads like its
// neighbour would supersede it rather than fill the drawer, which is the next test down.
const apart = i => `alpha${i} beta${i} gamma${i} is how it works`
const store = (...facts) => {
  let s = M.empty()
  facts.forEach((f, i) => { s = M.add(s, f, NOW + i).store })
  return s
}

console.log('memory: what a new chat is still told')

// ── secrets ──────────────────────────────────────────────────────────────────

t('a key, a token or a card is refused, whatever sentence it arrives in', () => {
  // Every credential below is invented. The four with a live-looking prefix are put
  // together at run time rather than written out, because a file that holds a string
  // shaped like a real token trips GitHub's push protection and blocks the push. That
  // is the scanner doing its job, and a test fixture is not worth teaching it to let
  // that shape through.
  const shaped = (prefix, body) => prefix + body
  const lines = [
    [`our stripe key is ${shaped('sk_', 'live_51H8aBcDeFgHiJkLmNoP')}`, 'an API key'],
    [`the deploy token is ${shaped('ghp', '_aBcDeFgHiJkLmNoPqRsTuVwXyZ01234')}`, 'a GitHub token'],
    [`use ${shaped('xox', 'b-2345678901-AbCdEfGhIjKlMn')} for the bot`, 'a Slack token'],
    ['the bucket runs under AKIAIOSFODNN7EXAMPLE', 'an AWS key'],
    [`maps uses ${shaped('AIza', 'SyD-1234567890abcdefghijklmnopqrstuv')}`, 'a Google key'],
    ['the session is eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc', 'a signed token'],
    ['send it with Bearer abcdef0123456789abcdef', 'a bearer token'],
    ['the admin password is hunter2000', 'a password'],
    ['my card on the billing page is 4111 1111 1111 1111', 'a card number'],
    ['the db url is postgres://app:s3cretpassword@db.internal', 'a password in a URL'],
    ['the build id is a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6', 'a long random string'],
  ]
  for (const [line, kind] of lines) {
    const call = M.judge(line)
    assert.strictEqual(call.keep, false, line)
    assert.strictEqual(call.kind, 'secret', line)
    assert.strictEqual(call.of, kind, line)
  }
})

t('the refusal hands back the same sentence with the value taken out, and never the value', () => {
  const r = M.add(M.empty(), 'our stripe key is sk_live_51H8aBcDeFgHiJkLmNoP', NOW)
  assert.strictEqual(r.fact, null)
  assert.strictEqual(r.store.facts.length, 0)
  assert.strictEqual(r.refused.instead, 'our stripe key is [an API key, not written down]')
  assert.ok(!JSON.stringify(r).includes('51H8aBcDeFgHiJkLmNoP'), 'the value is not in the result either')
  // and the redacted line is something the agent can send straight back
  assert.strictEqual(M.add(M.empty(), r.refused.instead, NOW).fact.text, r.refused.instead)
})

t('a fact about a secret is not a secret', () => {
  const kept = [
    'an API key is visible in the header at 14 s, redact it before this ships',
    'the password field is on the second screen and is always shown empty',
    'the settings page is at songscription-library.vercel.app/settings',
    'the API key field is the top row of the account panel',
  ]
  for (const line of kept) assert.strictEqual(M.judge(line).keep, true, line)
})

// ── chatter ──────────────────────────────────────────────────────────────────

t('passing remarks are refused, and the refusal says which kind it was', () => {
  const lines = [
    'is the export done yet?',
    'thanks, that is perfect',
    'that looks great',
    'cut the first 3 seconds',
    'zoom into Z2 a bit more',
    'make this a 60 second demo for my landing page',
    'hold on, one more time',
    'ok',
  ]
  for (const line of lines) {
    const call = M.judge(line)
    assert.strictEqual(call.keep, false, line)
    assert.ok(call.kind === 'passing' || call.kind === 'thin', line + ' :: ' + call.kind)
    assert.ok(call.why.length > 0, line)
  }
})

t('a standing order outranks every passing marker, because it is the point of the file', () => {
  const kept = [
    'never show the admin panel, it is internal only',
    'always export 16:9 for the landing page',
    'do not ever record the billing tab',
  ]
  for (const line of kept) {
    const call = M.judge(line)
    assert.strictEqual(call.keep, true, line)
    assert.strictEqual(call.kind, 'standing', line)
  }
})

t('two words is a fact and one is not', () => {
  assert.strictEqual(M.judge('Songscription').keep, false)
  assert.strictEqual(M.judge('  ').keep, false)
  assert.strictEqual(M.judge('Songscription, one word').keep, true)
})

t('a paragraph is cut down to a sentence, and a secret hiding past the cut is still found', () => {
  const long = 'the library tour walks the whole app in order, ' + 'row after row after row, '.repeat(20)
  const r = M.add(M.empty(), long, NOW)
  assert.strictEqual(r.fact.text.length, M.MAX_TEXT)
  const buried = long + ' and the key is sk_live_51H8aBcDeFgHiJkLmNoP'
  assert.strictEqual(M.judge(buried).kind, 'secret', 'the whole line is scanned, not the part that fits')
  assert.strictEqual(M.add(M.empty(), buried, NOW).fact, null)
})

t('a secret in a label is dropped, and the fact it labelled still stands', () => {
  const r = M.add(M.empty(), {
    fact: 'the audience is piano teachers', scope: 'product',
    key: 'sk_live_51H8aBcDeFgHiJkLmNoP', about: 'ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ01234',
  }, NOW)
  assert.strictEqual(r.fact.key, null)
  assert.strictEqual(r.fact.about, null)
  assert.strictEqual(r.fact.text, 'the audience is piano teachers')
  assert.ok(!JSON.stringify(r.store).includes('sk_live'))
})

// ── which drawer ─────────────────────────────────────────────────────────────

t('the sentence says which drawer it belongs in when nobody else does', () => {
  assert.strictEqual(M.inferScope('this take shows the unreleased grid view'), 'take')
  assert.strictEqual(M.inferScope('Z3 lands on the wrong row in this one'), 'take')
  assert.strictEqual(M.inferScope('I always want captions burned in'), 'global')
  assert.strictEqual(M.inferScope('my demos are never longer than a minute'), 'global')
  assert.strictEqual(M.inferScope('our demos are always 60 seconds'), 'global')
  assert.strictEqual(M.inferScope('Songscription is pronounced song-scription'), 'product')
  // a length names no object, so it is about every take there will ever be
  assert.strictEqual(M.inferScope('the library tour is always 60 seconds long'), 'product')
})

t('a take names its own product, and a nameless take names none', () => {
  assert.strictEqual(M.productOf('Songscription · Library Tour'), 'Songscription')
  assert.strictEqual(M.productOf('Songscription · Library Tour 2.mov'), 'Songscription')
  assert.strictEqual(M.productOf('Linear · Issue 42 triage'), 'Linear')
  assert.strictEqual(M.productOf('recording-1789677081300'), null)
  assert.strictEqual(M.productOf(''), null)
})

// ── writing, changing, forgetting ────────────────────────────────────────────

t('a fact is written once and carries its own id', () => {
  const r = M.add(M.empty(), { fact: 'Songscription reads sheet music from audio', scope: 'product', about: 'Songscription' }, NOW)
  assert.strictEqual(r.fact.id, 'F1')
  assert.strictEqual(r.fact.scope, 'product')
  assert.strictEqual(r.fact.about, 'Songscription')
  assert.strictEqual(r.fact.seen, 1)
  assert.strictEqual(r.fact.was, null)
  // the id says which drawer, so a person reading the block can name what is wrong
  assert.strictEqual(M.add(M.empty(), 'I always want 16:9', NOW).fact.id, 'G1')
})

t('a key is the handle, so the same key said twice replaces rather than piles up', () => {
  let s = M.add(M.empty(), { fact: 'the demo is for the landing page', key: 'demo-purpose' }, NOW).store
  const r = M.add(s, { fact: 'the demo is for the launch post on X', key: 'demo-purpose' }, NOW + 1)
  assert.strictEqual(r.store.facts.length, 1)
  assert.strictEqual(r.fact.id, 'F1', 'the id survives the change')
  assert.strictEqual(r.fact.text, 'the demo is for the launch post on X')
  assert.strictEqual(r.was, 'the demo is for the landing page')
  assert.strictEqual(r.fact.seen, 2)
})

t('a restatement in other words supersedes, and a different fact about the same screen does not', () => {
  const s = store({ fact: 'the product is called Songscription', scope: 'product' })
  const changed = M.add(s, { fact: 'the product is called Lyricly now', scope: 'product' }, NOW + 5)
  assert.strictEqual(changed.store.facts.length, 1)
  assert.strictEqual(changed.was, 'the product is called Songscription')

  let two = store({ fact: 'never show the admin panel', scope: 'product' })
  two = M.add(two, { fact: 'never show the billing page', scope: 'product' }, NOW + 1).store
  assert.strictEqual(two.facts.length, 2, 'two screens, two facts')
})

t('the same sentence again is not a change, it is the person saying it matters', () => {
  const s = store('Songscription is pronounced song-scription')
  const r = M.add(s, 'Songscription is pronounced song-scription.', NOW + 9)
  assert.strictEqual(r.same, true)
  assert.strictEqual(r.was, null)
  assert.strictEqual(r.fact.seen, 2)
  assert.strictEqual(r.store.facts.length, 1)
})

t('the same words in two drawers are two facts, because they mean two different things', () => {
  let s = M.add(M.empty(), { fact: 'the grid view is unreleased', scope: 'product' }, NOW).store
  s = M.add(s, { fact: 'the grid view is unreleased', scope: 'global' }, NOW + 1).store
  assert.deepStrictEqual(s.facts.map(f => f.id), ['F1', 'G1'])
})

t('two products do not share a drawer', () => {
  let s = M.add(M.empty(), { fact: 'the tagline is hear it, see it', scope: 'product', about: 'Songscription' }, NOW).store
  s = M.add(s, { fact: 'the tagline is hear it, see it', scope: 'product', about: 'Fetch' }, NOW + 1).store
  assert.strictEqual(s.facts.length, 2)
  assert.strictEqual(M.recall(s, { about: 'Fetch' }).facts.length, 1)
})

t('a full drawer drops its weakest fact, and never the one just written', () => {
  let s = M.empty()
  for (let i = 0; i < M.CAP.global; i++) s = M.add(s, { fact: apart(i), scope: 'global' }, NOW + i).store
  // everything in there has been said twice except the oldest
  for (let i = 1; i < M.CAP.global; i++) s = M.add(s, { fact: apart(i), scope: 'global' }, NOW + 100 + i).store
  assert.strictEqual(s.facts.length, M.CAP.global)
  const r = M.add(s, { fact: 'I always want the closing card left alone', scope: 'global' }, NOW + 999)
  assert.strictEqual(r.store.facts.length, M.CAP.global)
  assert.deepStrictEqual(r.dropped, ['G1'], 'the one said once and longest ago')
  assert.ok(r.store.facts.some(f => f.id === r.fact.id), 'the new fact is still there')
})

t('a pinned fact outlives the whole drawer', () => {
  let s = M.add(M.empty(), { fact: 'the product is called Songscription', scope: 'global', pin: true }, NOW).store
  for (let i = 0; i < M.CAP.global + 4; i++) s = M.add(s, { fact: apart(i), scope: 'global' }, NOW + 10 + i).store
  assert.strictEqual(s.facts.length, M.CAP.global)
  assert.ok(s.facts.some(f => f.id === 'G1' && f.pin), 'the pinned one stayed')
})

t('forgetting works by id, by key and by the whole drawer', () => {
  let s = M.empty()
  s = M.add(s, { fact: 'the product is called Songscription', scope: 'product', key: 'name' }, NOW).store
  s = M.add(s, { fact: 'the audience is piano teachers', scope: 'product' }, NOW + 1).store
  s = M.add(s, { fact: 'I always want captions burned in', scope: 'global' }, NOW + 2).store

  const byId = M.drop(s, 'F2')
  assert.deepStrictEqual(byId.gone, ['F2'])
  const byKey = M.drop(s, { scope: 'product', key: 'name' })
  assert.deepStrictEqual(byKey.gone, ['F1'])
  const wholeDrawer = M.drop(s, { scope: 'product' })
  assert.deepStrictEqual(wholeDrawer.gone, ['F1', 'F2'])
  assert.deepStrictEqual(wholeDrawer.store.facts.map(f => f.id), ['G1'])
  assert.deepStrictEqual(M.drop(s, {}).gone, [], 'an empty selector forgets nothing')
})

// ── the block a new chat opens on ────────────────────────────────────────────

t('recall reads general to specific, with the id on every line', () => {
  let s = M.empty()
  s = M.add(s, { fact: 'this take opens on the unreleased grid view', scope: 'take' }, NOW).store
  s = M.add(s, { fact: 'I always want captions burned in', scope: 'global' }, NOW + 1).store
  s = M.add(s, { fact: 'Songscription is pronounced song-scription', scope: 'product' }, NOW + 2).store
  const out = M.recall(s)
  assert.deepStrictEqual(out.lines, [
    'Always true for this person:',
    'G1 · I always want captions burned in',
    'About the product:',
    'F1 · Songscription is pronounced song-scription',
    'About this recording:',
    'N1 · this take opens on the unreleased grid view',
  ])
  assert.strictEqual(out.left, 0)
})

t('a memory too big for the opening of a chat is cut to the strongest facts and says so', () => {
  let s = M.empty()
  for (let i = 0; i < 12; i++) {
    s = M.add(s, { fact: apart(i) + ' on the tour', scope: 'product' }, NOW + i).store
  }
  s = M.add(s, { fact: 'the product is called Songscription and nothing else', scope: 'product', pin: true }, NOW + 50).store
  const out = M.recall(s, { budget: 200 })
  assert.ok(out.text.length <= 200 + 40, 'the block fits the budget')
  assert.strictEqual(out.facts[0].pin, true, 'the pinned fact is the one that survives')
  assert.ok(out.left > 0)
  assert.ok(out.lines[out.lines.length - 1].includes('not shown'), out.lines[out.lines.length - 1])
  assert.strictEqual(M.recall(s, { budget: 0 }).facts.length, 1, 'one fact always gets through')
})

t('recall can be asked for one drawer, and knows the product it is for', () => {
  let s = M.empty()
  s = M.add(s, { fact: 'the audience is piano teachers', scope: 'product', about: 'Songscription' }, NOW).store
  s = M.add(s, { fact: 'the audience is developers', scope: 'product', about: 'Fetch' }, NOW + 1).store
  s = M.add(s, { fact: 'I always want captions burned in', scope: 'global' }, NOW + 2).store
  assert.deepStrictEqual(M.recall(s, { scope: 'global' }).facts.map(f => f.id), ['G1'])
  const one = M.recall(s, { about: 'songscription' })
  assert.deepStrictEqual(one.facts.map(f => f.text), ['I always want captions burned in', 'the audience is piano teachers'])
})

// ── on disk ──────────────────────────────────────────────────────────────────

t('a take fact sits in the take\'s own hidden folder, the durable ones in one file', () => {
  const src = take('Songscription · Sidecar')
  assert.strictEqual(M.takePath(src), path.join(dir, 'Songscription · Sidecar', 'Original', '.fetch', 'Songscription · Sidecar.memory.json'))
  assert.strictEqual(M.storePath(root), path.join(root, 'memory.json'))

  M.remember({ root, take: src }, 'this take opens on the unreleased grid view', { now: NOW })
  M.remember({ root, take: src }, 'Songscription is pronounced song-scription', { now: NOW + 1 })
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'Songscription · Sidecar', 'Original', '.fetch')), ['Songscription · Sidecar.memory.json'])
  assert.ok(fs.existsSync(M.storePath(root)))
  // the take named the product without being asked
  assert.strictEqual(M.read(root).facts[0].about, 'Songscription')
})

t('remember hands back the memory as the next conversation will see it', () => {
  const src = take('Songscription · Round Trip')
  const r = M.remember({ root, take: src }, { fact: 'the grid view is unreleased, never show it', scope: 'product' }, { now: NOW + 2 })
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.scope, 'product')
  assert.ok(r.file.endsWith('memory.json'))
  assert.ok(r.memory.text.includes(r.fact.id + ' · the grid view is unreleased'), r.memory.text)
  // and it is still there for a chat that knows nothing else
  assert.ok(M.recallFor({ root, take: src }).text.includes('the grid view is unreleased'))
})

t('a refused fact is still a valid call, and writes nothing', () => {
  const src = take('Songscription · Refusal')
  const before = fs.readFileSync(M.storePath(root), 'utf8')
  const r = M.remember({ root, take: src }, 'our stripe key is sk_live_51H8aBcDeFgHiJkLmNoP', { now: NOW + 3 })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.file, null)
  assert.strictEqual(r.refused.kind, 'secret')
  assert.ok(r.memory.text.length > 0, 'it still hands back what is known')
  assert.strictEqual(fs.readFileSync(M.storePath(root), 'utf8'), before)
  assert.ok(!fs.readFileSync(M.storePath(root), 'utf8').includes('sk_live'))
})

t('a fact about one recording with no recording named is refused rather than misfiled', () => {
  const r = M.remember({ root }, 'this take opens on the pricing page', { now: NOW + 4 })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.refused.kind, 'unplaced')
  assert.strictEqual(M.remember({ take: take('Songscription · No Root') }, 'the audience is piano teachers', { now: NOW }).refused.kind, 'unplaced')
})

t('a memory file that will not parse reads as an empty one and never blocks a turn', () => {
  const bad = path.join(dir, 'broken')
  fs.mkdirSync(bad, { recursive: true })
  fs.writeFileSync(M.storePath(bad), '{ not json at all')
  assert.deepStrictEqual(M.read(bad).facts, [])
  const r = M.remember({ root: bad }, 'the audience is piano teachers', { now: NOW })
  assert.strictEqual(r.ok, true)
  assert.deepStrictEqual(M.read(bad).facts.map(f => f.text), ['the audience is piano teachers'])
})

t('a hand-edited file keeps every fact it can still read, and hands out no id twice', () => {
  const s = M.normalize({
    facts: [
      { text: 'the product is called Songscription', id: 'F1' },
      { text: 'the audience is piano teachers' },
      { text: '' },
      { text: 'I always want captions burned in', scope: 'global', id: 'F1' },
      'not a fact at all',
    ],
  })
  assert.deepStrictEqual(s.facts.map(f => f.id), ['F1', 'F2', 'G1'])
  assert.strictEqual(M.add(s, { fact: 'the tagline is hear it, see it', scope: 'product' }, NOW).fact.id, 'F3')
})

t('forget reaches both files from one call', () => {
  const src = take('Songscription · Forget')
  const home = path.join(dir, 'forget-home')
  const n1 = M.remember({ root: home, take: src }, { fact: 'this take opens on the pricing page', scope: 'take' }, { now: NOW })
  const f1 = M.remember({ root: home, take: src }, { fact: 'the audience is piano teachers', scope: 'product' }, { now: NOW + 1 })
  assert.strictEqual(n1.fact.id[0], 'N')
  assert.strictEqual(f1.fact.id[0], 'F')

  assert.deepStrictEqual(M.forget({ root: home, take: src }, n1.fact.id).gone, [n1.fact.id])
  assert.deepStrictEqual(M.readTake(src).facts, [])
  const rest = M.forget({ root: home, take: src }, { scope: 'product' })
  assert.deepStrictEqual(rest.gone, [f1.fact.id])
  assert.strictEqual(rest.memory.text, '')
})

t('a whole product briefing survives a new chat', () => {
  const home = path.join(dir, 'new-chat')
  const src = take('Songscription · Library Tour')
  const said = [
    'the product is called Songscription, pronounced song-scription',
    'the audience is piano teachers who cannot read a lead sheet',
    'never show the admin panel, it is internal only',
    'I always want 16:9 with captions burned in',
    'this take opens on the unreleased grid view',
    'thanks, that looks great',
    'my openai key is sk-proj-AbCdEfGhIjKlMnOpQrStUv',
  ]
  const wrote = said.map((line, i) => M.remember({ root: home, take: src }, line, { now: NOW + i }))
  assert.deepStrictEqual(wrote.map(r => r.ok), [true, true, true, true, true, false, false])

  // a fresh process, nothing in hand but the take and where the app keeps things
  const fresh = require('../ui/memory').recallFor({ root: home, take: src })
  assert.strictEqual(fresh.total, 5)
  assert.ok(fresh.text.includes('pronounced song-scription'))
  assert.ok(fresh.text.includes('never show the admin panel'))
  assert.ok(fresh.text.includes('this take opens on the unreleased grid view'))
  assert.ok(!fresh.text.includes('looks great'))
  assert.ok(!fresh.text.toLowerCase().includes('sk-proj'))
  assert.ok(fresh.text.length < M.BUDGET)
})

t('a password made of words is still a password', () => {
  // Only values carrying a digit used to be refused, so an alphabetic passphrase went
  // into the file verbatim.
  for (const line of ['the staging password is correcthorsebatterystaple',
    'my api key is abcdefghijklmnop', 'the wifi password is letmeinplease']) {
    const r = M.add(M.empty(), line)
    assert.ok(r.refused, line)
    assert.ok(!JSON.stringify(r).includes('letmein') || !/letmeinplease/.test(r.refused.instead || ''), line)
  }
  // and the notes worth keeping are still kept
  for (const line of ['the password field is always shown empty',
    'an API key is visible in the header at 14 s, redact it before this ships',
    'the password is on screen at 12 s']) {
    assert.ok(M.add(M.empty(), line).fact, line)
  }
})

t('forgetting by key reaches every drawer, not only the product', () => {
  // The bridge always sends the open take's product, and only a product fact carries
  // one, so a global fact keyed "shape" could never be forgotten by key at all.
  let s = M.add(M.empty(), { fact: 'I always want 16:9 with captions burned in', scope: 'global', key: 'shape' }).store
  s = M.add(s, { fact: 'the opener is the grid view', scope: 'product', about: 'Songscription', key: 'opener' }).store
  const g = M.drop(s, { key: 'shape', about: 'Songscription' })
  assert.deepStrictEqual(g.gone, ['G1'])
  assert.deepStrictEqual(M.drop(g.store, { key: 'opener', about: 'Songscription' }).gone, ['F1'])
})

t('a product that was renamed is one fact, and the old name is not printed as current', () => {
  const r = M.add(M.add(M.empty(), 'the product is called Songscription').store, 'it is called Lyricly now')
  assert.strictEqual(r.store.facts.length, 1)
  assert.strictEqual(r.was, 'the product is called Songscription')
  assert.ok(!M.recall([r.store]).text.includes('Songscription'))
  // two orders about different screens are still two facts
  const two = M.add(M.add(M.empty(), 'never show the billing page').store, 'never show the admin panel')
  assert.strictEqual(two.store.facts.length, 2)
  // and naming a different thing is its own fact
  const both = M.add(M.add(M.empty(), 'the product is called Songscription').store, 'the pricing page is called Plans')
  assert.strictEqual(both.store.facts.length, 2)
})

// ── rules (ui/guidelines.js is the rulebook; these are the drawer's half) ──

t('a rule is a product fact that survives a round trip, and a file from before rules reads the same', () => {
  const r = M.add(M.empty(), { fact: 'never show the admin panel', rule: 'never', about: 'Songscription',
    from: 'person' }, NOW)
  const back = M.normalize(JSON.parse(JSON.stringify(r.store)))
  assert.strictEqual(back.facts[0].rule, 'never')
  assert.strictEqual(back.facts[0].from, 'person')
  assert.strictEqual(back.facts[0].pin, true, 'a rule in force is pinned')
  // an old row has no rule fields at all, not nulls, so an old file writes back unchanged
  const old = M.normalize({ facts: [{ id: 'F1', scope: 'product', text: 'the audience is piano teachers' }] })
  assert.deepStrictEqual(Object.keys(old.facts[0]).filter(k => ['rule', 'draft', 'from', 'evidence', 'replaces', 'shownAt'].includes(k)), [])
  // a rule outside the product drawer is only a fact, and an unknown section is no rule
  assert.strictEqual(M.normalize({ facts: [{ scope: 'global', rule: 'never', text: 'never show my inbox' }] }).facts[0].rule, undefined)
  assert.strictEqual(M.normalize({ facts: [{ scope: 'product', rule: 'vibes', text: 'never show my inbox' }] }).facts[0].rule, undefined)
})

t('naming a rule files it with the product even when the sentence sounds like the person', () => {
  const r = M.add(M.empty(), { fact: 'I never want my inbox on screen', rule: 'never', about: 'Songscription' }, NOW)
  assert.strictEqual(r.fact.scope, 'product')
  assert.strictEqual(r.fact.id, 'F1')
})

t('evidence carrying a secret is dropped, never stored', () => {
  const key = 'ghp' + '_aBcDeFgHiJkLmNoPqRsTuVwXyZ01234'
  const r = M.add(M.empty(), { fact: 'never show the tokens page', rule: 'never', draft: true, about: 'S',
    from: 'screen', evidence: `Settings, next to ${key}` }, NOW)
  assert.ok(r.fact)
  assert.strictEqual(r.fact.evidence, undefined)
  assert.ok(!JSON.stringify(r.store).includes('aBcDeFgHiJkLmNoP'))
})

t('a draft is kept out of recall, counted, and never rewrites what is in force', () => {
  let s = M.add(M.empty(), { fact: 'the product is called Songscription', about: 'S' }, NOW).store
  const d = M.add(s, { fact: 'it is called Lyricly now', rule: 'name', draft: true, about: 'S', from: 'screen' }, NOW + 1)
  s = d.store
  assert.strictEqual(d.fact.replaces, 'F1')
  assert.strictEqual(s.facts.find(f => f.id === 'F1').text, 'the product is called Songscription')
  const r = M.recall([s], { about: 'S' })
  assert.ok(!r.text.includes('Lyricly'))
  assert.strictEqual(r.drafts, 1)
  assert.strictEqual(r.total, 1, 'total still counts the facts it could print')
  // settle puts it in force on the row that already had the id
  const done = M.settle(s, d.fact.id, NOW + 2, 'person')
  assert.strictEqual(done.id, 'F1')
  assert.strictEqual(done.rule, 'name')
  assert.strictEqual(s.facts.length, 1)
  assert.strictEqual(M.settle(s, 'F1', NOW + 3), null, 'only a draft settles')
})

t('two never-rules about different things stay two rules, and a restatement of one is still one', () => {
  const a = M.add(M.empty(), { fact: 'never show customer phone numbers', rule: 'never', about: 'Biscuit' }, NOW)
  const b = M.add(a.store, { fact: 'never show card numbers', rule: 'never', about: 'Biscuit' }, NOW + 1)
  assert.strictEqual(b.was, null, `"${b.was}" was replaced by a rule about something else`)
  assert.deepStrictEqual(b.store.facts.map(f => f.text).sort(), ['never show card numbers', 'never show customer phone numbers'])
  const c = M.add(b.store, { fact: 'never show the customer phone numbers', rule: 'never', about: 'Biscuit' }, NOW + 2)
  assert.strictEqual(c.store.facts.length, 2, 'a restatement of a rule became a third')
})

t('a memory with no rules prints exactly what it printed before', () => {
  const s = store('the product is called Songscription', 'never show the admin panel')
  const r = M.recall([s], { about: 'Songscription' })
  assert.deepStrictEqual(r.lines, ['About the product:', 'F2 · never show the admin panel', 'F1 · the product is called Songscription'])
  assert.deepStrictEqual(r.rules, [])
  assert.strictEqual(r.drafts, 0)
})

fs.rmSync(dir, { recursive: true, force: true })
console.log(`\n${n} memory tests passed`)
