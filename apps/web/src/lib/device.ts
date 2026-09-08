const DEVICE_KEY = 'sr.device_id';

/**
 * A stable label for this browser, recorded on each session row so the library can show
 * where a recording came from.
 *
 * It is not a credential and grants nothing: ownership comes from the signed-in account,
 * and the server stamps every session and frame with the account's user id regardless of
 * what the client sends. Losing this value costs a label, nothing more.
 */
export function deviceId(): string {
  try {
    let v = localStorage.getItem(DEVICE_KEY);
    if (!v) {
      v = `dev_${crypto.randomUUID()}`;
      localStorage.setItem(DEVICE_KEY, v);
    }
    return v;
  } catch {
    return `dev_${crypto.randomUUID()}`; // private mode: ephemeral label
  }
}
