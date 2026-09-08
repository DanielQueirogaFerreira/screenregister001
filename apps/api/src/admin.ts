import type { Env } from './types.js';

/**
 * The operator audit log, and how recent a heartbeat must be to count as recording.
 *
 * Who may do what moved to roles.ts when operators became manageable from inside the
 * product. What stayed here is the record of what they did with it.
 */

import type { Principal as Admin } from './roles.js';

/**
 * Record what an operator did.
 *
 * Separate from auth_events because these are actions taken *on other people*, and the
 * question "what has an admin been doing" should be answerable without filtering it out of
 * everyone's sign-in history. Failing to write the log must not fail the request — but
 * unlike most audit writes, a silent failure here is worth a console line, because an
 * unlogged admin action is the one kind this table exists to make impossible.
 */
export async function adminAudit(
  env: Env, req: Request, admin: Admin, action: string,
  subjectId?: string | null, detail?: string,
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO admin_events (at, actor_id, actor_email, action, subject_id, detail, ip)
       VALUES (?,?,?,?,?,?,?)`,
    ).bind(
      new Date().toISOString(), admin.userId, admin.email, action,
      subjectId ?? null, detail ?? null,
      req.headers.get('CF-Connecting-IP') ?? null,
    ).run();
  } catch (err) {
    console.error('failed to record an admin action', action, err);
  }
}

/** How recently a session must have reported in to count as recording right now. */
export const HEARTBEAT_INTERVAL_MS = 15_000;
/** Three missed beats. Long enough to ride out a slow network, short enough to be current. */
export const LIVE_WINDOW_MS = HEARTBEAT_INTERVAL_MS * 3;

export const liveCutoff = (): string =>
  new Date(Date.now() - LIVE_WINDOW_MS).toISOString();
