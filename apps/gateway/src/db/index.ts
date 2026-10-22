import postgres from 'postgres';
import type { Logger } from '../log.js';
import { migrations } from './migrations.js';

export type Sql = postgres.Sql<Record<string, unknown>>;

export function connect(url: string, log: Logger, max = 10): Sql {
  return postgres(url, {
    max,
    idle_timeout: 30,
    connect_timeout: 10,
    onnotice: (n) => log.debug({ notice: n.message }, 'pg notice'),
    transform: { undefined: null },
  });
}

/**
 * Apply pending migrations under a Postgres advisory lock, so several replicas
 * (or an initContainer racing a pod) never migrate concurrently.
 */
export async function migrate(sql: Sql, log: Logger): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('urumi:migrations'))`;
    await tx`CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
    const done = new Set((await tx<{ id: string }[]>`SELECT id FROM schema_migrations`).map((r) => r.id));
    for (const m of migrations) {
      if (done.has(m.id)) continue;
      log.info({ migration: m.id }, 'applying migration');
      await tx.unsafe(m.sql);
      await tx`INSERT INTO schema_migrations (id) VALUES (${m.id})`;
    }
    // Ownership-agnostic re-grant so tables added later are covered too.
    await tx.unsafe(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'urumi_app') THEN
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO urumi_app;
      REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM urumi_app;
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO urumi_app; END IF; END $$;`);
  });
}

export async function pendingMigrations(sql: Sql): Promise<string[]> {
  const exists = await sql`SELECT to_regclass('schema_migrations') AS t`;
  if (!exists[0]?.t) return migrations.map((m) => m.id);
  const done = new Set((await sql<{ id: string }[]>`SELECT id FROM schema_migrations`).map((r) => r.id));
  return migrations.filter((m) => !done.has(m.id)).map((m) => m.id);
}
