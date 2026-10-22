import { useState } from 'react';
import { api, errorText } from '../api';
import { useUser } from '../auth';
import { Avatar, Badge, Button, Card, Field, PageHead, Segmented, useToast } from '../components/ui';
import { Icons } from '../icons';
import { useTheme } from '../theme';

export function AccountPage() {
  const { me } = useUser();
  const toast = useToast();
  const [theme, setTheme] = useTheme();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/me/password', { body: { current, next } });
      setCurrent('');
      setNext('');
      toast('Password changed. Your other sessions were signed out.');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page narrow">
      <PageHead title="Account" desc="Your profile, password and display preferences." />
      <div className="stack">
        <Card>
          <div className="person">
            <Avatar name={me.user.name} size="lg" />
            <div>
              <div className="row-sm"><span className="cell-title">{me.user.name}</span>{me.user.role === 'admin' ? <Badge tone="accent">Admin</Badge> : <Badge>Member</Badge>}</div>
              <div className="cell-sub">{me.user.email}</div>
            </div>
          </div>
        </Card>

        <Card title="Appearance" subtitle="Saved in this browser.">
          <Segmented
            value={theme}
            onChange={setTheme}
            options={[
              { value: 'system', label: <><Icons.monitor /> System</> },
              { value: 'light', label: <><Icons.sun /> Light</> },
              { value: 'dark', label: <><Icons.moon /> Dark</> },
            ]}
          />
        </Card>

        <Card title="Change password" subtitle="Changing it signs out your other sessions. API keys and connected apps keep working.">
          <form className="form" onSubmit={submit}>
            <Field label="Current password">
              <input className="input" type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
            </Field>
            <Field label="New password" hint="At least 12 characters." error={error}>
              <input className="input" type="password" autoComplete="new-password" minLength={12} required value={next} onChange={(e) => setNext(e.target.value)} />
            </Field>
            <div><Button type="submit" variant="primary" loading={busy}>Change password</Button></div>
          </form>
        </Card>
      </div>
    </div>
  );
}
