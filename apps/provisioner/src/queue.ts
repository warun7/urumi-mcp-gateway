/**
 * A controller work queue, the same contract as client-go's:
 * - a key is queued at most once, however many events arrive for it;
 * - a key is never processed by two workers at once (an event during processing marks it dirty and it runs again after);
 * - up to `concurrency` different keys run in parallel;
 * - the worker can ask to be called again later (`requeueAfter`), and failures back off exponentially per key.
 */
export type Worker = (key: string) => Promise<{ requeueAfterMs?: number } | void>;

export class WorkQueue {
  private readonly queue: string[] = [];
  private readonly queued = new Set<string>();
  private readonly processing = new Set<string>();
  private readonly dirty = new Set<string>();
  private readonly timers = new Map<string, { at: number; t: NodeJS.Timeout }>();
  private readonly failures = new Map<string, number>();
  private stopped = false;
  private idle: (() => void)[] = [];

  constructor(
    private readonly worker: Worker,
    private readonly concurrency: number,
    private readonly onError: (key: string, err: unknown) => void = () => {},
    private readonly backoff = { baseMs: 1_000, maxMs: 60_000 },
  ) {}

  add(key: string) {
    if (this.stopped) return;
    if (this.processing.has(key)) {
      this.dirty.add(key);
      return;
    }
    if (this.queued.has(key)) return;
    this.queued.add(key);
    this.queue.push(key);
    this.pump();
  }

  /** Schedule `key`; an earlier pending schedule wins over a later one. */
  addAfter(key: string, ms: number) {
    if (this.stopped) return;
    const at = Date.now() + ms;
    const existing = this.timers.get(key);
    if (existing && existing.at <= at) return;
    if (existing) clearTimeout(existing.t);
    const t = setTimeout(() => {
      this.timers.delete(key);
      this.add(key);
    }, ms);
    t.unref?.();
    this.timers.set(key, { at, t });
  }

  get size() {
    return this.queue.length + this.processing.size;
  }

  private pump() {
    while (this.processing.size < this.concurrency && this.queue.length > 0) {
      const key = this.queue.shift()!;
      this.queued.delete(key);
      this.processing.add(key);
      void this.run(key);
    }
    if (this.size === 0) for (const r of this.idle.splice(0)) r();
  }

  private async run(key: string) {
    let next: number | undefined;
    try {
      const r = await this.worker(key);
      this.failures.delete(key);
      next = r?.requeueAfterMs;
    } catch (err) {
      const n = (this.failures.get(key) ?? 0) + 1;
      this.failures.set(key, n);
      next = Math.min(this.backoff.baseMs * 2 ** (n - 1), this.backoff.maxMs);
      this.onError(key, err);
    } finally {
      this.processing.delete(key);
    }
    if (this.dirty.delete(key)) this.add(key);
    else if (next !== undefined) this.addAfter(key, next);
    this.pump();
  }

  /** Resolves when nothing is queued or running (tests). */
  drained(): Promise<void> {
    return this.size === 0 ? Promise.resolve() : new Promise((r) => this.idle.push(r));
  }

  stop() {
    this.stopped = true;
    for (const { t } of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}
