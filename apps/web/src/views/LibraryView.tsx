import { useCallback, useEffect, useState } from 'react';
import type { SessionRecord } from '@sr/schema';
import type { CloudStore } from '@sr/storage';
import type { CaptureSessions } from '../capture/sessions.js';
import { LiveStrip } from './LiveStrip.js';
import { bytes, day, clock, duration } from '../lib/format.js';

interface Props {
  store: CloudStore;
  sessions: CaptureSessions;
  accountId: string;
  onOpen: (s: SessionRecord) => void;
  onInspect: (stamp: string) => void;
  onChanged: () => void;
}

export function LibraryView({ store, sessions, accountId, onOpen, onInspect, onChanged }: Props) {
  const [rows, setRows] = useState<SessionRecord[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => setRows(await store.listSessions()), [store]);
  useEffect(() => { void load(); }, [load]);

  /**
   * A session row is written when recording starts and completed when it stops, so a row
   * with no end time and no frames is a recording that began and never got anywhere.
   * Until now the commonest cause was a bug — switching to this very tab destroyed the
   * running recorder — and those rows are what is left of it. They are also what an
   * ordinary crash or a closed laptop leaves behind, so the cleanup stays.
   */
  const empty = rows.filter((s) => !s.ended_at && s.frames_stored === 0);

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
          used to stop a recording when you opened this page. There is nothing inside them.
          <button style={{ marginLeft: 8 }} disabled={busy} onClick={() => void removeEmpty()}>
            {busy ? 'Removing…' : `Remove ${empty.length}`}
          </button>
        </div>
      )}
      <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Started</th><th>Length</th><th>Frames</th><th>Size</th>
            <th>Rate</th><th>Screen</th><th>Device</th><th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => {
            const len = s.ended_at ? Date.parse(s.ended_at) - Date.parse(s.started_at) : 0;
            return (
              <tr
                key={s.session_id}
                onClick={() => onOpen(s)}
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(s); } }}
              >
                <td>{day(s.started_at)} <span style={{ color: 'var(--dim)' }}>{clock(s.started_at)}</span></td>
                <td>{s.ended_at ? duration(len) : <span style={{ color: 'var(--bad)' }}>unfinished</span>}</td>
                <td>{s.frames_stored}</td>
                <td>{bytes(s.bytes_stored)}</td>
                <td>{s.capture_fps} FPS · sens {s.sensitivity}</td>
                <td style={{ color: 'var(--dim)' }}>{s.screen_w}×{s.screen_h}</td>
                <td style={{ color: 'var(--dim)' }} title={s.device_id}>
                  <code>{s.device_id.replace(/^dev_/, '').slice(0, 8) || '—'}</code>
                </td>
                <td>
                  <button
                    className="danger"
                    onClick={async (e) => {
                      e.stopPropagation();
                      await store.deleteSession(s.session_id);
                      await load();
                      onChanged();
                    }}
                  >
                    Delete
                  </button>
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
