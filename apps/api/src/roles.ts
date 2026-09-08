import type { Env } from './types.js';

/**
 * Who may do what.
 *
 * Two rules carry the whole design, and everything else follows from them.
 *
 * **The master is above the rank that can be granted.** An admin with `can_grant_admin`
 * can create more admins, and any of them could otherwise turn on the rest — disable the
 * account that appointed them, delete its recordings, lock it out of its own system. There
 * is no arrangement of flags among equals that prevents that. A rank nobody can grant,
 * held by exactly one account, does.
 *
 * **Permissions default to off.** A new admin can open the operator view and do nothing in
 * it. Mistakes in this file should fall towards refusing, and a forgotten flag should mean
 * a capability was not given rather than that it was.
 */

export type Role = 'user' | 'admin' | 'master';

export interface Permissions {
  /** Create, edit, disable and remove accounts. */
  can_manage_users: boolean;
  /** Promote an ordinary account to admin, and set another admin's permissions. */
  can_grant_admin: boolean;
  /** Open frames belonging to other accounts. Every use is logged. */
  can_view_frames: boolean;
  /** Delete other accounts' recordings. */
  can_delete_recordings: boolean;
}

export interface Principal {
  userId: string;
  email: string;
  role: Role;
  permissions: Permissions;
  /** True when this account is listed in ADMIN_EMAILS, which is the way back in. */
  bootstrapped: boolean;
}

export const NO_PERMISSIONS: Permissions = {
  can_manage_users: false,
  can_grant_admin: false,
  can_view_frames: false,
  can_delete_recordings: false,
};

/** The master holds everything, always, without any of it being stored. */
export const ALL_PERMISSIONS: Permissions = {
  can_manage_users: true,
  can_grant_admin: true,
  can_view_frames: true,
  can_delete_recordings: true,
};

export const PERMISSION_KEYS = Object.keys(ALL_PERMISSIONS) as (keyof Permissions)[];

/** Parse the allow-list. Blank, unset or whitespace-only means nobody is bootstrapped. */
export function adminEmails(env: Env): string[] {
  return (env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

interface UserRow {
  user_id: string;
  email: string;
  role: string | null;
  can_manage_users: number | null;
  can_grant_admin: number | null;
  can_view_frames: number | null;
  can_delete_recordings: number | null;
  disabled_at: string | null;
  deleted_at: string | null;
}

const rowPermissions = (r: UserRow): Permissions => ({
  can_manage_users: Boolean(r.can_manage_users),
  can_grant_admin: Boolean(r.can_grant_admin),
  can_view_frames: Boolean(r.can_view_frames),
  can_delete_recordings: Boolean(r.can_delete_recordings),
});

/**
 * Resolve the signed-in account to what it may do.
 *
 * ADMIN_EMAILS still matters, but only in two narrow ways, and both are recovery rather
 * than routine. It seeds the first master when the database has none, so a fresh
 * deployment has a way in. And it floors a listed account at admin, so losing the master
 * account is survivable by someone with Cloudflare access — who could edit the database
 * directly in any case, which is why this concedes nothing that was not already true.
 *
 * It does not grant master to a listed account once a master exists. Otherwise transferring
 * the role would be reversible by whoever last edited a secret, and a transfer that the
 * previous holder can undo is not a transfer.
 */
export async function resolvePrincipal(env: Env, userId: string): Promise<Principal | null> {
  const row = await env.DB.prepare(
    `SELECT user_id, email, role, can_manage_users, can_grant_admin, can_view_frames,
            can_delete_recordings, disabled_at, deleted_at
       FROM users WHERE user_id = ?`,
  ).bind(userId).first<UserRow>();
  if (!row || row.disabled_at || row.deleted_at) return null;

  const listed = adminEmails(env).includes(row.email.trim().toLowerCase());
  let role = (row.role ?? 'user') as Role;

  // Seed the first master. Only when the database has none — a check, not a claim.
  if (listed && role !== 'master') {
    const master = await env.DB.prepare(
      `SELECT user_id FROM users WHERE role = 'master' AND deleted_at IS NULL LIMIT 1`,
    ).first<{ user_id: string }>();
    if (!master) {
      await env.DB.prepare(
        `UPDATE users SET role = 'master', updated_at = ? WHERE user_id = ?`,
      ).bind(new Date().toISOString(), row.user_id).run();
      role = 'master';
    } else if (role === 'user') {
      role = 'admin';   // the floor, so the way back in is never fully closed
    }
  }

  return {
    userId: row.user_id,
    email: row.email,
    role,
    permissions: role === 'master' ? ALL_PERMISSIONS : rowPermissions(row),
    bootstrapped: listed,
  };
}

export const isOperator = (p: Principal): boolean => p.role === 'admin' || p.role === 'master';

export const can = (p: Principal, key: keyof Permissions): boolean =>
  p.role === 'master' || (isOperator(p) && p.permissions[key]);

/**
 * Whether one account may act on another.
 *
 * The master is the point of the whole arrangement: nobody but the master may touch the
 * master, so no admin — however they were appointed, and whatever flags they hold — can
 * disable, delete, demote or edit the account that appointed them.
 *
 * Acting on yourself is refused for the same reason a surgeon does not operate on himself.
 * An admin who could edit their own permissions holds every permission, and one who could
 * disable themselves can do it by accident and lock the door from the inside.
 */
export function mayActOn(actor: Principal, target: { user_id: string; role: Role }): {
  ok: boolean; reason?: string;
} {
  if (!can(actor, 'can_manage_users')) {
    return { ok: false, reason: 'This account cannot manage users.' };
  }
  if (target.user_id === actor.userId) {
    return { ok: false, reason: 'An account cannot change its own role or permissions.' };
  }
  if (target.role === 'master' && actor.role !== 'master') {
    return { ok: false, reason: 'Only the master account can act on the master account.' };
  }
  if (target.role === 'master' && actor.role === 'master') {
    return { ok: false, reason: 'The master account cannot act on itself; transfer the role first.' };
  }
  if (target.role === 'admin' && !can(actor, 'can_grant_admin')) {
    return { ok: false, reason: 'Changing another operator requires permission to grant operator access.' };
  }
  return { ok: true };
}

/** Whether an actor may set a target to a given role. */
export function maySetRole(actor: Principal, target: { user_id: string; role: Role }, next: Role): {
  ok: boolean; reason?: string;
} {
  const base = mayActOn(actor, target);
  if (!base.ok) return base;
  if (next === 'master') {
    // Master is not a role that can be handed out sideways. It moves only through a
    // transfer, which demotes the holder in the same breath — the only shape that cannot
    // leave two, and the only one the holder consents to.
    return { ok: false, reason: 'Master is transferred, not assigned.' };
  }
  if (next === 'admin' && !can(actor, 'can_grant_admin')) {
    return { ok: false, reason: 'This account cannot grant operator access.' };
  }
  return { ok: true };
}

/** Coerce arbitrary JSON into the permission set, ignoring anything unrecognised. */
export function readPermissions(input: unknown): Permissions {
  const src = (input ?? {}) as Record<string, unknown>;
  const out = { ...NO_PERMISSIONS };
  for (const key of PERMISSION_KEYS) out[key] = Boolean(src[key]);
  return out;
}

/** An actor may never grant a permission it does not itself hold. */
export function clampPermissions(actor: Principal, wanted: Permissions): Permissions {
  if (actor.role === 'master') return wanted;
  const out = { ...NO_PERMISSIONS };
  for (const key of PERMISSION_KEYS) out[key] = wanted[key] && actor.permissions[key];
  return out;
}
