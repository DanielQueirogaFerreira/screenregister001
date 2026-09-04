import { useCallback, useEffect, useRef, useState } from 'react';
import { CloudStore, type UploadStatus, type UsageInfo } from '@sr/storage';
import type { CaptureSettings, SessionRecord } from '@sr/schema';
import { loadSettings, saveSettings } from './lib/settings.js';
import { connect } from './lib/cloud.js';
import { RecordView } from './views/RecordView.js';
import { LibraryView } from './views/LibraryView.js';
import { PlayerView } from './views/PlayerView.js';
import { SettingsView } from './views/SettingsView.js';

type Tab = 'record' | 'library' | 'settings';

export function App() {
  const [store, setStore] = useState<CloudStore | null>(null);
  const [tab, setTab] = useState<Tab>('record');
  const [settings, setSettings] = useState<CaptureSettings>(loadSettings);
  const [playing, setPlaying] = useState<SessionRecord | null>(null);
  const [usage, setUsage] = useState<UsageInfo | null>(null);
  const [uploads, setUploads] = useState<UploadStatus | null>(null);
  const [stalled, setStalled] = useState<string | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const storeRef = useRef<CloudStore | null>(null);

  const refreshUsage = useCallback(async (s: CloudStore) => {
    setUsage(await s.usage().catch(() => null));
  }, []);

  // One connection for the life of the page. There is no target to switch between —
  // the backend is the origin that served this bundle.
  useEffect(() => {
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
      } catch (err) {
        if (!cancelled) setBootError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
      storeRef.current?.dispose();
      storeRef.current = null;
    };
  }, [refreshUsage]);

  const update = useCallback((s: CaptureSettings) => {
    setSettings(s);
    saveSettings(s);
  }, []);

  if (bootError) {
    return (
      <div className="app">
        <div className="panel">
          <h3 style={{ marginTop: 0 }}>Cannot reach the recording service</h3>
          <div className="banner bad">{bootError}</div>
          <div className="hint">
            ScreenRegister stores recordings in Cloudflare, so it cannot record while the
            service is unavailable. Nothing was captured, and no data was lost. Reload once
            the service is back.
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <button className="primary" onClick={() => location.reload()}>Reload</button>
          </div>
        </div>
      </div>
    );
  }

  if (!store) {
    return (
      <div className="app">
        <div className="empty">Connecting to the recording service…</div>
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
          {(['record', 'library', 'settings'] as Tab[]).map((t) => (
            <button
              key={t}
              className={tab === t && !playing ? 'on' : ''}
              onClick={() => {
                setPlaying(null);
                setTab(t);
              }}
            >
              {t[0]!.toUpperCase() + t.slice(1)}
            </button>
          ))}
        </nav>
      </header>

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
          settings={settings}
          uploads={uploads}
          stalled={stalled}
          onRetryUploads={() => { setStalled(null); store.retryUploads(); }}
          onSettings={update}
          onSessionEnd={() => void refreshUsage(store)}
        />
      ) : tab === 'library' ? (
        <LibraryView store={store} onOpen={setPlaying} onChanged={() => void refreshUsage(store)} />
      ) : (
        <SettingsView
          store={store}
          settings={settings}
          usage={usage}
          uploads={uploads}
          onSettings={update}
          onChanged={() => void refreshUsage(store)}
        />
      )}
    </div>
  );
}
