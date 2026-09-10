/**
 * Walking the repository as folders and files.
 *
 * The graph answers "what has been happening". This answers the other half — "what is
 * actually in here" — because a directory node on the graph is a hub with no contents you
 * can read, and the thing anyone wants from clicking `packages/core` is to look inside it.
 *
 * It reads the build's own file manifest rather than the evolution log's path list, and
 * that distinction matters: the log holds only what was touched inside the window, so a
 * file nobody has edited for two months is absent from it while being very much present in
 * the directory. An explorer built on the log would quietly show an incomplete tree, which
 * is worse than showing none.
 */

export type EntryKind = 'dir' | 'file';

export interface Entry {
  name: string;
  /** Full repository-relative path. */
  path: string;
  kind: EntryKind;
  /** Bytes for a file; the sum beneath for a directory. */
  bytes: number;
  /** Files beneath, for a directory. 1 for a file. */
  files: number;
}

/** Strip the leading and trailing slashes a path may pick up from a breadcrumb or a URL. */
export const normaliseDir = (dir: string): string => dir.replace(/^\/+|\/+$/g, '');

/**
 * One level of the tree, folders first then files, each alphabetical.
 *
 * The convention every file manager uses, and worth following rather than inventing:
 * containers before contents, so the shape of a directory is visible before its detail.
 */
export function listDirectory(manifest: Record<string, number>, dir: string): Entry[] {
  const base = normaliseDir(dir);
  // The trailing slash is not tidiness. Without it `apps/web` also matches
  // `apps/website`, and a whole directory is silently absorbed into its neighbour.
  const prefix = base === '' ? '' : `${base}/`;

  const dirs = new Map<string, { bytes: number; files: number }>();
  const files: Entry[] = [];

  for (const [path, bytes] of Object.entries(manifest)) {
    if (prefix !== '' && !path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    if (rest === '') continue;
    const slash = rest.indexOf('/');
    if (slash === -1) {
      files.push({ name: rest, path, kind: 'file', bytes, files: 1 });
      continue;
    }
    const name = rest.slice(0, slash);
    const acc = dirs.get(name) ?? { bytes: 0, files: 0 };
    acc.bytes += bytes;
    acc.files += 1;
    dirs.set(name, acc);
  }

  const byName = (a: Entry, b: Entry) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

  const dirEntries: Entry[] = [...dirs.entries()].map(([name, acc]) => ({
    name,
    path: prefix + name,
    kind: 'dir' as const,
    bytes: acc.bytes,
    files: acc.files,
  }));

  return [...dirEntries.sort(byName), ...files.sort(byName)];
}

/** The path one level up, or null at the root. */
export function parentOf(path: string): string | null {
  const p = normaliseDir(path);
  if (p === '') return null;
  const slash = p.lastIndexOf('/');
  return slash === -1 ? '' : p.slice(0, slash);
}

export interface Crumb { name: string; path: string }

/**
 * The trail back up, root first.
 *
 * Every segment is a place you can return to in one tap. Breadcrumbs are the cheapest
 * orientation a hierarchy can offer, and without them a few levels down is somewhere you
 * can only leave by repeatedly going up.
 */
export function breadcrumbs(path: string, rootLabel = 'repo'): Crumb[] {
  const p = normaliseDir(path);
  const out: Crumb[] = [{ name: rootLabel, path: '' }];
  if (p === '') return out;
  let acc = '';
  for (const seg of p.split('/')) {
    acc = acc === '' ? seg : `${acc}/${seg}`;
    out.push({ name: seg, path: acc });
  }
  return out;
}

/** True when `path` is `dir` itself or sits beneath it. */
export function isWithin(path: string, dir: string): boolean {
  const d = normaliseDir(dir);
  if (d === '') return true;
  return path === d || path.startsWith(`${d}/`);
}

/**
 * The directory to open for a node that was selected on the graph.
 *
 * Selecting a folder should list that folder; selecting a file should list the folder it
 * lives in, with the file visible in it. Opening a file's own path as a directory would
 * list nothing and look broken.
 */
export function dirFor(path: string, isFile: boolean): string {
  return isFile ? (parentOf(path) ?? '') : normaliseDir(path);
}
