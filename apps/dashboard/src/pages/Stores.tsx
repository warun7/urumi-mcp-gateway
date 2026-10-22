import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, errorText } from '../api';
import { Button, Callout, Card, Code, Empty, ErrorBox, Field, LinkButton, Modal, PageHead, SkeletonRows, Status, Time, useConfirm, useParamFlag, useToast } from '../components/ui';
import { Icons } from '../icons';
import type { StoreCondition, StoreInfo, StorePhase, StoresResponse } from '../types';

const STEPS: { type: StoreCondition['type']; label: string }[] = [
  { type: 'Namespace', label: 'Namespace' },
  { type: 'Access', label: 'Access for the provisioner' },
  { type: 'Guardrails', label: 'Resource quota and limits' },
  { type: 'Secrets', label: 'Passwords and API keys' },
  { type: 'Release', label: 'Install WordPress and WooCommerce' },
  { type: 'Workloads', label: 'Store and database running' },
  { type: 'Registered', label: 'MCP server connected to the gateway' },
];

const PHASE: Record<StorePhase, { tone?: 'ok' | 'warn' | 'err' | 'info'; label: string; pulse?: boolean }> = {
  Pending: { tone: 'info', label: 'Queued', pulse: true },
  Provisioning: { tone: 'warn', label: 'Provisioning', pulse: true },
  Ready: { tone: 'ok', label: 'Ready' },
  Failed: { tone: 'err', label: 'Failed' },
  Deleting: { label: 'Deleting', pulse: true },
};
const NAME_RE = /^[a-z][a-z0-9-]{1,18}[a-z0-9]$/;
const busy = (s: StoreInfo) => s.phase === 'Pending' || s.phase === 'Provisioning' || s.phase === 'Deleting';

export function StoresPage() {
  const [creating, setCreating] = useParamFlag('new');
  const q = useQuery({
    queryKey: ['stores'],
    queryFn: () => api<StoresResponse>('/stores'),
    // Poll fast while something is changing, slowly otherwise.
    refetchInterval: (query) => (query.state.data?.stores.some(busy) ? 3_000 : 20_000),
  });
  const d = q.data;
  const atLimit = !!d && (d.limits.mine >= d.limits.perUser || d.limits.total >= d.limits.maxTotal);
  const used = d ? Math.min(4, Math.round((d.limits.mine / Math.max(1, d.limits.perUser)) * 4)) : 0;

  return (
    <div className="page">
      <PageHead
        title="Stores"
        desc={<>Spin up a separate WooCommerce store for a client or a test. Each gets its own namespace, database and MCP server, and about a minute later its tools appear for the whole team as <code>name__list_orders</code> and friends.</>}
        actions={
          <>
            {d && (
              <span className="meter" title={`The platform runs ${d.limits.total} of ${d.limits.maxTotal} stores`}>
                <span className="meter-bar"><span className={`w${used * 25}`} /></span>
                {d.limits.mine} of {d.limits.perUser} stores used
              </span>
            )}
            <Button variant="primary" icon={<Icons.plus />} disabled={!d || atLimit} title={atLimit ? 'You have reached the store limit. Delete one first.' : undefined} onClick={() => setCreating(true)}>
              New store
            </Button>
          </>
        }
      />
      {q.isPending ? (
        <Card pad={false}><SkeletonRows rows={3} /></Card>
      ) : q.error ? (
        <ErrorBox error={q.error} />
      ) : d!.stores.length === 0 ? (
        <Card pad={false}>
          <Empty icon={<Icons.store />} title="No extra stores yet" action={<Button variant="primary" size="sm" icon={<Icons.plus />} disabled={atLimit} onClick={() => setCreating(true)}>New store</Button>}>
            Create one and watch it come up step by step. The default store is always there as the <code>woo</code> server.
          </Empty>
        </Card>
      ) : (
        <div className="store-grid">
          {d!.stores.map((s) => (
            <StoreCard key={s.name} s={s} />
          ))}
        </div>
      )}
      {creating && d && <CreateStore domain={d.domain} onClose={() => setCreating(false)} />}
    </div>
  );
}

function StoreCard({ s }: { s: StoreInfo }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const p = PHASE[s.phase];
  const refresh = () => qc.invalidateQueries({ queryKey: ['stores'] });
  const del = useMutation({
    mutationFn: () => api(`/stores/${s.name}`, { method: 'DELETE' }),
    onSuccess: () => toast(`Deleting ${s.displayName}: its tools disappear now, the namespace within a minute`),
    onError: (e) => toast(errorText(e), true),
    onSettled: refresh,
  });
  const retry = useMutation({
    mutationFn: () => api(`/stores/${s.name}/retry`, { method: 'POST' }),
    onSuccess: () => toast(`Retrying ${s.displayName}`),
    onError: (e) => toast(errorText(e), true),
    onSettled: refresh,
  });
  const askDelete = async () => {
    if (await confirm({ title: `Delete ${s.displayName}?`, body: 'Its database, uploads and orders are deleted for good, and its tools disappear for everyone.', confirmLabel: 'Delete store', danger: true })) del.mutate();
  };

  return (
    <Card
      title={<span className="row-sm">{s.displayName} <Status tone={p.tone} pulse={p.pulse}>{p.label}</Status></span>}
      subtitle={<><span className="mono">{s.name}</span> · {s.ownerEmail ?? 'unknown owner'} · created <Time iso={s.createdAt} /></>}
      actions={
        s.canManage && !s.deleting && (
          <Button size="sm" variant="ghost" className="danger" icon={<Icons.trash />} loading={del.isPending} onClick={() => void askDelete()} aria-label={`Delete ${s.displayName}`} title="Delete store" />
        )
      }
    >
      <div className="stack">
        {s.phase === 'Ready' && (
          <>
            <div className="store-links">
              {s.url && <a className="btn sm" href={s.url} target="_blank" rel="noreferrer"><Icons.external /> Open store</a>}
              {s.adminUrl && <a className="btn sm" href={s.adminUrl} target="_blank" rel="noreferrer"><Icons.external /> WP admin</a>}
              <LinkButton to="/chat" size="sm" icon={<Icons.chat />}>Ask the chat</LinkButton>
            </div>
            <dl className="props compact">
              <dt>Tools</dt>
              <dd><span className="mono">{s.name}__list_orders</span>, <span className="mono">{s.name}__sales_summary</span>, …{conditionOf(s, 'Registered')?.message && <span className="muted"> ({conditionOf(s, 'Registered')!.message})</span>}</dd>
              <dt>Ready in</dt>
              <dd>{duration(s.startedAt, s.readyAt)}{s.attempts > 1 ? ` (attempt ${s.attempts})` : ''}</dd>
              <dt>Namespace</dt>
              <dd className="mono">{s.namespace}</dd>
            </dl>
            {s.canManage && (
              <div className="stack-sm">
                <p className="xs muted">WordPress admin password (user <span className="mono">admin</span>), from the cluster:</p>
                <Code>{`kubectl -n ${s.namespace} get secret wordpress -o jsonpath='{.data.admin-password}' | base64 -d`}</Code>
              </div>
            )}
            <p className="xs muted">Try “Compare today’s orders across woo and {s.name}” in the chat.</p>
          </>
        )}
        {(s.phase === 'Provisioning' || s.phase === 'Pending') && <Steps s={s} />}
        {s.phase === 'Failed' && (
          <>
            <Callout tone="err" title={s.reason ?? 'Failed'} action={s.canManage && <Button size="sm" icon={<Icons.refresh />} loading={retry.isPending} onClick={() => retry.mutate()}>Retry</Button>}>
              {s.message}
              {s.canManage && <div className="mt-1 muted">Retry keeps its passwords and data, and reinstalls what failed.</div>}
            </Callout>
            <Steps s={s} />
          </>
        )}
        {s.phase === 'Deleting' && <p className="small muted">Removing the MCP server, the namespace, its volumes and the Helm release…</p>}
      </div>
    </Card>
  );
}

/** The provisioner's conditions as a checklist, with the step in progress spinning. */
function Steps({ s }: { s: StoreInfo }) {
  const elapsed = useElapsed(s.phase === 'Provisioning' ? s.startedAt : null);
  const firstOpen = STEPS.findIndex((st) => conditionOf(s, st.type)?.status !== 'True');
  return (
    <div>
      <ol className="steps">
        {STEPS.map((st, i) => {
          const c = conditionOf(s, st.type);
          const done = c?.status === 'True';
          const current = !done && i === firstOpen;
          const failed = current && s.phase === 'Failed';
          return (
            <li key={st.type} className={done ? 'done' : failed ? 'fail' : current ? 'current' : 'todo'}>
              <span className="ic" aria-hidden="true">{done ? <Icons.check /> : failed ? <Icons.x /> : current && s.phase !== 'Failed' ? <span className="spinner" /> : null}</span>
              <span>
                {st.label}
                {(current || failed) && c?.message && <div className="msg">{c.message}</div>}
              </span>
            </li>
          );
        })}
      </ol>
      {elapsed && <p className="xs muted mt-3">{elapsed} so far · usually under a minute (longer on a fresh node that has to pull images)</p>}
    </div>
  );
}

function CreateStore({ domain, onClose }: { domain: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const create = useMutation({
    mutationFn: () => api<{ store: StoreInfo }>('/stores', { method: 'POST', body: { name, displayName } }),
    onSuccess: (r) => {
      toast(`${r.store.displayName} is being created`);
      onClose();
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['stores'] }),
  });
  const nameOk = NAME_RE.test(name);
  return (
    <Modal
      title="New store"
      desc="It comes up in about a minute; you can watch each step."
      onClose={onClose}
      footer={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!nameOk || !displayName.trim()} loading={create.isPending} onClick={() => create.mutate()}>Create store</Button>
      </>}
    >
      <form className="form" onSubmit={(e) => { e.preventDefault(); if (nameOk && displayName.trim()) create.mutate(); }}>
        <Field label="Store name" hint="Shown to customers and in the dashboard.">
          <input className="input" autoFocus value={displayName} maxLength={60} placeholder="Kaveri Coffee" onChange={(e) => {
            const v = e.target.value;
            setDisplayName(v);
            if (!name || name === slugify(displayName)) setName(slugify(v));
          }} />
        </Field>
        <Field label="Short name" error={name && !nameOk ? '3 to 20 characters: lowercase letters, digits and hyphens, starting with a letter' : undefined}
          hint={nameOk ? <>Store at <span className="mono">{name}.{domain}</span>, tools as <span className="mono">{name}__list_orders</span></> : 'Used in the web address and in tool names. It cannot be changed later.'}>
          <input className="input mono" value={name} maxLength={20} placeholder="kaveri" onChange={(e) => setName(e.target.value.toLowerCase())} />
        </Field>
        <ErrorBox error={create.error} />
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

// ------------------------------------------------------------------ helpers

const conditionOf = (s: StoreInfo, type: StoreCondition['type']) => s.conditions.find((c) => c.type === type);

function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^[^a-z]+/, '').replace(/-+$/, '').slice(0, 20).replace(/-+$/, '');
}

function duration(from: string | null, to: string | null): string {
  if (!from || !to) return '—';
  const s = Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function useElapsed(since: string | null): string | null {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!since) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [since]);
  return since ? duration(since, new Date().toISOString()) : null;
}
