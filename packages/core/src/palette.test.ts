import { describe, expect, it } from 'vitest';
import {
  ADJACENT_MAX, ADJACENT_MIN, DISTANT_MIN, PALETTES, accentFor, accents, oklchHex,
  randomPalette, sectionId,
} from './palette.js';

const srgb = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
function oklab(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => srgb(v / 255)) as
    [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}
const dE = (a: string, b: string) => {
  const x = oklab(a); const y = oklab(b);
  return 100 * Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
};
/** WCAG relative luminance, for contrast against the panel these sit on. */
const lum = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => srgb(v / 255)) as
    [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};
const PANEL = '#151a21';

describe('oklchHex', () => {
  it('always produces a valid six-digit hex', () => {
    for (let h = 0; h < 360; h += 7) {
      expect(oklchHex(0.66, 0.12, h)).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('clamps out-of-gamut channels rather than wrapping them', () => {
    // Wrapping a channel that has left sRGB produces a colour from the far side of the
    // wheel — a hue nobody asked for, appearing exactly where the palette was pushed
    // hardest. Extreme chroma must degrade, not teleport.
    for (const c of [0.3, 0.5, 1]) {
      for (const h of [0, 90, 180, 270]) {
        expect(oklchHex(0.66, c, h), `C${c} H${h}`).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });

  it('is stable for a hue that has gone round the wheel', () => {
    expect(oklchHex(0.66, 0.12, 30)).toBe(oklchHex(0.66, 0.12, 390 % 360));
  });
});

describe('every shipped palette', () => {
  for (const p of PALETTES) {
    describe(p.name, () => {
      const run = accents(p, 8);

      it('changes enough between neighbours to notice, and not so much that it jolts', () => {
        for (let i = 1; i < run.length; i++) {
          const d = dE(run[i - 1]!, run[i]!);
          expect(d, `${p.name} ${i - 1}->${i}`).toBeGreaterThanOrEqual(ADJACENT_MIN);
          expect(d, `${p.name} ${i - 1}->${i}`).toBeLessThanOrEqual(ADJACENT_MAX);
        }
      });

      it('makes travelling three sections unmistakable', () => {
        // The half that says "you have moved". Without it every section looks like its
        // neighbour and the whole page reads as one undifferentiated wash.
        for (let i = 3; i < run.length; i++) {
          expect(dE(run[i - 3]!, run[i]!), `${p.name} ${i - 3}->${i}`)
            .toBeGreaterThanOrEqual(DISTANT_MIN);
        }
      });

      it('is legible on the panel it sits on', () => {
        for (const c of run) expect(contrast(c, PANEL), c).toBeGreaterThanOrEqual(3);
      });

      it('does not read as grey', () => {
        // An accent whose job is peripheral awareness cannot be grey. One of these was,
        // at chroma 0.075, until the validator said so.
        for (const c of run) {
          const [, a, b] = oklab(c);
          expect(Math.hypot(a, b), c).toBeGreaterThanOrEqual(0.095);
        }
      });

      it('gives every accent the same weight, so none shouts', () => {
        const ls = run.map((c) => oklab(c)[0]);
        expect(Math.max(...ls) - Math.min(...ls)).toBeLessThan(0.06);
      });
    });
  }
});

describe('randomPalette', () => {
  it('cannot produce an unusable page, however the dice fall', () => {
    // A "surprise me" that can hand back something illegible is not a feature. Every draw
    // has to satisfy the same rules the shipped palettes do — and a wide sweep is the
    // point: a degree of hue is not a fixed amount of perceived change, so a step that is
    // safe starting at 210 degrees can fail starting at 295. Both bounds were corrected by
    // this test rather than by looking.
    let seed = 1;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let t = 0; t < 600; t++) {
      const p = randomPalette(rand);
      const run = accents(p, 8);
      for (let i = 1; i < run.length; i++) {
        const d = dE(run[i - 1]!, run[i]!);
        expect(d, `${p.name} adj ${i}`).toBeGreaterThanOrEqual(ADJACENT_MIN);
        expect(d, `${p.name} adj ${i}`).toBeLessThanOrEqual(ADJACENT_MAX);
      }
      for (let i = 3; i < run.length; i++) {
        expect(dE(run[i - 3]!, run[i]!), `${p.name} far ${i}`).toBeGreaterThanOrEqual(DISTANT_MIN);
      }
      for (const c of run) expect(contrast(c, PANEL), `${p.name} ${c}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('is reproducible from a seed', () => {
    const mk = () => { let s = 7; return () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648); };
    expect(randomPalette(mk())).toEqual(randomPalette(mk()));
  });
});

describe('accentFor', () => {
  it('wraps past the end of the wheel instead of running off it', () => {
    const p = PALETTES[0]!;
    expect(accentFor(p, 40)).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('sectionId', () => {
  it('is three digits, zero-padded, counting from one', () => {
    // Same width every time is what lets a column of badges read as a sequence rather
    // than as ragged text.
    expect(sectionId(0)).toBe('001');
    expect(sectionId(8)).toBe('009');
    expect(sectionId(98)).toBe('099');
    expect([...Array(20).keys()].every((i) => sectionId(i).length === 3)).toBe(true);
  });

  it('wraps rather than growing a fourth digit', () => {
    expect(sectionId(999)).toBe('001');
  });
});
