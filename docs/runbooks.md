# Runbooks

Operating procedures. Each one says how it was verified. The commands work on k3d and the VPS alike, because only the kubeconfig and the values file differ.

| Task | Command |
|---|---|
| Upgrade the gateway, agent or dashboard | `helm upgrade platform …` with the new image tag |
| Upgrade the default store (WordPress, WooCommerce, woo-mcp) | `helm upgrade store-default …` with the new image tags |
| Upgrade every provisioned store | Ship a provisioner image with a bumped store chart version |
| Roll back a release | `helm rollback <release> <revision>` |
| Undo a database migration | `scripts/restore-store.sh <namespace> <dump>` |
| Rotate the credential-encryption key | `make rotate-kek` |
| Rotate a store's WooCommerce API key | Edit Secret `woo-api`, then `helm upgrade` the store |
| Switch the chat to a real model | `make chat-llm` |
| Scale the gateway | `gateway.replicas: N` |

---

## Upgrades

**Every `helm upgrade` here uses `--rollback-on-failure --wait`** (Helm 4's name for `--atomic`): if the new revision isn't healthy before the timeout, Helm puts the previous one back by itself.

### Platform (gateway, agent, dashboard, fetch, provisioner)

```bash
# VPS: push the new images, then re-run prod-up with the new tag
make push REGISTRY=ghcr.io/you TAG=0.2.0
make prod-up DOMAIN=example.com REGISTRY=ghcr.io/you TAG=0.2.0 ISSUER=letsencrypt-prod
# local: rebuild and roll one service
make restart-gateway
```

What happens during a gateway upgrade:
1. **Migrations first.** The gateway's initContainer runs pending SQL migrations as the schema owner, under an advisory lock. Two pods starting together don't race, and the second one finds the work done.
2. **No capacity lost.** The rolling update is `maxSurge: 1, maxUnavailable: 0`, so the old pods serve until the new ones are Ready. A pod is Ready when the DB is reachable and the schema is current.
3. **A newer schema doesn't kill the old code.** Migrations are additive (new tables, columns and sequences), so pods still running the previous version keep working mid-rollout. A pod whose schema is *behind* refuses to start (`database schema is behind this version`) rather than run against the wrong tables.
4. **Production has a PodDisruptionBudget.** It keeps one gateway up during node drains.

**Verified:** a broken upgrade (`--set images.gateway.tag=does-not-exist`) went `ImagePullBackOff` → timeout → *rolled back automatically*. A probe hitting `/mcp` every 200 ms throughout got **762 of 762 answers, with zero downtime**, because the two old pods were never taken out.

```
REVISION  STATUS      DESCRIPTION
9         superseded  Upgrade complete
10        failed      Upgrade "platform" failed: resource Deployment/platform/gateway not ready…
11        deployed    Rollback to 9
```

### Store (WordPress, WooCommerce, woo-mcp)

The WooCommerce version is part of the image (`images/wordpress/Dockerfile` args). An upgrade is a new tag:

```bash
docker build -t urumi/wordpress:wc-11.3 --build-arg WOOCOMMERCE_VERSION=11.3.0 images/wordpress   # local; VPS: make push
helm upgrade store-default charts/store -n store-default -f charts/store/values-local.yaml \
  --set images.wordpress.tag=wc-11.3 --rollback-on-failure --wait --timeout 10m
```

Hooks, in order:
1. **Pre-upgrade backup Job.** `mariadb-dump --single-transaction` to `backups/` on the MariaDB volume. The newest 5 dumps are kept, and each is verified to end with the dump's completion marker.
   - **If the backup fails, the hook fails, and Helm stops the upgrade and rolls back. No backup, no upgrade.**
2. **New pods.** WordPress uses `Recreate` (the uploads volume is ReadWriteOnce), so the storefront is down for the seconds the new pod takes to become Ready. woo-mcp rolls normally.
3. **Post-upgrade setup Job.** Runs `wp core update-db` and `wp wc update` (WooCommerce's DB migrations), and re-applies settings idempotently.

**Verified, the hard way.** Testing the restore path showed the backup hook had **never produced a usable dump**:
- The `mariadb` client reads `MYSQL_PWD`, not `MARIADB_PWD`, so the hook connected without a password.
- Without `pipefail`, `gzip` turned the failure into a 4 KB "success".

After the fix, the next upgrade's first attempt hit the safeguard working as intended: the backup failed, so revision 3 failed and was rolled back. The following upgrade wrote a complete 56 KB dump.

### Every provisioned store at once

The store chart ships **inside the provisioner image**. Bump `charts/store/Chart.yaml`'s `version`, build and roll the provisioner. Each store's `status.releaseHash` (chart version + values) then no longer matches, so the provisioner upgrades the stores one reconcile at a time. Each one gets its own pre-upgrade backup.

```bash
make image-provisioner && k3d image import -c urumi urumi/provisioner:dev && kubectl -n platform rollout restart deploy/provisioner
kubectl -n platform get stores -w
```

**Verified, including a failure the provisioner now handles by itself.** Chart 0.1.0 → 0.1.1 failed on `acme` and `initech` with `StatefulSet.apps "mariadb" is invalid: spec: Forbidden: updates to statefulset spec…`:
- The MariaDB `volumeClaimTemplates` carried the `helm.sh/chart` label, and Kubernetes never lets a StatefulSet's claim templates change. So every chart version bump was an illegal update.
- **Fix in the chart (0.1.2):** the claim templates carry only labels that never change (`store.stableLabels`).
- **Fix in the provisioner:** when Helm reports that error, it deletes the StatefulSet with `propagationPolicy: Orphan`. The pod and its volume stay, Helm recreates the StatefulSet, and the new one adopts them. It does this once per store and release hash, and sets the condition `RecreatingStatefulSet`.
- **No uninstall of a live store.** Before, a failed upgrade was retried by uninstalling the release, which would have deleted the uploads volume. Now a release that was ever deployed is retried in place, and the uploads PVC also has `helm.sh/resource-policy: keep`.

With both fixes, `acme` and `initech` went to 0.1.2 with no manual step (about 38 s each), and their products were all still there.

## Rollback

```bash
helm history platform -n platform
helm rollback platform <revision> -n platform --wait
```

**This reverts manifests, config and image tags. It doesn't touch data.** Config changes roll the pods automatically, because the checksum annotations change.

**Verified:** `gateway.rateLimitPerMinute` 120 → 60 (revision 12), then `helm rollback` → 120 (revision 13), with the gateway pods rolled.

### When the upgrade migrated the database

**Platform.** Gateway migrations are additive, so the previous version runs fine on the newer schema. Roll back with Helm and leave the schema alone.

**Store.** WooCommerce's own migrations aren't guaranteed reversible. Roll back the release, *then* restore the dump the hook took just before the upgrade:

```bash
helm rollback store-default <previous-revision> -n store-default --wait
scripts/restore-store.sh store-default                              # list dumps, newest first, with "complete" or "INCOMPLETE"
scripts/restore-store.sh store-default wordpress-20261010T151818Z.sql.gz
```

The script:
1. stops WordPress, so there are no writes during the restore;
2. runs a one-off pod under the namespace's restricted policy, labelled so the NetworkPolicy lets it reach MariaDB;
3. refuses an incomplete dump, restores, and starts WordPress again.

Orders placed between the backup and the restore are lost, so restore the newest complete dump and export recent orders first if they matter.

**Verified:** created a "Restore Canary" product after the dump, restored, and the canary was gone. The storefront and the woo tools came back.

## Rotate the credential-encryption key (KEK)

Upstream credentials are sealed with AES-256-GCM under a key in the `platform/gateway` Secret (`kek-keys`). The **first** entry seals new credentials; others only open old ones.

```bash
make rotate-kek          # scripts/rotate-kek.sh [new-kid]
```

It does three steps, each a rolling restart, so no pod ever meets a credential it can't open:

| Step | Secret | Effect |
|---|---|---|
| 1 | `k1:…,k2:…` | Every pod can open what k2 will seal. Nothing is sealed with k2 yet. |
| 2 | `k2:…,k1:…` | New pods seal with k2 and **re-seal every k1 credential at startup** |
| 3 | `k2:…` | Done only if no row still uses k1; otherwise it stops and keeps both keys |

**Back up the new Secret afterwards**: without it, the stored credentials can't be decrypted.

**Verified:** k1 → k2 on the live cluster. 4 credentialed upstreams were re-sealed and reconnected with k2 alone.

**Other secrets:**
- **Token pepper.** Rotating it invalidates every API key and token, so treat it as "re-issue everything".
- **Postgres passwords.** Change the role password and the Secret together, then roll the gateway.
- **Store WooCommerce key.** Edit `woo-api`, then `helm upgrade` the store. The setup Job writes the new key into WooCommerce and woo-mcp rolls.
- **woo-mcp bearer.** Edit `woo-mcp-auth`, then upgrade the store and the platform. For the default store, the platform chart copies the token locally; in production, also update `platform/bootstrap-upstreams` (key `woo-token`). The gateway re-syncs it on start. For provisioned stores, the provisioner re-registers it.

## Backups

| Data | How | Where |
|---|---|---|
| Store DB | Pre-upgrade hook (automatic), or run the hook's Job on a schedule | `backups/` on the MariaDB PVC (5 newest) |
| Store uploads | PVC `wordpress-uploads` (kept by `helm uninstall`: `resource-policy: keep`) | Snapshot the volume |
| Platform DB (users, keys, servers, audit) | `kubectl -n platform exec sts/postgres -- sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' \| gzip > platform.sql.gz` | Off-cluster |
| Secrets | `kubectl get secret -n platform gateway postgres -o yaml` | Somewhere safe, encrypted |

On-node backups are lost with the node. Production should copy them off-site (S3, restic) with a CronJob. That's not implemented here.

## Switch the chat to a real model

```bash
make chat-llm                                                      # OpenAI, gpt-4.1-mini; prompts for the key
make chat-llm LLM_BASE_URL=https://api.groq.com/openai/v1 LLM_MODEL=<model>   # any OpenAI-compatible API
make chat-scripted                                                 # back to the free deterministic model
```

The key goes into Secret `platform/agent-llm` (from a prompt, not argv). The non-secret settings go into the gitignored `.dev/values-llm.yaml`, which later `make platform` runs keep using.

The agent's NetworkPolicy opens public-internet egress only when the provider isn't `scripted`. A model on a private address (Ollama on the host, for example) needs an extra egress rule.

On the VPS, the same values live in `values-prod.yaml` (`agent.llm`), and the key comes from `deploy/vps/.env.prod` through `create-secrets.sh`.

## Scale the gateway

Set `gateway.replicas` (local default 2, production 2). Nothing else changes:
- Any replica serves any `/mcp` request.
- One replica is elected leader for health checks and tool syncs. Leadership moves if it dies (Postgres advisory lock).
- Admin changes reach every replica through LISTEN/NOTIFY. A per-request epoch check makes them visible to the very next request on any replica.
- Rate limits are per replica, so the effective limit is N × `gateway.rateLimitPerMinute`.

**Verified:** all six e2e suites (137 checks on a fresh cluster) pass against 2 replicas.

## Troubleshooting

| Symptom | Look at |
|---|---|
| A server shows Unreachable | The reason on the server card: `CONNECTION_REFUSED`, `AUTH_REJECTED`, `NOT_MCP`, `DNS_FAILURE`, `TLS_ERROR`, `SSRF_BLOCKED` or `TIMEOUT`. Then `kubectl -n platform logs deploy/gateway \| grep <slug>`. |
| A tool vanished after an upstream upgrade | Its definition changed: Servers → the server → **Review**. Platform-owned servers (`woo`, stores) are auto-approved. |
| Store stuck Provisioning | `kubectl -n platform get store <name> -o yaml`: the conditions say which of the 7 steps it's on, and failures carry a reason (`SetupJobFailed` with log lines, `ImagePullFailed`, `QuotaExceeded`, …) |
| Certificate not issuing (VPS) | `kubectl get certificate,challenge -A` and `kubectl describe challenge -A`. Check that DNS points at the server and port 80 is open. The `acme-http01-solver` NetworkPolicy must exist in that namespace. |
| Store upgrade fails with `updates to statefulset spec … Forbidden` | A StatefulSet field that can't change did change (claim templates). The provisioner handles this for provisioned stores. For `store-default`, run `kubectl -n store-default delete sts mariadb --cascade=orphan` (the pod and data stay), then re-run `make store`. |
| `make isolation` shows every "blocked" path as open | The NetworkPolicies exist, but k3s's policy controller didn't start on the last boot (seen once after Docker restarted). `docker logs k3d-urumi-server-0 2>&1 \| grep 'Starting network policy controller'` should show a line after the node's last start. Fix: `k3d cluster stop urumi && k3d cluster start urumi` (VPS: `sudo systemctl restart k3s`), then re-run `make isolation`. Always re-run it after any node restart. |
| Chat says the model failed | `kubectl -n platform logs deploy/agent`, the Secret `agent-llm`, and the provider's base URL and model name |
| Metrics | `kubectl -n platform port-forward deploy/gateway 8081` → `curl localhost:8081/metrics`. Includes `mcp_tool_calls_total{server,outcome,via}`, `mcp_tool_call_duration_seconds`, `mcp_upstream_up`, `gateway_auth_failures_total`. |
