import { z } from 'zod';

const csv = z.string().default('').transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean));

const Env = z.object({
  PORT: z.coerce.number().int().default(8080),
  /** Provisioner-only API + metrics. Never exposed through the Ingress. */
  INTERNAL_PORT: z.coerce.number().int().default(8081),
  /**
   * The ONLY source of external URLs (OAuth issuer, resource id, cookie flags, redirects).
   * We never build URLs from the Host header (host-header injection).
   */
  PUBLIC_BASE_URL: z.string().url().transform((s) => s.replace(/\/$/, '')),
  DATABASE_URL: z.string().min(1),
  /**
   * Key-encryption keys for upstream credentials: "kid1:<base64 32B>,kid2:<base64 32B>". The FIRST entry seals new
   * credentials; the others only open old ones. Rotation is a Secret edit, never a values change (docs/runbooks.md).
   */
  KEK_KEYS: z.string().min(1),
  /** HMAC pepper for API keys and tokens. Lives only in a K8s Secret, never in the DB. */
  TOKEN_PEPPER: z.string().min(32),
  /** Bearer token the provisioner uses on the internal port. */
  INTERNAL_TOKEN: z.string().min(32),
  ADMIN_EMAIL: z.string().email().optional(),
  ADMIN_PASSWORD: z.string().min(12).optional(),
  /** JSON array of upstreams to seed on first start (see bootstrap.ts). */
  BOOTSTRAP_UPSTREAMS: z.string().default('[]'),
  /** Slug of the store to use when a request doesn't name one (the bootstrap store). Marked in tools' _meta and list_servers. */
  DEFAULT_STORE: z.string().default(''),
  AGENT_URL: z.string().url().default('http://agent:8080'),
  /** Hostnames (glob) admins may register even though they resolve to private IPs. Set by Helm, not the UI. */
  SSRF_ALLOWED_INTERNAL_HOSTS: csv,
  /** Hostname globs only the internal API (provisioner) may register, e.g. "woo-mcp.store-*.svc.cluster.local". */
  SSRF_PROVISIONER_HOSTS: csv,
  HEALTH_INTERVAL_MS: z.coerce.number().int().min(1000).default(10_000),
  SYNC_INTERVAL_MS: z.coerce.number().int().min(5000).default(60_000),
  DEFAULT_CALL_TIMEOUT_MS: z.coerce.number().int().default(20_000),
  MAX_RESULT_BYTES: z.coerce.number().int().default(1_000_000),
  TOOL_SEARCH_AUTO_THRESHOLD: z.coerce.number().int().default(60),
  /** Tool calls per minute per user, across all their keys, OAuth grants and chat (per replica). 0 = off. */
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(0).default(120),
  /** Kubernetes namespace where Store CRs live (bonus). Empty disables the stores API. */
  STORES_NAMESPACE: z.string().default(''),
  STORES_MAX_PER_USER: z.coerce.number().int().default(2),
  STORES_MAX_PER_ADMIN: z.coerce.number().int().default(5),
  STORES_MAX_TOTAL: z.coerce.number().int().default(4),
  STORE_BASE_DOMAIN: z.string().default('shop.127.0.0.1.nip.io'),
  STORE_SCHEME: z.enum(['http', 'https']).default('http'),
  /** Extra origins allowed to call the cookie-authenticated /api (e.g. the Vite dev server). */
  EXTRA_ALLOWED_ORIGINS: csv,
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
});

export type Config = z.infer<typeof Env> & {
  issuer: string;
  /** Canonical MCP resource identifier (RFC 8707 / RFC 9728). */
  resource: string;
  secureCookies: boolean;
  keks: Map<string, Buffer>;
  /** The kid that seals new credentials: the first entry of KEK_KEYS. */
  activeKid: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const c = Env.parse(env);
  const keks = new Map<string, Buffer>();
  for (const part of c.KEK_KEYS.split(',')) {
    const [kid, b64] = part.split(':');
    const key = Buffer.from(b64 ?? '', 'base64');
    if (!kid || key.length !== 32) throw new Error(`KEK_KEYS: entry "${kid}" must be <kid>:<base64 of 32 bytes>`);
    keks.set(kid, key);
  }
  return {
    ...c,
    issuer: c.PUBLIC_BASE_URL,
    resource: `${c.PUBLIC_BASE_URL}/mcp`,
    secureCookies: c.PUBLIC_BASE_URL.startsWith('https://'),
    keks,
    activeKid: keks.keys().next().value!,
  };
}
