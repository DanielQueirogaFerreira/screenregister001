import { describe, expect, it } from 'vitest';
import { formatUtcOffset, perFrame, utcOffset } from './format.js';

describe('formatUtcOffset', () => {
  it('reverses the sign getTimezoneOffset uses', () => {
    // The trap: getTimezoneOffset counts minutes *behind* UTC, so a machine in UTC-3
    // reports +180. Reading it straight through gives UTC+3 — wrong by six hours, and
    // entirely plausible-looking.
    expect(formatUtcOffset(180)).toBe('UTC-3');
    expect(formatUtcOffset(-180)).toBe('UTC+3');
    expect(formatUtcOffset(300)).toBe('UTC-5');
    expect(formatUtcOffset(480)).toBe('UTC-8');
  });

  it('says plain UTC at zero rather than +0', () => {
    expect(formatUtcOffset(0)).toBe('UTC');
    expect(formatUtcOffset(-0)).toBe('UTC');
  });

  it('keeps the zones that are not a whole number of hours', () => {
    expect(formatUtcOffset(-330)).toBe('UTC+5:30');   // India
    expect(formatUtcOffset(-345)).toBe('UTC+5:45');   // Nepal
    expect(formatUtcOffset(210)).toBe('UTC-3:30');    // Newfoundland
    expect(formatUtcOffset(-825)).toBe('UTC+13:45');  // Chatham Islands, in summer
  });

  it('handles the extremes the IANA database actually contains', () => {
    expect(formatUtcOffset(-840)).toBe('UTC+14');     // Line Islands
    expect(formatUtcOffset(720)).toBe('UTC-12');      // Baker Island
  });

  it('reads the offset off a real date', () => {
    const at = new Date();
    expect(utcOffset(at)).toBe(formatUtcOffset(at.getTimezoneOffset()));
    expect(utcOffset(at)).toMatch(/^UTC([+-]\d{1,2}(:\d{2})?)?$/);
  });

  it('takes the offset in force at that moment, not the one in force now', () => {
    // Daylight saving means a build from July and a frame from December need not share an
    // offset. Both are computed against their own instant; on a machine with no DST they
    // agree, and on one with DST they are allowed to differ.
    const july = new Date('2026-07-15T12:00:00Z');
    const december = new Date('2026-12-15T12:00:00Z');
    expect(utcOffset(july)).toBe(formatUtcOffset(july.getTimezoneOffset()));
    expect(utcOffset(december)).toBe(formatUtcOffset(december.getTimezoneOffset()));
  });
});

describe('bytes per frame', () => {
  it('is the figure a storage decision turns on, not the total', () => {
    // The example that prompted this: 100 frames in 100 MB is 1 MB a frame. Two sessions
    // with the same total can differ by orders of magnitude per frame, and only the ratio
    // shows it.
    expect(perFrame(100 * 1024 ** 2, 100)).toBe('1.0 MB/frame');
    expect(perFrame(100 * 1024 ** 2, 10_000)).toBe('10 KB/frame');
  });

  it('reports the real production figure the way it was measured', () => {
    // 12,525 frames in 1.295 GB — the session that made storage a problem.
    expect(perFrame(1_295_165_128, 12_525)).toBe('101 KB/frame');
  });

  it('refuses to divide by zero rather than rendering NaN into the page', () => {
    // A session that has started but stored nothing yet is the common case here, and it
    // appears in the admin list while it is still recording.
    expect(perFrame(0, 0)).toBe('—');
    expect(perFrame(5000, 0)).toBe('—');
  });
});
