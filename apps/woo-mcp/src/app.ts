import { createHash, timingSafeEqual } from 'node:crypto';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Logger } from 'pino';
import { buildServer } from './tools.js';
import type { WooClient } from './woo/client.js';

export interface AppOptions {
  woo: WooClient;
  store: { name: string; title: string };
  authToken: string;
  log: Logger;
}

export function createApp({ woo, store, authToken, log }: AppOptions) {
  // One fresh McpServer per request (stateless). Serves both 2026-07-28 clients and
  // 2025-era clients (the gateway may speak either), via the SDK's stateless legacy fallback.
  const mcp = createMcpHandler(() => buildServer(woo, store, log), {
    legacy: 'stateless',
    responseMode: 'json',
    onerror: (err) => log.warn({ err: err.message }, 'mcp transport error'),
  });

  // Compare SHA-256 digests so the comparison is constant-time AND length-independent.
  const expected = createHash('sha256').update(authToken).digest();
  const tokenOk = (header: string | undefined) => {
    const m = /^Bearer (.+)$/.exec(header ?? '');
    return !!m && timingSafeEqual(createHash('sha256').update(m[1]!).digest(), expected);
  };

  const app = new Hono();
  app.get('/healthz', (c) => c.text('ok'));
  app.get('/readyz', async (c) => ((await woo.ping()) ? c.text('ok') : c.text('store not reachable', 503)));

  app.use('/mcp', bodyLimit({ maxSize: 1024 * 1024, onError: (c) => c.json({ error: 'body too large' }, 413) }));
  app.all('/mcp', async (c) => {
    // Server-to-server only: a browser Origin here means DNS rebinding or a confused deputy.
    if (c.req.header('origin')) return c.json({ error: 'browser requests are not accepted' }, 403);
    if (!tokenOk(c.req.header('authorization'))) {
      log.warn({ ip: c.req.header('x-forwarded-for') }, 'rejected request with bad/missing bearer token');
      return c.json({ error: 'unauthorized' }, 401, { 'www-authenticate': 'Bearer realm="woo-mcp"' });
    }
    return mcp.fetch(c.req.raw);
  });
  app.notFound((c) => c.json({ error: 'not found' }, 404));

  return { app, close: () => mcp.close() };
}
