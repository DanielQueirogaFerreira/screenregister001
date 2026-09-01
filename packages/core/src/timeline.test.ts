import { describe, it, expect } from 'vitest';
import { DEFAULT_SETTINGS, withSensitivity, validateSettings, type CaptureSettings } from '@sr/schema';
import { TimelineProcessor, type Decision } from './timeline.js';
import { solid, withRect, blend, desktop, noisy, scrolled } from './fixtures.js';

/** Feed a luma sequence through the processor the way the recorder does:
 *  push each frame, drain at the live edge, then flush at the end. */
function run(lumas: Uint8Array[], settings: CaptureSettings): Decision<number>[] {
  const p = new TimelineProcessor<number>(settings);
  const stepMs = 1000 / settings.captureFps;
  const out: Decision<number>[] = [];
  lumas.forEach((luma, i) => {
    const tMs = Math.round(i * stepMs);
    p.push({ seq: i, tMs, luma, payload: i });
    out.push(...p.drain(tMs));
  });
  out.push(...p.flush());
  return out;
}

const at = (fps: number, over: Partial<CaptureSettings> = {}): CaptureSettings => ({
  ...DEFAULT_SETTINGS,
  captureFps: fps,
  ...over,
});

describe('static screen', () => {
  it('stores a handful of frames for 10 idle minutes at 1 FPS, not 600', () => {
    const base = desktop();
    const lumas = Array.from({ length: 601 }, () => base);
    const decisions = run(lumas, at(1));

    expect(decisions.length).toBeLessThanOrEqual(4);
    expect(decisions.length).toBeGreaterThanOrEqual(2);
    expect(decisions[0]!.reason).toBe('first');
    for (const d of decisions) expect(['first', 'heartbeat', 'final']).toContain(d.reason);
  });

  it('is not fooled by encoder noise on an otherwise still screen', () => {
    const base = desktop();
    const lumas = Array.from({ length: 120 }, (_, i) => noisy(base, 2 + (i % 2)));
    const decisions = run(lumas, at(1));
    expect(decisions.filter((d) => d.reason === 'scene_change' || d.reason === 'settled')).toHaveLength(0);
  });

  it('heartbeats prove stillness rather than leaving a hole in the record', () => {
    const base = desktop();
    const lumas = Array.from({ length: 1201 }, () => base);
    const decisions = run(lumas, at(1, { heartbeatMs: 300_000 }));
    const beats = decisions.filter((d) => d.reason === 'heartbeat');
    expect(beats.length).toBeGreaterThanOrEqual(3); // 300s, 600s, 900s, 1200s
  });
});

describe('transient suppression', () => {
  it('drops a 200ms tooltip at 30 FPS', () => {
    const base = desktop();
    const tip = withRect(base, 60, 40, 30, 25, 240);
    const lumas: Uint8Array[] = [];
    for (let i = 0; i < 30; i++) lumas.push(base);   // 1s idle
    for (let i = 0; i < 6; i++) lumas.push(tip);     // 200ms tooltip
    for (let i = 0; i < 60; i++) lumas.push(base);   // back to idle

    const decisions = run(lumas, at(30));
    const real = decisions.filter((d) => d.reason !== 'first' && d.reason !== 'final');
    expect(real).toHaveLength(0);
  });

  it('keeps a change that persists past the settle window', () => {
    const base = desktop();
    const panel = withRect(base, 60, 20, 60, 60, 240);
    const lumas: Uint8Array[] = [];
    for (let i = 0; i < 30; i++) lumas.push(base);
    for (let i = 0; i < 90; i++) lumas.push(panel); // 3s — a real event, not a flicker
    for (let i = 0; i < 30; i++) lumas.push(panel);

    const decisions = run(lumas, at(30));
    const real = decisions.filter((d) => d.reason === 'scene_change' || d.reason === 'settled');
    expect(real.length).toBeGreaterThanOrEqual(1);
  });
});

describe('settle selection', () => {
  it('stores the frame after motion stops, not one mid-transition', () => {
    const a = desktop(0);
    const b = desktop(3);
    const lumas: Uint8Array[] = [];
    for (let i = 0; i < 30; i++) lumas.push(a);
    for (let i = 1; i <= 9; i++) lumas.push(blend(a, b, i / 10)); // 300ms cross-fade
    for (let i = 0; i < 60; i++) lumas.push(b);

    const decisions = run(lumas, at(30));
    const chosen = decisions.find((d) => d.reason === 'settled' || d.reason === 'scene_change');
    expect(chosen).toBeDefined();
    // Frame 39 onward is the finished picture; anything in 30..38 is a blurred blend.
    expect(chosen!.frame.seq).toBeGreaterThanOrEqual(39);
  });

  it('skips the settle walk at low FPS, where the frame in hand is already settled', () => {
    const a = desktop(0);
    const b = desktop(3);
    const lumas = [...Array(10).fill(a), ...Array(10).fill(b)];
    const decisions = run(lumas, at(1));
    const chosen = decisions.find((d) => d.reason === 'scene_change');
    expect(chosen).toBeDefined();
    expect(chosen!.frame.seq).toBe(10); // the first frame showing the new screen
  });
});

describe('rate limiting under motion', () => {
  it('bounds the store rate during 10s of unbroken scrolling', () => {
    const base = desktop();
    const lumas = Array.from({ length: 300 }, (_, i) => scrolled(base, i * 3));
    const settings = at(30, { maxFramesPerSec: 4 });
    const decisions = run(lumas, settings);

    // Motion that never settles is sampled once per maxSettleMs rather than flooding.
    expect(decisions.length).toBeLessThanOrEqual(10 * settings.maxFramesPerSec + 4);
    expect(decisions.length).toBeGreaterThan(4); // but the activity is not dropped either
  });

  it('caps rapid discrete changes at maxFramesPerSec', () => {
    // A new, immediately-stable picture every 4 frames = 7.5 changes/sec at 30 FPS.
    // Each one settles instantly, so only the hard cap can hold the rate down.
    const lumas: Uint8Array[] = [];
    for (let i = 0; i < 300; i++) lumas.push(desktop(Math.floor(i / 4)));
    const settings = at(30, { maxFramesPerSec: 4 });
    const decisions = run(lumas, settings);

    const seconds = 10;
    expect(decisions.length).toBeLessThanOrEqual(seconds * settings.maxFramesPerSec + 2);
    expect(decisions.length).toBeGreaterThan(seconds * 2); // the cap binds, it does not silence
  });
});

describe('sensitivity', () => {
  it('is monotonic: raising it can only store more', () => {
    const base = desktop();
    const nudged = withRect(base, 70, 40, 20, 15, 150);
    const lumas = [...Array(20).fill(base), ...Array(40).fill(nudged)];

    const low = run(lumas, { ...at(2), ...withSensitivity(DEFAULT_SETTINGS, 5) , captureFps: 2 });
    const high = run(lumas, { ...at(2), ...withSensitivity(DEFAULT_SETTINGS, 95), captureFps: 2 });
    expect(high.length).toBeGreaterThanOrEqual(low.length);
  });
});

describe('settings validation', () => {
  it('rejects a buffer too short for its own lookahead', () => {
    const bad = { ...DEFAULT_SETTINGS, bufferMs: 500 };
    expect(validateSettings(bad).join(' ')).toMatch(/bufferMs/);
  });

  it('accepts the defaults', () => {
    expect(validateSettings(DEFAULT_SETTINGS)).toHaveLength(0);
  });
});

describe('session close', () => {
  it('does not store a closing frame identical to the one already on record', () => {
    // The last stored frame's hold_ms already covers the tail of the session, so a
    // byte-identical "final" frame is pure waste.
    const base = desktop();
    const decisions = run(Array.from({ length: 40 }, () => base), at(10));
    expect(decisions.map((d) => d.reason)).toEqual(['first']);
  });

  it('still captures a change that lands in the last moments of the session', () => {
    // Flush drains the preroll buffer, so a late change is normally stored on its own
    // merits ('settled'/'scene_change'); 'final' is only the fallback. What matters is
    // that the new screen is on record at all.
    const lumas = [...Array(40).fill(desktop(0)), ...Array(3).fill(desktop(5))];
    const decisions = run(lumas, at(10));
    const last = decisions[decisions.length - 1]!;
    expect(last.frame.seq).toBeGreaterThanOrEqual(40);
    expect(['settled', 'scene_change', 'burst', 'final']).toContain(last.reason);
  });
});
