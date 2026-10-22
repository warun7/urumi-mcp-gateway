/**
 * The assignment's definition of done, bullet by bullet, with two users:
 *   user A = the admin (dashboard chat), user B = an invited member (external MCP client, URL + key only).
 * Needs kubectl access to the cluster (it reads the WordPress admin password and kills an upstream's pod).
 *   BASE_URL=... ADMIN_EMAIL=... ADMIN_PASSWORD=... tsx scripts/dod-flow.ts
 */
import { execFileSync } from 'node:child_process';
import type { Client } from '@modelcontextprotocol/client';
import { chat, check, Dashboard, done, eventually, mcpConnect, mcpStatus, sleep, step, toolNames } from '../lib/api.js';
import { adminSeesOrder, placeOrder, storeProducts } from '../lib/store.js';

const BASE = process.env.BASE_URL ?? 'http://app.127.0.0.1.nip.io';
const MCP = `${BASE}/mcp`;
const STORE = process.env.STORE_SLUG ?? 'woo';
const STORE_NS = process.env.STORE_NAMESPACE ?? 'store-default';
const DISABLE = process.env.DISABLE_SLUG ?? 'fetch'; // the server we switch off
const KILL = { slug: 'chaos', ns: 'mcp-servers', deploy: 'testkit-chaos' }; // the server whose pod we kill
const runId = Date.now().toString(36);
const startedAt = new Date(Date.now() - 1000).toISOString();

const kubectl = (...args: string[]) => execFileSync('kubectl', args, { encoding: 'utf8' }).trim();
const secret = (ns: string, name: string, key: string) =>
  Buffer.from(kubectl('-n', ns, 'get', 'secret', name, '-o', `jsonpath={.data.${key}}`), 'base64').toString();
const sc = (r: any) => (r?.structuredContent ?? {}) as any;
const serversOf = (names: string[]) => [...new Set(names.filter((n) => !n.startsWith('gateway__')).map((n) => n.split('__')[0]!))].sort();

const A = new Dashboard(BASE);
const aUser = await A.login(process.env.ADMIN_EMAIL!, process.env.ADMIN_PASSWORD!);
const servers = async () => (await A.get('/servers')).data.servers as any[];
const server = async (slug: string) => (await servers()).find((s) => s.slug === slug);

// The chat runs in tool mode "auto": with the 288-tool test server enabled it starts in search mode, which
// chat-flow covers. Here we keep the catalog at a human scale so each DoD step reads plainly.
const parked = (await servers()).filter((s) => s.enabled && (s.tools?.total ?? 0) >= 50);
for (const s of parked) await A.patch(`/servers/${s.id}`, { enabled: false });

let a: Client | undefined;
let b: Client | undefined;
try {
  step('0. Two users: A is the admin; A invites B as a member, and B generates their own API key');
  const aKey = (await A.post('/keys', { name: `dod admin ${runId}`, toolMode: 'full' })).data.key as string;
  const bEmail = `bea-${runId}@urumi.test`;
  const inv = await A.post('/invites', { email: bEmail, role: 'member' });
  const B = new Dashboard(BASE);
  const acc = await B.post(`/invites/${inv.data.link.split('/').pop()}/accept`, { name: 'Bea', password: `pw-${runId}-long-enough` });
  check(acc.status === 201, `B (${bEmail}) accepted the invite`, acc.data);
  const bKeyRes = await B.post('/keys', { name: 'Claude Code', toolMode: 'full' });
  const bKey = bKeyRes.data.key as string;
  check(bKey?.startsWith('ugw_') && bKeyRes.data.mcpUrl === MCP, 'B generated a key in the dashboard; the only other thing B needs is the gateway URL', bKeyRes.data.mcpUrl);
  a = await mcpConnect(MCP, aKey);

  step('1. Store: a shopper checks out with cash on delivery, and the order is in WooCommerce admin');
  const info = sc(await a.callTool({ name: `${STORE}__get_store_info`, arguments: {} }));
  const shop = String(info.url ?? '').replace(/\/$/, '');
  check(shop && (await fetch(shop)).status === 200, `storefront is up at ${shop}`);
  const product = (await storeProducts(shop))[0]!;
  const order1 = await placeOrder(shop, product.id, `shopper-${runId}@example.com`);
  check(order1.id > 0 && /processing|on-hold/.test(order1.status), `checked out "${product.name}" with COD: order #${order1.id} (${order1.status})`, order1);
  const wpPassword = secret(STORE_NS, 'wordpress', 'admin-password');
  check(await adminSeesOrder(shop, 'admin', wpPassword, order1.id), `order #${order1.id} is on its WooCommerce admin screen (wp-admin login)`);

  step('2. Chat agent as user A: create a product, buy it on the storefront, ask what came in today');
  const name = `DoD Mug ${runId}`;
  const c1 = await chat(A, [{ role: 'user', content: `create a product called "${name}" for 499` }]);
  const ask = c1.of('approval_required')[0]?.calls?.[0];
  check(ask?.name === `${STORE}__create_product`, 'agent proposed create_product and paused for approval (write tool)', c1.of('approval_required'));
  const c1b = await chat(A, c1.history, { [ask?.id]: true });
  const created = c1b.of('tool_result')[0];
  check(created && !created.isError, 'A approved; the gateway created the product', created);
  const onShop = await eventually(() => storeProducts(shop), (ps) => ps.some((p) => p.name === name), 15_000);
  const newProduct = onShop.find((p) => p.name === name);
  check(newProduct && (await fetch(newProduct.permalink)).status === 200, `"${name}" is on the storefront: ${newProduct?.permalink}`);
  const order2 = await placeOrder(shop, newProduct!.id, `buyer-${runId}@example.com`);
  check(order2.id > order1.id, `ordered it by hand on the storefront: order #${order2.id}`);
  const c2 = await chat(A, [{ role: 'user', content: 'what orders came in today?' }]);
  const c2call = c2.of('tool_call')[0];
  const c2res = c2.of('tool_result')[0];
  check(c2call?.name === `${STORE}__list_orders` && c2call.args?.period === 'today', 'agent called list_orders with period "today" (resolved in the store timezone)', c2call);
  check(c2res && !c2res.isError && c2res.preview.includes(`${order2.id}`), `agent's answer includes order #${order2.id}`, c2res?.preview?.slice(0, 300));
  console.log(`     agent: ${c2.text.split('\n').slice(0, 3).join(' | ').slice(0, 200)}`);

  step('3. External MCP client as user B: the tools of every enabled server, with nothing configured per server');
  b = await mcpConnect(MCP, bKey, 'legacy'); // a 2025-era client, like most MCP clients today
  const aNames = await toolNames(a);
  const bNames = await toolNames(b);
  const live = (await servers()).filter((s) => s.enabled && s.status === 'connected' && s.tools?.active > 0).map((s) => s.slug).sort();
  check(live.length >= 3, `at least three upstream servers connected: ${live.join(', ')}`);
  check(JSON.stringify(serversOf(aNames)) === JSON.stringify(live), `A's client sees tools from every enabled server: ${serversOf(aNames).join(', ')}`, { live, seen: serversOf(aNames) });
  console.log(`     B sees ${bNames.length} tools from: ${serversOf(bNames).join(', ')} (members get read tools; writes are admin-only)`);
  check([STORE, DISABLE].every((s) => serversOf(bNames).includes(s)) && !bNames.includes(`${STORE}__create_product`), "B sees read tools from the store and the other servers, but not create_product");
  const bOrders = await b.callTool({ name: `${STORE}__list_orders`, arguments: { period: 'today' } });
  const ids = (sc(bOrders).orders ?? []).map((o: any) => o.id);
  check(!bOrders.isError && ids.includes(order2.id) && ids.includes(order1.id), `B asked "what orders came in today?": ${ids.length} orders, including #${order1.id} and #${order2.id}`, ids);
  // "One prompt that needs tools from two different upstream servers": what a model calls for
  // "compare today's sales in our demo store with <the other store>".
  const other = (await servers()).find((s) => s.enabled && s.status === 'connected' && s.managedBy?.startsWith?.('store/'))?.slug
    ?? (await servers()).find((s) => s.enabled && s.status === 'connected' && s.slug === 'erp')?.slug;
  if (other) {
    const tool = (await toolNames(b)).includes(`${other}__sales_summary`) ? 'sales_summary' : 'list_orders';
    const [x, y] = await Promise.all([
      b.callTool({ name: `${STORE}__sales_summary`, arguments: { period: 'today' } }),
      b.callTool({ name: `${other}__${tool}`, arguments: tool === 'sales_summary' ? { period: 'today' } : {} }),
    ]);
    check(!x.isError && !y.isError, `cross-server: ${STORE}__sales_summary + ${other}__${tool} in one prompt (${sc(x).order_count ?? '?'} orders here)`, [x.content, y.content]);
  } else console.log('  (no second data server registered; skipping the cross-server call)');

  step("4. Revoke user B's key: B's next call is rejected");
  const bKeyId = bKey.split('_')[1];
  check((await A.del(`/keys/${bKeyId}`)).status === 204, "A revoked B's key from the dashboard");
  check((await mcpStatus(MCP, bKey)) === 401, 'a fresh request with the key: 401 Unauthorized');
  const after = await b.callTool({ name: `${STORE}__list_orders`, arguments: { period: 'today' } }).then(() => 'allowed', (e) => String(e.message));
  check(after !== 'allowed', "B's already-connected client is rejected on its next call (no session outlives the key)", after);

  step(`5. Disable one upstream ("${DISABLE}"): its tools disappear from the chat agent and the external client`);
  const target = await server(DISABLE);
  const askFetch = () => chat(A, [{ role: 'user', content: 'fetch https://example.com and summarise it' }]);
  const usesTarget = (r: Awaited<ReturnType<typeof chat>>) => r.of('tool_call').some((c) => c.name.startsWith(`${DISABLE}__`));
  // fetch declares no readOnlyHint, so the gateway classes it as a write (it can carry data out in a URL):
  // the agent picks it and pauses for approval. Being picked is what shows the tool is on offer.
  check(usesTarget(await askFetch()) && (await toolNames(a)).some((n) => n.startsWith(`${DISABLE}__`)), `before: the chat agent picks ${DISABLE}__* tools, and A's client lists them`);
  await A.patch(`/servers/${target.id}`, { enabled: false });
  check(!(await toolNames(a)).some((n) => n.startsWith(`${DISABLE}__`)), `after: A's client no longer lists any ${DISABLE}__* tool`);
  check(!usesTarget(await askFetch()), `after: the chat agent no longer has ${DISABLE}__* tools to pick`);
  check((await server(DISABLE)).status === 'disabled', 'the dashboard shows it as Disabled');
  await A.patch(`/servers/${target.id}`, { enabled: true });
  await eventually(() => toolNames(a!), (n) => n.some((t) => t.startsWith(`${DISABLE}__`)), 20_000);

  step(`6. Kill the pod of one upstream ("${KILL.slug}"): the others keep working; the dashboard shows it Unreachable`);
  check((await server(KILL.slug))?.status === 'connected', `${KILL.slug} is connected to begin with`);
  // Scale to 0 rather than delete: a Deployment replaces a deleted pod within seconds, before a health check notices.
  kubectl('-n', KILL.ns, 'scale', `deploy/${KILL.deploy}`, '--replicas=0');
  kubectl('-n', KILL.ns, 'wait', '--for=delete', 'pod', '-l', `app.kubernetes.io/instance=${KILL.deploy}`, '--timeout=60s');
  const t0 = Date.now();
  const dead = await a.callTool({ name: `${KILL.slug}__echo`, arguments: { text: 'hello?' } }).catch((e) => ({ isError: true, content: [{ type: 'text', text: String(e.message) }] }));
  check(dead.isError && Date.now() - t0 < 8000, `a call to the dead server fails fast with a clear error (${Date.now() - t0} ms): "${String((dead.content as any)[0]?.text).slice(0, 120)}"`);
  const t1 = Date.now();
  const alive = await a.callTool({ name: `${STORE}__list_orders`, arguments: { period: 'today' } });
  check(!alive.isError, `${STORE} keeps working meanwhile (${Date.now() - t1} ms)`);
  const down = await eventually(() => server(KILL.slug), (s) => s?.status === 'unreachable', 60_000);
  check(down?.status === 'unreachable', `dashboard: ${KILL.slug} is Unreachable (${down?.statusReason}: ${String(down?.statusDetail ?? '').slice(0, 80)})`, down);
  check(!(await toolNames(a)).some((n) => n.startsWith(`${KILL.slug}__`)), `its tools are hidden from tools/list while it is down`);
  kubectl('-n', KILL.ns, 'scale', `deploy/${KILL.deploy}`, '--replicas=1');
  const up = await eventually(() => server(KILL.slug), (s) => s?.status === 'connected', 120_000);
  check(up?.status === 'connected', `${KILL.slug} recovers by itself once its pod is back`);

  step('7. Audit log: every call above, attributed to the right user');
  await sleep(500);
  const rows = ((await A.get(`/audit?limit=500&from=${encodeURIComponent(startedAt)}`)).data.events as any[]).reverse();
  const has = (what: string, f: (e: any) => boolean) => check(rows.some(f), what);
  has(`A: create_product via chat (${aUser.email})`, (e) => e.tool === 'create_product' && e.via === 'chat' && e.userEmail === aUser.email && e.outcome === 'success');
  has('A: list_orders via chat', (e) => e.tool === 'list_orders' && e.via === 'chat' && e.userEmail === aUser.email);
  has(`B: list_orders from the MCP client, with B's API key (${bEmail})`, (e) => e.tool === 'list_orders' && e.via === 'mcp' && e.authMethod === 'api_key' && e.userEmail === bEmail && e.outcome === 'success');
  if (other) has(`B: the cross-server calls (${STORE} and ${other})`, (e) => e.userEmail === bEmail && e.server === other);
  has("B: the call with the revoked key (auth_failed, still attributed to B)", (e) => e.outcome === 'auth_failed' && e.userEmail === bEmail);
  // How a call to the dead server fails depends on timing:
  // - "unavailable" if the new connection was refused;
  // - "timeout" if it went down a kept-alive connection to the gone pod's IP, which answers nothing, so the
  //   per-server timeout ends it;
  // - "denied" (unknown tool) if the gateway had already hidden its tools: a modern upstream's dropped listen stream
  //   can reveal the death before the next health check.
  has(`A: the call to the dead server (${KILL.slug}: unavailable or timeout, or denied once its tools were hidden)`,
    (e) => e.server === KILL.slug && e.userEmail === aUser.email && (e.outcome === 'unavailable' || e.outcome === 'timeout' || e.errorCode === 'UNKNOWN_TOOL'));
  const calls = rows.filter((e) => e.tool && e.server !== 'gateway');
  check(calls.every((e) => e.ts && e.server && e.tool && e.outcome && typeof e.durationMs === 'number'), `all ${calls.length} tool-call rows have user, server, tool, time, duration and outcome`);
  console.log('\n     time      user                         via   server  tool                 outcome      ms');
  for (const e of rows.filter((r) => r.server !== 'gateway').slice(-14))
    console.log(`     ${e.ts.slice(11, 19)}  ${String(e.userEmail ?? '-').padEnd(28)} ${String(e.via ?? '-').padEnd(5)} ${String(e.server ?? '-').padEnd(7)} ${String(e.tool ?? '-').padEnd(20)} ${e.outcome.padEnd(12)} ${e.durationMs ?? ''}`);
} finally {
  kubectl('-n', KILL.ns, 'scale', `deploy/${KILL.deploy}`, '--replicas=1');
  const t = await server(DISABLE);
  if (t && !t.enabled) await A.patch(`/servers/${t.id}`, { enabled: true });
  for (const s of parked) await A.patch(`/servers/${s.id}`, { enabled: true });
  await Promise.allSettled([a?.close(), b?.close()]);
}
done();
