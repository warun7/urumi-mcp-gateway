import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, errorText } from '../api';
import { useUser } from '../auth';
import { Avatar, Badge, Button, Callout, Card, CopyField, ErrorBox, Field, Menu, Modal, PageHead, Segmented, SkeletonRows, Status, Time, useConfirm, useParamFlag, useToast } from '../components/ui';
import { Icons } from '../icons';
import type { Invite, Member, Role } from '../types';

const ROLE_HINT: Record<Role, string> = {
  member: 'Uses read tools (plus anything a permission rule allows) and the chat.',
  admin: 'Manages servers, members and permissions, and can use every tool.',
};

export function MembersPage() {
  const { me } = useUser();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [inviting, setInviting] = useParamFlag('new');
  const members = useQuery({ queryKey: ['members'], queryFn: () => api<{ members: Member[] }>('/members') });
  const invites = useQuery({ queryKey: ['invites'], queryFn: () => api<{ invites: Invite[] }>('/invites') });

  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<Pick<Member, 'role' | 'status'>> }) => api(`/members/${id}`, { method: 'PATCH', body }),
    onSuccess: (_d, v) =>
      toast(v.body.status === 'disabled' ? 'Member disabled: their sessions, keys and app connections stopped working' : v.body.status === 'active' ? 'Member re-enabled' : `Role changed to ${v.body.role}`),
    onError: (e) => toast(errorText(e), true),
    onSettled: () => qc.invalidateQueries({ queryKey: ['members'] }),
  });
  const revokeInvite = useMutation({
    mutationFn: (id: string) => api(`/invites/${id}`, { method: 'DELETE' }),
    onSuccess: () => toast('Invitation revoked: the link no longer works'),
    onError: (e) => toast(errorText(e), true),
    onSettled: () => qc.invalidateQueries({ queryKey: ['invites'] }),
  });

  const setRole = async (m: Member, role: Role) => {
    if (role === m.role) return;
    const ok = await confirm({
      title: role === 'admin' ? `Make ${m.name} an admin?` : `Make ${m.name} a member?`,
      body: role === 'admin' ? 'Admins manage servers, members and permissions, and can use every tool, including write tools.' : 'They keep read tools and anything a permission rule allows, and lose access to admin pages.',
      confirmLabel: role === 'admin' ? 'Make admin' : 'Make member',
    });
    if (ok) update.mutate({ id: m.id, body: { role } });
  };
  const setStatus = async (m: Member) => {
    if (m.status === 'active') {
      const ok = await confirm({ title: `Disable ${m.name}?`, body: 'Their sessions, API keys and connected apps stop working immediately. You can enable them again later.', confirmLabel: 'Disable member', danger: true });
      if (!ok) return;
    }
    update.mutate({ id: m.id, body: { status: m.status === 'active' ? 'disabled' : 'active' } });
  };

  const list = members.data?.members ?? [];
  const pendingInvites = (invites.data?.invites ?? []).filter((i) => i.status === 'pending');
  const pastInvites = (invites.data?.invites ?? []).filter((i) => i.status !== 'pending');

  return (
    <div className="page">
      <PageHead
        title="Members"
        desc="Everyone on the team. Admins manage servers and people and can use every tool; members get read tools by default, and you can grant more under Permissions."
        actions={<Button variant="primary" icon={<Icons.plus />} onClick={() => setInviting(true)}>Invite member</Button>}
      />
      <div className="stack-lg">
        <Card pad={false}>
          {members.isPending ? <SkeletonRows rows={3} /> : members.error ? <div className="card-body"><ErrorBox error={members.error} /></div> : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Name</th><th>Role</th><th>Status</th><th className="num">Keys</th><th>Last sign-in</th><th>Joined</th><th /></tr></thead>
                <tbody>
                  {list.map((m) => {
                    const self = m.id === me.user.id;
                    return (
                      <tr key={m.id} className={m.status !== 'active' ? 'dim' : undefined}>
                        <td>
                          <div className="person">
                            <Avatar name={m.name} />
                            <div className="truncate">
                              <div className="cell-title">{m.name}{self && <span className="muted"> (you)</span>}</div>
                              <div className="cell-sub truncate">{m.email}</div>
                            </div>
                          </div>
                        </td>
                        <td>{m.role === 'admin' ? <Badge tone="accent">Admin</Badge> : <Badge>Member</Badge>}</td>
                        <td>{m.status === 'active' ? <Status tone="ok">Active</Status> : <Status tone="err">Disabled</Status>}</td>
                        <td className="num">{m.keys}</td>
                        <td className="small muted">{m.last_login_at ? <Time iso={m.last_login_at} /> : 'Never'}</td>
                        <td className="small muted"><Time iso={m.created_at} /></td>
                        <td className="actions-cell">
                          {!self && (
                            <Menu
                              label={`Actions for ${m.name}`}
                              items={[
                                m.role === 'member'
                                  ? { label: 'Make admin', icon: <Icons.lock />, onSelect: () => void setRole(m, 'admin') }
                                  : { label: 'Make member', icon: <Icons.user />, onSelect: () => void setRole(m, 'member') },
                                { separator: true },
                                m.status === 'active'
                                  ? { label: 'Disable access', icon: <Icons.power />, danger: true, onSelect: () => void setStatus(m) }
                                  : { label: 'Enable access', icon: <Icons.power />, onSelect: () => void setStatus(m) },
                              ]}
                            />
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <section>
          <div className="section-head">
            <div>
              <h2 className="section-title">Invitations</h2>
              <p>Single-use links that expire after 72 hours. There's no email server, so you share the link yourself.</p>
            </div>
          </div>
          <Card pad={false}>
            {invites.isPending ? <SkeletonRows rows={2} /> : (invites.data?.invites.length ?? 0) === 0 ? (
              <div className="all-good"><Icons.mail className="faint" /> No invitations yet. <button type="button" className="link-btn" onClick={() => setInviting(true)}>Invite someone</button></div>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Email</th><th>Role</th><th>Status</th><th>Sent</th><th>Expires</th><th /></tr></thead>
                  <tbody>
                    {[...pendingInvites, ...pastInvites].map((i) => (
                      <tr key={i.id} className={i.status !== 'pending' ? 'dim' : undefined}>
                        <td className="cell-title">{i.email}</td>
                        <td>{i.role === 'admin' ? <Badge tone="accent">Admin</Badge> : <Badge>Member</Badge>}</td>
                        <td><Status tone={i.status === 'pending' ? 'warn' : i.status === 'accepted' ? 'ok' : undefined}>{i.status[0]!.toUpperCase() + i.status.slice(1)}</Status></td>
                        <td className="small muted"><Time iso={i.createdAt} /></td>
                        <td className="small muted">{i.status === 'pending' ? <Time iso={i.expiresAt} /> : '–'}</td>
                        <td className="actions-cell">{i.status === 'pending' && <Button size="sm" variant="ghost" className="danger" loading={revokeInvite.isPending && revokeInvite.variables === i.id} onClick={() => revokeInvite.mutate(i.id)}>Revoke</Button>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </section>
      </div>
      {inviting && <InviteModal onClose={() => setInviting(false)} />}
    </div>
  );
}

function InviteModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('member');
  const create = useMutation({
    mutationFn: () => api<{ link: string; expiresInHours: number }>('/invites', { body: { email, role } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['invites'] }),
  });
  return (
    <Modal
      title={create.data ? 'Invitation ready' : 'Invite a member'}
      desc={create.data ? undefined : 'You get a sign-up link to send them.'}
      onClose={onClose}
      footer={create.data ? <Button variant="primary" onClick={onClose}>Done</Button> : <><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={create.isPending} disabled={!email.includes('@')} onClick={() => create.mutate()}>Create invite link</Button></>}
    >
      {create.data ? (
        <div className="stack">
          <p className="small">Send this link to <strong>{email}</strong>. It works once and expires in {create.data.expiresInHours} hours.</p>
          <CopyField value={create.data.link} />
          <Callout tone="warn">Anyone with the link can create this account, so share it privately (Slack DM, email to them).</Callout>
        </div>
      ) : (
        <form className="form" onSubmit={(e) => { e.preventDefault(); if (email.includes('@')) create.mutate(); }}>
          <Field label="Email">
            <input className="input" type="email" required autoFocus value={email} placeholder="teammate@company.com" onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="Role" hint={ROLE_HINT[role]}>
            <Segmented value={role} onChange={setRole} options={[{ value: 'member', label: 'Member' }, { value: 'admin', label: 'Admin' }]} />
          </Field>
          <ErrorBox error={create.error} />
          <button type="submit" hidden />
        </form>
      )}
    </Modal>
  );
}
