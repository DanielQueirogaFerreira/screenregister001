import type { FrameRecord, SessionRecord } from '@sr/schema';
import type { StorageAdapter, UsageInfo } from './adapter.js';

const DB_NAME = 'screenregister';
const DB_VERSION = 1;
const SESSIONS = 'sessions';
const FRAMES = 'frames';
const BLOBS = 'blobs';

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** Phase-1 local store. Also becomes the offline outbox once the cloud adapter lands. */
export class IndexedDBAdapter implements StorageAdapter {
  private db: IDBDatabase | null = null;

  async init(): Promise<void> {
    this.db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open(DB_NAME, DB_VERSION);
      open.onupgradeneeded = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains(SESSIONS)) {
          db.createObjectStore(SESSIONS, { keyPath: 'session_id' });
        }
        if (!db.objectStoreNames.contains(FRAMES)) {
          const s = db.createObjectStore(FRAMES, { keyPath: 'frame_id' });
          s.createIndex('by_session_seq', ['session_id', 'seq']);
          s.createIndex('by_time', 'captured_at');
        }
        if (!db.objectStoreNames.contains(BLOBS)) {
          db.createObjectStore(BLOBS, { keyPath: 'frame_id' });
        }
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });

    // Without this the browser may evict the whole database under storage pressure,
    // silently losing the record we promised to keep for seven days.
    if (navigator.storage?.persist) {
      try {
        await navigator.storage.persist();
      } catch {
        /* best effort — Firefox prompts, Safari may refuse */
      }
    }
  }

  private get idb(): IDBDatabase {
    if (!this.db) throw new Error('IndexedDBAdapter.init() has not been awaited');
    return this.db;
  }

  async createSession(session: SessionRecord): Promise<void> {
    const tx = this.idb.transaction(SESSIONS, 'readwrite');
    tx.objectStore(SESSIONS).put(session);
    await done(tx);
  }

  async updateSession(id: string, patch: Partial<SessionRecord>): Promise<void> {
    const tx = this.idb.transaction(SESSIONS, 'readwrite');
    const store = tx.objectStore(SESSIONS);
    const cur = await req<SessionRecord | undefined>(store.get(id));
    if (cur) store.put({ ...cur, ...patch });
    await done(tx);
  }

  async listSessions(): Promise<SessionRecord[]> {
    const tx = this.idb.transaction(SESSIONS, 'readonly');
    const all = await req<SessionRecord[]>(tx.objectStore(SESSIONS).getAll());
    return all.sort((a, b) => b.started_at.localeCompare(a.started_at));
  }

  async getSession(id: string): Promise<SessionRecord | null> {
    const tx = this.idb.transaction(SESSIONS, 'readonly');
    return (await req<SessionRecord | undefined>(tx.objectStore(SESSIONS).get(id))) ?? null;
  }

  async deleteSession(id: string): Promise<void> {
    const frames = await this.listFrames(id);
    const tx = this.idb.transaction([SESSIONS, FRAMES, BLOBS], 'readwrite');
    tx.objectStore(SESSIONS).delete(id);
    for (const f of frames) {
      tx.objectStore(FRAMES).delete(f.frame_id);
      tx.objectStore(BLOBS).delete(f.frame_id);
    }
    await done(tx);
  }

  async putFrame(record: FrameRecord, full: Blob, thumb: Blob): Promise<void> {
    const tx = this.idb.transaction([FRAMES, BLOBS], 'readwrite');
    tx.objectStore(FRAMES).put({ ...record, synced: 0 });
    tx.objectStore(BLOBS).put({ frame_id: record.frame_id, full, thumb });
    await done(tx);
  }

  async setHold(frameId: string, holdMs: number): Promise<void> {
    const tx = this.idb.transaction(FRAMES, 'readwrite');
    const store = tx.objectStore(FRAMES);
    const cur = await req<FrameRecord | undefined>(store.get(frameId));
    if (cur) store.put({ ...cur, hold_ms: holdMs });
    await done(tx);
  }

  async listFrames(sessionId: string): Promise<FrameRecord[]> {
    const tx = this.idb.transaction(FRAMES, 'readonly');
    const idx = tx.objectStore(FRAMES).index('by_session_seq');
    const range = IDBKeyRange.bound([sessionId, -Infinity], [sessionId, Infinity]);
    return await req<FrameRecord[]>(idx.getAll(range));
  }

  private async blobPart(frameId: string, part: 'full' | 'thumb'): Promise<Blob | null> {
    const tx = this.idb.transaction(BLOBS, 'readonly');
    const row = await req<{ full: Blob; thumb: Blob } | undefined>(
      tx.objectStore(BLOBS).get(frameId),
    );
    return row?.[part] ?? null;
  }

  getFullBlob(frameId: string): Promise<Blob | null> {
    return this.blobPart(frameId, 'full');
  }

  getThumbBlob(frameId: string): Promise<Blob | null> {
    return this.blobPart(frameId, 'thumb');
  }

  /** Retention is enforced here, at the storage layer — not by policy elsewhere. */
  async pruneOlderThan(cutoffIso: string): Promise<number> {
    const tx = this.idb.transaction([FRAMES, BLOBS], 'readwrite');
    const frames = tx.objectStore(FRAMES);
    const idx = frames.index('by_time');
    const stale = await req<FrameRecord[]>(idx.getAll(IDBKeyRange.upperBound(cutoffIso, true)));
    for (const f of stale) {
      frames.delete(f.frame_id);
      tx.objectStore(BLOBS).delete(f.frame_id);
    }
    await done(tx);

    // Drop sessions left with no frames at all.
    for (const s of await this.listSessions()) {
      if ((await this.listFrames(s.session_id)).length === 0) await this.deleteSession(s.session_id);
    }
    return stale.length;
  }

  async usage(): Promise<UsageInfo> {
    const tx = this.idb.transaction(FRAMES, 'readonly');
    const all = await req<FrameRecord[]>(tx.objectStore(FRAMES).getAll());
    const est = await navigator.storage?.estimate?.().catch(() => null);
    return {
      frames: all.length,
      bytes: all.reduce((n, f) => n + f.bytes, 0),
      sessions: (await this.listSessions()).length,
      quotaBytes: est?.quota ?? null,
      usageBytes: est?.usage ?? null,
      persisted: (await navigator.storage?.persisted?.().catch(() => false)) ?? false,
    };
  }

  async clearAll(): Promise<void> {
    const tx = this.idb.transaction([SESSIONS, FRAMES, BLOBS], 'readwrite');
    tx.objectStore(SESSIONS).clear();
    tx.objectStore(FRAMES).clear();
    tx.objectStore(BLOBS).clear();
    await done(tx);
  }
}
