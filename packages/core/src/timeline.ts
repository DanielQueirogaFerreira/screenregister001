import type { CaptureSettings, StoreReason } from '@sr/schema';
import { diffLuma, type DiffResult, EMPTY_DIFF } from './diff.js';

export interface BufferedFrame<P = unknown> {
  seq: number;
  /** Offset in ms from session start. Monotonic — never wall-clock. */
  tMs: number;
  /** THUMB_W x THUMB_H luma plane the diff runs on. */
  luma: Uint8Array;
  /** Opaque handle to the actual pixels (ImageBitmap or Blob in the browser, null in tests). */
  payload: P;
}

export interface Decision<P = unknown> {
  frame: BufferedFrame<P>;
  reason: StoreReason;
  changeScore: number;
  changedTiles: number[];
}

export interface ProcessorStats {
  sampled: number;
  stored: number;
  skippedNoChange: number;
  skippedTransient: number;
  skippedBurstCap: number;
}

export interface ActivityPoint {
  tMs: number;
  score: number;
  stored: boolean;
}

const ACTIVITY_CAP = 600;

/** How the settle walk resolved — drives the stored frame's `reason`. */
type SettleMode = 'immediate' | 'settled' | 'burst';

/**
 * Decides which sampled frames are worth keeping.
 *
 * The processor runs at a deliberate lag behind live (`bufferMs`) so that when a
 * change appears it can look *forward* before committing. That lookahead is what
 * separates this from naive frame-by-frame diffing, and it buys three things:
 *
 *   1. Transient suppression — a change that reverts within `settleMs` was a tooltip,
 *      a hover, or a blinking caret. Most "activity" on an idle screen is this.
 *   2. Settle selection — during real motion (a scroll, a window switch) it stores the
 *      frame where motion STOPS, not a blurred one mid-transition. The stable frame is
 *      the one a human wants to look at and the only one an LLM can read.
 *   3. Burst capping — sustained motion (playing a video) is rate-limited instead of
 *      being allowed to flood storage.
 *
 * Both lookahead behaviours need several frames inside the settle window to mean
 * anything. At low capture rates there aren't any, so they disable themselves rather
 * than firing on bad evidence — see `windowFrames()`.
 */
export class TimelineProcessor<P = unknown> {
  private buf: BufferedFrame<P>[] = [];
  /** Luma of the last STORED frame — every change is measured against this, not the previous frame. */
  private reference: Uint8Array | null = null;
  /** Luma of the last frame we consumed, stored or not. Used to tell motion from stillness. */
  private lastLuma: Uint8Array | null = null;
  private lastStoredTMs = Number.NEGATIVE_INFINITY;
  private storedTimes: number[] = [];
  private protectedSeq: number | null = null;

  readonly activity: ActivityPoint[] = [];
  stats: ProcessorStats = {
    sampled: 0,
    stored: 0,
    skippedNoChange: 0,
    skippedTransient: 0,
    skippedBurstCap: 0,
  };

  constructor(
    private settings: CaptureSettings,
    /** Called for every frame we discard, so the caller can release ImageBitmaps promptly. */
    private onDrop?: (frame: BufferedFrame<P>) => void,
  ) {}

  updateSettings(s: CaptureSettings): void {
    this.settings = s;
  }

  push(frame: BufferedFrame<P>): void {
    this.stats.sampled++;
    this.buf.push(frame);
  }

  /** How many sampled frames fall inside a window of `ms`, at the current capture rate. */
  private windowFrames(ms: number): number {
    return Math.floor(ms / (1000 / this.settings.captureFps));
  }

  /**
   * Emit decisions for every buffered frame old enough to have its full lookahead
   * available. Call this on a timer; `nowMs` is the session offset of the live edge.
   */
  drain(nowMs: number): Decision<P>[] {
    const horizon = nowMs - this.settings.bufferMs;
    const out: Decision<P>[] = [];
    while (this.buf.length > 0 && this.buf[0]!.tMs <= horizon) {
      const d = this.decide();
      if (d) out.push(d);
    }
    return out;
  }

  /** End of session: decide everything left, and guarantee a closing frame. */
  flush(): Decision<P>[] {
    const last = this.buf[this.buf.length - 1];
    this.protectedSeq = last?.seq ?? null;
    const out = this.drain(Number.POSITIVE_INFINITY);
    this.protectedSeq = null;

    if (last && out[out.length - 1]?.frame.seq !== last.seq) {
      // Only worth keeping if it differs from what is already on record. Otherwise the
      // last stored frame's hold_ms already covers this moment, and a byte-identical
      // duplicate just costs storage.
      const d = this.reference
        ? diffLuma(last.luma, this.reference, this.settings.tileThreshold)
        : null;
      const differs =
        !d ||
        d.changeScore >= this.settings.sceneThreshold ||
        d.maxTileMad >= this.settings.strongTileMad;

      if (differs) {
        this.stats.stored++;
        out.push({ frame: last, reason: 'final', changeScore: d?.changeScore ?? 0, changedTiles: d?.changedTiles ?? [] });
      } else {
        this.onDrop?.(last);
      }
    }
    return out;
  }

  /** Decide the oldest buffered frame. Returns a decision if it should be stored. */
  private decide(): Decision<P> | null {
    const f = this.buf[0]!;

    if (this.reference === null) {
      return this.store(0, 'first', EMPTY_DIFF);
    }

    const d = diffLuma(f.luma, this.reference, this.settings.tileThreshold);
    const changed =
      d.changeScore >= this.settings.sceneThreshold || d.maxTileMad >= this.settings.strongTileMad;

    this.recordActivity(f.tMs, d.changeScore, changed);

    if (!changed) {
      // Nothing moved. Still assert "the screen was showing this" on a heartbeat, so the
      // record contains positive evidence of stillness rather than an absence of data.
      if (f.tMs - this.lastStoredTMs >= this.settings.heartbeatMs) {
        return this.store(0, 'heartbeat', d);
      }
      this.stats.skippedNoChange++;
      this.consumeThrough(0);
      return null;
    }

    // --- Transient? Did the screen come back to what it was, quickly? ---
    if (this.windowFrames(this.settings.settleMs) >= 1) {
      const revertIdx = this.findRevert(f);
      if (revertIdx > 0) {
        this.stats.skippedTransient += revertIdx + 1;
        this.consumeThrough(revertIdx);
        return null;
      }
    }

    // --- Rate cap during sustained motion ---
    // Clamped to the capture rate: a cap of 4/s at 1 FPS is slack, not a constraint.
    const cap = Math.min(this.settings.maxFramesPerSec, this.settings.captureFps);
    this.storedTimes = this.storedTimes.filter((t) => f.tMs - t < 1000);
    if (this.storedTimes.length >= cap) {
      this.stats.skippedBurstCap++;
      // Advance the reference anyway: otherwise every subsequent frame keeps measuring
      // against a stale picture and re-triggers this same branch forever.
      this.reference = f.luma;
      this.consumeThrough(0);
      return null;
    }

    // --- Pick the frame where motion stopped ---
    const { index, mode } = this.findSettled(f);
    const reason: StoreReason =
      mode === 'immediate' ? 'scene_change' : mode === 'settled' ? 'settled' : 'burst';
    return this.store(index, reason, d);
  }

  /** True if this frame is already stable relative to the frame before it. */
  private isStable(f: BufferedFrame<P>): boolean {
    if (!this.lastLuma) return true;
    return (
      diffLuma(f.luma, this.lastLuma, this.settings.tileThreshold).changeScore <
      this.settings.settleThreshold
    );
  }

  /**
   * Look for a frame within `settleMs` that has returned to the reference picture.
   * Its presence means the change we just saw was a flicker, not an event.
   * Returns the buffer index of that frame, or -1.
   */
  private findRevert(f: BufferedFrame<P>): number {
    const deadline = f.tMs + this.settings.settleMs;
    for (let i = 1; i < this.buf.length; i++) {
      const g = this.buf[i]!;
      if (g.tMs > deadline) break;
      const dg = diffLuma(g.luma, this.reference!, this.settings.tileThreshold);
      if (
        dg.changeScore < this.settings.sceneThreshold &&
        dg.maxTileMad < this.settings.strongTileMad
      ) {
        return i;
      }
    }
    return -1;
  }

  /**
   * Walk forward from a changed frame until the picture stops moving, and return that
   * frame's index. Disabled at low capture rates: with fewer than two frames inside the
   * settle window there is no motion to observe, and the frame in hand is already the
   * settled one.
   */
  private findSettled(f: BufferedFrame<P>): { index: number; mode: SettleMode } {
    // Below two frames of lookahead there is no motion to observe: whatever arrived
    // IS the settled picture, and pretending otherwise would store it a beat late.
    if (this.windowFrames(this.settings.maxSettleMs) < 2) return { index: 0, mode: 'immediate' };
    if (this.isStable(f)) return { index: 0, mode: 'immediate' };

    const deadline = f.tMs + this.settings.maxSettleMs;
    let prev = f;
    let lastIdx = 0;
    for (let i = 1; i < this.buf.length; i++) {
      const n = this.buf[i]!;
      if (n.tMs > deadline) break;
      lastIdx = i;
      const dn = diffLuma(n.luma, prev.luma, this.settings.tileThreshold);
      if (dn.changeScore < this.settings.settleThreshold) return { index: i, mode: 'settled' };
      prev = n;
    }
    // Motion never stopped inside the window — take the freshest frame we have and
    // label it a burst so the caller can see this was sustained movement.
    return { index: lastIdx, mode: 'burst' };
  }

  private store(index: number, reason: StoreReason, d: DiffResult): Decision<P> {
    const frame = this.buf[index]!;
    this.reference = frame.luma;
    this.lastStoredTMs = frame.tMs;
    this.storedTimes.push(frame.tMs);
    this.stats.stored++;
    this.consumeThrough(index, /* keepIndex */ true);
    return { frame, reason, changeScore: d.changeScore, changedTiles: d.changedTiles };
  }

  /** Drop buffered frames up to and including `index`, releasing their payloads. */
  private consumeThrough(index: number, keepIndex = false): void {
    for (let i = 0; i <= index; i++) {
      const f = this.buf[i]!;
      if (i === index && keepIndex) continue;
      if (f.seq !== this.protectedSeq) this.onDrop?.(f);
    }
    this.lastLuma = this.buf[index]!.luma;
    this.buf.splice(0, index + 1);
  }

  private recordActivity(tMs: number, score: number, stored: boolean): void {
    this.activity.push({ tMs, score, stored });
    if (this.activity.length > ACTIVITY_CAP) this.activity.shift();
  }
}
