/** Diff grid. 16x9 keeps the screen's aspect so tiles stay square-ish on normal monitors. */
export const GRID_COLS = 16;
export const GRID_ROWS = 9;
export const TILE_COUNT = GRID_COLS * GRID_ROWS; // 144

/** Thumbnail the diff runs on. Small enough to be free, big enough to see a changed line of text. */
export const THUMB_W = 160;
export const THUMB_H = 90;

export interface CaptureSettings {
  /** Frames sampled per second, 1..30. Start at 1; ramp toward 30. */
  captureFps: number;
  /** Single 0..100 knob. Higher = notices smaller changes = stores more. */
  sensitivity: number;

  // --- Advanced. Derived from `sensitivity` unless overridden. ---
  /** Per-tile mean-absolute-difference (0..255) above which a tile counts as changed. */
  tileThreshold: number;
  /** Fraction of tiles that must change before it counts as a scene change. */
  sceneThreshold: number;
  /** A single tile changing this hard counts even if the changed *area* is tiny. */
  strongTileMad: number;

  // --- Preroll buffer / timeline processor ---
  /** How far behind live the decision runs. Must exceed settleMs + maxSettleMs. */
  bufferMs: number;
  /** A change that reverts within this window was a tooltip/hover/caret — drop it. */
  settleMs: number;
  /** Give up waiting for motion to stop after this long and take the best frame we have. */
  maxSettleMs: number;
  /** Inter-frame change below which we call the picture "stable". */
  settleThreshold: number;
  /** Hard cap on stored frames per second during sustained motion. */
  maxFramesPerSec: number;
  /** Store a frame this often even with zero change, to assert "still showing this". */
  heartbeatMs: number;

  // --- Encoding ---
  maxWidth: number;
  quality: number;
  thumbWidth: number;

  // --- Retention ---
  retentionDays: number;
  /** Playback: any still longer than this is compressed to this in real-time mode. */
  skipStillsOverMs: number;
}

/**
 * Map the single sensitivity slider onto the two thresholds that actually matter.
 * Both are exponential because the useful range spans orders of magnitude — a linear
 * slider would spend 80% of its travel in a region where nothing perceptibly changes.
 */
export function thresholdsFor(sensitivity: number): Pick<
  CaptureSettings,
  'tileThreshold' | 'sceneThreshold' | 'strongTileMad'
> {
  const s = Math.min(100, Math.max(0, sensitivity));
  const k = (100 - s) / 100; // 0 = most sensitive, 1 = least
  const tileThreshold = 2 * Math.pow(12, k);        // 2 (max) .. 24 (min), ~7 at 50
  const sceneThreshold = 0.002 * Math.pow(125, k);  // 0.2% .. 25% of screen, ~2.2% at 50
  return {
    tileThreshold: Math.round(tileThreshold * 10) / 10,
    sceneThreshold: Math.round(sceneThreshold * 10000) / 10000,
    strongTileMad: Math.round(Math.min(255, tileThreshold * 6)),
  };
}

export const DEFAULT_SETTINGS: CaptureSettings = {
  captureFps: 1,
  sensitivity: 50,
  ...thresholdsFor(50),
  bufferMs: 3000,
  settleMs: 400,
  maxSettleMs: 1200,
  settleThreshold: 0.01,
  maxFramesPerSec: 4,
  heartbeatMs: 300_000,
  maxWidth: 1920,
  quality: 0.7,
  thumbWidth: 320,
  retentionDays: 7,
  skipStillsOverMs: 5000,
};

export function withSensitivity(s: CaptureSettings, sensitivity: number): CaptureSettings {
  return { ...s, sensitivity, ...thresholdsFor(sensitivity) };
}

/** Guard the invariant the lookahead depends on: the buffer must outlast the settle window. */
export function validateSettings(s: CaptureSettings): string[] {
  const errs: string[] = [];
  if (s.captureFps < 1 || s.captureFps > 30) errs.push('captureFps must be 1..30');
  if (s.bufferMs < s.settleMs + s.maxSettleMs) {
    errs.push(
      `bufferMs (${s.bufferMs}) must be >= settleMs + maxSettleMs (${s.settleMs + s.maxSettleMs}); ` +
        'otherwise the processor decides before it can see whether motion stopped',
    );
  }
  if (s.maxFramesPerSec < 1) errs.push('maxFramesPerSec must be >= 1');
  // maxFramesPerSec above captureFps is not an error — it is simply slack. The
  // processor clamps it to the capture rate, so a cap of 4 at 1 FPS just never binds.
  return errs;
}
