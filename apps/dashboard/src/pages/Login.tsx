import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { api, errorText } from '../api';
import { Button, Callout, Field } from '../components/ui';
import { Logo } from '../icons';

/** Only same-site relative paths are allowed as ?next= targets (no open redirect). */
export const safeNext = (n: string | null) => (n && n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/\\') ? n : '/');

export function LoginPage() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const next = safeNext(params.get('next'));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/auth/login', { body: { email, password } });
      await qc.invalidateQueries({ queryKey: ['me'] });
      nav(next, { replace: true });
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
            <h1>Sign in to Urumi</h1>
            <p>Your team's MCP gateway</p>
          </div>
        </div>
        {next.startsWith('/consent') && <Callout tone="info">Sign in to connect an app to your team's MCP gateway.</Callout>}
        <form className="card auth-card form" onSubmit={submit}>
          <Field label="Email">
            <input className="input" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          </Field>
          <Field label="Password" error={error}>
            <input className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Button type="submit" variant="primary" size="lg" className="block" loading={busy}>Sign in</Button>
        </form>
        <p className="auth-foot">New here? Ask an admin for an invite link.</p>
      </div>
    </div>
  );
}
