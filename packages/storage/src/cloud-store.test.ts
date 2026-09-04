import { describe, expect, it } from 'vitest';
import type { FrameRecord, SessionRecord } from '@sr/schema';
import type { ApiClient } from './api.js';
import { CloudStore } from './cloud-store.js';
import { DEFAULT_LIMITS } from './upload-queue.js';

const frame = (id: string): FrameRecord => ({
  frame_id: id, session_id: 's1', user_id: 'u1',
  captured_at: '2026-01-01T00:00:00.000Z', offset_ms: 0, seq: 0,
  hold_ms: null, change_score: 0.1, changed_tiles: [], reason: 'scene_change',
  width: 1920, height: 1080, bytes: 100, format: 'image/webp', sha256: 'x',
  ocr_text: null, caption: null, enrich_status: 'pending',
});

const blob = (): Blob => new Blob([new Uint8Array(8)]);

function fake() {
  const posted: FrameRecord[] = [];
  const patched: Array<{ id: string; hold: number }> = [];
  const sessions: SessionRecord[] = [];
  const api = {
    async health() {
      return { ok: true, service: 'x', schema: 'ready', retention_days: 7,
        auth_configured: true, cors_localhost: false };
    },
    async postFrame(record: FrameRecord) {
      posted.push(record);
      return { ok: true, frame_id: record.frame_id };
    },
    async patchHold(id: string, hold: number) {
      patched.push({ id, hold });
      return { ok: true };
    },
    async putSession(s: SessionRecord) {
      sessions.push(s);
      return { ok: true };
    },
  } as unknown as ApiClient;
  return { api, posted, patched, sessions };
}

const fastLimits = { ...DEFAULT_LIMITS, baseBackoffMs: 1 };

describe('CloudStore', () => {
  it('holds a frame until its duration is known, then uploads it once, complete', async () => {
    const { api, posted, patched } = fake();
    const store = new CloudStore(api, () => {}, () => {}, fastLimits);

    await store.putFrame(frame('a'), blob(), blob());
    expect(posted).toHaveLength(0); // nothing sent while hold_ms is unknown

    await store.setHold('a', 4200);
    await store.flush();

    expect(posted).toHaveLength(1);
    expect(posted[0]!.frame_id).toBe('a');
    expect(posted[0]!.hold_ms).toBe(4200);
    // Sent complete the first time, so no follow-up patch is needed.
    expect(patched).toHaveLength(0);
  });

  it('flushes a frame whose duration never arrived rather than dropping it', async () => {
    // The tab closed, or sharing stopped, before the next frame closed this one out.
    const { api, posted } = fake();
    const store = new CloudStore(api, () => {}, () => {}, fastLimits);

    await store.putFrame(frame('a'), blob(), blob());
    await store.flush();

    expect(posted).toHaveLength(1);
    expect(posted[0]!.hold_ms).toBeNull();
  });

  it('patches the row when a hold arrives for a frame already uploaded', async () => {
    const { api, posted, patched } = fake();
    const store = new CloudStore(api, () => {}, () => {}, fastLimits);

    await store.putFrame(frame('a'), blob(), blob());
    await store.flush();                 // 'a' goes up with hold_ms null
    await store.setHold('a', 900);       // late close-out

    expect(posted).toHaveLength(1);
    expect(patched).toEqual([{ id: 'a', hold: 900 }]);
  });

  it('never holds more than one frame back', async () => {
    // Each new frame displaces the previous one into the queue, so memory does not grow
    // with session length even if hold_ms is never set.
    const { api, posted } = fake();
    const store = new CloudStore(api, () => {}, () => {}, fastLimits);

    for (const id of ['a', 'b', 'c']) await store.putFrame(frame(id), blob(), blob());
    await store.flush();

    expect(posted.map((f) => f.frame_id)).toEqual(['a', 'b', 'c']);
  });

  it('reads the retention ceiling from the server instead of assuming one', async () => {
    const { api } = fake();
    const store = new CloudStore(api, () => {}, () => {}, fastLimits);
    await store.init();
    expect(store.retentionDays).toBe(7);
    store.dispose();
  });

  it('refuses to start when the server reports it is not ready', async () => {
    const api = {
      async health() {
        return { ok: false, service: 'x', schema: 'missing', retention_days: 7,
          auth_configured: true, cors_localhost: false };
      },
    } as unknown as ApiClient;
    const store = new CloudStore(api, () => {}, () => {}, fastLimits);

    await expect(store.init()).rejects.toThrow(/schema migrations/i);
  });
});
