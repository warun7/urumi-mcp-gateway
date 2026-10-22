import { Hono } from 'hono';
import { z } from 'zod';
import { clientIp, RateLimiter, requireAdmin, type ApiEnv } from '../auth/sessions.js';
import type { SessionUser } from '../auth/principal.js';
import { burnPasswordCheck, hashPassword, verifyPassword } from '../crypto/passwords.js';
import { randomToken } from '../crypto/tokens.js';
import { body, HttpError, iso, type Deps } from './deps.js';

const INVITE_TTL_MS = 72 * 3600_000;
const Password = z.string().min(12, 'at least 12 characters').max(200);

/** Routes that work WITHOUT a session: login, invite lookup/acceptance. */
export function publicAuthApi(d: Deps) {
  const app = new Hono();
  const loginLimiter = new RateLimiter(10, 15 * 60_000);
  const allowed = new Set([new URL(d.cfg.PUBLIC_BASE_URL).origin, ...d.cfg.EXTRA_ALLOWED_ORIGINS]);
  const ip = clientIp;

  // Login CSRF ("log the victim into the attacker's account") is blocked by the same Origin rule.
  app.use('*', async (c, next) => {
    if (c.req.method === 'POST' && !allowed.has(c.req.header('origin') ?? '')) return c.json({ error: 'cross-origin request rejected' }, 403);
    await next();
  });

  app.post('/auth/login', async (c) => {
    const b = await body(c, z.object({ email: z.string().email().max(200), password: z.string().max(200) }));
    const email = b.email.toLowerCase();
    // Only FAILED attempts count (10 per 15 min per IP+email): brute force is stopped, normal use never is.
    const key = `${ip(c)}|${email}`;
    if (!loginLimiter.allowed(key)) throw new HttpError(429, 'too many failed attempts; wait 15 minutes');
    const [u] = await d.sql<(SessionUser & { password_hash: string | null })[]>`
      SELECT id, email, name, role, status, password_hash FROM users WHERE email = ${email}`;
    // Same work and same message whether the email exists or not: no account enumeration.
    if (!u?.password_hash) {
      await burnPasswordCheck(b.password);
      loginLimiter.take(key);
      throw new HttpError(401, 'wrong email or password');
    }
    if (!(await verifyPassword(b.password, u.password_hash))) {
      loginLimiter.take(key);
      throw new HttpError(401, 'wrong email or password');
    }
    loginLimiter.reset(key);
    if (u.status !== 'active') throw new HttpError(403, 'this account is disabled');
    await d.sessions.create(c, u.id);
    d.log.info({ user: email }, 'login');
    return c.json({ user: { id: u.id, email: u.email, name: u.name, role: u.role } });
  });

  app.get('/invites/:token', async (c) => {
    const [inv] = await d.sql<{ email: string; role: string }[]>`
      SELECT email, role FROM invites WHERE token_hash = ${d.hasher.hash(c.req.param('token'))}
        AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()`;
    if (!inv) throw new HttpError(404, 'this invite link is invalid, used, or expired');
    return c.json({ invite: inv });
  });

  app.post('/invites/:token/accept', async (c) => {
    if (!loginLimiter.take(`invite|${ip(c)}`)) throw new HttpError(429, 'too many attempts');
    const b = await body(c, z.object({ name: z.string().min(1).max(80), password: Password }));
    const tokenHash = d.hasher.hash(c.req.param('token'));
    const hash = await hashPassword(b.password);
    const userId = await d.sql.begin(async (tx) => {
      // FOR UPDATE: two tabs racing on the same link can't both create an account.
      const [inv] = await tx<{ id: string; email: string; role: 'admin' | 'member' }[]>`
        SELECT id, email, role FROM invites WHERE token_hash = ${tokenHash}
          AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now() FOR UPDATE`;
      if (!inv) throw new HttpError(404, 'this invite link is invalid, used, or expired');
      const [exists] = await tx`SELECT 1 FROM users WHERE email = ${inv.email}`;
      if (exists) throw new HttpError(409, 'an account with this email already exists');
      const [u] = await tx<{ id: string }[]>`
        INSERT INTO users (email, name, role, password_hash) VALUES (${inv.email}, ${b.name}, ${inv.role}, ${hash}) RETURNING id`;
      await tx`UPDATE invites SET accepted_at = now() WHERE id = ${inv.id}`;
      return u!.id;
    });
    await d.sessions.create(c, userId);
    return c.json({ ok: true }, 201);
  });

  return app;
}

/** Session-authenticated account/team routes. */
export function accountApi(d: Deps) {
  const app = new Hono<ApiEnv>();

  app.post('/auth/logout', async (c) => {
    await d.sessions.destroy(c);
    return c.json({ ok: true });
  });

  app.get('/me', (c) => {
    const u = c.get('user');
    return c.json({
      user: { id: u.id, email: u.email, name: u.name, role: u.role },
      mcpUrl: d.cfg.resource,
      publicBaseUrl: d.cfg.PUBLIC_BASE_URL,
      storesEnabled: !!d.cfg.STORES_NAMESPACE,
    });
  });

  app.post('/me/password', async (c) => {
    const b = await body(c, z.object({ current: z.string().max(200), next: Password }));
    const [u] = await d.sql<{ password_hash: string }[]>`SELECT password_hash FROM users WHERE id = ${c.get('user').id}`;
    if (!u || !(await verifyPassword(b.current, u.password_hash))) throw new HttpError(401, 'current password is wrong');
    await d.sql`UPDATE users SET password_hash = ${await hashPassword(b.next)} WHERE id = ${c.get('user').id}`;
    // Sign out every other session.
    await d.sql`DELETE FROM sessions WHERE user_id = ${c.get('user').id} AND id_hash <> ${c.get('sessionHash')}`;
    return c.json({ ok: true });
  });

  // ---- team (admin)
  app.get('/members', requireAdmin, async (c) => {
    const rows = await d.sql<{ id: string; email: string; name: string; role: string; status: string; created_at: Date; last_login_at: Date | null; keys: number }[]>`
      SELECT u.id, u.email, u.name, u.role, u.status, u.created_at, u.last_login_at,
             (SELECT count(*)::int FROM api_keys k WHERE k.user_id = u.id AND k.revoked_at IS NULL) AS keys
      FROM users u ORDER BY u.created_at`;
    return c.json({ members: rows.map((r) => ({ ...r, created_at: iso(r.created_at), last_login_at: iso(r.last_login_at) })) });
  });

  app.patch('/members/:id', requireAdmin, async (c) => {
    const b = await body(c, z.object({ role: z.enum(['admin', 'member']).optional(), status: z.enum(['active', 'disabled']).optional(), name: z.string().min(1).max(80).optional() }));
    const id = c.req.param('id');
    if (id === c.get('user').id && (b.role === 'member' || b.status === 'disabled')) throw new HttpError(409, "you can't demote or disable yourself");
    await d.sql.begin(async (tx) => {
      const [u] = await tx<{ role: string; status: string }[]>`SELECT role, status FROM users WHERE id = ${id} FOR UPDATE`;
      if (!u) throw new HttpError(404, 'member not found');
      await tx`UPDATE users SET role = ${b.role ?? u.role}, status = ${b.status ?? u.status}, name = COALESCE(${b.name ?? null}, name) WHERE id = ${id}`;
      const [row] = await tx<{ admins: number }[]>`SELECT count(*)::int AS admins FROM users WHERE role = 'admin' AND status = 'active'`;
      if ((row?.admins ?? 0) < 1) throw new HttpError(409, 'the team needs at least one active admin');
      if (b.status === 'disabled') await tx`DELETE FROM sessions WHERE user_id = ${id}`;
    });
    // Disabling a user kills their keys and OAuth tokens immediately on every replica.
    await d.bus.publish({ type: 'auth', userId: id });
    await d.manager.publishChange(); // role change can change their tool list
    return c.json({ ok: true });
  });

  app.get('/invites', requireAdmin, async (c) => {
    const rows = await d.sql<{ id: string; email: string; role: string; created_at: Date; expires_at: Date; accepted_at: Date | null; revoked_at: Date | null }[]>`
      SELECT id, email, role, created_at, expires_at, accepted_at, revoked_at FROM invites ORDER BY created_at DESC LIMIT 100`;
    return c.json({
      invites: rows.map((r) => ({
        id: r.id, email: r.email, role: r.role, createdAt: iso(r.created_at), expiresAt: iso(r.expires_at),
        status: r.accepted_at ? 'accepted' : r.revoked_at ? 'revoked' : r.expires_at < new Date() ? 'expired' : 'pending',
      })),
    });
  });

  /** No mail server needed: the admin gets a one-time link to send however they like. */
  app.post('/invites', requireAdmin, async (c) => {
    const b = await body(c, z.object({ email: z.string().email().max(200), role: z.enum(['admin', 'member']) }));
    const email = b.email.toLowerCase();
    const [exists] = await d.sql`SELECT 1 FROM users WHERE email = ${email}`;
    if (exists) throw new HttpError(409, 'this person already has an account');
    const token = randomToken(32);
    await d.sql`INSERT INTO invites (email, role, token_hash, invited_by, expires_at)
                VALUES (${email}, ${b.role}, ${d.hasher.hash(token)}, ${c.get('user').id}, ${new Date(Date.now() + INVITE_TTL_MS)})`;
    return c.json({ link: `${d.cfg.PUBLIC_BASE_URL}/invite/${token}`, expiresInHours: 72 }, 201);
  });

  app.delete('/invites/:id', requireAdmin, async (c) => {
    await d.sql`UPDATE invites SET revoked_at = now() WHERE id = ${c.req.param('id')} AND accepted_at IS NULL`;
    return c.body(null, 204);
  });

  return app;
}
