import { useCallback, useEffect, useState } from 'react';
import { PasswordField } from '../components/PasswordField.js';
import { bytes, clock, day, duration } from '../lib/format.js';

/**
 * Operator view: what the whole system is doing, across every account.
 *
 * One thing is deliberately absent, and its absence is the design rather than an omission.
 * There is no way to open anyone's frames from here. Listing someone's recordings and
 * watching their screen are different powers, and the second is not implied by the first —
 * it should be granted by someone who has decided to grant it, not acquired as a side
 * effect of being able to see a storage total. The server agrees: the image route has no
 * operator branch, so this page could not show a frame even if it tried.
 *
 * What an operator can do is see that a recording exists, whose it is, how large it is and
 * whether it is running; ask a runaway capture to stop; and delete one. Every one of those
 * is written to admin_events, and this page shows that log to the people who appear in it.
 */

interface Totals {
  users: number; sessions: number; frames: number; bytes: number; redacted_frames: number;
}

interface LiveRow {
  session_id: string; user_id: string; email: string; device_id: string;
  started_at: string; last_seen_at: string; frames_stored: number; bytes_stored: number;
  screen_w: number; screen_h: number; stop_requested: boolean;
}

interface RecentRow {
  session_id: string; user_id: string; email: string; device_id: string;
  started_at: string; ended_at: string | null; frames_stored: number; bytes_stored: number;
}

type Role = 'user' | 'admin' | 'master';

interface Permissions {
  can_manage_users: boolean;
  can_grant_admin: boolean;
  can_view_frames: boolean;
  can_delete_recordings: boolean;
}

interface UserRow {
  user_id: string; email: string; created_at: string; email_verified_at: string | null;
  disabled_at: string | null; deleted_at: string | null; locked_until: string | null;
  role: Role; permissions: Permissions;
  sessions: number; frames: number; bytes: number; last_recording: string | null;
}

interface Me { user_id: string; role: Role; permissions: Permissions }

const PERMISSION_LABELS: [keyof Permissions, string, string][] = [
  ['can_manage_users', 'Manage accounts', 'Create, edit, disable and remove accounts.'],
  ['can_grant_admin', 'Grant operator access', 'Promote an account, and edit another operator.'],
  ['can_view_frames', 'View others\u2019 frames', 'Open recordings belonging to other accounts. Every use is logged.'],
  ['can_delete_recordings', 'Delete recordings', 'Destroy other accounts\u2019 recordings.'],
];

interface AdminEvent {
  at: string; actor_email: string; action: string;
  subject_id: string | null; detail: string | null; ip: string | null;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`${path} returned ${res.status}`);
  return res.json() as Promise<T>;
}

export function AdminView() {
  const [overview, setOverview] = useState<
    { totals: Totals; live: LiveRow[]; recent: RecentRow[] } | null
  >(null);
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ role: Role; permissions: Permissions } | null>(null);
  const [creating, setCreating] = useState(false);
  const [newUser, setNewUser] = useState({ email: '', password: '', role: 'user' as Role });
  const [transferTo, setTransferTo] = useState<string | null>(null);
  const [transferPassword, setTransferPassword] = useState('');
  const [events, setEvents] = useState<AdminEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [o, u, e] = await Promise.all([
        get<{ totals: Totals; live: LiveRow[]; recent: RecentRow[] }>('/v1/admin/overview'),
        get<{ users: UserRow[]; me: Me }>('/v1/admin/users'),
        get<{ events: AdminEvent[] }>('/v1/admin/events'),
      ]);
      setOverview(o);
      setUsers(u.users);
      setMe(u.me);
      setEvents(e.events);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
    // Live rows go stale in 45 seconds, so a slower refresh than that would show
    // recordings as running after they had stopped.
    const t = window.setInterval(() => void load(), 15_000);
    return () => window.clearInterval(t);
  }, [load]);

  async function act(
    path: string, method: string, confirmText?: string, body?: unknown,
  ): Promise<void> {
    if (confirmText && !confirm(confirmText)) return;
    setBusy(path);
    setError(null);
    try {
      const res = await fetch(path, {
        method,
        credentials: 'same-origin',
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      if (!res.ok) {
        // The server's `detail` explains which permission is missing, and that is the
        // useful half of a refusal. A bare status code is not.
        let detail = `${method} ${path} returned ${res.status}`;
        try {
          const parsed = JSON.parse(text) as { detail?: string; error?: string; problems?: string[] };
          detail = parsed.detail ?? parsed.problems?.join(' ') ?? parsed.error ?? detail;
        } catch { /* not JSON; the status line is all there is */ }
        throw new Error(detail);
      }
      await load();
      return JSON.parse(text || '{}') as void;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  if (error && !overview) {
    return (
      <div className="panel">
        <h3 style={{ marginTop: 0 }}>The operator view is unavailable</h3>
        <div className="banner bad">{error}</div>
        <div className="hint">
          A 404 here means this account is not in <code>ADMIN_EMAILS</code> on the Worker.
          That is also what a signed-in stranger sees, deliberately: whether this deployment
          has an operator surface at all is not something to confirm to them.
        </div>
      </div>
    );
  }

  if (!overview) return <div className="panel"><div className="empty">Loading…</div></div>;

  const { totals, live, recent } = overview;
  const liveIds = new Set(live.map((r) => r.session_id));

  return (
    <div>
      <div className="banner warn">
        <b>You are looking at every account&rsquo;s recordings.</b> Everything on this page
        is written to the operator log below, including simply opening it. Frames cannot be
        viewed from here — this shows what exists, not what is in it.
      </div>

      <div className="panel">
        <div className="row" style={{ marginBottom: 10 }}>
          <b>System</b>
          <span style={{ marginLeft: 'auto', color: 'var(--dim)' }}>refreshes every 15s</span>
        </div>
        <div className="stats">
          <div className="stat"><b>{totals.users}</b><span>accounts</span></div>
          <div className="stat"><b>{totals.sessions}</b><span>sessions</span></div>
          <div className="stat"><b>{totals.frames}</b><span>frames</span></div>
          <div className="stat"><b>{bytes(totals.bytes)}</b><span>in R2</span></div>
          <div className="stat"><b>{totals.redacted_frames}</b><span>redacted</span></div>
          <div className="stat"><b>{live.length}</b><span>recording now</span></div>
        </div>
      </div>

      <div className="panel" style={{ marginTop: 14 }}>
        <div className="row" style={{ marginBottom: 10 }}>
          <span className={`dot ${live.length ? 'live' : ''}`} />
          <b>Recording right now</b>
        </div>
        {live.length === 0 ? (
          <div className="hint">
            Nothing is capturing anywhere. A session still shown as open below has stopped
            reporting in — its browser is gone — and closes itself within ten minutes, or
            immediately with <b>Finish</b>.
          </div>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Account</th><th>Device</th><th>Running</th><th>Frames</th>
                  <th>Size</th><th>Screen</th><th>Last beat</th><th></th>
                </tr>
              </thead>
              <tbody>
                {live.map((r) => (
                  <tr key={r.session_id}>
                    <td>{r.email}</td>
                    <td><code>{r.device_id.replace(/^dev_/, '').slice(0, 8)}</code></td>
                    <td>{duration(Date.now() - Date.parse(r.started_at))}</td>
                    <td>{r.frames_stored}</td>
                    <td>{bytes(r.bytes_stored)}</td>
                    <td style={{ color: 'var(--dim)' }}>{r.screen_w}×{r.screen_h}</td>
                    <td style={{ color: 'var(--dim)' }}>
                      {Math.round((Date.now() - Date.parse(r.last_seen_at)) / 1000)}s ago
                    </td>
                    <td>
                      <button
                        disabled={r.stop_requested || busy !== null}
                        onClick={() => void act(
                          `/v1/admin/sessions/${r.session_id}/request-stop`, 'POST',
                        )}
                      >
                        {r.stop_requested ? 'Stop requested' : 'Ask to stop'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="panel" style={{ marginTop: 14 }}>
        <div className="row" style={{ marginBottom: 10 }}>
          <b>Accounts</b>
          {me?.permissions.can_manage_users && (
            <button style={{ marginLeft: 'auto' }} onClick={() => setCreating((v) => !v)}>
              {creating ? 'Cancel' : 'Add an account'}
            </button>
          )}
        </div>

        {creating && (
          <div className="banner info">
            <div className="field">
              <label htmlFor="nu-email">Email</label>
              <input id="nu-email" type="email" value={newUser.email}
                onChange={(e) => setNewUser({ ...newUser, email: e.target.value })} />
            </div>
            <PasswordField
              id="nu-pass" label="First password" autoComplete="new-password"
              value={newUser.password}
              onChange={(v) => setNewUser({ ...newUser, password: v })}
              hint={
                <div className="hint">
                  Set here and shown to you once. No mail provider is configured, and an
                  invitation nobody can deliver is not an invitation — hand this over
                  yourself and have them change it.
                </div>
              }
            />
            <div className="field">
              <label htmlFor="nu-role">Role</label>
              <select id="nu-role" value={newUser.role}
                onChange={(e) => setNewUser({ ...newUser, role: e.target.value as Role })}>
                <option value="user">User — their own recordings only</option>
                {me?.permissions.can_grant_admin && (
                  <option value="admin">Operator — permissions set after creating</option>
                )}
              </select>
            </div>
            <button className="primary" disabled={busy !== null} onClick={() => void (async () => {
              await act('/v1/admin/users', 'POST', undefined, newUser);
              setNewUser({ email: '', password: '', role: 'user' });
              setCreating(false);
            })()}>
              Create
            </button>
          </div>
        )}

        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Email</th><th>Role</th><th>Joined</th><th>Sessions</th><th>Frames</th>
                <th>Size</th><th>State</th><th></th>
              </tr>
            </thead>
            <tbody>
              {(users ?? []).map((u) => {
                const isMe = u.user_id === me?.user_id;
                // Mirrors the server's rules so the interface offers only what would be
                // allowed. The server decides; this keeps it from proposing refusals.
                const mayEdit = Boolean(me?.permissions.can_manage_users)
                  && !isMe && !u.deleted_at
                  && (u.role !== 'master' || me?.role === 'master')
                  && u.role !== 'master'
                  && (u.role !== 'admin' || Boolean(me?.permissions.can_grant_admin));
                return (
                  <tr key={u.user_id} className={u.deleted_at ? 'row-removed' : ''}>
                    <td>
                      {u.email}
                      {isMe && <span className="tag" style={{ marginLeft: 6 }}>you</span>}
                    </td>
                    <td>
                      <span className={`tag ${u.role === 'master' ? 'warn-tag' : ''}`}>
                        {u.role}
                      </span>
                    </td>
                    <td style={{ color: 'var(--dim)' }}>{day(u.created_at)}</td>
                    <td>{u.sessions}</td>
                    <td>{u.frames}</td>
                    <td>{bytes(u.bytes)}</td>
                    <td>
                      {u.deleted_at ? <span className="tag warn-tag">removed</span>
                        : u.disabled_at ? <span className="tag warn-tag">disabled</span>
                          : u.locked_until && Date.parse(u.locked_until) > Date.now()
                            ? <span className="tag warn-tag">locked</span>
                            : u.email_verified_at ? <span className="tag">verified</span>
                              : <span className="tag">unverified</span>}
                    </td>
                    <td>
                      <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                        {u.role === 'master' && !isMe && (
                          <span className="hint" style={{ margin: 0 }}>protected</span>
                        )}
                        {mayEdit && (
                          <button onClick={() => {
                            setEditing(editing === u.user_id ? null : u.user_id);
                            setDraft({ role: u.role, permissions: { ...u.permissions } });
                          }}>
                            {editing === u.user_id ? 'Close' : 'Edit'}
                          </button>
                        )}
                        {me?.role === 'master' && !isMe && !u.deleted_at && u.role !== 'master' && (
                          <button
                            className="danger"
                            onClick={() => { setTransferTo(u.user_id); setTransferPassword(''); }}
                            title="Hand the master role to this account"
                          >
                            Make master
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {editing && draft && (() => {
          const u = (users ?? []).find((x) => x.user_id === editing);
          if (!u) return null;
          return (
            <div className="banner info" style={{ marginTop: 12 }}>
              <b>{u.email}</b>
              <div className="field" style={{ marginTop: 10 }}>
                <label htmlFor="ed-role">Role</label>
                <select id="ed-role" value={draft.role}
                  onChange={(e) => setDraft({ ...draft, role: e.target.value as Role })}>
                  <option value="user">User</option>
                  {me?.permissions.can_grant_admin && <option value="admin">Operator</option>}
                </select>
              </div>

              {draft.role === 'admin' && (
                <div className="health-list">
                  {PERMISSION_LABELS.map(([key, label, why]) => {
                    // An operator can never grant what it does not itself hold; the server
                    // clamps this, and showing it as unavailable is more honest than
                    // letting it be ticked and silently dropped.
                    const grantable = me?.role === 'master' || me?.permissions[key];
                    return (
                      <div key={key} className="health-row">
                        <span className="health-mark">
                          <input
                            type="checkbox"
                            checked={draft.permissions[key]}
                            disabled={!grantable}
                            onChange={(e) => setDraft({
                              ...draft,
                              permissions: { ...draft.permissions, [key]: e.target.checked },
                            })}
                          />
                        </span>
                        <span className="health-label">{label}</span>
                        <span className="health-note">
                          {why}{!grantable && ' — you do not hold this, so you cannot grant it.'}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="row" style={{ marginTop: 12 }}>
                <button className="primary" disabled={busy !== null} onClick={() => void (async () => {
                  await act(`/v1/admin/users/${u.user_id}`, 'PATCH', undefined, draft);
                  setEditing(null);
                })()}>
                  Save
                </button>
                <button disabled={busy !== null} onClick={() => void act(
                  `/v1/admin/users/${u.user_id}`, 'PATCH', undefined,
                  { disabled: !u.disabled_at },
                )}>
                  {u.disabled_at ? 'Enable' : 'Disable'}
                </button>
                <button className="danger" disabled={busy !== null} onClick={() => void act(
                  `/v1/admin/users/${u.user_id}`, 'DELETE',
                  `Remove ${u.email}, keeping their ${u.frames} recorded frame(s)?\n\n`
                  + 'They can no longer sign in. The recordings stay, still attributed to '
                  + 'them, and age out with everything else.',
                )}>
                  Remove, keep recordings
                </button>
                {me?.permissions.can_delete_recordings && (
                  <button className="danger" disabled={busy !== null} onClick={() => void act(
                    `/v1/admin/users/${u.user_id}?recordings=delete`, 'DELETE',
                    `Remove ${u.email} AND destroy all ${u.frames} of their frames?\n\n`
                    + 'The images go too. This cannot be undone.',
                  )}>
                    Remove &amp; delete recordings
                  </button>
                )}
              </div>
            </div>
          );
        })()}

        {transferTo && (() => {
          const u = (users ?? []).find((x) => x.user_id === transferTo);
          if (!u) return null;
          return (
            <div className="banner bad" style={{ marginTop: 12 }}>
              <b>Hand the master role to {u.email}?</b>
              <div className="hint" style={{ marginTop: 6 }}>
                They become the one account nobody else can edit, disable or demote — and
                this account stops being it. You keep every operator permission, but you
                will no longer be able to act on the master, including to take it back.
                Only they can transfer it onward.
              </div>
              <PasswordField
                id="xfer-pass" label="Your password" autoComplete="current-password"
                value={transferPassword} onChange={setTransferPassword}
              />
              <div className="row">
                <button
                  className="danger"
                  disabled={busy !== null || transferPassword.length === 0}
                  onClick={() => void (async () => {
                    await act('/v1/admin/transfer-master', 'POST', undefined,
                      { user_id: u.user_id, password: transferPassword });
                    setTransferTo(null);
                    setTransferPassword('');
                  })()}
                >
                  Transfer the master role
                </button>
                <button onClick={() => { setTransferTo(null); setTransferPassword(''); }}>
                  Cancel
                </button>
              </div>
            </div>
          );
        })()}
      </div>

      <div className="panel" style={{ marginTop: 14 }}>
        <div className="row" style={{ marginBottom: 10 }}>
          <b>Recent sessions</b>
          <span style={{ marginLeft: 'auto', color: 'var(--dim)' }}>last {recent.length}</span>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Account</th><th>Started</th><th>Length</th><th>Frames</th>
                <th>Size</th><th></th>
              </tr>
            </thead>
            <tbody>
              {recent.map((r) => (
                <tr key={r.session_id}>
                  <td>{r.email}</td>
                  <td>{day(r.started_at)} <span style={{ color: 'var(--dim)' }}>{clock(r.started_at)}</span></td>
                  <td>
                    {r.ended_at
                      ? duration(Date.parse(r.ended_at) - Date.parse(r.started_at))
                      : liveIds.has(r.session_id)
                        ? <span className="row" style={{ gap: 5, flexWrap: 'nowrap' }}>
                            <span className="dot live" /> recording
                          </span>
                        // Open but not reporting in: its browser is gone, so nothing will
                        // ever close it from that side. Saying "open" alone reads as
                        // "still going", which is the opposite of what it means here.
                        : <span style={{ color: 'var(--warn)' }} title="No heartbeat — its browser is gone. Closes itself within ten minutes.">
                            not reporting
                          </span>}
                  </td>
                  <td>{r.frames_stored}</td>
                  <td>{bytes(r.bytes_stored)}</td>
                  <td>
                    <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                      {/* Reachable from here as well as from the live table above: this is
                          the list an operator is actually reading when they notice a
                          recording that should not still be going, and making them find
                          the same row in another table to act on it is friction for
                          nothing. Offered for any session still open — a stop request on
                          one that has quietly died is harmless and answers 404. */}
                      {/*
                        Which control depends on whether anything is listening. Ask to
                        stop needs the recording browser alive to collect the request; when
                        it is gone that button does nothing and the row sits open, which is
                        exactly what happened. Finish closes it here instead.
                      */}
                      {!r.ended_at && (liveIds.has(r.session_id) ? (
                        <button
                          disabled={busy !== null}
                          title="Ask the device holding this capture to stop"
                          onClick={() => void act(
                            `/v1/admin/sessions/${r.session_id}/request-stop`, 'POST',
                          )}
                        >
                          Ask to stop
                        </button>
                      ) : (
                        <button
                          disabled={busy !== null}
                          title="Close this recording at its last frame; its browser is gone"
                          onClick={() => void act(
                            `/v1/admin/sessions/${r.session_id}/finish`, 'POST',
                          )}
                        >
                          Finish
                        </button>
                      ))}
                      <button
                        className="danger"
                        disabled={busy !== null}
                        onClick={() => void act(
                          `/v1/admin/sessions/${r.session_id}`, 'DELETE',
                          `Permanently delete ${r.email}'s recording of ${r.frames_stored} `
                          + 'frame(s)? The images go too, and this cannot be undone.',
                        )}
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel" style={{ marginTop: 14 }}>
        <div className="row" style={{ marginBottom: 10 }}>
          <b>Operator log</b>
          <span style={{ marginLeft: 'auto', color: 'var(--dim)' }}>
            what admins have done, including opening this page
          </span>
        </div>
        {(events ?? []).length === 0 ? (
          <div className="hint">Nothing recorded yet.</div>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr><th>When</th><th>Who</th><th>Action</th><th>Subject</th><th>Detail</th></tr>
              </thead>
              <tbody>
                {(events ?? []).map((e, i) => (
                  <tr key={`${e.at}-${i}`}>
                    <td title={e.at}>{clock(e.at)}</td>
                    <td>{e.actor_email}</td>
                    <td><code>{e.action}</code></td>
                    <td style={{ color: 'var(--dim)' }}>
                      {e.subject_id ? <code>{e.subject_id.slice(0, 10)}</code> : '—'}
                    </td>
                    <td style={{ color: 'var(--dim)' }}>{e.detail ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {error && <div className="banner bad" style={{ marginTop: 14 }}>{error}</div>}
    </div>
  );
}
