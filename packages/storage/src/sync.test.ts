import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { FrameRecord, SessionRecord } from '@sr/schema';
import { SyncEngine } from './sync.js';
import { ApiError } from './api.js';
import type { OutboxStore } from './adapter.js';

// The engine consults navigator.onLine before every pass; Node has no such property.
beforeEach(() => {
  vi.stubGlobal('navigator', { onLine: true });
});

const frame = (id: string): FrameRecord => ({
  frame_id: id, session_id: 'S1', user_id: 'U1', captured_at: '2026-09-01T10:00:00.000Z',
  offset_ms: 0, seq: 0, hold_ms: 1000, change_score: 0, changed_tiles: [], reason: 'first',
  width: 10, height: 10, bytes: 100, format: 'image/webp', sha256: 'x',
  ocr_text: null, caption: null, enrich_status: 'pending',
});

function fakeStore(ids: string[]) {
  const unsynced = new Set(ids);
  return {
    marked: [] as string[],
    async listUnsynced(limit: number) {
      return [...unsynced].slice(0, limit).map(frame);
    },
    async countUnsynced() { return unsynced.size; },
    async markSynced(fids: string[]) {
      this.marked.push(...fids);
      fids.forEach((f) => unsynced.delete(f));
    },
    async getSession(): Promise<SessionRecord | null> {
      return { session_id: 'S1', user_id: 'U1', device_id: 'D1', started_at: '', ended_at: null,
        capture_fps: 1, sensitivity: 50, screen_w: 1, screen_h: 1, frames_stored: 0,
        frames_skipped: 0, bytes_stored: 0, label: null };
    },
    async getFullBlob() { return new Blob(['full']); },
    async getThumbBlob() { return new Blob(['thumb']); },
  } satisfies OutboxStore & { marked: string[] };
}

const fakeApi = (postFrame: () => Promise<unknown>) =>
  ({ putSession: async () => ({ ok: true }), postFrame }) as never;

describe('SyncEngine', () => {
  it('uploads a batch and marks exactly what landed', async () => {
    const store = fakeStore(['a', 'b', 'c']);
    const engine = new SyncEngine(store, fakeApi(async () => ({ ok: true })));
    const status = await engine.syncOnce();

    expect(store.marked.sort()).toEqual(['a', 'b', 'c']);
    expect(status.uploaded).toBe(3);
    expect(status.pending).toBe(0);
    expect(status.state).toBe('idle');
  });

  it('does not mark frames the server rejected', async () => {
    // A 4xx repeats identically on retry, so the pass stops rather than hammering the
    // server — and crucially the frames stay queued instead of being lost.
    const store = fakeStore(['a', 'b', 'c']);
    const engine = new SyncEngine(store, fakeApi(async () => { throw new ApiError(403, 'forbidden'); }));
    const status = await engine.syncOnce();

    expect(store.marked).toEqual([]);
    expect(status.state).toBe('error');
    expect(status.lastError).toMatch(/forbidden/);
    expect(await store.countUnsynced()).toBe(3);
  });

  it('holds everything locally while offline', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    const store = fakeStore(['a', 'b']);
    const status = await new SyncEngine(store, fakeApi(async () => ({ ok: true }))).syncOnce();

    expect(status.state).toBe('offline');
    expect(store.marked).toEqual([]);
  });

  it('skips a frame whose bytes are gone rather than blocking the queue forever', async () => {
    const store = { ...fakeStore(['a']), getFullBlob: async () => null };
    const engine = new SyncEngine(store, fakeApi(async () => { throw new Error('should not be called'); }));
    await engine.syncOnce();
    expect(store.marked).toEqual(['a']);
  });
});
