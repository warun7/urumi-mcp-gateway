import MiniSearch from 'minisearch';
import type { Catalog } from './catalog.js';
import type { CatalogTool } from './types.js';

/**
 * Tool search over the catalog (the "many tools" stand-out).
 * With hundreds of tools, sending every schema to the model on every turn costs tokens and
 * hurts tool-selection accuracy. In `search` mode the client sees a few meta-tools and finds the
 * rest on demand. The index is rebuilt when the catalog changes (cheap: in memory, ms for 1000s of tools).
 *
 * Ranking = BM25 over stemmed words, then an action-aware re-rank. Tool names are almost always
 * verb_noun ("list_orders", "crm_create_deal"), and BM25 alone is blind to the verb: "start a review"
 * scores create_review, update_review and delete_review the same because they share the noun. So the
 * query's intent (create / update / delete, or a read) is matched against each tool's verb, and without
 * a write intent read tools outrank writes and deletes rank last; questions about a quantity ("how much",
 * "total") prefer summary tools over lists. Measured in eval/ (dev and holdout sets).
 */
interface Doc {
  id: string;
  name: string;
  server: string;
  title: string;
  description: string;
  params: string;
}

/** "list_orders" / "listOrders" / "woo__list-orders" -> "list orders woo" so BM25 can match words. */
export const splitIdent = (s: string) =>
  s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_\-./]+/g, ' ').toLowerCase().trim();

function paramText(schema: Record<string, unknown>): string {
  const props = (schema.properties ?? {}) as Record<string, { description?: string }>;
  return Object.entries(props).map(([k, v]) => `${splitIdent(k)} ${v?.description ?? ''}`).join(' ');
}

// Function words, plus "get"/"did"/"does": in a request they're grammar, and as BM25 terms they'd pull in
// every get_* tool ("how many orders did we get" is not about get_order). Verbs are judged by actionFit instead.
const STOP = new Set([
  'a', 'an', 'the', 'of', 'to', 'for', 'in', 'on', 'and', 'or', 'with', 'by', 'is', 'are', 'was', 'were', 'be', 'been',
  'my', 'me', 'we', 'our', 'us', 'you', 'your', 'it', 'its', 'all', 'from', 'this', 'that', 'these', 'those', 'what',
  'which', 'who', 'how', 'many', 'much', 'do', 'does', 'did', 'has', 'have', 'had', 'get', 'got', 'i', 'can', 'could',
  'would', 'should', 'will', 'please', 'there', 'here', 'at', 'as', 'about', 'into', 'just', 'any', 'some',
]);

/**
 * A deliberately light stemmer (plurals, -ing, -ed, -er), applied identically to the index and the query,
 * so "couriers" finds "courier" and "reminder" finds "remind". Consistency matters more than linguistics here.
 */
export function stem(w: string): string {
  if (w.length <= 3 || /\d/.test(w)) return w;
  if (w.endsWith('ies') && w.length > 4) return `${w.slice(0, -3)}y`;
  if (/(ss|us|is)$/.test(w)) return w;
  if (/(sses|xes|zes|ches|shes)$/.test(w)) return w.slice(0, -2);
  if (w.endsWith('s')) w = w.slice(0, -1);
  if (w.endsWith('ing') && w.length > 5) return undouble(w.slice(0, -3));
  if (w.endsWith('ed') && w.length > 4) return undouble(w.slice(0, -2));
  if (w.endsWith('er') && w.length > 5) return w.slice(0, -2);
  if (w.endsWith('e') && w.length > 4) return w.slice(0, -1); // schedule / scheduled -> schedul
  return w;
}
const undouble = (w: string) => (/([b-df-hj-np-tv-z])\1$/.test(w) && !/(ll|ss|zz)$/.test(w) ? w.slice(0, -1) : w);

type Verb = 'create' | 'update' | 'delete' | 'list' | 'get' | 'search';
const WRITE = new Set<Verb>(['create', 'update', 'delete']);

/** Verbs as they appear in tool names. */
const TOOL_VERBS: Record<string, Verb> = Object.fromEntries(
  ([
    ['create', ['create', 'add', 'new', 'insert', 'post', 'send', 'register', 'make']],
    ['update', ['update', 'edit', 'set', 'change', 'patch', 'modify', 'mark', 'move', 'rename', 'approve', 'cancel', 'close', 'enable', 'disable', 'toggle', 'assign']],
    ['delete', ['delete', 'remove', 'destroy', 'drop', 'purge']],
    ['list', ['list', 'all', 'browse']],
    ['get', ['get', 'fetch', 'read', 'show', 'describe', 'view', 'retrieve', 'info', 'summary']],
    ['search', ['search', 'find', 'query', 'lookup']],
  ] as [Verb, string[]][]).flatMap(([v, ws]) => ws.map((w) => [w, v])),
);

/** Verbs and phrasings people use in requests, mapped to the action they ask for. */
const INTENT_WORDS: Record<string, Verb> = Object.fromEntries(
  ([
    ['create', ['add', 'new', 'create', 'make', 'start', 'launch', 'post', 'send', 'schedule', 'book', 'log', 'register', 'issue', 'publish', 'write', 'draft', 'put', 'build', 'generate', 'raise', 'submit', 'invite']],
    ['update', ['update', 'change', 'edit', 'modify', 'set', 'mark', 'approve', 'reject', 'rename', 'move', 'reschedule', 'pause', 'resume', 'enable', 'disable', 'toggle', 'cancel', 'close', 'reopen', 'assign', 'upgrade', 'downgrade', 'silence', 'mute', 'switch', 'convert', 'adjust']],
    ['delete', ['delete', 'remove', 'drop', 'erase', 'purge', 'destroy', 'discard']],
    ['search', ['find', 'search', 'look', 'lookup']],
    ['list', ['list', 'every', 'everyone', 'recent', 'latest']],
  ] as [Verb, string[]][]).flatMap(([v, ws]) => ws.map((w) => [w, v])),
);

export function toolVerb(toolName: string): Verb | undefined {
  for (const w of splitIdent(toolName).split(' ')) if (TOOL_VERBS[w]) return TOOL_VERBS[w];
  return undefined;
}

export interface Intent { write?: Verb; read?: Verb; hasId: boolean; aggregate: boolean }

/** "how much revenue", "total sales", "how many orders": a question about a quantity, best answered by a summary tool. */
const AGGREGATE_QUERY = /\b(how (much|many)|totals?|sum|average|avg)\b/;
/** Tools that compute totals rather than return rows: sales_summary, get_stats, usage_report, order_totals... */
export const isAggregateTool = (toolName: string) => /(^|[\s_])(summary|stats|statistics|report|reports|totals?|metrics)($|[\s_])/.test(splitIdent(toolName).replace(/ /g, '_'));

/** Past-tense auxiliaries: a verb after them reports what happened ("how much did we make"), it doesn't ask for it. */
const REPORTED = new Set(['did', 'have', 'has', 'had']);
const PRONOUN = new Set(['we', 'i', 'you', 'they', 'he', 'she', 'it', 'anyone', 'someone', 'somebody', 'anybody', 'people', 'customers']);

/** The first action word decides; two-word phrasings ("set up", "turn on/off") are read as one. */
export function queryIntent(query: string): Intent {
  const ws = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const out: Intent = { hasId: ws.some((w) => /\d/.test(w)), aggregate: AGGREGATE_QUERY.test(ws.join(' ')) }; // hasId: "order 77", "SKU-123"
  for (let i = 0; i < ws.length && !out.write; i++) {
    const w = ws[i]!;
    const v = w === 'set' && ws[i + 1] === 'up' ? 'create' : w === 'turn' && /^(on|off)$/.test(ws[i + 1] ?? '') ? 'update' : INTENT_WORDS[w];
    const reported = REPORTED.has(ws[i - 1] ?? '') || (PRONOUN.has(ws[i - 1] ?? '') && REPORTED.has(ws[i - 2] ?? ''));
    if (v && WRITE.has(v)) {
      if (!reported) out.write = v;
    } else if (v && !out.read) out.read = v;
  }
  return out;
}

/** Multiplier on the BM25 score: how well the tool's action fits what the query asks for. */
export function actionFit(verb: Verb | undefined, intent: Intent, aggregateTool = false): number {
  if (intent.write) {
    if (!verb) return 1; // e.g. echo: no verb to judge
    if (verb === intent.write) return 1.6;
    return WRITE.has(verb) ? 0.7 : 0.85;
  }
  if (verb === 'delete') return 0.6; // never offer a delete first for a question
  if (verb && WRITE.has(verb)) return 0.8;
  if (intent.aggregate && aggregateTool) return 1.3; // "how much revenue": sales_summary, not 50 rows of list_orders
  if (!verb) return 1;
  if (intent.read) return verb === intent.read ? 1.25 : 1;
  if (verb === 'get') return intent.hasId ? 1.15 : 1;
  return intent.hasId || intent.aggregate ? 1 : 1.15; // list / search
}

export class ToolIndex {
  private readonly index: MiniSearch<Doc>;
  private readonly byId: Map<string, CatalogTool>;
  private readonly verbs: Map<string, Verb | undefined>;
  private readonly aggregate: Set<string>;

  constructor(catalog: Catalog) {
    this.byId = new Map(catalog.tools.map((t) => [t.exposedName, t]));
    this.verbs = new Map(catalog.tools.map((t) => [t.exposedName, toolVerb(t.name)]));
    this.aggregate = new Set(catalog.tools.filter((t) => isAggregateTool(t.name)).map((t) => t.exposedName));
    this.index = new MiniSearch<Doc>({
      fields: ['name', 'server', 'title', 'description', 'params'],
      storeFields: [],
      processTerm: (term) => {
        const t = term.toLowerCase();
        return STOP.has(t) ? null : stem(t);
      },
      searchOptions: {
        boost: { name: 2, title: 2, server: 1.5, description: 1, params: 0.5 },
        fuzzy: (term) => (term.length >= 6 ? 0.15 : false),
        combineWith: 'OR',
      },
    });
    this.index.addAll(
      catalog.tools.map((t) => ({
        id: t.exposedName,
        name: `${splitIdent(t.name)} ${t.name}`,
        server: `${t.slug} ${t.serverName}`,
        title: t.title ?? '',
        description: t.description,
        params: paramText(t.inputSchema),
      })),
    );
  }

  search(query: string, opts: { server?: string; limit: number; allow: (t: CatalogTool) => boolean }): { tool: CatalogTool; score: number }[] {
    const intent = queryIntent(query);
    const hits = this.index
      .search(splitIdent(query))
      .map((h) => ({ id: h.id as string, score: h.score * actionFit(this.verbs.get(h.id as string), intent, this.aggregate.has(h.id as string)) }))
      .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
    const out: { tool: CatalogTool; score: number }[] = [];
    for (const h of hits) {
      const t = this.byId.get(h.id);
      if (!t || !opts.allow(t)) continue; // permission-filtered: you can't discover what you can't call
      if (opts.server && t.slug !== opts.server) continue;
      out.push({ tool: t, score: Math.round(h.score * 100) / 100 });
      if (out.length >= opts.limit) break;
    }
    return out;
  }
}
