# Urumi: WooCommerce hosting with a team MCP gateway, on Kubernetes

[![ci](https://github.com/warun7/urumi-mcp-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/warun7/urumi-mcp-gateway/actions/workflows/ci.yml) [![e2e](https://github.com/warun7/urumi-mcp-gateway/actions/workflows/e2e.yml/badge.svg)](https://github.com/warun7/urumi-mcp-gateway/actions/workflows/e2e.yml)

An admin connects MCP servers once, in a dashboard. Every team member then uses all of them through **one MCP endpoint** (Claude Code, Cursor, Inspector) and through a **chat agent** in the dashboard. A WooCommerce store, with an MCP server written for it, is the first data source. Users can create more stores from the dashboard, and each one is registered with the gateway automatically.

Everything runs on Kubernetes. **The same Helm charts** run on a laptop (k3d) and on a VPS (k3s); only the values files differ.

**Start here:**
- `pnpm install && make up` builds and deploys everything on a local k3d cluster. Then `make dod` walks the brief's definition of done with two users and checks every step.
- [Where each requirement lives](#where-each-requirement-lives) maps every requirement in the brief to its code and the test that covers it.

```
 browser ─┐             ┌────────────────────────── platform ───────────────────────────┐
 Claude  ─┼─▶ Traefik ──┼─▶ dashboard    gateway ──▶ Postgres (users, keys, tools, audit)  │
 Code /   │   Ingress   │               /mcp /api /oauth ──▶ agent (calls back as the user) │
 Cursor  ─┘   one host  │                  │                provisioner ──▶ Kubernetes API │
                        └──────────────────┼────────────────────────────────────────────────┘
                                           │ only the gateway can connect (NetworkPolicy + bearer)
            ┌──────────────────────────────┼─────────────────────────┐   ┌─ mcp-servers ─┐
 storefront │ store-default                ▼   store-<name> (any)    │   │ test servers  │
 (Ingress)─▶│ WordPress ◀── woo-mcp          WordPress ◀── woo-mcp    │   │ + mcp-fetch   │
            │ MariaDB (PVC)                  MariaDB (PVC)           │   └───────────────┘
            └────────────────────────────────────────────────────────┘
```

| Layer | Where |
|---|---|
| Store: WordPress, WooCommerce and MariaDB, with persistent volumes, a setup Job and a pre-upgrade backup | [`charts/store`](charts/store), [`images/wordpress`](images/wordpress) |
| WooCommerce MCP server: 8 tools over Streamable HTTP, written from scratch, not reachable from outside | [`apps/woo-mcp`](apps/woo-mcp) |
| Gateway: an MCP client to every upstream and one MCP server to every user. Keys, OAuth 2.1, permissions, audit. | [`apps/gateway`](apps/gateway) |
| Dashboard: servers, members, keys, permissions, audit, chat, stores | [`apps/dashboard`](apps/dashboard) |
| Chat agent: the tool loop, acting as the logged-in user | [`apps/agent`](apps/agent) |
| Bonus: self-service stores, a `Store` CRD and a controller | [`apps/provisioner`](apps/provisioner) |

**Read next:**
- [System design and tradeoffs](docs/system-design.md)
- [Threat model](docs/threat-model.md)
- [Stand-outs, and where to find them](docs/standouts.md)
- [Runbooks](docs/runbooks.md): upgrade, rollback, restore, key rotation
- [Build log](docs/BUILD_LOG.md): every decision, and the bugs testing found. The project was built locally from 10 to 22 October 2026 and pushed as one commit, so the build log is its history, step by step.

---

## Contents

1. [Run it locally](#run-it-locally)
2. [Place an order](#place-an-order)
3. [Connect an MCP client](#connect-an-mcp-client)
4. [Use the chat agent](#use-the-chat-agent)
5. [The definition of done, as one command](#the-definition-of-done-as-one-command)
6. [Where each requirement lives](#where-each-requirement-lives)
7. [Deploy to a VPS (k3s)](#deploy-to-a-vps-k3s)
8. [Upgrade and roll back](#upgrade-and-roll-back)
9. [Tests](#tests)
10. [Repo map](#repo-map)
11. [Known limitations](#known-limitations)

---

## Run it locally

**You need:** Docker (give it **8 GB of memory**; each extra store costs about 0.7 GB), [k3d](https://k3d.io) 5.x, kubectl, Helm 4.x, Node 24 and pnpm.

```bash
pnpm install
make up
```

`make up` creates a k3d cluster, builds the images, imports them and installs:
- the default store;
- the platform (gateway ×2, dashboard, agent, Postgres, mcp-fetch, provisioner);
- the test MCP servers, which it then registers.

It is idempotent, so re-running it is safe. The first run takes several minutes, mostly the image builds.

| What | URL | Sign in |
|---|---|---|
| Dashboard and MCP endpoint | http://app.127.0.0.1.nip.io (MCP: `/mcp`) | `admin@urumi.test`; password from `make admin-password` |
| Storefront | http://shop.127.0.0.1.nip.io | none |
| WooCommerce admin | http://shop.127.0.0.1.nip.io/wp-admin | `admin`; password from `kubectl -n store-default get secret wordpress -o jsonpath='{.data.admin-password}' \| base64 -d` |
| Stores created in the dashboard | http://&lt;name&gt;.shop.127.0.0.1.nip.io | |

`make status` shows the pods and releases. `make help` lists every target.

### Local domains

The hostnames are real DNS names from [nip.io](https://nip.io): `anything.127.0.0.1.nip.io` resolves to `127.0.0.1`.
- k3d maps ports 80 and 443 on your machine to Traefik, the cluster's Ingress controller.
- So you get **stable, production-shaped URLs** with no `/etc/hosts` edits, including a subdomain per store.
- OAuth redirect URIs and cookies then behave as they do in production (D60). `localhost` with port-forwards would break the Ingress paths and OAuth discovery.

**Fallback.** Some routers and corporate DNS block answers that point at private addresses ("DNS rebinding protection"), so nip.io names don't resolve. Add the hosts yourself:

```bash
echo "127.0.0.1 app.127.0.0.1.nip.io shop.127.0.0.1.nip.io" | sudo tee -a /etc/hosts
```

Add a line for each store you create, for example `acme.shop.127.0.0.1.nip.io`.

**HTTPS locally (optional).** `make tls-local` runs the production TLS path against the local cluster: cert-manager, with a cluster-local CA in place of Let's Encrypt. `make platform` goes back to plain HTTP.

---

## Place an order

1. Open http://shop.127.0.0.1.nip.io, pick a product and choose **Add to cart**.
2. Go to **Checkout**, fill in any address and choose **Cash on delivery**. The setup Job enables it.
3. Place the order.
4. Open **WooCommerce → Orders** in http://shop.127.0.0.1.nip.io/wp-admin. The order is there as *Processing*.

The store uses INR and the Asia/Kolkata timezone, so "today" in the tools means today in the store's timezone (`charts/store/values.yaml`).

---

## Connect an MCP client

Each user has their own credential. Upstream credentials never leave the gateway.

### With an API key (works with every client)

**Dashboard → Keys → Create key.** The key is shown once, with ready-to-paste config for each client:

```bash
claude mcp add --transport http urumi http://app.127.0.0.1.nip.io/mcp --header "Authorization: Bearer <your key>"
```

<details><summary>Cursor, MCP Inspector, curl</summary>

Cursor (`~/.cursor/mcp.json`):

```json
{ "mcpServers": { "urumi": { "url": "http://app.127.0.0.1.nip.io/mcp", "headers": { "Authorization": "Bearer <your key>" } } } }
```

MCP Inspector: run `npx @modelcontextprotocol/inspector`, choose transport **Streamable HTTP**, enter URL `http://app.127.0.0.1.nip.io/mcp`, and add the header `Authorization: Bearer <your key>`.

curl:

```bash
curl -s http://app.127.0.0.1.nip.io/mcp -H "Authorization: Bearer <your key>" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2025-11-25' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```
</details>

**What you get:** the tools of every enabled server you're allowed to use, named `<server>__<tool>`, for example `woo__list_orders` or `fetch__fetch`. The prefix:
- avoids collisions between servers;
- tells you which store a tool acts on (`acme__list_orders`).

A key also has a **tool mode**:

| Mode | You see | Use it when |
|---|---|---|
| `full` | every permitted tool | small catalogs |
| `search` | 3 meta-tools: `gateway__list_servers`, `gateway__search_tools`, `gateway__call_tool` | hundreds of tools |
| `auto` | full under 60 tools, search above | default |

With the 288-tool test server enabled, search mode cuts the tool list from about 40k tokens to about 400 ([eval](eval/RESULTS.md)).

### With OAuth (browser sign-in, no key to copy)

Clients that implement the MCP authorization spec need only the URL:

```bash
claude mcp add --transport http urumi http://app.127.0.0.1.nip.io/mcp
```

Then run `/mcp` in Claude Code. What happens:
1. The client discovers the gateway's authorization server from the `401`.
2. It registers itself.
3. It opens the dashboard's consent page. You sign in and approve.

The grant shows up under **Connected apps**, where you can revoke it. Tokens are bound to this gateway (RFC 8707 `resource`) and never forwarded upstream.

Some clients refuse OAuth over plain HTTP on a host that isn't `localhost`. If yours does, run `make tls-local` and trust `.dev/local-ca.crt`, or use an API key. `e2e/scripts/oauth-flow.ts` runs the whole flow over both HTTP and HTTPS:
- discovery, DCR, PKCE and the consent screen;
- token, refresh rotation and reuse detection;
- revocation.

### As a second user (member)

1. As admin: **Members → Invite**, then send them the link.
2. They open it, set a password, and create their own key under **Keys**.

By default, members see read tools only: `woo__list_orders` yes, `woo__create_product` no. Hidden tools are also refused if called directly. **Permissions** changes that per role or per user.

### Add a third-party server

**Servers → Add server**, with:
- a URL;
- an optional credential, as a header or a bearer token. It is encrypted at rest and never shown again.

Public HTTPS servers work out of the box. For example, GitHub's remote MCP server is `https://api.githubcopilot.com/mcp/`, used with a fine-grained, read-only personal access token as the bearer.

New tools wait for an admin's review before anyone can call them. Suspicious descriptions are quarantined, and a definition that changes after approval is hidden until it is approved again.

---

## Use the chat agent

**Dashboard → Chat.** The agent:
- calls tools through the gateway **as you**, with a 5-minute delegation token;
- uses only the tools you are allowed;
- writes its calls to the audit log under your name, marked `via=chat`;
- shows each tool call as a chip;
- asks you to approve write actions, such as creating a product or changing an order, before they run;
- when you don't name a store, asks every store at once for questions, and proposes writes on the default store. The approval card shows which store before anything runs.

**Out of the box it runs a scripted model** (no API key), which is enough to exercise the tool loop:
- `Create a product called Urumi Mug for 499`
- `What orders came in today?`
- `Compare today's sales across all stores`
- `Fetch https://example.com`

**For a real model**, use any OpenAI-compatible API:

```bash
make chat-llm                       # prompts for the key; OpenAI gpt-4.1-mini by default
```

```bash
make chat-llm LLM_BASE_URL=https://api.deepseek.com/v1 LLM_MODEL=deepseek-chat
```

```bash
make chat-scripted                  # back to the scripted model
```

The key goes into the Secret `platform/agent-llm`, read from a prompt and never put on the command line. The non-secret settings go into the gitignored `.dev/values-llm.yaml`.

`make dod` passes on `deepseek-chat` as well as on the scripted model. The agent logs one `llm call` line per model round, with timing and token counts:

```bash
kubectl -n platform logs deploy/agent | grep -E '"(llm call|chat turn)"'
```

---

## The definition of done, as one command

```bash
make dod
```

[`e2e/scripts/dod-flow.ts`](e2e/scripts/dod-flow.ts) walks the assignment's definition of done with two real users. User A is the admin and uses the chat; user B is an invited member and uses an MCP client with only the URL and their key. It checks:

| DoD item | What the test does |
|---|---|
| Store | Checks out a COD order through the storefront's cart and checkout API, then signs in to wp-admin and finds the order there |
| Chat, as A | Creates a product with a name and price, and checks the storefront shows it. Places an order for it, then asks for today's orders and checks they include it. |
| Client, as B | Connects with only the URL and key, sees tools from every enabled server, asks the orders question, and makes the calls one prompt needs from two servers (today's sales from two stores) |
| Revoke | Revokes B's key; B's next call gets `401` |
| Disable | Disables a server; its tools disappear for both the chat and B's client |
| Kill a pod | Kills an upstream's pod: the dashboard shows it Unreachable with a reason, the other servers keep working, and it recovers |
| Audit | Every call above appears in the audit log under the right user |

`make e2e` runs it along with five more suites:

| Suite | Covers |
|---|---|
| `gateway-flow` | permissions, naming, search, rate limits |
| `oauth-flow` | the OAuth flow |
| `resilience-flow` | timeouts, the circuit breaker, rug pulls |
| `chat-flow` | the chat agent |
| `store-flow` | the bonus: create, isolate and delete stores |

Last run, on a freshly built cluster: **6 suites, 137 checks, 0 failures, against 2 gateway replicas.** One more check, the platform-wide store limit, runs only when existing stores already fill that limit (138 then).

`make isolation` proves the network isolation from inside the pods, at the TCP level. A store's woo-mcp can reach only its own WordPress: not its own database, another store, Postgres or the internet. Only the gateway can reach any woo-mcp. It works right after `make up`; once a second store exists (create one under Stores), it also probes store to store.

---

## Where each requirement lives

The brief's mandatory requirements, where each one is implemented, and what tests it. The bonus and the stand-outs are listed in [standouts.md](docs/standouts.md).

| Requirement | Where | Tested by |
|---|---|---|
| **Kubernetes and Helm** | | |
| Local k3d and a VPS on k3s, from the same charts; differences only in values | [`charts/`](charts) with `values-local.yaml` and `values-prod.yaml`, [`deploy/vps/`](deploy/vps) | `make up`; CI renders every chart with both values files |
| Store, database, MCP server, gateway and dashboard all in the cluster, with persistent storage | [`charts/store`](charts/store) (MariaDB StatefulSet, uploads volume), [`charts/platform`](charts/platform) (Postgres volume) | the `e2e` workflow, from a fresh cluster |
| Ingress with stable URLs; the local domain approach | `ingress.yaml` in both charts; [Local domains](#local-domains) | `make isolation` lists every Ingress rule |
| Readiness and liveness checks, requests and limits, on every workload | every template; enforced by [`scripts/check-manifests.py`](scripts/check-manifests.py) | `make charts-check` (CI) |
| No hardcoded secrets; credentials in Secrets | `secrets.yaml` in both charts; production uses Secrets made by [`create-secrets.sh`](deploy/vps/create-secrets.sh) | gitleaks, and the production render must contain no Secrets (CI) |
| **WooCommerce MCP server** | | |
| Written from scratch; Streamable HTTP; list and create products, list and get orders, update order status (8 tools in all) | [`apps/woo-mcp`](apps/woo-mcp) | unit tests, `dod-flow` |
| How it talks to the store, and why | WooCommerce REST API v3: [system design §2](docs/system-design.md#2-key-choices) | |
| Not reachable from outside the cluster; only the gateway can call it | no Ingress; [`networkpolicies.yaml`](charts/store/templates/networkpolicies.yaml) | `make isolation` |
| **Gateway** | | |
| Add, edit, disable and remove servers, each with an optional header or bearer credential | [`api/servers.ts`](apps/gateway/src/api/servers.ts), dashboard **Servers** | `gateway-flow` |
| One endpoint: listing returns every enabled server's tools, and calls are routed | [`mcp/endpoint.ts`](apps/gateway/src/mcp/endpoint.ts), [`mcp/router.ts`](apps/gateway/src/mcp/router.ts) | `dod-flow`, `gateway-flow` |
| Two servers with the same tool name | always `<server>__<tool>`: [`mcp/naming.ts`](apps/gateway/src/mcp/naming.ts), [system design §3](docs/system-design.md#3-tool-aggregation) | `resilience-flow` (the `collide` server) |
| A slow or dead upstream breaks nothing else; timeouts with clear errors | [`mcp/upstream/`](apps/gateway/src/mcp/upstream): timeout, circuit breaker, bulkhead | `dod-flow`, `resilience-flow` |
| Upstream credentials never reach the browser or an MCP client | encrypted at rest ([`crypto/secretbox.ts`](apps/gateway/src/crypto/secretbox.ts)); the API only says whether one is set | `gateway-flow` §11, unit tests |
| At least three upstreams | `woo`, `fetch` (a third-party server) and four test servers. Public servers such as DeepWiki (`https://mcp.deepwiki.com/mcp`) can be added in the dashboard. | `dod-flow` |
| **Team and access** | | |
| Admin and member roles | [`policy/permissions.ts`](apps/gateway/src/policy/permissions.ts) | `dod-flow`, `gateway-flow` |
| A key per user, revocable, stored hashed | [`api/keys.ts`](apps/gateway/src/api/keys.ts), [`crypto/tokens.ts`](apps/gateway/src/crypto/tokens.ts) (an HMAC with a pepper) | `dod-flow`, `gateway-flow` (revoked → 401) |
| An audit log of every tool call (user, server, tool, time, duration, outcome), shown in the dashboard | [`audit/audit.ts`](apps/gateway/src/audit/audit.ts), dashboard **Audit log** | `dod-flow`, `gateway-flow` |
| **Chat agent** | | |
| An LLM tool loop through the gateway that shows the tools it called | [`apps/agent/src/agent.ts`](apps/agent/src/agent.ts), dashboard **Chat** | `dod-flow`, `chat-flow` |
| Acts as the logged-in user, so its calls are audited under them | a 5-minute delegation token: [`api/chat.ts`](apps/gateway/src/api/chat.ts) | `dod-flow` |
| The LLM key is a Secret like every other | `make chat-llm` reads it from a prompt into the Secret `agent-llm` | |
| **Docs** | | |
| System design and tradeoffs; threat model; the bonus and stand-outs attempted | [system-design.md](docs/system-design.md), [threat-model.md](docs/threat-model.md), [standouts.md](docs/standouts.md) | |

---

## Deploy to a VPS (k3s)

Same charts, a different values file. **What changes** is listed in [system-design §9](docs/system-design.md#9-what-changes-for-production) and comes down to five things:
- **DNS:** real A records.
- **TLS:** cert-manager with Let's Encrypt.
- **Secrets:** created before install by a script, never by Helm.
- **Images:** pushed to a registry, multi-arch.
- **Availability:** replicas and PodDisruptionBudgets.

**You need:**
- an Ubuntu 24.04 server with 2 vCPU and 4 GB of RAM or more, and a public IP;
- a domain whose DNS you control;
- a container registry, such as GHCR.

**1. DNS.** Point A records for `app.<domain>`, `shop.<domain>` and `*.shop.<domain>` at the server.

**2. Install k3s on the server.** It is the same distribution as k3d, with Secrets encrypted at rest. The firewall allows 22, 80 and 443, plus 6443 from your IP only.

```bash
scp deploy/vps/bootstrap-node.sh root@<server>:
```

```bash
ssh root@<server> 'PUBLIC_IP=<server ip> ADMIN_CIDR=<your ip>/32 bash bootstrap-node.sh'
```

The script prints how to copy the kubeconfig to your machine. Point `KUBECONFIG` at that file.

**3. Prepare the cluster from your machine.** This installs cert-manager, the Let's Encrypt issuers, the namespaces and the production Secrets.

```bash
cp deploy/vps/.env.prod.example deploy/vps/.env.prod    # set ACME_EMAIL; optionally LLM_API_KEY
```

```bash
./deploy/vps/setup-cluster.sh
```

Secrets are create-if-absent, and anything not set in `.env.prod` is generated in the cluster. Back up the `platform/gateway` Secret: it holds the key that encrypts upstream credentials.

**4. Push the images**, multi-arch so ARM servers work:

```bash
make push REGISTRY=ghcr.io/<you> TAG=0.1.0
```

**5. Deploy.** Start with the Let's Encrypt **staging** issuer (the default), so a misconfiguration doesn't run into production rate limits:

```bash
make prod-up DOMAIN=<domain> REGISTRY=ghcr.io/<you> TAG=0.1.0
```

Once `kubectl get certificates -A` shows them Ready, switch to real certificates:

```bash
make prod-up DOMAIN=<domain> REGISTRY=ghcr.io/<you> TAG=0.1.0 ISSUER=letsencrypt-prod
```

The dashboard is then at `https://app.<domain>`, and `make admin-password` prints the admin password. Every section above applies, with `https://app.<domain>/mcp` as the MCP URL.

### Without a domain or a registry

Useful for trying it on a fresh server. Plain HTTP on `<ip>.sslip.io`, a wildcard DNS name that resolves to the IP, so store subdomains work too. The images are copied over SSH instead of going through a registry.

**1. Install k3s on the server.** Same as above; `ADMIN_CIDR` can stay empty, because kubectl will use an SSH tunnel:

```bash
scp deploy/vps/bootstrap-node.sh root@<ip>: && ssh root@<ip> 'PUBLIC_IP=<ip> bash bootstrap-node.sh'
```

**2. Connect kubectl through an SSH tunnel.** Port 6443 stays closed. This fetches the kubeconfig into the gitignored `.dev/`:

```bash
make vps-kubeconfig VPS=root@<ip>
```

```bash
export KUBECONFIG=$PWD/.dev/kubeconfig-vps
```

**3. Namespaces and Secrets.** No cert-manager, and no ACME email:

```bash
TLS=off ./deploy/vps/setup-cluster.sh
```

**4. Copy the images in.** They're built for the server's CPU (`VPS_PLATFORM`, default `linux/amd64`) and streamed into k3s:

```bash
make vps-images VPS=root@<ip> REGISTRY=local TAG=0.1.0
```

**5. Deploy:**

```bash
make prod-up TLS=off DOMAIN=<ip>.sslip.io REGISTRY=local TAG=0.1.0 ADMIN_EMAIL=admin@urumi.test
```

The dashboard is at `http://app.<ip>.sslip.io`. Without an `agent-llm` Secret, the chat uses the scripted model.

**Optional: the test servers and the e2e suites against the server:**

```bash
make test-servers register-test-servers e2e isolation BASE_URL=http://app.<ip>.sslip.io MCP_SERVER_ARGS="--set image.repository=local/urumi-testkit --set image.tag=0.1.0"
```

Let's Encrypt doesn't work well on sslip.io: it isn't on the Public Suffix List, so everyone's sslip.io certificates share one quota. For HTTPS, use a real domain and the steps above.

---

## Upgrade and roll back

Every `helm upgrade` here uses `--rollback-on-failure --wait`, so an upgrade that doesn't become healthy undoes itself. Details and verification are in [docs/runbooks.md](docs/runbooks.md).

| | How |
|---|---|
| **Gateway, agent, dashboard** | New image tag, then `make prod-up … TAG=<new>`. The rolling update keeps capacity (`maxUnavailable: 0`), and migrations are additive and run under a lock. A broken image tag was rolled back automatically, and the gateway answered 762 of 762 probe requests during it. |
| **Store** (WordPress, WooCommerce, woo-mcp) | New image tag. A pre-upgrade hook dumps the database first, and **no backup means no upgrade**. A post-upgrade Job runs WooCommerce's DB migrations. |
| **All provisioned stores** | Bump the store chart version and roll out the provisioner, which upgrades each store, each with its own backup |
| **Roll back** | `helm history <release> -n <ns>`, then `helm rollback <release> <revision> -n <ns> --wait` |
| **Roll back past a store DB migration** | `helm rollback`, then `scripts/restore-store.sh <ns> <dump>` |
| **Rotate the credential-encryption key** | `make rotate-kek`: three rolling restarts, no downtime |

---

## Tests

| Command | What runs |
|---|---|
| `make test` | Unit tests across the 4 services: 78 tests (naming, permissions, OAuth, SSRF, secretbox, search, rate limits, the provisioner's queue and diagnosis, OAuth 1.0a signing, model-provider errors and streaming…) |
| `make typecheck` | `tsc` on every package |
| `make e2e` | The 6 end-to-end suites against the running cluster. `chat-flow` pins the scripted model's replies, so it skips itself when a real model is configured. |
| `make dod` | Just the definition-of-done suite |
| `make isolation` | NetworkPolicy proof from inside the pods |
| `make eval` / `make eval-offline` | Tool-search quality on 102 tasks over 325 tools (live, or from a snapshot with no cluster). Results in [eval/RESULTS.md](eval/RESULTS.md). |

CI ([`.github/workflows`](.github/workflows)) runs two workflows on every push to `main`:
- **ci:** typecheck, unit tests, `helm lint` and render for both environments, kubeconform, shellcheck and gitleaks (also on pull requests);
- **e2e:** the full e2e on a fresh k3d cluster, then the isolation proof. It takes about 8 minutes and can also be started by hand.

---

## Repo map

```
apps/
  woo-mcp/        WooCommerce MCP server (REST API v3, OAuth 1.0a signing)
  gateway/        MCP gateway + dashboard API + OAuth 2.1 server
  agent/          chat agent (tool loop; OpenAI-compatible or scripted model)
  dashboard/      React dashboard
  provisioner/    Store controller (bonus)
  testkit/        test MCP servers: chaos (timeouts, faults), collide (name clashes), evil (poisoning), toolfarm (288 tools)
packages/kube/    small Kubernetes REST client shared by gateway and provisioner
charts/
  platform/       gateway, dashboard, agent, Postgres, mcp-fetch, provisioner, Store CRD (values-local / values-prod)
  store/          one WooCommerce store (values-local / values-prod); also installed per store by the provisioner
  mcp-server/     generic chart for the test servers
images/           Dockerfiles (node apps, dashboard, WordPress with WooCommerce baked in, mcp-fetch)
deploy/           namespaces, k3d cluster config, VPS scripts (bootstrap, cert-manager, Secrets)
e2e/              end-to-end suites (TypeScript MCP clients; storefront checkout through the WooCommerce Store API)
eval/             tool-search evaluation sets and results
scripts/          import-images, isolation-proof, restore-store, rotate-kek
docs/             system design, threat model, stand-outs, runbooks, build log
```

---

## Known limitations

- **Not yet run on a real VPS.** The VPS path was rehearsed against k3d with a local CA standing in for Let's Encrypt (`make tls-local`); the OAuth suite passed over TLS. The real ACME HTTP-01 round trip can only happen on a public server.
- **Shared upstream credentials** (the brief's model). Within their permissions, members act with the credential's authority. The fix is per-user upstream OAuth; see the [threat model](docs/threat-model.md).
- **Per-replica rate limits.** With N gateway replicas the ceiling is N × the limit.
- **Backups stay on the node.** Store dumps live on the MariaDB volume. Off-site copies (S3, restic) are not implemented.
- **No hosted MCP servers.** That stand-out wasn't attempted: servers are added by URL, not by container image.
- **Search is word-based.** It misses pure vocabulary gaps such as "money" vs "revenue"; [eval/RESULTS.md](eval/RESULTS.md) lists them. Hybrid retrieval with embeddings is the next step.
