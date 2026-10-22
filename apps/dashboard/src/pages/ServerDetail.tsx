import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { api, errorText } from '../api';
import { useUser } from '../auth';
import { AccessBadge, Badge, Button, Callout, Card, Drawer, Empty, ErrorBox, Menu, PageHead, SearchInput, SkeletonRows, StatusBadge, Switch, Tabs, Time, ToolStateBadge, useConfirm, useToast } from '../components/ui';
import { ms } from '../format';
import { Icons } from '../icons';
import { REASON_HINT } from '../reasons';
import type { Server, ToolDef } from '../types';
import { ServerForm } from './Servers';

type CheckResult = { ok: true; latencyMs: number; era: string; protocolVersion: string; server: string; tools: number } | { ok: false; reason: string; detail?: string };
type ToolView = 'all' | 'review' | 'disabled';

const FLAG_TEXT: Record<string, string> = {
  prompt_override: 'Tries to override instructions ("ignore previous instructions…")',
  hidden_instruction_tag: 'Contains instruction tags like <IMPORTANT> or <system>',
  concealment: 'Asks the model to hide something from the user',
  secret_exfiltration: 'Mentions passing along keys, passwords or secrets',
  cross_tool_instruction: 'Tries to direct how other tools are used',
  invisible_characters: 'Contained invisible or control characters (stripped)',
  contains_url: 'Mentions a URL (informational only)',
};
const isPending = (t: ToolDef) => t.state === 'pending_new' || t.state === 'pending_changed';

export function ServerDetailPage() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const { isAdmin } = useUser();
  const qc = useQueryClient();
  const nav = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const [editing, setEditing] = useState(false);
  const [review, setReview] = useState<ToolDef | null>(null);
  const [check, setCheck] = useState<CheckResult | null>(null);
  const [filter, setFilter] = useState('');
  const [view, setView] = useState<ToolView>(params.get('tools') === 'review' ? 'review' : 'all');

  const q = useQuery({ queryKey: ['server', id], queryFn: () => api<{ server: Server; tools: ToolDef[] }>(`/servers/${id}`), refetchInterval: 5_000 });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['server', id] });
    qc.invalidateQueries({ queryKey: ['servers'] });
  };

  const patchServer = useMutation({
    mutationFn: (body: Record<string, unknown>) => api(`/servers/${id}`, { method: 'PATCH', body }),
    onSuccess: (_d, body) => { refresh(); if ('enabled' in body) toast(body.enabled ? 'Server enabled' : 'Server disabled: its tools are hidden from every client'); },
    onError: (e) => toast(errorText(e), true),
  });
  const patchTool = useMutation({
    mutationFn: ({ name, body }: { name: string; body: Record<string, unknown> }) => api<{ tool: ToolDef }>(`/servers/${id}/tools/${encodeURIComponent(name)}`, { method: 'PATCH', body }),
    onSuccess: refresh,
    onError: (e) => toast(errorText(e), true),
  });
  const approveAll = useMutation({
    mutationFn: () => api<{ approved: number }>(`/servers/${id}/tools/approve-all`, { method: 'POST', body: {} }),
    onSuccess: (r) => { toast(`Approved ${r.approved} tool${r.approved === 1 ? '' : 's'}`); refresh(); },
    onError: (e) => toast(errorText(e), true),
  });
  const runCheck = useMutation({
    mutationFn: () => api<CheckResult>(`/servers/${id}/check`, { method: 'POST', body: {} }),
    onSuccess: (r) => { setCheck(r); refresh(); },
    onError: (e) => toast(errorText(e), true),
  });
  const remove = useMutation({
    mutationFn: () => api(`/servers/${id}`, { method: 'DELETE' }),
    onSuccess: () => { toast('Server removed'); qc.invalidateQueries({ queryKey: ['servers'] }); nav('/servers'); },
    onError: (e) => toast(errorText(e), true),
  });

  if (q.isPending) return <div className="page"><Card pad={false}><SkeletonRows rows={6} /></Card></div>;
  if (q.error) return <div className="page"><PageHead crumbs={{ to: '/servers', label: 'Servers' }} title="Server" /><ErrorBox error={q.error} /></div>;
  const { server: s, tools } = q.data;
  const managed = s.managedBy?.startsWith('store/');
  const pending = tools.filter(isPending);
  const disabledTools = tools.filter((t) => t.state === 'disabled');
  const term = filter.trim().toLowerCase();
  const shown = tools
    .filter((t) => (view === 'review' ? isPending(t) : view === 'disabled' ? t.state === 'disabled' : true))
    .filter((t) => !term || `${t.exposedName} ${t.description}`.toLowerCase().includes(term));

  const askRemove = async () => {
    if (await confirm({ title: `Remove ${s.displayName}?`, body: 'Its tools disappear for everyone immediately, and the stored credential is deleted. You can add the server again later.', confirmLabel: 'Remove server', danger: true })) remove.mutate();
  };
  const askApproveAll = async () => {
    if (await confirm({ title: `Approve all ${pending.length} tools?`, body: 'They become available to clients right away without you reading each definition. Prefer reviewing one by one when a tool changed after approval.', confirmLabel: 'Approve all' })) approveAll.mutate();
  };

  return (
    <div className="page">
      <PageHead
        crumbs={{ to: '/servers', label: 'Servers' }}
        title={s.displayName}
        badge={<StatusBadge status={s.status} />}
        desc={s.description || <>Tools from this server appear as <code>{s.slug}__tool</code>.</>}
        actions={isAdmin && (
          <>
            <Button icon={<Icons.refresh />} onClick={() => runCheck.mutate()} loading={runCheck.isPending}>Test connection</Button>
            {!managed && <Button icon={<Icons.edit />} onClick={() => setEditing(true)}>Edit</Button>}
            <Menu
              label="More actions"
              triggerClassName="btn icon"
              items={[
                { label: s.enabled ? 'Disable server' : 'Enable server', icon: <Icons.power />, onSelect: () => patchServer.mutate({ enabled: !s.enabled }) },
                ...(!managed ? [{ separator: true as const }, { label: 'Remove server', icon: <Icons.trash />, danger: true, onSelect: () => void askRemove() }] : []),
              ]}
            />
          </>
        )}
      />

      <div className="stack">
        {check && (check.ok
          ? <Callout tone="ok" title={`Connected in ${check.latencyMs} ms`}>{check.server} · protocol {check.protocolVersion} ({check.era}) · {check.tools} tools</Callout>
          : <Callout tone="err" title={check.reason}>{REASON_HINT[check.reason] ?? ''} {check.detail && <div className="mono xs mt-1">{check.detail}</div>}</Callout>)}
        {s.status === 'unreachable' && !check && (
          <Callout tone="err" title={`Unreachable: ${s.statusReason ?? 'no response'}`} action={isAdmin && <Button size="sm" onClick={() => runCheck.mutate()} loading={runCheck.isPending}>Retry now</Button>}>
            {REASON_HINT[s.statusReason ?? ''] ?? 'The server is not responding.'}
            {s.statusDetail && <div className="mono xs mt-1">{s.statusDetail}</div>}
            <div className="mt-1">Down since <Time iso={s.statusSince} />. Its tools are hidden until it recovers; the gateway keeps retrying.</div>
          </Callout>
        )}
        {!s.enabled && <Callout tone="info" title="Disabled">Its tools are hidden from every client and the chat. Enable it from the ⋯ menu.</Callout>}
        {managed && <Callout tone="info">Managed by <code>{s.managedBy}</code>: it's created and removed with its store.</Callout>}

        <section className="card">
          <dl className="facts">
            <div className="fact"><dt>Latency</dt><dd>{ms(s.latencyMs)}</dd></div>
            <div className="fact"><dt>Tools</dt><dd>{tools.filter((t) => t.state === 'active').length} active{pending.length > 0 && <span className="warn-text"> · {pending.length} to review</span>}</dd></div>
            <div className="fact"><dt>Protocol</dt><dd title={s.protocolEra ?? undefined}>{s.protocolVersion ?? '–'}</dd></div>
            <div className="fact"><dt>Last OK</dt><dd><Time iso={s.lastOkAt} /></dd></div>
            <div className="fact"><dt>Tools synced</dt><dd><Time iso={s.toolsSyncedAt} /></dd></div>
          </dl>
        </section>

        {isAdmin && pending.length > 0 && (
          <Callout
            tone="warn"
            title={`${pending.length} tool${pending.length === 1 ? '' : 's'} waiting for review`}
            action={<>
              {view !== 'review' && <Button size="sm" onClick={() => setView('review')}>Show them</Button>}
              <Button size="sm" variant="ghost" onClick={() => void askApproveAll()} loading={approveAll.isPending}>Approve all</Button>
            </>}
          >
            New tools with suspicious descriptions, and any tool whose definition changed after approval, stay hidden from every client until you approve them.
          </Callout>
        )}

        <Card
          title="Tools"
          subtitle={isAdmin ? 'Access sets the default for members: read tools are allowed, write tools need a permission rule. Pinned tools stay listed in search mode.' : undefined}
          pad={false}
          actions={<SearchInput size="sm" value={filter} onChange={setFilter} placeholder="Filter tools" />}
        >
          <Tabs
            value={view}
            onChange={setView}
            tabs={[
              { value: 'all', label: 'All', count: tools.length },
              { value: 'review', label: 'Needs review', count: pending.length, tone: pending.length ? 'warn' : undefined },
              { value: 'disabled', label: 'Disabled', count: disabledTools.length },
            ]}
          />
          {tools.length === 0 ? <Empty icon={<Icons.cube />} title="No tools yet">They appear after the first successful sync.</Empty> : shown.length === 0 ? (
            <Empty title={view === 'review' && !term ? 'All caught up' : 'No matching tools'}>{view === 'review' && !term ? 'Every tool on this server has been reviewed.' : 'Try another filter.'}</Empty>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Tool</th><th>State</th><th>Access</th>{isAdmin && <><th className="shrink">Pinned</th><th className="shrink">Enabled</th><th /></>}</tr></thead>
                <tbody>
                  {shown.slice(0, 300).map((t) => (
                    <tr key={t.name}>
                      <td>
                        <div className="mono cell-title">{t.exposedName}</div>
                        <div className="cell-desc" title={t.description}>{t.description || <em>No description</em>}</div>
                        {t.flags.some((f) => f !== 'contains_url') && (
                          <div className="row-sm mt-1">{t.flags.filter((f) => f !== 'contains_url').map((f) => <Badge key={f} tone="err" title={FLAG_TEXT[f]}>{f.replace(/_/g, ' ')}</Badge>)}</div>
                        )}
                      </td>
                      <td><ToolStateBadge state={t.state} /></td>
                      <td>
                        {isAdmin ? (
                          <select className="input sm" value={t.access} aria-label={`Access for ${t.exposedName}`} onChange={(e) => patchTool.mutate({ name: t.name, body: { access: e.target.value } })} title={`The server suggests: ${t.suggestedAccess}`}>
                            <option value="read">Read</option>
                            <option value="write">Write</option>
                          </select>
                        ) : <AccessBadge access={t.access} />}
                      </td>
                      {isAdmin && (
                        <>
                          <td><Switch label={`Pin ${t.exposedName}`} checked={t.pinned} onChange={(pinned) => patchTool.mutate({ name: t.name, body: { pinned } })} /></td>
                          <td><Switch label={`Enable ${t.exposedName}`} checked={t.state !== 'disabled'} disabled={t.state === 'gone'} onChange={(enabled) => patchTool.mutate({ name: t.name, body: { enabled } })} /></td>
                          <td className="actions-cell">
                            {isPending(t)
                              ? <Button size="sm" variant="primary" onClick={() => setReview(t)}>Review</Button>
                              : <Button size="sm" variant="ghost" onClick={() => setReview(t)}>Details</Button>}
                          </td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
              {shown.length > 300 && <div className="table-note">Showing 300 of {shown.length}. Use the filter to narrow it down.</div>}
            </div>
          )}
        </Card>

        <Card title="Connection">
          <dl className="props">
            <dt>Endpoint</dt><dd className="mono break">{s.url}</dd>
            <dt>Tool prefix</dt><dd><code>{s.slug}__</code></dd>
            <dt>Authentication</dt><dd>{s.authType === 'none' ? 'None' : s.authType === 'bearer' ? 'Bearer token' : <>Header <code>{s.authHeaderName}</code></>}{s.credentialSet && <span className="muted"> · credential stored, encrypted</span>}</dd>
            <dt>Upstream server</dt><dd>{s.serverName ? `${s.serverName} ${s.serverVersion ?? ''}` : '–'}</dd>
            <dt>Protocol</dt><dd>{s.protocolVersion ? `${s.protocolVersion} (${s.protocolEra === 'modern' ? 'stateless, 2026' : 'session-based, 2025'})` : '–'}</dd>
            <dt>Timeout · concurrency</dt><dd>{ms(s.timeoutMs)} · up to {s.maxConcurrency} calls at once</dd>
            <dt>Last health check</dt><dd><Time iso={s.lastCheckedAt} /></dd>
          </dl>
        </Card>
      </div>

      {editing && <ServerForm server={s} onClose={() => setEditing(false)} />}
      {review && (
        <ToolReview
          tool={tools.find((t) => t.name === review.name) ?? review}
          isAdmin={isAdmin}
          onClose={() => setReview(null)}
          onApprove={() => patchTool.mutate({ name: review.name, body: { approve: true } }, { onSuccess: () => { toast(`${review.exposedName} approved`); setReview(null); } })}
          busy={patchTool.isPending}
        />
      )}
    </div>
  );
}

function ToolReview({ tool, isAdmin, onClose, onApprove, busy }: { tool: ToolDef; isAdmin: boolean; onClose: () => void; onApprove: () => void; busy: boolean }) {
  const pending = isPending(tool);
  return (
    <Drawer
      title={<span className="mono">{tool.exposedName}</span>}
      onClose={onClose}
      footer={pending && isAdmin ? <><Button onClick={onClose}>Not now</Button><Button variant="primary" icon={<Icons.check />} loading={busy} onClick={onApprove}>Approve this definition</Button></> : undefined}
    >
      <div className="stack">
        <div className="row"><ToolStateBadge state={tool.state} /><AccessBadge access={tool.access} /><span className="small muted">First seen <Time iso={tool.firstSeenAt} /></span></div>
        {tool.state === 'pending_changed' && (
          <Callout tone="err" title="Changed after approval">
            The server changed this tool's definition (<Time iso={tool.changedAt} />). Changing a description after approval is how "rug pull" attacks work, so it's hidden until you compare and approve.
          </Callout>
        )}
        {tool.flags.length > 0 && (
          <Callout tone="warn" title="Hygiene scan">
            <ul className="flag-list">{tool.flags.map((f) => <li key={f}>{FLAG_TEXT[f] ?? f}</li>)}</ul>
          </Callout>
        )}
        {tool.previous ? (
          <>
            <div>
              <h3>Description</h3>
              <div className="diff">
                <div><div className="label">Approved before</div><pre className="code plain old">{tool.previous.description ?? ''}</pre></div>
                <div><div className="label">Now</div><pre className="code plain new">{tool.description}</pre></div>
              </div>
            </div>
            {JSON.stringify(tool.previous.input_schema) !== JSON.stringify(tool.inputSchema) && (
              <div>
                <h3>Input schema</h3>
                <div className="diff">
                  <pre className="code plain old">{JSON.stringify(tool.previous.input_schema, null, 2)}</pre>
                  <pre className="code plain new">{JSON.stringify(tool.inputSchema, null, 2)}</pre>
                </div>
              </div>
            )}
          </>
        ) : (
          <>
            <div>
              <h3>Description</h3>
              <pre className="code plain pre-wrap">{tool.description || '(none)'}</pre>
            </div>
            <div>
              <h3>Input schema</h3>
              <pre className="code plain scroll">{JSON.stringify(tool.inputSchema, null, 2)}</pre>
            </div>
          </>
        )}
        {tool.annotations && (
          <div>
            <h3>Annotations <span className="muted small">(hints from the server, not trusted)</span></h3>
            <pre className="code plain">{JSON.stringify(tool.annotations, null, 2)}</pre>
          </div>
        )}
      </div>
    </Drawer>
  );
}
