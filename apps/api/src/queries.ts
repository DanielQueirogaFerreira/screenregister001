import type { Env } from './types.js';

/**
 * The read layer shared by the MCP tools and the REST routes.
 *
 * Both surfaces answer the same questions and must not drift: an assistant reading over
 * MCP and a script reading over REST should never disagree about what was on screen.
 * Keeping the queries here — and the presentation in the callers — is what guarantees that.
 */

export interface FrameRow {
  frame_id: string;
  session_id: string;
  captured_at: string;
  hold_ms: number | null;
  change_score: number;
  reason: string;
  width: number;
  height: number;
  bytes: number;
  storage_key: string;
}

export interface Scene {
  start_frame_id: string;
  start_at: string;
  end_at: string;
  duration_ms: number;
  frame_count: number;
  peak_change: number;
}

/** A scene opens on a real change; heartbeats assert continuity, not novelty. */
export const SCENE_OPEN_THRESHOLD = 0.02;

export interface TimeWindow { from: string; to: string }

/** Resolve a window from an explicit range or a "last N hours" shorthand. */
export function resolveWindow(a: { last_hours?: number; from?: string; to?: string }): TimeWindow {
  const now = Date.now();
  if (a.from || a.to) {
    return {
      from: a.from ?? new Date(now - 7 * 86_400_000).toISOString(),
      to: a.to ?? new Date(now).toISOString(),
    };
  }
  const hours = a.last_hours ?? 24;
  return { from: new Date(now - hours * 3_600_000).toISOString(), to: new Date(now).toISOString() };
}

export async function listSessions(env: Env, userId: string, w: TimeWindow) {
  const { results } = await env.DB.prepare(
    `SELECT s.*, COUNT(f.frame_id) AS frame_count FROM sessions s
     LEFT JOIN frames f ON f.session_id = s.session_id
     WHERE s.user_id = ? AND s.started_at <= ? AND COALESCE(s.ended_at, s.started_at) >= ?
     GROUP BY s.session_id ORDER BY s.started_at DESC LIMIT 100`,
  ).bind(userId, w.to, w.from).all<Record<string, unknown>>();
  return results;
}

export interface FrameFilter {
  minChange?: number;
  reason?: string;
  limit?: number;
}

export async function listFrames(
  env: Env, userId: string, w: TimeWindow, f: FrameFilter = {},
): Promise<FrameRow[]> {
  const conds = ['user_id = ?', 'captured_at >= ?', 'captured_at <= ?'];
  const binds: unknown[] = [userId, w.from, w.to];
  if (f.minChange !== undefined) { conds.push('change_score >= ?'); binds.push(f.minChange); }
  if (f.reason) { conds.push('reason = ?'); binds.push(f.reason); }

  const { results } = await env.DB.prepare(
    `SELECT frame_id, session_id, captured_at, hold_ms, change_score, reason, width, height,
            bytes, storage_key
     FROM frames WHERE ${conds.join(' AND ')} ORDER BY captured_at ASC LIMIT ?`,
  ).bind(...binds, Math.min(f.limit ?? 100, 5000)).all<FrameRow>();
  return results;
}

/**
 * Collapse frames into scenes — runs where the screen stayed essentially the same.
 *
 * This is what turns eight hours of storage into a few dozen readable lines, and it is
 * the reason an assistant can survey a day without downloading it.
 */
export function buildScenes(frames: FrameRow[], minMs = 5000): { scenes: Scene[]; hidden: number } {
  const all: Scene[] = [];
  for (const f of frames) {
    const opens = all.length === 0 || (f.change_score >= SCENE_OPEN_THRESHOLD && f.reason !== 'heartbeat');
    if (opens) {
      all.push({
        start_frame_id: f.frame_id, start_at: f.captured_at, end_at: f.captured_at,
        duration_ms: f.hold_ms ?? 0, frame_count: 1, peak_change: f.change_score,
      });
    } else {
      const cur = all[all.length - 1]!;
      cur.end_at = f.captured_at;
      cur.duration_ms += f.hold_ms ?? 0;
      cur.frame_count++;
      cur.peak_change = Math.max(cur.peak_change, f.change_score);
    }
  }
  const scenes = all.filter((s) => s.duration_ms >= minMs);
  return { scenes, hidden: all.length - scenes.length };
}
