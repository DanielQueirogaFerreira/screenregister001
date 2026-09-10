import { useEffect, useMemo, useRef } from 'react';
import { breadcrumbs, listDirectory, parentOf, type Entry } from '@sr/core';
import { fileKind } from '../lib/evolution-palette.js';

/**
 * The repository as folders and files, beside the graph rather than instead of it.
 *
 * A directory node on the graph is a hub with no readable contents, and what anyone wants
 * from clicking `packages/core` is to look inside. This is that — one level at a time, with
 * breadcrumbs back up, in the order every file manager uses: folders before files, each
 * alphabetical, so the shape of a directory is visible before its detail.
 *
 * It is a drawer over one side of the scene and not a page of its own, for a reason the
 * request named: walking into a folder moves the camera to that element, and you should be
 * able to watch it happen. A full-screen list would hide the very thing it is steering.
 *
 * Opening a file from here does not leave here. The file viewer stacks on top and closing
 * it puts you back on the same row of the same folder, which is what makes browsing feel
 * like browsing rather than a series of round trips.
 */

export interface ExplorerProps {
  manifest: Record<string, number>;
  /** Directory currently listed. '' is the repository root. */
  dir: string;
  /** Where the navigator was opened from, to offer the way back. */
  entry: { dir: string; label: string } | null;
  /** Path of the file open in the viewer, if any — shown as the current row. */
  openFile: string | null;
  /** Path of the node currently selected on the graph. */
  selected: string | null;
  /** True when this path is a node on the graph and can be travelled to. */
  onGraph: (path: string) => boolean;
  onNavigate: (dir: string) => void;
  onOpenFile: (path: string) => void;
  onReturn: () => void;
  onClose: () => void;
}

const kb = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`);

export function Explorer({
  manifest, dir, entry, openFile, selected, onGraph, onNavigate, onOpenFile, onReturn, onClose,
}: ExplorerProps) {
  const entries = useMemo(() => listDirectory(manifest, dir), [manifest, dir]);
  const crumbs = useMemo(() => breadcrumbs(dir), [dir]);
  const up = parentOf(dir);
  const list = useRef<HTMLUListElement>(null);

  // Escape closes, as it does for every other overlay on this page. Not captured when the
  // file viewer is on top — that one wants the key first, and it has its own handler.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !openFile) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, openFile]);

  /**
   * Up and down the list with the arrow keys, into a folder with Enter.
   *
   * Roving focus over real buttons rather than a synthetic selection: the browser keeps
   * the focus ring, screen readers announce each row, and Tab still works. Arrow keys are
   * what anyone reaches for in a file list.
   */
  const onKeyDown = (e: React.KeyboardEvent<HTMLUListElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const rows = Array.from(list.current?.querySelectorAll<HTMLButtonElement>('button.xp-row') ?? []);
    const here = rows.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === 'ArrowDown'
      ? Math.min(rows.length - 1, here + 1)
      : Math.max(0, here <= 0 ? 0 : here - 1);
    rows[next]?.focus();
    e.preventDefault();
  };

  return (
    <aside className="xp" aria-label="Files and folders">
      <div className="xp-head">
        <b>Files</b>
        <span className="xp-count">
          {entries.length} item{entries.length === 1 ? '' : 's'}
        </span>
        <button onClick={onClose} className="xp-close" aria-label="Close the file navigator">×</button>
      </div>

      {/* Every level is one tap away. Breadcrumbs are the cheapest orientation a hierarchy
          can offer, and without them a few levels down is somewhere you can only leave by
          repeatedly going up. */}
      <nav className="xp-crumbs" aria-label="Path">
        {crumbs.map((c, i) => (
          <span key={c.path}>
            {i > 0 && <i aria-hidden="true">/</i>}
            <button
              className={c.path === dir ? 'on' : ''}
              onClick={() => onNavigate(c.path)}
              aria-current={c.path === dir ? 'location' : undefined}
            >
              {c.name}
            </button>
          </span>
        ))}
      </nav>

      {/*
        The way back to wherever the navigator was opened from.
        Browsing moves the graph's selection and the camera, so without this the trip has no
        return leg — you would have to remember which dot you came from and find it again.
      */}
      {entry && (entry.dir !== dir || selected !== null) && (
        <button className="xp-return" onClick={onReturn}>
          ↩ Back to <b>{entry.label}</b>
        </button>
      )}

      <ul className="xp-list" ref={list} onKeyDown={onKeyDown}>
        {up !== null && (
          <li>
            <button className="xp-row xp-up" onClick={() => onNavigate(up)}>
              <span className="xp-icon" aria-hidden="true">↰</span>
              <span className="xp-name">..</span>
            </button>
          </li>
        )}
        {entries.length === 0 && (
          <li className="xp-empty">Nothing in this folder.</li>
        )}
        {entries.map((e) => (
          <Row
            key={e.path}
            entry={e}
            current={e.path === openFile || e.path === selected}
            onGraph={onGraph(e.path)}
            onOpen={() => (e.kind === 'dir' ? onNavigate(e.path) : onOpenFile(e.path))}
          />
        ))}
      </ul>

      <p className="xp-note">
        A dot beside a name means it is on the graph — walking into it takes the camera
        there. Files with no dot exist but were not touched inside the window.
      </p>
    </aside>
  );
}

function Row({
  entry, current, onGraph, onOpen,
}: { entry: Entry; current: boolean; onGraph: boolean; onOpen: () => void }) {
  const dir = entry.kind === 'dir';
  const colour = dir ? '#8a99ad' : fileKind(entry.name).colour;
  return (
    <li>
      <button
        className={`xp-row${current ? ' current' : ''}`}
        onClick={onOpen}
        title={entry.path}
        aria-current={current ? 'true' : undefined}
      >
        <span className="xp-icon" aria-hidden="true">{dir ? '▸' : '·'}</span>
        {/* The same colour the dot has on the graph, so a name here and a dot there are
            recognisably the same thing. */}
        <i className="xp-swatch" style={{ background: colour }} aria-hidden="true" />
        <span className="xp-name">{entry.name}</span>
        {onGraph && <i className="xp-ongraph" title="On the graph" aria-hidden="true" />}
        <span className="xp-size">
          {dir ? `${entry.files} file${entry.files === 1 ? '' : 's'}` : kb(entry.bytes)}
        </span>
      </button>
    </li>
  );
}
