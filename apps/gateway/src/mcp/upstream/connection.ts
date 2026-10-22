import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { CallToolResult, DiscoverResult, McpSubscription, PriorDiscovery, Tool } from '@modelcontextprotocol/client';
import type { Logger } from '../../log.js';
import { Bulkhead, CircuitBreaker } from './resilience.js';
import { guardedFetch, type UrlPolicy } from './ssrf.js';

export interface ConnectionSpec {
  id: string;
  slug: string;
  url: string;
  /** Decrypted only in memory, only here. Never logged, never returned by the API. */
  headers: Record<string, string>;
  timeoutMs: number;
  maxConcurrency: number;
  policy: UrlPolicy;
  prior?: { era: 'modern' | 'legacy'; discover?: DiscoverResult };
}

export interface HealthInfo {
  latencyMs: number;
  era: 'modern' | 'legacy';
  protocolVersion?: string;
  serverName?: string;
  serverVersion?: string;
  discover?: DiscoverResult;
}

const CLIENT_INFO = { name: 'urumi-mcp-gateway', version: '0.1.0' };
const CONNECT_TIMEOUT_MS = 5_000;
const HEALTH_TIMEOUT_MS = 3_000;
const LIST_TIMEOUT_MS = 8_000;
/** A subscription that drops sooner than this after opening is not retried straight away (avoids a reconnect storm). */
const RELISTEN_MIN_UPTIME_MS = 30_000;

/**
 * One long-lived MCP client per upstream per gateway replica.
 * - Era-aware: probes `server/discover` (2026-07-28) and falls back to the 2025 `initialize` handshake,
 *   so the gateway bridges modern and legacy servers transparently.
 * - The negotiated era is cached (`prior`) to skip the probe on reconnect.
 * - Lazy: connects on first use; any transport-level failure drops the client so the next use reconnects.
 */
export class UpstreamConnection {
  readonly breaker = new CircuitBreaker();
  readonly bulkhead: Bulkhead;
  private client?: Client;
  private connecting?: Promise<Client>;
  private subscription?: McpSubscription;
  private onToolsChanged?: () => void;

  constructor(public spec: ConnectionSpec, private readonly log: Logger) {
    this.bulkhead = new Bulkhead(spec.maxConcurrency);
  }

  /** Called by the manager: upstream pushed notifications/tools/list_changed. */
  setToolsChangedHandler(fn: () => void) {
    this.onToolsChanged = fn;
  }

  get era(): 'modern' | 'legacy' | undefined {
    return this.client?.getProtocolEra() as 'modern' | 'legacy' | undefined;
  }

  async getClient(): Promise<Client> {
    if (this.client) return this.client;
    this.connecting ??= this.connect().finally(() => (this.connecting = undefined));
    return this.connecting;
  }

  private async connect(): Promise<Client> {
    const attempt = async (prior?: PriorDiscovery) => {
      const client = new Client(CLIENT_INFO, {
        versionNegotiation: { mode: 'auto', probe: { timeoutMs: CONNECT_TIMEOUT_MS } },
        listChanged: {
          tools: {
            // Era-transparent: a `subscriptions/listen` stream on modern servers, the legacy GET stream otherwise.
            onChanged: (err) => {
              if (!err) this.onToolsChanged?.();
            },
          },
        },
      });
      const transport = new StreamableHTTPClientTransport(new URL(this.spec.url), {
        fetch: guardedFetch(this.spec.policy) as never,
        requestInit: { headers: { ...this.spec.headers } },
      });
      client.onerror = (err) => this.log.debug({ upstream: this.spec.slug, err: err.message }, 'upstream client error');
      await client.connect(transport, { prior, timeout: CONNECT_TIMEOUT_MS });
      return client;
    };

    const p = this.spec.prior;
    const prior: PriorDiscovery | undefined =
      p?.era === 'modern' && p.discover ? { kind: 'modern', discover: p.discover } : p?.era === 'legacy' ? { kind: 'legacy' } : undefined;
    let client: Client;
    try {
      client = await attempt(prior);
    } catch (err) {
      if (!prior) throw err;
      // The cached era may be stale (server upgraded/downgraded): renegotiate from scratch once.
      this.log.info({ upstream: this.spec.slug }, 'cached protocol era failed; renegotiating');
      client = await attempt(undefined);
    }
    this.client = client;
    await this.watchToolChanges(client);
    return client;
  }

  /**
   * Make sure a modern upstream is actually pushing tools/list_changed to us.
   * The SDK opens `subscriptions/listen` itself only when it negotiates from scratch; a connect from a cached
   * `prior` registers the handlers but never opens the stream, so we open it here. The SDK also never re-opens
   * a dropped stream: when it ends we drop the client and ask for a sync, which reconnects (re-listening) and
   * catches any change made while we were not listening. Legacy servers use the GET stream, which the
   * transport manages on its own.
   */
  private async watchToolChanges(client: Client): Promise<void> {
    if (client.getProtocolEra() !== 'modern' || !client.getServerCapabilities()?.tools?.listChanged) return;
    if (this.subscription) return;
    let sub = client.autoOpenedSubscription;
    if (!sub) {
      try {
        sub = await client.listen({ toolsListChanged: true }, { timeout: CONNECT_TIMEOUT_MS });
      } catch (err) {
        // Not fatal: the periodic sync still catches changes, and the health tick retries the listen.
        this.log.warn({ upstream: this.spec.slug, err: (err as Error).message }, 'could not subscribe to tool changes');
        return;
      }
    }
    if (this.client !== client) {
      await sub.close().catch(() => undefined); // reset while we were subscribing
      return;
    }
    this.subscription = sub;
    const openedAt = Date.now();
    void sub.closed.then((how) => {
      if (how === 'local' || this.client !== client || this.subscription !== sub) return;
      const uptime = Date.now() - openedAt;
      this.log.info({ upstream: this.spec.slug, how, uptimeMs: uptime }, 'tool-change subscription ended');
      void this.reset().then(() => {
        if (uptime >= RELISTEN_MIN_UPTIME_MS) this.onToolsChanged?.();
      });
    });
  }

  /** Drop the client (e.g. after a transport error or a config change). Next use reconnects. */
  async reset(): Promise<void> {
    const c = this.client;
    const sub = this.subscription;
    this.client = undefined;
    this.subscription = undefined;
    await sub?.close().catch(() => undefined);
    await c?.close().catch(() => undefined);
  }

  /** Liveness: `server/discover` on modern servers, `ping` on legacy ones. */
  async health(): Promise<HealthInfo> {
    const started = performance.now();
    const client = await this.getClient();
    const era = client.getProtocolEra() as 'modern' | 'legacy';
    try {
      if (era === 'modern') await client.discover({ timeout: HEALTH_TIMEOUT_MS });
      else await client.ping({ timeout: HEALTH_TIMEOUT_MS });
      // A cached-prior connect makes no round trip, so the listen can fail while the client looks fine.
      if (!this.subscription) await this.watchToolChanges(client);
    } catch (err) {
      await this.reset();
      throw err;
    }
    const sv = client.getServerVersion();
    return {
      latencyMs: Math.round(performance.now() - started),
      era,
      protocolVersion: client.getNegotiatedProtocolVersion(),
      serverName: sv?.name,
      serverVersion: sv?.version,
      discover: era === 'modern' ? client.getDiscoverResult() : undefined,
    };
  }

  async listTools(): Promise<Tool[]> {
    const client = await this.getClient();
    try {
      const res = await client.listTools(undefined, { timeout: LIST_TIMEOUT_MS, cacheMode: 'bypass' });
      return res.tools;
    } catch (err) {
      await this.reset();
      throw err;
    }
  }

  async callTool(name: string, args: Record<string, unknown>, opts: { signal: AbortSignal; timeoutMs: number; meta?: Record<string, unknown> }): Promise<CallToolResult> {
    const client = await this.getClient();
    return (await client.callTool(
      { name, arguments: args, ...(opts.meta ? { _meta: opts.meta } : {}) },
      { signal: opts.signal, timeout: opts.timeoutMs, maxTotalTimeout: opts.timeoutMs },
    )) as CallToolResult;
  }

  async close(): Promise<void> {
    await this.reset();
  }
}
