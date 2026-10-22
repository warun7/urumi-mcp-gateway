import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { api, errorText } from '../api';
import { Avatar, Badge, Button, Callout, ErrorBox, Field, Loading, Segmented } from '../components/ui';
import { Icons } from '../icons';
import type { ToolMode } from '../types';
import { MODE_HINT } from './Keys';

interface ConsentInfo {
  client: { id: string; name: string; uri: string | null; host: string | null; logo: string | null; kind: 'cimd' | 'dcr'; verified: boolean };
  redirectHost: string | null;
  scopes: string[];
  resource: string;
  user: { email: string; role: string };
}

const SCOPE_TEXT: Record<string, string> = {
  'mcp:tools': 'Use the MCP tools you are allowed to use, as you. Every call is checked against your permissions and recorded in the audit log.',
};

/**
 * The OAuth consent screen. The gateway's /oauth/authorize has already validated the client, redirect
 * URI, PKCE and resource; this page only asks the signed-in human to approve or deny.
 */
export function ConsentPage() {
  const [params] = useSearchParams();
  const id = params.get('request') ?? '';
  const info = useQuery({ queryKey: ['consent', id], queryFn: () => api<ConsentInfo>(`/oauth/requests/${id}`), retry: false, enabled: !!id });
  const [mode, setMode] = useState<ToolMode>('auto');
  const [busy, setBusy] = useState<'approve' | 'deny' | null>(null);
  const [error, setError] = useState('');

  const decide = async (approve: boolean) => {
    setBusy(approve ? 'approve' : 'deny');
    setError('');
    try {
      const r = await api<{ redirect: string }>(`/oauth/requests/${id}/decision`, { body: { approve, toolMode: mode } });
      window.location.assign(r.redirect);
    } catch (err) {
      setError(errorText(err));
      setBusy(null);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-box wide">
        {!id && <Callout tone="err" title="Missing authorization request">Start connecting again from your app.</Callout>}
        {info.isPending && id && <Loading />}
        <ErrorBox error={info.error} />
        {info.data && (
          <div className="card">
            <div className="card-body stack">
              <div className="consent-app">
                <Avatar name={info.data.client.name} size="lg" />
                <div className="truncate">
                  <h1 className="truncate">{info.data.client.name}</h1>
                  <div className="row-sm mt-1">
                    {info.data.client.verified ? <Badge tone="ok" icon={<Icons.check />}>Verified · {info.data.client.host}</Badge> : <Badge tone="warn">Unverified app</Badge>}
                  </div>
                </div>
              </div>
              <p>wants to access your team's <strong>Urumi MCP gateway</strong> as <strong>{info.data.user.email}</strong>.</p>
              {!info.data.client.verified && (
                <Callout tone="warn">
                  This app identified itself only by the name it registered, so Urumi can't confirm who made it. Continue only if you just started connecting it yourself.
                  {info.data.redirectHost ? ` It will send you back to ${info.data.redirectHost}.` : ''}
                </Callout>
              )}
              <div>
                <h3 className="small strong">It will be able to</h3>
                <ul className="scope-list mt-2">
                  {info.data.scopes.map((s) => <li key={s}><Icons.checkCircle />{SCOPE_TEXT[s] ?? s}</li>)}
                </ul>
              </div>
              <Field label="How should tools be presented to this app?" hint={MODE_HINT[mode]}>
                <Segmented value={mode} onChange={setMode} options={[{ value: 'auto', label: 'Automatic' }, { value: 'full', label: 'All tools' }, { value: 'search', label: 'Search' }]} />
              </Field>
              <ErrorBox error={error || null} />
            </div>
            <div className="modal-foot">
              <Button onClick={() => decide(false)} loading={busy === 'deny'} disabled={!!busy}>Deny</Button>
              <Button variant="primary" onClick={() => decide(true)} loading={busy === 'approve'} disabled={!!busy}>Allow access</Button>
            </div>
          </div>
        )}
        <p className="auth-foot">You can disconnect this app any time under Connected apps.</p>
      </div>
    </div>
  );
}
