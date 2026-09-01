import { useCallback, useEffect, useState } from 'react';
import type { SessionRecord } from '@sr/schema';
import type { StorageAdapter } from '@sr/storage';
import { bytes, day, clock, duration } from '../lib/format.js';

interface Props {
  store: StorageAdapter;
  onOpen: (s: SessionRecord) => void;
  onChanged: () => void;
}

export function LibraryView({ store, onOpen, onChanged }: Props) {
  const [sessions, setSessions] = useState<SessionRecord[]>([]);

  const load = useCallback(async () => setSessions(await store.listSessions()), [store]);
  useEffect(() => { void load(); }, [load]);

  if (sessions.length === 0) {
    return (
      <div className="panel">
        <div className="empty">
          No sessions yet. Record one from the <b>Record</b> tab.
        </div>
      </div>
    );
  }

  return (
    <div className="panel">
      <table>
        <thead>
          <tr>
            <th>Started</th><th>Length</th><th>Frames</th><th>Size</th>
            <th>Rate</th><th>Screen</th><th></th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((s) => {
            const len = s.ended_at ? Date.parse(s.ended_at) - Date.parse(s.started_at) : 0;
            return (
              <tr key={s.session_id} onClick={() => onOpen(s)}>
                <td>{day(s.started_at)} <span style={{ color: 'var(--dim)' }}>{clock(s.started_at)}</span></td>
                <td>{s.ended_at ? duration(len) : <span style={{ color: 'var(--bad)' }}>unfinished</span>}</td>
                <td>{s.frames_stored}</td>
                <td>{bytes(s.bytes_stored)}</td>
                <td>{s.capture_fps} FPS · sens {s.sensitivity}</td>
                <td style={{ color: 'var(--dim)' }}>{s.screen_w}×{s.screen_h}</td>
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
  );
}
