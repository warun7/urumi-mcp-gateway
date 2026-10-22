#!/usr/bin/env bash
# Creates the Secrets the charts expect in production (secrets.existingSecrets=true), in the same formats
# the charts generate locally. Create-if-absent, never overwrite: the KEK, the token pepper and the DB
# passwords must outlive every upgrade (a new KEK can't decrypt stored credentials; a new pepper voids every key).
#
# A value set in deploy/vps/.env.prod (gitignored; see .env.prod.example) is used as given; anything unset
# is generated here and then exists only in the cluster. Values go to kubectl as files, not argv.
#   ./deploy/vps/create-secrets.sh              (platform + the default store)
#   STORE_NS=store-acme ./deploy/vps/create-secrets.sh store
set -euo pipefail
cd "$(dirname "$0")"
if [ -f .env.prod ]; then set -a; . ./.env.prod; set +a; fi
STORE_NS="${STORE_NS:-store-default}"
WHAT="${1:-all}"

# (no `tr </dev/urandom | head`: head closing the pipe is a SIGPIPE, which pipefail turns into an exit)
alnum() { local s=''; while [ ${#s} -lt "$1" ]; do s+=$(openssl rand -base64 64 | LC_ALL=C tr -dc 'A-Za-z0-9'); done; printf '%s' "${s:0:$1}"; }
hex() { openssl rand -hex "$(($1 / 2))"; }

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
# create <namespace> <secret> key=value...
create() {
  local ns=$1 name=$2; shift 2
  if kubectl -n "$ns" get secret "$name" >/dev/null 2>&1; then echo "  = $ns/$name exists, left as is"; return; fi
  local dir="$tmp/$ns.$name" args=() kv
  mkdir -m 700 "$dir"
  for kv in "$@"; do printf '%s' "${kv#*=}" >"$dir/${kv%%=*}"; args+=(--from-file="$dir/${kv%%=*}"); done
  kubectl -n "$ns" create secret generic "$name" "${args[@]}" >/dev/null
  kubectl -n "$ns" label secret "$name" app.kubernetes.io/part-of=urumi >/dev/null
  echo "  + $ns/$name created"
}

if [ "$WHAT" = all ] || [ "$WHAT" = platform ]; then
  echo "platform:"
  create platform gateway \
    "kek-keys=k1:$(openssl rand -base64 32)" \
    "token-pepper=$(alnum 48)" \
    "internal-token=$(alnum 48)" \
    "admin-password=${ADMIN_PASSWORD:-$(alnum 20)}"
  create platform postgres "owner-password=$(alnum 32)" "app-password=$(alnum 32)"
  if [ -n "${LLM_API_KEY:-}" ]; then create platform agent-llm "LLM_API_KEY=$LLM_API_KEY"
  else echo "  ! LLM_API_KEY not set: create platform/agent-llm later, or the hosted LLM will reject the chat agent's calls"; fi
fi

if [ "$WHAT" = all ] || [ "$WHAT" = store ]; then
  echo "$STORE_NS:"
  create "$STORE_NS" mariadb "root-password=$(alnum 32)" "password=$(alnum 32)"
  salts=()
  for k in auth-key secure-auth-key logged-in-key nonce-key auth-salt secure-auth-salt logged-in-salt nonce-salt; do salts+=("$k=$(alnum 64)"); done
  create "$STORE_NS" wordpress "admin-password=${WP_ADMIN_PASSWORD:-$(alnum 20)}" "${salts[@]}"
  create "$STORE_NS" woo-api "consumer-key=ck_$(hex 40)" "consumer-secret=cs_$(hex 40)"
  create "$STORE_NS" woo-mcp-auth "token=$(alnum 48)"
fi

# The gateway seeds the default store as its first upstream, with that store's woo-mcp bearer token. Locally
# the chart copies it with `lookup`; here the script does, so the value never lands in a Helm release record.
if [ "$WHAT" != store ]; then
  if token="$(kubectl -n store-default get secret woo-mcp-auth -o jsonpath='{.data.token}' 2>/dev/null)" && [ -n "$token" ]; then
    echo "platform (the default store's MCP token):"
    create platform bootstrap-upstreams "woo-token=$(printf '%s' "$token" | base64 -d)"
  else
    echo "  ! store-default/woo-mcp-auth not found: run '$0 store' first, then this again"
  fi
fi

echo
echo "Dashboard admin password:  kubectl -n platform get secret gateway -o jsonpath='{.data.admin-password}' | base64 -d"
echo "Back up platform/gateway somewhere safe: without kek-keys the stored upstream credentials can't be decrypted."
