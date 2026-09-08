import type { ActivityPoint, ProcessorStats } from '@sr/core';
import type { CaptureSettings, FrameRecord } from '@sr/schema';
import type { CloudStore } from '@sr/storage';
import { Recorder } from './recorder.js';

/**
 * Every capture running right now, owned outside the view tree.
 *
 * The bug this exists to end: `RecordView` held the Recorder in a ref, and App renders the
 * tabs as `tab === 'record' ? <RecordView/> : …`. Switching to Library unmounted the view,
 * which dropped the only reference to the running recorder — the MediaStream stayed open
 * so the browser kept claiming the screen was being shared, but nothing was reading it,
 * the session was never closed, and the row was left in the library with zero frames and
 * no end time. Both of those stranded sessions in the library came from exactly this.
 *
 * Capture is application state, not view state. It outlives any particular screen of the
 * interface, so it lives here, and the views subscribe.
 *
 * Holding a map rather than a single recorder is the other half: a person has more than
 * one screen, and the goal is to register all of them. Each entry is an independent
 * capture with its own share picker, its own worker and its own session row.
 */

export interface LiveSession {
  /** Stable for the lifetime of the entry, and available before the recorder has an id. */
  key: string;
  sessionId: string | null;
  /** What the browser called the shared surface, when it says. */
  label: string;
  running: boolean;
  paused: boolean;
  startedAt: number;
  elapsedSec: number;
  stats: ProcessorStats;
  activity: ActivityPoint[];
  backlog: number;
  last: { record: FrameRecord; url: string } | null;
  error: string | null;
}

const EMPTY_STATS: ProcessorStats = {
  sampled: 0, stored: 0, skippedNoChange: 0, skippedTransient: 0, skippedBurstCap: 0,
};

interface Entry extends LiveSession {
  recorder: Recorder;
}

export class CaptureSessions {
  private entries = new Map<string, Entry>();
  private listeners = new Set<() => void>();
  /** Rebuilt only when something changes, so useSyncExternalStore does not loop. */
  private snapshot: LiveSession[] = [];
  private ticker: number | null = null;
  private nextKey = 1;

  constructor(private settings: CaptureSettings) {}

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  };

  getSnapshot = (): LiveSession[] => this.snapshot;

  get anyRunning(): boolean {
    return this.snapshot.some((s) => s.running);
  }

  private pending = false;

  /**
   * Coalesce notifications to one per animation frame.
   *
   * Stats arrive once per sampled frame, and at 30 FPS across three screens that is 90
   * store updates a second — each one re-rendering the whole app, including whichever tab
   * happens to be open. The interface cannot show more than one update per frame anyway,
   * so batching costs nothing visible and takes the render load back down to 60Hz worst
   * case. `flush` exists for the state changes that must land before the next line of the
   * caller runs, like an entry being added or removed.
   */
  private publish(immediate = false): void {
    if (immediate) {
      this.pending = false;
      this.flush();
      return;
    }
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => {
      if (!this.pending) return;
      this.pending = false;
      this.flush();
    });
  }

  private flush(): void {
    this.snapshot = [...this.entries.values()].map(({ recorder: _r, ...rest }) => ({ ...rest }));
    for (const fn of this.listeners) fn();
  }

  /** One timer for every session, rather than one per view that happens to be mounted. */
  private ensureTicker(): void {
    if (this.ticker !== null) return;
    this.ticker = setInterval(() => {
      let changed = false;
      for (const e of this.entries.values()) {
        if (!e.running || e.paused) continue;
        const secs = Math.floor((Date.now() - e.startedAt) / 1000);
        if (secs !== e.elapsedSec) { e.elapsedSec = secs; changed = true; }
      }
      if (changed) this.publish();
    }, 1000);
  }

  private stopTickerIfIdle(): void {
    if (this.ticker !== null && ![...this.entries.values()].some((e) => e.running)) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  }

  /**
   * Open the browser's share picker and start another capture.
   *
   * Resolves once recording is under way. Cancelling the picker is not an error and leaves
   * nothing behind — the entry is only kept if `start` actually got a stream.
   */
  async start(store: CloudStore, accountId: string): Promise<void> {
    const key = `cap-${this.nextKey++}`;

    const entry: Entry = {
      key,
      sessionId: null,
      label: 'Starting…',
      running: false,
      paused: false,
      startedAt: Date.now(),
      elapsedSec: 0,
      stats: EMPTY_STATS,
      activity: [],
      backlog: 0,
      last: null,
      error: null,
      recorder: null as unknown as Recorder,
    };

    entry.recorder = new Recorder(store, this.settings, accountId, {
      onStats: (stats, activity, backlog) => {
        const e = this.entries.get(key);
        if (!e) return;
        e.stats = stats; e.activity = activity; e.backlog = backlog;
        this.publish();
      },
      onStored: (record, thumb) => {
        const e = this.entries.get(key);
        if (!e) return;
        // One blob URL is alive per session at a time; a long recording would otherwise
        // leak one per stored frame.
        if (e.last) URL.revokeObjectURL(e.last.url);
        e.last = { record, url: URL.createObjectURL(thumb) };
        this.publish();
      },
      onStopped: () => {
        const e = this.entries.get(key);
        if (e?.last) URL.revokeObjectURL(e.last.url);
        this.entries.delete(key);
        this.stopTickerIfIdle();
        this.publish(true);
        this.onSessionEnd?.();
      },
      onError: (message) => {
        const e = this.entries.get(key);
        if (!e) return;
        e.error = message;
        this.publish(true);
      },
    });

    this.entries.set(key, entry);
    this.publish(true);

    try {
      await entry.recorder.start();
    } catch (err) {
      this.entries.delete(key);
      this.publish(true);
      throw err;
    }

    entry.running = true;
    entry.startedAt = Date.now();
    entry.sessionId = entry.recorder.sessionId;
    entry.label = entry.recorder.surfaceLabel;
    this.ensureTicker();
    this.publish(true);
  }

  /** Called after a session closes, so the app can refresh stored usage. */
  onSessionEnd: (() => void) | null = null;

  setPaused(key: string, paused: boolean): void {
    const e = this.entries.get(key);
    if (!e) return;
    e.recorder.setPaused(paused);
    e.paused = paused;
    this.publish(true);
  }

  /** Pause or resume everything at once — what the stalled-uploads banner needs. */
  setAllPaused(paused: boolean): void {
    for (const e of this.entries.values()) {
      e.recorder.setPaused(paused);
      e.paused = paused;
    }
    this.publish(true);
  }

  async stop(key: string): Promise<void> {
    await this.entries.get(key)?.recorder.stop();
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((k) => this.stop(k)));
  }

  /** Keep every live capture in step with the sliders, so tuning applies to all screens. */
  updateSettings(settings: CaptureSettings): void {
    this.settings = settings;
    for (const e of this.entries.values()) e.recorder.updateSettings(settings);
  }
}
