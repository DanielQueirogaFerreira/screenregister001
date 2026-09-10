import { describe, expect, it } from 'vitest';
import {
  breadcrumbs, dirFor, isWithin, listDirectory, normaliseDir, parentOf,
} from './explorer.js';

const M: Record<string, number> = {
  'README.md': 100,
  '.gitignore': 10,
  'apps/web/src/App.tsx': 200,
  'apps/web/src/main.tsx': 50,
  'apps/web/index.html': 30,
  'apps/api/src/index.ts': 400,
  'apps/website/marketing.md': 70,
  'packages/core/src/diff.ts': 300,
  'scripts/bench/README.md': 20,
};

describe('listDirectory', () => {
  it('lists the root as folders first, then files, each alphabetical', () => {
    // The convention every file manager uses: containers before contents, so the shape of
    // a directory is visible before its detail.
    expect(listDirectory(M, '').map((e) => `${e.kind}:${e.name}`)).toEqual([
      'dir:apps', 'dir:packages', 'dir:scripts', 'file:.gitignore', 'file:README.md',
    ]);
  });

  it('lists one level only, not the whole subtree', () => {
    expect(listDirectory(M, 'apps').map((e) => e.name)).toEqual(['api', 'web', 'website']);
  });

  it('mixes folders and files at the same level correctly', () => {
    expect(listDirectory(M, 'apps/web').map((e) => `${e.kind}:${e.name}`))
      .toEqual(['dir:src', 'file:index.html']);
  });

  it('does not let one directory absorb another with the same prefix', () => {
    // Without the trailing slash on the prefix test, `apps/web` also matches
    // `apps/website` and a whole directory silently disappears into its neighbour.
    const web = listDirectory(M, 'apps/web');
    expect(web.map((e) => e.name)).not.toContain('marketing.md');
    expect(listDirectory(M, 'apps/website').map((e) => e.name)).toEqual(['marketing.md']);
  });

  it('sums bytes and counts files beneath a folder', () => {
    const apps = listDirectory(M, 'apps');
    const web = apps.find((e) => e.name === 'web')!;
    expect(web.files).toBe(3);
    expect(web.bytes).toBe(200 + 50 + 30);
  });

  it('reports a file as one file at its own size', () => {
    const readme = listDirectory(M, '').find((e) => e.name === 'README.md')!;
    expect(readme).toMatchObject({ kind: 'file', files: 1, bytes: 100, path: 'README.md' });
  });

  it('gives every entry a full path, not just a name', () => {
    // The path is what opens the file and what matches a node on the graph; a name alone
    // is ambiguous the moment two directories hold the same filename.
    expect(listDirectory(M, 'scripts/bench')[0]).toMatchObject({
      name: 'README.md', path: 'scripts/bench/README.md',
    });
  });

  it('tolerates a directory written with slashes around it', () => {
    expect(listDirectory(M, '/apps/web/')).toEqual(listDirectory(M, 'apps/web'));
  });

  it('returns nothing for a directory that does not exist, rather than throwing', () => {
    expect(listDirectory(M, 'nope/at/all')).toEqual([]);
  });

  it('returns nothing for a file path, which is not a directory', () => {
    expect(listDirectory(M, 'README.md')).toEqual([]);
  });

  it('handles an empty manifest', () => {
    expect(listDirectory({}, '')).toEqual([]);
  });

  it('sorts numerically, so 0002 does not come before 0010 by accident', () => {
    const m = { 'm/0002_b.sql': 1, 'm/0010_c.sql': 1, 'm/0001_a.sql': 1 };
    expect(listDirectory(m, 'm').map((e) => e.name))
      .toEqual(['0001_a.sql', '0002_b.sql', '0010_c.sql']);
  });
});

describe('parentOf', () => {
  it('goes up one level', () => {
    expect(parentOf('apps/web/src')).toBe('apps/web');
    expect(parentOf('apps')).toBe('');
  });

  it('has nowhere to go from the root', () => {
    expect(parentOf('')).toBeNull();
    expect(parentOf('/')).toBeNull();
  });
});

describe('breadcrumbs', () => {
  it('gives every level as somewhere you can return to in one tap', () => {
    expect(breadcrumbs('apps/web/src')).toEqual([
      { name: 'repo', path: '' },
      { name: 'apps', path: 'apps' },
      { name: 'web', path: 'apps/web' },
      { name: 'src', path: 'apps/web/src' },
    ]);
  });

  it('is just the root at the top', () => {
    expect(breadcrumbs('')).toEqual([{ name: 'repo', path: '' }]);
  });
});

describe('isWithin', () => {
  it('knows what is beneath a directory', () => {
    expect(isWithin('apps/web/src/App.tsx', 'apps/web')).toBe(true);
    expect(isWithin('apps/web', 'apps/web')).toBe(true);
    expect(isWithin('apps/website/x.md', 'apps/web')).toBe(false);
  });

  it('treats the root as containing everything', () => {
    expect(isWithin('anything/at/all', '')).toBe(true);
  });
});

describe('dirFor', () => {
  it('opens a folder as itself and a file as its parent', () => {
    // Opening a file's own path as a directory would list nothing and look broken.
    expect(dirFor('apps/web', false)).toBe('apps/web');
    expect(dirFor('apps/web/src/App.tsx', true)).toBe('apps/web/src');
  });

  it('opens a root-level file as the root', () => {
    expect(dirFor('README.md', true)).toBe('');
  });
});

describe('normaliseDir', () => {
  it('strips the slashes a breadcrumb or a URL may add', () => {
    expect(normaliseDir('/a/b/')).toBe('a/b');
    expect(normaliseDir('///')).toBe('');
    expect(normaliseDir('')).toBe('');
  });
});
