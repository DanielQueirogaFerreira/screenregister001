import type { FrameRecord } from '@sr/schema';
import { ApiClient, ApiError } from './api.js';
import type { OutboxStore } from './adapter.js';

export interface SyncStatus {
  state: 'idle' | 'syncing' | 'offline' | 'error';
  pending: number;
  uploaded: number;
  failed: number;
  lastError: string | null;
  lastSyncAt: string | null;
}

export interface SyncOptions {
  /** Frames per pass. Keeps a long backlog from monopolising the connection. */
  batchSize?: number;
  /** Parallel uploads. Small on purpose — these are ~110 KB each on a home uplink. */
  concurrency?: number;
  intervalMs?: number;
}

/**
 * Drains the local store to the cloud.
 *
 * The local IndexedDB store is not replaced by the server — it becomes the outbox. That
 * matters for a recorder: capture must not stop because the network did, and frames
 * written while offline have to survive until they can be sent.
 *
 * A frame is only eligible once its `hold_ms` is known, which happens when the next frame
 * is stored (or the session ends). Waiting for that means each frame is uploaded exactly
 * once, complete — no separate round trip later to patch in the duration.
 */
export class SyncEngine {
  private timer: number | undefined;
  private running = false;
  private status: SyncStatus = {
    state: 'idle', pending: 0, uploaded: 0, failed: 0, lastError: null, lastSyncAt: null,
  };

  constructor(
    private store: OutboxStore,
    private api: ApiClient,
    private onStatus: (s: SyncStatus) => void = () => {},
    private opts: SyncOptions = {},
  ) {}

  getStatus(): SyncStatus {
    return { ...this.status };
  }

  start(): void {
    this.stop();
    const every = this.opts.intervalMs ?? 15_000;
    this.timer = globalThis.setInterval(() => void this.syncOnce(), every);
    void this.syncOnce();
  }

  stop(): void {
    if (this.timer !== undefined) globalThis.clearInterval(this.timer);
    this.timer = undefined;
  }

  private emit(patch: Partial<SyncStatus>): void {
    this.status = { ...this.status, ...patch };
    this.onStatus(this.getStatus());
  }

  async syncOnce(): Promise<SyncStatus> {
    if (this.running) return this.getStatus();
    this.running = true;
    try {
      if (!navigator.onLine) {
        this.emit({ state: 'offline' });
        return this.getStatus();
      }
      this.emit({ state: 'syncing', failed: 0 });

      const batch = await this.store.listUnsynced(this.opts.batchSize ?? 50);
      this.emit({ pending: await this.store.countUnsynced() });
      if (batch.length === 0) {
        this.emit({ state: 'idle', lastSyncAt: new Date().toISOString() });
        return this.getStatus();
      }

      // The server rejects frames for a session it does not know, so upsert each session
      // once per pass before its frames go up.
      for (const sessionId of new Set(batch.map((f) => f.session_id))) {
        const s = await this.store.getSession(sessionId);
        if (s) await this.api.putSession(s);
      }

      const uploaded = await this.uploadAll(batch);
      await this.store.markSynced(uploaded);

      this.emit({
        state: uploaded.length === batch.length ? 'idle' : 'error',
        uploaded: this.status.uploaded + uploaded.length,
        failed: batch.length - uploaded.length,
        pending: await this.store.countUnsynced(),
        lastSyncAt: new Date().toISOString(),
        lastError: uploaded.length === batch.length ? null : this.status.lastError,
      });
      return this.getStatus();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.emit({ state: 'error', lastError: msg });
      return this.getStatus();
    } finally {
      this.running = false;
    }
  }

  /** Uploads with a small worker pool; returns the ids that genuinely landed. */
  private async uploadAll(batch: FrameRecord[]): Promise<string[]> {
    const queue = [...batch];
    const done: string[] = [];
    const workers = Array.from({ length: Math.min(this.opts.concurrency ?? 3, queue.length) }, async () => {
      for (;;) {
        const record = queue.shift();
        if (!record) return;
        try {
          const [full, thumb] = await Promise.all([
            this.store.getFullBlob(record.frame_id),
            this.store.getThumbBlob(record.frame_id),
          ]);
          if (!full || !thumb) {
            // Metadata without bytes is unrecoverable; marking it synced stops it from
            // blocking the queue forever.
            done.push(record.frame_id);
            continue;
          }
          await this.api.postFrame(record, full, thumb);
          done.push(record.frame_id);
        } catch (err) {
          this.emit({ lastError: err instanceof Error ? err.message : String(err) });
          // A 4xx will fail identically on every retry, so stop the pass rather than
          // hammering the server; transient 5xx/network errors are retried next tick.
          if (err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 429) {
            queue.length = 0;
          }
          return;
        }
      }
    });
    await Promise.all(workers);
    return done;
  }
}
