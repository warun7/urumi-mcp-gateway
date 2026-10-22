import { describe, expect, it } from 'vitest';
import { Catalog } from '../src/mcp/catalog.js';
import { actionFit, isAggregateTool, queryIntent, stem, ToolIndex, splitIdent, toolVerb } from '../src/mcp/search.js';
import type { ToolRow, UpstreamRow } from '../src/mcp/types.js';

const up = { id: 'u1', slug: 'woo', display_name: 'Urumi Demo Store', enabled: true, status: 'connected' } as UpstreamRow;
const tool = (name: string, description: string, props: Record<string, string> = {}): ToolRow => ({
  upstream_id: 'u1', name, exposed_name: `woo__${name}`, title: null, description,
  input_schema: { type: 'object', properties: Object.fromEntries(Object.entries(props).map(([k, d]) => [k, { type: 'string', description: d }])) },
  output_schema: null, annotations: null, def_hash: 'h', approved_hash: 'h', previous_def: null, access: 'read', flags: [],
  present: true, enabled: true, pinned: false, first_seen_at: new Date(), last_seen_at: new Date(), changed_at: null,
});

const cat = new Catalog([up], [
  tool('sales_summary', 'Order count and revenue for a period (store-local time), broken down by status. Useful for comparing stores.', { period: 'today etc' }),
  tool('list_orders', 'List orders, newest first. For questions like "orders today" use period="today".'),
  tool('create_product', 'Create a simple product that is immediately visible on the storefront.'),
  tool('list_products', 'Search and list products in the store catalog.'),
], 1);

describe('ToolIndex', () => {
  it('splits identifiers into words', () => {
    expect(splitIdent('woo__listOrders')).toBe('woo list orders');
  });
  it('finds sales_summary for a revenue question', () => {
    const hits = new ToolIndex(cat).search('how much revenue did we make today', { limit: 3, allow: () => true });
    expect(hits.map((h) => h.tool.name)).toContain('sales_summary');
  });
  it('finds create_product for "add a new product to the shop"', () => {
    const hits = new ToolIndex(cat).search('add a new product to the shop', { limit: 3, allow: () => true });
    expect(hits[0]?.tool.name).toBe('create_product');
  });
  it('respects the permission filter', () => {
    const hits = new ToolIndex(cat).search('create product', { limit: 5, allow: (t) => t.name !== 'create_product' });
    expect(hits.map((h) => h.tool.name)).not.toContain('create_product');
  });
});

describe('stemming and action-aware ranking', () => {
  it('stems plurals and verb forms the same way on both sides', () => {
    expect(stem('couriers')).toBe(stem('courier'));
    expect(stem('reminders')).toBe(stem('reminder'));
    expect(stem('scheduled')).toBe(stem('schedule'));
    expect(stem('categories')).toBe('category');
    expect(stem('status')).toBe('status');
    expect(stem('sku-123')).toBe('sku-123');
  });
  it('reads the tool verb from verb_noun names, wherever the verb sits', () => {
    expect(toolVerb('list_orders')).toBe('list');
    expect(toolVerb('hr_create_leave_request')).toBe('create');
    expect(toolVerb('fetch_markdown')).toBe('get');
    expect(toolVerb('sales_summary')).toBe('get');
    expect(toolVerb('echo')).toBeUndefined();
  });
  it('reads the intent of a request', () => {
    expect(queryIntent('start a performance review').write).toBe('create');
    expect(queryIntent('set up a courier account').write).toBe('create');
    expect(queryIntent('turn off the checkout flag').write).toBe('update');
    expect(queryIntent('turn this page into markdown').write).toBeUndefined();
    expect(queryIntent('find unpaid invoices').read).toBe('search');
    expect(queryIntent('where is parcel 1Z999').hasId).toBe(true);
  });
  it('a write verb after a past-tense auxiliary reports, it does not ask', () => {
    expect(queryIntent('how much revenue did we make today').write).toBeUndefined();
    expect(queryIntent('which products have we added this week').write).toBeUndefined();
    expect(queryIntent('has anyone cancelled an order').write).toBeUndefined();
    expect(queryIntent('make a product called Mug').write).toBe('create');
    expect(queryIntent('can you make a product called Mug').write).toBe('create');
    expect(queryIntent('please add a coupon').write).toBe('create');
  });
  it('questions about a quantity prefer summary tools over lists', () => {
    expect(isAggregateTool('sales_summary')).toBe(true);
    expect(isAggregateTool('getUsageStats')).toBe(true);
    expect(isAggregateTool('list_orders')).toBe(false);
    expect(isAggregateTool('reporter_list')).toBe(false);
    const q = queryIntent('how much revenue did we make today');
    expect(q.aggregate).toBe(true);
    expect(actionFit('get', q, true)).toBeGreaterThan(actionFit('list', q, false));
    expect(queryIntent('show me the latest orders').aggregate).toBe(false);
  });
  it('never ranks a delete first for a question, and prefers the asked-for action', () => {
    const q = queryIntent('the review for Asha');
    expect(actionFit('delete', q)).toBeLessThan(actionFit('get', q));
    const c = queryIntent('start a review for Asha');
    expect(actionFit('create', c)).toBeGreaterThan(actionFit('update', c));
    expect(actionFit('create', c)).toBeGreaterThan(actionFit('list', c));
  });
  it('picks create over update/delete when they share the noun', () => {
    const shared = new Catalog([up], [
      tool('delete_review', 'Permanently delete a review (a performance review) in HR.'),
      tool('update_review', 'Update fields of an existing review (a performance review) in HR.'),
      tool('create_review', 'Create a new review (a performance review) in HR.'),
      tool('list_reviews', 'List reviews in HR (a performance reviews), newest first.'),
    ], 2);
    expect(new ToolIndex(shared).search('start a performance review for an employee', { limit: 1, allow: () => true })[0]?.tool.name).toBe('create_review');
    expect(new ToolIndex(shared).search('performance reviews this quarter', { limit: 1, allow: () => true })[0]?.tool.name).toBe('list_reviews');
  });
});
