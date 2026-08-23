// POST /api/ping - the desktop app counting itself, once a day.
//
// Body: { id, event, v, os, arch }. `id` is random bytes generated on the machine,
// not derived from hardware. No account, no IP logging, no filenames, nothing about
// what was recorded.
import { redis, today, clean } from '../_lib/store'

export const runtime = 'edge'
export const dynamic = 'force-dynamic'

export async function POST(req) {
  let body
  try { body = await req.json() } catch { return Response.json({ error: 'bad body' }, { status: 400 }) }

  const id = clean(body?.id, 32)
  if (id.length < 16) return Response.json({ error: 'bad id' }, { status: 400 })
  const v = clean(body?.v, 16) || 'unknown'
  const day = today()

  await Promise.all([
    redis('SADD', 'installs', id),                                   // unique installs, all time
    redis('SADD', `dau:${day}`, id),                                 // unique actives today
    redis('EXPIRE', `dau:${day}`, String(60 * 60 * 24 * 120)),       // keep four months
    redis('HINCRBY', 'ver', v, '1'),                                 // which build people run
  ])
  return Response.json({ ok: true })
}
