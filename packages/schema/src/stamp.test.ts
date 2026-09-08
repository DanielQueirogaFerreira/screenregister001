import { describe, expect, it } from 'vitest';
import {
  HANDLE_LEN, STAMP_VERSION, StampError, decodeStamp, encodeStamp, fingerprint, handleMatches,
  handleTimeRange, stampMatches,
} from './stamp.js';
import { ulid, ulidTime } from './ulid.js';

const DEVICE = 'dev_2f1e0c44-9b3a-4d21-8f77-0a1b2c3d4e5f';
const ACCOUNT = 'usr_01J8XK3';

describe('frame stamps', () => {
  it('decodes the capture time with no lookup at all', async () => {
    // This is the property that makes a stamp a verification tool rather than an opaque
    // key: anyone holding one can check it against when they think something happened.
    const at = Date.UTC(2026, 8, 8, 2, 15, 30, 123);
    const code = await encodeStamp({ frameId: ulid(at), deviceId: DEVICE, userId: ACCOUNT });
    expect(decodeStamp(code).capturedAtMs).toBe(at);
  });

  it('never carries the identifiers it fingerprints', async () => {
    // A stamp is displayed while recording, so anything inside it lands in the archive.
    const code = await encodeStamp({ frameId: ulid(), deviceId: DEVICE, userId: ACCOUNT });
    expect(code).not.toContain(DEVICE);
    expect(code).not.toContain(ACCOUNT);
    expect(code.toUpperCase()).not.toContain('2F1E0C44');
  });

  it('stays short enough to read off a screen', async () => {
    const code = await encodeStamp({ frameId: ulid(), deviceId: DEVICE, userId: ACCOUNT });
    expect(code.length).toBeLessThanOrEqual(30);
    expect(code.startsWith(`${STAMP_VERSION}-`)).toBe(true);
  });

  it('separates the device and account domains', async () => {
    // Without domain separation a device id equal to a user id would fingerprint the same,
    // and "same device" and "same account" would stop being distinct claims.
    const same = 'identical-value';
    expect(await fingerprint('device', same)).not.toBe(await fingerprint('account', same));
  });

  it('confirms provenance without revealing it', async () => {
    const code = await encodeStamp({ frameId: ulid(), deviceId: DEVICE, userId: ACCOUNT });
    const parts = decodeStamp(code);
    expect(await stampMatches(parts, DEVICE, ACCOUNT)).toEqual({ device: true, account: true });
    expect(await stampMatches(parts, 'other-device', ACCOUNT))
      .toEqual({ device: false, account: true });
    expect(await stampMatches(parts, DEVICE, 'other-account'))
      .toEqual({ device: true, account: false });
  });

  it('gives a handle that resolves back to the frame it came from', async () => {
    const frameId = ulid();
    const code = await encodeStamp({ frameId, deviceId: DEVICE, userId: ACCOUNT });
    const { handle } = decodeStamp(code);
    expect(handle).toHaveLength(HANDLE_LEN);
    expect(handleMatches(handle, frameId)).toBe(true);
    expect(handleMatches(handle, ulid())).toBe(false);
    // The lookup range covers the frame's own id and stops before the next millisecond.
    const { from, to } = handleTimeRange(handle);
    expect(frameId >= from && frameId < to).toBe(true);
  });

  it('forgives the ways a code gets mistyped', async () => {
    const code = await encodeStamp({ frameId: ulid(), deviceId: DEVICE, userId: ACCOUNT });
    expect(decodeStamp(`  ${code.toLowerCase()} `)).toEqual(decodeStamp(code));
    // Crockford leaves I, L and O out of the alphabet precisely because people type them
    // for 1 and 0. Substituting them back is the whole reason for that choice.
    expect(decodeStamp(code.replace(/1/g, 'I'))).toEqual(decodeStamp(code));
    expect(decodeStamp(code.replace(/0/g, 'O'))).toEqual(decodeStamp(code));
  });

  it('says what is wrong, rather than just refusing', () => {
    expect(() => decodeStamp('hello')).toThrow(StampError);
    expect(() => decodeStamp('hello')).toThrow(/starts with SR1-/);
    expect(() => decodeStamp('SR9-K8Q3M2X7VW1A3F-4F2A9C1B')).toThrow(/this build reads SR1/);
    expect(() => decodeStamp('SR1-TOOSHORT-4F2A9C1B')).toThrow(/characters in total/);
  });

  it('orders by time, like the ULIDs it is cut from', async () => {
    const earlier = await encodeStamp({
      frameId: ulid(1_700_000_000_000), deviceId: DEVICE, userId: ACCOUNT,
    });
    const later = await encodeStamp({
      frameId: ulid(1_700_000_005_000), deviceId: DEVICE, userId: ACCOUNT,
    });
    expect(earlier < later).toBe(true);
    expect(ulidTime(decodeStamp(earlier).handle))
      .toBeLessThan(ulidTime(decodeStamp(later).handle));
  });

  it('distinguishes two frames captured in the same millisecond', async () => {
    // ULIDs minted in one millisecond do not re-randomise; they increment the tail of the
    // random block. A handle cut from the front of the ULID was identical for both, which
    // is a collision in the field whose entire job is to identify a frame.
    const at = Date.now();
    const first = ulid(at);
    const second = ulid(at);
    expect(first.slice(0, 16)).toBe(second.slice(0, 16));  // the trap

    const a = await encodeStamp({ frameId: first, deviceId: DEVICE, userId: ACCOUNT });
    const b = await encodeStamp({ frameId: second, deviceId: DEVICE, userId: ACCOUNT });
    expect(a).not.toBe(b);
    expect(decodeStamp(a).capturedAtMs).toBe(decodeStamp(b).capturedAtMs);
    expect(handleMatches(decodeStamp(a).handle, first)).toBe(true);
    expect(handleMatches(decodeStamp(a).handle, second)).toBe(false);
  });
});
