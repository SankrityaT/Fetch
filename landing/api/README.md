# Metrics on the landing page

Drop these three files into the Next.js app and the whole funnel is covered by one
deployment. No separate service, no extra host.

```
app/api/_lib/store.js       shared Upstash helper
app/api/ping/route.js       the desktop app counting itself
app/api/download/route.js   the download button, counted then redirected
```

They are `.js` on purpose: a Next.js project written in TypeScript accepts `route.js`
files unchanged, so this works either way without edits.

## Setup

1. Create a free Upstash Redis database and set two env vars on the site:
   `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`.
2. Optionally set `FETCH_DMG_URL` if the DMG is not on GitHub Releases.
3. Point the landing page's download button at the endpoint, not at the file:

```html
<a href="/api/download?ref=hero">Download for Mac</a>
<a href="/api/download?ref=footer">Download</a>
<a href="/api/download?ref=producthunt">Download</a>
```

The `ref` is just a label so you can see which button people actually press. It is
capped at 24 characters and stripped to word characters, so nothing arbitrary lands
in the store.

4. Build the desktop app pointing at the same site:

```bash
FETCH_METRICS_URL="https://your-domain.com/api/ping" ./build.sh
```

## The funnel this gives you

| number | key | meaning |
|---|---|---|
| download clicks | `dl:total` | pressed the button |
| clicks today | `dl:YYYY-MM-DD` | daily interest |
| by button | `dl:ref` | which placement converts |
| completed downloads | GitHub release asset | actually finished the 144MB file |
| installs | `installs` | opened the app at least once |
| active today | `dau:YYYY-MM-DD` | opened it today |
| versions | `ver` | who is on the old build |

Clicks minus completed downloads is the abandoned-download gap. Completed downloads
minus installs is the "downloaded but never opened" gap, which for a notarised DMG is
usually Gatekeeper friction. Both are worth watching in the first 48 hours.

Read any of it with `./metrics.sh` from the app repo.

## Why counting happens on the server

An `onClick` handler misses ad blockers, no-JS visitors and anyone who middle-clicks.
A redirect route counts the request itself, so every number corresponds to a redirect
that actually happened. It also means the download button keeps working if the
metrics store is down: the store call is wrapped and failure still redirects.

## What is deliberately not here

No IP logging, no user agent fingerprinting, no cookies, no session ids, no per-event
analytics. Fetch's pitch is that recordings never leave the machine, and these counters
only ever know that an anonymous install existed on a given day.
