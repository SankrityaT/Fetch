// Photographs from Unsplash, for backdrops. Main-process module, required from main.js.
//
// Two things live here. The credit every bundled or downloaded photograph carries
// (creditFor, withUtm), which processor.js reads for the backdrop list so the picker can
// name the photographer. And a small client for the Unsplash API: search, a result's
// photographer and links, and use(), which fetches a chosen photo into the person's own
// backdrops folder and tells Unsplash it was used, as their API guidelines require.
//
// Like the voiceover (ui/voice.js), this leaves the machine, and only when the person
// asks: a search is sent when they search, a download when they pick a photo. The
// access key is theirs, lives in the macOS Keychain and never in prefs.json, and is
// never logged, returned or put into an error message. Without a key nothing here
// fails: search() and use() answer { ok: false, reason: 'no-key' } with a sentence
// saying how to add one, and the bundled photographs work as before.
//
// Unsplash API guidelines, and where each is met (the full list is in the F2 report):
// - hotlink: the picker shows photo.urls as returned; use() fetches urls.raw with sizing
//   parameters appended, so its ixid stays on the URL
// - track: use() calls links.download_location, authorised, before it downloads
// - attribute: every result and every saved photo carries the photographer, their
//   profile and the photo's page, each with utm_source and utm_medium=referral
// - keep the key secret: Keychain only, sent only to api.unsplash.com, scrubbed from
//   anything that could be shown
// - respect the rate limit: results are cached, X-Ratelimit-Remaining is read, and at
//   zero the client refuses locally instead of spending more requests
//
// Everything network is injected (createClient({ request, keys })), so the tests run
// under node with no network at all.

'use strict'
const fs = require('fs')
const path = require('path')

const API = 'https://api.unsplash.com'
const API_HOST = 'api.unsplash.com'
const IMAGE_HOST = 'images.unsplash.com'
// utm_source is the application's name as registered with Unsplash. Change it here if
// the registered name differs, and only here.
const APP = 'fetch'
const SERVICE = 'fetch-unsplash'

// What the picker shows when there is no key. One sentence and where to go.
const NO_KEY = 'Photo search needs an Unsplash access key. Add yours in Settings, under Unsplash. The photos that come with Fetch work without one.'

// ---------- links and credit ----------
// Every link back to Unsplash carries the referral parameters. A link that already has
// them is left alone, and anything that is not an unsplash.com link is refused, so a
// photographer's profile can never be pointed elsewhere by a bad response.
function withUtm(url) {
  let u
  try { u = new URL(String(url || '')) } catch { return null }
  if (u.protocol !== 'https:' || !/(^|\.)unsplash\.com$/.test(u.hostname)) return null
  u.searchParams.set('utm_source', APP)
  u.searchParams.set('utm_medium', 'referral')
  return u.toString()
}

const UNSPLASH_HOME = withUtm('https://unsplash.com/')

// Where a photograph came from. assets/backdrops/README.md invites the person to add a
// credits.json entry for a photograph that is not ours, so an entry says its own source
// and its own licence and this honours both. Stamping every entry "Unsplash" and
// "Unsplash License" would display a CC-BY-SA photograph, in the person's own app, as an
// Unsplash-licensed one, which is a false licence statement rather than a cosmetic slip.
const SOURCES = {
  unsplash: { label: 'Unsplash', home: UNSPLASH_HOME, license: 'Unsplash License', link: withUtm },
}
const hostname = u => { try { return new URL(String(u)).hostname } catch { return '' } }
// An https link as the entry gave it, for a source with no rule of its own. Never http,
// so a credit cannot point at something a network can rewrite.
const httpsOnly = u => /^https:\/\//i.test(String(u || '')) ? String(u) : null
// The source an entry names, or the one its own links give it away as.
function sourceKey(c) {
  const said = String(c.source || '').trim().toLowerCase()
  if (said) return said
  return /(^|\.)unsplash\.com$/.test(hostname(c.photo || c.profile || '')) ? 'unsplash' : ''
}
const titled = k => k ? k.charAt(0).toUpperCase() + k.slice(1) : ''

// The credit a backdrop carries, from a credits.json entry or an API result's user.
// text is the line the picker shows; the links are what its two names open.
function creditFor(c) {
  if (!c || !c.photographer) return null
  const key = sourceKey(c)
  const known = SOURCES[key] || null
  const link = known && known.link ? known.link : httpsOnly
  const profile = link(c.profile || (known === SOURCES.unsplash && c.username ? `https://unsplash.com/@${c.username}` : ''))
  const photo = link(c.photo)
  const label = c.sourceLabel ? String(c.sourceLabel) : known ? known.label : titled(key)
  const home = known ? known.home : (hostname(photo) ? 'https://' + hostname(photo) + '/' : null)
  return {
    photographer: String(c.photographer),
    profile, photo,
    // the same three under the names the picker reads (ui/unsplash-picker.js creditOf)
    name: String(c.photographer), url: profile, link: photo,
    source: label || null,
    sourceUrl: home,
    license: c.license || (known ? known.license : null),
    text: `Photo by ${c.photographer}${label ? ` on ${label}` : ''}`,
  }
}

// credits.json beside the images: { "file.jpg": { photographer, username, photo, ... } }.
//
// Missing and unreadable are not the same thing, and use() has to tell them apart: it
// rewrites this file whole, so treating a truncated one as empty would erase every
// photographer already on disk and leave their photographs in the folder with no
// attribution, which is the one licence risk this module exists to prevent.
// { credits, ok, missing }: ok is false only where a file is there and cannot be read.
function creditsFile(dir) { return path.join(dir, 'credits.json') }
function readCreditsState(dir) {
  const file = creditsFile(dir)
  let raw
  try { raw = fs.readFileSync(file, 'utf8') }
  catch (err) { return { credits: {}, ok: true, missing: true } }
  try {
    const j = JSON.parse(raw)
    if (j && typeof j === 'object' && !Array.isArray(j)) return { credits: j, ok: true, missing: false }
  } catch {}
  return { credits: {}, ok: false, missing: false }
}
function readCredits(dir) { return readCreditsState(dir).credits }

// ---------- a result, as the rest of Fetch sees it ----------
function normalize(p) {
  if (!p || !p.id || !p.urls) return null
  const user = p.user || {}
  const credit = creditFor({
    photographer: user.name || user.username,
    profile: user.links && user.links.html,
    username: user.username,
    photo: p.links && p.links.html,
  })
  return {
    id: String(p.id),
    width: p.width || null,
    height: p.height || null,
    color: p.color || null,
    blurHash: p.blur_hash || null,
    alt: p.alt_description || p.description || null,
    // hotlinked, exactly as returned: the picker shows these directly
    thumb: p.urls.small || p.urls.thumb || null,
    preview: p.urls.regular || null,
    raw: p.urls.raw || null,
    downloadLocation: (p.links && p.links.download_location) || null,
    page: credit && credit.photo,
    photographer: credit && { name: credit.photographer, username: user.username || null, profile: credit.profile },
    credit,
  }
}

// ---------- the key ----------
// ui/keystore.js holds it: encrypted by Electron's safeStorage into a 0600 file, whose
// Keychain item is bound to Fetch's own binary. It used to be a generic password made by
// /usr/bin/security, which puts that binary in the item's ACL, so any shell the person
// runs (an agent engine keeps one) could print the key back with no prompt. A key still
// in the old item is migrated on the first read and the old item deleted.
function keychain() { return require('./keystore').store(SERVICE) }

// ---------- http ----------
// request({ url, headers }) -> { status, headers, body: Buffer }. Headers come back with
// lower-case names, as node gives them.
function httpsRequest({ url, headers = {}, timeout = 30000 }) {
  const https = require('https')
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, timeout }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on('timeout', () => req.destroy(new Error('Unsplash did not answer in time')))
    req.on('error', reject)
  })
}

const hostOf = url => { try { return new URL(url).hostname } catch { return '' } }

// ---------- the client ----------
function createClient({
  request = httpsRequest,
  keys = keychain(),
  now = () => Date.now(),
  cacheTtl = 60 * 60 * 1000,   // an hour: results for a query change slowly
  cacheMax = 60,
} = {}) {
  const cache = new Map()      // key -> { at, value }, oldest first
  let limitedUntil = 0         // when the rate limit ran out, the time to try again

  // Anything shown or thrown passes through here, so the key can never ride out in an
  // error message, even one Unsplash wrote.
  const scrub = (s, key) => {
    let t = String(s || '')
    if (key) t = t.split(key).join('…')
    return t
  }

  async function api(pathAndQuery, key) {
    const url = API + pathAndQuery
    if (hostOf(url) !== API_HOST) throw new Error('refused a request that was not to the Unsplash API')
    let res
    try {
      res = await request({
        url,
        headers: { Authorization: `Client-ID ${key}`, 'Accept-Version': 'v1', Accept: 'application/json' },
      })
    } catch {
      // offline, refused, timed out: said plainly, and never with the socket's own words
      return { error: 'offline', message: 'Could not reach Unsplash. Check the connection and try again.' }
    }
    const remaining = res.headers && res.headers['x-ratelimit-remaining']
    if (remaining != null && +remaining <= 0) limitedUntil = now() + 60 * 60 * 1000
    let body = null
    try { body = JSON.parse(Buffer.from(res.body || '').toString('utf8') || 'null') } catch {}
    if (res.status >= 400) {
      const theirs = body && Array.isArray(body.errors) ? body.errors.join(' ') : ''
      const text = Buffer.from(res.body || '').toString('utf8')
      if (res.status === 401) return { error: 'bad-key', message: 'Unsplash did not accept that access key.' }
      if (res.status === 403 && /rate limit/i.test(theirs || text)) {
        limitedUntil = now() + 60 * 60 * 1000
        return { error: 'rate-limited', message: 'Unsplash has had enough searches from this key for the hour. Try again later.' }
      }
      return { error: 'http', message: scrub(theirs ? `Unsplash said: ${theirs}` : `Unsplash returned ${res.status}.`, key) }
    }
    return { body }
  }

  // A refusal says why twice: message, and why, which is the name the picker reads.
  const refuse = (reason, message) => ({ ok: false, reason, message, why: message })
  const noKey = () => refuse('no-key', NO_KEY)
  const limited = () => refuse('rate-limited', 'Unsplash has had enough searches from this key for the hour. Try again later.')
  const fail = r => refuse(r.error, r.message)
  const badPhoto = m => refuse('bad-photo', m)
  // Every result this client has handed out, by id, so use() can be asked for a photo by
  // its id alone. The renderer sends only the id, and the URLs a download follows are
  // the ones Unsplash gave, never ones the page supplies.
  const seen = new Map()

  async function status() {
    const key = await keys.get()
    return { connected: !!key, limited: now() < limitedUntil, help: key ? null : NO_KEY }
  }

  // Checked before it is stored, so a mistyped key is caught here rather than at the
  // first search. The key is not echoed back in any answer.
  async function connect(key) {
    const k = String(key || '').trim()
    if (!k) return refuse('no-key', 'Paste an Unsplash access key first.')
    const r = await api('/photos?per_page=1', k)
    if (r.error) return fail(r)
    await keys.set(k)
    cache.clear()
    return { ok: true }
  }

  async function disconnect() {
    await keys.clear()
    cache.clear()
    return { ok: true }
  }

  async function search(query, { page = 1, perPage = 24, orientation = 'landscape', color = null } = {}) {
    const q = String(query || '').trim().replace(/\s+/g, ' ')
    if (!q) return { ok: true, query: q, total: 0, pages: 0, results: [] }
    const key = await keys.get()
    if (!key) return noKey()
    const pg = Math.max(1, Math.floor(+page) || 1)
    const per = Math.min(30, Math.max(1, Math.floor(+perPage) || 24))
    const params = new URLSearchParams({ query: q, page: String(pg), per_page: String(per), content_filter: 'high' })
    if (orientation) params.set('orientation', orientation)
    if (color) params.set('color', color)
    const ck = params.toString().toLowerCase()
    const hit = cache.get(ck)
    if (hit && now() - hit.at < cacheTtl) {
      cache.delete(ck); cache.set(ck, hit)   // most recently used goes last
      return { ...hit.value, cached: true }
    }
    if (now() < limitedUntil) return limited()
    const r = await api('/search/photos?' + params.toString(), key)
    if (r.error) return fail(r)
    const b = r.body || {}
    const value = {
      ok: true, query: q, page: pg,
      total: b.total || 0, pages: b.total_pages || 0,
      results: (b.results || []).map(normalize).filter(Boolean),
      attribution: { text: 'Photos from Unsplash', url: UNSPLASH_HOME },
    }
    for (const p of value.results) seen.set(p.id, p)
    while (seen.size > 600) seen.delete(seen.keys().next().value)
    cache.set(ck, { at: now(), value })
    while (cache.size > cacheMax) cache.delete(cache.keys().next().value)
    return value
  }

  // The photo the person picked, saved into their backdrops folder with its credit, so
  // exports read a local file and the picker can name who took it. Unsplash is told of
  // the use first, through the photo's own download_location. A photo already saved is
  // not fetched or counted again: choosing it later is choosing a local backdrop.
  // photo is an id from a search this client ran, { id }, or a result itself.
  async function use(photo, { dir, width = 2560, height = 1440 } = {}) {
    const id = typeof photo === 'string' ? photo : photo && photo.id
    const p = (id != null && seen.get(String(id))) || (photo && photo.raw ? photo : normalize(photo))
    if (!p || !p.id || !p.raw) return badPhoto('That is not a photo from an Unsplash search.')
    if (!dir) return refuse('no-dir', 'No backdrops folder to save into.')
    const safeId = String(p.id).replace(/[^A-Za-z0-9_-]/g, '')
    const file = `unsplash-${safeId}.jpg`
    const dest = path.join(dir, file)
    const out = { ok: true, id: 'img:user/' + file, file: dest, credit: p.credit }
    if (fs.existsSync(dest)) return { ...out, already: true }

    const key = await keys.get()
    if (!key) return noKey()
    if (hostOf(p.raw) !== IMAGE_HOST) return badPhoto('That photo does not come from Unsplash.')

    // Before anything is spent or written: the credits file this will rewrite whole has
    // to be readable. A truncated or hand-broken one read as empty would drop every
    // photographer already in that folder and leave their photographs on disk with no
    // attribution, which is the one licence risk this module exists to prevent. So the
    // bad file is moved aside under its own name, nothing is destroyed, and the person
    // is told before a photo lands beside it.
    if (!readCreditsState(dir).ok) {
      const bad = creditsFile(dir)
      try { fs.renameSync(bad, bad + '.bad') } catch {}
      return refuse('bad-credits', 'The credits file in your backdrops folder could not be read, so it was renamed to credits.json.bad rather than overwritten. Nothing was downloaded. Fix it or move it away, then try again.')
    }

    // 1. the use, as the guidelines ask. Only to the API host, since it carries the key.
    const loc = p.downloadLocation
    if (!loc || hostOf(loc) !== API_HOST || !String(loc).startsWith('https:')) return badPhoto('That photo has no Unsplash download link.')
    if (now() < limitedUntil) return limited()
    const where = new URL(loc)
    const tracked = await api(where.pathname + where.search, key)
    if (tracked.error) return fail(tracked)

    // 2. the image, from the hotlinked raw URL with sizing appended, so ixid stays on it.
    // No key goes to the image host.
    const u = new URL(p.raw)
    u.searchParams.set('w', String(width))
    u.searchParams.set('h', String(height))
    u.searchParams.set('fit', 'crop')
    u.searchParams.set('crop', 'entropy')
    u.searchParams.set('fm', 'jpg')
    u.searchParams.set('q', '80')
    let img
    try { img = await request({ url: u.toString(), headers: { Accept: 'image/jpeg' } }) }
    catch { return refuse('offline', 'Could not reach Unsplash for the photo. Check the connection and try again.') }
    if (img.status >= 400 || !img.body || !img.body.length) {
      return refuse('http', `Unsplash returned ${img.status} for the image.`)
    }

    fs.mkdirSync(dir, { recursive: true })
    const tmp = dest + '.part'
    fs.writeFileSync(tmp, img.body)
    fs.renameSync(tmp, dest)

    // Read again now rather than reusing what was read before the download: another use
    // may have finished in between, and its photographer must not be dropped. A file
    // that went bad in that window is left exactly as it is and the photo keeps its
    // credit in the answer, since losing ten credits to save one is the worse trade.
    const state = readCreditsState(dir)
    if (!state.ok) return { ...out, credited: false }
    const credits = state.credits
    credits[file] = {
      title: p.alt || null,
      photographer: p.credit ? p.credit.photographer : null,
      username: p.photographer ? p.photographer.username : null,
      photo: p.page ? stripUtm(p.page) : null,
      source: 'unsplash', license: 'Unsplash License',
    }
    const ctmp = creditsFile(dir) + '.part'
    fs.writeFileSync(ctmp, JSON.stringify(credits, null, 2) + '\n')
    fs.renameSync(ctmp, creditsFile(dir))
    return out
  }

  return { status, connect, disconnect, search, use, cacheSize: () => cache.size }
}

function stripUtm(url) {
  try {
    const u = new URL(url)
    u.searchParams.delete('utm_source'); u.searchParams.delete('utm_medium')
    return u.toString()
  } catch { return url }
}

// The one the app uses. Tests make their own.
let shared = null
const client = () => shared || (shared = createClient())

module.exports = {
  createClient, normalize, creditFor, withUtm, readCredits, readCreditsState,
  NO_KEY, APP, UNSPLASH_HOME,
  status: (...a) => client().status(...a),
  connect: (...a) => client().connect(...a),
  disconnect: (...a) => client().disconnect(...a),
  search: (...a) => client().search(...a),
  use: (...a) => client().use(...a),
}
