import { DEFAULT_SETTINGS, type CaptureSettings } from '@sr/schema';

const KEY = 'sr.settings';

export function loadSettings(): CaptureSettings {
  try {
    const raw = localStorage.getItem(KEY);
    // Merge over defaults so a settings object saved by an older build still boots.
    return raw ? { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<CaptureSettings>) } : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(s: CaptureSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* private mode — settings just will not persist */
  }
}
