export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/**
 * Bytes per frame — the number that says whether a recording is expensive.
 *
 * A total answers "how much is stored"; only the ratio answers "how much does one frame
 * cost", and that is the figure any decision about quality or capture rate turns on. A
 * session that stored 100 frames in 100 MB is doing something very different from one that
 * stored 10,000 in the same space, and the totals alone cannot tell them apart.
 *
 * Zero frames is not zero cost, it is an unanswerable question, so it says so rather than
 * dividing by zero and rendering NaN or Infinity into the page.
 */
export function perFrame(totalBytes: number, frames: number): string {
  if (!frames || frames < 1) return '—';
  return `${bytes(Math.round(totalBytes / frames))}/frame`;
}

export function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/**
 * Render a UTC offset the way people write one: UTC-3, UTC+5:30, or plain UTC at zero.
 *
 * Takes exactly what `Date.prototype.getTimezoneOffset` returns, which is minutes *behind*
 * UTC — so its sign is the reverse of the conventional one. A machine in UTC-3 reports
 * +180. Inverting that is the whole subtlety here, and getting it backwards produces a
 * label that is wrong by twice the offset while looking entirely plausible.
 *
 * Not every zone is a whole number of hours: India is +5:30, Nepal +5:45, Newfoundland
 * -3:30. Truncating to hours would mislabel them.
 */
export function formatUtcOffset(minutesBehindUtc: number): string {
  const minutes = -minutesBehindUtc;
  if (minutes === 0) return 'UTC';
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return m === 0 ? `UTC${sign}${h}` : `UTC${sign}${h}:${String(m).padStart(2, '0')}`;
}

/**
 * The offset in force at a given moment, not the one in force now.
 *
 * Daylight saving means a build made in July and a frame captured in December do not share
 * an offset, so the label has to be computed against the instant it describes.
 */
export const utcOffset = (at: Date = new Date()): string =>
  formatUtcOffset(at.getTimezoneOffset());

/** The IANA zone this browser is set to, when it will say — for the badge's tooltip. */
export function timeZoneName(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

export const clock = (iso: string): string =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export const day = (iso: string): string =>
  new Date(iso).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
