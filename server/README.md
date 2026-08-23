# Counting installs

Two numbers, two different sources. Neither needs a login and neither touches a
person's recordings.

## Downloads: nothing to build

If the DMG ships as a GitHub Release asset, GitHub already counts every download.
No code, no endpoint, no privacy cost at all:

```bash
./metrics.sh
```

## Active installs: one endpoint

`server/ping.js` is a single handler. The app POSTs `{ id, event, v, os, arch }`
once a day, where `id` is random bytes generated on the machine. There is no
account, no IP logging and nothing to join against.

1. Create a free Upstash Redis database, copy the REST url and token.
2. Deploy `ping.js` anywhere that runs a function. On Vercel, drop it in `api/ping.js`
   and set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`.
3. Build the app with the endpoint set:

```bash
FETCH_METRICS_URL="https://your-domain.com/api/ping" ./build.sh
```

With no `FETCH_METRICS_URL` set at build time the app sends nothing whatsoever,
which is what a fork or a local build should do.

## Reading it back

```bash
# total unique installs
curl -s -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN" \
  "$UPSTASH_REDIS_REST_URL/scard/installs"

# active installs today
curl -s -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN" \
  "$UPSTASH_REDIS_REST_URL/scard/dau:$(date -u +%F)"

# version spread
curl -s -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN" \
  "$UPSTASH_REDIS_REST_URL/hgetall/ver"
```

## What this deliberately does not do

No per-event analytics, no feature tracking, no session recording, no funnels.
Fetch's whole pitch is that your recordings never leave your machine, and a
counter that only knows "an install existed today" keeps that true.
