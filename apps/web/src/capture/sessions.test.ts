import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@sr/schema';

/**
 * A Recorder that never touches the screen, so the manager's bookkeeping can be tested
 * without a browser. `stop()` fires onStopped exactly as the real one does, because the
 * manager relies on that callback to remove the entry.
 */
const built: FakeRecorder[] = [];

class FakeRecorder {
  paused = false;
  stopped = false;
  settings: unknown;
  sessionId: string | null = null;
  surfaceLabel = '';
  failStart = false;

  constructor(
    _store: unknown, settings: unknown, _accountId: string,
    public events: Record<string, ((...a: never[]) => void) | undefined>,
  ) {
    this.settings = settings;
    built.push(this);
  }

  async start(): Promise<void> {
    if (this.failStart) throw new Error('NotAllowedError: Permission denied');
    this.sessionId = `sess-${built.indexOf(this)}`;
    this.surfaceLabel = `screen ${built.indexOf(this)}`;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    (this.events.onStopped as ((r: string) => void) | undefined)?.('stopped');
  }

  setPaused(p: boolean): void { this.paused = p; }
  updateSettings(s: unknown): void { this.settings = s; }
}

vi.mock('./recorder.js', () => ({
  Recorder: FakeRecorder,
  detectSupport: () => ({ supported: true, path: 'track-processor', reason: '' }),
}));

const { CaptureSessions } = await import('./sessions.js');

const store = {} as never;

beforeEach(() => {
  built.length = 0;
  // The manager batches notifications on a frame; run them straight through in tests.
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => {
    fn(0);
    return 0;
  });
  vi.stubGlobal('setInterval', (() => 1) as unknown as typeof setInterval);
  vi.stubGlobal('clearInterval', () => undefined);
  vi.stubGlobal('URL', { ...URL, createObjectURL: () => 'blob:x', revokeObjectURL: () => undefined });
});

describe('CaptureSessions', () => {
  it('keeps recording when the view that started it goes away', async () => {
    // This is the whole reason the class exists. RecordView used to hold the recorder in a
    // ref, and App unmounts it on every tab switch — so opening the library killed the
    // capture and left a zero-frame session behind. Nothing a subscriber does may stop it.
    const sessions = new CaptureSessions(DEFAULT_SETTINGS);
    const unsubscribe = sessions.subscribe(() => undefined);
    await sessions.start(store, 'user-1');

    unsubscribe();  // the view unmounts

    expect(sessions.getSnapshot()).toHaveLength(1);
    expect(sessions.getSnapshot()[0]!.running).toBe(true);
    expect(built[0]!.stopped).toBe(false);
  });

  it('runs several screens at once, each with its own recorder', async () => {
    const sessions = new CaptureSessions(DEFAULT_SETTINGS);
    await sessions.start(store, 'user-1');
    await sessions.start(store, 'user-1');
    await sessions.start(store, 'user-1');

    const live = sessions.getSnapshot();
    expect(live).toHaveLength(3);
    expect(new Set(live.map((s) => s.key)).size).toBe(3);
    expect(new Set(live.map((s) => s.sessionId)).size).toBe(3);
    expect(built).toHaveLength(3);
  });

  it('pauses and stops one capture without touching the others', async () => {
    const sessions = new CaptureSessions(DEFAULT_SETTINGS);
    await sessions.start(store, 'user-1');
    await sessions.start(store, 'user-1');
    const [first, second] = sessions.getSnapshot();

    sessions.setPaused(first!.key, true);
    expect(sessions.getSnapshot().find((s) => s.key === first!.key)!.paused).toBe(true);
    expect(sessions.getSnapshot().find((s) => s.key === second!.key)!.paused).toBe(false);

    await sessions.stop(first!.key);
    expect(sessions.getSnapshot().map((s) => s.key)).toEqual([second!.key]);
    expect(built[1]!.stopped).toBe(false);
  });

  it('applies a settings change to every live capture', async () => {
    const sessions = new CaptureSessions(DEFAULT_SETTINGS);
    await sessions.start(store, 'user-1');
    await sessions.start(store, 'user-1');

    const tuned = { ...DEFAULT_SETTINGS, captureFps: 12 };
    sessions.updateSettings(tuned);
    expect(built.map((r) => r.settings)).toEqual([tuned, tuned]);
  });

  it('pauses everything at once when uploads stall', async () => {
    const sessions = new CaptureSessions(DEFAULT_SETTINGS);
    await sessions.start(store, 'user-1');
    await sessions.start(store, 'user-1');

    sessions.setAllPaused(true);
    expect(sessions.getSnapshot().every((s) => s.paused)).toBe(true);
    expect(built.every((r) => r.paused)).toBe(true);
  });

  it('leaves nothing behind when the share picker is cancelled', async () => {
    const sessions = new CaptureSessions(DEFAULT_SETTINGS);
    const original = FakeRecorder.prototype.start;
    FakeRecorder.prototype.start = async function fail(this: FakeRecorder) {
      this.failStart = true;
      return original.call(this);
    };
    await expect(sessions.start(store, 'user-1')).rejects.toThrow(/Permission denied/);
    FakeRecorder.prototype.start = original;

    // A half-created entry would show as a stuck "Starting…" card with no way to stop it.
    expect(sessions.getSnapshot()).toEqual([]);
  });

  it('notifies subscribers so the interface can follow along', async () => {
    const sessions = new CaptureSessions(DEFAULT_SETTINGS);
    const seen: number[] = [];
    sessions.subscribe(() => seen.push(sessions.getSnapshot().length));

    await sessions.start(store, 'user-1');
    expect(seen.at(-1)).toBe(1);

    await sessions.stop(sessions.getSnapshot()[0]!.key);
    expect(seen.at(-1)).toBe(0);
  });

  it('stops every capture when the account signs out', async () => {
    const sessions = new CaptureSessions(DEFAULT_SETTINGS);
    await sessions.start(store, 'user-1');
    await sessions.start(store, 'user-1');

    await sessions.stopAll();
    expect(sessions.getSnapshot()).toEqual([]);
    expect(built.every((r) => r.stopped)).toBe(true);
  });
});
