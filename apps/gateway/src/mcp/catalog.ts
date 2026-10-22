import type { CatalogTool, ToolRow, UpstreamRow } from './types.js';
import { toolState } from './types.js';

/**
 * An immutable snapshot of everything callable through the gateway, rebuilt from Postgres on every
 * change (and on every replica, via NOTIFY). `tools/list` is served from memory: a slow upstream can
 * never slow down listing.
 */
export class Catalog {
  readonly byExposed = new Map<string, CatalogTool>();
  readonly upstreams = new Map<string, UpstreamRow>();
  readonly bySlug = new Map<string, UpstreamRow>();
  /** All tools of usable servers, sorted by exposed name (stable order helps client/LLM prompt caches). */
  readonly tools: CatalogTool[];

  constructor(upstreams: UpstreamRow[], toolRows: ToolRow[], readonly version: number) {
    for (const u of upstreams) {
      this.upstreams.set(u.id, u);
      this.bySlug.set(u.slug, u);
    }
    const list: CatalogTool[] = [];
    for (const t of toolRows) {
      const u = this.upstreams.get(t.upstream_id);
      if (!u || !u.enabled || u.status !== 'connected') continue; // dead or disabled servers' tools are hidden
      if (toolState(t) !== 'active') continue; // quarantined, changed-and-unapproved, disabled, gone
      list.push({
        exposedName: t.exposed_name,
        upstreamId: u.id,
        slug: u.slug,
        serverName: u.display_name,
        name: t.name,
        title: t.title ?? undefined,
        description: `[${u.display_name}] ${t.description}`.trim(),
        inputSchema: t.input_schema,
        outputSchema: t.output_schema ?? undefined,
        annotations: t.annotations ?? undefined,
        access: t.access,
        pinned: t.pinned,
        defHash: t.def_hash,
      });
    }
    list.sort((a, b) => (a.exposedName < b.exposedName ? -1 : 1));
    for (const t of list) this.byExposed.set(t.exposedName, t);
    this.tools = list;
  }
}
