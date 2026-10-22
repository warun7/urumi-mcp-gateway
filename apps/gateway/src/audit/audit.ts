import type { Principal } from '../auth/principal.js';
import type { Sql } from '../db/index.js';
import type { EventBus } from '../events/bus.js';
import type { Logger } from '../log.js';

export type AuditOutcome =
  | 'success' | 'tool_error' | 'timeout' | 'unavailable' | 'denied' | 'invalid_args' | 'auth_failed' | 'rate_limited' | 'cancelled' | 'error';

export interface AuditEntry {
  principal?: Pick<Principal, 'userId' | 'email' | 'authMethod' | 'credentialId' | 'clientName' | 'via'>;
  /** For entries without a resolved principal (failed auth): who the credential belonged to. */
  userId?: string;
  credentialId?: string;
  upstreamId?: string;
  upstreamSlug?: string;
  toolName?: string;
  exposedName?: string;
  outcome: AuditOutcome;
  errorCode?: string;
  errorMessage?: string;
  durationMs?: number;
  argsBytes?: number;
  resultBytes?: number;
  traceId?: string;
}

/**
 * One row per tool call (and per denied call / failed auth). Sizes, not values, are stored by default:
 * arguments and results can contain customer data, and the audit log is readable by admins.
 * The DB role the gateway runs as cannot UPDATE or DELETE this table (append-only).
 */
export class AuditLog {
  constructor(private readonly sql: Sql, private readonly bus: EventBus, private readonly log: Logger) {}

  async write(e: AuditEntry): Promise<void> {
    try {
      const p = e.principal;
      const userId = p?.userId ?? e.userId ?? null;
      // Failed-auth rows have no principal, only the credential's owner: snapshot their email too, so the
      // dashboard can say who is still using a revoked key.
      const [row] = await this.sql<{ id: string }[]>`
        INSERT INTO audit_events (duration_ms, user_id, user_email, auth_method, credential_id, client_name, via,
          upstream_id, upstream_slug, tool_name, exposed_name, outcome, error_code, error_message, args_bytes, result_bytes, trace_id)
        VALUES (${e.durationMs ?? null}, ${userId},
          COALESCE(${p?.email ?? null}::text, (SELECT email FROM users WHERE id = ${userId}::uuid)), ${p?.authMethod ?? null},
          ${p?.credentialId ?? e.credentialId ?? null}, ${p?.clientName ?? null}, ${p?.via ?? null}, ${e.upstreamId ?? null}, ${e.upstreamSlug ?? null},
          ${e.toolName ?? null}, ${e.exposedName ?? null}, ${e.outcome}, ${e.errorCode ?? null},
          ${e.errorMessage?.slice(0, 500) ?? null}, ${e.argsBytes ?? null}, ${e.resultBytes ?? null}, ${e.traceId ?? null})
        RETURNING id`;
      void this.bus.publish({ type: 'audit', id: Number(row!.id) }).catch(() => undefined);
    } catch (err) {
      // Never fail the user's call because the audit insert failed, but make it loud.
      this.log.error({ err, entry: { ...e, principal: undefined } }, 'AUDIT WRITE FAILED');
    }
  }
}
