export const PERIODS = ['today', 'yesterday', 'last_7_days', 'this_month'] as const;
export type Period = (typeof PERIODS)[number];

export interface StoreClock {
  timezone: string; // IANA name, may be '' when the site uses a raw UTC offset
  gmtOffsetHours: number;
}

/** YYYY-MM-DD of "now" in the store's timezone. */
export function localDate(clock: StoreClock, now: Date = new Date()): string {
  if (clock.timezone) {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: clock.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(now);
  }
  return new Date(now.getTime() + clock.gmtOffsetHours * 3_600_000).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export interface LocalRange {
  period: Period;
  /** Inclusive first day, store-local. */
  from: string;
  /** Exclusive end day, store-local. */
  to: string;
  /** Values for WooCommerce's after/before params (store-local time, dates_are_gmt=false). */
  after: string;
  before: string;
}

/**
 * Resolve "today"-style periods server-side in the STORE's timezone.
 * LLMs are unreliable with dates and don't know the store's timezone.
 * WooCommerce's `after` is strictly-greater, so we use 23:59:59 of the previous day.
 */
export function periodRange(period: Period, clock: StoreClock, now: Date = new Date()): LocalRange {
  const today = localDate(clock, now);
  let from: string;
  let to: string;
  switch (period) {
    case 'today': from = today; to = addDays(today, 1); break;
    case 'yesterday': from = addDays(today, -1); to = today; break;
    case 'last_7_days': from = addDays(today, -6); to = addDays(today, 1); break;
    case 'this_month': from = `${today.slice(0, 8)}01`; to = addDays(today, 1); break;
  }
  return { period, from, to, after: `${addDays(from, -1)}T23:59:59`, before: `${to}T00:00:00` };
}
