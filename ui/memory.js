// What the agent knows about this person and their product, kept past the end of a chat.
//
// Everything a person ever tells an agent about their own software dies when the
// conversation does. What the product is called, how the name is said out loud, which
// screen is not public yet, who the demo is being cut for, that they always want 16:9
// and never want their email on screen. "New chat" wipes all of it, so the agent asks
// the same four questions every week and its advice is worst on the thing the person
// has explained most often.
//
// This is the store and the rules around it, deliberately small. A memory that keeps
// everything is one nobody reads, and a memory an agent writes unattended is one that
// will eventually hold an API key.
//
// Three drawers, because the three kinds of fact have three different lifetimes:
//   global   the person, across every product: how they like their videos.
//   product  one product, across every take: its name, its audience, its secrets.
//   take     one recording: what it shows, and what is wrong with it.
// Take facts live in the take's own sidecar, so a rename carries them and a delete
// trashes them, the way every other per-take file already behaves. Global and product
// facts outlive every take and sit in one file beside the app's own settings.
//
// Nothing here decides when to write. The agent does, through the `remember` tool, and
// this file's whole job is the three refusals that keep the store worth reading: a
// secret, a passing remark, and a fact that is already in there in other words.
//
// A product fact can also be a rule: one of the product's standing orders, filed under
// what it governs (its name, its audience, what never goes on screen, the house look,
// the words it avoids). ui/guidelines.js is the rulebook and decides who may write one;
// this file only has to keep a rule in its drawer, keep a draft out of every briefing
// until the person has said yes to it, and print the rules ahead of the facts.
//
// Pure apart from the handful of functions at the bottom that touch the disk, so
// test/memory.test.js runs the rules under plain node with no Electron.

const fs = require('fs')
const path = require('path')

const V = 1

const SCOPES = ['global', 'product', 'take']
// The id is the handle, so it says which drawer it came out of. G, F and N are free:
// the edit document owns C, Z, T, S, B and M, the job owns P, a lassoed area owns R.
const PREFIX = { global: 'G', product: 'F', take: 'N' }

// A fact is a sentence. Past this it is a paragraph, and a paragraph is a document
// somebody should have written instead.
const MAX_TEXT = 200
const MAX_KEY = 40
const MAX_ABOUT = 60

// What each drawer holds before the weakest fact in it falls out. The product drawer
// earns the most room because it is the one that pays for this whole file; one take
// earns the least, because the take itself is right there to look at.
const CAP = { global: 24, product: 40, take: 16 }

// The briefing is pasted into the opening of every new conversation, so it is capped in
// characters rather than in rows: memory that costs a page is memory an agent learns to
// skip.
const BUDGET = 1200

// What a rule governs. The order is the order a briefing reads them in: what the thing
// is called before who it is for, and what must never be seen before how it should look.
const RULES = ['name', 'audience', 'never', 'look', 'words']
// Where a rule came from. Only the person's own words go straight into force; the rest
// are the agent reading the product, and wait to be shown.
const SOURCES = ['person', 'screen', 'help', 'code', 'agent']
const MAX_EVIDENCE = 120
// Rules are read before anything is planned, so they are printed first and get their
// own room: a drawer full of facts must never push "never show the admin panel" out of
// the briefing.
const RULE_BUDGET = 900
// Drafts are proposals, and a proposal nobody answered is not worth keeping forever.
const DRAFT_CAP = 20

const now0 = () => Date.now()

function clean(v, max = MAX_TEXT) {
  if (v === null || v === undefined) return ''
  return String(v).replace(/\s+/g, ' ').trim().slice(0, max)
}

const slug = v => clean(v, MAX_KEY).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

// ── what must never be kept ──────────────────────────────────────────────────
// A key on screen is a thing to redact in one take, not a durable fact about the
// product, and the difference matters: "an API key is visible in the header" is worth
// keeping and "the API key is sk-live-..." is worth refusing. So the rules look for the
// value, never for the word.

const SECRETS = [
  [/\b(sk|pk|rk)[-_](live|test|ant|proj|api)?[-_]?[A-Za-z0-9]{12,}/, 'an API key'],
  [/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/, 'a GitHub token'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/, 'a GitHub token'],
  [/\bxox[abprs]-[A-Za-z0-9-]{12,}/i, 'a Slack token'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS key'],
  [/\bAIza[0-9A-Za-z_-]{30,}/, 'a Google key'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./, 'a signed token'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/\bBearer\s+[A-Za-z0-9._-]{16,}/i, 'a bearer token'],
  [/\b[A-Za-z0-9._%+-]+:[^\s:@]{6,}@[A-Za-z0-9.-]+\b/, 'a password in a URL'],
]

// A long unbroken run carrying both digits and letters is not a sentence, whatever the
// agent believes it is writing down. The dot is left out of the run on purpose, so a
// hostname stays a hostname: songscription-library.vercel.app is a fact, not a token.
const BLOB = /[A-Za-z0-9+/_=-]{24,}/

// "the password is hunter2" is a secret. "the password is on screen at 12 s" is a note
// about a take and worth keeping, so what follows has to look like a value rather than
// like more sentence.
const NAMED = /\b(pass(?:word|phrase|code)|api[ _-]?key|secret(?:\s+key)?|access[ _-]?token|auth[ _-]?token|token|seed phrase|pin|otp|one[- ]time code)\b\s*(?:is|was|=|:)\s*(\S+)/i
const WORDY = /^(on|in|at|the|a|an|my|our|his|her|their|its|it|this|that|there|here|not|never|always|same|different|shown|showing|show|shows|visible|hidden|redacted|blurred|blurry|missing|empty|gone|wrong|right|correct|fine|safe|public|private|secret|saved|stored|typed|required|optional|needed|set|unset|live|test|remembered|generated|rotated|unchanged|expired|invalid|autofilled|prefilled)\b/i

function looksLikeValue(v) {
  const s = String(v).replace(/[.,;:!?)\]]+$/, '')
  if (!s || WORDY.test(s)) return false
  if (/^["'`]/.test(s)) return true
  // A long run of letters with no digit in it is exactly what a memorable password
  // looks like, and letting it through wrote correcthorsebatterystaple into the file
  // verbatim. WORDY is what keeps "the password is on screen at 12 s" a fact: the
  // sentence-continuation cases are named there rather than guessed at by shape.
  return /\d/.test(s) ? s.length >= 4 : s.length >= 10
}

// Thirteen to nineteen digits that pass Luhn is a card number and nothing else.
function cardIn(text) {
  const m = String(text).match(/\b(?:\d[ -]?){12,18}\d\b/)
  if (!m) return null
  const d = m[0].replace(/\D/g, '')
  if (d.length < 13 || d.length > 19) return null
  let sum = 0
  for (let i = 0; i < d.length; i++) {
    let n = +d[d.length - 1 - i]
    if (i % 2) { n *= 2; if (n > 9) n -= 9 }
    sum += n
  }
  return sum % 10 === 0 ? m[0] : null
}

// The span and what it is, or null. Never the value itself in any returned field: a
// refusal that quotes the key back has not kept it out of anything.
function secretIn(text) {
  const s = String(text || '')
  for (const [re, kind] of SECRETS) {
    const m = s.match(re)
    if (m) return { kind, at: m.index, len: m[0].length }
  }
  const named = s.match(NAMED)
  if (named && looksLikeValue(named[2])) {
    const at = named.index + named[0].length - named[2].length
    return { kind: 'a password', at, len: named[2].length }
  }
  const card = cardIn(s)
  if (card) return { kind: 'a card number', at: s.indexOf(card), len: card.length }
  const blob = s.match(BLOB)
  if (blob && /\d/.test(blob[0]) && /[A-Za-z]/.test(blob[0])) {
    return { kind: 'a long random string', at: blob.index, len: blob[0].length }
  }
  return null
}

// The same sentence with the value taken out, so the refusal comes with the one call
// that fixes it. Offered, never written: guessing what the person meant to say is not
// this file's job.
const without = (text, hit) =>
  clean(String(text).slice(0, hit.at) + '[' + hit.kind + ', not written down]' + String(text).slice(hit.at + hit.len))

// ── what is not worth keeping ────────────────────────────────────────────────
// A standing fact outranks every passing marker, because "never show the admin panel"
// is an order and also exactly the kind of order worth keeping forever.
const DURABLE = [
  /\b(always|never|usually|every time)\b/i,
  /\b(is|are|was) called\b/i,
  /\b(pronounc|spell|stands for|short for|abbreviat)/i,
  /\b(must not|do not|don't|cannot|can't) (ever|show|share|record|publish|mention)\b/i,
  /\b(secret|internal|confidential|unreleased|not public|under nda|pre[- ]release|staging only)\b/i,
  /\b(audience|customers|users are|brand|tagline|logo|licen[cs]e|trademark)\b/i,
  /\b(we|our team|the company|the product|the app) (call|calls|use|uses|ship|ships|sell|sells|prefer|prefers)\b/i,
]

const ORDER = /^(zoom|cut|trim|crop|export|render|undo|redo|delete|remove|add|move|drop|put|show|hide|play|pause|stop|record|speed|slow|fade|blur|redact|lift|spotlight|caption|shorten|lengthen|make|set|change|fix|try|apply|review)\b/i
const AT_THE_EDIT = /(\b\d+(\.\d+)?\s*(s|sec|secs|seconds?)\b|\b[CZTSMBPR]\d+\b)/

const PASSING = [
  [/\?\s*$/, 'a question, and a question is not a fact'],
  [/^(thanks|thank you|ok|okay|sure|cool|nice|great|awesome|yes|yeah|yep|no|nope|nah|got it|perfect|sounds good|never mind|nvm|hi|hey|hello|bye)\b/i, 'small talk'],
  [/\b(right now|just now|at the moment|for now|this time|one more time|hang on|hold on)\b/i, 'about this moment rather than about the work'],
  [/^(that|this|it)\b[^.]{0,60}\b(looks|sounds|works|worked|is|was|feels|came out)\s+(good|great|fine|better|worse|perfect|wrong|broken|off|weird|slow|fast|nice)\b/i, 'how one take turned out, not a standing fact'],
]

// Keep or refuse, and why. Default is keep: the agent already decided this was worth
// writing down, and second-guessing every sentence would make the tool useless. The
// refusals are the three ways a store goes bad, not a taste test.
//
// A rule is standing by definition: the section it is filed under already says it is an
// order about the product, so `standing` skips the passing-remark test. It never skips
// the secret test, and never the one that says a word is not a sentence.
function judge(raw, opts = {}) {
  // The whole line is scanned, not the part that fits: truncating first would leave the
  // first half of a key in a sentence that then reads as clean.
  const full = clean(raw, 4000)
  const text = clean(full)
  if (!text) return { keep: false, kind: 'thin', why: 'nothing to remember' }
  if (text.split(' ').length < 2 || text.length < 8) {
    return { keep: false, kind: 'thin', why: 'too short to still mean anything in a month' }
  }
  const hit = secretIn(full)
  if (hit) {
    return {
      keep: false, kind: 'secret', of: hit.kind,
      why: `that line carries ${hit.kind}, and a secret is not a durable fact about a product`,
      instead: without(full, hit),
    }
  }
  if (opts.standing || DURABLE.some(re => re.test(text))) return { keep: true, kind: 'standing' }
  if (ORDER.test(text) && AT_THE_EDIT.test(text)) {
    return { keep: false, kind: 'passing', why: 'an instruction about this edit, which the job file already holds' }
  }
  for (const [re, why] of PASSING) if (re.test(text)) return { keep: false, kind: 'passing', why }
  return { keep: true, kind: 'fact' }
}

// Which drawer, when the agent does not say. The sentence usually does: "this take" is
// about one recording, "I always" is about the person, and everything else is about the
// product, which is the drawer that earns this file its keep.
// "this demo" is the one on screen. "the demo" is usually the product's demo, the one
// they cut every month, so only the nouns that can mean nothing else take a bare "the".
const ABOUT_TAKE = /\bthis (take|recording|clip|video|demo|cut|file)\b|\bthe (take|recording|clip)\b|\bin this one\b/i
const ABOUT_PERSON = /\b(i|we) (always|never|usually|prefer|like|hate|want|don't|do not)\b|\b(my|our) (videos|demos|recordings|takes|exports|channel)\b/i
// An object id can only have come from one edit document. A timestamp cannot: "our
// demos are always 60 seconds" is about every take there will ever be.
const NAMES_AN_OBJECT = /\b[CZTSMB]\d+\b/

function inferScope(text) {
  const s = clean(text)
  if (ABOUT_TAKE.test(s)) return 'take'
  if (ABOUT_PERSON.test(s)) return 'global'
  if (NAMES_AN_OBJECT.test(s)) return 'take'
  return 'product'
}

// "Songscription · Library Tour" is a tour of Songscription. Every take in this app is
// named product first, so the product drawer keys itself without anyone being asked.
function productOf(name) {
  const stem = clean(String(name || '').replace(/\.[^.]+$/, ''), MAX_ABOUT)
  const head = stem.split(/\s*[·⋅]\s*/)[0]
  const one = clean(head, MAX_ABOUT).replace(/\s+\d+$/, '')
  return /^(recording|screen|display|untitled)\b/i.test(one) ? null : one || null
}

// ── is this already in here ──────────────────────────────────────────────────
const STOP = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'this',
  'that', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'we', 'i', 'my', 'our', 'you', 'your', 'they',
  'their', 'at', 'as', 'with', 'from', 'by', 'do', 'does', 'so', 'but', 'if', 'when', 'then', 'there',
  'here', 'has', 'have', 'had', 'will', 'would', 'can', 'could', 'should', 'just', 'about', 'into',
  'over', 'than', 'all', 'any', 'some', 'one', 'am',
  // the words a correction arrives wearing: "it is called Lyricly now" is the same
  // fact as "it is called Songscription", and the "now" must not hide that
  'now', 'still', 'also', 'yet', 'again', 'really', 'very', 'quite', 'actually', 'basically'])

const flat = s => clean(s).toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim()
const content = s => new Set(flat(s).split(' ').filter(w => w && !STOP.has(w)))

// Half the content words shared is a restatement. Below that two facts about the same
// screen stay two facts, which is why the `key` exists: it is the handle for "this
// replaces that" when the words are not close enough to tell.
const SAME = 0.5

// A naming sentence, and what it names. One thing has one name, so two of these about
// the same subject are one fact however few words they share: "the product is called
// Songscription" and "it is called Lyricly now" share only "called", a quarter by the
// rule above, and keeping both made recall print the superseded name as current.
//
// The subject is what is left of the words before "is called" once the stop words are
// gone, so "it" and "this" come out empty, which in a product drawer means the product
// itself. An empty subject matches a generic one and nothing else, so "the pricing page
// is called Plans" is still its own fact beside the product's name.
const NAMED_AS = /^(.*?)\b(?:is|are|was|were)\s+(?:now\s+)?(?:called|named)\s+(.+)$/i
const GENERIC = new Set(['product', 'app', 'tool', 'thing', 'company', 'service', 'project', 'startup'])
function namingOf(text) {
  const m = flat(text).match(NAMED_AS)
  if (!m || !clean(m[2])) return null
  return { subject: [...content(m[1])].join(' ') }
}
const sameName = (a, b) => {
  const x = namingOf(a), y = namingOf(b)
  if (!x || !y) return false
  if (x.subject === y.subject) return true
  const one = !x.subject ? y.subject : !y.subject ? x.subject : null
  return one != null && (one === '' || GENERIC.has(one))
}

// What a rule is about: its content words less the ones every rule of its kind says.
// "never show customer phone numbers" and "never show card numbers" share half their
// words (never, show, numbers) and are two rules, because what each keeps off screen is
// different; "never show the customer phone numbers" is the first again. Two rules are
// apart when neither's subject holds the other's.
const RULE_WORDS = new Set(['never', 'show', 'shown', 'showing', 'appear', 'appears', 'screen', 'always', 'avoid',
  'say', 'use', 'dont', 'not', 'no', 'instead', 'keep', 'off', 'visible', 'display', 'displayed', 'let', 'ever'])
const ruleSubject = s => new Set([...content(s)].filter(w => !RULE_WORDS.has(w)))
function rulesApart(a, b) {
  const A = ruleSubject(a), B = ruleSubject(b)
  if (!A.size || !B.size) return false
  return ![...A].every(w => B.has(w)) && ![...B].every(w => A.has(w))
}

function similarity(a, b) {
  const A = content(a), B = content(b)
  if (!A.size || !B.size) return 0
  let shared = 0
  for (const w of A) if (B.has(w)) shared++
  return shared / (A.size + B.size - shared)
}

// ── the store ────────────────────────────────────────────────────────────────
const empty = () => ({ v: V, facts: [], nextId: {}, updated: 0 })

function normalizeFact(raw, scope) {
  const f = raw && typeof raw === 'object' ? raw : {}
  const text = clean(f.text != null ? f.text : f.fact)
  if (!text) return null
  const sc = SCOPES.includes(f.scope) ? f.scope : SCOPES.includes(scope) ? scope : 'product'
  const at = Number.isFinite(+f.at) ? +f.at : 0
  return {
    id: typeof f.id === 'string' && /^[GFN]\d+$/.test(f.id) ? f.id : null,
    scope: sc,
    about: sc === 'product' ? (clean(f.about, MAX_ABOUT) || null) : null,
    key: slug(f.key) || null,
    text,
    was: clean(f.was) || null,
    pin: f.pin === true,
    by: clean(f.by, 40) || null,
    at,
    updated: Number.isFinite(+f.updated) ? +f.updated : at,
    seen: Math.max(1, Math.round(+f.seen || 1)),
    ...ruleFields(f, sc),
  }
}

// The fields only a rule carries, repaired the same way as the rest: a rule outside the
// product drawer is a fact, and evidence that carries a secret is dropped rather than
// kept, the way a key or a product name is.
function ruleFields(f, sc) {
  if (sc !== 'product' || !RULES.includes(f.rule)) return {}
  const out = { rule: f.rule }
  if (f.draft === true) out.draft = true
  if (SOURCES.includes(f.from)) out.from = f.from
  const ev = clean(f.evidence, MAX_EVIDENCE)
  if (ev && !secretIn(ev)) out.evidence = ev
  if (typeof f.replaces === 'string' && /^F\d+$/.test(f.replaces)) out.replaces = f.replaces
  if (Number.isFinite(+f.shownAt) && +f.shownAt > 0) out.shownAt = +f.shownAt
  return out
}

// A file that will not parse, or one an agent hand-edited, must never lose the facts it
// can still read, so every row is repaired on the way in and a row with no id is given
// one rather than dropped.
function normalize(raw, scope) {
  const o = raw && typeof raw === 'object' ? raw : {}
  const out = empty()
  out.nextId = {}
  for (const k of Object.keys(PREFIX)) {
    const n = +(o.nextId || {})[PREFIX[k]]
    out.nextId[PREFIX[k]] = Number.isFinite(n) && n > 0 ? Math.floor(n) : 1
  }
  const seen = new Set()
  const rows = []
  for (const r of Array.isArray(o.facts) ? o.facts : []) {
    const f = normalizeFact(r, scope)
    if (!f) continue
    if (f.id && seen.has(f.id)) f.id = null
    if (f.id) {
      seen.add(f.id)
      const n = +f.id.slice(1) + 1
      const p = f.id[0]
      out.nextId[p] = Math.max(out.nextId[p] || 1, n)
    }
    rows.push(f)
  }
  for (const f of rows) if (!f.id) f.id = mint(out, f.scope)
  out.facts = rows
  out.updated = Number.isFinite(+o.updated) ? +o.updated : 0
  return out
}

function mint(store, scope) {
  const p = PREFIX[scope] || PREFIX.product
  const n = store.nextId[p] || 1
  store.nextId[p] = n + 1
  return p + n
}

const sameSubject = (a, b) => slug(a || '') === slug(b || '')

// The weakest fact in a drawer: never a pinned one while an unpinned one is there,
// then the one restated least, then the oldest. Restating a fact is the person telling
// you twice that it matters.
function weakest(facts) {
  let worst = null
  for (const f of facts) {
    if (!worst) { worst = f; continue }
    if (f.pin !== worst.pin) { if (!f.pin) worst = f; continue }
    if (f.seen !== worst.seen) { if (f.seen < worst.seen) worst = f; continue }
    if (f.updated < worst.updated) worst = f
  }
  return worst
}

// Forgetting is by the drawer, not by the clock. A product's name does not go stale,
// it gets superseded; a take's facts go when the take does. What does happen is that a
// drawer fills, and then the least used fact in it leaves.
function prune(store, scope, about, keep) {
  const dropped = []
  // Drafts fill their own drawer, oldest out first. A pile of proposals nobody answered
  // must never evict a fact the person actually said.
  for (;;) {
    const drafts = store.facts.filter(f => f.draft && f.scope === scope && sameSubject(f.about, about))
    if (drafts.length <= DRAFT_CAP) break
    const out = drafts.filter(f => f.id !== keep).sort((a, b) => a.updated - b.updated)[0]
    if (!out) break
    store.facts = store.facts.filter(f => f !== out)
    dropped.push(out.id)
  }
  const cap = CAP[scope] || CAP.product
  for (;;) {
    const mine = store.facts.filter(f => !f.draft && f.scope === scope && (scope !== 'product' || sameSubject(f.about, about)))
    if (mine.length <= cap) break
    // The fact just written is never the one that falls out. A drawer full of restated
    // facts would otherwise swallow every new one and report success.
    const out = weakest(mine.filter(f => f.id !== keep))
    if (!out) break
    store.facts = store.facts.filter(f => f !== out)
    dropped.push(out.id)
  }
  return dropped
}

// Write one fact. Returns the store either way, so a refusal is still a valid call and
// the caller never has to branch before it can read the memory back.
function add(store, input, at = now0()) {
  const s = normalize(store)
  const raw = typeof input === 'string' ? { fact: input } : (input && typeof input === 'object' ? input : {})
  const given = clean(raw.fact != null ? raw.fact : raw.text, 4000)
  const scope0 = SCOPES.includes(raw.scope) ? raw.scope : null
  // A rule is a product's, so naming one files the fact in the product drawer whatever
  // the sentence sounds like: "never show my inbox" reads as the person, and is the
  // product's order all the same.
  const rule = RULES.includes(raw.rule) && (!scope0 || scope0 === 'product') ? raw.rule : null
  const call = judge(given, { standing: !!rule })
  if (!call.keep) return { store: s, fact: null, was: null, same: false, changed: false, refused: call, dropped: [] }

  const text = clean(given)
  const scope = rule ? 'product' : scope0 || inferScope(text)
  // A key or a product name is a label, so a secret in one is a mistake rather than a
  // reason to refuse the fact. It is dropped and the fact stands.
  const about = scope === 'product' && !secretIn(raw.about) ? (clean(raw.about, MAX_ABOUT) || null) : null
  const key = (secretIn(raw.key) ? '' : slug(raw.key)) || null
  const by = clean(raw.by, 40) || null
  const draft = !!rule && raw.draft === true
  // A rule in force is pinned: it is an order, and an order does not fall out of the
  // drawer because the person mentioned five other things this week.
  const pin = raw.pin === true || (!!rule && !draft)
  const extra = rule ? ruleFields({ rule, draft, from: raw.from, evidence: raw.evidence }, 'product') : {}

  const mine = s.facts.filter(f => f.scope === scope && (scope !== 'product' || sameSubject(f.about, about)))
  // The key is the handle the agent chose, so it wins. Without one, a restatement is
  // found by the words, which is what stops five spellings of the same fact piling up.
  const match = pool => (key && pool.find(f => f.key === key)) ||
    pool.find(f => flat(f.text) === flat(text)) ||
    pool.find(f => similarity(f.text, text) >= SAME && !((rule || f.rule) && rulesApart(f.text, text))) ||
    pool.find(f => sameName(f.text, text)) || null

  // A draft may refine an earlier draft, but it never rewrites what is in force: that
  // would put a sentence nobody was shown into every briefing. A draft that would change
  // a fact or a rule sits beside it, naming what it would replace, until it is adopted.
  if (draft) {
    const standing = match(mine.filter(f => !f.draft))
    if (standing && flat(standing.text) === flat(text)) {
      standing.seen += 1
      standing.updated = at
      if (!standing.rule) Object.assign(standing, { rule, pin: true })
      s.updated = at
      return { store: s, fact: { ...standing }, was: null, same: true, changed: true, refused: null, dropped: [] }
    }
    const earlier = match(mine.filter(f => f.draft && (!standing || !f.replaces || f.replaces === standing.id)))
    let fact, was = null, same = false
    if (earlier) {
      same = flat(earlier.text) === flat(text)
      if (!same) {
        was = earlier.text
        earlier.was = earlier.text
        earlier.text = text
        // what was shown is no longer what would be adopted
        delete earlier.shownAt
      }
      Object.assign(earlier, extra, { key: key || earlier.key, by: by || earlier.by,
        seen: earlier.seen + 1, updated: at })
      if (standing) earlier.replaces = standing.id
      fact = earlier
    } else {
      fact = { id: mint(s, scope), scope, about, key, text, was: null, pin: false, by, at, updated: at, seen: 1,
        ...extra, ...(standing ? { replaces: standing.id } : {}) }
      s.facts.push(fact)
    }
    const dropped = prune(s, scope, about, fact.id)
    s.updated = at
    return { store: s, fact: { ...fact }, was, same, changed: true, refused: null, dropped }
  }

  // A draft is never settled from here. Only the person's yes in Fetch puts a draft in
  // force (ui/guidelines.js adopt, behind the bridge's question or the Guidelines panel).
  // A remember used to match any sentence half like a draft, rewrite the draft with it and
  // put it in force: "Always show the customer emails page first" went into force under
  // "Never on screen", unshown. A sentence that is the draft word for word leaves the draft
  // waiting and says so; anything else is a fact of its own.
  // A rule written as the person's own (guidelines write with from: person, which the
  // bridge sends only after the person confirmed it in Fetch) that is a draft word for
  // word is that yes, and settles it.
  const prior = match(mine.filter(f => !f.draft))
  const waiting = !prior && mine.find(f => f.draft && flat(f.text) === flat(text))
  if (waiting && rule) {
    const fact = settle(s, waiting.id, at)
    Object.assign(fact, extra.from ? { from: extra.from } : {})
    const dropped = prune(s, scope, about, fact.id)
    s.updated = at
    return { store: s, fact: { ...fact }, was: fact.was || null, same: !fact.was, changed: true, refused: null, dropped }
  }
  if (waiting) {
    return { store: s, fact: { ...waiting }, was: null, same: true, changed: false, refused: null, dropped: [], waiting: true }
  }

  let fact, was = null, same = false
  if (prior) {
    same = flat(prior.text) === flat(text)
    if (!same) { prior.was = prior.text; was = prior.text }
    prior.text = text
    prior.key = key || prior.key
    prior.pin = pin || prior.pin
    prior.by = by || prior.by
    prior.seen += 1
    prior.updated = at
    if (rule) Object.assign(prior, extra)
    fact = prior
  } else {
    fact = { id: mint(s, scope), scope, about, key, text, was: null, pin, by, at, updated: at, seen: 1, ...extra }
    s.facts.push(fact)
  }
  const dropped = prune(s, scope, about, fact.id)
  s.updated = at
  return { store: s, fact: { ...fact }, was, same, changed: true, refused: null, dropped }
}

// A draft goes into force. If it was drafted as a change to something already there,
// that row takes the new words and keeps its id, because the id is the handle an agent
// may already hold, and the draft's own row goes. Returns the row now in force, or null
// for an id that is not a draft. Who said yes is the caller's business, not this one's.
function settle(store, id, at = now0(), by = null) {
  const d = store.facts.find(f => f.id === id && f.draft)
  if (!d) return null
  const target = d.replaces && store.facts.find(f => f.id === d.replaces && !f.draft)
  let out = d
  if (target) {
    if (flat(target.text) !== flat(d.text)) { target.was = target.text; target.text = d.text }
    Object.assign(target, { rule: d.rule, pin: true, updated: at, seen: target.seen + 1 })
    if (d.from) target.from = d.from
    if (d.evidence) target.evidence = d.evidence
    store.facts = store.facts.filter(f => f !== d)
    out = target
  }
  delete out.draft
  delete out.shownAt
  delete out.replaces
  out.pin = true
  out.updated = at
  if (by) out.by = clean(by, 40)
  store.updated = at
  return out
}

// Drop by id, by key within a drawer, or a whole drawer at once. An agent that wrote
// something wrong has to be able to take it back in one call, or it will write a second
// fact contradicting the first and the store is worse than before.
function drop(store, sel) {
  const s = normalize(store)
  const q = typeof sel === 'string' ? { id: sel } : (sel && typeof sel === 'object' ? sel : {})
  const id = clean(q.id, 8).toUpperCase()
  const key = slug(q.key)
  const scope = SCOPES.includes(q.scope) ? q.scope : null
  const about = q.about != null ? clean(q.about, MAX_ABOUT) : null
  if (!id && !key && !scope) return { store: s, gone: [], facts: [] }

  // The product filter is a product's filter. Only a product fact carries `about`, so
  // testing every scope against it meant a global or a take fact could never be
  // forgotten by key at all while a take was open: the bridge always sends the open
  // take's product, and the call came back "nothing in the memory is opener" with the
  // fact still sitting there.
  const hit = f => {
    if (id) return f.id === id
    if (scope && f.scope !== scope) return false
    if (about != null && f.scope === 'product' && !sameSubject(f.about, about)) return false
    return key ? f.key === key : true
  }
  const gone = s.facts.filter(hit)
  s.facts = s.facts.filter(f => !gone.includes(f))
  return { store: s, gone: gone.map(f => f.id), facts: gone.map(f => ({ ...f })) }
}

// ── what the next conversation is told ───────────────────────────────────────
const ORDERED = ['global', 'product', 'take']
const HEAD = {
  global: 'Always true for this person',
  product: 'About the product',
  take: 'About this recording',
}

// Strongest first, and strength is the same three things that keep a fact out of the
// bin: pinned, restated, recent.
const strength = (a, b) => (b.pin - a.pin) || (b.seen - a.seen) || (b.updated - a.updated)

const RULE_HEAD = { name: 'name', audience: 'audience', never: 'never on screen', look: 'look', words: 'words' }
const ruleOrder = (a, b) => RULES.indexOf(a.rule) - RULES.indexOf(b.rule) || strength(a, b)

// The rules for one product, as the lines a briefing prints. Rules are printed only for
// the product the conversation is about, because two products do not share rules. With
// no product named, one product's rules are still printed when it is the only one that
// has any, headed by its name so nobody reads them as general; with two or more the
// block says which products have rules and prints none of them.
function ruleLines(rules, drafts, about, budget) {
  const lines = []
  const bySlug = new Map(rules.filter(f => f.about).map(f => [slug(f.about), f.about]))
  let pick = null
  if (about != null) pick = bySlug.get(slug(about)) || about
  else if (bySlug.size === 1) pick = [...bySlug.values()][0]
  if (about == null && bySlug.size > 1) {
    lines.push(`Rules are kept for ${[...bySlug.values()].join(', ')}. None is printed until the conversation names its product.`)
    return { lines, kept: [], left: 0 }
  }
  const mine = rules.filter(f => pick != null && sameSubject(f.about, pick)).sort(ruleOrder)
  const kept = []
  let spent = 0
  for (const f of mine) {
    const cost = f.id.length + 3 + RULE_HEAD[f.rule].length + 2 + f.text.length + 1
    if (kept.length && spent + cost > budget) break
    kept.push(f)
    spent += cost
  }
  if (kept.length) {
    lines.push(`Rules for ${pick}, before planning, capturing or styling anything:`)
    for (const f of kept) lines.push(`${f.id} · ${RULE_HEAD[f.rule]}: ${f.text}`)
  }
  const left = mine.length - kept.length
  if (left > 0) lines.push(`(${left} more ${left === 1 ? 'rule' : 'rules'} not shown)`)
  const waiting = drafts.filter(f => pick != null && sameSubject(f.about, pick))
  if (waiting.length) {
    lines.push(`(${waiting.length} drafted ${waiting.length === 1 ? 'rule waits' : 'rules wait'} for the person: ` +
      `${waiting.map(f => f.id).join(', ')}. Not in force until they say yes.)`)
  }
  return { lines, kept, left }
}

// The block a new conversation opens with. Ids are printed because the id is the handle:
// a fact the person says is wrong has to be nameable in the same breath. Rules come
// first, in their own room; a draft is never in it, only counted.
function recall(store, opts = {}) {
  const stores = Array.isArray(store) ? store : [store]
  const scopes = opts.scope ? [].concat(opts.scope).filter(s => SCOPES.includes(s)) : ORDERED
  const about = opts.about != null ? clean(opts.about, MAX_ABOUT) : null
  let all = []
  for (const st of stores) all = all.concat(normalize(st).facts)
  all = all.filter(f => scopes.includes(f.scope))
  const drafts = all.filter(f => f.draft)
  const rules = all.filter(f => f.rule && !f.draft)
  all = all.filter(f => !f.rule && !f.draft)
  // A product drawer holding another product's facts is noise in this conversation, but
  // facts written before any product was known belong to whoever asks.
  if (about != null) all = all.filter(f => f.scope !== 'product' || f.about == null || sameSubject(f.about, about))

  const withRules = opts.rules !== false && scopes.includes('product')
  const R = withRules
    ? ruleLines(rules, drafts, about, Number.isFinite(+opts.ruleBudget) ? +opts.ruleBudget : RULE_BUDGET)
    : { lines: [], kept: [], left: 0 }

  const ranked = all.slice().sort(strength)
  const budget = Number.isFinite(+opts.budget) ? +opts.budget : BUDGET
  const limit = Number.isFinite(+opts.limit) ? +opts.limit : ranked.length
  const kept = []
  let spent = 0
  for (const f of ranked) {
    if (kept.length >= limit) break
    const cost = f.id.length + 3 + f.text.length + 1
    if (kept.length && spent + cost > budget) break
    kept.push(f)
    spent += cost
  }
  const left = ranked.length - kept.length

  const shown = kept.slice().sort((a, b) => ORDERED.indexOf(a.scope) - ORDERED.indexOf(b.scope) || strength(a, b))
  const lines = R.lines.slice()
  let head = null
  for (const f of shown) {
    if (f.scope !== head) { head = f.scope; lines.push(HEAD[head] + ':') }
    lines.push(`${f.id} · ${f.text}`)
  }
  if (left > 0) lines.push(`(${left} older ${left === 1 ? 'fact' : 'facts'} not shown)`)
  return {
    facts: shown.map(f => ({ ...f })), lines, text: lines.join('\n'), left, total: ranked.length,
    rules: R.kept.map(f => ({ ...f })), drafts: drafts.length,
  }
}

// ── the files ────────────────────────────────────────────────────────────────
// The same hidden folder every other sidecar uses, so a take's machinery stays in one
// place and the take folder holds only what the person made.
const SIDE_DIR = '.fetch'
const EXT = '.memory.json'
const FILE = 'memory.json'

const stem = p => path.basename(String(p || '')).replace(/\.[^.]+$/, '')
const storePath = root => path.join(String(root || ''), FILE)
const takePath = src => path.join(path.dirname(String(src || '')), SIDE_DIR, stem(src) + EXT)

// A memory that will not parse must never block a turn: a bad file reads as an empty
// one and the next write replaces it. Losing a fact is a bad day, refusing to record is
// a broken product.
function readFile(file, scope) {
  try { return normalize(JSON.parse(fs.readFileSync(file, 'utf8')), scope) } catch { return empty() }
}

function writeFile(file, store) {
  try { fs.mkdirSync(path.dirname(file), { recursive: true }) } catch {}
  const out = normalize(store)
  fs.writeFileSync(file, JSON.stringify(out, null, 2))
  return out
}

const read = root => readFile(storePath(root))
const write = (root, store) => writeFile(storePath(root), store)
const readTake = src => readFile(takePath(src), 'take')
const writeTake = (src, store) => writeFile(takePath(src), store)

// Where a fact can go: the durable file, and the take open in the editor if there is
// one. `about` names the product, and a take names its own product when nobody says.
function place(where) {
  const w = where && typeof where === 'object' ? where : {}
  const take = w.take ? String(w.take) : null
  return {
    root: w.root ? String(w.root) : null,
    take,
    about: w.about != null && clean(w.about, MAX_ABOUT) ? clean(w.about, MAX_ABOUT) : (take ? productOf(stem(take)) : null),
  }
}

// The `remember` tool, whole: judge it, route it to its drawer, write it, and hand back
// the memory as the next conversation will see it, so the agent reads the consequence
// of its own call instead of being told "saved".
function remember(where, input, opts = {}) {
  const at = opts.now || now0()
  const w = place(where)
  const raw = typeof input === 'string' ? { fact: input } : (input && typeof input === 'object' ? input : {})
  const text = clean(raw.fact != null ? raw.fact : raw.text, 4000)
  const scope = SCOPES.includes(raw.scope) ? raw.scope : inferScope(text)

  // A fact about one recording needs the recording. Filing it under the product instead
  // would outlive the thing it is about, which is how a memory starts lying.
  if (scope === 'take' && !w.take) {
    return {
      ok: false, scope, fact: null, was: null, same: false, dropped: [], file: null,
      refused: { keep: false, kind: 'unplaced', why: 'a fact about one recording needs that recording named', instead: null },
      memory: recallFor(where, opts),
    }
  }
  if (scope !== 'take' && !w.root) {
    return {
      ok: false, scope, fact: null, was: null, same: false, dropped: [], file: null,
      refused: { keep: false, kind: 'unplaced', why: 'nowhere to keep it: no memory folder was given', instead: null },
      memory: recallFor(where, opts),
    }
  }

  const file = scope === 'take' ? takePath(w.take) : storePath(w.root)
  const before = scope === 'take' ? readTake(w.take) : read(w.root)
  const r = add(before, { ...raw, fact: text, scope, about: scope === 'product' ? (clean(raw.about, MAX_ABOUT) || w.about) : null }, at)
  if (r.changed) writeFile(file, r.store)
  return {
    ok: !!r.fact,
    scope,
    fact: r.fact,
    was: r.was,
    same: r.same,
    dropped: r.dropped,
    refused: r.refused,
    file: r.changed ? file : null,
    ...(r.waiting ? { waiting: `${r.fact.id} is a drafted rule waiting for the person's yes, and it stays a draft: ` +
      'show it to them with guidelines action show, and adopt it only if they say yes.' } : {}),
    memory: recallFor(where, opts),
  }
}

// Both files, read as one. The take's drawer and the durable one are separate on disk
// and one block in the prompt, because the agent does not care which file a fact came
// out of, only whether it already knew it.
function recallFor(where, opts = {}) {
  const w = place(where)
  const stores = []
  if (w.root) stores.push(read(w.root))
  if (w.take) stores.push(readTake(w.take))
  return recall(stores, { ...opts, about: opts.about != null ? opts.about : w.about })
}

// Forgetting on disk. An id says which file it lives in, so one call reaches either.
function forget(where, sel, opts = {}) {
  const w = place(where)
  const q = typeof sel === 'string' ? { id: sel } : (sel && typeof sel === 'object' ? sel : {})
  const id = clean(q.id, 8).toUpperCase()
  const scope = SCOPES.includes(q.scope) ? q.scope : null
  const gone = []
  const takeSide = id ? id[0] === PREFIX.take : scope ? scope === 'take' : true
  const durable = id ? id[0] !== PREFIX.take : scope ? scope !== 'take' : true

  if (takeSide && w.take) {
    const r = drop(readTake(w.take), { ...q, id })
    if (r.gone.length) { writeTake(w.take, r.store); gone.push(...r.gone) }
  }
  if (durable && w.root) {
    const r = drop(read(w.root), { ...q, id, about: q.about != null ? q.about : undefined })
    if (r.gone.length) { write(w.root, r.store); gone.push(...r.gone) }
  }
  return { gone, memory: recallFor(where, opts) }
}

module.exports = {
  // rules
  judge, secretIn, without, inferScope, productOf, similarity, slug, clean, sameSubject,
  // store
  empty, normalize, normalizeFact, add, drop, prune, recall, mint, weakest, settle,
  // disk
  storePath, takePath, read, write, readTake, writeTake, remember, recallFor, forget, place,
  V, SCOPES, PREFIX, CAP, BUDGET, SAME, MAX_TEXT, EXT, FILE, SIDE_DIR,
  RULES, SOURCES, RULE_BUDGET, DRAFT_CAP, MAX_EVIDENCE,
}
