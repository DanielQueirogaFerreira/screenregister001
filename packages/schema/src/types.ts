/** Why the timeline processor decided to keep a frame. */
export type StoreReason =
  | 'first'         // first frame of the session
  | 'scene_change'  // changed and was already stable
  | 'settled'       // changed, then motion stopped — this is the stable representative
  | 'burst'         // sustained motion, emitted under the rate cap
  | 'heartbeat'     // nothing changed, but we assert "still showing this" periodically
  | 'final';        // last frame before the session stopped

export interface FrameRecord {
  frame_id: string;      // ULID — sorts by time; the handle an LLM uses
  session_id: string;
  user_id: string;
  captured_at: string;   // ISO-8601 UTC
  offset_ms: number;     // monotonic offset from session start; immune to wall-clock jumps
  seq: number;
  /**
   * How long this frame stayed on screen, i.e. until the next stored frame.
   * A screen that sat still for an hour is ONE row with hold_ms = 3_600_000.
   * This single field is what lets the player, the API and the LLM all skip
   * dead time without reconstructing it independently.
   * Null while the frame is still the live one ("open").
   */
  hold_ms: number | null;
  change_score: number;    // 0..1 — fraction of grid tiles that moved
  changed_tiles: number[]; // which tiles moved; a cheap activity heatmap
  reason: StoreReason;
  width: number;
  height: number;
  bytes: number;
  format: 'image/webp' | 'image/jpeg';
  sha256: string;

  // --- Enrichment: columns exist from day one, populated in a later phase. ---
  ocr_text: string | null;
  caption: string | null;
  enrich_status: 'pending' | 'done' | 'skipped';
}

export interface SessionRecord {
  session_id: string;
  user_id: string;
  device_id: string;
  started_at: string;
  ended_at: string | null;
  capture_fps: number;
  sensitivity: number;
  screen_w: number;
  screen_h: number;
  frames_stored: number;
  frames_skipped: number;
  bytes_stored: number;
  label: string | null;
}

/** A contiguous run of low-change frames — what an LLM should see instead of 400 near-identical stills. */
export interface Scene {
  scene_id: string;
  session_id: string;
  start_frame_id: string;
  start_at: string;
  end_at: string;
  duration_ms: number;
  frame_count: number;
  representative_frame_id: string;
}
