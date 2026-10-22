import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

export type Access = 'read' | 'write';
export interface HostTool {
  name: string;
  description: string;
  inputSchema: unknown;
  /** Gateway policy classification (from the gateway's own `_meta`, not the upstream's hints). */
  access: Access;
  /** The server's slug, and whether it is the store to use when the user doesn't name one (both from `_meta`). */
  server?: string;
  defaultStore?: boolean;
}
export interface ToolOutcome {
  text: string;
  isError: boolean;
}
/** What the agent loop needs from "the tools". The real one is the gateway; tests use a fake. */
export interface ToolHost {
  list(): Promise<HostTool[]>;
  call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolOutcome>;
  close(): Promise<void>;
}

/**
 * An MCP client to the gateway's /mcp, authenticated as the chatting user with the short-lived
 * delegation token the gateway minted. The agent has no credentials of its own: every call it makes
 * goes through the gateway's permission checks and lands in the audit log under the user's name.
 */
export async function connectGateway(url: string, token: string, timeoutMs = 10_000): Promise<ToolHost> {
  const client = new Client({ name: 'urumi-chat-agent', version: '0.1.0' }, { versionNegotiation: { mode: 'auto' } });
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
  // No cross-request `prior` discovery cache: the SDK says to reuse one only within a single
  // authorization context, and every chat user is a different one. The probe is one in-cluster hop.
  await client.connect(transport, { timeout: timeoutMs });

  return {
    async list() {
      const out: HostTool[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: timeoutMs });
        for (const t of page.tools) {
          const meta = (t._meta ?? {}) as Record<string, unknown>;
          const access = meta['io.urumi/access'];
          out.push({
            name: t.name,
            description: t.description ?? '',
            inputSchema: t.inputSchema,
            // Gateway meta-tools are read-only plumbing; anything unclassified is treated as a write.
            access: t.name.startsWith('gateway__') && t.name !== 'gateway__call_tool' ? 'read' : access === 'read' ? 'read' : 'write',
            ...(typeof meta['io.urumi/server'] === 'string' ? { server: meta['io.urumi/server'] } : {}),
            ...(meta['io.urumi/default-store'] === true ? { defaultStore: true } : {}),
          });
        }
        cursor = page.nextCursor;
      } while (cursor);
      return out;
    },
    async call(name, args, signal) {
      const r = await client.callTool({ name, arguments: args }, { signal, timeout: 60_000 });
      return { text: resultText(r), isError: Boolean(r.isError) };
    },
    async close() {
      await client.close().catch(() => {});
    },
  };
}

export function resultText(r: { content?: unknown; structuredContent?: unknown }): string {
  const blocks = Array.isArray(r.content) ? (r.content as { type: string; text?: string; mimeType?: string; resource?: { uri?: string } }[]) : [];
  const parts = blocks.map((b) => {
    if (b.type === 'text') return b.text ?? '';
    if (b.type === 'resource') return `[resource ${b.resource?.uri ?? ''}]`;
    if (b.type === 'resource_link') return `[resource link]`;
    return `[${b.type}${b.mimeType ? ` ${b.mimeType}` : ''} omitted]`;
  });
  if (!parts.join('').trim() && r.structuredContent !== undefined) return JSON.stringify(r.structuredContent);
  return parts.join('\n');
}
