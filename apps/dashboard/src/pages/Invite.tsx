import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { api, errorText } from '../api';
import { Badge, Button, ErrorBox, Field, Loading } from '../components/ui';
import { Logo } from '../icons';

export function InvitePage() {
  const { token = '' } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const invite = useQuery({ queryKey: ['invite', token], queryFn: () => api<{ invite: { email: string; role: string } }>(`/invites/${token}`), retry: false });
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirm) return setError('The passwords don’t match.');
    setBusy(true);
    setError('');
    try {
      await api(`/invites/${token}/accept`, { body: { name, password } });
      await qc.invalidateQueries({ queryKey: ['me'] });
      nav('/keys?welcome=1', { replace: true });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-box">
        <div className="auth-brand">
          <Logo className="logo lg" />
          <div>
            <h1>Join your team on Urumi</h1>
            <p>Create your account to use the team's MCP tools</p>
          </div>
        </div>
        {invite.isPending && <Loading label="Checking your invitation…" />}
        <ErrorBox error={invite.error} />
        {invite.data && (
          <form className="card auth-card form" onSubmit={submit}>
            <div className="row-sm small">
              <span className="muted">Invited as</span>
              <strong>{invite.data.invite.email}</strong>
              {invite.data.invite.role === 'admin' ? <Badge tone="accent">Admin</Badge> : <Badge>Member</Badge>}
            </div>
            <Field label="Your name">
              <input className="input" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            </Field>
            <Field label="Password" hint="At least 12 characters.">
              <input className="input" type="password" autoComplete="new-password" minLength={12} required value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <Field label="Confirm password" error={error}>
              <input className="input" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </Field>
            <Button type="submit" variant="primary" size="lg" className="block" loading={busy}>Create account</Button>
          </form>
        )}
      </div>
    </div>
  );
}
