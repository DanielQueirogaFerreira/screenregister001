import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { CloudStore, type UploadStatus, type UsageInfo } from '@sr/storage';
import type { CaptureSettings, SessionRecord } from '@sr/schema';
import { loadSettings, saveSettings } from './lib/settings.js';
import { connect } from './lib/cloud.js';
import {
  claimHistory, fetchMe, forgetLegacyToken, legacyDeviceToken, logout, type Account,
} from './lib/auth.js';
import { CaptureSessions } from './capture/sessions.js';
import { AuthView } from './views/AuthView.js';
import { RecordView } from './views/RecordView.js';
import { LibraryView } from './views/LibraryView.js';
import { PlayerView } from './views/PlayerView.js';
import { InspectView } from './views/InspectView.js';
import { SettingsView } from './views/SettingsView.js';
import { VersionBadge } from './views/VersionBadge.js';
import { StatusView } from './views/StatusView.js';

type Tab = 'record' | 'library' | 'inspect' | 'settings';

export function App() {
  // The status page is deliberately outside the auth gate, and checked before any of it
  // runs. The moment it is most needed is when authentication is the thing that is broken,
  // and a status page you have to sign in to read cannot report that you cannot sign in.
  if (typeof location !== 'undefined' && location.pathname.replace(/\/+$/, '') === '/status') {
    return (
      <>
        <StatusView />
        <VersionBadge />
      </>
    );
  }
  return <RecorderApp />;
}

function RecorderApp() {
  const [account, setAccount] = useState<Account | null>(null);
  const [emailConfigured, setEmailConfigured] = useState(false);
  const [checkingAuth, setCheckingAuth] = useState(true);

  const [store, setStore] = useState<CloudStore | null>(null);
  const [tab, setTab] = useState<Tab>('record');
  const [settings, setSettings] = useState<CaptureSettings>(loadSettings);
  const [playing, setPlaying] = useState<SessionRecord | null>(null);
  const [usage, setUsage] = useState<UsageInfo | null>(null);
  const [uploads, setUploads] = useState<UploadStatus | null>(null);
  const [stalled, setStalled] = useState<string | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [claimable, setClaimable] = useState<string | null>(null);
  const [claimNotice, setClaimNotice] = useState<string | null>(null);
  const storeRef = useRef<CloudStore | null>(null);

  /**
   * Capture lives here, not inside RecordView.
   *
   * The tabs render as `tab === 'record' ? <RecordView/> : …`, so anything the record
   * screen owned was destroyed the moment you opened the library — which is exactly how a
   * recording could vanish mid-session and leave a zero-frame row behind. A ref created
   * once, above the switch, is never unmounted by navigation.
   */
  const sessionsRef = useRef<CaptureSessions | null>(null);
  if (sessionsRef.current === null) sessionsRef.current = new CaptureSessions(settings);
  const sessions = sessionsRef.current;
  const live = useSyncExternalStore(sessions.subscribe, sessions.getSnapshot);

  const refreshUsage = useCallback(async (s: CloudStore) => {
    setUsage(await s.usage().catch(() => null));
  }, []);

  // Who is signed in? The session is an HttpOnly cookie, so the only way to know is to ask.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const me = await fetchMe();
        if (cancelled) return;
        setAccount(me?.user ?? null);
        setEmailConfigured(me?.email_configured ?? false);
      } catch (err) {
        if (!cancelled) setBootError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setCheckingAuth(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // The store is built only once there is an account to own the recordings.
  useEffect(() => {
    if (!account) {
      storeRef.current?.dispose();
      storeRef.current = null;
      setStore(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const api = await connect();
        const s = new CloudStore(api, setUploads, setStalled);
        await s.init();
        if (cancelled) return;
        storeRef.current = s;
        setStore(s);
        await refreshUsage(s);
        setClaimable(legacyDeviceToken());
      } catch (err) {
        if (!cancelled) setBootError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
      storeRef.current?.dispose();
      storeRef.current = null;
    };
  }, [account, refreshUsage]);

  const update = useCallback((s: CaptureSettings) => {
    setSettings(s);
    saveSettings(s);
    sessions.updateSettings(s);
  }, [sessions]);

  useEffect(() => {
    sessions.onSessionEnd = () => {
      const s = storeRef.current;
      if (s) void refreshUsage(s);
    };
  }, [sessions, refreshUsage]);

  /**
   * Uploads have stopped, so every capture pauses — not just the one on screen.
   *
   * The cloud is the only store: a frame that cannot be uploaded is a frame that is not
   * recorded, and capturing on into a dead queue would quietly discard it.
   */
  useEffect(() => {
    if (stalled) sessions.setAllPaused(true);
  }, [stalled, sessions]);

  /**
   * Closing the tab ends every recording, and the tail of a session exists only in memory
   * until it is flushed. Warn rather than lose it. Browsers ignore custom text here and
   * show their own wording, which is why none is supplied.
   */
  useEffect(() => {
    if (live.length === 0) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [live.length]);

  const signOut = useCallback(() => {
    // Stop first: these recordings belong to the account that is being signed out of, and
    // a capture left running would keep uploading into a session that can no longer be read.
    void sessions.stopAll().catch(() => undefined);
    void logout().catch(() => undefined);
    setAccount(null);
    setPlaying(null);
    setTab('record');
  }, [sessions]);

  if (checkingAuth) {
    return (
      <div className="app">
        <div className="empty">Checking your session…</div>
        <VersionBadge />
      </div>
    );
  }

  if (!account) {
    return (
      <>
        <AuthView onSignedIn={(user) => { setAccount(user); setBootError(null); }} />
        <VersionBadge signedIn={false} />
      </>
    );
  }

  if (bootError) {
    return (
      <div className="app">
        <div className="panel">
          <h3 style={{ marginTop: 0 }}>Cannot reach the recording service</h3>
          <div className="banner bad">{bootError}</div>
          <div className="hint">
            ScreenRegister stores recordings in Cloudflare, so it cannot record while the
            service is unavailable. Nothing was captured, and no data was lost.
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <button className="primary" onClick={() => location.reload()}>Reload</button>
            <button onClick={signOut}>Sign out</button>
          </div>
        </div>
        <VersionBadge />
      </div>
    );
  }

  if (!store) {
    return (
      <div className="app">
        <div className="empty">Connecting to the recording service…</div>
        <VersionBadge />
      </div>
    );
  }

  return (
    <div className="app">
      <header>
        <h1>
          ScreenRegister <span>· 7-day screen memory</span>
        </h1>
        <nav>
          {(['record', 'library', 'inspect', 'settings'] as Tab[]).map((t) => (
            <button
              key={t}
              className={tab === t && !playing ? 'on' : ''}
              onClick={() => {
                setPlaying(null);
                setTab(t);
              }}
            >
              {t[0]!.toUpperCase() + t.slice(1)}
              {/* Capture no longer stops when you leave this tab, so the tab has to say
                  so — an indicator that only appears on the screen it describes is not an
                  indicator. */}
              {t === 'record' && live.length > 0 && (
                <span className="tab-live" aria-hidden="true">
                  <span className={`dot ${live.some((x) => !x.paused) ? 'live' : ''}`} />
                  {live.length > 1 && live.length}
                </span>
              )}
            </button>
          ))}
          <span className="who" title={account.email}>{account.email}</span>
          <button onClick={signOut}>Sign out</button>
        </nav>
      </header>

      {live.length > 0 && tab !== 'record' && !playing && (
        <div className="banner info recording-bar">
          <span className={`dot ${live.some((x) => !x.paused) ? 'live' : ''}`} />
          <b>
            {live.length} screen{live.length === 1 ? '' : 's'} recording
          </b>
          <span style={{ color: 'var(--dim)' }}>
            {live.reduce((n, x) => n + x.stats.stored, 0)} frames stored this session
          </span>
          <div className="row" style={{ marginLeft: 'auto' }}>
            <button onClick={() => setTab('record')}>Manage</button>
            <button
              onClick={() => sessions.setAllPaused(!live.every((x) => x.paused))}
            >
              {live.every((x) => x.paused) ? 'Resume all' : 'Pause all'}
            </button>
            <button className="danger" onClick={() => void sessions.stopAll()}>Stop all</button>
          </div>
        </div>
      )}

      {claimNotice && <div className="banner info">{claimNotice}</div>}

      {claimable && (
        <div className="banner warn">
          This browser holds recordings made before you had an account. Move them into{' '}
          <b>{account.email}</b>?
          <button
            style={{ marginLeft: 8 }}
            onClick={() => void (async () => {
              try {
                const moved = await claimHistory(claimable);
                setClaimNotice(
                  `Moved ${moved.frames} frame(s) across ${moved.sessions} session(s) into your account.`,
                );
                await refreshUsage(store);
              } catch (err) {
                setClaimNotice(err instanceof Error ? err.message : String(err));
              } finally {
                setClaimable(null);
              }
            })()}
          >
            Move them
          </button>
          <button
            style={{ marginLeft: 6 }}
            onClick={() => { forgetLegacyToken(); setClaimable(null); }}
          >
            Discard
          </button>
        </div>
      )}

      {playing ? (
        <PlayerView
          store={store}
          session={playing}
          settings={settings}
          onBack={() => setPlaying(null)}
        />
      ) : tab === 'record' ? (
        <RecordView
          store={store}
          sessions={sessions}
          accountId={account.user_id}
          settings={settings}
          uploads={uploads}
          stalled={stalled}
          onRetryUploads={() => { setStalled(null); store.retryUploads(); }}
          onSettings={update}
        />
      ) : tab === 'library' ? (
        <LibraryView store={store} onOpen={setPlaying} onChanged={() => void refreshUsage(store)} />
      ) : tab === 'inspect' ? (
        <InspectView store={store} accountId={account.user_id} />
      ) : (
        <SettingsView
          store={store}
          settings={settings}
          usage={usage}
          uploads={uploads}
          account={account}
          emailConfigured={emailConfigured}
          onSignedOut={signOut}
          onSettings={update}
          onChanged={() => void refreshUsage(store)}
        />
      )}

      <VersionBadge retentionDays={store.retentionDays} signedIn />
    </div>
  );
}
