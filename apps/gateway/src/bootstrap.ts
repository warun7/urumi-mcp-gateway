import { z } from 'zod';
import type { Deps } from './api/deps.js';
import { hashPassword } from './crypto/passwords.js';
import type { UpstreamRow } from './mcp/types.js';

const Seed = z.array(z.object({
  slug: z.string(),
  displayName: z.string(),
  description: z.string().default(''),
  url: z.string().url(),
  authType: z.enum(['none', 'bearer', 'header']).default('none'),
  authHeaderName: z.string().optional(),
  /** Name of the env var holding the credential (mounted from a Secret), never the value itself. */
  credentialEnv: z.string().optional(),
  timeoutMs: z.number().int().default(20_000),
}));

/**
 * First-start setup, safe to run on every start:
 *  - the first admin (from a Helm-generated Secret);
 *  - default permission rules (only when the team is first created);
 *  - "bootstrap" upstreams declared in Helm values (kept in sync with the Secret on every start);
 *  - KEK rotation: credentials sealed under an older key id are re-sealed under the active one.
 */
export async function bootstrap(d: Deps): Promise<void> {
  const { sql, cfg, log } = d;
  const [users] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM users`;
  if ((users?.n ?? 0) === 0) {
    if (!cfg.ADMIN_EMAIL || !cfg.ADMIN_PASSWORD) {
      log.warn('no users yet and ADMIN_EMAIL/ADMIN_PASSWORD not set: nobody can log in');
    } else {
      await sql`INSERT INTO users (email, name, role, password_hash) VALUES (${cfg.ADMIN_EMAIL.toLowerCase()}, 'Admin', 'admin', ${await hashPassword(cfg.ADMIN_PASSWORD)})`;
      // Members may use the fetch server's tool even though it doesn't declare readOnlyHint (it only reads the web).
      await sql`INSERT INTO permissions (subject_type, subject, server, tool, effect) VALUES ('role', 'member', 'fetch', '*', 'allow')`;
      log.info({ email: cfg.ADMIN_EMAIL }, 'bootstrap admin created');
    }
  }

  const seeds = Seed.parse(JSON.parse(cfg.BOOTSTRAP_UPSTREAMS));
  for (const s of seeds) {
    const credential = s.credentialEnv ? process.env[s.credentialEnv] : undefined;
    if (s.authType !== 'none' && !credential) {
      log.warn({ upstream: s.slug, env: s.credentialEnv }, 'bootstrap upstream skipped: credential env var is empty');
      continue;
    }
    const [existing] = await sql<UpstreamRow[]>`SELECT * FROM upstreams WHERE slug = ${s.slug}`;
    if (existing && existing.managed_by !== 'bootstrap') continue; // an admin took it over; don't fight them
    const id = existing?.id ?? crypto.randomUUID();
    const sealed = credential ? d.box.seal(credential, id) : null;
    const credSame = existing && credential && existing.credential_ct && existing.credential_iv && existing.credential_kid &&
      d.box.open({ ct: existing.credential_ct, iv: existing.credential_iv, kid: existing.credential_kid }, id) === credential;
    if (!existing) {
      await sql`
        INSERT INTO upstreams (id, slug, display_name, description, url, auth_type, auth_header_name, credential_ct, credential_iv, credential_kid, managed_by, timeout_ms)
        VALUES (${id}, ${s.slug}, ${s.displayName}, ${s.description}, ${s.url}, ${s.authType}, ${s.authHeaderName ?? null},
                ${sealed?.ct ?? null}, ${sealed?.iv ?? null}, ${sealed?.kid ?? null}, 'bootstrap', ${s.timeoutMs})`;
      log.info({ upstream: s.slug }, 'bootstrap upstream created');
    } else if (existing.url !== s.url || existing.auth_type !== s.authType || (credential && !credSame)) {
      await sql`
        UPDATE upstreams SET url = ${s.url}, auth_type = ${s.authType}, auth_header_name = ${s.authHeaderName ?? null},
          credential_ct = ${sealed?.ct ?? null}, credential_iv = ${sealed?.iv ?? null}, credential_kid = ${sealed?.kid ?? null},
          status = CASE WHEN enabled THEN 'pending' ELSE 'disabled' END, protocol_era = NULL, discover_json = NULL, updated_at = now()
        WHERE id = ${id}`;
      log.info({ upstream: s.slug }, 'bootstrap upstream updated from Helm values');
    }
  }

  // Idempotent, and safe with several replicas starting at once: the WHERE on the old kid turns a second writer into a no-op.
  const stale = await sql<UpstreamRow[]>`
    SELECT * FROM upstreams WHERE credential_kid IS NOT NULL AND credential_kid <> ${d.box.activeKid}`;
  let resealed = 0;
  for (const u of stale) {
    try {
      const s = d.box.seal(d.box.open({ ct: u.credential_ct!, iv: u.credential_iv!, kid: u.credential_kid! }, u.id), u.id);
      await sql`UPDATE upstreams SET credential_ct = ${s.ct}, credential_iv = ${s.iv}, credential_kid = ${s.kid}
        WHERE id = ${u.id} AND credential_kid = ${u.credential_kid}`;
      resealed++;
    } catch (err) {
      log.error({ err, upstream: u.slug, kid: u.credential_kid }, 'cannot re-seal credential: is its key still in KEK_KEYS?');
    }
  }
  if (stale.length) log.info({ resealed, of: stale.length, activeKid: d.box.activeKid }, 'KEK rotation: credentials re-sealed');
}
