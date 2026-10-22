import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useUser } from '../auth';
import { Badge, Button, Card, Drawer, Empty, ErrorBox, PageHead, SkeletonRows, Status, Switch, Time } from '../components/ui';
import { bytes, fullTime, ms } from '../format';
import { Icons } from '../icons';
import type { AuditEvent, Outcome, Server } from '../types';

const OUTCOMES: Outcome[] = ['success', 'tool_error', 'denied', 'invalid_args', 'timeout', 'unavailable', 'auth_failed', 'rate_limited', 'cancelled', 'error'];
export const OUTCOME_TONE: Partial<Record<Outcome, 'ok' | 'warn' | 'err'>> = {
  success: 'ok', tool_error: 'warn', invalid_args: 'warn', rate_limited: 'warn', denied: 'err', auth_failed: 'err', timeout: 'err', unavailable: 'err', error: 'err',
};
const OUTCOME_LABEL: Record<Outcome, string> = {
  success: 'Success', tool_error: 'Tool error', denied: 'Denied', invalid_args: 'Invalid arguments', timeout: 'Timed out', unavailable: 'Server unavailable',
  auth_failed: 'Auth failed', rate_limited: 'Rate limited', cancelled: 'Cancelled', error: 'Error',
};
export const outcomeLabel = (o: Outcome) => OUTCOME_LABEL[o] ?? o;

type Filters = { user: string; server: string; tool: string; outcome: string; via: string };
const empty: Filters = { user: '', server: '', tool: '', outcome: '', via: '' };

function matches(e: AuditEvent, f: Filters) {
  if (f.user && !(e.userEmail ?? '').toLowerCase().includes(f.user.toLowerCase())) return false;
  if (f.server && e.server !== f.server) return false;
  if (f.tool && !`${e.tool ?? ''} ${e.exposedName ?? ''}`.toLowerCase().includes(f.tool.toLowerCase())) return false;
  if (f.outcome && e.outcome !== f.outcome) return false;
  if (f.via && e.via !== f.via) return false;
  return true;
}

export function AuditPage() {
  const { isAdmin } = useUser();
  const [f, setF] = useState<Filters>(empty);
  const [applied, setApplied] = useState<Filters>(empty);
  const [live, setLive] = useState(true);
  const [liveRows, setLiveRows] = useState<AuditEvent[]>([]);
  const [open, setOpen] = useState<AuditEvent | null>(null);
  const servers = useQuery({ queryKey: ['servers'], queryFn: () => api<{ servers: Server[] }>('/servers') });

  const qs = useMemo(() => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(applied)) if (v) p.set(k, v);
    return p;
  }, [applied]);

  const pages = useInfiniteQuery({
    queryKey: ['audit', qs.toString()],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams(qs);
      p.set('limit', '100');
      if (pageParam) p.set('before', String(pageParam));
      return api<{ events: AuditEvent[] }>(`/audit?${p}`);
    },
    getNextPageParam: (last) => (last.events.length === 100 ? last.events.at(-1)!.id : undefined),
  });
  useEffect(() => setLiveRows([]), [qs]);

  // Live tail: the gateway pushes new audit rows over SSE (fed by Postgres NOTIFY, so it works across replicas).
  useEffect(() => {
    if (!live) return;
    const es = new EventSource('/api/audit/stream');
    es.addEventListener('audit', (m) => {
      const e = JSON.parse((m as MessageEvent).data) as AuditEvent;
      if (matches(e, applied)) setLiveRows((rows) => (rows.some((r) => r.id === e.id) ? rows : [e, ...rows].slice(0, 500)));
    });
    return () => es.close();
  }, [live, applied]);

  const loaded = pages.data?.pages.flatMap((p) => p.events) ?? [];
  const seen = new Set(loaded.map((e) => e.id));
  const rows = [...liveRows.filter((e) => !seen.has(e.id)), ...loaded];
  const filtered = JSON.stringify(applied) !== JSON.stringify(empty);
  // Selects apply immediately; text fields apply on Enter or the Apply button.
  const setNow = (patch: Partial<Filters>) => {
    const next = { ...f, ...patch };
    setF(next);
    setApplied(next);
  };

  return (
    <div className="page">
      <PageHead
        title="Audit log"
        desc={isAdmin ? 'Every tool call through the gateway: who, from which client, which tool, and what happened. Append-only: the gateway itself can’t edit or delete rows.' : 'Your own tool calls through the gateway.'}
        actions={<>
          <label className="switch-label">
            <Switch label="Live updates" checked={live} onChange={setLive} />
            {live ? <Status tone="ok" pulse>Live</Status> : 'Paused'}
          </label>
          <a className="btn" href={`/api/audit/export.csv?${qs}`}><Icons.download /> Export CSV</a>
        </>}
      />
      <Card pad={false}>
        <form className="toolbar" onSubmit={(e) => { e.preventDefault(); setApplied(f); }}>
          {isAdmin && <input className="input sm" placeholder="User email" value={f.user} onChange={(e) => setF({ ...f, user: e.target.value })} aria-label="Filter by user" />}
          <input className="input sm" placeholder="Tool name" value={f.tool} onChange={(e) => setF({ ...f, tool: e.target.value })} aria-label="Filter by tool" />
          <select className="input sm" value={f.server} onChange={(e) => setNow({ server: e.target.value })} aria-label="Filter by server">
            <option value="">All servers</option>
            <option value="gateway">gateway (meta-tools)</option>
            {servers.data?.servers.map((s) => <option key={s.id} value={s.slug}>{s.displayName}</option>)}
          </select>
          <select className="input sm" value={f.outcome} onChange={(e) => setNow({ outcome: e.target.value })} aria-label="Filter by outcome">
            <option value="">Any outcome</option>
            {OUTCOMES.map((o) => <option key={o} value={o}>{OUTCOME_LABEL[o]}</option>)}
          </select>
          <select className="input sm" value={f.via} onChange={(e) => setNow({ via: e.target.value })} aria-label="Filter by channel">
            <option value="">MCP clients and chat</option>
            <option value="mcp">MCP clients</option>
            <option value="chat">Chat</option>
          </select>
          <Button size="sm" type="submit">Apply</Button>
          {filtered && <Button size="sm" variant="ghost" icon={<Icons.x />} onClick={() => { setF(empty); setApplied(empty); }}>Clear</Button>}
          {pages.data && <span className="count">{rows.length}{pages.hasNextPage ? '+' : ''} events</span>}
        </form>
        {pages.isPending ? <SkeletonRows rows={8} /> : pages.error ? <div className="card-body"><ErrorBox error={pages.error} /></div> : rows.length === 0 ? (
          <Empty icon={<Icons.audit />} title={filtered ? 'No matching events' : 'No tool calls yet'}>
            {filtered ? 'Try widening the filters.' : 'Calls from MCP clients and the chat appear here, live.'}
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Time</th>{isAdmin && <th>User</th>}<th>Client</th><th>Tool</th><th>Outcome</th><th className="num">Duration</th><th className="num">Result</th></tr></thead>
              <tbody>
                {rows.map((e) => (
                  <tr key={e.id} className="clickable" onClick={() => setOpen(e)}>
                    <td className="small muted"><Time iso={e.ts} /></td>
                    {isAdmin && <td className="small truncate">{e.userEmail ?? <span className="faint">unknown</span>}</td>}
                    <td className="small">{clientLabel(e)}</td>
                    <td className="mono">{e.exposedName ?? (e.tool ? `${e.server}__${e.tool}` : <span className="faint">–</span>)}</td>
                    <td><Status tone={OUTCOME_TONE[e.outcome]}>{outcomeLabel(e.outcome)}</Status>{e.errorCode && <span className="xs muted"> · {e.errorCode}</span>}</td>
                    <td className="num small">{ms(e.durationMs)}</td>
                    <td className="num small muted">{bytes(e.resultBytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {pages.hasNextPage && <div className="table-note"><Button size="sm" loading={pages.isFetchingNextPage} onClick={() => pages.fetchNextPage()}>Load older events</Button></div>}
          </div>
        )}
      </Card>
      {open && (
        <Drawer title={`Event #${open.id}`} onClose={() => setOpen(null)}>
          <div className="stack">
            <div className="row-sm">
              <Status tone={OUTCOME_TONE[open.outcome]}>{outcomeLabel(open.outcome)}</Status>
              {open.errorCode && <Badge tone="err">{open.errorCode}</Badge>}
              <span className="small muted">· {fullTime(open.ts)}</span>
            </div>
            <dl className="props">
              <dt>User</dt><dd>{open.userEmail ?? '–'}</dd>
              <dt>Signed in with</dt><dd>{open.authMethod ?? '–'}{open.credentialId && <span className="mono xs muted"> · {open.credentialId}</span>}</dd>
              <dt>Client</dt><dd>{clientLabel(open)}</dd>
              <dt>Server</dt><dd>{open.server ?? '–'}</dd>
              <dt>Tool</dt><dd className="mono">{open.exposedName ?? open.tool ?? '–'}</dd>
              {open.errorMessage && <><dt>Error</dt><dd className="mono xs">{open.errorMessage}</dd></>}
              <dt>Duration</dt><dd>{ms(open.durationMs)}</dd>
              <dt>Arguments size</dt><dd>{bytes(open.argsBytes)}</dd>
              <dt>Result size</dt><dd>{bytes(open.resultBytes)}</dd>
              <dt>Trace id</dt><dd className="mono xs">{open.traceId ?? '–'}</dd>
            </dl>
            <p className="small muted">Arguments and results aren't stored, only their sizes: they can contain customer data.</p>
          </div>
        </Drawer>
      )}
    </div>
  );
}

function clientLabel(e: AuditEvent) {
  if (e.via === 'chat') return 'Urumi chat';
  if (e.authMethod === 'oauth') return e.client ?? 'OAuth app';
  if (e.authMethod === 'api_key') return 'API key';
  return e.client ?? e.authMethod ?? '–';
}
