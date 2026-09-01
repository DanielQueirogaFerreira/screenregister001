export interface Env {
  FRAMES: R2Bucket;
  DB: D1Database;
  RETENTION_DAYS: string;
  /** HMAC key for device tokens. Set with `wrangler secret put AUTH_SECRET`. */
  AUTH_SECRET?: string;
  /**
   * Allow cross-origin calls from localhost. Off unless explicitly "true".
   *
   * Only useful when running a dev client on one port against an API on another. A
   * deployed Worker serves its own client, so production has no reason to accept requests
   * from whatever else happens to be listening on a developer's machine.
   */
  ALLOW_LOCALHOST_ORIGINS?: string;
}

export interface Principal {
  userId: string;
  deviceId: string;
}
