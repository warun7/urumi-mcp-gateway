import type { Context } from 'hono';
import { z } from 'zod';
import type { AuditLog } from '../audit/audit.js';
import type { Sessions } from '../auth/sessions.js';
import type { Config } from '../config.js';
import type { SecretBox } from '../crypto/secretbox.js';
import type { Hasher } from '../crypto/tokens.js';
import type { Sql } from '../db/index.js';
import type { EventBus } from '../events/bus.js';
import type { Logger } from '../log.js';
import type { Router } from '../mcp/router.js';
import type { UpstreamManager } from '../mcp/upstream/manager.js';
import type { Permissions } from '../policy/permissions.js';

export interface Deps {
  cfg: Config;
  sql: Sql;
  log: Logger;
  bus: EventBus;
  box: SecretBox;
  hasher: Hasher;
  sessions: Sessions;
  manager: UpstreamManager;
  router: Router;
  perms: Permissions;
  audit: AuditLog;
}

export class HttpError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 502 | 503, message: string) {
    super(message);
  }
}

/** Parse + validate a JSON body; zod errors become a readable 400. */
export async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HttpError(400, 'body must be JSON');
  }
  const r = schema.safeParse(raw);
  if (!r.success) throw new HttpError(400, r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  return r.data;
}

export const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
