import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { ApiEnv } from '../auth/sessions.js';
import type { BusEvent } from '../events/bus.js';
import { iso, type Deps } from './deps.js';

interface AuditRow {
  id: string; ts: Date; duration_ms: number | null; user_id: string | null; user_email: string | null; auth_method: string | null;
  credential_id: string | null; client_name: string | null; via: string | null; upstream_slug: string | null; tool_name: string | null;
  exposed_name: string | null; outcome: string; error_code: string | null; error_message: string | null;
  args_bytes: number | null; result_bytes: number | null; trace_id: string | null;
}

const view = (r: AuditRow) => ({
  id: Number(r.id), ts: iso(r.ts), durationMs: r.duration_ms, userId: r.user_id, userEmail: r.user_email,
  authMethod: r.auth_method, credentialId: r.credential_id, client: r.client_name, via: r.via, server: r.upstream_slug,
  tool: r.tool_name, exposedName: r.exposed_name, outcome: r.outcome, errorCode: r.error_code, errorMessage: r.error_message,
  argsBytes: r.args_bytes, resultBytes: r.result_bytes, traceId: r.trace_id,
});

/** Admins see everything; members see only their own calls. */
export function auditApi(d: Deps) {
  const app = new Hono<ApiEnv>();

  const filters = (c: Context<ApiEnv>) => {
    const me = c.get('user');
    const q = c.req.query();
    const conds = [d.sql`true`];
    if (me.role !== 'admin') conds.push(d.sql`user_id = ${me.id}`);
    else if (q.user) conds.push(d.sql`(user_email ILIKE ${'%' + q.user + '%'} OR user_id::text = ${q.user})`);
    if (q.server) conds.push(d.sql`upstream_slug = ${q.server}`);
    if (q.tool) conds.push(d.sql`(tool_name ILIKE ${'%' + q.tool + '%'} OR exposed_name ILIKE ${'%' + q.tool + '%'})`);
    if (q.outcome) conds.push(d.sql`outcome = ${q.outcome}`);
    if (q.via) conds.push(d.sql`via = ${q.via}`);
    if (q.from) conds.push(d.sql`ts >= ${new Date(q.from)}`);
    if (q.to) conds.push(d.sql`ts < ${new Date(q.to)}`);
    if (q.before) conds.push(d.sql`id < ${Number(q.before)}`);
    return conds.reduce((a, b) => d.sql`${a} AND ${b}`);
  };

  app.get('/', async (c) => {
    const limit = Math.min(500, Math.max(1, Number(c.req.query('limit') ?? 100)));
    const rows = await d.sql<AuditRow[]>`SELECT * FROM audit_events WHERE ${filters(c)} ORDER BY id DESC LIMIT ${limit}`;
    return c.json({ events: rows.map(view) });
  });

  app.get('/export.csv', async (c) => {
    const rows = await d.sql<AuditRow[]>`SELECT * FROM audit_events WHERE ${filters(c)} ORDER BY id DESC LIMIT 50000`;
    const cols = ['id', 'ts', 'userEmail', 'authMethod', 'credentialId', 'client', 'via', 'server', 'tool', 'outcome', 'errorCode', 'durationMs', 'argsBytes', 'resultBytes', 'traceId', 'errorMessage'] as const;
    const esc = (v: unknown) => {
      const s = v == null ? '' : String(v);
      // Also neutralise spreadsheet formula injection (=, +, -, @ at the start of a cell).
      const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
      return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
    };
    const csv = [cols.join(','), ...rows.map((r) => { const v = view(r); return cols.map((k) => esc(v[k])).join(','); })].join('\n');
    return c.body(csv, 200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="urumi-audit.csv"' });
  });

  /** Live tail over SSE, fed by NOTIFY so it works no matter which replica served the call. */
  app.get('/stream', (c) => {
    const me = c.get('user');
    return streamSSE(c, async (stream) => {
      const queue: number[] = [];
      let wake: (() => void) | undefined;
      const onEvent = (e: BusEvent) => {
        if (e.type === 'audit') {
          queue.push(e.id);
          wake?.();
        }
      };
      d.bus.on('event', onEvent);
      stream.onAbort(() => {
        d.bus.off('event', onEvent);
        wake?.();
      });
      while (!stream.aborted) {
        if (!queue.length) {
          await Promise.race([new Promise<void>((r) => (wake = r)), new Promise((r) => setTimeout(r, 20_000))]);
          if (!queue.length) {
            await stream.writeSSE({ event: 'ping', data: '' });
            continue;
          }
        }
        const ids = queue.splice(0);
        const rows = await d.sql<AuditRow[]>`
          SELECT * FROM audit_events WHERE id = ANY(${ids}) ${me.role === 'admin' ? d.sql`` : d.sql`AND user_id = ${me.id}`} ORDER BY id`;
        for (const r of rows) await stream.writeSSE({ event: 'audit', data: JSON.stringify(view(r)), id: String(r.id) });
      }
    });
  });

  /** Per-server summary for the overview page, straight from the audit table (no Prometheus needed). */
  app.get('/summary', async (c) => {
    const me = c.get('user');
    const scope = me.role === 'admin' ? d.sql`true` : d.sql`user_id = ${me.id}`;
    const rows = await d.sql<{ server: string; calls: number; errors: number; denied: number; p50: number | null; p95: number | null }[]>`
      SELECT upstream_slug AS server, count(*)::int AS calls,
             count(*) FILTER (WHERE outcome IN ('tool_error','timeout','unavailable','error'))::int AS errors,
             count(*) FILTER (WHERE outcome = 'denied')::int AS denied,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) AS p50,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95
      FROM audit_events WHERE ts > now() - interval '24 hours' AND upstream_slug IS NOT NULL AND ${scope}
      GROUP BY upstream_slug ORDER BY calls DESC`;
    return c.json({ servers: rows.map((r) => ({ ...r, p50: r.p50 == null ? null : Math.round(r.p50), p95: r.p95 == null ? null : Math.round(r.p95) })) });
  });

  return app;
}
