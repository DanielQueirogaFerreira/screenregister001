/**
 * Where the frame's stamp goes, and how big.
 *
 * Separated from the drawing so it can be checked without a canvas. The drawing itself is
 * four calls to a 2D context and is hard to get wrong; the arithmetic that decides where
 * the box lands, whether it stays inside the frame, and how much of the picture it covers
 * is where the mistakes live — and a stamp that has drifted off the edge or grown to cover
 * a quarter of the screen is not something a test of "did it draw" would notice.
 *
 * Bottom-left because interfaces put their content top-left and their own status bars
 * bottom-right; the lower left corner is the emptiest part of a typical screen, so it is
 * the least likely place to cover something that matters.
 */

export interface StampLayout {
  fontSize: number;
  /** The scrim, in frame pixels. */
  box: { x: number; y: number; w: number; h: number };
  /** Text baselines, in frame pixels, one per line. */
  baselines: { x: number; y: number }[];
}

/** Small enough to ignore, large enough to read on a phone looking at a 4K capture. */
const MIN_FONT = 9;
const MAX_FONT = 15;

export function stampLayout(
  frameW: number,
  frameH: number,
  lineCount: number,
  /** Width of the widest line, as the canvas measures it at `fontSize`. */
  textWidth: number,
): StampLayout {
  const w = Math.max(1, frameW);
  const h = Math.max(1, frameH);

  // Scales with the frame so it stays readable at 720p and does not dominate at 4K.
  const fontSize = Math.max(MIN_FONT, Math.min(MAX_FONT, Math.round(w / 110)));
  const pad = Math.round(fontSize * 0.6);
  const lineHeight = Math.round(fontSize * 1.35);

  const wanted = textWidth + pad * 2;
  // Clamped, because a long stamp on a narrow frame would otherwise run off the right
  // edge — 39 characters of monospace need about 350px, which is more than a phone-width
  // capture has to spare. The text is then wider than its scrim, which is the better
  // failure: legible and overhanging, rather than a scrim drawn outside the picture.
  const boxW = Math.min(wanted, w - pad * 2);
  const boxH = lineHeight * lineCount + pad;

  const x = pad;
  // Never above the top edge: a frame shorter than the stamp pins it to the top rather
  // than placing it at a negative y, where nothing would be drawn at all.
  const y = Math.max(0, h - boxH - pad);

  const baselines = Array.from({ length: lineCount }, (_, i) => ({
    x: x + pad,
    y: y + pad / 2 + lineHeight * (i + 1) - Math.round(fontSize * 0.25),
  }));

  return { fontSize, box: { x, y, w: Math.max(0, boxW), h: boxH }, baselines };
}

/** What fraction of the frame the scrim covers. */
export const stampCoverage = (l: StampLayout, frameW: number, frameH: number): number =>
  (l.box.w * l.box.h) / Math.max(1, frameW * frameH);
