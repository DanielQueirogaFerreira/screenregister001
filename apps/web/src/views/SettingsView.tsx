import { useState } from 'react';
import {
  DEFAULT_SETTINGS, settingsAreCustom, thresholdsFor, validateSettings, withSceneThreshold,
  withSensitivity, withTileThreshold, type CaptureSettings,
} from '@sr/schema';
import type { CloudStore, UploadStatus, UsageInfo } from '@sr/storage';
import { bytes, day } from '../lib/format.js';
import { CloudStatusPanel } from './CloudStatusPanel.js';
import { ZoneEditor } from './ZoneEditor.js';
import { AccountPanel } from './AccountPanel.js';
import type { Account } from '../lib/auth.js';

interface Props {
  store: CloudStore;
  settings: CaptureSettings;
  usage: UsageInfo | null;
  uploads: UploadStatus | null;
  account: Account;
  emailConfigured: boolean;
  onSignedOut: () => void;
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

export function SettingsView({
  store, settings, usage, uploads, account, emailConfigured, onSignedOut, onSettings, onChanged,
}: Props) {
  const [busy, setBusy] = useState(false);
  const errors = validateSettings(settings);
  const set = (patch: Partial<CaptureSettings>) => onSettings({ ...settings, ...patch });
  const custom = settingsAreCustom(settings);

  return (
    <div className="grid cols">
      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Capture</h3>
        {errors.length > 0 && <div className="banner bad">{errors.join(' · ')}</div>}

        <Num label="Capture rate (FPS)" min={1} value={settings.captureFps}
          hint="How often the screen is sampled. Not the storage rate — the change detector decides that."
          onChange={(captureFps) => set({ captureFps })} />

        <div className="field">
          <label>
            Sensitivity <b>{settings.sensitivity}</b>
          </label>
          <input type="range" min={0} max={100} value={settings.sensitivity}
            onChange={(e) => onSettings(withSensitivity(settings, Number(e.target.value)))} />
          <div className="hint">
            The slider and the two thresholds below are one setting seen two ways, and they
            now move together in both directions — typing a tile threshold slides this, and
            sliding this rewrites both thresholds.
          </div>
        </div>

        <Num label="Tile threshold (0–255)" step={0.5} value={settings.tileThreshold}
          hint="How different a tile must look before it counts as changed. Low values pick up compression noise."
          onChange={(tileThreshold) => onSettings(withTileThreshold(settings, tileThreshold))} />

        <Num label="Scene threshold (fraction of screen)" step={0.001} value={settings.sceneThreshold}
          hint={`Currently ${(settings.sceneThreshold * 100).toFixed(1)}% of the screen must move to keep a frame.`}
          onChange={(sceneThreshold) => onSettings(withSceneThreshold(settings, sceneThreshold))} />

        {custom && (
          <div className="banner info" style={{ marginTop: -4 }}>
            These thresholds no longer match sensitivity&nbsp;{settings.sensitivity}. That is
            allowed — the detector uses the numbers, not the slider — but the slider is now
            only an approximation of what is running.
            <div className="row" style={{ marginTop: 10 }}>
              <button onClick={() => onSettings(withSensitivity(settings, settings.sensitivity))}>
                Snap to sensitivity {settings.sensitivity}
              </button>
              <span className="hint" style={{ margin: 0 }}>
                would set tile {thresholdsFor(settings.sensitivity).tileThreshold} · scene{' '}
                {(thresholdsFor(settings.sensitivity).sceneThreshold * 100).toFixed(1)}%
              </span>
            </div>
          </div>
        )}

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
          hint="Hard ceiling during sustained motion, so a playing video cannot flood storage. Clamped to the capture rate, so at 1 FPS this never binds — use the minimum gap below."
          onChange={(maxFramesPerSec) => set({ maxFramesPerSec })} />

        <Num label="Minimum gap between stored frames (s)" min={0} step={1}
          value={Math.round(settings.minStoreGapMs / 1000)}
          hint="The knob that decides how much a busy hour costs. Measured on real recordings at ~103 KB a frame: 0 stores every second (~370 MB/h), 3 s costs ~123 MB/h, 5 s ~74 MB/h. It changes how often the screen is sampled into the record, never the quality of a frame, and a still screen is free either way."
          onChange={(sec) => set({ minStoreGapMs: sec * 1000 })} />

        <Num label="Heartbeat (seconds)" min={10} value={Math.round(settings.heartbeatMs / 1000)}
          hint="Keep one frame this often even with no change, so stillness is recorded as fact."
          onChange={(s) => set({ heartbeatMs: s * 1000 })} />

        <h3>Provenance &amp; privacy</h3>

        <div className="field">
          <label htmlFor="burnin">Burn the stamp into stored frames</label>
          <div className="row">
            <input
              id="burnin" type="checkbox" checked={settings.burnInStamp}
              onChange={(e) => set({ burnInStamp: e.target.checked })}
              style={{ width: 'auto' }}
            />
            <span className="hint" style={{ margin: 0 }}>
              bottom-left corner, over a scrim
            </span>
          </div>
          <div className="hint">
            So an image that leaves here still says which recording it came from, which a
            database row cannot do once the image has left the database. It covers well
            under one percent of the frame and costs nothing measurable.
          </div>
        </div>

        <div className="field">
          <label htmlFor="keeporig">Also keep the untouched capture</label>
          <div className="row">
            <input
              id="keeporig" type="checkbox" checked={settings.keepOriginal}
              disabled={!settings.burnInStamp}
              onChange={(e) => set({ keepOriginal: e.target.checked })}
              style={{ width: 'auto' }}
            />
            <span className="hint" style={{ margin: 0 }}>
              {settings.keepOriginal && settings.burnInStamp
                ? 'two images per frame'
                : 'one image per frame'}
            </span>
          </div>
          <div className="hint">
            <b>This doubles storage.</b> It is the largest single lever on this page: a
            second copy of every frame, differing from the first by a caption in one
            corner. Worth it only when the unmarked pixels are the point. Nothing to keep
            for a redacted frame — there is no untouched copy of one, because it was never
            encoded.
          </div>
        </div>

        <div className="field">
          <label htmlFor="privacy">Masked password fields</label>
          <select
            id="privacy" value={settings.privacyMask}
            onChange={(e) => set({ privacyMask: e.target.value as CaptureSettings['privacyMask'] })}
          >
            <option value="mask">Paint over them and discard the original</option>
            <option value="flag">Only record that one was seen</option>
            <option value="off">Do not look</option>
          </select>
          <div className="hint">
            Every frame is checked for a row of identical evenly spaced glyphs — what a
            password field looks like while it is masked. On <b>mask</b>, the field is
            painted black and only that version is ever encoded: the unmasked image is
            never created, so there is no copy to delete and no deletion that can fail.
            <br /><br />
            <b>What it does not catch:</b> a password typed in the clear, an empty field, a
            secret in a document, a key in a terminal, a card number. It works from
            appearance alone, because the browser hands this application pixels and no
            structure at all — there is no way to ask where a password field is. Treat it
            as less exposure, not as a guarantee.
            {settings.privacyMask === 'mask' && (
              <>
                <br /><br />
                It can also be wrong the other way. A run of eight or more identical, evenly
                spaced marks that is <i>not</i> a password gets masked, and the original of
                that frame is gone. <b>Flag</b> keeps both while you judge whether it
                behaves on your screens.
              </>
            )}
          </div>
        </div>

        <div className="field">
          <label>Never capture these areas</label>
          <div className="hint" style={{ marginTop: 0, marginBottom: 10 }}>
            The only control on this page that promises rather than estimates. A zone is
            painted black in the worker <b>before the change detector runs and before
            anything is encoded</b>, so no image, thumbnail, or untouched second copy of
            what was inside it is ever created — there is nothing to delete and no deletion
            that can fail. It costs one rectangle fill per sampled frame.
            <br /><br />
            The trade is that it is manual and static. It protects the corner where a
            password manager opens, the panel a terminal always occupies, the half of a
            second monitor you never want recorded — places you can name in advance. It
            cannot follow a window that moves, and it does not know what is inside it.
            Zones are stored as fractions of the frame, so they land on the same part of
            the screen if your resolution changes.
          </div>
          <ZoneEditor
            zones={settings.excludedZones}
            onChange={(excludedZones) => set({ excludedZones })}
          />
        </div>

        <h3>Encoding &amp; playback</h3>
        <Num label="Max width (px)" step={160} value={settings.maxWidth}
          hint="Frames are downscaled to this before encoding."
          onChange={(maxWidth) => set({ maxWidth })} />

        <Num label="WebP quality (0–1)" step={0.05} value={settings.quality}
          hint="0.5 is the default, chosen by measuring OCR accuracy on a realistic screen rather than guessing: it costs 24% fewer bytes than 0.7 with no measurable loss of readable text. 0.4 saves 34% and softens dark-mode interfaces slightly. Below 0.35 frames start to look degraded — light text on dark backgrounds mottles first — before they become unreadable, which is the wrong trade for a record you are meant to trust."
          onChange={(quality) => set({ quality })} />

        <Num label="Skip stills longer than (ms)" step={1000} value={settings.skipStillsOverMs}
          hint="In real-time playback, any longer still is compressed to this."
          onChange={(skipStillsOverMs) => set({ skipStillsOverMs })} />

        <button onClick={() => onSettings(DEFAULT_SETTINGS)}>Reset to defaults</button>
      </div>

      <div style={{ alignSelf: 'start' }}>
        <div className="panel">
          <h3 style={{ marginTop: 0 }}>Stored in Cloudflare</h3>
          {usage ? (
            <>
              <div className="stats">
                <div className="stat"><b>{usage.frames}</b><span>frames</span></div>
                <div className="stat"><b>{usage.sessions}</b><span>sessions</span></div>
                <div className="stat"><b>{bytes(usage.bytes)}</b><span>in R2</span></div>
                <div className="stat">
                  <b>{usage.oldest ? day(usage.oldest) : '\u2014'}</b><span>oldest kept</span>
                </div>
              </div>

              {/*
                The split, because "in R2" was until now the stored images only and the
                second copies were invisible — a storage figure that understated by about
                half, which is the worst way for one to be wrong.
              */}
              {usage.original_bytes > 0 && (
                <div className="hint" style={{ marginTop: 10 }}>
                  Of that, <b>{bytes(usage.stored_bytes)}</b> is the stored frames and{' '}
                  <b>{bytes(usage.original_bytes)}</b> is untouched second copies. Turning
                  off <b>Also keep the untouched capture</b> above stops the second copy for
                  frames recorded from then on.
                </div>
              )}
              {usage.unmeasured > 0 && (
                <div className="hint" style={{ marginTop: 6, color: 'var(--warn)' }}>
                  {usage.unmeasured} frame(s) have a second copy from before its size was
                  recorded, so the figure above understates R2 by roughly that many frames&rsquo;
                  worth. They age out with everything else.
                </div>
              )}
              {usage.frames > 0 && usage.oldest && (() => {
                // Projected from what this account has actually stored, not from a guess
                // about typical use: bytes per day so far, times the retention window.
                const days = Math.max(
                  0.25, (Date.now() - Date.parse(usage.oldest)) / 86_400_000,
                );
                const perDay = usage.bytes / days;
                return (
                  <div className="hint" style={{ marginTop: 6 }}>
                    At this rate — {bytes(Math.round(perDay))} a day over the last{' '}
                    {days < 1 ? `${Math.round(days * 24)}h` : `${days.toFixed(1)} days`} — a
                    full {store.retentionDays}-day window settles around{' '}
                    <b>{bytes(Math.round(perDay * store.retentionDays))}</b>.
                  </div>
                );
              })()}
            </>
          ) : (
            <div className="hint">Usage is unavailable right now.</div>
          )}

          <div className="hint" style={{ marginTop: 12 }}>
            These are the counts the server holds, not an estimate from this browser.
            Retention is enforced on the server: a nightly sweep deletes every frame older
            than {store.retentionDays} days, removing the D1 row and the R2 object in the
            same pass so the catalogue and the images can never drift apart. The setting
            below controls playback only; the server\u2019s ceiling is authoritative.
          </div>

          <div className="row" style={{ marginTop: 12 }}>
            <button className="danger" disabled={busy} onClick={async () => {
              if (!confirm('Permanently delete every session, frame and image you have stored? This cannot be undone.')) return;
              setBusy(true);
              try {
                await store.eraseAll();
                onChanged();
              } catch (err) {
                alert(err instanceof Error ? err.message : String(err));
              } finally {
                setBusy(false);
              }
            }}>Erase everything</button>
          </div>
        </div>

        <CloudStatusPanel status={uploads} />

        <AccountPanel
          account={account}
          emailConfigured={emailConfigured}
          onSignedOut={onSignedOut}
          onEraseRecordings={() => store.eraseAll()}
        />

        <div className="panel" style={{ marginTop: 14 }}>
          <h3 style={{ marginTop: 0 }}>Privacy</h3>
          <div className="hint">
            Screen frames are the most sensitive data a machine holds \u2014 passwords, banking,
            private messages, other people\u2019s data in calls. Capture starts only after you
            explicitly pick a screen or window to share, and{' '}
            <b>every frame that survives change detection is uploaded to Cloudflare</b>,
            where it is kept for {store.retentionDays} days and then deleted. Only your
            own device token can read it back; there is no cross-user access path in the
            schema.
            <br /><br />
            Use <b>Pause</b> while recording to stop capture without ending the session, and
            the browser\u2019s own \u201cStop sharing\u201d control to end it entirely.
            <br /><br />
            The browser gives us pixels but not window titles, so an app or site denylist
            cannot be reliable until frame text extraction lands in a later phase.
          </div>
        </div>
      </div>
    </div>
  );
}
