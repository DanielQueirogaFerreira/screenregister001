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
  /**
   * Shortest gap between two stored frames while the screen keeps changing. 0 disables it.
   *
   * `maxFramesPerSec` cannot do this job. It is clamped to `captureFps`, so at the default
   * 1 FPS a cap of 4 is pure slack and the real limit is one stored frame every second —
   * which is exactly what a measured session did: 12,525 frames over about three and a
   * half hours, 103 KB each, 1.295 GB. That is roughly 370 MB for every hour of active
   * use, and seven days of it fits in no free tier.
   *
   * This is the knob that changes that number, and it costs recall resolution rather than
   * image quality: at three seconds the same hour costs about 123 MB, at five about 74 MB.
   * A still screen is unaffected either way — stillness is already free, carried by
   * `hold_ms` on the frame before it.
   *
   * Nothing is lost, only delayed. The gap never advances the diff reference, so a change
   * that happens inside the window is still measured against the last frame actually
   * stored, and the first frame after the window carries it. Switching apps mid-gap
   * therefore costs up to this many milliseconds of latency, not the event.
   */
  minStoreGapMs: number;
  /** Store a frame this often even with zero change, to assert "still showing this". */
  heartbeatMs: number;

  // --- Provenance and privacy ---
  /**
   * Burn the frame's stamp into the bottom-left corner of the stored image.
   *
   * Costs almost nothing: the scrim and two lines of monospace cover well under one
   * percent of a 1080p frame, and what it buys is an image that still says which recording
   * it came from after it has been exported, pasted or screenshotted — which a row in a
   * database cannot do once the image has left the database.
   */
  burnInStamp: boolean;
  /**
   * Also keep the capture exactly as it was, beside the stamped one.
   *
   * This is the single largest thing in this file for storage: it doubles what every
   * session costs in R2, for a second copy that differs from the first by a caption in one
   * corner. Off by default for that reason. Turn it on when the unmarked pixels are the
   * point — something being handed to a person who should not see an identifier, or a
   * comparison where the caption would be in the way.
   *
   * Never applies to a redacted frame: there is no untouched copy of one to keep, because
   * it was never encoded.
   */
  keepOriginal: boolean;
  /**
   * What to do when a frame appears to show a masked input field.
   *
   * 'mask' paints over the field and stores only that version, discarding the unredacted
   * capture before it is ever uploaded. 'flag' records the finding and keeps both, which
   * is the setting to use while judging whether the detector is right about your screens.
   * 'off' disables the scan.
   *
   * Detection works on appearance alone — see findMaskedFields — so it catches a field
   * showing bullets and not a secret typed in the clear.
   */
  privacyMask: 'off' | 'flag' | 'mask';

  // --- Encoding ---
  maxWidth: number;
  quality: number;
  thumbWidth: number;

  // --- Playback ---
  /** Any still longer than this is compressed to this in real-time mode. */
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
    // Two decimals, not one. At the sensitive end a slider step moves the tile threshold
    // by about 0.05, so rounding to 0.1 collapses adjacent slider positions onto the same
    // threshold and the inverse cannot tell them apart — eight of the 101 positions failed
    // to round-trip. The extra digit costs nothing and makes the two views of this setting
    // exactly reversible.
    tileThreshold: Math.round(tileThreshold * 100) / 100,
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
  minStoreGapMs: 3000,
  heartbeatMs: 300_000,
  burnInStamp: true,
  keepOriginal: false,
  privacyMask: 'mask',
  maxWidth: 1920,
  quality: 0.7,
  thumbWidth: 320,
  skipStillsOverMs: 5000,
};

/** The range `thresholdsFor` can produce, and therefore the range the inverse can accept. */
export const TILE_THRESHOLD_MIN = 2;   // sensitivity 100
export const TILE_THRESHOLD_MAX = 24;  // sensitivity 0

/**
 * The inverse of `thresholdsFor`, over the tile threshold.
 *
 * The slider and the advanced thresholds are two views of one decision, and until now the
 * arrow only pointed one way: moving the slider rewrote the thresholds, but typing a tile
 * threshold left the slider reading whatever it read before. That is not a cosmetic
 * mismatch — the settings object then holds a `sensitivity` that no longer describes its
 * own thresholds, and the next touch of the slider silently discards the typed value.
 *
 * Inverting `tileThreshold = 2 * 12^k`, where `k = (100 - s) / 100`, gives
 * `s = 100 * (1 - ln(tile / 2) / ln(12))`. The tile threshold is the right knob to invert
 * because it is the one the sensitivity slider is really about — how different a patch of
 * screen has to look before it counts as different.
 */
export function sensitivityFor(tileThreshold: number): number {
  const clamped = Math.min(TILE_THRESHOLD_MAX, Math.max(TILE_THRESHOLD_MIN, tileThreshold));
  const k = Math.log(clamped / TILE_THRESHOLD_MIN) / Math.log(12);
  return Math.round(100 * (1 - k));
}

export function withSensitivity(s: CaptureSettings, sensitivity: number): CaptureSettings {
  return { ...s, sensitivity, ...thresholdsFor(sensitivity) };
}

/**
 * Set the tile threshold and move the slider to match.
 *
 * `strongTileMad` follows too, because it is defined as a multiple of the tile threshold —
 * leaving it behind would mean a single tile could count as a strong change at a level the
 * user has just declared unremarkable.
 */
export function withTileThreshold(s: CaptureSettings, tileThreshold: number): CaptureSettings {
  const tile = Math.max(0, tileThreshold);
  return {
    ...s,
    tileThreshold: tile,
    strongTileMad: Math.round(Math.min(255, tile * 6)),
    sensitivity: sensitivityFor(tile),
  };
}

/**
 * Set the scene threshold on its own.
 *
 * This one deliberately does not move the slider. Sensitivity is inverted from the tile
 * threshold, and back-computing it from two different knobs would make the last one you
 * touched win and the other one jump. `settingsAreCustom` reports the resulting mismatch
 * instead, so the interface can say so rather than hide it.
 */
export function withSceneThreshold(s: CaptureSettings, sceneThreshold: number): CaptureSettings {
  return { ...s, sceneThreshold: Math.max(0, sceneThreshold) };
}

/** Whether the thresholds still say what the slider position says they say. */
export function settingsAreCustom(s: CaptureSettings): boolean {
  const derived = thresholdsFor(s.sensitivity);
  return (
    Math.abs(derived.tileThreshold - s.tileThreshold) > 0.05 ||
    Math.abs(derived.sceneThreshold - s.sceneThreshold) > 0.0005 ||
    Math.abs(derived.strongTileMad - s.strongTileMad) > 1
  );
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
  // Which is why minStoreGapMs exists, and why it is the one that must be checked here.
  if (s.minStoreGapMs < 0) errs.push('minStoreGapMs must be >= 0');
  if (s.minStoreGapMs >= s.heartbeatMs) {
    errs.push(
      `minStoreGapMs (${s.minStoreGapMs}) must be below heartbeatMs (${s.heartbeatMs}); ` +
        'a gap that outlasts the heartbeat would suppress the frames that prove the ' +
        'screen was still showing something',
    );
  }
  return errs;
}
