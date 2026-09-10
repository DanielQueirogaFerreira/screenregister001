/**
 * Section accents, so scrolling tells you where you are — in either colour mode.
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
 *
 * A palette is hue GEOMETRY plus one TONE per colour mode. The geometry is the palette's
 * identity and is shared; the tone is not transferable. An accent tuned to sit on a
 * near-black panel is far too light to sit on a white one — it does not merely look worse,
 * it stops being readable — so "the same palette in light mode" has to mean the same hues
 * at a different lightness and chroma, not the same colours on a different background.
 */

export type Mode = 'dark' | 'light';

/** Lightness and chroma for one colour mode. Every accent in a run shares them. */
export interface Tone {
  lightness: number;
  chroma: number;
}

export interface Palette {
  id: string;
  name: string;
  /** Where the hue wheel starts, in degrees. Shared by both modes. */
  from: number;
  /** How far apart consecutive sections sit on the wheel. Shared by both modes. */
  step: number;
  /** The tone on a near-black surface. */
  dark: Tone;
  /** The tone on a near-white surface. */
  light: Tone;
}

/**
 * Three that ship.
 *
 * "Drift" walks a short arc so neighbours are close cousins; "Signal" takes bigger steps
 * for a page whose sections are unrelated; "Dusk" is the quiet one, lower chroma, for
 * reading rather than scanning. Each carries both tones: the light one is darker and more
 * chromatic, which is what keeps the same hue readable when the ground is white instead of
 * black.
 */
export const PALETTES: Palette[] = [
  {
    id: 'drift', name: 'Drift', from: 214, step: 28,
    dark: { lightness: 0.66, chroma: 0.115 },
    light: { lightness: 0.54, chroma: 0.155 },
  },
  {
    id: 'signal', name: 'Signal', from: 196, step: 36,
    dark: { lightness: 0.66, chroma: 0.13 },
    light: { lightness: 0.54, chroma: 0.14 },
  },
  {
    id: 'dusk', name: 'Dusk', from: 262, step: 34,
    dark: { lightness: 0.63, chroma: 0.10 },
    light: { lightness: 0.55, chroma: 0.125 },
  },
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
 *
 * All three bounds apply in BOTH modes. They are perceptual distances, and the eye does
 * not get more tolerant because the page went white.
 */
export const ADJACENT_MIN = 4;
// 10, not 9. The first figure was my own round number rather than a measured one, and a
// 200-draw sweep found a legitimate palette at ΔE 9.07. Ten is still a gentle step — the
// categorical floor, where colours must be told apart at a glance, is fifteen.
export const ADJACENT_MAX = 10;
export const DISTANT_MIN = 14;

/**
 * The lowest chroma a palette may ASK for. Distinct from what it gets — see `gamutChroma`.
 *
 * This is the bound that stops someone choosing a colour that is grey by intent. It is not
 * the bound that decides whether a rendered accent is colourful enough, because at low
 * lightness sRGB simply cannot hold much chroma in some hues, and a test that ignores that
 * calls the bluest blue the display owns "grey".
 */
export const REQUESTED_CHROMA_MIN = 0.10;

// --- OKLCH to sRGB ----------------------------------------------------------------------

const toSrgb = (c: number) =>
  c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;

/** Linear sRGB for an OKLCH triple, unclamped — negative and >1 mean out of gamut. */
function linearRgb(l: number, c: number, hDeg: number): [number, number, number] {
  const h = (hDeg * Math.PI) / 180;
  const a = Math.cos(h) * c;
  const b = Math.sin(h) * c;

  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.2914855480 * b;

  const L = l_ * l_ * l_;
  const M = m_ * m_ * m_;
  const S = s_ * s_ * s_;

  return [
    +4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S,
    -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S,
    -0.0041960863 * L - 0.7034186147 * M + 1.7076147010 * S,
  ];
}

/** OKLCH to a hex string, clamped into sRGB. */
export function oklchHex(l: number, c: number, hDeg: number): string {
  return '#' + linearRgb(l, c, hDeg).map((v) => {
    // Clamped, not wrapped. A channel that has left the gamut has to land somewhere, and
    // wrapping it produces a colour from the far side of the wheel — a hue from nowhere,
    // appearing exactly where the palette was pushed hardest.
    const n = Math.round(Math.max(0, Math.min(1, toSrgb(Math.max(0, Math.min(1, v))))) * 255);
    return n.toString(16).padStart(2, '0');
  }).join('');
}

/**
 * The most chroma sRGB can hold at this lightness and hue.
 *
 * This exists because the obvious "is it colourful enough" test is wrong at low lightness,
 * and wrong in a way that looks like a real failure. At L 0.52 the narrowest hue is cyan
 * around 195°, where sRGB tops out at chroma 0.089 — below the absolute floor the dark
 * palettes were checked against. A cyan sitting exactly on that boundary is the most
 * colourful cyan the display owns; calling it grey measures the monitor, not the palette.
 *
 * The dark palettes ride this boundary too — Drift's worst hue at L 0.66 measures 0.112
 * against a gamut maximum of 0.112 — so they were only ever clearing the absolute floor by
 * where the boundary happens to sit, not by design.
 */
export function gamutChroma(l: number, hDeg: number): number {
  let lo = 0;
  let hi = 0.5;
  for (let i = 0; i < 32; i++) {
    const mid = (lo + hi) / 2;
    if (linearRgb(l, mid, hDeg).every((v) => v >= -1e-4 && v <= 1 + 1e-4)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** The tone a palette uses in this mode. */
export const toneFor = (p: Palette, mode: Mode = 'dark'): Tone =>
  mode === 'light' ? p.light : p.dark;

/** The hue for section `i`, in degrees. Shared by both modes — it is the palette's shape. */
export const hueFor = (p: Palette, i: number): number => (p.from + p.step * i) % 360;

/** The accent for section `i` under a palette: the mark itself — a rule, a chip, a border. */
export function accentFor(p: Palette, i: number, mode: Mode = 'dark'): string {
  const t = toneFor(p, mode);
  return oklchHex(t.lightness, t.chroma, hueFor(p, i));
}

/**
 * The same hue, but safe to set small text in.
 *
 * On a dark panel the accent is already the text colour — it clears 4.7:1 there. On a white
 * one it cannot be: against pure white, a hue light enough to satisfy the adjacency bounds
 * and a hue dark enough for 4.5:1 small text are mutually exclusive, which a sweep of every
 * lightness and chroma in range confirmed rather than a hunch. Rather than bend one of the
 * perceptual bounds to fit, light mode sets its badge text in a darker step of the same
 * hue — 6.5:1 at worst — and leaves the accent to do the job accents are good at.
 */
export function inkFor(p: Palette, i: number, mode: Mode = 'dark'): string {
  if (mode !== 'light') return accentFor(p, i, mode);
  return oklchHex(LIGHT_INK_LIGHTNESS, p.light.chroma, hueFor(p, i));
}

/** Lightness for light-mode text in an accent hue. 0.44 measures 6.58:1 on white at worst. */
export const LIGHT_INK_LIGHTNESS = 0.44;

/** The whole run of accents a page of `n` sections uses. */
export const accents = (p: Palette, n: number, mode: Mode = 'dark'): string[] =>
  Array.from({ length: n }, (_, i) => accentFor(p, i, mode));

/**
 * A palette made up on the spot, but not at random — and usable in both modes.
 *
 * A genuinely random hue step lands on 3° as readily as on 150°, and both are wrong: one
 * is invisible, the other is a jolt at every boundary. The step is drawn from the range
 * that reads as a change without being one, and each mode's lightness and chroma stay
 * inside the band its fixed palettes use, so a generated palette cannot come out shouting
 * on either ground. Shuffle rolls one palette, not one colour scheme: the same hues answer
 * for dark and for light.
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
  const r3 = (n: number) => Math.round(n * 1000) / 1000;
  // Light mode's chroma band is narrower at the top than dark's. A step of 37° at chroma
  // 0.15 on a light ground measures ΔE 10.2 between neighbours — over the jolt bound —
  // because the same hue step covers more perceptual ground where there is more chroma
  // to cover it with.
  return {
    id: `custom-${from}-${step}`,
    name: `Custom ${from}°/${step}°`,
    from, step,
    dark: {
      lightness: r3(0.63 + rand() * 0.035),           // 0.630..0.665
      chroma: r3(0.105 + rand() * 0.03),              // 0.105..0.135
    },
    light: {
      lightness: r3(0.535 + rand() * 0.025),          // 0.535..0.560
      chroma: r3(0.125 + rand() * 0.02),              // 0.125..0.145
    },
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
