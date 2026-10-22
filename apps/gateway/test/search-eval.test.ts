/**
 * Ranking regression guard: runs the tool-search evaluation (eval/) offline against the committed catalog
 * snapshot. If a change to the index makes retrieval worse than the recorded floor, this fails in CI.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { expander, here, loadTasks, metrics, type WireTool } from '../../../eval/lib.js';
import type { Catalog } from '../src/mcp/catalog.js';
import { ToolIndex } from '../src/mcp/search.js';
import type { CatalogTool } from '../src/mcp/types.js';

const snap = JSON.parse(readFileSync(join(here, 'catalog.snapshot.json'), 'utf8')) as { tools: WireTool[] };
const wire = snap.tools.filter((t) => !t.name.startsWith('gateway__'));
const tools = wire.map((t) => {
  const slug = t.name.split('__')[0]!;
  return { exposedName: t.name, slug, serverName: slug, name: t.name.slice(slug.length + 2), title: t.title, description: t.description ?? '',
    inputSchema: t.inputSchema ?? {}, access: 'read', pinned: false, defHash: t.name, upstreamId: slug } as CatalogTool;
});
const index = new ToolIndex({ tools, version: 1 } as unknown as Catalog);
const expand = expander(new Set(wire.map((t) => t.name)));
const run = (set: 'dev' | 'holdout') =>
  metrics(loadTasks(set).map((task) => ({ task, expected: expand(task), got: index.search(task.q, { limit: 10, allow: () => true }).map((h) => h.tool.exposedName) })));

describe('tool search quality (eval/ snapshot)', () => {
  it.each([
    ['dev', 0.65, 0.77],
    ['holdout', 0.6, 0.85],
  ] as const)('%s set stays above its floor (hit@1 >= %d, hit@5 >= %d)', (set, h1, h5) => {
    const m = run(set);
    expect(m.h1).toBeGreaterThanOrEqual(h1);
    expect(m.h5).toBeGreaterThanOrEqual(h5);
  });
});
