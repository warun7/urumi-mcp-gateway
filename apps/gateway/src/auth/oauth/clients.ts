import type { Sql } from '../../db/index.js';
import { guardedFetch, SsrfError } from '../../mcp/upstream/ssrf.js';

export interface OAuthClient {
  client_id: string;
  kind: 'cimd' | 'dcr';
  client_name: string | null;
  client_uri: string | null;
  logo_uri: string | null;
  redirect_uris: string[];
  metadata: Record<string, unknown>;
  fetched_at: Date;
}

export class OAuthClientError extends Error {}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Redirect URI rules for public clients (OAuth 2.1 + RFC 8252 native apps). */
export function validateRedirectUri(raw: string): void {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new OAuthClientError(`redirect_uri is not a URL: ${raw}`);
  }
  if (u.hash) throw new OAuthClientError('redirect_uri must not contain a fragment');
  if (u.protocol === 'https:') return;
  if (u.protocol === 'http:') {
    if (LOOPBACK.has(u.hostname)) return; // native app loopback redirect, any port
    throw new OAuthClientError('http redirect_uris are only allowed for localhost / 127.0.0.1');
  }
  // Private-use URI schemes for native apps must look like reverse domain names (com.example.app:/cb).
  const scheme = u.protocol.slice(0, -1);
  if (/^[a-z][a-z0-9+.-]*\.[a-z0-9+.-]+$/i.test(scheme) && !['javascript', 'data', 'file', 'vbscript'].includes(scheme)) return;
  throw new OAuthClientError(`redirect_uri scheme "${scheme}" is not allowed`);
}

/** A client whose every redirect goes to localhost can't be tied to any verified domain: we warn on consent. */
export const isLocalOnly = (c: Pick<OAuthClient, 'redirect_uris'>) =>
  c.redirect_uris.every((r) => {
    try {
      const u = new URL(r);
      return u.protocol === 'http:' ? LOOPBACK.has(u.hostname) : u.protocol !== 'https:';
    } catch {
      return true;
    }
  });

const CIMD_TTL_MS = 3600_000;
const CIMD_MAX_BYTES = 64 * 1024;

/**
 * Resolve a client_id.
 *  - https URL  -> Client ID Metadata Document (the 2026 spec's preferred registration): fetch the JSON the client
 *                  publishes at that URL, with the SSRF guard (public https only, no redirects, 5 s, 64 KB).
 *  - otherwise  -> a client registered earlier through Dynamic Client Registration (kept for older clients).
 */
export async function resolveClient(sql: Sql, clientId: string): Promise<OAuthClient> {
  const [cached] = await sql<OAuthClient[]>`SELECT * FROM oauth_clients WHERE client_id = ${clientId}`;
  if (!clientId.startsWith('https://')) {
    if (!cached || cached.kind !== 'dcr') throw new OAuthClientError('unknown client_id');
    return cached;
  }
  if (cached && Date.now() - cached.fetched_at.getTime() < CIMD_TTL_MS) return cached;

  const url = new URL(clientId);
  if (url.pathname === '/' || url.hash) throw new OAuthClientError('a client_id URL must have a path and no fragment');
  let doc: Record<string, unknown>;
  try {
    const res = await guardedFetch({ internalHosts: [] })(clientId, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5_000) });
    if (!res.ok) throw new OAuthClientError(`client metadata document returned HTTP ${res.status}`);
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > CIMD_MAX_BYTES) throw new OAuthClientError('client metadata document too large');
    const text = await res.text();
    if (text.length > CIMD_MAX_BYTES) throw new OAuthClientError('client metadata document too large');
    doc = JSON.parse(text) as Record<string, unknown>;
  } catch (err) {
    if (err instanceof OAuthClientError) throw err;
    if (err instanceof SsrfError) throw new OAuthClientError(`client_id URL not allowed: ${err.message}`);
    throw new OAuthClientError(`could not fetch client metadata document: ${(err as Error).message}`);
  }
  if (doc.client_id !== clientId) throw new OAuthClientError('client metadata document client_id does not match its URL');
  const redirects = doc.redirect_uris;
  if (!Array.isArray(redirects) || !redirects.length || !redirects.every((r) => typeof r === 'string')) throw new OAuthClientError('redirect_uris missing in client metadata');
  redirects.forEach((r) => validateRedirectUri(r as string));
  const auth = doc.token_endpoint_auth_method ?? 'none';
  if (auth !== 'none') throw new OAuthClientError(`token_endpoint_auth_method "${String(auth)}" is not supported (public clients only)`);
  const str = (v: unknown, max = 300) => (typeof v === 'string' ? v.slice(0, max) : null);
  const [row] = await sql<OAuthClient[]>`
    INSERT INTO oauth_clients (client_id, kind, client_name, client_uri, logo_uri, redirect_uris, metadata, fetched_at)
    VALUES (${clientId}, 'cimd', ${str(doc.client_name, 100)}, ${str(doc.client_uri)}, ${str(doc.logo_uri)}, ${redirects as string[]}, ${sql.json(doc as never)}, now())
    ON CONFLICT (client_id) DO UPDATE SET client_name = EXCLUDED.client_name, client_uri = EXCLUDED.client_uri, logo_uri = EXCLUDED.logo_uri,
      redirect_uris = EXCLUDED.redirect_uris, metadata = EXCLUDED.metadata, fetched_at = now()
    RETURNING *`;
  return row!;
}
