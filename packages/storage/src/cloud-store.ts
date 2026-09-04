import type { FrameRecord, SessionRecord } from '@sr/schema';
import type { FrameStore, UsageInfo } from './adapter.js';
import type { ApiClient } from './api.js';
import { DEFAULT_LIMITS, UploadQueue, type UploadLimits, type UploadStatus } from './upload-queue.js';

/**
 * The only storage implementation: Cloudflare R2 for frame bytes, D1 for the catalogue.
 *
 * Nothing durable is kept in the browser. The single piece of state held here is `pending`
 * — the one frame currently on screen, whose `hold_ms` is unknown until the next frame
 * arrives. Waiting for that is what lets each frame be uploaded exactly once, complete,
 * rather than posted and then patched; and it is bounded by the heartbeat, which forces a
 * frame at a fixed interval even when nothing moves.
 */
export class CloudStore implements FrameStore {
  private uploads: UploadQueue;
  private pending: { record: FrameRecord; full: Blob; thumb: Blob } | null = null;
  private ageTimer: ReturnType<typeof setInterval> | undefined;
  /** Retention ceiling as reported by the server, so the UI never invents one. */
  retentionDays = 7;

  constructor(
    private api: ApiClient,
    onUploadStatus: (s: UploadStatus) => void = () => {},
    onSaturated: (reason: string) => void = () => {},
    limits: UploadLimits = DEFAULT_LIMITS,
  ) {
    this.uploads = new UploadQueue(api, onUploadStatus, onSaturated, limits);
  }

  async init(): Promise<void> {
    const health = await this.api.health();
    if (!health.ok) {
      throw new Error(
        health.schema !== 'ready'
          ? 'The server database is not ready. Its schema migrations have not been applied.'
          : 'The server is not configured to issue access tokens.',
      );
    }
    this.retentionDays = health.retention_days;
    this.ageTimer ??= setInterval(() => this.uploads.checkAge(), 5000);
  }

  dispose(): void {
    if (this.ageTimer) clearInterval(this.ageTimer);
    this.ageTimer = undefined;
    this.uploads.clear();
  }

  uploadStatus(): UploadStatus {
    return this.uploads.getStatus();
  }

  /** The user's "Retry" action after uploads stopped. */
  retryUploads(): void {
    this.uploads.resume();
  }

  // --- sessions -----------------------------------------------------------------

  /**
   * Awaited rather than queued. The server rejects frames for a session it does not know,
   * so this has to land before capture starts — and failing here, before the user has
   * recorded anything, is far better than failing on the first frame.
   */
  async createSession(session: SessionRecord): Promise<void> {
    await this.api.putSession(session);
  }

  async updateSession(session: SessionRecord): Promise<void> {
    await this.api.putSession(session);
  }

  async listSessions(): Promise<SessionRecord[]> {
    return (await this.api.listSessions()).sessions;
  }

  async deleteSession(id: string): Promise<void> {
    await this.api.deleteSession(id);
  }

  // --- frames -------------------------------------------------------------------

  async putFrame(record: FrameRecord, full: Blob, thumb: Blob): Promise<void> {
    // Whatever was pending never got a hold_ms — the session must have been interrupted.
    // Send it anyway with hold unknown rather than discarding a captured frame.
    if (this.pending) this.release(this.pending);
    this.pending = { record, full, thumb };
  }

  async setHold(frameId: string, holdMs: number): Promise<void> {
    if (this.pending?.record.frame_id === frameId) {
      const job = this.pending;
      this.pending = null;
      this.release({ ...job, record: { ...job.record, hold_ms: holdMs } });
      return;
    }
    // Already uploaded (an interrupted session, or a duplicate close). The row is the
    // source of truth now, so patch it there.
    await this.api.patchHold(frameId, holdMs);
  }

  private release(job: { record: FrameRecord; full: Blob; thumb: Blob }): void {
    this.uploads.enqueue(job.record, job.full, job.thumb);
  }

  async flush(): Promise<void> {
    if (this.pending) {
      this.release(this.pending);
      this.pending = null;
    }
    await this.uploads.flush();
  }

  async listFrames(sessionId: string): Promise<FrameRecord[]> {
    return (await this.api.listFrames(sessionId)).frames;
  }

  getFullBlob(frameId: string): Promise<Blob | null> {
    return this.api.imageBlob(frameId, 'full');
  }

  getThumbBlob(frameId: string): Promise<Blob | null> {
    return this.api.imageBlob(frameId, 'thumb');
  }

  // --- account ------------------------------------------------------------------

  async usage(): Promise<UsageInfo> {
    const u = await this.api.usage();
    return { frames: u.frames, bytes: u.bytes, sessions: u.sessions, oldest: u.oldest };
  }

  async eraseAll(): Promise<void> {
    this.uploads.clear();
    this.pending = null;
    await this.api.eraseAll();
  }
}
