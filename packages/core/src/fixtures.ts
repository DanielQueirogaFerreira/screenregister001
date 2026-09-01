import { THUMB_W, THUMB_H } from '@sr/schema';

/** Synthetic luma planes, so the decision logic can be tuned headlessly against
 *  reproducible motion instead of by staring at a real screen. */

export function solid(v: number): Uint8Array {
  return new Uint8Array(THUMB_W * THUMB_H).fill(v);
}

/** Paint an axis-aligned rectangle, in thumbnail pixel coordinates. */
export function withRect(
  base: Uint8Array,
  x: number,
  y: number,
  w: number,
  h: number,
  v: number,
): Uint8Array {
  const out = base.slice();
  for (let yy = y; yy < Math.min(y + h, THUMB_H); yy++) {
    for (let xx = x; xx < Math.min(x + w, THUMB_W); xx++) out[yy * THUMB_W + xx] = v;
  }
  return out;
}

/** Linear cross-fade between two pictures — stands in for a window switch animation. */
export function blend(a: Uint8Array, b: Uint8Array, t: number): Uint8Array {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = (a[i]! * (1 - t) + b[i]! * t) | 0;
  return out;
}

/** Shift the picture vertically — stands in for scrolling. */
export function scrolled(src: Uint8Array, dy: number): Uint8Array {
  const out = new Uint8Array(src.length);
  for (let y = 0; y < THUMB_H; y++) {
    const sy = (y + dy + THUMB_H * 10) % THUMB_H;
    out.set(src.subarray(sy * THUMB_W, sy * THUMB_W + THUMB_W), y * THUMB_W);
  }
  return out;
}

/**
 * A busy-looking desktop: pseudo-random horizontal bands.
 *
 * The row values must NOT be periodic over a short span. An earlier version used
 * `(y * 7) % 5`, which repeats every 5 rows — scrolling it returned to the exact
 * starting picture every 5 frames, and the transient detector correctly (but
 * uselessly) classified a scroll as a flicker. Real content is not periodic.
 */
export function desktop(seed = 0): Uint8Array {
  const out = new Uint8Array(THUMB_W * THUMB_H);
  for (let y = 0; y < THUMB_H; y++) {
    // Seed must enter BEFORE the multiply: xor-ing it in afterwards only touches low
    // bits that the shift discards, which silently made every seed render the same.
    const v = (Math.imul(y + 1 + seed * 977, 2654435761) >>> 17) & 0xff;
    out.fill(v, y * THUMB_W, y * THUMB_W + THUMB_W);
  }
  return out;
}

/** Sensor noise, so "static screen" tests are not unrealistically perfect. */
export function noisy(src: Uint8Array, amp = 2): Uint8Array {
  const out = src.slice();
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.max(0, Math.min(255, out[i]! + ((i * 2654435761) % (amp * 2 + 1)) - amp));
  }
  return out;
}
