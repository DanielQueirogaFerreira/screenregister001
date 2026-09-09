import { ulidTime } from './ulid.js';

/**
 * The frame stamp: one short code carrying when a frame was taken, on what device, and
 * for which account.
 *
 * Every frame already has a ULID, which is time-sortable and is the LLM-facing handle. But
 * a ULID answers only "when" — "which machine" and "whose account" required a join, so a
 * frame quoted on its own could not be placed. The stamp is the frame's identity as a
 * single value you can read off a screen, write down, and hand back to get everything else.
 *
 *     SR1-01M1ZF6SKE93Z3RRC90ZXTMTT9-4F2A9C1B
 *     ^^^ ^^^^^^^^^^^^^^^^^^^^^^^^^^ ^^^^^^^^
 *     |   |                          └ device (4) and account (4) fingerprints
 *     |   └ the frame's id, entire and unaltered
 *     └ format version, so a decoder can refuse a code it does not understand
 *
 * Two properties matter, and they pull in opposite directions:
 *
 * The time decodes offline. No lookup, no network, no account — paste a stamp and you know
 * the millisecond it was captured. That is what makes it a verification tool rather than
 * an opaque key: a client can compare the stamp on a frame against its own clock and show
 * the delta, and anyone holding a code can check it against when they think something
 * happened.
 *
 * The identities do not decode, ever. They are truncated SHA-256, one way by construction.
 * This is not laziness about a reversible encoding — it is the point. ScreenRegister
 * records screens, so anything displayed while recording is captured and stored, and a
 * stamp shown live would put a plaintext account id inside the archive and inside every
 * screenshot anyone takes of it. A fingerprint lets you confirm "same device" and "same
 * account" by eye across two frames while carrying nothing that identifies either.
 *
 * Twenty bits per fingerprint is deliberately small. It is enough to tell one of a
 * person's handful of devices from another at a glance, and far too little to enumerate
 * users from — reversing one yields about a million candidates and no way to choose.
 */

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32, as ULID uses
export const STAMP_VERSION = 'SR1';

/**
 * The stamp carries the frame's id whole.
 *
 * It carried an abbreviation first, and that was wrong twice over. The first attempt took
 * the ULID's leading 16 characters, which collide: frames minted in the same millisecond
 * do not re-randomise — `bumpRandom` increments the random block from its last character —
 * so consecutive frames shared every leading character. The fix, taking the time plus the
 * final six characters, was unique but unreadable: it silently drops characters 11 to 20,
 * so `01M1ZF6SKE93Z3RRC90ZXTMTT9` abbreviates to `01M1ZF6SKEXTMTT9` and no person can see
 * that those are the same frame. A stamp shown beside a frame id that looks unrelated to it
 * is worse than no stamp, because the natural conclusion is that one of them is wrong.
 *
 * Ten more characters buys: an identifier anyone can check against the library at a glance,
 * a lookup that is a primary-key hit rather than a range scan, and no collision to reason
 * about at all. The stamp is still one line, still selectable, still typed in one go.
 */
const ULID_LEN = 26;
export const HANDLE_LEN = ULID_LEN;
/** Characters per fingerprint: 4 x 5 bits = 20 bits. */
const FINGERPRINT_LEN = 4;

export interface StampParts {
  /** Milliseconds since the epoch, decoded from the code itself. */
  capturedAtMs: number;
  /** The frame id, exactly as the library and the API show it. */
  handle: string;
  device: string;
  account: string;
}

const enc = new TextEncoder();

/**
 * A short, stable, non-reversible label for an arbitrary string.
 *
 * Domain-separated so the same device id and account id cannot produce the same
 * fingerprint — without the prefix, a device whose id happened to equal a user id would
 * stamp identically, and "same device" and "same account" would stop being distinct claims.
 */
export async function fingerprint(kind: 'device' | 'account', value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', enc.encode(`sr.stamp.${kind}:${value}`)),
  );
  let out = '';
  // 4 characters, 5 bits each, taken from the leading 20 bits of the digest.
  let bits = 0;
  let acc = 0;
  for (let i = 0; out.length < FINGERPRINT_LEN; i++) {
    acc = (acc << 8) | digest[i]!;
    bits += 8;
    while (bits >= 5 && out.length < FINGERPRINT_LEN) {
      bits -= 5;
      out += ENCODING[(acc >> bits) & 31]!;
    }
  }
  return out;
}

/** The stamp's view of a frame id, which is now simply the id. */
export function handleFor(frameId: string): string {
  return frameId;
}

/** Whether a full frame id is the one a handle refers to. */
export function handleMatches(handle: string, frameId: string): boolean {
  return handle === frameId;
}

export async function encodeStamp(input: {
  frameId: string;
  deviceId: string;
  userId: string;
}): Promise<string> {
  const [device, account] = await Promise.all([
    fingerprint('device', input.deviceId),
    fingerprint('account', input.userId),
  ]);
  return `${STAMP_VERSION}-${handleFor(input.frameId)}-${device}${account}`;
}

/** Loose enough to accept a code typed in lower case or with spaces around it. */
const SHAPE = new RegExp(
  `^${STAMP_VERSION}-([${ENCODING}]{${HANDLE_LEN}})-([${ENCODING}]{${FINGERPRINT_LEN * 2}})$`,
);

export class StampError extends Error {}

/**
 * Read a stamp without asking anything else. Throws with a reason a person can act on,
 * because this is what a paste-a-code box calls and "invalid" is not a useful answer.
 */
export function decodeStamp(code: string): StampParts {
  const clean = code.trim().toUpperCase()
    // Crockford's own substitutions: these characters are excluded from the alphabet
    // precisely because they are the ones people mistype for 1 and 0.
    .replace(/[IL]/g, '1').replace(/O/g, '0')
    .replace(/\s+/g, '');

  if (!clean.startsWith(`${STAMP_VERSION}-`)) {
    const version = clean.split('-')[0];
    throw new StampError(
      version && /^SR\d+$/.test(version)
        ? `This is a ${version} stamp; this build reads ${STAMP_VERSION}.`
        : `A frame stamp starts with ${STAMP_VERSION}-. Check you copied the whole code.`,
    );
  }

  const m = SHAPE.exec(clean);
  if (!m) {
    throw new StampError(
      `A frame stamp is ${STAMP_VERSION}-, then ${HANDLE_LEN} characters, then ` +
      `${FINGERPRINT_LEN * 2}. Got ${clean.length} characters in total.`,
    );
  }

  const handle = m[1]!;
  const capturedAtMs = ulidTime(handle);
  if (!Number.isFinite(capturedAtMs) || capturedAtMs <= 0) {
    throw new StampError('The time in this stamp does not decode. It may be corrupted.');
  }

  return {
    capturedAtMs,
    handle,
    device: m[2]!.slice(0, FINGERPRINT_LEN),
    account: m[2]!.slice(FINGERPRINT_LEN),
  };
}

/** Whether a stamp was minted by this device and account, without revealing either. */
export async function stampMatches(
  parts: StampParts, deviceId: string, userId: string,
): Promise<{ device: boolean; account: boolean }> {
  const [device, account] = await Promise.all([
    fingerprint('device', deviceId),
    fingerprint('account', userId),
  ]);
  return { device: parts.device === device, account: parts.account === account };
}

/**
 * A UTC offset written the way people write one: UTC-4, UTC+5:30, plain UTC at zero.
 *
 * Takes exactly what `Date.prototype.getTimezoneOffset` returns, which is minutes *behind*
 * UTC — the reverse of the conventional sign. A machine in UTC-3 reports +180. Inverting
 * that is the whole subtlety, and getting it backwards produces a label that is wrong by
 * twice the offset while looking entirely plausible.
 *
 * Not every zone is a whole number of hours: India is +5:30, Nepal +5:45, Newfoundland
 * -3:30. Truncating to hours would mislabel them.
 *
 * It lives beside the stamp because the stamp is now what carries it. The frame's ISO
 * timestamp already says the instant in UTC to the millisecond; the offset says where the
 * person was standing when it happened, and that is the part no amount of arithmetic can
 * recover from the image later.
 */
export function formatUtcOffset(minutesBehindUtc: number): string {
  const minutes = -minutesBehindUtc;
  if (minutes === 0) return 'UTC';
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return m === 0 ? `UTC${sign}${h}` : `UTC${sign}${h}:${String(m).padStart(2, '0')}`;
}

/**
 * The offset in force at a given moment, not the one in force now.
 *
 * Daylight saving means a frame captured in July and one captured in December do not share
 * an offset, so the label has to be computed against the instant it describes rather than
 * against the clock at the time of asking.
 */
export const utcOffset = (at: Date = new Date()): string =>
  formatUtcOffset(at.getTimezoneOffset());

/**
 * The second line burned into a stored frame: the exact instant, in UTC, to the
 * millisecond, followed by the offset the recording device was on.
 *
 * Both halves are needed and neither substitutes for the other. UTC alone is unambiguous
 * but says nothing about whether this was the middle of someone's working day or three in
 * the morning. A local time alone is readable but meaningless once the image has left the
 * machine that made it. Together they are a complete statement that survives export.
 */
export function stampTimeLine(capturedMs: number, minutesBehindUtc: number): string {
  return `${new Date(capturedMs).toISOString()} ${formatUtcOffset(minutesBehindUtc)}`;
}

/**
 * The wall-clock time a frame was captured, as the clock on that machine read it.
 *
 * `getTimezoneOffset` counts minutes *behind* UTC, so local = UTC − offset: a machine on
 * UTC-4 reports +240, and 05:12Z was 01:12 there. Getting that subtraction backwards
 * produces a time wrong by twice the offset that still looks like a plausible time of day,
 * which is why this is a named function with a test rather than arithmetic inline in a
 * view.
 *
 * Rendered without a zone suffix because it is deliberately not an instant — the caller
 * pairs it with `formatUtcOffset` to say which clock it was read from.
 */
export function localWallClock(capturedIso: string, minutesBehindUtc: number): string {
  const local = Date.parse(capturedIso) - minutesBehindUtc * 60_000;
  return new Date(local).toISOString().replace('T', ' ').replace('Z', '');
}
