import { useCallback, useEffect, useState } from 'react';
import { IndexedDBAdapter, type StorageAdapter, type UsageInfo } from '@sr/storage';
import type { CaptureSettings, SessionRecord } from '@sr/schema';
import { loadSettings, saveSettings } from './lib/settings.js';
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
          onSettings={update}
          onChanged={() => void refreshUsage(store)}
        />
      )}
    </div>
  );
}
