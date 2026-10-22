/**
 * Deterministic synthetic tool catalog: 12 fake SaaS services x ~25 tools = ~300 realistic tools.
 * Used to demonstrate and evaluate gateway-side tool search (the "many tools" stand-out).
 */
export interface FarmTool {
  name: string;
  description: string;
  params: Record<string, { type: 'string' | 'integer' | 'boolean'; description: string }>;
  required: string[];
}

const SERVICES: Record<string, { label: string; nouns: [string, string, string][] }> = {
  crm: { label: 'CRM', nouns: [['contact', 'contacts', 'a person in the CRM'], ['deal', 'deals', 'a sales opportunity'], ['company', 'companies', 'an account / organisation'], ['lead', 'leads', 'an unqualified prospect']] },
  billing: { label: 'Billing', nouns: [['invoice', 'invoices', 'a customer invoice'], ['subscription', 'subscriptions', 'a recurring plan'], ['refund', 'refunds', 'money returned to a customer'], ['coupon', 'coupons', 'a discount code']] },
  tickets: { label: 'Helpdesk', nouns: [['ticket', 'tickets', 'a customer support ticket'], ['macro', 'macros', 'a canned support reply'], ['sla_policy', 'sla_policies', 'a response-time policy'], ['satisfaction_rating', 'satisfaction_ratings', 'a CSAT survey answer']] },
  chat: { label: 'Team chat', nouns: [['channel', 'channels', 'a chat channel'], ['message', 'messages', 'a chat message'], ['reminder', 'reminders', 'a scheduled reminder'], ['user_status', 'user_statuses', "a teammate's presence/status"]] },
  calendar: { label: 'Calendar', nouns: [['event', 'events', 'a calendar event / meeting'], ['room', 'rooms', 'a bookable meeting room'], ['availability', 'availabilities', 'free/busy time'], ['calendar', 'calendars', 'a shared calendar']] },
  docs: { label: 'Docs', nouns: [['document', 'documents', 'a wiki page or doc'], ['folder', 'folders', 'a docs folder'], ['comment', 'comments', 'a comment on a doc'], ['template', 'templates', 'a document template']] },
  hr: { label: 'HR', nouns: [['employee', 'employees', 'a staff member record'], ['leave_request', 'leave_requests', 'a time-off request'], ['payslip', 'payslips', 'a monthly salary slip'], ['review', 'reviews', 'a performance review']] },
  inventory: { label: 'Warehouse', nouns: [['stock_item', 'stock_items', 'a SKU stock level in a warehouse'], ['purchase_order', 'purchase_orders', 'an order to a supplier'], ['supplier', 'suppliers', 'a vendor that supplies goods'], ['warehouse', 'warehouses', 'a storage location']] },
  shipping: { label: 'Shipping', nouns: [['shipment', 'shipments', 'a parcel in transit'], ['label', 'labels', 'a printable shipping label'], ['carrier', 'carriers', 'a courier such as DHL'], ['return', 'returns', 'a customer return / RMA']] },
  analytics: { label: 'Analytics', nouns: [['dashboard', 'dashboards', 'a metrics dashboard'], ['report', 'reports', 'a scheduled report'], ['funnel', 'funnels', 'a conversion funnel'], ['segment', 'segments', 'a user segment / cohort']] },
  marketing: { label: 'Marketing', nouns: [['campaign', 'campaigns', 'an email/ads campaign'], ['audience', 'audiences', 'a mailing list'], ['landing_page', 'landing_pages', 'a marketing web page'], ['ab_test', 'ab_tests', 'an A/B experiment']] },
  devops: { label: 'DevOps', nouns: [['deployment', 'deployments', 'a release to an environment'], ['incident', 'incidents', 'a production outage'], ['alert', 'alerts', 'a monitoring alert'], ['feature_flag', 'feature_flags', 'a runtime toggle']] },
};

const VERBS: [string, (s: string, p: string, what: string, label: string) => string, boolean][] = [
  ['list', (_s, p, what, label) => `List ${p.replace(/_/g, ' ')} in ${label} (${what}s), newest first, with optional filters.`, false],
  ['get', (s, _p, what, label) => `Get one ${s.replace(/_/g, ' ')} (${what}) from ${label} by id, with all fields.`, true],
  ['create', (s, _p, what, label) => `Create a new ${s.replace(/_/g, ' ')} (${what}) in ${label}.`, false],
  ['update', (s, _p, what, label) => `Update fields of an existing ${s.replace(/_/g, ' ')} (${what}) in ${label}.`, true],
  ['delete', (s, _p, what, label) => `Permanently delete a ${s.replace(/_/g, ' ')} (${what}) from ${label}.`, true],
  ['search', (_s, p, what, label) => `Full-text search across ${p.replace(/_/g, ' ')} (${what}s) in ${label}.`, false],
];

export function buildFarm(limit = 300): FarmTool[] {
  const out: FarmTool[] = [];
  for (const [svc, { label, nouns }] of Object.entries(SERVICES)) {
    for (const [singular, plural, what] of nouns) {
      for (const [verb, desc, needsId] of VERBS) {
        const noun = verb === 'list' || verb === 'search' ? plural : singular;
        const params: FarmTool['params'] = {};
        const required: string[] = [];
        if (needsId) {
          params[`${singular}_id`] = { type: 'string', description: `Id of the ${singular.replace(/_/g, ' ')}` };
          required.push(`${singular}_id`);
        }
        if (verb === 'search') {
          params.query = { type: 'string', description: 'Search text' };
          required.push('query');
        }
        if (verb === 'list') params.limit = { type: 'integer', description: 'Max results (default 20)' };
        if (verb === 'create' || verb === 'update') params.fields = { type: 'string', description: `JSON object of ${singular.replace(/_/g, ' ')} fields` };
        out.push({ name: `${svc}_${verb}_${noun}`, description: desc(singular, plural, what, label), params, required });
      }
    }
  }
  return out.slice(0, limit);
}
