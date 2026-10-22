/**
 * Turns what the cluster shows about a store namespace into one specific, human-readable failure reason.
 * Pure (no I/O), so it's unit-tested. Called while waiting, to **fail fast** instead of sitting in
 * Provisioning until the timeout, and at the timeout, to say *why* it timed out.
 */
interface ContainerStatus {
  name: string;
  restartCount?: number;
  state?: { waiting?: { reason?: string; message?: string } };
}
export interface PodLike {
  metadata: { name: string; creationTimestamp?: string };
  status?: { containerStatuses?: ContainerStatus[]; initContainerStatuses?: ContainerStatus[] };
}
export interface JobLike {
  metadata: { name: string };
  status?: { conditions?: { type: string; status: string; reason?: string; message?: string }[] };
}
export interface EventLike {
  reason?: string;
  message?: string;
  involvedObject?: { kind?: string; name?: string };
  lastTimestamp?: string;
  eventTime?: string;
}
export interface Diagnosis {
  reason: string;
  message: string;
  /** For a failed Job: the pod whose log tail is worth attaching. */
  logsFrom?: { pod: string; container: string };
}

const IMAGE_ERRORS = new Set(['ImagePullBackOff', 'ErrImagePull', 'InvalidImageName', 'ErrImageNeverPull']);
export const IMAGE_GRACE_MS = 2 * 60_000;
const CONFIG_GRACE_MS = 60_000;
const CRASH_RESTARTS = 5;
const SETUP_JOB = 'store-setup';

export function diagnose(x: { pods: PodLike[]; jobs: JobLike[]; events: EventLike[]; now: number }): Diagnosis | null {
  const job = x.jobs.find((j) => j.metadata.name === SETUP_JOB);
  const failed = job?.status?.conditions?.find((c) => c.type === 'Failed' && c.status === 'True');
  if (failed) {
    const pod = x.pods.filter((p) => p.metadata.name.startsWith(`${SETUP_JOB}-`)).sort(byAge).at(-1);
    return {
      reason: 'SetupJobFailed',
      message: `The store setup job failed (${failed.reason ?? 'Failed'}${failed.message ? `: ${failed.message}` : ''}).`,
      logsFrom: pod ? { pod: pod.metadata.name, container: 'setup' } : undefined,
    };
  }

  const quota = x.events.find((e) => e.reason === 'FailedCreate' && /exceeded quota/i.test(e.message ?? ''));
  if (quota) return { reason: 'QuotaExceeded', message: `The store's resource quota blocked a pod: ${trim(quota.message)}` };

  for (const p of x.pods) {
    const age = x.now - Date.parse(p.metadata.creationTimestamp ?? new Date(x.now).toISOString());
    for (const c of [...(p.status?.initContainerStatuses ?? []), ...(p.status?.containerStatuses ?? [])]) {
      const w = c.state?.waiting;
      if (!w?.reason) continue;
      if (IMAGE_ERRORS.has(w.reason) && age > IMAGE_GRACE_MS)
        return { reason: 'ImagePullFailed', message: `${p.metadata.name}/${c.name} cannot pull its image: ${trim(w.message ?? w.reason)}` };
      if (w.reason === 'CreateContainerConfigError' && age > CONFIG_GRACE_MS)
        return { reason: 'ConfigError', message: `${p.metadata.name}/${c.name}: ${trim(w.message ?? w.reason)}` };
      if (w.reason === 'CrashLoopBackOff' && (c.restartCount ?? 0) >= CRASH_RESTARTS)
        return { reason: 'CrashLoop', message: `${p.metadata.name}/${c.name} keeps crashing (${c.restartCount} restarts)` };
    }
  }
  return null;
}

const byAge = (a: PodLike, b: PodLike) => Date.parse(a.metadata.creationTimestamp ?? '') - Date.parse(b.metadata.creationTimestamp ?? '');
const trim = (s?: string) => (s ?? '').replace(/\s+/g, ' ').slice(0, 300);
