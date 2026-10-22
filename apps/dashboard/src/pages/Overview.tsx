import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { api } from '../api';
import { useUser } from '../auth';
import { ConnectTabs } from '../components/connect';
import { Card, CopyField, Empty, LinkButton, PageHead, SkeletonRows, Status, StatusBadge, Time } from '../components/ui';
import { ms } from '../format';
import { Icons } from '../icons';
import type { AuditEvent, MyTool, Server, StoresResponse } from '../types';
import { OUTCOME_TONE, outcomeLabel } from './Audit';

interface Summary { servers: { server: string; calls: number; errors: number; denied: number; p50: number | null; p95: number | null }[] }
type Attention = { key: string; tone: 'warn' | 'err'; text: ReactNode; to: string; action: string };

export function OverviewPage() {
  const { me, isAdmin } = useUser();
  const nav = useNavigate();
  const servers = useQuery({ queryKey: ['servers'], queryFn: () => api<{ servers: Server[] }>('/servers'), refetchInterval: 15_000 });
  const tools = useQuery({ queryKey: ['my-tools'], queryFn: () => api<{ tools: MyTool[] }>('/tools') });
  const summary = useQuery({ queryKey: ['audit-summary'], queryFn: () => api<Summary>('/audit/summary'), refetchInterval: 30_000 });
  const recent = useQuery({ queryKey: ['audit', 'recent'], queryFn: () => api<{ events: AuditEvent[] }>('/audit?limit=6'), refetchInterval: 15_000 });
  const stores = useQuery({ queryKey: ['stores'], queryFn: () => api<StoresResponse>('/stores'), enabled: me.storesEnabled, refetchInterval: 30_000 });

  const list = servers.data?.servers ?? [];
  const connected = list.filter((s) => s.status === 'connected').length;
  const down = list.filter((s) => s.status === 'unreachable').length;
  const rows = summary.data?.servers ?? [];
  const bySlug = new Map(rows.map((s) => [s.server, s]));
  const calls = rows.reduce((n, s) => n + s.calls, 0);
  const errors = rows.reduce((n, s) => n + s.errors, 0);
  const denied = rows.reduce((n, s) => n + s.denied, 0);
  const errorRate = calls ? (errors / calls) * 100 : 0;
  const serverCount = new Set((tools.data?.tools ?? []).map((t) => t.server)).size;

  const attention: Attention[] = [];
  if (isAdmin) {
    for (const s of list) {
      if (s.status === 'unreachable') {
        attention.push({ key: `down-${s.id}`, tone: 'err', text: <><strong>{s.displayName}</strong> is unreachable{s.statusReason ? ` (${s.statusReason})` : ''}. Its tools are hidden until it recovers.</>, to: `/servers/${s.id}`, action: 'Investigate' });
      }
      const p = s.tools?.pending ?? 0;
      if (p > 0) {
        attention.push({ key: `review-${s.id}`, tone: 'warn', text: <><strong>{p} tool{p === 1 ? '' : 's'}</strong> on {s.displayName} {p === 1 ? 'is' : 'are'} waiting for your review before anyone can use {p === 1 ? 'it' : 'them'}.</>, to: `/servers/${s.id}?tools=review`, action: 'Review' });
      }
    }
  }
  for (const st of stores.data?.stores ?? []) {
    if (st.phase === 'Failed' && st.canManage) attention.push({ key: `store-${st.name}`, tone: 'err', text: <>Store <strong>{st.displayName}</strong> failed to provision{st.reason ? ` (${st.reason})` : ''}.</>, to: '/stores', action: 'Open stores' });
  }

  return (
    <div className="page">
      <PageHead
        title="Overview"
        desc={`Welcome back, ${me.user.name.split(' ')[0]}. One MCP endpoint for every tool your team uses, with per-person permissions and a full audit trail.`}
        actions={isAdmin ? <LinkButton to="/servers?new=1" variant="primary" icon={<Icons.plus />}>Add server</LinkButton> : <LinkButton to="/chat" variant="primary" icon={<Icons.chat />}>Open chat</LinkButton>}
      />

      <div className="stack-lg">
        <section className="card stats" aria-label="Key numbers">
          <Link className="stat" to="/servers">
            <div className="stat-label"><Icons.servers /> Servers</div>
            <div className="stat-value">{servers.data ? <>{connected}<span className="of">/{list.length}</span></> : '–'}</div>
            <div className="stat-sub">{!servers.data ? ' ' : down ? <Status tone="err">{down} unreachable</Status> : list.length ? <Status tone="ok">All connected</Status> : 'None registered yet'}</div>
          </Link>
          <div className="stat">
            <div className="stat-label"><Icons.cube /> Tools you can use</div>
            <div className="stat-value">{tools.data?.tools.length ?? '–'}</div>
            <div className="stat-sub">{tools.data ? `from ${serverCount} server${serverCount === 1 ? '' : 's'}` : ' '}</div>
          </div>
          <Link className="stat" to="/audit">
            <div className="stat-label"><Icons.activity /> {isAdmin ? 'Tool calls' : 'Your tool calls'}, 24h</div>
            <div className="stat-value">{summary.data ? calls.toLocaleString() : '–'}</div>
            <div className="stat-sub">{denied ? `${denied} denied by permissions` : 'through MCP clients and chat'}</div>
          </Link>
          <Link className="stat" to="/audit">
            <div className="stat-label"><Icons.alertCircle /> Error rate, 24h</div>
            <div className="stat-value">{summary.data ? `${errorRate < 10 && errorRate > 0 ? errorRate.toFixed(1) : Math.round(errorRate)}%` : '–'}</div>
            <div className="stat-sub">{summary.data ? (errors ? <Status tone={errorRate > 5 ? 'err' : 'warn'}>{errors} failed call{errors === 1 ? '' : 's'}</Status> : <Status tone="ok">No failures</Status>) : ' '}</div>
          </Link>
        </section>

        {isAdmin && (
          <Card title="Needs attention" pad={false} className={attention.length ? '' : 'flush'}>
            {attention.length === 0 ? (
              <div className="all-good"><Icons.checkCircle className="ok-text" /> Nothing needs you right now: every server is connected and no tools are waiting for review.</div>
            ) : (
              <ul className="attn">
                {attention.map((a) => (
                  <li key={a.key}>
                    <span className={`attn-icon ${a.tone}`}>{a.tone === 'err' ? <Icons.alertCircle /> : <Icons.eye />}</span>
                    <span className="attn-text">{a.text}</span>
                    <LinkButton to={a.to} size="sm">{a.action}</LinkButton>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}

        <div className="grid-main">
          <Card title="Servers" subtitle="Health and traffic over the last 24 hours" pad={false} actions={<LinkButton to="/servers" size="sm" variant="ghost">View all <Icons.arrowRight /></LinkButton>}>
            {servers.isPending ? <SkeletonRows rows={5} /> : list.length === 0 ? (
              <Empty icon={<Icons.servers />} title="No servers yet" action={isAdmin && <LinkButton to="/servers?new=1" variant="primary" size="sm" icon={<Icons.plus />}>Add server</LinkButton>}>
                {isAdmin ? 'Register an MCP server by URL and its tools appear here for your team.' : 'An admin needs to register MCP servers first.'}
              </Empty>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Server</th><th>Status</th><th className="num">Tools</th><th className="num">Calls</th><th className="num">Errors</th><th className="num">p95</th></tr></thead>
                  <tbody>
                    {list.map((s) => {
                      const m = bySlug.get(s.slug);
                      return (
                        <tr key={s.id} className="clickable" onClick={() => nav(`/servers/${s.id}`)}>
                          <td>
                            <Link to={`/servers/${s.id}`} className="cell-title" onClick={(e) => e.stopPropagation()}>{s.displayName}</Link>
                            <div className="cell-sub mono">{s.slug}</div>
                          </td>
                          <td><StatusBadge status={s.status} /></td>
                          <td className="num">{s.tools?.active ?? 0}</td>
                          <td className="num">{(m?.calls ?? 0).toLocaleString()}</td>
                          <td className="num">{m?.errors ? <span className="err-text">{m.errors}</span> : <span className="faint">0</span>}</td>
                          <td className="num">{m?.p95 != null ? ms(m.p95) : <span className="faint">–</span>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card
            title="Connect a client"
            subtitle="Point any MCP client at your gateway URL. You sign in once in the browser; no key to copy around."
            pad={false}
            footer={<>No OAuth in your client? <Link to="/keys?new=1">Create an API key</Link></>}
          >
            <div className="connect-body">
              <CopyField value={me.mcpUrl} />
            </div>
            <ConnectTabs url={me.mcpUrl} />
          </Card>
        </div>

        <Card title="Recent activity" subtitle={isAdmin ? 'The latest tool calls across the team' : 'Your latest tool calls'} pad={false} actions={<LinkButton to="/audit" size="sm" variant="ghost">Audit log <Icons.arrowRight /></LinkButton>}>
          {recent.isPending ? <SkeletonRows rows={3} /> : (recent.data?.events.length ?? 0) === 0 ? (
            <Empty icon={<Icons.activity />} title="No tool calls yet">Connect a client or ask the chat something; each call shows up here as it happens.</Empty>
          ) : (
            <ul className="feed">
              {recent.data!.events.map((e) => (
                <li key={e.id}>
                  <span className={`dot ${OUTCOME_TONE[e.outcome] ?? ''}`} title={outcomeLabel(e.outcome)} />
                  <span className="what">
                    {isAdmin && <>{e.userEmail ?? 'unknown'} · </>}
                    <span className="mono">{e.exposedName ?? (e.tool ? `${e.server}__${e.tool}` : '—')}</span>
                    {e.outcome !== 'success' && <span className="muted"> · {outcomeLabel(e.outcome)}</span>}
                  </span>
                  <span className="when">{ms(e.durationMs)} · <Time iso={e.ts} /></span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
