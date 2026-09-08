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

/**
 * Columns in the scrub bar, regardless of how many frames there are.
 *
 * The bar used to draw one element per frame at `flex: 1 0 1px` with a 1px gap. A session
 * of 1,623 frames therefore demanded 3,200px it was not allowed to shrink below, so the
 * track ran off the side of the window, took the page's horizontal scrollbar with it, and
 * put most of the timeline somewhere you could not reach. Worse, the click handler divides
 * by the element's width — which was the overflowed width — so seeking landed in the wrong
 * place even for the part you could see.
 *
 * A fixed column count also fixes a second, quieter bug: the ticks were spaced by frame
 * index while the playhead was positioned by elapsed time. Those are different axes
 * whenever frames are unevenly spaced, which is always, so the highlighted tick and the
 * playhead disagreed. Both are now positions on the same time axis.
 */
const TICKS = 240;

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
  /**
   * The playhead is written straight to the DOM from the animation loop. Driving it
   * through state would mean a React render per frame, and the position only changed when
   * the picture did — so during a long still the marker sat frozen while time ran on.
   */
  const headRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);

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

  /** One column per slice of elapsed time, carrying the strongest change inside it. */
  const ticks = useMemo(() => {
    const height = new Float32Array(TICKS);
    if (!timeline.total) return height;
    frames.forEach((f, i) => {
      const col = Math.min(
        TICKS - 1,
        Math.floor((timeline.starts[i]! / timeline.total) * TICKS),
      );
      height[col] = Math.max(height[col]!, f.change_score);
    });
    return height;
  }, [frames, timeline]);

  const currentTick = timeline.total
    ? Math.min(TICKS - 1, Math.floor((timeline.starts[index]! / timeline.total) * TICKS))
    : 0;

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
      if (headRef.current) {
        const at = timeline.total ? (playhead.current / timeline.total) * 100 : 0;
        headRef.current.style.left = `${at}%`;
      }
      void paint(i);
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [frames, playing, speed, timeline, paint]);

  const seek = useCallback((ms: number) => {
    playhead.current = Math.max(0, Math.min(timeline.total, ms));
  }, [timeline.total]);

  /**
   * Pointer events rather than click, so dragging scrubs and a finger works the same as a
   * mouse. Capturing the pointer keeps the drag alive when it leaves the bar, which on a
   * 40px-tall control on a phone is most of the time.
   */
  const scrubTo = useCallback((clientX: number) => {
    const el = trackRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    seek(fraction * timeline.total);
  }, [seek, timeline.total]);

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
        ref={trackRef}
        className="track"
        role="slider"
        tabIndex={0}
        aria-label="Playback position"
        aria-valuemin={0}
        aria-valuemax={Math.round(timeline.total)}
        aria-valuenow={Math.round(playhead.current)}
        aria-valuetext={`${clock(current.captured_at)}, frame ${index + 1} of ${frames.length}`}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          scrubTo(e.clientX);
        }}
        onPointerMove={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId)) scrubTo(e.clientX);
        }}
        onKeyDown={(e) => {
          const step = timeline.total / 50;
          if (e.key === 'ArrowLeft') seek(playhead.current - step);
          else if (e.key === 'ArrowRight') seek(playhead.current + step);
          else if (e.key === 'Home') seek(0);
          else if (e.key === 'End') seek(timeline.total);
          else if (e.key === ' ') setPlaying((p) => !p);
          else return;
          e.preventDefault();
        }}
      >
        {Array.from(ticks, (score, i) => (
          <i
            key={i}
            className={i === currentTick ? 'on' : ''}
            style={{ height: `${Math.max(8, Math.min(100, score * 160))}%` }}
          />
        ))}
        <div ref={headRef} className="head" style={{ left: 0 }} />
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
