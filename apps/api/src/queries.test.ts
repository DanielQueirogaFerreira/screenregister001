import { describe, it, expect } from 'vitest';
import { publicFrame, variantKeys } from './index.js';
import { buildScenes, resolveWindow, type FrameRow, likeEscape,
} from './queries.js';

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

describe('publicFrame', () => {
  const row = {
    frame_id: '01M1ZF6SKE93Z3RRC90ZXTMTT9',
    session_id: 's1',
    user_id: 'u1',
    device_id: 'dev_1',
    changed_tiles: '[3,4,5]',
    redacted_regions: '[{"x":10,"y":20,"w":30,"h":8}]',
    redacted: 1,
    storage_key: 'f/u1/s1/01M1ZF6SKE93Z3RRC90ZXTMTT9.webp',
    original_key: 'o/u1/s1/01M1ZF6SKE93Z3RRC90ZXTMTT9.webp',
    stamp: 'SR1-01M1ZF6SKE93Z3RRC90ZXTMTT9-4F2A9C1B',
  };

  it('turns D1 text and integers back into arrays and booleans', () => {
    const out = publicFrame(row);
    expect(out.changed_tiles).toEqual([3, 4, 5]);
    expect(out.redacted_regions).toEqual([{ x: 10, y: 20, w: 30, h: 8 }]);
    expect(out.redacted).toBe(true);
  });

  it('reports whether an untouched capture exists, not where it is', () => {
    // The object keys are where bytes happen to live. A caller holding them would
    // reasonably conclude it should fetch them directly, bypassing the ownership check
    // on the image route.
    const out = publicFrame(row);
    expect(out.has_original).toBe(true);
    expect(out.storage_key).toBeUndefined();
    expect(out.original_key).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain('f/u1/s1');
    expect(JSON.stringify(out)).not.toContain('o/u1/s1');
  });

  it('reports no original when the frame was redacted', () => {
    const out = publicFrame({ ...row, original_key: null });
    expect(out.has_original).toBe(false);
    expect(out.redacted).toBe(true);
  });

  it('carries how readable the frame was, not only what it contained', () => {
    /**
     * These three columns reach a caller for free, because publicFrame passes through
     * everything it is not deliberately removing. Pinned anyway: the pass-through is an
     * implementation detail and the property is now part of what the API promises.
     *
     * What they are for: a frame marked `inconclusive` was stored WITHOUT text-secret
     * masking, because there was no text to scan. It is the least examined frame in the
     * system, and a caller that cannot tell it from a clean one will treat the two alike.
     */
    const out = publicFrame({
      ...row, enrich_status: 'inconclusive', scan_reason: 'the reader failed or timed out',
      ocr_confidence: null, ocr_ms: 3000,
    });
    expect(out.enrich_status).toBe('inconclusive');
    expect(out.scan_reason).toBe('the reader failed or timed out');
    expect(out.ocr_confidence).toBeNull();
  });

  it('copes with the columns a pre-migration row does not have', () => {
    const out = publicFrame({ frame_id: 'x', changed_tiles: '[]' });
    expect(out.redacted).toBe(false);
    expect(out.redacted_regions).toEqual([]);
    expect(out.has_original).toBe(false);
  });
});

describe('variantKeys', () => {
  it('derives all three object keys from the stored one', () => {
    // Derived rather than read from the row so a deletion path cannot forget the original:
    // it is optional, so nothing would complain if it were left behind — it would simply
    // outlive its frame and its seven-day window.
    expect(variantKeys('f/u1/s1/frame.webp')).toEqual([
      'f/u1/s1/frame.webp',
      't/u1/s1/frame.webp',
      'o/u1/s1/frame.webp',
    ]);
  });

  it('only rewrites the leading prefix', () => {
    expect(variantKeys('f/u1/f/f.webp')).toEqual([
      'f/u1/f/f.webp', 't/u1/f/f.webp', 'o/u1/f/f.webp',
    ]);
  });
});

describe('searching by what was on screen', () => {
  it('neutralises LIKE wildcards in a search term', () => {
    // Without this, searching for "100%" matches every frame that has any text at all,
    // and "a_b" matches "axb". Both fail silently, in the direction of returning far too
    // much — an assistant hands back a week and nobody can tell it was a bug.
    expect(likeEscape('100%')).toBe('100\\%');
    expect(likeEscape('a_b')).toBe('a\\_b');
    expect(likeEscape('C:\\Users')).toBe('C:\\\\Users');
    expect(likeEscape('ordinary text')).toBe('ordinary text');
  });

  it('leaves a term that needs no escaping exactly as typed', () => {
    for (const t of ['pricing', 'Cloudflare R2', 'ação', '0.015']) {
      expect(likeEscape(t)).toBe(t);
    }
  });
});
