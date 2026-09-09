import { describe, expect, it } from 'vitest';
import {
  ACTION_COLOUR, ACTION_LABEL, FILE_KINDS, fileColour, fileKind,
} from './evolution-palette.js';

/**
 * These are all one test really: the legend must be a true and complete account of what
 * the canvas draws. It was neither — config files were amber on the graph and absent from
 * the legend — and the cause was two hardcoded lists that nothing checked against each
 * other.
 */
describe('the legend accounts for every colour on the graph', () => {
  it('gives every file kind a legend entry with a label and a hint', () => {
    for (const k of FILE_KINDS) {
      expect(k.label, k.id).toBeTruthy();
      expect(k.hint, k.id).toBeTruthy();
      expect(k.colour, k.id).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('gives every action swatch a word, so none is drawn unexplained', () => {
    for (const code of Object.keys(ACTION_COLOUR)) {
      expect(ACTION_LABEL[code], code).toBeTruthy();
    }
    // And nothing labelled that is never drawn — a legend entry for a colour the canvas
    // cannot produce is the same defect pointing the other way.
    for (const code of Object.keys(ACTION_LABEL)) {
      expect(ACTION_COLOUR[code], code).toBeTruthy();
    }
  });

  it('has no two kinds sharing a colour', () => {
    const colours = FILE_KINDS.map((k) => k.colour);
    expect(new Set(colours).size).toBe(colours.length);
  });

  it('never colours a file at rest the same as an action', () => {
    // The bug this is for: .sql at rest was #35c98b, byte-identical to "added". A
    // migration file sitting untouched looked exactly like one that had just appeared.
    const actions = new Set(Object.values(ACTION_COLOUR));
    for (const k of FILE_KINDS) expect(actions.has(k.colour), k.id).toBe(false);
  });
});

describe('fileKind', () => {
  it('reaches every kind, so no legend entry is dead', () => {
    // A legend row for a colour nothing can ever be is as misleading as a missing one.
    const samples = [
      'apps/web/src/App.tsx', 'packages/core/src/diff.ts', 'scripts/x.mjs',
      'apps/web/src/styles.css', 'apps/web/index.html',
      '.github/workflows/deploy.yml', 'package.json', 'apps/api/wrangler.toml',
      'apps/api/migrations/0001_init.sql',
      'README.md', '.gitignore', 'LICENSE',
    ];
    const reached = new Set(samples.map((p) => fileKind(p).id));
    expect([...reached].sort()).toEqual(FILE_KINDS.map((k) => k.id).sort());
  });

  it('puts the files this repository is actually made of where you would expect', () => {
    expect(fileKind('a.tsx').id).toBe('code');
    expect(fileKind('a.ts').id).toBe('code');
    expect(fileKind('a.css').id).toBe('code');
    expect(fileKind('deploy.yml').id).toBe('config');
    expect(fileKind('package.json').id).toBe('config');
    expect(fileKind('wrangler.toml').id).toBe('config');
    expect(fileKind('0001_init.sql').id).toBe('schema');
    expect(fileKind('README.md').id).toBe('other');
  });

  it('always answers, whatever the path looks like', () => {
    // fileColour runs inside the draw loop on every node of every frame. An undefined
    // here is a canvas that throws sixty times a second.
    for (const p of ['', '.', 'no-extension', 'a.', 'weird.ZZZ', 'dir.ts/file', 'a.tsx.bak']) {
      expect(fileColour(p), p).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('matches on the extension, not anywhere in the path', () => {
    // "dir.ts/file" has no extension of its own; a loose regex would call it code.
    expect(fileKind('dir.ts/file').id).toBe('other');
    expect(fileKind('a.tsx.bak').id).toBe('other');
  });

  it('is case-insensitive about extensions', () => {
    // A `Deploy.YML` or a `.SQL` dump fell through to the grey "everything else" slot
    // before this, so a config file was drawn as a document.
    expect(fileKind('Deploy.YML').id).toBe('config');
    expect(fileKind('Styles.CSS').id).toBe('code');
    expect(fileKind('0001_Init.SQL').id).toBe('schema');
  });
});
