// GET /api/download - the landing page's download button points here.
//
// Counting server side rather than with an onClick means ad blockers and
// no-JS visitors are still counted, and the number cannot drift from reality:
// every count corresponds to a real redirect that really happened.
//
// Pair this with the GitHub release asset count. Clicks here minus completed
// downloads there is the "started but never finished" gap, which is worth knowing
// when the file is 144MB.
import { redis, today, clean } from '../_lib/store'

export const runtime = 'edge'
export const dynamic = 'force-dynamic'

const DMG_URL = process.env.FETCH_DMG_URL ||
  'https://github.com/SankrityaT/Fetch/releases/latest/download/Fetch.dmg'

export async function GET(req) {
  const day = today()
  // where the click came from, coarse enough to be useful and not identifying
  const ref = clean(new URL(req.url).searchParams.get('ref') || 'direct', 24)

  await Promise.all([
    redis('INCR', 'dl:total'),
    redis('INCR', `dl:${day}`),
    redis('EXPIRE', `dl:${day}`, String(60 * 60 * 24 * 120)),
    redis('HINCRBY', 'dl:ref', ref, '1'),
  ])

  // Response.redirect() returns a response whose headers are immutable, and
  // Next's route handler tries to write to them, which throws TypeError:
  // immutable and turns the download button into a 500. Building the redirect
  // by hand keeps the headers mutable.
  return new Response(null, { status: 302, headers: { Location: DMG_URL } })
}
