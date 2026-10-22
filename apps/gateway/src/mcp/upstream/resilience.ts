/**
 * Per-upstream failure isolation: a slow or dead upstream must never take the gateway
 * (or calls to OTHER upstreams) down with it.
 */

/** Circuit breaker: after N consecutive failures, fail fast for `openMs`, then let one probe through. */
export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private probing = false;

  constructor(private readonly threshold = 5, private readonly openMs = 15_000) {}

  get state(): 'closed' | 'open' | 'half-open' {
    if (this.openedAt === 0) return 'closed';
    return Date.now() - this.openedAt >= this.openMs ? 'half-open' : 'open';
  }

  /** Returns false if the call must be rejected without trying. */
  allow(): boolean {
    const s = this.state;
    if (s === 'closed') return true;
    if (s === 'half-open' && !this.probing) {
      this.probing = true;
      return true;
    }
    return false;
  }

  success(): void {
    this.failures = 0;
    this.openedAt = 0;
    this.probing = false;
  }

  failure(): void {
    this.probing = false;
    this.failures++;
    if (this.failures >= this.threshold || this.openedAt !== 0) this.openedAt = Date.now();
  }

  reset(): void {
    this.success();
  }
}

export class BulkheadFullError extends Error {}

/** Bulkhead: at most `limit` concurrent calls per upstream; others queue for up to `queueMs`. */
export class Bulkhead {
  private active = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(public limit: number, private readonly queueMs = 2_000) {}

  get inFlight(): number {
    return this.active;
  }

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve, reject) => {
        const onReady = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          resolve();
        };
        const remove = () => {
          const i = this.waiters.indexOf(onReady);
          if (i >= 0) this.waiters.splice(i, 1);
        };
        const timer = setTimeout(() => {
          remove();
          reject(new BulkheadFullError(`more than ${this.limit} calls in flight; queued ${this.queueMs} ms`));
        }, this.queueMs);
        const onAbort = () => {
          clearTimeout(timer);
          remove();
          reject(signal!.reason);
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        this.waiters.push(onReady);
      });
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }
}
