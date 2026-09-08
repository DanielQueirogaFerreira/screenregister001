import { timeZoneName, utcOffset } from '../lib/format.js';

interface Props {
  /** Retention ceiling the server reports, so the badge shows live config, not a guess. */
  retentionDays?: number;
  /** Present once connected; omitted while booting or on the auth screens. */
  signedIn?: boolean;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * The build time, in this browser's own zone, with the offset stated.
 *
 * It used to print `toISOString()` — UTC, with nothing saying so — while every other clock
 * in the application (the library, the player, the inspector) renders local time through
 * `toLocaleTimeString`. So one instant appeared as two different numbers on the same
 * screen, and neither of them admitted which reference it was using. That is the whole
 * reason to add the offset: not decoration, but the thing that makes the number mean
 * something.
 *
 * Rendering it locally rather than labelling it UTC is the choice that makes the badge
 * agree with the rest of the interface instead of contradicting it, and it means the one
 * offset shown in the corner is the reference for every unlabelled timestamp on screen.
 * The exact UTC instant stays in the tooltip, where a machine comparison wants it.
 */
function localBuildTime(iso: string): { text: string; offset: string } | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const text =
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return { text, offset: utcOffset(d) };
}

/**
 * Build provenance, bottom-left.
 *
 * Small on purpose — it is diagnostic furniture, not chrome. The commit is what makes it
 * worth having: when something looks wrong, the first question is always which build is
 * actually being served, and reading it off the screen beats inferring it from a deploy log.
 */
export function VersionBadge({ retentionDays, signedIn }: Props) {
  const built = localBuildTime(__BUILD_TIME__);
  const zone = timeZoneName();

  const bits = [
    `v${__APP_VERSION__}`,
    __BUILD_COMMIT__,
    built ? `${built.text} ${built.offset}` : '—',
    retentionDays ? `${retentionDays}d retention` : null,
    signedIn === false ? 'signed out' : null,
  ].filter(Boolean);

  return (
    <div
      className="version-badge"
      title={[
        `ScreenRegister ${__APP_VERSION__}`,
        `commit ${__BUILD_COMMIT__}`,
        `built ${__BUILD_TIME__}`,
        built ? `shown in ${zone ?? 'this browser\u2019s time zone'} (${built.offset})` : null,
        'Times elsewhere in the app use this same zone.',
      ].filter(Boolean).join('\n')}
    >
      {bits.join(' · ')}
    </div>
  );
}
