import { currentNamespace } from '@urumi/kube';
import { z } from 'zod';

const json = <T extends z.ZodType>(schema: T) =>
  z
    .string()
    .default('{}')
    .transform((s, ctx) => {
      try {
        return JSON.parse(s) as unknown;
      } catch {
        ctx.addIssue({ code: 'custom', message: 'not valid JSON' });
        return z.NEVER;
      }
    })
    .pipe(schema);

const Env = z.object({
  PORT: z.coerce.number().int().default(8080),
  /** Namespace holding the Store custom resources (the platform namespace). */
  NAMESPACE: z.string().default(currentNamespace()),
  /** Stores are served at `<name>.<STORE_DOMAIN>`, e.g. acme.shop.127.0.0.1.nip.io. */
  STORE_DOMAIN: z.string().min(3),
  STORE_SCHEME: z.enum(['http', 'https']).default('https'),
  /** Extra values for the store chart (images, persistence, ingress TLS, store defaults), from the platform chart. */
  STORE_VALUES: json(z.record(z.string(), z.unknown())),
  /** Guardrails the provisioner applies before any workload exists; the tenant chart can't loosen them. */
  STORE_QUOTA: json(z.record(z.string(), z.string())),
  STORE_LIMITS: json(z.record(z.string(), z.unknown())),
  /** The ClusterRole bound (by RoleBinding) inside each store namespace, and to whom. */
  STORE_ROLE: z.string().default('urumi-store-manager'),
  SERVICE_ACCOUNT: z.string().default('provisioner'),
  GATEWAY_INTERNAL_URL: z.string().url().default('http://gateway-internal:8081'),
  INTERNAL_TOKEN: z.string().min(16),
  CHART_DIR: z.string().default('/app/charts/store'),
  HELM_BIN: z.string().default('helm'),
  /** Per-operation Helm timeout (the setup Job is a post-install hook Helm waits for). */
  HELM_TIMEOUT: z.string().default('10m'),
  /** A store that isn't Ready this long after (re)starting becomes Failed with the most specific reason found. */
  PROVISION_TIMEOUT_MS: z.coerce.number().int().default(12 * 60_000),
  CONCURRENCY: z.coerce.number().int().min(1).max(10).default(3),
  RESYNC_MS: z.coerce.number().int().default(30_000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});
export type Config = z.infer<typeof Env>;
export const loadConfig = (): Config => Env.parse(process.env);
