import type { Env } from './types.js';

/**
 * Operator access.
 *
 * Who is an admin is derived from the ADMIN_EMAILS Worker variable on every request, and
 * is deliberately not a column. An admin can see and delete any account's recordings — the
 * most dangerous capability this system has — and a role stored in the database is one
 * careless UPDATE, one injection, or one restored-from-backup row away from belonging to
 * the wrong person. A Worker variable cannot be changed by anything the application does
 * to itself; changing it takes access to the Cloudflare account and leaves a deploy behind.
 *
 * The deliberate limit: an admin can see that a recording exists, who owns it, how large
 * it is and whether it is running, and can delete it or ask it to stop. An admin cannot
 * fetch its frames. Listing someone's recordings and watching their screen are different
 * powers, and the second one is not implied by "manage the system" — it should be granted
 * explicitly, by someone who has decided to grant it, not acquired as a side effect.
 * `/v1/frames/:id/image` therefore stays scoped to the owner with no admin branch.
 */

export interface Admin {
  userId: string;
  email: string;
}

/** Parse the allow-list. Blank, unset or whitespace-only means nobody is an admin. */
export function adminEmails(env: Env): string[] {
  return (env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Resolve the signed-in user to an admin, or null.
 *
 * The lookup is by user id and the comparison is against the stored email, so an admin
 * cannot be impersonated by signing up with a lookalike address: the address has to be the
 * one on the account, and addresses are unique and normalised at write time.
 */
export async function resolveAdmin(env: Env, userId: string): Promise<Admin | null> {
  const allowed = adminEmails(env);
  if (allowed.length === 0) return null;

  const row = await env.DB.prepare(
    `SELECT user_id, email FROM users WHERE user_id = ? AND disabled_at IS NULL`,
  ).bind(userId).first<{ user_id: string; email: string }>();
  if (!row) return null;
  if (!allowed.includes(row.email.trim().toLowerCase())) return null;
  return { userId: row.user_id, email: row.email };
}

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
