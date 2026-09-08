import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { encodeStamp, type CaptureSettings, type FrameRecord, type SessionRecord } from '@sr/schema';
import { buildSteps, stepAt, totalSpan, type Step } from '@sr/core';
import type { CloudStore } from '@sr/storage';
import { bytes, clock, day, duration } from '../lib/format.js';

interface Props {
  store: CloudStore;
  /** One or several recordings, played together or one after another. */
  sessions: SessionRecord[];
  settings: CaptureSettings;
  accountId: string;
  onBack: () => void;
  onInspect: (stamp: string) => void;
}

type Mode = 'realtime' | 'condensed';
/** Which of a frame's two images to draw. */
type Variant = 'full' | 'original';
/**
 * How several recordings share the player.
 *
 *   sequence  one after another, on a single screen — the whole period as one run
 *   together  all at once, each on its own pane, aligned by the clock
 *
 * They answer different questions. Sequence answers "what happened over this stretch of
 * time"; together answers "what was on my other screen while this was going on", which
 * needs the panes lined up on the same instant rather than on the same frame number.
 */
type Layout = 'sequence' | 'together';

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
 * track ran off the side of the window and put most of the timeline out of reach.
 */
const TICKS = 240;

/**
 * One recording's picture.
 *
 * Each pane owns its decode cache and its own canvas, because the panes show different
 * recordings at different resolutions and sharing either would mean one pane's prefetch
 * evicting another's current frame.
 */
function Pane({
  store, frame, variant, label, onDoubleClick,
}: {
  store: CloudStore;
  frame: FrameRecord | null;
  variant: Variant;
  label: string | null;
  onDoubleClick: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cache = useRef(new Map<string, ImageBitmap>());
  const fadeFrom = useRef<{ bitmap: ImageBitmap; at: number } | null>(null);
  const drawn = useRef<string | null>(null);

  useEffect(() => {
    const c = cache.current;
    return () => { c.forEach((b) => b.close()); c.clear(); };
  }, []);

  const bitmapFor = useCallback(async (f: FrameRecord): Promise<ImageBitmap | null> => {
    // Keyed by variant as well as by frame: without that, toggling to the original would
    // hand back the stamped bitmap already cached under the same id.
    const key = `${variant}:${f.frame_id}`;
    const hit = cache.current.get(key);
    if (hit) return hit;
    const wanted = variant === 'original' && f.has_original ? 'original' : 'full';
    const blob = await store.getImageBlob(f.frame_id, wanted).catch(() => null);
    if (!blob) return null;
    const bmp = await createImageBitmap(blob);
    cache.current.set(key, bmp);
    if (cache.current.size > CACHE_MAX) {
      const oldest = cache.current.keys().next().value as string | undefined;
      if (oldest && oldest !== key) {
        cache.current.get(oldest)?.close();
        cache.current.delete(oldest);
      }
    }
    return bmp;
  }, [store, variant]);

  useEffect(() => {
    if (!frame) return;
    let cancelled = false;
    void (async () => {
      const bmp = await bitmapFor(frame);
      const canvas = canvasRef.current;
      if (cancelled || !bmp || !canvas) return;

      if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
        canvas.width = bmp.width;
        canvas.height = bmp.height;
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const previous = drawn.current ? cache.current.get(`${variant}:${drawn.current}`) : undefined;
      if (previous && drawn.current !== frame.frame_id) {
        fadeFrom.current = { bitmap: previous, at: performance.now() };
      }
      drawn.current = frame.frame_id;

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
    })();
    return () => { cancelled = true; };
  }, [frame, bitmapFor, variant]);

  return (
    <div className="pane">
      <div className="stage" onDoubleClick={onDoubleClick} title="Double-press to inspect this frame">
        <canvas ref={canvasRef} />
        {!frame && (
          <div className="pane-idle">
            {/* A recording that had not started, or had already ended, at this instant.
                Blank with no explanation reads as a broken pane. */}
            not recording at this moment
          </div>
        )}
      </div>
      {label && <div className="pane-label">{label}</div>}
    </div>
  );
}

export function PlayerView({
  store, sessions, settings, accountId, onBack, onInspect,
}: Props) {
  const [byId, setById] = useState<Record<string, FrameRecord[]>>({});
  const [mode, setMode] = useState<Mode>('realtime');
  const [layout, setLayout] = useState<Layout>(sessions.length > 1 ? 'together' : 'sequence');
  const [variant, setVariant] = useState<Variant>('full');
  const [speed, setSpeed] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(true);

  const playhead = useRef(0);
  const drawnStep = useRef(-1);
  const headRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      const lists = await Promise.all(
        sessions.map(async (s) => [s.session_id, await store.listFrames(s.session_id)] as const),
      );
      if (cancelled) return;
      setById(Object.fromEntries(lists));
      setLoading(false);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, sessions.map((s) => s.session_id).join(',')]);

  const lists = useMemo(
    () => sessions.map((s) => byId[s.session_id] ?? []),
    [sessions, byId],
  );

  /**
   * The combined timeline, as a list of steps.
   *
   * Sequence walks each recording's frames in turn, so the player's clock is the sum of
   * the parts. Together merges every recording's capture instants into one ordered set and
   * shows, at each instant, the frame each recording had on screen then — which is what
   * makes two panes mean the same moment rather than the same frame number. Recordings
   * rarely start together and never tick together, so aligning on anything else would put
   * unrelated moments beside each other and quietly invite the wrong conclusion.
   */
  /**
   * The combined timeline. Built by @sr/core so it can be tested without a browser — the
   * clock-alignment it does is the part most easily got subtly wrong, and the part whose
   * being wrong would be hardest to notice by eye.
   */
  const steps = useMemo<Step[]>(() => buildSteps(lists, {
    layout,
    condensed: mode === 'condensed',
    skipStillsOverMs: settings.skipStillsOverMs,
    condensedMs: CONDENSED_MS,
  }), [lists, layout, mode, settings.skipStillsOverMs]);

  const total = totalSpan(steps);

  /** One column per slice of elapsed time, carrying the strongest change inside it. */
  const ticks = useMemo(() => {
    const height = new Float32Array(TICKS);
    if (!total) return height;
    for (const s of steps) {
      const col = Math.min(TICKS - 1, Math.floor((s.start / total) * TICKS));
      height[col] = Math.max(height[col]!, s.change);
    }
    return height;
  }, [steps, total]);

  const current = steps[step];
  const currentTick = total && current
    ? Math.min(TICKS - 1, Math.floor((current.start / total) * TICKS))
    : 0;

  // Decode ahead so playback never stalls waiting on a fetch.
  useEffect(() => {
    for (let k = step; k < Math.min(steps.length, step + PREFETCH); k++) {
      steps[k]?.at.forEach((i, s) => {
        const f = i >= 0 ? lists[s]?.[i] : null;
        if (f) void store.getImageBlob(f.frame_id, 'full').catch(() => null);
      });
    }
  }, [step, steps, lists, store]);

  const seek = useCallback((ms: number) => {
    playhead.current = Math.max(0, Math.min(total, ms));
  }, [total]);

  const scrubTo = useCallback((clientX: number) => {
    const el = trackRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    seek(Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * total);
  }, [seek, total]);

  // Advance the playhead and pick the step. One rAF loop drives both.
  useEffect(() => {
    if (steps.length === 0) return;
    let raf = 0;
    let prev = performance.now();

    const tick = (now: number) => {
      const dt = now - prev;
      prev = now;

      if (playing) {
        playhead.current += dt * speed;
        if (playhead.current >= total) {
          playhead.current = total;
          setPlaying(false);
        }
      }

      const k = stepAt(steps, playhead.current);
      if (k !== drawnStep.current) {
        drawnStep.current = k;
        setStep(k);
      }
      if (headRef.current) {
        headRef.current.style.left = `${total ? (playhead.current / total) * 100 : 0}%`;
      }
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [steps, playing, speed, total]);

  const inspectPane = useCallback((s: number) => {
    const i = current?.at[s] ?? -1;
    const f = i >= 0 ? lists[s]?.[i] : null;
    if (!f) return;
    void encodeStamp({
      frameId: f.frame_id,
      deviceId: f.device_id || sessions[s]?.device_id || '',
      userId: accountId,
    }).then(onInspect);
  }, [current, lists, sessions, accountId, onInspect]);

  if (loading) return <div className="panel"><div className="empty">Loading frames…</div></div>;

  const totalFrames = lists.reduce((n, f) => n + f.length, 0);
  if (totalFrames === 0) {
    return (
      <div className="panel">
        <div className="empty">
          {sessions.length === 1 ? 'This session stored no frames.'
            : 'None of these sessions stored any frames.'}
        </div>
        <div className="row" style={{ justifyContent: 'center' }}>
          <button onClick={onBack}>Back</button>
        </div>
      </div>
    );
  }

  // In sequence the panes would be all-but-one idle, so only the active one is drawn.
  const visible = layout === 'together'
    ? sessions.map((_, s) => s)
    : [current?.at.findIndex((i) => i >= 0) ?? 0].filter((s) => s >= 0);

  const activeFrame = (s: number): FrameRecord | null => {
    const i = current?.at[s] ?? -1;
    return i >= 0 ? lists[s]?.[i] ?? null : null;
  };

  const anyFrame = visible.map(activeFrame).find(Boolean) ?? null;
  const skipping = mode === 'realtime'
    && anyFrame !== null
    && (anyFrame.hold_ms ?? 0) > settings.skipStillsOverMs;

  return (
    <div>
      <div className="row" style={{ marginBottom: 12 }}>
        <button onClick={onBack}>← Library</button>
        <b>
          {sessions.length === 1
            ? `${day(sessions[0]!.started_at)} ${clock(sessions[0]!.started_at)}`
            : `${sessions.length} recordings`}
        </b>
        <span style={{ color: 'var(--dim)' }}>
          {totalFrames} frames · {bytes(sessions.reduce((n, s) => n + s.bytes_stored, 0))}
        </span>
        <div className="row" style={{ marginLeft: 'auto' }}>
          {sessions.length > 1 && (
            <div className="row" style={{ gap: 4 }}>
              <button
                className={layout === 'together' ? 'on' : ''}
                onClick={() => { setLayout('together'); seek(0); }}
                title="All recordings at once, lined up on the same instant"
              >
                Side by side
              </button>
              <button
                className={layout === 'sequence' ? 'on' : ''}
                onClick={() => { setLayout('sequence'); seek(0); }}
                title="One after another, as a single run"
              >
                In sequence
              </button>
            </div>
          )}
          <select value={mode} onChange={(e) => { setMode(e.target.value as Mode); seek(0); }} style={{ width: 190 }}>
            <option value="realtime">Real time (skip stills)</option>
            <option value="condensed">Condensed (flip through)</option>
          </select>
          <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} style={{ width: 80 }}>
            {[0.5, 1, 2, 4, 8].map((v) => <option key={v} value={v}>{v}×</option>)}
          </select>
          {lists.some((f) => f.some((x) => x.has_original)) && (
            <div className="row" style={{ gap: 4 }}>
              <button
                className={variant === 'full' ? 'on' : ''}
                onClick={() => setVariant('full')}
                title="The stored image, with its stamp and any masks"
              >
                Stamped
              </button>
              <button
                className={variant === 'original' ? 'on' : ''}
                onClick={() => setVariant('original')}
                title="The capture as it was, where one was kept"
              >
                Original
              </button>
            </div>
          )}
        </div>
      </div>

      <div className={`panes ${visible.length > 1 ? 'multi' : ''}`}>
        {visible.map((s) => (
          <Pane
            key={sessions[s]!.session_id}
            store={store}
            frame={activeFrame(s)}
            variant={variant}
            label={sessions.length > 1
              ? `${clock(sessions[s]!.started_at)} · ${sessions[s]!.screen_w}×${sessions[s]!.screen_h}`
              : null}
            onDoubleClick={() => inspectPane(s)}
          />
        ))}
        {skipping && (
          <div className="skip skip-float">
            ⏩ screen unchanged for {duration(anyFrame?.hold_ms ?? 0)} — skipped
          </div>
        )}
      </div>

      <div
        ref={trackRef}
        className="track"
        role="slider"
        tabIndex={0}
        aria-label="Playback position"
        aria-valuemin={0}
        aria-valuemax={Math.round(total)}
        aria-valuenow={Math.round(playhead.current)}
        aria-valuetext={current ? `${clock(new Date(current.wall).toISOString())}, step ${step + 1} of ${steps.length}` : ''}
        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); scrubTo(e.clientX); }}
        onPointerMove={(e) => { if (e.currentTarget.hasPointerCapture(e.pointerId)) scrubTo(e.clientX); }}
        onKeyDown={(e) => {
          const stepMs = total / 50;
          if (e.key === 'ArrowLeft') seek(playhead.current - stepMs);
          else if (e.key === 'ArrowRight') seek(playhead.current + stepMs);
          else if (e.key === 'Home') seek(0);
          else if (e.key === 'End') seek(total);
          else if (e.key === ' ') setPlaying((p) => !p);
          else return;
          e.preventDefault();
        }}
      >
        {Array.from(ticks, (score, i) => (
          <i key={i} className={i === currentTick ? 'on' : ''}
            style={{ height: `${Math.max(8, Math.min(100, score * 160))}%` }} />
        ))}
        <div ref={headRef} className="head" style={{ left: 0 }} />
      </div>

      <div className="row" style={{ marginTop: 12 }}>
        <button className="primary" onClick={() => setPlaying((p) => !p)}>
          {playing ? 'Pause' : 'Play'}
        </button>
        <button onClick={() => seek(steps[Math.max(0, step - 1)]?.start ?? 0)}>← Prev</button>
        <button onClick={() => seek(steps[Math.min(steps.length - 1, step + 1)]?.start ?? 0)}>
          Next →
        </button>
        {anyFrame && (
          <>
            <span className={`tag ${anyFrame.reason}`}>{anyFrame.reason}</span>
            {anyFrame.redacted ? (
              <span className="tag warn-tag" title={`${anyFrame.redacted_regions.length} field(s) masked before upload`}>
                redacted
              </span>
            ) : anyFrame.redacted_regions.length > 0 ? (
              <span className="tag warn-tag" title="Detected but not masked — the setting is 'flag'">
                flagged
              </span>
            ) : null}
          </>
        )}
        <span style={{ color: 'var(--dim)' }}>
          {current ? clock(new Date(current.wall).toISOString()) : '—'} · step {step + 1}/{steps.length}
          {layout === 'together' && sessions.length > 1
            && ` · ${current?.at.filter((i) => i >= 0).length ?? 0}/${sessions.length} recording`}
        </span>
        {anyFrame && (
          <button style={{ marginLeft: 'auto' }} onClick={() => inspectPane(visible[0] ?? 0)}>
            Inspect this frame
          </button>
        )}
      </div>
    </div>
  );
}
