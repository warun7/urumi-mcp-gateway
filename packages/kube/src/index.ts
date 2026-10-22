import { readFileSync } from 'node:fs';
import { Agent, fetch, type Dispatcher } from 'undici';

/**
 * A deliberately small Kubernetes REST client: the handful of verbs the gateway and the provisioner need.
 * `@kubernetes/client-node` is 61 MB of generated code for what is a dozen HTTP calls here, and this is
 * easier to audit. In a pod it uses the projected ServiceAccount token (re-read, since it rotates) and the
 * cluster CA; outside a cluster set KUBE_API_URL (e.g. `kubectl proxy` on http://127.0.0.1:8001).
 */
export class KubeError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}
export const isNotFound = (e: unknown) => e instanceof KubeError && e.status === 404;
export const isConflict = (e: unknown) => e instanceof KubeError && e.status === 409;
export const isGone = (e: unknown) => e instanceof KubeError && e.status === 410;

export interface ObjectMeta {
  name: string;
  namespace?: string;
  uid?: string;
  resourceVersion?: string;
  generation?: number;
  creationTimestamp?: string;
  deletionTimestamp?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  finalizers?: string[];
}
export interface KubeObject {
  apiVersion?: string;
  kind?: string;
  metadata: ObjectMeta;
  [k: string]: unknown;
}
export interface KubeList<T> {
  metadata: { resourceVersion: string };
  items: T[];
}
export interface WatchEvent<T> {
  type: 'ADDED' | 'MODIFIED' | 'DELETED' | 'BOOKMARK' | 'ERROR';
  object: T;
}

const SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';
const TOKEN_TTL_MS = 60_000;
export const FIELD_MANAGER = 'urumi';

type Query = Record<string, string | number | boolean | undefined>;
interface RequestOpts {
  body?: unknown;
  contentType?: string;
  query?: Query;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export class Kube {
  private token?: { value: string; at: number };
  private readonly dispatcher?: Dispatcher;

  constructor(
    readonly baseUrl: string,
    private readonly tokenFile?: string,
    ca?: string,
  ) {
    if (ca) this.dispatcher = new Agent({ connect: { ca } });
  }

  static fromEnv(): Kube {
    if (process.env.KUBE_API_URL) return new Kube(process.env.KUBE_API_URL.replace(/\/$/, ''));
    const host = process.env.KUBERNETES_SERVICE_HOST;
    if (!host) throw new Error('not running in a cluster and KUBE_API_URL is not set');
    const h = host.includes(':') ? `[${host}]` : host;
    return new Kube(`https://${h}:${process.env.KUBERNETES_SERVICE_PORT ?? 443}`, `${SA_DIR}/token`, readFileSync(`${SA_DIR}/ca.crt`, 'utf8'));
  }

  private authHeader(): Record<string, string> {
    if (!this.tokenFile) return {};
    if (!this.token || Date.now() - this.token.at > TOKEN_TTL_MS) this.token = { value: readFileSync(this.tokenFile, 'utf8').trim(), at: Date.now() };
    return { authorization: `Bearer ${this.token.value}` };
  }

  private url(path: string, query?: Query) {
    const u = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) u.searchParams.set(k, String(v));
    return u;
  }

  private async send(method: string, path: string, o: RequestOpts = {}) {
    const signal = o.signal ?? AbortSignal.timeout(o.timeoutMs ?? 15_000);
    const res = await fetch(this.url(path, o.query), {
      method,
      headers: { accept: 'application/json', ...this.authHeader(), ...(o.body !== undefined ? { 'content-type': o.contentType ?? 'application/json' } : {}) },
      body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
      signal,
      dispatcher: this.dispatcher,
    });
    if (!res.ok) {
      const text = await res.text();
      let status: { reason?: string; message?: string } = {};
      try {
        status = JSON.parse(text);
      } catch {
        /* not a Status object */
      }
      throw new KubeError(res.status, status.reason ?? res.statusText, `${method} ${path}: ${status.message ?? (text.slice(0, 300) || res.statusText)}`);
    }
    return res;
  }

  async request<T>(method: string, path: string, o?: RequestOpts): Promise<T> {
    const res = await this.send(method, path, o);
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  /** Plain-text endpoints (pod logs). */
  async text(path: string, query?: Query): Promise<string> {
    return (await this.send('GET', path, { query })).text();
  }
  get<T = KubeObject>(path: string, query?: Query) {
    return this.request<T>('GET', path, { query });
  }
  list<T = KubeObject>(path: string, query?: Query) {
    return this.request<KubeList<T>>('GET', path, { query });
  }
  create<T = KubeObject>(path: string, body: unknown) {
    return this.request<T>('POST', path, { body });
  }
  /** Server-side apply: idempotent create-or-update owned by our field manager. */
  apply<T = KubeObject>(path: string, body: unknown) {
    return this.request<T>('PATCH', path, { body, contentType: 'application/apply-patch+yaml', query: { fieldManager: FIELD_MANAGER, force: true } });
  }
  mergePatch<T = KubeObject>(path: string, body: unknown) {
    return this.request<T>('PATCH', path, { body, contentType: 'application/merge-patch+json' });
  }
  delete(path: string, query?: Query) {
    return this.request<unknown>('DELETE', path, { query });
  }

  /**
   * One watch request: calls `onEvent` for each event until the server ends the stream (normal, every few
   * minutes) or `signal` aborts. Throws KubeError 410 when `resourceVersion` is too old (caller re-lists).
   */
  async watch<T>(path: string, query: Query, onEvent: (e: WatchEvent<T>) => void, signal: AbortSignal): Promise<void> {
    const res = await this.send('GET', path, { query: { ...query, watch: true, allowWatchBookmarks: true }, signal });
    if (!res.body) return;
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk as Uint8Array, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const e = JSON.parse(line) as WatchEvent<T>;
        if (e.type === 'ERROR') {
          const s = e.object as { code?: number; reason?: string; message?: string };
          throw new KubeError(s.code ?? 500, s.reason ?? 'WatchError', s.message ?? 'watch error');
        }
        onEvent(e);
      }
    }
  }
}

/** The namespace this pod runs in (falls back to POD_NAMESPACE, then 'default'). */
export function currentNamespace(): string {
  if (process.env.POD_NAMESPACE) return process.env.POD_NAMESPACE;
  try {
    return readFileSync(`${SA_DIR}/namespace`, 'utf8').trim();
  } catch {
    return 'default';
  }
}

// ------------------------------------------------------------------ the Store custom resource

export const STORE_GROUP = 'urumi.io';
export const STORE_VERSION = 'v1alpha1';
export const storesPath = (ns: string, name?: string) => `/apis/${STORE_GROUP}/${STORE_VERSION}/namespaces/${ns}/stores${name ? `/${name}` : ''}`;

export type StorePhase = 'Provisioning' | 'Ready' | 'Failed' | 'Deleting';
export interface StoreCondition {
  type: string;
  status: 'True' | 'False' | 'Unknown';
  reason?: string;
  message?: string;
  lastTransitionTime: string;
}
export interface Store extends KubeObject {
  spec: { displayName: string; ownerId: string; ownerEmail?: string; retryNonce?: number };
  status?: {
    phase?: StorePhase;
    namespace?: string;
    url?: string;
    adminUrl?: string;
    startedAt?: string;
    readyAt?: string;
    attempts?: number;
    observedRetryNonce?: number;
    /** Hash of the chart version + values last deployed; a change (new chart, new defaults) triggers an upgrade. */
    releaseHash?: string;
    reason?: string;
    message?: string;
    conditions?: StoreCondition[];
  };
}

/** Store names double as DNS labels (`store-<name>`, `<name>.shop.…`) and as MCP tool prefixes (`<name>__list_orders`). */
export const STORE_NAME_RE = /^[a-z][a-z0-9-]{1,18}[a-z0-9]$/;
