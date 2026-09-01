import type { FrameRecord, SessionRecord } from '@sr/schema';

export interface ApiConfig {
  /** Base URL of the Worker, e.g. https://screenregister-api.<subdomain>.workers.dev */
  baseUrl: string;
  token: string | null;
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Thin client over the Worker API. Deliberately dumb — retry policy lives in SyncEngine. */
export class ApiClient {
  constructor(private config: ApiConfig) {}

  get token(): string | null {
    return this.config.token;
  }

  setToken(token: string | null): void {
    this.config.token = token;
  }

  private url(path: string): string {
    return `${this.config.baseUrl.replace(/\/+$/, '')}${path}`;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    if (this.config.token) headers.set('Authorization', `Bearer ${this.config.token}`);

    const res = await fetch(this.url(path), { ...init, headers });
    if (!res.ok) {
      throw new ApiError(res.status, `${init.method ?? 'GET'} ${path} failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as T;
  }

  async health(): Promise<{ ok: boolean; service: string }> {
    const res = await fetch(this.url('/v1/health'));
    if (!res.ok) throw new ApiError(res.status, `health check failed: ${res.status}`);
    return (await res.json()) as { ok: boolean; service: string };
  }

  /** Exchange locally-generated ids for a signed token that makes them unforgeable. */
  async registerDevice(userId: string, deviceId: string): Promise<string> {
    const res = await fetch(this.url('/v1/devices'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: userId, device_id: deviceId }),
    });
    if (!res.ok) throw new ApiError(res.status, `device registration failed: ${res.status}`);
    const { token } = (await res.json()) as { token: string };
    this.config.token = token;
    return token;
  }

  putSession(s: SessionRecord): Promise<{ ok: boolean }> {
    return this.request(`/v1/sessions/${encodeURIComponent(s.session_id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(s),
    });
  }

  postFrame(record: FrameRecord, full: Blob, thumb: Blob): Promise<{ ok: boolean; frame_id: string }> {
    const form = new FormData();
    form.set('meta', JSON.stringify(record));
    form.set('full', full, `${record.frame_id}.webp`);
    form.set('thumb', thumb, `${record.frame_id}.thumb.webp`);
    return this.request('/v1/frames', { method: 'POST', body: form });
  }

  listSessions(): Promise<{ sessions: SessionRecord[] }> {
    return this.request('/v1/sessions');
  }

  listFrames(sessionId: string): Promise<{ frames: FrameRecord[] }> {
    return this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/frames`);
  }

  usage(): Promise<{ frames: number; bytes: number; sessions: number; oldest: string | null }> {
    return this.request('/v1/usage');
  }

  imageUrl(frameId: string, variant: 'full' | 'thumb' = 'full'): string {
    return this.url(`/v1/frames/${encodeURIComponent(frameId)}/image?variant=${variant}`);
  }
}
