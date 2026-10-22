import type { Logger } from '../log.js';
import type { EventBus } from './bus.js';

/**
 * Read-your-writes across gateway replicas.
 * NOTIFY reaches the other replicas within milliseconds, but a client whose next request lands on a different
 * replica can still beat it. The two-replica e2e run caught exactly that: a disabled server's tools were still
 * listed, and the next chat turn saw the old catalog. So every state-changing publish bumps the `state_epoch`
 * sequence, and each /mcp request reads it (one sequence read, no table) and catches up first if this replica is
 * behind: catalog, permissions, and the auth cache. Anything committed before an admin's API call returned is
 * therefore visible to every request that starts after it, on any replica.
 */
export class Freshness {
  private applied = 0n;
  private inflight?: { epoch: bigint; done: Promise<void> };

  constructor(
    private readonly bus: EventBus,
    private readonly log: Logger,
    private readonly catchUp: () => Promise<void>,
  ) {}

  /** Call before the initial state load: everything up to this epoch is about to be loaded. */
  async prime(): Promise<void> {
    this.applied = await this.bus.epoch();
  }

  async ensure(): Promise<void> {
    let now: bigint;
    try {
      now = await this.bus.epoch();
    } catch (err) {
      // Database unreachable: serve from memory (possibly stale) rather than fail every request.
      this.log.warn({ err: (err as Error).message }, 'freshness check skipped');
      return;
    }
    if (now <= this.applied) return;
    // One catch-up at a time per target epoch; concurrent requests wait for the same one.
    if (!this.inflight || this.inflight.epoch < now) {
      const run = {
        epoch: now,
        done: this.catchUp().then(() => {
          if (now > this.applied) this.applied = now;
        }),
      };
      this.inflight = run;
      void run.done.finally(() => {
        if (this.inflight === run) this.inflight = undefined;
      }).catch(() => undefined);
    }
    await this.inflight.done;
  }
}
