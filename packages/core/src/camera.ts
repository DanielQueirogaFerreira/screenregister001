/**
 * An orbit camera, and the perspective projection it implies.
 *
 * Written rather than imported. Three.js would do this and a great deal more, but the
 * "more" is the problem: it is roughly 600 KB against a client that is currently 287 KB
 * whole, to draw a few hundred dots that need no materials, no lighting, no shadows and no
 * scene graph. What is actually needed is one matrix-free projection and a camera that
 * orbits, and that is small enough to write, small enough to read, and — the part a library
 * cannot give — testable without a GPU or a canvas.
 *
 * The camera looks at `target` from `distance` away, at angles `yaw` and `pitch`. Panning
 * moves the target rather than the eye, which is what makes dragging feel like moving the
 * object instead of walking around it.
 */

export interface Vec3 { x: number; y: number; z: number }

export interface Camera {
  /** Rotation about the world Y axis, radians. Wraps freely. */
  yaw: number;
  /** Elevation, radians. Clamped short of the poles — see PITCH_LIMIT. */
  pitch: number;
  /** Eye-to-target distance in world units. Always positive. */
  distance: number;
  /** The point the camera looks at. Panning moves this. */
  target: Vec3;
  /** Vertical field of view, radians. */
  fov: number;
}

/**
 * How close pitch may get to straight up or down.
 *
 * At exactly ±90° the view direction is parallel to world up, the cross product that builds
 * the right vector collapses to zero length, and normalising it yields NaN — which
 * propagates to every projected point and blanks the canvas until reload. Stopping a
 * degree short costs nothing anyone can see and removes the failure entirely.
 */
export const PITCH_LIMIT = Math.PI / 2 - 0.02;

export const DEFAULT_CAMERA: Camera = {
  // Not zero. A graph first seen face-on looks flat, and the whole point of this view is
  // that it is not — a slight three-quarter angle shows the depth immediately.
  yaw: 0.6,
  pitch: 0.32,
  distance: 900,
  target: { x: 0, y: 0, z: 0 },
  fov: Math.PI / 4,
};

export const clampPitch = (p: number): number =>
  Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, p));

/** Smallest and largest useful eye distance, so a wheel cannot lose the graph entirely. */
export const MIN_DISTANCE = 60;
export const MAX_DISTANCE = 12_000;

export const clampDistance = (d: number): number =>
  Math.max(MIN_DISTANCE, Math.min(MAX_DISTANCE, Number.isFinite(d) ? d : DEFAULT_CAMERA.distance));

/** The orthonormal basis the camera sees in: right, up, and the direction it looks. */
export function basis(cam: Camera): { right: Vec3; up: Vec3; forward: Vec3 } {
  const cp = Math.cos(cam.pitch);
  const sp = Math.sin(cam.pitch);
  const cy = Math.cos(cam.yaw);
  const sy = Math.sin(cam.yaw);
  // Points from the eye toward the target.
  const forward: Vec3 = { x: -cp * sy, y: -sp, z: -cp * cy };
  // Right is horizontal by construction, so the horizon never tilts — a rolled horizon on
  // a graph with horizontal text labels reads as a bug, not as a camera move.
  const right: Vec3 = { x: cy, y: 0, z: -sy };
  const up: Vec3 = {
    x: right.y * forward.z - right.z * forward.y,
    y: right.z * forward.x - right.x * forward.z,
    z: right.x * forward.y - right.y * forward.x,
  };
  return { right, up, forward };
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
  // Screen y grows downward; world y grows up.
  return { x: w / 2 + sx * scale, y: h / 2 - sy * scale, depth, scale, visible: true };
}

/** Drag to turn. Pixels in, radians out. */
export function orbit(cam: Camera, dxPx: number, dyPx: number, speed = 0.005): Camera {
  return { ...cam, yaw: cam.yaw + dxPx * speed, pitch: clampPitch(cam.pitch + dyPx * speed) };
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
