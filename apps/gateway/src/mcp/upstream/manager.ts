import { EventEmitter } from 'node:events';
import { ProtocolError } from '@modelcontextprotocol/client';
import type { CallToolResult, Tool } from '@modelcontextprotocol/client';
import type { Config } from '../../config.js';
import type { SecretBox } from '../../crypto/secretbox.js';
import type { Sql } from '../../db/index.js';
import type { EventBus } from '../../events/bus.js';
import type { Logger } from '../../log.js';
import { Catalog } from '../catalog.js';
import { clean, cleanSchema, defHash, MAX_DESCRIPTION, QUARANTINE_FLAGS, scan } from '../hygiene.js';
import { assignNames } from '../naming.js';
import type { CatalogTool, ToolRow, UpstreamRow } from '../types.js';
import { compileSchema } from '../validate.js';
import { UpstreamConnection, type ConnectionSpec } from './connection.js';
import { classify, type StatusReason } from './errors.js';
import { BulkheadFullError } from './resilience.js';

export type CallOutcome = 'success' | 'tool_error' | 'timeout' | 'unavailable' | 'cancelled' | 'error';

export interface CallResult {
  outcome: CallOutcome;
  result: CallToolResult;
  errorCode?: string;
}

const FAILS_TO_UNREACHABLE = 2; // hysteresis: one blip doesn't hide a server's tools
const LEADER_LOCK = 'urumi:upstream-leader';

/**
 * Owns every upstream connection on this replica and the in-memory Catalog.
 *
 * All replicas: hold connections (for calls) and rebuild the Catalog from Postgres whenever a
 * `catalog` event arrives over NOTIFY.
 * Leader only (pg advisory lock): runs health checks and tool syncs, writes results to Postgres,
 * then NOTIFYs. One writer means no flapping from replicas that disagree.
 */
export class UpstreamManager extends EventEmitter<{ changed: [Catalog] }> {
  catalog = new Catalog([], [], 0);
  private readonly conns = new Map<string, UpstreamConnection>();
  private readonly fails = new Map<string, number>();
  private readonly syncing = new Map<string, Promise<void>>();
  private version = 0;
  private visibleSig = '';
  private reloadTimer?: NodeJS.Timeout;
  private leader = false;
  private leaderConn?: Awaited<ReturnType<Sql['reserve']>>;
  private healthTimer?: NodeJS.Timeout;
  private ticking = false;
  private stopped = false;
  private lastSyncAt = new Map<string, number>();

  constructor(
    private readonly sql: Sql,
    private readonly bus: EventBus,
    private readonly box: SecretBox,
    private readonly cfg: Config,
    private readonly log: Logger,
  ) {
    super();
  }

  get isLeader(): boolean {
    return this.leader;
  }

  async start(): Promise<void> {
    await this.reload();
    this.bus.on('event', (e) => {
      if (e.type === 'catalog') this.scheduleReload();
    });
    void this.campaign();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.healthTimer);
    await Promise.allSettled([...this.conns.values()].map((c) => c.close()));
    this.leaderConn?.release();
  }

  /** Tell every replica (including this one) that upstreams/tools/permissions changed. */
  async publishChange(): Promise<void> {
    await this.bus.publish({ type: 'catalog' });
    // Read-your-writes on this replica: an admin API call that changed something returns only after
    // the local catalog reflects it. Other replicas follow via NOTIFY within milliseconds.
    await this.reload();
  }

  private reloading: Promise<void> = Promise.resolve();

  private scheduleReload() {
    clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => void this.reload().catch((err) => this.log.error({ err }, 'catalog reload failed')), 50);
  }

  /** Reloads are serialized so a slow, older read can never overwrite a newer catalog. */
  reload(): Promise<void> {
    const next = this.reloading.then(() => this.loadCatalog());
    this.reloading = next.catch(() => {});
    return next;
  }

  private async loadCatalog(): Promise<void> {
    const ups = await this.sql<UpstreamRow[]>`SELECT * FROM upstreams ORDER BY slug`;
    const tools = await this.sql<ToolRow[]>`SELECT * FROM upstream_tools`;
    this.syncConnections(ups);
    this.catalog = new Catalog(ups, tools, ++this.version);
    const sig = this.catalog.tools.map((t) => `${t.exposedName}:${t.defHash}:${t.access}`).join('|');
    if (sig !== this.visibleSig) {
      this.visibleSig = sig;
      this.log.info({ tools: this.catalog.tools.length, version: this.version }, 'catalog changed');
    }
    // Emit on every reload: permissions may have changed even when the tool set did not.
    this.emit('changed', this.catalog);
    if (this.leader) for (const u of ups) if (u.enabled && u.status === 'pending') void this.checkOne(u);
  }

  // ---------------------------------------------------------------- connections
  private specFor(u: UpstreamRow): ConnectionSpec {
    const headers: Record<string, string> = { 'user-agent': 'urumi-mcp-gateway/0.1' };
    if (u.auth_type !== 'none' && u.credential_ct && u.credential_iv && u.credential_kid) {
      const secret = this.box.open({ ct: u.credential_ct, iv: u.credential_iv, kid: u.credential_kid }, u.id);
      if (u.auth_type === 'bearer') headers.authorization = `Bearer ${secret}`;
      else headers[(u.auth_header_name ?? 'x-api-key').toLowerCase()] = secret;
    }
    const trusted = u.managed_by === 'bootstrap' || u.managed_by?.startsWith('store/');
    return {
      id: u.id,
      slug: u.slug,
      url: u.url,
      headers,
      timeoutMs: u.timeout_ms,
      maxConcurrency: u.max_concurrency,
      policy: { internalHosts: [...this.cfg.SSRF_ALLOWED_INTERNAL_HOSTS, ...(trusted ? this.cfg.SSRF_PROVISIONER_HOSTS : [])] },
      prior: u.protocol_era ? { era: u.protocol_era, discover: u.discover_json ?? undefined } : undefined,
    };
  }

  private static specKey(s: ConnectionSpec) {
    return JSON.stringify([s.url, s.headers, s.timeoutMs, s.maxConcurrency, s.policy]);
  }

  private syncConnections(ups: UpstreamRow[]) {
    const live = new Set<string>();
    for (const u of ups) {
      if (!u.enabled) continue;
      let spec: ConnectionSpec;
      try {
        spec = this.specFor(u);
      } catch (err) {
        this.log.error({ upstream: u.slug, err: (err as Error).message }, 'cannot decrypt upstream credential');
        continue;
      }
      live.add(u.id);
      const existing = this.conns.get(u.id);
      if (existing && UpstreamManager.specKey(existing.spec) === UpstreamManager.specKey(spec)) {
        existing.spec.prior = spec.prior;
        continue;
      }
      void existing?.close();
      const conn = new UpstreamConnection(spec, this.log);
      conn.setToolsChangedHandler(() => {
        if (this.leader) {
          this.log.info({ upstream: u.slug }, 'upstream announced tools/list_changed');
          void this.syncTools(u.id);
        }
      });
      this.conns.set(u.id, conn);
    }
    for (const [id, c] of this.conns) {
      if (!live.has(id)) {
        void c.close();
        this.conns.delete(id);
      }
    }
  }

  connection(upstreamId: string): UpstreamConnection | undefined {
    return this.conns.get(upstreamId);
  }

  // ---------------------------------------------------------------- leader election
  private async campaign(): Promise<void> {
    while (!this.stopped && !this.leader) {
      try {
        const conn = await this.sql.reserve();
        const [row] = await conn<{ ok: boolean }[]>`SELECT pg_try_advisory_lock(hashtext(${LEADER_LOCK})) AS ok`;
        if (row?.ok) {
          this.leaderConn = conn;
          this.leader = true;
          this.log.info('elected leader for upstream health checks');
          this.healthTimer = setInterval(() => void this.tick(), this.cfg.HEALTH_INTERVAL_MS);
          void this.tick();
          return;
        }
        conn.release();
      } catch (err) {
        this.log.warn({ err: (err as Error).message }, 'leader election failed');
      }
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }

  private async stepDown(reason: string) {
    this.log.warn({ reason }, 'stepping down as leader');
    this.leader = false;
    clearInterval(this.healthTimer);
    try {
      this.leaderConn?.release();
    } catch {
      /* connection already gone */
    }
    this.leaderConn = undefined;
    void this.campaign();
  }

  // ---------------------------------------------------------------- health + sync (leader)
  private async tick(): Promise<void> {
    if (this.ticking || !this.leader) return;
    this.ticking = true;
    try {
      // Holding the session is what holds the lock; if this fails we may no longer be leader.
      await this.leaderConn!`SELECT 1`;
    } catch (err) {
      this.ticking = false;
      await this.stepDown((err as Error).message);
      return;
    }
    try {
      const ups = [...this.catalog.upstreams.values()].filter((u) => u.enabled);
      await Promise.allSettled(ups.map((u) => this.checkOne(u)));
    } finally {
      this.ticking = false;
    }
  }

  /** Health-check one upstream, update its status (with hysteresis), and sync tools when needed. */
  async checkOne(u: UpstreamRow): Promise<void> {
    const conn = this.conns.get(u.id);
    let status: UpstreamRow['status'] = u.status;
    let reason: StatusReason | 'CREDENTIAL_ERROR' | null = null;
    let detail: string | null = null;
    const now = new Date();
    if (!conn) {
      status = 'unreachable';
      reason = 'CREDENTIAL_ERROR';
      detail = 'Stored credential cannot be decrypted (key rotated or removed?)';
      await this.writeStatus(u, { status, reason, detail, checked: now });
      return;
    }
    try {
      const h = await conn.health();
      this.fails.set(u.id, 0);
      conn.breaker.reset();
      const becameUp = u.status !== 'connected';
      await this.sql`
        UPDATE upstreams SET
          status = 'connected', status_reason = NULL, status_detail = NULL,
          status_since = CASE WHEN status = 'connected' THEN status_since ELSE now() END,
          last_ok_at = now(), last_checked_at = now(), latency_ms = ${h.latencyMs},
          protocol_era = ${h.era}, protocol_version = ${h.protocolVersion ?? null},
          server_name = ${h.serverName ?? null}, server_version = ${h.serverVersion ?? null},
          discover_json = ${h.discover ? this.sql.json(h.discover as never) : null}
        WHERE id = ${u.id}`;
      const stale = Date.now() - (this.lastSyncAt.get(u.id) ?? 0) > this.cfg.SYNC_INTERVAL_MS;
      if (becameUp || stale || !u.tools_synced_at) await this.syncTools(u.id);
      if (becameUp) {
        this.log.info({ upstream: u.slug, era: h.era, version: h.protocolVersion }, 'upstream connected');
        await this.publishChange();
      }
    } catch (err) {
      const c = classify(err);
      const n = (this.fails.get(u.id) ?? 0) + 1;
      this.fails.set(u.id, n);
      const goDown = u.status === 'pending' || (u.status === 'connected' && n >= FAILS_TO_UNREACHABLE) || u.status === 'unreachable';
      this.log[u.status === 'connected' ? 'warn' : 'debug']({ upstream: u.slug, reason: c.reason, detail: c.detail, consecutive: n }, 'upstream health check failed');
      if (goDown) await this.writeStatus(u, { status: 'unreachable', reason: c.reason, detail: c.detail, checked: now });
      else await this.sql`UPDATE upstreams SET last_checked_at = now() WHERE id = ${u.id}`;
    }
  }

  private async writeStatus(u: UpstreamRow, s: { status: UpstreamRow['status']; reason: string | null; detail: string | null; checked: Date }) {
    const changed = u.status !== s.status || u.status_reason !== s.reason;
    await this.sql`
      UPDATE upstreams SET status = ${s.status}, status_reason = ${s.reason}, status_detail = ${s.detail},
        status_since = CASE WHEN status = ${s.status} AND status_reason IS NOT DISTINCT FROM ${s.reason} THEN status_since ELSE now() END,
        last_checked_at = ${s.checked}
      WHERE id = ${u.id}`;
    if (changed) {
      this.log.warn({ upstream: u.slug, status: s.status, reason: s.reason }, 'upstream status changed');
      await this.publishChange();
    }
  }

  /** Pull tools/list from one upstream and reconcile upstream_tools (TOFU + rug-pull pinning). */
  syncTools(upstreamId: string): Promise<void> {
    const running = this.syncing.get(upstreamId);
    if (running) return running;
    const p = this.doSync(upstreamId).finally(() => this.syncing.delete(upstreamId));
    this.syncing.set(upstreamId, p);
    return p;
  }

  private async doSync(upstreamId: string): Promise<void> {
    const conn = this.conns.get(upstreamId);
    const u = this.catalog.upstreams.get(upstreamId);
    if (!conn || !u) return;
    let tools: Tool[];
    try {
      tools = await conn.listTools();
    } catch (err) {
      this.log.warn({ upstream: u.slug, err: classify(err) }, 'tools/list failed; keeping previous catalog');
      return;
    }
    this.lastSyncAt.set(upstreamId, Date.now());
    const names = assignNames(u.slug, tools.map((t) => t.name));
    const existing = new Map((await this.sql<ToolRow[]>`SELECT * FROM upstream_tools WHERE upstream_id = ${upstreamId}`).map((r) => [r.name, r]));
    let changes = 0;

    await this.sql.begin(async (tx) => {
      for (const t of tools) {
        const flags = new Set<string>(scan(`${t.title ?? ''}\n${t.description ?? ''}`));
        const description = clean(t.description, MAX_DESCRIPTION);
        const title = t.title ? clean(t.title, 120) : null;
        let inputSchema: Record<string, unknown>;
        try {
          inputSchema = cleanSchema(t.inputSchema ?? { type: 'object' }, flags) as Record<string, unknown>;
          compileSchema(`probe:${upstreamId}:${t.name}:${Date.now()}`, inputSchema);
        } catch (err) {
          flags.add('invalid_schema');
          inputSchema = { type: 'object' };
          this.log.warn({ upstream: u.slug, tool: t.name, err: (err as Error).message }, 'tool has an unusable input schema');
        }
        const outputSchema = (t.outputSchema as Record<string, unknown> | undefined) ?? null;
        const annotations = (t.annotations as Record<string, unknown> | undefined) ?? null;
        const hash = defHash({ name: t.name, title: title ?? undefined, description, inputSchema, outputSchema, annotations });
        const exposed = names.get(t.name)!;
        const flagList = [...flags].sort();
        const quarantine = flagList.some((f) => QUARANTINE_FLAGS.has(f) || f === 'invalid_schema');
        const ex = existing.get(t.name);

        if (!ex) {
          // Trust on first use: an admin registered this server, so its initial tools are approved —
          // unless hygiene flagged them, in which case they wait for explicit approval.
          changes++;
          await tx`
            INSERT INTO upstream_tools (upstream_id, name, exposed_name, title, description, input_schema, output_schema, annotations,
                                        def_hash, approved_hash, access, flags)
            VALUES (${upstreamId}, ${t.name}, ${exposed}, ${title}, ${description}, ${tx.json(inputSchema as never)},
                    ${outputSchema ? tx.json(outputSchema as never) : null}, ${annotations ? tx.json(annotations as never) : null},
                    ${hash}, ${quarantine ? null : hash}, ${annotations?.readOnlyHint === true ? 'read' : 'write'}, ${flagList})`;
        } else if (ex.def_hash !== hash) {
          // Definition changed after approval: hide it until an admin re-approves ("rug pull" protection).
          // Platform-shipped servers (the bootstrap ones and store woo-mcp) are pinned by the image tag the
          // operator deploys instead, so an upgrade doesn't hide every store's tools; hygiene flags still quarantine.
          changes++;
          const platformOwned = u.managed_by === 'bootstrap' || !!u.managed_by?.startsWith('store/');
          const approve = platformOwned && !quarantine;
          const prev = ex.approved_hash === ex.def_hash
            ? { title: ex.title, description: ex.description, input_schema: ex.input_schema, output_schema: ex.output_schema, annotations: ex.annotations }
            : ex.previous_def;
          await tx`
            UPDATE upstream_tools SET exposed_name = ${exposed}, title = ${title}, description = ${description},
              input_schema = ${tx.json(inputSchema as never)}, output_schema = ${outputSchema ? tx.json(outputSchema as never) : null},
              annotations = ${annotations ? tx.json(annotations as never) : null}, def_hash = ${hash},
              approved_hash = ${approve ? hash : ex.approved_hash},
              previous_def = ${approve || hash === ex.approved_hash ? null : prev ? tx.json(prev as never) : null},
              flags = ${flagList}, present = true, last_seen_at = now(), changed_at = now()
            WHERE upstream_id = ${upstreamId} AND name = ${t.name}`;
          this.log.warn({ upstream: u.slug, tool: t.name, reapproval: !approve && hash !== ex.approved_hash }, 'tool definition changed');
        } else {
          if (!ex.present || ex.exposed_name !== exposed) changes++;
          await tx`UPDATE upstream_tools SET present = true, last_seen_at = now(), exposed_name = ${exposed}
                   WHERE upstream_id = ${upstreamId} AND name = ${t.name}`;
        }
      }
      const seen = tools.map((t) => t.name);
      const gone = await tx`UPDATE upstream_tools SET present = false
                            WHERE upstream_id = ${upstreamId} AND present AND NOT (name = ANY(${seen})) RETURNING name`;
      changes += gone.length;
      await tx`UPDATE upstreams SET tools_synced_at = now() WHERE id = ${upstreamId}`;
    });
    if (changes > 0) {
      this.log.info({ upstream: u.slug, tools: tools.length, changes }, 'tools synced');
      await this.publishChange();
    }
  }

  // ---------------------------------------------------------------- calls
  /**
   * Call one upstream tool with every isolation mechanism applied:
   * circuit breaker -> bulkhead (bounded concurrency) -> per-upstream timeout -> caller cancellation.
   * Never throws: every failure becomes an `isError` result the model can read.
   */
  async call(t: CatalogTool, args: Record<string, unknown>, signal: AbortSignal, meta?: Record<string, unknown>): Promise<CallResult> {
    const u = this.catalog.upstreams.get(t.upstreamId);
    const conn = this.conns.get(t.upstreamId);
    if (!u || !conn) return fail('unavailable', 'UPSTREAM_GONE', `Server '${t.slug}' is not available.`);
    if (!conn.breaker.allow())
      return fail('unavailable', 'CIRCUIT_OPEN', `Server '${t.slug}' is failing; calls are paused for a few seconds (circuit open). Other servers are unaffected.`);

    const idempotent = t.annotations?.readOnlyHint === true || t.annotations?.idempotentHint === true;
    for (let attempt = 1; ; attempt++) {
      const timeout = AbortSignal.timeout(u.timeout_ms);
      try {
        const result = await conn.bulkhead.run(
          () => conn.callTool(t.name, args, { signal: AbortSignal.any([signal, timeout]), timeoutMs: u.timeout_ms, meta }),
          signal,
        );
        conn.breaker.success();
        return { outcome: result.isError ? 'tool_error' : 'success', result };
      } catch (err) {
        if (signal.aborted) return fail('cancelled', 'CANCELLED', 'The request was cancelled by the client.');
        if (err instanceof BulkheadFullError)
          return fail('unavailable', 'BUSY', `Server '${t.slug}' is at its concurrency limit (${conn.bulkhead.limit}); try again shortly.`);
        if (err instanceof ProtocolError) {
          // The upstream answered with a JSON-RPC error: the server is alive, the call was bad.
          return fail('tool_error', `JSONRPC_${err.code}`, `Server '${t.slug}' rejected the call: ${err.message}`);
        }
        const c = classify(err);
        if (timeout.aborted || c.reason === 'TIMEOUT') {
          conn.breaker.failure();
          return fail('timeout', 'TIMEOUT', `Server '${t.slug}' did not answer ${t.name} within ${u.timeout_ms} ms. Other servers are unaffected.`);
        }
        conn.breaker.failure();
        await conn.reset(); // reconnect next time (also recovers a legacy session lost to an upstream restart)
        if (attempt === 1 && idempotent && c.reason !== 'AUTH_REJECTED' && c.reason !== 'SSRF_BLOCKED') {
          this.log.info({ upstream: t.slug, tool: t.name, reason: c.reason }, 'retrying idempotent call once after reconnect');
          continue;
        }
        return fail('unavailable', c.reason, `Server '${t.slug}' is unavailable (${c.reason}: ${c.detail}).`);
      }
    }
  }
}

function fail(outcome: CallOutcome, code: string, message: string): CallResult {
  return { outcome, errorCode: code, result: { content: [{ type: 'text', text: message }], isError: true } };
}
