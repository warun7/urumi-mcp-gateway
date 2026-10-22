import { z } from 'zod';

const Env = z.object({
  PORT: z.coerce.number().int().default(8080),
  /** Where requests are sent: the in-cluster WordPress Service. */
  WOO_BASE_URL: z.string().url(),
  /** WordPress's home URL. WooCommerce rebuilds the OAuth 1.0a base string from it. */
  WOO_PUBLIC_URL: z.string().url(),
  WOO_CONSUMER_KEY: z.string().startsWith('ck_'),
  WOO_CONSUMER_SECRET: z.string().startsWith('cs_'),
  /** Static bearer token the gateway must present. */
  MCP_AUTH_TOKEN: z.string().min(16),
  STORE_NAME: z.string().default('default'),
  STORE_TITLE: z.string().default('WooCommerce store'),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type Config = z.infer<typeof Env>;
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => Env.parse(env);
