import { createHash, randomBytes } from 'node:crypto';
import { isNotFound, KubeError, storesPath, type Kube, type KubeObject, type Store, type StoreCondition } from '@urumi/kube';
import type { Config } from './config.js';
import { diagnose, type Diagnosis, type EventLike, type JobLike, type PodLike } from './diagnose.js';
import type { GatewayClient } from './gateway.js';
import type { Helm } from './helm.js';
import type { Logger } from './log.js';

export const FINALIZER = 'urumi.io/store-cleanup';
const CONDITIONS = ['Namespace', 'Access', 'Guardrails', 'Secrets', 'Release', 'Workloads', 'Registered'] as const;
type CondType = (typeof CONDITIONS)[number];
const POLL_MS = 5_000;
/** How Helm describes a run that was stopped (signal), as opposed to one that failed on its own. */
const INTERRUPTED = /context canceled|signal: (terminated|killed|interrupt)/i;
/** Kubernetes refuses in-place changes to some StatefulSet fields (volumeClaimTemplates among them). */
export const STS_IMMUTABLE = /StatefulSet\.apps "([a-z0-9-]+)" is invalid: spec: Forbidden: updates to statefulset spec/;
const READY_RESYNC_MS = 60_000;

export interface Deps {
  kube: Kube;
  helm: Helm;
  gateway: GatewayClient;
  cfg: Config;
  log: Logger;
  chartVersion: string;
}
export type Result = { requeueAfterMs?: number } | void;
type Status = NonNullable<Store['status']>;

/**
 * Level-triggered and idempotent: every pass re-derives what to do from the cluster, Helm's release history
 * and the Store's status, applies at most one slow step, records progress in `status`, and asks to be called
 * again. Nothing that matters lives in memory, so the provisioner can be killed at any point.
 *
 *   Namespace → Access (RoleBinding) → Guardrails (quota, limits) → Secrets → Release (helm) → Workloads → Registered
 */
export class Reconciler {
  /** StatefulSet recreations already tried, per store and chart+values hash (so a persistent failure still surfaces). */
  private readonly recreated = new Set<string>();

  constructor(private readonly d: Deps) {}

  private path(name: string) {
    return storesPath(this.d.cfg.NAMESPACE, name);
  }

  async reconcile(name: string): Promise<Result> {
    let store: Store;
    try {
      store = await this.d.kube.get<Store>(this.path(name));
    } catch (e) {
      if (isNotFound(e)) {
        this.d.helm.kill(name);
        return;
      }
      throw e;
    }
    if (store.metadata.deletionTimestamp) return this.finalize(store);

    if (!store.metadata.finalizers?.includes(FINALIZER)) {
      store = await this.d.kube.mergePatch<Store>(this.path(name), {
        metadata: { finalizers: [...(store.metadata.finalizers ?? []), FINALIZER], resourceVersion: store.metadata.resourceVersion },
      });
    }

    const st = new StatusDraft(store);
    const nonce = store.spec.retryNonce ?? 0;
    if (!st.phase || nonce !== (st.next.observedRetryNonce ?? 0)) {
      if (st.phase) this.d.log.info({ store: name, attempt: (st.next.attempts ?? 0) + 1 }, 'retrying store');
      st.set({ phase: 'Provisioning', startedAt: now(), readyAt: undefined, reason: undefined, message: undefined, attempts: (st.next.attempts ?? 0) + 1, observedRetryNonce: nonce });
    }
    // Failed is terminal until someone retries (the dashboard bumps spec.retryNonce).
    if (st.phase === 'Failed') return;
    try {
      return await this.provision(store, st);
    } finally {
      await this.flush(name, st);
    }
  }

  private async provision(store: Store, st: StatusDraft): Promise<Result> {
    const { kube, cfg, helm, gateway, log } = this.d;
    const name = store.metadata.name;
    const ns = `store-${name}`;
    const release = `store-${name}`;
    const host = `${name}.${cfg.STORE_DOMAIN}`;
    const url = `${cfg.STORE_SCHEME}://${host}`;
    st.set({ namespace: ns, url, adminUrl: `${url}/wp-admin/` });

    if (st.phase === 'Provisioning' && Date.now() - Date.parse(st.next.startedAt!) > cfg.PROVISION_TIMEOUT_MS) {
      helm.kill(name);
      const why = await this.diagnoseNs(ns).catch(() => null);
      const stuck = st.firstPending();
      const mins = Math.round(cfg.PROVISION_TIMEOUT_MS / 60_000);
      return this.fail(st, name, why?.reason ?? 'Timeout', `Not ready after ${mins} minutes. ${why?.message ?? `Stuck at ${stuck.type}: ${stuck.message || stuck.reason}`}`);
    }

    // 1. Namespace. Never adopt one we didn't create (a name clash must not hand a tenant someone else's namespace).
    const existing = await getOrNull<KubeObject & { status?: { phase?: string } }>(kube, `/api/v1/namespaces/${ns}`);
    if (existing?.status?.phase === 'Terminating') {
      st.cond('Namespace', false, 'Terminating', 'Waiting for a previous store with this name to finish deleting');
      return { requeueAfterMs: POLL_MS };
    }
    if (existing && existing.metadata.labels?.['urumi.io/store'] !== name)
      return this.fail(st, name, 'NamespaceConflict', `Namespace ${ns} already exists and was not created for this store.`);
    await kube.apply(`/api/v1/namespaces/${ns}`, {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: {
        name: ns,
        labels: {
          'app.kubernetes.io/part-of': 'urumi',
          'urumi.io/store': name,
          'urumi.io/managed-by': 'provisioner',
          'urumi.io/mcp-upstreams': 'true',
          'pod-security.kubernetes.io/enforce': 'restricted',
          'pod-security.kubernetes.io/enforce-version': 'latest',
        },
      },
    });
    st.cond('Namespace', true, 'Ready', ns);

    // 2. Access: bind the store-manager ClusterRole to ourselves *inside this namespace only*.
    await kube.apply(`/apis/rbac.authorization.k8s.io/v1/namespaces/${ns}/rolebindings/urumi-provisioner`, {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'RoleBinding',
      metadata: { name: 'urumi-provisioner', namespace: ns, labels: { 'urumi.io/store': name } },
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: cfg.STORE_ROLE },
      subjects: [{ kind: 'ServiceAccount', name: cfg.SERVICE_ACCOUNT, namespace: cfg.NAMESPACE }],
    });
    st.cond('Access', true, 'Bound', `${cfg.STORE_ROLE} bound in ${ns}`);

    try {
      // 3. Guardrails, before any workload exists. The provisioner owns them, not the tenant chart's values.
      if (Object.keys(cfg.STORE_QUOTA).length)
        await kube.apply(`/api/v1/namespaces/${ns}/resourcequotas/store-quota`, {
          apiVersion: 'v1',
          kind: 'ResourceQuota',
          metadata: { name: 'store-quota', namespace: ns },
          spec: { hard: cfg.STORE_QUOTA },
        });
      if (Object.keys(cfg.STORE_LIMITS).length)
        await kube.apply(`/api/v1/namespaces/${ns}/limitranges/store-limits`, {
          apiVersion: 'v1',
          kind: 'LimitRange',
          metadata: { name: 'store-limits', namespace: ns },
          spec: { limits: [{ type: 'Container', ...cfg.STORE_LIMITS }] },
        });
      st.cond('Guardrails', true, 'Applied', Object.entries(cfg.STORE_QUOTA).map(([k, v]) => `${k}=${v}`).join(', ') || 'none configured');

      // 4. Secrets: created once, never regenerated, so retries and reinstalls keep matching the data on the PVCs.
      const have = await kube.list(`/api/v1/namespaces/${ns}/secrets`, { labelSelector: 'urumi.io/store-secret=true' });
      const present = new Set(have.items.map((s) => s.metadata.name));
      for (const s of storeSecrets()) {
        if (present.has(s.name)) continue;
        await kube.create(`/api/v1/namespaces/${ns}/secrets`, {
          apiVersion: 'v1',
          kind: 'Secret',
          metadata: { name: s.name, labels: { 'urumi.io/store': name, 'urumi.io/store-secret': 'true' } },
          type: 'Opaque',
          stringData: s.data,
        });
      }
      st.cond('Secrets', true, 'Present', 'mariadb, wordpress, woo-api, woo-mcp-auth');
    } catch (e) {
      // A RoleBinding takes a moment to reach the authorizer; the first calls in a new namespace can get 403.
      if (e instanceof KubeError && e.status === 403 && st.phase === 'Provisioning') {
        st.cond('Guardrails', false, 'WaitingForAccess', 'Waiting for the new RoleBinding to take effect');
        return { requeueAfterMs: 1_000 };
      }
      throw e;
    }

    // 5. Release
    const values = this.values(store, host);
    const hash = createHash('sha256').update(`${this.d.chartVersion}\n${JSON.stringify(values)}`).digest('hex').slice(0, 16);
    const install = () => helm.startInstall(name, { namespace: ns, release, chart: cfg.CHART_DIR, values, timeout: cfg.HELM_TIMEOUT, hash });
    const result = helm.takeResult(name);
    if (result && !result.ok) {
      if (await this.recreateStatefulSet(ns, name, hash, result.message)) {
        install();
        st.cond('Release', false, 'RecreatingStatefulSet', 'The upgrade changed a StatefulSet field Kubernetes treats as immutable: recreated the StatefulSet (its pod and volume are kept) and upgrading again');
        return { requeueAfterMs: POLL_MS };
      }
      return this.fail(st, name, 'HelmFailed', await this.explain(ns, result.message));
    }
    if (result?.ok) st.set({ releaseHash: result.hash });
    if (helm.isRunning(name)) {
      const why = await this.diagnoseNs(ns);
      if (why) {
        helm.kill(name);
        return this.fail(st, name, why.reason, why.message);
      }
      st.cond('Release', false, 'Installing', `helm upgrade --install running for ${Math.round((helm.runningFor(name) ?? 0) / 1000)}s (the setup job installs WordPress and WooCommerce)`);
      return { requeueAfterMs: POLL_MS };
    }
    const rel = await helm.latest(ns, release);
    if (!rel || rel.status !== 'deployed' || st.next.releaseHash !== hash) {
      if (rel?.status.startsWith('pending-')) {
        // No run of ours is in flight, so a previous provisioner died mid-operation. Recover, then go again.
        const rollback = await helm.hasDeployedRevision(ns, release);
        log.warn({ store: name, status: rel.status, action: rollback ? 'rollback' : 'uninstall' }, 'release stuck after a provisioner restart; recovering');
        if (rollback) await helm.rollback(ns, release);
        else await helm.uninstall(ns, release);
        st.cond('Release', false, 'Recovered', `Release was stuck ${rel.status} (provisioner restarted mid-install); ${rollback ? 'rolled back' : 'reinstalling'}`);
        return { requeueAfterMs: 1_000 };
      }
      if (rel?.status === 'uninstalling') return { requeueAfterMs: POLL_MS };
      if (rel?.status === 'failed') {
        // Helm 4 catches SIGTERM and records "context canceled": that's our own restart, not a store problem.
        const interrupted = INTERRUPTED.test(rel.description);
        // Failed during this attempt, for a real reason (and we lost the in-memory result to a restart): report it.
        if (Date.parse(rel.updated) >= Date.parse(st.next.startedAt!) && !interrupted) {
          if (!(await this.recreateStatefulSet(ns, name, hash, rel.description)))
            return this.fail(st, name, 'HelmFailed', await this.explain(ns, rel.description));
        } else if (await helm.hasDeployedRevision(ns, release)) {
          // An UPGRADE failed earlier: this store has been live. Upgrade again in place; uninstalling would take it down.
          log.info({ store: name, description: rel.description }, 'retrying a failed upgrade in place');
        } else {
          log.info({ store: name, description: rel.description }, interrupted ? 'release was interrupted by a provisioner restart; reinstalling' : 'removing a failed release from an earlier attempt');
          await helm.uninstall(ns, release); // never deployed: start clean (our Secrets and the PVCs stay, so data and passwords still match)
          if (interrupted) st.cond('Release', false, 'Recovered', 'Install was interrupted by a provisioner restart; reinstalling');
        }
      }
      install();
      st.cond('Release', false, 'Installing', rel?.status === 'deployed' ? 'Upgrading to the current chart and values' : 'helm upgrade --install started');
      return { requeueAfterMs: POLL_MS };
    }
    st.cond('Release', true, 'Deployed', `${release} revision ${rel.revision}`);

    // 6. Workloads
    const waiting = await this.notReady(ns);
    if (waiting.length) {
      const why = st.phase === 'Provisioning' ? await this.diagnoseNs(ns) : null;
      if (why) return this.fail(st, name, why.reason, why.message);
      st.cond('Workloads', false, 'Starting', `Waiting for ${waiting.join(', ')}`);
      return { requeueAfterMs: POLL_MS };
    }
    st.cond('Workloads', true, 'Available', 'wordpress, mariadb and woo-mcp are ready');

    // 7. Register with the gateway (idempotent upsert), then wait until it has connected and synced the tools.
    const token = await this.secretValue(ns, 'woo-mcp-auth', 'token');
    await gateway.register(name, {
      displayName: store.spec.displayName,
      description: `WooCommerce store at ${url}`,
      url: `http://woo-mcp.${ns}.svc.cluster.local:8080/mcp`,
      token,
      managedBy: `store/${name}`,
    });
    const g = await gateway.get(name);
    if (!g || g.server.status !== 'connected' || g.activeTools === 0) {
      const detail = g?.server.statusDetail ? `: ${g.server.statusDetail}` : '';
      st.cond('Registered', false, 'Connecting', `Gateway reports ${g?.server.status ?? 'not registered'}${detail}`);
      return { requeueAfterMs: 3_000 };
    }
    st.cond('Registered', true, 'Connected', `${g.activeTools} tools available as ${name}__*`);
    if (st.phase !== 'Ready') {
      st.set({ phase: 'Ready', readyAt: now() });
      log.info({ store: name, seconds: Math.round((Date.now() - Date.parse(st.next.startedAt!)) / 1000) }, 'store ready');
    }
    return { requeueAfterMs: READY_RESYNC_MS };
  }

  /** Delete flow: deregister → delete the namespace (release records, PVCs and PVs go with it) → drop the finalizer. */
  private async finalize(store: Store): Promise<Result> {
    const { kube, helm, gateway, log } = this.d;
    const name = store.metadata.name;
    const ns = `store-${name}`;
    if (!store.metadata.finalizers?.includes(FINALIZER)) return;
    const st = new StatusDraft(store);
    if (st.phase !== 'Deleting') {
      st.set({ phase: 'Deleting', reason: undefined, message: undefined });
      await this.flush(name, st);
      log.info({ store: name }, 'deleting store');
    }
    helm.kill(name);
    await gateway.deregister(name); // its tools disappear and connected clients get list_changed
    const nsObj = await getOrNull(kube, `/api/v1/namespaces/${ns}`);
    if (nsObj && nsObj.metadata.labels?.['urumi.io/store'] === name) {
      if (!nsObj.metadata.deletionTimestamp) await kube.delete(`/api/v1/namespaces/${ns}`);
      return { requeueAfterMs: 3_000 };
    }
    await kube.mergePatch(this.path(name), {
      metadata: { finalizers: store.metadata.finalizers.filter((f) => f !== FINALIZER), resourceVersion: store.metadata.resourceVersion },
    });
    log.info({ store: name }, 'store deleted');
  }

  private values(store: Store, host: string) {
    const { cfg } = this.d;
    return deepMerge(cfg.STORE_VALUES, {
      store: { name: store.metadata.name, title: store.spec.displayName, host, scheme: cfg.STORE_SCHEME, adminEmail: store.spec.ownerEmail || 'admin@example.com' },
      secrets: { existingSecrets: true },
      quota: { enabled: false }, // the provisioner applies the quota itself (step 3)
    });
  }

  private async notReady(ns: string): Promise<string[]> {
    type Workload = KubeObject & { status?: { availableReplicas?: number; readyReplicas?: number } };
    const [wp, mcp, db] = await Promise.all([
      getOrNull<Workload>(this.d.kube, `/apis/apps/v1/namespaces/${ns}/deployments/wordpress`),
      getOrNull<Workload>(this.d.kube, `/apis/apps/v1/namespaces/${ns}/deployments/woo-mcp`),
      getOrNull<Workload>(this.d.kube, `/apis/apps/v1/namespaces/${ns}/statefulsets/mariadb`),
    ]);
    const out: string[] = [];
    if (!((wp?.status?.availableReplicas ?? 0) >= 1)) out.push('wordpress');
    if (!((db?.status?.readyReplicas ?? 0) >= 1)) out.push('mariadb');
    if (!((mcp?.status?.availableReplicas ?? 0) >= 1)) out.push('woo-mcp');
    return out;
  }

  /**
   * Helm can't change a StatefulSet's immutable fields, e.g. its volumeClaimTemplates. The standard remedy: delete the
   * StatefulSet with propagationPolicy=Orphan (its pod keeps serving and its PVC stays), and let the next helm run
   * recreate it, which adopts both. The pre-upgrade hook has just taken a DB backup. Tried once per chart+values.
   */
  private async recreateStatefulSet(ns: string, store: string, hash: string, message: string): Promise<boolean> {
    const m = STS_IMMUTABLE.exec(message);
    const key = `${store}:${hash}`;
    if (!m || this.recreated.has(key)) return false;
    this.recreated.add(key);
    await this.d.kube.delete(`/apis/apps/v1/namespaces/${ns}/statefulsets/${m[1]}`, { propagationPolicy: 'Orphan' });
    this.d.log.warn({ store, statefulset: m[1] }, 'statefulset had an immutable change; recreated it (pod and volume kept)');
    return true;
  }

  private async diagnoseNs(ns: string): Promise<Diagnosis | null> {
    const { kube } = this.d;
    const [pods, jobs, events] = await Promise.all([
      kube.list<PodLike>(`/api/v1/namespaces/${ns}/pods`),
      kube.list<JobLike>(`/apis/batch/v1/namespaces/${ns}/jobs`),
      kube.list<EventLike>(`/api/v1/namespaces/${ns}/events`, { fieldSelector: 'reason=FailedCreate' }),
    ]);
    const d = diagnose({ pods: pods.items, jobs: jobs.items, events: events.items, now: Date.now() });
    if (d?.logsFrom) {
      const tail = await kube
        .text(`/api/v1/namespaces/${ns}/pods/${d.logsFrom.pod}/log`, { container: d.logsFrom.container, tailLines: 8 })
        .catch(() => '');
      if (tail.trim()) d.message += ` Last log lines: ${tail.trim().split('\n').slice(-4).join(' | ').slice(0, 600)}`;
    }
    return d;
  }

  /** A Helm error is often just "job failed"; add what the cluster says when we can. */
  private async explain(ns: string, helmMessage: string) {
    const why = await this.diagnoseNs(ns).catch(() => null);
    return why ? `${why.message} (helm: ${helmMessage})` : helmMessage;
  }

  private async secretValue(ns: string, name: string, key: string) {
    const s = await this.d.kube.get<KubeObject & { data?: Record<string, string> }>(`/api/v1/namespaces/${ns}/secrets/${name}`);
    const v = s.data?.[key];
    if (!v) throw new Error(`secret ${ns}/${name} has no ${key}`);
    return Buffer.from(v, 'base64').toString('utf8');
  }

  private fail(st: StatusDraft, name: string, reason: string, message: string): Result {
    st.set({ phase: 'Failed', reason, message });
    this.d.log.warn({ store: name, reason, message }, 'store failed');
  }

  private async flush(name: string, st: StatusDraft) {
    if (!st.changed()) return;
    try {
      await this.d.kube.mergePatch(`${this.path(name)}/status`, st.patchBody());
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
  }
}

/** The Store's status as we'd like it to be; patched once per pass, and only when it changed (no watch-event loops). */
export class StatusDraft {
  readonly next: Status;
  private readonly before: string;

  constructor(store: Store) {
    this.next = structuredClone(store.status ?? {});
    this.before = JSON.stringify(this.next);
  }
  get phase() {
    return this.next.phase;
  }
  set(p: Partial<Status>) {
    Object.assign(this.next, p);
  }
  cond(type: CondType, ok: boolean, reason: string, message = '') {
    const status = ok ? 'True' : 'False';
    const list = this.next.conditions ?? [];
    const prev = list.find((c) => c.type === type);
    const c: StoreCondition = { type, status, reason, message, lastTransitionTime: prev?.status === status ? prev.lastTransitionTime : now() };
    this.next.conditions = CONDITIONS.map((t) => (t === type ? c : list.find((x) => x.type === t))).filter((x): x is StoreCondition => !!x);
  }
  /** The first step that isn't done yet, for "stuck at …" messages. */
  firstPending(): StoreCondition {
    for (const t of CONDITIONS) {
      const c = this.next.conditions?.find((x) => x.type === t);
      if (c?.status !== 'True') return c ?? { type: t, status: 'Unknown', reason: 'NotStarted', message: 'not started', lastTransitionTime: now() };
    }
    return { type: 'Registered', status: 'True', reason: 'Done', lastTransitionTime: now() };
  }
  changed() {
    return JSON.stringify(this.next) !== this.before;
  }
  /** Merge-patch body; cleared fields are sent as null, which a merge patch needs to remove them. */
  patchBody() {
    const s: Record<string, unknown> = { ...this.next };
    for (const k of ['reason', 'message', 'readyAt'] as const) if (s[k] === undefined) s[k] = null;
    return { status: s };
  }
}

// ------------------------------------------------------------------ helpers

const now = () => new Date().toISOString();

async function getOrNull<T extends KubeObject = KubeObject>(kube: Kube, path: string): Promise<T | null> {
  try {
    return await kube.get<T>(path);
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
/** Unbiased random alphanumeric string (rejection sampling: 248 = 4 × 62). */
export function alnum(n: number): string {
  let s = '';
  while (s.length < n) for (const b of randomBytes(n * 2)) if (b < 248 && s.length < n) s += ALNUM[b % 62];
  return s;
}
const hex = (n: number) => randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n);
const SALTS = ['auth-key', 'secure-auth-key', 'logged-in-key', 'nonce-key', 'auth-salt', 'secure-auth-salt', 'logged-in-salt', 'nonce-salt'];

/** The same Secrets the store chart would generate, in the same formats (the chart runs with existingSecrets=true). */
export function storeSecrets(): { name: string; data: Record<string, string> }[] {
  return [
    { name: 'mariadb', data: { 'root-password': alnum(32), password: alnum(32) } },
    { name: 'wordpress', data: { 'admin-password': alnum(20), ...Object.fromEntries(SALTS.map((k) => [k, alnum(64)])) } },
    { name: 'woo-api', data: { 'consumer-key': `ck_${hex(40)}`, 'consumer-secret': `cs_${hex(40)}` } },
    { name: 'woo-mcp-auth', data: { token: alnum(48) } },
  ];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
export function deepMerge(base: Obj, over: Obj): Obj {
  const out: Obj = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k] as Obj, v) : v;
  return out;
}
