import { useSyncExternalStore } from 'react';
import type { Mode } from '@sr/core';

/**
 * Which colour mode the app is in.
 *
 * Deliberately not React state and not a provider. The theme has to be readable from the
 * recorder, the database page, the status page and the codebase navigator — four separate
 * roots, two of them rendered before any provider could wrap them — and a context would
 * mean remembering to mount it in each, with a crash or a silent fallback when someone
 * adds a fifth. A module-level store with `useSyncExternalStore` has no mounting order to
 * get wrong.
 *
 * The value that actually drives the stylesheet is an attribute on <html>, which is set
 * here and, for the first paint, by a snippet in index.html — without that the page paints
 * dark and then flips, which is worse than either mode.
 */

const KEY = 'sr.theme';

function systemPrefers(): Mode {
  try {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

function stored(): Mode | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
}

/**
 * Whether the mode was chosen or merely inherited from the system.
 *
 * Worth keeping separate. Someone who has never touched the control should follow their
 * system when it changes at sunset; someone who picked dark on a light desktop meant it,
 * and should not be overruled at sunset.
 */
let explicit = stored() !== null;
let mode: Mode = stored() ?? systemPrefers();

const listeners = new Set<() => void>();

function apply(): void {
  try {
    document.documentElement.dataset.theme = mode;
    // Native widgets — scrollbars, form controls, the space beyond the page — follow this
    // and nothing else. Without it a light page keeps a dark scrollbar.
    document.documentElement.style.colorScheme = mode;
  } catch { /* no document: a test, or SSR */ }
}

export function setThemeMode(next: Mode): void {
  if (next === mode && explicit) return;
  mode = next;
  explicit = true;
  try { localStorage.setItem(KEY, next); } catch { /* the choice just will not persist */ }
  apply();
  for (const l of listeners) l();
}

/** Hand the choice back to the operating system. */
export function followSystem(): void {
  explicit = false;
  try { localStorage.removeItem(KEY); } catch { /* nothing to undo */ }
  mode = systemPrefers();
  apply();
  for (const l of listeners) l();
}

export const themeIsExplicit = (): boolean => explicit;

const subscribe = (fn: () => void): (() => void) => {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
};

export const getThemeMode = (): Mode => mode;

export function useThemeMode(): Mode {
  // The server snapshot is the same value: this app has no SSR, and returning a different
  // one would make the first client render disagree with itself.
  return useSyncExternalStore(subscribe, getThemeMode, getThemeMode);
}

// Follow the system while nobody has expressed a preference — and stop the moment they do.
try {
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', (e) => {
    if (explicit) return;
    mode = e.matches ? 'light' : 'dark';
    apply();
    for (const l of listeners) l();
  });
} catch { /* older browser, or none */ }

apply();
