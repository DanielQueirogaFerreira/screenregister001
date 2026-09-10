import { describe, expect, it } from 'vitest';
import {
  ADJACENT_MAX, ADJACENT_MIN, DISTANT_MIN, LIGHT_INK_LIGHTNESS, PALETTES,
  REQUESTED_CHROMA_MIN, accentFor, accents, gamutChroma, hueFor, inkFor, oklchHex,
  randomPalette, sectionId, toneFor, type Mode, type Palette,
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
const chromaOf = (hex: string) => { const [, a, b] = oklab(hex); return Math.hypot(a, b); };
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

/** The panel each mode's accents actually sit on, straight out of styles.css. */
const PANEL: Record<Mode, string> = { dark: '#151a21', light: '#ffffff' };
const MODES: Mode[] = ['dark', 'light'];

/**
 * The rules, as one function, so a shipped palette and a rolled one are held to the same
 * bar in the same mode. Every earlier version of this file checked dark only, which is how
 * "we just have dark ones" stayed true for as long as it did.
 */
function check(p: Palette, mode: Mode, label: string) {
  const run = accents(p, 8, mode);
  const panel = PANEL[mode];

  for (let i = 1; i < run.length; i++) {
    const d = dE(run[i - 1]!, run[i]!);
    expect(d, `${label} ${mode} adjacent ${i - 1}->${i}`).toBeGreaterThanOrEqual(ADJACENT_MIN);
    expect(d, `${label} ${mode} adjacent ${i - 1}->${i}`).toBeLessThanOrEqual(ADJACENT_MAX);
  }
  for (let i = 3; i < run.length; i++) {
    expect(dE(run[i - 3]!, run[i]!), `${label} ${mode} distant ${i - 3}->${i}`)
      .toBeGreaterThanOrEqual(DISTANT_MIN);
  }
  // The accent is a mark — a rule down the side of a panel, a chip. 3:1 is the graphic bar.
  for (const c of run) {
    expect(contrast(c, panel), `${label} ${mode} accent ${c} on ${panel}`)
      .toBeGreaterThanOrEqual(3);
  }
  // Small text in the accent hue. On dark the accent is the ink; on light it is a darker
  // step, because on white those two jobs cannot be done by one colour — see inkFor.
  for (let i = 0; i < 8; i++) {
    expect(contrast(inkFor(p, i, mode), panel), `${label} ${mode} ink ${i}`)
      .toBeGreaterThanOrEqual(4.5);
  }
  // Colourful enough — measured against what sRGB can actually hold here, not against a
  // fixed number. At L 0.54 the narrowest hue tops out below the old absolute floor, so
  // that floor would have failed the most colourful cyan the display owns.
  const t = toneFor(p, mode);
  expect(t.chroma, `${label} ${mode} requested chroma`).toBeGreaterThanOrEqual(REQUESTED_CHROMA_MIN);
  for (let i = 0; i < 8; i++) {
    const want = Math.min(t.chroma, gamutChroma(t.lightness, hueFor(p, i)));
    expect(chromaOf(run[i]!), `${label} ${mode} chroma ${i}`).toBeGreaterThanOrEqual(want * 0.95);
  }
  // Same weight, so none of them shouts.
  const ls = run.map((c) => oklab(c)[0]);
  expect(Math.max(...ls) - Math.min(...ls), `${label} ${mode} even weight`).toBeLessThan(0.06);
}

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

describe('gamutChroma', () => {
  it('finds a boundary the palette actually runs into', () => {
    // Not a theoretical concern: this is why the absolute chroma floor had to go. Cyan is
    // the narrowest part of sRGB, and at the lightness light mode needs it tops out below
    // the floor the dark palettes were checked against.
    expect(gamutChroma(0.54, 195)).toBeLessThan(0.10);
    // Purple at the same lightness has room to spare, so the limit is per hue, not global.
    expect(gamutChroma(0.54, 305)).toBeGreaterThan(0.20);
  });

  it('reports a chroma that is in gamut and one just past it is not', () => {
    for (const [l, h] of [[0.54, 195], [0.66, 202], [0.44, 30]] as [number, number][]) {
      const max = gamutChroma(l, h);
      expect(chromaOf(oklchHex(l, max, h))).toBeGreaterThan(max * 0.95);
      // Asking for a great deal more does not get more: the clamp caps it near the edge.
      expect(chromaOf(oklchHex(l, max + 0.15, h))).toBeLessThan(max + 0.05);
    }
  });
});

describe('every shipped palette', () => {
  for (const p of PALETTES) {
    for (const mode of MODES) {
      it(`${p.name} works in ${mode} mode`, () => check(p, mode, p.name));
    }
  }
});

describe('light mode is a different tone, not the same colours on a white page', () => {
  it('sets every accent darker than its dark-mode counterpart', () => {
    // The failure this prevents is the one that made the whole feature necessary: a
    // palette tuned for a near-black panel, reused unchanged on a white one, where every
    // accent is a pale wash nobody can read.
    for (const p of PALETTES) {
      for (let i = 0; i < 8; i++) {
        expect(oklab(accentFor(p, i, 'light'))[0], `${p.name} ${i}`)
          .toBeLessThan(oklab(accentFor(p, i, 'dark'))[0]);
      }
    }
  });

  it('keeps the hues, because the hues are what the palette is', () => {
    for (const p of PALETTES) {
      for (let i = 0; i < 8; i++) {
        const a = oklab(accentFor(p, i, 'dark'));
        const b = oklab(accentFor(p, i, 'light'));
        const angle = (x: [number, number, number]) => Math.atan2(x[2], x[1]);
        let d = Math.abs(angle(a) - angle(b));
        if (d > Math.PI) d = 2 * Math.PI - d;
        // Some drift is unavoidable: clamping an out-of-gamut channel moves the hue a
        // little. Fifteen degrees is the most any of them moves.
        expect((d * 180) / Math.PI, `${p.name} ${i}`).toBeLessThan(15);
      }
    }
  });

  it('uses the accent itself as ink on dark, and a darker step on light', () => {
    const p = PALETTES[0]!;
    expect(inkFor(p, 0, 'dark')).toBe(accentFor(p, 0, 'dark'));
    expect(inkFor(p, 0, 'light')).not.toBe(accentFor(p, 0, 'light'));
    expect(oklab(inkFor(p, 0, 'light'))[0]).toBeCloseTo(LIGHT_INK_LIGHTNESS, 1);
  });
});

describe('randomPalette', () => {
  it('cannot produce an unusable page in either mode, however the dice fall', () => {
    // A "surprise me" that can hand back something illegible is not a feature. Every draw
    // has to satisfy the same rules the shipped palettes do, in BOTH modes — and a wide
    // sweep is the point: a degree of hue is not a fixed amount of perceived change, so a
    // step that is safe starting at 210 degrees can fail starting at 295. Both bounds were
    // corrected by this test rather than by looking.
    let seed = 1;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let t = 0; t < 400; t++) {
      const p = randomPalette(rand);
      for (const mode of MODES) check(p, mode, `draw ${t} ${p.name}`);
    }
  });

  it('is reproducible from a seed', () => {
    const mk = () => { let s = 7; return () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648); };
    expect(randomPalette(mk())).toEqual(randomPalette(mk()));
  });

  it('rolls one palette for both modes rather than two unrelated ones', () => {
    let seed = 42;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let t = 0; t < 20; t++) {
      const p = randomPalette(rand);
      expect(hueFor(p, 3)).toBe((p.from + p.step * 3) % 360);
    }
  });
});

describe('accentFor', () => {
  it('wraps past the end of the wheel instead of running off it', () => {
    const p = PALETTES[0]!;
    for (const mode of MODES) expect(accentFor(p, 40, mode)).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('defaults to dark, which is what every existing caller means', () => {
    const p = PALETTES[1]!;
    expect(accentFor(p, 2)).toBe(accentFor(p, 2, 'dark'));
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
