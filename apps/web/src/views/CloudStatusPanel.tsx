import type { UploadStatus } from '@sr/storage';
import { bytes } from '../lib/format.js';

interface Props {
  status: UploadStatus | null;
}

const LABEL: Record<UploadStatus['state'], string> = {
  idle: 'All captured frames are stored in Cloudflare',
  uploading: 'Uploading…',
  retrying: 'Retrying a failed upload…',
  saturated: 'Uploads are behind — capture is paused',
  error: 'Uploads have stopped',
};

/**
 * Upload status, not configuration.
 *
 * There is nothing to configure: the Worker serves this page, so the API is the origin it
 * was loaded from. The panel that used to ask for a URL and an opt-in switch is gone —
 * both implied the cloud was optional, and it is where recordings live.
 */
export function CloudStatusPanel({ status }: Props) {
  return (
    <div className="panel" style={{ marginTop: 14 }}>
      <h3 style={{ marginTop: 0 }}>Cloud storage</h3>

      <div className="hint">
        Recordings are stored in <b>Cloudflare</b> — frame images in R2, and the session
        timeline, timestamps, hashes and change scores in D1. The API is on this same
        origin, so there is no address to enter and no connection to switch on.
      </div>

      {status && (
        <>
          <div className="stats" style={{ marginTop: 14 }}>
            <div className="stat"><b>{status.uploaded}</b><span>uploaded</span></div>
            <div className="stat"><b>{status.queued}</b><span>waiting</span></div>
            <div className="stat"><b>{status.dropped}</b><span>lost</span></div>
            <div className="stat"><b>{bytes(status.bytesQueued)}</b><span>in memory</span></div>
          </div>
          <div className="hint" style={{ marginTop: 8 }}>
            {LABEL[status.state]}
            {status.lastUploadAt &&
              ` · last upload ${new Date(status.lastUploadAt).toLocaleTimeString()}`}
          </div>
          {status.lastError && (
            <div className="banner bad" style={{ marginTop: 10 }}>{status.lastError}</div>
          )}
        </>
      )}

      <div className="hint" style={{ marginTop: 12 }}>
        A frame is sent once its duration is known — when the next frame is captured, or the
        session ends — so each one is uploaded exactly once, complete. Frames wait in memory
        only for that moment and for the upload itself; the queue is capped by count, size
        and age, and capture pauses rather than letting a backlog grow. Frames average
        around {bytes(110 * 1024)}.
      </div>
    </div>
  );
}
