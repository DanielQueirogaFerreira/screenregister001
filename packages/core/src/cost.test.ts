import { describe, expect, it } from 'vitest';
import {
  billingGb, CLOUDFLARE_RATES, DEFAULT_SCENARIO, daysUntil, priceMonth, projectToPeriodEnd,
  projectUsage, type Scenario,
} from './cost.js';

const s = (over: Partial<Scenario> = {}): Scenario => ({ ...DEFAULT_SCENARIO, ...over });

describe('projectUsage', () => {
  it('counts a full day of 1 FPS with nothing deduplicated', () => {
    // The headline question: everything different from everything else, recorded around
    // the clock. 86,400 seconds in a day, one frame each.
    const u = projectUsage(s({ fps: 1, hoursPerDay: 24, minStoreGapMs: 0 }));
    expect(u.framesPerDay).toBe(86_400);
  });

  it('scales with frame rate up to 30', () => {
    expect(projectUsage(s({ fps: 30 })).framesPerDay).toBe(86_400 * 30);
  });

  it('lets the minimum gap, not the frame rate, decide the bill', () => {
    // The governor that actually matters. At 1 FPS a three-second gap cuts storage to a
    // third; at 30 FPS it cuts it by ninety. Someone reading only the FPS number would
    // plan for the wrong figure by two orders of magnitude.
    expect(projectUsage(s({ fps: 1, minStoreGapMs: 3000 })).framesPerDay).toBe(28_800);
    expect(projectUsage(s({ fps: 30, minStoreGapMs: 3000 })).framesPerDay).toBe(28_800);
  });

  it('never lets the gap raise the rate above the sampling rate', () => {
    // A five-second gap cannot conjure frames out of a recorder sampling every ten.
    expect(projectUsage(s({ fps: 0.1, minStoreGapMs: 5000 })).framesPerDay)
      .toBeCloseTo(0.1 * 86_400, 6);
  });

  it('charges for the thumbnail, because R2 stores one', () => {
    const withThumb = projectUsage(s({ thumbRatio: 0.05 }));
    const without = projectUsage(s({ thumbRatio: 0 }));
    expect(withThumb.bytesPerFrame).toBeCloseTo(without.bytesPerFrame * 1.05, 6);
  });

  it('doubles the bytes when the untouched copy is kept', () => {
    const on = projectUsage(s({ keepOriginal: true }));
    const off = projectUsage(s({ keepOriginal: false }));
    expect(on.bytesPerFrame).toBeCloseTo(off.bytesPerFrame * 2, 6);
    expect(on.objectsPerFrame).toBe(3);
    expect(off.objectsPerFrame).toBe(2);
  });

  it('plateaus at the retention window rather than growing forever', () => {
    // Storage is not cumulative: the nightly sweep deletes past the ceiling, so the bill
    // is a week of frames however long the recorder has been running.
    const u = projectUsage(s({ retentionDays: 7 }));
    expect(u.steadyStateBytes).toBeCloseTo(u.bytesPerDay * 7, 6);
    expect(projectUsage(s({ retentionDays: 30 })).steadyStateBytes)
      .toBeCloseTo(u.bytesPerDay * 30, 6);
  });

  it('counts the delete as a row written, not just the insert', () => {
    // The half of D1's bill people forget. Every frame is written once when it arrives and
    // once more when retention removes it.
    const u = projectUsage(s({ fps: 1 }));
    expect(u.d1RowsWrittenPerMonth).toBe(86_400 * 30 * 2);
  });

  it('knows D1, not Workers, is what stops a full-time 1 FPS recording', () => {
    // Worth stating precisely, because the two caps are close enough to guess wrong: at
    // 1 FPS around the clock the recorder makes 86,400 uploads a day, which is UNDER the
    // 100,000 free daily request cap — but it writes 172,800 D1 rows, which is nearly
    // double D1's. The database is the binding constraint, and it is the one that now
    // fails queries outright rather than throttling.
    const u = projectUsage(s({ fps: 1, minStoreGapMs: 0 }));
    expect(u.framesPerDay).toBe(86_400);
    expect(u.exceedsFreeDailyRequests).toBe(false);
    expect(u.exceedsFreeDailyWrites).toBe(true);
    // It runs for well under a day before the write cap stops it dead.
    expect(u.d1FreeWriteHeadroom).toBeLessThan(1);
  });

  it('does trip the request cap once the frame rate rises', () => {
    expect(projectUsage(s({ fps: 2, minStoreGapMs: 0 })).exceedsFreeDailyRequests).toBe(true);
  });

  it('handles a recorder that is switched off', () => {
    const u = projectUsage(s({ hoursPerDay: 0 }));
    expect(u.framesPerDay).toBe(0);
    expect(u.steadyStateBytes).toBe(0);
    expect(u.d1FreeWriteHeadroom).toBe(Infinity);
  });
});

describe('priceMonth on the paid plan', () => {
  /** The measured average on this project: 100,549 bytes over 4,734 real frames. */
  const measured = s({ avgFrameBytes: 100_549 });

  it('prices a week of full-time 1 FPS against Cloudflare\'s published rates', () => {
    const u = projectUsage(measured);
    const bill = priceMonth(u, 'paid');
    // 86,400 frames a day at ~105.6 KB each with the thumbnail = ~9.12 GB/day, held for
    // seven days = ~63.9 GB.
    expect(u.steadyStateGb).toBeGreaterThan(60);
    expect(u.steadyStateGb).toBeLessThan(68);
    expect(bill.total).toBeGreaterThan(0);
    // Every line must be non-negative; a negative line means an allowance was subtracted
    // twice and the total silently understates.
    for (const i of bill.items) expect(i.cost, i.label).toBeGreaterThanOrEqual(0);
  });

  it('rounds storage up to a whole GB-month, as R2 does', () => {
    // R2's own example: 1.1 GB-month is billed as 2. Estimates that miss this undercount,
    // and they undercount most at the small scale where someone is deciding whether they
    // can afford to run at all.
    const u = projectUsage(s({ fps: 1, hoursPerDay: 1, retentionDays: 1 }));
    const storage = priceMonth(u, 'paid').items.find((i) => i.label === 'R2 storage')!;
    expect(Number.isInteger(storage.billable)).toBe(true);
  });

  it('rounds operations up to whole millions, as R2 does', () => {
    const item = priceMonth(projectUsage(measured), 'paid')
      .items.find((i) => i.label === 'R2 writes (Class A)')!;
    expect(item.billable % 1e6).toBe(0);
  });

  it('subtracts each allowance exactly once', () => {
    const bill = priceMonth(projectUsage(measured), 'paid');
    const storage = bill.items.find((i) => i.label === 'R2 storage')!;
    expect(storage.included).toBe(CLOUDFLARE_RATES.r2.freeStorageGbMonth);
    expect(storage.billable).toBeCloseTo(
      Math.ceil(storage.quantity - CLOUDFLARE_RATES.r2.freeStorageGbMonth), 6,
    );
  });

  it('charges nothing beyond the subscription for a scenario inside every allowance', () => {
    // A tiny recorder should cost exactly the $5 the plan starts at, not a stray fraction
    // of a cent from a line that forgot its included quantity.
    const bill = priceMonth(projectUsage(s({ fps: 1, hoursPerDay: 0.1, retentionDays: 1 })), 'paid');
    expect(bill.total).toBeCloseTo(CLOUDFLARE_RATES.workers.subscriptionPerMonth, 6);
  });

  it('grows the bill when the frame rate grows', () => {
    const cheap = priceMonth(projectUsage(s({ fps: 1 })), 'paid').total;
    const dear = priceMonth(projectUsage(s({ fps: 10 })), 'paid').total;
    expect(dear).toBeGreaterThan(cheap);
  });

  it('shows the minimum gap saving real money', () => {
    const ungoverned = priceMonth(projectUsage(s({ minStoreGapMs: 0 })), 'paid').total;
    const governed = priceMonth(projectUsage(s({ minStoreGapMs: 3000 })), 'paid').total;
    expect(governed).toBeLessThan(ungoverned);
  });
});

describe('priceMonth on the free plan', () => {
  it('says a scenario does not run rather than that it costs nothing', () => {
    // The free plan is not a cheaper paid plan. Past its caps D1 returns errors — since
    // 1 September 2026 it fails queries outright — so "$0.00" would be a lie about what
    // happens, not a discount.
    const bill = priceMonth(projectUsage(DEFAULT_SCENARIO), 'free');
    expect(bill.total).toBe(0);
    expect(bill.blocked.length).toBeGreaterThan(0);
    expect(bill.blocked.join(' ')).toMatch(/D1|cap/);
  });

  it('clears a scenario that genuinely fits', () => {
    const tiny = projectUsage({
      ...DEFAULT_SCENARIO, fps: 1, hoursPerDay: 0.2, retentionDays: 1, minStoreGapMs: 5000,
    });
    expect(priceMonth(tiny, 'free').blocked).toEqual([]);
  });
});

describe('the billed quantity', () => {
  it('is never negative zero, which renders as "-0" in a table', () => {
    // Found in a screenshot rather than a test: the epsilon that stops floating-point
    // noise rounding 12.0000000001 up to 13 also turned an exact zero into -0, and the
    // billing table printed it.
    const tiny = projectUsage(s({ fps: 1, hoursPerDay: 0.1, retentionDays: 1 }));
    for (const i of priceMonth(tiny, 'paid').items) {
      expect(Object.is(i.billable, -0), i.label).toBe(false);
      expect(i.billable, i.label).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('projectToPeriodEnd', () => {
  it('extrapolates in a straight line', () => {
    expect(projectToPeriodEnd(10, 10, 30)).toBeCloseTo(30, 6);
  });

  it('says zero rather than dividing by zero on the first day', () => {
    expect(projectToPeriodEnd(5, 0)).toBe(0);
  });
});

describe('billingGb', () => {
  it('is decimal, because an invoice GB is 10^9 bytes', () => {
    // A 2^30-based "GB" beside a billed GB-month puts two different units under one label
    // and makes the page disagree with itself by seven percent.
    expect(billingGb(1e9)).toBe(1);
    expect(billingGb(1_073_741_824)).toBeCloseTo(1.0737, 4);
  });
});

describe('daysUntil', () => {
  it('counts down to a ceiling', () => {
    expect(daysUntil(0, 10, 100)).toBe(10);
    expect(daysUntil(50, 10, 100)).toBe(5);
  });

  it('is zero once the ceiling is already passed', () => {
    expect(daysUntil(200, 10, 100)).toBe(0);
  });

  it('never reaches a ceiling when nothing is growing', () => {
    expect(daysUntil(0, 0, 100)).toBe(Infinity);
  });
});
