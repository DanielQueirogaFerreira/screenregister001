import { useEffect, useRef, useState } from 'react';
import { coveredFraction, normaliseZone, type Zone } from '@sr/core';

/**
 * Draw the rectangles that are never captured.
 *
 * Two things make this usable rather than merely present.
 *
 * **You draw on a picture of your own screen.** A grey box is not a screen: nobody can say
 * where their password manager opens as a pair of fractions, and a zone placed by guesswork
 * is worse than none, because it looks configured. The snapshot is taken with the same
 * `getDisplayMedia` prompt the recorder uses, held in this tab as a blob URL, and revoked
 * when the editor closes. It is never encoded for storage and never uploaded — it exists
 * only so the black box lands where you meant it to.
 *
 * **Coordinates are fractions.** The snapshot may be 1920 wide and the recording 1366; the
 * zone is stored as a share of the frame, so it covers the same part of the screen either
 * way. See zones.ts in @sr/core.
 */

interface Props {
  zones: Zone[];
  onChange: (zones: Zone[]) => void;
}

interface Draft { x: number; y: number; w: number; h: number }

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

/** Grab one frame of the screen, then stop the track immediately. */
async function snapshot(): Promise<string> {
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  try {
    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    await video.play();
    // One rAF after play() — the first frame is not necessarily painted when play resolves,
    // and a black snapshot is indistinguishable from a failed one.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const c = document.createElement('canvas');
    c.width = video.videoWidth || 1920;
    c.height = video.videoHeight || 1080;
    c.getContext('2d')!.drawImage(video, 0, 0, c.width, c.height);
    video.srcObject = null;
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/webp', 0.8));
    if (!blob) throw new Error('could not read the screen');
    return URL.createObjectURL(blob);
  } finally {
    // Whatever happened above, stop sharing. Leaving a live capture running behind a
    // settings page is exactly the surprise this whole feature exists to prevent.
    for (const t of stream.getTracks()) t.stop();
  }
}

export function ZoneEditor({ zones, onChange }: Props) {
  const surface = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [shot, setShot] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Revoke on unmount, so leaving the tab open on another view does not keep a picture of
  // the screen alive in this process indefinitely.
  useEffect(() => () => { if (shot) URL.revokeObjectURL(shot); }, [shot]);

  const at = (e: React.PointerEvent): { x: number; y: number } => {
    const r = surface.current!.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    };
  };

  const down = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = at(e);
    setDraft({ x: p.x, y: p.y, w: 0, h: 0 });
  };

  const move = (e: React.PointerEvent) => {
    if (!draft) return;
    const p = at(e);
    setDraft({ ...draft, w: p.x - draft.x, h: p.y - draft.y });
  };

  const up = () => {
    if (!draft) return;
    const z = normaliseZone({ id: crypto.randomUUID(), label: `Zone ${zones.length + 1}`, ...draft });
    setDraft(null);
    // A click without a drag is a click, not a zone. Below this the rectangle would be an
    // invisible speck on every frame and a list entry nobody can find again.
    if (z.w >= 0.001 && z.h >= 0.001) onChange([...zones, z]);
  };

  const grab = async () => {
    setBusy(true);
    setError(null);
    try {
      const url = await snapshot();
      setShot((old) => { if (old) URL.revokeObjectURL(old); return url; });
    } catch (err) {
      // Cancelling the share prompt is the common case and is not a failure worth shouting
      // about — the editor still works, just without a backdrop.
      const m = err instanceof Error ? err.message : String(err);
      setError(/denied|dismissed|abort/i.test(m) ? null : m);
    } finally {
      setBusy(false);
    }
  };

  const shown = draft
    ? [...zones, { ...normaliseZone({ id: '__draft', label: '', ...draft }), id: '__draft' }]
    : zones;
  const covered = coveredFraction(zones);

  return (
    <div className="field">
      <div className="row" style={{ marginBottom: 8 }}>
        <button onClick={grab} disabled={busy}>
          {busy ? 'Waiting for the share prompt…' : shot ? 'Take another snapshot' : 'Show my screen'}
        </button>
        {zones.length > 0 && (
          <button className="danger" onClick={() => onChange([])}>Clear all</button>
        )}
        <span className="hint" style={{ margin: 0 }}>
          {zones.length === 0
            ? 'Drag on the box below to mark an area.'
            : `${zones.length} zone${zones.length > 1 ? 's' : ''} · ${pct(covered)} of the screen hidden`}
        </span>
      </div>

      {error && <div className="banner bad">{error}</div>}
      {covered > 0.6 && (
        <div className="banner warn">
          These zones hide {pct(covered)} of the screen. That is allowed, but most of what
          you record will be black — check that is what you meant.
        </div>
      )}

      <div
        ref={surface}
        className="zones"
        style={shot ? { backgroundImage: `url(${shot})` } : undefined}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={() => setDraft(null)}
      >
        {!shot && (
          <div className="zones-empty">
            Drag here to mark an area, or take a snapshot of your screen first so you can
            see what you are covering.
          </div>
        )}
        {shown.map((z) => (
          <div
            key={z.id}
            className={z.id === '__draft' ? 'zone draft' : 'zone'}
            style={{ left: pct(z.x), top: pct(z.y), width: pct(z.w), height: pct(z.h) }}
          >
            {z.id !== '__draft' && (
              <button
                className="zone-x"
                title={`Remove ${z.label}`}
                // The surface below is listening for a drag; without this, removing a zone
                // starts drawing a new one on top of where it was.
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => onChange(zones.filter((o) => o.id !== z.id))}
              >
                ×
              </button>
            )}
          </div>
        ))}
      </div>

      {zones.length > 0 && (
        <div className="zone-list">
          {zones.map((z) => (
            <div className="row" key={z.id}>
              <input
                type="text"
                value={z.label}
                aria-label="Zone name"
                onChange={(e) =>
                  onChange(zones.map((o) => (o.id === z.id ? { ...o, label: e.target.value } : o)))}
              />
              <span className="hint" style={{ margin: 0, whiteSpace: 'nowrap' }}>
                {pct(z.w)} × {pct(z.h)}
              </span>
              <button onClick={() => onChange(zones.filter((o) => o.id !== z.id))}>Remove</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
