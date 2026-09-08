/**
 * Client side of the account system.
 *
 * There is no token to store. The session lives in an HttpOnly cookie the browser attaches
 * automatically and script cannot read, which is the point: an XSS bug in this app cannot
 * exfiltrate a login the way it could read a token out of localStorage. Every call here
 * therefore sends `credentials: 'same-origin'` and nothing else.
 */

export interface Account {
  user_id: string;
  email: string;
  email_verified: boolean;
  created_at?: string;
}

export interface MeResponse {
  user: Account;
  scope: 'read' | 'write';
  email_configured: boolean;
}

export class AuthError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly problems?: string[],
    readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

const HUMAN: Record<string, string> = {
  invalid_credentials: 'That email and password do not match an account.',
  account_locked: 'Too many failed attempts. Wait a few minutes, or reset your password.',
  rate_limited: 'Too many attempts. Please wait before trying again.',
  invalid_email: 'That does not look like an email address.',
  weak_password: 'That password does not meet the requirements.',
  invalid_or_expired_token: 'That link has expired or has already been used. Request a new one.',
  csrf_check_failed: 'The request was blocked as cross-origin. Reload the page and try again.',
  insufficient_scope: 'This token is read-only.',
  already_claimed: 'That history already belongs to another account.',
  invalid_device_token: 'This browser has no recoverable recording history.',
};

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const code = typeof body.error === 'string' ? body.error : undefined;
    throw new AuthError(
      res.status,
      (code && HUMAN[code]) ?? (typeof body.detail === 'string' ? body.detail : `Request failed (${res.status})`),
      code,
      Array.isArray(body.problems) ? (body.problems as string[]) : undefined,
      typeof body.retry_after_sec === 'number' ? body.retry_after_sec : undefined,
    );
  }
  return body as T;
}

const post = <T>(path: string, payload?: unknown): Promise<T> =>
  call<T>(path, { method: 'POST', body: JSON.stringify(payload ?? {}) });

/** Null rather than throwing: "not signed in" is the normal state on first load. */
export async function fetchMe(): Promise<MeResponse | null> {
  try {
    return await call<MeResponse>('/v1/auth/me');
  } catch (err) {
    if (err instanceof AuthError && err.status === 401) return null;
    throw err;
  }
}

export interface SignupResult {
  user: Account;
  email_configured: boolean;
  /** Present only when no mail provider is configured, so the flow stays completable. */
  verify_link?: string;
}

export const signup = (email: string, password: string): Promise<SignupResult> =>
  post('/v1/auth/signup', { email, password });

export const login = (email: string, password: string): Promise<{ user: Account }> =>
  post('/v1/auth/login', { email, password });

export const logout = (): Promise<{ ok: boolean }> => post('/v1/auth/logout');

export const requestReset = (email: string): Promise<{ message: string; reset_link?: string }> =>
  post('/v1/auth/reset/request', { email });

export const confirmReset = (token: string, password: string): Promise<{ ok: boolean }> =>
  post('/v1/auth/reset/confirm', { token, password });

export const verifyEmail = (token: string): Promise<{ ok: boolean }> =>
  post('/v1/auth/verify', { token });

export const resendVerification = (): Promise<{ verify_link?: string }> =>
  post('/v1/auth/verify/resend');

export const changePassword = (current: string, next: string): Promise<{ other_sessions_revoked: number }> =>
  post('/v1/auth/password', { current_password: current, new_password: next });

export interface LoginSession {
  id: string;
  current: boolean;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  ip: string | null;
  user_agent: string | null;
}

export const listSessions = (): Promise<{ sessions: LoginSession[] }> => call('/v1/auth/sessions');

export const revokeSession = (id: string): Promise<{ revoked: number }> =>
  call(`/v1/auth/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });

export interface ApiTokenSummary {
  id: string;
  name: string;
  scope: 'read' | 'write';
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
}

export const listTokens = (): Promise<{ tokens: ApiTokenSummary[] }> => call('/v1/auth/tokens');

export const createToken = (
  name: string, scope: 'read' | 'write', expiresInDays?: number,
): Promise<ApiTokenSummary & { token: string }> =>
  post('/v1/auth/tokens', { name, scope, expires_in_days: expiresInDays });

export const revokeToken = (id: string): Promise<{ revoked: number }> =>
  call(`/v1/auth/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' });

export interface AuthEventRow {
  at: string;
  event: string;
  ip: string | null;
  user_agent: string | null;
  detail: string | null;
}

export const listEvents = (): Promise<{ events: AuthEventRow[] }> => call('/v1/auth/events');

export const deleteAccount = (): Promise<{ ok: boolean }> =>
  call('/v1/account', { method: 'DELETE' });

// --- claiming pre-account recordings -------------------------------------------------

const LEGACY_TOKEN_KEY = 'sr.token';

/**
 * A device token left by a build from before accounts existed. Its only remaining power is
 * to prove that this browser made those recordings, so they can be moved into the account
 * now signed in — after which it is discarded.
 */
export const legacyDeviceToken = (): string | null => {
  try {
    return localStorage.getItem(LEGACY_TOKEN_KEY);
  } catch {
    return null;
  }
};

export function forgetLegacyToken(): void {
  try {
    localStorage.removeItem(LEGACY_TOKEN_KEY);
    localStorage.removeItem('sr.user_id');
    localStorage.removeItem('sr.device_id');
  } catch {
    /* private mode */
  }
}

export async function claimHistory(deviceToken: string): Promise<{ frames: number; sessions: number }> {
  const result = await post<{ frames: number; sessions: number }>('/v1/account/claim', {
    device_token: deviceToken,
  });
  forgetLegacyToken();
  return result;
}
