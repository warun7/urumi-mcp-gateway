import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, errorText } from '../api';
import { useUser } from '../auth';
import { Badge, Button, Card, Empty, ErrorBox, Field, Modal, PageHead, SearchInput, Segmented, SkeletonRows, StatusBadge, Switch, Time, useParamFlag, useToast } from '../components/ui';
import { ms } from '../format';
import { Icons } from '../icons';
import type { Server } from '../types';

type View = 'all' | 'attention' | 'disabled';
const needsAttention = (s: Server) => s.status === 'unreachable' || (s.tools?.pending ?? 0) > 0;

export function ServersPage() {
  const { isAdmin } = useUser();
  const qc = useQueryClient();
  const nav = useNavigate();
  const toast = useToast();
  const [adding, setAdding] = useParamFlag('new');
  const [q, setQ] = useState('');
  const [view, setView] = useState<View>('all');
  const servers = useQuery({ queryKey: ['servers'], queryFn: () => api<{ servers: Server[] }>('/servers'), refetchInterval: 5_000 });

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api(`/servers/${id}`, { method: 'PATCH', body: { enabled } }),
    onSuccess: (_d, v) => toast(v.enabled ? 'Server enabled: its tools are back for everyone' : 'Server disabled: its tools are hidden from every client'),
    onError: (e) => toast(errorText(e), true),
    onSettled: () => qc.invalidateQueries({ queryKey: ['servers'] }),
  });

  const all = servers.data?.servers ?? [];
  const attention = all.filter(needsAttention).length;
  const disabled = all.filter((s) => !s.enabled).length;
  const term = q.trim().toLowerCase();
  const shown = all
    .filter((s) => (view === 'attention' ? needsAttention(s) : view === 'disabled' ? !s.enabled : true))
    .filter((s) => !term || `${s.displayName} ${s.slug} ${s.url}`.toLowerCase().includes(term));

  return (
    <div className="page">
      <PageHead
        title="Servers"
        desc={<>The MCP servers behind your gateway. Each server's tools reach clients as <code>server__tool</code>, filtered per person by permissions.</>}
        actions={isAdmin && <Button variant="primary" icon={<Icons.plus />} onClick={() => setAdding(true)}>Add server</Button>}
      />
      <Card pad={false}>
        {servers.isPending ? <SkeletonRows rows={6} /> : servers.error ? <div className="card-body"><ErrorBox error={servers.error} /></div> : all.length === 0 ? (
          <Empty icon={<Icons.servers />} title="No servers registered" action={isAdmin && <Button variant="primary" size="sm" icon={<Icons.plus />} onClick={() => setAdding(true)}>Add server</Button>}>
            {isAdmin ? 'Add an MCP server by its URL. The gateway connects, syncs its tools and starts health-checking it.' : 'Ask an admin to register one.'}
          </Empty>
        ) : (
          <>
            <div className="toolbar">
              <SearchInput size="sm" value={q} onChange={setQ} placeholder="Search servers" />
              <Segmented
                size="sm"
                value={view}
                onChange={setView}
                options={[
                  { value: 'all', label: <>All <span className="seg-count">{all.length}</span></> },
                  { value: 'attention', label: <>Needs attention <span className="seg-count">{attention}</span></> },
                  { value: 'disabled', label: <>Disabled <span className="seg-count">{disabled}</span></> },
                ]}
              />
            </div>
            {shown.length === 0 ? (
              <Empty title={view === 'attention' && !term ? 'Nothing needs attention' : 'No matching servers'}>
                {view === 'attention' && !term ? 'Every server is connected and every tool has been reviewed.' : 'Try a different search or filter.'}
              </Empty>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr><th>Server</th><th>Status</th><th>Tools</th><th className="col-wide">Protocol</th><th className="num">Latency</th><th className="col-wide">Last check</th>{isAdmin && <th className="shrink">Enabled</th>}</tr>
                  </thead>
                  <tbody>
                    {shown.map((s) => (
                      <tr key={s.id} className="clickable" onClick={() => nav(`/servers/${s.id}`)}>
                        <td>
                          <div className="row-sm">
                            <Link to={`/servers/${s.id}`} className="cell-title" onClick={(e) => e.stopPropagation()}>{s.displayName}</Link>
                            <span className="mono xs muted">{s.slug}</span>
                            {s.managedBy?.startsWith('store/') && <Badge icon={<Icons.store />}>Store</Badge>}
                          </div>
                          <div className="cell-sub truncate" title={s.url}>{s.url}</div>
                        </td>
                        <td>
                          <StatusBadge status={s.status} reason={s.statusReason} />
                          {s.status === 'unreachable' && s.statusReason && <div className="cell-sub mono">{s.statusReason}</div>}
                        </td>
                        <td className="nowrap">
                          <span className="tabular">{s.tools?.active ?? 0}</span>
                          {(s.tools?.pending ?? 0) > 0 && <> <Badge tone="warn">{s.tools!.pending} to review</Badge></>}
                        </td>
                        <td className="small nowrap col-wide">{s.protocolVersion ? <>{s.protocolVersion} <span className="muted">· {s.protocolEra}</span></> : <span className="faint">–</span>}</td>
                        <td className="num">{s.latencyMs != null ? ms(s.latencyMs) : <span className="faint">–</span>}</td>
                        <td className="small muted col-wide"><Time iso={s.lastCheckedAt} /></td>
                        {isAdmin && (
                          <td onClick={(e) => e.stopPropagation()}>
                            <Switch label={`${s.enabled ? 'Disable' : 'Enable'} ${s.displayName}`} checked={s.enabled} disabled={toggle.isPending} onChange={(enabled) => toggle.mutate({ id: s.id, enabled })} />
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </Card>
      {adding && isAdmin && <ServerForm onClose={() => setAdding(false)} onSaved={(s) => nav(`/servers/${s.id}`)} />}
    </div>
  );
}

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/^[^a-z]+/, '').slice(0, 20);

/** Register a server, or edit one. Credentials are write-only: the API only says whether one is set. */
export function ServerForm({ server, onClose, onSaved }: { server?: Server; onClose: () => void; onSaved?: (s: Server) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const editing = !!server;
  const [f, setF] = useState({
    displayName: server?.displayName ?? '',
    slug: server?.slug ?? '',
    description: server?.description ?? '',
    url: server?.url ?? '',
    authType: server?.authType ?? 'none',
    authHeaderName: server?.authHeaderName ?? 'x-api-key',
    credential: '',
    timeoutMs: server?.timeoutMs ?? 20_000,
    maxConcurrency: server?.maxConcurrency ?? 16,
  });
  const [slugTouched, setSlugTouched] = useState(editing);
  const [advanced, setAdvanced] = useState(false);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((s) => ({ ...s, [k]: v }));

  const save = useMutation({
    mutationFn: () => {
      const auth = { authType: f.authType, ...(f.authType === 'header' ? { authHeaderName: f.authHeaderName } : {}), ...(f.credential ? { credential: f.credential } : {}) };
      const all = { displayName: f.displayName, description: f.description, url: f.url, timeoutMs: Number(f.timeoutMs), maxConcurrency: Number(f.maxConcurrency), ...auth };
      if (!editing) return api<{ server: Server }>('/servers', { body: { ...all, slug: f.slug } });
      // Send only what changed: touching auth or the URL makes the gateway reconnect, a rename shouldn't.
      const changed = Object.fromEntries(Object.entries(all).filter(([k, v]) => k === 'credential' || v !== (server as unknown as Record<string, unknown>)[k]));
      if (f.credential) changed.authType = f.authType;
      return api<{ server: Server }>(`/servers/${server!.id}`, { method: 'PATCH', body: changed });
    },
    onSuccess: (r) => {
      toast(editing ? 'Saved. The gateway is reconnecting…' : 'Server added. Connecting and syncing its tools…');
      qc.invalidateQueries({ queryKey: ['servers'] });
      qc.invalidateQueries({ queryKey: ['server', r.server.id] });
      onSaved?.(r.server);
      onClose();
    },
  });

  const needsCred = f.authType !== 'none' && !(editing && server!.credentialSet && server!.authType === f.authType);

  return (
    <Modal
      title={editing ? `Edit ${server!.displayName}` : 'Add an MCP server'}
      desc={editing ? undefined : 'The gateway connects right away, syncs the tool list and keeps health-checking it.'}
      onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>{editing ? 'Save changes' : 'Add server'}</Button></>}
    >
      <form className="form" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <Field label="MCP endpoint URL" hint="A Streamable HTTP endpoint, usually ending in /mcp. Public servers need https; private addresses are blocked unless allow-listed.">
          <input className="input" type="url" required autoFocus={!editing} value={f.url} placeholder="https://mcp.example.com/mcp" onChange={(e) => set('url', e.target.value)} />
        </Field>
        <div className="form-row">
          <Field label="Name">
            <input className="input" value={f.displayName} required maxLength={80} placeholder="Linear" onChange={(e) => {
              set('displayName', e.target.value);
              if (!slugTouched) set('slug', slugify(e.target.value));
            }} />
          </Field>
          <Field label="Tool prefix" hint={editing ? 'Fixed: clients refer to tools by it.' : <>Tools appear as <code>{f.slug || 'prefix'}__tool</code></>}>
            <input className="input mono" value={f.slug} disabled={editing} required pattern="[a-z][a-z0-9-]{0,19}" placeholder="linear" onChange={(e) => { setSlugTouched(true); set('slug', e.target.value); }} />
          </Field>
        </div>
        <Field label="Description" optional>
          <input className="input" maxLength={300} value={f.description} placeholder="What the team uses it for" onChange={(e) => set('description', e.target.value)} />
        </Field>
        <div className="form-row">
          <Field label="Authentication">
            <select className="input" value={f.authType} onChange={(e) => set('authType', e.target.value as typeof f.authType)}>
              <option value="none">None</option>
              <option value="bearer">Bearer token</option>
              <option value="header">Custom header</option>
            </select>
          </Field>
          {f.authType === 'header' && (
            <Field label="Header name">
              <input className="input mono" value={f.authHeaderName} onChange={(e) => set('authHeaderName', e.target.value)} />
            </Field>
          )}
        </div>
        {f.authType !== 'none' && (
          <Field label={f.authType === 'bearer' ? 'Token' : 'Header value'} hint={editing && server!.credentialSet ? 'A credential is stored (encrypted). Leave blank to keep it.' : 'Stored encrypted (AES-256-GCM). Never shown again and never sent to clients.'}>
            <input className="input mono" type="password" autoComplete="off" required={needsCred} value={f.credential} onChange={(e) => set('credential', e.target.value)} />
          </Field>
        )}
        {advanced ? (
          <div className="form-row">
            <Field label="Call timeout (ms)"><input className="input" type="number" min={1000} max={120000} step={1000} value={f.timeoutMs} onChange={(e) => set('timeoutMs', Number(e.target.value))} /></Field>
            <Field label="Max concurrent calls"><input className="input" type="number" min={1} max={256} value={f.maxConcurrency} onChange={(e) => set('maxConcurrency', Number(e.target.value))} /></Field>
          </div>
        ) : (
          <div><button type="button" className="link-btn small" onClick={() => setAdvanced(true)}>Timeout and concurrency…</button></div>
        )}
        <ErrorBox error={save.error} />
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
