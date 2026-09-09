/**
 * The force-directed layout behind the "Codebase Evolution" view.
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
  x: Float64Array;
  y: Float64Array;
  vx: Float64Array;
  vy: Float64Array;
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
    x: new Float64Array(n), y: new Float64Array(n),
    vx: new Float64Array(n), vy: new Float64Array(n),
  };
  for (let i = 1; i < n; i++) {
    const node = nodes[i]!;
    const h = hash(node.id);
    const angle = (h % 3600) / 3600 * Math.PI * 2;
    const r = REST * node.depth;
    const p = node.parent;
    l.x[i] = l.x[p]! + Math.cos(angle) * r;
    l.y[i] = l.y[p]! + Math.sin(angle) * r;
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
   * 1 is a circle, which is what the tests want and what a square canvas wants.
   */
  aspect: number;
}

export const DEFAULT_LAYOUT: LayoutOptions = {
  spring: 0.06,
  repel: 900,
  dirRepel: 4200,
  damping: 0.86,
  maxStep: 12,
  aspect: 1,
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

  // 1. Springs to the parent.
  for (let i = 1; i < n; i++) {
    const p = nodes[i]!.parent;
    let dx = l.x[i]! - l.x[p]!;
    let dy = l.y[i]! - l.y[p]!;
    let d = Math.hypot(dx, dy);
    if (d < 1e-6) {
      // Exactly coincident: the direction is undefined, so pick a stable one from the id
      // rather than leaving a division by zero to produce NaN and poison every later frame.
      const a = (hash(nodes[i]!.id) % 3600) / 3600 * Math.PI * 2;
      dx = Math.cos(a); dy = Math.sin(a); d = 1;
    }
    const f = (d - REST) * o.spring;
    const ux = dx / d, uy = dy / d;
    fx[i]! -= ux * f; fy[i]! -= uy * f;
    fx[p]! += ux * f; fy[p]! += uy * f;
  }

  // 2. Siblings push apart, 3. directories push apart. Same kernel, different pair lists.
  for (const g of groups) pairRepel(g, l, fx, fy, o.repel, o.aspect);
  pairRepel(dirs, l, fx, fy, o.dirRepel, o.aspect);

  for (let i = 1; i < n; i++) {
    let vx = (l.vx[i]! + fx[i]!) * o.damping;
    let vy = (l.vy[i]! + fy[i]!) * o.damping;
    const speed = Math.hypot(vx, vy);
    // A node that has been pushed hard must not teleport across the graph in one frame:
    // it would fly past everything that was holding it in place and come back oscillating.
    if (speed > o.maxStep) { vx = vx / speed * o.maxStep; vy = vy / speed * o.maxStep; }
    l.vx[i] = vx; l.vy[i] = vy;
    l.x[i]! += vx; l.y[i]! += vy;
  }
  l.x[0] = 0; l.y[0] = 0; l.vx[0] = 0; l.vy[0] = 0;
}

function pairRepel(
  list: number[], l: Layout, fx: Float64Array, fy: Float64Array, k: number, aspect = 1,
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
      let d2 = dx * dx + dy * dy;
      if (d2 < 1) {
        // Two nodes on top of each other would otherwise divide by nearly zero and launch
        // both to infinity. Nudge them apart along a fixed axis and let the next step do
        // the work properly.
        dx = (i - j) || 1; dy = 1; d2 = dx * dx + dy * dy;
      }
      const f = k / d2;
      const d = Math.sqrt(d2);
      const ux = dx / d * f * kx, uy = dy / d * f * ky;
      fx[i]! += ux; fy[i]! += uy;
      fx[j]! -= ux; fy[j]! -= uy;
    }
  }
}

/** Total kinetic energy — how far the layout still is from settled. */
export function energy(l: Layout): number {
  let e = 0;
  for (let i = 0; i < l.x.length; i++) e += l.vx[i]! * l.vx[i]! + l.vy[i]! * l.vy[i]!;
  return e;
}

export interface Bounds { minX: number; minY: number; maxX: number; maxY: number }

export function boundsOf(l: Layout): Bounds {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < l.x.length; i++) {
    if (l.x[i]! < minX) minX = l.x[i]!;
    if (l.x[i]! > maxX) maxX = l.x[i]!;
    if (l.y[i]! < minY) minY = l.y[i]!;
    if (l.y[i]! > maxY) maxY = l.y[i]!;
  }
  if (!Number.isFinite(minX)) return { minX: -1, minY: -1, maxX: 1, maxY: 1 };
  return { minX, minY, maxX, maxY };
}

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
