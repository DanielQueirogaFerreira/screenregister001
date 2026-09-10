/**
 * Every part of the system, and the number it answers to.
 *
 * An area id is for the moment someone is describing what they are looking at to somebody
 * who cannot see it — a bug report, a support message, a note to a colleague. "The
 * recorder" and "the record screen" and "the capture page" are three names for one place;
 * 101 is not.
 *
 * The scheme is deliberate rather than sequential, because a sequence carries no
 * information beyond order:
 *
 *   1xx  capture and review — what an account does with its own recordings
 *   2xx  the account itself — access, identity, settings
 *   3xx  operating the platform for other people
 *   4xx  instrumentation — the pages that describe the system rather than use it
 *
 * 401 was assigned first, on the codebase navigator, and keeps its number. Everything else is
 * arranged around it.
 */

export interface Area {
  id: string;
  /** What this place is, in the words someone would use out loud. */
  name: string;
}

export const AREAS = {
  record: { id: '101', name: 'recorder' },
  library: { id: '102', name: 'library' },
  player: { id: '103', name: 'player' },
  inspect: { id: '104', name: 'inspector' },
  settings: { id: '201', name: 'settings' },
  auth: { id: '202', name: 'sign-in' },
  admin: { id: '301', name: 'operator console' },
  evolution: { id: '401', name: 'codebase navigator' },
  database: { id: '402', name: 'database & cost' },
  status: { id: '403', name: 'status' },
  boot: { id: '404', name: 'starting up' },
} as const satisfies Record<string, Area>;

export type AreaKey = keyof typeof AREAS;

/** Formatted the way the badge prints it: `area 402 · database & cost`. */
export const areaLine = (a: Area): string => `area ${a.id} · ${a.name}`;
