# Codebase Navigator — portable build specification

**Version 1.1 · extracted from ScreenRegister (`screenregister001`), area 401.**

This document is a complete, self-contained specification for building the 3D codebase
navigator: a repository's structure and history as a scene you fly through. It is written to be handed to another engineer or another AI agent
working in a *different* codebase, who cannot see the original source. Every constant in
here is the value that actually ships, and every one that looks arbitrary has a reason
recorded beside it — most of them were arrived at by measuring a failure, not by choosing.

---

## 0. How to use this document

Paste the following, then this whole file, into the assistant that will build it:

> Build the system described in the specification below, in this project. It is a complete
> build spec, not a summary — implement every part in the order given. Section 8 is a list
> of failures that the obvious implementation produces; read it before writing code, not
> after. Where the spec gives a number, use that number and keep the comment explaining it.
> Where the spec says a behaviour was measured, do not substitute your own judgement for
> the measurement without re-measuring. Ask me before deviating from the data contract in
> section 3, because that contract is what lets two implementations interoperate.

### On the name

It was called the *codebase viewer* until this revision. "Viewer" described what it was when
it only animated history; everything added since has been about **moving through** —
stepping commit by commit, walking directories with breadcrumbs and a way back, locking the
camera onto a node, opening files without leaving the folder. Navigator is what it became.

Two things were **not** renamed with it, and the distinction is worth carrying into your own
build:

- **The route** (`/evolution`) is an address, not a name. It sits in links, bookmarks and in
  this document's own examples. Names are for people; addresses should not churn because a
  word improved.
- **The contract** (`evolution.json`, §3) describes the *data* — the evolution of a git
  history — not the tool that draws it. Renaming a tool must never rename its interoperability
  surface. This is the first test of the "stable and additive" rule in §10, and it would have
  been an easy one to fail.

This document's own filename (`CODEBASE-VIEWER-SPEC.md`) is left alone for the same reason,
which is worth noticing rather than reading as an oversight: it is the URL people have
already been handed. Renaming it would have broken every link to the thing arguing that
addresses should not churn.

Pick one name and use it everywhere else. Before this revision the same thing was called
three things — the page heading said "Codebase Evolution & Activity", the area badge said
"codebase viewer", this document said "Codebase Viewer" — which is how a team ends up unsure
whether two people are discussing the same screen.

---

## 1. What you are building

A view that answers **"what does this codebase look like, and what has been happening to
it"** — as a navigable 3D scene rather than a chart or a video.

- The repository's directory tree is laid out as a force-directed graph in three
  dimensions. Directories are hubs, files hang off them.
- A playhead sweeps through git history. Files light up as commits touch them, with a
  colour saying what happened (added / modified / deleted) and a ring that expands and
  fades over a few seconds.
- The camera is a full trackball: turn in any direction without end, pan, zoom, orbit any
  node you pick.
- You can freeze it, pick a node, and read what has happened to that file or directory.
- You can walk into a directory as a folder tree, and open any file's actual contents in a
  viewer that picks its form from the file type — a page renders as a page, markdown as
  prose, code with line numbers.

It replaces a Gource video, and the reason is not taste. A Gource render of a mid-size
repository is tens of megabytes of MP4 that has to live somewhere — committed, where every
daily regeneration adds another blob to git history permanently, or in object storage where
it costs money forever. The log format below is a few hundred kilobytes of text, is rebuilt
from scratch on every deploy so it can never go stale, and nothing about it accumulates.
It is also strictly more useful: a video can only be watched, while this can be scrubbed,
paused on the commit you care about, and read — the renderer knows which file each dot is.

---

## 2. Architecture — three separable parts

```
  ┌────────────────┐      ┌──────────────────┐      ┌──────────────────┐
  │  PRODUCER      │ ───▶ │  CONTRACT        │ ───▶ │  RENDERER        │
  │  git history   │      │  evolution.json  │      │  the 3D view     │
  │  + file tree   │      │  manifest.json   │      │  (pure client)   │
  │  (build step)  │      │  source files    │      │                  │
  └────────────────┘      └──────────────────┘      └──────────────────┘
```

**Keep these three genuinely separate.** The renderer must never know about git, and the
producer must never know about rendering. That boundary is what makes the third instance in
section 10 possible at all: a hosted navigator that connects to arbitrary repositories is the
same renderer pointed at a different producer.

The renderer is a pure client. It fetches three static things and needs no API:

| What | Where | Purpose |
|---|---|---|
| `evolution.json` | one static file | the history to animate |
| `manifest.json` | one static file | which files exist, and how big |
| the files themselves | one static file each | contents, fetched on demand |

Static assets are usually free and unlimited on a CDN, and a per-file layout means opening
one file fetches that file rather than a megabyte of everything.

---

## 3. The data contract

**This is the interoperability boundary. Do not change it casually.** Two implementations
that agree on this can share producers and renderers.

### 3.1 `evolution.json`

The format is Gource's own model — `(timestamp, author, action, path)` — **interned**,
because the same few hundred paths and handful of authors repeat across every commit and
writing them out in full is most of the bytes.

```jsonc
{
  "generated_at": "2026-09-10T21:09:54.123Z",  // ISO, when this file was produced
  "window_days": 30,                            // how far back the producer looked
  "since": 1786000000,                          // unix SECONDS of the first event, or null
  "until": 1788256757,                          // unix SECONDS of the last event, or null
  "head": {                                     // newest commit in the window, or null
    "sha": "da96955",                           // short sha, 7 chars
    "at": 1788256757,                           // unix seconds
    "subject": "Light mode, a whole-estate…"
  },
  "authors": ["Daniel Queiroga Ferreira", "…"], // interned, first-seen order
  "paths":   ["apps/web/src/App.tsx", "…"],     // interned, first-seen order
  "alive":   [1, 0, 1],                         // 1 if the path exists at HEAD; indexed like `paths`
  "events": [
    {
      "t": 1788256757,        // unix SECONDS. Never milliseconds — see the trap in 8.1
      "a": 0,                 // index into `authors`
      "s": "da96955",         // short sha
      "m": "commit subject",  // truncated to 120 chars
      "f": [[12, "M"], [40, "A"]]   // [index into `paths`, action]. "A" | "M" | "D"
    }
  ],
  "totals": {
    "commits": 94,
    "files_touched": 160,   // files touched INSIDE the window, not the repo's size
    "files_at_head": 173,
    "authors": 2,
    "edits": 412            // sum of every event's `f.length`
  }
}
```

**Events must be sorted ascending by `t`.** Several renderer algorithms rely on it and
break silently if it is not true — `heatAt` early-exits on the first event past the
playhead, and `commitIndexAt` binary-searches.

### 3.2 `manifest.json`

A flat map of every servable file path to its size in bytes.

```json
{ "apps/web/src/App.tsx": 14231, "README.md": 8102 }
```

It exists so the navigator knows a file is there, and how big, **before** fetching it. A "view
content" button that leads to a 404 is worse than no button. It is also the source of truth
for the folder explorer — see the trap in 8.9 about why the explorer must not be built on
the event log instead.

### 3.3 The files

Each tracked file copied to `<source-root>/<original path>`, so
`apps/web/src/App.tsx` is fetched from `<source-root>/apps/web/src/App.tsx`.

---

## 4. Part one — the producer

A build-time script. Runs on every deploy, writes `evolution.json`.

### 4.1 Reading git

```
git log --since="<N> days ago" --no-merges --reverse --name-status --no-renames \
        --format=%x01%H%x00%at%x00%an%x00%s
```

Four decisions in that command line, each of which matters:

- **`%x00` field separators, not a printable character.** Commit subjects are written by
  people, and one containing a pipe or a tab splits a record into the wrong number of
  fields — a parser that is correct for every message written so far and silently wrong for
  the next one. `%x01` marks the start of a commit record, so the name-status lines that
  follow are unambiguous.
- **`--no-renames`.** A rename becomes a delete plus an add, which is what the animation
  should show: the file leaves one directory and appears in another.
- **`--reverse`** so events come out in ascending time order, which the contract requires.
- **`--no-merges`**, because a merge commit's file list is the union of its branches and
  would flash the whole graph at once.

Parse `A\tpath`, `M\tpath`, `D\tpath`. **Status letters can carry a score** (`R100`,
`C075`) — take the *first character* only. Discard any action that is not `A`, `M` or `D`.

### 4.2 Ignore rules

```
/^pnpm-lock\.yaml$/       /^package-lock\.json$/
/(^|\/)dist\//            /(^|\/)node_modules\//
/^<path to the generated log itself>$/
```

A lockfile changes on every dependency bump and is thousands of lines nobody reads. The
generated log would appear as a file that changes on every single deploy — untrue of the
source, and the loudest node on the graph.

**Drop commits whose file list is empty after filtering.** Keeping them shows a beat where
nothing happens and makes the timeline look emptier than the work was.

### 4.3 Interning

Intern paths and authors **in first-seen order**. Stable ordering means a diff of the
generated file shows only what is genuinely new, for the history that has not changed.

### 4.4 Author identity

One person, one node. Real repositories contain the same human committing from two machines
under two git identities — `Daniel Queiroga Ferreira` and `DanielQueirogaFerreira`.
Showing them as two contributors is wrong in the one place the view makes a factual claim.

Merge on the name with spacing and punctuation removed:

```js
const authorKey = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, '');
```

Prefer the spaced form as the display name — it is the one a person would write down.

**Do not key on email addresses.** This file is served publicly, and a contributor list is
not a reason to publish anyone's address.

### 4.5 `alive`

Take it from `git ls-tree -r --name-only HEAD`, **not** by replaying adds and deletes. A
file created before the window opened has no `A` event in the log and would otherwise be
indistinguishable from one that never existed.

### 4.6 The file bundle

Separately, copy every tracked file to the source root and write `manifest.json`.

- Skip the same paths as above, **plus** `.dev.vars` and `.env` and anything else your
  project uses for secrets.
- Skip files over **512 KB** — bigger than that is not something a navigator should try to
  paint. Report how many were skipped.
- Files in the tree but not on disk (submodules, partial checkouts) are skipped silently.

> **Security gate — read this before enabling the bundle.** This publishes your repository's
> source at your application's origin. It is safe *only* if the repository is already
> public. If your repository is private, or the navigator's route sits outside your auth gate,
> **do not ship this step** — or put the source root behind the same authentication as
> everything else. Verify, do not assume: check the repository's visibility, and scan the
> bundle for credentials before the first deploy.

---

## 5. Part two — serving

Three static paths. No API, no server logic:

```
/evolution.json
/source/manifest.json
/source/<repo-relative path>
```

If your host uploads assets by content hash, a redeploy re-uploads only what changed.

---

## 6. Part three — the renderer

Written from scratch rather than on a 3D library, and that is a deliberate call worth
repeating in your own code. Three.js would do this and a great deal more, but the "more" is
the problem: roughly 600 KB against a client that is a few hundred KB whole, to draw a few
hundred dots that need no materials, no lighting, no shadows and no scene graph. What is
needed is one matrix-free projection and a camera that turns. That is small enough to
write, small enough to read, and — the part a library cannot give — **testable without a
GPU or a canvas**, which is what makes the layout and camera logic unit-testable.

Split the code so the maths is separate from the React/DOM layer. In the original:

| Module | Contains |
|---|---|
| `camera.ts` | quaternion trackball, projection, framing, clamping |
| `evolution.ts` | tree building, 3D force layout, heat, stats, timeline marks |
| `explorer.ts` | directory listing, breadcrumbs, path predicates |
| `source.ts` | viewer selection, syntax tokens, markdown parser |
| `palette.ts` | OKLCH accent generation (if you also want section colours) |
| the view | canvas painting, controls, layout of the panel |

Everything in the first five is pure and unit-tested. **The original has ~646 tests, and
several of the constants below exist because a test found the previous value wrong.**

### 6.1 The camera

**Orientation is a quaternion, not a yaw/pitch pair, and that is the whole point.**

Euler angles have to clamp pitch short of the poles: at exactly ±90° the view direction is
parallel to world up, the cross product that builds the right vector collapses to zero
length, and normalising it yields `NaN`. Clamping removes the `NaN` and introduces a worse
problem — dragging up runs into an invisible wall and stops, while dragging sideways spins
forever. A quaternion rotated about its **own local axes** has no poles, no wall and no
special case: every direction of drag keeps turning as long as you keep dragging.

```ts
interface Camera {
  orientation: Quat;   // identity looks down -Z from +Z, world up on screen up
  distance: number;    // eye-to-target, world units, always positive
  target: Vec3;        // what the camera looks at AND turns around
  fov: number;         // vertical, radians
}
```

**Panning moves `target`, not the eye.** That is what makes dragging feel like moving the
object rather than walking around it.

Required operations:

```ts
quatFromAxisAngle(axis, angle)
quatMul(a, b)
quatNormalize(q)          // REQUIRED every frame — see trap 8.2
rotate(q, v)              // t = 2·(q.xyz × v);  v' = v + q.w·t + q.xyz × t
basis(cam)  → { right: rotate(q, +X), up: rotate(q, +Y), forward: rotate(q, -Z) }
eyeOf(cam)  → target − forward · distance
```

**Orbit** — post-multiply by rotations about the camera's own axes:

```ts
function orbit(cam, dxPx, dyPx, speed = 0.005) {
  const yaw   = quatFromAxisAngle({x:0,y:1,z:0},  dxPx * speed);
  const pitch = quatFromAxisAngle({x:1,y:0,z:0}, -dyPx * speed);  // negated: drag down tips the top toward you
  return { ...cam, orientation: quatNormalize(quatMul(quatMul(cam.orientation, yaw), pitch)) };
}
```

Order matters: `orientation × yaw × pitch`, never `yaw × orientation`. Pre-multiplying
applies the rotation in world space and reintroduces exactly the pole the quaternion was
chosen to avoid.

**Projection** — matrix-free, and it must refuse points behind the eye:

```ts
const NEAR = 1;
function project(p, cam, w, h) {
  const { right, up, forward } = basis(cam);
  const eye = eyeOf(cam);
  const v = { x: p.x-eye.x, y: p.y-eye.y, z: p.z-eye.z };
  const depth = v.x*forward.x + v.y*forward.y + v.z*forward.z;
  if (!(depth > NEAR)) return { x:0, y:0, depth, scale:0, visible:false };
  const sx = v.x*right.x + v.y*right.y + v.z*right.z;
  const sy = v.x*up.x    + v.y*up.y    + v.z*up.z;
  const scale = (h/2) / Math.tan(cam.fov/2) / depth;   // pixels per world unit at this depth
  return { x: w/2 + sx*scale, y: h/2 - sy*scale, depth, scale, visible: true };
  //                          ^ screen y grows downward; the camera's up axis grows up
}
```

The `visible: false` branch is not defensive tidiness. Projecting a point behind the eye
divides by roughly zero and throws it to infinity — or worse, **mirrors it into the visible
half where it looks like a real node in the wrong place.**

**Pan** — scaled by distance, or it is unusably slow zoomed out and jumps across the graph
zoomed in:

```ts
const perPixel = (2 * Math.tan(cam.fov/2) * cam.distance) / Math.max(1, h);
target += right * (-dxPx * perPixel) + up * (dyPx * perPixel);
```

**Zoom** — multiplicative, so every wheel notch feels the same at any distance:
`distance * 1.12` or `/ 1.12`, clamped to `[40, 12000]`.

**Frame the whole graph** — fit the bounding **sphere**, not a box. The camera can be
anywhere, and a box fitted from one angle crops from another:

```ts
function frameSphere(cam, centre, radius, w, h, margin = 1.02) {
  const r = Math.max(1, radius) * margin;
  const vFov = cam.fov;
  const hFov = 2 * Math.atan(Math.tan(vFov/2) * (Math.max(1,w) / Math.max(1,h)));
  return { ...cam, target: {...centre},
           distance: clampDistance(Math.max(r/Math.sin(vFov/2), r/Math.sin(hFov/2))) };
}
```

**Anti-lost clamp** — keep the orbit centre inside the bounding sphere:

```ts
clampTarget(cam, centre, maxDistance)   // called every frame with maxDistance = sphere radius
```

The orbit centre being free is the point of it, but *free* and *unbounded* are not the same
thing. Panning has no natural end, and a few seconds of it puts the centre out in empty
space with the graph off screen and no cue for which way to drag back. See trap 8.4 for the
measurement that set this radius.

**Defaults**

```ts
DEFAULT_CAMERA = {
  // Not identity. A graph first seen face-on looks flat, and the whole point of this view
  // is that it is not — a slight three-quarter angle shows the depth immediately.
  orientation: normalize(mul(axisAngle(+Y, 0.6), axisAngle(+X, -0.32))),
  distance: 900,
  target: { x: 0, y: 0, z: 0 },
  fov: Math.PI / 4,
};
VIEWS = { front: IDENTITY, side: axisAngle(+Y, π/2), top: axisAngle(+X, -π/2) };
MIN_DISTANCE = 40;  MAX_DISTANCE = 12000;
```

The three named views re-orient someone who is lost **without moving the orbit centre**, so
they do not also throw away the thing that was centred.

### 6.2 The tree

```ts
interface EvoNode {
  id: string;        // full path; the root is the empty string
  name: string;      // last segment — what the label shows
  parent: number;    // index into the same array, ALWAYS less than this node's own index
  depth: number;
  file: boolean;
  pathIndex: number; // index into EvoLog.paths for files, -1 for directories
}
```

`buildTree(paths)` walks each path, creating directory nodes as needed. Two invariants:

- **Parents always come before their children in the array.** One forward pass can then
  position the whole tree, and the layout can read a parent's position while computing a
  child's without a second traversal.
- **Sort the paths before building.** The layout seeds off node order, and a graph that
  rearranges itself between deploys for no reason looks like the codebase changed when it
  did not.

### 6.3 The layout — 3D force-directed, with bounded drift

Three forces, all in three dimensions, plus a displacement that is not a force.

```ts
const REST = 34;                 // spring rest length, world units
DEFAULT_LAYOUT = {
  spring:   0.06,                // stiffness toward the parent directory
  repel:    900,                 // push between siblings
  dirRepel: 4200,                // push between directories anywhere in the tree
  damping:  0.86,                // velocity retained per step
  maxStep:  12,                  // ceiling on movement per step
  aspect:   1,                   // 1 is a sphere; the view passes 1.6
  wander:   0,                   // drift amplitude, world units; 0 is off
  wanderPhase: 0,                // radians, advanced by the caller from wall-clock
};
```

**Seeding.** Place each node at `REST × depth` from its parent, in a direction taken from a
stable hash of its path — deterministic, so the same repository always produces the same
opening shape. Distribute on a **sphere**, not a circle:

```ts
const theta = (h % 3600) / 3600 * 2π;
const phi   = Math.acos(1 - 2 * (((h >>> 12) % 1000) + 0.5) / 1000);
```

Taking the polar angle uniformly crowds the poles, and the initial cloud then has two dense
caps that the repulsion spends hundreds of steps undoing.

**One step:**

1. **Take the drift back out** of every position, first thing. From here to the end of the
   function the coordinates are pure physics.
2. **Springs** to the parent: `f = (d − REST) × spring`, applied equally and oppositely.
   If `d < 1e-6` the direction is undefined — pick a stable angle from the node's hash
   rather than dividing by zero and poisoning every later frame with `NaN`.
3. **Sibling repulsion** over each parent's child list.
4. **Directory repulsion** over all directory nodes, same kernel, longer range.
5. Integrate with damping, then **clamp speed to `maxStep`**. A node pushed hard must not
   teleport across the graph in one frame — it would fly past everything holding it in
   place and come back oscillating.
6. **Pin the root at the origin**, position and velocity. Something has to be pinned, or the
   whole graph drifts off in whatever direction the forces happen not to cancel, and a
   viewer watching it slide out of frame cannot tell that from a bug.
7. **Put the drift back on** (below).

**The `aspect` knob.** A tree with no opinion about direction settles into a sphere, and a
sphere drawn in a canvas twice as wide as it is tall wastes more than half the canvas —
measured at 460px tall, the graph filled the height and about 40% of the width. Stretch the
*repulsion*, not the drawing: scaling the finished picture flattens every node into an
ellipse and slants every label. Split the bias evenly around 1 so the total push is
unchanged and only its direction is biased — `kx = √aspect, ky = 1/kx` — otherwise the graph
also inflates every time the canvas gets wider. **Never stretch depth**: a shape that is
correct head-on and wrong from the side is worse than one that is merely round.

**The drift, and why it is a displacement rather than a force.** This is the single most
important design point in the layout, and getting it wrong is invisible in code review:

> The three forces form a **converging** system. They exist to find an equilibrium and then
> hold it. That is right for the shape and wrong for the impression — measured on the
> original repository, the largest single-step movement falls from **9.6 world units at the
> start to 0.029 after two thousand steps**, about a fiftieth of a pixel. A simulation that
> is still running looks exactly like one that has been switched off.

So the drift adds the one thing a damped system cannot produce on its own: motion that never
stops changing. It is a bounded **displacement**, not a force:

```ts
for (let i = 1; i < n; i++) {
  const h = hash(nodes[i].id);
  const wx = wander * Math.sin(phase * 0.83 + ( h         & 1023) * 0.00614);
  const wy = wander * Math.sin(phase * 1.00 + ((h >>> 10) & 1023) * 0.00614);
  const wz = wander * Math.sin(phase * 1.19 + ((h >>> 20) & 1023) * 0.00614);
  l.wx[i] = wx; l.wy[i] = wy; l.wz[i] = wz;     // remembered, so step 1 can undo it
  l.x[i] += wx; l.y[i] += wy; l.z[i] += wz;
}
```

A force is only bounded if something happens to pull back, and the parent spring constrains
*distance*, not *position* — the first version of this drifted **134 world units**, about
four times the spring's rest length. A displacement is bounded by construction: no node is
ever further than `wander × √3` from where the physics put it, whatever happens.

Each axis runs at its own rate (0.83 / 1.00 / 1.19) and each node takes its own offset from
its hash, so the graph never synchronises into a single pulse — a shared phase makes every
node lean the same way at the same moment, which reads as a glitch rather than as life.
Deterministic throughout, so the motion is a property of the repository and not of when the
page happened to load. With `wander: 0` this writes zeros, which returns a drifting graph to
rest the moment it is switched to fixed.

View values: `wander: 7`, `wanderPhase += dt × 0.0016` radians/ms. Seven against a rest
length of thirty-four and a node radius of four is a visible sway of a few pixels, well
short of a node reaching its neighbour's place; the period works out around four seconds,
slow enough to read as breathing rather than jitter.

**Precompute the pair lists once.** `siblingGroups(nodes)` and `directoryIndices(nodes)`
recomputed every frame is most of the cost.

### 6.4 Painting

Four cues, and taking any one away flattens the picture:

1. **Perspective** — nearer nodes are larger, from `projected.scale`.
2. **Atmospheric haze** — further nodes are dimmer.
3. **Painter's algorithm** — sort back to front, so nearer nodes genuinely occlude.
4. **Occlusion by real overlap**, which follows from 3.

```ts
const dpr = Math.min(2, devicePixelRatio || 1);   // capped at 2: beyond that it is pixels nobody sees
```

Resize the backing store only when it actually differs, then
`ctx.setTransform(dpr, 0, 0, dpr, 0, 0)` so all drawing is in CSS pixels.

**Order of operations, exactly:**

1. Project every node once into flat typed arrays. Track `near` and `far` depth over
   *visible* nodes only.
2. `haze(i) = 1 − 0.62 × min(1, (depth[i] − near) / range)` — 1 at the front, fading back.
3. **Edges first, unsorted.** They are hairlines behind everything; sorting them into the
   painter's order costs a second sort of a longer list and changes nothing visible.
   `rgba(64, 78, 94, 0.25 + 0.5 × haze)`.
4. **Nodes, sorted far to near.**
5. **The orbit crosshair** at the canvas centre.
6. **Text last**, so a node drawn afterwards can never land on top of a label.

**Node sizes** are world-space radii multiplied by the projected scale, then clamped:

```ts
R_FILE = 4.2;  R_FILE_WARM = 9;  R_DIR = 5.4;
R_MIN = 1.1;   R_MAX = 44;       // below a pixel a dot is invisible; above 44 it is a blob
const worldR = node.file ? R_FILE + warmth * R_FILE_WARM : R_DIR;
const r = clamp(worldR * scale[i], R_MIN, R_MAX);
```

**Alpha** = `(exists ? 1 : 0.4) × (0.35 + 0.65 × haze)`. A deleted file is drawn faded,
not hidden — it was there, and its absence is part of the history.

**Culling:** skip a *file* node entirely unless it exists at HEAD or is currently warm.
Directories always draw. Otherwise a month's worth of deleted temporary files clutters the
scene permanently.

**The warm ring** is the only place an action colour appears:

```ts
ctx.globalAlpha = warmth * 0.75 * haze;
ctx.strokeStyle = ACTION_COLOUR[action];
ctx.lineWidth = 2;
ctx.arc(x, y, r + (1 - warmth) * 26 * scale[i] * 1.4, 0, 2π);
```

It starts tight and expands as the heat decays, which reads as a pulse outward.

**Labels** appear for: warm files above `warmth > 0.45` (fading in over the remainder), the
selected node (full path, always), and directories at `depth <= 2`. Labelling every node
turns the scene into unreadable text.

### 6.5 Colour

Two orthogonal encodings, and keeping them orthogonal is the whole design.

**Action → the ring, never the dot.**

```ts
ACTION_COLOUR = { A: '#35c98b', M: '#4da3ff', D: '#f0645c' };   // added / modified / deleted
```

These are the diff convention and are not free to move.

**File kind → the dot, never the ring.**

```ts
FILE_KINDS = [
  { id:'code',   label:'code',         colour:'#9c6ade', hint:'ts, tsx, js, css, html',
    match:/\.(tsx?|jsx?|mjs|cjs|css|html)$/i },
  { id:'config', label:'config & CI',  colour:'#c87820', hint:'yml, json, toml',
    match:/\.(ya?ml|toml|json)$/i },
  { id:'schema', label:'migrations',   colour:'#1f9c78', hint:'sql',
    match:/\.sql$/i },
  { id:'other',  label:'docs & other', colour:'#5c6672', hint:'md, txt, everything else',
    match:null },     // last, matches everything left
];
```

**Derive the legend from this same table.** In the original these were two hardcoded lists
inside the renderer and they drifted: the graph coloured config files amber and the legend
listed only added/modified/deleted, so the most eye-catching colour on the picture had no
entry at all and a reader who noticed it had nowhere to look it up. Deriving the legend from
the palette makes that bug *unrepresentable* rather than merely fixed, and a test can assert
the agreement.

Four kind slots, not seven. An earlier set spent a hue on `.tsx` separately from `.ts` and
another on `.css`, then gave docs and unknown files two different greys — and a
colour-vision validator put numbers on the cost: those two greys were ΔE 9.7 apart to normal
vision, well under the 15 needed to tell a pair apart at all, and purple-vs-blue was 4.7
under deuteranopia. Rare kinds are folded in rather than each holding a hue nobody can
separate. Verified across every pair rather than only neighbours: worst CVD ΔE 10.0, worst
normal-vision 16.3, all four above 3:1 contrast against the panel background.

The grey is deliberately below the chroma floor — it is the fold-in slot, not a fourth
series, and reading as recessive is its job. It was originally `#7b8798`, which sat ΔE 4.6
from the teal under deuteranopia, so a migration and a README were the same dot; darkening
to `#5c6672` fixes that.

**Code is violet, not blue, on purpose.** Blue belongs to "modified", and while the ring
keeps the two apart, spending the largest category on a near-neighbour of a status colour
is asking for the confusion back.

**Every regex is case-insensitive**, and that is not hypothetical tidiness: a `Deploy.YML`
or a `.SQL` dump fell through to the grey slot, so a config file was drawn as a document.
Found by a test that asked the question, not by looking at a graph.

**The 3D scene stays on a dark stage even if your application has a light mode.** These
separations were measured against a near-black background; a white stage needs every one
re-picked and re-validated rather than re-tinted. Every 3D tool with a light interface keeps
a dark viewport. Let the chrome around it follow the theme.

### 6.6 The playhead and heat

The playhead is the single most performance-sensitive value in the view.

> **Keep it in a ref, not in state.** Driving it from React state means a re-render on every
> animation frame — sixty a second, each rebuilding the component tree to move one dot. The
> canvas needs a number, not React.

Mirror it into state on a **125 ms interval** for the parts a person reads. That is eight
times a second, far faster than anyone can read a clock, and it decouples the render loop
from the component tree entirely.

```ts
const SWEEP_MS = 75_000;   // one pass over the whole window at 1×
clock += (dt / SWEEP_MS) * span * rate;
if (clock > endMs) clock = startMs;      // loop
```

**Clamp `dt` to 100 ms.** A backgrounded tab delivers one enormous delta on return, which
otherwise jumps the playhead across days in a single step.

**Heat** — which files are lit, and how brightly:

```ts
const DECAY_MS = 14_000;
function heatAt(log, atMs, decayMs) {
  const out = new Map();          // pathIndex → { heat, action, author }
  for (const e of log.events) {
    const ms = e.t * 1000;
    if (ms > atMs) break;                       // relies on sorted events
    if (ms < atMs - decayMs) continue;
    const heat = 1 - (atMs - ms) / decayMs;
    for (const [p, action] of e.f) {
      const prev = out.get(p);
      if (!prev || heat > prev.heat) out.set(p, { heat, action, author: e.a });
    }
  }
  return out;
}
```

A file touched twice inside the window shows the more recent, brighter touch.

**`livePaths(log, atMs)`** returns the set of path indices that exist as of the playhead.
It drives the fade on deleted files. Compute it **backwards from HEAD**, not forwards:

```ts
const live = new Set(paths where alive[i]);
for (let i = events.length - 1; i >= 0; i--) {
  if (events[i].t * 1000 <= atMs) break;
  for (const [p, action] of events[i].f) {
    if (action === 'A') live.delete(p);        // undo the add
    else if (action === 'D') live.add(p);      // undo the delete
  }
}
```

Replaying forwards means starting from a tree you do not know — the state of the repository
at the beginning of the window, which the log does not record. Starting from HEAD, which the
log *does* record in `alive`, and undoing everything after the playhead needs no such
assumption.

### 6.7 The timeline

A full-width strip **inside the scene**, directly above the controls. It is the top of a
two-row bar and it carries everything that answers **WHEN**: the clock, the scrubber, and
the commit you are standing on.

Put the clock here rather than in a readout of its own. It is the playhead's value, and it
belongs beside the playhead's control — two rows apart, the eye has to travel to check what
a drag just did.

Four things, because they are four answers to one question.

**The activity histogram behind the track.** Evenly spaced ticks would only repeat what the
caption says — that commits exist. Bucketing by time and drawing the volume in each turns
the track into a map of when the work actually happened, so aiming at "that burst last
Tuesday" is one glance and one drag instead of scrubbing back and forth to find it.

```ts
function timelineMarks(log, startMs, endMs, buckets = 120) {
  // → [{ at: 0..1 along the track, commits, edits }]
  // Bucket index MUST be clamped to buckets-1: a commit exactly at endMs indexes one past
  // the last bucket, which in a typed array is a silent no-op write — the commit simply
  // vanishes from the strip with nothing to show why.
  // Drop empty buckets rather than returning zeros: a quiet fortnight would otherwise
  // carry a hundred marks of height nothing, each a DOM node.
}
```

Scale bar heights against the busiest bucket, not an absolute — a quiet week and a frantic
one both need to be readable. Floor the height at **15%** so a one-file commit beside a
fifty-file one is still a mark you can see and land on.

**Commit stepping.** A drag lands you *between* commits, where the graph shows a state that
never existed as a checkout; the ⏮ / ⏭ buttons put you exactly on one.

```ts
commitIndexAt(log, atMs)         // binary search: the last commit at or before atMs, or -1
stepCommit(log, atMs, dir)       // → ms of the previous/next commit, or null at the ends
```

**Stepping back from a position already exactly on a commit must go to the one before it,
not stay put** — that is the only moment anyone presses the button twice, and a naive
"last commit at or before now" search returns where you already are.

Return `null` at the ends rather than clamping silently, so the buttons can disable.

**Markup.** The range input sits over the marks with a transparent track, so the activity
*is* the track. `-webkit-appearance: none` is still required — without it Safari and Chrome
draw their own track over the marks and the whole strip becomes a plain grey bar. Give the
thumb `aria-valuetext` naming the commit, so a screen reader says something useful.

### 6.8 Controls — the cockpit, and the furniture budget

**Two rows. The count is the design, not an accident of what fitted.**

This is the section that went wrong in the original and is worth reading before you lay
anything out. Every control was added on its own, each one small and each one justified,
and nobody added up the rows. It reached four stacked rows along the bottom plus a fifth
cluster in the opposite corner, and measured against the canvas they sat on:

```
                            before      after
  laptop,  1400px            26.9%      14.2%
  narrow,   780px            36.8%      19.5%
  phone,    390px            46.2%      19.2%
  phone, fullscreen          22.5%       9.4%
```

**A navigator whose furniture takes half the view is not a navigator.** Measure this. It is two
lines of script — the cockpit's height over the canvas's height — and it is the only way the
number ever gets looked at, because no individual control looks expensive.

Group the rows by **what they answer**, not by what they are:

- **Row one — WHEN:** clock · ⏮ · track · ⏭ · the commit you are on.
- **Row two — HOW and WHAT:** the identity of what is running, then the controls.

| Control | Behaviour |
|---|---|
| ▶ / ❚❚ | play / freeze — **freezes the simulation as well as the clock** |
| `1×` ‹ | speed tab; expands a row of `[0.1, 0.25, 0.5, 1, 2, 4]` |
| ◉ / ◎ | element motion: live (drifting) / fixed |
| ⟳ | slow automatic turn, suspended while the pointer is down |
| ◱ | view anchors; expands `Front · Side · Top · Reset` |
| ⛶ | fullscreen |
| ? | colour key, reachable from inside the scene |
| Nav ∣ Inspect | interaction mode |

**Fold rarely-used clusters behind one chip.** The four view anchors were four full-width
buttons, permanently on screen, in the corner furthest from every other control, for
something reached a few times a session. Behind one chip they cost nothing until wanted.
**Opening either chip row must close the other** — two open at once stack, and hand back
exactly what the folding reclaimed.

**Cut readouts that state the default.** An orbit line saying "orbiting a free point"
permanently is the default state and therefore no information at all, on a row of its own.
Show it when you have locked onto something, or strayed far enough that the way back is
worth offering. Same for a "frozen" tag when the play button and the canvas border already
say so.

**0.1 and 0.25 exist because the fast end is easy and the slow end is where the work is.**
At 1× a busy day goes past in a couple of seconds and a commit you wanted to read is gone
before you find it. Below 0.1 the playhead moves slower than the eye notices and pausing is
the better tool.

**Pause must freeze the simulation too.** It used to stop only the clock, on the reasoning
that a graph should keep settling while you read a commit. That is wrong for what pause is
actually for: you press it to look at something, and the something drifts out from under the
cursor. Frozen means frozen — the camera still moves, because turning a still object around
is the whole point of stopping it.

**Two interaction modes:**

- **Navigate** — alive, clock running, fly around, click to pick out.
- **Inspect** — freezes playback, sets motion to fixed, stops the spin, and locks the orbit
  onto the selection. In this mode *picking something is asking to look at it*, so a click
  both selects and focuses — making that a second click on a separate button would be
  ceremony.

**Leaving inspect restores what was running before.** Without the restore, a look at one
file silently costs you the animation and you have to remember to press play — the sort of
small tax that stops people using a mode at all.

**Keyboard**, on the focused canvas: arrows orbit (12 px per press, 40 with shift), `+`/`−`
zoom, `Home` recentres *and* re-enables auto-framing, `Esc` deselects, `Space` freezes, `F`
orbits the selection.

**Pointer:** track live pointers in a `Map` so two fingers can be told from one without a
separate touch handler. Shift-drag or right-drag pans. **A drag under 4 px is a click** — a
mouse always shifts a little between press and release, and a graph that refuses to select
anything feels broken.

**Register the wheel listener by hand with `{ passive: false }`.** React attaches wheel
listeners passively and a passive listener cannot `preventDefault`, so the page scrolls away
underneath while you are trying to zoom.

**Make the controls one group, and let the identity truncate.**

This is the rule that makes a two-row bar hold at 390 px, and both of the obvious flex
settings get it wrong in opposite directions:

- `flex-wrap: wrap` prefers a **second line** to a narrower item — the row grows.
- `flex-wrap: nowrap` **squeezes every item** instead. Measured at a 390 px stage, that took
  the round buttons from 24 px to 20 — below a comfortable tap target, and no longer the
  same size as each other.

So: the row does not wrap, the controls are their own non-shrinking group, and the identity
readout takes `flex: 0 1 auto; min-width: 0` with `text-overflow: ellipsis`. The identity is
the part that can afford to lose characters. The buttons are the part that can afford
neither a row nor a millimetre.

```css
.cockpit-row { display: flex; flex-wrap: nowrap; align-items: center; min-width: 0; }
.identity    { flex: 0 1 auto; min-width: 0; overflow: hidden;
               text-overflow: ellipsis; white-space: nowrap; margin-right: auto; }
.controls    { flex: none; display: flex; flex-wrap: wrap; }  /* wrap only as a last resort */
```

**On a phone, drop from the scene whatever the page repeats a few pixels below** — the
commit is in the caption under the canvas, the build in the page's own badge. In fullscreen
neither is there, so both come back. That is the whole reason the scene carries its own
copies at all.

### 6.9 Auto-framing, and when to stop

```ts
if (!framed) {
  cam = frameSphere(cam, sphere, sphere.r, w, h);
  framed = hasSettled(layout);        // stop refitting once the graph stops growing
} else if (orbitLock !== null) {
  cam = focusOn(cam, positionOf(orbitLock));   // follow the node; on a live graph it moves
} else {
  cam = clampTarget(cam, sphere, sphere.r);    // free centre, never outside the graph
}
```

```ts
function hasSettled(l) {
  // AVERAGE speed per node, not the total: the threshold then means the same thing for a
  // repository of forty files and one of four hundred.
  let e = 0;
  for (let i = 0; i < n; i++) e += Math.abs(l.vx[i]) + Math.abs(l.vy[i]) + Math.abs(l.vz[i]);
  return e / n < 0.05;
}
```

**Every user camera action must set `framed = true`.** See trap 8.3.

### 6.10 Picking

Keep a flat array of `{ x, y, r, depth, index }` written during painting, and hit-test it by
**smallest depth among everything hit** — the nearest node, which is the one drawn on top and
the one a person means.

```ts
if (Math.hypot(h.x - x, h.y - y) > Math.max(10, h.r + 6)) continue;
if (!best || h.depth < best.depth) best = h;
```

`Math.max(10, r + 6)` is a generous target on purpose: a 2 px dot is impossible to hit
exactly, and a graph that ignores clicks reads as broken rather than as precise.

### 6.11 The selection panel

For any node, computed from the log:

```ts
interface NodeStats {
  path: string; file: boolean;
  files: number;           // files beneath this node, itself included when it is a file
  commits: number;         // commits touching this node or anything under it
  edits: number;           // individual file edits; exceeds `commits` when one touched several
  added: number; modified: number; deleted: number;
  firstMs: number | null; lastMs: number | null;
  authors: { author: number; commits: number }[];   // busiest first
  alive: boolean;
}
```

A directory reports everything underneath it; a file reports itself. Plus buttons: **Orbit
this**, **View content** (files), **Browse folder** (both — a file's button points at its
parent, because "show me where this lives" is the other question a path raises).

### 6.12 The folder explorer

A drawer over one side of the scene, **not** replacing it — walking into a folder moves the
camera to that element and you should be able to watch it happen. A full-screen list hides
the thing it is steering. On a phone there is no "beside", so it takes the width.

```ts
listDirectory(manifest, dir) → Entry[]    // one level; folders first, then files, each alphabetical
parentOf(path)               → string | null
breadcrumbs(path, rootLabel) → Crumb[]
isWithin(path, dir)          → boolean
dirFor(path, isFile)         → string
normaliseDir(dir)            → string     // strips leading and trailing slashes
```

Folders-before-files-then-alphabetical is the order every file manager uses and is worth
following rather than inventing.

Three things make the trip feel like one trip:

- **Breadcrumbs**, every level returnable in one tap — the cheapest orientation a hierarchy
  can offer. Without them, a few levels down is somewhere you can only leave by going up
  repeatedly.
- **A dot beside rows that exist on the graph.** Walking into one selects it and takes the
  camera there. Rows without a dot exist but were not touched inside the window, and the
  drawer should say so rather than leaving the difference to be guessed at.
- **"Back to `<entry>`"**, which restores the folder, the selection *and* the camera —
  including whether it was locked to a node at all. Because browsing moves the selection and
  the camera, the trip needs a return leg; without it you have to remember which dot you
  came from and find it again on a graph that has since travelled somewhere else.

**Opening a file does not leave the folder.** The viewer stacks above the drawer, and
closing it puts you back on the same row of the same folder. That is the whole difference
between browsing and a series of round trips.

**Sync must be two-way.** Walking a folder moves the graph selection, *and* clicking a node
on the graph moves the explorer to that node's directory. Two panes claiming to describe the
same thing while describing different ones is worse than either alone.

Arrow keys move focus down the list over **real buttons**, so the browser keeps its focus
ring, a screen reader announces each row, and Tab still works.

### 6.13 The source viewer

Pick the form from the file, because showing everything as monospace throws away most of
what a file is.

```ts
viewerFor(path) → 'html' | 'svg' | 'image' | 'markdown' | 'json' | 'code'
hasPreview(v)   → boolean     // is there a second, rendered view worth showing?
langFor(path)   → 'ts'|'css'|'sql'|'yaml'|'json'|'shell'|'md'|'html'|'plain'
```

Where there are two useful views they sit **side by side when there is room and behind a
toggle when there is not** — half a pane of each is neither. The breakpoint is measured on
the viewer's own element with a `ResizeObserver`, not on the window: **820 px**. See trap
8.10.

**Security — non-negotiable:**

- **Nothing the parser produces is ever handed to `innerHTML`.** Everything comes back as
  tokens and is rendered as framework nodes, so a file in the repository — or one added
  later — cannot inject markup into the page displaying it.
- The single exception is the HTML preview, which is a document by definition. Render it in
  `<iframe sandbox="">` with **nothing** allowed, scripts included.
- Refuse `javascript:` in markdown links — the oldest injection in the format, and this
  renders whatever lands in the repository next. Keep the label, drop the link.

**Syntax highlighting** returns `{ text, kind }[]` and must **never lose a character** —
assert `tokens.join('') === input` in a test. That one property catches almost every
tokeniser bug.

**Markdown rules that earned their place by failing:**

- Emphasis may not begin or end on a space, or `2 * 3 * 4` renders as `2 <em> 3 </em> 4`.
  Arithmetic silently italicised is a renderer mangling exactly the content someone opened
  the file to read.
- Underscore emphasis needs a word boundary, or `some_var_name` becomes emphasised.
- A link URL containing brackets must not end at the first one, or it leaves a stray `)` in
  the text.

**Put the "this preview is blank because…" note ABOVE the iframe**, not after it. After a
full-height iframe it is pushed out of sight in the one arrangement where it is needed.

### 6.14 The HUD

Inside the scene so it survives fullscreen — the page's own version badge is outside the
fullscreen shell and disappears with it, which is exactly when someone asking "which build
am I looking at" cannot see the answer.

**One line, at the left of the control row.** It began as a three-line stack on a row of its
own, and that is the shape to avoid: a readout nobody consults while flying should not cost
a row that everybody looks past. Everything it said is still available — the rest is in its
tooltip.

```
[◉] 401 · v1.2.3 · da96955          ← the area id keeps its own colour
```

The area id and the build are two colours because they answer two different questions —
where am I, versus what am I running. The eye collapses the line and **its state is shared**
with any other badge on the page: two badges disagreeing about whether they are collapsed
would be the clearest possible sign the control means nothing. Persist the choice — a badge
that re-expands on every navigation is one you have to dismiss over and over.

**The page keeps its own badge as well, and that is not a duplicate.** They are in different
places and answer for different things: the scene's belongs to the navigator and survives
fullscreen; the page's sits at the foot of the page, below the legend and the statistics,
where every other screen in the system puts the same information. Removing the page's
because the scene had one made that page the only one in the system that could not answer
"which build is this". A fixed badge floating over page content needs an opaque or blurred
backdrop — a translucent fade lets the paragraph underneath show *through* it, which is two
sentences in the same pixels and worse than either.

**The clock is written by the animation loop through a ref, never by React.** Milliseconds
at 8 Hz would be a re-render per frame for digits nobody reads individually. It lives on the
timeline row rather than here — see 6.7.

Timestamps are UTC to the millisecond with the `Z`. `Z` is unambiguous everywhere, forever,
to anyone; an offset invites the reader to do arithmetic and disagree with the answer.

**Lay the bottom of the stage out as a flow, not as absolutely positioned blocks.** See
trap 8.11.

### 6.15 Fullscreen

Portrait 9:16 first. Everything that steers the graph must be inside the stage, or it is
left behind exactly when someone is looking hardest at the scene. Keep the selection panel
reachable.

---

## 7. Acceptance checklist

Build in this order; each line is independently checkable.

**Producer**
- [ ] `evolution.json` validates against §3.1; events ascending by `t`
- [ ] two git identities for one human merge to one author
- [ ] `alive` comes from `ls-tree`, not from replaying events
- [ ] lockfiles, `dist/`, `node_modules/` and the log itself excluded
- [ ] `manifest.json` written; files over 512 KB skipped and counted
- [ ] secrets patterns excluded; repository confirmed public *or* the bundle step omitted

**Camera**
- [ ] dragging up passes over the top and down the far side, forever, no wall, no `NaN`
- [ ] dragging in any direction keeps turning as long as you keep dragging
- [ ] quaternion renormalised every frame
- [ ] points behind the eye are refused, not mirrored into view
- [ ] pan feels the same at any zoom
- [ ] `frameSphere` fits from every angle, not just the opening one
- [ ] the orbit centre cannot leave the graph

**Layout**
- [ ] deterministic: same repository, same opening shape
- [ ] root pinned at the origin
- [ ] coincident nodes do not produce `NaN`
- [ ] `aspect` stretches repulsion, never the drawing, never depth
- [ ] **live mode still visibly moves after 40 seconds with the clock frozen and spin off**
- [ ] switching to fixed returns nodes to rest
- [ ] no node strays more than `wander × √3` from its physics position

**Painting**
- [ ] painter's order: nearer nodes occlude
- [ ] haze, perspective scaling, alpha fade all present
- [ ] deleted files faded, not hidden
- [ ] action colour only on the ring; kind colour only on the dot
- [ ] legend derived from the same table as the graph, asserted by a test
- [ ] labels only for warm, selected, and shallow directories

**Interaction**
- [ ] a 3 px drag selects; a 30 px drag does not
- [ ] wheel zooms without scrolling the page
- [ ] pause freezes clock *and* simulation
- [ ] leaving inspect restores what was running
- [ ] every camera action stops the auto-refit

**Furniture budget** — measure, do not eyeball
- [ ] cockpit height over canvas height is **under 20%** at 390px, windowed and fullscreen
- [ ] two rows at every width tested; the control row never wraps by default
- [ ] round buttons are the same size as each other at every width (no squeeze)
- [ ] opening one chip row closes the other
- [ ] the identity truncates before anything else moves
- [ ] no readout states only its own default

**Timeline**
- [ ] the clock sits with the scrubber, not in a readout of its own
- [ ] histogram scaled to the busiest bucket, minimum 15% height
- [ ] a commit exactly at the end lands in the last bucket
- [ ] stepping back off a commit goes to the previous one
- [ ] the ends disable rather than clamping silently
- [ ] visible and usable in fullscreen

**Explorer & viewer**
- [ ] `apps/web` does not match `apps/website` (the trailing-slash rule)
- [ ] the explorer reads the manifest, not the event log
- [ ] graph → explorer and explorer → graph both sync
- [ ] closing a file returns to the same row of the same folder
- [ ] "Back to entry" restores folder, selection *and* camera lock
- [ ] no parser output reaches `innerHTML`; HTML preview sandboxed with nothing allowed
- [ ] `javascript:` links refused, label kept
- [ ] tokeniser loses no characters (asserted)
- [ ] split view actually appears at a wide window

**Responsive**
- [ ] no horizontal overflow at 390 px
- [ ] no two pieces of stage furniture overlap, windowed or fullscreen
- [ ] nothing escapes the stage bounds

---

## 8. The traps

Each of these is a real defect that shipped or nearly shipped. The obvious implementation
produces every one of them.

**8.1 — Seconds and milliseconds.** The log is in unix *seconds*; every clock in the
renderer is in *milliseconds*. Mixing them produces a playhead in 1970 or in the year 57000,
and both look like "the animation is broken" rather than a unit error. Convert once at the
boundary and name variables `atMs`, `t`.

**8.2 — Quaternion drift.** A thousand small multiplications drift off the unit sphere, and
a non-unit quaternion scales the whole scene a little more with every frame of dragging.
Renormalise every time.

**8.3 — Auto-framing silently undoing zoom.** The refit loop and the user fight each other,
and the user loses without any sign of it. Measured before the fix: six wheel notches moved
the graph's width from 336 px to **324 px** — it got *smaller*. Every camera action must set
the "framed" flag; `Reset` and `Home` clear it deliberately.

**8.4 — An anti-lost clamp that still loses the graph.** The first version allowed 2.2
radii of stray on the theory that a little room outside was useful. Twenty-five hard pans
then put the graph off screen entirely — **28 lit pixels remaining**, measured, not guessed.
Tightened to exactly the bounding radius: 102% of the graph retained after 48 pans. The
pivot is what the camera looks at, so keeping it inside the sphere is what makes "you cannot
get lost" a guarantee rather than a hope.

**8.5 — "Live" that is not alive.** Covered at length in §6.3. The thing to internalise:
**a test that measures during the initial settle will pass while the feature is broken.**
The original test did exactly that and gave a false pass. The honest test waits 40 seconds
with the clock frozen and the spin off, then compares frames — 0 of 4 identical.

**8.6 — Wander as a force.** Strays 134 world units. A force is only bounded if something
resists; the parent spring constrains distance, not position. Use a displacement.

**8.7 — Drift fighting the physics.** If the drift offset is left in the coordinates while
the forces run, the springs treat the sway as real displacement and push back against it.
Remove the offset at the top of every step and re-apply at the bottom. Verify with a
lockstep pair: the same layout with and without drift must agree within about one unit.

**8.8 — The legend that drifts from the graph.** Two hardcoded lists. Derive both from one
table.

**8.9 — Building the explorer on the event log.** The log holds only what was touched inside
the window, so a file nobody has edited for two months is absent from it while being very
much present in the directory. An explorer built on the log quietly shows an *incomplete*
tree, which is worse than showing none. Use the manifest.

**8.10 — Measuring the window instead of the element.** The split view "never appeared" at a
1400 px window because the viewer was confined to the stage, which is ~806 px once a 268 px
inspector column is taken out — the split could never happen. Observe the element, and give
the viewer the whole layout's width.

**8.11 — Absolutely positioned stage furniture.** The bottom of the stage was three absolute
blocks with hand-tuned offsets, retuned by hand twice. Adding a full-width timeline landed
it directly on top of the clock, because nothing in the layout knew the clock was there.
Make it a flow: one column, so a new row pushes the others up.

**8.12 — Controls anchored right that grow rightward.** The speed chips grew off-canvas, and
an animated `max-width` clipped them while leaving them in the tab order — invisible and
still focusable, which is the worst of both. Span the stage, wrap, align right.

**8.13 — Case-sensitive extension matching.** `Deploy.YML` drew as a document.

**8.14 — Trailing slashes in path prefixes.** `apps/web` must not match `apps/website`. Get
this wrong and a whole directory disappears into its neighbour's listing with nothing to
show that it happened. It is worth more tests than it looks like it deserves — the original
has twenty-one for the tree logic and most are about this.

**8.15 — Flex wrap versus flex squeeze.** Covered in 6.8. Both defaults are wrong and they
are wrong in opposite directions, so trying the other one when the first misbehaves does not
converge. Group what must not shrink; let one item absorb the slack.

**8.16 — A media query that lands above the rule it overrides.** Equal specificity means
source order decides, and a narrow-screen block placed earlier in the file than the rule it
targets does *nothing at all*. This happened twice in one sitting here, and both times the
code read correctly: the buttons stayed 27px at 390px through two rebuilds while the CSS
said 24. Only measurement caught it. Put narrow overrides at the end of the stylesheet.

**8.17 — Editing a CSS block by slicing text and losing its closing brace.** An unterminated
`@media` swallows every rule after it until the next stray `}`, which corrupts the cascade in
ways that look like unrelated layout bugs. If you edit stylesheets programmatically, count
braces afterwards — it is three lines and it catches this instantly.

**8.18 — Locator waits in browser tests.** If you verify with Playwright, read the DOM
through `page.evaluate` rather than locators when checking for *absence* or iterating —
locators wait the full 30 s timeout on every miss and a sweep takes minutes instead of
seconds.

**8.19 — Tests that confirm what you hoped.** Two in this project reported success while the
feature was broken: the live-motion test above, and a sync test that reported "0 changes"
because it kept re-selecting the same node. When a test passes for a feature you have not
seen work, make it fail on purpose first.

---

## 9. Mounting it in a status panel

The entry point is a small card in the status area, linking to the full view:

- The card loads **the same log the full view does** — under 20 KB, gzipped to less — rather
  than a separate summary endpoint. A link with nothing behind it is a link nobody clicks;
  knowing there were 94 commits this month before you decide is the whole value.
- Show four figures: commits in the window, files monitored, file edits, contributors. Plus
  the latest tracked commit's sha and subject.
- **It fails silently.** This is a card on a page whose job is reporting whether the service
  is up. A missing history file is not a service problem, and an error banner here says
  "something is wrong" about the wrong thing.

The full view lives on its own route. In the original that route is **outside the auth
gate**, because it shows the public history of a public repository and contains nothing
belonging to any account. If your repository is private, that decision inverts — see the
security gate in §4.6.

Give the area its own identifier (`401` in the original) and print it in the HUD, so an
identifier read off a screenshot says where it came from without anyone having to describe
the page.

---

## 10. The third instance — a hosted navigator for any repository

The architecture in §2 already supports this; nothing in the renderer needs to change. What
is missing is a producer that runs against a repository it does not own.

**What stays exactly as it is:** the contract (§3) and the renderer (§6). That is the point
of having drawn the boundary there.

**What has to be built:**

1. **A connect step.** OAuth against the forge (GitHub App, GitLab application) rather than
   a pasted token — revocable by the user, scoped by the provider, and nothing sensitive
   ever enters a chat or a form you have to protect. Ask for the narrowest scope that reads
   history and the tree.
2. **A producer that runs server-side per repository.** Either a shallow clone plus the same
   `git log` in §4.1, or the forge's own commits API. Prefer the clone: the API's rate limits
   and pagination make a 30-day window across a busy repository expensive, and `--name-status`
   gives you file actions in one pass that the API charges a request per commit for.
3. **A cache keyed by `(repo, ref, window_days)`.** The log is deterministic given those
   three, so regenerating it per page load is pure waste. Invalidate on push webhook.
4. **A per-repository access boundary.** The generated log names paths and commit subjects
   from a private repository. It must be readable only by accounts that can read the
   repository itself, re-checked at request time rather than trusted from a session flag.
   The source bundle in §4.6 is strictly more sensitive again and should be opt-in per
   repository, off by default.
5. **A quota.** A producer that clones arbitrary repositories on demand is a resource you
   are handing to the internet. Cap clone size, history window, and concurrent jobs before
   the first public user, not after.

**Design notes for the platform layer, from what this build already taught:**

- Keep the log format versioned in the file itself. A renderer that can say "this log is
  from a newer producer than I understand" is far better than one that renders it wrongly.
- The `window_days` in the file is what the renderer trusts; do not let a URL parameter and
  the file disagree.
- Sizes matter more than they look: 94 commits and 160 paths is 20 KB. A large repository
  with a year of history is megabytes, and the interning in §4.3 is what keeps it linear in
  distinct paths rather than in edits. If you extend the window, measure before assuming.

The layers you have described building on top of this — expression, manifestation, digital
life — all read the same tree and the same event stream. The single most useful thing you
can do for them now is **keep the contract in §3 stable and additive**: new fields, never
renamed or repurposed ones. Every later layer becomes a consumer of that contract, and each
one you add makes it more expensive to change.

---

## 11. Scope of this document

This specifies the navigator and nothing else. It deliberately does not cover the surrounding
application — authentication, storage, the recording pipeline it was extracted from — and
none of that is needed to build it.

Numbers marked as measured were measured on one repository (~160 files, ~94 commits in a
30-day window, rendered at 780×520 CSS pixels). They are good defaults and the reasoning
behind each is given so you can re-derive rather than re-guess if your scale differs
substantially. If you change one, change the comment with it.
