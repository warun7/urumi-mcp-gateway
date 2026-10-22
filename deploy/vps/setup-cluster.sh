#!/usr/bin/env bash
# Step 2 of the VPS path. Run from the repo on your machine, with KUBECONFIG pointing at the VPS cluster
# (see bootstrap-node.sh). Idempotent: safe to re-run.
#   ACME_EMAIL=you@example.com ./deploy/vps/setup-cluster.sh      (or set ACME_EMAIL in deploy/vps/.env.prod)
#   TLS=off ./deploy/vps/setup-cluster.sh                          (no domain yet: plain HTTP, no cert-manager)
# Installs cert-manager, the Let's Encrypt issuers, the namespaces (Pod Security + NetworkPolicy labels)
# and the production Secrets. Then: make prod-up DOMAIN=... REGISTRY=...
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$here/.env.prod" ]; then set -a; . "$here/.env.prod"; set +a; fi
TLS="${TLS:-on}"
[ "$TLS" = off ] || ACME_EMAIL="${ACME_EMAIL:?set ACME_EMAIL (the ACME account email), or TLS=off for plain HTTP}"
CERT_MANAGER_VERSION="${CERT_MANAGER_VERSION:-v1.21.1}"

ctx="$(kubectl config current-context)"
echo "Cluster: $ctx ($(kubectl get nodes -o jsonpath='{.items[0].status.nodeInfo.kubeletVersion}'))"
case "$ctx" in k3d-*) echo "  (a local k3d context: fine for a rehearsal, but Let's Encrypt can't reach it)";; esac

if [ "$TLS" = off ]; then
  echo "== TLS=off: skipping cert-manager and the Let's Encrypt issuers (deploy with: make prod-up ... TLS=off)"
else
  echo "== cert-manager $CERT_MANAGER_VERSION"
  helm repo add jetstack https://charts.jetstack.io --force-update >/dev/null
  helm upgrade --install cert-manager jetstack/cert-manager -n cert-manager --create-namespace \
    --version "$CERT_MANAGER_VERSION" --set crds.enabled=true --wait --timeout 5m

  echo "== ClusterIssuers (letsencrypt-staging, letsencrypt-prod)"
  sed "s/ACME_EMAIL/$ACME_EMAIL/" "$here/cluster-issuers.yaml" | kubectl apply -f -
fi

echo "== Namespaces"
kubectl apply -f "$here/../namespaces.yaml"

echo "== Secrets"
"$here/create-secrets.sh"

cat <<'EOF'

Cluster ready. Point DNS at the server (A records):  app.<domain>, shop.<domain>, *.shop.<domain>
Push images (make push REGISTRY=ghcr.io/<you> TAG=0.1.0), then deploy:
  make prod-up DOMAIN=<domain> REGISTRY=ghcr.io/<you> TAG=0.1.0 ISSUER=letsencrypt-staging
and once the staging certificates issue, re-run with ISSUER=letsencrypt-prod.
EOF
