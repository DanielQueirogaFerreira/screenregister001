import type { FrameRecord, SessionRecord } from '@sr/schema';

export interface UsageInfo {
  frames: number;
  bytes: number;
  sessions: number;
  /** Browser-reported quota, when available. */
  quotaBytes: number | null;
  usageBytes: number | null;
  persisted: boolean;
}

/**
 * The seam between the recorder and wherever frames actually live.
 *
 * Phase 1 implements this over IndexedDB so the whole pipeline can be proven with no
 * server and no cost. Phase 2 adds a Cloudflare implementation (R2 for blobs, D1 for
 * the catalogue) behind the identical interface — at which point the IndexedDB one is
 * not discarded but demoted to the offline outbox, which is why `putFrame` records a
 * `synced` flag from the very beginning.
 */
export interface StorageAdapter {
  init(): Promise<void>;

  createSession(session: SessionRecord): Promise<void>;
  updateSession(id: string, patch: Partial<SessionRecord>): Promise<void>;
  listSessions(): Promise<SessionRecord[]>;
  getSession(id: string): Promise<SessionRecord | null>;
  deleteSession(id: string): Promise<void>;

  putFrame(record: FrameRecord, full: Blob, thumb: Blob): Promise<void>;
  /** Close out a frame once we know how long it stayed on screen. */
  setHold(frameId: string, holdMs: number): Promise<void>;
  listFrames(sessionId: string): Promise<FrameRecord[]>;
  getFullBlob(frameId: string): Promise<Blob | null>;
  getThumbBlob(frameId: string): Promise<Blob | null>;

  /** Enforce the retention ceiling. Returns how many frames were removed. */
  pruneOlderThan(cutoffIso: string): Promise<number>;
  usage(): Promise<UsageInfo>;
  clearAll(): Promise<void>;
}

/**
 * The subset of a local store that the sync engine needs.
 *
 * Split out from StorageAdapter because it is meaningful only for a store that queues
 * work for somewhere else — a pure cloud-backed adapter has no outbox.
 */
export interface OutboxStore {
  /** Frames not yet on the server. Only closed frames (hold_ms set) are eligible. */
  listUnsynced(limit: number): Promise<FrameRecord[]>;
  countUnsynced(): Promise<number>;
  markSynced(frameIds: string[]): Promise<void>;
  getSession(id: string): Promise<SessionRecord | null>;
  getFullBlob(frameId: string): Promise<Blob | null>;
  getThumbBlob(frameId: string): Promise<Blob | null>;
}

export async function sha256Hex(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
