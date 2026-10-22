import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Keyed hash for anything we look up by secret (API keys, OAuth tokens, sessions, invites). */
export class Hasher {
  constructor(private readonly pepper: string) {}
  hash(secret: string): string {
    return createHmac('sha256', this.pepper).update(secret).digest('hex');
  }
  equals(secret: string, expectedHex: string): boolean {
    const a = Buffer.from(this.hash(secret), 'hex');
    const b = Buffer.from(expectedHex, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  }
}

/**
 * API key format: ugw_<12 char id>_<43 char secret>.
 * The id is public (shown in the UI, used for lookup and audit); only HMAC(secret) is stored.
 * The fixed prefix makes leaked keys easy to detect (secret-scanning patterns).
 */
const KEY_RE = /^ugw_([A-Za-z0-9]{12})_([A-Za-z0-9_-]{43})$/;
const ALPHANUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function newApiKey(): { id: string; secret: string; full: string } {
  const bytes = randomBytes(12);
  const id = Array.from(bytes, (b) => ALPHANUM[b % ALPHANUM.length]).join('');
  const secret = randomBytes(32).toString('base64url');
  return { id, secret, full: `ugw_${id}_${secret}` };
}

export function parseApiKey(token: string): { id: string; secret: string } | null {
  const m = KEY_RE.exec(token);
  return m ? { id: m[1]!, secret: m[2]! } : null;
}

/** OAuth/delegation tokens carry a type prefix so logs and scanners can tell them apart. */
export const TOKEN_PREFIX = { access: 'uat_', refresh: 'urt_', delegation: 'udt_' } as const;
