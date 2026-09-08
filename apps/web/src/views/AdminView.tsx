import { useCallback, useEffect, useState } from 'react';
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

interface UserRow {
  user_id: string; email: string; created_at: string; email_verified_at: string | null;
  disabled_at: string | null; locked_until: string | null;
  sessions: number; frames: number; bytes: number; last_recording: string | null;
}

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
  const [events, setEvents] = useState<AdminEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [o, u, e] = await Promise.all([
        get<{ totals: Totals; live: LiveRow[]; recent: RecentRow[] }>('/v1/admin/overview'),
        get<{ users: UserRow[] }>('/v1/admin/users'),
        get<{ events: AdminEvent[] }>('/v1/admin/events'),
      ]);
      setOverview(o);
      setUsers(u.users);
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

  async function act(path: string, method: string, confirmText?: string): Promise<void> {
    if (confirmText && !confirm(confirmText)) return;
    setBusy(path);
    try {
      const res = await fetch(path, {
        method, credentials: 'same-origin', headers: { Origin: location.origin },
      });
      if (!res.ok) throw new Error(`${method} ${path} returned ${res.status}`);
      await load();
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
        <div className="row" style={{ marginBottom: 10 }}><b>Accounts</b></div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Email</th><th>Joined</th><th>Sessions</th><th>Frames</th>
                <th>Size</th><th>Last recording</th><th>State</th>
              </tr>
            </thead>
            <tbody>
              {(users ?? []).map((u) => (
                <tr key={u.user_id}>
                  <td>{u.email}</td>
                  <td style={{ color: 'var(--dim)' }}>{day(u.created_at)}</td>
                  <td>{u.sessions}</td>
                  <td>{u.frames}</td>
                  <td>{bytes(u.bytes)}</td>
                  <td style={{ color: 'var(--dim)' }}>
                    {u.last_recording ? day(u.last_recording) : '—'}
                  </td>
                  <td>
                    {u.disabled_at ? <span className="tag warn-tag">disabled</span>
                      : u.locked_until && Date.parse(u.locked_until) > Date.now()
                        ? <span className="tag warn-tag">locked</span>
                        : u.email_verified_at ? <span className="tag">verified</span>
                          : <span className="tag">unverified</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
