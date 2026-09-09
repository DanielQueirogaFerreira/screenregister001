import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { SessionRecord } from '@sr/schema';
import type { CloudStore } from '@sr/storage';
import type { CaptureSessions } from '../capture/sessions.js';
import { LiveStrip } from './LiveStrip.js';
import { bytes, clock, day, duration, perFrame } from '../lib/format.js';

interface Props {
  store: CloudStore;
  sessions: CaptureSessions;
  accountId: string;
  /** One or several recordings to open in the player. */
  onOpen: (s: SessionRecord[]) => void;
  onInspect: (stamp: string) => void;
  onChanged: () => void;
}

export function LibraryView({ store, sessions, accountId, onOpen, onInspect, onChanged }: Props) {
  const [rows, setRows] = useState<SessionRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);

  /**
   * Which of these rows are actually recording at this moment.
   *
   * A row with no end time means one of two very different things, and until now the
   * library showed both as "unfinished" with a Finish button — which then refused with a
   * 409 for exactly the rows a person is most likely to press it on, because a capture
   * that is still running is not unfinished. The manager already knows: local captures
   * from its own snapshot, and captures on other devices from the server's live poll.
   */
  const localLive = useSyncExternalStore(sessions.subscribe, sessions.getSnapshot);
  const remoteLive = useSyncExternalStore(sessions.subscribe, sessions.getRemotes);
  const liveIds = new Set<string>([
    ...localLive.map((l) => l.sessionId).filter((id): id is string => Boolean(id)),
    ...remoteLive.map((r) => r.session_id),
  ]);

  const toggle = (id: string) => setPicked((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  const chosen = rows.filter((r) => picked.has(r.session_id));

  /**
   * Close a recording whose browser never did.
   *
   * Deleting was the only thing on offer, and it is the wrong remedy for a session that
   * holds real frames: the capture happened, and what it stored is worth keeping. The
   * server picks the end time from the last frame rather than from now — a laptop closed
   * on Friday and reopened on Monday did not record for three days.
   */
  async function finish(id: string) {
    setBusy(true);
    setNotice(null);
    try {
      const res = await store.finishSession(id);
      setNotice(res.frames > 0
        ? `Closed with ${res.frames} frame(s), ending at its last one.`
        : 'Closed. It had stored nothing, so it shows as zero length.');
      await load();
      onChanged();
    } catch (err) {
      // The server's own words are useful to a developer and noise to everyone else. The
      // one refusal a person will actually meet gets said in plain language.
      const raw = err instanceof Error ? err.message : String(err);
      setNotice(/still_recording|409/.test(raw)
        ? 'That capture is still running, so there is nothing to close yet. '
          + 'Ask it to stop — it closes itself once it has.'
        : raw);
    } finally {
      setBusy(false);
    }
  }

  async function askStop(id: string) {
    setBusy(true);
    setNotice(null);
    try {
      await store.requestStop(id);
      setNotice('Asked it to stop. The recording device acts on this within a few seconds — '
        + 'up to a minute if that tab is in the background, since browsers slow timers there.');
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const load = useCallback(async () => setRows(await store.listSessions()), [store]);
  useEffect(() => { void load(); }, [load]);

  /**
   * A session row is written when recording starts and completed when it stops, so a row
   * with no end time and no frames is a recording that began and never got anywhere.
   * Until now the commonest cause was a bug — switching to this very tab destroyed the
   * running recorder — and those rows are what is left of it. They are also what an
   * ordinary crash or a closed laptop leaves behind, so the cleanup stays.
   */
  const empty = rows.filter((s) => !s.ended_at && s.frames_stored === 0 && !liveIds.has(s.session_id));

  async function removeEmpty() {
    setBusy(true);
    try {
      for (const s of empty) await store.deleteSession(s.session_id);
      await load();
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  const strip = (
    <LiveStrip store={store} sessions={sessions} accountId={accountId} onInspect={onInspect} />
  );

  if (rows.length === 0) {
    return (
      <div>
        {strip}
        <div className="panel">
          <div className="empty">
            No finished sessions yet. Record one from the <b>Record</b> tab.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
    {strip}
    <div className="panel">
      {empty.length > 0 && (
        <div className="banner warn">
          <b>{empty.length} recording{empty.length === 1 ? '' : 's'} started but stored
          nothing.</b>{' '}
          A row is written when capture begins and completed when it stops, so these are
          sessions that never finished — a closed tab, a crash, or the tab-switch bug that
          used to stop a recording when you opened this page. There is nothing inside these
          ones, so removing them loses nothing; a recording that <i>did</i> store frames
          should be closed with <b>Finish</b> instead.
          <button style={{ marginLeft: 8 }} disabled={busy} onClick={() => void removeEmpty()}>
            {busy ? 'Removing…' : `Remove ${empty.length}`}
          </button>
        </div>
      )}
      {notice && <div className="banner info">{notice}</div>}

      {/* Opening several at once is the point of the checkboxes: two screens recorded over
          the same period are far more use side by side than one after the other. */}
      {picked.size > 0 && (
        <div className="banner info recording-bar">
          <b>{picked.size} selected</b>
          <span style={{ color: 'var(--dim)' }}>
            {chosen.reduce((n, r) => n + r.frames_stored, 0)} frames ·{' '}
            {bytes(chosen.reduce((n, r) => n + r.bytes_stored, 0))} ·{' '}
            {perFrame(
              chosen.reduce((n, r) => n + r.bytes_stored, 0),
              chosen.reduce((n, r) => n + r.frames_stored, 0),
            )}
          </span>
          <div className="row" style={{ marginLeft: 'auto' }}>
            <button className="primary" onClick={() => onOpen(chosen)}>
              Play {picked.size} together
            </button>
            <button onClick={() => setPicked(new Set())}>Clear</button>
          </div>
        </div>
      )}

      <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th style={{ width: 28 }}>
              <input
                type="checkbox"
                aria-label="Select every recording"
                checked={picked.size > 0 && picked.size === rows.length}
                ref={(el) => {
                  // Some are picked but not all: neither ticked nor empty is honest.
                  if (el) el.indeterminate = picked.size > 0 && picked.size < rows.length;
                }}
                onChange={(e) => setPicked(
                  e.target.checked ? new Set(rows.map((r) => r.session_id)) : new Set(),
                )}
              />
            </th>
            <th>Started</th><th>Length</th><th>Frames</th><th>Size</th>
            <th>Per frame</th><th>Rate</th><th>Screen</th><th>Device</th><th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => {
            const len = s.ended_at ? Date.parse(s.ended_at) - Date.parse(s.started_at) : 0;
            return (
              <tr
                key={s.session_id}
                onClick={() => onOpen([s])}
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen([s]); } }}
              >
                <td onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    aria-label={`Select the recording from ${day(s.started_at)} ${clock(s.started_at)}`}
                    checked={picked.has(s.session_id)}
                    onChange={() => toggle(s.session_id)}
                  />
                </td>
                <td>{day(s.started_at)} <span style={{ color: 'var(--dim)' }}>{clock(s.started_at)}</span></td>
                <td>
                  {s.ended_at ? duration(len)
                    : liveIds.has(s.session_id)
                      ? <span className="row" style={{ gap: 5, flexWrap: 'nowrap' }}>
                          <span className="dot live" /> recording
                        </span>
                      : <span style={{ color: 'var(--bad)' }}>unfinished</span>}
                </td>
                <td>{s.frames_stored}</td>
                <td>{bytes(s.bytes_stored)}</td>
                {/* Per recording, because this is where the settings that decide it are
                    shown too — the column beside it is the FPS and sensitivity that
                    produced this number. */}
                <td>{perFrame(s.bytes_stored, s.frames_stored)}</td>
                <td>{s.capture_fps} FPS · sens {s.sensitivity}</td>
                <td style={{ color: 'var(--dim)' }}>{s.screen_w}×{s.screen_h}</td>
                <td style={{ color: 'var(--dim)' }} title={s.device_id}>
                  <code>{s.device_id.replace(/^dev_/, '').slice(0, 8) || '—'}</code>
                </td>
                <td onClick={(e) => e.stopPropagation()}>
                  <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                    {!s.ended_at && (liveIds.has(s.session_id) ? (
                      <button
                        disabled={busy}
                        title="Ask the device holding this capture to stop; it closes itself"
                        onClick={() => void askStop(s.session_id)}
                      >
                        Ask to stop
                      </button>
                    ) : (
                      <button
                        disabled={busy}
                        title="Close this recording, ending it at its last frame"
                        onClick={() => void finish(s.session_id)}
                      >
                        Finish
                      </button>
                    ))}
                    <button
                      className="danger"
                      disabled={busy}
                      onClick={async () => {
                        if (!confirm(
                          `Permanently delete this recording of ${s.frames_stored} frame(s)? `
                          + 'The images go too, and this cannot be undone.',
                        )) return;
                        await store.deleteSession(s.session_id);
                        setPicked((prev) => {
                          const next = new Set(prev);
                          next.delete(s.session_id);
                          return next;
                        });
                        await load();
                        onChanged();
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
    </div>
    </div>
  );
}
