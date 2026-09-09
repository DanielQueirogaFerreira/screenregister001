import { buildTimeLine, timeZoneName, utcOffset } from '../lib/format.js';

interface Props {
  /** Retention ceiling the server reports, so the badge shows live config, not a guess. */
  retentionDays?: number;
  /** Present once connected; omitted while booting or on the auth screens. */
  signedIn?: boolean;
}

/**
 * Build provenance, bottom-left.
 *
 * Small on purpose — it is diagnostic furniture, not chrome. The commit is what makes it
 * worth having: when something looks wrong, the first question is always which build is
 * actually being served, and reading it off the screen beats inferring it from a deploy log.
 *
 * The time is UTC to the millisecond with the `Z`, which is the same rule the frame stamp
 * follows and comes from the same function — see buildTimeLine. The offset lives in the
 * tooltip, not on the badge.
 */
export function VersionBadge({ retentionDays, signedIn }: Props) {
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
    <div
      className="version-badge"
      title={[
        `ScreenRegister ${__APP_VERSION__}`,
        `commit ${__BUILD_COMMIT__}`,
        built ? `built ${built} — Z means UTC, the zero offset` : null,
        `this browser is ${zone ?? 'in an unreported zone'} (${offset})`,
        'Clocks elsewhere in the app render in that zone; this one does not.',
      ].filter(Boolean).join('\n')}
    >
      {bits.join(' · ')}
    </div>
  );
}
