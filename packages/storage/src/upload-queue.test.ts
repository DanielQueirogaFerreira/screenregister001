import { describe, expect, it } from 'vitest';
import type { FrameRecord } from '@sr/schema';
import { ApiError, type ApiClient } from './api.js';
import { DEFAULT_LIMITS, UploadQueue, type UploadLimits } from './upload-queue.js';

const frame = (id: string, bytes = 1000): FrameRecord => ({
  frame_id: id,
  session_id: 's1',
  user_id: 'u1',
  captured_at: '2026-01-01T00:00:00.000Z',
  offset_ms: 0,
  seq: 0,
  hold_ms: 1000,
  change_score: 0.1,
  changed_tiles: [],
  reason: 'scene_change',
  width: 1920,
  height: 1080,
  bytes,
  format: 'image/webp',
  sha256: 'x',
  ocr_text: null,
  caption: null,
  enrich_status: 'pending',
});

const blob = (n: number): Blob => new Blob([new Uint8Array(n)]);

/** Records every upload and fails on demand. */
function fakeApi(fail: (id: string, attempt: number) => Error | null = () => null) {
  const sent: string[] = [];
  const attempts = new Map<string, number>();
  const api = {
    async postFrame(record: FrameRecord) {
      const n = (attempts.get(record.frame_id) ?? 0) + 1;
      attempts.set(record.frame_id, n);
      const err = fail(record.frame_id, n);
      if (err) throw err;
      sent.push(record.frame_id);
      return { ok: true, frame_id: record.frame_id };
    },
  } as unknown as ApiClient;
  return { api, sent, attempts };
}

const fast: UploadLimits = { ...DEFAULT_LIMITS, baseBackoffMs: 1, maxAttempts: 3 };

describe('UploadQueue', () => {
  it('uploads what it accepts and reports idle once drained', async () => {
    const { api, sent } = fakeApi();
    const q = new UploadQueue(api, () => {}, () => {}, fast);

    for (const id of ['a', 'b', 'c']) expect(q.enqueue(frame(id), blob(10), blob(2))).toBe(true);
    await q.flush();

    expect(sent.sort()).toEqual(['a', 'b', 'c']);
    expect(q.getStatus().uploaded).toBe(3);
    expect(q.getStatus().state).toBe('idle');
    expect(q.getStatus().queued).toBe(0);
  });

  it('retries a transient failure and still delivers the frame', async () => {
    // Two 500s, then success — the frame must arrive, not be dropped.
    const { api, sent, attempts } = fakeApi((_id, n) =>
      n <= 2 ? new ApiError(500, 'server blew up') : null);
    const q = new UploadQueue(api, () => {}, () => {}, fast);

    q.enqueue(frame('a'), blob(10), blob(2));
    await q.flush();

    expect(sent).toEqual(['a']);
    expect(attempts.get('a')).toBe(3);
    expect(q.getStatus().dropped).toBe(0);
  });

  it('treats 429 as transient, not permanent', async () => {
    const { api, sent } = fakeApi((_id, n) => (n === 1 ? new ApiError(429, 'slow down') : null));
    const q = new UploadQueue(api, () => {}, () => {}, fast);

    q.enqueue(frame('a'), blob(10), blob(2));
    await q.flush();

    expect(sent).toEqual(['a']);
  });

  it('halts on a permanent 4xx and refuses further frames until resumed', async () => {
    // An expired token rejects every frame; churning the queue would hide that.
    // Only 'a' is rejected: 'c' must go through once the user resumes.
    const { api, sent } = fakeApi((id) =>
      id === 'a' ? new ApiError(401, 'POST /v1/frames failed: 401 unauthorized') : null);
    const reasons: string[] = [];
    const q = new UploadQueue(api, () => {}, (r) => reasons.push(r), fast);

    q.enqueue(frame('a'), blob(10), blob(2));
    await q.flush();

    expect(sent).toEqual([]);
    expect(q.getStatus().state).toBe('error');
    expect(reasons.some((r) => /401/.test(r))).toBe(true);

    // A frame offered while halted must be reported as not stored.
    expect(q.enqueue(frame('b'), blob(10), blob(2))).toBe(false);

    q.resume();
    expect(q.enqueue(frame('c'), blob(10), blob(2))).toBe(true);
    await q.flush();
    expect(sent).toEqual(['c']);
  });

  it('refuses a frame once the count cap is reached rather than growing', async () => {
    // Uploads never resolve, so the queue fills and must start rejecting.
    const api = { postFrame: () => new Promise(() => {}) } as unknown as ApiClient;
    const reasons: string[] = [];
    const q = new UploadQueue(api, () => {}, (r) => reasons.push(r), { ...fast, maxFrames: 4, concurrency: 1 });

    const accepted = ['a', 'b', 'c', 'd', 'e', 'f']
      .map((id) => q.enqueue(frame(id), blob(10), blob(2)));

    // One is in flight, four fit the queue; the rest are refused.
    expect(accepted.filter(Boolean).length).toBe(5);
    expect(accepted.at(-1)).toBe(false);
    expect(q.getStatus().state).toBe('saturated');
    expect(q.getStatus().dropped).toBeGreaterThan(0);
    expect(reasons.some((r) => /backlog is full/.test(r))).toBe(true);
  });

  it('refuses a frame that would blow the byte budget', () => {
    const api = { postFrame: () => new Promise(() => {}) } as unknown as ApiClient;
    const q = new UploadQueue(api, () => {}, () => {}, {
      ...fast, maxBytes: 5000, concurrency: 0, maxFrames: 100,
    });

    expect(q.enqueue(frame('a'), blob(2000), blob(500))).toBe(true);
    expect(q.enqueue(frame('b'), blob(2000), blob(500))).toBe(true);
    expect(q.enqueue(frame('c'), blob(2000), blob(500))).toBe(false);
    expect(q.getStatus().state).toBe('saturated');
  });

  it('saturates on age even while under the size caps', () => {
    // A slow trickle stays under every byte and count limit forever; only age catches it.
    const api = { postFrame: () => new Promise(() => {}) } as unknown as ApiClient;
    const reasons: string[] = [];
    let now = 0;
    const q = new UploadQueue(
      api, () => {}, (r) => reasons.push(r),
      { ...fast, maxAgeMs: 10_000, concurrency: 0 },
      () => now,
    );

    q.enqueue(frame('a'), blob(10), blob(2));
    now = 9_000;
    q.checkAge();
    expect(q.getStatus().state).not.toBe('saturated');

    now = 11_000;
    q.checkAge();
    expect(q.getStatus().state).toBe('saturated');
    expect(reasons.some((r) => /waiting 11s/.test(r))).toBe(true);
  });

  it('gives up on a frame after maxAttempts rather than retrying forever', async () => {
    const { api, attempts } = fakeApi(() => new ApiError(503, 'still down'));
    const q = new UploadQueue(api, () => {}, () => {}, fast);

    q.enqueue(frame('a'), blob(10), blob(2));
    await q.flush();

    expect(attempts.get('a')).toBe(fast.maxAttempts);
    expect(q.getStatus().dropped).toBe(1);
    expect(q.getStatus().state).toBe('error');
  });
});
