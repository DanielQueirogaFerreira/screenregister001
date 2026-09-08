/**
 * Finding masked input fields in a captured frame.
 *
 * What this can and cannot do, stated plainly, because a privacy control that is trusted
 * and wrong is worse than none at all — people record things they would not have.
 *
 * `getDisplayMedia` hands over pixels and nothing else. When you share another
 * application's window the browser reports no structure whatsoever: no field types, no
 * coordinates, no DOM. There is no call that says "there is a password input here". So the
 * only available signal is what the field looks like, and the one thing a password field
 * reliably looks like is a row of identical glyphs — bullets, dots or asterisks — evenly
 * spaced on a common baseline. That signature is real and it is detectable.
 *
 * Therefore:
 *
 *   FOUND      a password field that is currently showing masked characters, which is the
 *              common case for "a password is on screen right now"
 *   NOT FOUND  a password typed in the clear, a field before anything is typed, a secret
 *              in a document, an API key in a terminal, a card number, a recovery phrase
 *
 * It is a reduction in exposure, not a guarantee of one. Anything that treats it as a
 * guarantee is misusing it.
 *
 * False positives are the expensive direction here, because the caller deletes the
 * unredacted frame when this returns a region. Everything below is tuned to say nothing
 * rather than to say something: a long run is required, and the run must be uniform in
 * both glyph size and spacing to a degree ordinary text never is.
 */

export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PrivacyOptions {
  /** Fewest repeated glyphs that can count as a masked field. */
  minGlyphs: number;
  /** How much glyph widths may vary, as a fraction of the mean. */
  widthTolerance: number;
  /** How much the gaps between glyphs may vary, as a fraction of the mean. */
  spacingTolerance: number;
  /** Ink threshold: how far from the local mean a pixel must be to count as drawn. */
  inkDelta: number;
}

/**
 * Deliberately strict.
 *
 * Eight glyphs rather than four: four repeated marks occur in ordinary interfaces — a
 * rating row, a pagination control, a loading indicator, an ellipsis — and a password
 * shorter than eight characters is rarer than any of them. The tolerances are tight for
 * the same reason: proportional text varies far more than this in both width and spacing,
 * so the uniformity test, not the binarisation, is what does the discriminating.
 */
export const DEFAULT_PRIVACY: PrivacyOptions = {
  minGlyphs: 8,
  widthTolerance: 0.22,
  spacingTolerance: 0.3,
  inkDelta: 38,
};

/** Glyph size limits, as a fraction of the scanned image's width. */
const MIN_GLYPH_FRAC = 0.002;
const MAX_GLYPH_FRAC = 0.02;
/** A masked field is a single line of text; anything taller is not one. */
const MAX_GLYPH_HEIGHT_FRAC = 0.06;

interface Blob {
  x0: number; y0: number; x1: number; y1: number; count: number;
}

/**
 * Connected components over "ink" pixels, four-connected, with an explicit stack.
 *
 * Recursion is not an option: a full-width dark bar is a single component spanning
 * hundreds of thousands of pixels, and that overflows the stack on the first dark toolbar
 * it meets.
 */
function components(ink: Uint8Array, w: number, h: number): Blob[] {
  const seen = new Uint8Array(w * h);
  const out: Blob[] = [];
  const stack: number[] = [];

  for (let start = 0; start < ink.length; start++) {
    if (!ink[start] || seen[start]) continue;
    seen[start] = 1;
    stack.length = 0;
    stack.push(start);

    const sx = start % w;
    const sy = (start / w) | 0;
    const blob: Blob = { x0: sx, y0: sy, x1: sx, y1: sy, count: 0 };

    while (stack.length) {
      const i = stack.pop()!;
      const x = i % w;
      const y = (i / w) | 0;
      blob.count++;
      if (x < blob.x0) blob.x0 = x;
      if (x > blob.x1) blob.x1 = x;
      if (y < blob.y0) blob.y0 = y;
      if (y > blob.y1) blob.y1 = y;

      if (x > 0 && ink[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack.push(i - 1); }
      if (x < w - 1 && ink[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack.push(i + 1); }
      if (y > 0 && ink[i - w] && !seen[i - w]) { seen[i - w] = 1; stack.push(i - w); }
      if (y < h - 1 && ink[i + w] && !seen[i + w]) { seen[i + w] = 1; stack.push(i + w); }
    }
    out.push(blob);
  }
  return out;
}

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Spread as a fraction of the mean. Zero mean returns Infinity so it can never pass. */
function relativeSpread(xs: number[]): number {
  const m = mean(xs);
  if (m <= 0) return Infinity;
  const variance = mean(xs.map((x) => (x - m) ** 2));
  return Math.sqrt(variance) / m;
}

/**
 * Mark pixels that differ from their neighbourhood's average brightness.
 *
 * Banded rather than global because a screen is not one scene: a dark editor beside a
 * white document has no single threshold that works for both. Bands of 24 rows are small
 * enough to sit inside one interface region and tall enough to contain a line of text.
 *
 * Both polarities count. A password field is dark bullets on white as often as it is light
 * bullets on a dark theme, and only looking for one of those misses half of them.
 */
function inkMask(gray: Uint8Array, w: number, h: number, delta: number): Uint8Array {
  const ink = new Uint8Array(w * h);
  const BAND = 24;
  for (let top = 0; top < h; top += BAND) {
    const bottom = Math.min(h, top + BAND);
    let sum = 0;
    for (let i = top * w; i < bottom * w; i++) sum += gray[i]!;
    const avg = sum / ((bottom - top) * w);
    for (let i = top * w; i < bottom * w; i++) {
      if (Math.abs(gray[i]! - avg) > delta) ink[i] = 1;
    }
  }
  return ink;
}

/**
 * Find rows of repeated, evenly spaced glyphs.
 *
 * @param gray  one byte of luminance per pixel, row-major
 */
export function findMaskedFields(
  gray: Uint8Array,
  w: number,
  h: number,
  opts: PrivacyOptions = DEFAULT_PRIVACY,
): Region[] {
  if (w < 32 || h < 16 || gray.length < w * h) return [];

  const minGlyph = Math.max(2, Math.floor(w * MIN_GLYPH_FRAC));
  const maxGlyph = Math.max(minGlyph + 1, Math.ceil(w * MAX_GLYPH_FRAC));
  const maxGlyphH = Math.max(4, Math.ceil(h * MAX_GLYPH_HEIGHT_FRAC));

  const glyphs = components(inkMask(gray, w, h, opts.inkDelta), w, h).filter((b) => {
    const bw = b.x1 - b.x0 + 1;
    const bh = b.y1 - b.y0 + 1;
    if (bw < minGlyph || bw > maxGlyph) return false;
    if (bh < minGlyph || bh > maxGlyphH) return false;
    // A mask glyph is roughly as tall as it is wide, and solid. A stroke of text or a
    // rule is neither.
    if (bw / bh > 2.2 || bh / bw > 2.6) return false;
    return b.count / (bw * bh) > 0.45;
  });

  // Group by baseline. Glyphs on one line share a bottom edge to within a pixel or two.
  const byRow = new Map<number, Blob[]>();
  for (const g of glyphs) {
    const key = Math.round(g.y1 / 3);
    const row = byRow.get(key);
    if (row) row.push(g);
    else byRow.set(key, [g]);
  }

  const regions: Region[] = [];
  for (const row of byRow.values()) {
    if (row.length < opts.minGlyphs) continue;
    row.sort((a, b) => a.x0 - b.x0);

    // Walk the row and take the longest stretch that stays uniform. A password field
    // sitting in a line beside other content should contribute its own run, not drag the
    // whole line's statistics out of tolerance.
    let run: Blob[] = [row[0]!];
    const flush = () => {
      if (run.length < opts.minGlyphs) return;
      const widths = run.map((g) => g.x1 - g.x0 + 1);
      const gaps: number[] = [];
      for (let i = 1; i < run.length; i++) gaps.push(run[i]!.x0 - run[i - 1]!.x0);
      if (relativeSpread(widths) > opts.widthTolerance) return;
      if (relativeSpread(gaps) > opts.spacingTolerance) return;
      // Glyphs that touch are a solid bar, not a row of marks.
      if (mean(gaps) <= mean(widths) * 1.05) return;

      const pad = Math.ceil(mean(widths));
      const x0 = Math.max(0, run[0]!.x0 - pad);
      const y0 = Math.max(0, Math.min(...run.map((g) => g.y0)) - pad);
      const x1 = Math.min(w - 1, run[run.length - 1]!.x1 + pad);
      const y1 = Math.min(h - 1, Math.max(...run.map((g) => g.y1)) + pad);
      regions.push({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 });
    };

    for (let i = 1; i < row.length; i++) {
      const prev = run[run.length - 1]!;
      const gap = row[i]!.x0 - prev.x0;
      const prevWidth = prev.x1 - prev.x0 + 1;
      // More than a few glyph-widths of empty space means a different field.
      if (gap > prevWidth * 5) {
        flush();
        run = [row[i]!];
      } else {
        run.push(row[i]!);
      }
    }
    flush();
  }
  return regions;
}

/** Scale regions found on the scan image back onto the frame's own pixels. */
export function scaleRegions(regions: Region[], factor: number): Region[] {
  return regions.map((r) => ({
    x: Math.floor(r.x * factor),
    y: Math.floor(r.y * factor),
    w: Math.ceil(r.w * factor),
    h: Math.ceil(r.h * factor),
  }));
}
