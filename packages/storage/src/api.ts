import type { FrameRecord, SessionRecord } from '@sr/schema';

export interface ApiConfig {
  /**
   * Prefix for every request. Empty by default, which makes every call a same-origin
   * relative path — the Worker serves this client, so there is no second address and
   * nothing for a user to configure. Tests pass an absolute base.
   */
  baseUrl?: string;
  /** Bearer token for non-browser clients (MCP, scripts). Null in the browser. */
  token: string | null;
  /**
   * Set to 'same-origin' in the browser so the HttpOnly session cookie rides along.
   * Omitted elsewhere, where there is no cookie jar and a bearer token is used instead.
   */
  credentials?: RequestCredentials;
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }

  /** A 4xx other than 429 will fail identically however many times it is retried. */
  get permanent(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 429;
  }
}

export interface HealthReport {
  ok: boolean;
  service: string;
  schema: 'ready' | 'missing' | 'error';
  retention_days: number;
  auth_configured: boolean;
  email_configured: boolean;
  cors_localhost: boolean;
  hint?: string;
  auth_hint?: string;
}

/** Thin client over the Worker API. Deliberately dumb — retry policy lives in UploadQueue. */
/** A recording that is happening right now, as the server sees it. */
export interface LiveSessionRow {
  session_id: string;
  device_id: string;
  started_at: string;
  last_seen_at: string;
  capture_fps: number;
  sensitivity: number;
  screen_w: number;
  screen_h: number;
  frames_stored: number;
  bytes_stored: number;
  label: string | null;
  stop_requested: boolean;
}

export class ApiClient {
  constructor(private config: ApiConfig) {}

  get token(): string | null {
    return this.config.token;
  }

  setToken(token: string | null): void {
    this.config.token = token;
  }

  private url(path: string): string {
    return `${(this.config.baseUrl ?? '').replace(/\/+$/, '')}${path}`;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.raw(path, init);
    return (await res.json()) as T;
  }

  private async raw(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.config.token) headers.set('Authorization', `Bearer ${this.config.token}`);

    const res = await fetch(this.url(path), {
      ...init,
      credentials: this.config.credentials,
      headers,
    });
    if (!res.ok) {
      throw new ApiError(
        res.status,
        `${init.method ?? 'GET'} ${path} failed: ${res.status} ${await res.text()}`,
      );
    }
    return res;
  }

  async health(): Promise<HealthReport> {
    const res = await fetch(this.url('/v1/health'), { credentials: this.config.credentials });
    if (!res.ok) throw new ApiError(res.status, `health check failed: ${res.status}`);
    return (await res.json()) as HealthReport;
  }

  putSession(s: SessionRecord): Promise<{ ok: boolean }> {
    return this.request(`/v1/sessions/${encodeURIComponent(s.session_id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(s),
    });
  }

  deleteSession(id: string): Promise<{ ok: boolean; deleted: number }> {
    return this.request(`/v1/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  postFrame(
    record: FrameRecord, full: Blob, thumb: Blob, original: Blob | null = null,
  ): Promise<{ ok: boolean; frame_id: string }> {
    const form = new FormData();
    form.set('meta', JSON.stringify(record));
    form.set('full', full, `${record.frame_id}.webp`);
    form.set('thumb', thumb, `${record.frame_id}.thumb.webp`);
    // Absent for a redacted frame, by construction rather than by omission: the worker
    // never encoded one.
    if (original) form.set('original', original, `${record.frame_id}.original.webp`);
    return this.request('/v1/frames', { method: 'POST', body: form });
  }

  /**
   * Set a frame's duration after the fact. Only needed when a session was interrupted and
   * the frame went up before its hold was known — the normal path sends it complete.
   */
  patchHold(frameId: string, holdMs: number): Promise<{ ok: boolean }> {
    return this.request(`/v1/frames/${encodeURIComponent(frameId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hold_ms: holdMs }),
    });
  }

  /** "Still recording." Returns any stop asked for from another device. */
  heartbeat(
    sessionId: string, counts: { frames_stored: number; bytes_stored: number },
  ): Promise<{ ok: boolean; stop_requested?: boolean }> {
    return this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(counts),
    });
  }

  /** What this account is recording right now, on any device including this one. */
  liveSessions(): Promise<{ sessions: LiveSessionRow[]; live_window_ms: number }> {
    return this.request('/v1/sessions/live');
  }

  requestStop(sessionId: string): Promise<{ ok: boolean }> {
    return this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/request-stop`, {
      method: 'POST',
    });
  }

  /** Close a session whose browser never did. Refused while it is still beating. */
  finishSession(sessionId: string): Promise<{ ok: boolean; ended_at: string | null; frames: number }> {
    return this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/finish`, {
      method: 'POST',
    });
  }

  listSessions(): Promise<{ sessions: SessionRecord[] }> {
    return this.request('/v1/sessions');
  }

  listFrames(sessionId: string): Promise<{ frames: FrameRecord[] }> {
    return this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/frames`);
  }

  /** The newer fields are optional: a Worker deployed before them answers without them. */
  usage(): Promise<{
    frames: number; bytes: number; sessions: number; oldest: string | null;
    stored_bytes?: number; original_bytes?: number; unmeasured?: number;
  }> {
    return this.request('/v1/usage');
  }

  eraseAll(): Promise<{ ok: boolean; sessions: number; frames: number }> {
    return this.request('/v1/data', { method: 'DELETE' });
  }

  /**
   * Frame bytes, fetched with the bearer token.
   *
   * Images cannot be an `<img src>`: the route is authenticated, and a plain element
   * request carries no Authorization header. Fetching to a Blob keeps every read behind
   * the same token as the metadata.
   */
  async imageBlob(
    frameId: string, variant: 'full' | 'thumb' | 'original' = 'full',
  ): Promise<Blob | null> {
    try {
      const res = await this.raw(
        `/v1/frames/${encodeURIComponent(frameId)}/image?variant=${variant}`,
      );
      return await res.blob();
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
  }
}
