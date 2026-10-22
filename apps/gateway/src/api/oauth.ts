import { Hono } from 'hono';
import { z } from 'zod';
import { isLocalOnly, type OAuthClient } from '../auth/oauth/clients.js';
import { approveRequest, denyRequest } from '../auth/oauth/server.js';
import type { ApiEnv } from '../auth/sessions.js';
import { body, HttpError, iso, type Deps } from './deps.js';

const host = (u: string | null) => {
  try {
    return u ? new URL(u).host : null;
  } catch {
    return null;
  }
};

/** Dashboard side of OAuth: the consent screen and "Connected apps". */
export function oauthApi(d: Deps) {
  const app = new Hono<ApiEnv>();

  app.get('/requests/:id', async (c) => {
    const [r] = await d.sql<(OAuthClient & { redirect_uri: string; scope: string; resource: string })[]>`
      SELECT r.redirect_uri, r.scope, r.resource, c.* FROM oauth_requests r JOIN oauth_clients c ON c.client_id = r.client_id
      WHERE r.id = ${c.req.param('id')} AND r.expires_at > now()`;
    if (!r) throw new HttpError(404, 'this authorization request expired; start again from your app');
    // "Verified" = the client is identified by an https URL it controls (CIMD) AND redirects somewhere other than localhost.
    const verified = r.kind === 'cimd' && !isLocalOnly(r);
    return c.json({
      client: {
        id: r.client_id,
        name: r.client_name ?? 'Unnamed app',
        uri: r.client_uri,
        host: r.kind === 'cimd' ? host(r.client_id) : host(r.client_uri),
        logo: r.logo_uri,
        kind: r.kind,
        verified,
      },
      redirectHost: host(r.redirect_uri),
      scopes: r.scope.split(' '),
      resource: r.resource,
      user: { email: c.get('user').email, role: c.get('user').role },
    });
  });

  app.post('/requests/:id/decision', async (c) => {
    const b = await body(c, z.object({ approve: z.boolean(), toolMode: z.enum(['full', 'search', 'auto']).default('auto') }));
    const redirect = b.approve ? await approveRequest(d, c.req.param('id'), c.get('user').id, b.toolMode) : await denyRequest(d, c.req.param('id'));
    if (!redirect) throw new HttpError(404, 'this authorization request expired; start again from your app');
    d.log.info({ user: c.get('user').email, approved: b.approve }, 'oauth consent decision');
    return c.json({ redirect });
  });

  app.get('/grants', async (c) => {
    const me = c.get('user');
    const all = me.role === 'admin' && c.req.query('all') === '1';
    const rows = await d.sql<{ id: string; user_email: string; client_id: string; client_name: string | null; kind: string; redirect_uris: string[]; scope: string; tool_mode: string; created_at: Date; last_used_at: Date | null; revoked_at: Date | null }[]>`
      SELECT g.id, u.email AS user_email, c.client_id, c.client_name, c.kind, c.redirect_uris, g.scope, g.tool_mode, g.created_at, g.last_used_at, g.revoked_at
      FROM oauth_grants g JOIN oauth_clients c ON c.client_id = g.client_id JOIN users u ON u.id = g.user_id
      WHERE ${all ? d.sql`true` : d.sql`g.user_id = ${me.id}`}
      ORDER BY g.revoked_at NULLS FIRST, g.created_at DESC LIMIT 200`;
    return c.json({
      grants: rows.map((g) => ({
        id: g.id, user: g.user_email, clientName: g.client_name ?? 'Unnamed app', clientId: g.client_id,
        host: g.kind === 'cimd' ? host(g.client_id) : null, verified: g.kind === 'cimd' && !isLocalOnly(g),
        scopes: g.scope.split(' '), toolMode: g.tool_mode, createdAt: iso(g.created_at), lastUsedAt: iso(g.last_used_at), revokedAt: iso(g.revoked_at),
      })),
    });
  });

  app.delete('/grants/:id', async (c) => {
    const me = c.get('user');
    const r = await d.sql`UPDATE oauth_grants SET revoked_at = now() WHERE id = ${c.req.param('id')} AND revoked_at IS NULL
                          AND (user_id = ${me.id} OR ${me.role === 'admin'})`;
    if (!r.count) throw new HttpError(404, 'grant not found');
    await d.bus.publish({ type: 'auth' });
    return c.body(null, 204);
  });

  return app;
}
