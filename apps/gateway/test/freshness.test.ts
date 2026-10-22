import { describe, expect, it } from 'vitest';
import type { EventBus } from '../src/events/bus.js';
import { Freshness } from '../src/events/freshness.js';
import type { Logger } from '../src/log.js';

const log = { warn: () => undefined } as unknown as Logger;
const fakeBus = (epoch: { v: bigint; fail?: boolean }) =>
  ({ epoch: async () => { if (epoch.fail) throw new Error('db down'); return epoch.v; } }) as unknown as EventBus;

describe('Freshness', () => {
  it('catches up once when another replica moved the epoch, then serves from memory', async () => {
    const e = { v: 5n };
    let catchUps = 0;
    const f = new Freshness(fakeBus(e), log, async () => { catchUps++; });
    await f.prime();
    await f.ensure();
    expect(catchUps).toBe(0);
    e.v = 6n; // a change committed elsewhere
    await f.ensure();
    await f.ensure();
    expect(catchUps).toBe(1);
  });

  it('concurrent requests share one catch-up', async () => {
    const e = { v: 1n };
    let catchUps = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const f = new Freshness(fakeBus(e), log, async () => { catchUps++; await gate; });
    await f.prime();
    e.v = 2n;
    const waiting = Promise.all([f.ensure(), f.ensure(), f.ensure()]);
    release();
    await waiting;
    expect(catchUps).toBe(1);
  });

  it('a request never returns before its catch-up finished', async () => {
    const e = { v: 1n };
    let loaded = false;
    const f = new Freshness(fakeBus(e), log, async () => { await new Promise((r) => setTimeout(r, 10)); loaded = true; });
    await f.prime();
    e.v = 2n;
    await f.ensure();
    expect(loaded).toBe(true);
  });

  it('stays available when the database is unreachable', async () => {
    const e = { v: 1n, fail: false };
    const f = new Freshness(fakeBus(e), log, async () => { throw new Error('should not run'); });
    await f.prime();
    e.fail = true;
    await expect(f.ensure()).resolves.toBeUndefined();
  });
});
