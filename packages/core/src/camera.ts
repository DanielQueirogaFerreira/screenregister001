/**
 * A trackball camera, and the perspective projection it implies.
 *
 * Written rather than imported. Three.js would do this and a great deal more, but the
 * "more" is the problem: it is roughly 600 KB against a client that is currently 287 KB
 * whole, to draw a few hundred dots that need no materials, no lighting, no shadows and no
 * scene graph. What is actually needed is one matrix-free projection and a camera that
 * turns, and that is small enough to write, small enough to read, and — the part a library
 * cannot give — testable without a GPU or a canvas.
 *
 * **Orientation is a quaternion, not a yaw/pitch pair, and that is the whole point.**
 * Euler angles have to clamp pitch short of the poles: at exactly ±90° the view direction
 * is parallel to world up, the cross product that builds the right vector collapses to zero
 * length, and normalising it yields NaN. Clamping removes the NaN and introduces a worse
 * problem — dragging up runs into an invisible wall and stops, while dragging sideways
 * spins forever. A quaternion rotated about its own local axes has no poles, no wall and no
 * special case: every direction of drag keeps turning as long as you keep dragging.
 *
 * The camera looks at `target` from `distance` away. Panning moves the target rather than
 * the eye, which is what makes dragging feel like moving the object instead of walking
 * around it.
 */

export interface Vec3 { x: number; y: number; z: number }
export interface Quat { x: number; y: number; z: number; w: number }

export interface Camera {
  /** Orientation. Identity looks down -Z from +Z, with world up on screen up. */
  orientation: Quat;
  /** Eye-to-target distance in world units. Always positive. */
  distance: number;
  /** The point the camera looks at and turns around. Panning and focusing move this. */
  target: Vec3;
  /** Vertical field of view, radians. */
  fov: number;
}

export const IDENTITY: Quat = { x: 0, y: 0, z: 0, w: 1 };

export function quatFromAxisAngle(axis: Vec3, angle: number): Quat {
  const len = Math.hypot(axis.x, axis.y, axis.z) || 1;
  const h = angle / 2;
  const s = Math.sin(h) / len;
  return { x: axis.x * s, y: axis.y * s, z: axis.z * s, w: Math.cos(h) };
}

export function quatMul(a: Quat, b: Quat): Quat {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}

/**
 * Renormalise, because a thousand small multiplications drift off the unit sphere and a
 * non-unit quaternion scales the whole scene a little more with every frame of dragging.
 */
export function quatNormalize(q: Quat): Quat {
  const n = Math.hypot(q.x, q.y, q.z, q.w);
  if (!(n > 1e-12)) return { ...IDENTITY };
  return { x: q.x / n, y: q.y / n, z: q.z / n, w: q.w / n };
}

/** Rotate a vector by a quaternion. */
export function rotate(q: Quat, v: Vec3): Vec3 {
  // t = 2 * (q.xyz x v); v' = v + q.w * t + q.xyz x t
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + q.y * tz - q.z * ty,
    y: v.y + q.w * ty + q.z * tx - q.x * tz,
    z: v.z + q.w * tz + q.x * ty - q.y * tx,
  };
}

export const DEFAULT_CAMERA: Camera = {
  // Not identity. A graph first seen face-on looks flat, and the whole point of this view
  // is that it is not — a slight three-quarter angle shows the depth immediately.
  orientation: quatNormalize(quatMul(
    quatFromAxisAngle({ x: 0, y: 1, z: 0 }, 0.6),
    quatFromAxisAngle({ x: 1, y: 0, z: 0 }, -0.32),
  )),
  distance: 900,
  target: { x: 0, y: 0, z: 0 },
  fov: Math.PI / 4,
};

/** The three fixed viewpoints, as orientations. */
export const VIEWS = {
  front: IDENTITY,
  side: quatFromAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI / 2),
  top: quatFromAxisAngle({ x: 1, y: 0, z: 0 }, -Math.PI / 2),
} as const;

/** Smallest and largest useful eye distance, so a wheel cannot lose the graph entirely. */
export const MIN_DISTANCE = 40;
export const MAX_DISTANCE = 12_000;

export const clampDistance = (d: number): number =>
  Math.max(MIN_DISTANCE, Math.min(MAX_DISTANCE, Number.isFinite(d) ? d : DEFAULT_CAMERA.distance));

/** The orthonormal basis the camera sees in: right, up, and the direction it looks. */
export function basis(cam: Camera): { right: Vec3; up: Vec3; forward: Vec3 } {
  const q = cam.orientation;
  return {
    right: rotate(q, { x: 1, y: 0, z: 0 }),
    up: rotate(q, { x: 0, y: 1, z: 0 }),
    forward: rotate(q, { x: 0, y: 0, z: -1 }),
  };
}

export function eyeOf(cam: Camera): Vec3 {
  const { forward } = basis(cam);
  return {
    x: cam.target.x - forward.x * cam.distance,
    y: cam.target.y - forward.y * cam.distance,
    z: cam.target.z - forward.z * cam.distance,
  };
}

export interface Projected {
  x: number;
  y: number;
  /** Distance along the view direction. Larger is further away. */
  depth: number;
  /** Pixels per world unit at this depth — what a radius should be multiplied by. */
  scale: number;
  /** False when the point is behind the eye, where a projection has no meaning. */
  visible: boolean;
}

const NEAR = 1;

/** World point to screen pixels. */
export function project(p: Vec3, cam: Camera, w: number, h: number): Projected {
  const { right, up, forward } = basis(cam);
  const eye = eyeOf(cam);
  const vx = p.x - eye.x;
  const vy = p.y - eye.y;
  const vz = p.z - eye.z;

  const depth = vx * forward.x + vy * forward.y + vz * forward.z;
  if (!(depth > NEAR)) {
    // Behind the eye or on the plane through it. Projecting anyway divides by ~zero and
    // throws the point to infinity — or, worse, mirrors it into the visible half where it
    // looks like a real node in the wrong place.
    return { x: 0, y: 0, depth, scale: 0, visible: false };
  }

  const sx = vx * right.x + vy * right.y + vz * right.z;
  const sy = vx * up.x + vy * up.y + vz * up.z;
  const scale = (h / 2) / Math.tan(cam.fov / 2) / depth;
  // Screen y grows downward; the camera's up axis grows up.
  return { x: w / 2 + sx * scale, y: h / 2 - sy * scale, depth, scale, visible: true };
}

/**
 * Drag to turn, in any direction, without end.
 *
 * The rotations are applied about the camera's OWN axes rather than the world's. That is
 * what makes a drag feel the same whichever way the camera is already pointing, and it is
 * also what removes the pole: there is no world "up" to become parallel to, so dragging
 * upward simply carries on over the top and down the far side.
 */
export function orbit(cam: Camera, dxPx: number, dyPx: number, speed = 0.005): Camera {
  const yaw = quatFromAxisAngle({ x: 0, y: 1, z: 0 }, dxPx * speed);
  // Negated so that dragging down lifts the camera and tips the top of the graph toward
  // you, which is the direction this view has always turned.
  const pitch = quatFromAxisAngle({ x: 1, y: 0, z: 0 }, -dyPx * speed);
  return {
    ...cam,
    orientation: quatNormalize(quatMul(quatMul(cam.orientation, yaw), pitch)),
  };
}

/** Spin about the view axis. Available because a trackball can, not because it must. */
export function roll(cam: Camera, angle: number): Camera {
  return {
    ...cam,
    orientation: quatNormalize(quatMul(cam.orientation, quatFromAxisAngle({ x: 0, y: 0, z: 1 }, angle))),
  };
}

/**
 * Drag to slide the view.
 *
 * Scaled by distance so a pixel of drag moves the same apparent amount however far out you
 * are. Without that, panning is unusably slow when zoomed out and jumps across the graph
 * when zoomed in.
 */
export function pan(cam: Camera, dxPx: number, dyPx: number, h: number): Camera {
  const { right, up } = basis(cam);
  const perPixel = (2 * Math.tan(cam.fov / 2) * cam.distance) / Math.max(1, h);
  const mx = -dxPx * perPixel;
  const my = dyPx * perPixel;
  return {
    ...cam,
    target: {
      x: cam.target.x + right.x * mx + up.x * my,
      y: cam.target.y + right.y * mx + up.y * my,
      z: cam.target.z + right.z * mx + up.z * my,
    },
  };
}

/** Multiplicative, so every notch of the wheel feels the same at any distance. */
export function zoom(cam: Camera, factor: number): Camera {
  return { ...cam, distance: clampDistance(cam.distance * factor) };
}

/** Turn around a chosen point, keeping the current angle and distance. */
export function focusOn(cam: Camera, point: Vec3): Camera {
  return { ...cam, target: { ...point } };
}

/**
 * Keep the orbit centre near the graph.
 *
 * The orbit centre is free — that is the point of it — but "free" and "unbounded" are not
 * the same thing. Panning has no natural end, and a few seconds of it puts the centre far
 * out in empty space with the graph off screen and no cue for which way to drag back. This
 * lets the centre go anywhere within reach of the graph and refuses to let it leave, so
 * being lost is not a state the camera can reach.
 */
export function clampTarget(cam: Camera, centre: Vec3, maxDistance: number): Camera {
  const dx = cam.target.x - centre.x;
  const dy = cam.target.y - centre.y;
  const dz = cam.target.z - centre.z;
  const d = Math.hypot(dx, dy, dz);
  if (!Number.isFinite(d)) return { ...cam, target: { ...centre } };
  if (d <= maxDistance) return cam;
  const k = maxDistance / d;
  return {
    ...cam,
    target: { x: centre.x + dx * k, y: centre.y + dy * k, z: centre.z + dz * k },
  };
}

/** How far the orbit centre has strayed — what a "you are here" readout shows. */
export const strayedBy = (cam: Camera, centre: Vec3): number =>
  Math.hypot(cam.target.x - centre.x, cam.target.y - centre.y, cam.target.z - centre.z);

/**
 * Put the whole graph on screen: centre on it and back off far enough to contain its
 * bounding sphere, with a margin.
 *
 * Uses the sphere rather than the box because the camera can be anywhere — a box fitted
 * from one angle crops from another, and this view exists to be turned around.
 */
export function frameSphere(
  cam: Camera, centre: Vec3, radius: number, w: number, h: number, margin = 1.02,
): Camera {
  const r = Math.max(1, radius) * margin;
  const vFov = cam.fov;
  // The horizontal field is narrower than the vertical on a tall viewport, so fit both.
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * (Math.max(1, w) / Math.max(1, h)));
  const distance = Math.max(r / Math.sin(vFov / 2), r / Math.sin(hFov / 2));
  return { ...cam, target: { ...centre }, distance: clampDistance(distance) };
}
