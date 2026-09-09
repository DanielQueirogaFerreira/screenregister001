import type { Env } from './types.js';

/**
 * Delete every object belonging to a frame, from its stored-image key alone.
 *
 * All three variants are derived here rather than read from the row, so a caller cannot
 * forget one. That matters most for the original: it is optional, so nothing would
 * complain if it were left behind — it would simply sit in R2 after its frame was deleted
 * and after the retention window had closed on it, which is the one thing a seven-day
 * promise cannot survive. Deleting a key that does not exist is a no-op, so asking for all
 * three unconditionally is both correct and cheaper than looking up which exist.
 */
export function variantKeys(storageKey: string): string[] {
  return [storageKey, storageKey.replace(/^f\//, 't/'), storageKey.replace(/^f\//, 'o/')];
}

export async function deleteObjects(env: Env, keys: string[]): Promise<void> {
  const all = keys.flatMap(variantKeys);
  // R2 caps a bulk delete at 1000 keys per call.
  for (let i = 0; i < all.length; i += 1000) await env.FRAMES.delete(all.slice(i, i + 1000));
}

/**
 * Retention sweep. The blobs and the catalogue rows are deleted in the same pass so the
 * two never drift apart — an R2 lifecycle rule would expire objects on its own schedule
 * and leave rows pointing at nothing.
 */
/**
 * Delete every frame matching one predicate — the blobs and the catalogue rows together.
 *
 * The single place frames are deleted, because there are three reasons to delete them
 * (retention, an account erasing its own history, an operator removing an account) and
 * they were three copies of the same loop carrying the same bug.
 *
 * D1 refuses a query with more than 100 bound parameters — "too many SQL variables" — and
 * the row delete binds one per frame. All three copies selected 500 and bound 500, so the
 * delete threw every time, AFTER the objects for the batch had been deleted: 500 images
 * destroyed and 500 rows left pointing at nothing, per attempt. In the sweep nothing
 * surfaced it, because retention had never yet found an expired frame to delete. On
 * `DELETE /v1/data` it would have surfaced as "deleting your history failed" to a caller
 * whose history was already half gone.
 *
 * 90 leaves room under the limit and keeps a failure cheap in the order these two deletes
 * have to happen: objects first, because a row deleted before its object orphans that
 * object with nothing left to name it, while an object deleted before its row leaves a row
 * a retry will clear. There is no transaction spanning R2 and D1, so a small window is the
 * best available trade rather than something that can be closed.
 *
 * `where` is interpolated, so it must stay a literal written here. Every value that comes
 * from a request travels in `binds`.
 */
export const FRAME_BATCH = 90;

export async function deleteFramesWhere(
  env: Env, where: string, binds: unknown[], maxBatches = Number.POSITIVE_INFINITY,
): Promise<number> {
  const BATCH = FRAME_BATCH;
  let total = 0;

  for (let i = 0; i < maxBatches; i++) {
    const { results } = await env.DB.prepare(
      `SELECT frame_id, storage_key FROM frames WHERE ${where} LIMIT ${BATCH}`,
    ).bind(...binds).all<{ frame_id: string; storage_key: string }>();
    if (results.length === 0) break;

    await deleteObjects(env, results.map((r) => r.storage_key));
    await env.DB.prepare(
      `DELETE FROM frames WHERE frame_id IN (${results.map(() => '?').join(',')})`,
    ).bind(...results.map((r) => r.frame_id)).run();
    total += results.length;
  }
  return total;
}

