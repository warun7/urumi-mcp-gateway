/**
 * Offline tool-search evaluation: runs the gateway's real ToolIndex against a catalog snapshot
 * (eval/catalog.snapshot.json, a full-mode tools/list), so ranking changes can be measured without a cluster.
 *   cd e2e && pnpm exec tsx ../eval/offline.ts [--misses] [--holdout-detail]
 * --misses lists the dev-set tasks that miss the top 5. The holdout set is reported only in aggregate unless
 * --holdout-detail is given: tune on dev, then check that holdout moved the same way.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ToolIndex } from '../apps/gateway/src/mcp/search.js';
import type { Catalog } from '../apps/gateway/src/mcp/catalog.js';
import type { CatalogTool } from '../apps/gateway/src/mcp/types.js';
import { expander, fmt, here, keywordBaseline, loadTasks, metrics, rank, type Scored, type SetName, type WireTool } from './lib.js';

const snap = JSON.parse(readFileSync(join(here, 'catalog.snapshot.json'), 'utf8')) as { tools: WireTool[]; servers: { slug: string; displayName: string }[] };
const wire = snap.tools.filter((t) => !t.name.startsWith('gateway__'));
const display = new Map(snap.servers.map((s) => [s.slug, s.displayName]));
const tools: CatalogTool[] = wire.map((t) => {
  const slug = t.name.split('__')[0]!;
  return {
    exposedName: t.name, upstreamId: slug, slug, serverName: display.get(slug) ?? slug, name: t.name.slice(slug.length + 2),
    title: t.title, description: t.description ?? '', inputSchema: t.inputSchema ?? {}, access: (t._meta?.['io.urumi/access'] as 'read' | 'write') ?? 'write',
    pinned: false, defHash: t.name,
  };
});
const index = new ToolIndex({ tools, version: 1 } as unknown as Catalog);
const expand = expander(new Set(wire.map((t) => t.name)));
const base = keywordBaseline(wire);
const args = new Set(process.argv.slice(2));

for (const set of ['dev', 'holdout'] as SetName[]) {
  const tasks = loadTasks(set).map((task) => ({ task, expected: expand(task) })).filter((x) => x.expected.size);
  const bm25: Scored[] = tasks.map((x) => ({ ...x, got: index.search(x.task.q, { limit: 10, allow: () => true }).map((h) => h.tool.exposedName) }));
  const kw: Scored[] = tasks.map((x) => ({ ...x, got: base(x.task.q) }));
  console.log(`\n${set.padEnd(8)} gateway   ${fmt(metrics(bm25))}\n${''.padEnd(8)} baseline  ${fmt(metrics(kw))}`);
  if ((set === 'dev' && args.has('--misses')) || (set === 'holdout' && args.has('--holdout-detail')))
    for (const s of bm25.filter((s) => rank(s.got, s.expected) > 1))
      console.log(`   ${String(rank(s.got, s.expected)).padStart(8)}  "${s.task.q}" -> ${s.got.slice(0, 3).join(', ')}`);
}
