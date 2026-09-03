import { useState } from 'react';
import type { SyncStatus } from '@sr/storage';
import type { CloudConfig } from '../lib/cloud.js';
import { connect } from '../lib/cloud.js';
import { bytes } from '../lib/format.js';

interface Props {
  cloud: CloudConfig;
  status: SyncStatus | null;
  onCloud: (c: CloudConfig) => void;
  onSyncNow: () => void;
}

const LABEL: Record<SyncStatus['state'], string> = {
  idle: 'Up to date',
  syncing: 'Syncing…',
  offline: 'Offline — queued locally',
  error: 'Last pass had errors',
};

export function CloudPanel({ cloud, status, onCloud, onSyncNow }: Props) {
  const [url, setUrl] = useState(cloud.apiUrl);
  const [probe, setProbe] = useState<{ ok: boolean; msg: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function test() {
    setBusy(true);
    setProbe(null);
    try {
      await connect({ ...cloud, apiUrl: url });
      onCloud({ ...cloud, apiUrl: url });
      setProbe({ ok: true, msg: 'Connected and device registered.' });
    } catch (err) {
      setProbe({ ok: false, msg: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel" style={{ marginTop: 14 }}>
      <h3 style={{ marginTop: 0 }}>Cloud sync</h3>

      <div className="field">
        <label>Worker API URL</label>
        <input
          type="text" value={url} placeholder="https://screenregister-api.<you>.workers.dev"
          onChange={(e) => setUrl(e.target.value)}
          style={{ width: '100%', font: 'inherit', color: 'var(--fg)', background: 'var(--panel-2)',
                   border: '1px solid var(--line)', borderRadius: 8, padding: '6px 8px' }}
        />
        <div className="hint">
          {url === (typeof location !== 'undefined' ? location.origin : '')
            ? 'This page is served by the Worker, so the API is on this same origin — the URL above is already correct.'
            : 'The URL of your deployed Worker.'}{' '}
          Recording never waits on the network. Frames are written locally first and drain
          from there, so capture continues through an outage and resumes when it clears.
        </div>
      </div>

      <div className="row">
        <button onClick={() => void test()} disabled={busy || !url}>
          {busy ? 'Checking…' : 'Test & register'}
        </button>
        <label className="row" style={{ gap: 6, color: 'var(--dim)' }}>
          <input
            type="checkbox" checked={cloud.enabled} disabled={!cloud.apiUrl}
            onChange={(e) => onCloud({ ...cloud, enabled: e.target.checked })}
          />
          Sync enabled
        </label>
        <button onClick={onSyncNow} disabled={!cloud.enabled}>Sync now</button>
      </div>

      {probe && (
        <div className={`banner ${probe.ok ? 'info' : 'bad'}`} style={{ marginTop: 12 }}>
          {probe.msg}
        </div>
      )}

      {cloud.enabled && status && (
        <>
          <div className="stats" style={{ marginTop: 14 }}>
            <div className="stat"><b>{status.pending}</b><span>queued</span></div>
            <div className="stat"><b>{status.uploaded}</b><span>uploaded</span></div>
            <div className="stat"><b>{status.failed}</b><span>failed</span></div>
          </div>
          <div className="hint" style={{ marginTop: 8 }}>
            {LABEL[status.state]}
            {status.lastSyncAt && ` · last pass ${new Date(status.lastSyncAt).toLocaleTimeString()}`}
          </div>
          {status.lastError && <div className="banner bad" style={{ marginTop: 10 }}>{status.lastError}</div>}
        </>
      )}

      <div className="hint" style={{ marginTop: 12 }}>
        A frame is uploaded once its duration is known — that is, when the next frame is
        stored or the session ends. Waiting for that means each frame is sent exactly once,
        complete, instead of being patched afterwards. Frames average around {bytes(110 * 1024)}.
      </div>
    </div>
  );
}
