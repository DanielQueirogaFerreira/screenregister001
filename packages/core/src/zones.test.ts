import { describe, expect, it } from 'vitest';
import { coveredFraction, normaliseZone, usableZones, zoneRect, type Zone } from './zones.js';

const zone = (over: Partial<Zone> = {}): Zone =>
  ({ id: 'z', label: 'test', x: 0.1, y: 0.1, w: 0.2, h: 0.2, ...over });

describe('a zone drawn in any direction', () => {
  it('is the same rectangle whichever corner it started from', () => {
    // Dragging up and left is the natural way to grab a top-left corner, and it produces
    // negative width. Stored verbatim it draws as nothing — so someone marks an area, sees
    // no black box, and concludes the feature is broken while believing they are covered.
    const forward = normaliseZone(zone({ x: 0.2, y: 0.3, w: 0.4, h: 0.2 }));
    const backward = normaliseZone(zone({ x: 0.6, y: 0.5, w: -0.4, h: -0.2 }));
    // Compared with a tolerance, not exactly: 0.6 - 0.4 and 0.2 are different doubles, and
    // asserting bit equality on computed floats tests the arithmetic rather than the rule.
    for (const k of ['x', 'y', 'w', 'h'] as const) {
      expect(backward[k], k).toBeCloseTo(forward[k], 10);
    }
    expect(backward.w).toBeGreaterThan(0);
  });

  it('never escapes the frame, however far the drag went', () => {
    const z = normaliseZone(zone({ x: -0.5, y: -0.5, w: 3, h: 3 }));
    expect(z).toMatchObject({ x: 0, y: 0, w: 1, h: 1 });
  });

  it('survives values that are not numbers at all', () => {
    const z = normaliseZone(zone({ x: NaN, y: 0.5, w: Infinity, h: 0.1 }));
    expect(Number.isFinite(z.x) && Number.isFinite(z.w)).toBe(true);
  });
});

describe('the pixels actually painted', () => {
  it('rounds outwards, so no fringe of the original survives at the edge', () => {
    // Rounding to nearest leaves a sliver of unredacted pixels whenever the fraction lands
    // mid-pixel. On a 4K frame that sliver is wide enough to read. Covering slightly more
    // than asked is the only rounding a redaction can afford.
    const r = zoneRect(zone({ x: 0.1001, y: 0.1001, w: 0.2004, h: 0.2004 }), 1920, 1080);
    expect(r.x).toBeLessThanOrEqual(Math.round(0.1001 * 1920));
    expect(r.y).toBeLessThanOrEqual(Math.round(0.1001 * 1080));
    expect(r.x + r.w).toBeGreaterThanOrEqual(Math.round(0.3005 * 1920));
    expect(r.y + r.h).toBeGreaterThanOrEqual(Math.round(0.3005 * 1080));
  });

  it('lands on the same part of the screen at any capture resolution', () => {
    // The reason zones are fractions. This project's own capture went 768x1366 ->
    // 1920x1366 -> 1920x1080 in one afternoon; pixel coordinates would have kept pointing
    // confidently at the wrong place, which for a privacy control is the worst failure:
    // configured, and covering nothing.
    const z = zone({ x: 0.5, y: 0, w: 0.5, h: 0.25 });
    const sizes: [number, number][] = [[768, 1366], [1920, 1366], [1920, 1080], [3840, 2160]];
    for (const [w, h] of sizes) {
      const r = zoneRect(z, w, h);
      expect(r.x / w).toBeCloseTo(0.5, 2);
      expect(r.w / w).toBeCloseTo(0.5, 2);
      expect(r.h / h).toBeCloseTo(0.25, 2);
    }
  });

  it('stays inside the frame it is painted on', () => {
    const r = zoneRect(zone({ x: 0.9, y: 0.9, w: 0.5, h: 0.5 }), 1000, 500);
    expect(r.x + r.w).toBeLessThanOrEqual(1000);
    expect(r.y + r.h).toBeLessThanOrEqual(500);
  });

  it('covers a whole-screen zone completely', () => {
    const r = zoneRect(zone({ x: 0, y: 0, w: 1, h: 1 }), 1920, 1080);
    expect(r).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
  });
});

describe('which zones are worth drawing', () => {
  it('drops a stray click but keeps a deliberate rectangle', () => {
    const kept = usableZones([
      zone({ id: 'speck', x: 0.5, y: 0.5, w: 0.0001, h: 0.0001 }),
      zone({ id: 'real', x: 0.1, y: 0.1, w: 0.3, h: 0.2 }),
    ]);
    expect(kept.map((z) => z.id)).toEqual(['real']);
  });
});

describe('how much of the screen is hidden', () => {
  it('reports roughly the area covered', () => {
    expect(coveredFraction([zone({ x: 0, y: 0, w: 0.5, h: 0.5 })])).toBeCloseTo(0.25, 2);
  });

  it('counts an overlap once rather than twice', () => {
    // Two halves that share a quarter cover three quarters, not a whole screen. Telling
    // someone they have hidden 100% when they have hidden 75% would be a reason to undo a
    // zone they actually wanted.
    const f = coveredFraction([
      zone({ id: 'a', x: 0, y: 0, w: 0.5, h: 1 }),
      zone({ id: 'b', x: 0.25, y: 0, w: 0.5, h: 1 }),
    ]);
    expect(f).toBeCloseTo(0.75, 2);
  });

  it('is zero when there is nothing to hide', () => {
    expect(coveredFraction([])).toBe(0);
  });
});
