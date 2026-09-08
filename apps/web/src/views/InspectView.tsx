import { useCallback, useEffect, useState } from 'react';
import { StampError, decodeStamp, stampMatches, type StampParts } from '@sr/schema';
import type { CloudStore } from '@sr/storage';
import { deviceId } from '../lib/device.js';
import { bytes, clock, day, duration } from '../lib/format.js';

interface ResolvedFrame {
  stamp: {
    handle: string;
    captured_at: string;
    device_fingerprint: string;
    account_fingerprint: string;
  };
  frame: {
    frame_id: string; session_id: string; user_id: string; device_id: string;
    captured_at: string; offset_ms: number; seq: number; hold_ms: number | null;
    change_score: number; changed_tiles: number[]; reason: string;
    width: number; height: number; bytes: number; format: string; sha256: string;
    ocr_text: string | null; caption: string | null; enrich_status: string;
  };
  session: {
    session_id: string; device_id: string; started_at: string; ended_at: string | null;
    screen_w: number; screen_h: number; label: string | null;
  } | null;
}

function Row({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="health-row">
      <span className="health-mark" aria-hidden="true" />
      <span className="health-label">{label}</span>
      <span className="health-value" style={mono ? { fontFamily: 'ui-monospace, monospace' } : undefined}>
        {value}
      </span>
    </div>
  );
}

/**
 * Paste a stamp, get the frame back.
 *
 * Two stages, deliberately visible as two. The first needs nothing but the code: the
 * capture time is encoded in the stamp itself and decodes here, offline, before any
 * request is made. The second asks the server for everything the code does not carry.
 *
 * Keeping them apart is the point. If the lookup fails — wrong account, frame past
 * retention, service down — you still know exactly when the frame was taken, which is
 * usually the question. A design that resolved everything server-side would have nothing
 * to say in precisely the cases where the stamp is most useful.
 */
export function InspectView({ store, accountId }: { store: CloudStore; accountId: string }) {
  const [code, setCode] = useState('');
  const [parts, setParts] = useState<StampParts | null>(null);
  const [mine, setMine] = useState<{ device: boolean; account: boolean } | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [result, setResult] = useState<ResolvedFrame | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [image, setImage] = useState<string | null>(null);

  // Decode as the code is typed. No network, no account, no waiting.
  useEffect(() => {
    setResult(null);
    setLookupError(null);
    if (!code.trim()) { setParts(null); setLocalError(null); setMine(null); return; }
    try {
      const p = decodeStamp(code);
      setParts(p);
      setLocalError(null);
      void stampMatches(p, deviceId(), accountId).then(setMine);
    } catch (err) {
      setParts(null);
      setMine(null);
      setLocalError(err instanceof StampError ? err.message : String(err));
    }
  }, [code, accountId]);

  useEffect(() => () => { if (image) URL.revokeObjectURL(image); }, [image]);

  const resolve = useCallback(async () => {
    if (!parts) return;
    setBusy(true);
    setLookupError(null);
    try {
      const res = await fetch(`/v1/frames/stamp/${encodeURIComponent(code.trim())}`, {
        credentials: 'same-origin',
      });
      const body = await res.json() as ResolvedFrame & { error?: string; detail?: string };
      if (!res.ok) throw new Error(body.detail ?? body.error ?? `HTTP ${res.status}`);
      setResult(body);
      const blob = await store.getFullBlob(body.frame.frame_id).catch(() => null);
      setImage((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return blob ? URL.createObjectURL(blob) : null;
      });
    } catch (err) {
      setLookupError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [parts, code, store]);

  const drift = parts ? Date.now() - parts.capturedAtMs : 0;
  const capturedIso = parts ? new Date(parts.capturedAtMs).toISOString() : '';

  return (
    <div className="grid cols">
      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Look up a frame stamp</h3>
        <div className="hint" style={{ marginBottom: 14 }}>
          Every stored frame carries a stamp: when it was captured, on which device, and for
          which account, in one short code. Paste one here.
        </div>

        <div className="field">
          <label htmlFor="stamp">Stamp</label>
          <input
            id="stamp" type="text" value={code} placeholder="SR1-…"
            spellCheck={false} autoCapitalize="off" autoCorrect="off"
            style={{ fontFamily: 'ui-monospace, monospace' }}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && parts) void resolve(); }}
          />
          {localError && <div className="hint" style={{ color: 'var(--bad)' }}>{localError}</div>}
        </div>

        {parts && (
          <>
            <div className="banner info">
              <b>Read from the code alone</b>, with no lookup and no account.
              <div className="health-list" style={{ marginTop: 8 }}>
                <Row label="Captured" value={`${day(capturedIso)} ${clock(capturedIso)}`} />
                <Row
                  label="Age"
                  value={drift < 0
                    ? `${duration(-drift)} in the future — check the clock on the recording device`
                    : `${duration(drift)} ago`}
                />
                <Row label="Frame handle" value={parts.handle} mono />
                <Row label="Device" value={parts.device} mono />
                <Row label="Account" value={parts.account} mono />
              </div>
              {mine && (
                <div className="hint" style={{ marginTop: 8 }}>
                  {mine.device && mine.account
                    ? 'Recorded by this browser, on your account.'
                    : mine.account
                      ? 'Your account, but a different device from this one.'
                      : 'Neither the device nor the account fingerprint matches this browser.'}
                </div>
              )}
            </div>

            <button className="primary" disabled={busy} onClick={() => void resolve()}>
              {busy ? 'Looking up…' : 'Fetch the rest from the server'}
            </button>
          </>
        )}

        {lookupError && <div className="banner bad" style={{ marginTop: 14 }}>{lookupError}</div>}

        {result && (
          <>
            <h3>The frame</h3>
            {image && <img className="shot" src={image} alt="the frame this stamp names" />}
            <div className="health-list" style={{ marginTop: 12 }}>
              <Row label="Frame id" value={result.frame.frame_id} mono />
              <Row label="Captured at" value={result.frame.captured_at} />
              <Row label="Kept because" value={<span className={`tag ${result.frame.reason}`}>{result.frame.reason}</span>} />
              <Row label="Stayed on screen" value={result.frame.hold_ms === null ? 'still open' : duration(result.frame.hold_ms)} />
              <Row label="Change" value={`${(result.frame.change_score * 100).toFixed(1)}% · ${result.frame.changed_tiles.length} tiles`} />
              <Row label="Size" value={`${result.frame.width}×${result.frame.height} · ${bytes(result.frame.bytes)} ${result.frame.format}`} />
              <Row label="Offset in session" value={duration(result.frame.offset_ms)} />
              <Row label="SHA-256" value={<span style={{ wordBreak: 'break-all' }}>{result.frame.sha256}</span>} mono />
              <Row label="Device" value={result.frame.device_id} mono />
              <Row label="Account" value={result.frame.user_id} mono />
              {result.session && (
                <>
                  <Row label="Session" value={result.session.session_id} mono />
                  <Row label="Session started" value={`${day(result.session.started_at)} ${clock(result.session.started_at)}`} />
                  <Row label="Screen" value={`${result.session.screen_w}×${result.session.screen_h}`} />
                </>
              )}
            </div>
          </>
        )}
      </div>

      <div className="panel" style={{ alignSelf: 'start' }}>
        <h3 style={{ marginTop: 0 }}>What a stamp is</h3>
        <div className="hint">
          <p style={{ marginTop: 0 }}>
            <code>SR1-K8Q3M2X7VW1A3F1K-4F2A9C1B</code>
          </p>
          <p>
            The middle group is the frame: ten characters of millisecond time, then six that
            tell apart frames captured in the same millisecond. It decodes with arithmetic —
            that is why the time above appears before anything is fetched.
          </p>
          <p>
            The last group is <b>not</b> reversible. It is a truncated hash of the device and
            of the account, four characters each. ScreenRegister records screens, so anything
            shown while recording ends up stored — a stamp displayed live must not put a
            readable account id inside the archive. A fingerprint is enough to say “same
            device” or “different account” at a glance and carries nothing that identifies
            either.
          </p>
          <p>
            Holding a stamp is not access. The time decodes for anyone; everything below it
            requires the account that owns the frame, and a stamp naming someone else’s
            recording answers exactly as one naming nothing at all.
          </p>
          <p style={{ marginBottom: 0 }}>
            Frames are kept for {store.retentionDays} days. After that a stamp still decodes
            its own timestamp, and the lookup returns nothing — which is the correct answer.
          </p>
        </div>
      </div>
    </div>
  );
}
