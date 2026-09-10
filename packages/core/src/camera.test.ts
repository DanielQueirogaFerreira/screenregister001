import { describe, expect, it } from 'vitest';
import {
  basis, clampDistance, clampPitch, DEFAULT_CAMERA, eyeOf, frameSphere, MAX_DISTANCE,
  MIN_DISTANCE, orbit, pan, PITCH_LIMIT, project, zoom, type Camera,
} from './camera.js';

const W = 800;
const H = 400;
const cam = (over: Partial<Camera> = {}): Camera => ({ ...DEFAULT_CAMERA, ...over });
const at = (x: number, y: number, z: number) => ({ x, y, z });

describe('basis', () => {
  it('is orthonormal at every angle it allows', () => {
    // Everything else here divides by these vectors. If they stop being unit length the
    // whole projection drifts by a factor nothing else would explain.
    for (const yaw of [0, 1, 3, -2.5, 7]) {
      for (const pitch of [-PITCH_LIMIT, -0.7, 0, 0.7, PITCH_LIMIT]) {
        const { right, up, forward } = basis(cam({ yaw, pitch }));
        for (const [name, v] of [['right', right], ['up', up], ['forward', forward]] as const) {
          expect(Math.hypot(v.x, v.y, v.z), `${name} @${yaw},${pitch}`).toBeCloseTo(1, 6);
        }
        const dot = (a: typeof right, b: typeof right) => a.x * b.x + a.y * b.y + a.z * b.z;
        expect(dot(right, up)).toBeCloseTo(0, 6);
        expect(dot(right, forward)).toBeCloseTo(0, 6);
        expect(dot(up, forward)).toBeCloseTo(0, 6);
      }
    }
  });

  it('keeps the horizon level', () => {
    // Right is horizontal by construction. A rolled horizon under a graph carrying
    // horizontal text reads as a bug rather than as a camera move.
    for (const pitch of [-1, 0, 1, PITCH_LIMIT]) {
      expect(basis(cam({ pitch })).right.y).toBeCloseTo(0, 9);
    }
  });
});

describe('project', () => {
  it('puts the target in the middle of the screen', () => {
    const c = cam({ target: at(5, -3, 2) });
    const p = project(at(5, -3, 2), c, W, H);
    expect(p.visible).toBe(true);
    expect(p.x).toBeCloseTo(W / 2, 6);
    expect(p.y).toBeCloseTo(H / 2, 6);
  });

  it('sees the eye at exactly `distance` from the target', () => {
    const c = cam({ target: at(0, 0, 0), distance: 500 });
    const e = eyeOf(c);
    expect(Math.hypot(e.x, e.y, e.z)).toBeCloseTo(500, 6);
  });

  it('makes further things smaller', () => {
    const c = cam({ yaw: 0, pitch: 0, target: at(0, 0, 0), distance: 600 });
    // With yaw and pitch zero the camera looks down -z from +z, so smaller z is further.
    const near = project(at(0, 0, 100), c, W, H);
    const far = project(at(0, 0, -100), c, W, H);
    expect(far.depth).toBeGreaterThan(near.depth);
    expect(far.scale).toBeLessThan(near.scale);
  });

  it('refuses to project what is behind the camera', () => {
    // Mirrored rather than merely wrong: an unguarded divide puts a point behind the eye
    // back into the visible half, where it looks like a real node in the wrong place.
    const c = cam({ yaw: 0, pitch: 0, distance: 300 });
    const behind = project(at(0, 0, 600), c, W, H);
    expect(behind.visible).toBe(false);
  });

  it('sends world up to screen up', () => {
    const c = cam({ yaw: 0, pitch: 0, distance: 600 });
    expect(project(at(0, 100, 0), c, W, H).y).toBeLessThan(H / 2);
    expect(project(at(0, -100, 0), c, W, H).y).toBeGreaterThan(H / 2);
  });

  it('sends world right to screen right at the default yaw of zero', () => {
    const c = cam({ yaw: 0, pitch: 0, distance: 600 });
    expect(project(at(100, 0, 0), c, W, H).x).toBeGreaterThan(W / 2);
  });

  it('never produces NaN, including at the pitch limit', () => {
    for (const pitch of [-PITCH_LIMIT, PITCH_LIMIT]) {
      const p = project(at(120, -80, 40), cam({ pitch }), W, H);
      expect(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.scale)).toBe(true);
    }
  });

  it('is unchanged by a full turn', () => {
    const a = project(at(90, 40, -20), cam({ yaw: 0.3 }), W, H);
    const b = project(at(90, 40, -20), cam({ yaw: 0.3 + Math.PI * 2 }), W, H);
    expect(b.x).toBeCloseTo(a.x, 4);
    expect(b.y).toBeCloseTo(a.y, 4);
  });
});

describe('orbit', () => {
  it('turns with horizontal drag and tilts with vertical', () => {
    const c = orbit(cam({ yaw: 0, pitch: 0 }), 100, 50);
    expect(c.yaw).toBeGreaterThan(0);
    expect(c.pitch).toBeGreaterThan(0);
  });

  it('cannot be dragged past the pole', () => {
    // Straight up collapses the right vector to zero length and normalising it yields NaN,
    // which propagates to every point and blanks the canvas until reload.
    let c = cam({ pitch: 0 });
    for (let i = 0; i < 200; i++) c = orbit(c, 0, 100);
    expect(c.pitch).toBeLessThanOrEqual(PITCH_LIMIT);
    expect(Number.isFinite(project(at(10, 10, 10), c, W, H).x)).toBe(true);
  });

  it('lets yaw wrap without limit, because nothing breaks there', () => {
    let c = cam({ yaw: 0 });
    for (let i = 0; i < 100; i++) c = orbit(c, 100, 0);
    expect(Number.isFinite(c.yaw)).toBe(true);
  });
});

describe('pan', () => {
  it('moves the target across the view, not along it', () => {
    const c0 = cam({ yaw: 0, pitch: 0, target: at(0, 0, 0) });
    const c1 = pan(c0, 60, 0, H);
    // Dragging right pulls the graph right, so the target moves left in world space.
    expect(c1.target.x).toBeLessThan(0);
    expect(c1.target.z).toBeCloseTo(0, 6);
    expect(c1.distance).toBe(c0.distance);
  });

  it('moves the same apparent amount however far out you are', () => {
    // Unscaled panning is unusable: crawling when zoomed out, jumping when zoomed in.
    const near = pan(cam({ distance: 200, yaw: 0, pitch: 0 }), 100, 0, H);
    const far = pan(cam({ distance: 2000, yaw: 0, pitch: 0 }), 100, 0, H);
    expect(Math.abs(far.target.x)).toBeGreaterThan(Math.abs(near.target.x) * 5);
  });

  it('follows the camera when it has been turned', () => {
    const c = pan(cam({ yaw: Math.PI / 2, pitch: 0, target: at(0, 0, 0) }), 60, 0, H);
    // Turned a quarter turn, dragging sideways should move the target in z, not x.
    expect(Math.abs(c.target.z)).toBeGreaterThan(Math.abs(c.target.x));
  });
});

describe('zoom', () => {
  it('is multiplicative, so a notch feels the same at any distance', () => {
    expect(zoom(cam({ distance: 400 }), 0.9).distance).toBeCloseTo(360, 6);
    expect(zoom(cam({ distance: 4000 }), 0.9).distance).toBeCloseTo(3600, 6);
  });

  it('cannot lose the graph by zooming forever', () => {
    let c = cam({ distance: 900 });
    for (let i = 0; i < 500; i++) c = zoom(c, 0.9);
    expect(c.distance).toBe(MIN_DISTANCE);
    for (let i = 0; i < 1000; i++) c = zoom(c, 1.1);
    expect(c.distance).toBe(MAX_DISTANCE);
  });

  it('survives a nonsense distance rather than propagating it', () => {
    expect(clampDistance(NaN)).toBe(DEFAULT_CAMERA.distance);
    expect(clampDistance(-5)).toBe(MIN_DISTANCE);
    expect(clampPitch(NaN)).toBeNaN();  // documented: pitch is guarded at its callers
  });
});

describe('frameSphere', () => {
  it('backs off far enough to contain the whole graph', () => {
    const c = frameSphere(cam(), at(0, 0, 0), 300, W, H);
    // Every point on the sphere must land on screen, from any angle the camera can take.
    for (const yaw of [0, 1.1, 2.4, 4.2]) {
      for (const pitch of [-1, 0, 1]) {
        const turned = { ...c, yaw, pitch };
        for (const p of [at(300, 0, 0), at(-300, 0, 0), at(0, 300, 0), at(0, -300, 0),
                         at(0, 0, 300), at(0, 0, -300)]) {
          const q = project(p, turned, W, H);
          expect(q.visible).toBe(true);
          expect(q.x).toBeGreaterThanOrEqual(0);
          expect(q.x).toBeLessThanOrEqual(W);
          expect(q.y).toBeGreaterThanOrEqual(0);
          expect(q.y).toBeLessThanOrEqual(H);
        }
      }
    }
  });

  it('centres on the graph rather than the origin', () => {
    const c = frameSphere(cam(), at(50, -20, 10), 100, W, H);
    expect(c.target).toEqual({ x: 50, y: -20, z: 10 });
  });

  it('fits a tall viewport, where the horizontal field is the narrow one', () => {
    const c = frameSphere(cam(), at(0, 0, 0), 200, 300, 900);
    const q = project(at(200, 0, 0), { ...c, yaw: 0, pitch: 0 }, 300, 900);
    expect(q.x).toBeGreaterThanOrEqual(0);
    expect(q.x).toBeLessThanOrEqual(300);
  });

  it('keeps a degenerate graph — one node, no radius — on screen', () => {
    const c = frameSphere(cam(), at(0, 0, 0), 0, W, H);
    expect(c.distance).toBeGreaterThanOrEqual(MIN_DISTANCE);
    expect(project(at(0, 0, 0), c, W, H).visible).toBe(true);
  });
});
