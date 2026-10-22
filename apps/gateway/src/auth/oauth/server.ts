import { createHash, randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import type { Deps } from '../../api/deps.js';
import { randomToken } from '../../crypto/tokens.js';
import { SCOPE_TOOLS } from '../bearer.js';
import { clientIp, RateLimiter } from '../sessions.js';
import { OAuthClientError, resolveClient, validateRedirectUri } from './clients.js';
import { CODE_TTL_S, issueTokenPair } from './tokens.js';

export const SUPPORTED_SCOPES = [SCOPE_TOOLS];

const pkceS256 = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');
const normResource = (r: string) => r.replace(/\/+$/, '');

/**
 * The gateway is both the OAuth 2.1 Authorization Server and the Resource Server for /mcp
 * (MCP authorization spec). Login and consent reuse the dashboard's users and sessions.
 *
 * Security properties (each one maps to a known attack):
 *  - exact redirect_uri match ............... open redirect / code theft
 *  - PKCE S256 required ..................... authorization-code interception
 *  - `iss` in the redirect (RFC 9207) ....... AS mix-up
 *  - `resource` bound into tokens (RFC 8707)  token replay against another API
 *  - single-use codes; reuse revokes grant .. code replay
 *  - rotating refresh tokens + reuse detection (revokes the family)
 *  - per-client consent screen .............. confused deputy
 *  - opaque tokens never forwarded upstream . token passthrough
 */
export function oauthServer(d: Deps) {
  const app = new Hono();
  const { cfg, sql, hasher, log } = d;
  const registerLimiter = new RateLimiter(20, 3600_000);
  const tokenLimiter = new RateLimiter(120, 60_000);
  const ip = (c: Context) => clientIp(c);

  // Browser-based MCP clients (e.g. MCP Inspector) call these cross-origin. No cookies are involved, so * is safe.
  const publicCors = cors({ origin: '*', allowHeaders: ['content-type', 'authorization', 'mcp-protocol-version'], exposeHeaders: ['www-authenticate'] });
  app.use('/.well-known/*', publicCors);
  app.use('/oauth/token', publicCors);
  app.use('/oauth/register', publicCors);
  app.use('/oauth/revoke', publicCors);

  // ---- discovery
  const prm = (c: Context) =>
    c.json({
      resource: cfg.resource,
      authorization_servers: [cfg.issuer],
      scopes_supported: SUPPORTED_SCOPES,
      bearer_methods_supported: ['header'],
      resource_name: 'Urumi MCP Gateway',
      resource_documentation: `${cfg.PUBLIC_BASE_URL}/`,
    });
  app.get('/.well-known/oauth-protected-resource/mcp', prm);
  app.get('/.well-known/oauth-protected-resource', prm);

  const asMetadata = (c: Context) =>
    c.json({
      issuer: cfg.issuer,
      authorization_endpoint: `${cfg.issuer}/oauth/authorize`,
      token_endpoint: `${cfg.issuer}/oauth/token`,
      registration_endpoint: `${cfg.issuer}/oauth/register`,
      revocation_endpoint: `${cfg.issuer}/oauth/revoke`,
      scopes_supported: SUPPORTED_SCOPES,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });
  app.get('/.well-known/oauth-authorization-server', asMetadata);
  app.get('/.well-known/openid-configuration', asMetadata);

  // ---- authorization endpoint
  const errorPage = (c: Context, msg: string) =>
    c.html(`<!doctype html><meta charset="utf-8"><title>Authorization error</title><body style="font-family:system-ui;max-width:40rem;margin:4rem auto">
      <h1>Can't authorize this app</h1><p>${msg.replace(/[<>&"]/g, (ch) => `&#${ch.charCodeAt(0)};`)}</p></body>`, 400);

  app.get('/oauth/authorize', async (c) => {
    const q = c.req.query();
    if (!q.client_id) return errorPage(c, 'client_id is missing.');
    let client;
    try {
      client = await resolveClient(sql, q.client_id);
    } catch (err) {
      return errorPage(c, err instanceof OAuthClientError ? err.message : 'Could not resolve the client.');
    }
    // Until redirect_uri is validated we must not redirect anywhere: show an error page instead.
    const redirectUri = q.redirect_uri ?? (client.redirect_uris.length === 1 ? client.redirect_uris[0] : undefined);
    if (!redirectUri || !client.redirect_uris.includes(redirectUri)) return errorPage(c, 'redirect_uri does not exactly match one registered by this client.');

    const back = (params: Record<string, string>) => {
      const u = new URL(redirectUri);
      for (const [k, v] of Object.entries({ ...params, ...(q.state ? { state: q.state } : {}), iss: cfg.issuer })) u.searchParams.set(k, v);
      return c.redirect(u.toString(), 302);
    };
    if (q.response_type !== 'code') return back({ error: 'unsupported_response_type' });
    if (!q.code_challenge || q.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(q.code_challenge))
      return back({ error: 'invalid_request', error_description: 'PKCE with code_challenge_method=S256 is required' });
    const resource = normResource(q.resource ?? cfg.resource);
    if (resource !== normResource(cfg.resource))
      return back({ error: 'invalid_target', error_description: `this server only issues tokens for ${cfg.resource}` });
    const scopes = (q.scope ?? SCOPE_TOOLS).split(' ').filter(Boolean);
    if (!scopes.length || scopes.some((s) => !SUPPORTED_SCOPES.includes(s))) return back({ error: 'invalid_scope' });

    const id = randomToken(24);
    await sql`
      INSERT INTO oauth_requests (id, client_id, redirect_uri, state, code_challenge, scope, resource, expires_at)
      VALUES (${id}, ${client.client_id}, ${redirectUri}, ${q.state ?? null}, ${q.code_challenge}, ${scopes.join(' ')}, ${cfg.resource},
              ${new Date(Date.now() + 10 * 60_000)})`;
    await sql`DELETE FROM oauth_requests WHERE expires_at < now()`;
    // The dashboard handles login (if needed) and the consent screen, then calls /api/oauth/requests/:id/decision.
    return c.redirect(`${cfg.PUBLIC_BASE_URL}/consent?request=${id}`, 302);
  });

  // ---- token endpoint
  const tokenError = (c: Context, error: string, description?: string, status: 400 | 401 = 400) =>
    c.json({ error, ...(description ? { error_description: description } : {}) }, status, { 'cache-control': 'no-store' });

  app.post('/oauth/token', async (c) => {
    if (!tokenLimiter.take(ip(c))) return tokenError(c, 'slow_down');
    const f = (await c.req.parseBody()) as Record<string, string>;
    if (f.resource && normResource(f.resource) !== normResource(cfg.resource)) return tokenError(c, 'invalid_target');

    if (f.grant_type === 'authorization_code') {
      if (!f.code || !f.code_verifier || !f.client_id) return tokenError(c, 'invalid_request', 'code, code_verifier and client_id are required');
      // Atomic single-use: only one request can flip used_at.
      const [code] = await sql<{ grant_id: string; redirect_uri: string; code_challenge: string; scope: string; resource: string; expires_at: Date }[]>`
        UPDATE oauth_codes SET used_at = now() WHERE code_hash = ${hasher.hash(f.code)} AND used_at IS NULL
        RETURNING grant_id, redirect_uri, code_challenge, scope, resource, expires_at`;
      if (!code) {
        const [reused] = await sql<{ grant_id: string }[]>`SELECT grant_id FROM oauth_codes WHERE code_hash = ${hasher.hash(f.code)}`;
        if (reused) {
          // RFC 6749 §4.1.2: a replayed code means it leaked; revoke everything issued from it.
          await sql`UPDATE oauth_grants SET revoked_at = now() WHERE id = ${reused.grant_id}`;
          await d.bus.publish({ type: 'auth' });
          log.warn({ grant: reused.grant_id }, 'authorization code reuse: grant revoked');
        }
        return tokenError(c, 'invalid_grant', 'code is invalid, expired, or already used');
      }
      const [grant] = await sql<{ id: string; user_id: string; client_id: string; revoked_at: Date | null }[]>`
        SELECT id, user_id, client_id, revoked_at FROM oauth_grants WHERE id = ${code.grant_id}`;
      if (!grant || grant.revoked_at) return tokenError(c, 'invalid_grant');
      if (code.expires_at < new Date()) return tokenError(c, 'invalid_grant', 'code expired');
      if (grant.client_id !== f.client_id) return tokenError(c, 'invalid_grant', 'client_id mismatch');
      if ((f.redirect_uri ?? code.redirect_uri) !== code.redirect_uri) return tokenError(c, 'invalid_grant', 'redirect_uri mismatch');
      if (pkceS256(f.code_verifier) !== code.code_challenge) return tokenError(c, 'invalid_grant', 'PKCE verification failed');
      await sql`UPDATE oauth_clients SET last_used_at = now() WHERE client_id = ${grant.client_id}`;
      const tokens = await issueTokenPair(sql, hasher, { grantId: grant.id, userId: grant.user_id, scope: code.scope, resource: code.resource });
      log.info({ client: grant.client_id, user: grant.user_id }, 'oauth tokens issued');
      return c.json(tokens, 200, { 'cache-control': 'no-store' });
    }

    if (f.grant_type === 'refresh_token') {
      if (!f.refresh_token || !f.client_id) return tokenError(c, 'invalid_request', 'refresh_token and client_id are required');
      const h = hasher.hash(f.refresh_token);
      const [old] = await sql<{ grant_id: string; user_id: string; family_id: string; scope: string; resource: string; expires_at: Date; revoked_at: Date | null; used_at: Date | null }[]>`
        SELECT grant_id, user_id, family_id, scope, resource, expires_at, revoked_at, used_at FROM oauth_tokens WHERE token_hash = ${h} AND kind = 'refresh'`;
      if (!old) return tokenError(c, 'invalid_grant');
      if (old.used_at) {
        // Refresh token reuse = it was stolen (or a client bug). Kill the whole rotation family.
        await sql`UPDATE oauth_tokens SET revoked_at = now() WHERE family_id = ${old.family_id} AND revoked_at IS NULL`;
        await d.bus.publish({ type: 'auth' });
        log.warn({ grant: old.grant_id }, 'refresh token reuse detected: token family revoked');
        return tokenError(c, 'invalid_grant', 'refresh token already used');
      }
      if (old.revoked_at || old.expires_at < new Date()) return tokenError(c, 'invalid_grant');
      const [grant] = await sql<{ client_id: string; revoked_at: Date | null; status: string }[]>`
        SELECT g.client_id, g.revoked_at, u.status FROM oauth_grants g JOIN users u ON u.id = g.user_id WHERE g.id = ${old.grant_id}`;
      if (!grant || grant.revoked_at || grant.status !== 'active' || grant.client_id !== f.client_id) return tokenError(c, 'invalid_grant');
      const scope = f.scope ? f.scope.split(' ').filter((s) => old.scope.split(' ').includes(s)).join(' ') : old.scope;
      const [marked] = await sql`UPDATE oauth_tokens SET used_at = now() WHERE token_hash = ${h} AND used_at IS NULL RETURNING 1`;
      if (!marked) return tokenError(c, 'invalid_grant', 'refresh token already used');
      const tokens = await issueTokenPair(sql, hasher, { grantId: old.grant_id, userId: old.user_id, scope, resource: old.resource, familyId: old.family_id });
      return c.json(tokens, 200, { 'cache-control': 'no-store' });
    }

    return tokenError(c, 'unsupported_grant_type');
  });

  // ---- dynamic client registration (RFC 7591). Deprecated in favour of CIMD; kept for older clients.
  app.post('/oauth/register', async (c) => {
    if (!registerLimiter.take(ip(c))) return c.json({ error: 'slow_down' }, 429);
    let m: Record<string, unknown>;
    try {
      m = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_client_metadata', error_description: 'body must be JSON' }, 400);
    }
    const redirects = m.redirect_uris;
    try {
      if (!Array.isArray(redirects) || !redirects.length || redirects.length > 10) throw new OAuthClientError('redirect_uris must be a non-empty array');
      redirects.forEach((r) => validateRedirectUri(String(r)));
      const auth = m.token_endpoint_auth_method ?? 'none';
      if (auth !== 'none') throw new OAuthClientError('only public clients (token_endpoint_auth_method=none) are supported');
      const grants = (m.grant_types as string[] | undefined) ?? ['authorization_code', 'refresh_token'];
      if (!grants.every((g) => g === 'authorization_code' || g === 'refresh_token')) throw new OAuthClientError('unsupported grant_types');
    } catch (err) {
      return c.json({ error: 'invalid_redirect_uri', error_description: (err as Error).message }, 400);
    }
    const clientId = `dcr_${randomUUID()}`;
    const name = typeof m.client_name === 'string' ? m.client_name.slice(0, 100) : null;
    const uri = typeof m.client_uri === 'string' ? m.client_uri.slice(0, 300) : null;
    const doc = { ...m, client_id: clientId, token_endpoint_auth_method: 'none' };
    await sql`
      INSERT INTO oauth_clients (client_id, kind, client_name, client_uri, redirect_uris, metadata)
      VALUES (${clientId}, 'dcr', ${name}, ${uri}, ${redirects as string[]}, ${sql.json(doc as never)})`;
    // Garbage-collect DCR clients that never got a grant.
    await sql`DELETE FROM oauth_clients c WHERE kind = 'dcr' AND created_at < now() - interval '7 days'
              AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = c.client_id)`;
    log.info({ clientId, name }, 'dynamic client registered');
    return c.json({ ...doc, client_id_issued_at: Math.floor(Date.now() / 1000), grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }, 201);
  });

  // ---- revocation (RFC 7009): always 200, so it can't be used to probe which tokens exist.
  app.post('/oauth/revoke', async (c) => {
    const f = (await c.req.parseBody()) as Record<string, string>;
    if (f.token) {
      const h = hasher.hash(f.token);
      const [t] = await sql<{ kind: string; family_id: string | null }[]>`SELECT kind, family_id FROM oauth_tokens WHERE token_hash = ${h}`;
      if (t?.kind === 'refresh' && t.family_id) await sql`UPDATE oauth_tokens SET revoked_at = now() WHERE family_id = ${t.family_id} AND revoked_at IS NULL`;
      else if (t) await sql`UPDATE oauth_tokens SET revoked_at = now() WHERE token_hash = ${h}`;
      if (t) await d.bus.publish({ type: 'auth' });
    }
    return c.body(null, 200);
  });

  return app;
}

/** Called by the consent screen after the user approves: create the grant and a short-lived single-use code. */
export async function approveRequest(d: Deps, requestId: string, userId: string, toolMode: 'full' | 'search' | 'auto') {
  const { sql, hasher, cfg } = d;
  return sql.begin(async (tx) => {
    const [r] = await tx<{ client_id: string; redirect_uri: string; state: string | null; code_challenge: string; scope: string; resource: string }[]>`
      DELETE FROM oauth_requests WHERE id = ${requestId} AND expires_at > now()
      RETURNING client_id, redirect_uri, state, code_challenge, scope, resource`;
    if (!r) return null;
    const [g] = await tx<{ id: string }[]>`
      INSERT INTO oauth_grants (user_id, client_id, scope, resource, tool_mode) VALUES (${userId}, ${r.client_id}, ${r.scope}, ${r.resource}, ${toolMode}) RETURNING id`;
    const code = randomToken(32);
    await tx`
      INSERT INTO oauth_codes (code_hash, grant_id, redirect_uri, code_challenge, scope, resource, expires_at)
      VALUES (${hasher.hash(code)}, ${g!.id}, ${r.redirect_uri}, ${r.code_challenge}, ${r.scope}, ${r.resource}, ${new Date(Date.now() + CODE_TTL_S * 1000)})`;
    const u = new URL(r.redirect_uri);
    u.searchParams.set('code', code);
    if (r.state) u.searchParams.set('state', r.state);
    u.searchParams.set('iss', cfg.issuer);
    return u.toString();
  });
}

export async function denyRequest(d: Deps, requestId: string) {
  const [r] = await d.sql<{ redirect_uri: string; state: string | null }[]>`DELETE FROM oauth_requests WHERE id = ${requestId} RETURNING redirect_uri, state`;
  if (!r) return null;
  const u = new URL(r.redirect_uri);
  u.searchParams.set('error', 'access_denied');
  if (r.state) u.searchParams.set('state', r.state);
  u.searchParams.set('iss', d.cfg.issuer);
  return u.toString();
}
