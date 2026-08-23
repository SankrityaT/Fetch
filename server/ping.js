// Anonymous install counter. One HTTP handler, no database to run.
//
// Deploy anywhere that runs a Node/Edge function (Vercel, Netlify, Cloudflare,
// Railway) and point FETCH_METRICS_URL at it when building the app.
//
// Storage is Upstash Redis over REST, which has a free tier and needs no client
// library. Three sets are all the metrics anyone actually needs:
//
//   installs            every install id ever seen        -> total installs
//   dau:YYYY-MM-DD      ids seen that day                 -> daily actives
//   ver                 hash of version -> count          -> which build people run
//
// Storing ids in a set means we can count uniques without ever storing a row per
// person, and there is nothing in here to join against: no IP, no account, no
// filenames. Redis does the counting, we only ever read the cardinality back.

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN

async function redis(cmd) {
  if (!REDIS_URL || !REDIS_TOKEN) return null
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${REDIS_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(cmd),
  })
  return r.ok ? r.json() : null
}

const clean = (s, max) => String(s == null ? '' : s).replace(/[^\w.\-]/g, '').slice(0, max)

module.exports = async function handler(req, res) {
  const send = (code, body) => {
    if (res.status) return res.status(code).json(body)
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (req.method !== 'POST') return send(405, { error: 'POST only' })

  let body = req.body
  if (typeof body === 'string') { try { body = JSON.parse(body) } catch { body = null } }
  if (!body || typeof body !== 'object') return send(400, { error: 'bad body' })

  const id = clean(body.id, 32)
  if (id.length < 16) return send(400, { error: 'bad id' })
  const version = clean(body.v, 16) || 'unknown'
  const day = new Date().toISOString().slice(0, 10)

  // Fire and forget. If the store is down the ping is simply lost, which is the
  // correct outcome: metrics must never be the reason a request looks broken.
  try {
    await Promise.all([
      redis(['SADD', 'installs', id]),
      redis(['SADD', `dau:${day}`, id]),
      redis(['EXPIRE', `dau:${day}`, String(60 * 60 * 24 * 120)]),   // keep 120 days
      redis(['HINCRBY', 'ver', version, '1']),
    ])
  } catch {}

  return send(200, { ok: true })
}
