import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { WooClient } from '../src/woo/client.js';

const TOKEN = 'test-token-0123456789';
const fakeWoo = {
  ping: async () => true,
  storeInfo: async () => ({ name: 'Test', url: 'http://shop.test', timezone: 'Asia/Kolkata', gmtOffsetHours: 5.5 }),
  get: async (path: string) => {
    if (path === '/products') return { data: [{ id: 1, name: 'Mug', sku: 'M1', status: 'publish', type: 'simple', price: '10', regular_price: '10', sale_price: '', stock_status: 'instock', stock_quantity: null, permalink: 'http://shop.test/mug', categories: [] }], total: 1, totalPages: 1 };
    throw new Error('unexpected ' + path);
  },
} as unknown as WooClient;

const { app } = createApp({ woo: fakeWoo, store: { name: 't', title: 'Test' }, authToken: TOKEN, log: pino({ level: 'silent' }) });

// A 2025-era (legacy) JSON-RPC request, which is what a pre-2026 client sends.
const rpc = (method: string, params: unknown = {}, headers: Record<string, string> = {}) =>
  app.request('/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });

describe('woo-mcp HTTP surface', () => {
  it('health endpoints need no auth', async () => {
    expect((await app.request('/healthz')).status).toBe(200);
    expect((await app.request('/readyz')).status).toBe(200);
  });

  it('rejects a missing or wrong bearer token', async () => {
    expect((await rpc('tools/list')).status).toBe(401);
    expect((await rpc('tools/list', {}, { authorization: 'Bearer nope' })).status).toBe(401);
  });

  it('rejects browser requests even with a valid token', async () => {
    expect((await rpc('tools/list', {}, { authorization: `Bearer ${TOKEN}`, origin: 'https://evil.example' })).status).toBe(403);
  });

  it('lists the tools with a valid token', async () => {
    const res = await rpc('tools/list', {}, { authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(200);
    const body = await readRpc(res);
    const names = body.result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(['create_product', 'get_order', 'get_product', 'get_store_info', 'list_orders', 'list_products', 'sales_summary', 'update_order_status']);
  });

  it('calls a tool and returns structured content', async () => {
    const res = await rpc('tools/call', { name: 'list_products', arguments: {} }, { authorization: `Bearer ${TOKEN}` });
    const body = await readRpc(res);
    expect(body.result.isError).toBeFalsy();
    expect(body.result.structuredContent.products[0].name).toBe('Mug');
  });
});

/** Legacy stateless responses may be JSON or a single-event SSE stream. */
async function readRpc(res: Response) {
  const text = await res.text();
  if (res.headers.get('content-type')?.includes('text/event-stream')) {
    const line = text.split('\n').find((l) => l.startsWith('data: '));
    return JSON.parse(line!.slice(6));
  }
  return JSON.parse(text);
}
