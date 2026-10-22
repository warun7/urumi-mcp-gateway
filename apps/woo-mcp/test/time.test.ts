import { describe, expect, it } from 'vitest';
import { localDate, periodRange } from '../src/woo/time.js';

const IST = { timezone: 'Asia/Kolkata', gmtOffsetHours: 5.5 };
// 20:00 UTC on Oct 9 is already 01:30 on Oct 10 in India. A naive UTC "today" would be wrong.
const now = new Date('2026-10-09T20:00:00Z');

describe('localDate', () => {
  it("uses the store's timezone, not UTC", () => {
    expect(localDate(IST, now)).toBe('2026-10-10');
  });
  it('falls back to a raw gmt offset when there is no IANA timezone', () => {
    expect(localDate({ timezone: '', gmtOffsetHours: 5.5 }, now)).toBe('2026-10-10');
    expect(localDate({ timezone: '', gmtOffsetHours: -5 }, now)).toBe('2026-10-09');
  });
});

describe('periodRange', () => {
  it('today', () => {
    expect(periodRange('today', IST, now)).toEqual({
      period: 'today', from: '2026-10-10', to: '2026-10-11',
      after: '2026-10-09T23:59:59', before: '2026-10-11T00:00:00',
    });
  });
  it('yesterday', () => {
    const r = periodRange('yesterday', IST, now);
    expect([r.from, r.to, r.after, r.before]).toEqual(['2026-10-09', '2026-10-10', '2026-10-08T23:59:59', '2026-10-10T00:00:00']);
  });
  it('last_7_days includes today', () => {
    const r = periodRange('last_7_days', IST, now);
    expect([r.from, r.to]).toEqual(['2026-10-04', '2026-10-11']);
  });
  it('this_month starts on the 1st and crosses month boundaries correctly', () => {
    expect(periodRange('this_month', IST, now).from).toBe('2026-10-01');
    // 19:00 UTC on Oct 31 is 00:30 on Nov 1 in India.
    const r = periodRange('today', IST, new Date('2026-10-31T19:00:00Z'));
    expect([r.from, r.to]).toEqual(['2026-11-01', '2026-11-02']);
  });
});
