import { describe, expect, it } from 'vitest';
import { buildSteps, stepAt, totalSpan, type PlayableFrame } from './playback.js';

const T0 = Date.UTC(2026, 8, 8, 12, 0, 0);
const at = (offsetMs: number, holdMs: number | null = 1000, change = 0.2): PlayableFrame => ({
  captured_at: new Date(T0 + offsetMs).toISOString(),
  hold_ms: holdMs,
  change_score: change,
});

const opts = (over: Partial<Parameters<typeof buildSteps>[1]> = {}) => ({
  layout: 'together' as const,
  condensed: false,
  skipStillsOverMs: 5000,
  condensedMs: 200,
  ...over,
});

describe('sequence', () => {
  it('plays one recording after another', () => {
    const steps = buildSteps(
      [[at(0), at(1000)], [at(0), at(1000), at(2000)]],
      opts({ layout: 'sequence' }),
    );
    expect(steps).toHaveLength(5);
    // Each step shows exactly one recording, and they do not interleave.
    expect(steps.map((s) => s.at.findIndex((i) => i >= 0))).toEqual([0, 0, 1, 1, 1]);
  });

  it('lays the steps end to end with no gaps or overlaps', () => {
    const steps = buildSteps([[at(0), at(1000)], [at(0)]], opts({ layout: 'sequence' }));
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i]!.start).toBe(steps[i - 1]!.start + steps[i - 1]!.span);
    }
    expect(totalSpan(steps)).toBe(steps.reduce((n, s) => n + s.span, 0));
  });

  it('compresses a long still rather than playing it out', () => {
    const steps = buildSteps([[at(0, 3_600_000)]], opts({ layout: 'sequence' }));
    expect(steps[0]!.span).toBe(5000);   // an hour of stillness, capped
  });
});

describe('together', () => {
  it('pairs recordings by the clock, not by frame number', () => {
    // The trap this exists for. One screen stores four frames while the other stores one,
    // because the second was sitting still. Pairing by index would show frame 2 of A
    // beside frame 2 of B — moments a minute apart — and invite exactly the wrong
    // conclusion about what coincided.
    const busy = [at(0), at(1000), at(2000), at(3000)];
    const still = [at(0, 60_000)];
    const steps = buildSteps([busy, still], opts());

    expect(steps.map((s) => s.wall - T0)).toEqual([0, 1000, 2000, 3000]);
    expect(steps.map((s) => s.at[0])).toEqual([0, 1, 2, 3]);
    // The still screen shows its one frame throughout, because that is what was on it.
    expect(steps.map((s) => s.at[1])).toEqual([0, 0, 0, 0]);
  });

  it('shows nothing for a recording that had not started yet', () => {
    // The late recording holds long enough to still be on screen at the last instant, so
    // this isolates the before-it-started case from the after-it-ended one.
    const early = [at(0), at(5000)];
    const late = [at(3000, 10_000)];
    const steps = buildSteps([early, late], opts());
    expect(steps.map((s) => s.wall - T0)).toEqual([0, 3000, 5000]);
    expect(steps.map((s) => s.at[1])).toEqual([-1, 0, 0]);
  });

  it('shows nothing once a recording has ended', () => {
    // Its last frame held for one second; after that the recording is over. Freezing on
    // the final picture would read as "this screen still looks like that", which is a
    // claim the data does not make.
    const short = [at(0, 1000)];
    const long = [at(0), at(2000), at(4000)];
    const steps = buildSteps([short, long], opts());
    expect(steps.map((s) => s.wall - T0)).toEqual([0, 2000, 4000]);
    expect(steps.map((s) => s.at[0])).toEqual([0, -1, -1]);
  });

  it('keeps an open last frame on screen, since it never stopped holding', () => {
    // hold_ms null means the frame was still the live one when the session was written.
    const open = [at(0, null)];
    const other = [at(0), at(9000)];
    const steps = buildSteps([open, other], opts());
    expect(steps.map((s) => s.at[0])).toEqual([0, 0]);
  });

  it('merges instants that coincide into one step', () => {
    const a = [at(0), at(1000)];
    const b = [at(0), at(1000)];
    const steps = buildSteps([a, b], opts());
    expect(steps).toHaveLength(2);
    expect(steps[0]!.at).toEqual([0, 0]);
    expect(steps[1]!.at).toEqual([1, 1]);
  });

  it('orders by time even when the recordings are given out of order', () => {
    const later = [at(10_000)];
    const earlier = [at(0)];
    const steps = buildSteps([later, earlier], opts());
    expect(steps.map((s) => s.wall - T0)).toEqual([0, 10_000]);
    // At t=0 only the earlier one exists; by t=10s it has long since ended — its single
    // frame held for a second — so it is the later one that is showing. Both facts follow
    // from the clock rather than from the order the recordings were handed over.
    expect(steps[0]!.at).toEqual([-1, 0]);
    expect(steps[1]!.at).toEqual([0, -1]);
  });

  it('keeps an earlier recording on screen while its hold is still running', () => {
    const later = [at(10_000)];
    const earlier = [at(0, 30_000)];
    const steps = buildSteps([later, earlier], opts());
    expect(steps[1]!.at).toEqual([0, 0]);
  });

  it('caps a long gap rather than sitting on one step for an hour', () => {
    const steps = buildSteps([[at(0), at(3_600_000)]], opts());
    expect(steps[0]!.span).toBe(5000);
  });

  it('gives every step a span long enough to be seen', () => {
    // Frames a millisecond apart must not produce steps the animation loop steps over.
    const steps = buildSteps([[at(0), at(1), at(2)]], opts());
    expect(steps.every((s) => s.span >= 16)).toBe(true);
  });

  it('takes the strongest change across the recordings for the scrub bar', () => {
    const quiet = [at(0, 1000, 0.05)];
    const loud = [at(0, 1000, 0.9)];
    expect(buildSteps([quiet, loud], opts())[0]!.change).toBe(0.9);
  });

  it('condenses every step equally, whatever the real gaps were', () => {
    const steps = buildSteps([[at(0), at(50), at(3_600_000)]], opts({ condensed: true }));
    expect(steps.map((s) => s.span)).toEqual([200, 200, 200]);
  });

  it('copes with a recording that stored nothing', () => {
    const steps = buildSteps([[], [at(0), at(1000)]], opts());
    expect(steps).toHaveLength(2);
    expect(steps.every((s) => s.at[0] === -1)).toBe(true);
  });

  it('has nothing to play when no recording stored anything', () => {
    expect(buildSteps([[], []], opts())).toEqual([]);
    expect(totalSpan([])).toBe(0);
  });
});

describe('stepAt', () => {
  it('finds the step showing at a position', () => {
    const steps = buildSteps([[at(0), at(1000), at(2000)]], opts());
    expect(stepAt(steps, 0)).toBe(0);
    expect(stepAt(steps, steps[1]!.start)).toBe(1);
    expect(stepAt(steps, steps[1]!.start + steps[1]!.span - 1)).toBe(1);
    expect(stepAt(steps, steps[2]!.start)).toBe(2);
  });

  it('clamps past the end rather than running off it', () => {
    const steps = buildSteps([[at(0)]], opts());
    expect(stepAt(steps, 10_000_000)).toBe(steps.length - 1);
    expect(stepAt([], 5)).toBe(0);
  });
});
