import { describe, expect, it } from 'vitest';
import type { Store } from '@urumi/kube';
import { diagnose, IMAGE_GRACE_MS } from '../src/diagnose.js';
import { lastError } from '../src/helm.js';
import { WorkQueue } from '../src/queue.js';
import { alnum, deepMerge, StatusDraft, storeSecrets, STS_IMMUTABLE } from '../src/reconcile.js';

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

describe('work queue', () => {
  it('never runs one key twice at once, and re-runs it if an event arrived meanwhile', async () => {
    const running = new Set<string>();
    let overlap = false;
    const runs: string[] = [];
    let q!: WorkQueue;
    q = new WorkQueue(async (k) => {
      if (running.has(k)) overlap = true;
      running.add(k);
      runs.push(k);
      if (runs.length === 1) q.add('a'); // event for the same key while it is being processed
      await tick();
      running.delete(k);
    }, 3);
    q.add('a');
    q.add('a'); // deduplicated while queued
    await tick(1);
    await q.drained();
    await tick(20);
    expect(overlap).toBe(false);
    expect(runs).toEqual(['a', 'a']);
  });

  it('runs different keys in parallel up to the concurrency limit', async () => {
    let active = 0;
    let peak = 0;
    const q = new WorkQueue(async () => {
      peak = Math.max(peak, ++active);
      await tick(10);
      active--;
    }, 3);
    for (const k of ['a', 'b', 'c', 'd', 'e']) q.add(k);
    await tick(1);
    await q.drained();
    expect(peak).toBe(3);
  });

  it('honours requeueAfter and backs off on errors', async () => {
    const calls: number[] = [];
    const t0 = Date.now();
    const q = new WorkQueue(
      async () => {
        calls.push(Date.now() - t0);
        if (calls.length === 1) return { requeueAfterMs: 30 };
        if (calls.length === 2) throw new Error('boom');
      },
      1,
      () => {},
      { baseMs: 20, maxMs: 1000 },
    );
    q.add('s');
    await tick(150);
    q.stop();
    expect(calls.length).toBe(3);
    expect(calls[1]!).toBeGreaterThanOrEqual(25);
    expect(calls[2]! - calls[1]!).toBeGreaterThanOrEqual(15);
  });
});

describe('diagnose', () => {
  const now = Date.parse('2026-10-10T12:00:00Z');
  const pod = (name: string, ageMs: number, waiting?: { reason: string; message?: string }, restartCount = 0) => ({
    metadata: { name, creationTimestamp: new Date(now - ageMs).toISOString() },
    status: { containerStatuses: [{ name: 'c', restartCount, state: waiting ? { waiting } : {} }] },
  });

  it('is quiet while things are just starting', () => {
    expect(diagnose({ pods: [pod('wordpress-1', 10_000, { reason: 'ContainerCreating' })], jobs: [], events: [], now })).toBeNull();
    expect(diagnose({ pods: [pod('wordpress-1', 30_000, { reason: 'ImagePullBackOff' })], jobs: [], events: [], now })).toBeNull();
  });

  it('fails fast on an image that cannot be pulled after the grace period', () => {
    const d = diagnose({ pods: [pod('wordpress-1', IMAGE_GRACE_MS + 1, { reason: 'ImagePullBackOff', message: 'not found' })], jobs: [], events: [], now });
    expect(d).toMatchObject({ reason: 'ImagePullFailed' });
    expect(d!.message).toMatch(/wordpress-1\/c.*not found/);
  });

  it('reports a failed setup job and points at its newest pod for logs', () => {
    const d = diagnose({
      pods: [pod('store-setup-old', 60_000), pod('store-setup-new', 1_000)],
      jobs: [{ metadata: { name: 'store-setup' }, status: { conditions: [{ type: 'Failed', status: 'True', reason: 'BackoffLimitExceeded' }] } }],
      events: [],
      now,
    });
    expect(d).toMatchObject({ reason: 'SetupJobFailed', logsFrom: { pod: 'store-setup-new', container: 'setup' } });
  });

  it('reports quota rejections and crash loops', () => {
    expect(diagnose({ pods: [], jobs: [], events: [{ reason: 'FailedCreate', message: 'pods "x" is forbidden: exceeded quota: store-quota' }], now })).toMatchObject({ reason: 'QuotaExceeded' });
    expect(diagnose({ pods: [pod('woo-mcp-1', 5_000, { reason: 'CrashLoopBackOff' }, 6)], jobs: [], events: [], now })).toMatchObject({ reason: 'CrashLoop' });
  });
});

describe('status draft', () => {
  const store = (status?: Store['status']): Store => ({ metadata: { name: 'acme' }, spec: { displayName: 'Acme', ownerId: 'u1' }, status });

  it('only reports a change when something changed, and keeps transition times', () => {
    const first = new StatusDraft(store());
    first.cond('Namespace', true, 'Ready', 'store-acme');
    expect(first.changed()).toBe(true);
    const saved = first.next;
    const again = new StatusDraft(store(saved));
    again.cond('Namespace', true, 'Ready', 'store-acme');
    expect(again.changed()).toBe(false);
    again.cond('Release', false, 'Installing');
    expect(again.next.conditions!.map((c) => c.type)).toEqual(['Namespace', 'Release']);
    expect(again.firstPending().type).toBe('Access');
  });

  it('sends cleared fields as null so a merge patch removes them', () => {
    const d = new StatusDraft(store({ phase: 'Failed', reason: 'Timeout', message: 'x' }));
    d.set({ phase: 'Provisioning', reason: undefined, message: undefined });
    expect(d.patchBody().status).toMatchObject({ phase: 'Provisioning', reason: null, message: null, readyAt: null });
  });
});

describe('helpers', () => {
  it('generates secrets in the formats the store chart expects', () => {
    const s = Object.fromEntries(storeSecrets().map((x) => [x.name, x.data]));
    expect(Object.keys(s)).toEqual(['mariadb', 'wordpress', 'woo-api', 'woo-mcp-auth']);
    expect(s['woo-api']!['consumer-key']).toMatch(/^ck_[0-9a-f]{40}$/);
    expect(s['woo-api']!['consumer-secret']).toMatch(/^cs_[0-9a-f]{40}$/);
    expect(s.wordpress!['auth-key']).toMatch(/^[A-Za-z0-9]{64}$/);
    expect(alnum(48)).toMatch(/^[A-Za-z0-9]{48}$/);
    expect(alnum(16)).not.toBe(alnum(16));
  });

  it('merges chart values with generated ones taking precedence', () => {
    expect(deepMerge({ images: { wordpress: { tag: 'dev' } }, store: { timezone: 'UTC', name: 'x' } }, { store: { name: 'acme' } })).toEqual({
      images: { wordpress: { tag: 'dev' } },
      store: { timezone: 'UTC', name: 'acme' },
    });
  });

  it('pulls the useful line out of Helm output', () => {
    expect(lastError('Release "x" does not exist. Installing it now.\nError: failed post-install: 1 error occurred:\n\t* job store-setup failed: BackoffLimitExceeded')).toMatch(/^Error: failed post-install/);
    expect(lastError('')).toBe('helm failed with no output');
  });
});

describe('StatefulSet immutable-field failures', () => {
  it('recognises Helm\'s error and extracts the StatefulSet name', () => {
    const msg = 'Error: UPGRADE FAILED: server-side apply failed for object store-acme/mariadb apps/v1, Kind=StatefulSet: StatefulSet.apps "mariadb" is invalid: spec: Forbidden: updates to statefulset spec for fields other than \'replicas\', \'ordinals\', \'template\', \'updateStrategy\' are forbidden';
    expect(STS_IMMUTABLE.exec(msg)?.[1]).toBe('mariadb');
    expect(STS_IMMUTABLE.test('Error: UPGRADE FAILED: context deadline exceeded')).toBe(false);
  });
});
