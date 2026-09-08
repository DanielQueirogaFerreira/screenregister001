import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS, TILE_THRESHOLD_MAX, TILE_THRESHOLD_MIN, sensitivityFor,
  settingsAreCustom, thresholdsFor, withSceneThreshold, withSensitivity, withTileThreshold,
} from './settings.js';

describe('sensitivity and the thresholds it drives', () => {
  it('round-trips every slider position back to itself', () => {
    // The bug this guards: the mapping only ran one way, so a typed tile threshold left
    // `sensitivity` describing thresholds the settings no longer had.
    for (let s = 0; s <= 100; s++) {
      expect(sensitivityFor(thresholdsFor(s).tileThreshold)).toBe(s);
    }
  });

  it('pins the ends of the range', () => {
    expect(thresholdsFor(100).tileThreshold).toBeCloseTo(TILE_THRESHOLD_MIN, 5);
    expect(thresholdsFor(0).tileThreshold).toBeCloseTo(TILE_THRESHOLD_MAX, 5);
    expect(sensitivityFor(TILE_THRESHOLD_MIN)).toBe(100);
    expect(sensitivityFor(TILE_THRESHOLD_MAX)).toBe(0);
  });

  it('clamps a tile threshold outside the slider range instead of running off the scale', () => {
    expect(sensitivityFor(0)).toBe(100);
    expect(sensitivityFor(-5)).toBe(100);
    expect(sensitivityFor(1000)).toBe(0);
  });

  it('moves the slider when the tile threshold is set directly', () => {
    const next = withTileThreshold(DEFAULT_SETTINGS, 24);
    expect(next.tileThreshold).toBe(24);
    expect(next.sensitivity).toBe(0);
    expect(next.sensitivity).not.toBe(DEFAULT_SETTINGS.sensitivity);
  });

  it('keeps the strong-tile cutoff a multiple of the tile threshold', () => {
    const next = withTileThreshold(DEFAULT_SETTINGS, 10);
    expect(next.strongTileMad).toBe(60);
    // Which is what deriving it from the resulting slider position would also give.
    expect(next.strongTileMad).toBeCloseTo(thresholdsFor(next.sensitivity).strongTileMad, 0);
  });

  it('still lets the slider overwrite a typed threshold, on purpose', () => {
    const typed = withTileThreshold(DEFAULT_SETTINGS, 19);
    const swept = withSensitivity(typed, 80);
    expect(swept.tileThreshold).toBeCloseTo(thresholdsFor(80).tileThreshold, 5);
    expect(settingsAreCustom(swept)).toBe(false);
  });

  it('reports a scene threshold that no longer matches the slider', () => {
    expect(settingsAreCustom(DEFAULT_SETTINGS)).toBe(false);
    const custom = withSceneThreshold(DEFAULT_SETTINGS, 0.4);
    expect(custom.sensitivity).toBe(DEFAULT_SETTINGS.sensitivity);
    expect(settingsAreCustom(custom)).toBe(true);
  });

  it('does not call a tile-threshold edit custom, because the slider followed it', () => {
    // The scene threshold is the only value left behind, and at this size the rounding
    // stays inside the tolerance — so the badge appears for a real divergence, not for
    // every keystroke in the tile field.
    const next = withTileThreshold(DEFAULT_SETTINGS, thresholdsFor(60).tileThreshold);
    expect(next.sensitivity).toBe(60);
    expect(settingsAreCustom(next)).toBe(true);
  });

  it('never produces a negative threshold from a negative input', () => {
    expect(withTileThreshold(DEFAULT_SETTINGS, -3).tileThreshold).toBe(0);
    expect(withSceneThreshold(DEFAULT_SETTINGS, -1).sceneThreshold).toBe(0);
  });
});
