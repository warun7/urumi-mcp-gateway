import { useState } from 'react';
import { Code, Tabs } from './ui';

type Client = 'claude' | 'cursor' | 'vscode' | 'other' | 'curl';
type Snippet = { label: string; code: string; note: string };

/**
 * Setup snippets per MCP client. Without a key every snippet is URL-only: the client discovers the
 * gateway's OAuth server and signs the user in. With a key, the snippets send it as a bearer header.
 */
export function clientSnippets(url: string, key?: string): Record<Client, Snippet> {
  const auth = key ? { Authorization: `Bearer ${key}` } : undefined;
  return {
    claude: {
      label: 'Claude Code',
      code: key ? `claude mcp add --transport http urumi ${url} \\\n  --header "Authorization: Bearer ${key}"` : `claude mcp add --transport http urumi ${url}`,
      note: key ? 'Run it in a terminal. The tools show up in your next Claude Code session.' : 'Run it in a terminal, then type /mcp in Claude Code and choose urumi to sign in.',
    },
    cursor: {
      label: 'Cursor',
      code: JSON.stringify({ mcpServers: { urumi: { url, ...(auth ? { headers: auth } : {}) } } }, null, 2),
      note: key ? 'Add to ~/.cursor/mcp.json.' : 'Add to ~/.cursor/mcp.json. Cursor opens a browser window to sign in.',
    },
    vscode: {
      label: 'VS Code',
      code: JSON.stringify({ servers: { urumi: { type: 'http', url, ...(auth ? { headers: auth } : {}) } } }, null, 2),
      note: key ? 'Add to .vscode/mcp.json in your project.' : 'Add to .vscode/mcp.json. VS Code asks you to sign in on first use.',
    },
    other: {
      label: 'Other clients',
      code: key ? `URL:     ${url}\nHeader:  Authorization: Bearer ${key}` : url,
      note: key
        ? 'Any MCP client that speaks Streamable HTTP. To poke at it by hand: npx @modelcontextprotocol/inspector.'
        : 'Any MCP client that supports OAuth only needs this URL. For one that doesn’t, create an API key.',
    },
    curl: {
      label: 'curl',
      code: `curl -s ${url} \\\n  -H "Authorization: Bearer ${key ?? '<API key>'}" \\\n  -H "Content-Type: application/json" \\\n  -H "Accept: application/json, text/event-stream" \\\n  -H "MCP-Protocol-Version: 2026-07-28" \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'`,
      note: 'Lists the tools this key can see. Handy for checking a key works.',
    },
  };
}

export function ConnectTabs({ url, apiKey, className }: { url: string; apiKey?: string; className?: string }) {
  const all = clientSnippets(url, apiKey);
  const order: Client[] = apiKey ? ['claude', 'cursor', 'vscode', 'curl', 'other'] : ['claude', 'cursor', 'vscode', 'other'];
  const [tab, setTab] = useState<Client>('claude');
  const s = all[tab];
  return (
    <div className={className}>
      <Tabs className="connect-tabs" value={tab} onChange={setTab} tabs={order.map((k) => ({ value: k, label: all[k].label }))} />
      <div className="connect-body">
        <Code>{s.code}</Code>
        <p className="connect-note">{s.note}</p>
      </div>
    </div>
  );
}
