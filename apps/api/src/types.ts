export interface Env {
  FRAMES: R2Bucket;
  DB: D1Database;
  RETENTION_DAYS: string;
  /** HMAC key for device tokens. Set with `wrangler secret put AUTH_SECRET`. */
  AUTH_SECRET?: string;
}

export interface Principal {
  userId: string;
  deviceId: string;
}
