import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { api, errorText } from '../api';
import { useUser } from '../auth';
import { ConnectTabs } from '../components/connect';
import { Button, Callout, Card, CopyButton, CopyField, Empty, ErrorBox, Field, Modal, PageHead, Segmented, SkeletonRows, Status, Time, useConfirm, useParamFlag, useToast } from '../components/ui';
import { Icons } from '../icons';
import type { ApiKey, Member, ToolMode } from '../types';

export const MODE_HINT: Record<ToolMode, string> = {
  auto: 'Lists every tool while the catalog is small, and switches to search above 60 tools.',
  full: 'Every tool you can use is listed up front.',
  search: 'Lists 3 gateway tools; the client searches for the rest on demand. Best for big catalogs.',
};
const MODE_LABEL: Record<ToolMode, string> = { auto: 'Auto', full: 'All tools', search: 'Search' };

export function KeysPage() {
  const { me, isAdmin } = useUser();
  const [params] = useSearchParams();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [all, setAll] = useState(false);
  const [creating, setCreating] = useParamFlag('new');
  const keys = useQuery({ queryKey: ['keys', all], queryFn: () => api<{ keys: ApiKey[] }>(`/keys${all ? '?all=1' : ''}`) });

  const setMode = useMutation({
    mutationFn: ({ id, toolMode }: { id: string; toolMode: ToolMode }) => api(`/keys/${id}`, { method: 'PATCH', body: { toolMode } }),
    onSuccess: () => toast('Tool mode updated: connected clients see it on their next tool list'),
    onError: (e) => toast(errorText(e), true),
    onSettled: () => qc.invalidateQueries({ queryKey: ['keys'] }),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/keys/${id}`, { method: 'DELETE' }),
    onSuccess: () => toast('Key revoked: it stopped working immediately'),
    onError: (e) => toast(errorText(e), true),
    onSettled: () => qc.invalidateQueries({ queryKey: ['keys'] }),
  });
  const askRevoke = async (k: ApiKey) => {
    if (await confirm({ title: `Revoke “${k.name}”?`, body: 'Any client using this key loses access on its next request. This can’t be undone; create a new key if you need one again.', confirmLabel: 'Revoke key', danger: true })) revoke.mutate(k.id);
  };

  const list = keys.data?.keys ?? [];
  return (
    <div className="page">
      <PageHead
        title="API keys"
        desc="Personal keys for MCP clients that can't sign in with OAuth. A key acts as its owner: it sees exactly the tools they can use, and every call is logged under their name."
        actions={<Button variant="primary" icon={<Icons.plus />} onClick={() => setCreating(true)}>Create key</Button>}
      />
      <div className="stack">
        {params.get('welcome') && (
          <Callout tone="ok" title={`Welcome aboard, ${me.user.name.split(' ')[0]}`}>
            Connect your MCP client: OAuth-capable clients only need the URL below, or create a key for the rest.
          </Callout>
        )}
        <Card pad={false}>
          {isAdmin && (
            <div className="toolbar">
              <Segmented size="sm" value={all ? 'all' : 'mine'} onChange={(v) => setAll(v === 'all')} options={[{ value: 'mine', label: 'My keys' }, { value: 'all', label: 'Whole team' }]} />
              {keys.data && <span className="count">{list.filter((k) => k.status === 'active').length} active</span>}
            </div>
          )}
          {keys.isPending ? <SkeletonRows rows={3} /> : keys.error ? <div className="card-body"><ErrorBox error={keys.error} /></div> : list.length === 0 ? (
            <Empty icon={<Icons.key />} title={all ? 'No keys on the team yet' : 'You have no API keys'} action={<Button size="sm" variant="primary" icon={<Icons.plus />} onClick={() => setCreating(true)}>Create key</Button>}>
              Create one to connect Cursor, scripts, or any MCP client that doesn't do OAuth.
            </Empty>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Name</th>{all && <th>Owner</th>}<th>Key</th><th>Tool mode</th><th>Last used</th><th>Created</th><th>Status</th><th /></tr></thead>
                <tbody>
                  {list.map((k) => (
                    <tr key={k.id} className={k.status !== 'active' ? 'dim' : undefined}>
                      <td>
                        <div className="cell-title">{k.name}</div>
                        {k.createdBy && k.createdBy !== k.userEmail && <div className="cell-sub">Issued by {k.createdBy}</div>}
                      </td>
                      {all && <td className="small">{k.userEmail}</td>}
                      <td><code>{k.prefix}…</code></td>
                      <td>
                        <select className="input sm" value={k.toolMode} disabled={k.status !== 'active'} title={MODE_HINT[k.toolMode]} aria-label={`Tool mode for ${k.name}`} onChange={(e) => setMode.mutate({ id: k.id, toolMode: e.target.value as ToolMode })}>
                          {(['auto', 'full', 'search'] as const).map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}
                        </select>
                      </td>
                      <td className="small muted">{k.lastUsedAt ? <Time iso={k.lastUsedAt} /> : 'Never'}</td>
                      <td className="small muted"><Time iso={k.createdAt} /></td>
                      <td>{k.status === 'active' ? <Status tone="ok">Active</Status> : <Status>{k.status === 'revoked' ? 'Revoked' : 'Expired'}</Status>}</td>
                      <td className="actions-cell">{k.status === 'active' && <Button size="sm" variant="ghost" className="danger" onClick={() => void askRevoke(k)}>Revoke</Button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <Card title="No key needed for OAuth clients" subtitle="Claude Code, Cursor and VS Code can sign in with just the URL. Each connection then shows up under Connected apps, where you can disconnect it.">
          <CopyField value={me.mcpUrl} />
        </Card>
      </div>
      {creating && <CreateKeyModal onClose={() => setCreating(false)} />}
    </div>
  );
}

function CreateKeyModal({ onClose }: { onClose: () => void }) {
  const { me, isAdmin } = useUser();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [toolMode, setToolMode] = useState<ToolMode>('auto');
  const [expires, setExpires] = useState('');
  const [userId, setUserId] = useState('');
  const members = useQuery({ queryKey: ['members'], queryFn: () => api<{ members: Member[] }>('/members'), enabled: isAdmin });
  const create = useMutation({
    mutationFn: () => api<{ id: string; key: string; mcpUrl: string }>('/keys', {
      body: { name, toolMode, ...(expires ? { expiresInDays: Number(expires) } : {}), ...(userId ? { userId } : {}) },
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['keys'] }),
  });

  if (create.data) return <KeyCreated keyValue={create.data.key} url={create.data.mcpUrl} onClose={onClose} />;
  return (
    <Modal
      title="Create an API key"
      desc="The key is shown once, right after you create it."
      onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={create.isPending} disabled={!name.trim()} onClick={() => create.mutate()}>Create key</Button></>}
    >
      <form className="form" onSubmit={(e) => { e.preventDefault(); if (name.trim()) create.mutate(); }}>
        <Field label="Name" hint="Where it will be used, so you can recognise it later.">
          <input className="input" required maxLength={60} autoFocus value={name} placeholder="Cursor on my laptop" onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Tool mode" hint={MODE_HINT[toolMode]}>
          <Segmented value={toolMode} onChange={setToolMode} options={(['auto', 'full', 'search'] as const).map((m) => ({ value: m, label: MODE_LABEL[m] }))} />
        </Field>
        <div className="form-row">
          <Field label="Expires">
            <select className="input" value={expires} onChange={(e) => setExpires(e.target.value)}>
              <option value="">Never</option>
              <option value="7">In 7 days</option>
              <option value="30">In 30 days</option>
              <option value="90">In 90 days</option>
            </select>
          </Field>
          {isAdmin && (
            <Field label="Owner" hint={userId ? 'The key acts as this person, with their permissions.' : undefined}>
              <select className="input" value={userId} onChange={(e) => setUserId(e.target.value)}>
                <option value="">Me ({me.user.email})</option>
                {members.data?.members.filter((m) => m.id !== me.user.id && m.status === 'active').map((m) => <option key={m.id} value={m.id}>{m.name} ({m.email})</option>)}
              </select>
            </Field>
          )}
        </div>
        <ErrorBox error={create.error} />
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function KeyCreated({ keyValue, url, onClose }: { keyValue: string; url: string; onClose: () => void }) {
  return (
    <Modal title="Your new API key" desc="Copy it now. This is the only time it's shown: Urumi stores only a keyed hash." size="wide" onClose={onClose} footer={<Button variant="primary" onClick={onClose}>I've saved it</Button>}>
      <div className="stack">
        <div className="secret-box">
          <span className="value">{keyValue}</span>
          <CopyButton text={keyValue} label="Copy key" variant="primary" />
        </div>
        <div className="card">
          <div className="card-head"><div className="titles"><h2>Connect a client</h2><p>Snippets with this key already filled in.</p></div></div>
          <ConnectTabs url={url} apiKey={keyValue} />
        </div>
      </div>
    </Modal>
  );
}
