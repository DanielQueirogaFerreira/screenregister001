import { describe, it, expect } from 'vitest';
import { buildScenes, resolveWindow, type FrameRow } from './queries.js';

const frame = (min: number, change: number, reason: string, holdMs: number): FrameRow => ({
  frame_id: `f${min}`,
  session_id: 'S1',
  captured_at: new Date(Date.UTC(2026, 8, 1, 9, min)).toISOString(),
  hold_ms: holdMs,
  change_score: change,
  reason,
  width: 1920, height: 1080, bytes: 100, storage_key: `f/u/S1/f${min}.webp`,
});

describe('buildScenes', () => {
  it('collapses an idle hour into one scene, not sixty frames', () => {
    // This is the whole point: a screen that did not change is one line for the LLM.
    const frames = [
      frame(0, 0.4, 'scene_change', 300_000),
      ...Array.from({ length: 11 }, (_, i) => frame(5 + i * 5, 0, 'heartbeat', 300_000)),
    ];
    const { scenes } = buildScenes(frames);
    expect(scenes).toHaveLength(1);
    expect(scenes[0]!.duration_ms).toBe(3_600_000); // a full hour
    expect(scenes[0]!.frame_count).toBe(12);
  });

  it('opens a new scene when the screen actually changes', () => {
    const { scenes } = buildScenes([
      frame(0, 0.4, 'scene_change', 60_000),
      frame(1, 0.0, 'heartbeat', 60_000),
      frame(2, 0.5, 'settled', 60_000),
      frame(3, 0.0, 'heartbeat', 60_000),
    ]);
    expect(scenes).toHaveLength(2);
    expect(scenes.map((s) => s.start_frame_id)).toEqual(['f0', 'f2']);
  });

  it('never lets a heartbeat open a scene, however it is scored', () => {
    // Heartbeats assert continuity, not novelty. A heartbeat that happened to carry a
    // high change score must not fragment a stable stretch into noise.
    const { scenes } = buildScenes([
      frame(0, 0.4, 'scene_change', 60_000),
      frame(1, 0.9, 'heartbeat', 60_000),
      frame(2, 0.9, 'heartbeat', 60_000),
    ]);
    expect(scenes).toHaveLength(1);
    expect(scenes[0]!.peak_change).toBe(0.9); // still reported, just not scene-opening
  });

  it('hides scenes below the minimum but counts them', () => {
    const { scenes, hidden } = buildScenes(
      [frame(0, 0.4, 'scene_change', 1000), frame(1, 0.4, 'settled', 60_000)],
      5000,
    );
    expect(scenes).toHaveLength(1);
    expect(hidden).toBe(1);
  });

  it('returns nothing for no frames', () => {
    expect(buildScenes([]).scenes).toHaveLength(0);
  });
});

describe('resolveWindow', () => {
  it('defaults to the last 24 hours', () => {
    const w = resolveWindow({});
    expect(Date.parse(w.to) - Date.parse(w.from)).toBeCloseTo(24 * 3_600_000, -3);
  });

  it('honours an explicit range', () => {
    const w = resolveWindow({ from: '2026-08-01T00:00:00.000Z', to: '2026-08-02T00:00:00.000Z' });
    expect(w.from).toBe('2026-08-01T00:00:00.000Z');
    expect(w.to).toBe('2026-08-02T00:00:00.000Z');
  });

  it('lets an explicit bound override the hours shorthand', () => {
    const w = resolveWindow({ last_hours: 1, from: '2026-08-01T00:00:00.000Z' });
    expect(w.from).toBe('2026-08-01T00:00:00.000Z');
  });
});
