import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { auditApi } from './api/audit.js';
import { accountApi, publicAuthApi } from './api/auth.js';
import { chatApi } from './api/chat.js';
import { HttpError, type Deps } from './api/deps.js';
import { keysApi } from './api/keys.js';
import { oauthApi } from './api/oauth.js';
import { permissionsApi } from './api/permissions.js';
import { serversApi } from './api/servers.js';
import { AuditLog } from './audit/audit.js';
import { BearerAuth } from './auth/bearer.js';
import { oauthServer } from './auth/oauth/server.js';
import { Sessions, type ApiEnv } from './auth/sessions.js';
import { bootstrap } from './bootstrap.js';
import { loadConfig } from './config.js';
import { SecretBox } from './crypto/secretbox.js';
import { Hasher } from './crypto/tokens.js';
import { connect, migrate, pendingMigrations } from './db/index.js';
import { EventBus } from './events/bus.js';
import { Freshness } from './events/freshness.js';
import { internalApi } from './internal/api.js';
import { storesApi } from './api/stores.js';
import { createLogger } from './log.js';
import { upstreamUp } from './metrics.js';
import { createMcpEndpoint } from './mcp/endpoint.js';
import { Router } from './mcp/router.js';
import { UpstreamManager } from './mcp/upstream/manager.js';
import { Permissions } from './policy/permissions.js';

const cfg = loadConfig();
const log = createLogger(cfg.LOG_LEVEL);

// `node index.mjs migrate`: run by the Helm initContainer with the schema-owner credentials, then exit.
if (process.argv[2] === 'migrate') {
  const sql = connect(process.env.MIGRATE_DATABASE_URL ?? cfg.DATABASE_URL, log, 1);
  await migrate(sql, log);
  await sql.end();
  log.info('migrations complete');
  process.exit(0);
}

const sql = connect(cfg.DATABASE_URL, log);
if (process.env.MIGRATE_ON_START === 'true') await migrate(sql, log); // local dev convenience
const pending = await pendingMigrations(sql);
if (pending.length) {
  log.fatal({ pending }, 'database schema is behind this version; run the migrate job first');
  process.exit(1);
}

const bus = new EventBus(sql, log);
await bus.start();
const hasher = new Hasher(cfg.TOKEN_PEPPER);
const box = new SecretBox(cfg.keks, cfg.activeKid);
const audit = new AuditLog(sql, bus, log);
const perms = new Permissions(sql);
await perms.reload();
const manager = new UpstreamManager(sql, bus, box, cfg, log);
const router = new Router(manager, perms, audit, cfg);
const sessions = new Sessions(sql, hasher, cfg);
const bearer = new BearerAuth(sql, hasher, cfg, bus);
const deps: Deps = { cfg, sql, log, bus, box, hasher, sessions, manager, router, perms, audit };

await bootstrap(deps);
// Permission rules are part of "what can this user see": reload them on the same signal as the catalog.
bus.on('event', (e) => {
  if (e.type === 'catalog') void perms.reload().catch((err) => log.error({ err }, 'permission reload failed'));
});
manager.on('changed', (cat) => {
  upstreamUp.reset();
  for (const u of cat.upstreams.values()) upstreamUp.set({ server: u.slug }, u.enabled && u.status === 'connected' ? 1 : 0);
});
const freshness = new Freshness(bus, log, async () => {
  bearer.flush();
  await Promise.all([manager.reload(), perms.reload()]);
});
await freshness.prime(); // before the first catalog load, so nothing committed after it is mistaken for applied
await manager.start();
const mcp = createMcpEndpoint({ cfg, bearer, router, manager, audit, freshness, log });

// ------------------------------------------------------------------ public app (behind the Ingress)
const app = new Hono();

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
  log.error({ err, path: c.req.path }, 'unhandled error');
  return c.json({ error: 'internal error' }, 500);
});

app.get('/healthz', (c) => c.text('ok'));
// Ready = DB reachable + schema current + catalog loaded. Upstreams are deliberately NOT checked:
// one dead MCP server must not take the whole gateway out of rotation.
app.get('/readyz', async (c) => {
  try {
    await sql`SELECT 1`;
    return c.text('ok');
  } catch {
    return c.text('database unreachable', 503);
  }
});

// MCP endpoint. CORS only so browser-based MCP clients (Inspector) work; auth is a bearer header, never a cookie.
app.use(
  '/mcp',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowHeaders: ['authorization', 'content-type', 'accept', 'mcp-protocol-version', 'mcp-method', 'mcp-name', 'mcp-session-id', 'last-event-id'],
    exposeHeaders: ['www-authenticate', 'mcp-session-id', 'mcp-protocol-version'],
  }),
);
app.use('/mcp', bodyLimit({ maxSize: 4 * 1024 * 1024, onError: (c) => c.json({ error: 'request too large' }, 413) }));
app.all('/mcp', (c) => mcp.handle(c));

app.route('/', oauthServer(deps));

// Dashboard JSON API (session cookie).
const api = new Hono<ApiEnv>();
api.use('*', secureHeaders());
api.use('*', async (c, next) => {
  await next();
  c.header('cache-control', 'no-store');
});
api.route('/', publicAuthApi(deps) as unknown as Hono<ApiEnv>);
const authed = new Hono<ApiEnv>();
authed.use('*', sessions.middleware());
authed.route('/', accountApi(deps));
authed.route('/servers', serversApi(deps));
authed.route('/keys', keysApi(deps));
authed.route('/audit', auditApi(deps));
authed.route('/permissions', permissionsApi(deps));
authed.route('/oauth', oauthApi(deps));
authed.route('/chat', chatApi(deps));
authed.route('/stores', storesApi(deps));
authed.get('/tools', (c) => {
  const u = c.get('user');
  const p = { userId: u.id, role: u.role };
  return c.json({
    tools: router.permitted({ ...p, email: u.email, name: u.name, authMethod: 'api_key', credentialId: '', via: 'mcp', toolMode: 'full', scopes: [] }).map((t) => ({
      name: t.exposedName, server: t.slug, serverName: t.serverName, title: t.title, description: t.description, access: t.access,
    })),
  });
});
api.route('/', authed);
app.route('/api', api);
app.notFound((c) => c.json({ error: 'not found' }, 404));

const server = serve({ fetch: app.fetch, port: cfg.PORT }, (i) => log.info({ port: i.port, publicUrl: cfg.PUBLIC_BASE_URL }, 'gateway listening'));
const internal = serve({ fetch: internalApi(deps).fetch, port: cfg.INTERNAL_PORT }, (i) => log.info({ port: i.port }, 'internal api listening'));

// Housekeeping (idempotent, any replica).
setInterval(() => {
  void sql`DELETE FROM sessions WHERE expires_at < now()`.catch(() => undefined);
  void sql`DELETE FROM oauth_codes WHERE expires_at < now() - interval '1 day'`.catch(() => undefined);
  void sql`DELETE FROM oauth_tokens WHERE expires_at < now() - interval '7 days'`.catch(() => undefined);
}, 10 * 60_000).unref();

let stopping = false;
async function shutdown(sig: string) {
  if (stopping) return;
  stopping = true;
  log.info({ sig }, 'shutting down');
  setTimeout(() => process.exit(0), 10_000).unref();
  server.close();
  internal.close();
  await mcp.handler.close().catch(() => undefined);
  await manager.stop().catch(() => undefined);
  await sql.end({ timeout: 5 }).catch(() => undefined);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
