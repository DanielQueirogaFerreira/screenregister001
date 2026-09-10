/**
 * What this system costs to run on Cloudflare, and what it will cost.
 *
 * Every rate here is quoted from Cloudflare's own pricing pages rather than recalled, and
 * carries the date it was read. A cost model built on remembered prices is worse than no
 * cost model: it is confidently wrong, and nobody checks a number that looks plausible.
 *
 * The arithmetic is separated from the display for the usual reason — a projection that
 * decides whether to keep recording is exactly the kind of thing that should be tested
 * against worked examples rather than eyeballed in a panel.
 */

export interface Rates {
  /** When these were read from Cloudflare's documentation. */
  asOf: string;
  source: string;
  r2: {
    storagePerGbMonth: number;
    classAPerMillion: number;
    classBPerMillion: number;
    freeStorageGbMonth: number;
    freeClassA: number;
    freeClassB: number;
  };
  d1: {
    rowsReadPerMillion: number;
    rowsWrittenPerMillion: number;
    storagePerGbMonth: number;
    includedRowsRead: number;
    includedRowsWritten: number;
    includedStorageGb: number;
    /** Workers Free plan daily caps. Exceeding these now fails queries outright. */
    freeDailyRowsRead: number;
    freeDailyRowsWritten: number;
    freeStorageGb: number;
  };
  workers: {
    subscriptionPerMonth: number;
    requestsPerMillion: number;
    includedRequests: number;
    cpuMsPerMillion: number;
    includedCpuMs: number;
    freeDailyRequests: number;
  };
}

/**
 * Cloudflare's published rates, in USD.
 *
 * R2: https://developers.cloudflare.com/r2/pricing/
 * D1 and Workers: https://developers.cloudflare.com/workers/platform/pricing/
 */
export const CLOUDFLARE_RATES: Rates = {
  asOf: '2026-09-10',
  source: 'developers.cloudflare.com/r2/pricing + /workers/platform/pricing',
  r2: {
    storagePerGbMonth: 0.015,
    classAPerMillion: 4.5,
    classBPerMillion: 0.36,
    freeStorageGbMonth: 10,
    freeClassA: 1_000_000,
    freeClassB: 10_000_000,
  },
  d1: {
    rowsReadPerMillion: 0.001,
    rowsWrittenPerMillion: 1.0,
    storagePerGbMonth: 0.75,
    includedRowsRead: 25_000_000_000,
    includedRowsWritten: 50_000_000,
    includedStorageGb: 5,
    freeDailyRowsRead: 5_000_000,
    freeDailyRowsWritten: 100_000,
    freeStorageGb: 5,
  },
  workers: {
    subscriptionPerMonth: 5,
    requestsPerMillion: 0.3,
    includedRequests: 10_000_000,
    cpuMsPerMillion: 0.02,
    includedCpuMs: 30_000_000,
    freeDailyRequests: 100_000,
  },
};

export interface Scenario {
  /** Frames sampled per second, 1..30. */
  fps: number;
  /** Hours of active recording per day. 24 is the "full time" case. */
  hoursPerDay: number;
  /** Retention ceiling. Storage plateaus at this many days of frames. */
  retentionDays: number;
  /** Mean stored bytes per frame. Measured, not assumed — see `avgFrameBytes` callers. */
  avgFrameBytes: number;
  /**
   * Fraction of sampled frames that differ enough to be stored, 0..1.
   *
   * 1 is the worst case and the one worth planning against: every frame different from the
   * last, nothing deduplicated by the change detector.
   */
  changeRate: number;
  /** Shortest gap between two stored frames, in ms. 0 disables the governor. */
  minStoreGapMs: number;
  /** Whether a second untouched copy is kept beside each stored frame. */
  keepOriginal: boolean;
  /**
   * Thumbnail size as a fraction of the full frame. Measured at roughly a twentieth on
   * this project's frames — a 320px-wide WebP beside a 1920px one.
   */
  thumbRatio: number;
  /**
   * How many people are recording like this at once.
   *
   * Everything downstream is per-recorder and scales linearly, which is exactly why it is
   * worth having as a knob rather than left as an exercise: the difference between one
   * person and a team of forty is the difference between a free tier and a real bill, and
   * multiplying four separate figures in your head is where planning goes wrong.
   */
  users: number;
}

export const DEFAULT_SCENARIO: Scenario = {
  fps: 1,
  hoursPerDay: 24,
  retentionDays: 7,
  avgFrameBytes: 100_549,
  changeRate: 1,
  minStoreGapMs: 0,
  keepOriginal: false,
  thumbRatio: 0.05,
  users: 1,
};

export interface Usage {
  /** People recording. Every other figure here is the total across them. */
  users: number;
  /** Frames actually written per day across every recorder. */
  framesPerDay: number;
  bytesPerFrame: number;
  bytesPerDay: number;
  /** What R2 holds once the retention window is full — the figure the bill is based on. */
  steadyStateBytes: number;
  steadyStateGb: number;
  /** R2 objects written per frame: the image, its thumbnail, and maybe the original. */
  objectsPerFrame: number;
  r2ClassAPerMonth: number;
  d1RowsWrittenPerMonth: number;
  workerRequestsPerMonth: number;
  /** Days until the D1 free plan's daily write cap is hit, or null if it never is. */
  d1FreeWriteHeadroom: number;
  /** True when this scenario alone exceeds a Workers Free daily allowance. */
  exceedsFreeDailyWrites: boolean;
  exceedsFreeDailyRequests: boolean;
}

const DAYS_PER_MONTH = 30;

/**
 * How much of everything one recording pattern consumes.
 *
 * The governor that decides this is `minStoreGapMs`, not `fps`. At 1 FPS with no gap the
 * recorder stores a frame every second for as long as the screen keeps moving; at a
 * three-second gap the same hour costs a third as much. Both are modelled because the
 * difference between them is the difference between a free tier and a bill.
 */
export function projectUsage(s: Scenario): Usage {
  const fps = Math.max(0, s.fps);
  const sampledPerSecond = fps * Math.max(0, Math.min(1, s.changeRate));
  // The gap caps the rate outright: two frames can never be closer together than this.
  const gapCap = s.minStoreGapMs > 0 ? 1000 / s.minStoreGapMs : Infinity;
  const storedPerSecond = Math.min(sampledPerSecond, gapCap);
  const users = Math.max(0, s.users);
  const perUserPerDay = storedPerSecond * 3600 * Math.max(0, Math.min(24, s.hoursPerDay));
  const framesPerDay = perUserPerDay * users;

  const bytesPerFrame = s.avgFrameBytes * (1 + s.thumbRatio) * (s.keepOriginal ? 2 : 1);
  const bytesPerDay = framesPerDay * bytesPerFrame;
  const steadyStateBytes = bytesPerDay * s.retentionDays;

  // The image and its thumbnail are separate objects, and the untouched copy is a third.
  const objectsPerFrame = 2 + (s.keepOriginal ? 1 : 0);

  const framesPerMonth = framesPerDay * DAYS_PER_MONTH;
  return {
    users,
    framesPerDay,
    bytesPerFrame,
    bytesPerDay,
    steadyStateBytes,
    steadyStateGb: steadyStateBytes / 1e9,
    objectsPerFrame,
    r2ClassAPerMonth: framesPerMonth * objectsPerFrame,
    // Written once when captured and again when the retention sweep deletes it: a delete
    // is a row written, which is the half of D1's bill that people forget.
    d1RowsWrittenPerMonth: framesPerMonth * 2,
    workerRequestsPerMonth: framesPerMonth,
    d1FreeWriteHeadroom: framesPerDay > 0
      ? CLOUDFLARE_RATES.d1.freeDailyRowsWritten / (framesPerDay * 2)
      : Infinity,
    exceedsFreeDailyWrites: framesPerDay * 2 > CLOUDFLARE_RATES.d1.freeDailyRowsWritten,
    exceedsFreeDailyRequests: framesPerDay > CLOUDFLARE_RATES.workers.freeDailyRequests,
  };
}

export interface LineItem {
  label: string;
  /** What was consumed, in the unit the note names. */
  quantity: number;
  unit: string;
  /** Covered by the plan's included allowance. */
  included: number;
  /** What is actually charged for, after allowances and any rounding rule. */
  billable: number;
  cost: number;
  note?: string;
}

export interface Bill {
  plan: 'free' | 'paid';
  items: LineItem[];
  total: number;
  /** Set when the scenario cannot run on this plan at all, rather than merely costing money. */
  blocked: string[];
}

/**
 * R2 rounds every billable quantity UP to the next whole unit.
 *
 * Their own words: one million and one operations is billed as two million, and 1.1
 * GB-month is billed as 2. Most estimates miss this and undercount, which matters most at
 * exactly the small scale where someone is deciding whether they can afford to run at all.
 */
const roundUp = (n: number) => {
  // The epsilon stops 12.0000000001 becoming 13 through floating-point noise. The
  // guard in front of it stops the epsilon turning an exact zero into NEGATIVE zero,
  // which renders as "-0" in a billing table — spotted in a screenshot, not in a test.
  if (!(n > 0)) return 0;
  return Math.ceil(n - 1e-9);
};

/**
 * Bytes as Cloudflare counts them, which is decimal and not binary.
 *
 * A GB-month on an invoice is 10^9 bytes. Showing a 2^30-based "GB" beside it puts two
 * different units under one label on the same screen and makes the page disagree with
 * itself by seven percent.
 */
export const billingGb = (b: number): number => b / 1e9;

export function priceMonth(
  u: Usage, plan: 'free' | 'paid', r: Rates = CLOUDFLARE_RATES,
): Bill {
  const items: LineItem[] = [];
  const blocked: string[] = [];

  if (plan === 'free') {
    // The free plan is not a cheaper paid plan. Past these caps queries fail outright —
    // since 1 September 2026 D1 returns errors rather than throttling — so the honest
    // answer for a scenario that exceeds them is "this does not run", not "this costs $0".
    if (u.exceedsFreeDailyWrites) {
      blocked.push(
        `D1 writes ${fmt(u.framesPerDay * 2)} rows/day against a ${fmt(r.d1.freeDailyRowsWritten)} free daily cap — queries fail once it is reached`,
      );
    }
    if (u.exceedsFreeDailyRequests) {
      blocked.push(
        `${fmt(u.framesPerDay)} uploads/day against a ${fmt(r.workers.freeDailyRequests)} free daily request cap`,
      );
    }
    if (u.steadyStateGb > r.r2.freeStorageGbMonth) {
      blocked.push(
        `${u.steadyStateGb.toFixed(1)} GB held against R2's ${r.r2.freeStorageGbMonth} GB free allowance`,
      );
    }
    if (u.steadyStateGb > r.d1.freeStorageGb) {
      // D1 holds rows, not images; this only bites at a scale the row count reaches first.
      blocked.push(`D1 storage cap is ${r.d1.freeStorageGb} GB on the free plan`);
    }
    return { plan, items, total: 0, blocked };
  }

  items.push({
    label: 'Workers subscription',
    quantity: 1, unit: 'month', included: 0, billable: 1,
    cost: r.workers.subscriptionPerMonth,
    note: 'the flat fee the paid plan starts at',
  });

  const gbBillable = roundUp(u.steadyStateGb - r.r2.freeStorageGbMonth);
  items.push({
    label: 'R2 storage',
    quantity: u.steadyStateGb, unit: 'GB-month',
    included: r.r2.freeStorageGbMonth, billable: gbBillable,
    cost: gbBillable * r.r2.storagePerGbMonth,
    note: 'rounded up to a whole GB-month, as R2 bills it',
  });

  const classAMillions = roundUp((u.r2ClassAPerMonth - r.r2.freeClassA) / 1e6);
  items.push({
    label: 'R2 writes (Class A)',
    quantity: u.r2ClassAPerMonth, unit: 'operations',
    included: r.r2.freeClassA, billable: classAMillions * 1e6,
    cost: classAMillions * r.r2.classAPerMillion,
    note: `${u.objectsPerFrame} objects per frame, rounded up to whole millions`,
  });

  const rowsWritten = Math.max(0, u.d1RowsWrittenPerMonth - r.d1.includedRowsWritten);
  items.push({
    label: 'D1 rows written',
    quantity: u.d1RowsWrittenPerMonth, unit: 'rows',
    included: r.d1.includedRowsWritten, billable: rowsWritten,
    cost: (rowsWritten / 1e6) * r.d1.rowsWrittenPerMillion,
    note: 'one row when the frame arrives, one when retention deletes it',
  });

  const requests = Math.max(0, u.workerRequestsPerMonth - r.workers.includedRequests);
  items.push({
    label: 'Worker requests',
    quantity: u.workerRequestsPerMonth, unit: 'requests',
    included: r.workers.includedRequests, billable: requests,
    cost: (requests / 1e6) * r.workers.requestsPerMillion,
    note: 'one upload per stored frame',
  });

  return {
    plan,
    items,
    total: items.reduce((n, i) => n + i.cost, 0),
    blocked,
  };
}

const fmt = (n: number) => Math.round(n).toLocaleString('en-US');

/**
 * Where a running total will land by the end of the billing period.
 *
 * Straight-line from the rate observed so far, which is the right model for a recorder
 * that either runs or does not: it does not accelerate. Deliberately not a curve fit —
 * with a handful of days of history a curve says more than the data supports.
 */
export function projectToPeriodEnd(
  usedSoFar: number, daysElapsed: number, daysInPeriod = DAYS_PER_MONTH,
): number {
  if (!(daysElapsed > 0)) return 0;
  return (usedSoFar / daysElapsed) * daysInPeriod;
}

export interface HistoryPoint {
  /** 'YYYY-MM-DD'. */
  day: string;
  frames: number;
  bytes: number;
}

export interface Observed {
  usage: Usage;
  /** Calendar days in the range, including the ones nothing happened on. */
  days: number;
  /** Days something was actually recorded. */
  activeDays: number;
  totalFrames: number;
  totalBytes: number;
  /** Mean bytes per stored frame across the range, or 0 when nothing was stored. */
  avgFrameBytes: number;
  /** The rate while recording, as opposed to the rate averaged over idle days too. */
  framesPerActiveDay: number;
}

/**
 * What the account has actually been doing, turned into the same shape a scenario produces.
 *
 * Averaged over CALENDAR days in the range rather than over the days something happened.
 * That is the honest basis for a bill: an idle Sunday genuinely costs nothing, and dividing
 * by active days only would answer "what does it cost while running", which is a different
 * and much larger number. Both are reported, because both are worth knowing and quietly
 * picking one is how a projection ends up overstating by a factor of three.
 */
export function usageFromHistory(
  points: HistoryPoint[],
  o: { days: number; retentionDays: number; objectsPerFrame: number },
): Observed {
  const totalFrames = points.reduce((n, p) => n + p.frames, 0);
  const totalBytes = points.reduce((n, p) => n + p.bytes, 0);
  const activeDays = points.filter((p) => p.frames > 0).length;
  const days = Math.max(1, o.days);

  const framesPerDay = totalFrames / days;
  const bytesPerDay = totalBytes / days;
  const steadyStateBytes = bytesPerDay * o.retentionDays;
  const framesPerMonth = framesPerDay * DAYS_PER_MONTH;

  return {
    days,
    activeDays,
    totalFrames,
    totalBytes,
    avgFrameBytes: totalFrames > 0 ? totalBytes / totalFrames : 0,
    framesPerActiveDay: activeDays > 0 ? totalFrames / activeDays : 0,
    usage: {
      users: 1,
      framesPerDay,
      bytesPerFrame: totalFrames > 0 ? totalBytes / totalFrames : 0,
      bytesPerDay,
      steadyStateBytes,
      steadyStateGb: steadyStateBytes / 1e9,
      objectsPerFrame: o.objectsPerFrame,
      r2ClassAPerMonth: framesPerMonth * o.objectsPerFrame,
      d1RowsWrittenPerMonth: framesPerMonth * 2,
      workerRequestsPerMonth: framesPerMonth,
      d1FreeWriteHeadroom: framesPerDay > 0
        ? CLOUDFLARE_RATES.d1.freeDailyRowsWritten / (framesPerDay * 2)
        : Infinity,
      exceedsFreeDailyWrites: framesPerDay * 2 > CLOUDFLARE_RATES.d1.freeDailyRowsWritten,
      exceedsFreeDailyRequests: framesPerDay > CLOUDFLARE_RATES.workers.freeDailyRequests,
    },
  };
}

/** Days until a quantity growing at this rate reaches a ceiling, or Infinity. */
export function daysUntil(current: number, perDay: number, ceiling: number): number {
  if (current >= ceiling) return 0;
  if (!(perDay > 0)) return Infinity;
  return (ceiling - current) / perDay;
}
