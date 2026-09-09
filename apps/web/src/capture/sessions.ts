import type { ActivityPoint, ProcessorStats } from '@sr/core';
import { encodeStamp, type CaptureSettings, type FrameRecord } from '@sr/schema';
import type { CloudStore, LiveSessionRow } from '@sr/storage';
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
  /** Summed from the frames actually stored, so the heartbeat reports a fact. */
  bytes: number;
  /**
   * The most recent stored frame, with its stamp. The stamp is computed here rather than
   * in the view so it exists the moment the frame does — "transmit the metadata live"
   * means the identity travels with the frame, not that a screen derives it when looked at.
   */
  last: { record: FrameRecord; url: string; stamp: string } | null;
  error: string | null;
}

const EMPTY_STATS: ProcessorStats = {
  sampled: 0, stored: 0, skippedNoChange: 0, skippedTransient: 0, skippedBurstCap: 0, skippedMinGap: 0,
};

interface Entry extends LiveSession {
  recorder: Recorder;
}

/**
 * A capture running somewhere else — another browser, another machine — signed in as the
 * same account. Read-only here: nothing outside the browser holding a screen-capture
 * stream can release it, so the only control available is to ask.
 */
export interface RemoteSession extends LiveSessionRow {
  remote: true;
}

/** How often to tell the server this capture is still going. Matches the server's window. */
const HEARTBEAT_MS = 15_000;
/** How often to ask what else is recording. Slower: it is a background fact, not a control. */
const LIVE_POLL_MS = 10_000;

export class CaptureSessions {
  private entries = new Map<string, Entry>();
  private listeners = new Set<() => void>();
  /** Rebuilt only when something changes, so useSyncExternalStore does not loop. */
  private snapshot: LiveSession[] = [];
  private ticker: number | null = null;
  private beat: number | null = null;
  private poll: number | null = null;
  private nextKey = 1;
  private store: CloudStore | null = null;
  /** Captures on other devices. Empty until the first poll answers. */
  private remotes: RemoteSession[] = [];
  private remoteSnapshot: RemoteSession[] = [];

  constructor(private settings: CaptureSettings) {}

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  };

  getSnapshot = (): LiveSession[] => this.snapshot;

  /** Recordings on other devices. Separate from the local snapshot because they are not
   *  the same kind of thing: these cannot be paused, and their controls are requests. */
  getRemotes = (): RemoteSession[] => this.remoteSnapshot;

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
    // Anything this browser is recording is already in the local snapshot with live stats;
    // showing it twice, once as a "remote", would be wrong and confusing.
    const mine = new Set(this.snapshot.map((s) => s.sessionId));
    this.remoteSnapshot = this.remotes.filter((r) => !mine.has(r.session_id));
    for (const fn of this.listeners) fn();
  }

  /**
   * Start watching what else is recording, and keep this browser's own captures alive.
   *
   * Called once the store exists. The poll runs whether or not this browser is recording:
   * the case that has to work is a second browser that has just signed in and is recording
   * nothing itself, which is precisely when it reported that nothing was happening at all.
   */
  attach(store: CloudStore): void {
    this.store = store;
    if (this.poll === null) {
      void this.refreshRemotes();
      this.poll = setInterval(() => void this.refreshRemotes(), LIVE_POLL_MS);
    }
    if (this.beat === null) {
      this.beat = setInterval(() => void this.sendHeartbeats(), HEARTBEAT_MS);
    }
  }

  detach(): void {
    if (this.poll !== null) { clearInterval(this.poll); this.poll = null; }
    if (this.beat !== null) { clearInterval(this.beat); this.beat = null; }
    this.store = null;
    this.remotes = [];
    this.publish(true);
  }

  private async refreshRemotes(): Promise<void> {
    const store = this.store;
    if (!store) return;
    try {
      const { sessions } = await store.liveSessions();
      this.remotes = sessions.map((s) => ({ ...s, remote: true as const }));
      this.publish(true);
    } catch {
      // A failed poll is not worth surfacing: the next one is ten seconds away, and an
      // error banner for a background fact would be noise during an ordinary blip.
    }
  }

  /**
   * Tell the server each local capture is still going, and obey any stop asked for
   * elsewhere.
   *
   * The stop arrives as a reply rather than a push because nothing outside this browser
   * can release its capture stream — a remote control here can only ever be a request that
   * this side chooses to honour.
   */
  private async sendHeartbeats(): Promise<void> {
    const store = this.store;
    if (!store) return;
    for (const e of [...this.entries.values()]) {
      if (!e.running || !e.sessionId) continue;
      try {
        const res = await store.heartbeat(e.sessionId, {
          frames_stored: e.stats.stored,
          bytes_stored: e.bytes,
        });
        if (res.stop_requested) await this.stop(e.key);
      } catch (err) {
        /**
         * A 404 here is the server saying this session is not open any more — closed by an
         * operator, or by the sweep that tidies up abandoned recordings. Carrying on would
         * mean holding the screen and uploading frames into a session everything else
         * considers finished, which is exactly the state that leaves the browser's sharing
         * indicator lit over a recording nobody believes is running.
         *
         * Every other failure is a lost beat and nothing more: capture continues, frames
         * still queue, and the session simply reads as stale elsewhere until one lands.
         */
        if (/\b404\b|not_recording/.test(err instanceof Error ? err.message : String(err))) {
          await this.stop(e.key);
        }
      }
    }
  }

  /** Ask a capture running on another device to stop. */
  async requestRemoteStop(sessionId: string): Promise<void> {
    await this.store?.requestStop(sessionId);
    await this.refreshRemotes();
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
      bytes: 0,
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
        e.bytes += record.bytes;
        e.last = { record, url: URL.createObjectURL(thumb), stamp: '' };
        this.publish();
        // Hashing is async, so the frame appears immediately and its stamp lands a tick
        // later rather than delaying the picture behind two SHA-256 digests.
        void encodeStamp({
          frameId: record.frame_id, deviceId: record.device_id, userId: record.user_id,
        }).then((stamp) => {
          const still = this.entries.get(key);
          if (still?.last?.record.frame_id !== record.frame_id) return;
          still.last = { ...still.last, stamp };
          this.publish();
        });
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
    // Beat immediately rather than waiting up to fifteen seconds: a recording that another
    // device cannot see for a quarter of a minute looks like the bug this replaces.
    void this.sendHeartbeats();
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
