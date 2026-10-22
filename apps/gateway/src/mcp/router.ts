import { randomBytes } from 'node:crypto';
import { ProtocolError, ProtocolErrorCode, TRACEPARENT_META_KEY } from '@modelcontextprotocol/server';
import type { CallToolResult, Tool } from '@modelcontextprotocol/server';
import type { AuditLog, AuditOutcome } from '../audit/audit.js';
import type { Principal } from '../auth/principal.js';
import type { Config } from '../config.js';
import { toolCallDuration, toolCalls } from '../metrics.js';
import type { Permissions } from '../policy/permissions.js';
import { CallBudget } from '../policy/ratelimit.js';
import type { Catalog } from './catalog.js';
import { ToolIndex } from './search.js';
import type { CatalogTool } from './types.js';
import type { UpstreamManager } from './upstream/manager.js';
import { validateArgs } from './validate.js';

/** The gateway's own tools live in the reserved "gateway" namespace, so they can never collide with an upstream. */
export const META = {
  listServers: 'gateway__list_servers',
  searchTools: 'gateway__search_tools',
  callTool: 'gateway__call_tool',
} as const;

const META_TOOLS: Record<string, Tool> = {
  [META.listServers]: {
    name: META.listServers,
    title: 'List connected servers',
    description: '[Gateway] List the MCP servers (and stores) available to you, with a one-line summary, how many tools each has, and which store is the default. Use it to decide where to search.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  [META.searchTools]: {
    name: META.searchTools,
    title: 'Search tools',
    description:
      '[Gateway] Find tools by describing what you want to do (e.g. "orders placed today", "create a github issue"). ' +
      'Returns the best matching tools with their input schemas. Then call a tool directly by its name, or via gateway__call_tool.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 300, description: 'What you want to do, in plain words' },
        server: { type: 'string', description: 'Optional server slug to search within (see gateway__list_servers)' },
        limit: { type: 'integer', minimum: 1, maximum: 10, default: 5 },
      },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  [META.callTool]: {
    name: META.callTool,
    title: 'Call a tool by name',
    description: '[Gateway] Call any tool you found with gateway__search_tools, by its exact name, with arguments matching its input schema.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Exact tool name, e.g. "woo__list_orders"' },
        arguments: { type: 'object', description: 'Arguments for that tool', additionalProperties: true },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
};

const toWire = (t: CatalogTool, defaultStore: string): Tool => ({
  name: t.exposedName,
  ...(t.title ? { title: t.title } : {}),
  description: t.description,
  inputSchema: t.inputSchema as Tool['inputSchema'],
  ...(t.outputSchema ? { outputSchema: t.outputSchema as Tool['outputSchema'] } : {}),
  ...(t.annotations ? { annotations: t.annotations } : {}),
  // The gateway's own (admin-owned) classification. Clients like our chat agent use it to ask for human
  // approval before write tools; unlike upstream annotations it is not controlled by the upstream server.
  // The default store answers requests that don't name a store ("create a product…" with three stores connected).
  _meta: { 'io.urumi/access': t.access, 'io.urumi/server': t.slug, ...(t.slug === defaultStore ? { 'io.urumi/default-store': true } : {}) },
});

const bytes = (v: unknown) => (v === undefined ? 0 : Buffer.byteLength(JSON.stringify(v)));
const text = (s: string, isError = false): CallToolResult => ({ content: [{ type: 'text', text: s }], ...(isError ? { isError } : {}) });

/**
 * The call path. Every tools/call — from Claude Code, Inspector, the chat agent, or via gateway__call_tool —
 * goes through `call()`:  per-user budget -> lookup -> permission -> argument validation -> upstream (breaker/bulkhead/timeout)
 * -> size cap -> audit. (The meta-tools are answered from memory and don't spend the budget.)
 */
export class Router {
  private index?: { version: number; idx: ToolIndex };
  private readonly budget: CallBudget;

  constructor(
    private readonly manager: UpstreamManager,
    private readonly perms: Permissions,
    private readonly audit: AuditLog,
    private readonly cfg: Config,
  ) {
    this.budget = new CallBudget(cfg.RATE_LIMIT_PER_MINUTE);
  }

  private get catalog(): Catalog {
    return this.manager.catalog;
  }

  private toolIndex(): ToolIndex {
    if (!this.index || this.index.version !== this.catalog.version) this.index = { version: this.catalog.version, idx: new ToolIndex(this.catalog) };
    return this.index.idx;
  }

  permitted(p: Principal): CatalogTool[] {
    return this.catalog.tools.filter((t) => this.perms.allowed(p, t));
  }

  effectiveMode(p: Principal, permittedCount: number): 'full' | 'search' {
    if (p.toolMode === 'auto') return permittedCount > this.cfg.TOOL_SEARCH_AUTO_THRESHOLD ? 'search' : 'full';
    return p.toolMode;
  }

  /** tools/list for one principal. Served from memory; never touches an upstream. */
  list(p: Principal): Tool[] {
    const tools = this.permitted(p);
    const wire = (t: CatalogTool) => toWire(t, this.cfg.DEFAULT_STORE);
    if (this.effectiveMode(p, tools.length) === 'full') return [META_TOOLS[META.listServers]!, ...tools.map(wire)];
    // search mode: meta-tools + a few admin-pinned core tools. Everything else is still callable by name.
    return [META_TOOLS[META.listServers]!, META_TOOLS[META.searchTools]!, META_TOOLS[META.callTool]!, ...tools.filter((t) => t.pinned).map(wire)];
  }

  async call(p: Principal, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<CallToolResult> {
    if (name === META.listServers) return this.listServers(p);
    if (name === META.searchTools) return this.searchTools(p, args);
    if (name === META.callTool) {
      const inner = typeof args.name === 'string' ? args.name : '';
      if (inner.startsWith('gateway__')) return text('gateway__call_tool cannot call gateway meta-tools.', true);
      const innerArgs = (args.arguments && typeof args.arguments === 'object' ? args.arguments : {}) as Record<string, unknown>;
      // Recorded in the audit log as the INNER tool: the meta-tool is just a transport.
      return this.callUpstream(p, inner, innerArgs, signal, true);
    }
    return this.callUpstream(p, name, args, signal, false);
  }

  private async callUpstream(p: Principal, name: string, args: Record<string, unknown>, signal: AbortSignal, viaMeta: boolean): Promise<CallToolResult> {
    const started = performance.now();
    const traceId = randomBytes(16).toString('hex');
    const t = this.catalog.byExposed.get(name);
    // Not in the catalog (its server is down or disabled, or no such tool): still attribute the attempt to the server
    // its name points at, when that server is registered, so "who called chaos while it was down" is answerable.
    const sep = name.indexOf('__');
    const named = !t && sep > 0 ? this.catalog.bySlug.get(name.slice(0, sep)) : undefined;
    const target = t
      ? { upstreamId: t.upstreamId, upstreamSlug: t.slug, toolName: t.name }
      : { upstreamId: named?.id, upstreamSlug: named?.slug, toolName: named ? name.slice(sep + 2) : undefined };
    const base = { principal: p, exposedName: name, traceId, argsBytes: bytes(args), ...target };
    const finish = async (outcome: AuditOutcome, extra: { errorCode?: string; errorMessage?: string; resultBytes?: number } = {}) => {
      const durationMs = Math.round(performance.now() - started);
      toolCalls.inc({ server: target.upstreamSlug ?? 'unknown', outcome, via: p.via });
      if (t) toolCallDuration.observe({ server: t.slug }, durationMs / 1000);
      await this.audit.write({ ...base, outcome, durationMs, ...extra });
    };

    // Checked first, so probing for tool names spends the budget too. A tool error rather than a protocol error:
    // the model reads it and backs off instead of the client treating it as a crash.
    const waitMs = this.budget.take(p.userId);
    if (waitMs > 0) {
      await finish('rate_limited', { errorCode: 'RATE_LIMITED' });
      return text(`Rate limit: at most ${this.cfg.RATE_LIMIT_PER_MINUTE} tool calls per minute per user. Try again in ${Math.ceil(waitMs / 1000)} s.`, true);
    }

    // Unknown, hidden, and FORBIDDEN tools get the same answer, so names can't be enumerated by probing.
    if (!t || !this.perms.allowed(p, t)) {
      await finish('denied', { errorCode: t ? 'FORBIDDEN' : 'UNKNOWN_TOOL' });
      if (viaMeta) return text(`Unknown tool: ${name}. Use gateway__search_tools to find available tools.`, true);
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown tool: ${name}`);
    }

    let problem: string | null;
    try {
      problem = validateArgs(t.defHash, t.inputSchema, args);
    } catch (err) {
      problem = `tool schema could not be compiled: ${(err as Error).message}`;
    }
    if (problem) {
      await finish('invalid_args', { errorCode: 'INVALID_ARGUMENTS', errorMessage: problem });
      return text(`Invalid arguments for ${name}: ${problem}`, true);
    }

    const traceparent = `00-${traceId}-${randomBytes(8).toString('hex')}-01`;
    const r = await this.manager.call(t, args, signal, { [TRACEPARENT_META_KEY]: traceparent });
    let result = r.result;
    let size = bytes(result);
    if (size > this.cfg.MAX_RESULT_BYTES) {
      // Protect clients and the model's context window from a runaway upstream.
      const firstText = result.content.find((c) => c.type === 'text');
      const kept = firstText && 'text' in firstText ? firstText.text.slice(0, Math.floor(this.cfg.MAX_RESULT_BYTES / 2)) : '';
      result = text(`${kept}\n\n[gateway: result truncated, ${size} bytes exceeded the ${this.cfg.MAX_RESULT_BYTES}-byte limit]`, !!result.isError);
      size = bytes(result);
    }
    const msg = r.outcome === 'success' ? undefined : (result.content[0] as { text?: string } | undefined)?.text;
    await finish(r.outcome, { errorCode: r.errorCode, errorMessage: msg, resultBytes: size });
    return result;
  }

  private async listServers(p: Principal): Promise<CallToolResult> {
    const permitted = this.permitted(p);
    const counts = new Map<string, number>();
    for (const t of permitted) counts.set(t.slug, (counts.get(t.slug) ?? 0) + 1);
    const servers = [...this.catalog.upstreams.values()]
      .filter((u) => u.enabled && u.status === 'connected' && counts.get(u.slug))
      .map((u) => ({
        server: u.slug,
        name: u.display_name,
        description: u.description || undefined,
        kind: u.managed_by?.startsWith('store/') || u.slug === this.cfg.DEFAULT_STORE ? 'woocommerce_store' : 'mcp_server',
        ...(u.slug === this.cfg.DEFAULT_STORE ? { default: true } : {}),
        tools: counts.get(u.slug),
      }));
    const data = { servers };
    await this.audit.write({ principal: p, upstreamSlug: 'gateway', toolName: 'list_servers', exposedName: META.listServers, outcome: 'success' });
    return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
  }

  private async searchTools(p: Principal, args: Record<string, unknown>): Promise<CallToolResult> {
    const query = typeof args.query === 'string' ? args.query.slice(0, 300) : '';
    if (!query.trim()) return text('query is required', true);
    const limit = Math.min(10, Math.max(1, Number(args.limit ?? 5) || 5));
    const server = typeof args.server === 'string' ? args.server : undefined;
    const hits = this.toolIndex().search(query, { server, limit, allow: (t) => this.perms.allowed(p, t) });
    const data = {
      query,
      results: hits.map(({ tool, score }) => ({
        name: tool.exposedName,
        server: tool.slug,
        description: tool.description.length > 300 ? `${tool.description.slice(0, 299)}…` : tool.description,
        input_schema: tool.inputSchema,
        access: tool.access,
        score,
      })),
      hint: hits.length ? 'Call a result by its name with matching arguments.' : 'No match. Try other words, or gateway__list_servers to see what exists.',
    };
    await this.audit.write({ principal: p, upstreamSlug: 'gateway', toolName: 'search_tools', exposedName: META.searchTools, outcome: 'success', resultBytes: bytes(data) });
    return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
  }
}
