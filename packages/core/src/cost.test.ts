import { describe, expect, it } from 'vitest';
import {
  billingGb, CLOUDFLARE_RATES, concentration, DEFAULT_SCENARIO, daysUntil, growthForecast,
  priceMonth, projectToPeriodEnd, projectUsage, usageFromHistory, type Scenario,
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

describe('more than one recorder', () => {
  const one = projectUsage(s({ users: 1 }));

  it('scales every figure linearly with the number of people', () => {
    // The difference between one person and a team is the difference between a free tier
    // and a real bill, and multiplying four separate figures in your head is where
    // planning goes wrong.
    const forty = projectUsage(s({ users: 40 }));
    expect(forty.framesPerDay).toBeCloseTo(one.framesPerDay * 40, 6);
    expect(forty.steadyStateBytes).toBeCloseTo(one.steadyStateBytes * 40, 6);
    expect(forty.r2ClassAPerMonth).toBeCloseTo(one.r2ClassAPerMonth * 40, 6);
    expect(forty.d1RowsWrittenPerMonth).toBeCloseTo(one.d1RowsWrittenPerMonth * 40, 6);
    expect(forty.workerRequestsPerMonth).toBeCloseTo(one.workerRequestsPerMonth * 40, 6);
  });

  it('leaves the per-frame size alone, because that is per frame', () => {
    expect(projectUsage(s({ users: 40 })).bytesPerFrame).toBeCloseTo(one.bytesPerFrame, 6);
  });

  it('reports zero for nobody rather than dividing by it', () => {
    const none = projectUsage(s({ users: 0 }));
    expect(none.framesPerDay).toBe(0);
    expect(none.steadyStateBytes).toBe(0);
    expect(none.d1FreeWriteHeadroom).toBe(Infinity);
  });

  it('costs more with more people', () => {
    expect(priceMonth(projectUsage(s({ users: 25 })), 'paid').total)
      .toBeGreaterThan(priceMonth(one, 'paid').total);
  });

  it('measures the free-plan caps against the whole team, not one person', () => {
    // Two people at a 5-second gap each fit; together they do not. Checking one recorder
    // against a per-ACCOUNT cap is how a team plan looks affordable until it stops working.
    const gentle = s({ minStoreGapMs: 5000, users: 1 });
    expect(projectUsage(gentle).exceedsFreeDailyWrites).toBe(false);
    expect(projectUsage({ ...gentle, users: 6 }).exceedsFreeDailyWrites).toBe(true);
  });
});

describe('usageFromHistory', () => {
  const points = [
    { day: '2026-09-01', frames: 1000, bytes: 100_000_000 },
    { day: '2026-09-02', frames: 0, bytes: 0 },
    { day: '2026-09-03', frames: 3000, bytes: 300_000_000 },
  ];

  it('averages over calendar days, not only the busy ones', () => {
    // An idle day genuinely costs nothing, so it belongs in the divisor. Dividing by active
    // days answers "what does it cost while running", which here is 50% larger — quietly
    // picking one is how a projection overstates.
    const o = usageFromHistory(points, { days: 3, retentionDays: 7, objectsPerFrame: 2 });
    expect(o.usage.framesPerDay).toBeCloseTo(4000 / 3, 6);
    expect(o.framesPerActiveDay).toBe(2000);
    expect(o.activeDays).toBe(2);
    expect(o.days).toBe(3);
  });

  it('measures the frame size instead of assuming one', () => {
    const o = usageFromHistory(points, { days: 3, retentionDays: 7, objectsPerFrame: 2 });
    expect(o.avgFrameBytes).toBeCloseTo(400_000_000 / 4000, 6);
    expect(o.usage.bytesPerFrame).toBeCloseTo(100_000, 6);
  });

  it('plateaus at the retention window, as the sweep makes it', () => {
    const o = usageFromHistory(points, { days: 3, retentionDays: 7, objectsPerFrame: 2 });
    expect(o.usage.steadyStateBytes).toBeCloseTo(o.usage.bytesPerDay * 7, 6);
  });

  it('counts the delete as a written row here too', () => {
    const o = usageFromHistory(points, { days: 3, retentionDays: 7, objectsPerFrame: 2 });
    expect(o.usage.d1RowsWrittenPerMonth).toBeCloseTo(o.usage.framesPerDay * 30 * 2, 6);
  });

  it('survives an empty range without producing NaN', () => {
    // A range before the account existed is an ordinary thing to select.
    const o = usageFromHistory([], { days: 0, retentionDays: 7, objectsPerFrame: 2 });
    expect(o.usage.framesPerDay).toBe(0);
    expect(o.avgFrameBytes).toBe(0);
    expect(o.framesPerActiveDay).toBe(0);
    expect(Number.isFinite(o.usage.steadyStateGb)).toBe(true);
  });

  it('prices what it observed', () => {
    const o = usageFromHistory(points, { days: 3, retentionDays: 7, objectsPerFrame: 2 });
    const bill = priceMonth(o.usage, 'paid');
    expect(bill.total).toBeGreaterThanOrEqual(CLOUDFLARE_RATES.workers.subscriptionPerMonth);
    for (const i of bill.items) expect(i.cost, i.label).toBeGreaterThanOrEqual(0);
  });
});

describe('where the database growth stops', () => {
  const DAY = 86_400_000;
  const today = Date.parse('2026-09-10T00:00:00Z');
  const dayKey = (n: number) => new Date(today + n * DAY).toISOString().slice(0, 10);
  /** A steady week: 1 GB a day for the last seven days. */
  const steady = [-6, -5, -4, -3, -2, -1, 0].map((n) => ({
    day: dayKey(n), frames: 1000, bytes: 1e9,
  }));

  it('flattens rather than climbing without end', () => {
    // The whole reason this exists. A daily rate multiplied out reads like a runaway bill;
    // retention means it is not one, and the plateau is the number the invoice follows.
    const f = growthForecast(steady, {
      heldBytes: 7e9, bytesPerDay: 1e9, retentionDays: 7, horizonDays: 60,
      todayMs: today, historyFromMs: today - 7 * DAY,
    });
    expect(f.plateauBytes).toBe(7e9);
    expect(f.days[59]!.bytes).toBeCloseTo(7e9, -6);
    // and it got there without wandering above it
    expect(Math.max(...f.days.map((d) => d.bytes))).toBeLessThanOrEqual(7e9 * 1.001);
  });

  it('fills up to the plateau when the recorder has only just started', () => {
    const f = growthForecast([{ day: dayKey(0), frames: 1000, bytes: 1e9 }], {
      heldBytes: 1e9, bytesPerDay: 1e9, retentionDays: 7, horizonDays: 30,
      todayMs: today, historyFromMs: today - 30 * DAY,
    });
    expect(f.days[0]!.bytes).toBeCloseTo(2e9, -6);
    expect(f.days[5]!.bytes).toBeCloseTo(7e9, -6);
    expect(f.days[29]!.bytes).toBeCloseTo(7e9, -6);
    expect(f.settlesInDays).toBe(6);
  });

  it('uses what really ages out, not the average, while that is still known', () => {
    // The case the average gets wrong: six quiet days and one enormous one. On the day that
    // big day falls out of the window, the total drops by the big day — not by the mean.
    const spiky = [-6, -5, -4, -3, -2, -1, 0].map((n) => ({
      day: dayKey(n), frames: 10, bytes: n === -6 ? 6e9 : 1e8,
    }));
    const f = growthForecast(spiky, {
      heldBytes: 6.6e9, bytesPerDay: 6.6e9 / 7, retentionDays: 7, horizonDays: 10,
      todayMs: today, historyFromMs: today - 7 * DAY,
    });
    expect(f.days[0]!.expired).toBe(6e9);
    expect(f.days[0]!.measured).toBe(true);
    expect(f.days[1]!.expired).toBe(1e8);
    // Past the window the history has run out and the rate takes over.
    expect(f.days[7]!.measured).toBe(false);
    expect(f.days[7]!.expired).toBeCloseTo(6.6e9 / 7, 3);
  });

  it('falls back toward the plateau when more is held than the rate supports', () => {
    // Someone recorded heavily and stopped. Storage does not stay where it is; it drains as
    // the window rolls, and a projection that only ever climbs would keep billing for it.
    // With no history at all, every day falling out of the window is unknown — and
    // "unknown" must not mean "nothing", or the total climbs and then sits there forever.
    const f = growthForecast([], {
      heldBytes: 50e9, bytesPerDay: 1e9, retentionDays: 7, horizonDays: 30,
      todayMs: today, historyFromMs: today,
    });
    expect(f.shrinking).toBe(true);
    expect(f.days[29]!.bytes).toBeLessThan(50e9);
    // and it drains to the plateau rather than to nothing
    expect(f.days[29]!.bytes).toBeCloseTo(7e9, -9);
  });

  it('drains holdings the window cannot explain, instead of stranding them', () => {
    // Caught by looking at the chart, not by a test: with a full window of history, every
    // day of expiry was "measured", so anything held beyond what those days account for
    // had nowhere to go and the curve flattened above its own plateau. Old frames the
    // sweep has not reached yet are exactly this, and they do leave.
    const week = [-6, -5, -4, -3, -2, -1, 0].map((n) => ({
      day: dayKey(n), frames: 100, bytes: 1e9,
    }));
    const f = growthForecast(week, {
      heldBytes: 20e9, bytesPerDay: 1e9, retentionDays: 7, horizonDays: 40,
      todayMs: today, historyFromMs: today - 30 * DAY,
    });
    expect(f.shrinking).toBe(true);
    expect(f.days[39]!.bytes).toBeCloseTo(7e9, -9);
    // and it says so: those days are not a pure measurement any more
    expect(f.days[0]!.measured).toBe(false);
  });

  it('never reports negative storage', () => {
    const f = growthForecast(
      [{ day: dayKey(-1), frames: 1, bytes: 900e9 }],
      { heldBytes: 1e9, bytesPerDay: 0, retentionDays: 2, horizonDays: 5,
        todayMs: today, historyFromMs: today - 7 * DAY },
    );
    expect(f.days.every((d) => d.bytes >= 0)).toBe(true);
  });

  it('treats a day the history simply does not have as a real zero', () => {
    // A gap inside the retention window is a day nothing was recorded, so nothing expires
    // that day. Reading it as "unknown, use the average" would invent deletions.
    const f = growthForecast([{ day: dayKey(-3), frames: 1, bytes: 5e9 }], {
      heldBytes: 5e9, bytesPerDay: 0, retentionDays: 7, horizonDays: 7,
      todayMs: today, historyFromMs: today - 7 * DAY,
    });
    expect(f.days[3]!.expired).toBe(5e9);
    expect(f.days[0]!.expired).toBe(0);
  });
});

describe('who is using the system', () => {
  const acct = (id: string, bytes: number) => ({
    userId: id, email: `${id}@x`, frames: 1, bytes, sessions: 1, lastSeen: null,
  });

  it('names the account holding the most, and its share', () => {
    // The figure that changes a decision: a hundred accounts averaging a little is a
    // capacity problem, and one account holding most of it is a conversation with a person.
    const c = concentration([acct('a', 90), acct('b', 5), acct('c', 5)]);
    expect(c.top?.userId).toBe('a');
    expect(c.topShare).toBeCloseTo(0.9, 5);
    expect(c.total).toBe(100);
  });

  it('reports a median that the mean would hide', () => {
    const c = concentration([acct('a', 900), acct('b', 10), acct('c', 10), acct('d', 10)]);
    expect(c.median).toBe(10);
  });

  it('has nothing to say about an empty system rather than dividing by zero', () => {
    expect(concentration([])).toEqual({ total: 0, top: null, topShare: 0, median: 0 });
  });
});
