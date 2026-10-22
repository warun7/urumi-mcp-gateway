import type { Principal } from '../auth/principal.js';
import type { Sql } from '../db/index.js';
import type { CatalogTool } from '../mcp/types.js';
import { globToRegex } from '../mcp/upstream/ssrf.js';

export interface PermissionRow {
  id: string;
  subject_type: 'role' | 'user';
  subject: string;
  server: string;
  tool: string;
  effect: 'allow' | 'deny';
}

interface CompiledRule extends PermissionRow {
  serverRe: RegExp;
  toolRe: RegExp;
}

/** Tool globs: "*" spans any characters (tool names may contain dots or slashes). */
const toolGlob = (g: string) => new RegExp('^' + g.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');

/**
 * Tool permissions. Evaluation order (most specific intent wins, deny is never overridden):
 *   1. any matching DENY rule      -> denied
 *   2. any matching ALLOW rule     -> allowed
 *   3. default: admins get everything; members get tools classified "read" by an admin.
 * The read/write classification starts from the upstream's readOnlyHint, but that hint comes from an
 * untrusted party, so it's only a suggestion the admin confirms in the dashboard; the stored value decides.
 * Enforced in tools/list, tools/call, gateway__search_tools and gateway__call_tool (and so for the chat agent).
 */
export class Permissions {
  private rules: CompiledRule[] = [];

  constructor(private readonly sql: Sql) {}

  async reload(): Promise<void> {
    const rows = await this.sql<PermissionRow[]>`SELECT id, subject_type, subject, server, tool, effect FROM permissions`;
    this.rules = rows.map((r) => ({ ...r, serverRe: globToRegex(r.server), toolRe: toolGlob(r.tool) }));
  }

  private matching(p: Pick<Principal, 'role' | 'userId'>, t: Pick<CatalogTool, 'slug' | 'name'>) {
    return this.rules.filter(
      (r) =>
        ((r.subject_type === 'role' && r.subject === p.role) || (r.subject_type === 'user' && r.subject === p.userId)) &&
        r.serverRe.test(t.slug) &&
        r.toolRe.test(t.name),
    );
  }

  allowed(p: Pick<Principal, 'role' | 'userId'>, t: Pick<CatalogTool, 'slug' | 'name' | 'access'>): boolean {
    const rules = this.matching(p, t);
    if (rules.some((r) => r.effect === 'deny')) return false;
    if (rules.some((r) => r.effect === 'allow')) return true;
    return p.role === 'admin' || t.access === 'read';
  }

  /** Why a decision was made: shown in the dashboard's "effective permissions" view. */
  explain(p: Pick<Principal, 'role' | 'userId'>, t: Pick<CatalogTool, 'slug' | 'name' | 'access'>): string {
    const rules = this.matching(p, t);
    const deny = rules.find((r) => r.effect === 'deny');
    if (deny) return `denied by rule ${deny.subject_type}:${deny.subject} ${deny.server}/${deny.tool}`;
    const allow = rules.find((r) => r.effect === 'allow');
    if (allow) return `allowed by rule ${allow.subject_type}:${allow.subject} ${allow.server}/${allow.tool}`;
    return p.role === 'admin' ? 'allowed: admins can use every tool' : t.access === 'read' ? 'allowed: read tool (member default)' : 'denied: write tool (members need an allow rule)';
  }
}
