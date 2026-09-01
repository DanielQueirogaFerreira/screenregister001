# ScreenRegister API

Cloudflare Worker that stores the frame catalogue in **D1** and the frame blobs in **R2**,
enforces the 7-day retention ceiling server-side, and serves that history to an LLM over
**MCP** (or plain REST).

## Deploy

You need a Cloudflare account with a payment method on file (R2 requires one).

> **Run these from `apps/api`, not the repository root.** This repo is a pnpm workspace,
> and there is no wrangler config at the root, so `wrangler deploy` there fails with:
>
> ```
> ✘ [ERROR] The Cloudflare application detection logic has been run in the root of a
>   workspace instead of targeting a specific project.
> ```
>
> Wrangler is telling you it found a workspace and does not know which application you
> meant. Either `cd apps/api` first, or use the root shortcuts, which do it for you:
> `pnpm deploy:api`, `pnpm migrate:api`, `pnpm dev:api`.
>
> One trap if you write your own: **`pnpm --filter @sr/api deploy` does not work.** `deploy`
> is a built-in pnpm command and silently shadows the package script — you get
> `Unknown option: 'dry-run'` with no hint a script was involved. Insert `run`:
> `pnpm --filter @sr/api run deploy`.

```bash
cd apps/api
npx wrangler login

# 1. Create the bucket and the database
npx wrangler r2 bucket create screenregister-frames
npx wrangler d1 create screenregister
#    ^ copy the printed database_id into wrangler.toml, replacing
#      REPLACE_WITH_ID_FROM_WRANGLER_D1_CREATE

# 2. Create the schema
npx wrangler d1 migrations apply screenregister --remote

# 3. Set the token-signing key (any long random string; keep it secret)
openssl rand -hex 32 | npx wrangler secret put AUTH_SECRET

# 4. Ship it
npx wrangler deploy
```

`deploy` runs a preflight check first (`pnpm --filter @sr/api run preflight` to run it
alone). It catches the mistakes that `--dry-run` cannot: a dry run validates the bundle
but never checks whether the bindings point at resources that exist, so an unedited
`database_id` passes it and then fails against the Cloudflare API with an error that does
not mention the config file.

`wrangler deploy` prints the URL. Paste it into the web app under
**Settings → Cloud sync → Worker API URL**, click *Test & register*, tick *Sync enabled*.

### Deploying from the Cloudflare dashboard (connected to GitHub)

**One Worker serves everything** — the recorder UI at `/`, the API at `/v1/*`, and MCP at
`/mcp`. `[assets]` in `wrangler.toml` points at the built SPA, and any request that does
not match a built file falls through to the Worker. That means one deployment, one URL,
and the browser client calling the API on the origin it was loaded from, so there is no
CORS to configure and no second address to keep in sync.

Set the build configuration to exactly this:

| setting | value |
|---|---|
| **Root directory** | `apps/api` |
| **Build command** | `pnpm --filter @sr/web run build` |
| **Deploy command** | `npx wrangler deploy` |

Three things go wrong if these are left at their defaults:

- **Root directory `/`** makes wrangler run in the workspace root, where there is no
  config, and it fails with *"Missing entry-point to Worker script or to assets
  directory"* — or, for `deploy`, the workspace-detection error above. It has to point at
  the directory holding `wrangler.toml`.
- **The build command must build the web app**, because the Worker serves it. `pnpm run
  build` at the root does this too, but naming the filter makes the dependency obvious.
  Wrangler bundles the Worker itself; the build step exists only to produce `apps/web/dist`.
- **`wrangler versions upload` uploads a version without sending traffic to it**, so a
  build can succeed while the live Worker never changes. Use `wrangler deploy`.

`AUTH_SECRET` still has to be set as a secret. The dashboard's build variables are
plaintext and are not the same thing; a secret set with `wrangler secret put AUTH_SECRET`
survives redeploys.

After the first deploy, open the Worker's URL, go to **Settings → Cloud sync**, and the
API URL is already filled in with that same origin. Tick *Sync enabled* — deliberately not
on by default, because uploading screen frames is not a decision a default should make for
you.

> **Set `AUTH_SECRET` before you deploy.** Without it the Worker falls back to a
> well-known development key, and anyone who knows it could mint a token for any user id.
> The fallback exists so `wrangler dev` works offline; it is not safe in production.

## Run locally

```bash
npx wrangler d1 migrations apply screenregister --local
npm run dev            # http://127.0.0.1:8787, D1 and R2 emulated on disk
```

Add `--test-scheduled` to expose `GET /__scheduled?cron=0+3+*+*+*`, which runs the
retention sweep on demand instead of waiting for 03:00.

## Connecting an LLM (Phase 3)

The Worker speaks **MCP over Streamable HTTP** at `POST /mcp`, using the same device
token as the REST API.

```bash
claude mcp add --transport http screenregister https://<your-worker>/mcp \
  --header "Authorization: Bearer <your device token>"
```

Get a token with `POST /v1/devices`, or copy the one the web app already stored under
`sr.cloud_token` in localStorage.

Then ask, in plain language: *"What was I working on yesterday afternoon?"* The assistant
calls `get_scene_summary` first, narrows with `search_timeline`, and pulls a couple of
images with `get_frame`.

### The tools, and why they are layered

Seven days of frames is thousands of images. An assistant that had to download them to
answer a question would exhaust its context before reaching the answer. So the tools are
tiered — cheap text first, pixels last:

| tool | returns | cost |
|---|---|---|
| `list_sessions` | when the screen was being recorded at all | text |
| `get_scene_summary` | a period collapsed into scenes — a day becomes a few dozen lines | text |
| `search_timeline` | individual frames, filterable by change or reason | text |
| `get_frame` | the screenshot at one moment | **image** |
| `get_frames` | up to 8 moments, forced to thumbnails | **images** |

`get_frames` caps at 8 and refuses full-size images on purpose: a dozen full screenshots
crowds out whatever the assistant was reasoning about.

The server's `instructions` tell the client that gaps between frame timestamps mean
"nothing changed", not "no data" — without that, an assistant reads sparse frames as
missing history and hedges its answers.

### Clients that do not speak MCP

The same reads are mirrored as REST, running the same code in `queries.ts` so the two
surfaces cannot drift: `GET /v1/scenes` and `GET /v1/timeline`, described by
`GET /v1/openapi.json` (unauthenticated, so a client can discover the shape before
holding a token).

### Known limit: no OAuth

Authentication is a bearer token, not OAuth. Any client that can set an `Authorization`
header works today — Claude Code, scripts, most MCP clients. The one-click custom
connector on claude.ai expects an OAuth authorization server, which this does not yet
implement; that belongs with real accounts in Phase 4.

## API

All routes except `/v1/health`, `/v1/openapi.json` and `POST /v1/devices` require
`Authorization: Bearer <token>`.

| | |
|---|---|
| `GET /v1/health` | liveness |
| `POST /v1/devices` | `{user_id, device_id}` → `{token}` |
| `PUT /v1/sessions/:id` | upsert a session (idempotent) |
| `GET /v1/sessions` | the caller's sessions, newest first |
| `DELETE /v1/sessions/:id` | delete a session, its rows and its objects |
| `POST /v1/frames` | multipart: `meta` (JSON), `full` (file), `thumb` (file) |
| `PATCH /v1/frames/:id` | `{hold_ms}` |
| `GET /v1/sessions/:id/frames` | the session's frames, in capture order |
| `GET /v1/frames/:id/image?variant=full\|thumb` | the WebP bytes |
| `GET /v1/usage` | frame count, byte total, oldest frame |
| `GET /v1/scenes` | a period collapsed into scenes |
| `GET /v1/timeline` | individual frames as metadata |
| `GET /v1/openapi.json` | machine-readable API description (no auth) |
| `POST /mcp` | MCP over Streamable HTTP |

## Design notes

**Tokens, not accounts.** The client mints `user_id` and `device_id` locally, but those
are guessable — anyone could name someone else's id. So the server HMAC-signs the pair and
demands the signature back: possession of the token grants access, not knowledge of the id.
Every query filters on the token's user, and there is no code path that reads another
user's rows. This is the smallest thing that makes the ids unforgeable, not an account
system; real auth replaces `issue`/`verify` without the rest of the API changing.

**Blobs go through the Worker.** The original plan called for presigned direct-to-R2 PUTs
to save bandwidth. That reasoning does not apply here: Cloudflare does not bill Worker
bandwidth, and a frame is ~110 KB — far inside the request limit. Presigning would buy
nothing and cost a set of S3 credentials to manage, so `env.FRAMES.put()` it is.

**No Durable Object.** The plan proposed one per live session for sequencing and to hold
the open frame's unknown `hold_ms`. Neither is needed: ordering comes from the client's
monotonic `seq` and its time-sortable ULIDs, and the client already knows a frame's
duration the moment the next frame is stored. A DO would have added a moving part for no
current benefit.

**Retention deletes rows and objects in one pass.** An R2 lifecycle rule would expire
objects on its own schedule and leave catalogue rows pointing at nothing. The nightly
`scheduled` handler removes both together, then drops sessions left with no frames.

## Verified

Against `wrangler dev --local` (real D1 and R2 emulation):

- Missing, malformed and forged tokens are all rejected with 401.
- A second user attaching a frame to someone else's session gets 403; reading their
  sessions returns empty and their images 404.
- Uploaded and downloaded blobs are byte-identical (SHA-256) for both variants.
- The retention sweep deletes a 10-day-old frame's row **and** its R2 objects, drops the
  emptied session, and leaves in-window frames untouched.
- Full round trip from the browser client: record → sync → D1 + R2 → fetched back as
  valid WebP showing the recorded screen.
- Network cut mid-session: capture continued, frames queued locally, and the whole
  backlog drained once the connection returned.

Phase 3, driven by a real MCP client (`@modelcontextprotocol/sdk` 1.30.0) over the wire:

- Protocol negotiated at **2025-11-25**; all five tools listed with their schemas and
  called successfully, returning text and base64 WebP image blocks.
- An unrelated user's token sees no sessions, no frames and no scenes, and asking for a
  known frame id belonging to someone else returns an error with **no image block**.
- An unauthenticated `POST /mcp` is rejected with 401 before any MCP handling runs.
- `GET /v1/scenes` and `GET /v1/timeline` return the same scenes and frames the MCP tools
  report, and both require auth.
