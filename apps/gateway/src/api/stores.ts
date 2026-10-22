import { Hono } from 'hono';
import { z } from 'zod';
import { isConflict, isNotFound, Kube, STORE_GROUP, STORE_NAME_RE, STORE_VERSION, storesPath, type Store } from '@urumi/kube';
import { RESERVED_SLUGS } from '../mcp/naming.js';
import type { ApiEnv } from '../auth/sessions.js';
import { body, HttpError, type Deps } from './deps.js';

/** Names that would be confusing or clash with platform hostnames, on top of the gateway's reserved slugs. */
const RESERVED_STORE_NAMES = new Set([...RESERVED_SLUGS, 'default', 'www', 'shop', 'app', 'store', 'stores', 'platform', 'system', 'fetch', 'kube']);

export function storeView(s: Store, viewer: { id: string; role: string }) {
  return {
    name: s.metadata.name,
    displayName: s.spec.displayName,
    ownerId: s.spec.ownerId,
    ownerEmail: s.spec.ownerEmail ?? null,
    createdAt: s.metadata.creationTimestamp ?? null,
    deleting: !!s.metadata.deletionTimestamp,
    phase: s.metadata.deletionTimestamp ? 'Deleting' : (s.status?.phase ?? 'Pending'),
    url: s.status?.url ?? null,
    adminUrl: s.status?.adminUrl ?? null,
    namespace: s.status?.namespace ?? null,
    reason: s.status?.reason ?? null,
    message: s.status?.message ?? null,
    startedAt: s.status?.startedAt ?? null,
    readyAt: s.status?.readyAt ?? null,
    attempts: s.status?.attempts ?? 0,
    conditions: s.status?.conditions ?? [],
    canManage: viewer.role === 'admin' || s.spec.ownerId === viewer.id,
  };
}

/**
 * Bonus: self-service stores. The gateway only creates and deletes `Store` custom resources (a namespaced
 * Role on that one resource); the provisioner, a separate Deployment, does everything else. So the
 * internet-facing process never holds broad cluster permissions.
 */
export function storesApi(d: Deps) {
  const app = new Hono<ApiEnv>();
  const ns = d.cfg.STORES_NAMESPACE;
  let kube: Kube | undefined;
  const k8s = () => (kube ??= Kube.fromEnv());

  app.use('*', async (c, next) => {
    if (!ns) throw new HttpError(404, 'store provisioning is not enabled on this gateway');
    await next();
  });

  const list = async () => (await k8s().list<Store>(storesPath(ns))).items.sort((a, b) => (a.metadata.creationTimestamp ?? '').localeCompare(b.metadata.creationTimestamp ?? ''));
  const limitFor = (role: string) => (role === 'admin' ? d.cfg.STORES_MAX_PER_ADMIN : d.cfg.STORES_MAX_PER_USER);

  app.get('/', async (c) => {
    const u = c.get('user');
    const all = await list();
    const live = all.filter((s) => !s.metadata.deletionTimestamp);
    return c.json({
      stores: all.map((s) => storeView(s, u)),
      limits: { mine: live.filter((s) => s.spec.ownerId === u.id).length, perUser: limitFor(u.role), total: live.length, maxTotal: d.cfg.STORES_MAX_TOTAL },
      domain: d.cfg.STORE_BASE_DOMAIN,
    });
  });

  app.get('/:name', async (c) => {
    const s = await getStore(c.req.param('name'));
    return c.json({ store: storeView(s, c.get('user')) });
  });

  app.post('/', async (c) => {
    const u = c.get('user');
    const b = await body(c, z.object({
      name: z.string().regex(STORE_NAME_RE, '3 to 20 characters: lowercase letters, digits and hyphens, starting with a letter'),
      displayName: z.string().trim().min(1).max(60),
    }));
    if (RESERVED_STORE_NAMES.has(b.name)) throw new HttpError(422, `"${b.name}" is reserved`);
    // The store name becomes the MCP server slug (acme__list_orders), so it can't clash with another server.
    const [clash] = await d.sql<{ managed_by: string | null }[]>`SELECT managed_by FROM upstreams WHERE slug = ${b.name}`;
    if (clash && clash.managed_by !== `store/${b.name}`) throw new HttpError(409, `"${b.name}" is already used by an MCP server`);

    // One lock for every create, so concurrent clicks (or users) can't overshoot the limits.
    const result = await d.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('urumi:stores'))`;
      const live = (await list()).filter((s) => !s.metadata.deletionTimestamp);
      const existing = live.find((s) => s.metadata.name === b.name);
      if (existing) {
        // Idempotent: the same owner asking again gets the store it already has.
        if (existing.spec.ownerId === u.id) return { store: existing, created: false };
        throw new HttpError(409, `a store named "${b.name}" already exists`);
      }
      const mine = live.filter((s) => s.spec.ownerId === u.id).length;
      if (mine >= limitFor(u.role)) throw new HttpError(429, `you already have ${mine} store(s); the limit is ${limitFor(u.role)}`);
      if (live.length >= d.cfg.STORES_MAX_TOTAL) throw new HttpError(429, `this platform is at its limit of ${d.cfg.STORES_MAX_TOTAL} stores`);
      try {
        const store = await k8s().create<Store>(storesPath(ns), {
          apiVersion: `${STORE_GROUP}/${STORE_VERSION}`,
          kind: 'Store',
          metadata: { name: b.name, labels: { 'urumi.io/owner': u.id } },
          spec: { displayName: b.displayName, ownerId: u.id, ownerEmail: u.email, retryNonce: 0 },
        });
        return { store, created: true };
      } catch (e) {
        // Still being deleted from a previous life: the provisioner hasn't released the name yet.
        if (isConflict(e)) throw new HttpError(409, `a store named "${b.name}" is still being deleted; try again in a minute`);
        throw e;
      }
    });
    if (result.created) d.log.info({ store: b.name, by: u.email }, 'store requested');
    return c.json({ store: storeView(result.store, u) }, result.created ? 201 : 200);
  });

  app.delete('/:name', async (c) => {
    const u = c.get('user');
    const s = await getStore(c.req.param('name'));
    if (!storeView(s, u).canManage) throw new HttpError(403, 'only the owner or an admin can delete this store');
    await k8s().delete(storesPath(ns, s.metadata.name)).catch((e) => {
      if (!isNotFound(e)) throw e;
    });
    d.log.info({ store: s.metadata.name, by: u.email }, 'store deletion requested');
    return c.json({ ok: true }, 202);
  });

  app.post('/:name/retry', async (c) => {
    const u = c.get('user');
    const s = await getStore(c.req.param('name'));
    if (!storeView(s, u).canManage) throw new HttpError(403, 'only the owner or an admin can retry this store');
    if (s.status?.phase !== 'Failed') throw new HttpError(409, 'only a failed store can be retried');
    const updated = await k8s().mergePatch<Store>(storesPath(ns, s.metadata.name), {
      metadata: { resourceVersion: s.metadata.resourceVersion },
      spec: { retryNonce: (s.spec.retryNonce ?? 0) + 1 },
    });
    d.log.info({ store: s.metadata.name, by: u.email }, 'store retry requested');
    return c.json({ store: storeView(updated, u) }, 202);
  });

  async function getStore(name: string): Promise<Store> {
    if (!STORE_NAME_RE.test(name)) throw new HttpError(404, 'store not found');
    try {
      return await k8s().get<Store>(storesPath(ns, name));
    } catch (e) {
      if (isNotFound(e)) throw new HttpError(404, 'store not found');
      throw e;
    }
  }

  return app;
}
