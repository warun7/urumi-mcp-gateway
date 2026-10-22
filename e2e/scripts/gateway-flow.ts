// The assignment's "definition of done" for the gateway, as an executable script.
//   BASE=https://app.127.0.0.1.nip.io ADMIN_EMAIL=... ADMIN_PASSWORD=... tsx scripts/gateway-flow.ts
import { execFileSync } from 'node:child_process';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { check, Dashboard, done, eventually, mcpConnect, mcpStatus, step, toolNames } from '../lib/api.js';

const BASE = process.env.BASE_URL ?? 'http://localhost:8080';
const MCP = `${BASE}/mcp`;
const STORE = process.env.STORE_SLUG ?? 'woo';
const runId = Date.now().toString(36);

const admin = new Dashboard(BASE);
step('1. User A (admin) signs in and creates an API key');
await admin.login(process.env.ADMIN_EMAIL!, process.env.ADMIN_PASSWORD!);
const aKey = (await admin.post('/keys', { name: `e2e admin ${runId}` })).data.key as string;
check(aKey?.startsWith('ugw_'), 'admin API key issued (shown once)');

step('2. User A invites user B (member); B accepts and creates a key');
const bEmail = `member-${runId}@urumi.test`;
const inv = await admin.post('/invites', { email: bEmail, role: 'member' });
check(inv.status === 201, 'invite link created', inv.data);
const member = new Dashboard(BASE);
const acc = await member.post(`/invites/${inv.data.link.split('/').pop()}/accept`, { name: 'Bea', password: `pw-${runId}-long-enough` });
check(acc.status === 201, 'member accepted the invite', acc.data);
const bKey = (await member.post('/keys', { name: 'e2e member' })).data.key as string;
check(bKey?.startsWith('ugw_'), 'member API key issued');
check((await member.get('/members')).status === 403, 'member cannot use admin APIs');

step('3. Registered servers are connected');
const servers = (await admin.get('/servers')).data.servers as any[];
for (const s of servers) console.log(`     ${s.slug.padEnd(10)} ${s.status.padEnd(12)} era=${s.protocolEra} tools=${s.tools?.active}`);
const store = servers.find((s) => s.slug === STORE);
check(store?.status === 'connected', `store server "${STORE}" is connected`, store);

step('4. User A, from an MCP client, creates a product (visible on the storefront)');
const a = await mcpConnect(MCP, aKey);
const aTools = await toolNames(a);
check(aTools.includes(`${STORE}__create_product`), 'admin sees the write tools', aTools);
const sku = `E2E-${runId}`.toUpperCase();
const created = await a.callTool({ name: `${STORE}__create_product`, arguments: { name: `E2E Product ${runId}`, regular_price: '123.00', sku } });
const product = (created.structuredContent as any)?.product;
check(!created.isError && product?.id, 'product created', created.content);
if (product?.permalink) {
  const page = await fetch(product.permalink).then((r) => r.status).catch(() => 0);
  check(page === 200, `product page is live: ${product.permalink}`, page);
}

step('5. User B (member) asks about today\'s orders; write tools are invisible and refused');
const b = await mcpConnect(MCP, bKey, 'legacy');
const bTools = await toolNames(b);
check(bTools.includes(`${STORE}__list_orders`) && !bTools.includes(`${STORE}__create_product`), 'member sees read tools only', bTools);
const orders = await b.callTool({ name: `${STORE}__list_orders`, arguments: { period: 'today' } });
check(!orders.isError, `member listed today's orders (${(orders.structuredContent as any)?.total ?? '?'} found)`, orders.content);
const denied = await b.callTool({ name: `${STORE}__create_product`, arguments: { name: 'x', regular_price: '1' } }).then(() => 'allowed', (e) => String(e.message));
check(/Unknown tool/.test(denied), 'member calling a write tool gets "Unknown tool"', denied);

step('6. Disabling a server hides its tools for everyone; re-enabling restores them');
// A modern client holding a subscriptions/listen stream should be told immediately (push, not poll).
let pushed = 0;
const listener = new Client({ name: 'urumi-e2e-listener', version: '0.1.0' }, {
  versionNegotiation: { mode: 'auto' },
  listChanged: { tools: { onChanged: () => void pushed++ } },
});
await listener.connect(new StreamableHTTPClientTransport(new URL(MCP), { requestInit: { headers: { authorization: `Bearer ${aKey}` } } }));
await new Promise((r) => setTimeout(r, 500));
await admin.patch(`/servers/${store.id}`, { enabled: false });
const hidden = await eventually(() => toolNames(a), (t) => !t.some((n) => n.startsWith(`${STORE}__`)), 10_000);
check(!hidden.some((n) => n.startsWith(`${STORE}__`)), 'tools gone after disable');
await eventually(async () => pushed, (n) => n > 0, 5_000);
check(pushed > 0, 'listening client received notifications/tools/list_changed', { pushed });
await listener.close();
await admin.patch(`/servers/${store.id}`, { enabled: true });
const back = await eventually(() => toolNames(a), (t) => t.includes(`${STORE}__list_orders`), 30_000);
check(back.includes(`${STORE}__list_orders`), 'tools back after re-enable');

step('7. Many tools: a search-mode key finds the right tool');
const sKey = (await admin.post('/keys', { name: 'e2e search', toolMode: 'search' })).data.key as string;
const s = await mcpConnect(MCP, sKey);
const sTools = await toolNames(s);
check(sTools.includes('gateway__search_tools') && !sTools.includes(`${STORE}__list_orders`), 'search mode lists meta-tools only', sTools);
const hit = await s.callTool({ name: 'gateway__search_tools', arguments: { query: 'how much revenue did we make today' } });
const names = ((hit.structuredContent as any)?.results ?? []).map((r: any) => r.name);
// No store named, so any store's sales_summary is right (equal scores tie-break by name: acme before woo).
check(names.slice(0, 3).some((n: string) => n.endsWith('__sales_summary')), 'sales_summary in top 3 for a revenue question', names);

step('8. Revoking B\'s key takes effect immediately');
await member.del(`/keys/${bKey.split('_')[1]}`);
const st = await eventually(() => mcpStatus(MCP, bKey), (x) => x === 401, 10_000);
check(st === 401, 'revoked key gets HTTP 401');

step('9. Audit log attributes every call to the right user');
const audit = (await admin.get(`/audit?limit=200`)).data.events as any[];
const mine = audit.filter((e) => e.userEmail === bEmail || e.userId);
check(audit.some((e) => e.tool === 'create_product' && e.outcome === 'success' && e.userEmail === process.env.ADMIN_EMAIL), 'A\'s create_product recorded as success');
check(audit.some((e) => e.userEmail === bEmail && e.tool === 'list_orders' && e.outcome === 'success'), 'B\'s list_orders recorded');
check(audit.some((e) => e.userEmail === bEmail && e.tool === 'create_product' && e.outcome === 'denied'), 'B\'s denied attempt recorded');
check(audit.some((e) => e.outcome === 'auth_failed' && e.credentialId === bKey.split('_')[1]), 'revoked-key attempt recorded against B\'s key');
check((await member.get('/audit')).data.events?.every((e: any) => e.userEmail === bEmail || e.userEmail === null), 'member only sees their own audit rows');
void mine;

step('10. Per-user rate limit: a member flooding tool calls is throttled; everyone else is unaffected');
// The budget (gateway.rateLimitPerMinute, default 120) is per replica, so flood until the first refusal instead of
// assuming a count. Unknown tool names spend it too (it's checked before the lookup), which keeps the upstreams idle.
const b2 = await mcpConnect(MCP, (await member.post('/keys', { name: 'e2e flood' })).data.key as string);
let sent = 0;
let refusal: any;
while (!refusal && sent < 1500) {
  const batch = await Promise.all(Array.from({ length: 25 }, () => b2.callTool({ name: 'nope__probe', arguments: {} }).catch((e) => e)));
  sent += batch.length;
  refusal = batch.find((r: any) => r?.isError && /^Rate limit/.test(r.content?.[0]?.text ?? ''));
}
check(refusal && sent >= 120, `throttled after ~${sent} calls: "${refusal?.content?.[0]?.text}"`);
const other = await a.callTool({ name: `${STORE}__get_store_info`, arguments: {} });
check(!other.isError, 'the admin\'s calls still go through meanwhile');
const limited = (await admin.get(`/audit?outcome=rate_limited&user=${encodeURIComponent(bEmail)}&limit=5`)).data.events as any[];
check(limited.length > 0 && limited[0].errorCode === 'RATE_LIMITED', 'refusals are in the audit log as rate_limited, under the member');

step('11. Upstream credentials never reach the browser or an MCP client');
// The chaos server's real credential, from its own Secret: it must not appear in anything the gateway sends out.
const secret = Buffer.from(execFileSync('kubectl', ['-n', 'mcp-servers', 'get', 'secret', 'chaos-auth', '-o', 'jsonpath={.data.token}'], { encoding: 'utf8' }), 'base64').toString('utf8');
const chaos = servers.find((x) => x.slug === 'chaos');
check(secret.length >= 8 && chaos?.credentialSet === true, 'the chaos server has a stored credential');
const bodies = [
  (await admin.get('/servers')).data,
  (await admin.get(`/servers/${chaos?.id}`)).data,
  (await member.get('/servers')).data,
  (await admin.get('/audit?limit=200')).data,
  await a.listTools(),
  await a.callTool({ name: 'chaos__echo', arguments: { text: 'hello' } }),
].map((v) => JSON.stringify(v));
check(bodies.every((body) => !body.includes(secret)), 'the credential is in no API response (admin or member), tool list, tool result or audit row');

await Promise.allSettled([a.close(), b.close(), b2.close(), s.close()]);
done();
