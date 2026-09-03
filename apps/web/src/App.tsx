import { useCallback, useEffect, useRef, useState } from 'react';
import {
  IndexedDBAdapter, SyncEngine, type StorageAdapter, type SyncStatus, type UsageInfo,
} from '@sr/storage';
import type { CaptureSettings, SessionRecord } from '@sr/schema';
import { loadSettings, saveSettings } from './lib/settings.js';
import { connect, loadCloud, saveCloud, type CloudConfig } from './lib/cloud.js';
import { RecordView } from './views/RecordView.js';
import { LibraryView } from './views/LibraryView.js';
import { PlayerView } from './views/PlayerView.js';
import { SettingsView } from './views/SettingsView.js';

type Tab = 'record' | 'library' | 'settings';

/** Retention is checked on boot and hourly — a 7-day ceiling that is not merely a policy. */
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

export function App() {
  const [store, setStore] = useState<StorageAdapter | null>(null);
  const [tab, setTab] = useState<Tab>('record');
  const [settings, setSettings] = useState<CaptureSettings>(loadSettings);
  const [playing, setPlaying] = useState<SessionRecord | null>(null);
  const [usage, setUsage] = useState<UsageInfo | null>(null);
  const [booted, setBooted] = useState(false);
  const [cloud, setCloud] = useState<CloudConfig>(loadCloud);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const syncer = useRef<SyncEngine | null>(null);

  const refreshUsage = useCallback(async (s: StorageAdapter) => {
    setUsage(await s.usage());
  }, []);

  useEffect(() => {
    let timer: number | undefined;
    void (async () => {
      const s = new IndexedDBAdapter();
      await s.init();
      const cutoff = () => new Date(Date.now() - settings.retentionDays * 86400_000).toISOString();
      await s.pruneOlderThan(cutoff());
      timer = window.setInterval(() => void s.pruneOlderThan(cutoff()), PRUNE_INTERVAL_MS);
      setStore(s);
      await refreshUsage(s);
      setBooted(true);
    })();
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The sync engine is torn down and rebuilt whenever the target changes, so a stale
  // engine can never keep uploading to a server the user has switched away from.
  useEffect(() => {
    syncer.current?.stop();
    syncer.current = null;
    setSyncStatus(null);
    if (!store || !cloud.enabled || !cloud.apiUrl) return;

    let cancelled = false;
    void (async () => {
      try {
        const api = await connect(cloud);
        if (cancelled) return;
        const engine = new SyncEngine(store as IndexedDBAdapter, api, setSyncStatus);
        syncer.current = engine;
        engine.start();
      } catch (err) {
        if (!cancelled) {
          setSyncStatus({
            state: 'error', pending: 0, uploaded: 0, failed: 0, lastSyncAt: null,
            lastError: err instanceof Error ? err.message : String(err),
          });
        }
      }
    })();
    return () => {
      cancelled = true;
      syncer.current?.stop();
      syncer.current = null;
    };
  }, [store, cloud]);

  const updateCloud = useCallback((c: CloudConfig) => {
    setCloud(c);
    saveCloud(c);
  }, []);

  const update = useCallback((s: CaptureSettings) => {
    setSettings(s);
    saveSettings(s);
  }, []);

  if (!booted || !store) {
    return (
      <div className="app">
        <div className="empty">Opening local store…</div>
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
          cloud={cloud}
          syncStatus={syncStatus}
          onCloud={updateCloud}
          onSyncNow={() => void syncer.current?.syncOnce()}
          onSettings={update}
          onChanged={() => void refreshUsage(store)}
        />
      )}
    </div>
  );
}
