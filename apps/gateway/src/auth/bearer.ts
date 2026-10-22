import type { Config } from '../config.js';
import { Hasher, parseApiKey, TOKEN_PREFIX } from '../crypto/tokens.js';
import type { Sql } from '../db/index.js';
import type { EventBus } from '../events/bus.js';
import type { Principal, Role, ToolMode } from './principal.js';

export type BearerResult =
  | { ok: true; principal: Principal; expiresAt?: number }
  | { ok: false; reason: 'missing' | 'malformed' | 'unknown' | 'revoked' | 'expired' | 'user_disabled' | 'wrong_audience' | 'insufficient_scope'; userId?: string; credentialId?: string };

export const SCOPE_TOOLS = 'mcp:tools';
const CACHE_MS = 5_000;

interface UserCols { user_id: string; email: string; name: string; role: Role; user_status: 'active' | 'disabled' }

/**
 * Resolves `Authorization: Bearer ...` for /mcp.
 * Tokens are opaque and looked up on every request (with a 5 s cache that NOTIFY clears), so
 * revoking a key, a grant, or disabling a user takes effect immediately on every replica.
 */
export class BearerAuth {
  private cache = new Map<string, { at: number; res: BearerResult }>();
  private lastUsedWrites = new Map<string, number>();

  constructor(private readonly sql: Sql, private readonly hasher: Hasher, private readonly cfg: Config, bus: EventBus) {
    bus.on('event', (e) => {
      if (e.type === 'auth') this.cache.clear();
    });
  }

  /** Drop every cached result (freshness catch-up: a revocation committed elsewhere must win over the cache). */
  flush(): void {
    this.cache.clear();
  }

  async resolve(header: string | undefined): Promise<BearerResult> {
    if (!header) return { ok: false, reason: 'missing' };
    const m = /^Bearer\s+(\S+)$/i.exec(header);
    if (!m) return { ok: false, reason: 'malformed' };
    const token = m[1]!;
    const key = this.hasher.hash(token);
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.res;
    const res = await this.lookup(token, key);
    if (this.cache.size > 10_000) this.cache.clear();
    this.cache.set(key, { at: Date.now(), res });
    return res;
  }

  private async lookup(token: string, tokenHash: string): Promise<BearerResult> {
    const apiKey = parseApiKey(token);
    if (apiKey) return this.apiKey(apiKey.id, apiKey.secret);
    if (token.startsWith(TOKEN_PREFIX.access)) return this.oauthToken(tokenHash, 'access');
    if (token.startsWith(TOKEN_PREFIX.delegation)) return this.oauthToken(tokenHash, 'delegation');
    return { ok: false, reason: 'unknown' };
  }

  private async apiKey(id: string, secret: string): Promise<BearerResult> {
    const [row] = await this.sql<(UserCols & { secret_hmac: string; revoked_at: Date | null; expires_at: Date | null; tool_mode: ToolMode; key_name: string })[]>`
      SELECT k.secret_hmac, k.revoked_at, k.expires_at, k.tool_mode, k.name AS key_name,
             u.id AS user_id, u.email, u.name, u.role, u.status AS user_status
      FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.id = ${id}`;
    if (!row || !this.hasher.equals(secret, row.secret_hmac)) return { ok: false, reason: 'unknown' };
    const who = { userId: row.user_id, credentialId: id };
    if (row.revoked_at) return { ok: false, reason: 'revoked', ...who };
    if (row.expires_at && row.expires_at.getTime() < Date.now()) return { ok: false, reason: 'expired', ...who };
    if (row.user_status !== 'active') return { ok: false, reason: 'user_disabled', ...who };
    this.touch(`k:${id}`, () => this.sql`UPDATE api_keys SET last_used_at = now() WHERE id = ${id}`);
    return {
      ok: true,
      principal: {
        userId: row.user_id, email: row.email, name: row.name, role: row.role,
        authMethod: 'api_key', credentialId: id, clientName: row.key_name, via: 'mcp',
        toolMode: row.tool_mode, scopes: [SCOPE_TOOLS],
      },
    };
  }

  private async oauthToken(tokenHash: string, kind: 'access' | 'delegation'): Promise<BearerResult> {
    const [row] = await this.sql<(UserCols & {
      grant_id: string | null; scope: string; resource: string; expires_at: Date; revoked_at: Date | null;
      grant_revoked_at: Date | null; tool_mode: ToolMode | null; client_name: string | null; client_id: string | null;
    })[]>`
      SELECT t.grant_id, t.scope, t.resource, t.expires_at, t.revoked_at,
             g.revoked_at AS grant_revoked_at, g.tool_mode, c.client_name, c.client_id,
             u.id AS user_id, u.email, u.name, u.role, u.status AS user_status
      FROM oauth_tokens t
      JOIN users u ON u.id = t.user_id
      LEFT JOIN oauth_grants g ON g.id = t.grant_id
      LEFT JOIN oauth_clients c ON c.client_id = g.client_id
      WHERE t.token_hash = ${tokenHash} AND t.kind = ${kind}`;
    if (!row) return { ok: false, reason: 'unknown' };
    const credentialId = kind === 'delegation' ? `chat:${tokenHash.slice(0, 8)}` : row.grant_id!;
    const who = { userId: row.user_id, credentialId };
    if (row.revoked_at || row.grant_revoked_at) return { ok: false, reason: 'revoked', ...who };
    if (row.expires_at.getTime() < Date.now()) return { ok: false, reason: 'expired', ...who };
    // Audience binding (RFC 8707): a token minted for another resource is useless here.
    if (row.resource !== this.cfg.resource) return { ok: false, reason: 'wrong_audience', ...who };
    if (row.user_status !== 'active') return { ok: false, reason: 'user_disabled', ...who };
    const scopes = row.scope.split(' ').filter(Boolean);
    if (!scopes.includes(SCOPE_TOOLS)) return { ok: false, reason: 'insufficient_scope', ...who };
    if (row.grant_id) this.touch(`g:${row.grant_id}`, () => this.sql`UPDATE oauth_grants SET last_used_at = now() WHERE id = ${row.grant_id}`);
    return {
      ok: true,
      expiresAt: Math.floor(row.expires_at.getTime() / 1000),
      principal: {
        userId: row.user_id, email: row.email, name: row.name, role: row.role,
        authMethod: kind === 'delegation' ? 'delegation' : 'oauth',
        credentialId,
        clientName: kind === 'delegation' ? 'Urumi chat' : (row.client_name ?? row.client_id ?? undefined),
        via: kind === 'delegation' ? 'chat' : 'mcp',
        // The chat agent uses auto mode: with hundreds of tools it searches and loads tools on demand.
        toolMode: row.tool_mode ?? 'auto',
        scopes,
      },
    };
  }

  /** last_used_at is useful in the UI but not worth a write per request: at most once a minute. */
  private touch(key: string, write: () => PromiseLike<unknown>) {
    const last = this.lastUsedWrites.get(key) ?? 0;
    if (Date.now() - last < 60_000) return;
    this.lastUsedWrites.set(key, Date.now());
    void Promise.resolve(write()).catch(() => undefined);
  }
}
