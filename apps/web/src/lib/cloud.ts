import { ApiClient } from '@sr/storage';
import { deviceId, userId } from './device.js';

const CONFIG_KEY = 'sr.cloud';
const TOKEN_KEY = 'sr.cloud_token';

export interface CloudConfig {
  apiUrl: string;
  enabled: boolean;
}

/**
 * When the Worker serves this page, the API is on the very origin it was loaded from, so
 * defaulting the URL there means a fresh deploy needs no configuration at all.
 *
 * `enabled` stays false regardless. Uploading screen frames is a decision about some of
 * the most sensitive data a machine holds, and it is not one a default should make on the
 * user's behalf — they tick the box.
 */
export const DEFAULT_CLOUD: CloudConfig = {
  apiUrl: typeof location !== 'undefined' ? location.origin : '',
  enabled: false,
};

export function loadCloud(): CloudConfig {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    return raw ? { ...DEFAULT_CLOUD, ...(JSON.parse(raw) as Partial<CloudConfig>) } : DEFAULT_CLOUD;
  } catch {
    return DEFAULT_CLOUD;
  }
}

export function saveCloud(c: CloudConfig): void {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(c));
  } catch {
    /* private mode */
  }
}

/**
 * Build a client, registering this device if we do not hold a token yet.
 *
 * The token is bound to the server that issued it, so changing the API URL must discard
 * it — otherwise a signature from the old deployment would be sent to the new one and
 * every request would 401 with no obvious cause.
 */
export async function connect(config: CloudConfig): Promise<ApiClient> {
  const stored = readToken(config.apiUrl);
  const api = new ApiClient({ baseUrl: config.apiUrl, token: stored });
  await api.health();
  if (!stored) writeToken(config.apiUrl, await api.registerDevice(userId(), deviceId()));
  return api;
}

function tokenStore(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(TOKEN_KEY) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}

const readToken = (url: string): string | null => tokenStore()[normalize(url)] ?? null;

function writeToken(url: string, token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, JSON.stringify({ ...tokenStore(), [normalize(url)]: token }));
  } catch {
    /* private mode */
  }
}

const normalize = (url: string): string => url.replace(/\/+$/, '').toLowerCase();
