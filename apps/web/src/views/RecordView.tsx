import { useMemo, useState, useSyncExternalStore } from 'react';
import type { CaptureSettings } from '@sr/schema';
import { withSensitivity } from '@sr/schema';
import type { CloudStore, UploadStatus } from '@sr/storage';
import type { CaptureSessions, LiveSession } from '../capture/sessions.js';
import { detectSupport } from '../capture/recorder.js';
import { bytes, clock } from '../lib/format.js';

interface Props {
  store: CloudStore;
  sessions: CaptureSessions;
  accountId: string;
  settings: CaptureSettings;
  uploads: UploadStatus | null;
  /** Set when uploads stopped; capture is paused until the user retries. */
  stalled: string | null;
  onRetryUploads: () => void;
  onSettings: (s: CaptureSettings) => void;
}

function SessionCard({
  live, onPause, onStop,
}: {
  live: LiveSession;
  onPause: (paused: boolean) => void;
  onStop: () => void;
}) {
  const perMin = live.elapsedSec > 0 ? (live.stats.stored / live.elapsedSec) * 60 : 0;
  const kept = live.stats.sampled > 0 ? (live.stats.stored / live.stats.sampled) * 100 : 0;

  return (
    <div className="panel" style={{ marginBottom: 14 }}>
      <div className="row" style={{ marginBottom: 14 }}>
        <span className={`dot ${live.paused || !live.running ? '' : 'live'}`} />
        <b>{live.paused ? 'Paused' : live.running ? 'Recording' : 'Starting…'}</b>
        <span className="surface" title={live.label}>{live.label}</span>
        <span style={{ color: 'var(--dim)' }}>
          {Math.floor(live.elapsedSec / 60)}m {live.elapsedSec % 60}s
        </span>
        <div style={{ marginLeft: 'auto' }} className="row">
          <button disabled={!live.running} onClick={() => onPause(!live.paused)}>
            {live.paused ? 'Resume' : 'Pause'}
          </button>
          <button className="danger" disabled={!live.running} onClick={onStop}>Stop</button>
        </div>
      </div>

      {live.error && <div className="banner bad">{live.error}</div>}
      {live.backlog > 12 && (
        <div className="banner warn">
          Encoder is {live.backlog} frames behind — samples are being skipped to protect
          memory. Lower the capture rate.
        </div>
      )}

      <div className="stats">
        <div className="stat"><b>{live.stats.stored}</b><span>stored</span></div>
        <div className="stat"><b>{live.stats.sampled}</b><span>sampled</span></div>
        <div className="stat"><b>{kept.toFixed(1)}%</b><span>kept</span></div>
        <div className="stat"><b>{perMin.toFixed(1)}</b><span>frames/min</span></div>
        <div className="stat"><b>{live.stats.skippedTransient}</b><span>transient</span></div>
        <div className="stat"><b>{live.stats.skippedNoChange}</b><span>unchanged</span></div>
      </div>

      <div style={{ marginTop: 16 }}>
        <div className="hint" style={{ marginBottom: 6 }}>
          Change over time — blue marks a frame that was kept
        </div>
        <div className="spark">
          {live.activity.slice(-160).map((a, i) => (
            <i
              key={i}
              className={a.stored ? 'hit' : ''}
              style={{ height: `${Math.max(4, Math.min(100, a.score * 100))}%` }}
            />
          ))}
        </div>
      </div>

      {live.last && (
        <div style={{ marginTop: 14 }}>
          <div className="row" style={{ marginBottom: 10 }}>
            <b>Last kept frame</b>
            <span className={`tag ${live.last.record.reason}`}>{live.last.record.reason}</span>
            <span style={{ color: 'var(--dim)' }}>{clock(live.last.record.captured_at)}</span>
            <span style={{ marginLeft: 'auto', color: 'var(--dim)' }}>
              {bytes(live.last.record.bytes)} · change{' '}
              {(live.last.record.change_score * 100).toFixed(1)}%
            </span>
          </div>
          <img className="shot" src={live.last.url} alt="most recently stored frame" />
          {/* The frame's identity, live. Device, time and account in one code that can be
              read off the screen and looked up under Inspect. */}
          <div className="stamp-line">
            <span>stamp</span>
            <code>{live.last.stamp || '…'}</code>
            {live.last.stamp && (
              <button
                onClick={() => void navigator.clipboard?.writeText(live.last!.stamp)}
                title="Copy this frame's stamp"
              >
                Copy
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function RecordView({
  store, sessions, accountId, settings, uploads, stalled, onRetryUploads, onSettings,
}: Props) {
  const support = useMemo(detectSupport, []);
  const [error, setError] = useState<string | null>(null);
  const live = useSyncExternalStore(sessions.subscribe, sessions.getSnapshot);

  async function addScreen() {
    setError(null);
    try {
      await sessions.start(store, accountId);
    } catch (err) {
      // Cancelling the browser's own share picker lands here; that is not an error.
      const m = err instanceof Error ? err.message : String(err);
      if (!/Permission denied|NotAllowed/i.test(m)) setError(m);
    }
  }

  return (
    <div className="grid cols">
      <div>
        {!support.supported && <div className="banner bad">{support.reason}</div>}
        {error && <div className="banner bad">{error}</div>}
        {stalled && (
          <div className="banner bad">
            <b>Capture paused — uploads have stopped.</b> {stalled}. Recording is stored in
            Cloudflare, so nothing is being captured while uploads are down.{' '}
            <button style={{ marginLeft: 8 }} onClick={() => {
              onRetryUploads();
              sessions.setAllPaused(false);
            }}>
              Retry &amp; resume
            </button>
          </div>
        )}

        <div className="row" style={{ marginBottom: 14 }}>
          <button className="primary" disabled={!support.supported} onClick={() => void addScreen()}>
            {live.length === 0 ? 'Share screen & record' : 'Add another screen'}
          </button>
          {live.length > 1 && (
            <button className="danger" onClick={() => void sessions.stopAll()}>
              Stop all {live.length}
            </button>
          )}
          <span style={{ color: 'var(--dim)' }}>
            {live.length === 0 ? support.reason
              : `${live.length} capture${live.length === 1 ? '' : 's'} running`}
          </span>
        </div>

        {live.length === 0 ? (
          <div className="panel">
            <div className="empty">
              Nothing is being captured.
              <div className="hint" style={{ marginTop: 8 }}>
                Each screen or window you share becomes its own recording, and they run at
                the same time — the browser asks separately for each one, so nothing is
                captured that you have not explicitly picked.
              </div>
            </div>
          </div>
        ) : (
          live.map((s) => (
            <SessionCard
              key={s.key}
              live={s}
              onPause={(p) => sessions.setPaused(s.key, p)}
              onStop={() => void sessions.stop(s.key)}
            />
          ))
        )}
      </div>

      <div className="panel" style={{ alignSelf: 'start' }}>
        <div className="field">
          <label>
            Capture rate <b>{settings.captureFps} FPS</b>
          </label>
          <input
            type="range" min={1} max={30} step={1} value={settings.captureFps}
            onChange={(e) => onSettings({ ...settings, captureFps: Number(e.target.value) })}
          />
          <div className="hint">
            How often the screen is examined. Start at 1 and raise it — this is the sampling
            rate, not the storage rate.
          </div>
        </div>

        <div className="field">
          <label>
            Sensitivity <b>{settings.sensitivity}</b>
          </label>
          <input
            type="range" min={0} max={100} step={1} value={settings.sensitivity}
            onChange={(e) => onSettings(withSensitivity(settings, Number(e.target.value)))}
          />
          <div className="hint">
            How much must change before a frame is worth keeping. Now: a frame is kept once{' '}
            <code>{(settings.sceneThreshold * 100).toFixed(1)}%</code> of the screen moves.
            Adjustable while recording, and applies to every capture at once.
          </div>
        </div>

        <div className="field">
          <label>Heartbeat <b>{Math.round(settings.heartbeatMs / 1000)}s</b></label>
          <input
            type="range" min={30} max={900} step={30} value={settings.heartbeatMs / 1000}
            onChange={(e) => onSettings({ ...settings, heartbeatMs: Number(e.target.value) * 1000 })}
          />
          <div className="hint">
            Keeps one frame this often even when nothing moves, so the record proves the screen
            was still rather than merely lacking data.
          </div>
        </div>

        <div className="banner info" style={{ margin: 0 }}>
          Frames are processed in this browser and uploaded to Cloudflare, where they are
          kept for {store.retentionDays} days and then deleted. Nothing durable is stored
          in the browser. Recording continues while you use the Library and Settings tabs.
          {uploads && (
            <>
              {' '}Right now: <b>{uploads.uploaded}</b> uploaded, <b>{uploads.queued}</b> waiting
              {uploads.dropped > 0 && <>, <b>{uploads.dropped}</b> lost</>}.
            </>
          )}
        </div>
      </div>
    </div>
  );
}
