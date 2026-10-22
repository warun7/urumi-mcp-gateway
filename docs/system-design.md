# System design and tradeoffs

A WooCommerce hosting platform with a team MCP gateway, on Kubernetes. The same Helm charts run on a laptop (k3d) and a VPS (k3s); only values change. Decision numbers (D*n*) link the reasoning in [BUILD_LOG.md](BUILD_LOG.md).

## 1. Architecture

```
                         ┌──────────────────────── namespace: platform ────────────────────────┐
 browser ──┐             │                                                                     │
           │  Traefik    │   dashboard (nginx, static React)                                   │
 Claude ───┼─▶ Ingress ──┼─▶ gateway ──────────────┬──▶ Postgres (users, keys, tools, audit)   │
 Code /    │  one host   │   /mcp /api /oauth      │                                           │
 Cursor ───┘             │     ▲      │            ├──▶ mcp-fetch (public web only)            │
                         │     │      └─▶ agent    │                                           │
                         │     └── (agent calls    │   provisioner ──▶ Kubernetes API          │
                         │          back as user)  │     (Store CRs → helm install per store)  │
                         └─────────────────────────┼───────────────────────────────────────────┘
                                                   │  only the gateway may connect (NetworkPolicy + bearer)
                ┌──────────────────────────────────┼───────────────────────┐   ┌── mcp-servers ──┐
                │ store-default        store-acme  ▼                       │   │ chaos, collide, │
 storefront ──▶ │  WordPress ◀── woo-mcp      WordPress ◀── woo-mcp  ...    │   │ evil, toolfarm  │
 (Ingress)      │      │                          │                        │   │ (test servers)  │
                │   MariaDB (PVC)              MariaDB (PVC)               │   └─────────────────┘
                └──────────────────────────────────────────────────────────┘
```

| Component | Responsibility | Tech |
|---|---|---|
| **Store** (`charts/store`, `images/wordpress`) | WordPress, WooCommerce and Storefront baked into an immutable image. MariaDB StatefulSet, uploads PVC, setup Job (Helm hook), pre-upgrade DB backup Job. | Official `wordpress` and `mariadb` images |
| **woo-mcp** (`apps/woo-mcp`) | 8 tools over Streamable HTTP: `get_store_info`, `list_products`, `get_product`, `create_product`, `list_orders`, `get_order`, `update_order_status`, `sales_summary`. ClusterIP only. | MCP SDK v2, stateless |
| **Gateway** (`apps/gateway`) | MCP client to every upstream and MCP server to every user. Auth (keys, OAuth 2.1, sessions), permissions, routing, health, audit, dashboard API. | Node 24, Hono, postgres.js |
| **Dashboard** (`apps/dashboard`) | Servers, tools review, members, permissions, keys, connected apps, audit (live), chat, stores | React, strict CSP |
| **Chat agent** (`apps/agent`) | Tool loop: LLM ↔ gateway. No credentials of its own: it acts as the user with a 5-minute delegation token. | OpenAI-compatible API over `fetch`, or `scripted` |
| **Provisioner** (`apps/provisioner`) | Bonus: reconciles `Store` custom resources into namespaces, quotas, Secrets and Helm releases, then registers each store's woo-mcp | Node controller + Helm CLI |
| **Test servers** (`apps/testkit`, `images/mcp-fetch`) | Timeouts, collisions, poisoning, rug pulls, 288 tools; a real third-party stdio server (`mcp-fetch-server`) bridged to HTTP | |

**Upstreams on the default install** (at least 3 required):
- `woo`: the default store.
- `fetch`: a third-party server, 2025-era protocol.
- `chaos`, `collide`, `evil`, `toolfarm`: test servers.
- One more `<name>` per store created from the dashboard.

## 2. Key choices

| Choice | Why | Instead of |
|---|---|---|
| **woo-mcp talks to WooCommerce through REST API v3** with a dedicated key, signed with OAuth 1.0a (it's plain HTTP inside the cluster) | A versioned contract that runs WooCommerce's own logic (stock, hooks, HPOS). It needs no Kubernetes permissions. | **WP-CLI** needs `pods/exec` RBAC and a shell per call. **SQL** skips WooCommerce's invariants and breaks on schema changes. Signing quirk, found by experiment: the signature base URL must be WordPress's *home* URL, not the Service URL the request goes to. |
| **One origin** for dashboard, API, `/mcp` and OAuth (D49) | First-party `HttpOnly` cookie, no CORS for the dashboard, and OAuth discovery works because clients and the browser share one host | A separate API host |
| **Postgres for everything stateful in the platform**, LISTEN/NOTIFY for cross-replica events (D4, D22) | One stateful dependency. Advisory locks for leader election and migrations; an append-only audit enforced by DB grants. | Redis plus a DB |
| **Stateless MCP endpoint** (spec 2026-07-28, legacy clients served per request) | Any replica serves any request: no sticky sessions, no session store | Session affinity |
| **Gateway answers `tools/list` from an in-memory catalog** synced by a leader | Listing never touches an upstream, so a slow or dead server can't slow it down | Fan-out per list call |
| **Own small charts on official images** | Bitnami's free images are frozen. Small charts are explainable line by line. | Bitnami WordPress chart |
| **k3d locally, k3s on the VPS** | Same distribution: Traefik, local-path storage and NetworkPolicy enforcement out of the box. Local and prod differ only in values. | Kind or Minikube (extra CNI and ingress work) |

## 3. Tool aggregation

**Naming: `<server>__<tool>`, always.**
- The server's slug (`woo`, `fetch`, `acme`) is fixed at registration and matches `^[a-z][a-z0-9-]{0,19}$` (no underscores), so the double underscore can't be ambiguous.
- `woo__list_orders` and `erp__list_orders` coexist, and no server can shadow another.
- The `gateway__` prefix is reserved for the gateway's own meta-tools.
- Every store gets its own prefix, so tool names say which store they act on (`acme__list_orders`).
- Prefixing even when there's no collision means names never change when a second server with the same tool arrives.

**The catalog** (`mcp/catalog.ts`) is an immutable snapshot of enabled, connected upstreams and their approved tools.
- The leader rebuilds it from Postgres on every change: register, edit, disable, a tool sync, approval, or a permission rule.
- It then tells every replica (NOTIFY), and each replica pushes `notifications/tools/list_changed` to its listening clients.
- Hidden from it:
  - tools of disabled or unreachable servers;
  - quarantined tools;
  - tools whose definition changed since approval (rug-pull pinning).

**Per-user view.** `tools/list` = the catalog filtered by the caller's permissions:
- admins get everything;
- members get tools classified `read`;
- explicit allow and deny rules per role or user apply on top, and deny wins.

Search and calls use the same filter, so a hidden tool behaves as if it doesn't exist (D29).

**Many tools.** Each key or grant has a tool mode:

| Mode | `tools/list` returns | When |
|---|---|---|
| `full` | every permitted tool | small catalogs |
| `search` | `gateway__list_servers`, `gateway__search_tools`, `gateway__call_tool` (plus admin-pinned tools) | large catalogs |
| `auto` (default for OAuth and chat) | full under 60 permitted tools, search above | |

In search mode the model searches, gets the 5 best tools *with their schemas*, and calls them by name. The chat agent then offers found tools as real function definitions (D43).

Search ranking:
- BM25 over stemmed words.
- An action-aware re-rank: the tool's verb against the query's intent. Reads before writes, deletes last, and summary tools for "how much" questions.

Measured in [`eval/`](../eval/RESULTS.md) on 102 tasks across 325 tools: **hit@5 81% on dev, 89% on held-out**, against 79% and 83% for a keyword baseline. The tool list shrinks from about 40k tokens to about 400. A CI test guards the scores.

**Protocol eras.** woo-mcp and the test servers speak MCP 2026-07-28. `mcp-fetch` and many real clients speak 2025-11-25.
- The gateway probes each upstream (`server/discover`, falling back to `initialize`) and caches the result.
- It serves both kinds of clients from one endpoint.
- Health checks use `server/discover` or `ping` to match.

## 4. Routing and failure handling

A call from any client (Claude Code, Inspector, the chat agent, or `gateway__call_tool`) goes through `Router.call` (`mcp/router.ts`):

```
freshness check (catch up if another replica changed state)        events/freshness.ts
 → authenticate (key | OAuth token | delegation token → Principal) auth/bearer.ts
 → per-user rate limit (120/min, token bucket)                     policy/ratelimit.ts
 → look up "woo__list_orders" in the catalog → permission check     (unknown and forbidden answer identically)
 → validate arguments against the tool's JSON Schema
 → upstream connection for "woo":
      circuit breaker (opens after 5 consecutive failures, 15 s)
      → bulkhead (max concurrent calls per server, 2 s queue)
      → per-server timeout (default 20 s), and client cancellation
      → retry once after reconnect, only for read-only or idempotent tools
 → cap the result at 1 MB → audit row (user, credential, client, server, tool, duration, outcome) → metrics
```

**Every failure becomes a tool result with `isError: true`** and a sentence the model and the user can act on. Nothing hangs, and one server's trouble never touches another's:

| Situation | What the caller gets | Status in the dashboard |
|---|---|---|
| Server's pod killed | `Server 'chaos' is unavailable (CONNECTION_REFUSED: Connection refused (is the server running?))` in about 3 s | Unreachable · `CONNECTION_REFUSED`, and its tools are hidden after 2 failed health checks |
| Slow tool | `Server 'chaos' did not answer sleep within 3000 ms. Other servers are unaffected.` | stays Connected (the server answers health checks) |
| Server failing repeatedly | `calls are paused for a few seconds (circuit open)`, with no wait at all | |
| Too many concurrent calls | `at its concurrency limit (N); try again shortly` | |
| Tool returned an error | passed through unchanged (`tool_error` in the audit) | |
| Credential wrong | `AUTH_REJECTED` | Unreachable · `AUTH_REJECTED` |
| Wrong URL | `NOT_MCP`, `DNS_FAILURE`, `TLS_ERROR`, `SSRF_BLOCKED` | shown when the admin clicks *Test connection* |

**Health.** One replica is elected leader through a Postgres advisory lock (D25). It probes every server every 10 s (5 s locally) and syncs tool lists every 60 s or immediately on `list_changed`.
- A connected server needs **2 consecutive failures** before it's marked Unreachable, so one blip doesn't make tools vanish (D26).
- A new server is reported on its first failure.
- An unreachable server recovers on its own: it's re-probed, and its tools come back.

**Hiding the tools of an unreachable server** keeps a dead server's tools out of the model's choices and makes "the dead one disappears, the others keep working" visible. The cost: a client that cached the list might call a hidden tool and get the same clear `Unknown tool` error.

## 5. Identity, authorization and the audit

**Three ways in, one `Principal`:**

| Credential | For | Lifetime |
|---|---|---|
| API key `ugw_<id>_<secret>` | the user's own MCP clients | until revoked |
| OAuth 2.1 access token | MCP clients doing browser login (MCP authorization spec: protected-resource metadata, PKCE, DCR and CIMD, `iss`, audience-bound) | short, with rotating refresh |
| Delegation token | the chat agent, acting as the logged-in user (`via=chat`) | 5 minutes |

All three are opaque and HMAC-hashed with a pepper. Revocation takes effect on the next request on every replica (§7).

**Roles.** Admins manage servers, members, permissions and stores, and see the whole audit. Members use the tools they're permitted, manage their own keys and grants, and see their own audit rows.

**The audit** records every call with:
- user and credential (and the OAuth client name);
- `via` (mcp or chat), server and tool;
- time, duration and outcome: `success`, `tool_error`, `timeout`, `unavailable`, `denied`, `invalid_args`, `auth_failed`, `rate_limited` or `cancelled`;
- argument and result sizes, and a trace id. The trace id is also sent upstream as W3C `traceparent` in `_meta`.

Rejected credentials are recorded against the key's owner. The dashboard shows the audit with filters, a live SSE tail, CSV export and summaries. The app's database role can't update or delete audit rows.

## 6. Chat agent

```
browser ──cookie──▶ gateway /api/chat ──mints udt_… (5 min)──▶ agent /chat
agent ──Bearer udt_…──▶ gateway /mcp      (same permission checks, rate limit and audit as any client)
agent ──SSE (text, tool_call, tool_result, approval_required)──▶ gateway ──▶ browser
```

- **Stateless.** The browser keeps the history and sends it each turn. The gateway forbids a client-supplied `system` role.
- **Write tools pause for approval.** The gateway's admin-owned `access` flag decides which tools are writes, never the upstream's hint. Approval is stateless too: the browser resends the history with `approvals`.
- **Guardrails:**
  - 8 steps, and the last one gets no tools;
  - 10 calls per turn;
  - results truncated to 8,000 characters;
  - history trimmed without orphaning tool results.
- **Model choice.** The default is a deterministic `scripted` model, so the system is demoable and testable for free. A real model is three values (`agent.llm.provider`, `baseUrl`, `model`) plus a Secret for the key. Any OpenAI-compatible API works: OpenAI, Gemini, Groq, OpenRouter, or a local Ollama or vLLM.

## 7. Scaling and consistency

- **Replicas.** The gateway is stateless per request, so `gateway.replicas: N` just works. Production values run 2, with a PodDisruptionBudget. The full e2e suite passes against 2 replicas.
- **One writer, many readers.** Only the leader runs health checks and tool syncs (no flapping, no duplicate probes). Every replica serves calls with its own upstream connections.
- **Read-your-writes across replicas.** LISTEN/NOTIFY gets a change to every replica within milliseconds. But a client whose next request lands on another replica can beat it. *Found by running the suite on 2 replicas*: a disabled server's tools were still listed for one request.
  - The fix: every state change bumps a Postgres sequence (`state_epoch`). Each `/mcp` request reads it (a single sequence read, no table) and catches up first if its replica is behind: catalog, permissions and the auth cache.
  - So a revoked key fails on the very next call, and a disabled server's tools are gone from the very next list, whichever replica serves it.
- **Rate limits** are per user, in memory per replica, so the cluster-wide ceiling is N × the limit. The login limiter works the same way. A Postgres or Redis counter is the upgrade if that matters.
- **The provisioner** runs as 1 replica with `Recreate`. Helm's release history is the state, so a restart mid-install resumes or fails with a reason.
  - **Upgrades fan out.** The store chart ships in the provisioner image. A chart bump changes every store's release hash, so each store is upgraded on its next reconcile, with its own pre-upgrade backup.
  - **Self-healing, never destructive.** It recreates a StatefulSet that Helm can't patch (orphan delete: pod and volume kept). It never uninstalls a store that was once deployed; it retries the upgrade in place. Both came from a real chart bump that failed (BUILD_LOG D99).

## 8. Kubernetes layout

| Namespace | Runs | Public? |
|---|---|---|
| `platform` | gateway (2 ports: public 8080, internal 8081 for the provisioner and `/metrics`), dashboard, agent, Postgres, mcp-fetch, provisioner | Ingress → dashboard `/`, gateway `/mcp`, `/api`, `/oauth`, `/.well-known`. Nothing else. |
| `store-default`, `store-<name>` | WordPress, MariaDB, woo-mcp | Ingress → storefront only. **woo-mcp has no Ingress**, and its NetworkPolicy admits only gateway pods; it also requires the gateway's bearer token. |
| `mcp-servers` | test servers | internal only |

- **Probes and resources** on every container. WordPress has a liveness check that doesn't need the DB (`healthz.php`) and a readiness check that does (`ready.php`). The gateway is ready when the DB is, and deliberately *not* tied to upstreams.
- **Persistence.**
  - MariaDB datadir and uploads on PVCs (`local-path`).
  - Postgres on a PVC.
  - The backup Job writes to a subPath of the MariaDB volume (D11), and `scripts/restore-store.sh` restores from it.
  - The uploads PVC survives `helm uninstall` (`resource-policy: keep`). Only deleting the store's namespace removes it.
- **Pod Security `restricted` enforced** on every namespace: non-root, read-only root filesystems, no capabilities.
- **NetworkPolicies**: default deny in both directions, with explicit allows only.
- **Secrets**: K8s Secrets only (never values files or code), encrypted at rest by k3s.
- **Upgrades and rollback**: see [runbooks.md](runbooks.md).

## 9. What changes for production

Same charts. `values-local.yaml` and `values-prod.yaml` differ only in these:

| Concern | Local (k3d) | VPS (k3s) |
|---|---|---|
| **DNS** | `*.127.0.0.1.nip.io`: real hostnames that resolve to the laptop, with no `/etc/hosts` edits. Store subdomains work too (`acme.shop.127.0.0.1.nip.io`). | A records for `app.<domain>`, `shop.<domain>` and wildcard `*.shop.<domain>` → VPS IP |
| **Ingress and TLS** | Traefik (bundled), plain HTTP. `make tls-local` rehearses TLS with a cluster-local CA. | The same Traefik, plus cert-manager with Let's Encrypt (HTTP-01, staging first) per host via `cert-manager.io/cluster-issuer`. `publicScheme: https` switches cookies to `__Host-…; Secure` and the OAuth issuer to `https://`. |
| **Storage class** | `local-path` (k3d default), small PVCs | `local-path` on the node's disk (single node). Larger PVCs (10 Gi DBs). `persistence.storageClass` takes a cloud class (Longhorn, EBS) for multi-node. |
| **Secrets** | Generated by Helm on first install and kept across upgrades (`lookup`) | `secrets.existingSecrets: true`: created beforehand by `deploy/vps/create-secrets.sh` (create-if-absent, never overwritten, never in a release record). The LLM key lives in its own Secret. KEK rotation with `make rotate-kek`. |
| **Images** | Built locally, imported into k3d (`urumi/*:dev`) | Multi-arch images in a registry (`make push`) at a pinned tag |
| **Availability** | gateway ×2 (so the demo runs what prod runs), the rest ×1 | gateway and dashboard ×2, PodDisruptionBudgets |
| **Kubernetes API egress** (provisioner) | k3d's Docker network `172.16.0.0/12` | The node IP `/32`, auto-detected by `make prod-up` |
| **Chat model** | `scripted` | `provider: openai` with any OpenAI-compatible endpoint |

Step by step: [README → Deploy to a VPS](../README.md#deploy-to-a-vps-k3s).

## 10. Tradeoffs

| Decision | Upside | Cost and mitigation |
|---|---|---|
| Hide tools of unreachable servers | The model never picks a dead tool; the outage is visible | A cached client list can be stale; the call gets a clear error. 2-failure hysteresis avoids flapping. |
| One shared upstream credential per server (the brief's model) | Simple for admins | Members act with its authority within their permissions; see the [threat model](threat-model.md) §1. Next step: per-user upstream OAuth. |
| Audit written after the call; a failed audit write doesn't fail the call (D24) | A DB hiccup doesn't take tools down | A call could go unaudited; it's logged loudly. Fail-closed would be a flag. |
| 2025-era clients served statelessly | Any replica, no session store | No server push for legacy clients; a 10 s list TTL makes them notice changes |
| Code baked into the WordPress image | Reproducible, immutable, an upgrade is a tag bump | Plugins can't be installed from wp-admin (by design); custom plugins mean a new image |
| Helm CLI inside the provisioner | The same chart for the default store and every new one, and Helm's history as state | A child process instead of a library call; handled by treating Helm's release status as the truth (D68) |
| In-memory rate limits | No new dependency | Per-replica ceilings (§7) |
| Opaque tokens instead of JWTs | Instant revocation, no signing keys | A DB lookup per request (5 s cache, flushed by the freshness epoch) |
| Platform-owned servers auto-approve definition changes (D87) | Upgrading woo-mcp doesn't hide tools on every store | Trusts the image the operator deployed; third-party servers still need re-approval |
