import type { FrameRecord, SessionRecord } from '@sr/schema';

/** What the account holds server-side. Reported by the Worker, not by the browser. */
export interface UsageInfo {
  frames: number;
  bytes: number;
  sessions: number;
  /** Oldest frame still inside the retention window, ISO-8601, or null when empty. */
  oldest: string | null;
}

/**
 * The recorder's view of storage. Cloudflare is the only implementation.
 *
 * There is deliberately no local persistent implementation. R2 and D1 are the system of
 * record: a frame that has not reached the Worker is not stored, and the UI says so rather
 * than implying a durable local copy exists. The browser's role is bounded to capture,
 * change detection, encoding, and a short in-memory queue that smooths uploads and retries
 * transient failures — see `UploadQueue`.
 *
 * `getFullBlob`/`getThumbBlob` return bytes fetched from the Worker, so playback reads the
 * same objects any other client would. They are not a cache of something held locally.
 */
export interface FrameStore {
  /** Fail fast if the backend is unreachable or unauthenticated. */
  init(): Promise<void>;

  createSession(session: SessionRecord): Promise<void>;
  /** Full record, not a patch: the server route is an upsert, and sending a partial one
   *  would blank the columns it omits. */
  updateSession(session: SessionRecord): Promise<void>;
  listSessions(): Promise<SessionRecord[]>;
  deleteSession(id: string): Promise<void>;

  /**
   * Accept a newly encoded frame. It is held in memory only until its `hold_ms` is known,
   * at which point `setHold` releases it to the upload queue — so each frame is uploaded
   * exactly once, complete, instead of being patched afterwards.
   */
  putFrame(record: FrameRecord, full: Blob, thumb: Blob): Promise<void>;
  /** Close out a frame once we know how long it stayed on screen, and queue it for upload. */
  setHold(frameId: string, holdMs: number): Promise<void>;
  /** Wait for the queue to drain. Called when a session ends. */
  flush(): Promise<void>;

  listFrames(sessionId: string): Promise<FrameRecord[]>;
  getFullBlob(frameId: string): Promise<Blob | null>;
  getThumbBlob(frameId: string): Promise<Blob | null>;

  usage(): Promise<UsageInfo>;
  /** Delete every session, frame row and object belonging to this device's user. */
  eraseAll(): Promise<void>;
}

export async function sha256Hex(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
