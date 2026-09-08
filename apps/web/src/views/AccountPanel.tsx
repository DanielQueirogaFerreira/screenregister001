import { useCallback, useEffect, useState } from 'react';
import {
  changePassword, createToken, deleteAccount, listEvents, listSessions, listTokens,
  resendVerification, revokeSession, revokeToken,
  type Account, type ApiTokenSummary, type AuthEventRow, type LoginSession,
} from '../lib/auth.js';
import { PasswordField } from '../components/PasswordField.js';

interface Props {
  account: Account;
  emailConfigured: boolean;
  onSignedOut: () => void;
  /** Erases recordings before the account itself; the two are separate deletions. */
  onEraseRecordings: () => Promise<void>;
}

const when = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleString() : '—';

const shortAgent = (ua: string | null): string => {
  if (!ua) return 'unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /Chrome\//.test(ua) ? 'Chrome'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /Safari\//.test(ua) ? 'Safari' : 'browser';
  const os = /Windows/.test(ua) ? 'Windows'
    : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
    : /Android/.test(ua) ? 'Android'
    : /iPhone|iPad/.test(ua) ? 'iOS'
    : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
};

export function AccountPanel({ account, emailConfigured, onSignedOut, onEraseRecordings }: Props) {
  const [sessions, setSessions] = useState<LoginSession[]>([]);
  const [tokens, setTokens] = useState<ApiTokenSummary[]>([]);
  const [events, setEvents] = useState<AuthEventRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [tokenName, setTokenName] = useState('');
  const [tokenScope, setTokenScope] = useState<'read' | 'write'>('read');
  const [freshToken, setFreshToken] = useState<string | null>(null);
  const [verifyLink, setVerifyLink] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [s, t, e] = await Promise.all([listSessions(), listTokens(), listEvents()]);
    setSessions(s.sessions);
    setTokens(t.tokens);
    setEvents(e.events);
  }, []);

  useEffect(() => { void refresh().catch((err: unknown) => setError(String(err))); }, [refresh]);

  const run = async (fn: () => Promise<string | null>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const msg = await fn();
      if (msg) setNotice(msg);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel" style={{ marginTop: 14 }}>
      <h3 style={{ marginTop: 0 }}>Account &amp; security</h3>

      {error && <div className="banner bad">{error}</div>}
      {notice && <div className="banner info">{notice}</div>}

      <div className="hint">
        Signed in as <b>{account.email}</b>
        {account.email_verified
          ? ' · email confirmed'
          : ' · email not confirmed yet'}
      </div>

      {!account.email_verified && (
        <div className="banner warn" style={{ marginTop: 10 }}>
          Your email is not confirmed. Until it is, a forgotten password cannot be recovered.
          {emailConfigured ? (
            <button
              style={{ marginLeft: 8 }} disabled={busy}
              onClick={() => void run(async () => {
                await resendVerification();
                return 'Confirmation email sent.';
              })}
            >
              Resend
            </button>
          ) : (
            <button
              style={{ marginLeft: 8 }} disabled={busy}
              onClick={() => void run(async () => {
                const res = await resendVerification();
                setVerifyLink(res.verify_link ?? null);
                return 'No mail provider is configured — use the link below.';
              })}
            >
              Get link
            </button>
          )}
          {verifyLink && (
            <div style={{ marginTop: 8, wordBreak: 'break-all' }}>
              <a href={verifyLink} style={{ color: 'var(--accent)' }}>{verifyLink}</a>
            </div>
          )}
        </div>
      )}

      <h3>Change password</h3>
      <PasswordField
        id="cur" label="Current password" autoComplete="current-password"
        value={current} onChange={setCurrent} disabled={busy}
      />
      <PasswordField
        id="new" label="New password" autoComplete="new-password" minLength={12}
        value={next} onChange={setNext} disabled={busy}
        hint={
          <div className="hint">
            Changing it signs out every other device. This one stays signed in.
          </div>
        }
      />
      <button disabled={busy || !current || !next} onClick={() => void run(async () => {
        const res = await changePassword(current, next);
        setCurrent('');
        setNext('');
        return `Password changed. ${res.other_sessions_revoked} other session(s) signed out.`;
      })}>Change password</button>

      <h3>Where you are signed in</h3>
      {sessions.length === 0 ? (
        <div className="hint">No active sessions.</div>
      ) : (
        <table>
          <thead>
            <tr><th>Device</th><th>Last seen</th><th>IP</th><th></th></tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <tr key={s.id}>
                <td>{shortAgent(s.user_agent)}{s.current && <b> · this one</b>}</td>
                <td>{when(s.last_seen_at)}</td>
                <td style={{ color: 'var(--dim)' }}>{s.ip ?? '—'}</td>
                <td>
                  <button className="danger" disabled={busy} onClick={() => void run(async () => {
                    await revokeSession(s.id);
                    if (s.current) { onSignedOut(); return null; }
                    return 'Session signed out.';
                  })}>
                    {s.current ? 'Sign out' : 'Revoke'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>API tokens</h3>
      <div className="hint">
        For assistants and scripts, which cannot hold a browser cookie. A <b>read</b> token
        can look at your history but cannot record or delete — that is the one to give an
        LLM. Shown once, at creation; it is stored only as a hash and cannot be retrieved
        again.
      </div>

      {freshToken && (
        <div className="banner warn" style={{ marginTop: 10 }}>
          Copy this now — it will not be shown again:
          <br />
          <code style={{ wordBreak: 'break-all' }}>{freshToken}</code>
        </div>
      )}

      <div className="row" style={{ marginTop: 10 }}>
        <input
          placeholder="Token name, e.g. Claude Desktop" value={tokenName}
          onChange={(e) => setTokenName(e.target.value)} disabled={busy} style={{ flex: 1 }}
        />
        <select value={tokenScope} onChange={(e) => setTokenScope(e.target.value as 'read' | 'write')}
          style={{ width: 130 }} disabled={busy}>
          <option value="read">Read only</option>
          <option value="write">Read &amp; write</option>
        </select>
        <button disabled={busy || !tokenName.trim()} onClick={() => void run(async () => {
          const created = await createToken(tokenName.trim(), tokenScope);
          setFreshToken(created.token);
          setTokenName('');
          return null;
        })}>Create</button>
      </div>

      {tokens.length > 0 && (
        <table style={{ marginTop: 10 }}>
          <thead><tr><th>Name</th><th>Scope</th><th>Last used</th><th></th></tr></thead>
          <tbody>
            {tokens.map((t) => (
              <tr key={t.id}>
                <td>{t.name}</td>
                <td>{t.scope}</td>
                <td style={{ color: 'var(--dim)' }}>{when(t.last_used_at)}</td>
                <td>
                  <button className="danger" disabled={busy} onClick={() => void run(async () => {
                    await revokeToken(t.id);
                    return 'Token revoked.';
                  })}>Revoke</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>Recent account activity</h3>
      <div className="hint">
        Sign-ins, failures and changes to this account. Kept for 90 days.
      </div>
      {events.length > 0 && (
        <table style={{ marginTop: 10 }}>
          <thead><tr><th>When</th><th>Event</th><th>IP</th><th>Detail</th></tr></thead>
          <tbody>
            {events.slice(0, 20).map((e, i) => (
              <tr key={`${e.at}-${i}`}>
                <td>{when(e.at)}</td>
                <td>{e.event}</td>
                <td style={{ color: 'var(--dim)' }}>{e.ip ?? '—'}</td>
                <td style={{ color: 'var(--dim)' }}>{e.detail ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>Delete this account</h3>
      <div className="hint">
        Deletes the account, its sessions and its tokens. Your recordings are erased first,
        so nothing is left behind in R2 or D1. This cannot be undone.
      </div>
      <button className="danger" style={{ marginTop: 10 }} disabled={busy} onClick={() => void run(async () => {
        if (!confirm('Delete your account and every recording it holds? This cannot be undone.')) {
          return null;
        }
        await onEraseRecordings();
        await deleteAccount();
        onSignedOut();
        return null;
      })}>Delete account and all recordings</button>
    </div>
  );
}
