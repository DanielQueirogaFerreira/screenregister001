# ScreenRegister

A **7-day screen memory** you can hand to an LLM.

Open a URL, share your screen the same way you would in a video call — no install — and
the system keeps a rolling, frame-addressable record of what was actually on screen.
Every frame has an ID, a timestamp, and a change score, so Claude, ChatGPT, Gemini or
anything else can connect and *see* your last seven days instead of being told about them.

The rule that shapes everything: **do not store what did not change.** A screen that sat
still for an hour is one frame, and both the player and the API skip straight over it.

> **Status: Phase 3.** Capture, change detection, storage and playback run locally in the
> browser; frames optionally sync to a Cloudflare Worker backed by R2 and D1; and an LLM
> can read that history over **MCP** or plain REST. Next up is accounts
> (see [Roadmap](#roadmap)).

---

## Try it

```bash
pnpm install
pnpm dev            # http://localhost:5173
```

Open it on a **desktop** browser, click *Share screen & record*, and leave it alone for a
few minutes. Watch the `stored` and `sampled` counters diverge.

```bash
pnpm test                                   # 96 tests
npx vite-node packages/core/src/bench.ts    # threshold tuning bench
```

To let an assistant read your screen history, deploy the Worker and point a client at it:

```bash
claude mcp add --transport http screenregister https://<your-worker>/mcp \
  --header "Authorization: Bearer <device token>"
```

Then ask *"what was I working on yesterday afternoon?"* — see
[`apps/api/README.md`](apps/api/README.md) for the tools and the token.

Cloud sync is off by default. To turn it on, deploy the Worker and paste its URL into
**Settings → Cloud sync**. Recording never waits on the network: frames are written
locally first and drain from there, so capture continues through an outage.

```bash
pnpm migrate:api     # apply D1 migrations to the remote database
pnpm deploy:api      # deploy the Worker
```

These run in `apps/api` for you. Running `wrangler deploy` from the repository root fails —
it is a pnpm workspace with no wrangler config at the root, so wrangler cannot tell which
application you meant.

**One Worker serves everything**: the recorder UI at `/`, the API at `/v1/*` and MCP at
`/mcp`. So a deployment gives you a single URL you can open, share your screen on, and
point an assistant at.

Pushes to `main` deploy themselves via
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) — typecheck, tests, SPA
build, D1 migrations, then `wrangler deploy`. It needs one repository secret; setup and the
alternative Cloudflare-dashboard build settings are in
[`apps/api/README.md`](apps/api/README.md).

### Mobile

`getDisplayMedia` — the browser screen-share API — **does not exist on iOS Safari or
Android Chrome.** That is a platform decision, not something a polyfill can fix. Mobile
browsers can view and play back recordings; capturing from a phone needs a native client
(iOS ReplayKit, Android MediaProjection), which is Phase 6. The ingest API is a plain
HTTP contract precisely so those clients can post to it later without a redesign.

---

## How it decides what to keep

```
getDisplayMedia ─► sample at N FPS ─► [worker] luma thumb ─► 16x9 grid diff
                                                                   │
                                          preroll ring buffer ◄────┘
                                          (decides 3s behind live)
                                                   │
                    ┌──────────────────────────────┼───────────────────────┐
                    ▼                              ▼                       ▼
             transient? drop            motion? wait for it to      still? heartbeat
             (tooltip, caret)           settle, keep THAT frame     every N minutes
                                                   │
                                          WebP ─► IndexedDB
```

**1. Diff.** Each sampled frame is reduced to a 160x90 luma plane and split into a 16x9
grid. A tile counts as changed when its mean absolute difference crosses `tileThreshold`;
`changeScore` is the fraction of tiles that moved. Luma rather than RGB, because chroma
noise from the video encoder is far larger than luma noise and makes a still screen look
busy. Grid rather than a single number, because *where* it changed is worth as much as
*whether* — and it doubles as a free activity heatmap.

**2. Preroll buffer.** The decision runs a deliberate `bufferMs` (3s) behind live, so when
a change appears the processor can look **forward** before committing. That lookahead is
the whole point:

| | |
|---|---|
| **Transient suppression** | A change that reverts within `settleMs` was a tooltip, a hover, a blinking caret. Dropped. Most "activity" on an idle screen is this. |
| **Settle selection** | During real motion, store the frame where motion *stops* — not a blurred one mid-transition. The settled frame is the one a human wants and the only one an LLM can read. |
| **Burst capping** | Sustained motion is rate-limited, so a playing video cannot flood storage. |

Both lookahead behaviours need several frames inside the settle window to mean anything.
At 1 FPS there aren't any, so they **disable themselves** rather than firing on bad
evidence — the frame in hand is already the settled one.

**3. `hold_ms`.** Every stored frame records how long it stayed on screen. A motionless
hour is one row with `hold_ms = 3600000`. This single field is what makes skip-ahead work
identically in the player, in the API, and for the LLM — nobody reconstructs it twice.

**4. Heartbeat.** A frame is kept every `heartbeatMs` even at zero change. This matters
more than it looks: it is positive evidence the screen *was* showing X at 14:35, rather
than an absence of data. It is the difference between "you were on that page for an hour"
and "I have no data".

### Measured

From `packages/core/src/bench.ts`, and confirmed against a real browser end-to-end:

| scenario | fps | sampled | stored | kept |
|---|--:|--:|--:|--:|
| idle 10 min | 1 | 601 | 3 | 0.5% |
| idle 10 min + encoder noise | 1 | 601 | 3 | 0.5% |
| tooltip flicker x10 | 30 | 600 | 2 | 0.3% |
| window switch | 30 | 300 | 3 | 1.0% |
| continuous scroll 10s | 30 | 300 | 10 | 3.3% |
| typing (change every 4 frames) | 30 | 300 | 40 | 13.3% |

A live browser run at 10 FPS: **200 frames sampled, 2 stored, 12 KB** for 24 seconds
covering one static screen, one window switch, and six 200ms flickers — all six suppressed.

---

## Layout

```
apps/web            Vite + React client — capture, playback, settings
apps/api            Cloudflare Worker — ingest, read API, and the MCP server
packages/core       diff engine, ring buffer, timeline processor, fixtures, bench
packages/schema     frame/session types, settings, sensitivity mapping, ULID
packages/storage    StorageAdapter + IndexedDB store, API client, sync engine
scripts             repo-wide checks (file encoding)
```

`packages/core` is DOM-free and headless-testable — thresholds are tuned against synthetic
motion fixtures, not by eye. `StorageAdapter` is the seam Cloudflare slots into; the
IndexedDB implementation was not throwaway — it is now the offline outbox.

### The frame record

```ts
frame_id      ULID — time-sortable; the handle an LLM uses
session_id, user_id
captured_at   ISO-8601 UTC
offset_ms     monotonic from session start (immune to clock skew)
hold_ms       how long it stayed on screen  <- an idle hour is ONE row
change_score  0..1
changed_tiles which grid cells moved
reason        first | scene_change | settled | burst | heartbeat | final
width, height, bytes, format, sha256
ocr_text, caption, enrich_status    <- reserved for Phase 5, unused today
```

---

## Roadmap

| | |
|---|---|
| **1 — done** | Browser capture, change detection, preroll buffer, WebP, IndexedDB, playback, 7-day prune |
| **2 — done** | Cloudflare Worker API over R2 (blobs) and D1 (catalogue), signed device tokens, server-side retention sweep; IndexedDB became the offline outbox |
| **3 — done** | MCP server over Streamable HTTP (`list_sessions`, `get_scene_summary`, `search_timeline`, `get_frame`, `get_frames`) plus mirrored REST + OpenAPI for clients without MCP |
| **4** | Accounts — email magic link, multi-device |
| **5** | Enrichment — OCR, captions, embeddings; turns "download 400 screenshots" into "search text, fetch 3 images" |
| **6** | Native iOS/Android capture posting to the same ingest contract |

### Why Cloudflare

R2 is **$0.015/GB-month with zero egress fees**. An LLM pulling thousands of frames costs
nothing to serve; on S3 the same access pattern would be dominated by egress. Projected at
1080p WebP q70 (~110 KB/frame), an 8-hour day where ~8% of samples survive the diff:

| capture rate | per day | 7-day footprint per user |
|---|--:|--:|
| 1 FPS | ~230 MB | **~1.6 GB** (about $0.10/month) |
| 30 FPS, 4/s cap | ~900 MB | **~6.5 GB** |

---

## Privacy

Screen frames are the most sensitive data a machine holds — passwords in plaintext,
banking, private messages, other people's data visible in calls.

- In this build **nothing leaves the device.** Frames live in browser storage.
- Retention is a hard ceiling enforced by the storage layer, not by policy.
- Always-visible recording indicator; **Pause** blacks out capture without ending the session.
- No cross-user access path exists in the schema.
- **Known limitation:** the browser gives us pixels but not window titles, so a reliable
  app/site denylist is not possible until frame text extraction lands in Phase 5.
  Documented rather than pretended.

## Known Phase-1 limits

- Above ~12 buffered frames the worker encodes preroll frames to WebP to cap memory
  (90 uncompressed 1080p bitmaps would be ~700 MB). At 30 FPS that is real CPU; the UI
  surfaces the encoder backlog and the sampler applies backpressure rather than growing an
  unbounded queue. This is the tradeoff a 3-second lookahead costs at high frame rates.
- One shared surface per session. Multi-monitor means multiple concurrent sessions.
- Audio is out of scope.
- **No offline app shell.** A recording already in progress survives an outage, and its
  frames queue and drain correctly. But *starting* a new session while offline does not
  work: each session spawns a fresh capture worker, and without a service worker that
  script cannot be fetched. Found while testing; a service worker would close it.
- Device tokens are unforgeable but not revocable, and a token is as good as the device
  holding it. Accounts (Phase 4) replace this.
- The MCP server authenticates with a bearer token, not OAuth, so any client that can set
  an `Authorization` header works — but claude.ai's one-click custom connector, which
  expects an OAuth authorization server, does not. That belongs with accounts.
