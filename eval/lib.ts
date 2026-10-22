/** Shared scoring for the tool-search evaluation (live: run.ts, offline against a catalog snapshot: offline.ts). */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Task { q: string; expect: string[]; tags: string[] }
export interface WireTool { name: string; title?: string; description?: string; inputSchema?: Record<string, unknown>; _meta?: Record<string, unknown> }
export interface Scored { task: Task; expected: Set<string>; got: string[] }
export interface Metrics { n: number; h1: number; h3: number; h5: number; mrr: number }

export const here = dirname(fileURLToPath(import.meta.url));
export const SETS = { dev: 'tool-search.jsonl', holdout: 'tool-search.holdout.jsonl' } as const;
export type SetName = keyof typeof SETS;

export function loadTasks(set: SetName): Task[] {
  return readFileSync(join(here, SETS[set]), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Task);
}

/** "@store:list_orders" = that tool on any WooCommerce store in the catalog (servers exposing get_store_info). */
export function expander(names: Set<string>) {
  const stores = [...names].filter((n) => n.endsWith('__get_store_info')).map((n) => n.split('__')[0]!);
  return (task: Task) => new Set(task.expect.flatMap((e) => (e.startsWith('@store:') ? stores.map((s) => `${s}__${e.slice(7)}`) : [e])).filter((n) => names.has(n)));
}

export const rank = (got: string[], exp: Set<string>) => {
  const i = got.findIndex((n) => exp.has(n));
  return i < 0 ? Infinity : i + 1;
};

export function metrics(rows: Scored[]): Metrics {
  const ranks = rows.map((s) => rank(s.got, s.expected));
  const at = (k: number) => ranks.filter((r) => r <= k).length / (rows.length || 1);
  return { n: rows.length, h1: at(1), h3: at(3), h5: at(5), mrr: ranks.reduce((a, r) => a + (r === Infinity ? 0 : 1 / r), 0) / (rows.length || 1) };
}

const STOP = new Set(['a', 'an', 'the', 'of', 'to', 'for', 'in', 'on', 'and', 'or', 'with', 'by', 'is', 'are', 'my', 'me', 'our', 'we', 'did', 'all', 'from', 'this', 'that', 'what', 'which', 'how', 'many', 'much', 'do', 'i', 'can', 'please', 'get', 'it', 'at', 'just', 'show', 'give', 'their', 'right', 'now']);
const words = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !STOP.has(w));

/** What a quick grep would do: rank tools by how many of the query's words they contain (ties: catalog order). */
export function keywordBaseline(catalog: WireTool[]) {
  const docs = catalog.map((t) => ({ name: t.name, words: new Set(words(`${t.name} ${t.description ?? ''}`)) }));
  return (q: string) => {
    const qw = words(q);
    return docs.map((d, i) => ({ d, i, s: qw.filter((w) => d.words.has(w)).length }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || a.i - b.i)
      .slice(0, 10)
      .map((x) => x.d.name);
  };
}

export const pct = (x: number) => `${(100 * x).toFixed(0)}%`;
export const fmt = (m: Metrics) => `hit@1 ${pct(m.h1)}  hit@3 ${pct(m.h3)}  hit@5 ${pct(m.h5)}  MRR ${m.mrr.toFixed(2)}  (n=${m.n})`;
export const tableRow = (label: string, m: Metrics) => `| ${label} | ${m.n} | ${pct(m.h1)} | ${pct(m.h3)} | ${pct(m.h5)} | ${m.mrr.toFixed(2)} |`;
