import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { PALETTES, accentFor, randomPalette, sectionId, type Palette } from '@sr/core';

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
 * target than it sounds and is not something to judge by eye.
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

function load(): { palette: Palette; saved: Palette[] } {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const v = JSON.parse(raw) as { palette?: Palette; saved?: Palette[] };
      // Merged over the shipped default rather than trusted: this is user-editable storage,
      // and a half-written object here would otherwise render every accent as "undefined".
      if (v.palette && typeof v.palette.step === 'number') {
        return { palette: { ...PALETTES[0]!, ...v.palette }, saved: v.saved ?? [] };
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
  const accent = accentFor(palette, n);
  return (
    <div className="panel sec" style={{ '--sec': accent } as React.CSSProperties}>
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

/** Pick a palette, roll a new one, keep the ones worth keeping. */
export function PalettePicker() {
  const { palette, saved, setPalette, shuffle, save, remove } = usePalette();
  const all = [...PALETTES, ...saved];
  const isSaved = saved.some((p) => p.id === palette.id);
  const isBuiltIn = PALETTES.some((p) => p.id === palette.id);

  return (
    <div className="pal">
      <span className="pal-label">Section colours</span>
      {all.map((p) => (
        <button
          key={p.id}
          className={`pal-chip${p.id === palette.id ? ' on' : ''}`}
          onClick={() => setPalette(p)}
          title={p.name}
          aria-pressed={p.id === palette.id}
        >
          {/* The palette shown as itself: four consecutive accents, which is the thing
              being chosen. A name alone would make this a guess. */}
          {[0, 1, 2, 3].map((i) => (
            <i key={i} style={{ background: accentFor(p, i) }} />
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
