import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { isGone, Kube, storesPath, type Store } from '@urumi/kube';
import { loadConfig } from './config.js';
import { GatewayClient } from './gateway.js';
import { Helm } from './helm.js';
import { createLogger } from './log.js';
import { WorkQueue } from './queue.js';
import { Reconciler } from './reconcile.js';

const cfg = loadConfig();
const log = createLogger(cfg.LOG_LEVEL);
const kube = Kube.fromEnv();
const chart = readFileSync(`${cfg.CHART_DIR}/Chart.yaml`, 'utf8');
const chartVersion = `${/^version:\s*(\S+)/m.exec(chart)?.[1] ?? '0'}+${/^appVersion:\s*"?([^"\n]+)/m.exec(chart)?.[1] ?? ''}`;

let queue: WorkQueue | undefined;
const helm = new Helm(cfg.HELM_BIN, log, (key) => queue?.add(key));
const reconciler = new Reconciler({ kube, helm, gateway: new GatewayClient(cfg.GATEWAY_INTERNAL_URL, cfg.INTERNAL_TOKEN), cfg, log, chartVersion });
queue = new WorkQueue((key) => reconciler.reconcile(key), cfg.CONCURRENCY, (key, err) =>
  log.error({ store: key, err: (err as Error).message }, 'reconcile failed; backing off'),
);

// ------------------------------------------------------------------ informer: list, then watch from that version
const stop = new AbortController();
let synced = false;
const path = storesPath(cfg.NAMESPACE);

async function listAll(): Promise<string> {
  const l = await kube.list<Store>(path);
  for (const s of l.items) queue!.add(s.metadata.name);
  synced = true;
  return l.metadata.resourceVersion;
}

async function informer() {
  while (!stop.signal.aborted) {
    try {
      let rv = await listAll();
      while (!stop.signal.aborted) {
        // The server ends a watch every few minutes; the client-side timeout covers a silently dead connection.
        const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(330_000)]);
        await kube.watch<Store>(path, { resourceVersion: rv, timeoutSeconds: 300 }, (e) => {
          rv = e.object.metadata.resourceVersion ?? rv;
          if (e.type !== 'BOOKMARK') queue!.add(e.object.metadata.name);
        }, signal);
      }
    } catch (err) {
      if (stop.signal.aborted) return;
      if (isGone(err)) continue; // our resourceVersion is too old: re-list
      if ((err as Error).name !== 'TimeoutError') log.warn({ err: (err as Error).message }, 'watch failed; re-listing shortly');
      await sleep(2_000).catch(() => undefined);
    }
  }
}

// Level-triggered safety net: even if an event were lost, every store is looked at again regularly.
const resync = setInterval(() => listAll().catch((err) => log.warn({ err: err.message }, 'resync list failed')), cfg.RESYNC_MS);

const server = createServer((req, res) => {
  if (req.url === '/healthz') return res.writeHead(200).end('ok');
  if (req.url === '/readyz') return res.writeHead(synced ? 200 : 503).end(synced ? 'ok' : 'not synced');
  res.writeHead(404).end();
});
server.listen(cfg.PORT, () =>
  log.info({ port: cfg.PORT, namespace: cfg.NAMESPACE, domain: cfg.STORE_DOMAIN, chart: chartVersion, concurrency: cfg.CONCURRENCY }, 'provisioner started'),
);
void informer();

function shutdown(sig: string) {
  log.info({ sig }, 'shutting down');
  stop.abort();
  clearInterval(resync);
  queue?.stop();
  // A Helm run killed here leaves its release pending-install; the next provisioner recovers it.
  helm.killAll();
  server.close();
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
