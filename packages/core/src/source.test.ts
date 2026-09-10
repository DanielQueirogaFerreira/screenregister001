import { describe, expect, it } from 'vitest';
import {
  hasPreview, highlight, highlightLines, langFor, measure, parseInline, parseMarkdown,
  prettyJson, safeHref, viewerFor,
} from './source.js';

describe('viewerFor', () => {
  it('shows each file the way that file wants to be seen', () => {
    expect(viewerFor('apps/web/index.html')).toBe('html');
    expect(viewerFor('icon.svg')).toBe('svg');
    expect(viewerFor('shot.png')).toBe('image');
    expect(viewerFor('README.md')).toBe('markdown');
    expect(viewerFor('package.json')).toBe('json');
    expect(viewerFor('src/App.tsx')).toBe('code');
    expect(viewerFor('.gitignore')).toBe('code');
  });

  it('does not care about case', () => {
    expect(viewerFor('INDEX.HTML')).toBe('html');
    expect(viewerFor('Readme.MD')).toBe('markdown');
  });

  it('offers a second view only where there is one worth having', () => {
    expect(hasPreview('html')).toBe(true);
    expect(hasPreview('markdown')).toBe(true);
    expect(hasPreview('code')).toBe(false);
    expect(hasPreview('json')).toBe(false);
  });
});

describe('langFor', () => {
  it('recognises what this repository is made of', () => {
    expect(langFor('a.ts')).toBe('ts');
    expect(langFor('a.tsx')).toBe('ts');
    expect(langFor('a.mjs')).toBe('ts');
    expect(langFor('a.css')).toBe('css');
    expect(langFor('0001_init.sql')).toBe('sql');
    expect(langFor('deploy.yml')).toBe('yaml');
    expect(langFor('wrangler.toml')).toBe('yaml');
    expect(langFor('package.json')).toBe('json');
    expect(langFor('.gitignore')).toBe('shell');
    expect(langFor('LICENSE')).toBe('plain');
  });
});

describe('highlight', () => {
  const kinds = (code: string, lang: Parameters<typeof highlight>[1]) =>
    highlight(code, lang).map((t) => `${t.kind}:${t.text}`);

  it('never loses or invents a character', () => {
    // The property that matters most: the view is the file. A highlighter that drops a
    // character shows something that is not what is on disk, which is worse than no colour.
    const samples = [
      `const a = "hi"; // note\n/* block */\nfunction f() { return 1.5 }`,
      `SELECT * FROM frames WHERE id = 'x' -- trailing`,
      `# yaml\nkey: "value"\nlist:\n  - 1\n`,
      `body { color: #fff; /* white */ }`,
      `it's an unterminated apostrophe in prose`,
      '',
      'no tokens at all',
      '`template ${with} parts`',
    ];
    for (const s of samples) {
      for (const lang of ['ts', 'sql', 'yaml', 'css', 'plain'] as const) {
        expect(highlight(s, lang).map((t) => t.text).join(''), `${lang}: ${s}`).toBe(s);
      }
    }
  });

  it('finds line comments and block comments', () => {
    expect(kinds('a // b', 'ts')).toContain('comment:// b');
    expect(kinds('/* x */ a', 'ts')).toContain('comment:/* x */');
    expect(kinds('-- note', 'sql')).toContain('comment:-- note');
    expect(kinds('# note', 'yaml')).toContain('comment:# note');
  });

  it('finds strings, including escapes', () => {
    expect(kinds('"a\\"b"', 'ts')).toContain('string:"a\\"b"');
    expect(kinds("'x'", 'ts')).toContain("string:'x'");
  });

  it('does not let a stray apostrophe swallow the rest of the file', () => {
    // Apostrophes in prose and comments are everywhere. An unterminated single quote that
    // ran to end-of-file would grey out everything after it.
    const src = "const a = 1; // it's fine\nconst b = 2;";
    const toks = highlight(src, 'ts');
    expect(toks.map((t) => t.text).join('')).toBe(src);
    expect(toks.some((t) => t.kind === 'keyword' && t.text === 'const')).toBe(true);
    // The second const, after the apostrophe, must still be found.
    expect(toks.filter((t) => t.kind === 'keyword' && t.text === 'const')).toHaveLength(2);
  });

  it('lets a template literal span lines, because it may', () => {
    const src = '`line one\nline two`';
    expect(highlight(src, 'ts')).toEqual([{ text: src, kind: 'string' }]);
  });

  it('is case-insensitive for SQL and case-sensitive for TypeScript', () => {
    expect(kinds('SELECT', 'sql')).toContain('keyword:SELECT');
    expect(kinds('select', 'sql')).toContain('keyword:select');
    expect(kinds('CONST x', 'ts')).not.toContain('keyword:CONST');
  });

  it('does not mistake part of an identifier for a keyword or a number', () => {
    expect(kinds('constant', 'ts')).toEqual(['plain:constant']);
    expect(kinds('a1b', 'ts')).toEqual(['plain:a1b']);
  });

  it('runs an unterminated block comment to the end rather than throwing', () => {
    const src = '/* never closed';
    expect(highlight(src, 'ts')).toEqual([{ text: src, kind: 'comment' }]);
  });
});

describe('highlightLines', () => {
  it('gives one entry per line, so the view can number them', () => {
    expect(highlightLines('a\nb\nc', 'plain')).toHaveLength(3);
    // A trailing newline means a final empty line exists, exactly as an editor shows it.
    expect(highlightLines('a\n', 'plain')).toHaveLength(2);
    expect(highlightLines('', 'plain')).toHaveLength(1);
  });

  it('splits a multi-line token across lines without losing it', () => {
    const lines = highlightLines('/* one\ntwo */', 'ts');
    expect(lines).toHaveLength(2);
    expect(lines.flat().map((t) => t.text).join('\n')).toBe('/* one\ntwo */');
    expect(lines[1]![0]!.kind).toBe('comment');
  });
});

describe('prettyJson', () => {
  it('formats what parses', () => {
    expect(prettyJson('{"a":1}')).toEqual({ text: '{\n  "a": 1\n}', ok: true });
  });

  it('hands back what does not, rather than swallowing it', () => {
    // A JSON file that will not parse is a fact worth seeing, not an error to hide.
    const bad = '{ oops';
    expect(prettyJson(bad)).toEqual({ text: bad, ok: false });
  });
});

describe('safeHref', () => {
  it('allows the schemes a document page can follow', () => {
    expect(safeHref('https://example.com')).toBe('https://example.com');
    expect(safeHref('http://example.com')).toBe('http://example.com');
    expect(safeHref('mailto:a@b.c')).toBe('mailto:a@b.c');
    expect(safeHref('./local.md')).toBe('./local.md');
    expect(safeHref('#anchor')).toBe('#anchor');
  });

  it('refuses the ones that execute', () => {
    // The oldest injection in the format, and this renderer shows whatever lands in the
    // repository next.
    expect(safeHref('javascript:alert(1)')).toBeUndefined();
    expect(safeHref('JavaScript:alert(1)')).toBeUndefined();
    expect(safeHref('  javascript:alert(1)')).toBeUndefined();
    expect(safeHref('data:text/html,<script>')).toBeUndefined();
    expect(safeHref('vbscript:x')).toBeUndefined();
    expect(safeHref('//evil.example')).toBeUndefined();
  });
});

describe('parseInline', () => {
  it('finds code, bold, italic and links', () => {
    expect(parseInline('a `b` c')).toEqual([
      { text: 'a ' }, { text: 'b', code: true }, { text: ' c' },
    ]);
    expect(parseInline('**bold**')).toEqual([{ text: 'bold', strong: true }]);
    expect(parseInline('_em_')).toEqual([{ text: 'em', em: true }]);
    expect(parseInline('[t](https://x.dev)')).toEqual([{ text: 't', href: 'https://x.dev' }]);
  });

  it('keeps the text of a refused link and drops only the link', () => {
    expect(parseInline('[click](javascript:alert(1))')).toEqual([{ text: 'click' }]);
  });

  it('leaves unmatched markers as literal text', () => {
    expect(parseInline('a `unclosed').map((s) => s.text).join('')).toBe('a `unclosed');
  });

  it('does not turn arithmetic into italics', () => {
    // `2 * 3 * 4` became "2 <em> 3 </em> 4" — a naive renderer mangling exactly the content
    // someone opened the file to read. Emphasis may not begin or end on a space.
    const spans = parseInline('2 * 3 * 4');
    expect(spans.map((s) => s.text).join('')).toBe('2 * 3 * 4');
    expect(spans.some((s) => s.em || s.strong)).toBe(false);
  });

  it('leaves underscores inside identifiers alone', () => {
    const spans = parseInline('call some_var_name now');
    expect(spans.map((s) => s.text).join('')).toBe('call some_var_name now');
    expect(spans.some((s) => s.em)).toBe(false);
  });

  it('keeps emphasis that is properly formed', () => {
    expect(parseInline('a *b* c')).toEqual([
      { text: 'a ' }, { text: 'b', em: true }, { text: ' c' },
    ]);
  });

  it('reads a URL containing brackets without leaving a stray one behind', () => {
    // The regex stopped at the first ")" and left the rest as text.
    expect(parseInline('[t](https://x.dev/a_(b)_c)')).toEqual([
      { text: 't', href: 'https://x.dev/a_(b)_c' },
    ]);
  });
});

describe('parseMarkdown', () => {
  it('reads a small README', () => {
    const blocks = parseMarkdown([
      '# Title', '', 'A paragraph', 'wrapped over lines.', '',
      '## Two', '', '- one', '- two', '', '```ts', 'const a = 1;', '```', '',
      '> quoted', '', '---',
    ].join('\n'));
    expect(blocks.map((b) => b.kind)).toEqual([
      'heading', 'para', 'heading', 'list', 'code', 'quote', 'rule',
    ]);
    expect(blocks[0]).toMatchObject({ level: 1 });
    // A wrapped paragraph is one paragraph, joined with a space.
    expect((blocks[1] as { spans: { text: string }[] }).spans[0]!.text)
      .toBe('A paragraph wrapped over lines.');
    expect(blocks[4]).toMatchObject({ kind: 'code', lang: 'ts', text: 'const a = 1;' });
  });

  it('keeps a fenced block literal, markers and all', () => {
    // Code inside a fence is not markdown. Parsing it would mangle exactly the content
    // someone opened the file to read.
    const b = parseMarkdown('```\n# not a heading\n- not a list\n**not bold**\n```')[0];
    expect(b).toEqual({ kind: 'code', lang: '', text: '# not a heading\n- not a list\n**not bold**' });
  });

  it('does not join a numbered list onto a bulleted one', () => {
    const kinds = parseMarkdown('- a\n- b\n1. c\n2. d').filter((b) => b.kind === 'list');
    expect(kinds).toHaveLength(2);
    expect(kinds[0]).toMatchObject({ ordered: false });
    expect(kinds[1]).toMatchObject({ ordered: true });
  });

  it('survives an unclosed fence rather than dropping the rest of the file', () => {
    const b = parseMarkdown('```ts\nconst a = 1;');
    expect(b).toEqual([{ kind: 'code', lang: 'ts', text: 'const a = 1;' }]);
  });

  it('handles an empty file and one that is only blank lines', () => {
    expect(parseMarkdown('')).toEqual([]);
    expect(parseMarkdown('\n\n  \n')).toEqual([]);
  });

  it('reads CRLF the same as LF', () => {
    expect(parseMarkdown('# a\r\n\r\nb\r\n')).toEqual(parseMarkdown('# a\n\nb\n'));
  });
});

describe('measure', () => {
  it('counts lines the way an editor does', () => {
    expect(measure('a\nb')).toEqual({ lines: 2, chars: 3 });
    expect(measure('a\n')).toEqual({ lines: 2, chars: 2 });
    expect(measure('')).toEqual({ lines: 0, chars: 0 });
  });
});
