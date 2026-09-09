import { useEffect, useMemo, useRef, useState } from 'react';
import {
  boundsOf, buildTree, DEFAULT_LAYOUT, directoryIndices, heatAt, livePaths, seedLayout,
  siblingGroups, stepLayout, type EvoLog, type EvoNode, type Layout,
} from '@sr/core';
import { VersionBadge } from './VersionBadge.js';

/**
 * The codebase, animated the way Gource animates one: a tree that springs itself apart,
 * with files lighting up as the commits that touched them go by.
 *
 * It is a canvas rather than a rendered video, and that was a deliberate trade. A Gource
 * MP4 of this repository is tens of megabytes that has to live somewhere — committed, where
 * every daily regeneration adds another blob to git history forever, or in R2, competing
 * for the free tier the recordings need. The log this reads is a few hundred kilobytes of
 * text, rebuilt from scratch on every deploy so it cannot go stale, and it can be scrubbed,
 * paused, and pointed at. A video can only be watched.
 *
 * Everything about where a node goes lives in @sr/core, where it is tested without a
 * browser. This file decides what a node looks like and nothing else.
 */

const DECAY_MS = 14_000;
/** How long one pass over the whole window takes at 1x. */
const SWEEP_MS = 75_000;

const AUTHOR_COLOURS = ['#4da3ff', '#35c98b', '#f0b23c', '#c98bf0', '#f0645c', '#3ccfd0'];

const ACTION_COLOUR: Record<string, string> = {
  A: '#35c98b',   // added
  M: '#4da3ff',   // modified
  D: '#f0645c',   // deleted
};

/** Extension families, so a glance says "this was all frontend" without reading labels. */
function fileColour(name: string): string {
  if (/\.(tsx|jsx)$/.test(name)) return '#7cc4ff';
  if (/\.(ts|mjs|js)$/.test(name)) return '#5b8fc9';
  if (/\.(css|html)$/.test(name)) return '#c98bf0';
  if (/\.(md|txt)$/.test(name)) return '#8a99ad';
  if (/\.(yml|yaml|toml|json)$/.test(name)) return '#f0b23c';
  if (/\.sql$/.test(name)) return '#35c98b';
  return '#6c7c90';
}

const timeOf = (s: number) => new Date(s * 1000);

function shortDate(s: number): string {
  return timeOf(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function EvolutionView() {
  const [log, setLog] = useState<EvoLog | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/evolution.json', { headers: { accept: 'application/json' } })
      .then((r) => {
        if (!r.ok) throw new Error(`the history file answered ${r.status}`);
        return r.json() as Promise<EvoLog>;
      })
      .then((d) => { if (!cancelled) setLog(d); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="app">
      <header>
        <h1>ScreenRegister <span>· codebase evolution</span></h1>
        <nav>
          <a href="/status" className="button-link">&larr; Status</a>
          <a href="/" className="button-link">Recorder</a>
        </nav>
      </header>

      {error && (
        <div className="panel">
          <div className="banner bad">Could not load the history: {error}</div>
          <div className="hint">
            The file is written into the build by <code>scripts/evolution-log.mjs</code>
            during deployment. A local <code>vite dev</code> has not run that step, which is
            the usual reason for this.
          </div>
        </div>
      )}

      {!log && !error && <div className="empty">Reading the history…</div>}
      {log && <Evolution log={log} />}
      <VersionBadge />
    </div>
  );
}

function Evolution({ log }: { log: EvoLog }) {
  const nodes = useMemo(() => buildTree(log.paths), [log]);
  const groups = useMemo(() => siblingGroups(nodes), [nodes]);
  const dirs = useMemo(() => directoryIndices(nodes), [nodes]);
  const startMs = (log.since ?? 0) * 1000;
  const endMs = (log.until ?? 0) * 1000;
  const span = Math.max(1, endMs - startMs);

  const canvas = useRef<HTMLCanvasElement>(null);
  const layout = useRef<Layout | null>(null);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [hover, setHover] = useState<{ name: string; x: number; y: number } | null>(null);
  /** Written by the draw loop, read on hover. A ref because it changes 60 times a second. */
  const screen = useRef<{ x: number; y: number; r: number; node: EvoNode }[]>([]);

  /**
   * The playhead lives in a ref, not in state, and this is the difference between a page
   * that animates and one that fights React.
   *
   * Driving it from state means a re-render on every animation frame — sixty a second, each
   * one recomputing the heat map and the live set and rebuilding the whole component tree
   * to move one dot. The canvas does not need React to draw; it needs a number. So the loop
   * owns the number, and the parts a person actually reads — the clock, the commit caption,
   * the scrubber — are mirrored into state a few times a second, which is far faster than
   * anyone can read them anyway.
   */
  const clock = useRef(startMs);
  const [atMs, setAtMs] = useState(startMs);
  const playRef = useRef({ playing, speed });
  playRef.current = { playing, speed };

  const seek = (t: number) => { clock.current = t; setAtMs(t); };

  // The readable half, at 8 Hz.
  useEffect(() => {
    const id = setInterval(() => setAtMs(clock.current), 125);
    return () => clearInterval(id);
  }, []);

  const heat = useMemo(() => heatAt(log, atMs, DECAY_MS), [log, atMs]);
  const current = useMemo(() => {
    // The most recent commit at or before the playhead — the caption under the canvas.
    let found = null;
    for (const e of log.events) { if (e.t * 1000 > atMs) break; found = e; }
    return found;
  }, [log, atMs]);

  // The simulation, the clock and the drawing: one rAF loop. A settled graph still has to
  // be redrawn every frame, because the heat moves even when the nodes do not.
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const l = seedLayout(nodes);
    layout.current = l;
    let last = performance.now();
    let raf = 0;
    let stop = false;

    const frame = (now: number) => {
      if (stop) return;
      // Clamped: a backgrounded tab delivers one enormous delta on return, which would
      // otherwise jump the playhead across days in a single step.
      const dt = Math.min(100, now - last);
      last = now;
      if (playRef.current.playing) {
        const next = clock.current + (dt / SWEEP_MS) * span * playRef.current.speed;
        clock.current = next > endMs ? startMs : next;   // loop, as the video would have
      }
      // Settle into the shape of the canvas rather than a circle, which on a wide panel
      // leaves most of the width empty. Read every frame so a window resize is followed.
      const aspect = Math.min(3, Math.max(1, (el.clientWidth || 1) / (el.clientHeight || 1)));
      const opts = { ...DEFAULT_LAYOUT, aspect };
      // Two steps a frame: at 60fps the graph reaches its shape in about four seconds,
      // which is roughly how long someone spends reading the heading above it.
      stepLayout(nodes, l, groups, dirs, opts);
      stepLayout(nodes, l, groups, dirs, opts);
      render(
        el, nodes, l,
        heatAt(log, clock.current, DECAY_MS),
        livePaths(log, clock.current),
        screen,
      );
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => { stop = true; cancelAnimationFrame(raf); };
  }, [log, nodes, groups, dirs, span, startMs, endMs]);

  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    let best: { name: string; d: number } | null = null;
    for (const s of screen.current) {
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < Math.max(9, s.r + 5) && (!best || d < best.d)) best = { name: s.node.id, d };
    }
    setHover(best ? { name: best.name, x, y } : null);
  };

  const contributors = useMemo(() => {
    const counts = new Map<number, number>();
    for (const e of log.events) counts.set(e.a, (counts.get(e.a) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [log]);

  return (
    <>
      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Codebase Evolution &amp; Activity</h3>

        <div className="evo-stage">
          <canvas
            ref={canvas}
            className="evo-canvas"
            onPointerMove={onMove}
            onPointerLeave={() => setHover(null)}
          />
          {hover && (
            <div className="evo-tip" style={{ left: hover.x, top: hover.y }}>{hover.name}</div>
          )}
          <div className="evo-clock">
            {timeOf(atMs / 1000).toLocaleString(undefined, {
              month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
            })}
          </div>
        </div>

        <div className="evo-controls">
          <button onClick={() => setPlaying((p) => !p)} className={playing ? '' : 'primary'}>
            {playing ? '❚❚ Pause' : '▶ Play'}
          </button>
          <input
            type="range" min={startMs} max={endMs} step={1000} value={atMs}
            aria-label="Timeline position"
            onChange={(e) => { setPlaying(false); seek(Number(e.target.value)); }}
          />
          <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}
            aria-label="Playback speed">
            <option value={0.5}>0.5×</option>
            <option value={1}>1×</option>
            <option value={2}>2×</option>
            <option value={4}>4×</option>
          </select>
          <button onClick={() => { seek(startMs); setPlaying(true); }}>Restart</button>
        </div>

        <div className="evo-caption">
          {current ? (
            <>
              <code>{current.s}</code>{' '}
              <b style={{ color: AUTHOR_COLOURS[current.a % AUTHOR_COLOURS.length] }}>
                {log.authors[current.a]}
              </b>{' '}
              <span>{current.m}</span>{' '}
              <span className="hint" style={{ margin: 0 }}>
                · {current.f.length} file{current.f.length === 1 ? '' : 's'}
              </span>
            </>
          ) : (
            <span className="hint" style={{ margin: 0 }}>Before the first commit in view.</span>
          )}
        </div>

        <div className="evo-key">
          <span><i style={{ background: ACTION_COLOUR.A }} /> added</span>
          <span><i style={{ background: ACTION_COLOUR.M }} /> modified</span>
          <span><i style={{ background: ACTION_COLOUR.D }} /> deleted</span>
          <span><i style={{ background: '#6c7c90' }} /> untouched right now</span>
        </div>
      </div>

      <div className="panel">
        <h3 style={{ marginTop: 0 }}>What this is showing</h3>
        <div className="stats">
          <div className="stat">
            <b>{log.totals.commits}</b><span>commits in {log.window_days} days</span>
          </div>
          <div className="stat"><b>{log.totals.files_at_head}</b><span>files monitored</span></div>
          <div className="stat">
            <b>{log.totals.files_touched}</b><span>files touched in window</span>
          </div>
          <div className="stat"><b>{log.totals.edits}</b><span>file edits</span></div>
        </div>

        <div className="hint" style={{ marginTop: 12 }}>
          Latest commit tracked:{' '}
          {log.head ? (
            <>
              <code>{log.head.sha}</code> — {log.head.subject}, {' '}
              <time dateTime={timeOf(log.head.at).toISOString()}>
                {timeOf(log.head.at).toLocaleString()}
              </time>
            </>
          ) : '—'}
          <br />
          Window: {log.since ? shortDate(log.since) : '—'} to{' '}
          {log.until ? shortDate(log.until) : '—'}. History rebuilt{' '}
          {new Date(log.generated_at).toLocaleString()} — on every deployment, so it is never
          older than what is running.
        </div>

        <h3>Contributors in this window</h3>
        <div className="evo-authors">
          {contributors.map(([a, n]) => (
            <div className="evo-author" key={a}>
              <i style={{ background: AUTHOR_COLOURS[a % AUTHOR_COLOURS.length] }} />
              <b>{log.authors[a]}</b>
              <span className="hint" style={{ margin: 0 }}>
                {n} commit{n === 1 ? '' : 's'}
              </span>
            </div>
          ))}
        </div>

        <div className="hint" style={{ marginTop: 14 }}>
          Lockfiles, <code>dist/</code> and <code>node_modules/</code> are excluded: they
          change on every dependency bump and would be the loudest thing on the graph while
          saying nothing about the shape of the code. Renames are shown as a delete and an
          add, because that is what they look like — the file leaves one directory and
          appears in another.
        </div>
      </div>
    </>
  );
}

/** Everything the canvas knows about how a repository should look. */
function render(
  el: HTMLCanvasElement,
  nodes: EvoNode[],
  l: Layout,
  heat: Map<number, { heat: number; action: string; author: number }>,
  live: Set<number>,
  screen: React.MutableRefObject<{ x: number; y: number; r: number; node: EvoNode }[]>,
): void {
  const dpr = Math.min(2, self.devicePixelRatio || 1);
  const cssW = el.clientWidth || 800;
  const cssH = el.clientHeight || 460;
  if (el.width !== Math.round(cssW * dpr) || el.height !== Math.round(cssH * dpr)) {
    el.width = Math.round(cssW * dpr);
    el.height = Math.round(cssH * dpr);
  }
  const ctx = el.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  // Fit the graph to the canvas every frame rather than once. The tree grows as it settles
  // and as deleted files fade in and out, and a fixed scale chosen at frame one either
  // wastes most of the canvas or crops the result.
  const b = boundsOf(l);
  const pad = 40;
  const scale = Math.min(
    (cssW - pad * 2) / Math.max(1, b.maxX - b.minX),
    (cssH - pad * 2) / Math.max(1, b.maxY - b.minY),
  );
  const ox = cssW / 2 - ((b.minX + b.maxX) / 2) * scale;
  const oy = cssH / 2 - ((b.minY + b.maxY) / 2) * scale;
  const X = (i: number) => l.x[i]! * scale + ox;
  const Y = (i: number) => l.y[i]! * scale + oy;

  // Edges first, so nothing is drawn over a node.
  ctx.strokeStyle = 'rgba(38, 47, 58, 0.9)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 1; i < nodes.length; i++) {
    const n = nodes[i]!;
    if (n.file && !live.has(n.pathIndex) && !heat.has(n.pathIndex)) continue;
    ctx.moveTo(X(n.parent), Y(n.parent));
    ctx.lineTo(X(i), Y(i));
  }
  ctx.stroke();

  screen.current = [];

  for (let i = 1; i < nodes.length; i++) {
    const n = nodes[i]!;
    const x = X(i);
    const y = Y(i);

    if (!n.file) {
      ctx.fillStyle = 'rgba(138, 153, 173, 0.55)';
      ctx.beginPath();
      ctx.arc(x, y, 3.5, 0, Math.PI * 2);
      ctx.fill();
      // Only the top two levels are labelled. Every directory named at once is a wall of
      // text at this size, and the shape is the point.
      if (n.depth <= 2) {
        ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
        ctx.fillStyle = 'rgba(230, 237, 245, 0.75)';
        ctx.fillText(n.name, x + 7, y + 4);
      }
      screen.current.push({ x, y, r: 4, node: n });
      continue;
    }

    const h = heat.get(n.pathIndex);
    const exists = live.has(n.pathIndex);
    // A file that does not exist yet, or has been deleted, is drawn only while its own
    // commit is still warm — that is the moment it appears or disappears, and it should be
    // visible for it.
    if (!exists && !h) continue;

    const warmth = h?.heat ?? 0;
    const r = 2.6 + warmth * 5.5;
    ctx.globalAlpha = exists ? 1 : 0.35 + warmth * 0.65;
    ctx.fillStyle = warmth > 0
      ? mix(fileColour(n.name), ACTION_COLOUR[h!.action] ?? '#4da3ff', warmth)
      : fileColour(n.name);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();

    if (warmth > 0) {
      // The ring expands and fades as the heat decays, so the eye is drawn to what just
      // changed rather than having to compare brightnesses.
      ctx.globalAlpha = warmth * 0.55;
      ctx.strokeStyle = ACTION_COLOUR[h!.action] ?? '#4da3ff';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, r + (1 - warmth) * 22, 0, Math.PI * 2);
      ctx.stroke();

      if (warmth > 0.45) {
        ctx.globalAlpha = (warmth - 0.45) / 0.55;
        ctx.font = '10px ui-monospace, monospace';
        ctx.fillStyle = '#e6edf5';
        ctx.fillText(n.name, x + r + 4, y + 3);
      }
    }
    ctx.globalAlpha = 1;
    screen.current.push({ x, y, r, node: n });
  }
}

/** Blend two hex colours. `t` of 1 is entirely `b`. */
function mix(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (sh: number) => Math.round(
    ((pa >> sh) & 255) * (1 - t) + ((pb >> sh) & 255) * t,
  );
  return `rgb(${ch(16)}, ${ch(8)}, ${ch(0)})`;
}

/**
 * The entry point from the status page.
 *
 * It loads the same log the full view does — seventeen kilobytes, gzipped to less — rather
 * than a separate summary endpoint, because a link with nothing behind it is a link nobody
 * clicks. Knowing there were eighty commits this month before you decide is the whole
 * value.
 *
 * It fails silently. This is a card on a status page whose job is reporting whether the
 * service is up, and a missing history file is not a service problem; an error banner here
 * would say "something is wrong" about the wrong thing.
 */
export function EvolutionCard() {
  const [log, setLog] = useState<EvoLog | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch('/evolution.json')
      .then((r) => (r.ok ? (r.json() as Promise<EvoLog>) : null))
      .then((d) => { if (!cancelled && d) setLog(d); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="panel">
      <div className="evo-card-link">
        <h3 style={{ margin: 0 }}>Codebase Evolution &amp; Activity</h3>
        <a href="/evolution" className="button-link">Open the animation &rarr;</a>
      </div>
      {log ? (
        <>
          <div className="stats" style={{ marginTop: 12 }}>
            <div className="stat"><b>{log.totals.commits}</b><span>commits · {log.window_days}d</span></div>
            <div className="stat"><b>{log.totals.files_at_head}</b><span>files monitored</span></div>
            <div className="stat"><b>{log.totals.edits}</b><span>file edits</span></div>
            <div className="stat"><b>{log.totals.authors}</b><span>contributors</span></div>
          </div>
          <div className="hint" style={{ marginTop: 10 }}>
            A force-directed timelapse of every commit in the last {log.window_days} days —
            the same picture Gource draws, as a canvas you can scrub rather than a video you
            can only watch. Latest tracked:{' '}
            {log.head ? <><code>{log.head.sha}</code> {log.head.subject}</> : '—'}.
          </div>
        </>
      ) : (
        <div className="hint" style={{ marginTop: 10 }}>
          A force-directed timelapse of recent commits — directories spring apart, files
          light up as they are touched.
        </div>
      )}
    </div>
  );
}
