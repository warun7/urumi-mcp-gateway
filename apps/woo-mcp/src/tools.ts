import { McpServer } from '@modelcontextprotocol/server';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Logger } from 'pino';
import { z } from 'zod';
import { WooClient, WooError } from './woo/client.js';
import { PERIODS, localDate, periodRange } from './woo/time.js';

// ---- WooCommerce response shapes (only the fields we use) --------------------------
interface WooProduct {
  id: number; name: string; sku: string; status: string; type: string;
  price: string; regular_price: string; sale_price: string;
  stock_status: string; stock_quantity: number | null; permalink: string;
  categories: { id: number; name: string }[]; description: string; short_description: string;
  date_created: string;
}
interface WooAddress { first_name: string; last_name: string; city: string; country: string; email?: string; phone?: string }
interface WooLineItem { name: string; product_id: number; sku: string; quantity: number; subtotal: string; total: string }
interface WooOrder {
  id: number; number: string; status: string; currency: string; total: string;
  date_created: string; date_modified: string; payment_method_title: string; customer_note: string;
  billing: WooAddress; shipping: WooAddress; line_items: WooLineItem[];
  shipping_lines: { method_title: string; total: string }[];
}

const ORDER_STATUSES = ['pending', 'processing', 'on-hold', 'completed', 'cancelled', 'refunded', 'failed'] as const;

// ---- PII minimisation: the model rarely needs full emails/phones -------------------
const maskEmail = (e?: string) => {
  if (!e || !e.includes('@')) return e ?? '';
  const [u, d] = e.split('@');
  return `${u!.slice(0, 1)}***@${d}`;
};
const maskPhone = (p?: string) => (p && p.length > 4 ? `***${p.slice(-4)}` : p ?? '');
/** WooCommerce returns some symbols as HTML entities (e.g. "&#8377;" for ₹). */
const decodeEntities = (s: string) =>
  s.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&amp;/g, '&');
const fullName = (a: WooAddress) => `${a.first_name} ${a.last_name}`.trim();

const productSummary = (p: WooProduct) => ({
  id: p.id, name: p.name, sku: p.sku, status: p.status, price: p.price,
  regular_price: p.regular_price, sale_price: p.sale_price || undefined,
  stock_status: p.stock_status, stock_quantity: p.stock_quantity,
  categories: p.categories.map((c) => c.name), permalink: p.permalink,
});

const orderSummary = (o: WooOrder) => ({
  id: o.id, number: o.number, status: o.status,
  date_created_local: o.date_created, total: o.total, currency: o.currency,
  customer_name: fullName(o.billing), customer_email: maskEmail(o.billing.email),
  payment_method: o.payment_method_title,
  items: o.line_items.map((i) => ({ name: i.name, quantity: i.quantity, total: i.total })),
});

// ---- result helpers ------------------------------------------------------------------
const ok = (data: Record<string, unknown>): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(data) }],
  structuredContent: data,
});
const fail = (message: string, code: string): CallToolResult => ({
  content: [{ type: 'text', text: `Error (${code}): ${message}` }],
  isError: true,
});

export function buildServer(woo: WooClient, store: { name: string; title: string }, log: Logger): McpServer {
  const server = new McpServer(
    { name: 'woo-mcp', version: '0.1.0', title: `WooCommerce: ${store.title}` },
    {
      instructions:
        `Tools for the WooCommerce store "${store.title}". Dates are in the store's timezone; ` +
        `use period="today" for questions about today. Prices are decimal strings in the store currency.`,
    },
  );

  /** Wrap every handler: uniform logging, and WooCommerce errors become readable tool errors. */
  const run = <A>(name: string, fn: (args: A, signal: AbortSignal) => Promise<CallToolResult>) =>
    async (args: A, ctx: { mcpReq: { signal: AbortSignal } }): Promise<CallToolResult> => {
      const started = performance.now();
      try {
        const res = await fn(args, ctx.mcpReq.signal);
        log.info({ tool: name, ms: Math.round(performance.now() - started), isError: !!res.isError }, 'tool call');
        return res;
      } catch (err) {
        const ms = Math.round(performance.now() - started);
        if (err instanceof WooError) {
          log.warn({ tool: name, ms, status: err.status, code: err.code, msg: err.message }, 'tool call failed');
          return fail(err.message, err.code);
        }
        log.error({ tool: name, ms, err }, 'tool call crashed');
        return fail('Unexpected error in woo-mcp', 'internal_error');
      }
    };

  server.registerTool(
    'get_store_info',
    {
      title: 'Store info',
      description: "Store name, URL, timezone, currency and the current local date/time. Call this first if you need to know what 'today' means for the store.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    run('get_store_info', async (_args, signal) => {
      const info = await woo.storeInfo(signal);
      const cur = await woo.get<{ code: string; symbol: string }>('/data/currencies/current', {}, signal);
      const now = new Date();
      return ok({
        name: info.name, url: info.url, timezone: info.timezone || `UTC${info.gmtOffsetHours >= 0 ? '+' : ''}${info.gmtOffsetHours}`,
        currency: cur.data.code, currency_symbol: decodeEntities(cur.data.symbol),
        today_local: localDate(info, now),
        now_local: info.timezone ? now.toLocaleString('sv-SE', { timeZone: info.timezone }) : undefined,
      });
    }),
  );

  server.registerTool(
    'list_products',
    {
      title: 'List products',
      description: 'Search and list products in the store catalog. Returns id, name, SKU, price, stock and storefront link.',
      inputSchema: z.object({
        search: z.string().max(100).optional().describe('Text to match in product name/description'),
        sku: z.string().max(100).optional().describe('Exact SKU'),
        status: z.enum(['publish', 'draft', 'pending', 'private', 'any']).default('any'),
        page: z.number().int().min(1).default(1),
        per_page: z.number().int().min(1).max(100).default(20),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    run('list_products', async (a, signal) => {
      const res = await woo.get<WooProduct[]>('/products', { search: a.search, sku: a.sku, status: a.status, page: a.page, per_page: a.per_page, orderby: 'date', order: 'desc' }, signal);
      return ok({ page: a.page, total: res.total, total_pages: res.totalPages, products: res.data.map(productSummary) });
    }),
  );

  server.registerTool(
    'get_product',
    {
      title: 'Get product',
      description: 'Full details of one product by id.',
      inputSchema: z.object({ product_id: z.number().int().positive() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    run('get_product', async (a, signal) => {
      const { data: p } = await woo.get<WooProduct>(`/products/${a.product_id}`, {}, signal);
      return ok({ ...productSummary(p), description: p.description, short_description: p.short_description, date_created_local: p.date_created });
    }),
  );

  server.registerTool(
    'create_product',
    {
      title: 'Create product',
      description:
        'Create a simple product that is immediately visible on the storefront (status "publish" by default). ' +
        'If a SKU is given and already exists, the existing product is returned instead of creating a duplicate.',
      inputSchema: z.object({
        name: z.string().min(1).max(200),
        regular_price: z.string().regex(/^\d+(\.\d{1,2})?$/, 'decimal string like "12.50"').describe('Price in the store currency, e.g. "12.50"'),
        description: z.string().max(5000).optional(),
        short_description: z.string().max(1000).optional(),
        sku: z.string().max(100).optional(),
        stock_quantity: z.number().int().min(0).optional().describe('Omit for unlimited stock'),
        categories: z.array(z.string().min(1).max(100)).max(10).optional().describe('Category names; created if missing'),
        status: z.enum(['publish', 'draft']).default('publish'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    run('create_product', async (a, signal) => {
      if (a.sku) {
        const existing = await woo.get<WooProduct[]>('/products', { sku: a.sku }, signal);
        if (existing.data.length > 0) return ok({ created: false, reason: 'sku_exists', product: productSummary(existing.data[0]!) });
      }
      const categoryIds: { id: number }[] = [];
      for (const name of a.categories ?? []) {
        const found = await woo.get<{ id: number; name: string }[]>('/products/categories', { search: name, per_page: 100 }, signal);
        const match = found.data.find((c) => c.name.toLowerCase() === name.toLowerCase());
        categoryIds.push({ id: match ? match.id : (await woo.post<{ id: number }>('/products/categories', { name }, signal)).data.id });
      }
      const { data: p } = await woo.post<WooProduct>('/products', {
        name: a.name, type: 'simple', status: a.status, regular_price: a.regular_price,
        description: a.description, short_description: a.short_description, sku: a.sku,
        manage_stock: a.stock_quantity !== undefined, stock_quantity: a.stock_quantity,
        categories: categoryIds.length ? categoryIds : undefined,
      }, signal);
      return ok({ created: true, product: productSummary(p) });
    }),
  );

  server.registerTool(
    'list_orders',
    {
      title: 'List orders',
      description:
        'List orders, newest first. For questions like "orders today" use period="today" — the date range is resolved ' +
        "in the store's timezone. Alternatively pass after/before as ISO dates (store-local). Customer emails are masked.",
      inputSchema: z.object({
        period: z.enum(PERIODS).optional().describe('Convenience date range in store-local time'),
        after: z.string().max(40).optional().describe('ISO 8601 date/time, store-local, exclusive'),
        before: z.string().max(40).optional().describe('ISO 8601 date/time, store-local, exclusive'),
        status: z.enum([...ORDER_STATUSES, 'any']).default('any'),
        search: z.string().max(100).optional(),
        page: z.number().int().min(1).default(1),
        per_page: z.number().int().min(1).max(100).default(20),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    run('list_orders', async (a, signal) => {
      const info = await woo.storeInfo(signal);
      const range = a.period ? periodRange(a.period, info) : undefined;
      const res = await woo.get<WooOrder[]>('/orders', {
        after: range?.after ?? a.after, before: range?.before ?? a.before,
        status: a.status, search: a.search, page: a.page, per_page: a.per_page, orderby: 'date', order: 'desc',
      }, signal);
      return ok({
        store: info.name, timezone: info.timezone,
        range: range ? { period: range.period, from: range.from, to_exclusive: range.to } : undefined,
        page: a.page, total: res.total, total_pages: res.totalPages, orders: res.data.map(orderSummary),
      });
    }),
  );

  server.registerTool(
    'get_order',
    {
      title: 'Get order',
      description: 'Full details of one order: line items, totals, shipping, payment method. Contact details are masked.',
      inputSchema: z.object({ order_id: z.number().int().positive() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    run('get_order', async (a, signal) => {
      const { data: o } = await woo.get<WooOrder>(`/orders/${a.order_id}`, {}, signal);
      return ok({
        ...orderSummary(o),
        date_modified_local: o.date_modified,
        customer_note: o.customer_note || undefined,
        billing: { name: fullName(o.billing), city: o.billing.city, country: o.billing.country, email: maskEmail(o.billing.email), phone: maskPhone(o.billing.phone) },
        shipping: { name: fullName(o.shipping), city: o.shipping.city, country: o.shipping.country },
        line_items: o.line_items.map((i) => ({ name: i.name, product_id: i.product_id, sku: i.sku, quantity: i.quantity, subtotal: i.subtotal, total: i.total })),
        shipping_lines: o.shipping_lines.map((s) => ({ method: s.method_title, total: s.total })),
      });
    }),
  );

  server.registerTool(
    'update_order_status',
    {
      title: 'Update order status',
      description: 'Change the status of an order (e.g. processing -> completed). Optionally adds a private order note.',
      inputSchema: z.object({
        order_id: z.number().int().positive(),
        status: z.enum(ORDER_STATUSES),
        note: z.string().max(1000).optional().describe('Private note added to the order'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    run('update_order_status', async (a, signal) => {
      const { data: before } = await woo.get<WooOrder>(`/orders/${a.order_id}`, {}, signal);
      const { data: after } = await woo.put<WooOrder>(`/orders/${a.order_id}`, { status: a.status }, signal);
      if (a.note) await woo.post(`/orders/${a.order_id}/notes`, { note: a.note, customer_note: false }, signal);
      return ok({ order_id: after.id, number: after.number, previous_status: before.status, status: after.status, note_added: !!a.note });
    }),
  );

  server.registerTool(
    'sales_summary',
    {
      title: 'Sales summary',
      description: 'Sales totals for a period (store-local time): order count, revenue and average order value, broken down by status. Useful for comparing stores.',
      inputSchema: z.object({ period: z.enum(PERIODS).default('today') }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    run('sales_summary', async (a, signal) => {
      const info = await woo.storeInfo(signal);
      const range = periodRange(a.period, info);
      const orders: WooOrder[] = [];
      for (let page = 1; page <= 10; page++) {
        const res = await woo.get<WooOrder[]>('/orders', { after: range.after, before: range.before, per_page: 100, page, status: 'any' }, signal);
        orders.push(...res.data);
        if (!res.totalPages || page >= res.totalPages) break;
      }
      const counted = orders.filter((o) => !['cancelled', 'failed', 'refunded', 'pending'].includes(o.status));
      const revenue = counted.reduce((s, o) => s + Number(o.total), 0);
      const byStatus: Record<string, { count: number; total: number }> = {};
      for (const o of orders) {
        const b = (byStatus[o.status] ??= { count: 0, total: 0 });
        b.count++;
        b.total = Math.round((b.total + Number(o.total)) * 100) / 100;
      }
      // With no orders there's no order currency to report; fall back to the store's (comparisons need it).
      const currency = orders[0]?.currency ?? (await woo.get<{ code: string }>('/data/currencies/current', {}, signal)).data.code;
      return ok({
        store: info.name, period: a.period, from: range.from, to_exclusive: range.to, timezone: info.timezone,
        currency, order_count: orders.length,
        revenue: Math.round(revenue * 100) / 100,
        revenue_note: 'revenue excludes pending, cancelled, failed and refunded orders',
        average_order_value: counted.length ? Math.round((revenue / counted.length) * 100) / 100 : 0,
        by_status: byStatus,
      });
    }),
  );

  return server;
}
