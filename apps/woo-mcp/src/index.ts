import { serve } from '@hono/node-server';
import { pino } from 'pino';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { WooClient } from './woo/client.js';

const cfg = loadConfig();
const log = pino({ level: cfg.LOG_LEVEL, base: { svc: 'woo-mcp', store: cfg.STORE_NAME } });

const woo = new WooClient({
  baseUrl: cfg.WOO_BASE_URL.replace(/\/$/, ''),
  publicUrl: cfg.WOO_PUBLIC_URL,
  consumerKey: cfg.WOO_CONSUMER_KEY,
  consumerSecret: cfg.WOO_CONSUMER_SECRET,
  timeoutMs: cfg.REQUEST_TIMEOUT_MS,
  log,
});

const { app, close } = createApp({ woo, store: { name: cfg.STORE_NAME, title: cfg.STORE_TITLE }, authToken: cfg.MCP_AUTH_TOKEN, log });

const server = serve({ fetch: app.fetch, port: cfg.PORT }, (info) =>
  log.info({ port: info.port, store: cfg.WOO_PUBLIC_URL }, 'woo-mcp listening'),
);

let stopping = false;
const shutdown = (sig: string) => {
  if (stopping) return;
  stopping = true;
  log.info({ sig }, 'shutting down');
  server.close(() => process.exit(0));
  void close();
  setTimeout(() => process.exit(0), 8_000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
