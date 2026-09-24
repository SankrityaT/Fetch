// ui/unsplash.js and the photographs that ship, under node with the network injected.
// Nothing here opens a socket or touches the Keychain.
//
//   node test/unsplash.test.js

'use strict'
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const U = require('../ui/unsplash')

let passed = 0, failed = 0
const is = (what, got, want) => {
  try { assert.deepStrictEqual(got, want); passed++ }
  catch { failed++; console.log(`FAIL ${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`) }
}
const ok = (what, cond) => { if (cond) passed++; else { failed++; console.log('FAIL ' + what) } }

// A placeholder, deliberately nothing like a real key's shape.
const KEY = 'placeholder-access-key'

// A fake Unsplash: records every request, answers from a table.
function fakeNet(routes = {}) {
  const calls = []
  const request = async ({ url, headers }) => {
    calls.push({ url, headers: { ...headers } })
    const u = new URL(url)
    for (const [prefix, answer] of Object.entries(routes)) {
      if ((u.hostname + u.pathname).startsWith(prefix)) {
        const a = typeof answer === 'function' ? answer(u) : answer
        const body = Buffer.isBuffer(a.body) ? a.body : Buffer.from(JSON.stringify(a.body ?? {}))
        return { status: a.status || 200, headers: a.headers || { 'x-ratelimit-remaining': '49' }, body }
      }
    }
    return { status: 404, headers: {}, body: Buffer.from('{"errors":["Not found"]}') }
  }
  return { request, calls }
}
function fakeKeys(initial = null) {
  let k = initial
  return { get: async () => k, set: async v => { k = v }, clear: async () => { k = null }, peek: () => k }
}
const photo = (id, extra = {}) => ({
  id, width: 6000, height: 4000, color: '#c0a080', blur_hash: 'LKO2?U%2Tw=w]~RBVZRi};RPxuwH',
  alt_description: 'sand dunes at dusk', description: null,
  urls: {
    raw: `https://images.unsplash.com/photo-${id}?ixid=track${id}&ixlib=rb-4.0.3`,
    regular: `https://images.unsplash.com/photo-${id}?ixid=track${id}&w=1080`,
    small: `https://images.unsplash.com/photo-${id}?ixid=track${id}&w=400`,
    thumb: `https://images.unsplash.com/photo-${id}?ixid=track${id}&w=200`,
  },
  links: {
    html: `https://unsplash.com/photos/${id}`,
    download_location: `https://api.unsplash.com/photos/${id}/download?ixid=track${id}`,
  },
  user: { name: 'Ada Lens', username: 'adalens', links: { html: 'https://unsplash.com/@adalens' } },
  ...extra,
})
const searchAnswer = (ids, headers) => ({ body: { total: ids.length, total_pages: 1, results: ids.map(i => photo(i)) }, headers })

;(async () => {
  // ---- no key: a clear refusal, never an error, and no request made
  {
    const net = fakeNet()
    const c = U.createClient({ request: net.request, keys: fakeKeys(null) })
    const r = await c.search('dunes')
    is('no key refuses', [r.ok, r.reason], [false, 'no-key'])
    ok('no key says how to add one', /Settings/.test(r.message) && /Unsplash/.test(r.message))
    ok('no key says the bundled photos still work', /work without one/.test(r.message))
    is('no key sends nothing', net.calls.length, 0)
    const st = await c.status()
    is('status without a key', [st.connected, !!st.help], [false, true])
    const used = await c.use(U.normalize(photo('abc')), { dir: fs.mkdtempSync(path.join(os.tmpdir(), 'f2-')) })
    is('use without a key refuses too', [used.ok, used.reason], [false, 'no-key'])
    is('an empty query asks nothing', (await c.search('   ')).results, [])
  }

  // ---- search: headers, parameters, the normalised result, attribution
  {
    const net = fakeNet({ 'api.unsplash.com/search/photos': searchAnswer(['a1', 'b2']) })
    const c = U.createClient({ request: net.request, keys: fakeKeys(KEY) })
    const r = await c.search('  calm   dunes ', { perPage: 99 })
    is('search ok', [r.ok, r.results.length, r.total], [true, 2, 2])
    const call = net.calls[0]
    const u = new URL(call.url)
    is('goes to the API host', u.hostname, 'api.unsplash.com')
    is('key sent as Client-ID', call.headers.Authorization, `Client-ID ${KEY}`)
    is('asks for v1', call.headers['Accept-Version'], 'v1')
    is('query tidied', u.searchParams.get('query'), 'calm dunes')
    is('per_page capped at their maximum', u.searchParams.get('per_page'), '30')
    is('landscape by default, for a 16:9 frame', u.searchParams.get('orientation'), 'landscape')
    is('safe content filter', u.searchParams.get('content_filter'), 'high')
    ok('the key is never in the URL', !call.url.includes(KEY))
    const p = r.results[0]
    is('thumb is the hotlinked URL, untouched', p.thumb, photo('a1').urls.small)
    is('photographer name', p.photographer.name, 'Ada Lens')
    is('profile carries utm', p.photographer.profile, 'https://unsplash.com/@adalens?utm_source=fetch&utm_medium=referral')
    is('photo page carries utm', p.page, 'https://unsplash.com/photos/a1?utm_source=fetch&utm_medium=referral')
    is('credit line', p.credit.text, 'Photo by Ada Lens on Unsplash')
    is('credit links Unsplash with utm', p.credit.sourceUrl, 'https://unsplash.com/?utm_source=fetch&utm_medium=referral')
    ok('download location kept', /\/photos\/a1\/download/.test(p.downloadLocation))
    ok('the key is nowhere in the result', !JSON.stringify(r).includes(KEY))
    ok('results attribute Unsplash', /Unsplash/.test(r.attribution.text) && /utm_medium=referral/.test(r.attribution.url))
  }

  // ---- cache: the same search is answered locally, a different one is not, it expires
  {
    let t = 1000
    const net = fakeNet({ 'api.unsplash.com/search/photos': searchAnswer(['a1']) })
    const c = U.createClient({ request: net.request, keys: fakeKeys(KEY), now: () => t, cacheTtl: 5000, cacheMax: 2 })
    await c.search('fog')
    const again = await c.search('FOG')
    is('same search cached, case and space folded', [net.calls.length, again.cached], [1, true])
    await c.search('fog', { page: 2 })
    is('another page is another request', net.calls.length, 2)
    t += 6000
    await c.search('fog')
    is('cache expires', net.calls.length, 3)
    await c.search('sea'); await c.search('sky')
    is('cache is bounded', c.cacheSize(), 2)
  }

  // ---- rate limit: read from the header, refused locally once spent
  {
    let t = 0
    const net = fakeNet({ 'api.unsplash.com/search/photos': searchAnswer(['a1'], { 'x-ratelimit-remaining': '0' }) })
    const c = U.createClient({ request: net.request, keys: fakeKeys(KEY), now: () => t })
    const first = await c.search('one')
    is('the last allowed request still answers', first.ok, true)
    const second = await c.search('two')
    is('then refuses locally', [second.ok, second.reason, net.calls.length], [false, 'rate-limited', 1])
    is('a cached search still answers while limited', (await c.search('one')).ok, true)
    t += 61 * 60 * 1000
    await c.search('three')
    is('tries again after the hour', net.calls.length, 2)
  }
  {
    const net = fakeNet({ 'api.unsplash.com/search/photos': { status: 403, body: 'Rate Limit Exceeded' } })
    const c = U.createClient({ request: net.request, keys: fakeKeys(KEY) })
    const r = await c.search('x')
    is('a 403 rate limit is said as one', [r.ok, r.reason], [false, 'rate-limited'])
  }

  // ---- errors never carry the key
  {
    const net = fakeNet({ 'api.unsplash.com/search/photos': { status: 500, body: { errors: [`boom for ${KEY}`] } } })
    const c = U.createClient({ request: net.request, keys: fakeKeys(KEY) })
    const r = await c.search('x')
    is('an error is an answer, not a throw', r.ok, false)
    ok('their message is passed on', /boom/.test(r.message))
    ok('with the key scrubbed out', !r.message.includes(KEY))
  }

  // ---- connect: checked before stored, a bad key is not stored
  {
    const keys = fakeKeys(null)
    const bad = fakeNet({ 'api.unsplash.com/photos': { status: 401, body: { errors: ['OAuth error: The access token is invalid'] } } })
    const c1 = U.createClient({ request: bad.request, keys })
    const r1 = await c1.connect('  wrong-placeholder  ')
    is('a rejected key is refused', [r1.ok, r1.reason], [false, 'bad-key'])
    is('and not stored', keys.peek(), null)
    ok('and not echoed', !JSON.stringify(r1).includes('wrong-placeholder'))
    const good = fakeNet({ 'api.unsplash.com/photos': { body: [photo('z')] } })
    const c2 = U.createClient({ request: good.request, keys })
    const r2 = await c2.connect(` ${KEY} `)
    is('a good key is stored trimmed', [r2.ok, keys.peek()], [true, KEY])
    ok('connect returns no key', !JSON.stringify(r2).includes(KEY))
    is('empty connect refuses', (await c2.connect('')).reason, 'no-key')
    await c2.disconnect()
    is('disconnect clears', keys.peek(), null)
  }

  // ---- use: download endpoint first, then the hotlinked image, then the credit
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f2-'))
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9])
    const net = fakeNet({
      'api.unsplash.com/search/photos': searchAnswer(['d9']),
      'api.unsplash.com/photos/d9/download': { body: { url: 'https://images.unsplash.com/photo-d9?ixid=track' } },
      'images.unsplash.com/photo-d9': { body: jpeg },
    })
    const c = U.createClient({ request: net.request, keys: fakeKeys(KEY) })
    const [p] = (await c.search('dunes')).results
    const r = await c.use(p, { dir })
    is('use ok', [r.ok, r.id], [true, 'img:user/unsplash-d9.jpg'])
    const after = net.calls.slice(1)
    is('two requests: track, then image', after.map(x => new URL(x.url).hostname), ['api.unsplash.com', 'images.unsplash.com'])
    is('tracking is the download endpoint', new URL(after[0].url).pathname, '/photos/d9/download')
    is('tracking keeps its ixid', new URL(after[0].url).searchParams.get('ixid'), 'trackd9')
    is('tracking is authorised', after[0].headers.Authorization, `Client-ID ${KEY}`)
    const img = new URL(after[1].url)
    is('image keeps ixid', img.searchParams.get('ixid'), 'trackd9')
    is('image sized for a frame', [img.searchParams.get('w'), img.searchParams.get('h')], ['2560', '1440'])
    ok('the key never goes to the image host', !JSON.stringify(after[1].headers).includes(KEY))
    is('the file is written', fs.readFileSync(path.join(dir, 'unsplash-d9.jpg')), jpeg)
    ok('no partial file left', !fs.existsSync(path.join(dir, 'unsplash-d9.jpg.part')))
    const cr = U.readCredits(dir)['unsplash-d9.jpg']
    is('credit saved beside it', [cr.photographer, cr.username, cr.photo], ['Ada Lens', 'adalens', 'https://unsplash.com/photos/d9'])
    is('saved credit reads back as the list shows it', U.creditFor(cr).text, 'Photo by Ada Lens on Unsplash')
    const again = await c.use(p, { dir })
    is('a photo already saved is not fetched or counted again', [again.ok, again.already, net.calls.length], [true, true, 3])
  }
  {
    const net = fakeNet()
    const c = U.createClient({ request: net.request, keys: fakeKeys(KEY) })
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f2-'))
    const evil = U.normalize(photo('e1', { links: { html: 'https://unsplash.com/photos/e1', download_location: 'https://evil.example/photos/e1/download' } }))
    is('a download link off the API host is refused', (await c.use(evil, { dir })).reason, 'bad-photo')
    const evil2 = U.normalize(photo('e2', { urls: { raw: 'https://evil.example/x.jpg', small: 'https://evil.example/s.jpg' } }))
    is('an image off the image host is refused', (await c.use(evil2, { dir })).reason, 'bad-photo')
    is('neither sent anything, so the key went nowhere', net.calls.length, 0)
    is('not a photo', (await c.use({}, { dir })).reason, 'bad-photo')
    const trav = U.normalize(photo('../../etc'))
    const tr = await c.use(trav, { dir })
    ok('an id cannot climb out of the folder', !tr.file || path.dirname(tr.file) === dir)
  }

  // ---- use by id alone, as the picker sends it over IPC
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f2-'))
    const net = fakeNet({
      'api.unsplash.com/search/photos': searchAnswer(['k7']),
      'api.unsplash.com/photos/k7/download': { body: { url: 'x' } },
      'images.unsplash.com/photo-k7': { body: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) },
    })
    const c = U.createClient({ request: net.request, keys: fakeKeys(KEY) })
    is('an id nobody searched for is refused', (await c.use({ id: 'k7' }, { dir })).reason, 'bad-photo')
    await c.search('k')
    const r = await c.use({ id: 'k7' }, { dir })
    is('an id from a search is used', [r.ok, r.id], [true, 'img:user/unsplash-k7.jpg'])
    const r2 = await c.use('k7', { dir })
    is('a bare id works too', r2.already, true)
  }

  // ---- offline is an answer, not a throw
  {
    const c = U.createClient({ request: async () => { throw new Error(`ECONNREFUSED ${KEY}`) }, keys: fakeKeys(KEY) })
    const r = await c.search('sea')
    is('offline refuses', [r.ok, r.reason], [false, 'offline'])
    ok('offline message is plain and keyless', /Could not reach Unsplash/.test(r.message) && !r.message.includes(KEY))
    is('a refusal carries why, for the picker', r.why, r.message)
  }

  // ---- the credit, in the shape the picker reads (ui/unsplash-picker.js creditOf)
  {
    const cr = U.creditFor({ photographer: 'Ada Lens', username: 'adalens', photo: 'https://unsplash.com/photos/x1' })
    is('picker name', cr.name, 'Ada Lens')
    is('picker url is the profile', cr.url, 'https://unsplash.com/@adalens?utm_source=fetch&utm_medium=referral')
    is('picker link is the photo page', cr.link, 'https://unsplash.com/photos/x1?utm_source=fetch&utm_medium=referral')
    is('picker source', cr.source, 'Unsplash')
    let Picker = null
    try { Picker = require('../ui/unsplash-picker') } catch {}
    if (Picker && Picker.creditOf) {
      const seen = Picker.creditOf({ credit: cr })
      is('the picker reads it as given', [seen.name, seen.source, !!seen.url, !!seen.link], ['Ada Lens', 'Unsplash', true, true])
    }
  }

  // ---- links
  is('utm added', U.withUtm('https://unsplash.com/@x'), 'https://unsplash.com/@x?utm_source=fetch&utm_medium=referral')
  is('utm not doubled', U.withUtm(U.withUtm('https://unsplash.com/@x')), 'https://unsplash.com/@x?utm_source=fetch&utm_medium=referral')
  is('a profile off unsplash.com is refused', U.withUtm('https://evil.example/@x'), null)
  is('plain http refused', U.withUtm('http://unsplash.com/@x'), null)
  is('no photographer, no credit', U.creditFor({}), null)

  // ---- the set that ships
  {
    const dir = path.join(__dirname, '..', 'assets', 'backdrops')
    const credits = U.readCredits(dir)
    const jpgs = fs.readdirSync(dir).filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f))
    const photos = Object.keys(credits)
    is('ten photographs', photos.length, 10)
    for (const f of photos) {
      ok(`${f} is on disk`, jpgs.includes(f))
      const c = credits[f]
      ok(`${f} names its photographer`, !!c.photographer && !!c.username)
      ok(`${f} links its photo page`, /^https:\/\/unsplash\.com\/photos\/[A-Za-z0-9_-]+$/.test(c.photo))
      is(`${f} license`, c.license, 'Unsplash License')
      const buf = fs.readFileSync(path.join(dir, f))
      is(`${f} is a jpeg`, [buf[0], buf[1]], [0xff, 0xd8])
      ok(`${f} is compressed (under 600KB)`, buf.length < 600 * 1024)
    }
    const total = jpgs.reduce((s, f) => s + fs.statSync(path.join(dir, f)).size, 0)
    ok(`the whole folder stays small (${(total / 1048576).toFixed(1)}MB)`, total < 4 * 1048576)
    const notices = fs.readFileSync(path.join(__dirname, '..', 'THIRD-PARTY-NOTICES.md'), 'utf8')
    for (const f of photos) {
      ok(`${f} credited in THIRD-PARTY-NOTICES.md`, notices.includes(credits[f].photographer) && notices.includes(credits[f].photo))
    }
    ok('no em dash in the notices', !notices.includes('\u2014'))

    // the list the picker reads carries the credit, and the retired ids still resolve
    const proc = require('../processor.js')
    const list = proc.backdropList()
    const dune = list.find(b => b.id === 'img:red-dune.jpg')
    is('the list credits a photo', dune && dune.credit && dune.credit.text, 'Photo by Mikk Tõnissoo on Unsplash')
    ok('the credit links the profile with utm', /unsplash\.com\/@themikk\?utm_source=fetch&utm_medium=referral/.test(dune.credit.profile))
    is('a drawn ground has no credit', list.find(b => b.id === 'img:blueprint-grid.jpg').credit, null)
    ok('retired ids are not listed', !list.some(b => /warm-dune|cold-harbour|deep-space/.test(b.id)))
    const warm = proc.imageBackdrops().find(b => b.id === 'img:warm-dune.jpg')
    ok('a saved look naming warm-dune still gets a photograph', !!warm && /amber-dusk\.jpg$/.test(warm.file))
  }

  // ---- no em dash in the module either
  ok('no em dash in ui/unsplash.js', !fs.readFileSync(path.join(__dirname, '..', 'ui', 'unsplash.js'), 'utf8').includes('\u2014'))

  console.log(`${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
})().catch(e => { console.error(e); process.exit(1) })
