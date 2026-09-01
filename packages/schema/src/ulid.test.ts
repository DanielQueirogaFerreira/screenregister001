import { describe, it, expect } from 'vitest';
import { ulid, ulidTime } from './ulid.js';

const CROCKFORD = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;

describe('ulid', () => {
  it('rejects nothing but produces a well-formed id from a fractional timestamp', () => {
    // Regression: capture timestamps come from performance.now() and are fractional.
    // Indexing the base-32 alphabet at a non-integer spliced "undefined" into the id.
    const id = ulid(1756684800123.456);
    expect(id).toMatch(CROCKFORD);
    expect(id).not.toContain('undefined');
    expect(id).toHaveLength(26);
  });

  it('sorts lexicographically by time', () => {
    const ids = [0, 1, 2, 3, 4].map((i) => ulid(1756684800000 + i * 1000));
    expect([...ids].sort()).toEqual(ids);
  });

  it('stays monotonic within a single millisecond', () => {
    const ids = Array.from({ length: 50 }, () => ulid(1756684800000));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('round-trips the timestamp', () => {
    expect(ulidTime(ulid(1756684800123))).toBe(1756684800123);
  });
});
