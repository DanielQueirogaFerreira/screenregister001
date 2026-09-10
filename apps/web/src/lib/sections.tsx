import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import {
  PALETTES, accentFor, inkFor, randomPalette, sectionId, type Mode, type Palette,
} from '@sr/core';
import { followSystem, setThemeMode, themeIsExplicit, useThemeMode } from './theme.js';

/**
 * Sections that tell you where you are.
 *
 * A long page of identical panels gives no sense of place: you scroll, everything looks the
 * same, and the only way to know which part you are in is to stop and read a heading. Each
 * section carries a number and an accent from the active palette, so position becomes
 * peripheral information rather than something you have to look up.
 *
 * The accents are generated, bounded and tested in @sr/core — neighbouring sections differ
 * enough to register as a change without the boundary being a jolt, which is a narrower
 * target than it sounds and is not something to judge by eye. Every palette carries a tone
 * for each colour mode, so the same palette is the same palette on a white page: the same
 * hues, at the lightness that ground needs.
 */

const KEY = 'sr.palette';

interface PaletteBox {
  palette: Palette;
  saved: Palette[];
  setPalette: (p: Palette) => void;
  shuffle: () => void;
  save: () => void;
  remove: (id: string) => void;
}

const Ctx = createContext<PaletteBox | null>(null);

/** A palette from before palettes had two tones. Kept only so a saved one is not lost. */
interface LegacyPalette {
  id: string; name: string; from: number; step: number;
  lightness?: number; chroma?: number;
}

/**
 * Bring a stored palette up to the current shape.
 *
 * A palette used to be one lightness and one chroma, which was the dark tone under another
 * name. Discarding those would silently delete a palette someone chose to keep, so the old
 * values become the dark tone and the light tone is derived — darker and more chromatic,
 * which is the same relationship the shipped palettes have between their two tones.
 */
function migrate(v: LegacyPalette & Partial<Palette>): Palette | null {
  if (typeof v.from !== 'number' || typeof v.step !== 'number') return null;
  if (v.dark && v.light) return v as Palette;
  if (typeof v.lightness !== 'number' || typeof v.chroma !== 'number') return null;
  return {
    id: v.id, name: v.name, from: v.from, step: v.step,
    dark: { lightness: v.lightness, chroma: v.chroma },
    light: { lightness: 0.545, chroma: Math.min(0.145, Math.max(0.125, v.chroma + 0.025)) },
  };
}

function load(): { palette: Palette; saved: Palette[] } {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const v = JSON.parse(raw) as { palette?: LegacyPalette; saved?: LegacyPalette[] };
      // Migrated and validated rather than trusted: this is user-editable storage, and a
      // half-written object here would otherwise render every accent as "undefined".
      const palette = v.palette ? migrate(v.palette) : null;
      if (palette) {
        const saved = (v.saved ?? []).map(migrate).filter((p): p is Palette => p !== null);
        return { palette, saved };
      }
    }
  } catch {
    /* private mode, or nonsense in storage — the default is a fine answer */
  }
  return { palette: PALETTES[0]!, saved: [] };
}

export function PaletteProvider({ children }: { children: React.ReactNode }) {
  const [{ palette, saved }, setState] = useState(load);

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify({ palette, saved }));
    } catch { /* nothing to do; the choice just will not persist */ }
  }, [palette, saved]);

  const box = useMemo<PaletteBox>(() => ({
    palette,
    saved,
    setPalette: (p) => setState((s) => ({ ...s, palette: p })),
    shuffle: () => setState((s) => ({ ...s, palette: randomPalette() })),
    save: () => setState((s) => (
      s.saved.some((p) => p.id === s.palette.id)
        ? s
        : { ...s, saved: [...s.saved, s.palette] }
    )),
    remove: (id) => setState((s) => ({ ...s, saved: s.saved.filter((p) => p.id !== id) })),
  }), [palette, saved]);

  return <Ctx.Provider value={box}>{children}</Ctx.Provider>;
}

export const usePalette = (): PaletteBox => {
  const box = useContext(Ctx);
  if (!box) throw new Error('usePalette outside a PaletteProvider');
  return box;
};

/** One numbered, accented panel. `n` is its position on the page, counting from zero. */
export function Section({
  n, title, children, aside,
}: { n: number; title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  const { palette } = usePalette();
  const mode = useThemeMode();
  return (
    <div
      className="panel sec"
      style={{
        // Two variables, not one. The accent is the mark — the rule down the side, the
        // chip. The ink is small text in the same hue, which on a white ground cannot be
        // the same colour: see inkFor, where a sweep showed the two jobs are mutually
        // exclusive there.
        '--sec': accentFor(palette, n, mode),
        '--sec-ink': inkFor(palette, n, mode),
      } as React.CSSProperties}
    >
      <div className="sec-head">
        {/* Left of the name, three digits, same width every time — which is what lets a
            column of them read as a sequence rather than as ragged text. */}
        <span className="sec-id">{sectionId(n)}</span>
        <h3>{title}</h3>
        {aside}
      </div>
      {children}
    </div>
  );
}

/** Dark or light, or back to whatever the machine says. */
export function ThemeToggle() {
  const mode = useThemeMode();
  // Read once per render rather than subscribed to: it only ever changes in the same tick
  // as `mode`, which is already subscribed.
  const explicit = themeIsExplicit();
  return (
    <div className="pal-modes" role="group" aria-label="Colour mode">
      <button
        className={mode === 'dark' && explicit ? 'on' : ''}
        aria-pressed={mode === 'dark' && explicit}
        onClick={() => setThemeMode('dark')}
        title="Dark"
      >
        ◐ dark
      </button>
      <button
        className={mode === 'light' && explicit ? 'on' : ''}
        aria-pressed={mode === 'light' && explicit}
        onClick={() => setThemeMode('light')}
        title="Light"
      >
        ◑ light
      </button>
      {/*
        A third state, and worth the width. Someone who has never touched this should
        follow their desktop when it turns light at sunrise; someone who chose dark on a
        light desktop meant it and must not be overruled at sunrise. Without a way back,
        the first press of either button is irreversible.
      */}
      <button
        className={explicit ? '' : 'on'}
        aria-pressed={!explicit}
        onClick={followSystem}
        title="Follow the system setting"
      >
        auto
      </button>
    </div>
  );
}

/** Pick a palette, roll a new one, keep the ones worth keeping — in either colour mode. */
export function PalettePicker() {
  const { palette, saved, setPalette, shuffle, save, remove } = usePalette();
  const mode: Mode = useThemeMode();
  const all = [...PALETTES, ...saved];
  const isSaved = saved.some((p) => p.id === palette.id);
  const isBuiltIn = PALETTES.some((p) => p.id === palette.id);

  return (
    <div className="pal">
      <span className="pal-label">Appearance</span>
      <ThemeToggle />
      {all.map((p) => (
        <button
          key={p.id}
          className={`pal-chip${p.id === palette.id ? ' on' : ''}`}
          onClick={() => setPalette(p)}
          title={p.name}
          aria-pressed={p.id === palette.id}
        >
          {/* The palette shown as itself: four consecutive accents, in the mode they will
              actually be seen in. A name alone would make this a guess, and swatches drawn
              in the other mode's tone would make it a wrong one. */}
          {[0, 1, 2, 3].map((i) => (
            <i key={i} style={{ background: accentFor(p, i, mode) }} />
          ))}
          <span>{p.name}</span>
        </button>
      ))}
      <button className="pal-act" onClick={shuffle} title="Roll a new palette">↻ Shuffle</button>
      {!isBuiltIn && !isSaved && (
        <button className="pal-act on" onClick={save}>+ Save this one</button>
      )}
      {isSaved && (
        <button className="pal-act" onClick={() => remove(palette.id)}>Remove</button>
      )}
    </div>
  );
}
