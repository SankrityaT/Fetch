// A product's standing rules, read before the agent plans, captures or styles anything.
//
// Memory holds facts: things the person said that will still be true next week. A rule
// is the kind of fact that decides work before it starts. What the product is called and
// how it is said. Who a demo of it is for. What must never be on screen. How its
// screenshots should look. The words it avoids, and what it says instead. An agent that
// learns these at review time has already recorded the admin panel.
//
// Built on memory rather than beside it: a rule is a product fact with a `rule` field,
// in the same file, under the same F ids, through the same refusals. So a secret is
// refused here exactly as it is there, "never show the admin panel" said to `remember`
// and filed here later is one row and not two, and every briefing that already prints
// the memory block prints the rules at the top of it without a second reader.
//
// Two ways a rule is written, and they are not equal:
//   the person   their own words, written in the app's Guidelines panel, or relayed by an
//                agent and confirmed by the person in Fetch (ui/agent-bridge.js asks, with
//                the words in front of them). In force at once. Nothing an agent sends is
//                taken as the person's yes on its own: the bridge asks before a write
//                from the person and before an adopt, and a remember never settles a
//                draft (ui/memory.js add).
//   the agent    drafted from the product itself: its screens, its help pages, its code.
//                A draft is never in any briefing. It is shown to the person with `show`,
//                and goes into force only through `adopt`, naming the ids and carrying
//                the seal `show` handed back, so what goes into force is exactly what
//                was shown. A draft that changes after it was shown has to be shown again.
// A draft that would change a rule already in force sits beside it, naming it, and on
// adoption the old rule takes the new words and keeps its id.
//
// Rules are scoped per product and always carry one: two products do not share rules,
// so a rule with no product to belong to is refused rather than filed for everyone.
//
// Pure apart from what ui/memory.js does on disk, so test/guidelines.test.js runs it
// under plain node with no Electron.

const crypto = require('crypto')
const Memory = require('./memory')

const { RULES, SOURCES, clean } = Memory

// What each section is, and the question that fills it. A gap is printed as its question,
// because "no audience rule" tells an agent nothing about what to ask.
const SECTIONS = {
  name: { head: 'Name', ask: 'What is the product called, and how is it said out loud?' },
  audience: { head: 'Audience', ask: 'Who is a demo of it for?' },
  never: { head: 'Never on screen', ask: 'What must never be on screen?' },
  look: { head: 'Look', ask: 'How should its screenshots look: shape, background, frame?' },
  words: { head: 'Words', ask: 'Which words does it avoid, and what does it say instead?' },
}

const FROM_WORDS = { screen: 'its own screens', help: 'its help pages', code: 'its code', agent: 'the agent' }

// ── which section a sentence belongs to ──────────────────────────────────────
// Asked in this order because the sentences overlap: "never say 'simply'" is about words
// before it is about the screen, and "the product is called Lyricly, never Lyrically" is
// about the name before it is about words.
const INFER = [
  ['name', /\b(is|are|was) (now )?(called|named)\b|\bpronounc\w*|\b(spelled|spelt|stands for|short for|capitali[sz]\w*|written as)\b/i],
  ['words', /\b(say|says|said|word|words|term|terms|wording|phrase|phrases|jargon|avoid|avoids)\b/i],
  ['audience', /\b(audience|viewers|watched by|made for|built for|aimed at|demos? (is |are )?for|for people who|customers are|users are)\b/i],
  ['never', /\b(never|must not|mustn't|do not|don't|cannot|can't)\b.*\b(show|shown|showing|record|recorded|film|capture|captured|on screen|visible|appear|appears|include|reveal|open)\b|\b(off screen|redact|redacted|blur|blurred|confidential|internal only|not public|under nda|unreleased)\b/i],
  ['look', /\b(screenshots?|background|backdrop|frame|framed|device|bezel|aspect|16:9|9:16|4:3|1:1|square|portrait|landscape|shadow|corners?|radius|padding|margin|dark mode|light mode|colou?rs?|font|gradient|wallpaper|zoom|cursor|captions?|looks?|style|styled)\b/i],
]

function sectionOf(text) {
  const s = clean(text)
  for (const [k, re] of INFER) if (re.test(s)) return k
  return null
}

// ── where ────────────────────────────────────────────────────────────────────
function place(where) {
  const w = where && typeof where === 'object' ? where : {}
  const p = Memory.place(where)
  const product = clean(w.product, 60) || p.about
  return { root: p.root, take: p.take, product: product || null }
}

const mineOf = (store, product) =>
  store.facts.filter(f => f.scope === 'product' && f.rule && Memory.sameSubject(f.about, product))

// ── the seal ─────────────────────────────────────────────────────────────────
// The drafts as they were shown, in a few characters. Adopting with a seal that does not
// match means the words changed after the person saw them, or were never shown at all.
function sealOf(product, drafts) {
  const body = [Memory.slug(product || '')]
    .concat(drafts.slice().sort((a, b) => a.id.localeCompare(b.id)).map(f => `${f.id}\n${f.rule}\n${f.text}`))
    .join('\n\n')
  return crypto.createHash('sha1').update(body).digest('hex').slice(0, 10)
}

// ── reading ──────────────────────────────────────────────────────────────────
const row = (f, all) => {
  const r = { id: f.id, section: f.rule, text: f.text }
  if (f.from) r.from = f.from
  if (f.evidence) r.evidence = f.evidence
  if (f.replaces) {
    r.replaces = f.replaces
    const old = all && all.find(x => x.id === f.replaces)
    if (old) r.replacing = old.text
  }
  if (f.was) r.was = f.was
  return r
}

function sheet(product, store) {
  const all = store.facts
  const mine = mineOf(store, product)
  const kept = mine.filter(f => !f.draft)
  const drafts = mine.filter(f => f.draft)
  const rules = {}
  for (const k of RULES) rules[k] = kept.filter(f => f.rule === k).map(f => row(f, all))
  const gaps = RULES.filter(k => !rules[k].length).map(k => ({ section: k, ask: SECTIONS[k].ask }))

  const lines = []
  if (kept.length) {
    lines.push(`Rules for ${product}:`)
    for (const k of RULES) for (const r of rules[k]) lines.push(`${r.id} · ${SECTIONS[k].head}: ${r.text}`)
  } else {
    lines.push(`No rules for ${product} yet.`)
  }
  if (drafts.length) {
    lines.push(`${drafts.length} drafted, not in force until the person says yes: ${drafts.map(f => f.id).join(', ')}.`)
  }
  if (gaps.length) lines.push('Still to ask: ' + gaps.map(g => g.ask).join(' '))
  return { product, rules, drafts: drafts.map(f => row(f, all)), gaps, text: lines.join('\n') }
}

const unplaced = (why, extra = {}) => ({ ok: false, refused: { keep: false, kind: 'unplaced', why }, ...extra })

// What the rulebook says for one product, whole: the rules in force by section, the
// drafts waiting, and the questions nobody has answered yet.
function read(where) {
  const w = place(where)
  if (!w.root) return unplaced('nowhere to read rules from: no memory folder was given')
  if (!w.product) {
    return unplaced('rules belong to one product, and no product was named',
      { products: productsIn(Memory.read(w.root)) })
  }
  return { ok: true, ...sheet(w.product, Memory.read(w.root)) }
}

function productsIn(store) {
  const seen = new Map()
  for (const f of store.facts) if (f.rule && f.about) seen.set(Memory.slug(f.about), f.about)
  return [...seen.values()]
}

// ── writing ──────────────────────────────────────────────────────────────────
// One rule or several. The person's words go into force; anything else is a draft. An
// agent relaying what the person just said sends from: 'person', the way `remember`
// already trusts it to; an agent that read a sentence off a settings screen does not.
function write(where, input, opts = {}) {
  const at = opts.now || Date.now()
  const w = place(where)
  const list = Array.isArray(input) ? input : Array.isArray(input && input.rules) ? input.rules : [input]
  if (!w.root) return unplaced('nowhere to keep rules: no memory folder was given', { written: [] })
  if (!w.product) {
    return unplaced('a rule belongs to one product, and no product was named: pass product, or open one of its takes',
      { written: [], products: productsIn(Memory.read(w.root)) })
  }
  let store = Memory.read(w.root)
  const written = []
  let changed = false
  for (const one of list) {
    const raw = typeof one === 'string' ? { rule: one } : (one && typeof one === 'object' ? one : {})
    const text = clean(raw.rule != null ? raw.rule : raw.text != null ? raw.text : raw.fact, 4000)
    const from = SOURCES.includes(raw.from) ? raw.from : 'agent'
    const section = RULES.includes(raw.section) ? raw.section : sectionOf(text)
    if (!section) {
      written.push({ ok: false, text: clean(text), refused: { keep: false, kind: 'unfiled',
        why: `say which section it governs: ${RULES.join(', ')}` } })
      continue
    }
    const draft = from !== 'person'
    const r = Memory.add(store, { fact: text, scope: 'product', about: w.product, rule: section, draft,
      from, evidence: raw.evidence, key: raw.key, by: raw.by }, at)
    store = r.store
    if (!r.fact) {
      written.push({ ok: false, section, refused: r.refused })
      continue
    }
    changed = changed || r.changed
    written.push({ ok: true, id: r.fact.id, section, text: r.fact.text, draft: !!r.fact.draft,
      ...(r.fact.replaces ? { replaces: r.fact.replaces } : {}),
      ...(r.was ? { was: r.was } : {}), ...(r.same ? { same: true } : {}),
      ...(r.dropped.length ? { dropped: r.dropped } : {}) })
  }
  if (changed) Memory.write(w.root, store)
  const drafted = written.filter(x => x.ok && x.draft).map(x => x.id)
  return {
    ok: written.some(x => x.ok),
    written,
    ...(drafted.length ? { next: `show ${drafted.join(', ')} to the person with show, and adopt only what they say yes to` } : {}),
    guidelines: sheet(w.product, store),
  }
}

// ── showing and saying yes ───────────────────────────────────────────────────
// The drafts as the person should see them, word for word, with where each came from.
// Showing is written down: a draft that was never shown cannot be adopted, and a draft
// whose words changed since has to be shown again.
function show(where, opts = {}) {
  const at = opts.now || Date.now()
  const w = place(where)
  if (!w.root) return unplaced('nowhere to read rules from: no memory folder was given')
  if (!w.product) return unplaced('rules belong to one product, and no product was named')
  const store = Memory.read(w.root)
  const pick = opts.ids ? new Set([].concat(opts.ids).map(x => String(x).trim().toUpperCase())) : null
  const drafts = mineOf(store, w.product).filter(f => f.draft && (!pick || pick.has(f.id)))
  if (!drafts.length) return { ok: true, product: w.product, drafts: [], seal: null, text: `Nothing drafted for ${w.product}.` }
  for (const f of drafts) f.shownAt = at
  Memory.write(w.root, store)

  const lines = [`Drafted for ${w.product}. None of these is used until you say yes:`]
  for (const f of drafts) {
    const src = f.evidence ? `${FROM_WORDS[f.from] || 'the agent'}, ${f.evidence}` : (FROM_WORDS[f.from] || 'the agent')
    lines.push(`${f.id} · ${SECTIONS[f.rule].head}: ${f.text} (from ${src})`)
    const old = f.replaces && store.facts.find(x => x.id === f.replaces)
    if (old) lines.push(`    would replace ${old.id}: ${old.text}`)
  }
  return {
    ok: true, product: w.product,
    drafts: drafts.map(f => row(f, store.facts)),
    seal: sealOf(w.product, drafts),
    text: lines.join('\n'),
  }
}

// The person's yes. Every id named, every one of them shown in its current words, and
// the seal from that showing. `edits` is the person rewording a draft on the way in,
// which makes it their sentence: it is judged like any other and goes in as theirs.
function adopt(where, args = {}, opts = {}) {
  const at = opts.now || Date.now()
  const w = place(where)
  if (!w.root) return unplaced('nowhere to keep rules: no memory folder was given')
  if (!w.product) return unplaced('rules belong to one product, and no product was named')
  const ids = [].concat(args.ids || []).map(x => String(x).trim().toUpperCase()).filter(Boolean)
  const refuse = (kind, why) => ({ ok: false, adopted: [], refused: { keep: false, kind, why } })
  if (!ids.length) return refuse('unnamed', 'name the drafts the person said yes to, by id')

  const store = Memory.read(w.root)
  const mine = mineOf(store, w.product)
  const drafts = []
  for (const id of ids) {
    const f = mine.find(x => x.id === id)
    if (!f) return refuse('unknown', `${id} is not a rule for ${w.product}`)
    if (!f.draft) return refuse('in-force', `${id} is already in force`)
    if (!(f.shownAt >= f.updated)) return refuse('unshown', `${id} has not been shown to the person in its current words: call show first`)
    drafts.push(f)
  }
  if (String(args.seal || '') !== sealOf(w.product, drafts)) {
    return refuse('seal', 'the seal does not match these drafts as they were shown: show them again and adopt with the new seal')
  }

  const edits = args.edits && typeof args.edits === 'object' ? args.edits : {}
  for (const f of drafts) {
    const e = edits[f.id] != null ? edits[f.id] : edits[f.id.toLowerCase()]
    if (e == null) continue
    const call = Memory.judge(e, { standing: true })
    if (!call.keep) return { ok: false, adopted: [], refused: { ...call, id: f.id } }
    f.was = f.text
    f.text = clean(e)
    f.from = 'person'
  }
  const adopted = []
  for (const f of drafts) {
    const r = Memory.settle(store, f.id, at, 'person')
    if (r) adopted.push(r.id)
  }
  Memory.write(w.root, store)
  return { ok: true, adopted, guidelines: sheet(w.product, store) }
}

// A draft the person said no to. Only drafts: a rule in force is taken back with
// `forget`, which is the one call that already knows how to say what it removed.
function reject(where, ids) {
  const w = place(where)
  if (!w.root || !w.product) return unplaced('rules belong to one product, and no product was named')
  const want = new Set([].concat(ids || []).map(x => String(x).trim().toUpperCase()))
  let store = Memory.read(w.root)
  const gone = mineOf(store, w.product).filter(f => f.draft && want.has(f.id)).map(f => f.id)
  if (gone.length) {
    store = { ...store, facts: store.facts.filter(f => !gone.includes(f.id)) }
    Memory.write(w.root, store)
  }
  return { ok: gone.length > 0, rejected: gone, guidelines: sheet(w.product, Memory.read(w.root)) }
}

// ── holding work to the rules ────────────────────────────────────────────────
// A rule an agent only reads is a suggestion. Four sections are checked by machine as
// well: the words a product avoids, what must never be on screen, what it is called and
// how its pictures look. Each check says what broke, where, and the call that fixes it,
// and a rule it cannot hold the work to is said to be unchecked rather than passed.
// Audience is the one left to the agent: no frame or field says who a demo is for.

const AVOID_CUE = /\b(avoid|avoids|never|not|no|don't|do not|instead of|rather than|without|ban|banned|drop)\b/i
const QUOTED = /(^|[\s(,:;])["'“‘]([^"'“”‘’]{1,40}?)["'”’](?=$|[\s),.;:!?])/g
const LIST_JOIN = /^[\s,]*(and|or|,)?[\s,]*$/i

// The words one rule avoids, each with what to say instead when the rule names it.
function termsOf(text) {
  const s = String(text || '')
  const out = []
  const said = []
  let last = 0, prev = null
  for (const m of s.matchAll(QUOTED)) {
    const start = m.index + m[1].length
    const between = s.slice(last, start)
    const avoided = AVOID_CUE.test(between) ? true : (prev != null && LIST_JOIN.test(between) ? prev : false)
    ;(avoided ? out : said).push(m[2].trim())
    prev = avoided
    last = m.index + m[0].length
  }
  if (!out.length && !said.length) {
    const m = s.match(/\b(?:avoid|never say|never use|never write|don't say|do not say|don't use|do not use|no)\b\s*:?\s*(.+)$/i)
    if (m) {
      for (const t of m[1].split(/,|\band\b|\bor\b/i)) {
        const term = t.replace(/[.;!]+$/, '').trim()
        if (term && term.split(/\s+/).length <= 3) out.push(term)
      }
    }
  }
  const instead = said.length ? said[0] : null
  return out.filter(Boolean).map(term => ({ term, ...(instead ? { instead } : {}) }))
}

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Every avoided word in a piece of text, where it is and what to say instead.
function avoidedIn(text, rules) {
  const s = String(text || '')
  const hits = []
  for (const r of rules || []) {
    if (r.section !== 'words' && r.rule !== 'words') continue
    for (const t of termsOf(r.text)) {
      const re = new RegExp(`(^|[^A-Za-z0-9])(${esc(t.term)})(?=$|[^A-Za-z0-9])`, 'i')
      const m = s.match(re)
      if (m) hits.push({ term: t.term, at: m.index + m[1].length, rule: r.id, ...(t.instead ? { instead: t.instead } : {}) })
    }
  }
  return hits
}

const NEVER_OBJ = [
  /\b(?:never|don't|do not|must not|mustn't|cannot|can't|should not|shouldn't)\s+(?:ever\s+)?(?:show|record|film|capture|include|reveal|open|put)\s+(.+?)(?=[,.;]|\s+(?:on screen|in (?:a|any|the) (?:demo|take|video|screenshot|recording)s?)\b|$)/i,
  /\bkeep\s+(.+?)\s+off(?:\s+(?:the\s+)?screen)?\b/i,
  /^(.+?)\s+(?:must|should|can|is|are)?\s*(?:never|not)\s+(?:be\s+)?(?:on screen|shown|visible|seen|recorded|appear)/i,
]
const THIN = new Set(['the', 'a', 'an', 'any', 'our', 'my', 'their', 'its', 'his', 'her', 'your', 'this', 'that', 'of', 'or', 'and', 'ever', 'real'])
const words = s => clean(s).toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/)
  .filter(w => w && !THIN.has(w)).map(w => w.length > 3 ? w.replace(/(ies)$/, 'y').replace(/s$/, '') : w)

// What one never-rule keeps off screen, as the words a label would carry.
function neverOf(text) {
  for (const re of NEVER_OBJ) {
    const m = String(text || '').match(re)
    if (m && words(m[1]).length) return clean(m[1])
  }
  return null
}

// ── what a never-rule is about, by its shape ─────────────────────────────────
// "Never show an email address" is not about the words "email address". A label reading
// Email is the name of a field; maya@biscuit.test is the thing the person meant. So a
// never-rule that names a kind of thing with a shape of its own is held to that shape,
// read off every element and every word on the frame, and not to its own words. The
// shapes are Memory's where Memory already has one (a key, a token, a card number), so
// what is refused as a fact is found on a screen by the same test.
//
// A kind with no shape (a person's name, a street address) is said to be unchecked, with
// the reason, and never passes: "Maya Chen" and "Morning oats" are the same shape.
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/
const PHONE = /(?:^|[^\d\w])((?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?|\d{2,4}[\s.-])\d{3,4}[\s.-]\d{3,4})(?![\d\w])/
const phoneIn = s => {
  const m = String(s || '').match(PHONE)
  if (!m) return null
  const digits = m[1].replace(/\D/g, '').length
  return digits >= 9 && digits <= 15 ? { at: m.index + m[0].length - m[1].length, len: m[1].length } : null
}
const secretOf = (want) => s => {
  const h = Memory.secretIn(s)
  return h && want(h.kind) ? h : null
}
const KINDS = [
  { kind: 'email', what: 'an email address', named: /\be-?mails?\b/i,
    find: s => { const m = String(s || '').match(EMAIL); return m ? { at: m.index, len: m[0].length } : null } },
  { kind: 'phone', what: 'a phone number', named: /\b(phone|telephone|mobile|cell)( numbers?)?\b/i,
    find: s => (secretOf(k => k === 'a card number')(s) ? null : phoneIn(s)) },
  { kind: 'card', what: 'a card number', secret: true, named: /\b(card numbers?|credit cards?|debit cards?|payment cards?)\b/i,
    find: secretOf(k => k === 'a card number') },
  { kind: 'secret', what: 'a key, token or password', secret: true,
    named: /\b(api[ _-]?keys?|keys?|tokens?|passwords?|passcodes?|secrets?|credentials?)\b/i,
    find: secretOf(k => k !== 'a card number') },
]
const SHAPELESS = [
  { kind: 'person', named: /\b(names? of (people|customers|users|patients|students|clients|staff)|(people|person|customer|user|patient|student|client|staff|real|full)(?:'s|s'|s)? names?)\b/i,
    why: "a person's name has no shape of its own: \"Maya Chen\" reads exactly like \"Morning oats\", so no check of the words can find one" },
  { kind: 'address', named: /\b(home|street|postal|mailing|shipping|delivery|house) address(es)?\b/i,
    why: 'a street address is written too many ways to be told from other words by its shape' },
]

// The kinds one never-rule names. Read off the thing the rule keeps off screen when it
// can be told, so "never show the admin panel, it lists emails" is about the panel.
function neverKinds(text) {
  const about = neverOf(text) || String(text || '')
  const shaped = KINDS.filter(k => k.named.test(about))
  // "email addresses" is an email, not a street address
  const shapeless = SHAPELESS.filter(k => k.named.test(about) && !(k.kind === 'address' && shaped.some(x => x.kind === 'email')))
  return { shaped, shapeless }
}

const labelText = l => (typeof l === 'string' ? l : l && (l.label || l.text || l.name)) || ''

// Labels read off a frame (find_on_screen's boxes, a window title) that a never-rule
// names. A label hits when it carries every word of the thing, or two thirds of a thing
// named in three words or more: "Email addresses" is the customer email addresses. A
// rule about a kind of thing also hits on the thing itself, by its shape, and that hit
// never repeats the value: a check that quotes the address back has put it in one more place.
function onScreen(labels, rules) {
  const hits = []
  for (const r of rules || []) {
    if (r.section !== 'never' && r.rule !== 'never') continue
    const thing = neverOf(r.text)
    const { shaped } = neverKinds(r.text)
    const want = thing ? words(thing) : []
    for (const label of [].concat(labels || [])) {
      const text = labelText(label)
      if (!text) continue
      const id = label && label.id ? { id: label.id } : {}
      if (want.length) {
        const have = new Set(words(text))
        const shared = want.filter(x => have.has(x)).length
        const enough = shared === want.length || (want.length >= 3 && shared / want.length >= 2 / 3)
        if (enough) { hits.push({ label: text, thing, rule: r.id, ...id }); continue }
      }
      const k = shaped.find(k => k.find(text))
      if (k) hits.push({ label: k.what, thing: thing || k.what, kind: k.kind, rule: r.id, ...id })
    }
  }
  return hits
}

// ── the name ─────────────────────────────────────────────────────────────────
// What the product is called, and what it must not be called, read off a name rule:
// "the product is called Biscuit's Pantry, never Biscuits Pantry", "always 'Lyricly',
// never 'Lyrically'", "Songscription, formerly Scorely". Null when the rule says no name
// a check can hold words to, and the check then says so rather than passing.
const CAP_RUN = "([A-Z0-9][\\w'’.&+-]*(?:\\s+(?:[A-Z0-9][\\w'’.&+-]*|of|the|and|for|de|la))*)"
// A name can carry its own apostrophe ("Biscuit's Pantry"), so double and curly quotes
// take anything up to their pair; a single straight quote cannot, and stops at the next.
const NAME_QUOTED = /(^|[\s(,:;])(?:"([^"]{1,60})"|\u201c([^\u201d]{1,60})\u201d|'([^']{1,60})'(?=$|[\s),.;:!?])|\u2018([^\u2019]{1,60}?)\u2019(?=$|[\s),.;:!?]))/g
const OLD_CUE = /\b(never|not|no longer|formerly|previously|used to be(?: called)?|was(?: called| named)?|old name(?: is| was)?|instead of|rather than)\s*$/i
function nameOf(text) {
  const s = String(text || '')
  let name = null
  const old = []
  for (const m of s.matchAll(NAME_QUOTED)) {
    const said = (m[2] || m[3] || m[4] || m[5] || '').trim()
    if (!said) continue
    if (OLD_CUE.test(s.slice(0, m.index + m[1].length))) old.push(said)
    else if (!name) name = said
  }
  if (!name) {
    for (const re of [new RegExp(`\\b(?:called|named|spelled|spelt|written as|written|always)\\s+${CAP_RUN}`),
      new RegExp(`^${CAP_RUN}(?=\\s*(?:,|\\bis\\b|$))`)]) {
      const m = s.match(re)
      if (m && !OLD_CUE.test(s.slice(0, m.index))) { name = trimName(m[1]); break }
    }
  }
  for (const m of s.matchAll(new RegExp(`\\b(?:never|not|no longer|formerly|previously|used to be(?: called)?|was(?: called| named)?|old name(?: is| was)?|instead of|rather than)\\s+${CAP_RUN}`, 'g'))) {
    const o = trimName(m[1])
    if (o && o !== name && !old.includes(o)) old.push(o)
  }
  return name ? { name, old: old.filter(o => o.toLowerCase() !== name.toLowerCase()) } : null
}
// A capitalised run can swallow the sentence's next word ("Biscuit's Pantry With") only
// when that word is capitalised, which a rule's lower-case prose is not; a trailing
// full stop is punctuation, not part of the name.
const trimName = s => String(s || '').replace(/[.,;:!?]+$/, '').replace(/(\s+(of|the|and|for|de|la))+$/, '').trim() || null

const APOS = /[‘’ʼ`]/g
const flat = s => String(s).replace(APOS, "'")
const squash = s => flat(s).toLowerCase().replace(/[^a-z0-9]/g, '')
function distance(a, b) {
  if (a === b) return 0
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = cur
  }
  return prev[b.length]
}

// Every place a text calls the product something else: an old name, a near spelling
// ("Biscuits Pantry", "Songsciption"), the words run together or pulled apart, or the
// right letters in the wrong case. A short one-word name met all in lower case is left
// alone, because "fetch the file" is a verb and not a misspelling of Fetch; a line set
// all in capitals is a style, not a spelling.
function misnamed(text, rule) {
  const s = String(text || '')
  const n = rule && nameOf(rule.text)
  if (!n) return []
  const hits = []
  for (const o of n.old) {
    const re = new RegExp(`(^|[^A-Za-z0-9])(${esc(o)})(?=$|[^A-Za-z0-9])`, 'gi')
    for (const m of s.matchAll(re)) hits.push({ at: m.index + m[1].length, len: m[2].length, said: m[2], name: n.name, old: true, rule: rule.id })
  }
  const toks = [...s.matchAll(/[\p{L}\p{N}][\p{L}\p{N}'’.&+-]*/gu)]
    .map(m => { const t = m[0].replace(/[.]+$/, ''); return { at: m.index, end: m.index + t.length } })
  const want = squash(n.name)
  const k = n.name.split(/\s+/).length
  const most = want.length >= 9 ? 2 : want.length >= 4 ? 1 : 0
  // a short one-word name with only its first letter capitalised may be an ordinary word
  // too (Fetch, Notion), so met in lower case it is left alone; a coined one is not
  const plainWord = k === 1 && n.name.length <= 7 && /^[A-Z][a-z]+$/.test(n.name)
  const taken = (a, b) => hits.some(h => a < h.at + h.len && b > h.at)
  for (let i = 0; i < toks.length; i++) {
    for (const size of [k, k + 1, k - 1].filter(x => x >= 1)) {
      if (i + size > toks.length) continue
      const a = toks[i].at, b = toks[i + size - 1].end
      if (taken(a, b)) continue
      const said = s.slice(a, b)
      const plain = flat(said).replace(/'s$/i, '')
      if (flat(said) === flat(n.name) || plain === flat(n.name)) continue
      const got = squash(said), got2 = squash(plain)
      const shouted = said === said.toUpperCase() && flat(said).toUpperCase() === flat(n.name).toUpperCase()
      if (shouted) continue
      const caseOnly = got === want || got2 === want
      if (caseOnly && plainWord && !/[A-Z]/.test(said)) continue
      const near = !caseOnly && most > 0 && got[0] === want[0] &&
        Math.abs(got.length - want.length) <= most && Math.min(distance(got, want), distance(got2, want)) <= most
      if (caseOnly || near) { hits.push({ at: a, len: b - a, said, name: n.name, rule: rule.id }); break }
    }
  }
  return hits.sort((x, y) => x.at - y.at)
}

// ── the look ─────────────────────────────────────────────────────────────────
// A look rule is prose ("screenshots on warm cream, with the device frame, no shadow"),
// so it is read clause by clause into the fields of the look it constrains, and each
// clause is held to the edit's look. A clause that names nothing a look field decides
// ("feels calm", "dark mode in the app") is returned as unchecked with the clause
// quoted, never dropped: silence about half a rule reads as that half having passed.

// Colour words as tests on hue (degrees), saturation and lightness (0 to 1).
const HSL = hex => {
  const m = String(hex || '').match(/^#?([0-9a-f]{6})$/i)
  if (!m) return null
  const [r, g, b] = [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16) / 255)
  const hi = Math.max(r, g, b), lo = Math.min(r, g, b), l = (hi + lo) / 2
  if (hi === lo) return { h: 0, s: 0, l }
  const d = hi - lo
  const s = l > 0.5 ? d / (2 - hi - lo) : d / (hi + lo)
  const h = hi === r ? ((g - b) / d + (g < b ? 6 : 0)) : hi === g ? (b - r) / d + 2 : (r - g) / d + 4
  return { h: h * 60, s, l }
}
const hueIn = (h, a, b) => (a <= b ? h >= a && h <= b : h >= a || h <= b)
const TONES = {
  cream: c => c.l >= 0.8 && hueIn(c.h, 20, 65) && c.s >= 0.15,
  ivory: c => c.l >= 0.85 && hueIn(c.h, 20, 70) && c.s >= 0.1,
  beige: c => c.l >= 0.65 && c.l < 0.93 && hueIn(c.h, 20, 55) && c.s >= 0.12,
  white: c => c.l >= 0.93,
  black: c => c.l <= 0.1,
  dark: c => c.l <= 0.3,
  deep: c => c.l <= 0.35,
  light: c => c.l >= 0.7,
  pale: c => c.l >= 0.75,
  warm: c => c.s >= 0.08 && hueIn(c.h, 330, 70),
  cool: c => c.s >= 0.08 && hueIn(c.h, 170, 280),
  neutral: c => c.s <= 0.2,
  grey: c => c.s <= 0.15 && c.l > 0.12 && c.l < 0.88,
  gray: c => c.s <= 0.15 && c.l > 0.12 && c.l < 0.88,
  blue: c => c.s >= 0.2 && hueIn(c.h, 190, 250),
  navy: c => c.s >= 0.2 && hueIn(c.h, 200, 250) && c.l <= 0.3,
  green: c => c.s >= 0.2 && hueIn(c.h, 80, 170),
  red: c => c.s >= 0.3 && hueIn(c.h, 345, 15),
  orange: c => c.s >= 0.3 && hueIn(c.h, 15, 45),
  gold: c => c.s >= 0.3 && hueIn(c.h, 30, 55) && c.l >= 0.35,
  yellow: c => c.s >= 0.3 && hueIn(c.h, 45, 65),
  purple: c => c.s >= 0.2 && hueIn(c.h, 255, 300),
  pink: c => c.s >= 0.3 && hueIn(c.h, 300, 350) && c.l >= 0.5,
  brown: c => c.s >= 0.15 && hueIn(c.h, 10, 45) && c.l < 0.45,
}
// Colours a fix can offer, tried in order: the first that passes every word of the rule
// is the one sent.
const OFFER = ['#F3EADB', '#F8F4EA', '#E8DCC8', '#EDE6DA', '#FFFFFF', '#1A1714', '#0A0908', '#1F2430', '#14213D',
  '#8A8580', '#D9D6D2', '#DCE8F5', '#2F6FDE', '#2E9E5B', '#D63A3A', '#F08A3C', '#F0A93C', '#F2CF4A', '#7C5CE0', '#E26BA6', '#6B4A2E']
const TONE_WORD = new RegExp(`\\b(${Object.keys(TONES).join('|')})\\b`, 'gi')
const HEX = /#[0-9a-f]{6}\b/i
const groundRe = new RegExp(`\\b(backgrounds?|backdrops?|behind|ground|wallpaper|on (?:a |an )?(?:[a-z]+ )?(?:${Object.keys(TONES).join('|')}))\\b|${HEX.source}`, 'i')
const PRESET = /\b(dusk|ember|mint|violet|slate|ink|studio)\b/i

const STILL_ONLY = /\b(screenshots?|stills?|images?|pictures?|pngs?)\b/i
const MOVING = /\b(videos?|recordings?|demos?|takes?|clips?|exports?|gifs?|movies?)\b/i

// The background's colours as they would be drawn, from the look's own tables.
function groundOf(L) {
  const bg = L.background || {}
  const S = require('./look-schema')
  if (bg.kind === 'solid') return { kind: 'solid', colours: [bg.color] }
  if (bg.kind === 'gradient') return { kind: 'gradient', name: bg.gradient, colours: S.GRADIENTS[bg.gradient] || [] }
  if (bg.kind === 'mesh') return { kind: 'mesh', name: bg.mesh, colours: (S.MESHES[bg.mesh] || []).map(p => p[3]) }
  return { kind: bg.kind || 'none', colours: [] }
}
const mean = cols => {
  const ok = cols.map(c => String(c).match(/^#?([0-9a-f]{6})$/i)).filter(Boolean)
  if (!ok.length) return null
  const sum = [0, 0, 0]
  for (const m of ok) for (let i = 0; i < 3; i++) sum[i] += parseInt(m[1].slice(i * 2, i * 2 + 2), 16)
  return '#' + sum.map(v => Math.round(v / ok.length).toString(16).padStart(2, '0')).join('').toUpperCase()
}
const rgbGap = (a, b) => {
  const p = h => [0, 2, 4].map(i => parseInt(h.replace('#', '').slice(i, i + 2), 16))
  const x = p(a), y = p(b)
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2])
}

// One look rule, read into what it asks of the look. Each want is
// { clause, path, test(L, ctx) -> null | { was, fix } } or { clause, unchecked: why }.
function lookWants(text) {
  const out = []
  const clauses = String(text || '').split(/[.;,]|\s+and\s+|\s+with\s+|\s+but\s+/i).map(s => s.trim()).filter(Boolean)
  for (const clause of clauses) {
    const got = []
    const no = /\b(no|without|never|not|off|none)\b/i.test(clause)
    // shape
    const ratio = clause.match(/\b(16:9|9:16|4:3|1:1|4:5)\b/)
    const shape = ratio ? ratio[1]
      : /\bsquare\b(?!\s+(corners?|edges?))/i.test(clause) ? '1:1'
        : /\b(portrait|vertical)\b/i.test(clause) ? 'portrait'
          : /\b(landscape|widescreen|horizontal)\b/i.test(clause) ? 'landscape' : null
    if (shape) got.push({ clause, path: 'frame.aspect', want: shape, test: aspectTest(shape) })
    // device frame
    const dev = clause.match(/\b(browser|window|laptop|phone|device)\b[\s-]*(frame|bezel|chrome|mock-?up)|\bbezels?\b|\bframed in (?:a |an )?(browser|window|laptop|phone)\b/i)
    if (dev) {
      const kind = (dev[1] || dev[3] || 'device').toLowerCase()
      got.push({ clause, path: 'device.kind', want: no ? 'none' : kind, test: deviceTest(no ? 'none' : kind) })
    }
    // corners
    const px = clause.match(/\b(\d{1,2})\s*(?:px|pixels?|pt|points?)?\s*(?:rounded\s+)?(?:corners?|radius)\b|\b(?:corner\s+)?radius\s+(?:of\s+)?(\d{1,2})\b/i)
    if (px) got.push({ clause, path: 'frame.radius', want: +(px[1] || px[2]), test: L => Math.abs(L.frame.radius - +(px[1] || px[2])) <= 1 ? null : { was: L.frame.radius, set: { frame: { radius: +(px[1] || px[2]) } } } })
    else if (/\b(square|sharp|hard)\s+(corners?|edges?)\b|\bno\s+(rounded\s+)?corners?\b/i.test(clause)) got.push({ clause, path: 'frame.radius', want: 0, test: L => L.frame.radius === 0 ? null : { was: L.frame.radius, set: { frame: { radius: 0 } } } })
    else if (/\b(rounded|round|soft)\s+corners?\b/i.test(clause)) got.push({ clause, path: 'frame.radius', want: 'rounded', test: L => L.frame.radius > 0 ? null : { was: 0, set: { frame: { radius: 14 } } } })
    // shadow
    if (/\bshadows?\b/i.test(clause)) {
      got.push(no
        ? { clause, path: 'frame.shadow', want: 0, test: L => L.frame.shadow === 0 ? null : { was: L.frame.shadow, set: { frame: { shadow: 0 } } } }
        : { clause, path: 'frame.shadow', want: 'a shadow', test: L => L.frame.shadow > 0 ? null : { was: 0, set: { frame: { shadow: 0.6 } } } })
    } else if (/\bflat\b/i.test(clause)) {
      got.push({ clause, path: 'frame.shadow', want: 0, test: L => L.frame.shadow === 0 ? null : { was: L.frame.shadow, set: { frame: { shadow: 0 } } } })
    }
    // captions
    if (/\b(captions?|subtitles?)\b/i.test(clause)) {
      const where = clause.match(/\b(top|bottom|middle)\b/i)
      if (where) got.push({ clause, path: 'captions.position', want: where[1].toLowerCase(), test: L => L.captions.position === where[1].toLowerCase() ? null : { was: L.captions.position, set: { captions: { position: where[1].toLowerCase() } } } })
      else got.push({ clause, path: 'captions.show', want: !no, test: L => !!L.captions.show === !no ? null : { was: !!L.captions.show, set: { captions: { show: !no } } } })
    }
    // cursor
    if (/\b(cursor|pointer)\b/i.test(clause) && (no || /\bhid(e|den)\b/i.test(clause))) {
      got.push({ clause, path: 'cursor.show', want: false, test: L => !L.cursor.show ? null : { was: true, set: { cursor: { show: false } } } })
    }
    // background: a named preset, a hex, or colour words, when the clause is about the ground
    const aboutGround = groundRe.test(clause) || (/\b(gradient|mesh)\b/i.test(clause))
    const preset = clause.match(PRESET)
    if (aboutGround && preset && /\b(gradient|mesh|background|backdrop)\b/i.test(clause)) {
      const name = preset[1].toLowerCase()
      got.push({ clause, path: 'background', want: name, test: L => {
        const g = groundOf(L)
        return (g.kind === 'gradient' || g.kind === 'mesh') && g.name === name ? null
          : { was: g.name ? `${g.kind} ${g.name}` : g.kind, set: { background: { kind: 'mesh', mesh: name } } }
      } })
    } else if (aboutGround && /\b(no|without|transparent)\s+(background|backdrop)\b/i.test(clause)) {
      got.push({ clause, path: 'background.kind', want: 'none', test: L => L.background.kind === 'none' ? null : { was: L.background.kind, set: { background: { kind: 'none' } } } })
    } else if (aboutGround) {
      const hex = clause.match(HEX)
      const tones = [...clause.matchAll(TONE_WORD)].map(m => m[1].toLowerCase())
      if (hex || tones.length) got.push({ clause, path: 'background', want: hex ? hex[0].toUpperCase() : tones.join(' '), ground: true, test: groundTest(hex && hex[0], tones) })
    }
    if (got.length) out.push(...got)
    else if (clause.split(/\s+/).length >= 2) out.push({ clause, unchecked: `"${clause}" names nothing an edit's look decides, so it is for the agent to follow by eye` })
  }
  return out
}

function aspectTest(want) {
  const Look = require('./look')
  return (L, ctx) => {
    const set = want === 'portrait' ? '9:16' : want === 'landscape' ? '16:9' : want
    let shape = L.frame.aspect === 'auto' ? ctx.takeAspect : Look.aspectNumber(L.frame.aspect)
    if (!(shape > 0)) return { unknown: `the shape is the take's own (auto) and the take's width and height were not given` }
    const ok = want === 'portrait' ? shape < 1 : want === 'landscape' ? shape > 1 : Math.abs(shape - Look.aspectNumber(want)) < 0.01
    return ok ? null : { was: L.frame.aspect === 'auto' ? `auto (${Math.round(shape * 100) / 100})` : L.frame.aspect, set: { frame: { aspect: set } } }
  }
}
function deviceTest(want) {
  return L => {
    const k = L.device.kind
    const ok = want === 'none' ? k === 'none' : want === 'device' ? k !== 'none' : k === want
    return ok ? null : { was: k, set: { device: { kind: want === 'device' ? 'window' : want } } }
  }
}
function groundTest(hex, tones) {
  return L => {
    const g = groundOf(L)
    const offer = hex ? hex.toUpperCase() : OFFER.find(c => { const h = HSL(c); return tones.every(t => TONES[t](h)) })
    const set = offer ? { background: { kind: 'solid', color: offer } } : null
    if (g.kind === 'none') return { was: 'no background: the take fills the frame and nothing is drawn round it', set }
    if (!g.colours.length) {
      return { unknown: `the background is ${g.kind === 'image' ? 'an image' : 'the take blurred'}, and its tone is in pixels this check does not read` }
    }
    const avg = mean(g.colours)
    const ok = hex ? rgbGap(avg, hex) <= 28 : tones.every(t => TONES[t](HSL(avg)))
    return ok ? null : { was: `${g.kind}${g.name ? ' ' + g.name : ''} ${avg}`, set }
  }
}

// ── holding a piece of work to every rule ────────────────────────────────────
// What a check is handed, all of it optional:
//   doc     the edit or the shot, so its own words (texts, captions, marks' labels, the
//           drawn window's title), its look and its redactions are all read from it
//   look    a look alone, when there is no document
//   frames  what was read off the picture: [{ at, elements }], elements as
//           find_on_screen hands them ({ id, text or label, box }) or plain strings.
//           `labels` (and `at`) is one frame, the way the bridge already sends it
//   text    words handed in that are not on the document (a title, a filename)
//   width, height   the take's own size, for a look whose shape is auto
//   path    the recording or the shot, put on every fix so it can be sent as it stands
//
// It answers the way review does: every finding is { rule, guideline, severity, what,
// where, fix: { tool, args, why } }, where `guideline` is the F id that was broken. And
// every rule it could not hold the work to is in `unchecked` with the reason and, where
// there is one, the call that would let it: `clean` is only true when both are empty.

const SEV = { never: 'blocking', name: 'should', words: 'should', look: 'should' }
const GAP = 4
const r2 = n => Math.round(n * 100) / 100

// The words the work puts on the picture, each with where it lives.
function saidOn(doc, text) {
  const out = []
  const d = doc || {}
  for (const list of ['texts', 'cues', 'marks']) {
    for (const it of Array.isArray(d[list]) ? d[list] : []) {
      for (const field of ['text', 'title', 'sub', 'label']) {
        if (it && typeof it[field] === 'string' && it[field].trim()) out.push({ text: it[field], where: { list, id: it.id || null, field } })
      }
    }
  }
  const title = d.look && d.look.device && d.look.device.title
  if (typeof title === 'string' && title.trim()) out.push({ text: title, where: { look: 'device.title' } })
  ;[].concat(text == null ? [] : text).forEach((t, i) => {
    if (typeof t === 'string' && t.trim()) out.push({ text: t, where: { given: i } })
  })
  return out
}

// One call that makes every rewrite at once, per place. A list is replaced whole by
// apply_edit, so a fix built from the document as it was for T1 alone would put T2 back
// the moment it was sent after T2's: every text fix carries every rewrite in its list.
function rewrites(doc, edits, call) {
  const d = doc || {}
  const byList = {}
  for (const e of edits) {
    const k = e.where.list ? e.where.list : e.where.look ? 'look' : 'given'
    ;(byList[k] = byList[k] || []).push(e)
  }
  // a word the rule swaps keeps the case it was met in ("Simply" becomes "Just"); a name
  // is written the one way it is written
  const cased = (was, to, name) => !name && /^[A-Z]/.test(was) && /^[a-z]/.test(to) ? to[0].toUpperCase() + to.slice(1) : to
  const apply = (s, es) => es.slice().sort((a, b) => b.at - a.at)
    .reduce((t, e) => t.slice(0, e.at) + cased(t.slice(e.at, e.at + e.len), e.to, e.name) + t.slice(e.at + e.len), s)
  const same = (a, b) => a.where.id === b.where.id && a.where.field === b.where.field
  const fixes = {}
  for (const list of ['texts', 'cues']) {
    if (!byList[list]) continue
    const next = (d[list] || []).map(it => {
      const mine = byList[list].filter(e => e.where.id === (it.id || null))
      if (!mine.length) return it
      const out = { ...it }
      for (const f of new Set(mine.map(e => e.where.field))) out[f] = apply(it[f], mine.filter(e => e.where.field === f))
      return out
    })
    fixes[list] = call('apply_edit', { doc: { [list]: next } },
      `${list} is replaced whole, so this is the whole list with every rewrite in it; send it once`)
  }
  if (byList.marks) {
    const ids = [...new Set(byList.marks.map(e => e.where.id))]
    fixes.marks = call('apply_edit', { doc: { marks: ids.map(id => {
      const mine = byList.marks.filter(e => e.where.id === id)
      const m = (d.marks || []).find(x => x.id === id) || {}
      const out = { id }
      for (const f of new Set(mine.map(e => e.where.field))) out[f] = apply(m[f], mine.filter(e => e.where.field === f))
      return out
    }) } }, 'marks merge by id, so only these labels change')
  }
  if (byList.look) {
    const t = d.look.device.title
    fixes.look = call('apply_look', { look: { device: { title: apply(t, byList.look) } } }, 'the title drawn in the window frame')
  }
  if (byList.given) {
    for (const e of byList.given) {
      const key = 'given' + e.where.given
      if (fixes[key]) continue
      const mine = byList.given.filter(x => x.where.given === e.where.given && same(x, e))
      fixes[key] = { tool: null, args: { text: apply(e.text, mine) },
        why: 'these words were handed in rather than read off the edit: use them as written here' }
    }
  }
  return e => fixes[e.where.list || (e.where.look ? 'look' : 'given' + e.where.given)]
}

const covers = (m, b) => {
  const ix = Math.max(0, Math.min(m.x + m.w, b.x + b.w) - Math.max(m.x, b.x))
  const iy = Math.max(0, Math.min(m.y + m.h, b.y + b.h) - Math.max(m.y, b.y))
  return b.w * b.h > 0 && ix * iy >= 0.9 * b.w * b.h
}
const boxOf = e => {
  const b = e && typeof e === 'object' && (e.box || (Number.isFinite(+e.x) && Number.isFinite(+e.w) ? e : null))
  return b && +b.w > 0 && +b.h > 0 ? { x: +b.x, y: +b.y, w: +b.w, h: +b.h } : null
}
// A redaction or a blur over this box at this moment. A blur is not enough for a key, a
// token or a card number: it softens and can be undone.
function hiddenBy(doc, box, at, secret) {
  if (!box || !doc) return null
  const still = doc.kind === 'shot'
  for (const m of Array.isArray(doc.marks) ? doc.marks : []) {
    if (!m || (m.kind !== 'redact' && m.kind !== 'blur')) continue
    if (!still && at != null && Number.isFinite(+m.start) && Number.isFinite(+m.end) && !(at >= +m.start && at <= +m.end)) continue
    if (!covers({ x: +m.x, y: +m.y, w: +m.w, h: +m.h }, box)) continue
    return { id: m.id || null, kind: m.kind, weak: m.kind === 'blur' && !!secret }
  }
  return null
}

function framesOf(args) {
  if (Array.isArray(args.frames)) return args.frames.map(f => ({ at: f && Number.isFinite(+f.at) ? +f.at : null, elements: [].concat((f && (f.elements || f.labels || f.words)) || []) }))
  if (args.labels != null || args.elements != null) {
    return [{ at: Number.isFinite(+args.at) ? +args.at : null, elements: [].concat(args.elements || [], args.labels || []) }]
  }
  return []
}

// The stretches of the kept take no frame was read near. A frame is taken to speak for
// GAP seconds round it and no further: what is on a screen changes between frames.
function unread(doc, frames) {
  if (!doc || doc.kind === 'shot') return null
  const kept = Array.isArray(doc.clips) && doc.clips.length ? doc.clips.map(c => [+c.start, +c.end])
    : +doc.dur > 0 ? [[0, +doc.dur]] : null
  const times = frames.map(f => f.at).filter(t => t != null).sort((a, b) => a - b)
  if (!kept) return { unknown: 'how long the take is was not known, so whether the frames read cover it could not be told' }
  if (times.length < frames.length) return { unknown: 'a frame was read with no time, so which part of the take it speaks for could not be told' }
  const gaps = []
  for (const [a, b] of kept) {
    let from = a
    for (const t of times) {
      if (t + GAP / 2 <= from) continue
      if (t - GAP / 2 > from) gaps.push([from, Math.min(b, t - GAP / 2)])
      from = Math.max(from, t + GAP / 2)
      if (from >= b) break
    }
    if (from < b) gaps.push([from, b])
  }
  const real = gaps.filter(([a, b]) => b - a >= 0.5).map(([a, b]) => [r2(a), r2(b)])
  return real.length ? { gaps: real } : null
}

function neverFindings(rules, frames, doc, call, out) {
  const own = saidOn(doc, null)
  const shot = doc && doc.kind === 'shot'
  for (const r of rules) {
    const thing = neverOf(r.text)
    const { shaped, shapeless } = neverKinds(r.text)
    for (const k of shapeless) {
      out.unchecked.push({ rule: 'rule-never', guideline: r.id, section: 'never', why: k.why + ', so this rule was not checked and has not passed',
        fix: call(shot ? 'get_frame' : 'preview_frame', {}, 'look at the picture yourself and redact any you see with apply_edit') })
    }
    if (!thing && !shaped.length && !shapeless.length) {
      out.unchecked.push({ rule: 'rule-never', guideline: r.id, section: 'never',
        why: `"${r.text}" does not say what must stay off screen in words a check can look for` })
      continue
    }
    if (!shaped.length && (shapeless.length || !thing)) continue
    if (!frames.length) {
      out.unchecked.push({ rule: 'rule-never', guideline: r.id, section: 'never',
        why: 'nothing was read off the picture, so what is on screen was not checked against this rule',
        fix: call('find_on_screen', {}, 'read the words and elements off the frame, then check again with them') })
    }
    // the picture: a kind by its shape, anything else by its words
    // One finding per thing seen, however many frames it was seen on: the same id on
    // five frames is one redaction over the whole stretch, not five findings.
    const seen = new Map()
    for (const f of frames) {
      for (const el of f.elements) {
        const text = labelText(el)
        if (!text) continue
        let kind = null, what = null
        if (shaped.length) {
          const k = shaped.find(k => k.find(text))
          if (!k) continue
          kind = k; what = k.what
        } else {
          if (!onScreen([text], [r]).length) continue
          what = `"${text}"`
        }
        const box = boxOf(el)
        const id = el && el.id ? String(el.id) : null
        const under = hiddenBy(doc, box, f.at, kind && kind.secret)
        if (under && !under.weak) { out.covered.push({ guideline: r.id, ...(id ? { id } : {}), ...(f.at != null ? { frame: f.at } : {}), by: under.id }); continue }
        const key = id || (box ? JSON.stringify(box) : text)
        const one = seen.get(key) || { what, kind, id, box, at: [], weak: null }
        if (f.at != null) one.at.push(f.at)
        if (under && under.weak) one.weak = under.id
        seen.set(key, one)
      }
    }
    for (const { what, kind, id, box, at, weak } of seen.values()) {
      const when = at.length && !shot ? { start: r2(Math.max(0, Math.min(...at) - GAP / 2)), end: r2(Math.max(...at) + GAP / 2) } : {}
      const where = { ...(at.length ? { frames: at } : {}), ...(id ? { id } : {}), ...(box ? { box } : {}) }
      const fix = weak
        ? call('apply_edit', { doc: { marks: [{ id: weak, kind: 'redact' }] } }, 'a blur can be undone; the same box as a redaction cannot')
        : id || box
          ? call('apply_edit', { doc: { marks: [{ kind: 'redact', ...(id ? { element: id } : { box }), ...when }] } },
            shot ? 'a redaction destroys that box on the picture' :
              `a redaction on that box from ${GAP / 2} s before the first frame it was read on to ${GAP / 2} s after the last; ` +
              'read the frames either side with find_on_screen and widen it to every moment it shows')
          : call('find_on_screen', at.length ? { at: at[0] } : {}, 'it was read with no box, so find it again and redact the box that comes back')
      out.findings.push({ rule: 'rule-never', guideline: r.id, severity: 'blocking',
        what: `${what}${id ? ` (${id})` : ''} is on the picture${at.length && !shot ? ` at ${at.map(r2).join(', ')} s` : ''}, and ${r.id} keeps ${thing || kind.what} off screen` +
          `${weak ? `: ${weak} only blurs it, and a blur can be undone` : ''}.`,
        where, fix })
    }
    // the edit's own words
    for (const s of own) {
      const k = shaped.find(k => k.find(s.text))
      const lit = !shaped.length && thing && onScreen([s.text], [r]).length
      if (!k && !lit) continue
      out.findings.push({ rule: 'rule-never', guideline: r.id, severity: 'blocking',
        what: `${s.where.id || s.where.look}'s own words carry ${k ? k.what : `"${thing}"`}, which must never be on screen.`,
        where: s.where, fix: call('get_edit', {}, `take it out of ${s.where.id || s.where.look} and send the change with apply_edit`) })
    }
  }
  if (rules.length && frames.length) {
    const u = unread(doc, frames)
    if (u) {
      const mid = u.gaps ? u.gaps.slice().sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]))[0] : null
      out.unchecked.push({ rule: 'rule-never', section: 'never', guideline: rules.map(r => r.id).join(', '),
        why: u.unknown || `the never-rules were held to ${frames.length} frame${frames.length === 1 ? '' : 's'}; ` +
          `${u.gaps.map(([a, b]) => `${a} to ${b} s`).join(', ')} of the kept take ${u.gaps.length === 1 ? 'was' : 'were'} not read`,
        ...(mid ? { where: { gaps: u.gaps }, fix: call('find_on_screen', { at: r2((mid[0] + mid[1]) / 2) }, 'read the middle of the longest stretch and check again with every frame') } : {}) })
    }
  }
}

function check(where, args = {}) {
  const r = read(where)
  if (!r.ok) return r
  const doc = args.doc || null
  const path = args.path || (doc && doc.src) || null
  const call = (tool, a, why) => ({ tool, args: { ...(path ? { path } : {}), ...a }, why })
  const out = { findings: [], unchecked: [], covered: [] }
  const said = saidOn(doc, args.text)

  // words and the name: every rewrite first, then one fix per place that makes them all
  const edits = []
  const hits = []
  for (const s of said) {
    for (const w of avoidedIn(s.text, r.rules.words)) {
      const len = w.term.length, at = w.at
      hits.push({ kind: 'words', s, w, at, len })
      if (w.instead) edits.push({ where: s.where, text: s.text, at, len, to: w.instead })
    }
  }
  for (const rule of r.rules.name) {
    if (!nameOf(rule.text)) {
      out.unchecked.push({ rule: 'rule-name', guideline: rule.id, section: 'name',
        why: `no name could be read from "${rule.text}", so no words were checked against it: the rule needs the name in quotes, the way it is spelled`,
        fix: call('guidelines', { action: 'read' }, 'ask the person how the name is spelled, and write it in quotes as theirs') })
      continue
    }
    for (const s of said) {
      for (const m of misnamed(s.text, rule)) {
        hits.push({ kind: 'name', s, m })
        edits.push({ where: s.where, text: s.text, at: m.at, len: m.len, to: m.name, name: true })
      }
    }
  }
  const fixOf = rewrites(doc, edits, call)
  for (const h of hits) {
    const at = h.s.where
    if (h.kind === 'words') {
      out.findings.push({ rule: 'rule-words', guideline: h.w.rule, severity: SEV.words,
        what: `"${h.w.term}" is a word the product avoids${h.w.instead ? `; say "${h.w.instead}"` : ''}.`,
        where: { ...at, at: h.at },
        fix: h.w.instead ? fixOf({ where: at }) : call('get_edit', {}, `reword ${at.id || at.look || 'it'} without "${h.w.term}" and send it with apply_edit`) })
    } else {
      out.findings.push({ rule: 'rule-name', guideline: h.m.rule, severity: SEV.name,
        what: h.m.old ? `"${h.m.said}" is an old name; the product is called "${h.m.name}".`
          : `"${h.m.said}" is not how the product is written: it is "${h.m.name}".`,
        where: { ...at, at: h.m.at }, fix: fixOf({ where: at }) })
    }
  }

  // never
  const frames = framesOf(args)
  neverFindings(r.rules.never, frames, doc, call, out)

  // look
  const look = (doc && doc.look) || args.look || null
  if (r.rules.look.length) {
    const still = doc ? doc.kind === 'shot' : args.still === true ? true : args.still === false ? false : null
    const L = look ? require('./look').resolve(look) : null
    const crop = doc && doc.crop && +doc.crop.w > 0 && +doc.crop.h > 0 ? doc.crop : null
    const w = crop ? +crop.w * (+args.width || +(doc && doc.w) || 0) : +args.width || +(doc && doc.w) || 0
    const h = crop ? +crop.h * (+args.height || +(doc && doc.h) || 0) : +args.height || +(doc && doc.h) || 0
    const ctx = { takeAspect: w > 0 && h > 0 ? w / h : null }
    for (const rule of r.rules.look) {
      if (still === false && STILL_ONLY.test(rule.text) && !MOVING.test(rule.text)) continue
      if (still === true && MOVING.test(rule.text) && !STILL_ONLY.test(rule.text)) continue
      if (!L) {
        out.unchecked.push({ rule: 'rule-look', guideline: rule.id, section: 'look', why: 'no look was handed in, so there was nothing to hold this rule to',
          fix: call('get_edit', {}, 'read the edit, then check again with it') })
        continue
      }
      for (const want of lookWants(rule.text)) {
        if (want.unchecked) { out.unchecked.push({ rule: 'rule-look', guideline: rule.id, section: 'look', clause: want.clause, why: want.unchecked }); continue }
        const miss = want.test(L, ctx)
        if (!miss) continue
        if (miss.unknown) { out.unchecked.push({ rule: 'rule-look', guideline: rule.id, section: 'look', clause: want.clause, why: miss.unknown }); continue }
        out.findings.push({ rule: 'rule-look', guideline: rule.id, severity: SEV.look,
          what: `The rule says "${want.clause}", and ${want.path} is ${typeof miss.was === 'string' ? miss.was : JSON.stringify(miss.was)}.`,
          where: { look: want.path },
          fix: miss.set ? call('apply_look', { look: miss.set }, `what "${want.clause}" asks of ${want.path}`)
            : call('get_look_schema', {}, `pick a ${want.path} that is ${want.want}`) })
      }
    }
  }

  const rank = { blocking: 0, should: 1, note: 2 }
  out.findings.sort((a, b) => rank[a.severity] - rank[b.severity])
  // the two lists the bridge already reads, as they were
  const wordsHit = said.length || args.text != null ? avoidedIn(said.map(s => s.text).join('\n'), r.rules.words) : []
  const seen = args.labels != null ? onScreen(args.labels, r.rules.never) : []
  const blocking = out.findings.filter(f => f.severity === 'blocking').length
  return {
    ok: true, product: r.product,
    clean: !out.findings.length && !out.unchecked.length,
    verdict: blocking ? 'refuse' : out.findings.length ? 'fix' : out.unchecked.length ? 'unchecked' : 'clean',
    findings: out.findings, unchecked: out.unchecked, covered: out.covered,
    words: wordsHit, onScreen: seen,
  }
}

// Before a take is exported or a still is saved. The same check, answered as a yes or a
// no: anything a never-rule keeps off screen that is on the picture and not under a
// redaction refuses, and the rest travels with the yes so it is said rather than lost.
// A never-rule that could not be checked is not a refusal, because nothing was seen;
// it is not a pass either, and `unchecked` says so on the way through.
function gate(where, args = {}) {
  const r = check(where, args)
  if (!r.ok) return r
  const stop = r.findings.filter(f => f.severity === 'blocking')
  const what = args.for === 'still' ? 'this still is saved' : 'this is exported'
  return {
    ok: !stop.length, product: r.product,
    ...(stop.length ? { refused: { keep: false, kind: 'never-on-screen',
      why: `${r.product}'s rules keep ${stop.length === 1 ? 'something' : stop.length + ' things'} off screen that ${stop.length === 1 ? 'is' : 'are'} on it. Fix ${stop.length === 1 ? 'it' : 'them'} before ${what}.` } } : {}),
    findings: r.findings, unchecked: r.unchecked, covered: r.covered, verdict: r.verdict,
  }
}

// ── the one entry point a tool needs ─────────────────────────────────────────
// `where` is the same { root, take, about } memory takes; `args.product` names the
// product when no take is open.
function op(where, args = {}, opts = {}) {
  const at = { ...(where || {}), ...(args.product ? { product: args.product } : {}) }
  switch (args.action || (args.rules || args.rule ? 'write' : 'read')) {
    case 'read': return read(at)
    case 'write': return write(at, args.rules || args, opts)
    case 'show': return show(at, { ...opts, ids: args.ids })
    case 'adopt': return adopt(at, args, opts)
    case 'reject': return reject(at, args.ids)
    case 'check': return check(at, args)
    case 'gate': return gate(at, args)
    default: throw new Error(`action is one of read, write, show, adopt, reject, check, gate`)
  }
}

module.exports = {
  SECTIONS, sectionOf, place, sealOf,
  read, write, show, adopt, reject,
  termsOf, avoidedIn, neverOf, neverKinds, onScreen, nameOf, misnamed, lookWants, check, gate, op,
}
