import { useEffect, useState } from 'react';
import {
  AuthError, confirmReset, login, requestReset, signup, verifyEmail, type Account,
} from '../lib/auth.js';

type Mode = 'login' | 'signup' | 'forgot' | 'reset' | 'verify';

interface Props {
  onSignedIn: (user: Account) => void;
}

/** A link may drop the user straight into a reset or verification. */
function initialMode(): { mode: Mode; token: string | null } {
  if (typeof location === 'undefined') return { mode: 'login', token: null };
  const token = new URLSearchParams(location.search).get('token');
  if (location.pathname.startsWith('/reset')) return { mode: 'reset', token };
  if (location.pathname.startsWith('/verify')) return { mode: 'verify', token };
  return { mode: 'login', token: null };
}

const MIN_LENGTH = 12;

export function AuthView({ onSignedIn }: Props) {
  const start = initialMode();
  const [mode, setMode] = useState<Mode>(start.mode);
  const [token] = useState<string | null>(start.token);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [devLink, setDevLink] = useState<string | null>(null);

  // Verification is a link the user clicked, not something to make them press a button for.
  useEffect(() => {
    if (mode !== 'verify' || !token) return;
    setBusy(true);
    verifyEmail(token)
      .then(() => setNotice('Email confirmed. You can sign in now.'))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => { setBusy(false); setMode('login'); });
  }, [mode, token]);

  const fail = (err: unknown) => {
    if (err instanceof AuthError) {
      setError(err.message);
      setProblems(err.problems ?? []);
    } else {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setProblems([]);
    setNotice(null);
    try {
      await fn();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;

    if (mode === 'login') {
      void run(async () => onSignedIn((await login(email, password)).user));
    } else if (mode === 'signup') {
      if (password !== confirm) return setError('The two passwords do not match.');
      void run(async () => {
        const res = await signup(email, password);
        if (res.verify_link) setDevLink(res.verify_link);
        onSignedIn(res.user);
      });
    } else if (mode === 'forgot') {
      void run(async () => {
        const res = await requestReset(email);
        setNotice(res.message);
        if (res.reset_link) setDevLink(res.reset_link);
      });
    } else if (mode === 'reset') {
      if (password !== confirm) return setError('The two passwords do not match.');
      if (!token) return setError('This reset link is missing its token.');
      void run(async () => {
        await confirmReset(token, password);
        setNotice('Password changed. Every other device has been signed out. Sign in below.');
        setMode('login');
        setPassword('');
        setConfirm('');
      });
    }
  };

  const title = {
    login: 'Sign in', signup: 'Create an account', forgot: 'Reset your password',
    reset: 'Choose a new password', verify: 'Confirming your email…',
  }[mode];

  return (
    <div className="auth-shell">
      <div className="panel auth-panel">
        <h1 style={{ marginTop: 0 }}>
          ScreenRegister <span>· 7-day screen memory</span>
        </h1>

        <p className="hint" style={{ marginTop: -4 }}>
          This service records your screen and stores it in Cloudflare for seven days. An
          account is what keeps that recording readable by you and nobody else.
        </p>

        <h3>{title}</h3>

        {error && <div className="banner bad">{error}</div>}
        {problems.length > 0 && (
          <div className="banner bad">
            <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
              {problems.map((p) => <li key={p}>{p}</li>)}
            </ul>
          </div>
        )}
        {notice && <div className="banner info">{notice}</div>}
        {devLink && (
          <div className="banner warn">
            No email provider is configured on this deployment, so nothing was sent. Use this
            link to continue:
            <br />
            <a href={devLink} style={{ color: 'var(--accent)', wordBreak: 'break-all' }}>{devLink}</a>
          </div>
        )}

        <form onSubmit={submit}>
          {mode !== 'reset' && (
            <div className="field">
              <label htmlFor="email">Email</label>
              <input
                id="email" type="email" autoComplete="username" required value={email}
                onChange={(e) => setEmail(e.target.value)} disabled={busy}
              />
            </div>
          )}

          {mode !== 'forgot' && mode !== 'verify' && (
            <div className="field">
              <label htmlFor="password">Password</label>
              <input
                id="password" type="password" required value={password}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                minLength={mode === 'login' ? undefined : MIN_LENGTH}
                onChange={(e) => setPassword(e.target.value)} disabled={busy}
              />
              {mode !== 'login' && (
                <div className="hint">
                  At least {MIN_LENGTH} characters. Length matters far more than symbols — a
                  passphrase of ordinary words beats a short scramble.
                </div>
              )}
            </div>
          )}

          {(mode === 'signup' || mode === 'reset') && (
            <div className="field">
              <label htmlFor="confirm">Confirm password</label>
              <input
                id="confirm" type="password" required autoComplete="new-password"
                value={confirm} onChange={(e) => setConfirm(e.target.value)} disabled={busy}
              />
            </div>
          )}

          <button className="primary" type="submit" disabled={busy} style={{ width: '100%' }}>
            {busy ? 'Working…' : title}
          </button>
        </form>

        <div className="row auth-links">
          {mode === 'login' && (
            <>
              <button onClick={() => { setMode('signup'); setError(null); }}>Create an account</button>
              <button onClick={() => { setMode('forgot'); setError(null); }}>Forgot password</button>
            </>
          )}
          {mode !== 'login' && (
            <button onClick={() => { setMode('login'); setError(null); setNotice(null); }}>
              Back to sign in
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
