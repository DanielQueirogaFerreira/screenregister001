/// <reference lib="webworker" />
import {
  TimelineProcessor, findMaskedFields, scaleRegions, stampLayout, toLuma, type Region,
} from '@sr/core';
import {
  STAMP_VERSION, THUMB_W, THUMB_H, stampTimeLine, ulid, type CaptureSettings,
} from '@sr/schema';
import type { CaptureIdentity, ToWorker, FromWorker } from './protocol.js';

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

/**
 * Width the privacy scan runs at.
 *
 * Not the diff's 160x90 grid: a password bullet is a few pixels across on a 1080p screen
 * and disappears entirely at thumbnail size. 1280 keeps a bullet four or five pixels wide,
 * which is the smallest a run of them can be and still be told apart from noise, while
 * costing one downscale and one read per stored frame rather than per sampled frame.
 */
const SCAN_MAX_W = 1280;

const post = (m: FromWorker, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(m, transfer);

const thumbCanvas = new OffscreenCanvas(THUMB_W, THUMB_H);
const thumbCtx = thumbCanvas.getContext('2d', { willReadFrequently: true })!;

export interface Encoded {
  full: Blob;
  thumb: Blob;
  original: Blob | null;
  redacted: boolean;
  regions: Region[];
}

/** Lazily-encoded pixels for one buffered frame. */
class Payload {
  private encoded: Promise<Encoded> | null = null;
  released = false;

  constructor(
    public bitmap: ImageBitmap | null,
    readonly w: number,
    readonly h: number,
    /**
     * Minted when the frame is sampled rather than when it is stored, because the identity
     * has to be drawn into the pixels and by storage time the bitmap may already be gone.
     * Frames that are never stored simply spend an id, which costs nothing.
     */
    readonly frameId: string,
    readonly stamp: string,
    /** The captured instant in UTC, to the millisecond. */
    readonly capturedIso: string,
    /**
     * Minutes behind UTC on the recording machine, as getTimezoneOffset reports them.
     * Kept raw rather than pre-formatted: the row should store the fact, and every place
     * that shows it can render it the same way through formatUtcOffset.
     */
    readonly tzOffsetMinutes: number,
  ) {}

  get isLive(): boolean {
    return this.bitmap !== null && !this.released;
  }

  /**
   * Encode once, whether that is triggered by memory pressure or by the decision to store.
   *
   * The order here is the whole privacy design, and it only works in this order:
   *
   *   1. scan the frame for masked input fields
   *   2. if any were found, paint over them and encode ONLY that
   *   3. otherwise encode the capture untouched, and a second copy carrying the stamp
   *
   * Step 2 never produces an unredacted blob at all. There is no moment where the original
   * exists as an encoded image and is then deleted — deletion is something that can fail,
   * be interrupted, or be beaten by a retry. It is simply never made, and the bitmap it
   * would have come from is closed here in the worker.
   */
  encode(s: CaptureSettings): Promise<Encoded> {
    if (!this.encoded) {
      const bmp = this.bitmap;
      if (!bmp) return Promise.reject(new Error('payload released before encode'));
      this.encoded = (async () => {
        const scale = Math.min(1, s.maxWidth / this.w);
        const w = Math.round(this.w * scale);
        const h = Math.round(this.h * scale);

        let regions: Region[] = [];
        if (s.privacyMask !== 'off') {
          const scan = grayscale(bmp);
          regions = scaleRegions(findMaskedFields(scan.gray, scan.w, scan.h), scan.factor * scale);
        }
        const redacted = regions.length > 0 && s.privacyMask === 'mask';

        // The image that gets stored. Masks first so the stamp is never painted over.
        const ctx = stage(bmp, w, h);
        if (redacted) paintMasks(ctx, regions);
        if (s.burnInStamp) drawStamp(ctx, w, h, [this.stamp, this.capturedIso]);
        const full = await ctx.canvas.convertToBlob({ type: 'image/webp', quality: s.quality });

        // The capture as it was — only when it was asked for, nothing was masked, and the
        // stored image is not already unaltered. Encoding a second copy identical to the
        // first would double the storage cost of the session for nothing.
        const original = s.keepOriginal && s.burnInStamp && !redacted
          ? await render(bmp, w, h, s.quality)
          : null;

        const tScale = Math.min(1, s.thumbWidth / this.w);
        const tw = Math.round(this.w * tScale);
        const th = Math.round(this.h * tScale);
        const tctx = stage(bmp, tw, th);
        // The thumbnail is derived from the stored image, so a redacted frame can never
        // leak through its own preview.
        if (redacted) paintMasks(tctx, scaleRegions(regions, tw / w));
        const thumb = await tctx.canvas.convertToBlob({ type: 'image/webp', quality: 0.6 });

        bmp.close();
        this.bitmap = null;
        return { full, thumb, original, redacted, regions };
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

/** Draw the frame into a canvas at the stored size, so masks and the stamp share one pass. */
function stage(bmp: ImageBitmap, w: number, h: number): OffscreenCanvasRenderingContext2D {
  const c = new OffscreenCanvas(Math.max(1, w), Math.max(1, h));
  const ctx = c.getContext('2d')!;
  ctx.drawImage(bmp, 0, 0, w, h);
  return ctx;
}

/** Grayscale at scan resolution, plus the factor that maps findings back to full size. */
function grayscale(bmp: ImageBitmap): { gray: Uint8Array; w: number; h: number; factor: number } {
  const scale = Math.min(1, SCAN_MAX_W / bmp.width);
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const ctx = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  const gray = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    // Rec. 601 luma, the same weighting the diff uses, so "bright" means one thing here.
    gray[p] = (data[i]! * 77 + data[i + 1]! * 150 + data[i + 2]! * 29) >> 8;
  }
  return { gray, w, h, factor: 1 / scale };
}

/** Solid black, edge to edge of the detected field. Not a blur: a blur can be undone. */
function paintMasks(ctx: OffscreenCanvasRenderingContext2D, regions: Region[]): void {
  ctx.save();
  ctx.fillStyle = '#000';
  for (const r of regions) ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.restore();
}

/**
 * The stamp, drawn into the bottom-left corner.
 *
 * Bottom-left because interfaces put their content top-left and their own status bars
 * bottom-right; the lower left corner is the emptiest part of a typical screen, so this is
 * the least likely place to cover something that matters.
 *
 * It is drawn over a scrim rather than straight onto the pixels, because white text on a
 * white document is unreadable and a stamp nobody can read is not provenance. The scrim is
 * sized to the text, so on a 1080p frame this covers well under one percent of the image.
 *
 * Two lines: the handle and the captured instant in UTC. Deliberately no offset and no
 * local time — see stampTimeLine in @sr/schema for why both were tried and removed. The
 * offset is still recorded, on the row rather than on the picture.
 */
function drawStamp(
  ctx: OffscreenCanvasRenderingContext2D, w: number, h: number, lines: string[],
): void {

  // Measured at the size the layout will choose, so the box is sized for the text that
  // actually gets drawn. Where it lands is decided by @sr/core, where it is tested — a
  // stamp that has drifted off the edge or grown to cover a corner is not something a
  // "did it draw" check would notice.
  const probe = stampLayout(w, h, lines.length, 0);
  const font = `${probe.fontSize}px ui-monospace, "SF Mono", Menlo, Consolas, monospace`;

  ctx.save();
  ctx.font = font;
  ctx.textBaseline = 'alphabetic';
  const textWidth = Math.max(...lines.map((l) => ctx.measureText(l).width));
  const { box, baselines } = stampLayout(w, h, lines.length, textWidth);

  ctx.fillStyle = 'rgba(0, 0, 0, 0.72)';
  ctx.fillRect(box.x, box.y, box.w, box.h);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.94)';
  lines.forEach((line, i) => {
    const b = baselines[i];
    if (b) ctx.fillText(line, b.x, b.y);
  });
  ctx.restore();
}

let settings: CaptureSettings | null = null;
let identity: CaptureIdentity | null = null;
let proc: TimelineProcessor<Payload> | null = null;
let live: Payload[] = [];
let backlog = 0;

self.onmessage = async (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  try {
    switch (msg.type) {
      case 'start':
        settings = msg.settings;
        identity = msg.identity;
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
  if (!proc || !settings || !identity) {
    bitmap.close();
    return;
  }

  // Luma thumbnail for the diff. Grayscale at 160x90 — the diff never sees full res.
  thumbCtx.drawImage(bitmap, 0, 0, THUMB_W, THUMB_H);
  const luma = toLuma(thumbCtx.getImageData(0, 0, THUMB_W, THUMB_H).data);

  // The identity is fixed now, before any pixel work, so the stamp drawn into the image
  // and the row written to the database cannot disagree.
  const capturedMs = identity.startedAtMs + tMs;
  const frameId = ulid(capturedMs);
  /**
   * Computed against the captured instant rather than against "now". Across a daylight
   * saving boundary — or a session left running through one — those differ by an hour, and
   * the whole value of burning this in is that it describes the moment in the picture.
   */
  const tzOffsetMinutes = new Date(capturedMs).getTimezoneOffset();
  const stamp =
    `${STAMP_VERSION}-${frameId}-${identity.deviceFingerprint}${identity.accountFingerprint}`;

  const payload = new Payload(
    bitmap, bitmap.width, bitmap.height,
    frameId, stamp, stampTimeLine(capturedMs), tzOffsetMinutes,
  );
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
    const { full, thumb, original, redacted, regions } = await d.frame.payload.encode(settings);
    post(
      {
        type: 'stored',
        frameId: d.frame.payload.frameId,
        stamp: d.frame.payload.stamp,
        tzOffsetMinutes: d.frame.payload.tzOffsetMinutes,
        seq: d.frame.seq,
        tMs: d.frame.tMs,
        reason: d.reason,
        changeScore: d.changeScore,
        changedTiles: d.changedTiles,
        width: d.frame.payload.w,
        height: d.frame.payload.h,
        full,
        thumb,
        original,
        redacted,
        regions,
      },
      [],
    );
    d.frame.payload.release();
  }
}

export const BACKLOG_THRESHOLD = BACKLOG_LIMIT;
