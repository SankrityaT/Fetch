#!/bin/bash
# Fetch metrics. Downloads come from GitHub, active installs from the ping store.
#   ./metrics.sh
set -uo pipefail
cd "$(dirname "$0")"
REPO="SankrityaT/Fetch"

echo "── downloads ──────────────────────────────────────────"
if command -v gh >/dev/null 2>&1; then
  COUNT=$(gh api "repos/$REPO/releases" --jq 'length' 2>/dev/null || echo 0)
  if [ "$COUNT" = "0" ]; then
    echo "  no releases published yet"
    echo "  publish one:  gh release create v1.0.0 dist/Fetch.dmg --repo $REPO"
  else
    gh api "repos/$REPO/releases" --jq \
      '.[] | "  \(.tag_name)  \(.assets[] | "\(.name)  \(.download_count) downloads")"' 2>/dev/null
    TOTAL=$(gh api "repos/$REPO/releases" --jq '[.[].assets[].download_count] | add // 0' 2>/dev/null)
    echo "  ---"
    echo "  total: $TOTAL"
  fi
else
  echo "  gh not installed"
fi

echo
echo "── active installs ────────────────────────────────────"
if [ -z "${UPSTASH_REDIS_REST_URL:-}" ] || [ -z "${UPSTASH_REDIS_REST_TOKEN:-}" ]; then
  echo "  no store configured (set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN)"
  echo "  see server/README.md"
  exit 0
fi
q() { curl -s -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN" "$UPSTASH_REDIS_REST_URL/$1" | sed 's/.*"result":\([^,}]*\).*/\1/'; }
echo "  installs, all time : $(q "scard/installs")"
echo "  active today       : $(q "scard/dau:$(date -u +%F)")"
echo "  active yesterday   : $(q "scard/dau:$(date -u -v-1d +%F 2>/dev/null || date -u -d yesterday +%F)")"
echo
echo "  last 7 days:"
for i in 0 1 2 3 4 5 6; do
  D=$(date -u -v-${i}d +%F 2>/dev/null || date -u -d "$i days ago" +%F)
  printf "    %s  %s\n" "$D" "$(q "scard/dau:$D")"
done
