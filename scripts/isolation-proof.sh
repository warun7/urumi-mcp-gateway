#!/usr/bin/env bash
# Shows where isolation is enforced, by trying the connections that must fail (and the ones that must work).
# Probes are raw TCP connects made with the pod's own `node`, so "blocked" means NetworkPolicy dropped the
# connection, not that an HTTP redirect or an app-level 401 got in the way.
#   scripts/isolation-proof.sh [store-a] [store-b]
# With no arguments: the default store, plus the first store created from the dashboard if there is one.
# On a fresh cluster (one store) the store-to-store probes are skipped; create a second store to include them.
set -euo pipefail
A="${1:-default}"
B="${2:-$(kubectl get ns -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' | sed -n 's/^store-//p' | grep -vx "$A" | head -1 || true)}"
for s in "$A" ${B:+"$B"}; do
  kubectl get ns "store-$s" >/dev/null 2>&1 || { echo "no namespace store-$s: create the store from the dashboard, or pass store names that exist" >&2; exit 1; }
done
lbl() { if [ "$1" = default ]; then echo "the default store's"; else echo "store $1's"; fi; }

# Each target is "label|host|port|expect" with expect = open or blocked. Prints one line per target; exits non-zero on a mismatch.
JS='
const net = require("net");
const probe = (host, port) => new Promise((done) => {
  const s = net.connect({ host, port, timeout: 2500 });
  s.on("connect", () => { s.destroy(); done("open"); });
  s.on("timeout", () => { s.destroy(); done("blocked (timeout)"); });
  s.on("error", (e) => done(e.code === "ENOTFOUND" ? "no such host" : `blocked (${e.code})`));
});
(async () => {
  let bad = 0;
  const rows = await Promise.all(process.argv.slice(1).map(async (t) => {
    const [label, host, port, expect] = t.split("|");
    const got = await probe(host, Number(port));
    const ok = expect === "open" ? got === "open" : got.startsWith("blocked");
    if (!ok) bad++;
    return `  ${ok ? "✔" : "✘"} ${label.padEnd(52)} ${got}`;
  }));
  console.log(rows.join("\n"));
  process.exit(bad ? 1 : 0);
})();'

fail=0
from() { # from <namespace> <label selector> <title> <targets...>
  local ns=$1 sel=$2 title=$3; shift 3
  local pod; pod="$(kubectl -n "$ns" get pod -l "$sel" --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}')"
  echo; echo "From $title ($ns/$pod):"
  kubectl -n "$ns" exec -q "$pod" -- node -e "$JS" "$@" || fail=1
}
svc() { printf '%s.%s.svc.cluster.local' "$1" "$2"; }

echo "Public entry points (every Ingress rule in the cluster):"
kubectl get ingress -A -o jsonpath='{range .items[*]}{range .spec.rules[*]}{.host}{"\t"}{range .http.paths[*]}{.path}{" -> "}{.backend.service.name}{":"}{.backend.service.port.number}{.backend.service.port.name}{"  "}{end}{"\n"}{end}{end}' \
  | sed 's/^/  /'
if kubectl get ingress -A -o jsonpath='{..backend.service.name}' | tr ' ' '\n' | grep -qxE 'woo-mcp|mariadb|postgres|gateway-internal|agent|mcp-fetch'; then
  echo "  ✘ an internal service has an Ingress"; fail=1
else
  echo "  ✔ no Ingress for woo-mcp, MariaDB, Postgres, the agent, mcp-fetch or the gateway's internal port"
fi

cross=()
if [ -n "$B" ]; then
  cross=(
    "$(lbl "$B") WordPress|$(svc wordpress "store-$B")|8080|blocked"
    "$(lbl "$B") MariaDB|$(svc mariadb "store-$B")|3306|blocked"
    "$(lbl "$B") woo-mcp|$(svc woo-mcp "store-$B")|8080|blocked"
  )
fi
from "store-$A" app.kubernetes.io/name=woo-mcp "$(lbl "$A") woo-mcp (what a compromised MCP server could reach)" \
  "its own WordPress (the REST API it uses)|$(svc wordpress "store-$A")|8080|open" \
  "its own MariaDB (it only needs the REST API)|$(svc mariadb "store-$A")|3306|blocked" \
  ${cross[@]+"${cross[@]}"} \
  "the platform's Postgres|$(svc postgres platform)|5432|blocked" \
  "the gateway's internal port (store registration)|$(svc gateway-internal platform)|8081|blocked" \
  "the internet (1.1.1.1:443)|1.1.1.1|443|blocked"

from mcp-servers app.kubernetes.io/instance=testkit-evil "a third-party MCP server (the 'evil' test server)" \
  "the default store's woo-mcp|$(svc woo-mcp store-default)|8080|blocked" \
  "the default store's WordPress|$(svc wordpress store-default)|8080|blocked" \
  "the platform's Postgres|$(svc postgres platform)|5432|blocked" \
  "the gateway's internal port|$(svc gateway-internal platform)|8081|blocked"

gw=("the default store's woo-mcp|$(svc woo-mcp store-default)|8080|open")
for s in "$A" ${B:+"$B"}; do
  [ "$s" = default ] || gw+=("store $s's woo-mcp|$(svc woo-mcp "store-$s")|8080|open")
done
gw+=(
  "$(lbl "$A") MariaDB|$(svc mariadb "store-$A")|3306|blocked"
  "$(lbl "$A") WordPress (only woo-mcp talks to it)|$(svc wordpress "store-$A")|8080|blocked"
)
from platform app.kubernetes.io/name=gateway "the gateway (the only client woo-mcp accepts)" "${gw[@]}"

echo
[ -n "$B" ] || echo "Store-to-store probes skipped: only one store exists. Create a store in the dashboard (Stores) and re-run to include them."
if [ $fail -eq 0 ]; then echo "All isolation checks passed."; else
  echo "Some isolation checks FAILED (see ✘ above)." >&2
  # Seen after a Docker restart: the policies exist but k3s's policy controller never started, so nothing is blocked.
  echo "If every 'blocked' path shows open, check that k3s started its NetworkPolicy controller since the last boot" >&2
  echo "(log line 'Starting network policy controller'). k3d: k3d cluster stop urumi && k3d cluster start urumi; VPS: sudo systemctl restart k3s" >&2
fi
exit $fail
