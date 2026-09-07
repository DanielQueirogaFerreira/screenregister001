import { ApiClient } from '@sr/storage';

/**
 * Connect to the backend that served this page.
 *
 * Every request is a same-origin relative path — the Worker serves the UI at `/`, the API
 * at `/v1/*` and MCP at `/mcp`, so there is one address and nothing to configure.
 *
 * There is no token to pass. The browser holds an HttpOnly session cookie it attaches
 * automatically and script cannot read, so a scripting bug in this app cannot steal a
 * login. Authentication is entirely the cookie's job; `ApiClient` sends credentials on
 * every call and carries no bearer token of its own.
 */
export async function connect(): Promise<ApiClient> {
  const api = new ApiClient({ token: null, credentials: 'same-origin' });
  await api.health();
  return api;
}
