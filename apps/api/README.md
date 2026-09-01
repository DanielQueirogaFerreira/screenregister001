# ScreenRegister API (Phase 2)

Cloudflare Worker that stores the frame catalogue in **D1** and the frame blobs in **R2**,
and enforces the 7-day retention ceiling server-side.

## Deploy

You need a Cloudflare account with a payment method on file (R2 requires one).

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

`wrangler deploy` prints the URL. Paste it into the web app under
**Settings → Cloud sync → Worker API URL**, click *Test & register*, tick *Sync enabled*.

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

## API

All routes except `/v1/health` and `POST /v1/devices` require `Authorization: Bearer <token>`.

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
