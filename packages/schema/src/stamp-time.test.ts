import { describe, expect, it } from 'vitest';
import { formatUtcOffset, localWallClock, stampTimeLines, utcOffset } from './stamp.js';

describe('the offset burned into a frame', () => {
  it('inverts the sign getTimezoneOffset uses', () => {
    // The trap: a machine in UTC-4 reports +240. Taking that at face value labels the
    // frame UTC+4, which is wrong by eight hours and looks entirely plausible.
    expect(formatUtcOffset(240)).toBe('UTC-4');
    expect(formatUtcOffset(360)).toBe('UTC-6');
    expect(formatUtcOffset(480)).toBe('UTC-8');
    expect(formatUtcOffset(-60)).toBe('UTC+1');
    expect(formatUtcOffset(0)).toBe('UTC');
  });

  it('keeps the zones that are not a whole number of hours', () => {
    expect(formatUtcOffset(-330)).toBe('UTC+5:30');   // India
    expect(formatUtcOffset(-345)).toBe('UTC+5:45');   // Nepal
    expect(formatUtcOffset(210)).toBe('UTC-3:30');    // Newfoundland
  });

  it('leads with the clock a person can check, and keeps the absolute instant under it', () => {
    // The bug this ordering exists to prevent: a stamp reading only 06:26Z UTC-4 was read
    // against a wall clock saying 02:29 and reported as a wrong offset. It was correct —
    // 06:26Z IS 02:26 in UTC-4 — but nothing on the image said so without arithmetic.
    const ms = Date.UTC(2026, 8, 9, 6, 26, 34, 762);
    expect(stampTimeLines(ms, 240)).toEqual([
      '2026-09-09 02:26:34.762 UTC-4',
      '2026-09-09T06:26:34.762Z',
    ]);
  });

  it('keeps the milliseconds on both lines', () => {
    // Not decoration: frames are ULID-ordered by millisecond, so a timestamp truncated to
    // the second cannot tell two frames of the same second apart.
    const ms = Date.UTC(2026, 8, 9, 5, 12, 44, 123);
    for (const line of stampTimeLines(ms, 240)) expect(line).toContain('.123');
  });

  it('agrees with itself: the local line is the Z line shifted by the stated offset', () => {
    // The property that makes the two lines trustworthy together. Checked across offsets
    // that cross midnight in both directions and one that is not a whole hour.
    for (const off of [240, 360, 480, -60, 0, -330, 210]) {
      const ms = Date.UTC(2026, 8, 9, 6, 26, 34, 762);
      const [local, iso] = stampTimeLines(ms, off);
      const [wall, label] = [local.slice(0, 23), local.slice(24)];
      expect(wall).toBe(localWallClock(iso, off));
      expect(label).toBe(formatUtcOffset(off));
      expect(Date.parse(iso)).toBe(ms);
    }
  });

  it('takes the offset in force at the captured instant, not at the time of asking', () => {
    // Daylight saving means "now" is the wrong question for a frame captured in another
    // season. utcOffset accepts the instant so the caller cannot accidentally ask it.
    const winter = new Date(Date.UTC(2026, 0, 15));
    const summer = new Date(Date.UTC(2026, 6, 15));
    expect(utcOffset(winter)).toBe(formatUtcOffset(winter.getTimezoneOffset()));
    expect(utcOffset(summer)).toBe(formatUtcOffset(summer.getTimezoneOffset()));
  });
});

describe('the clock on the recording machine', () => {
  it('subtracts the offset, because getTimezoneOffset counts backwards', () => {
    // 05:12:44.123Z on a machine in UTC-4 was 01:12 in the morning there. Adding instead
    // of subtracting gives 09:12 — a plausible-looking time that is wrong by eight hours.
    expect(localWallClock('2026-09-09T05:12:44.123Z', 240)).toBe('2026-09-09 01:12:44.123');
    expect(localWallClock('2026-09-09T05:12:44.123Z', 480)).toBe('2026-09-08 21:12:44.123');
    expect(localWallClock('2026-09-09T05:12:44.123Z', -60)).toBe('2026-09-09 06:12:44.123');
    expect(localWallClock('2026-09-09T05:12:44.123Z', 0)).toBe('2026-09-09 05:12:44.123');
  });

  it('carries the date across when the offset crosses midnight', () => {
    // The case a naive time-only render gets wrong: UTC-8 at 05:12Z is the previous day.
    expect(localWallClock('2026-09-09T05:12:44.123Z', 480)).toMatch(/^2026-09-08 /);
  });

  it('keeps the milliseconds, which is what tells two frames of one second apart', () => {
    expect(localWallClock('2026-09-09T05:12:44.123Z', 240)).toContain('.123');
  });
});
