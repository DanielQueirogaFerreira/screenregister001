/**
 * Minimal monotonic ULID.
 *
 * Frame IDs are the public, LLM-facing handle for a moment in time, so they must
 * sort lexicographically by capture time — an LLM asking for "frames after X" can
 * then use a plain string comparison, and D1/IndexedDB range scans work without a
 * secondary index. UUIDv4 would not give us that.
 */
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32
const TIME_LEN = 10;
const RAND_LEN = 16;

let lastTime = -1;
let lastRandom: number[] = [];

function randomChars(n: number): number[] {
  const out = new Array<number>(n);
  const bytes = new Uint8Array(n);
  globalThis.crypto.getRandomValues(bytes);
  for (let i = 0; i < n; i++) out[i] = bytes[i]! % 32;
  return out;
}

function encodeTime(now: number): string {
  let out = '';
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    out = ENCODING[now % 32]! + out;
    now = Math.floor(now / 32);
  }
  return out;
}

/** Increment the random half in place so IDs minted in the same millisecond still ascend. */
function bumpRandom(prev: number[]): number[] {
  const next = prev.slice();
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i]! < 31) {
      next[i] = next[i]! + 1;
      return next;
    }
    next[i] = 0;
  }
  return randomChars(RAND_LEN); // overflowed a full 16-char space; astronomically unlikely
}

export function ulid(nowMs: number = Date.now()): string {
  // Callers derive timestamps from performance.now(), which is fractional. A fractional
  // value indexes ENCODING at a non-integer and splices the string "undefined" into the
  // ID — malformed, and no longer collision-safe. Floor before encoding.
  const now = Math.floor(nowMs);
  if (now === lastTime) {
    lastRandom = bumpRandom(lastRandom);
  } else {
    lastTime = now;
    lastRandom = randomChars(RAND_LEN);
  }
  return encodeTime(now) + lastRandom.map((c) => ENCODING[c]!).join('');
}

/** Recover the millisecond timestamp encoded in a ULID's first 10 characters. */
export function ulidTime(id: string): number {
  let t = 0;
  for (let i = 0; i < TIME_LEN; i++) t = t * 32 + ENCODING.indexOf(id[i]!);
  return t;
}
