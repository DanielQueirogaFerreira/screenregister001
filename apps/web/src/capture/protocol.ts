import type { CaptureSettings, StoreReason } from '@sr/schema';
import type { ProcessorStats, ActivityPoint } from '@sr/core';

/**
 * Everything the worker needs to mint a frame's identity without a round trip.
 *
 * The id used to be minted on the main thread after the worker had already encoded the
 * image — which is fine until the identity has to be drawn into the pixels, because by
 * then the bitmap is gone. Minting moves here so the stamp and the image are produced in
 * one pass over the frame.
 *
 * The fingerprints arrive precomputed. They are hashes of the device and account, they
 * never change during a session, and the worker has no business holding the values they
 * were derived from.
 */
export interface CaptureIdentity {
  startedAtMs: number;
  deviceFingerprint: string;
  accountFingerprint: string;
}

export type ToWorker =
  | { type: 'start'; settings: CaptureSettings; identity: CaptureIdentity }
  | { type: 'frame'; bitmap: ImageBitmap; seq: number; tMs: number }
  | { type: 'settings'; settings: CaptureSettings }
  | { type: 'flush' };

export type FromWorker =
  | {
      type: 'stored';
      /** Minted here, so the stamp drawn into the image and the row agree by construction. */
      frameId: string;
      stamp: string;
      seq: number;
      tMs: number;
      reason: StoreReason;
      changeScore: number;
      changedTiles: number[];
      width: number;
      height: number;
      /** The stored image: stamped when burn-in is on, and redacted when anything was found. */
      full: Blob;
      thumb: Blob;
      /**
       * The capture as it was, kept only when nothing sensitive was found. Null when the
       * frame was redacted — the unmasked pixels are dropped in the worker and never
       * reach the network — and null when burn-in is off, since `full` is then already it.
       */
      original: Blob | null;
      redacted: boolean;
      /** Where the masks were painted, in the stored image's own pixels. */
      regions: { x: number; y: number; w: number; h: number }[];
    }
  | { type: 'stats'; stats: ProcessorStats; activity: ActivityPoint[]; backlog: number }
  | { type: 'flushed' }
  | { type: 'error'; message: string };
