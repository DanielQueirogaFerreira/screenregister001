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
 * The offset helpers live in @sr/schema, beside the stamp format that burns them into the
 * image, and are re-exported here so callers keep one import. Two copies of a sign
 * inversion is exactly the kind of thing that drifts and is wrong by twice the offset.
 */
export { formatUtcOffset, utcOffset } from '@sr/schema';

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
