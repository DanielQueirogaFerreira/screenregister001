import { GRID_COLS, GRID_ROWS, THUMB_W, THUMB_H, TILE_COUNT } from '@sr/schema';

export interface DiffResult {
  /** Fraction of grid tiles whose change exceeded the threshold, 0..1. */
  changeScore: number;
  /** Indices of the tiles that changed — a free activity heatmap. */
  changedTiles: number[];
  /** Strongest single-tile difference. Catches small-area, high-intensity changes. */
  maxTileMad: number;
  /** Mean absolute difference across the whole frame. Useful for debugging/tuning. */
  meanMad: number;
}

export const EMPTY_DIFF: DiffResult = {
  changeScore: 0,
  changedTiles: [],
  maxTileMad: 0,
  meanMad: 0,
};

/**
 * Rec. 709 luma from RGBA. We diff on luminance rather than per-channel RGB because
 * chroma noise from the video encoder is far larger than luma noise, so RGB diffing
 * makes a static screen look like it is constantly changing.
 */
export function toLuma(rgba: Uint8ClampedArray | Uint8Array, out?: Uint8Array): Uint8Array {
  const n = rgba.length >> 2;
  const luma = out ?? new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    luma[i] = (0.2126 * rgba[j]! + 0.7152 * rgba[j + 1]! + 0.0722 * rgba[j + 2]!) | 0;
  }
  return luma;
}

/**
 * Tile-wise mean absolute difference between two THUMB_W x THUMB_H luma planes.
 *
 * Grid-based rather than a single whole-frame number because *where* a change
 * happened is worth as much as *whether* it did: one changed tile in a corner is a
 * clock ticking, forty tiles in the middle is a new window.
 */
export function diffLuma(a: Uint8Array, b: Uint8Array, tileThreshold: number): DiffResult {
  const tileW = THUMB_W / GRID_COLS; // 10
  const tileH = THUMB_H / GRID_ROWS; // 10
  const perTile = tileW * tileH;
  const changedTiles: number[] = [];
  let maxTileMad = 0;
  let totalDiff = 0;

  for (let ty = 0; ty < GRID_ROWS; ty++) {
    for (let tx = 0; tx < GRID_COLS; tx++) {
      let sum = 0;
      const x0 = tx * tileW;
      const y0 = ty * tileH;
      for (let y = y0; y < y0 + tileH; y++) {
        const row = y * THUMB_W;
        for (let x = x0; x < x0 + tileW; x++) {
          const d = a[row + x]! - b[row + x]!;
          sum += d < 0 ? -d : d;
        }
      }
      totalDiff += sum;
      const mad = sum / perTile;
      if (mad > maxTileMad) maxTileMad = mad;
      if (mad > tileThreshold) changedTiles.push(ty * GRID_COLS + tx);
    }
  }

  return {
    changeScore: changedTiles.length / TILE_COUNT,
    changedTiles,
    maxTileMad: Math.round(maxTileMad * 100) / 100,
    meanMad: Math.round((totalDiff / (THUMB_W * THUMB_H)) * 100) / 100,
  };
}
