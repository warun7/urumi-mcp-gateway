# Stand-outs and bonus: what was built, where, and how to see it

The brief lists nine "ways to stand out" plus a bonus. Eight of the nine are done, as is the bonus. **Hosted MCP servers (#5) were not attempted.** Each entry below says where the code lives and how to see it working. The decision numbers (D*n*) point at the reasoning in [BUILD_LOG.md](BUILD_LOG.md).

| # | Item | Status | Proof |
|---|---|---|---|
| Bonus | Multi-store provisioning | ✅ | `store-flow` e2e, `make isolation` |
| 3 | OAuth on the gateway | ✅ | `oauth-flow` e2e (over HTTP and HTTPS) |
| 4 | Handling many tools | ✅ | `eval/RESULTS.md`, a CI floor on the scores |
| 2 | Tool permissions | ✅ | `gateway-flow` and `dod-flow` e2e |
| 6 | Security hardening | ✅ | `make isolation`, the RBAC impersonation tests (D66), `resilience-flow` |
| 7 | Scaling | ✅ | the full e2e on 2 gateway replicas; the rate-limit e2e |
| 9 | Upgrades and rollback | ✅ | [runbooks.md](runbooks.md): a broken upgrade was rolled back with 762/762 requests answered; a restore was verified |
| 1 | VPS deployment with TLS | ◑ scripted and rehearsed | `make tls-local` runs the same path on k3d; not yet run on a public server |
| 8 | Observability | ✅ light | `/metrics`, status reasons, live audit, p50/p95 per server |
| 5 | Hosted MCP servers | ✗ | not attempted |

---

## Bonus: multi-store provisioning

**What it does.**
1. **Dashboard → Stores → New store** creates a `Store` custom resource.
2. A separate controller turns it into a namespace with its own guardrails, Secrets, MariaDB, WordPress, woo-mcp and Ingress host. It installs them with the same `charts/store` chart that runs the default store.
3. It registers the store's MCP server with the gateway, so its tools appear as `<store>__list_orders` and so on.
4. Deleting the store deregisters it and removes the namespace, which takes the volumes, Secrets and Helm release with it.

**Where:**
- [`apps/provisioner`](../apps/provisioner): the controller. `queue.ts` has client-go queue semantics, `reconcile.ts` the 7 steps, and `diagnose.ts` the failure reasons.
- [`charts/platform/templates/stores.yaml`](../charts/platform/templates/stores.yaml): the CRD (with CEL validation), RBAC and the ValidatingAdmissionPolicy.
- `apps/gateway/src/api/stores.ts`: the dashboard API and limits.

**Requirement by requirement:**
- **Create and delete from the dashboard, several at once.** The provisioner runs reconciles with concurrency 3. Two stores requested together were Ready in 26 to 36 s.
- **Kubernetes-native.** Helm, one namespace per store, its own database, Secrets, PVCs and Ingress host.
- **Automatic registration.** It uses the gateway's internal port, which NetworkPolicy opens only to the provisioner. Tool names carry the store's name.
- **Clean teardown.** The store's tools vanish in about 2 s, and the namespace, PVs and release are gone in about 36 s. Audit rows are kept on purpose.
- **Isolation.** `make isolation` makes TCP probes from inside a store's woo-mcp:
  - its own WordPress is reachable;
  - its own MariaDB, any other store, Postgres, the gateway's internal port and the internet are not.
- **Guardrails.**
  - A ResourceQuota and LimitRange in each namespace, applied *before* any workload. The store's own values can't loosen them.
  - At most 2 stores per member, 5 per admin and 4 for the whole platform, checked under an advisory lock so concurrent clicks can't overshoot.
  - A 12-minute provisioning timeout that names the step it was stuck on.
- **Recovery.**
  - Creating a store is idempotent.
  - If the provisioner is killed mid-install, the store still completes (bug 1 in Step 7 of the build log: Helm 4 marks a cancelled release `failed`, and that case is now recognised).
  - Failures carry a reason: `SetupJobFailed` with log lines, `ImagePullFailed`, `QuotaExceeded`, `NamespaceConflict`, and others.
  - A failed upgrade of a live store is retried in place, never by uninstalling it (D99).
- **Least privilege despite Helm (D66).**
  - The provisioner's powerful ClusterRole is never bound cluster-wide; it binds it to itself per `store-*` namespace.
  - A ValidatingAdmissionPolicy enforces that rule.
  - Verified by impersonating its ServiceAccount: it can't read platform Secrets or bind cluster-admin.
- **The internet-facing gateway holds no cluster power.** It can only create and delete `Store` objects in its own namespace (D64).

**The brief's test:** "Compare today's sales across all stores" in the chat calls `sales_summary` on every store. Then delete one store and its tools and namespace are gone. `e2e/scripts/store-flow.ts` automates it.

---

## 3. OAuth on the gateway (MCP authorization spec)

**What it does.** A client that supports MCP OAuth connects with only the URL:
1. `401` with `WWW-Authenticate`.
2. Protected Resource Metadata, then Authorization Server metadata.
3. Client registration, by either method:
   - **Client ID Metadata Documents** (CIMD: the client's URL is its id);
   - **Dynamic Client Registration**.
4. Browser sign-in and consent in the dashboard.
5. Code exchange with **PKCE (S256 only)**.
6. Tokens.

**Security properties:**
- **Audience binding.** `resource` (RFC 8707) is required and must be this gateway's `/mcp`.
- `iss` is returned with the authorization code (RFC 9207), against mix-up attacks.
- A redirect URI must match exactly; a bad one is never redirected to.
- Codes are single-use. **Replaying a code revokes the whole grant.**
- **Refresh tokens rotate, and reusing an old one revokes the whole family.**
- Tokens are opaque and stored hashed, so revocation is immediate (no JWT expiry window).
- The consent page shows the client's name, its redirect host and a verified or unverified badge, against OAuth phishing (threat model Q4).
- Grants are listed under **Connected apps** and can be revoked there.
- Tokens are **never passed through** to upstreams (threat model Q2).

**Where:** `apps/gateway/src/auth/oauth/` (`server.ts`, `clients.ts`, `tokens.ts`), `apps/dashboard/src/pages/Consent.tsx` and `Apps.tsx`.

**Proof.** [`e2e/scripts/oauth-flow.ts`](../e2e/scripts/oauth-flow.ts) runs the discovery chain, DCR, PKCE enforcement, a wrong `resource`, a bad redirect, code replay, refresh rotation and reuse, and an MCP call audited with `auth_method=oauth`. It passed over plain HTTP and over HTTPS (`make tls-local`).

---

## 4. Handling many tools

**What it does.** Each API key or OAuth grant has a tool mode:
- `full`: every permitted tool.
- `search`: three meta-tools, `gateway__list_servers`, `gateway__search_tools` and `gateway__call_tool`.
- `auto`: full under 60 tools, search above. This is the default for OAuth and chat.

**How search works:**
- It runs **after** the permission filter, so a member never discovers a tool they can't call.
- Ranking is BM25 over stemmed words, plus an **action-aware re-rank**:
  - the tool's verb is read from its name, and the query's intent from its action words;
  - reads come before writes and deletes come last;
  - past-tense questions aren't write requests, and "how much" questions prefer summary tools.
- The chat agent turns found tools into real function definitions for its next turn (dynamic tool loading).

**Measured, not claimed.** [`eval/`](../eval/RESULTS.md) has 102 tasks over a live catalog of 325 tools: 3 stores, fetch, the test servers and a 288-tool synthetic SaaS farm.

| | hit@1 | hit@5 | MRR |
|---|---|---|---|
| gateway search, dev | 69% | 81% | 0.74 |
| gateway search, held-out | 63% | 89% | 0.73 |
| keyword baseline, held-out | 43% | 83% | 0.55 |

**Size and speed:**
- The standing tool context shrinks **101×**, from about 40k tokens to about 400.
- Search latency through the full MCP path is p50 4 ms.
- The held-out set was written before tuning and only read in aggregate (D84).
- `apps/gateway/test/search-eval.test.ts` fails CI if either score drops below its floor.

**Where:** `apps/gateway/src/mcp/search.ts`, `router.ts` (the meta-tools), `apps/agent/src/agent.ts` (dynamic loading), `eval/`.

---

## 2. Tool permissions

- **Defaults.** Admins get everything. Members get tools classified `read`. Rules then allow or deny per role or per user, by server or by tool, and **deny wins**.
- **Restricted tools are hidden and refused.** They are absent from `tools/list` and from search. A direct call gets "Unknown tool", the same as a tool that doesn't exist, and is audited as `denied`.
- A tool is `read` only if it declares the MCP annotation `readOnlyHint: true`; everything else is `write`, the safe default. An admin can override the classification in the server's tools table.
- The dashboard shows an **effective access** view per member.

**Where:** `apps/gateway/src/policy/permissions.ts`, `apps/gateway/src/api/permissions.ts`, `apps/dashboard/src/pages/Permissions.tsx`.

**Proof:** `gateway-flow` and `dod-flow`. Member B sees `woo__list_orders` but not `woo__create_product`, and a direct call is denied and audited.

---

## 6. Security hardening

| The brief asks for | Done as |
|---|---|
| SSRF protection | URLs are classified at registration, then **re-checked at connect time against the resolved IP**, which defeats DNS rebinding. Redirects are refused. Private, link-local and metadata ranges are blocked. In-cluster servers are allowed only for hostname globs set by the operator, and store hostnames only for the provisioner. (`mcp/upstream/ssrf.ts`) |
| Least-privilege RBAC | The gateway may only touch `Store` objects. The provisioner's rights are bound per namespace and fenced by a ValidatingAdmissionPolicy (D66). No other pod gets a ServiceAccount token. |
| Default-deny NetworkPolicies, non-root | Every namespace denies in both directions by default, with explicit allows. Pod Security `restricted` is **enforced** on every namespace: non-root, read-only root filesystems, no capabilities, seccomp. `make isolation` proves the policies. |
| Credentials encrypted at rest | AES-256-GCM, with the row id as additional data so a ciphertext can't be moved to another row. Real **key rotation**: `make rotate-kek` runs three phases and re-seals at startup, with no downtime (D92). Secrets are also encrypted in the k3s datastore. |

**Beyond the list:**
- **Tool-poisoning defences.** Invisible characters are stripped and lengths capped. Suspicious descriptions are **quarantined** until an admin reviews them, and the review drawer explains why. The `evil` test server exercises this.
- **Rug-pull pinning.** A tool whose definition changes after approval is hidden until it is approved again, with a before/after diff. `resilience-flow` flips `chaos`'s rug-pull switch to check it.
- **Credential handling:**
  - API keys and tokens are HMAC'd with a pepper;
  - passwords use scrypt;
  - upstream credentials are write-only in the API;
  - Secrets are passed to kubectl as files, never on the command line;
  - the production Secrets are created outside Helm.
- **Limits.** A 1 MB result cap, per-upstream timeouts, a circuit breaker and a bulkhead, so a slow or hostile server can't starve the others.
- **Dashboard and audit.**
  - Strict CSP with no inline script or style, and untrusted text rendered as text: tool descriptions come from upstreams, which is where XSS against an admin would come from.
  - An append-only audit enforced by database grants, so the app role can't UPDATE or DELETE audit rows.

The [threat model](threat-model.md) maps each attack to its control.

---

## 7. Scaling

- **Multiple replicas.** The gateway runs **2 replicas locally and in production**. `/mcp` is stateless per request, so any replica serves any call, for both MCP protocol eras.
- **One leader.** One replica, elected through a Postgres advisory lock, runs health checks and tool syncs. If it dies, its database connection closes, the lock is released, and a standby takes over within 10 s (its retry interval).
- **Read-your-writes across replicas** (D96).
  - Every state change bumps a Postgres sequence, and each request catches up if its replica is behind.
  - So a revoked key fails on the very next call, whichever replica gets it.
  - *Found by running the e2e suite on 2 replicas.*
- **Per-user rate limits** (D93). A token bucket covers all of a user's keys, grants and chat. A throttled call is an MCP tool error with the wait time, audited as `rate_limited`.

**Proof:** all six e2e suites (137 checks on a fresh cluster) pass on 2 replicas, and `gateway-flow` floods calls until it is throttled.

---

## 9. Upgrades and rollback

Documented and **performed** in [runbooks.md](runbooks.md):
- **A broken gateway upgrade rolled back by itself, with zero downtime.** A probe got 762/762 answers during it.
- **Manual `helm rollback`** of a config change.
- **Store upgrades are guarded:**
  - a pre-upgrade backup Job, with no backup meaning no upgrade;
  - WooCommerce DB migrations in a post-upgrade Job;
  - `scripts/restore-store.sh` for rolling back past a migration, verified by restoring a dump and checking a canary product disappeared.
- **Fleet upgrades.** A store chart bump rolls out to every provisioned store. The provisioner heals a StatefulSet that Helm can't patch (D99).
- *Testing found and fixed two serious bugs:*
  - the backup hook had never produced a usable dump (D98);
  - a chart bump would have failed every provisioned store (D99).

---

## 1. VPS deployment with TLS (scripted and rehearsed)

**The path.** [`deploy/vps/`](../deploy/vps) has four pieces:
- `bootstrap-node.sh`: k3s with Secrets encryption, plus a firewall;
- `setup-cluster.sh`: cert-manager, Let's Encrypt staging and prod issuers, the namespaces and Secrets;
- `create-secrets.sh`: create-if-absent;
- `make push` (multi-arch) and `make prod-up`.

**What changes between environments** is only the values: [system-design §9](system-design.md#9-what-changes-for-production).

**Rehearsed locally.** `make tls-local` runs `setup-cluster.sh` unchanged against k3d, with a cluster-local CA in place of Let's Encrypt. The certificate was issued, cookies switched to `__Host-…; Secure`, the OAuth issuer became `https://`, and the OAuth suite passed over TLS.

**Found by the rehearsal:** default-deny would have blocked cert-manager's HTTP-01 solver, so no certificate would ever have been issued (D89).

**Not yet done:** a run on a public server.

---

## 8. Observability (light)

- **`/metrics`** on the gateway's internal port:
  - `mcp_tool_calls_total{server,outcome,via}`
  - `mcp_tool_call_duration_seconds`
  - `mcp_upstream_up`
  - `gateway_auth_failures_total`
- **Why a server is unreachable** is shown on its card as a reason code: `CONNECTION_REFUSED`, `DNS_FAILURE`, `AUTH_REJECTED`, `NOT_MCP`, `TLS_ERROR`, `SSRF_BLOCKED` or `TIMEOUT`.
- **Why a call failed** is recorded in the audit row as an outcome (`timeout`, `unavailable`, `denied`, `rate_limited`, `auth_failed`, …) plus an error code (`TIMEOUT`, `CONNECTION_REFUSED`, `FORBIDDEN`, `REVOKED`, …).
- **Dashboard.** The overview shows calls, errors and p50/p95 per server. The audit log has a live tail (SSE), filters and CSV export.
- **Stores** report their 7 provisioning steps as conditions, and failures carry a specific reason.

---

## Extras not on the list

- **The definition of done is a test.** `make dod` runs it with two users. `make e2e` adds five more suites (137 checks on a fresh cluster) that run against the real cluster, including killing pods.
- **Write actions in chat need approval.** The chat shows an approval card before any write tool runs. This answers the cross-user prompt-injection risk (threat model Q4) with working code.
- **Test servers for the hard cases:**
  - `chaos`: timeouts, errors and faults, toggled at runtime, plus a rug-pull switch;
  - `collide`: tool names that clash with woo's;
  - `evil`: a poisoned tool description;
  - `toolfarm`: 288 tools.
- **Both MCP protocol eras.** The gateway speaks 2026-07-28 and bridges 2025-era clients and upstreams on one endpoint (`fetch` is 2025-era).
- **A build log** with about 100 numbered decisions and the bugs testing found ([BUILD_LOG.md](BUILD_LOG.md)).
