import { describe, expect, it } from 'vitest';
import {
  boundingSphere, boundsOf, buildTree, coveredPaths, DEFAULT_LAYOUT, directoryIndices,
  energy, eventsBetween, heatAt, livePaths, nodeStats, seedLayout, siblingGroups,
  stepLayout, type EvoLog,
} from './evolution.js';

const PATHS = [
  'apps/web/src/App.tsx',
  'apps/web/src/views/StatusView.tsx',
  'apps/api/src/index.ts',
  'packages/core/src/diff.ts',
  'README.md',
];

function log(over: Partial<EvoLog> = {}): EvoLog {
  return {
    generated_at: '2026-09-09T00:00:00.000Z',
    window_days: 30,
    since: 1000,
    until: 4000,
    head: { sha: 'abc1234', at: 4000, subject: 'head' },
    authors: ['Ana', 'Bo'],
    paths: ['a.ts', 'b.ts', 'c.ts'],
    alive: [1, 1, 0],
    events: [
      { t: 1000, a: 0, s: '1111111', m: 'one', f: [[0, 'A']] },
      { t: 2000, a: 1, s: '2222222', m: 'two', f: [[1, 'A'], [0, 'M']] },
      { t: 3000, a: 0, s: '3333333', m: 'three', f: [[2, 'A']] },
      { t: 4000, a: 0, s: '4444444', m: 'four', f: [[2, 'D']] },
    ],
    totals: { commits: 4, files_touched: 3, files_at_head: 2, authors: 2, edits: 5 },
    ...over,
  };
}

describe('buildTree', () => {
  it('creates the directories the paths imply', () => {
    const ids = buildTree(PATHS).map((n) => n.id);
    expect(ids).toContain('apps');
    expect(ids).toContain('apps/web/src');
    expect(ids).toContain('apps/web/src/views');
    // Each directory appears once however many files hang off it.
    expect(ids.filter((i) => i === 'apps/web/src')).toHaveLength(1);
  });

  it('puts every parent before its children', () => {
    // The layout walks the array forwards and reads parent positions as it goes; a child
    // ahead of its parent would seed off a position that is still (0, 0).
    const nodes = buildTree(PATHS);
    for (let i = 1; i < nodes.length; i++) expect(nodes[i]!.parent).toBeLessThan(i);
  });

  it('marks only leaves as files, and keeps their path index', () => {
    const nodes = buildTree(PATHS);
    const app = nodes.find((n) => n.id === 'apps/web/src/App.tsx')!;
    expect(app.file).toBe(true);
    expect(PATHS[app.pathIndex]).toBe('apps/web/src/App.tsx');
    expect(nodes.find((n) => n.id === 'apps/web/src')!.file).toBe(false);
    expect(nodes.find((n) => n.id === 'apps/web/src')!.pathIndex).toBe(-1);
  });

  it('is the same tree whatever order the paths arrive in', () => {
    // The seed hashes ids and the renderer walks the array; if input order changed the
    // output the graph would rearrange itself between deploys for no reason at all.
    const a = buildTree(PATHS).map((n) => n.id);
    const b = buildTree([...PATHS].reverse()).map((n) => n.id);
    expect(b).toEqual(a);
  });

  it('handles a file at the repository root', () => {
    const nodes = buildTree(['README.md']);
    const readme = nodes.find((n) => n.id === 'README.md')!;
    expect(readme.parent).toBe(0);
    expect(readme.depth).toBe(1);
  });

  it('ignores an empty path list beyond the root', () => {
    expect(buildTree([]).map((n) => n.id)).toEqual(['']);
  });
});

describe('layout', () => {
  const nodes = buildTree(PATHS);

  it('seeds deterministically', () => {
    const a = seedLayout(nodes);
    const b = seedLayout(nodes);
    expect(Array.from(a.x)).toEqual(Array.from(b.x));
    expect(Array.from(a.y)).toEqual(Array.from(b.y));
  });

  it('does not start with every child on top of its parent', () => {
    // If it did, sibling repulsion would have no direction to act in.
    const l = seedLayout(nodes);
    for (let i = 1; i < nodes.length; i++) {
      const p = nodes[i]!.parent;
      expect(Math.hypot(l.x[i]! - l.x[p]!, l.y[i]! - l.y[p]!)).toBeGreaterThan(1);
    }
  });

  it('settles instead of ringing', () => {
    const l = seedLayout(nodes);
    const g = siblingGroups(nodes);
    const d = directoryIndices(nodes);
    for (let i = 0; i < 40; i++) stepLayout(nodes, l, g, d);
    const early = energy(l);
    for (let i = 0; i < 400; i++) stepLayout(nodes, l, g, d);
    expect(energy(l)).toBeLessThan(early);
    expect(energy(l)).toBeLessThan(1);
  });

  it('keeps the root pinned and the graph finite', () => {
    const l = seedLayout(nodes);
    const g = siblingGroups(nodes);
    const d = directoryIndices(nodes);
    for (let i = 0; i < 500; i++) stepLayout(nodes, l, g, d);
    expect(l.x[0]).toBe(0);
    expect(l.y[0]).toBe(0);
    for (let i = 0; i < nodes.length; i++) {
      expect(Number.isFinite(l.x[i]!)).toBe(true);
      expect(Number.isFinite(l.y[i]!)).toBe(true);
    }
    const b = boundsOf(l);
    expect(b.maxX - b.minX).toBeLessThan(5000);
  });

  it('survives every node starting at the same point', () => {
    // The degenerate case the guards exist for: coincident nodes have no direction between
    // them, and an unguarded normalise divides by zero and turns the whole layout to NaN
    // one frame later.
    const l = seedLayout(nodes);
    l.x.fill(0); l.y.fill(0);
    const g = siblingGroups(nodes);
    const d = directoryIndices(nodes);
    for (let i = 0; i < 100; i++) stepLayout(nodes, l, g, d);
    for (let i = 0; i < nodes.length; i++) expect(Number.isFinite(l.x[i]!)).toBe(true);
  });

  it('pushes siblings apart', () => {
    const l = seedLayout(nodes);
    const g = siblingGroups(nodes);
    const d = directoryIndices(nodes);
    for (let i = 0; i < 600; i++) stepLayout(nodes, l, g, d);
    const a = nodes.findIndex((n) => n.id === 'apps');
    const p = nodes.findIndex((n) => n.id === 'packages');
    expect(Math.hypot(l.x[a]! - l.x[p]!, l.y[a]! - l.y[p]!)).toBeGreaterThan(20);
  });

  it('groups only directories that actually have siblings', () => {
    const g = siblingGroups(nodes);
    expect(g.every((group) => group.length > 1)).toBe(true);
  });
});

describe('heatAt', () => {
  it('is brightest at the moment of the commit and fades to nothing', () => {
    expect(heatAt(log(), 2000_000, 1000_000).get(1)!.heat).toBeCloseTo(1, 5);
    expect(heatAt(log(), 2500_000, 1000_000).get(1)!.heat).toBeCloseTo(0.5, 5);
    expect(heatAt(log(), 3100_000, 1000_000).has(1)).toBe(false);
  });

  it('ignores the future', () => {
    expect(heatAt(log(), 1500_000, 1000_000).has(1)).toBe(false);
  });

  it('shows the most recent touch when a file is edited twice in the window', () => {
    // a.ts is added at t=1000 and modified at t=2000; at 2000 the modify is the live one.
    const h = heatAt(log(), 2000_000, 5000_000).get(0)!;
    expect(h.action).toBe('M');
    expect(h.author).toBe(1);
  });
});

describe('livePaths', () => {
  it('shows what exists at HEAD', () => {
    // c.ts was deleted by the last commit, so it is gone at the end.
    expect([...livePaths(log(), 4000_000)].sort()).toEqual([0, 1]);
  });

  it('brings a deleted file back when scrubbed to before its deletion', () => {
    expect(livePaths(log(), 3000_000).has(2)).toBe(true);
  });

  it('hides a file before it was added', () => {
    expect(livePaths(log(), 1500_000).has(1)).toBe(false);
    expect(livePaths(log(), 2000_000).has(1)).toBe(true);
  });

  it('keeps a file that predates the window, which has no add event', () => {
    // The reason this walks backwards from HEAD instead of replaying forwards: `old.ts` is
    // alive and never appears in any event, and a forward replay would never show it.
    const l = log({
      paths: ['old.ts'], alive: [1],
      events: [{ t: 3000, a: 0, s: 'aaaaaaa', m: 'x', f: [] }],
    });
    expect(livePaths(l, 1000_000).has(0)).toBe(true);
  });
});

describe('eventsBetween', () => {
  it('takes the half-open window, so a step never shows a commit twice', () => {
    expect(eventsBetween(log(), 1000_000, 2000_000).map((e) => e.s)).toEqual(['2222222']);
    expect(eventsBetween(log(), 2000_000, 3000_000).map((e) => e.s)).toEqual(['3333333']);
  });
});

describe('aspect', () => {
  const nodes = buildTree(PATHS);
  const settle = (aspect: number) => {
    const l = seedLayout(nodes);
    const g = siblingGroups(nodes);
    const d = directoryIndices(nodes);
    for (let i = 0; i < 800; i++) {
      stepLayout(nodes, l, g, d, { ...DEFAULT_LAYOUT, aspect });
    }
    const b = boundsOf(l);
    return (b.maxX - b.minX) / Math.max(1, b.maxY - b.minY);
  };

  it('settles wider than tall when asked to', () => {
    // The measured defect this exists for: a circular graph in a canvas twice as wide as
    // it is tall filled the height and 40% of the width.
    expect(settle(2.2)).toBeGreaterThan(settle(1));
    expect(settle(2.2)).toBeGreaterThan(1);
  });

  it('still settles', () => {
    const l = seedLayout(nodes);
    const g = siblingGroups(nodes);
    const d = directoryIndices(nodes);
    for (let i = 0; i < 800; i++) stepLayout(nodes, l, g, d, { ...DEFAULT_LAYOUT, aspect: 2.2 });
    expect(energy(l)).toBeLessThan(1);
    for (let i = 0; i < nodes.length; i++) expect(Number.isFinite(l.x[i]!)).toBe(true);
  });
});

describe('the third axis', () => {
  const nodes = buildTree(PATHS);
  const settle = (steps: number, aspect = 1) => {
    const l = seedLayout(nodes);
    const g = siblingGroups(nodes);
    const d = directoryIndices(nodes);
    for (let i = 0; i < steps; i++) stepLayout(nodes, l, g, d, { ...DEFAULT_LAYOUT, aspect });
    return l;
  };

  it('seeds onto a sphere, not a disc', () => {
    // A flat seed leaves the repulsion no direction to push in out of plane, and the graph
    // stays a pancake no matter how long it runs — 3D in the data and 2D on screen.
    const l = seedLayout(nodes);
    let spread = 0;
    for (let i = 1; i < nodes.length; i++) spread = Math.max(spread, Math.abs(l.z[i]!));
    expect(spread).toBeGreaterThan(1);
  });

  it('settles into something with real depth', () => {
    const l = settle(600);
    const b = boundingSphere(l);
    let depth = 0;
    for (let i = 0; i < nodes.length; i++) depth = Math.max(depth, Math.abs(l.z[i]! - b.z));
    // Not a demand for a particular shape, only that it is not flat: a graph you can orbit
    // has to have something to see from the side.
    expect(depth).toBeGreaterThan(b.r * 0.2);
  });

  it('still settles, and never to NaN', () => {
    const l = settle(600);
    expect(energy(l)).toBeLessThan(1);
    for (let i = 0; i < nodes.length; i++) {
      expect(Number.isFinite(l.x[i]!) && Number.isFinite(l.y[i]!) && Number.isFinite(l.z[i]!))
        .toBe(true);
    }
  });

  it('pins the root in all three axes', () => {
    const l = settle(300);
    expect([l.x[0], l.y[0], l.z[0]]).toEqual([0, 0, 0]);
  });

  it('survives every node starting at one point in 3D too', () => {
    const l = seedLayout(nodes);
    l.x.fill(0); l.y.fill(0); l.z.fill(0);
    const g = siblingGroups(nodes);
    const d = directoryIndices(nodes);
    for (let i = 0; i < 150; i++) stepLayout(nodes, l, g, d);
    for (let i = 0; i < nodes.length; i++) expect(Number.isFinite(l.z[i]!)).toBe(true);
  });

  it('never stretches depth, whatever the aspect', () => {
    // A shape that is right head-on and wrong from the side is worse than a round one, and
    // this view exists to be turned around.
    const wide = settle(600, 2.4);
    const round = settle(600, 1);
    const zSpread = (l: typeof wide) => {
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < nodes.length; i++) { lo = Math.min(lo, l.z[i]!); hi = Math.max(hi, l.z[i]!); }
      return hi - lo;
    };
    const xSpread = (l: typeof wide) => {
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < nodes.length; i++) { lo = Math.min(lo, l.x[i]!); hi = Math.max(hi, l.x[i]!); }
      return hi - lo;
    };
    expect(xSpread(wide)).toBeGreaterThan(xSpread(round));
    expect(zSpread(wide)).toBeLessThan(zSpread(round) * 1.6);
  });

  it('is deterministic in 3D', () => {
    expect(Array.from(seedLayout(nodes).z)).toEqual(Array.from(seedLayout(nodes).z));
  });
});

describe('boundingSphere', () => {
  it('contains every node', () => {
    const nodes = buildTree(PATHS);
    const l = seedLayout(nodes);
    const g = siblingGroups(nodes);
    const d = directoryIndices(nodes);
    for (let i = 0; i < 400; i++) stepLayout(nodes, l, g, d);
    const b = boundingSphere(l);
    for (let i = 0; i < nodes.length; i++) {
      expect(Math.hypot(l.x[i]! - b.x, l.y[i]! - b.y, l.z[i]! - b.z)).toBeLessThanOrEqual(b.r + 1e-9);
    }
  });

  it('never reports a zero radius, which would divide by zero when framing', () => {
    const nodes = buildTree([]);
    expect(boundingSphere(seedLayout(nodes)).r).toBeGreaterThan(0);
  });
});

describe('nodeStats', () => {
  const paths = ['apps/web/a.ts', 'apps/web/b.ts', 'apps/api/c.ts', 'README.md'];
  const nodes = buildTree(paths);
  const idx = (id: string) => nodes.findIndex((n) => n.id === id);
  const l = (): EvoLog => ({
    generated_at: '2026-09-10T00:00:00.000Z',
    window_days: 30, since: 1000, until: 4000,
    head: { sha: 'aaaaaaa', at: 4000, subject: 'head' },
    authors: ['Ana', 'Bo'],
    paths,
    alive: [1, 1, 0, 1],
    events: [
      { t: 1000, a: 0, s: 'c1', m: 'one', f: [[0, 'A'], [1, 'A']] },
      { t: 2000, a: 1, s: 'c2', m: 'two', f: [[0, 'M']] },
      { t: 3000, a: 0, s: 'c3', m: 'three', f: [[2, 'A'], [3, 'M']] },
      { t: 4000, a: 0, s: 'c4', m: 'four', f: [[2, 'D']] },
    ],
    totals: { commits: 4, files_touched: 4, files_at_head: 3, authors: 2, edits: 6 },
  });

  it('reports a single file', () => {
    const s = nodeStats(l(), nodes, idx('apps/web/a.ts'))!;
    expect(s).toMatchObject({ file: true, files: 1, commits: 2, edits: 2, added: 1, modified: 1 });
    expect(s.firstMs).toBe(1000_000);
    expect(s.lastMs).toBe(2000_000);
    expect(s.alive).toBe(true);
  });

  it('aggregates a directory over its whole subtree', () => {
    // What someone actually wants from clicking apps/web — not "this directory is not a
    // file and was never edited", which is true and useless.
    const s = nodeStats(l(), nodes, idx('apps/web'))!;
    expect(s.files).toBe(2);
    expect(s.commits).toBe(2);
    expect(s.edits).toBe(3);
  });

  it('counts a commit once however many of its files are in the subtree', () => {
    const s = nodeStats(l(), nodes, idx('apps/web'))!;
    // c1 touched both a.ts and b.ts: one commit, two edits.
    expect(s.commits).toBeLessThan(s.edits);
  });

  it('does not let one directory claim another with the same prefix', () => {
    // Without the trailing slash on the prefix test, `apps/web` also matches
    // `apps/website` — a whole directory silently folded into its neighbour's numbers.
    const ns = buildTree(['apps/web/a.ts', 'apps/website/b.ts']);
    const covered = coveredPaths(ns, ns.findIndex((n) => n.id === 'apps/web'));
    expect(covered.size).toBe(1);
  });

  it('lets the root cover the whole repository', () => {
    const s = nodeStats(l(), nodes, 0)!;
    expect(s.files).toBe(4);
    expect(s.commits).toBe(4);
    expect(s.edits).toBe(6);
  });

  it('ranks authors by how much they did here, busiest first', () => {
    const s = nodeStats(l(), nodes, 0)!;
    expect(s.authors[0]).toEqual({ author: 0, commits: 3 });
    expect(s.authors[1]).toEqual({ author: 1, commits: 1 });
  });

  it('knows a deleted file is gone', () => {
    const s = nodeStats(l(), nodes, idx('apps/api/c.ts'))!;
    expect(s.alive).toBe(false);
    expect(s.deleted).toBe(1);
  });

  it('lists recent commits newest first', () => {
    // The panel is read top-down, and the last thing that happened is what a click is
    // asking about.
    expect(nodeStats(l(), nodes, 0)!.recent.map((e) => e.s)).toEqual(['c4', 'c3', 'c2', 'c1']);
  });

  it('caps the recent list rather than rendering the whole history', () => {
    expect(nodeStats(l(), nodes, 0, 2)!.recent.map((e) => e.s)).toEqual(['c4', 'c3']);
  });

  it('says nothing happened rather than inventing a date', () => {
    const quiet = l();
    quiet.events = [];
    const s = nodeStats(quiet, nodes, 0)!;
    expect(s.commits).toBe(0);
    expect(s.firstMs).toBeNull();
    expect(s.lastMs).toBeNull();
  });

  it('returns null for a node that does not exist', () => {
    expect(nodeStats(l(), nodes, 999)).toBeNull();
  });
});
