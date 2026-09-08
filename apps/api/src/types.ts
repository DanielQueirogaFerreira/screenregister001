export interface Env {
  /** The built client. Used to serve the app shell for client-side routes. */
  ASSETS: Fetcher;
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
  /**
   * Transactional email, for verification and password reset. Both must be set before any
   * mail is sent; with either missing the Worker logs the link instead and says so, rather
   * than silently dropping the message.
   */
  RESEND_API_KEY?: string;
  MAIL_FROM?: string;
  /**
   * Comma-separated addresses allowed operator access.
   *
   * A Worker variable rather than a column on purpose — see admin.ts. Unset means nobody
   * is an admin, which is the correct default for a deployment nobody has configured.
   */
  ADMIN_EMAILS?: string;
}

export interface Principal {
  userId: string;
  deviceId: string;
}
