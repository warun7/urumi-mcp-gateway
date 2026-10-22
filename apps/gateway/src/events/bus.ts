import { EventEmitter } from 'node:events';
import type { Sql } from '../db/index.js';
import type { Logger } from '../log.js';

/**
 * Cross-replica events over Postgres LISTEN/NOTIFY.
 * Every replica keeps in-memory state (catalog, auth cache, listen streams); NOTIFY tells
 * all of them, including the sender, to refresh. Postgres is already a dependency, so no Redis.
 */
export type BusEvent =
  | { type: 'catalog' } //                    upstreams/tools/permissions changed -> reload catalog, emit list_changed
  | { type: 'auth'; userId?: string } //      key/token/user revoked or disabled -> drop auth cache
  | { type: 'audit'; id: number }; //         new audit row -> live tail

const CHANNEL = 'urumi_events';

export class EventBus extends EventEmitter<{ event: [BusEvent] }> {
  constructor(private readonly sql: Sql, private readonly log: Logger) {
    super();
    this.setMaxListeners(1000);
  }

  async start(): Promise<void> {
    await this.sql.listen(
      CHANNEL,
      (payload) => {
        try {
          this.emit('event', JSON.parse(payload) as BusEvent);
        } catch (err) {
          this.log.warn({ err, payload }, 'bad bus payload');
        }
      },
      // postgres.js re-LISTENs after a reconnect; anything may have changed while we were away.
      () => this.emit('event', { type: 'catalog' }),
    );
  }

  /** State changes (everything but audit rows) also bump the epoch that request-time freshness checks compare against. */
  async publish(e: BusEvent): Promise<void> {
    if (e.type !== 'audit') await this.sql`SELECT nextval('state_epoch')`;
    await this.sql.notify(CHANNEL, JSON.stringify(e));
  }

  /** The latest state epoch: a sequence read, no table access. */
  async epoch(): Promise<bigint> {
    const [r] = await this.sql<{ last_value: string; is_called: boolean }[]>`SELECT last_value, is_called FROM state_epoch`;
    return r?.is_called ? BigInt(r.last_value) : 0n;
  }
}
