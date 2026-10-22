import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Config } from '../config.js';
import { randomToken, type Hasher } from '../crypto/tokens.js';
import type { Sql } from '../db/index.js';
import type { SessionUser } from './principal.js';

const TTL_MS = 12 * 3600_000;

export type ApiEnv = { Variables: { user: SessionUser; sessionHash: string } };

/**
 * Dashboard sessions: an opaque random id in an HttpOnly cookie; only its HMAC is stored.
 * `__Host-` prefix under TLS pins the cookie to this exact host (no subdomain can set or read it).
 */
export class Sessions {
  readonly cookieName: string;

  constructor(private readonly sql: Sql, private readonly hasher: Hasher, private readonly cfg: Config) {
    this.cookieName = cfg.secureCookies ? '__Host-urumi_sid' : 'urumi_sid';
  }

  async create(c: Context, userId: string): Promise<void> {
    const id = randomToken(32);
    await this.sql`
      INSERT INTO sessions (id_hash, user_id, expires_at, ip, user_agent)
      VALUES (${this.hasher.hash(id)}, ${userId}, ${new Date(Date.now() + TTL_MS)},
              ${clientIp(c)}, ${c.req.header('user-agent')?.slice(0, 200) ?? null})`;
    await this.sql`UPDATE users SET last_login_at = now() WHERE id = ${userId}`;
    setCookie(c, this.cookieName, id, { httpOnly: true, secure: this.cfg.secureCookies, sameSite: 'Lax', path: '/', maxAge: TTL_MS / 1000 });
  }

  async destroy(c: Context): Promise<void> {
    const id = getCookie(c, this.cookieName);
    if (id) await this.sql`DELETE FROM sessions WHERE id_hash = ${this.hasher.hash(id)}`;
    deleteCookie(c, this.cookieName, { path: '/', secure: this.cfg.secureCookies });
  }

  async current(c: Context): Promise<{ user: SessionUser; hash: string } | null> {
    const id = getCookie(c, this.cookieName);
    if (!id) return null;
    const hash = this.hasher.hash(id);
    const [row] = await this.sql<SessionUser[]>`
      SELECT u.id, u.email, u.name, u.role, u.status FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id_hash = ${hash} AND s.expires_at > now()`;
    if (!row || row.status !== 'active') return null;
    return { user: row, hash };
  }

  /** Requires a valid session; also enforces the CSRF rule for state-changing requests. */
  middleware(): MiddlewareHandler<ApiEnv> {
    const allowedOrigins = new Set([new URL(this.cfg.PUBLIC_BASE_URL).origin, ...this.cfg.EXTRA_ALLOWED_ORIGINS]);
    return async (c, next) => {
      if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
        // CSRF: browsers always send Origin on cross-site POST/PATCH/DELETE; we accept only our own.
        // JSON-only bodies add a second barrier (a plain HTML form cannot send application/json).
        const origin = c.req.header('origin');
        if (!origin || !allowedOrigins.has(origin)) return c.json({ error: 'cross-origin request rejected' }, 403);
        const ct = c.req.header('content-type') ?? '';
        const hasBody = Number(c.req.header('content-length') ?? 0) > 0 || !!c.req.header('transfer-encoding');
        if (hasBody && !ct.startsWith('application/json'))
          return c.json({ error: 'content-type must be application/json' }, 415);
      }
      const s = await this.current(c);
      if (!s) return c.json({ error: 'not signed in' }, 401);
      c.set('user', s.user);
      c.set('sessionHash', s.hash);
      await next();
    };
  }
}

export const requireAdmin: MiddlewareHandler<ApiEnv> = async (c, next) => {
  if (c.get('user').role !== 'admin') return c.json({ error: 'admin only' }, 403);
  await next();
};

/** Tiny fixed-window limiter (per replica) for login and invite acceptance: slows down password guessing. */
/**
 * The client address as seen by our proxy. The RIGHTMOST X-Forwarded-For entry is the one Traefik appended;
 * entries to its left are client-supplied and spoofable (keying rate limits on them is bypassable).
 */
export function clientIp(c: { req: { header: (n: string) => string | undefined } }): string {
  return c.req.header('x-forwarded-for')?.split(',').at(-1)?.trim() || 'local';
}

export class RateLimiter {
  private hits = new Map<string, { n: number; reset: number }>();
  constructor(private readonly max: number, private readonly windowMs: number) {}
  take(key: string): boolean {
    const now = Date.now();
    const h = this.hits.get(key);
    if (!h || h.reset < now) {
      if (this.hits.size > 50_000) this.hits.clear();
      this.hits.set(key, { n: 1, reset: now + this.windowMs });
      return true;
    }
    h.n++;
    return h.n <= this.max;
  }
  /** True while the key still has attempts left in the current window (does not consume one). */
  allowed(key: string): boolean {
    const h = this.hits.get(key);
    return !h || h.reset < Date.now() || h.n < this.max;
  }
  reset(key: string): void {
    this.hits.delete(key);
  }
}
