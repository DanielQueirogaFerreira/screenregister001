interface Props {
  /** Retention ceiling the server reports, so the badge shows live config, not a guess. */
  retentionDays?: number;
  /** Present once connected; omitted while booting or on the auth screens. */
  signedIn?: boolean;
}

const shortTime = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toISOString().slice(0, 16).replace('T', ' ');
};

/**
 * Build provenance, bottom-left.
 *
 * Small on purpose — it is diagnostic furniture, not chrome. The commit is what makes it
 * worth having: when something looks wrong, the first question is always which build is
 * actually being served, and reading it off the screen beats inferring it from a deploy log.
 */
export function VersionBadge({ retentionDays, signedIn }: Props) {
  const bits = [
    `v${__APP_VERSION__}`,
    __BUILD_COMMIT__,
    shortTime(__BUILD_TIME__),
    retentionDays ? `${retentionDays}d retention` : null,
    signedIn === false ? 'signed out' : null,
  ].filter(Boolean);

  return (
    <div
      className="version-badge"
      title={`ScreenRegister ${__APP_VERSION__}\ncommit ${__BUILD_COMMIT__}\nbuilt ${__BUILD_TIME__}`}
    >
      {bits.join(' · ')}
    </div>
  );
}
