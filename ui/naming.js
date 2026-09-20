// Recording names people can actually find again.
//
// Every take used to be `recording-1789677081300.mov`, which tells you nothing, sorts
// only by accident, and is the reason the library needed folders to be usable at all.
// Fetch already knows what was recorded (the window's app and title) and, once
// transcribed, what was said. Those two facts make a better name than any timestamp:
//
//     Linear · Issue 42 triage          (from the window, at the moment the take ends)
//     Xcode · Open the filter panel     (upgraded from the transcript's first beat)
//
// Local and instant by design: the app and window in front for most of the take name
// it the moment it ends. When the person has an agent connected, a take with speech is
// then renamed from what was said (ui/take-namer.js), but a good default must not need
// a model to exist.
//
// Pure: no filesystem, no Electron. The caller does the rename.

const MAX = 56

// Window titles carry the browser's name on the end, which is noise once the app is
// already the first half of the name.
const BROWSER_SUFFIX = /\s*[-\u2013\u2014|·\u22C5]\s*(google chrome( for testing)?|chromium|safari|firefox|mozilla firefox|arc|brave|microsoft edge|edge|opera|dia|aside)\s*$/i

// Characters that break paths or look like paths. The middle dot is kept: it is the
// separator this app uses everywhere a name has two parts.
const ILLEGAL = /[\/\\:*?"<>|\x00-\x1f]/g

// A browser puts the tab's state into the window title ("Video - YouTube 🔊", "Meet 🔴",
// "Tab - Audio playing"). It says what the tab is doing, not what it is, and left in, it
// became part of the product ("YouTube 🔊").
const TITLE_STATUS = /^[\s\p{Extended_Pictographic}\p{So}\u{FE0F}\u{200D}]+|[\s\p{Extended_Pictographic}\p{So}\u{FE0F}\u{200D}]+$/gu
const TITLE_ALERT = /\s*[-\u2013|·]\s*(audio playing|audio muted|playing audio|camera (and|or) microphone recording|camera recording|microphone recording|sharing (this tab|your screen|screen)|network error)\s*$/i
// ...and its unread count up front: "(3) Inbox" is the inbox, whatever the count was
const TITLE_COUNT = /^\(\d+\+?\)\s+/
function bareTitle(s) {
  const strip = t => t.replace(TITLE_STATUS, '').replace(TITLE_ALERT, '').replace(TITLE_STATUS, '').replace(TITLE_COUNT, '')
  return strip(strip(String(s || '')).replace(BROWSER_SUFFIX, ''))
}

function clean(s) {
  return bareTitle(s)
    .replace(ILLEGAL, ' ')
    // an editor's "file \u2014 project" reads in this app's own separator
    .replace(/\s+[\u2013\u2014]\s+/g, ' · ')
    .replace(/[.\s]+$/, '')          // trailing dots confuse extension handling
    .replace(/\s+/g, ' ')
    .trim()
}

// Cut at a word boundary rather than mid-word, so a long title reads as shortened
// rather than broken.
function fit(s, max = MAX) {
  if (s.length <= max) return s
  const cut = s.slice(0, max + 1)
  const sp = cut.lastIndexOf(' ')
  return (sp > max * 0.5 ? cut.slice(0, sp) : s.slice(0, max)).replace(/[\s,·-]+$/, '')
}

// For a browser the product is the page, not the browser. "Google Chrome · Linear"
// spends the front of every name on the one word all of them share.
// Playwright's headed Chrome ("Google Chrome for Testing") included: it is what an agent
// drives while Fetch records.
const BROWSERS = /^(google chrome( for testing| canary| beta| dev)?|chrome|chromium|safari( technology preview)?|firefox( developer edition| nightly)?|arc|brave browser|brave|microsoft edge|opera|dia|aside|orion|zen|vivaldi)$/i

// A browser's own pages, not a site: Aside titles its built-in chats "<chat> ⋅ Chats".
// The product there is the browser, and the chat's title is the person's own words,
// which once became a take's folder name. Only the page's kind is kept.
const OWN_PAGE = /\s+[\u22C5\u2219]\s+(chats?|settings|history|downloads|bookmarks|extensions|spaces?)\s*$/i
function ownPage(app, title) {
  const a = clean(app), m = BROWSERS.test(a) && String(title || '').match(OWN_PAGE)
  return m ? { product: a, page: cap(m[1].toLowerCase()) } : null
}

const sameIgnoringCase = (a, b) => a.toLowerCase() === b.toLowerCase()

/**
 * A filename stem, without extension, or null when there is nothing better than the
 * timestamp. Never returns an empty string.
 *
 * @param {object} s
 *   @param {string} [s.app]    the recorded window's application
 *   @param {string} [s.title]  the recorded window's title
 *   @param {string} [s.said]   the first beat's label, once transcribed
 *   @param {string} [s.product] a browser page's product, when already known
 *   @param {string} [s.domain]  a browser page's address
 */
function smartName({ app, title, said, product, domain } = {}) {
  const a = clean(app), t = clean(title), w = clean(said)

  // what the recording is of, then what happened in it
  let subject = a
  let detail = w || t
  const own = !domain ? ownPage(app, title) : null
  if (own) {
    subject = own.product
    detail = w || own.page
  } else if (BROWSERS.test(a) && (t || product || domain)) {
    const tab = productFromTitle(String(title || '').replace(BROWSER_SUFFIX, ''))
    const p = clean(product) || productFromDomain(domain) || tab.product
    subject = p || t
    detail = w || (p ? tab.page : '')
  }

  // a title that just repeats the app ("Xcode" window titled "Xcode") adds nothing
  if (detail && subject && (sameIgnoringCase(detail, subject) || detail.toLowerCase().startsWith(subject.toLowerCase() + ' '))) {
    detail = detail.slice(subject.length).trim() || ''
  }

  const parts = [subject, detail].filter(Boolean)
  if (!parts.length) return null
  return fit(parts.join(' · '))
}

// ── the product behind a browser tab ─────────────────────────────────────
// A browser take is of a product, and the browser is only the frame around it. The
// product comes from the page's domain when there is one, else from the tab title.

// Hosts that serve thousands of products, one per subdomain: the subdomain is the
// product. songscription-library.vercel.app is Songscription, not Vercel.
const HOSTING = /\.(vercel\.app|netlify\.app|herokuapp\.com|pages\.dev|workers\.dev|github\.io|gitlab\.io|onrender\.com|fly\.dev|railway\.app|web\.app|firebaseapp\.com|surge\.sh|ngrok-free\.app|ngrok\.io|ngrok\.app|glitch\.me|replit\.app|repl\.co|lovable\.app|framer\.website|framer\.app|webflow\.io|myshopify\.com|azurewebsites\.net|amplifyapp\.com|deno\.dev)$/
// Words a deploy name ends in that say what kind of page it is, not whose.
const GENERIC = new Set(['app', 'web', 'site', 'www', 'library', 'dashboard', 'demo', 'staging',
  'preview', 'prod', 'production', 'dev', 'frontend', 'client', 'landing', 'main', 'beta', 'test',
  'home', 'docs', 'admin', 'portal', 'console', 'settings', 'login', 'new tab', 'untitled'])
// The few brands whose capitals a title case would get wrong.
const BRAND = { github: 'GitHub', gitlab: 'GitLab', youtube: 'YouTube', linkedin: 'LinkedIn',
  openai: 'OpenAI', chatgpt: 'ChatGPT', posthog: 'PostHog', testflight: 'TestFlight', icloud: 'iCloud',
  producthunt: 'Product Hunt', stackoverflow: 'Stack Overflow', hubspot: 'HubSpot', paypal: 'PayPal' }
const GOOGLE = { docs: 'Google Docs', sheets: 'Google Sheets', slides: 'Google Slides', mail: 'Gmail',
  calendar: 'Google Calendar', drive: 'Google Drive', meet: 'Google Meet', analytics: 'Google Analytics' }
const cap = w => BRAND[w.toLowerCase()] || (w ? w[0].toUpperCase() + w.slice(1) : w)

/**
 * The product a web address belongs to, or null. Takes a bare host or a whole URL.
 *   songscription-library.vercel.app -> Songscription
 *   app.linear.app/team/issue/42     -> Linear
 */
function productFromDomain(domain) {
  let host = String(domain || '').trim().toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/^www\./, '')
  if (!host || host === 'localhost' || /^[\d.]+$/.test(host) || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) return null
  if (HOSTING.test(host)) {
    let words = host.slice(0, host.length - host.match(HOSTING)[0].length).split('.').pop()
      .replace(/-git-.*$/, '')                     // a Vercel branch preview
      .split('-')
    // a preview deploy's hash, and the team name after it
    const hash = words.findIndex((w, i) => i > 0 && w.length >= 7 && /\d/.test(w) && /[a-z]/.test(w))
    if (hash > 0) words = words.slice(0, hash)
    // songscription-library is Songscription, but my-app stays My App
    while (words.length > 1 && GENERIC.has(words[words.length - 1]) && words[words.length - 2].length >= 4) words.pop()
    const name = words.filter(Boolean).map(cap).join(' ')
    return name || null
  }
  const labels = host.split('.')
  // the registrable name: linear in app.linear.app, bbc in www.bbc.co.uk
  const twoLevel = /^(co|com|org|net|ac|gov|edu)$/.test(labels[labels.length - 2] || '') && labels.length > 2
  const at = labels.length - (twoLevel ? 3 : 2)
  const name = labels[at]
  if (!name) return null
  if (name === 'google' && GOOGLE[labels[at - 1]]) return GOOGLE[labels[at - 1]]
  return name.length <= 3 && !BRAND[name] ? name.toUpperCase() : cap(name)     // BBC, CNN
}

// A tab title that is only an address: what Chrome shows for a page with no <title>
const looksLikeAddress = s => /^([a-z][a-z0-9+.-]*:\/\/)?(localhost|[a-z0-9-]+(\.[a-z0-9-]+)+)(:\d+)?([/?#]\S*)?$/i.test(s)

/**
 * Splits a tab title into the product and the page, e.g. "Issue 42 · Linear" into
 * { product: 'Linear', page: 'Issue 42' }. product is null when the title does not
 * say whose page it is.
 */
function productFromTitle(title) {
  const t = bareTitle(title).trim()
  if (!t) return { product: null, page: '' }
  if (looksLikeAddress(t)) return { product: productFromDomain(t), page: '' }
  const parts = t.split(/\s+[|·•\u22C5\u2013\u2014-]\s+/).map(s => s.trim()).filter(Boolean)
  if (parts.length < 2) return { product: null, page: t }
  // a brand is a word or three, never a path, an address or a count
  const brand = s => s.split(/\s+/).length <= 3 && s.length <= 32 && !/[/@#:\\]|^\(?\d/.test(s) &&
    !GENERIC.has(s.toLowerCase())
  // ...and never a phrase: "Your spreadsheet workspace" is a tagline, not a name. A
  // tagline opens with a word like Your or The, or goes on in lower case.
  const phrase = s => /^(your|the|a|an|our|my|we|get|build|make|all|every)\s/i.test(s) ||
    s.split(/\s+/).slice(1).some(w => /^\p{Ll}/u.test(w))
  const name = s => brand(s) && !phrase(s)
  const first = parts[0], last = parts[parts.length - 1]
  // "Page | Brand" is the convention; "Brand - Page" when the end is not a brand
  let product = null
  if (name(last)) product = last
  else if (name(first)) product = first
  else if (brand(last)) product = last
  else if (brand(first)) product = first
  if (!product) return { product: null, page: t }
  return { product, page: parts.filter(p => p !== product).join(' ') }
}

/**
 * The app and window that were in front for most of a take, from samples taken every
 * couple of seconds while it recorded. A browser counts per product, so ten seconds
 * on GitHub do not outvote a minute on the app being demoed in the next tab.
 *
 * @param {Array<{app: string, title?: string, domain?: string}>} samples
 * @param {object} [opts]
 *   @param {string} [opts.app]  a window take: only that app's samples count
 * @returns {{app, title, domain, product, share}|null}
 */
function dominantFront(samples, opts = {}) {
  let list = (samples || []).filter(s => s && s.app)
  if (opts.app) list = list.filter(s => sameIgnoringCase(String(s.app), String(opts.app)))
  if (!list.length) return null
  const groups = new Map()
  list.forEach((s, i) => {
    const browser = BROWSERS.test(s.app)
    const product = browser ? (productFromDomain(s.domain) || (ownPage(s.app, s.title) || {}).product || productFromTitle(String(s.title || '').replace(BROWSER_SUFFIX, '')).product) : null
    const key = browser ? 'b:' + String(product || s.title || s.app).toLowerCase() : 'a:' + s.app.toLowerCase()
    if (!groups.has(key)) groups.set(key, { n: 0, last: 0, product, items: [] })
    const g = groups.get(key)
    g.n++; g.last = i; g.items.push(s)
  })
  // most samples wins; a tie goes to whatever was in front later
  const best = [...groups.values()].sort((a, b) => b.n - a.n || b.last - a.last)[0]
  const most = field => {
    const count = new Map()
    best.items.forEach((s, i) => { const v = s[field]; if (v) count.set(v, { n: ((count.get(v) || {}).n || 0) + 1, i }) })
    const top = [...count.entries()].sort((a, b) => b[1].n - a[1].n || b[1].i - a[1].i)[0]
    return top ? top[0] : ''
  }
  return { app: most('app'), title: most('title'), domain: most('domain') || null,
    product: best.product || null, share: best.n / list.length }
}

// ── names from the person's own agent ───────────────────────────────────
// The prompt for one short name. Only facts go in: the app, the window, the domain and
// the first words spoken. Never the video, the audio or a path.
function namePrompt({ app, title, domain, product, words } = {}) {
  // a browser's own chat is named by its kind; its title is the person's, not a product's
  const own = ownPage(app, title)
  if (own) { title = own.page; product = product || own.product }
  const said = String(words || '').split(/\s+/).filter(Boolean).slice(0, 80).join(' ')
  const facts = [
    app && `App: ${app}`,
    title && `Window title: ${bareTitle(title)}`,
    domain && `Web address: ${domain}`,
    product && `Product: ${product}`,
    said && `First words spoken: "${said}"`,
  ].filter(Boolean).join('\n')
  return 'Name this screen recording so it is easy to find in a list of takes.\n\n' + facts + '\n\n' +
    'Reply with the name only, in the form "Product · What happens": the product being shown ' +
    (product ? `(use "${product}")` : '(the app or website, not the browser)') +
    ', a middle dot, then what the recording shows in two to four words (a checkout demo might be ' +
    '"Checkout Flow", a settings walkthrough "Settings Tour"). At most 6 words in total, title case, ' +
    'no quotes, no full stop.'
}

// Short words a title case leaves alone, except at the start
const SMALL = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'vs', 'via', 'with'])
function titleCase(s) {
  return s.split(' ').map((w, i) => {
    if (!w || /[A-Z]/.test(w.slice(1)) || /\d/.test(w)) return w     // iOS, GitHub, v2
    const lower = w.toLowerCase()
    return i > 0 && SMALL.has(lower) ? lower : w[0].toUpperCase() + w.slice(1)
  }).join(' ')
}

/**
 * The name out of whatever the model replied, or null when the reply is not a name
 * (an apology, a paragraph). Always "Product · What happens" shaped when it can be.
 */
function parseAgentName(reply) {
  let line = String(reply || '').split('\n').map(l => l.trim()).find(Boolean) || ''
  line = line.replace(/^(\*\*)?(name|title)(\*\*)?\s*:\s*/i, '').replace(/^[-*>•\s]+/, '')
    .replace(/^["'`“”‘’*_]+|["'`“”‘’*_.]+$/g, '').trim()
  if (!line || line.split(/\s+/).length > 12 || /^(i |i'|sorry|unfortunately|here|sure|okay|ok\b|certainly|of course)/i.test(line)) return null
  // the one separator this app uses, whatever the model reached for
  if (!line.includes('·')) line = line.replace(/\s+[|\u2013\u2014:-]\s+|:\s+/, ' · ')
  const [head, ...rest] = line.split(/\s*·\s*/).filter(Boolean)
  if (!head) return null
  const tail = rest.join(' ')
  const words = (head + ' ' + tail).trim().split(/\s+/)
  if (words.length > 8) return null
  const name = clean([titleCase(head), tail && titleCase(tail)].filter(Boolean).join(' · '))
  return name ? fit(name) : null
}

// ── a shot names itself after what it captured ────────────────────────────
// Same rule as a take, for the same reason: the library is scanned by what is in the
// picture, not by when the shutter went. The difference is that a still has no
// transcript, so this name is the only one it will ever get, and a capture of a whole
// display with nothing identifiable in front still has to be called something.
const AREA = { display: 'Screen', region: 'Screen area', window: 'Window' }
function shotName({ app, title, domain, product, area } = {}) {
  return smartName({ app, title, domain, product }) || AREA[area] || null
}

/**
 * `stem`, or the first of `stem 2`, `stem 3`... that is free. Two shots of the same
 * window a second apart are the ordinary case, so a name has to make room for its
 * twin rather than overwrite it. Same shape as processor.renameTake's "Name 2".
 *
 * @param {string} stem
 * @param {string[]|function} taken  the names already used, or a test for one
 */
function uniqueName(stem, taken) {
  const used = typeof taken === 'function' ? taken
    : n => (taken || []).some(t => sameIgnoringCase(String(t || ''), n))
  const base = fit(clean(stem)) || 'Screen'
  if (!used(base)) return base
  for (let n = 2; n < 1000; n++) {
    const suffix = ' ' + n
    const next = fit(base, MAX - suffix.length) + suffix
    if (!used(next)) return next
  }
  return base + ' ' + Date.now().toString(36)
}

// Names Fetch generated itself, which are fair game to improve later. A name someone
// typed is theirs and is never touched again. `note` is the take's name note
// (processor.readNameNote): the exact name Fetch last gave it, so a name made from the
// app in front ("Songscription · Library") is told apart from one a person typed.
// The bare fallbacks a shot falls back to ("Screen", "Screen area 3") count too: they
// are names nobody types.
const isAutoName = (stem, note) => {
  const s = String(stem || '')
  // shot-<epoch> is what the capture path writes before anything names it, the same
  // shape recording-<epoch> is for a take.
  if (/^recording-\d{10,}/i.test(s) || /^shot-\d{10,}/i.test(s) || /^Screen · \d/.test(s)) return true
  if (/^(Screen|Screen area|Window)( \d+)?$/.test(s)) return true
  return !!(note && typeof note.auto === 'string' && note.auto && s === note.auto)
}

module.exports = { smartName, shotName, uniqueName, isAutoName, clean, fit, MAX,
  productFromDomain, productFromTitle, dominantFront, namePrompt, parseAgentName, titleCase }
