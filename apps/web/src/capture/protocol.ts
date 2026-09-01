import type { CaptureSettings, StoreReason } from '@sr/schema';
import type { ProcessorStats, ActivityPoint } from '@sr/core';

export type ToWorker =
  | { type: 'start'; settings: CaptureSettings }
  | { type: 'frame'; bitmap: ImageBitmap; seq: number; tMs: number }
  | { type: 'settings'; settings: CaptureSettings }
  | { type: 'flush' };

export type FromWorker =
  | {
      type: 'stored';
      seq: number;
      tMs: number;
      reason: StoreReason;
      changeScore: number;
      changedTiles: number[];
      width: number;
      height: number;
      full: Blob;
      thumb: Blob;
    }
  | { type: 'stats'; stats: ProcessorStats; activity: ActivityPoint[]; backlog: number }
  | { type: 'flushed' }
  | { type: 'error'; message: string };
