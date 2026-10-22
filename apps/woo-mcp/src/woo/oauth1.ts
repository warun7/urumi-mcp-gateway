import { createHmac, randomBytes } from 'node:crypto';

/** RFC 3986 percent-encoding as required by OAuth 1.0a (RFC 5849 §3.6). */
export const pct = (s: string): string =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

export interface SignInput {
  method: string;
  /** The URL WordPress believes it lives at (home URL + path), WITHOUT query string. */
  baseUrl: string;
  query: Record<string, string>;
  consumerKey: string;
  consumerSecret: string;
  /** Injectable for deterministic tests. */
  nonce?: string;
  timestamp?: number;
}

/**
 * One-legged OAuth 1.0a (HMAC-SHA256), the scheme WooCommerce requires over plain HTTP.
 * The consumer secret never crosses the wire; nonce + timestamp stop replays.
 * Returns the full parameter set (query + oauth_*) to append to the request URL.
 */
export function signOAuth1(input: SignInput): Record<string, string> {
  const oauth: Record<string, string> = {
    oauth_consumer_key: input.consumerKey,
    oauth_nonce: input.nonce ?? randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA256',
    oauth_timestamp: String(input.timestamp ?? Math.floor(Date.now() / 1000)),
  };
  const all: Record<string, string> = { ...input.query, ...oauth };
  const paramString = Object.keys(all)
    .map((k) => [pct(k), pct(all[k]!)] as const)
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const baseString = [input.method.toUpperCase(), pct(input.baseUrl), pct(paramString)].join('&');
  const signature = createHmac('sha256', `${pct(input.consumerSecret)}&`).update(baseString).digest('base64');
  return { ...all, oauth_signature: signature };
}
