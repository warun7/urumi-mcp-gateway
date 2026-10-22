import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

/** Minimal dashboard-API client with a cookie jar, used by the e2e scripts. */
export class Dashboard {
  private cookie = '';
  constructor(readonly base: string) {}

  async req<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
    const res = await fetch(`${this.base}/api${path}`, {
      method,
      headers: { origin: this.base, ...(body ? { 'content-type': 'application/json' } : {}), ...(this.cookie ? { cookie: this.cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    });
    const set = res.headers.getSetCookie?.() ?? [];
    for (const c of set) if (/urumi_sid=/.test(c)) this.cookie = c.split(';')[0]!;
    const text = await res.text();
    let data: any = text;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* not json */
    }
    return { status: res.status, data };
  }
  get = <T = any>(p: string) => this.req<T>('GET', p);
  post = <T = any>(p: string, b?: unknown) => this.req<T>('POST', p, b ?? {});
  patch = <T = any>(p: string, b: unknown) => this.req<T>('PATCH', p, b);
  del = <T = any>(p: string) => this.req<T>('DELETE', p);

  async login(email: string, password: string) {
    const r = await this.post('/auth/login', { email, password });
    if (r.status !== 200) throw new Error(`login failed for ${email}: ${JSON.stringify(r.data)}`);
    return r.data.user;
  }
}

export async function mcpConnect(url: string, token: string, mode: 'auto' | 'legacy' = 'auto') {
  const client = new Client({ name: 'urumi-e2e', version: '0.1.0' }, { versionNegotiation: { mode } });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return client;
}

/** tools/list that bypasses the SDK's client-side cache (the gateway sends ttlMs), so tests see the server's truth. */
export async function toolNames(client: Client): Promise<string[]> {
  return (await client.listTools(undefined, { cacheMode: 'refresh' })).tools.map((t) => t.name);
}

export async function mcpStatus(url: string, token: string): Promise<number> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  return r.status;
}

export type ChatEvent = { event: string; data: any };
export type ChatMessage = { role: string; content?: string | null; tool_calls?: any[]; tool_call_id?: string };

/** One chat turn through the dashboard API (POST /api/chat, SSE), parsed into events. */
export async function chat(d: Dashboard, messages: ChatMessage[], approvals: Record<string, boolean> = {}) {
  const r = await d.post('/chat', { messages, approvals });
  const events: ChatEvent[] = [];
  for (const block of String(r.data).split(/\n\n/)) {
    const ev = /^event: (.*)$/m.exec(block)?.[1];
    const data = /^data: (.*)$/m.exec(block)?.[1];
    if (ev && data) events.push({ event: ev, data: JSON.parse(data) });
  }
  const of = (t: string) => events.filter((e) => e.event === t).map((e) => e.data);
  return {
    status: r.status,
    events,
    of,
    text: of('text').map((e) => e.delta).join(''),
    history: (of('messages')[0]?.messages ?? []) as ChatMessage[],
    done: of('done')[0]?.reason as string | undefined,
  };
}

let failures = 0;
export function check(cond: unknown, what: string, detail?: unknown) {
  if (cond) console.log(`  \x1b[32m✔\x1b[0m ${what}`);
  else {
    failures++;
    console.log(`  \x1b[31m✘ ${what}\x1b[0m${detail !== undefined ? `\n      ${JSON.stringify(detail).slice(0, 400)}` : ''}`);
  }
}
export const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
export const done = () => {
  console.log(failures ? `\n\x1b[31m${failures} check(s) failed\x1b[0m` : '\n\x1b[32mall checks passed\x1b[0m');
  process.exit(failures ? 1 : 0);
};
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/**
 * Polls fn until ok(value), or until the timeout, then returns the last value. A thrown error counts as "not yet":
 * these polls run while the cluster is changing (a pod killed, a store deleted), and one dropped connection must not
 * end the suite. If the time runs out on an error, that error is thrown.
 */
export async function eventually<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 30_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    let result: { v: T } | undefined;
    let err: unknown;
    try {
      result = { v: await fn() };
    } catch (e) {
      err = e;
      console.log(`     (retrying after: ${(e as Error)?.message ?? e})`);
    }
    if (result && ok(result.v)) return result.v;
    if (Date.now() >= until) {
      if (result) return result.v;
      throw err;
    }
    await sleep(1000);
  }
}
