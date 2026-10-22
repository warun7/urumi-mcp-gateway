/** The gateway's internal API (port 8081, reachable only from the provisioner by NetworkPolicy). */
export interface GatewayServer {
  status: string;
  statusReason?: string | null;
  statusDetail?: string | null;
}

export class GatewayClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private async call(method: string, path: string, body?: unknown) {
    const res = await fetch(`${this.baseUrl}/internal/v1/upstreams/${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    return res;
  }

  /** Idempotent upsert: safe to repeat on every reconcile. */
  async register(slug: string, b: { displayName: string; description: string; url: string; token: string; managedBy: string }) {
    const res = await this.call('PUT', slug, b);
    if (!res.ok) throw new Error(`gateway register ${slug}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  }

  async get(slug: string): Promise<{ server: GatewayServer; activeTools: number } | null> {
    const res = await this.call('GET', slug);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`gateway get ${slug}: ${res.status}`);
    return (await res.json()) as { server: GatewayServer; activeTools: number };
  }

  /** Idempotent: removing a store that is already gone is fine. */
  async deregister(slug: string) {
    const res = await this.call('DELETE', slug);
    if (!res.ok && res.status !== 404) throw new Error(`gateway deregister ${slug}: ${res.status}`);
  }
}
