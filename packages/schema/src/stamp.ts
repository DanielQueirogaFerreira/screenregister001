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
 *     SR1-K8Q3M2X7VW1A3F1K-4F2A9C1B
 *     ^^^ ^^^^^^^^^^^^^^^^ ^^^^^^^^
 *     |   |                └ device (4) and account (4) fingerprints
 *     |   └ 10 chars of millisecond time, then the ULID's last 6 characters
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
 * How much of the frame's ULID the stamp carries.
 *
 * The entropy is taken from the END of the ULID, not the start. Frames minted in the same
 * millisecond do not re-randomise — `bumpRandom` increments the random block from its last
 * character — so consecutive frames in one millisecond share every leading character and
 * differ only in the tail. Cutting from the front produced identical handles for different
 * frames, which is a collision in the one field that has to identify a frame.
 *
 * The cost is that the handle is no longer a plain prefix of the ULID. Lookups take the
 * 10-character time as an indexed range and match the 6-character tail within it, which is
 * at most a handful of rows: capture tops out at 30 frames a second.
 */
const TIME_LEN = 10;
const ENTROPY_LEN = 6;
export const HANDLE_LEN = TIME_LEN + ENTROPY_LEN;
/** Characters per fingerprint: 4 x 5 bits = 20 bits. */
const FINGERPRINT_LEN = 4;

export interface StampParts {
  /** Milliseconds since the epoch, decoded from the code itself. */
  capturedAtMs: number;
  /** Identifies the frame: the ULID's 10-char time followed by its last 6 characters. */
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

/** The stamp's view of a frame id: leading time, trailing entropy. */
export function handleFor(frameId: string): string {
  return frameId.slice(0, TIME_LEN) + frameId.slice(-ENTROPY_LEN);
}

/** Whether a full frame id is the one a handle refers to. */
export function handleMatches(handle: string, frameId: string): boolean {
  return handleFor(frameId) === handle;
}

/** The half-open ULID range a handle's millisecond covers, for an indexed lookup. */
export function handleTimeRange(handle: string): { from: string; to: string } {
  const time = handle.slice(0, TIME_LEN);
  return { from: time, to: `${time}\uffff` };
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
