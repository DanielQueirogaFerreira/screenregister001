import { describe, expect, it } from 'vitest';
import { formatUtcOffset, utcOffset } from './format.js';

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
