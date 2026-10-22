import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Logger } from './log.js';

export interface Revision {
  revision: number;
  updated: string;
  status: 'deployed' | 'failed' | 'pending-install' | 'pending-upgrade' | 'pending-rollback' | 'superseded' | 'uninstalling' | 'uninstalled' | 'unknown';
  chart: string;
  description: string;
}
export interface RunResult {
  ok: boolean;
  /** The most useful line of output (Helm's "Error: …"), else the tail. */
  message: string;
  hash: string;
  finishedAt: number;
}

const WORK_DIR = '/tmp/urumi-provisioner';
const OUTPUT_TAIL = 4_000;

/**
 * The Helm CLI, with installs run as **background child processes**: `helm upgrade --install` blocks on the
 * store's post-install setup Job (minutes), and a reconcile must never block a worker that long.
 * Only "is a run in flight right now" lives in memory. The truth is Helm's release history, so after a
 * provisioner restart a release left `pending-install` is detected and recovered (see reconcile.ts).
 */
export class Helm {
  private readonly running = new Map<string, { child: ChildProcess; startedAt: number; hash: string }>();
  private readonly results = new Map<string, RunResult>();

  constructor(
    private readonly bin: string,
    private readonly log: Logger,
    private readonly onFinished: (key: string) => void,
  ) {
    mkdirSync(WORK_DIR, { recursive: true, mode: 0o700 });
  }

  private env() {
    return {
      ...process.env,
      HOME: WORK_DIR,
      HELM_CACHE_HOME: `${WORK_DIR}/cache`,
      HELM_CONFIG_HOME: `${WORK_DIR}/config`,
      HELM_DATA_HOME: `${WORK_DIR}/data`,
    };
  }

  private exec(args: string[], timeoutMs = 60_000): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.bin, args, { env: this.env(), stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
  }

  /** The latest revision of a release, or null if it doesn't exist. */
  async latest(namespace: string, release: string): Promise<Revision | null> {
    const r = await this.exec(['history', release, '-n', namespace, '--max', '1', '-o', 'json']);
    if (r.code !== 0) {
      if (/not found/i.test(r.stderr)) return null;
      throw new Error(`helm history: ${lastError(r.stderr)}`);
    }
    const revs = JSON.parse(r.stdout) as Revision[];
    return revs.at(-1) ?? null;
  }

  /** Whether any revision of the release was ever deployed (so a stuck upgrade can be rolled back). */
  async hasDeployedRevision(namespace: string, release: string): Promise<boolean> {
    const r = await this.exec(['history', release, '-n', namespace, '-o', 'json']);
    if (r.code !== 0) return false;
    return (JSON.parse(r.stdout) as Revision[]).some((x) => x.status === 'deployed' || x.status === 'superseded');
  }

  async rollback(namespace: string, release: string): Promise<void> {
    const r = await this.exec(['rollback', release, '-n', namespace, '--timeout', '5m'], 6 * 60_000);
    if (r.code !== 0) throw new Error(`helm rollback: ${lastError(r.stderr)}`);
  }

  async uninstall(namespace: string, release: string): Promise<void> {
    const r = await this.exec(['uninstall', release, '-n', namespace, '--ignore-not-found'], 5 * 60_000);
    if (r.code !== 0) throw new Error(`helm uninstall: ${lastError(r.stderr)}`);
  }

  isRunning(key: string) {
    return this.running.has(key);
  }
  runningFor(key: string): number | undefined {
    const r = this.running.get(key);
    return r ? Date.now() - r.startedAt : undefined;
  }
  /** The outcome of the last background run for `key`, consumed once. */
  takeResult(key: string): RunResult | undefined {
    const r = this.results.get(key);
    this.results.delete(key);
    return r;
  }

  /** Start `helm upgrade --install` in the background; `onFinished(key)` fires when it exits. */
  startInstall(key: string, o: { namespace: string; release: string; chart: string; values: unknown; timeout: string; hash: string }) {
    if (this.running.has(key)) return;
    this.results.delete(key);
    const valuesFile = `${WORK_DIR}/${o.release}.values.json`;
    writeFileSync(valuesFile, JSON.stringify(o.values, null, 2), { mode: 0o600 });
    const args = ['upgrade', '--install', o.release, o.chart, '-n', o.namespace, '-f', valuesFile, '--timeout', o.timeout, '--history-max', '5'];
    this.log.info({ store: key, release: o.release }, 'helm upgrade --install started');
    const child = spawn(this.bin, args, { env: this.env(), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const collect = (d: Buffer) => {
      out = (out + d.toString()).slice(-OUTPUT_TAIL);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    this.running.set(key, { child, startedAt: Date.now(), hash: o.hash });
    const done = (ok: boolean, message: string) => {
      if (!this.running.has(key)) return;
      this.running.delete(key);
      this.results.set(key, { ok, message, hash: o.hash, finishedAt: Date.now() });
      this.log[ok ? 'info' : 'warn']({ store: key, ok, message: ok ? undefined : message }, 'helm upgrade --install finished');
      this.onFinished(key);
    };
    child.on('error', (err) => done(false, err.message));
    child.on('close', (code, signal) => done(code === 0, code === 0 ? 'deployed' : signal ? `helm was stopped (${signal})` : lastError(out)));
  }

  /** Stop a background run (store deleted, or failed fast on a diagnosed problem). */
  kill(key: string) {
    const r = this.running.get(key);
    if (!r) return;
    this.running.delete(key);
    r.child.kill('SIGTERM');
    this.log.info({ store: key }, 'helm run stopped');
  }

  killAll() {
    for (const k of [...this.running.keys()]) this.kill(k);
  }
}

/** Helm prints "Error: <reason>" last; that line is what a person needs to see. */
export function lastError(output: string): string {
  const lines = output.trim().split('\n').filter(Boolean);
  const err = [...lines].reverse().find((l) => l.startsWith('Error:'));
  return (err ?? lines.slice(-3).join(' ')).slice(0, 500) || 'helm failed with no output';
}
