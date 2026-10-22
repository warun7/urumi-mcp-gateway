import { createHash } from 'node:crypto';

/**
 * THE NAMING SCHEME (documented in README):
 *   exposed name = <server slug> "__" <tool name with chars outside [A-Za-z0-9_-] replaced by "_">
 *   - Always prefixed, even with no collision today: names stay stable when a colliding server is added later.
 *   - Max 64 chars (what most LLM providers accept). Longer names are cut to 57 chars + "_" + 6 hex of a hash.
 *   - If sanitizing makes two tools of the same server collide, the later one gets the hash suffix too.
 *   - Routing uses a lookup table (exposed -> upstream id + original name), NEVER splitting on "__",
 *     because tool names may themselves contain "__".
 *   - Slugs are immutable, ^[a-z][a-z0-9-]{0,19}$, and "gateway" is reserved for the gateway's own meta-tools.
 */
export const MAX_NAME = 64;
export const SEP = '__';
export const SLUG_RE = /^[a-z][a-z0-9-]{0,19}$/;
export const RESERVED_SLUGS = new Set(['gateway', 'api', 'mcp', 'admin', 'oauth', 'internal']);

const short = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 6);

export function sanitize(tool: string): string {
  return tool.replace(/[^A-Za-z0-9_-]/g, '_');
}

export function exposedName(slug: string, tool: string, taken: Set<string> = new Set()): string {
  let name = `${slug}${SEP}${sanitize(tool)}`;
  if (name.length > MAX_NAME) name = `${name.slice(0, MAX_NAME - 7)}_${short(tool)}`;
  if (taken.has(name)) name = `${name.slice(0, MAX_NAME - 7)}_${short(tool)}`;
  return name;
}

/** Assign exposed names for one server's tools deterministically (sorted by original name). */
export function assignNames(slug: string, tools: string[]): Map<string, string> {
  const taken = new Set<string>();
  const out = new Map<string, string>();
  for (const t of [...tools].sort()) {
    const n = exposedName(slug, t, taken);
    taken.add(n);
    out.set(t, n);
  }
  return out;
}
