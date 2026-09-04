import { ulid, type CaptureSettings, type FrameRecord, type SessionRecord } from '@sr/schema';
import type { ProcessorStats, ActivityPoint } from '@sr/core';
import { sha256Hex, type FrameStore } from '@sr/storage';
import { deviceId, userId } from '../lib/device.js';
import type { FromWorker, ToWorker } from './protocol.js';

export interface RecorderEvents {
  onStored?: (record: FrameRecord, thumb: Blob) => void;
  onStats?: (s: ProcessorStats, activity: ActivityPoint[], backlog: number) => void;
  onStopped?: (reason: string) => void;
  onError?: (message: string) => void;
}

export interface CaptureSupport {
  supported: boolean;
  reason: string;
  path: 'track-processor' | 'video-callback' | 'none';
}

/**
 * Screen capture from a URL exists only on desktop browsers. iOS Safari and Android
 * Chrome do not implement getDisplayMedia at all — it is a platform decision, not a
 * feature gap we can polyfill — so mobile is a playback client until native capture
 * apps post to the same ingest contract.
 */
export function detectSupport(): CaptureSupport {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    return {
      supported: false,
      path: 'none',
      reason: mobile
        ? 'Mobile browsers cannot capture the screen. Open this page on a desktop to record; playback works here.'
        : 'This browser does not support getDisplayMedia. Try Chrome, Edge, Firefox or Safari on desktop.',
    };
  }
  if ('MediaStreamTrackProcessor' in globalThis) {
    return { supported: true, path: 'track-processor', reason: 'Frame-exact capture' };
  }
  return { supported: true, path: 'video-callback', reason: 'Compatibility capture path' };
}

export class Recorder {
  private worker: Worker | null = null;
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private reader: ReadableStreamDefaultReader<VideoFrame> | null = null;
  private running = false;
  private paused = false;
  private seq = 0;
  private stored = 0;
  private bytesStored = 0;
  private startedMs = 0;
  private startedIso = '';
  private lastSampleMs = -Infinity;
  private backlog = 0;
  private session: SessionRecord | null = null;
  /** The frame currently on screen. Its hold_ms is unknown until the next one lands. */
  private openFrame: { id: string; tMs: number } | null = null;

  constructor(
    private store: FrameStore,
    private settings: CaptureSettings,
    private events: RecorderEvents = {},
  ) {}

  get isRunning(): boolean {
    return this.running;
  }
  get isPaused(): boolean {
    return this.paused;
  }
  get sessionId(): string | null {
    return this.session?.session_id ?? null;
  }

  updateSettings(s: CaptureSettings): void {
    this.settings = s;
    this.worker?.postMessage({ type: 'settings', settings: s } satisfies ToWorker);
  }

  /** Blackout: keeps the session open but stops sampling entirely. */
  setPaused(p: boolean): void {
    this.paused = p;
  }

  async start(): Promise<void> {
    if (this.running) return;

    this.stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: Math.max(this.settings.captureFps, 5) } },
      audio: false,
    });

    // The browser's own "Stop sharing" button is the primary stop control; honour it.
    this.stream.getVideoTracks()[0]?.addEventListener('ended', () => {
      void this.stop('screen sharing ended');
    });

    const track = this.stream.getVideoTracks()[0]!;
    const s = track.getSettings();

    this.startedMs = performance.now();
    this.startedIso = new Date().toISOString();
    this.seq = 0;
    this.stored = 0;
    this.bytesStored = 0;
    this.lastSampleMs = -Infinity;
    this.openFrame = null;

    this.session = {
      session_id: ulid(),
      user_id: userId(),
      device_id: deviceId(),
      started_at: this.startedIso,
      ended_at: null,
      capture_fps: this.settings.captureFps,
      sensitivity: this.settings.sensitivity,
      screen_w: s.width ?? 0,
      screen_h: s.height ?? 0,
      frames_stored: 0,
      frames_skipped: 0,
      bytes_stored: 0,
      label: null,
    };
    await this.store.createSession(this.session);

    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => void this.onWorkerMessage(e.data);
    this.worker.postMessage({ type: 'start', settings: this.settings } satisfies ToWorker);

    this.running = true;
    if ('MediaStreamTrackProcessor' in globalThis) this.pumpTrackProcessor(track);
    else await this.pumpVideoCallback();
  }

  async stop(reason = 'stopped'): Promise<void> {
    if (!this.running) return;
    this.running = false;

    await this.reader?.cancel().catch(() => undefined);
    this.reader = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video?.remove();
    this.video = null;

    // Let the worker decide on whatever is still sitting in the preroll buffer.
    await new Promise<void>((resolve) => {
      if (!this.worker) return resolve();
      const w = this.worker;
      const onDone = (e: MessageEvent<FromWorker>) => {
        if (e.data.type === 'flushed') {
          w.removeEventListener('message', onDone);
          resolve();
        }
      };
      w.addEventListener('message', onDone);
      w.postMessage({ type: 'flush' } satisfies ToWorker);
      setTimeout(resolve, 4000); // never hang the UI on a wedged worker
    });

    const endedMs = performance.now() - this.startedMs;
    if (this.openFrame) {
      await this.store.setHold(this.openFrame.id, Math.round(Math.max(0, endedMs - this.openFrame.tMs)));
      this.openFrame = null;
    }
    if (this.session) {
      this.session = {
        ...this.session,
        ended_at: new Date().toISOString(),
        frames_stored: this.stored,
        bytes_stored: this.bytesStored,
      };
      await this.store.updateSession(this.session);
    }

    // Push the last frame out and wait for the backlog. Until this resolves the tail of
    // the session exists only in memory, so reporting "stopped" any earlier would claim a
    // recording that is not yet stored.
    await this.store.flush();

    this.worker?.terminate();
    this.worker = null;
    this.events.onStopped?.(reason);
  }

  /** Chrome/Edge: pull VideoFrames straight off the track. */
  private pumpTrackProcessor(track: MediaStreamTrack): void {
    const Ctor = (globalThis as unknown as {
      MediaStreamTrackProcessor: new (o: { track: MediaStreamTrack }) => {
        readable: ReadableStream<VideoFrame>;
      };
    }).MediaStreamTrackProcessor;

    const reader = new Ctor({ track }).readable.getReader();
    this.reader = reader;

    const loop = async (): Promise<void> => {
      while (this.running) {
        const { done, value } = await reader.read();
        if (done || !value) break;
        await this.maybeSample(value);
        value.close();
      }
    };
    void loop().catch((err) => this.events.onError?.(String(err)));
  }

  /** Firefox/Safari: draw the shared stream into a video element and grab frames. */
  private async pumpVideoCallback(): Promise<void> {
    const v = document.createElement('video');
    v.srcObject = this.stream;
    v.muted = true;
    v.playsInline = true;
    Object.assign(v.style, { position: 'fixed', left: '-10000px', width: '1px', height: '1px' });
    document.body.appendChild(v);
    this.video = v;
    await v.play();

    const tick = async (): Promise<void> => {
      if (!this.running || !this.video) return;
      await this.maybeSample(this.video);
      if (!this.running) return;
      if ('requestVideoFrameCallback' in v) {
        (v as HTMLVideoElement & { requestVideoFrameCallback: (cb: () => void) => number })
          .requestVideoFrameCallback(() => void tick());
      } else {
        setTimeout(() => void tick(), 1000 / this.settings.captureFps);
      }
    };
    void tick();
  }

  /** Rate-limit the incoming stream down to captureFps, with backpressure. */
  private async maybeSample(source: VideoFrame | HTMLVideoElement): Promise<void> {
    const now = performance.now();
    const interval = 1000 / this.settings.captureFps;
    if (now - this.lastSampleMs < interval) return;
    if (this.paused) return;
    // The encoder is behind; skipping a sample is far better than growing an
    // unbounded queue of full-resolution bitmaps.
    if (this.backlog > 24) return;

    this.lastSampleMs = now;
    const bitmap = await createImageBitmap(source as ImageBitmapSource);
    this.worker?.postMessage(
      { type: 'frame', bitmap, seq: this.seq++, tMs: now - this.startedMs } satisfies ToWorker,
      [bitmap],
    );
  }

  private async onWorkerMessage(msg: FromWorker): Promise<void> {
    if (msg.type === 'error') {
      this.events.onError?.(msg.message);
      return;
    }
    if (msg.type === 'stats') {
      this.backlog = msg.backlog;
      this.events.onStats?.(msg.stats, msg.activity, msg.backlog);
      return;
    }
    if (msg.type !== 'stored' || !this.session) return;

    const frameId = ulid(Date.parse(this.startedIso) + msg.tMs);

    // The previous frame stayed on screen until this one arrived. This is where a
    // motionless hour collapses into a single row with hold_ms = 3_600_000.
    if (this.openFrame) {
      await this.store.setHold(this.openFrame.id, Math.round(Math.max(0, msg.tMs - this.openFrame.tMs)));
    }

    const record: FrameRecord = {
      frame_id: frameId,
      session_id: this.session.session_id,
      user_id: this.session.user_id,
      captured_at: new Date(Date.parse(this.startedIso) + msg.tMs).toISOString(),
      offset_ms: Math.round(msg.tMs),
      seq: msg.seq,
      hold_ms: null,
      change_score: msg.changeScore,
      changed_tiles: msg.changedTiles,
      reason: msg.reason,
      width: msg.width,
      height: msg.height,
      bytes: msg.full.size,
      format: 'image/webp',
      sha256: await sha256Hex(msg.full),
      ocr_text: null,
      caption: null,
      enrich_status: 'pending',
    };

    await this.store.putFrame(record, msg.full, msg.thumb);
    this.openFrame = { id: frameId, tMs: msg.tMs };
    this.stored++;
    this.bytesStored += msg.full.size;
    this.events.onStored?.(record, msg.thumb);
  }
}
