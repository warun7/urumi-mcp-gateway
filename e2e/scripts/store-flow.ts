// Bonus: self-service store provisioning, end to end against the cluster (takes ~1-2 minutes).
//   BASE_URL=... ADMIN_EMAIL=... ADMIN_PASSWORD=... tsx scripts/store-flow.ts
import { check, Dashboard, done, eventually, mcpConnect, step, toolNames } from '../lib/api.js';

const BASE = process.env.BASE_URL ?? 'http://localhost:8080';
const MCP = `${BASE}/mcp`;
const A = { name: 'e2e-a', displayName: 'E2E Alpha' };
const B = { name: 'e2e-b', displayName: 'E2E Beta' };
const runId = Date.now().toString(36);

const admin = new Dashboard(BASE);
await admin.login(process.env.ADMIN_EMAIL!, process.env.ADMIN_PASSWORD!);
const first = await admin.get('/stores');
if (first.status === 404) {
  console.log('store provisioning is not enabled on this gateway; skipping');
  process.exit(0);
}

const gone = async (name: string) => (await admin.get(`/stores/${name}`)).status === 404;
async function removeIfPresent(name: string) {
  if (await gone(name)) return;
  await admin.del(`/stores/${name}`);
  await eventually(() => gone(name), (g) => g, 240_000);
}
// A previous run that died half way may have left these behind.
await Promise.all([removeIfPresent(A.name), removeIfPresent(B.name)]);

step('1. Validation and naming');
check((await admin.post('/stores', { name: 'Bad_Name', displayName: 'x' })).status === 400, 'an invalid name is rejected (400)');
check((await admin.post('/stores', { name: 'default', displayName: 'x' })).status === 422, 'a reserved name is rejected (422)');
check((await admin.post('/stores', { name: 'chaos', displayName: 'x' })).status === 409, 'a name already used by an MCP server is rejected (409)');

step('2. Two stores requested at the same time');
const t0 = Date.now();
const [ra, rb] = await Promise.all([admin.post('/stores', A), admin.post('/stores', B)]);
check(ra.status === 201 && rb.status === 201, 'both accepted (201)', [ra.status, rb.status, ra.data, rb.data]);
check((await admin.post('/stores', A)).status === 200, 'asking again for the same store is idempotent (200)');

step('3. Ownership and limits');
const memberEmail = `store-member-${runId}@urumi.test`;
const inv = await admin.post('/invites', { email: memberEmail, role: 'member' });
const member = new Dashboard(BASE);
await member.post(`/invites/${inv.data.link.split('/').pop()}/accept`, { name: 'Sam', password: `pw-${runId}-long-enough` });
const seen = (await member.get('/stores')).data.stores.find((s: any) => s.name === A.name);
check(seen && seen.canManage === false, "a member sees the admin's store but cannot manage it");
check((await member.del(`/stores/${A.name}`)).status === 403, "a member cannot delete someone else's store (403)");
const lim = (await admin.get('/stores')).data.limits;
if (lim.total >= lim.maxTotal) {
  const over = await member.post('/stores', { name: `m-${runId}`.slice(0, 20), displayName: 'One too many' });
  check(over.status === 429, `the platform limit (${lim.maxTotal} stores) is enforced (429)`, over.data);
} else console.log(`  (platform limit not reached: ${lim.total} of ${lim.maxTotal}; skipping the 429 check)`);

step('4. Both become Ready');
const readyAll = await eventually(
  async () => Promise.all([A, B].map(async (s) => (await admin.get(`/stores/${s.name}`)).data.store)),
  (ss) => ss.every((s: any) => s?.phase === 'Ready' || s?.phase === 'Failed'),
  360_000,
);
for (const s of readyAll) check(s.phase === 'Ready', `${s.name} is Ready (${s.phase}${s.reason ? `: ${s.reason} ${s.message}` : ''})`);
console.log(`     both ready ${Math.round((Date.now() - t0) / 1000)} s after the request`);
check(readyAll.every((s: any) => s.conditions.length === 7 && s.conditions.every((c: any) => c.status === 'True')), 'all seven provisioning conditions are True');
const front = await fetch(readyAll[0].url).catch(() => null);
check(front?.ok && (await front.text()).includes(A.displayName), `the storefront answers at ${readyAll[0].url}`);

step('5. Their tools appear for MCP clients and work');
const key = (await admin.post('/keys', { name: `stores e2e ${runId}`, toolMode: 'full' })).data.key as string;
const c = await mcpConnect(MCP, key);
const names = await eventually(() => toolNames(c), (n) => n.includes(`${A.name}__list_orders`) && n.includes(`${B.name}__list_orders`), 30_000);
check(names.includes(`${A.name}__sales_summary`) && names.includes(`${B.name}__sales_summary`), 'e2e-a__* and e2e-b__* tools are listed');
const info = await c.callTool({ name: `${A.name}__get_store_info`, arguments: {} });
const infoJson = JSON.parse((info.content[0] as any).text);
check(!info.isError && infoJson.name === A.displayName, 'e2e-a__get_store_info talks to the right store', infoJson.name);
const sums = await Promise.all([A, B].map((s) => c.callTool({ name: `${s.name}__sales_summary`, arguments: { period: 'today' } })));
const parsed = sums.map((r) => JSON.parse((r.content[0] as any).text));
check(parsed.every((p) => p.currency && p.order_count === 0), 'sales_summary works on both and reports a currency even with no orders', parsed.map((p) => [p.store, p.currency]));

step('6. Deleting a store removes everything');
check((await admin.del(`/stores/${B.name}`)).status === 202, 'delete accepted (202)');
const afterDel = await eventually(() => toolNames(c), (n) => !n.some((x) => x.startsWith(`${B.name}__`)), 20_000);
check(!afterDel.some((x) => x.startsWith(`${B.name}__`)) && afterDel.includes(`${A.name}__list_orders`), "e2e-b's tools disappear; e2e-a's stay");
const t1 = Date.now();
check(await eventually(() => gone(B.name), (g) => g, 240_000), `the Store is gone after its namespace, volumes and release were removed (${Math.round((Date.now() - t1) / 1000)} s)`);
const audit = (await admin.get(`/audit?server=${B.name}&limit=20`)).data.events ?? [];
check(audit.length > 0, 'the audit log still shows the calls made to the deleted store', audit.length);

await c.close();
// Leave the platform as we found it (the store limit is shared with other suites).
await admin.del(`/stores/${A.name}`);
await eventually(() => gone(A.name), (g) => g, 240_000);
done();
