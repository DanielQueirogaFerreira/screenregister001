import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  boundingSphere, buildTree, clampTarget, DEFAULT_CAMERA, DEFAULT_LAYOUT, directoryIndices,
  focusOn, frameSphere, heatAt, livePaths, nodeStats, orbit, pan, project, seedLayout,
  siblingGroups, stepLayout, strayedBy, VIEWS, zoom,
  type Camera, type EvoLog, type EvoNode, type Layout, type NodeStats, type Quat,
} from '@sr/core';
import { stampTimeLine } from '@sr/schema';
import { VersionBadge } from './VersionBadge.js';
import { ACTION_COLOUR, ACTION_LABEL, FILE_KINDS, fileColour, fileKind } from '../lib/evolution-palette.js';

/**
 * The codebase as a solid you can walk around.
 *
 * The layout, the camera and the statistics all live in @sr/core, where they are tested
 * without a browser. This file decides what a node looks like and what a drag means, and
 * nothing else.
 *
 * There is no Three.js here, and that was a decision rather than an omission: it is roughly
 * 600 KB against a client that is currently 287 KB whole, to draw a few hundred dots that
 * need no materials, no lighting, no shadows and no scene graph. What was actually needed
 * was one projection and an orbit camera — small enough to write, and testable, which the
 * library version would not have been.
 *
 * Depth is drawn with three cues rather than one, because a single cue reads as noise:
 * nearer nodes are larger (perspective), further ones are dimmer (atmospheric), and
 * everything is painted back to front so nearer nodes genuinely occlude what is behind
 * them. Take any one away and the picture flattens.
 */

const DECAY_MS = 14_000;
/** How long one pass over the whole window takes at 1x. */
const SWEEP_MS = 75_000;

/**
 * How far a node may drift from where the physics put it, in world units, and how fast.
 *
 * Seven against a spring rest length of thirty-four and a node radius of four: a visible
 * sway of a few pixels at the default framing, well short of a node reaching its
 * neighbour's place. The period works out around four seconds, which is slow enough to
 * read as breathing rather than as jitter.
 */
const WANDER = 7;
const WANDER_RATE = 0.0016;   // radians per millisecond

/**
 * The speeds worth having.
 *
 * 0.1 and 0.25 exist because the fast end is easy and the slow end is where the work is:
 * at 1x a busy day goes past in a couple of seconds and a commit you wanted to read is
 * gone before you find it. Below 0.1 the playhead moves slower than the eye notices and
 * pausing is the better tool.
 */
const SPEEDS = [0.1, 0.25, 0.5, 1, 2, 4] as const;

const AUTHOR_COLOURS = ['#4da3ff', '#35c98b', '#f0b23c', '#c98bf0', '#f0645c', '#3ccfd0'];

/** World-space radii. Screen size comes from these times the projected scale. */
const R_FILE = 4.2;
const R_FILE_WARM = 9;
const R_DIR = 5.4;
/** Below a pixel or so a dot is invisible; above forty it is a blob covering its neighbours. */
const R_MIN = 1.1;
const R_MAX = 44;

const timeOf = (s: number) => new Date(s * 1000);
const shortDate = (s: number) =>
  timeOf(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const stamp = (ms: number) =>
  new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/**
 * The playhead clock, split into the part that rarely changes and the part that never
 * stops.
 *
 * Same rule as the frame stamp and the version badge: UTC to the millisecond, with the Z.
 * It comes from the same function so it stays the same rule rather than a third
 * coincidentally-similar format. The date is set small and quiet to the left because it is
 * context you glance at; the time is the thing actually moving.
 */
function splitStamp(ms: number): { date: string; time: string } {
  const iso = stampTimeLine(ms);
  const t = iso.indexOf('T');
  return { date: iso.slice(0, t), time: iso.slice(t + 1) };
}

interface Hit { x: number; y: number; r: number; depth: number; index: number }

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
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [spin, setSpin] = useState(true);
  const [selected, setSelected] = useState<number | null>(null);
  const [hover, setHover] = useState<{ label: string; x: number; y: number } | null>(null);

  /**
   * Two ways of using the same scene, sharing everything that matters.
   *
   * Navigate is for looking around: the graph is alive, the timeline runs, and a click
   * picks something out. Inspect is for holding still: it stops the clock, makes the
   * elements rigid, and turns the camera around whatever is selected. Neither is a
   * different view — the selection, the camera and the playhead survive the switch, so
   * moving between them never costs you the thing you were looking at.
   */
  const [mode, setMode] = useState<'navigate' | 'inspect'>('navigate');
  /**
   * Whether the elements themselves move, kept separate from whether the clock runs.
   *
   * These were one switch and should not have been. Freezing to read a commit also froze
   * the drift, and wanting the drift back meant restarting the timeline. They are coupled
   * by default — pressing Freeze stops both, which is what "freeze" means — and separable
   * whenever the answer is not the default.
   */
  const [motion, setMotion] = useState<'live' | 'fixed'>('live');
  /**
   * The node the camera turns around, or null for a free point in space.
   *
   * When it names a node the target follows that node every frame, so a live graph carries
   * the camera with it instead of drifting out from under it.
   */
  const [orbitOn, setOrbitOn] = useState<number | null>(null);
  const [strayed, setStrayed] = useState(0);
  /** Whether the speed chips are showing. Collapsed by default: it is six extra targets. */
  const [speedOpen, setSpeedOpen] = useState(false);
  const [legendOpen, setLegendOpen] = useState(false);
  const [full, setFull] = useState(false);
  const shell = useRef<HTMLDivElement>(null);

  /**
   * The playhead lives in a ref, not in state.
   *
   * Driving it from state means a re-render on every animation frame — sixty a second, each
   * one rebuilding the component tree to move one dot. The canvas needs a number, not
   * React. So the loop owns the number and the parts a person reads are mirrored into
   * state a few times a second, which is far faster than anyone can read them.
   */
  const clock = useRef(startMs);
  const [atMs, setAtMs] = useState(startMs);
  const cam = useRef<Camera>({ ...DEFAULT_CAMERA });
  const framed = useRef(false);
  const screen = useRef<Hit[]>([]);
  const selectedRef = useRef<number | null>(null);
  selectedRef.current = selected;
  const orbitRef = useRef<number | null>(null);
  orbitRef.current = orbitOn;
  /** The live layout, so buttons outside the loop can read a node's position. */
  const layoutRef = useRef<Layout | null>(null);
  /** Centre and radius of the graph, for the anti-lost clamp and the readout. */
  const sphere = useRef({ x: 0, y: 0, z: 0, r: 1 });
  /** How far the orbit centre has strayed, in graph radii. Mirrored to state at 8 Hz. */
  const strayRef = useRef(0);
  /** The drift's phase, advanced only while the elements are live. */
  const phase = useRef(0);
  const dateRef = useRef<HTMLSpanElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);

  /**
   * Pause freezes the simulation as well as the clock.
   *
   * It used to stop only the clock, on the reasoning that a graph should keep settling
   * while you read a commit. That is wrong for the thing pause is actually for: you press
   * it to look at something, and the something drifts out from under the cursor. Frozen
   * means frozen — the camera still moves, because turning a still object around is the
   * whole point of stopping it.
   */
  const live = useRef({ playing, speed, spin, motion });
  live.current = { playing, speed, spin, motion };

  useEffect(() => {
    const id = setInterval(() => {
      setAtMs(clock.current);
      setStrayed(strayRef.current);
    }, 125);
    return () => clearInterval(id);
  }, []);

  const heat = useMemo(() => heatAt(log, atMs, DECAY_MS), [log, atMs]);
  const current = useMemo(() => {
    let found = null;
    for (const e of log.events) { if (e.t * 1000 > atMs) break; found = e; }
    return found;
  }, [log, atMs]);
  const stats = useMemo(
    () => (selected === null ? null : nodeStats(log, nodes, selected)),
    [log, nodes, selected],
  );

  // --- camera gestures -----------------------------------------------------------------
  /** Live pointers, so two fingers can be told from one without a separate touch handler. */
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const dragged = useRef(0);
  const pinch = useRef<number | null>(null);
  const interacting = useRef(false);

  /**
   * Any camera input from the viewer ends auto-framing for good.
   *
   * Without this the camera keeps refitting the graph until the layout settles — and it
   * overwrites `distance` and `target` while it does, so a wheel or a pan in the first few
   * seconds is silently undone a frame later. Measured before the fix: six notches of zoom
   * moved the graph's on-screen width from 336px to 324px, which is to say not at all.
   * Freezing made it permanent, because a frozen layout never settles and the refit never
   * stopped. The camera is the viewer's from the first time they touch it.
   */
  const setCam = (next: Camera) => { framed.current = true; cam.current = next; };

  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    dragged.current = 0;
    interacting.current = true;
    if (pointers.current.size === 2) pinch.current = pinchSpan(pointers.current);
  };

  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const prev = pointers.current.get(e.pointerId);

    if (!prev) {
      // Not dragging: just name whatever is under the cursor.
      const hit = pick(screen.current, e.clientX - rect.left, e.clientY - rect.top);
      setHover(hit === null
        ? null
        : { label: nodes[hit]!.id || '/', x: e.clientX - rect.left, y: e.clientY - rect.top });
      return;
    }

    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    dragged.current += Math.abs(dx) + Math.abs(dy);

    if (pointers.current.size >= 2) {
      const span2 = pinchSpan(pointers.current);
      if (pinch.current && span2 > 0) setCam(zoom(cam.current, pinch.current / span2));
      pinch.current = span2;
      return;
    }
    // Shift, or any button but the first, pans. Everything else orbits.
    if (e.shiftKey || e.ctrlKey || e.buttons > 1) {
      // Sliding the view is how you choose a centre that is not a node. Doing it while
      // locked to one would fight the lock a frame later, so it releases it.
      if (orbitRef.current !== null) setOrbitOn(null);
      setCam(pan(cam.current, dx, dy, rect.height));
    } else setCam(orbit(cam.current, dx, dy));
  };

  const onUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (pointers.current.size === 0) interacting.current = false;
    // A drag that barely moved was a click. Four pixels of slop, because a mouse always
    // shifts a little between press and release and a graph that refuses to select
    // anything feels broken.
    if (dragged.current < 4) {
      const hit = pick(screen.current, e.clientX - rect.left, e.clientY - rect.top);
      setSelected(hit);
      // In inspect, picking something IS asking to look at it — making that a second
      // click on a separate button would be ceremony.
      if (hit !== null && mode === 'inspect') focusNode(hit);
    }
  };

  const onWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    setCam(zoom(cam.current, e.deltaY > 0 ? 1.12 : 1 / 1.12));
  }, []);

  // Registered by hand rather than through onWheel, because React attaches wheel listeners
  // passively and a passive listener cannot preventDefault — so the page scrolls away
  // underneath while you are trying to zoom.
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [onWheel]);

  const onKey = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 40 : 12;
    const k = e.key;
    if (k === 'ArrowLeft') setCam(orbit(cam.current, -step, 0));
    else if (k === 'ArrowRight') setCam(orbit(cam.current, step, 0));
    else if (k === 'ArrowUp') setCam(orbit(cam.current, 0, -step));
    else if (k === 'ArrowDown') setCam(orbit(cam.current, 0, step));
    else if (k === '+' || k === '=') setCam(zoom(cam.current, 1 / 1.15));
    else if (k === '-' || k === '_') setCam(zoom(cam.current, 1.15));
    else if (k === 'Home') recentre();   // deliberately re-enables the refit
    else if (k === 'Escape') setSelected(null);
    else if (k === ' ') setRunning(!playing);
    else if (k === 'f' || k === 'F') { if (selected !== null) focusNode(selected); }
    else return;
    e.preventDefault();
  };

  /**
   * The anchors. Whatever the camera has been dragged into, these put it back onto a named
   * axis without moving the orbit centre — so they re-orient someone who is lost without
   * also throwing away the thing they had centred.
   */
  const view = (orientation: Quat) => {
    setCam({ ...cam.current, orientation });
    setSpin(false);
  };

  // --- the loop ------------------------------------------------------------------------
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const l = seedLayout(nodes);
    layoutRef.current = l;
    framed.current = false;
    let last = performance.now();
    let raf = 0;
    let stop = false;

    const frame = (now: number) => {
      if (stop) return;
      // Clamped: a backgrounded tab delivers one enormous delta on return, which would
      // otherwise jump the playhead across days in a single step.
      const dt = Math.min(100, now - last);
      last = now;
      const { playing: run, speed: rate, spin: turning, motion: move } = live.current;

      // The clock and the elements are now two decisions, so they are two branches.
      if (run) {
        const next = clock.current + (dt / SWEEP_MS) * span * rate;
        clock.current = next > endMs ? startMs : next;
      }
      if (move === 'live') {
        // The drift is what makes "live" mean anything. Without it the three forces
        // converge and hold, and a converged simulation is indistinguishable from a
        // switched-off one — measured at a fiftieth of a pixel per step after twenty
        // seconds. See LayoutOptions.wander.
        phase.current += dt * WANDER_RATE;
        const o = { ...DEFAULT_LAYOUT, aspect: 1.6, wander: WANDER, wanderPhase: phase.current };
        stepLayout(nodes, l, groups, dirs, o);
        stepLayout(nodes, l, groups, dirs, o);
      }
      if (turning && !interacting.current) {
        cam.current = orbit(cam.current, dt * 0.012, 0);
      }

      const cssW = el.clientWidth || 800;
      const cssH = el.clientHeight || 460;
      const b = boundingSphere(l);
      sphere.current = b;

      // Keep refitting until the graph stops growing, then leave the camera alone — it is
      // the viewer's from that moment on, and a camera that kept refitting would undo
      // every pan and zoom. Reset and Home set this back to false to refit on demand.
      if (!framed.current) {
        cam.current = frameSphere(cam.current, b, b.r, cssW, cssH);
        framed.current = hasSettled(l);
      } else {
        const lock = orbitRef.current;
        if (lock !== null && lock < nodes.length) {
          // Follow the node. On a live graph the thing you centred is still moving, and a
          // camera that stayed on its old position would let it wander off screen.
          cam.current = focusOn(cam.current, { x: l.x[lock]!, y: l.y[lock]!, z: l.z[lock]! });
        } else {
          // Free centre, but never outside the graph itself.
          //
          // The first attempt allowed 2.2 radii of stray, on the theory that a little room
          // outside was useful. Twenty-five hard pans then put the graph off screen
          // entirely — measured, not guessed. The pivot is what the camera looks at, so
          // keeping it inside the bounding sphere is what makes "you cannot get lost" a
          // guarantee rather than a hope: whatever the angle or the zoom, the thing in the
          // middle of the screen is part of the graph.
          cam.current = clampTarget(cam.current, b, b.r);
        }
      }
      strayRef.current = strayedBy(cam.current, b) / Math.max(1, b.r);

      render(el, nodes, l, cam.current, heatRef.current, liveRef.current, screen,
        selectedRef.current, orbitRef.current);

      const shown = splitStamp(clock.current);
      if (dateRef.current) dateRef.current.textContent = shown.date;
      if (timeRef.current) timeRef.current.textContent = shown.time;
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => { stop = true; cancelAnimationFrame(raf); };
  }, [log, nodes, groups, dirs, span, startMs, endMs]);

  // Read through refs so moving the playhead never restarts the loop — that would reseed
  // the layout sixty times a second and the graph would never settle.
  const heatRef = useRef(heat);
  heatRef.current = heat;
  const liveSet = useMemo(() => livePaths(log, atMs), [log, atMs]);
  const liveRef = useRef(liveSet);
  liveRef.current = liveSet;

  const contributors = useMemo(() => {
    const counts = new Map<number, number>();
    for (const e of log.events) counts.set(e.a, (counts.get(e.a) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [log]);

  const seek = (t: number) => { clock.current = t; setAtMs(t); };

  /**
   * Fullscreen puts the scene and its controls edge to edge, and keeps the inspector.
   *
   * Keeping it is the point: fullscreen exists to look at the thing closely, and a
   * fullscreen mode that drops the panel telling you what you are looking at has removed
   * the reason for going fullscreen. On a phone held upright there is no room beside the
   * canvas, so the panel becomes a sheet over the bottom of it instead of a column.
   */
  useEffect(() => {
    const onChange = () => setFull(document.fullscreenElement === shell.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggleFull = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await shell.current?.requestFullscreen({ navigationUI: 'hide' });
    } catch {
      // Refused — Safari on iPhone has no element fullscreen at all. Fall back to filling
      // the viewport with CSS, which gets most of the benefit and cannot fail.
      setFull((v) => !v);
    }
  };

  /** Freeze means freeze: the clock and the elements both. The switches below separate them. */
  const setRunning = (run: boolean) => { setPlaying(run); setMotion(run ? 'live' : 'fixed'); };

  const focusNode = (i: number | null) => {
    const l = layoutRef.current;
    setOrbitOn(i);
    if (i === null || !l) return;
    setCam(focusOn(cam.current, { x: l.x[i]!, y: l.y[i]!, z: l.z[i]! }));
  };

  const recentre = () => {
    setOrbitOn(null);
    framed.current = false;   // let the loop refit once, then hand the camera back
  };

  /**
   * Inspect stops the world; leaving it puts back what was running before.
   *
   * Without the restore, a look at one file silently costs you the animation and you have
   * to remember to press play — which is the sort of small tax that stops people using a
   * mode at all.
   */
  const before = useRef<{ playing: boolean; motion: 'live' | 'fixed' } | null>(null);
  const enterMode = (next: 'navigate' | 'inspect') => {
    if (next === mode) return;
    if (next === 'inspect') {
      before.current = { playing, motion };
      setPlaying(false);
      setMotion('fixed');
      setSpin(false);
      if (selected !== null) focusNode(selected);
    } else if (before.current) {
      setPlaying(before.current.playing);
      setMotion(before.current.motion);
      before.current = null;
    }
    setMode(next);
  };

  return (
    <>
      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Codebase Evolution &amp; Activity</h3>

        <div className={`evo-layout${full ? ' full' : ''}`} ref={shell}>
          <div className="evo-stage">
            <canvas
              ref={canvas}
              className={`evo-canvas${playing ? '' : ' frozen'}`}
              tabIndex={0}
              aria-label="Codebase evolution, in three dimensions. Drag to turn, shift-drag to pan, scroll to zoom, click a node to inspect it."
              onPointerDown={onDown}
              onPointerMove={onMove}
              onPointerUp={onUp}
              onPointerCancel={onUp}
              onPointerLeave={() => setHover(null)}
              onKeyDown={onKey}
            />
            {hover && (
              <div className="evo-tip" style={{ left: hover.x, top: hover.y }}>{hover.label}</div>
            )}
            {/*
              Written by the animation loop, not by React.
              Milliseconds mean nothing at the 8 Hz the readable state runs at — the digits
              would jump in steps of 125. The loop owns this text so the last three digits
              tick at frame rate, and the element carries no React children for the same
              reason: nothing here for a re-render to overwrite.
            */}
            <div className="evo-clock">
              <span className="evo-date" ref={dateRef} />
              <span className="evo-time" ref={timeRef} />
            </div>
            {!playing && <span className="evo-frozen-tag">frozen</span>}
            <div className="evo-viewkeys">
              <button onClick={() => view(VIEWS.front)} title="Look along the z axis">Front</button>
              <button onClick={() => view(VIEWS.side)} title="Look along the x axis">Side</button>
              <button onClick={() => view(VIEWS.top)} title="Look down the y axis">Top</button>
              <button
                onClick={() => { cam.current = { ...DEFAULT_CAMERA }; recentre(); }}
                title="Back to the opening view, centred on the whole graph"
              >
                Reset
              </button>
            </div>

            {/*
              The mode switch, in the corner of the scene it changes.
              Small on purpose: it is a thing you flick without looking away from the graph,
              which is exactly when a control at the far end of the page is useless.
            */}
            {/*
              The cockpit.
              Everything needed while looking at the graph sits in one corner within reach
              of a thumb, because the alternative is reaching across the page for a control
              and losing your place in the scene. Icons rather than words: at this size a
              word is either unreadable or the whole button.
            */}
            <div className="evo-cockpit">
              <div className={`evo-speeds${speedOpen ? ' open' : ''}`}>
                {SPEEDS.map((v) => (
                  <button
                    key={v}
                    className={speed === v ? 'on' : ''}
                    aria-pressed={speed === v}
                    onClick={() => { setSpeed(v); setSpeedOpen(false); }}
                  >
                    {v}&times;
                  </button>
                ))}
              </div>

              <div className="evo-cockpit-row">
                <button
                  className={`evo-cbtn${playing ? '' : ' on'}`}
                  title={playing ? 'Freeze' : 'Play'}
                  aria-label={playing ? 'Freeze' : 'Play'}
                  onClick={() => setRunning(!playing)}
                >
                  {playing ? '❚❚' : '▶'}
                </button>
                {/* The arrow that opens the speeds, showing the current one so the row can
                    stay collapsed without hiding what it is set to. */}
                <button
                  className={`evo-cbtn evo-speedtab${speedOpen ? ' on' : ''}`}
                  title="Playback speed"
                  aria-expanded={speedOpen}
                  onClick={() => setSpeedOpen((v) => !v)}
                >
                  {speed}&times;<i aria-hidden="true">{speedOpen ? '›' : '‹'}</i>
                </button>
                <button
                  className={`evo-cbtn${motion === 'live' ? ' on' : ''}`}
                  title={motion === 'live' ? 'Elements are moving — hold them still' : 'Elements are held still — let them move'}
                  aria-label="Element motion"
                  aria-pressed={motion === 'live'}
                  onClick={() => setMotion(motion === 'live' ? 'fixed' : 'live')}
                >
                  {motion === 'live' ? '◉' : '◎'}
                </button>
                <button
                  className={`evo-cbtn${spin ? ' on' : ''}`}
                  aria-pressed={spin}
                  title={spin ? 'Stop the slow turn' : 'Turn the graph slowly on its own'}
                  onClick={() => setSpin((v) => !v)}
                >
                  <span aria-hidden="true">⟳</span>
                </button>
                <button
                  className={`evo-cbtn${full ? ' on' : ''}`}
                  title={full ? 'Leave fullscreen' : 'Fullscreen'}
                  aria-label={full ? 'Leave fullscreen' : 'Fullscreen'}
                  onClick={toggleFull}
                >
                  {full ? '⤡' : '⛶'}
                </button>
                {/* The colour key, reachable from inside the scene.
                    It also lives under the canvas, but fullscreen leaves that behind — and
                    fullscreen is exactly when an operator is looking hardest at colours
                    they have not memorised. */}
                <button
                  className={`evo-cbtn${legendOpen ? ' on' : ''}`}
                  aria-expanded={legendOpen}
                  title="What the colours mean"
                  aria-label="Colour key"
                  onClick={() => setLegendOpen((v) => !v)}
                >
                  ?
                </button>
                {/* Last in the row because it is the least often touched of the six, and the
                    only one carrying words. */}
                <div className="evo-modeswitch" role="group" aria-label="Interaction mode">
                  <button
                    className={mode === 'navigate' ? 'on' : ''}
                    aria-pressed={mode === 'navigate'}
                    title="Navigate — alive, fly around, click to pick out"
                    onClick={() => enterMode('navigate')}
                  >
                    Nav
                  </button>
                  <button
                    className={mode === 'inspect' ? 'on' : ''}
                    aria-pressed={mode === 'inspect'}
                    title="Inspect — held still, orbits what you select, full detail"
                    onClick={() => enterMode('inspect')}
                  >
                    Inspect
                  </button>
                </div>
              </div>
            </div>

            {legendOpen && <LegendCard onClose={() => setLegendOpen(false)} />}

            {/* Where the camera is turning, and the way back. The crosshair on the canvas
                marks the pivot; this says what the pivot is and how far it has wandered. */}
            <div className="evo-orbit-readout">
              <span className={orbitOn === null ? '' : 'locked'}>
                {orbitOn === null
                  ? 'orbiting a free point'
                  : `orbiting ${nodes[orbitOn]?.name || '/'}`}
              </span>
              {strayed > 0.55 && (
                <button onClick={recentre} title="Bring the whole graph back into view">
                  Recentre
                </button>
              )}
            </div>
          </div>

          <Inspector
            stats={stats}
            log={log}
            mode={mode}
            node={selected === null ? null : nodes[selected] ?? null}
            orbiting={selected !== null && selected === orbitOn}
            onOrbit={() => focusNode(selected)}
            onClear={() => { setSelected(null); if (orbitOn !== null) recentre(); }}
          />
        </div>

        {/* One line describing whichever mode is on, rather than a second pair of buttons
            beside the switch in the corner — two controls for one state is worse than a
            small control and a sentence. */}
        <div className={`evo-modeline ${mode}`}>
          <b>{mode === 'navigate' ? 'Navigate' : 'Inspect'}</b>
          {mode === 'navigate'
            ? ' — the graph is alive and the clock runs. Fly around it; click anything to pick it out.'
            : ' — held still, and the camera turns around whatever you select. Click a node to look at it from every side.'}
        </div>

        {/* Only the scrubber is left out here: it wants width, which is the one thing a
            thumb-sized corner cannot give it. Everything else moved into the cockpit. */}
        <div className="evo-controls">
          <input
            type="range" min={startMs} max={endMs} step={1000} value={atMs}
            aria-label="Timeline position"
            onChange={(e) => { setPlaying(false); seek(Number(e.target.value)); }}
          />
          <button onClick={() => { seek(startMs); setRunning(true); }}>Restart</button>
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

        <Legend />

        <div className="hint evo-help">
          <b>Drag</b> to turn — in any direction, without end · <b>Shift-drag</b> or
          right-drag to move the orbit centre · <b>Scroll</b> or pinch to zoom ·{' '}
          <b>Click</b> a node to pick it out, then <b>Orbit this</b> to turn around it ·
          arrow keys turn, <b>+</b>/<b>−</b> zoom, <b>F</b> orbits the selection,{' '}
          <b>Home</b> recentres, <b>Esc</b> deselects, <b>Space</b> freezes. The crosshair
          marks what the camera is turning around, and the centre can never leave the
          graph behind.
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

/**
 * The colour key.
 *
 * One component, rendered in two places: under the canvas where there is room for it, and
 * as a card inside the scene for fullscreen — where the page below is gone and an operator
 * has nothing else to read a colour against. Two hand-written copies of a key is how a
 * legend drifts from what the canvas draws, which is the bug that put an undocumented
 * amber on this graph in the first place.
 */
function Legend({ inScene = false, onClose }: { inScene?: boolean; onClose?: () => void }) {
  return (
    <div className={inScene ? 'evo-legend-card' : ''}>
      {inScene && (
        <div className="evo-legend-head">
          <b>What the colours mean</b>
          <button onClick={onClose} title="Close" aria-label="Close the colour key">×</button>
        </div>
      )}
      <div className="evo-key">
        <b>The ring — what just happened</b>
        {(['A', 'M', 'D'] as const).map((a) => (
          <span key={a}>
            <i className="ring" style={{ borderColor: ACTION_COLOUR[a] }} /> {ACTION_LABEL[a]}
          </span>
        ))}
        <span className="evo-key-note">expands and fades over a few seconds</span>
      </div>
      <div className="evo-key">
        <b>The dot — what the file is</b>
        {FILE_KINDS.map((k) => (
          <span key={k.id} title={k.hint}>
            <i style={{ background: k.colour }} /> {k.label}
          </span>
        ))}
        <span className="evo-key-note">
          always, brightening when touched; a deleted file shows faded, and only while its
          own commit is on screen
        </span>
      </div>
      <div className="evo-key">
        <b>On the canvas</b>
        <span><i className="cross" /> the orbit centre — what the camera turns around</span>
        <span><i className="sel" /> the selected node</span>
        <span className="evo-key-note">
          nearer nodes are larger and brighter, and hide what is behind them
        </span>
      </div>
    </div>
  );
}

const LegendCard = ({ onClose }: { onClose: () => void }) => (
  <Legend inScene onClose={onClose} />
);

/** What one selected node is, and what has happened to it. */
function Inspector({
  stats, log, node, mode, orbiting, onOrbit, onClear,
}: {
  stats: NodeStats | null; log: EvoLog; node: EvoNode | null;
  mode: 'navigate' | 'inspect'; orbiting: boolean;
  onOrbit: () => void; onClear: () => void;
}) {
  if (!stats || !node) {
    return (
      <aside className="evo-inspect empty-inspect">
        <div className="hint" style={{ margin: 0 }}>
          {mode === 'inspect'
            ? 'Click any node and the camera will turn around it. A file reports its own history; a directory reports everything underneath it.'
            : 'Click any node to pick it out. A file reports its own history; a directory reports everything underneath it.'}
        </div>
      </aside>
    );
  }

  const kind = node.file ? fileKind(node.name) : null;
  return (
    <aside className="evo-inspect">
      <div className="evo-inspect-head">
        <span className="evo-inspect-kind" style={{ background: kind ? kind.colour : '#8a99ad' }} />
        <b title={stats.path}>{node.name || '/'}</b>
        <button onClick={onClear} title="Clear selection">×</button>
      </div>
      <div className="evo-path" title={stats.path}>{stats.path || 'the whole repository'}</div>

      {/* The one navigation control that belongs in the selection panel: having chosen a
          thing, the next thing you want is to look at it from every side. */}
      <button
        className={`evo-orbit-btn${orbiting ? ' on' : ''}`}
        onClick={orbiting ? onClear : onOrbit}
      >
        {orbiting ? '● orbiting this — release' : '⟳ Orbit this element'}
      </button>

      <div className="evo-inspect-tags">
        <span className="tag">{node.file ? (kind?.label ?? 'file') : 'directory'}</span>
        {!node.file && <span className="tag">{stats.files} file{stats.files === 1 ? '' : 's'}</span>}
        <span className={`tag ${stats.alive ? 'heartbeat' : 'burst'}`}>
          {stats.alive ? 'at HEAD' : 'deleted'}
        </span>
      </div>

      {stats.commits === 0 ? (
        <div className="hint">
          Untouched in this window — it predates {log.window_days} days ago and has not
          changed since.
        </div>
      ) : (
        <>
          <div className="evo-inspect-grid">
            <div><b>{stats.commits}</b><span>commits</span></div>
            <div><b>{stats.edits}</b><span>edits</span></div>
            <div><b>{stats.added}</b><span>added</span></div>
            <div><b>{stats.modified}</b><span>modified</span></div>
            <div><b>{stats.deleted}</b><span>deleted</span></div>
          </div>

          <div className="hint">
            {stats.firstMs !== null && (
              <>First touched {stamp(stats.firstMs)}<br /></>
            )}
            {stats.lastMs !== null && <>Last touched {stamp(stats.lastMs)}</>}
          </div>

          <h4>Who</h4>
          <div className="evo-authors">
            {stats.authors.map((a) => (
              <div className="evo-author" key={a.author}>
                <i style={{ background: AUTHOR_COLOURS[a.author % AUTHOR_COLOURS.length] }} />
                <b>{log.authors[a.author]}</b>
                <span className="hint" style={{ margin: 0 }}>{a.commits}</span>
              </div>
            ))}
          </div>

          <h4>Recent commits</h4>
          <ul className="evo-commits">
            {stats.recent.map((e) => (
              <li key={e.s}>
                <code>{e.s}</code> <span>{e.m}</span>
                <em>{stamp(e.t * 1000)} · {log.authors[e.a]}</em>
              </li>
            ))}
          </ul>
        </>
      )}
    </aside>
  );
}

// --- helpers ---------------------------------------------------------------------------

function pinchSpan(ps: Map<number, { x: number; y: number }>): number {
  const [a, b] = [...ps.values()];
  return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
}

/** Nearest node under the cursor, preferring the one in front when two overlap. */
function pick(hits: Hit[], x: number, y: number): number | null {
  let best: Hit | null = null;
  for (const h of hits) {
    // A generous target: a 2px dot is impossible to hit exactly, and a graph that ignores
    // clicks reads as broken rather than as precise.
    if (Math.hypot(h.x - x, h.y - y) > Math.max(10, h.r + 6)) continue;
    if (!best || h.depth < best.depth) best = h;
  }
  return best ? best.index : null;
}

/**
 * Has the graph stopped growing?
 *
 * Used only to decide when to stop auto-framing. Average speed per node rather than total,
 * so the threshold means the same thing for a repository of forty files and one of four
 * hundred.
 */
function hasSettled(l: Layout): boolean {
  const n = l.x.length;
  if (n === 0) return true;
  let e = 0;
  for (let i = 0; i < n; i++) e += Math.abs(l.vx[i]!) + Math.abs(l.vy[i]!) + Math.abs(l.vz[i]!);
  return e / n < 0.05;
}

function render(
  el: HTMLCanvasElement,
  nodes: EvoNode[],
  l: Layout,
  cam: Camera,
  heat: Map<number, { heat: number; action: string; author: number }>,
  liveSet: Set<number>,
  screen: React.MutableRefObject<Hit[]>,
  selected: number | null,
  orbitOn: number | null,
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

  const n = nodes.length;
  const px = new Float64Array(n);
  const py = new Float64Array(n);
  const pd = new Float64Array(n);
  const ps = new Float64Array(n);
  const vis = new Uint8Array(n);

  let near = Infinity;
  let far = -Infinity;
  for (let i = 0; i < n; i++) {
    const q = project({ x: l.x[i]!, y: l.y[i]!, z: l.z[i]! }, cam, cssW, cssH);
    px[i] = q.x; py[i] = q.y; pd[i] = q.depth; ps[i] = q.scale;
    vis[i] = q.visible ? 1 : 0;
    if (q.visible) { near = Math.min(near, q.depth); far = Math.max(far, q.depth); }
  }
  if (!Number.isFinite(near) || !Number.isFinite(far)) { near = 0; far = 1; }
  const range = Math.max(1, far - near);
  /** 1 at the front of the graph, fading back — the atmospheric half of the depth cue. */
  const haze = (i: number) => 1 - 0.62 * Math.min(1, (pd[i]! - near) / range);

  // Edges first and unsorted. They are hairlines behind everything; sorting them into the
  // painter's order costs a second sort of a longer list and changes nothing visible.
  ctx.lineWidth = 1;
  for (let i = 1; i < n; i++) {
    const node = nodes[i]!;
    if (!vis[i] || !vis[node.parent]) continue;
    if (node.file && !liveSet.has(node.pathIndex) && !heat.has(node.pathIndex)) continue;
    ctx.strokeStyle = `rgba(64, 78, 94, ${(0.25 + 0.5 * haze(i)).toFixed(3)})`;
    ctx.beginPath();
    ctx.moveTo(px[node.parent]!, py[node.parent]!);
    ctx.lineTo(px[i]!, py[i]!);
    ctx.stroke();
  }

  // Painter's algorithm: far to near, so nearer nodes genuinely occlude what is behind
  // them. Without it the picture reads as a flat scatter however good the perspective is.
  const order: number[] = [];
  for (let i = 1; i < n; i++) {
    if (!vis[i]) continue;
    const node = nodes[i]!;
    if (node.file && !liveSet.has(node.pathIndex) && !heat.has(node.pathIndex)) continue;
    order.push(i);
  }
  order.sort((a, b) => pd[b]! - pd[a]!);

  screen.current = [];
  const labels: { x: number; y: number; text: string; alpha: number }[] = [];

  for (const i of order) {
    const node = nodes[i]!;
    const x = px[i]!;
    const y = py[i]!;
    const dim = haze(i);
    const h = node.file ? heat.get(node.pathIndex) : undefined;
    const warmth = h?.heat ?? 0;
    const exists = node.file ? liveSet.has(node.pathIndex) : true;

    const worldR = node.file ? R_FILE + warmth * R_FILE_WARM : R_DIR;
    const r = Math.max(R_MIN, Math.min(R_MAX, worldR * ps[i]!));

    ctx.globalAlpha = (exists ? 1 : 0.4) * (0.35 + 0.65 * dim);
    ctx.fillStyle = node.file
      ? (warmth > 0 ? mix(fileColour(node.name), '#ffffff', warmth * 0.42) : fileColour(node.name))
      : '#8a99ad';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();

    if (node.file && warmth > 0) {
      // The only place an action colour appears, which is what lets the dot keep meaning
      // one thing. It expands and fades as the heat decays.
      ctx.globalAlpha = warmth * 0.75 * dim;
      ctx.strokeStyle = ACTION_COLOUR[h!.action] ?? '#4da3ff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, r + (1 - warmth) * 26 * ps[i]! * 1.4, 0, Math.PI * 2);
      ctx.stroke();
      if (warmth > 0.45) labels.push({ x: x + r + 4, y: y + 3, text: node.name, alpha: (warmth - 0.45) / 0.55 });
    }

    if (i === selected) {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = '#e6edf5';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, r + 6, 0, Math.PI * 2);
      ctx.stroke();
      labels.push({ x: x + r + 9, y: y + 4, text: node.id || '/', alpha: 1 });
    } else if (!node.file && node.depth <= 2) {
      labels.push({ x: x + r + 5, y: y + 4, text: node.name, alpha: 0.55 + 0.45 * dim });
    }

    ctx.globalAlpha = 1;
    screen.current.push({ x, y, r, depth: pd[i]!, index: i });
  }

  // The orbit centre, which always projects to the middle of the canvas.
  //
  // A camera that turns around an invisible point is disorienting in a way that is hard to
  // name while it is happening: the graph swings and nothing explains what it is swinging
  // about. Drawing the pivot costs four strokes and answers that before it is asked.
  ctx.globalAlpha = 0.5;
  ctx.strokeStyle = orbitOn === null ? '#4a5666' : '#4da3ff';
  ctx.lineWidth = 1;
  const mx = cssW / 2;
  const my = cssH / 2;
  ctx.beginPath();
  ctx.moveTo(mx - 9, my); ctx.lineTo(mx - 3, my);
  ctx.moveTo(mx + 3, my); ctx.lineTo(mx + 9, my);
  ctx.moveTo(mx, my - 9); ctx.lineTo(mx, my - 3);
  ctx.moveTo(mx, my + 3); ctx.lineTo(mx, my + 9);
  ctx.stroke();
  ctx.globalAlpha = 1;

  // Text last, so a node drawn afterwards can never land on top of a label.
  ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
  for (const t of labels) {
    ctx.globalAlpha = t.alpha;
    ctx.fillStyle = '#e6edf5';
    ctx.fillText(t.text, t.x, t.y);
  }
  ctx.globalAlpha = 1;
}

/** Blend two hex colours. `t` of 1 is entirely `b`. */
function mix(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (sh: number) => Math.round(((pa >> sh) & 255) * (1 - t) + ((pb >> sh) & 255) * t);
  return `rgb(${ch(16)}, ${ch(8)}, ${ch(0)})`;
}

/**
 * The entry point from the status page.
 *
 * It loads the same log the full view does — under twenty kilobytes, gzipped to less —
 * rather than a separate summary endpoint, because a link with nothing behind it is a link
 * nobody clicks. Knowing there were eighty commits this month before you decide is the
 * whole value.
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
            A force-directed timelapse of every commit in the last {log.window_days} days, in
            three dimensions — turn it, zoom in, freeze it and click a node to see what has
            happened to that file. Latest tracked:{' '}
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
