import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CaptureSettings, FrameRecord, SessionRecord } from '@sr/schema';
import type { CloudStore } from '@sr/storage';
import { bytes, clock, day, duration } from '../lib/format.js';

interface Props {
  store: CloudStore;
  session: SessionRecord;
  settings: CaptureSettings;
  onBack: () => void;
}

type Mode = 'realtime' | 'condensed';

/** Screen time each frame gets in condensed mode — a whole day in about a minute. */
const CONDENSED_MS = 200;
/** Cross-fade length. Without it, sparse frames read as a slideshow rather than video. */
const FADE_MS = 80;
const PREFETCH = 6;
const CACHE_MAX = 48;

export function PlayerView({ store, session, settings, onBack }: Props) {
  const [frames, setFrames] = useState<FrameRecord[]>([]);
  const [mode, setMode] = useState<Mode>('realtime');
  const [speed, setSpeed] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [index, setIndex] = useState(0);
  const [loading, setLoading] = useState(true);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cache = useRef(new Map<string, ImageBitmap>());
  const playhead = useRef(0);
  const fadeFrom = useRef<{ bitmap: ImageBitmap; at: number } | null>(null);
  const drawnIndex = useRef(-1);

  useEffect(() => {
    void (async () => {
      const f = await store.listFrames(session.session_id);
      setFrames(f);
      setLoading(false);
    })();
    const c = cache.current;
    return () => { c.forEach((b) => b.close()); c.clear(); };
  }, [store, session.session_id]);

  /**
   * Screen time per frame. Real-time honours how long each frame actually stayed up, but
   * compresses anything longer than `skipStillsOverMs` — that is what turns a motionless
   * hour into a five-second skip instead of an hour of watching nothing.
   */
  const timeline = useMemo(() => {
    const starts: number[] = [];
    const spans: number[] = [];
    let acc = 0;
    for (const f of frames) {
      const real = f.hold_ms ?? 1000;
      const span = mode === 'condensed' ? CONDENSED_MS : Math.min(real, settings.skipStillsOverMs);
      starts.push(acc);
      spans.push(span);
      acc += span;
    }
    return { starts, spans, total: acc };
  }, [frames, mode, settings.skipStillsOverMs]);

  const bitmapFor = useCallback(
    async (f: FrameRecord): Promise<ImageBitmap | null> => {
      const hit = cache.current.get(f.frame_id);
      if (hit) return hit;
      // Fetched from R2 through the Worker, with this device's token. The cache below
      // is a decode cache for the current playback pass, not a copy of the recording.
      const blob = await store.getFullBlob(f.frame_id).catch(() => null);
      if (!blob) return null;
      const bmp = await createImageBitmap(blob);
      cache.current.set(f.frame_id, bmp);
      if (cache.current.size > CACHE_MAX) {
        const oldest = cache.current.keys().next().value as string | undefined;
        if (oldest && oldest !== f.frame_id) {
          cache.current.get(oldest)?.close();
          cache.current.delete(oldest);
        }
      }
      return bmp;
    },
    [store],
  );

  // Decode ahead so playback never stalls waiting on a frame fetch.
  useEffect(() => {
    for (let i = index; i < Math.min(frames.length, index + PREFETCH); i++) {
      const f = frames[i];
      if (f) void bitmapFor(f);
    }
  }, [index, frames, bitmapFor]);

  const paint = useCallback(
    async (i: number) => {
      const f = frames[i];
      const canvas = canvasRef.current;
      if (!f || !canvas) return;
      const bmp = await bitmapFor(f);
      if (!bmp) return;

      if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
        canvas.width = bmp.width;
        canvas.height = bmp.height;
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const fade = fadeFrom.current;
      const t = fade ? Math.min(1, (performance.now() - fade.at) / FADE_MS) : 1;
      ctx.globalAlpha = 1;
      if (fade && t < 1) {
        ctx.drawImage(fade.bitmap, 0, 0, canvas.width, canvas.height);
        ctx.globalAlpha = t;
      }
      ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      ctx.globalAlpha = 1;
      if (fade && t >= 1) fadeFrom.current = null;
    },
    [frames, bitmapFor],
  );

  // Advance the playhead and repaint. One rAF loop drives both.
  useEffect(() => {
    if (frames.length === 0) return;
    let raf = 0;
    let prev = performance.now();

    const tick = (now: number) => {
      const dt = now - prev;
      prev = now;

      if (playing) {
        playhead.current += dt * speed;
        if (playhead.current >= timeline.total) {
          playhead.current = timeline.total;
          setPlaying(false);
        }
      }

      let i = frames.length - 1;
      for (let k = 0; k < frames.length; k++) {
        if (playhead.current < timeline.starts[k]! + timeline.spans[k]!) { i = k; break; }
      }
      if (i !== drawnIndex.current) {
        const previous = frames[drawnIndex.current];
        const oldBmp = previous ? cache.current.get(previous.frame_id) : undefined;
        if (oldBmp) fadeFrom.current = { bitmap: oldBmp, at: performance.now() };
        drawnIndex.current = i;
        setIndex(i);
      }
      void paint(i);
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [frames, playing, speed, timeline, paint]);

  const seek = (ms: number) => {
    playhead.current = Math.max(0, Math.min(timeline.total, ms));
  };

  if (loading) return <div className="panel"><div className="empty">Loading frames…</div></div>;
  if (frames.length === 0) {
    return (
      <div className="panel">
        <div className="empty">This session stored no frames.</div>
        <div className="row" style={{ justifyContent: 'center' }}>
          <button onClick={onBack}>Back</button>
        </div>
      </div>
    );
  }

  const current = frames[index]!;
  const realHold = current.hold_ms ?? 0;
  const skipping = mode === 'realtime' && realHold > settings.skipStillsOverMs;

  return (
    <div>
      <div className="row" style={{ marginBottom: 12 }}>
        <button onClick={onBack}>← Library</button>
        <b>{day(session.started_at)} {clock(session.started_at)}</b>
        <span style={{ color: 'var(--dim)' }}>
          {frames.length} frames · {bytes(session.bytes_stored)}
        </span>
        <div className="row" style={{ marginLeft: 'auto' }}>
          <select value={mode} onChange={(e) => { setMode(e.target.value as Mode); seek(0); }} style={{ width: 190 }}>
            <option value="realtime">Real time (skip stills)</option>
            <option value="condensed">Condensed (flip through)</option>
          </select>
          <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} style={{ width: 80 }}>
            {[0.5, 1, 2, 4, 8].map((v) => <option key={v} value={v}>{v}×</option>)}
          </select>
        </div>
      </div>

      <div className="stage">
        <canvas ref={canvasRef} />
        {skipping && (
          <div className="skip">⏩ screen unchanged for {duration(realHold)} — skipped</div>
        )}
      </div>

      <div
        className="track"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          seek(((e.clientX - r.left) / r.width) * timeline.total);
        }}
      >
        {frames.map((f, i) => (
          <i
            key={f.frame_id}
            className={i === index ? 'on' : ''}
            title={`${clock(f.captured_at)} · ${f.reason} · held ${duration(f.hold_ms ?? 0)}`}
            style={{ height: `${Math.max(8, Math.min(100, f.change_score * 160))}%` }}
          />
        ))}
        <div
          className="head"
          style={{ left: `${timeline.total ? (playhead.current / timeline.total) * 100 : 0}%` }}
        />
      </div>

      <div className="row" style={{ marginTop: 12 }}>
        <button className="primary" onClick={() => setPlaying((p) => !p)}>
          {playing ? 'Pause' : 'Play'}
        </button>
        <button onClick={() => seek(timeline.starts[Math.max(0, index - 1)] ?? 0)}>← Prev</button>
        <button onClick={() => seek(timeline.starts[Math.min(frames.length - 1, index + 1)] ?? 0)}>
          Next →
        </button>
        <span className={`tag ${current.reason}`}>{current.reason}</span>
        <span style={{ color: 'var(--dim)' }}>
          {clock(current.captured_at)} · frame {index + 1}/{frames.length} · held{' '}
          {duration(realHold)} · change {(current.change_score * 100).toFixed(1)}%
        </span>
        <code style={{ marginLeft: 'auto' }}>{current.frame_id}</code>
      </div>
    </div>
  );
}
