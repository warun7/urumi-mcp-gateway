import type { Logger } from 'pino';
import { signOAuth1 } from './oauth1.js';
import type { StoreClock } from './time.js';

export class WooError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

export interface WooResponse<T> {
  data: T;
  total?: number;
  totalPages?: number;
}

export interface StoreInfo extends StoreClock {
  name: string;
  url: string;
}

interface Options {
  baseUrl: string; // in-cluster Service, e.g. http://wordpress:8080
  publicUrl: string; // WordPress home URL, used in the signature
  consumerKey: string;
  consumerSecret: string;
  timeoutMs: number;
  log: Logger;
}

/**
 * Thin WooCommerce REST v3 client.
 * Requests GO to the Service URL but are SIGNED with the public home URL: WooCommerce
 * rebuilds the OAuth base string from get_home_url(), not from the Host it was reached at
 * (verified against the live store; signing with the Service URL returns 401).
 */
export class WooClient {
  private infoCache?: { at: number; value: StoreInfo };
  private lastOkAt = 0;

  constructor(private readonly o: Options) {}

  get lastSuccessAt(): number {
    return this.lastOkAt;
  }

  async get<T>(path: string, query: Record<string, string | number | boolean | undefined> = {}, signal?: AbortSignal) {
    return this.request<T>('GET', path, query, undefined, signal);
  }
  async post<T>(path: string, body: unknown, signal?: AbortSignal) {
    return this.request<T>('POST', path, {}, body, signal);
  }
  async put<T>(path: string, body: unknown, signal?: AbortSignal) {
    return this.request<T>('PUT', path, {}, body, signal);
  }

  private async request<T>(
    method: string,
    path: string,
    rawQuery: Record<string, string | number | boolean | undefined>,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<WooResponse<T>> {
    const apiPath = `/wp-json/wc/v3${path}`;
    const query: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawQuery)) if (v !== undefined && v !== '') query[k] = String(v);

    const signed = signOAuth1({
      method,
      baseUrl: new URL(apiPath, this.o.publicUrl).toString().replace(/^https:/, 'http:'), // is_ssl() is false in-cluster
      query,
      consumerKey: this.o.consumerKey,
      consumerSecret: this.o.consumerSecret,
    });
    const url = `${this.o.baseUrl}${apiPath}?${new URLSearchParams(signed).toString()}`;

    const timeout = AbortSignal.timeout(this.o.timeoutMs);
    const started = performance.now();
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (err) {
      const e = err as Error;
      if (e.name === 'TimeoutError') throw new WooError(`WooCommerce did not answer within ${this.o.timeoutMs} ms`, 504, 'store_timeout');
      if (e.name === 'AbortError') throw new WooError('Request cancelled by caller', 499, 'cancelled');
      throw new WooError(`Cannot reach the store: ${e.message}`, 502, 'store_unreachable');
    }
    const ms = Math.round(performance.now() - started);
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      throw new WooError(`Store returned non-JSON (HTTP ${res.status})`, 502, 'bad_response');
    }
    this.o.log.debug({ method, path, status: res.status, ms }, 'woo request');
    if (!res.ok) {
      const j = (json ?? {}) as { code?: string; message?: string };
      throw new WooError(j.message ?? `HTTP ${res.status}`, res.status, j.code ?? 'woo_error');
    }
    this.lastOkAt = Date.now();
    const total = res.headers.get('x-wp-total');
    const pages = res.headers.get('x-wp-totalpages');
    return { data: json as T, total: total ? Number(total) : undefined, totalPages: pages ? Number(pages) : undefined };
  }

  /** Public REST index: name, timezone, gmt_offset. No auth needed. Cached 5 minutes. */
  async storeInfo(signal?: AbortSignal): Promise<StoreInfo> {
    if (this.infoCache && Date.now() - this.infoCache.at < 300_000) return this.infoCache.value;
    const res = await fetch(`${this.o.baseUrl}/wp-json/`, {
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.o.timeoutMs)]) : AbortSignal.timeout(this.o.timeoutMs),
    }).catch((e: Error) => {
      throw new WooError(`Cannot reach the store: ${e.message}`, 502, 'store_unreachable');
    });
    if (!res.ok) throw new WooError(`Store index returned HTTP ${res.status}`, 502, 'store_unreachable');
    const j = (await res.json()) as { name: string; home: string; timezone_string: string; gmt_offset: number | string };
    const value: StoreInfo = { name: j.name, url: j.home, timezone: j.timezone_string ?? '', gmtOffsetHours: Number(j.gmt_offset ?? 0) };
    this.infoCache = { at: Date.now(), value };
    this.lastOkAt = Date.now();
    return value;
  }

  /** Cheap readiness check: is WordPress answering at all? */
  async ping(): Promise<boolean> {
    if (Date.now() - this.lastOkAt < 10_000) return true;
    try {
      const res = await fetch(`${this.o.baseUrl}/ready.php`, { signal: AbortSignal.timeout(3_000) });
      if (res.ok) this.lastOkAt = Date.now();
      return res.ok;
    } catch {
      return false;
    }
  }
}
