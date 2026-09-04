import type { FrameRecord } from '@sr/schema';
import { ApiClient, ApiError } from './api.js';

export type UploadState = 'idle' | 'uploading' | 'retrying' | 'saturated' | 'error';

export interface UploadStatus {
  state: UploadState;
  /** Frames encoded and waiting to go up. Never larger than `limits.maxFrames`. */
  queued: number;
  inFlight: number;
  uploaded: number;
  /** Frames abandoned after exhausting retries, or rejected because the queue was full. */
  dropped: number;
  bytesQueued: number;
  /** How long the oldest queued frame has been waiting. Drives the age limit. */
  oldestAgeMs: number;
  lastError: string | null;
  lastUploadAt: string | null;
}

export interface UploadLimits {
  maxFrames: number;
  maxBytes: number;
  /** A frame waiting longer than this means the connection is not coming back. */
  maxAgeMs: number;
  concurrency: number;
  /** Attempts per frame before it is abandoned. */
  maxAttempts: number;
  baseBackoffMs: number;
}

/**
 * Deliberately small. This is a shock absorber for a few seconds of bad network, not a
 * store — at ~110 KB a frame, 48 frames is roughly 5 MB of browser memory, and holding
 * substantially more would amount to an undeclared local database.
 */
export const DEFAULT_LIMITS: UploadLimits = {
  maxFrames: 48,
  maxBytes: 24 * 1024 * 1024,
  maxAgeMs: 120_000,
  concurrency: 3,
  maxAttempts: 4,
  baseBackoffMs: 1000,
};

interface Job {
  record: FrameRecord;
  full: Blob;
  thumb: Blob;
  enqueuedAt: number;
  attempts: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Holds encoded frames in memory just long enough to upload them.
 *
 * The contract this exists to enforce: **the cloud is the only durable store.** A frame is
 * recorded when the Worker has it, and never before. So when the queue cannot drain — the
 * network is down, or the backlog has outgrown its limits — the honest response is to stop
 * capturing and say so, not to silently accumulate frames in the browser and imply they
 * are safe. `onSaturated` is how the recorder learns to pause.
 *
 * Bounded three ways, because each catches a different failure: `maxFrames`/`maxBytes` cap
 * memory during a fast burst, and `maxAgeMs` catches a slow trickle that would sit under
 * both caps indefinitely while the frames quietly went stale.
 */
export class UploadQueue {
  private queue: Job[] = [];
  private inFlight = 0;
  private pumping = false;
  private halted = false;
  private status: UploadStatus = {
    state: 'idle', queued: 0, inFlight: 0, uploaded: 0, dropped: 0,
    bytesQueued: 0, oldestAgeMs: 0, lastError: null, lastUploadAt: null,
  };

  constructor(
    private api: ApiClient,
    private onStatus: (s: UploadStatus) => void = () => {},
    private onSaturated: (reason: string) => void = () => {},
    private limits: UploadLimits = DEFAULT_LIMITS,
    private now: () => number = () => Date.now(),
  ) {}

  getStatus(): UploadStatus {
    return { ...this.status, ...this.counts() };
  }

  private counts() {
    const oldest = this.queue[0];
    return {
      queued: this.queue.length,
      inFlight: this.inFlight,
      bytesQueued: this.queue.reduce((n, j) => n + j.full.size + j.thumb.size, 0),
      oldestAgeMs: oldest ? this.now() - oldest.enqueuedAt : 0,
    };
  }

  private emit(patch: Partial<UploadStatus> = {}): void {
    this.status = { ...this.status, ...this.counts(), ...patch };
    this.onStatus(this.getStatus());
  }

  /**
   * Queue a frame. Returns false when the queue is full, which the caller must treat as
   * "this frame was not recorded" — there is nowhere else for it to go.
   */
  enqueue(record: FrameRecord, full: Blob, thumb: Blob): boolean {
    const { bytesQueued } = this.counts();
    const wouldExceed =
      this.queue.length >= this.limits.maxFrames ||
      bytesQueued + full.size + thumb.size > this.limits.maxBytes;

    if (this.halted || wouldExceed) {
      this.status.dropped++;
      const why = this.halted
        ? 'uploads are halted'
        : `upload backlog is full (${this.queue.length} frames, ${Math.round(bytesQueued / 1024)} KB)`;
      this.emit({ state: this.halted ? 'error' : 'saturated' });
      this.onSaturated(why);
      return false;
    }

    this.queue.push({ record, full, thumb, enqueuedAt: this.now(), attempts: 0 });
    this.emit({ state: 'uploading' });
    void this.pump();
    return true;
  }

  /** True once nothing is queued or in flight. */
  get drained(): boolean {
    return this.queue.length === 0 && this.inFlight === 0;
  }

  /** Wait for the backlog to clear. Resolves even if frames were dropped along the way. */
  async flush(): Promise<UploadStatus> {
    void this.pump();
    while (!this.drained && !this.halted) await sleep(50);
    if (this.drained && this.status.state !== 'error') this.emit({ state: 'idle' });
    return this.getStatus();
  }

  /** Resume after a halt or a saturation stop. The user's "Retry" action. */
  resume(): void {
    this.halted = false;
    this.emit({ state: this.queue.length ? 'uploading' : 'idle', lastError: null });
    void this.pump();
  }

  /** Drop everything still queued. Used when a session ends unrecoverably. */
  clear(): void {
    this.queue = [];
    this.emit({ state: 'idle' });
  }

  /**
   * Age check. A frame under both size caps can still sit for minutes on a dying
   * connection, so staleness gets its own trigger.
   */
  checkAge(): void {
    const { oldestAgeMs } = this.counts();
    if (oldestAgeMs > this.limits.maxAgeMs && this.status.state !== 'saturated') {
      this.emit({ state: 'saturated' });
      this.onSaturated(`frames have been waiting ${Math.round(oldestAgeMs / 1000)}s to upload`);
    }
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (!this.halted && this.queue.length > 0 && this.inFlight < this.limits.concurrency) {
        const job = this.queue.shift();
        if (!job) break;
        this.inFlight++;
        void this.send(job).finally(() => {
          this.inFlight--;
          if (!this.pumping) void this.pump();
        });
      }
    } finally {
      this.pumping = false;
    }
    // A slot may have freed while the loop was running.
    if (!this.halted && this.queue.length > 0 && this.inFlight < this.limits.concurrency) {
      await sleep(0);
      void this.pump();
    }
  }

  private async send(job: Job): Promise<void> {
    try {
      await this.api.postFrame(job.record, job.full, job.thumb);
      this.status.uploaded++;
      this.emit({
        state: this.drained ? 'idle' : 'uploading',
        lastUploadAt: new Date(this.now()).toISOString(),
        lastError: null,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      // A rejected frame will be rejected again on every retry, and an expired token will
      // reject every frame. Halting is the honest outcome: the user is told uploads have
      // stopped rather than watching a queue churn forever.
      if (err instanceof ApiError && err.permanent) {
        this.halted = true;
        this.status.dropped++;
        this.emit({ state: 'error', lastError: msg });
        this.onSaturated(msg);
        return;
      }

      job.attempts++;
      if (job.attempts >= this.limits.maxAttempts) {
        this.status.dropped++;
        this.emit({ state: 'error', lastError: `gave up after ${job.attempts} attempts: ${msg}` });
        return;
      }

      this.emit({ state: 'retrying', lastError: msg });
      await sleep(this.limits.baseBackoffMs * 2 ** (job.attempts - 1));
      if (!this.halted) {
        this.queue.unshift(job); // oldest first; ordering is not required but is tidier
        void this.pump();
      }
    }
  }
}
