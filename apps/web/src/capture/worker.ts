/// <reference lib="webworker" />
import { TimelineProcessor, toLuma } from '@sr/core';
import { THUMB_W, THUMB_H, type CaptureSettings } from '@sr/schema';
import type { ToWorker, FromWorker } from './protocol.js';

/**
 * All pixel work happens here. The main thread never touches frame data, so a 30 FPS
 * capture cannot make the UI stutter — which matters because the operator needs to be
 * able to move the sensitivity slider while recording and see the effect immediately.
 */

/**
 * How many full-resolution frames we keep decoded at once.
 *
 * The preroll buffer holds `bufferMs` of frames. At 1 FPS that is 3 bitmaps and we
 * never encode a frame we do not store. At 30 FPS it would be 90 bitmaps — roughly
 * 700 MB at 1080p — so past this cap the oldest buffered frames are encoded to WebP
 * and their bitmaps released. That trades memory for CPU, and it is the real cost of
 * running a 3-second lookahead at high frame rates.
 */
const MAX_LIVE_BITMAPS = 12;

/** Above this many un-encoded frames we tell the recorder to back off. */
const BACKLOG_LIMIT = 24;

const post = (m: FromWorker, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(m, transfer);

const thumbCanvas = new OffscreenCanvas(THUMB_W, THUMB_H);
const thumbCtx = thumbCanvas.getContext('2d', { willReadFrequently: true })!;

/** Lazily-encoded pixels for one buffered frame. */
class Payload {
  private encoded: Promise<{ full: Blob; thumb: Blob }> | null = null;
  released = false;

  constructor(
    public bitmap: ImageBitmap | null,
    readonly w: number,
    readonly h: number,
  ) {}

  get isLive(): boolean {
    return this.bitmap !== null && !this.released;
  }

  /** Idempotent: demotion and storage share the same encode. */
  encode(s: CaptureSettings): Promise<{ full: Blob; thumb: Blob }> {
    if (!this.encoded) {
      const bmp = this.bitmap;
      if (!bmp) return Promise.reject(new Error('payload released before encode'));
      this.encoded = (async () => {
        const scale = Math.min(1, s.maxWidth / this.w);
        const full = await render(bmp, Math.round(this.w * scale), Math.round(this.h * scale), s.quality);
        const tScale = Math.min(1, s.thumbWidth / this.w);
        const thumb = await render(bmp, Math.round(this.w * tScale), Math.round(this.h * tScale), 0.6);
        bmp.close();
        this.bitmap = null;
        return { full, thumb };
      })();
    }
    return this.encoded;
  }

  release(): void {
    this.released = true;
    // Only close if nothing is mid-encode; encode() closes it itself when it finishes.
    if (this.bitmap && !this.encoded) {
      this.bitmap.close();
      this.bitmap = null;
    }
  }
}

async function render(bmp: ImageBitmap, w: number, h: number, quality: number): Promise<Blob> {
  const c = new OffscreenCanvas(Math.max(1, w), Math.max(1, h));
  const ctx = c.getContext('2d')!;
  ctx.drawImage(bmp, 0, 0, w, h);
  return c.convertToBlob({ type: 'image/webp', quality });
}

let settings: CaptureSettings | null = null;
let proc: TimelineProcessor<Payload> | null = null;
let live: Payload[] = [];
let backlog = 0;

self.onmessage = async (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  try {
    switch (msg.type) {
      case 'start':
        settings = msg.settings;
        live = [];
        backlog = 0;
        proc = new TimelineProcessor<Payload>(settings, (f) => f.payload.release());
        break;

      case 'settings':
        settings = msg.settings;
        proc?.updateSettings(msg.settings);
        break;

      case 'frame':
        await onFrame(msg.bitmap, msg.seq, msg.tMs);
        break;

      case 'flush': {
        if (proc && settings) await emit(proc.flush());
        post({ type: 'flushed' });
        break;
      }
    }
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};

async function onFrame(bitmap: ImageBitmap, seq: number, tMs: number): Promise<void> {
  if (!proc || !settings) {
    bitmap.close();
    return;
  }

  // Luma thumbnail for the diff. Grayscale at 160x90 — the diff never sees full res.
  thumbCtx.drawImage(bitmap, 0, 0, THUMB_W, THUMB_H);
  const luma = toLuma(thumbCtx.getImageData(0, 0, THUMB_W, THUMB_H).data);

  const payload = new Payload(bitmap, bitmap.width, bitmap.height);
  live.push(payload);
  proc.push({ seq, tMs, luma, payload });

  demoteOldest();
  await emit(proc.drain(tMs));

  post({ type: 'stats', stats: proc.stats, activity: proc.activity.slice(-240), backlog });
}

/** Encode-and-release the oldest live bitmaps once we exceed the memory cap. */
function demoteOldest(): void {
  live = live.filter((p) => p.isLive || p.released === false);
  const liveOnes = live.filter((p) => p.isLive);
  if (liveOnes.length <= MAX_LIVE_BITMAPS || !settings) return;

  for (const p of liveOnes.slice(0, liveOnes.length - MAX_LIVE_BITMAPS)) {
    backlog++;
    p.encode(settings)
      .catch(() => undefined)
      .finally(() => {
        backlog--;
      });
  }
  live = live.filter((p) => !p.released);
}

async function emit(decisions: ReturnType<TimelineProcessor<Payload>['drain']>): Promise<void> {
  if (!settings) return;
  for (const d of decisions) {
    const { full, thumb } = await d.frame.payload.encode(settings);
    post(
      {
        type: 'stored',
        seq: d.frame.seq,
        tMs: d.frame.tMs,
        reason: d.reason,
        changeScore: d.changeScore,
        changedTiles: d.changedTiles,
        width: d.frame.payload.w,
        height: d.frame.payload.h,
        full,
        thumb,
      },
      [],
    );
    d.frame.payload.release();
  }
}

export const BACKLOG_THRESHOLD = BACKLOG_LIMIT;
