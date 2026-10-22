// Connect to any MCP endpoint, print era + tools, optionally call one tool.
//   tsx scripts/mcp-smoke.ts <url> [--token T] [--legacy] [--call name '{"json":"args"}']
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const args = process.argv.slice(2);
const url = args[0];
if (!url) throw new Error('usage: mcp-smoke.ts <url> [--token T] [--legacy] [--call name json]');
const flag = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const token = flag('--token') ?? process.env.MCP_TOKEN;
const callName = flag('--call');
const callArgs = callName ? JSON.parse(args[args.indexOf('--call') + 2] ?? '{}') : undefined;

const client = new Client(
  { name: 'urumi-smoke', version: '0.1.0' },
  { versionNegotiation: { mode: args.includes('--legacy') ? 'legacy' : 'auto' } },
);
const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: token ? { headers: { authorization: `Bearer ${token}` } } : undefined,
});
await client.connect(transport);
console.log('era:', client.getProtocolEra(), '| server:', client.getServerVersion()?.name);
const { tools } = await client.listTools();
console.log(`tools (${tools.length}):`, tools.map((t) => t.name).join(', '));
if (callName) {
  const res = await client.callTool({ name: callName, arguments: callArgs });
  console.log(JSON.stringify(res.structuredContent ?? res.content, null, 2));
  if (res.isError) process.exitCode = 1;
}
await client.close();
