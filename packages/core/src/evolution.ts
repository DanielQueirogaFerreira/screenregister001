/**
 * The force-directed layout behind the codebase navigator.
 *
 * It is the Gource model — a tree of directories and files, sprung apart until it settles,
 * with commits lighting up the files they touched — written as pure functions so it can be
 * tested without a canvas, a browser, or a video encoder. The renderer decides what a node
 * looks like; everything about where it goes is here.
 *
 * Three forces, and they are the whole thing:
 *
 *   1. Every node is on a spring to its parent directory. That is what makes a tree look
 *      like a tree rather than a cloud.
 *   2. Siblings repel each other. Without this the spring collapses every child of a
 *      directory onto the same point, since the spring alone has no opinion about angle.
 *   3. Directories repel all other directories. Siblings-only repulsion keeps each folder
 *      tidy internally while letting two unrelated branches drift through each other, and
 *      a graph where apps/web sits inside packages/core is worse than no graph.
 *
 * Repulsion is deliberately not global over every node. That is O(n^2) over every file in
 * the repository on every animation frame; restricting it to siblings and to the far
 * smaller set of directories gives the same picture for a fraction of the work, which is
 * what keeps this at 60fps on a laptop that is also recording its own screen.
 */

/** One commit, as scripts/evolution-log.mjs writes it. */
export interface EvoEvent {
  /** Unix seconds. */
  t: number;
  /** Index into `EvoLog.authors`. */
  a: number;
  s: string;
  m: string;
  /** [index into `EvoLog.paths`, 'A' | 'M' | 'D'] */
  f: [number, string][];
}

export interface EvoLog {
  generated_at: string;
  window_days: number;
  since: number | null;
  until: number | null;
  head: { sha: string; at: number; subject: string } | null;
  authors: string[];
  paths: string[];
  /** 1 if the path still exists at HEAD, 0 if it has since been deleted. */
  alive: number[];
  events: EvoEvent[];
  totals: {
    commits: number;
    files_touched: number;
    files_at_head: number;
    authors: number;
    edits: number;
  };
}

export interface EvoNode {
  /** Full path. The root is the empty string. */
  id: string;
  /** Last segment — what the label shows. */
  name: string;
  /** Index into the same array, or -1 for the root. Always less than this node's own. */
  parent: number;
  depth: number;
  file: boolean;
  /** Index into `EvoLog.paths` for files, -1 for directories. */
  pathIndex: number;
}

/**
 * Build the directory tree the paths imply.
 *
 * Parents always come before their children, so one forward pass can position the whole
 * tree — several places below rely on that and it is cheaper to guarantee here than to
 * sort for repeatedly.
 */
export function buildTree(paths: string[]): EvoNode[] {
  const nodes: EvoNode[] = [
    { id: '', name: '', parent: -1, depth: 0, file: false, pathIndex: -1 },
  ];
  const index = new Map<string, number>([['', 0]]);

  // Sorted, so the tree is identical whatever order the log lists paths in — the layout
  // seeds off node order, and a graph that rearranges itself between deploys for no reason
  // would look like the codebase changed when it did not.
  const sorted = [...paths].map((p, i) => [p, i] as const).sort((a, b) => a[0].localeCompare(b[0]));

  for (const [path, pathIndex] of sorted) {
    const parts = path.split('/').filter(Boolean);
    if (parts.length === 0) continue;
    let parent = 0;
    let prefix = '';
    for (let d = 0; d < parts.length; d++) {
      const name = parts[d]!;
      prefix = prefix ? `${prefix}/${name}` : name;
      const last = d === parts.length - 1;
      const existing = index.get(prefix);
      if (existing !== undefined) {
        // A path can be both: "apps/web" is a directory here and would be a file in a log
        // that also recorded it directly. Directory wins — it has children to hold.
        parent = existing;
        continue;
      }
      const node: EvoNode = {
        id: prefix,
        name,
        parent,
        depth: d + 1,
        file: last,
        pathIndex: last ? pathIndex : -1,
      };
      nodes.push(node);
      index.set(prefix, nodes.length - 1);
      parent = nodes.length - 1;
    }
  }
  return nodes;
}

export interface Layout {
  /** Where a node is drawn: its physics position plus the current drift offset. */
  x: Float64Array;
  y: Float64Array;
  z: Float64Array;
  vx: Float64Array;
  vy: Float64Array;
  vz: Float64Array;
  /**
   * The drift offset currently folded into x/y/z.
   *
   * Kept so it can be taken back out before each step. The physics must never see it, or
   * the two fight: the forces treat the displacement as a real perturbation, push against
   * it, and the equilibrium walks. Measured on the first attempt, which added the drift as
   * a force instead — nodes strayed 134 world units from where they settled, about four
   * times the spring's rest length. That is a graph slowly reorganising itself, not a
   * graph breathing.
   */
  wx: Float64Array;
  wy: Float64Array;
  wz: Float64Array;
}

/**
 * A deterministic starting position for every node.
 *
 * Random seeding would give a different picture on every page load, and a diagram that
 * never looks the same twice cannot be pointed at. Hashing the path means the layout is a
 * property of the repository rather than of when you happened to open the page.
 *
 * Nodes still need to start *apart*: with every child stacked on its parent the sibling
 * repulsion has no direction to push in and the tree unfolds along whatever axis floating
 * point noise picks first.
 */
export function seedLayout(nodes: EvoNode[]): Layout {
  const n = nodes.length;
  const l: Layout = {
    x: new Float64Array(n), y: new Float64Array(n), z: new Float64Array(n),
    vx: new Float64Array(n), vy: new Float64Array(n), vz: new Float64Array(n),
    wx: new Float64Array(n), wy: new Float64Array(n), wz: new Float64Array(n),
  };
  for (let i = 1; i < n; i++) {
    const node = nodes[i]!;
    const h = hash(node.id);
    // Two angles from one hash, on a sphere rather than a circle. Taking the polar angle
    // uniformly would crowd the poles — acos of a uniform cosine spreads points evenly
    // over the surface, which is what keeps the initial cloud from having two dense caps
    // that the repulsion then has to spend hundreds of steps undoing.
    const theta = (h % 3600) / 3600 * Math.PI * 2;
    const phi = Math.acos(1 - 2 * (((h >>> 12) % 1000) + 0.5) / 1000);
    const r = REST * node.depth;
    const p = node.parent;
    l.x[i] = l.x[p]! + Math.sin(phi) * Math.cos(theta) * r;
    l.y[i] = l.y[p]! + Math.cos(phi) * r;
    l.z[i] = l.z[p]! + Math.sin(phi) * Math.sin(theta) * r;
  }
  return l;
}

/** FNV-1a. Any stable hash would do; this one is four lines and has no dependencies. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Spring rest length between a node and its parent, in layout units. */
const REST = 34;

export interface LayoutOptions {
  /** Spring stiffness toward the parent directory. */
  spring: number;
  /** Strength of the push between siblings. */
  repel: number;
  /** Strength of the push between directories anywhere in the tree. */
  dirRepel: number;
  /** Velocity retained per step. Below 1 the graph settles instead of ringing forever. */
  damping: number;
  /** Ceiling on how far a node may move in one step, in layout units. */
  maxStep: number;
  /**
   * Width-to-height ratio the graph should settle into.
   *
   * A tree with no opinion about direction settles into a circle, and a circle drawn in a
   * canvas twice as wide as it is tall wastes more than half the canvas — measured on this
   * repository at 460px tall, the graph filled the height and about 40% of the width.
   * Stretching the repulsion rather than the drawing keeps every node round and every
   * label horizontal; scaling the finished picture would flatten both.
   *
   * 1 is a sphere, which is what a camera that can be turned to any angle wants. Above 1
   * the graph spreads along x only; depth is never stretched, because a shape that is
   * correct head-on and wrong from the side is worse than one that is merely round.
   */
  aspect: number;
  /**
   * Amplitude of the drift that keeps a settled graph alive, in world units. 0 turns it off.
   *
   * The three forces above form a CONVERGING system: they exist to find an equilibrium and
   * then hold it. That is right for the shape and wrong for the impression — measured on
   * this repository, the largest single-step movement falls from 9.6 world units at the
   * start to 0.029 after two thousand steps, which is about a fiftieth of a pixel. A
   * simulation that is still running looks exactly like one that has been switched off.
   *
   * So this adds the one thing a damped system cannot produce on its own: motion that
   * never stops changing. It is a bounded DISPLACEMENT rather than a force, and that
   * distinction is the whole design — a force is only bounded if something happens to pull
   * back, and the first version of this drifted 134 units because nothing did. A
   * displacement is bounded by construction: no node is ever further than this many units
   * (times root three) from where the physics put it, whatever happens.
   */
  wander: number;
  /**
   * The drift's phase, in radians, advanced by the caller from wall-clock time.
   *
   * Passed in rather than read from a clock inside so that the same inputs always give the
   * same output — a layout step that consults Date.now() cannot be tested for anything.
   */
  wanderPhase: number;
}

export const DEFAULT_LAYOUT: LayoutOptions = {
  spring: 0.06,
  repel: 900,
  dirRepel: 4200,
  damping: 0.86,
  maxStep: 12,
  aspect: 1,
  wander: 0,
  wanderPhase: 0,
};

/** Sibling lists, computed once — recomputing them every frame is most of the cost. */
export function siblingGroups(nodes: EvoNode[]): number[][] {
  const groups: number[][] = nodes.map(() => []);
  for (let i = 1; i < nodes.length; i++) groups[nodes[i]!.parent]!.push(i);
  return groups.filter((g) => g.length > 1);
}

export function directoryIndices(nodes: EvoNode[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < nodes.length; i++) if (!nodes[i]!.file) out.push(i);
  return out;
}

/**
 * Advance the simulation one step, in place.
 *
 * The root is pinned at the origin. Something has to be, or the whole graph drifts off in
 * whatever direction the forces happen not to cancel in, and a viewer watching it slide
 * out of frame cannot tell that from a bug.
 */
export function stepLayout(
  nodes: EvoNode[],
  l: Layout,
  groups: number[][],
  dirs: number[],
  o: LayoutOptions = DEFAULT_LAYOUT,
): void {
  const n = nodes.length;
  const fx = new Float64Array(n);
  const fy = new Float64Array(n);
  const fz = new Float64Array(n);

  // Take the drift back out before anything looks at a position. From here to the bottom
  // of this function x/y/z are pure physics; the offset goes back on at the end.
  for (let i = 1; i < n; i++) {
    l.x[i]! -= l.wx[i]!; l.y[i]! -= l.wy[i]!; l.z[i]! -= l.wz[i]!;
  }

  // 1. Springs to the parent.
  for (let i = 1; i < n; i++) {
    const p = nodes[i]!.parent;
    let dx = l.x[i]! - l.x[p]!;
    let dy = l.y[i]! - l.y[p]!;
    let dz = l.z[i]! - l.z[p]!;
    let d = Math.hypot(dx, dy, dz);
    if (d < 1e-6) {
      // Exactly coincident: the direction is undefined, so pick a stable one from the id
      // rather than leaving a division by zero to produce NaN and poison every later frame.
      const a = (hash(nodes[i]!.id) % 3600) / 3600 * Math.PI * 2;
      dx = Math.cos(a); dy = Math.sin(a); dz = 0; d = 1;
    }
    const f = (d - REST) * o.spring;
    const ux = dx / d, uy = dy / d, uz = dz / d;
    fx[i]! -= ux * f; fy[i]! -= uy * f; fz[i]! -= uz * f;
    fx[p]! += ux * f; fy[p]! += uy * f; fz[p]! += uz * f;
  }

  // 2. Siblings push apart, 3. directories push apart. Same kernel, different pair lists.
  for (const g of groups) pairRepel(g, l, fx, fy, fz, o.repel, o.aspect);
  pairRepel(dirs, l, fx, fy, fz, o.dirRepel, o.aspect);


  for (let i = 1; i < n; i++) {
    let vx = (l.vx[i]! + fx[i]!) * o.damping;
    let vy = (l.vy[i]! + fy[i]!) * o.damping;
    let vz = (l.vz[i]! + fz[i]!) * o.damping;
    const speed = Math.hypot(vx, vy, vz);
    // A node that has been pushed hard must not teleport across the graph in one frame:
    // it would fly past everything that was holding it in place and come back oscillating.
    if (speed > o.maxStep) {
      vx = vx / speed * o.maxStep; vy = vy / speed * o.maxStep; vz = vz / speed * o.maxStep;
    }
    l.vx[i] = vx; l.vy[i] = vy; l.vz[i] = vz;
    l.x[i]! += vx; l.y[i]! += vy; l.z[i]! += vz;
  }
  l.x[0] = 0; l.y[0] = 0; l.z[0] = 0;
  l.vx[0] = 0; l.vy[0] = 0; l.vz[0] = 0;

  // The drift, back on.
  //
  // Each axis runs at its own rate and each node takes its own offset from its id, so the
  // graph never synchronises into a single pulse — a shared phase makes every node lean the
  // same way at the same moment, which reads as a glitch rather than as life. Deterministic
  // throughout, so the motion is a property of the repository and not of when the page
  // happened to load. With an amplitude of zero this writes zeros, which is what returns a
  // drifting graph to rest the moment it is switched to fixed.
  for (let i = 1; i < n; i++) {
    const h = hash(nodes[i]!.id);
    const wx = o.wander * Math.sin(o.wanderPhase * 0.83 + (h & 1023) * 0.00614);
    const wy = o.wander * Math.sin(o.wanderPhase * 1.00 + ((h >>> 10) & 1023) * 0.00614);
    const wz = o.wander * Math.sin(o.wanderPhase * 1.19 + ((h >>> 20) & 1023) * 0.00614);
    l.wx[i] = wx; l.wy[i] = wy; l.wz[i] = wz;
    l.x[i]! += wx; l.y[i]! += wy; l.z[i]! += wz;
  }
}

function pairRepel(
  list: number[], l: Layout, fx: Float64Array, fy: Float64Array, fz: Float64Array,
  k: number, aspect = 1,
): void {
  // Split evenly around 1 so the total push is unchanged and only its direction is biased:
  // scaling x up alone would also inflate the graph every time the canvas got wider.
  const kx = Math.sqrt(aspect);
  const ky = 1 / kx;
  for (let a = 0; a < list.length; a++) {
    const i = list[a]!;
    for (let b = a + 1; b < list.length; b++) {
      const j = list[b]!;
      let dx = l.x[i]! - l.x[j]!;
      let dy = l.y[i]! - l.y[j]!;
      let dz = l.z[i]! - l.z[j]!;
      let d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < 1) {
        // Two nodes on top of each other would otherwise divide by nearly zero and launch
        // both to infinity. Nudge them apart along a fixed axis and let the next step do
        // the work properly.
        dx = (i - j) || 1; dy = 1; dz = 0; d2 = dx * dx + dy * dy + dz * dz;
      }
      const f = k / d2;
      const d = Math.sqrt(d2);
      const ux = dx / d * f * kx, uy = dy / d * f * ky, uz = dz / d * f;
      fx[i]! += ux; fy[i]! += uy; fz[i]! += uz;
      fx[j]! -= ux; fy[j]! -= uy; fz[j]! -= uz;
    }
  }
}

/** Total kinetic energy — how far the layout still is from settled. */
export function energy(l: Layout): number {
  let e = 0;
  for (let i = 0; i < l.x.length; i++) {
    e += l.vx[i]! * l.vx[i]! + l.vy[i]! * l.vy[i]! + l.vz[i]! * l.vz[i]!;
  }
  return e;
}

/**
 * Centre and radius of the smallest sphere the graph fits in.
 *
 * A sphere and not a box, because the camera can be anywhere: a box fitted from one angle
 * crops from another, and this view exists to be turned around.
 */
export function boundingSphere(l: Layout): { x: number; y: number; z: number; r: number } {
  const n = l.x.length;
  if (n === 0) return { x: 0, y: 0, z: 0, r: 1 };
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < n; i++) { cx += l.x[i]!; cy += l.y[i]!; cz += l.z[i]!; }
  cx /= n; cy /= n; cz /= n;
  let r = 0;
  for (let i = 0; i < n; i++) {
    r = Math.max(r, Math.hypot(l.x[i]! - cx, l.y[i]! - cy, l.z[i]! - cz));
  }
  return { x: cx, y: cy, z: cz, r: Math.max(1, r) };
}

export interface Bounds {
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
}

/**
 * Axis-aligned extents.
 *
 * The camera frames with `boundingSphere`, not this — a box fitted from one angle crops
 * from another. This answers the different question of how far the graph reaches along
 * each axis, which is what the layout's own assertions are about.
 */
export function boundsOf(l: Layout): Bounds {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < l.x.length; i++) {
    if (l.x[i]! < minX) minX = l.x[i]!;
    if (l.x[i]! > maxX) maxX = l.x[i]!;
    if (l.y[i]! < minY) minY = l.y[i]!;
    if (l.y[i]! > maxY) maxY = l.y[i]!;
    if (l.z[i]! < minZ) minZ = l.z[i]!;
    if (l.z[i]! > maxZ) maxZ = l.z[i]!;
  }
  if (!Number.isFinite(minX)) {
    return { minX: -1, minY: -1, minZ: -1, maxX: 1, maxY: 1, maxZ: 1 };
  }
  return { minX, minY, minZ, maxX, maxY, maxZ };
}

export const spanX = (b: Bounds): number => b.maxX - b.minX;
export const spanY = (b: Bounds): number => b.maxY - b.minY;
export const spanZ = (b: Bounds): number => b.maxZ - b.minZ;

/**
 * How lit up each file is at a given moment: 1 the instant it is touched, fading to 0 over
 * `decayMs`.
 *
 * Returned as a map rather than an array over every path because on a typical frame a
 * handful of files are warm and several hundred are not, and the renderer's inner loop
 * should not walk the cold ones.
 */
export function heatAt(
  log: EvoLog, atMs: number, decayMs = 12_000,
): Map<number, { heat: number; action: string; author: number }> {
  const out = new Map<number, { heat: number; action: string; author: number }>();
  const fromMs = atMs - decayMs;
  for (const e of log.events) {
    const ms = e.t * 1000;
    if (ms > atMs) break;          // events are in time order
    if (ms < fromMs) continue;
    const heat = 1 - (atMs - ms) / decayMs;
    for (const [p, action] of e.f) {
      const prev = out.get(p);
      // A file touched twice inside the window shows the more recent, brighter touch.
      if (!prev || heat > prev.heat) out.set(p, { heat, action, author: e.a });
    }
  }
  return out;
}

/** The commits inside a window, newest last. Drives the "what just happened" caption. */
export function eventsBetween(log: EvoLog, fromMs: number, toMs: number): EvoEvent[] {
  return log.events.filter((e) => e.t * 1000 > fromMs && e.t * 1000 <= toMs);
}

/**
 * Which files exist at a given moment.
 *
 * Replaying adds and deletes is not enough on its own: a file created before the window
 * opened has no 'A' event here at all, and treating "no add seen" as "does not exist" would
 * hide most of the repository for most of the animation. So a path starts visible if it is
 * alive at HEAD or was ever modified, and the events only move it from there.
 */
export function livePaths(log: EvoLog, atMs: number): Set<number> {
  const live = new Set<number>();
  for (let i = 0; i < log.paths.length; i++) if (log.alive[i]) live.add(i);
  // Walk backwards from HEAD undoing everything after `atMs`, which is cheaper to reason
  // about than replaying forwards from an unknown starting tree.
  for (let i = log.events.length - 1; i >= 0; i--) {
    const e = log.events[i]!;
    if (e.t * 1000 <= atMs) break;
    for (const [p, action] of e.f) {
      if (action === 'A') live.delete(p);
      else if (action === 'D') live.add(p);
    }
  }
  return live;
}

/**
 * Everything the inspector shows about one node.
 *
 * Computed on selection rather than kept per node, because it is wanted for exactly one
 * node at a time and precomputing it for every path would walk the whole log once per file
 * to fill a panel nobody has opened.
 *
 * A directory aggregates its whole subtree. That is the answer people actually want from
 * clicking `packages/core` — how much has happened in there — rather than the strictly
 * true but useless "this directory itself was never edited, it is not a file".
 */
export interface NodeStats {
  path: string;
  file: boolean;
  /** Files beneath this node, itself included when it is a file. */
  files: number;
  /** Commits that touched this node or anything under it. */
  commits: number;
  /** Individual file edits, which exceeds `commits` when one commit touched several. */
  edits: number;
  added: number;
  modified: number;
  deleted: number;
  /** Unix ms of the first and last touch inside the window, or null if never touched. */
  firstMs: number | null;
  lastMs: number | null;
  /** Author index and their commit count here, busiest first. */
  authors: { author: number; commits: number }[];
  /** True if the path (or, for a directory, anything under it) exists at HEAD. */
  alive: boolean;
  /** Most recent commits touching this node, newest first. */
  recent: EvoEvent[];
}

/** The path indices a node covers: itself if a file, its whole subtree if a directory. */
export function coveredPaths(nodes: EvoNode[], index: number): Set<number> {
  const node = nodes[index];
  const out = new Set<number>();
  if (!node) return out;
  if (node.file) {
    out.add(node.pathIndex);
    return out;
  }
  // The root covers everything; any other directory covers what sits under its path. A
  // prefix test needs the trailing slash or `apps/web` would also claim `apps/website`.
  const prefix = node.id === '' ? '' : `${node.id}/`;
  for (const n of nodes) {
    if (n.file && (prefix === '' || n.id.startsWith(prefix))) out.add(n.pathIndex);
  }
  return out;
}

export function nodeStats(
  log: EvoLog, nodes: EvoNode[], index: number, recentLimit = 8,
): NodeStats | null {
  const node = nodes[index];
  if (!node) return null;
  const paths = coveredPaths(nodes, index);

  const authorCommits = new Map<number, number>();
  const recent: EvoEvent[] = [];
  let commits = 0, edits = 0, added = 0, modified = 0, deleted = 0;
  let firstMs: number | null = null;
  let lastMs: number | null = null;

  for (const e of log.events) {
    let hit = 0;
    for (const [p, action] of e.f) {
      if (!paths.has(p)) continue;
      hit++;
      if (action === 'A') added++;
      else if (action === 'M') modified++;
      else if (action === 'D') deleted++;
    }
    if (hit === 0) continue;
    commits++;
    edits += hit;
    authorCommits.set(e.a, (authorCommits.get(e.a) ?? 0) + 1);
    const ms = e.t * 1000;
    if (firstMs === null) firstMs = ms;
    lastMs = ms;
    recent.push(e);
  }

  return {
    path: node.id,
    file: node.file,
    files: paths.size,
    commits,
    edits,
    added,
    modified,
    deleted,
    firstMs,
    lastMs,
    authors: [...authorCommits.entries()]
      .map(([author, n]) => ({ author, commits: n }))
      .sort((a, b) => b.commits - a.commits),
    alive: [...paths].some((p) => log.alive[p] === 1),
    // Newest first: the panel is read top-down and the last thing that happened is the
    // thing someone clicked a node to find out.
    recent: recent.slice(-recentLimit).reverse(),
  };
}

// --- moving about in time ----------------------------------------------------------------

/**
 * The commit in force at `atMs`: the last one at or before it, or -1 before the first.
 *
 * A binary search rather than the linear scan the caption used, because this now runs from
 * a scrubber being dragged rather than from a clock ticking eight times a second, and a
 * project with a year of history has a lot of commits to walk past on every pointer move.
 */
export function commitIndexAt(log: EvoLog, atMs: number): number {
  let lo = 0;
  let hi = log.events.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (log.events[mid]!.t * 1000 <= atMs) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

/**
 * Where the playhead lands stepping one commit back or forward, in ms.
 *
 * Stepping BACK from a position that is already exactly on a commit has to go to the one
 * before it, not stay put — otherwise the button does nothing at the only moment anyone
 * presses it twice. Stepping forward from between two commits goes to the next one, which
 * is the same rule stated the other way round.
 */
export function stepCommit(log: EvoLog, atMs: number, dir: -1 | 1): number | null {
  if (log.events.length === 0) return null;
  const here = commitIndexAt(log, atMs);
  if (dir > 0) {
    // `here` is at or before atMs, so the next one is always here+1 — except when atMs sits
    // exactly on a commit and floating-point has put it a hair behind.
    for (let i = Math.max(0, here); i < log.events.length; i++) {
      const t = log.events[i]!.t * 1000;
      if (t > atMs) return t;
    }
    return null;
  }
  for (let i = here; i >= 0; i--) {
    const t = log.events[i]!.t * 1000;
    if (t < atMs) return t;
  }
  return null;
}

/** One bucket of the timeline strip: where it sits, and how much happened in it. */
export interface TimelineMark {
  /** Position along the track, 0 at the start of the window and 1 at the end. */
  at: number;
  commits: number;
  /** File edits, which is what makes one commit taller than another. */
  edits: number;
}

/**
 * The activity strip behind the scrubber.
 *
 * Evenly spaced ticks would say only "there are commits", which the caption already says.
 * Bucketing by time and drawing the volume in each turns the track into a map of when the
 * work actually happened — so aiming at "that burst last Tuesday" is one glance and one
 * drag rather than scrubbing back and forth to find it.
 *
 * Empty buckets are dropped rather than returned as zeros: a project with a quiet fortnight
 * would otherwise carry a hundred marks of height nothing, each of them a DOM node.
 */
export function timelineMarks(
  log: EvoLog, startMs: number, endMs: number, buckets = 120,
): TimelineMark[] {
  const span = endMs - startMs;
  if (!(span > 0) || buckets < 1) return [];
  const commits = new Float64Array(buckets);
  const edits = new Float64Array(buckets);
  for (const e of log.events) {
    const t = e.t * 1000;
    if (t < startMs || t > endMs) continue;
    // Clamped rather than trusted to land inside: a commit exactly at endMs indexes one
    // past the last bucket, which is a silent out-of-bounds write in a typed array.
    const i = Math.min(buckets - 1, Math.floor(((t - startMs) / span) * buckets));
    commits[i]! += 1;
    edits[i]! += e.f.length;
  }
  const out: TimelineMark[] = [];
  for (let i = 0; i < buckets; i++) {
    if (commits[i]! === 0) continue;
    out.push({ at: (i + 0.5) / buckets, commits: commits[i]!, edits: edits[i]! });
  }
  return out;
}
