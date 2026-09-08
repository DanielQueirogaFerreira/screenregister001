import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { encodeStamp, type FrameRecord } from '@sr/schema';
import type { CloudStore } from '@sr/storage';
import type { CaptureSessions } from '../capture/sessions.js';
import { bytes, clock, duration } from '../lib/format.js';

/**
 * The tail of what is being recorded right now, with the ability to step back through it.
 *
 * The library is a list of finished sessions, which answers "what did I record" but never
 * "what is it storing at this moment" — and that second question is the one you ask while
 * a recording is running and you want to know it is working. The recorder's own panel
 * shows one frame and replaces it; this keeps the last several so you can step back and
 * look at what just went past.
 *
 * Frames are held only as long as this component is mounted. It is a window onto the live
 * stream, not a second copy of the archive: leaving the tab drops them, and everything
 * durable is in R2 either way.
 */
const KEEP = 24;

interface Held {
  record: FrameRecord;
  url: string;
  sessionKey: string;
}

export function LiveStrip({
  sessions, accountId, onInspect,
}: {
  store: CloudStore;
  sessions: CaptureSessions;
  accountId: string;
  onInspect: (stamp: string) => void;
}) {
  const live = useSyncExternalStore(sessions.subscribe, sessions.getSnapshot);
  const [held, setHeld] = useState<Held[]>([]);
  /** null = follow the newest frame; a number = the user has stepped back and is holding. */
  const [pinned, setPinned] = useState<number | null>(null);
  const seen = useRef(new Set<string>());

  /**
   * The manager already holds one object URL per session for its newest frame and revokes
   * it when the next arrives, so this cannot borrow those — it would be showing a URL that
   * is about to be revoked underneath it. Each frame kept here gets its own copy of the
   * blob, and this component revokes what it created.
   */
  useEffect(() => {
    let cancelled = false;
    for (const s of live) {
      const last = s.last;
      if (!last || seen.current.has(last.record.frame_id)) continue;
      seen.current.add(last.record.frame_id);
      void fetch(last.url)
        .then((r) => r.blob())
        .then((blob) => {
          if (cancelled) return;
          const entry: Held = {
            record: last.record,
            url: URL.createObjectURL(blob),
            sessionKey: s.key,
          };
          setHeld((prev) => {
            const next = [entry, ...prev];
            for (const dropped of next.slice(KEEP)) URL.revokeObjectURL(dropped.url);
            return next.slice(0, KEEP);
          });
        })
        .catch(() => undefined);
    }
    return () => { cancelled = true; };
  }, [live]);

  // Revoke everything this component made when it goes away.
  const heldRef = useRef(held);
  heldRef.current = held;
  useEffect(() => () => {
    for (const h of heldRef.current) URL.revokeObjectURL(h.url);
  }, []);

  const inspect = useCallback((f: FrameRecord) => {
    void encodeStamp({
      frameId: f.frame_id, deviceId: f.device_id, userId: accountId,
    }).then(onInspect);
  }, [accountId, onInspect]);

  if (live.length === 0 && held.length === 0) return null;

  const index = pinned ?? 0;
  const showing = held[index];
  const following = pinned === null;

  return (
    <div className="panel" style={{ marginBottom: 14 }}>
      <div className="row" style={{ marginBottom: 10 }}>
        <span className={`dot ${live.some((s) => !s.paused) ? 'live' : ''}`} />
        <b>Live</b>
        <span style={{ color: 'var(--dim)' }}>
          {live.length > 0
            ? `${live.length} capture${live.length === 1 ? '' : 's'} · last ${held.length} frame${held.length === 1 ? '' : 's'} kept here`
            : 'recording ended — these are the last frames it stored'}
        </span>
        <div className="row" style={{ marginLeft: 'auto' }}>
          <button
            disabled={index >= held.length - 1}
            onClick={() => setPinned(Math.min(held.length - 1, index + 1))}
            title="Step back to the previous stored frame"
          >
            ← Back
          </button>
          <button disabled={index <= 0} onClick={() => setPinned(index - 1 === 0 ? null : index - 1)}>
            Forward →
          </button>
          <button className={following ? 'on' : ''} disabled={following} onClick={() => setPinned(null)}>
            {following ? 'Following live' : 'Follow live'}
          </button>
        </div>
      </div>

      {!showing ? (
        <div className="empty">Waiting for the first stored frame…</div>
      ) : (
        <>
          <div
            className="stage"
            onDoubleClick={() => inspect(showing.record)}
            title="Double-press to inspect this frame"
          >
            <img className="shot" src={showing.url} alt="most recently stored frame" />
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <span className={`tag ${showing.record.reason}`}>{showing.record.reason}</span>
            <span style={{ color: 'var(--dim)' }}>
              {clock(showing.record.captured_at)} · {bytes(showing.record.bytes)} · change{' '}
              {(showing.record.change_score * 100).toFixed(1)}%
              {showing.record.hold_ms !== null && <> · held {duration(showing.record.hold_ms)}</>}
            </span>
            {!following && (
              <span className="tag warn-tag">
                holding · {index === 0 ? 'newest' : `${index} frame${index === 1 ? '' : 's'} back`}
              </span>
            )}
            <button style={{ marginLeft: 'auto' }} onClick={() => inspect(showing.record)}>
              Inspect
            </button>
          </div>

          {/* Thumbnails of what is still held, newest first. */}
          <div className="live-strip">
            {held.map((h, i) => (
              <button
                key={h.record.frame_id}
                className={i === index ? 'on' : ''}
                onClick={() => setPinned(i === 0 ? null : i)}
                title={`${clock(h.record.captured_at)} · ${h.record.reason}`}
              >
                <img src={h.url} alt="" />
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
