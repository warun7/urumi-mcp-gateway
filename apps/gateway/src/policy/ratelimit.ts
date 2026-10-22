/**
 * Per-user tool-call budget: a token bucket of `perMinute` calls, refilled continuously, so a burst of up to
 * `perMinute` is fine and a sustained flood is not. Keyed by user, so a user's keys, OAuth grants and chat share
 * one budget (minting more keys doesn't buy more calls). In memory per replica, so the cluster-wide ceiling is
 * perMinute × replicas: it guards the shared upstream credentials' quotas against one noisy member, not billing.
 */
export class CallBudget {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly perMinute: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** 0 if the call may go ahead (and spends a token); otherwise the milliseconds until one is available. */
  take(key: string): number {
    if (this.perMinute <= 0) return 0; // disabled
    const t = this.now();
    const perMs = this.perMinute / 60_000;
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= 50_000) this.buckets.clear(); // bounded memory; clearing only ever grants budget
      b = { tokens: this.perMinute, at: t };
      this.buckets.set(key, b);
    }
    b.tokens = Math.min(this.perMinute, b.tokens + (t - b.at) * perMs);
    b.at = t;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return 0;
    }
    return Math.ceil((1 - b.tokens) / perMs);
  }
}
