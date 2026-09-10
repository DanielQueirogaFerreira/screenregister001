import { describe, expect, it } from 'vitest';
import {
  basis, clampDistance, clampTarget, DEFAULT_CAMERA, eyeOf, focusOn, frameSphere, IDENTITY,
  MAX_DISTANCE, MIN_DISTANCE, orbit, pan, project, quatFromAxisAngle, quatMul, quatNormalize,
  roll, rotate, strayedBy, VIEWS, zoom, type Camera, type Quat,
} from './camera.js';

const W = 800;
const H = 400;
const cam = (over: Partial<Camera> = {}): Camera => ({ ...DEFAULT_CAMERA, ...over });
const at = (x: number, y: number, z: number) => ({ x, y, z });
const len = (v: { x: number; y: number; z: number }) => Math.hypot(v.x, v.y, v.z);
const dot = (a: typeof at extends never ? never : { x: number; y: number; z: number },
             b: { x: number; y: number; z: number }) => a.x * b.x + a.y * b.y + a.z * b.z;

/** Every orientation a lot of dragging can reach, to sweep the whole rotation group. */
function tumbled(steps: number): Camera {
  let c = cam({ orientation: IDENTITY });
  for (let i = 0; i < steps; i++) c = orbit(c, 37, 23);
  return c;
}

describe('quaternion arithmetic', () => {
  it('rotates a vector without changing its length', () => {
    const q = quatFromAxisAngle(at(1, 2, -3), 1.1);
    expect(len(rotate(q, at(3, -4, 5)))).toBeCloseTo(Math.hypot(3, 4, 5), 9);
  });

  it('turns a quarter turn about Y as expected', () => {
    const v = rotate(quatFromAxisAngle(at(0, 1, 0), Math.PI / 2), at(0, 0, -1));
    expect(v.x).toBeCloseTo(-1, 9);
    expect(v.y).toBeCloseTo(0, 9);
    expect(v.z).toBeCloseTo(0, 9);
  });

  it('leaves a vector alone under the identity', () => {
    expect(rotate(IDENTITY, at(4, 5, 6))).toEqual({ x: 4, y: 5, z: 6 });
  });

  it('renormalises, so a long drag does not scale the scene', () => {
    // A thousand small multiplications drift off the unit sphere, and a non-unit quaternion
    // rotates AND scales — the graph would swell a little more with every frame of drag.
    let q: Quat = IDENTITY;
    for (let i = 0; i < 5000; i++) {
      q = quatNormalize(quatMul(q, quatFromAxisAngle(at(0.3, 1, 0.2), 0.01)));
    }
    expect(Math.hypot(q.x, q.y, q.z, q.w)).toBeCloseTo(1, 9);
    expect(len(rotate(q, at(1, 0, 0)))).toBeCloseTo(1, 6);
  });

  it('recovers from a degenerate quaternion instead of emitting NaN', () => {
    expect(quatNormalize({ x: 0, y: 0, z: 0, w: 0 })).toEqual(IDENTITY);
  });
});

describe('basis', () => {
  it('is orthonormal at every orientation, including ones Euler angles could not reach', () => {
    for (const steps of [0, 1, 5, 12, 40, 137]) {
      const b = basis(tumbled(steps));
      for (const [name, v] of [['right', b.right], ['up', b.up], ['forward', b.forward]] as const) {
        expect(len(v), `${name} @${steps}`).toBeCloseTo(1, 6);
      }
      expect(dot(b.right, b.up)).toBeCloseTo(0, 6);
      expect(dot(b.right, b.forward)).toBeCloseTo(0, 6);
      expect(dot(b.up, b.forward)).toBeCloseTo(0, 6);
    }
  });
});

describe('orbit — the thing Euler angles could not do', () => {
  it('keeps turning downward forever instead of stopping at the pole', () => {
    // The reported bug. Dragging sideways span freely while dragging up or down ran into an
    // invisible wall and stopped, because pitch had to be clamped short of ±90° or the
    // projection produced NaN. A quaternion has no pole to run into.
    let c = cam({ orientation: IDENTITY });
    const seen: number[] = [];
    for (let i = 0; i < 400; i++) {
      c = orbit(c, 0, 12);
      seen.push(basis(c).forward.y);
    }
    // It must actually go over the top: the view direction has to pass through pointing
    // straight down AND straight up, which a clamped pitch never reaches.
    expect(Math.max(...seen)).toBeGreaterThan(0.99);
    expect(Math.min(...seen)).toBeLessThan(-0.99);
  });

  it('comes back to where it started after a full loop, in every direction', () => {
    const drags: [number, number][] = [[10, 0], [0, 10], [7, 7], [-6, 9]];
    for (const [dx, dy] of drags) {
      let c = cam({ orientation: IDENTITY });
      const turns = Math.round((Math.PI * 2) / (Math.hypot(dx, dy) * 0.005));
      for (let i = 0; i < turns; i++) c = orbit(c, dx, dy);
      const f = basis(c).forward;
      expect(f.x, `${dx},${dy}`).toBeCloseTo(0, 1);
      expect(f.y, `${dx},${dy}`).toBeCloseTo(0, 1);
      expect(f.z, `${dx},${dy}`).toBeCloseTo(-1, 1);
    }
  });

  it('never produces NaN, however far it is dragged', () => {
    let c = cam({ orientation: IDENTITY });
    for (let i = 0; i < 3000; i++) {
      c = orbit(c, (i % 7) - 3, (i % 11) - 5);
      const p = project(at(120, -80, 40), c, W, H);
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) throw new Error(`NaN at step ${i}`);
    }
    expect(true).toBe(true);
  });

  it('turns about its own axes, so a drag feels the same whichever way it points', () => {
    // Rotating about world axes instead makes horizontal drag useless once the camera is
    // looking along that axis — the classic gimbal collapse.
    for (const steps of [0, 9, 31]) {
      const before = basis(tumbled(steps)).forward;
      const after = basis(orbit(tumbled(steps), 40, 0)).forward;
      const angle = Math.acos(Math.max(-1, Math.min(1, dot(before, after))));
      expect(angle, `steps ${steps}`).toBeCloseTo(40 * 0.005, 3);
    }
  });

  it('lifts the camera when dragged downward, as it always has', () => {
    const c = orbit(cam({ orientation: IDENTITY, target: at(0, 0, 0) }), 0, 60);
    expect(eyeOf(c).y).toBeGreaterThan(0);
  });

  it('moves the eye to +x when dragged right, as it always has', () => {
    const c = orbit(cam({ orientation: IDENTITY, target: at(0, 0, 0) }), 60, 0);
    expect(eyeOf(c).x).toBeGreaterThan(0);
  });
});

describe('roll', () => {
  it('spins about the view axis without changing where the camera looks', () => {
    const c0 = cam({ orientation: IDENTITY });
    const c1 = roll(c0, 0.8);
    const a = basis(c0).forward;
    const b = basis(c1).forward;
    expect(b.x).toBeCloseTo(a.x, 6);
    expect(b.y).toBeCloseTo(a.y, 6);
    expect(b.z).toBeCloseTo(a.z, 6);
    expect(dot(basis(c0).up, basis(c1).up)).toBeLessThan(0.99);
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
    const e = eyeOf(cam({ target: at(0, 0, 0), distance: 500 }));
    expect(len(e)).toBeCloseTo(500, 6);
  });

  it('makes further things smaller', () => {
    const c = cam({ orientation: IDENTITY, target: at(0, 0, 0), distance: 600 });
    const near = project(at(0, 0, 100), c, W, H);
    const far = project(at(0, 0, -100), c, W, H);
    expect(far.depth).toBeGreaterThan(near.depth);
    expect(far.scale).toBeLessThan(near.scale);
  });

  it('refuses to project what is behind the camera', () => {
    // Mirrored rather than merely wrong: an unguarded divide puts a point behind the eye
    // back into the visible half, where it looks like a real node in the wrong place.
    const c = cam({ orientation: IDENTITY, distance: 300 });
    expect(project(at(0, 0, 600), c, W, H).visible).toBe(false);
  });

  it('sends camera up to screen up and camera right to screen right', () => {
    const c = cam({ orientation: IDENTITY, distance: 600 });
    expect(project(at(0, 100, 0), c, W, H).y).toBeLessThan(H / 2);
    expect(project(at(0, -100, 0), c, W, H).y).toBeGreaterThan(H / 2);
    expect(project(at(100, 0, 0), c, W, H).x).toBeGreaterThan(W / 2);
  });
});

describe('the fixed viewpoints', () => {
  it('look down the axis each one names', () => {
    // These are the anchors someone reaches for after turning the graph until they are
    // lost, so they have to mean exactly what they say.
    // `+ 0` because Math.round(-1e-17) is -0, which toEqual distinguishes from 0 — a
    // signed-zero difference, not a direction difference.
    const axes = (c: Camera) => {
      const f = basis(c).forward;
      return [f.x, f.y, f.z].map((n) => Math.round(n) + 0);
    };
    expect(axes(cam({ orientation: VIEWS.front }))).toEqual([0, 0, -1]);
    expect(axes(cam({ orientation: VIEWS.side }))).toEqual([-1, 0, 0]);
    expect(axes(cam({ orientation: VIEWS.top }))).toEqual([0, -1, 0]);
  });

  it('puts the eye above the target for the top view', () => {
    expect(eyeOf(cam({ orientation: VIEWS.top, target: at(0, 0, 0) })).y).toBeGreaterThan(0);
  });
});

describe('pan', () => {
  it('moves the target across the view, not along it', () => {
    const c0 = cam({ orientation: IDENTITY, target: at(0, 0, 0) });
    const c1 = pan(c0, 60, 0, H);
    expect(c1.target.x).toBeLessThan(0);
    expect(c1.target.z).toBeCloseTo(0, 6);
    expect(c1.distance).toBe(c0.distance);
  });

  it('moves the same apparent amount however far out you are', () => {
    const near = pan(cam({ distance: 200, orientation: IDENTITY }), 100, 0, H);
    const far = pan(cam({ distance: 2000, orientation: IDENTITY }), 100, 0, H);
    expect(Math.abs(far.target.x)).toBeGreaterThan(Math.abs(near.target.x) * 5);
  });

  it('follows the camera when it has been turned', () => {
    const c = pan(cam({ orientation: VIEWS.side, target: at(0, 0, 0) }), 60, 0, H);
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
  });
});

describe('the orbit centre', () => {
  it('can be put on any point', () => {
    expect(focusOn(cam(), at(12, -4, 7)).target).toEqual({ x: 12, y: -4, z: 7 });
  });

  it('keeps the angle and distance when the centre moves', () => {
    const c0 = cam();
    const c1 = focusOn(c0, at(99, 99, 99));
    expect(c1.distance).toBe(c0.distance);
    expect(c1.orientation).toEqual(c0.orientation);
  });

  it('refuses to let the centre leave the neighbourhood of the graph', () => {
    // Free and unbounded are not the same thing. Panning has no natural end, and a few
    // seconds of it puts the centre out in empty space with the graph off screen and no
    // cue for which way to drag back — being lost should not be a reachable state.
    let c = cam({ target: at(0, 0, 0) });
    for (let i = 0; i < 200; i++) {
      c = pan(c, 80, 40, H);
      c = clampTarget(c, at(0, 0, 0), 500);
    }
    expect(strayedBy(c, at(0, 0, 0))).toBeLessThanOrEqual(500 + 1e-6);
  });

  it('leaves a centre that is already close alone', () => {
    const c = cam({ target: at(10, 0, 0) });
    expect(clampTarget(c, at(0, 0, 0), 500)).toBe(c);
  });

  it('pulls the centre back along the same direction it strayed', () => {
    const c = clampTarget(cam({ target: at(3000, 0, 0) }), at(0, 0, 0), 500);
    expect(c.target.x).toBeCloseTo(500, 6);
    expect(c.target.y).toBeCloseTo(0, 6);
  });

  it('recovers a target that has become NaN rather than keeping it', () => {
    const c = clampTarget(cam({ target: at(NaN, 0, 0) }), at(1, 2, 3), 500);
    expect(c.target).toEqual({ x: 1, y: 2, z: 3 });
  });

  it('reports how far it has strayed, for a "you are here" readout', () => {
    expect(strayedBy(cam({ target: at(3, 4, 0) }), at(0, 0, 0))).toBeCloseTo(5, 9);
  });
});

describe('frameSphere', () => {
  it('backs off far enough to contain the whole graph, from any angle', () => {
    const c = frameSphere(cam(), at(0, 0, 0), 300, W, H);
    for (const steps of [0, 3, 17, 44]) {
      const turned = { ...c, orientation: tumbled(steps).orientation };
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
  });

  it('centres on the graph rather than the origin', () => {
    expect(frameSphere(cam(), at(50, -20, 10), 100, W, H).target).toEqual({ x: 50, y: -20, z: 10 });
  });

  it('fits a tall viewport, where the horizontal field is the narrow one', () => {
    const c = frameSphere(cam(), at(0, 0, 0), 200, 300, 900);
    const q = project(at(200, 0, 0), { ...c, orientation: IDENTITY }, 300, 900);
    expect(q.x).toBeGreaterThanOrEqual(0);
    expect(q.x).toBeLessThanOrEqual(300);
  });

  it('keeps a degenerate graph — one node, no radius — on screen', () => {
    const c = frameSphere(cam(), at(0, 0, 0), 0, W, H);
    expect(c.distance).toBeGreaterThanOrEqual(MIN_DISTANCE);
    expect(project(at(0, 0, 0), c, W, H).visible).toBe(true);
  });
});
