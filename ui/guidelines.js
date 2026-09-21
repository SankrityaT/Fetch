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
// The two rules a machine can check without taste: a word the product avoids, in a
// caption or a title; and a thing that must never be seen, in the labels read off a
// frame. The rest (audience, look) is for the agent to read, not for a regex to enforce.

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

// Labels read off a frame (find_on_screen's boxes, a window title) that a never-rule
// names. A label hits when it carries every word of the thing, or two thirds of a thing
// named in three words or more: "Email addresses" is the customer email addresses.
function onScreen(labels, rules) {
  const hits = []
  for (const r of rules || []) {
    if (r.section !== 'never' && r.rule !== 'never') continue
    const thing = neverOf(r.text)
    if (!thing) continue
    const want = words(thing)
    for (const label of [].concat(labels || [])) {
      const text = typeof label === 'string' ? label : label && (label.label || label.text || label.name)
      if (!text) continue
      const have = new Set(words(text))
      const shared = want.filter(x => have.has(x)).length
      const enough = shared === want.length || (want.length >= 3 && shared / want.length >= 2 / 3)
      if (enough) hits.push({ label: text, thing, rule: r.id, ...(label && label.id ? { id: label.id } : {}) })
    }
  }
  return hits
}

// Both checks at once, against the rules in force for this product. Drafts are never
// checked against: a rule nobody agreed to has no business failing somebody's export.
function check(where, args = {}) {
  const r = read(where)
  if (!r.ok) return r
  const all = [...r.rules.words, ...r.rules.never]
  const words = args.text != null ? avoidedIn(args.text, all) : []
  const seen = args.labels != null ? onScreen(args.labels, all) : []
  return { ok: true, product: r.product, clean: !words.length && !seen.length, words, onScreen: seen }
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
    default: throw new Error(`action is one of read, write, show, adopt, reject, check`)
  }
}

module.exports = {
  SECTIONS, sectionOf, place, sealOf,
  read, write, show, adopt, reject,
  termsOf, avoidedIn, neverOf, onScreen, check, op,
}
