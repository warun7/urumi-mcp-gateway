#!/usr/bin/env bash
# Rotates the gateway's key-encryption key (KEK) with no downtime and no Helm values involved.
# The FIRST entry of the gateway Secret's kek-keys seals new upstream credentials; other entries only open old ones.
#   1. append the new key       -> every pod can open what the new key will seal
#   2. move it to the front     -> new pods seal with it, and re-seal old rows at startup (gateway bootstrap)
#   3. drop the old key, once no row still uses it
# Each step is a rolling restart of the gateway. Works the same on k3d and on the VPS.
#   scripts/rotate-kek.sh [new-kid]        (make rotate-kek)
set -euo pipefail
NS="${NS:-platform}"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

keys() { kubectl -n "$NS" get secret gateway -o jsonpath='{.data.kek-keys}' | base64 -d; }
put() { # the key material goes through a file, not argv
  printf '{"data":{"kek-keys":"%s"}}' "$(printf '%s' "$1" | base64 | tr -d '\n')" >"$tmp/patch.json"
  kubectl -n "$NS" patch secret gateway --type merge --patch-file "$tmp/patch.json" >/dev/null
}
roll() { kubectl -n "$NS" rollout restart deploy/gateway >/dev/null && kubectl -n "$NS" rollout status deploy/gateway --timeout=5m; }
psql() { kubectl -n "$NS" exec -i sts/postgres -- sh -c 'psql -U "$POSTGRES_USER" -d "${POSTGRES_DB:-urumi}" -At'; }
using() { echo "SELECT count(*) FROM upstreams WHERE credential_kid = '$1'" | psql; }

current="$(keys)"
case "$current" in *,*) echo "kek-keys already holds several keys (an unfinished rotation?): finish or fix it first" >&2; exit 1;; esac
old_kid="${current%%:*}"
if [ -n "${1:-}" ]; then new_kid="$1"
elif [[ "$old_kid" =~ ^k([0-9]+)$ ]]; then new_kid="k$((BASH_REMATCH[1] + 1))"
else echo "usage: $0 <new-kid>" >&2; exit 1; fi
[[ "$new_kid" =~ ^[A-Za-z0-9_-]+$ && "$new_kid" != "$old_kid" ]] || { echo "bad kid: $new_kid" >&2; exit 1; }
new="$new_kid:$(openssl rand -base64 32)"

echo "Rotating $old_kid -> $new_kid ($(using "$old_kid") credentials sealed under $old_kid)"
echo "== 1/3 add $new_kid (still sealing with $old_kid)"
put "$current,$new"; roll
echo "== 2/3 seal with $new_kid; pods re-seal old rows as they start"
put "$new,$current"; roll
left="$(using "$old_kid")"
if [ "$left" != 0 ]; then
  echo "$left credentials still sealed under $old_kid: kept both keys. Check the gateway logs ('cannot re-seal')." >&2; exit 1
fi
echo "== 3/3 drop $old_kid"
put "$new"; roll
echo "SELECT slug, credential_kid, status FROM upstreams WHERE credential_kid IS NOT NULL ORDER BY slug" | psql | column -t -s'|'
echo "Done. Back up the new platform/gateway Secret: the old key is gone from the cluster."
