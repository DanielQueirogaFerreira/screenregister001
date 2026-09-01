import { useEffect, useMemo, useRef, useState } from 'react';
import type { CaptureSettings, FrameRecord } from '@sr/schema';
import { withSensitivity } from '@sr/schema';
import type { ActivityPoint, ProcessorStats } from '@sr/core';
import type { StorageAdapter } from '@sr/storage';
import { Recorder, detectSupport } from '../capture/recorder.js';
import { bytes, clock } from '../lib/format.js';

interface Props {
  store: StorageAdapter;
  settings: CaptureSettings;
  onSettings: (s: CaptureSettings) => void;
  onSessionEnd: () => void;
}

const EMPTY: ProcessorStats = {
  sampled: 0, stored: 0, skippedNoChange: 0, skippedTransient: 0, skippedBurstCap: 0,
};

export function RecordView({ store, settings, onSettings, onSessionEnd }: Props) {
  const support = useMemo(detectSupport, []);
  const recorder = useRef<Recorder | null>(null);
  const [running, setRunning] = useState(false);
  const [paused, setPaused] = useState(false);
  const [stats, setStats] = useState<ProcessorStats>(EMPTY);
  const [activity, setActivity] = useState<ActivityPoint[]>([]);
  const [backlog, setBacklog] = useState(0);
  const [last, setLast] = useState<{ record: FrameRecord; url: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);

  // Keep the live recorder in step with the sliders, so tuning is immediate.
  useEffect(() => recorder.current?.updateSettings(settings), [settings]);

  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => window.clearInterval(t);
  }, [running]);

  // Revoke the previous preview URL; without this a long session leaks one blob URL
  // per stored frame.
  useEffect(() => () => { if (last) URL.revokeObjectURL(last.url); }, [last]);

  async function start() {
    setError(null);
    const r = new Recorder(store, settings, {
      onStats: (s, a, b) => { setStats(s); setActivity(a); setBacklog(b); },
      onStored: (record, thumb) =>
        setLast((prev) => {
          if (prev) URL.revokeObjectURL(prev.url);
          return { record, url: URL.createObjectURL(thumb) };
        }),
      onStopped: () => { setRunning(false); setPaused(false); onSessionEnd(); },
      onError: setError,
    });
    recorder.current = r;
    try {
      await r.start();
      setElapsed(0);
      setStats(EMPTY);
      setRunning(true);
    } catch (err) {
      // Cancelling the browser's own share picker lands here; that is not an error.
      const m = err instanceof Error ? err.message : String(err);
      if (!/Permission denied|NotAllowed/i.test(m)) setError(m);
    }
  }

  const perMin = elapsed > 0 ? (stats.stored / elapsed) * 60 : 0;
  const kept = stats.sampled > 0 ? (stats.stored / stats.sampled) * 100 : 0;

  return (
    <div className="grid cols">
      <div>
        {!support.supported && <div className="banner bad">{support.reason}</div>}
        {error && <div className="banner bad">{error}</div>}
        {backlog > 12 && (
          <div className="banner warn">
            Encoder is {backlog} frames behind — samples are being skipped to protect memory.
            Lower the capture rate.
          </div>
        )}

        <div className="panel">
          <div className="row" style={{ marginBottom: 16 }}>
            {running ? (
              <>
                <span className={`dot ${paused ? '' : 'live'}`} />
                <b>{paused ? 'Paused' : 'Recording'}</b>
                <span style={{ color: 'var(--dim)' }}>
                  {Math.floor(elapsed / 60)}m {elapsed % 60}s
                </span>
                <div style={{ marginLeft: 'auto' }} className="row">
                  <button onClick={() => { const p = !paused; setPaused(p); recorder.current?.setPaused(p); }}>
                    {paused ? 'Resume' : 'Pause'}
                  </button>
                  <button className="danger" onClick={() => void recorder.current?.stop()}>Stop</button>
                </div>
              </>
            ) : (
              <>
                <button className="primary" disabled={!support.supported} onClick={() => void start()}>
                  Share screen &amp; record
                </button>
                <span style={{ color: 'var(--dim)' }}>{support.reason}</span>
              </>
            )}
          </div>

          <div className="stats">
            <div className="stat"><b>{stats.stored}</b><span>stored</span></div>
            <div className="stat"><b>{stats.sampled}</b><span>sampled</span></div>
            <div className="stat"><b>{kept.toFixed(1)}%</b><span>kept</span></div>
            <div className="stat"><b>{perMin.toFixed(1)}</b><span>frames/min</span></div>
            <div className="stat"><b>{stats.skippedTransient}</b><span>transient</span></div>
            <div className="stat"><b>{stats.skippedNoChange}</b><span>unchanged</span></div>
          </div>

          <div style={{ marginTop: 16 }}>
            <div className="hint" style={{ marginBottom: 6 }}>
              Change over time — blue marks a frame that was kept
            </div>
            <div className="spark">
              {activity.slice(-160).map((a, i) => (
                <i
                  key={i}
                  className={a.stored ? 'hit' : ''}
                  style={{ height: `${Math.max(4, Math.min(100, a.score * 100))}%` }}
                />
              ))}
            </div>
          </div>
        </div>

        {last && (
          <div className="panel" style={{ marginTop: 14 }}>
            <div className="row" style={{ marginBottom: 10 }}>
              <b>Last kept frame</b>
              <span className={`tag ${last.record.reason}`}>{last.record.reason}</span>
              <span style={{ color: 'var(--dim)' }}>{clock(last.record.captured_at)}</span>
              <span style={{ marginLeft: 'auto', color: 'var(--dim)' }}>
                {bytes(last.record.bytes)} · change {(last.record.change_score * 100).toFixed(1)}%
              </span>
            </div>
            <img className="shot" src={last.url} alt="most recently stored frame" />
          </div>
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
            Adjustable while recording.
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
          Frames stay on this device only, for {settings.retentionDays} days. Nothing is uploaded
          in this build.
        </div>
      </div>
    </div>
  );
}
