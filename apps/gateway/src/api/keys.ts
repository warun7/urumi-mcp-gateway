import { Hono } from 'hono';
import { z } from 'zod';
import type { ApiEnv } from '../auth/sessions.js';
import { newApiKey } from '../crypto/tokens.js';
import { body, HttpError, iso, type Deps } from './deps.js';

interface KeyRow {
  id: string; user_id: string; name: string; tool_mode: string; created_at: Date; last_used_at: Date | null;
  expires_at: Date | null; revoked_at: Date | null; email: string; created_by_email: string | null;
}

const view = (k: KeyRow) => ({
  id: k.id,
  prefix: `ugw_${k.id}_…`,
  name: k.name,
  userId: k.user_id,
  userEmail: k.email,
  createdBy: k.created_by_email,
  toolMode: k.tool_mode,
  createdAt: iso(k.created_at),
  lastUsedAt: iso(k.last_used_at),
  expiresAt: iso(k.expires_at),
  revokedAt: iso(k.revoked_at),
  status: k.revoked_at ? 'revoked' : k.expires_at && k.expires_at < new Date() ? 'expired' : 'active',
});

/**
 * Personal API keys for MCP clients. Members manage their own; admins can see/revoke all and issue keys
 * for a member (shown once to the admin, recorded as "created by").
 */
export function keysApi(d: Deps) {
  const app = new Hono<ApiEnv>();

  app.get('/', async (c) => {
    const me = c.get('user');
    const all = me.role === 'admin' && c.req.query('all') === '1';
    const rows = await d.sql<KeyRow[]>`
      SELECT k.*, u.email, cb.email AS created_by_email FROM api_keys k
      JOIN users u ON u.id = k.user_id LEFT JOIN users cb ON cb.id = k.created_by
      WHERE ${all ? d.sql`true` : d.sql`k.user_id = ${me.id}`}
      ORDER BY k.revoked_at NULLS FIRST, k.created_at DESC`;
    return c.json({ keys: rows.map(view) });
  });

  app.post('/', async (c) => {
    const me = c.get('user');
    const b = await body(c, z.object({
      name: z.string().min(1).max(60),
      toolMode: z.enum(['full', 'search', 'auto']).default('full'),
      expiresInDays: z.number().int().min(1).max(365).optional(),
      userId: z.string().uuid().optional(),
    }));
    const owner = b.userId ?? me.id;
    if (owner !== me.id && me.role !== 'admin') throw new HttpError(403, 'only admins can issue keys for other members');
    const [u] = await d.sql<{ status: string }[]>`SELECT status FROM users WHERE id = ${owner}`;
    if (!u || u.status !== 'active') throw new HttpError(404, 'member not found or disabled');
    const k = newApiKey();
    await d.sql`
      INSERT INTO api_keys (id, user_id, name, secret_hmac, tool_mode, created_by, expires_at)
      VALUES (${k.id}, ${owner}, ${b.name}, ${d.hasher.hash(k.secret)}, ${b.toolMode}, ${me.id},
              ${b.expiresInDays ? new Date(Date.now() + b.expiresInDays * 86_400_000) : null})`;
    d.log.info({ keyId: k.id, owner, by: me.email }, 'api key created');
    // The only time the full key exists outside the client: it is not stored and cannot be shown again.
    return c.json({ id: k.id, key: k.full, mcpUrl: d.cfg.resource }, 201);
  });

  app.patch('/:id', async (c) => {
    const me = c.get('user');
    const b = await body(c, z.object({ toolMode: z.enum(['full', 'search', 'auto']).optional(), name: z.string().min(1).max(60).optional() }));
    const r = await d.sql`
      UPDATE api_keys SET tool_mode = COALESCE(${b.toolMode ?? null}, tool_mode), name = COALESCE(${b.name ?? null}, name)
      WHERE id = ${c.req.param('id')} AND (user_id = ${me.id} OR ${me.role === 'admin'})`;
    if (!r.count) throw new HttpError(404, 'key not found');
    await d.bus.publish({ type: 'auth' });
    return c.json({ ok: true });
  });

  /** Revocation is immediate: every replica drops its auth cache on the NOTIFY. */
  app.delete('/:id', async (c) => {
    const me = c.get('user');
    const r = await d.sql`
      UPDATE api_keys SET revoked_at = now(), revoked_by = ${me.id}
      WHERE id = ${c.req.param('id')} AND revoked_at IS NULL AND (user_id = ${me.id} OR ${me.role === 'admin'})`;
    if (!r.count) throw new HttpError(404, 'key not found or already revoked');
    await d.bus.publish({ type: 'auth' });
    d.log.info({ keyId: c.req.param('id'), by: me.email }, 'api key revoked');
    return c.body(null, 204);
  });

  return app;
}
