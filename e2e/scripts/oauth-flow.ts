// OAuth 2.1 flow against the gateway, the way an MCP client (Claude Code, Inspector) does it.
//   BASE=... ADMIN_EMAIL=... ADMIN_PASSWORD=... tsx scripts/oauth-flow.ts
import { createHash, randomBytes } from 'node:crypto';
import { check, Dashboard, done, mcpConnect, mcpStatus, step, toolNames } from '../lib/api.js';

const BASE = process.env.BASE_URL ?? 'http://localhost:8080';
const MCP = `${BASE}/mcp`;
const REDIRECT = 'http://127.0.0.1:33418/callback';
const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
const post = (path: string, body: Record<string, string>) =>
  fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form(body) }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) as any }));

step('1. Discovery: 401 -> protected resource metadata -> authorization server metadata');
const unauth = await fetch(MCP, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
const wwwAuth = unauth.headers.get('www-authenticate') ?? '';
check(unauth.status === 401 && /resource_metadata="/.test(wwwAuth), '401 carries WWW-Authenticate with resource_metadata', wwwAuth);
const prmUrl = /resource_metadata="([^"]+)"/.exec(wwwAuth)?.[1]!;
const prm: any = await fetch(prmUrl).then((r) => r.json());
check(prm.resource === MCP && prm.authorization_servers?.[0] === BASE, 'RFC 9728 metadata names the resource and the AS', prm);
const as: any = await fetch(`${prm.authorization_servers[0]}/.well-known/oauth-authorization-server`).then((r) => r.json());
check(as.code_challenge_methods_supported?.includes('S256') && as.client_id_metadata_document_supported, 'RFC 8414 metadata: PKCE S256, CIMD supported', as);

step('2. Dynamic client registration (fallback for clients without a CIMD URL)');
const reg: any = await fetch(as.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'E2E Test Client', redirect_uris: [REDIRECT] }) }).then((r) => r.json());
check(reg.client_id?.startsWith('dcr_'), 'client registered', reg);
const badReg = await fetch(as.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://evil.example/cb'] }) });
check(badReg.status === 400, 'non-loopback http redirect_uri rejected');

step('3. Authorization request with PKCE -> login + consent -> code');
const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const state = randomBytes(8).toString('hex');
const authUrl = new URL(as.authorization_endpoint);
for (const [k, v] of Object.entries({ response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state, scope: 'mcp:tools', resource: MCP })) authUrl.searchParams.set(k, v);
const noPkce = new URL(authUrl); noPkce.searchParams.delete('code_challenge');
const r0 = await fetch(noPkce, { redirect: 'manual' });
check(/error=invalid_request/.test(r0.headers.get('location') ?? ''), 'request without PKCE is refused');
const wrongRes = new URL(authUrl); wrongRes.searchParams.set('resource', 'https://other.example/mcp');
check(/error=invalid_target/.test((await fetch(wrongRes, { redirect: 'manual' })).headers.get('location') ?? ''), 'token for a different resource is refused');
const badRedirect = new URL(authUrl); badRedirect.searchParams.set('redirect_uri', 'http://127.0.0.1:1/evil');
const r1 = await fetch(badRedirect, { redirect: 'manual' });
check(r1.status === 400 && !r1.headers.get('location'), 'unregistered redirect_uri shows an error page, never redirects');

const r = await fetch(authUrl, { redirect: 'manual' });
const consentUrl = new URL(r.headers.get('location')!);
check(consentUrl.pathname === '/consent', 'authorize redirects the browser to the consent screen', consentUrl.toString());
const reqId = consentUrl.searchParams.get('request')!;
const user = new Dashboard(BASE);
await user.login(process.env.ADMIN_EMAIL!, process.env.ADMIN_PASSWORD!);
const details = await user.get(`/oauth/requests/${reqId}`);
check(details.data.client?.name === 'E2E Test Client' && details.data.client.verified === false, 'consent screen shows the client as unverified (DCR, localhost redirect)', details.data);
const decision = await user.post(`/oauth/requests/${reqId}/decision`, { approve: true, toolMode: 'full' });
const back = new URL(decision.data.redirect);
check(back.origin + back.pathname === REDIRECT && back.searchParams.get('state') === state && back.searchParams.get('iss') === BASE, 'redirect back carries code, state and iss (RFC 9207)', decision.data);
const code = back.searchParams.get('code')!;

step('4. Token exchange');
const wrongVerifier = await post('/oauth/token', { grant_type: 'authorization_code', code, code_verifier: 'x'.repeat(43), client_id: reg.client_id, redirect_uri: REDIRECT });
check(wrongVerifier.status === 400 && wrongVerifier.data.error === 'invalid_grant', 'wrong PKCE verifier rejected (and the code is now burned)');
// The failed attempt consumed the code (single use). Run the flow again for a fresh code.
const r2 = await fetch(authUrl, { redirect: 'manual' });
const reqId2 = new URL(r2.headers.get('location')!).searchParams.get('request')!;
const code2 = new URL((await user.post(`/oauth/requests/${reqId2}/decision`, { approve: true, toolMode: 'full' })).data.redirect).searchParams.get('code')!;
const tok = await post('/oauth/token', { grant_type: 'authorization_code', code: code2, code_verifier: verifier, client_id: reg.client_id, redirect_uri: REDIRECT, resource: MCP });
check(tok.status === 200 && tok.data.access_token?.startsWith('uat_') && tok.data.refresh_token, 'access + refresh token issued', tok.data);
const replay = await post('/oauth/token', { grant_type: 'authorization_code', code: code2, code_verifier: verifier, client_id: reg.client_id, redirect_uri: REDIRECT });
check(replay.status === 400, 'replayed code rejected');
check((await mcpStatus(MCP, tok.data.access_token)) === 401, 'code replay revoked the whole grant (RFC 6749 §4.1.2)');

step('5. Fresh grant: use the token for MCP, rotate, detect refresh-token reuse');
const r3 = await fetch(authUrl, { redirect: 'manual' });
const reqId3 = new URL(r3.headers.get('location')!).searchParams.get('request')!;
const code3 = new URL((await user.post(`/oauth/requests/${reqId3}/decision`, { approve: true, toolMode: 'full' })).data.redirect).searchParams.get('code')!;
const t3 = (await post('/oauth/token', { grant_type: 'authorization_code', code: code3, code_verifier: verifier, client_id: reg.client_id, redirect_uri: REDIRECT })).data;
const client = await mcpConnect(MCP, t3.access_token);
const tools = await toolNames(client);
check(tools.length > 1, `MCP works with the OAuth token (${tools.length} tools)`);
const info = await client.callTool({ name: 'woo__get_store_info', arguments: {} });
check(!info.isError, 'tool call with the OAuth token succeeds');
await client.close();
const rot = await post('/oauth/token', { grant_type: 'refresh_token', refresh_token: t3.refresh_token, client_id: reg.client_id });
check(rot.status === 200 && rot.data.refresh_token !== t3.refresh_token, 'refresh rotates the refresh token');
const reuse = await post('/oauth/token', { grant_type: 'refresh_token', refresh_token: t3.refresh_token, client_id: reg.client_id });
check(reuse.status === 400, 'old refresh token reuse rejected');
check((await mcpStatus(MCP, rot.data.access_token)) === 401, 'reuse revoked the whole token family');

step('6. Connected apps: the user can see and revoke grants');
const grants = (await user.get('/oauth/grants')).data.grants as any[];
check(grants.some((g) => g.clientName === 'E2E Test Client'), 'grant listed under Connected apps');
const audit = (await user.get('/audit?limit=50')).data.events as any[];
check(audit.some((e) => e.authMethod === 'oauth' && e.client === 'E2E Test Client' && e.tool === 'get_store_info'), 'oauth calls appear in audit with the client name', audit.slice(0, 3));
done();
