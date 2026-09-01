import { useState } from 'react';
import { DEFAULT_SETTINGS, validateSettings, withSensitivity, type CaptureSettings } from '@sr/schema';
import type { StorageAdapter, UsageInfo } from '@sr/storage';
import { bytes } from '../lib/format.js';

interface Props {
  store: StorageAdapter;
  settings: CaptureSettings;
  usage: UsageInfo | null;
  onSettings: (s: CaptureSettings) => void;
  onChanged: () => void;
}

function Num({
  label, hint, value, step = 1, min = 0, onChange,
}: {
  label: string; hint: string; value: number; step?: number; min?: number;
  onChange: (n: number) => void;
}) {
  return (
    <div className="field">
      <label>{label}</label>
      <input type="number" value={value} step={step} min={min}
        onChange={(e) => onChange(Number(e.target.value))} />
      <div className="hint">{hint}</div>
    </div>
  );
}

export function SettingsView({ store, settings, usage, onSettings, onChanged }: Props) {
  const [busy, setBusy] = useState(false);
  const errors = validateSettings(settings);
  const set = (patch: Partial<CaptureSettings>) => onSettings({ ...settings, ...patch });

  return (
    <div className="grid cols">
      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Capture</h3>
        {errors.length > 0 && <div className="banner bad">{errors.join(' · ')}</div>}

        <Num label="Capture rate (FPS)" min={1} value={settings.captureFps}
          hint="How often the screen is sampled. Not the storage rate — the change detector decides that."
          onChange={(captureFps) => set({ captureFps })} />

        <div className="field">
          <label>Sensitivity <b>{settings.sensitivity}</b></label>
          <input type="range" min={0} max={100} value={settings.sensitivity}
            onChange={(e) => onSettings(withSensitivity(settings, Number(e.target.value)))} />
          <div className="hint">
            Drives the two thresholds below. Moving this slider overwrites them.
          </div>
        </div>

        <Num label="Tile threshold (0–255)" step={0.5} value={settings.tileThreshold}
          hint="How different a tile must look before it counts as changed. Low values pick up compression noise."
          onChange={(tileThreshold) => set({ tileThreshold })} />

        <Num label="Scene threshold (fraction of screen)" step={0.001} value={settings.sceneThreshold}
          hint={`Currently ${(settings.sceneThreshold * 100).toFixed(1)}% of the screen must move to keep a frame.`}
          onChange={(sceneThreshold) => set({ sceneThreshold })} />

        <h3>Preroll buffer</h3>
        <Num label="Buffer (ms)" step={100} value={settings.bufferMs}
          hint="How far behind live the decision runs. The lookahead this buys is what separates a tooltip from an event."
          onChange={(bufferMs) => set({ bufferMs })} />

        <Num label="Transient window (ms)" step={50} value={settings.settleMs}
          hint="A change that reverts within this window is treated as a flicker and dropped."
          onChange={(settleMs) => set({ settleMs })} />

        <Num label="Max settle wait (ms)" step={100} value={settings.maxSettleMs}
          hint="How long to wait for motion to stop before keeping the best frame available."
          onChange={(maxSettleMs) => set({ maxSettleMs })} />

        <Num label="Max frames per second" min={1} value={settings.maxFramesPerSec}
          hint="Hard ceiling during sustained motion, so a playing video cannot flood storage."
          onChange={(maxFramesPerSec) => set({ maxFramesPerSec })} />

        <Num label="Heartbeat (seconds)" min={10} value={Math.round(settings.heartbeatMs / 1000)}
          hint="Keep one frame this often even with no change, so stillness is recorded as fact."
          onChange={(s) => set({ heartbeatMs: s * 1000 })} />

        <h3>Encoding &amp; playback</h3>
        <Num label="Max width (px)" step={160} value={settings.maxWidth}
          hint="Frames are downscaled to this before encoding."
          onChange={(maxWidth) => set({ maxWidth })} />

        <Num label="WebP quality (0–1)" step={0.05} value={settings.quality}
          hint="0.7 is a good balance; below 0.5 text becomes hard to read, which matters for later OCR."
          onChange={(quality) => set({ quality })} />

        <Num label="Skip stills longer than (ms)" step={1000} value={settings.skipStillsOverMs}
          hint="In real-time playback, any longer still is compressed to this."
          onChange={(skipStillsOverMs) => set({ skipStillsOverMs })} />

        <button onClick={() => onSettings(DEFAULT_SETTINGS)}>Reset to defaults</button>
      </div>

      <div style={{ alignSelf: 'start' }}>
        <div className="panel">
          <h3 style={{ marginTop: 0 }}>Storage</h3>
          {usage && (
            <div className="stats">
              <div className="stat"><b>{usage.frames}</b><span>frames</span></div>
              <div className="stat"><b>{usage.sessions}</b><span>sessions</span></div>
              <div className="stat"><b>{bytes(usage.bytes)}</b><span>stored</span></div>
              <div className="stat">
                <b>{usage.quotaBytes ? bytes(usage.quotaBytes) : '—'}</b><span>quota</span>
              </div>
            </div>
          )}
          {usage && !usage.persisted && (
            <div className="banner warn" style={{ marginTop: 12 }}>
              Storage is not marked persistent — the browser may evict these frames under disk
              pressure before the {settings.retentionDays}-day window is up.
            </div>
          )}

          <Num label="Retention (days)" min={1} value={settings.retentionDays}
            hint="Frames older than this are deleted on load and hourly. Enforced by the store, not by policy."
            onChange={(retentionDays) => set({ retentionDays })} />

          <div className="row">
            <button disabled={busy} onClick={async () => {
              setBusy(true);
              const cutoff = new Date(Date.now() - settings.retentionDays * 86400_000).toISOString();
              const n = await store.pruneOlderThan(cutoff);
              setBusy(false);
              onChanged();
              alert(`Pruned ${n} frame(s) older than ${settings.retentionDays} days.`);
            }}>Prune now</button>
            <button className="danger" disabled={busy} onClick={async () => {
              if (!confirm('Delete every recorded frame on this device?')) return;
              setBusy(true);
              await store.clearAll();
              setBusy(false);
              onChanged();
            }}>Erase everything</button>
          </div>
        </div>

        <div className="panel" style={{ marginTop: 14 }}>
          <h3 style={{ marginTop: 0 }}>Privacy</h3>
          <div className="hint">
            Screen frames are the most sensitive data a machine holds — passwords, banking,
            private messages, other people's data in calls. In this build nothing leaves the
            device: frames live in this browser's storage and are deleted after{' '}
            {settings.retentionDays} days. Use <b>Pause</b> while recording to stop capture
            without ending the session.
            <br /><br />
            The browser gives us pixels but not window titles, so an app or site denylist
            cannot be reliable until frame text extraction lands in a later phase.
          </div>
        </div>
      </div>
    </div>
  );
}
