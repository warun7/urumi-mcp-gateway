import { Hono } from 'hono';
import { z } from 'zod';
import { requireAdmin, type ApiEnv } from '../auth/sessions.js';
import type { Role } from '../auth/principal.js';
import { body, HttpError, type Deps } from './deps.js';

export function permissionsApi(d: Deps) {
  const app = new Hono<ApiEnv>();

  app.get('/', requireAdmin, async (c) => {
    const rows = await d.sql`SELECT p.*, u.email AS subject_email FROM permissions p
                             LEFT JOIN users u ON p.subject_type = 'user' AND u.id::text = p.subject ORDER BY p.created_at`;
    return c.json({ rules: rows });
  });

  app.post('/', requireAdmin, async (c) => {
    const b = await body(c, z.object({
      subjectType: z.enum(['role', 'user']),
      subject: z.string().min(1).max(100),
      server: z.string().regex(/^[a-z0-9*-]{1,40}$/).default('*'),
      tool: z.string().min(1).max(128).default('*'),
      effect: z.enum(['allow', 'deny']),
    }));
    if (b.subjectType === 'role' && !['admin', 'member'].includes(b.subject)) throw new HttpError(422, 'role must be admin or member');
    if (b.subjectType === 'user' && !z.string().uuid().safeParse(b.subject).success) throw new HttpError(422, 'user subject must be a user id');
    const [row] = await d.sql`INSERT INTO permissions (subject_type, subject, server, tool, effect, created_by)
                              VALUES (${b.subjectType}, ${b.subject}, ${b.server}, ${b.tool}, ${b.effect}, ${c.get('user').id}) RETURNING *`;
    await d.manager.publishChange();
    return c.json({ rule: row }, 201);
  });

  app.delete('/:id', requireAdmin, async (c) => {
    await d.sql`DELETE FROM permissions WHERE id = ${c.req.param('id')}`;
    await d.manager.publishChange();
    return c.body(null, 204);
  });

  /** Effective tool access for one user (admin) or yourself: what they'd see in tools/list, and why. */
  app.get('/effective', async (c) => {
    const me = c.get('user');
    const userId = c.req.query('userId') ?? me.id;
    if (userId !== me.id && me.role !== 'admin') throw new HttpError(403, 'admin only');
    const [u] = await d.sql<{ id: string; role: Role }[]>`SELECT id, role FROM users WHERE id = ${userId}`;
    if (!u) throw new HttpError(404, 'user not found');
    const p = { userId: u.id, role: u.role };
    return c.json({
      tools: d.manager.catalog.tools.map((t) => ({
        name: t.exposedName, server: t.slug, access: t.access,
        allowed: d.perms.allowed(p, t), reason: d.perms.explain(p, t),
      })),
    });
  });

  return app;
}
