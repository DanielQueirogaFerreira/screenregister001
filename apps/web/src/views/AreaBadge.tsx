import { useCallback, useSyncExternalStore } from 'react';
import { AREAS, areaLine, type Area } from '../lib/areas.js';
import { buildTimeLine, timeZoneName, utcOffset } from '../lib/format.js';

interface Props {
  /** Which part of the system this screen is. Every screen names one. */
  area: Area;
  /** Retention ceiling the server reports, so the badge shows live config, not a guess. */
  retentionDays?: number;
  /** Present once connected; omitted while booting or on the auth screens. */
  signedIn?: boolean;
}

/**
 * Where you are and what you are running, bottom-left, on every screen.
 *
 * Two lines that answer two different questions, which is why they are two lines and two
 * colours rather than one run of text: the area id says WHERE this is, the build line says
 * WHAT is serving it. Together they turn "it's broken on the thing with the graphs" into
 * something reproducible.
 *
 * Small on purpose — it is diagnostic furniture, not chrome — and collapsible, because
 * furniture that cannot be moved out of the way stops being furniture and becomes
 * clutter. The eye is the whole control: one press hides both lines, another brings them
 * back, and the choice is remembered, since a badge that re-expands on every navigation is
 * one you have to dismiss over and over.
 *
 * The time is UTC to the millisecond with the `Z`, which is the same rule the frame stamp
 * follows and comes from the same function — see buildTimeLine. The offset lives in the
 * tooltip, not on the badge.
 */
export function AreaBadge({ area, retentionDays, signedIn }: Props) {
  const [open, setOpen] = useBadgeOpen();
  const built = buildTimeLine(__BUILD_TIME__);
  const zone = timeZoneName();
  const offset = utcOffset();

  const bits = [
    `v${__APP_VERSION__}`,
    __BUILD_COMMIT__,
    built ?? '—',
    retentionDays ? `${retentionDays}d retention` : null,
    signedIn === false ? 'signed out' : null,
  ].filter(Boolean);

  return (
    <div className={`area-badge${open ? '' : ' shut'}`}>
      {/* Left of the block it governs, so the thing you press does not move when the
          block it hides disappears. */}
      <button
        className="area-badge-eye"
        aria-expanded={open}
        aria-label={open ? 'Hide the area and build details' : 'Show the area and build details'}
        title={open ? `Hide ${areaLine(area)}` : `Show area and build details (${areaLine(area)})`}
        onClick={() => setOpen(!open)}
      >
        {open ? '◉' : '◌'}
      </button>
      {open && (
        <div className="area-badge-lines">
          <div className="area-badge-area">{areaLine(area)}</div>
          <div
            className="area-badge-build"
            title={[
              `ScreenRegister ${__APP_VERSION__}`,
              `${areaLine(area)}`,
              `commit ${__BUILD_COMMIT__}`,
              built ? `built ${built} — Z means UTC, the zero offset` : null,
              `this browser is ${zone ?? 'in an unreported zone'} (${offset})`,
              'Clocks elsewhere in the app render in that zone; this one does not.',
            ].filter(Boolean).join('\n')}
          >
            {bits.join(' · ')}
          </div>
        </div>
      )}
    </div>
  );
}

const KEY = 'sr.badge.open';
const listeners = new Set<() => void>();
let openState: boolean = read();

function read(): boolean {
  try {
    return localStorage.getItem(KEY) !== '0';
  } catch {
    return true;
  }
}

/**
 * Shared between every badge on the page rather than held per component.
 *
 * There is normally one badge, but the codebase viewer draws its own inside the scene so
 * it survives fullscreen — and two badges that disagree about whether they are collapsed
 * would be the clearest possible sign that the control does not mean anything.
 */
export function useBadgeOpen(): [boolean, (v: boolean) => void] {
  const open = useSyncExternalStore(
    (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    () => openState,
    () => true,
  );
  const set = useCallback((v: boolean) => {
    openState = v;
    try { localStorage.setItem(KEY, v ? '1' : '0'); } catch { /* will not persist */ }
    for (const l of listeners) l();
  }, []);
  return [open, set];
}
