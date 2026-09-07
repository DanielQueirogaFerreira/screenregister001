import { ApiClient } from '@sr/storage';
import { deviceId, userId } from './device.js';

const TOKEN_KEY = 'sr.token';

/**
 * Connect to the backend that served this page.
 *
 * Every request is a same-origin relative path — the Worker serves the UI at `/`, the API
 * at `/v1/*` and MCP at `/mcp`, so there is exactly one address and nothing for a user to
 * configure. There is no URL field and no enable switch: opening the app *is* connecting
 * to it, and a recording that has not reached the Worker is not stored anywhere.
 *
 * The device token is kept in localStorage. That is not a data store — it is this
 * device's identity, and losing it would lock the user out of their own history on the
 * next reload rather than merely costing a cache. Accounts replace it in a later phase.
 */
export async function connect(): Promise<ApiClient> {
  const api = new ApiClient({ token: readToken() });
  await api.health();
  if (!api.token) writeToken(await api.registerDevice(userId(), deviceId()));
  return api;
}

function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null; // private mode: a fresh token is issued per page load
  }
}

function writeToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* private mode */
  }
}
