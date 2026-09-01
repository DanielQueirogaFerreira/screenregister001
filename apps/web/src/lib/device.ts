const DEVICE_KEY = 'sr.device_id';
const USER_KEY = 'sr.user_id';

function stable(key: string, prefix: string): string {
  let v = localStorage.getItem(key);
  if (!v) {
    v = `${prefix}_${crypto.randomUUID()}`;
    localStorage.setItem(key, v);
  }
  return v;
}

/**
 * Anonymous identity for the prototype. Every frame carries a user_id from day one so
 * that real accounts drop in later as a change of how this value is obtained, not as a
 * schema migration.
 */
export const deviceId = (): string => stable(DEVICE_KEY, 'dev');
export const userId = (): string => stable(USER_KEY, 'usr');
