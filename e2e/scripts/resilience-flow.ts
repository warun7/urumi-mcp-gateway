// Failure handling, security quarantine and many-tools behaviour, against the testkit servers.
//   BASE_URL=... ADMIN_EMAIL=... ADMIN_PASSWORD=... [CHAOS_ADMIN_URL=http://...:18191] tsx scripts/resilience-flow.ts
import { check, Dashboard, done, eventually, mcpConnect, step, toolNames } from '../lib/api.js';

const BASE = process.env.BASE_URL ?? 'http://localhost:8080';
const MCP = `${BASE}/mcp`;
const admin = new Dashboard(BASE);
await admin.login(process.env.ADMIN_EMAIL!, process.env.ADMIN_PASSWORD!);
const key = (await admin.post('/keys', { name: 'resilience e2e', toolMode: 'full' })).data.key as string;
const c = await mcpConnect(MCP, key);
const servers = async () => (await admin.get('/servers')).data.servers as any[];

step('1. Name collisions: two servers with list_products stay distinct');
const names = await toolNames(c);
check(names.includes('woo__list_products') && names.includes('erp__list_products'), 'woo__list_products and erp__list_products both listed');

step('2. Timeouts are per upstream and do not affect other servers');
const t0 = Date.now();
const slow = c.callTool({ name: 'chaos__sleep', arguments: { ms: 10_000 } });
const fast = await c.callTool({ name: 'woo__get_store_info', arguments: {} });
check(!fast.isError && Date.now() - t0 < 3000, `woo answered while chaos was hanging (${Date.now() - t0} ms)`);
const slowRes = await slow;
const slowText = (slowRes.content[0] as any)?.text ?? '';
check(slowRes.isError && /did not answer .* within 3000 ms/.test(slowText), 'chaos__sleep returned a timeout tool error after the 3 s limit', slowText);

step('3. Upstream tool errors are passed through as tool errors');
const f = await c.callTool({ name: 'chaos__fail', arguments: { message: 'kaput' } });
check(f.isError && /kaput/.test((f.content[0] as any).text), 'isError result passed through');

step('4. Tool poisoning: a flagged tool is quarantined (not listed, not callable)');
check(!names.includes('evil__get_weather') && names.includes('evil__get_time'), 'evil__get_weather hidden, evil__get_time available');
const ev = (await servers()).find((s) => s.slug === 'evil');
const detail = (await admin.get(`/servers/${ev.id}`)).data.tools as any[];
const gw = detail.find((t) => t.name === 'get_weather');
check(gw?.state === 'pending_new' && gw.flags.includes('secret_exfiltration'), 'dashboard shows it pending with flags', gw?.flags);

step('5. Rug pull: a tool whose definition changes after approval is hidden until re-approved');
if (process.env.CHAOS_ADMIN_URL) {
  const chaosAdmin = (q = '') => fetch(`${process.env.CHAOS_ADMIN_URL}/admin/rugpull${q}`, { method: 'POST' });
  const ch = (await servers()).find((s) => s.slug === 'chaos');
  const echoTool = async () => ((await admin.get(`/servers/${ch.id}`)).data.tools as any[]).find((t) => t.name === 'echo');
  // Put echo back to its original definition and make that the approved one. Reverting is itself a definition
  // change (the last approval was for the rug-pulled text), so a previous run leaves it pending re-approval.
  const baseline = async () => {
    await chaosAdmin('?undo=1');
    await admin.post(`/servers/${ch.id}/check`);
    if ((await echoTool())?.state !== 'active') await admin.patch(`/servers/${ch.id}/tools/echo`, { approve: true });
    await eventually(() => toolNames(c), (n) => n.includes('chaos__echo'), 10_000);
  };
  await baseline();
  await chaosAdmin();
  // No nudge: the upstream pushes notifications/tools/list_changed and the gateway re-syncs on its own.
  const t1 = Date.now();
  const after = await eventually(() => toolNames(c), (n) => !n.includes('chaos__echo'), 15_000);
  check(!after.includes('chaos__echo'), `chaos__echo hidden after its description changed (${Date.now() - t1} ms, via list_changed push)`);
  const echo = await echoTool();
  check(echo?.state === 'pending_changed' && echo.previous?.description, 'dashboard can show the before/after diff', echo?.state);
  await admin.patch(`/servers/${ch.id}/tools/echo`, { approve: true });
  const again = await eventually(() => toolNames(c), (n) => n.includes('chaos__echo'), 10_000);
  check(again.includes('chaos__echo'), 'listed again after the admin re-approves');
  await baseline();
} else console.log('  (skipped: set CHAOS_ADMIN_URL)');

step('6. Many tools: auto mode switches to search above the threshold');
const auto = (await admin.post('/keys', { name: 'auto e2e', toolMode: 'auto' })).data.key as string;
const ac = await mcpConnect(MCP, auto);
const autoNames = await toolNames(ac);
check(autoNames.length < 20 && autoNames.includes('gateway__search_tools'), `auto mode lists ${autoNames.length} tools instead of ${names.length}`);
const q = await ac.callTool({ name: 'gateway__search_tools', arguments: { query: 'refund a customer invoice' } });
const hits = ((q.structuredContent as any)?.results ?? []).map((r: any) => r.name);
check(hits.slice(0, 3).some((n: string) => /billing_.*refund|billing_.*invoice/.test(n)), 'search finds billing tools for "refund a customer invoice"', hits);
const viaMeta = await ac.callTool({ name: 'gateway__call_tool', arguments: { name: 'woo__get_store_info', arguments: {} } });
check(!viaMeta.isError, 'gateway__call_tool routes to the real tool');
const direct = await ac.callTool({ name: 'woo__get_store_info', arguments: {} });
check(!direct.isError, 'unlisted tools stay callable by name in search mode');
const listBytes = JSON.stringify(names).length;
console.log(`     full tools/list names only: ${names.length} tools; search mode: ${autoNames.length} tools (~${listBytes} bytes of names alone)`);

await Promise.allSettled([c.close(), ac.close()]);
done();
