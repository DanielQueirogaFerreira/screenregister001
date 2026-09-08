import { describe, expect, it } from 'vitest';
import {
  ALL_PERMISSIONS, NO_PERMISSIONS, type Principal, type Role,
  can, clampPermissions, isOperator, mayActOn, maySetRole, readPermissions, resolvePrincipal,
} from './roles.js';

const who = (role: Role, perms: Partial<typeof ALL_PERMISSIONS> = {}, id: string = role): Principal => ({
  userId: id,
  email: `${id}@example.com`,
  role,
  permissions: role === 'master' ? ALL_PERMISSIONS : { ...NO_PERMISSIONS, ...perms },
  bootstrapped: false,
});

const target = (role: Role, id: string = role) => ({ user_id: id, role });

describe('the master cannot be touched by anyone else', () => {
  it('refuses every admin, however they were appointed and whatever they hold', () => {
    // This is the whole reason the rank exists. An admin with can_grant_admin can make
    // more admins; without a rank above the one being granted, any of them could turn on
    // the account that appointed them. No arrangement of flags among equals prevents that.
    const fullAdmin = who('admin', ALL_PERMISSIONS, 'a1');
    expect(mayActOn(fullAdmin, target('master')).ok).toBe(false);
    expect(mayActOn(fullAdmin, target('master')).reason).toMatch(/Only the master/);
    expect(maySetRole(fullAdmin, target('master'), 'user').ok).toBe(false);
    expect(maySetRole(fullAdmin, target('master'), 'admin').ok).toBe(false);
  });

  it('refuses the master acting on itself, so it cannot lock its own door', () => {
    expect(mayActOn(who('master'), target('master', 'master')).ok).toBe(false);
  });

  it('is not a role anyone can assign, only transfer', () => {
    // Assigning it sideways could leave two masters, or one appointed without consent.
    expect(maySetRole(who('master'), target('user', 'u1'), 'master').ok).toBe(false);
    expect(maySetRole(who('master'), target('user', 'u1'), 'master').reason)
      .toMatch(/transferred, not assigned/);
    expect(maySetRole(who('admin', ALL_PERMISSIONS, 'a1'), target('user', 'u1'), 'master').ok)
      .toBe(false);
  });
});

describe('acting on other accounts', () => {
  it('needs the permission to manage users at all', () => {
    expect(mayActOn(who('admin', {}, 'a1'), target('user', 'u1')).ok).toBe(false);
    expect(mayActOn(who('admin', { can_manage_users: true }, 'a1'), target('user', 'u1')).ok)
      .toBe(true);
  });

  it('refuses an account acting on itself', () => {
    // An admin who can edit their own permissions holds every permission, and one who can
    // disable themselves can do it by accident.
    const a = who('admin', { can_manage_users: true, can_grant_admin: true }, 'a1');
    expect(mayActOn(a, target('admin', 'a1')).ok).toBe(false);
    expect(mayActOn(a, target('admin', 'a1')).reason).toMatch(/its own role/);
  });

  it('needs the grant permission to touch another operator', () => {
    const plain = who('admin', { can_manage_users: true }, 'a1');
    expect(mayActOn(plain, target('user', 'u1')).ok).toBe(true);
    expect(mayActOn(plain, target('admin', 'a2')).ok).toBe(false);

    const granter = who('admin', { can_manage_users: true, can_grant_admin: true }, 'a1');
    expect(mayActOn(granter, target('admin', 'a2')).ok).toBe(true);
  });

  it('needs the grant permission to promote anyone', () => {
    const plain = who('admin', { can_manage_users: true }, 'a1');
    expect(maySetRole(plain, target('user', 'u1'), 'admin').ok).toBe(false);
    expect(maySetRole(plain, target('user', 'u1'), 'user').ok).toBe(true);
  });

  it('lets the master do all of it', () => {
    const m = who('master');
    expect(mayActOn(m, target('admin', 'a1')).ok).toBe(true);
    expect(mayActOn(m, target('user', 'u1')).ok).toBe(true);
    expect(maySetRole(m, target('user', 'u1'), 'admin').ok).toBe(true);
    expect(maySetRole(m, target('admin', 'a1'), 'user').ok).toBe(true);
  });

  it('refuses an ordinary account outright', () => {
    expect(mayActOn(who('user', {}, 'u1'), target('user', 'u2')).ok).toBe(false);
  });
});

describe('permissions', () => {
  it('default to off, so a forgotten flag withholds rather than grants', () => {
    expect(readPermissions({})).toEqual(NO_PERMISSIONS);
    expect(readPermissions(null)).toEqual(NO_PERMISSIONS);
    expect(readPermissions({ nonsense: true })).toEqual(NO_PERMISSIONS);
  });

  it('ignore anything not in the set', () => {
    const p = readPermissions({ can_view_frames: true, is_superuser: true, role: 'master' });
    expect(p.can_view_frames).toBe(true);
    expect(Object.keys(p).sort()).toEqual(Object.keys(NO_PERMISSIONS).sort());
  });

  it('cannot be granted by an actor that does not hold them', () => {
    // Otherwise the weakest admin who can manage users could mint one stronger than
    // itself, and the hierarchy would only be a suggestion.
    const actor = who('admin', { can_manage_users: true, can_view_frames: true }, 'a1');
    expect(clampPermissions(actor, ALL_PERMISSIONS)).toEqual({
      ...NO_PERMISSIONS,
      can_manage_users: true,
      can_view_frames: true,
    });
  });

  it('are unclamped for the master', () => {
    expect(clampPermissions(who('master'), ALL_PERMISSIONS)).toEqual(ALL_PERMISSIONS);
  });

  it('give the master everything without any of it being stored', () => {
    const m = who('master');
    for (const key of Object.keys(ALL_PERMISSIONS) as (keyof typeof ALL_PERMISSIONS)[]) {
      expect(can(m, key), key).toBe(true);
    }
  });

  it('mean nothing for an account that is not an operator', () => {
    // A stray flag on an ordinary account must not become a capability.
    const stray = who('user', { can_view_frames: true, can_manage_users: true }, 'u1');
    expect(isOperator(stray)).toBe(false);
    expect(can(stray, 'can_view_frames')).toBe(false);
    expect(can(stray, 'can_manage_users')).toBe(false);
  });
});

describe('resolving an account', () => {
  const db = (row: unknown, master: unknown = null) => {
    const updates: unknown[][] = [];
    return {
      updates,
      env: {
        ADMIN_EMAILS: 'boss@example.com',
        DB: {
          prepare(sql: string) {
            const self = {
              _b: [] as unknown[],
              bind(...b: unknown[]) { self._b = b; return self; },
              async first() {
                return /role = 'master'/.test(sql) && !/UPDATE/.test(sql) ? master : row;
              },
              async run() { updates.push(self._b); return { meta: { changes: 1 } }; },
            };
            return self;
          },
        },
      } as never,
    };
  };

  const base = {
    user_id: 'u1', email: 'boss@example.com', role: 'user',
    can_manage_users: 0, can_grant_admin: 0, can_view_frames: 0, can_delete_recordings: 0,
    disabled_at: null, deleted_at: null,
  };

  it('seeds the first master from ADMIN_EMAILS when there is none', async () => {
    const { env, updates } = db(base, null);
    const p = await resolvePrincipal(env, 'u1');
    expect(p?.role).toBe('master');
    expect(updates.length).toBe(1);          // it wrote the promotion down
  });

  it('does not hand master back once one exists', async () => {
    // Otherwise a transfer would be undoable by whoever last edited a secret, and a
    // transfer the previous holder can reverse is not a transfer.
    const { env, updates } = db(base, { user_id: 'someone-else' });
    const p = await resolvePrincipal(env, 'u1');
    expect(p?.role).toBe('admin');           // floored, not restored
    expect(updates).toEqual([]);
  });

  it('floors a listed address at admin, so the way back in is never fully closed', async () => {
    const { env } = db(base, { user_id: 'other' });
    expect((await resolvePrincipal(env, 'u1'))?.role).toBe('admin');
  });

  it('leaves an unlisted account exactly as the database has it', async () => {
    const { env } = db({ ...base, email: 'someone@example.com', role: 'admin' }, { user_id: 'm' });
    const p = await resolvePrincipal(env, 'u1');
    expect(p?.role).toBe('admin');
    expect(p?.bootstrapped).toBe(false);
  });

  it('refuses a disabled or deleted account, listed or not', async () => {
    expect(await resolvePrincipal(db({ ...base, disabled_at: 'x' }).env, 'u1')).toBeNull();
    expect(await resolvePrincipal(db({ ...base, deleted_at: 'x' }).env, 'u1')).toBeNull();
  });

  it('is nobody when the account does not exist', async () => {
    expect(await resolvePrincipal(db(null).env, 'nope')).toBeNull();
  });
});
