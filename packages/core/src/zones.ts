/**
 * Areas of the screen that are never captured.
 *
 * This is the only privacy control in the system that offers a guarantee rather than a
 * probability. `findMaskedFields` recognises a password field by its shape and misses
 * anything that does not have that shape; `findSecrets` reads text and misses whatever OCR
 * misreads. Both reduce exposure. Neither can promise anything, and both cost work on
 * every frame.
 *
 * A zone promises: the pixels inside it are painted over at ingest, before the diff runs,
 * before a thumbnail exists, before anything is encoded. Nothing downstream ever sees
 * them, so nothing downstream can leak them. It costs one rectangle fill per sampled
 * frame, which is nothing.
 *
 * The trade is that it is manual and static. It protects the corner where a password
 * manager opens, the panel where a terminal always sits, the region of a second monitor
 * that shows a dashboard — the places a person can name in advance. It cannot follow a
 * window that moves, and it does not know what is inside it.
 *
 * **Coordinates are fractions of the frame, never pixels.** During one afternoon of
 * development this project's capture went from 768x1366 to 1920x1366 to 1920x1080: a zone
 * stored in pixels would have kept pointing confidently at the wrong part of the screen,
 * which for a privacy control is the worst possible failure — it would look configured
 * and cover nothing.
 */

import type { Zone } from '@sr/schema';
import type { Region } from './privacy.js';

export type { Zone };

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/**
 * Put a zone into canonical form: inside the frame, with positive width and height.
 *
 * Dragging up and to the left is the natural way to select the top-left corner of a
 * screen, and it produces a negative width. Storing that verbatim gives a rectangle that
 * draws as nothing, so a person would mark an area, see no black box, and conclude the
 * feature does not work — while believing they were protected.
 */
export function normaliseZone(z: Zone): Zone {
  const x0 = clamp01(Math.min(z.x, z.x + z.w));
  const y0 = clamp01(Math.min(z.y, z.y + z.h));
  const x1 = clamp01(Math.max(z.x, z.x + z.w));
  const y1 = clamp01(Math.max(z.y, z.y + z.h));
  return { ...z, x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * The pixel rectangle to paint, rounded OUTWARDS.
 *
 * Rounding to nearest would leave a fringe of original pixels along an edge whenever the
 * fraction lands mid-pixel. On a 4K frame that fringe is wide enough to read a line of
 * text. Always covering slightly more than asked is the only rounding a redaction can
 * afford.
 */
export function zoneRect(z: Zone, frameW: number, frameH: number): Region {
  const n = normaliseZone(z);
  const x = Math.floor(n.x * frameW);
  const y = Math.floor(n.y * frameH);
  const x1 = Math.ceil((n.x + n.w) * frameW);
  const y1 = Math.ceil((n.y + n.h) * frameH);
  return {
    x: Math.max(0, x),
    y: Math.max(0, y),
    w: Math.min(frameW, x1) - Math.max(0, x),
    h: Math.min(frameH, y1) - Math.max(0, y),
  };
}

/** Zones worth drawing: canonical, and big enough to be a deliberate act. */
export function usableZones(zones: Zone[]): Zone[] {
  return zones
    .map(normaliseZone)
    // A zone under a thousandth of the frame in either direction is a stray click, not an
    // instruction. Drawing it would put an invisible speck on every frame and give someone
    // a list entry they cannot see or find again.
    .filter((z) => z.w >= 0.001 && z.h >= 0.001);
}

/**
 * The share of the frame the zones cover, overlaps counted once.
 *
 * Sampled on a grid rather than solved exactly: the answer is shown to a person deciding
 * whether they have blacked out more than they meant to, and at that job a tenth of a
 * percent of error is invisible while an inclusion-exclusion implementation is somewhere
 * a bug could hide.
 */
export function coveredFraction(zones: Zone[], steps = 200): number {
  const list = usableZones(zones);
  if (list.length === 0) return 0;
  let hit = 0;
  for (let i = 0; i < steps; i++) {
    const px = (i + 0.5) / steps;
    for (let j = 0; j < steps; j++) {
      const py = (j + 0.5) / steps;
      if (list.some((z) => px >= z.x && px < z.x + z.w && py >= z.y && py < z.y + z.h)) hit++;
    }
  }
  return hit / (steps * steps);
}
