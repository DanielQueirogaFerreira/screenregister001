import { describe, expect, it } from 'vitest';
import { stampCoverage, stampLayout } from './stamp-layout.js';

/** A 39-character stamp in monospace is about 0.6em per character. */
const textFor = (fontSize: number, chars = 39) => Math.round(chars * fontSize * 0.6);

const SIZES: [number, number, string][] = [
  [1920, 1080, '1080p'],
  [2560, 1440, '1440p'],
  [3840, 2160, '4K'],
  [1280, 720, '720p'],
  [1080, 1920, 'phone, portrait'],
  [800, 600, 'small window'],
];

describe('where the stamp lands', () => {
  it('sits in the bottom-left corner, at every size', () => {
    for (const [w, h, name] of SIZES) {
      const l = stampLayout(w, h, 2, textFor(stampLayout(w, h, 2, 0).fontSize));
      // Left: its own edge is nearer the left of the frame than the middle.
      expect(l.box.x, name).toBeLessThan(w / 2);
      // Bottom: its top edge is below the halfway line.
      expect(l.box.y, name).toBeGreaterThan(h / 2);
      // And it reaches the bottom, rather than floating in the middle.
      expect(h - (l.box.y + l.box.h), name).toBeLessThanOrEqual(l.fontSize);
    }
  });

  it('stays inside the frame', () => {
    for (const [w, h, name] of SIZES) {
      const l = stampLayout(w, h, 2, textFor(stampLayout(w, h, 2, 0).fontSize));
      expect(l.box.x, name).toBeGreaterThanOrEqual(0);
      expect(l.box.y, name).toBeGreaterThanOrEqual(0);
      expect(l.box.x + l.box.w, name).toBeLessThanOrEqual(w);
      expect(l.box.y + l.box.h, name).toBeLessThanOrEqual(h);
    }
  });

  it('covers a fraction of a percent, not a corner of the picture', () => {
    // The whole argument for burning it in is that it costs nothing visually. If this
    // grows, that argument stops holding and the setting should be reconsidered.
    for (const [w, h, name] of SIZES) {
      const l = stampLayout(w, h, 2, textFor(stampLayout(w, h, 2, 0).fontSize));
      expect(stampCoverage(l, w, h), `${name}: ${(stampCoverage(l, w, h) * 100).toFixed(2)}%`)
        .toBeLessThan(0.03);
    }
    const hd = stampLayout(1920, 1080, 2, textFor(15));
    expect(stampCoverage(hd, 1920, 1080)).toBeLessThan(0.015);
  });

  it('keeps the text on its own scrim', () => {
    const l = stampLayout(1920, 1080, 2, textFor(15));
    for (const b of l.baselines) {
      expect(b.x).toBeGreaterThanOrEqual(l.box.x);
      expect(b.y).toBeGreaterThan(l.box.y);
      expect(b.y).toBeLessThanOrEqual(l.box.y + l.box.h);
    }
    // Lines are ordered top to bottom and evenly spaced.
    expect(l.baselines[1]!.y - l.baselines[0]!.y).toBe(Math.round(15 * 1.35));
  });

  it('scales with the frame, within bounds', () => {
    expect(stampLayout(3840, 2160, 2, 0).fontSize).toBe(15);   // capped
    expect(stampLayout(640, 360, 2, 0).fontSize).toBe(9);      // floored
    expect(stampLayout(1320, 743, 2, 0).fontSize).toBe(12);
  });

  it('clamps a stamp too wide for a narrow frame instead of overhanging the scrim', () => {
    // 39 monospace characters need roughly 350px; a 320px-wide capture has less than that.
    const narrow = stampLayout(320, 240, 2, 400);
    expect(narrow.box.x + narrow.box.w).toBeLessThanOrEqual(320);
  });

  it('pins to the top rather than off the frame when there is no room below', () => {
    // A frame shorter than the stamp would otherwise place the box at a negative y, where
    // nothing is drawn at all — silently no stamp, which is worse than an awkward one.
    const tiny = stampLayout(400, 20, 2, 100);
    expect(tiny.box.y).toBe(0);
    expect(tiny.box.x).toBeGreaterThanOrEqual(0);
  });

  it('grows with the number of lines, downward from the same left edge', () => {
    const one = stampLayout(1920, 1080, 1, textFor(15));
    const two = stampLayout(1920, 1080, 2, textFor(15));
    expect(two.box.h).toBeGreaterThan(one.box.h);
    expect(two.box.x).toBe(one.box.x);
    expect(two.box.y).toBeLessThan(one.box.y);   // taller box starts higher up
    expect(two.box.y + two.box.h).toBe(one.box.y + one.box.h);  // same bottom edge
  });
});
