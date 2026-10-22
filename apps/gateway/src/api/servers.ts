import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { requireAdmin, type ApiEnv } from '../auth/sessions.js';
import { RESERVED_SLUGS, SLUG_RE } from '../mcp/naming.js';
import { toolState, type ToolRow, type UpstreamRow } from '../mcp/types.js';
import { classify } from '../mcp/upstream/errors.js';
import { assertResolvesPublic, classifyUrl, SsrfError } from '../mcp/upstream/ssrf.js';
import { body, HttpError, iso, type Deps } from './deps.js';

const AuthFields = {
  authType: z.enum(['none', 'bearer', 'header']).default('none'),
  authHeaderName: z.string().regex(/^[A-Za-z0-9-]{1,64}$/, 'letters, digits and dashes').optional(),
  /** Write-only. Omitted or empty on edit = keep the stored value. */
  credential: z.string().max(4096).optional(),
};

const CreateServer = z.object({
  slug: z.string().regex(SLUG_RE, 'lowercase letters, digits, dashes; starts with a letter; max 20 chars'),
  displayName: z.string().min(1).max(80),
  description: z.string().max(300).default(''),
  url: z.string().url().max(500),
  ...AuthFields,
  timeoutMs: z.number().int().min(1000).max(120_000).default(20_000),
  maxConcurrency: z.number().int().min(1).max(256).default(16),
  enabled: z.boolean().default(true),
});

const UpdateServer = z.object({
  displayName: z.string().min(1).max(80).optional(),
  description: z.string().max(300).optional(),
  url: z.string().url().max(500).optional(),
  // No default here: an omitted field means "unchanged" (a default would silently reset auth to none).
  authType: z.enum(['none', 'bearer', 'header']).optional(),
  authHeaderName: AuthFields.authHeaderName,
  credential: AuthFields.credential,
  timeoutMs: z.number().int().min(1000).max(120_000).optional(),
  maxConcurrency: z.number().int().min(1).max(256).optional(),
  enabled: z.boolean().optional(),
});

/** What the API returns. Credentials never leave the gateway: only whether one is set. */
export function serverView(u: UpstreamRow, toolCounts?: { active: number; pending: number; total: number }) {
  return {
    id: u.id,
    slug: u.slug,
    displayName: u.display_name,
    description: u.description,
    url: u.url,
    authType: u.auth_type,
    authHeaderName: u.auth_header_name,
    credentialSet: !!u.credential_ct,
    enabled: u.enabled,
    managedBy: u.managed_by,
    timeoutMs: u.timeout_ms,
    maxConcurrency: u.max_concurrency,
    status: u.enabled ? u.status : 'disabled',
    statusReason: u.status_reason,
    statusDetail: u.status_detail,
    statusSince: iso(u.status_since),
    lastOkAt: iso(u.last_ok_at),
    lastCheckedAt: iso(u.last_checked_at),
    latencyMs: u.latency_ms,
    protocolEra: u.protocol_era,
    protocolVersion: u.protocol_version,
    serverName: u.server_name,
    serverVersion: u.server_version,
    toolsSyncedAt: iso(u.tools_synced_at),
    tools: toolCounts,
    createdAt: iso(u.created_at),
  };
}

function toolView(t: ToolRow) {
  return {
    name: t.name,
    exposedName: t.exposed_name,
    title: t.title,
    description: t.description,
    inputSchema: t.input_schema,
    annotations: t.annotations,
    state: toolState(t),
    access: t.access,
    suggestedAccess: t.annotations?.readOnlyHint === true ? 'read' : 'write',
    pinned: t.pinned,
    flags: t.flags,
    previous: t.previous_def,
    firstSeenAt: iso(t.first_seen_at),
    changedAt: iso(t.changed_at),
  };
}

export function serversApi(d: Deps) {
  const app = new Hono<ApiEnv>();

  const getRow = async (id: string) => {
    if (!z.string().uuid().safeParse(id).success) throw new HttpError(404, 'server not found');
    const [u] = await d.sql<UpstreamRow[]>`SELECT * FROM upstreams WHERE id = ${id}`;
    if (!u) throw new HttpError(404, 'server not found');
    return u;
  };

  /** SSRF check at registration: scheme, hostname rules, and the current DNS answer. */
  const checkUrl = async (url: string) => {
    try {
      const { url: u, kind } = classifyUrl(url, { internalHosts: d.cfg.SSRF_ALLOWED_INTERNAL_HOSTS });
      if (kind === 'public') await assertResolvesPublic(u.hostname.replace(/^\[|\]$/g, ''));
    } catch (err) {
      if (err instanceof SsrfError) throw new HttpError(422, `URL not allowed: ${err.message}`);
      throw new HttpError(422, `URL not allowed: cannot resolve host (${(err as Error).message})`);
    }
  };

  const seal = (id: string, authType: string, credential?: string) => {
    if (authType === 'none' || !credential) return { ct: null, iv: null, kid: null };
    const s = d.box.seal(credential, id);
    return { ct: s.ct, iv: s.iv, kid: s.kid };
  };

  app.get('/', async (c) => {
    const ups = await d.sql<UpstreamRow[]>`SELECT * FROM upstreams ORDER BY created_at`;
    const tools = await d.sql<ToolRow[]>`SELECT upstream_id, present, enabled, approved_hash, def_hash FROM upstream_tools`;
    const counts = new Map<string, { active: number; pending: number; total: number }>();
    for (const t of tools) {
      const k = counts.get(t.upstream_id) ?? { active: 0, pending: 0, total: 0 };
      const s = toolState(t);
      if (s !== 'gone') k.total++;
      if (s === 'active') k.active++;
      if (s === 'pending_new' || s === 'pending_changed') k.pending++;
      counts.set(t.upstream_id, k);
    }
    return c.json({ servers: ups.map((u) => serverView(u, counts.get(u.id) ?? { active: 0, pending: 0, total: 0 })) });
  });

  app.get('/:id', async (c) => {
    const u = await getRow(c.req.param('id'));
    const tools = await d.sql<ToolRow[]>`SELECT * FROM upstream_tools WHERE upstream_id = ${u.id} ORDER BY name`;
    return c.json({ server: serverView(u), tools: tools.map(toolView) });
  });

  app.post('/', requireAdmin, async (c) => {
    const b = await body(c, CreateServer);
    if (RESERVED_SLUGS.has(b.slug)) throw new HttpError(422, `"${b.slug}" is reserved`);
    if (b.authType === 'header' && !b.authHeaderName) throw new HttpError(422, 'authHeaderName is required for header auth');
    if (b.authType !== 'none' && !b.credential) throw new HttpError(422, 'credential is required for this auth type');
    await checkUrl(b.url);
    const id = randomUUID();
    const cred = seal(id, b.authType, b.credential);
    try {
      await d.sql`
        INSERT INTO upstreams (id, slug, display_name, description, url, auth_type, auth_header_name,
          credential_ct, credential_iv, credential_kid, enabled, timeout_ms, max_concurrency, status, created_by)
        VALUES (${id}, ${b.slug}, ${b.displayName}, ${b.description}, ${b.url}, ${b.authType},
          ${b.authType === 'header' ? b.authHeaderName! : null}, ${cred.ct}, ${cred.iv}, ${cred.kid}, ${b.enabled},
          ${b.timeoutMs}, ${b.maxConcurrency}, ${b.enabled ? 'pending' : 'disabled'}, ${c.get('user').id})`;
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new HttpError(409, `a server with slug "${b.slug}" already exists`);
      throw err;
    }
    d.log.info({ upstream: b.slug, by: c.get('user').email }, 'server registered');
    await d.manager.publishChange();
    return c.json({ server: serverView(await getRow(id)) }, 201);
  });

  app.patch('/:id', requireAdmin, async (c) => {
    const u = await getRow(c.req.param('id'));
    const b = await body(c, UpdateServer);
    if (u.managed_by?.startsWith('store/') && Object.keys(b).some((k) => k !== 'enabled'))
      throw new HttpError(409, `managed by ${u.managed_by}: only enable/disable is allowed here (delete the store to remove it)`);
    if (b.url) await checkUrl(b.url);

    const authType = b.authType ?? u.auth_type;
    const headerName = authType === 'header' ? (b.authHeaderName ?? u.auth_header_name) : null;
    if (authType === 'header' && !headerName) throw new HttpError(422, 'authHeaderName is required for header auth');
    let cred = { ct: u.credential_ct, iv: u.credential_iv, kid: u.credential_kid };
    if (authType === 'none') cred = { ct: null, iv: null, kid: null };
    else if (b.credential) cred = seal(u.id, authType, b.credential);
    else if (!u.credential_ct) throw new HttpError(422, 'credential is required for this auth type');

    const connectionChanged = (b.url && b.url !== u.url) || b.authType !== undefined || !!b.credential || b.authHeaderName !== undefined;
    const enabled = b.enabled ?? u.enabled;
    const status = !enabled ? 'disabled' : connectionChanged || !u.enabled ? 'pending' : u.status;
    await d.sql`
      UPDATE upstreams SET
        display_name = ${b.displayName ?? u.display_name}, description = ${b.description ?? u.description},
        url = ${b.url ?? u.url}, auth_type = ${authType}, auth_header_name = ${headerName},
        credential_ct = ${cred.ct}, credential_iv = ${cred.iv}, credential_kid = ${cred.kid},
        timeout_ms = ${b.timeoutMs ?? u.timeout_ms}, max_concurrency = ${b.maxConcurrency ?? u.max_concurrency},
        enabled = ${enabled}, status = ${status},
        status_reason = ${status === u.status ? u.status_reason : null}, status_detail = ${status === u.status ? u.status_detail : null},
        status_since = ${status === u.status ? u.status_since : new Date()},
        protocol_era = ${connectionChanged ? null : u.protocol_era}, discover_json = ${connectionChanged ? null : u.discover_json ? d.sql.json(u.discover_json as never) : null},
        updated_at = now()
      WHERE id = ${u.id}`;
    d.log.info({ upstream: u.slug, by: c.get('user').email, enabled, connectionChanged }, 'server updated');
    await d.manager.publishChange();
    return c.json({ server: serverView(await getRow(u.id)) });
  });

  app.delete('/:id', requireAdmin, async (c) => {
    const u = await getRow(c.req.param('id'));
    if (u.managed_by?.startsWith('store/')) throw new HttpError(409, `managed by ${u.managed_by}: delete the store instead`);
    await d.sql`DELETE FROM upstreams WHERE id = ${u.id}`;
    d.log.info({ upstream: u.slug, by: c.get('user').email }, 'server removed');
    await d.manager.publishChange();
    return c.body(null, 204);
  });

  /** "Test connection": run a health check right now from this replica and report what happened. */
  app.post('/:id/check', requireAdmin, async (c) => {
    const u = await getRow(c.req.param('id'));
    const conn = d.manager.connection(u.id);
    if (!conn) return c.json({ ok: false, reason: u.enabled ? 'CREDENTIAL_ERROR' : 'DISABLED' });
    try {
      const h = await conn.health();
      const tools = await conn.listTools();
      await d.sql`UPDATE upstreams SET status = 'pending' WHERE id = ${u.id} AND status <> 'connected'`;
      // A connected server is only re-synced on push or the periodic tick; "Test connection" should be instant.
      if (u.status === 'connected' && d.manager.isLeader) await d.manager.syncTools(u.id);
      await d.manager.publishChange(); // nudge the leader to re-check and sync now
      return c.json({ ok: true, latencyMs: h.latencyMs, era: h.era, protocolVersion: h.protocolVersion, server: h.serverName, tools: tools.length });
    } catch (err) {
      return c.json({ ok: false, ...classify(err) });
    }
  });

  const ToolPatch = z.object({
    approve: z.literal(true).optional(),
    enabled: z.boolean().optional(),
    access: z.enum(['read', 'write']).optional(),
    pinned: z.boolean().optional(),
  });

  /** Approve a quarantined/changed tool, toggle it, or (re)classify it as read/write for member defaults. */
  app.patch('/:id/tools/:name', requireAdmin, async (c) => {
    const u = await getRow(c.req.param('id'));
    const b = await body(c, ToolPatch);
    const [t] = await d.sql<ToolRow[]>`SELECT * FROM upstream_tools WHERE upstream_id = ${u.id} AND name = ${c.req.param('name')}`;
    if (!t) throw new HttpError(404, 'tool not found');
    await d.sql`
      UPDATE upstream_tools SET
        approved_hash = ${b.approve ? t.def_hash : t.approved_hash},
        previous_def = ${b.approve ? null : t.previous_def ? d.sql.json(t.previous_def as never) : null},
        enabled = ${b.enabled ?? t.enabled}, access = ${b.access ?? t.access}, pinned = ${b.pinned ?? t.pinned}
      WHERE upstream_id = ${u.id} AND name = ${t.name}`;
    d.log.info({ upstream: u.slug, tool: t.name, ...b, by: c.get('user').email }, 'tool updated');
    await d.manager.publishChange();
    const [after] = await d.sql<ToolRow[]>`SELECT * FROM upstream_tools WHERE upstream_id = ${u.id} AND name = ${t.name}`;
    return c.json({ tool: toolView(after!) });
  });

  app.post('/:id/tools/approve-all', requireAdmin, async (c) => {
    const u = await getRow(c.req.param('id'));
    const r = await d.sql`UPDATE upstream_tools SET approved_hash = def_hash, previous_def = NULL
                          WHERE upstream_id = ${u.id} AND present AND approved_hash IS DISTINCT FROM def_hash`;
    await d.manager.publishChange();
    return c.json({ approved: r.count });
  });

  return app;
}
