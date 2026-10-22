import { randomUUID } from 'node:crypto';
import type { Config } from '../../config.js';
import { randomToken, TOKEN_PREFIX, type Hasher } from '../../crypto/tokens.js';
import type { Sql } from '../../db/index.js';

export const ACCESS_TTL_S = 3600;
export const REFRESH_TTL_S = 30 * 86_400;
export const DELEGATION_TTL_S = 300;
export const CODE_TTL_S = 120;

/** Opaque tokens (not JWTs): revocation is instant because every use is a DB lookup of the hash. */
export async function issueTokenPair(sql: Sql, hasher: Hasher, g: { grantId: string; userId: string; scope: string; resource: string; familyId?: string }) {
  const access = TOKEN_PREFIX.access + randomToken(32);
  const refresh = TOKEN_PREFIX.refresh + randomToken(32);
  const familyId = g.familyId ?? randomUUID();
  await sql`
    INSERT INTO oauth_tokens (token_hash, kind, grant_id, user_id, family_id, scope, resource, expires_at) VALUES
      (${hasher.hash(access)}, 'access', ${g.grantId}, ${g.userId}, ${familyId}, ${g.scope}, ${g.resource}, ${new Date(Date.now() + ACCESS_TTL_S * 1000)}),
      (${hasher.hash(refresh)}, 'refresh', ${g.grantId}, ${g.userId}, ${familyId}, ${g.scope}, ${g.resource}, ${new Date(Date.now() + REFRESH_TTL_S * 1000)})`;
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: g.scope };
}

/**
 * The chat agent acts AS the logged-in user: the gateway mints a 5-minute token bound to that user and to the
 * MCP resource, and hands it to the agent server-side. The browser never sees it; the agent never sees cookies.
 */
export async function mintDelegationToken(sql: Sql, hasher: Hasher, cfg: Config, userId: string): Promise<string> {
  const token = TOKEN_PREFIX.delegation + randomToken(32);
  await sql`
    INSERT INTO oauth_tokens (token_hash, kind, user_id, scope, resource, expires_at)
    VALUES (${hasher.hash(token)}, 'delegation', ${userId}, 'mcp:tools', ${cfg.resource}, ${new Date(Date.now() + DELEGATION_TTL_S * 1000)})`;
  // Opportunistic cleanup so the table doesn't grow forever.
  await sql`DELETE FROM oauth_tokens WHERE kind = 'delegation' AND expires_at < now() - interval '1 hour'`;
  return token;
}
