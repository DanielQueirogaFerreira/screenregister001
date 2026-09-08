import { describe, expect, it } from 'vitest';
import { DEFAULT_PRIVACY, findMaskedFields, scaleRegions } from './privacy.js';

const W = 640;
const H = 360;

/** A blank light page, as most interfaces are. */
function page(fill = 240): { gray: Uint8Array; w: number; h: number } {
  return { gray: new Uint8Array(W * H).fill(fill), w: W, h: H };
}

function dot(g: Uint8Array, cx: number, cy: number, r: number, value: number): void {
  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) g[y * W + x] = value;
    }
  }
}

/** A row of identical bullets: what a masked password field looks like. */
function bullets(
  g: Uint8Array,
  { x = 100, y = 180, count = 10, pitch = 12, r = 3, value = 30 } = {},
): void {
  for (let i = 0; i < count; i++) dot(g, x + i * pitch, y, r, value);
}

/** Proportional text: varying glyph widths and gaps, which is the discriminator. */
function text(g: Uint8Array, y: number, widths: number[], value = 30): void {
  let x = 60;
  for (const w of widths) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = 0; dx < w; dx++) g[(y + dy) * W + (x + dx)] = value;
    }
    x += w + 3 + (w % 3);
  }
}

describe('masked field detection', () => {
  it('finds a row of evenly spaced bullets', () => {
    const { gray, w, h } = page();
    bullets(gray);
    const found = findMaskedFields(gray, w, h);
    expect(found.length).toBeGreaterThanOrEqual(1);
    // The region covers the bullets, with padding.
    const r = found[0]!;
    expect(r.x).toBeLessThanOrEqual(100);
    expect(r.x + r.w).toBeGreaterThanOrEqual(100 + 9 * 12);
    expect(r.y).toBeLessThan(180);
    expect(r.y + r.h).toBeGreaterThan(180);
  });

  it('finds light bullets on a dark theme too', () => {
    // Only looking for dark-on-light would miss half of all password fields.
    const { gray, w, h } = page(20);
    bullets(gray, { value: 235 });
    expect(findMaskedFields(gray, w, h).length).toBeGreaterThanOrEqual(1);
  });

  it('says nothing about a blank screen', () => {
    const { gray, w, h } = page();
    expect(findMaskedFields(gray, w, h)).toEqual([]);
  });

  it('says nothing about ordinary text', () => {
    // The expensive failure is the false positive: the caller deletes the original frame
    // when this returns a region, so a paragraph must never look like a password.
    const { gray, w, h } = page();
    text(gray, 100, [7, 4, 9, 5, 11, 6, 8, 4, 10, 5, 7, 9, 4, 12]);
    text(gray, 140, [5, 8, 6, 11, 4, 9, 7, 5, 10, 6, 8, 4]);
    expect(findMaskedFields(gray, w, h)).toEqual([]);
  });

  it('says nothing about a short run of repeated marks', () => {
    // Four or five identical marks are ordinary: a rating row, pagination, an ellipsis,
    // a loading indicator. Only a run long enough to be a password counts.
    const { gray, w, h } = page();
    bullets(gray, { count: 5 });
    expect(findMaskedFields(gray, w, h)).toEqual([]);
  });

  it('says nothing about a solid bar', () => {
    const { gray, w, h } = page();
    for (let y = 170; y < 190; y++) {
      for (let x = 80; x < 400; x++) gray[y * W + x] = 30;
    }
    expect(findMaskedFields(gray, w, h)).toEqual([]);
  });

  it('says nothing when the spacing is irregular', () => {
    const { gray, w, h } = page();
    let x = 100;
    for (let i = 0; i < 12; i++) {
      dot(gray, x, 180, 3, 30);
      x += 9 + (i % 5) * 7;   // gaps from 9 to 37 px
    }
    expect(findMaskedFields(gray, w, h)).toEqual([]);
  });

  it('says nothing when the marks are different sizes', () => {
    const { gray, w, h } = page();
    for (let i = 0; i < 12; i++) dot(gray, 100 + i * 16, 180, 2 + (i % 4), 30);
    expect(findMaskedFields(gray, w, h)).toEqual([]);
  });

  it('finds two fields on the same line separately', () => {
    // A password and its confirmation, side by side. One region spanning both would mask
    // whatever sits between them.
    const { gray, w, h } = page();
    bullets(gray, { x: 60, count: 9, pitch: 11 });
    bullets(gray, { x: 380, count: 9, pitch: 11 });
    const found = findMaskedFields(gray, w, h);
    expect(found).toHaveLength(2);
    expect(found[0]!.x + found[0]!.w).toBeLessThan(found[1]!.x);
  });

  it('finds fields stacked on separate lines', () => {
    const { gray, w, h } = page();
    bullets(gray, { y: 120 });
    bullets(gray, { y: 220 });
    expect(findMaskedFields(gray, w, h)).toHaveLength(2);
  });

  it('survives a full-width dark bar without overflowing the stack', () => {
    // A toolbar is one connected component of a hundred thousand pixels. A recursive
    // flood fill dies here; this is why the search uses an explicit stack.
    const { gray, w, h } = page();
    for (let y = 0; y < 60; y++) gray.fill(20, y * W, y * W + W);
    bullets(gray);
    expect(() => findMaskedFields(gray, w, h)).not.toThrow();
    expect(findMaskedFields(gray, w, h).length).toBeGreaterThanOrEqual(1);
  });

  it('refuses inputs too small to mean anything', () => {
    expect(findMaskedFields(new Uint8Array(16), 4, 4)).toEqual([]);
    expect(findMaskedFields(new Uint8Array(10), 640, 360)).toEqual([]);
  });

  it('can be made stricter, and a stricter setting finds less', () => {
    const { gray, w, h } = page();
    bullets(gray, { count: 9 });
    expect(findMaskedFields(gray, w, h, DEFAULT_PRIVACY).length).toBe(1);
    expect(findMaskedFields(gray, w, h, { ...DEFAULT_PRIVACY, minGlyphs: 20 })).toEqual([]);
  });

  it('scales regions back onto the frame', () => {
    const scaled = scaleRegions([{ x: 10, y: 20, w: 30, h: 40 }], 1.5);
    expect(scaled).toEqual([{ x: 15, y: 30, w: 45, h: 60 }]);
  });
});
