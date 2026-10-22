import { describe, expect, it } from 'vitest';
import { CallBudget } from '../src/policy/ratelimit.js';

describe('CallBudget', () => {
  it('allows a burst up to the limit, then says how long to wait', () => {
    let now = 0;
    const b = new CallBudget(60, () => now); // one token per second
    for (let i = 0; i < 60; i++) expect(b.take('u1')).toBe(0);
    expect(b.take('u1')).toBe(1000);
    now += 1000;
    expect(b.take('u1')).toBe(0);
    expect(b.take('u1')).toBeGreaterThan(0);
  });

  it('keeps users separate', () => {
    const b = new CallBudget(1, () => 0);
    expect(b.take('u1')).toBe(0);
    expect(b.take('u1')).toBeGreaterThan(0);
    expect(b.take('u2')).toBe(0);
  });

  it('refills continuously but never above the limit', () => {
    let now = 0;
    const b = new CallBudget(120, () => now);
    for (let i = 0; i < 120; i++) b.take('u1');
    now += 60 * 60_000; // an idle hour
    for (let i = 0; i < 120; i++) expect(b.take('u1')).toBe(0);
    expect(b.take('u1')).toBeGreaterThan(0);
  });

  it('0 disables it', () => {
    const b = new CallBudget(0, () => 0);
    for (let i = 0; i < 1000; i++) expect(b.take('u1')).toBe(0);
  });
});
