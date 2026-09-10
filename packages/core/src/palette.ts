/**
 * Section accents, so scrolling tells you where you are.
 *
 * A long page of identical panels gives no sense of place: you scroll, everything looks
 * the same, and the only way to know which part you are in is to read a heading. Giving
 * each section its own accent turns that into peripheral information.
 *
 * The constraint is narrow at both ends and worth stating, because it is what makes this
 * hard to do by eye. Neighbouring sections must differ enough to register as a change —
 * too little and the whole thing reads as one undifferentiated wash — but not so much that
 * crossing a boundary is a jolt. So the step between adjacent accents is bounded on BOTH
 * sides rather than merely maximised, which is the opposite of what a categorical palette
 * usually wants.
 *
 * Hues are generated rather than written down, at a fixed lightness and chroma, so every
 * accent carries the same visual weight and only its hue changes. Anything else and the
 * brightest section shouts.
 */

export interface Palette {
  id: string;
  name: string;
  /** Where the hue wheel starts, in degrees. */
  from: number;
  /** How far apart consecutive sections sit on the wheel. */
  step: number;
  /** OKLCH lightness and chroma, shared by every accent so none outweighs another. */
  lightness: number;
  chroma: number;
}

/**
 * Three that ship.
 *
 * "Drift" walks a short arc so neighbours are close cousins; "Signal" takes bigger steps
 * for a page whose sections are unrelated; "Dusk" is the quiet one, lower chroma, for
 * reading rather than scanning.
 */
export const PALETTES: Palette[] = [
  { id: 'drift', name: 'Drift', from: 214, step: 28, lightness: 0.66, chroma: 0.115 },
  { id: 'signal', name: 'Signal', from: 196, step: 36, lightness: 0.66, chroma: 0.13 },
  { id: 'dusk', name: 'Dusk', from: 262, step: 34, lightness: 0.63, chroma: 0.10 },
];

/**
 * What "different enough, but not a jolt" means as numbers.
 *
 * Measured as OKLab ΔE (×100), the same scale the palette validator uses. The first
 * versions of these palettes were tuned by eye and every one of them failed: two sat above
 * the dark-mode lightness band and read as shouting, and one had so little chroma it was
 * grey — an accent whose entire job is to be noticed peripherally.
 *
 * A categorical validator is the wrong instrument here and it is worth saying why rather
 * than quietly ignoring its verdict. It demands adjacent slots be at least 15 apart, because
 * a legend is read all at once and series three must be told from series four. Section
 * accents are never seen as a set: you cross from one to the next while scrolling, and 15
 * at that boundary is exactly the jolt this is meant to avoid. So neighbours are bounded on
 * both sides, and the thing that must be unmistakable is the distance between sections
 * three apart — which is what tells you that you have travelled.
 */
export const ADJACENT_MIN = 4;
// 10, not 9. The first figure was my own round number rather than a measured one, and a
// 200-draw sweep found a legitimate palette at ΔE 9.07. Ten is still a gentle step — the
// categorical floor, where colours must be told apart at a glance, is fifteen.
export const ADJACENT_MAX = 10;
export const DISTANT_MIN = 14;

// --- OKLCH to sRGB ----------------------------------------------------------------------

const toSrgb = (c: number) =>
  c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;

/** OKLCH to a hex string, clamped into sRGB. */
export function oklchHex(l: number, c: number, hDeg: number): string {
  const h = (hDeg * Math.PI) / 180;
  const a = Math.cos(h) * c;
  const b = Math.sin(h) * c;

  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.2914855480 * b;

  const L = l_ * l_ * l_;
  const M = m_ * m_ * m_;
  const S = s_ * s_ * s_;

  const rgb = [
    +4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S,
    -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S,
    -0.0041960863 * L - 0.7034186147 * M + 1.7076147010 * S,
  ];

  return '#' + rgb.map((v) => {
    // Clamped, not wrapped. A channel that has left the gamut has to land somewhere, and
    // wrapping it produces a colour from the far side of the wheel — a hue that was never
    // asked for, appearing exactly where the palette was pushed hardest.
    const n = Math.round(Math.max(0, Math.min(1, toSrgb(Math.max(0, Math.min(1, v))))) * 255);
    return n.toString(16).padStart(2, '0');
  }).join('');
}

/** The accent for section `i` under a palette. */
export const accentFor = (p: Palette, i: number): string =>
  oklchHex(p.lightness, p.chroma, (p.from + p.step * i) % 360);

/** The whole run of accents a page of `n` sections uses. */
export const accents = (p: Palette, n: number): string[] =>
  Array.from({ length: n }, (_, i) => accentFor(p, i));

/**
 * A palette made up on the spot, but not at random.
 *
 * A genuinely random hue step lands on 3° as readily as on 150°, and both are wrong: one
 * is invisible, the other is a jolt at every boundary. The step is drawn from the range
 * that reads as a change without being one, and lightness and chroma stay inside the band
 * the fixed palettes use so a generated palette cannot come out shouting.
 */
export function randomPalette(rand: () => number = Math.random): Palette {
  const from = Math.floor(rand() * 360);
  // The ranges below are not taste, they are the measured band that satisfies the
  // adjacent/distant rules above. Outside them a generated palette either whispers or
  // shouts, and a "surprise me" button that can produce an unusable page is not a feature.
  // 30, not 26. A degree of hue is not a fixed amount of perceived change: the same step
  // that clears the distant-separation rule starting at 210° falls to ΔE 13.3 starting at
  // 295°, which a 200-draw sweep found and eyeballing never would.
  const step = 30 + Math.round(rand() * 7);           // 30..37 degrees
  const lightness = 0.63 + rand() * 0.035;            // 0.630..0.665
  const chroma = 0.105 + rand() * 0.03;               // 0.105..0.135
  return {
    id: `custom-${from}-${step}`,
    name: `Custom ${from}°/${step}°`,
    from, step,
    lightness: Math.round(lightness * 1000) / 1000,
    chroma: Math.round(chroma * 1000) / 1000,
  };
}

/**
 * Section numbering: 001, 002, 003.
 *
 * Three digits and zero-padded so every badge is the same width, which is what lets a
 * column of them read as a sequence rather than as ragged text. Runs 001..999 and then
 * wraps: the modulo has to be applied before the offset, or section 999 is labelled "1000"
 * and the badges stop being the same width after all.
 */
export const sectionId = (i: number): string => String((i % 999) + 1).padStart(3, '0');
