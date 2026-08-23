// Tiny Upstash Redis REST client. No SDK, no connection pool, works on Vercel,
// Netlify, Cloudflare and Railway alike because it is just fetch.
//
// Counting uniques with sets means the store holds a set of opaque ids rather than
// a row per person. There is no IP, no user agent and nothing to join against.

const URL_ = process.env.UPSTASH_REDIS_REST_URL
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN

export const configured = () => !!(URL_ && TOKEN)

export async function redis(...cmd) {
  if (!configured()) return null
  try {
    const r = await fetch(URL_, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(cmd),
      cache: 'no-store',
    })
    return r.ok ? await r.json() : null
  } catch { return null }        // metrics must never be why a request fails
}

export const today = () => new Date().toISOString().slice(0, 10)
export const clean = (s, max) => String(s ?? '').replace(/[^\w.\-]/g, '').slice(0, max)
