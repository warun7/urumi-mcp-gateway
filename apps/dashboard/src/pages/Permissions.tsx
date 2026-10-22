import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, errorText } from '../api';
import { AccessBadge, Badge, Button, Card, Empty, ErrorBox, Field, Modal, PageHead, SearchInput, Segmented, SkeletonRows, Status, useConfirm, useParamFlag, useToast } from '../components/ui';
import { Icons } from '../icons';
import type { EffectiveTool, Member, Rule, Server } from '../types';

export function PermissionsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [adding, setAdding] = useParamFlag('new');
  const [who, setWho] = useState('');
  const [toolFilter, setToolFilter] = useState('');
  const [onlyBlocked, setOnlyBlocked] = useState<'all' | 'allowed' | 'blocked'>('all');
  const rules = useQuery({ queryKey: ['rules'], queryFn: () => api<{ rules: Rule[] }>('/permissions') });
  const members = useQuery({ queryKey: ['members'], queryFn: () => api<{ members: Member[] }>('/members') });
  const effective = useQuery({
    queryKey: ['effective', who],
    queryFn: () => api<{ tools: EffectiveTool[] }>(`/permissions/effective?userId=${who}`),
    enabled: !!who,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/permissions/${id}`, { method: 'DELETE' }),
    onSuccess: () => toast('Rule removed: connected clients get the updated tool list now'),
    onError: (e) => toast(errorText(e), true),
    onSettled: () => { qc.invalidateQueries({ queryKey: ['rules'] }); qc.invalidateQueries({ queryKey: ['effective'] }); },
  });
  const askRemove = async (r: Rule) => {
    if (await confirm({ title: 'Remove this rule?', body: <>{r.effect === 'allow' ? 'Allow' : 'Deny'} <code>{r.server}__{r.tool}</code> for {subjectText(r)}. Access falls back to the next matching rule or the default.</>, confirmLabel: 'Remove rule', danger: true })) remove.mutate(r.id);
  };

  const person = members.data?.members.find((m) => m.id === who);
  const eff = effective.data?.tools ?? [];
  const allowedCount = eff.filter((t) => t.allowed).length;
  const term = toolFilter.trim().toLowerCase();
  const effShown = eff
    .filter((t) => (onlyBlocked === 'allowed' ? t.allowed : onlyBlocked === 'blocked' ? !t.allowed : true))
    .filter((t) => !term || t.name.toLowerCase().includes(term));

  return (
    <div className="page">
      <PageHead
        title="Permissions"
        desc="Who can use which tools. Checked on every tool list and every call; tools a person can't use are invisible to them."
        actions={<Button variant="primary" icon={<Icons.plus />} onClick={() => setAdding(true)}>Add rule</Button>}
      />
      <div className="stack-lg">
        <section className="card" aria-label="How access is decided">
          <div className="decide">
            <div className="decide-step">
              <span className="n">1</span>
              <h3>A deny rule matches <Badge tone="err">Blocked</Badge></h3>
              <p>Deny always wins, so you can carve out exceptions from a broad allow.</p>
            </div>
            <div className="decide-step">
              <span className="n">2</span>
              <h3>An allow rule matches <Badge tone="ok">Allowed</Badge></h3>
              <p>Grant a person or a whole role a tool, a glob like <code>create_*</code>, or a whole server.</p>
            </div>
            <div className="decide-step">
              <span className="n">3</span>
              <h3>Otherwise, the default</h3>
              <p>Admins get every tool. Members get tools marked <strong>Read</strong>, which you set per tool on each server's page.</p>
            </div>
          </div>
        </section>

        <Card title="Rules" subtitle="Their order here doesn't matter: a matching deny always beats a matching allow." pad={false}>
          {rules.isPending ? <SkeletonRows rows={3} /> : rules.error ? <div className="card-body"><ErrorBox error={rules.error} /></div> : rules.data.rules.length === 0 ? (
            <Empty icon={<Icons.lock />} title="No rules: the defaults apply" action={<Button size="sm" icon={<Icons.plus />} onClick={() => setAdding(true)}>Add rule</Button>}>
              Members can use read tools and admins can use everything. Add a rule to grant a write tool to someone, or to block a tool.
            </Empty>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Effect</th><th>Applies to</th><th>Server</th><th>Tool</th><th /></tr></thead>
                <tbody>
                  {rules.data.rules.map((r) => (
                    <tr key={r.id}>
                      <td className="shrink">{r.effect === 'allow' ? <Badge tone="ok">Allow</Badge> : <Badge tone="err">Deny</Badge>}</td>
                      <td>{subjectText(r)}</td>
                      <td>{r.server === '*' ? <span className="muted">Any server</span> : <code>{r.server}</code>}</td>
                      <td>{r.tool === '*' ? <span className="muted">Any tool</span> : <code>{r.tool}</code>}</td>
                      <td className="actions-cell"><Button size="sm" variant="ghost" className="danger" onClick={() => void askRemove(r)}>Remove</Button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card
          title="Check someone's access"
          subtitle="Exactly which tools a person's MCP clients and chat can see, and the reason for each."
          pad={false}
          actions={
            <select className="input sm" value={who} onChange={(e) => setWho(e.target.value)} aria-label="Member">
              <option value="">Choose a member…</option>
              {members.data?.members.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.role})</option>)}
            </select>
          }
        >
          {!who ? (
            <Empty icon={<Icons.user />} title="Pick a member">See their effective tool list, after defaults and rules.</Empty>
          ) : effective.isPending ? <SkeletonRows rows={5} /> : effective.error ? <div className="card-body"><ErrorBox error={effective.error} /></div> : (
            <>
              <div className="toolbar">
                <SearchInput size="sm" value={toolFilter} onChange={setToolFilter} placeholder="Filter tools" />
                <Segmented size="sm" value={onlyBlocked} onChange={setOnlyBlocked} options={[{ value: 'all', label: 'All' }, { value: 'allowed', label: 'Allowed' }, { value: 'blocked', label: 'Blocked' }]} />
                <span className="count">{person?.name ?? 'They'} can use <strong className="strong">{allowedCount}</strong> of {eff.length} tools</span>
              </div>
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Tool</th><th>Access</th><th>Result</th><th>Why</th></tr></thead>
                  <tbody>
                    {effShown.map((t) => (
                      <tr key={t.name}>
                        <td className="mono">{t.name}</td>
                        <td><AccessBadge access={t.access} /></td>
                        <td>{t.allowed ? <Status tone="ok">Allowed</Status> : <Status tone="err">Blocked</Status>}</td>
                        <td className="small muted">{t.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {effShown.length === 0 && <div className="table-note">No tools match.</div>}
              </div>
            </>
          )}
        </Card>
      </div>
      {adding && <RuleModal members={members.data?.members ?? []} onClose={() => setAdding(false)} />}
    </div>
  );
}

function subjectText(r: Rule) {
  return r.subject_type === 'role' ? <>Everyone with role <strong>{r.subject}</strong></> : <>{r.subject_email ?? r.subject}</>;
}

function RuleModal({ members, onClose }: { members: Member[]; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const servers = useQuery({ queryKey: ['servers'], queryFn: () => api<{ servers: Server[] }>('/servers') });
  const [r, setR] = useState({ subjectType: 'role' as 'role' | 'user', subject: 'member', server: '*', tool: '*', effect: 'allow' as 'allow' | 'deny' });
  const create = useMutation({
    mutationFn: () => api('/permissions', { body: r }),
    onSuccess: () => { toast('Rule added: connected clients get the updated tool list now'); qc.invalidateQueries({ queryKey: ['rules'] }); qc.invalidateQueries({ queryKey: ['effective'] }); onClose(); },
  });
  const who = r.subjectType === 'role' ? (r.subject === 'member' ? 'all members' : 'all admins') : members.find((m) => m.id === r.subject)?.name ?? 'this person';
  const what = `${r.tool === '*' ? 'every tool' : r.tool} on ${r.server === '*' ? 'any server' : r.server}`;
  return (
    <Modal
      title="Add a permission rule"
      onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={create.isPending} onClick={() => create.mutate()}>Add rule</Button></>}
    >
      <form className="form" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
        <Field label="Effect">
          <Segmented value={r.effect} onChange={(effect) => setR({ ...r, effect })} options={[{ value: 'allow', label: 'Allow' }, { value: 'deny', label: 'Deny' }]} />
        </Field>
        <Field label="Applies to">
          <select className="input" value={r.subjectType === 'role' ? `role:${r.subject}` : `user:${r.subject}`} onChange={(e) => {
            const [t, s] = e.target.value.split(':') as ['role' | 'user', string];
            setR({ ...r, subjectType: t, subject: s });
          }}>
            <optgroup label="Roles">
              <option value="role:member">All members</option>
              <option value="role:admin">All admins</option>
            </optgroup>
            <optgroup label="People">
              {members.map((m) => <option key={m.id} value={`user:${m.id}`}>{m.name} ({m.email})</option>)}
            </optgroup>
          </select>
        </Field>
        <div className="form-row">
          <Field label="Server">
            <select className="input" value={r.server} onChange={(e) => setR({ ...r, server: e.target.value })}>
              <option value="*">Any server</option>
              {servers.data?.servers.map((s) => <option key={s.id} value={s.slug}>{s.displayName} ({s.slug})</option>)}
            </select>
          </Field>
          <Field label="Tool" hint={<>An exact name or a glob like <code>create_*</code>, without the server prefix.</>}>
            <input className="input mono" value={r.tool} onChange={(e) => setR({ ...r, tool: e.target.value })} />
          </Field>
        </div>
        <div className={`callout ${r.effect === 'allow' ? 'ok' : 'err'}`}>
          {r.effect === 'allow' ? <Icons.checkCircle /> : <Icons.alertCircle />}
          <div className="callout-body"><strong>{r.effect === 'allow' ? 'Allow' : 'Block'}</strong> {who} to use <span className="mono">{what}</span>.</div>
        </div>
        <ErrorBox error={create.error} />
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
