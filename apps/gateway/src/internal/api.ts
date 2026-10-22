import { createHash, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { body, HttpError, type Deps } from '../api/deps.js';
import { serverView } from '../api/servers.js';
import { registry } from '../metrics.js';
import { SLUG_RE } from '../mcp/naming.js';
import type { UpstreamRow } from '../mcp/types.js';
import { classifyUrl, globToRegex } from '../mcp/upstream/ssrf.js';

/**
 * Internal port (8081), never routed by the Ingress; a NetworkPolicy lets only the provisioner reach it.
 * The provisioner registers each store's woo-mcp here. Upserts are idempotent so reconciles can repeat them.
 */
export function internalApi(d: Deps) {
  const app = new Hono();
  const expected = createHash('sha256').update(d.cfg.INTERNAL_TOKEN).digest();

  app.get('/metrics', async (c) => c.body(await registry.metrics(), 200, { 'content-type': registry.contentType }));

  app.use('/internal/*', async (c, next) => {
    const m = /^Bearer (.+)$/.exec(c.req.header('authorization') ?? '');
    if (!m || !timingSafeEqual(createHash('sha256').update(m[1]!).digest(), expected)) return c.json({ error: 'unauthorized' }, 401);
    await next();
  });

  app.put('/internal/v1/upstreams/:slug', async (c) => {
    const slug = c.req.param('slug');
    if (!SLUG_RE.test(slug)) throw new HttpError(422, 'bad slug');
    const b = await body(c, z.object({
      displayName: z.string().min(1).max(80),
      description: z.string().max(300).default(''),
      url: z.string().url(),
      token: z.string().min(16).max(4096),
      managedBy: z.string().regex(/^store\/[a-z0-9-]+$/),
    }));
    const host = new URL(b.url).hostname;
    if (!d.cfg.SSRF_PROVISIONER_HOSTS.some((g) => globToRegex(g).test(host))) throw new HttpError(422, `host ${host} is not an allowed store host`);
    classifyUrl(b.url, { internalHosts: d.cfg.SSRF_PROVISIONER_HOSTS });

    const [existing] = await d.sql<UpstreamRow[]>`SELECT * FROM upstreams WHERE slug = ${slug}`;
    if (existing && existing.managed_by !== b.managedBy) throw new HttpError(409, `slug "${slug}" is already used by another server`);
    // The provisioner re-sends this on every resync; only a real change should reload catalogs everywhere.
    let changed = false;
    if (existing) {
      const same = existing.url === b.url && existing.credential_ct && existing.credential_iv && existing.credential_kid &&
        d.box.open({ ct: existing.credential_ct, iv: existing.credential_iv, kid: existing.credential_kid }, existing.id) === b.token;
      if (!same) {
        const s = d.box.seal(b.token, existing.id);
        await d.sql`UPDATE upstreams SET url = ${b.url}, auth_type = 'bearer', credential_ct = ${s.ct}, credential_iv = ${s.iv}, credential_kid = ${s.kid},
                    status = CASE WHEN enabled THEN 'pending' ELSE 'disabled' END, protocol_era = NULL, discover_json = NULL, updated_at = now()
                    WHERE id = ${existing.id}`;
        changed = true;
      }
      if (existing.display_name !== b.displayName || existing.description !== b.description) {
        await d.sql`UPDATE upstreams SET display_name = ${b.displayName}, description = ${b.description} WHERE id = ${existing.id}`;
        changed = true;
      }
    } else {
      const [row] = await d.sql<{ id: string }[]>`
        INSERT INTO upstreams (slug, display_name, description, url, auth_type, managed_by, status, timeout_ms)
        VALUES (${slug}, ${b.displayName}, ${b.description}, ${b.url}, 'bearer', ${b.managedBy}, 'pending', 20000) RETURNING id`;
      const s = d.box.seal(b.token, row!.id);
      await d.sql`UPDATE upstreams SET credential_ct = ${s.ct}, credential_iv = ${s.iv}, credential_kid = ${s.kid} WHERE id = ${row!.id}`;
      d.log.info({ upstream: slug, managedBy: b.managedBy }, 'store upstream registered');
      changed = true;
    }
    if (changed) await d.manager.publishChange();
    const [u] = await d.sql<UpstreamRow[]>`SELECT * FROM upstreams WHERE slug = ${slug}`;
    return c.json({ server: serverView(u!) });
  });

  app.get('/internal/v1/upstreams/:slug', async (c) => {
    const [u] = await d.sql<UpstreamRow[]>`SELECT * FROM upstreams WHERE slug = ${c.req.param('slug')}`;
    if (!u) throw new HttpError(404, 'not found');
    const [t] = await d.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM upstream_tools WHERE upstream_id = ${u.id} AND present AND approved_hash = def_hash`;
    return c.json({ server: serverView(u), activeTools: t?.n ?? 0 });
  });

  app.delete('/internal/v1/upstreams/:slug', async (c) => {
    const r = await d.sql`DELETE FROM upstreams WHERE slug = ${c.req.param('slug')} AND managed_by LIKE 'store/%'`;
    if (r.count) {
      d.log.info({ upstream: c.req.param('slug') }, 'store upstream removed');
      await d.manager.publishChange();
    }
    return c.body(null, 204); // idempotent: deleting something already gone is fine
  });

  return app;
}
