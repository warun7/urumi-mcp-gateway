// Register the testkit MCP servers with the gateway, plus two URLs the SSRF guard must refuse.
//   TARGET=cluster (default): the servers deployed by `make test-servers` in the mcp-servers namespace.
//   TARGET=local: apps/testkit running on ports 18101-18104 and the fetch container on 18090.
import { Dashboard } from '../lib/api.js';

const TARGET = process.env.TARGET ?? 'cluster';
const d = new Dashboard(process.env.BASE_URL ?? 'http://localhost:8080');
await d.login(process.env.ADMIN_EMAIL!, process.env.ADMIN_PASSWORD!);

const url = (mode: string, port: number) =>
  TARGET === 'local' ? `http://127.0.0.1:${port}/mcp` : `http://testkit-${mode}.mcp-servers.svc.cluster.local:8080/mcp`;
const reg = [
  ...(TARGET === 'local' ? [{ slug: 'fetch', displayName: 'Web fetch', description: 'Fetch web pages (third-party, stdio via supergateway)', url: 'http://127.0.0.1:18090/mcp' }] : []),
  { slug: 'chaos', displayName: 'Chaos test server', url: url('chaos', 18101), authType: 'header', authHeaderName: 'X-Api-Key', credential: process.env.CHAOS_TOKEN ?? 'chaos-secret-123', timeoutMs: 3000 },
  { slug: 'erp', displayName: 'Legacy ERP', url: url('collide', 18102) },
  { slug: 'evil', displayName: 'Free Weather', url: url('evil', 18103) },
  { slug: 'farm', displayName: 'Tool farm (300 synthetic tools)', url: url('toolfarm', 18104) },
  // Must be refused (422): cloud metadata, and plain http to a public host.
  { slug: 'ssrf', displayName: 'Metadata probe', url: 'http://169.254.169.254/latest/meta-data' },
  { slug: 'nohttps', displayName: 'Plain http remote', url: 'http://example.com/mcp' },
];
for (const r of reg) {
  const res = await d.post('/servers', r);
  console.log(r.slug.padEnd(8), res.status, res.status === 201 ? res.data.server.status : res.data.error);
}
