/**
 * Turning several recordings into one thing to watch.
 *
 * Two arrangements, answering different questions.
 *
 *   sequence  one recording after another, as a single run — "what happened over this
 *             stretch of time", where the recordings do not overlap and reading them end
 *             to end is exactly right
 *   together  all of them at once, each on its own pane — "what was on my other screen
 *             while this was going on"
 *
 * Together is the one with a trap in it. Recordings almost never start at the same moment
 * and never tick at the same rate: one screen might store forty frames while another stores
 * three, because the second was sitting still. Pairing them by frame number would put
 * unrelated moments side by side and invite exactly the wrong conclusion — the whole reason
 * to look at two screens together is to see what coincided. So the merge is on the clock:
 * every capture instant from every recording, in order, and at each one, the frame each
 * recording actually had on screen then.
 */

/** The subset of a frame this module needs; the full record has much more on it. */
export interface PlayableFrame {
  captured_at: string;
  hold_ms: number | null;
  change_score: number;
}

export interface Step {
  /** Where this step begins on the player's own clock. */
  start: number;
  /** How long it stays on screen, after skipping and condensing. */
  span: number;
  /** Index into each recording's frame list, or -1 when it has nothing to show. */
  at: number[];
  /** The wall-clock instant this step represents. */
  wall: number;
  /** Strongest change across the recordings at this step, for the scrub bar. */
  change: number;
}

export interface PlaybackOptions {
  layout: 'sequence' | 'together';
  condensed: boolean;
  /** Any still longer than this is compressed to this in real time. */
  skipStillsOverMs: number;
  /** Screen time per frame in condensed mode. */
  condensedMs: number;
}

/** Never less than one animation frame, or a step could be skipped entirely. */
const MIN_SPAN_MS = 16;
/** What to assume for the last step's gap, which has no successor to measure against. */
const TAIL_SPAN_MS = 1000;

export function buildSteps(lists: PlayableFrame[][], o: PlaybackOptions): Step[] {
  const out: Step[] = [];
  let acc = 0;

  if (o.layout === 'sequence') {
    lists.forEach((frames, s) => {
      frames.forEach((f, i) => {
        const real = f.hold_ms ?? TAIL_SPAN_MS;
        const span = o.condensed ? o.condensedMs : Math.max(MIN_SPAN_MS, Math.min(real, o.skipStillsOverMs));
        const at = lists.map(() => -1);
        at[s] = i;
        out.push({ start: acc, span, at, wall: Date.parse(f.captured_at), change: f.change_score });
        acc += span;
      });
    });
    return out;
  }

  const instants = [...new Set(
    lists.flatMap((frames) => frames.map((f) => Date.parse(f.captured_at))),
  )].sort((a, b) => a - b);

  /**
   * One cursor per recording, advanced as the merged instants move forward.
   *
   * Linear overall rather than a binary search per recording per instant. At a few thousand
   * frames across several recordings that is the difference between building this once on
   * open and rebuilding it visibly.
   */
  const cursor = lists.map(() => -1);

  instants.forEach((wall, k) => {
    let change = 0;
    lists.forEach((frames, s) => {
      while (cursor[s]! + 1 < frames.length
        && Date.parse(frames[cursor[s]! + 1]!.captured_at) <= wall) {
        cursor[s] = cursor[s]! + 1;
        change = Math.max(change, frames[cursor[s]!]!.change_score);
      }
    });

    const at = lists.map((frames, s) => {
      const i = cursor[s]!;
      if (i < 0) return -1;                      // this recording had not started yet
      const f = frames[i]!;
      // Past its final frame's hold: the recording is over, so its pane goes idle rather
      // than freezing on a stale picture as though it were still going. Only the last
      // frame is treated this way — an earlier frame's hold always runs to the next one.
      const isLast = i === frames.length - 1;
      if (isLast && f.hold_ms !== null && wall > Date.parse(f.captured_at) + f.hold_ms) return -1;
      return i;
    });

    const realGap = k + 1 < instants.length ? instants[k + 1]! - wall : TAIL_SPAN_MS;
    const span = o.condensed
      ? o.condensedMs
      : Math.max(MIN_SPAN_MS, Math.min(realGap, o.skipStillsOverMs));
    out.push({ start: acc, span, at, wall, change });
    acc += span;
  });
  return out;
}

/** Total running time of a built timeline. */
export const totalSpan = (steps: Step[]): number =>
  steps.length ? steps[steps.length - 1]!.start + steps[steps.length - 1]!.span : 0;

/** The step showing at a position on the player's clock. */
export function stepAt(steps: Step[], ms: number): number {
  for (let i = 0; i < steps.length; i++) {
    if (ms < steps[i]!.start + steps[i]!.span) return i;
  }
  return Math.max(0, steps.length - 1);
}
