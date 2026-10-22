#!/usr/bin/env bash
# Step 1 of the VPS path. Run ON the server (Ubuntu 24.04 LTS, 2 vCPU / 4 GB is enough for the platform
# and two stores), as root:
#   scp deploy/vps/bootstrap-node.sh root@<vps>:  &&  ssh root@<vps> 'PUBLIC_IP=<vps ip> ADMIN_CIDR=<your ip>/32 bash bootstrap-node.sh'
#
# Installs single-node k3s, the same distribution as the local k3d cluster, so the charts don't change:
# Traefik ingress, local-path storage, the embedded NetworkPolicy controller, and Secrets encrypted at rest.
set -euo pipefail

K3S_VERSION="${K3S_VERSION:-v1.35.5+k3s1}"        # same minor as deploy/k3d/cluster.yaml
PUBLIC_IP="${PUBLIC_IP:?set PUBLIC_IP to the public address of the server}"
ADMIN_CIDR="${ADMIN_CIDR:-}"                       # who may reach the Kubernetes API (6443); empty = nobody from outside

[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }

# k3s: --secrets-encryption = AES-CBC encryption of Secret objects in the datastore (the KEK and the
# token pepper live there). --tls-san so the API certificate is valid for the public IP you'll kubectl against.
curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION="$K3S_VERSION" sh -s - server \
  --secrets-encryption \
  --tls-san "$PUBLIC_IP" \
  --write-kubeconfig-mode 0600

# Firewall: SSH, HTTP (ACME challenges + redirect), HTTPS; the API only from your address.
# Pod and Service CIDRs must be allowed or ufw drops in-cluster traffic (k3s defaults below).
if command -v ufw >/dev/null; then
  ufw allow 22/tcp
  ufw allow 80/tcp
  ufw allow 443/tcp
  [ -n "$ADMIN_CIDR" ] && ufw allow from "$ADMIN_CIDR" to any port 6443 proto tcp
  ufw allow from 10.42.0.0/16 to any
  ufw allow from 10.43.0.0/16 to any
  ufw --force enable
fi

until kubectl get nodes 2>/dev/null | grep -q ' Ready'; do sleep 2; done
kubectl get nodes -o wide

cat <<EOF

k3s is up. Copy the kubeconfig to your machine (it is cluster-admin; keep it out of git):
  ssh root@$PUBLIC_IP 'cat /etc/rancher/k3s/k3s.yaml' | sed 's/127.0.0.1/$PUBLIC_IP/' > ~/.kube/urumi-vps.yaml
  export KUBECONFIG=~/.kube/urumi-vps.yaml
Then, from the repo:  ./deploy/vps/setup-cluster.sh
EOF
