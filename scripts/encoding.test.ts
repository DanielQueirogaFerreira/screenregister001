import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Guards every tracked text file against the encoding bug that broke the Pages build.
 *
 * The README had been written as UTF-16LE with no byte-order mark. The subtle part, and
 * the reason a plain "is it valid UTF-8" check is not enough on its own: UTF-16LE ASCII
 * is ordinary characters interleaved with NUL bytes, and NUL is a perfectly legal UTF-8
 * byte. So the file decoded cleanly for 3457 bytes and only blew up at the first
 * genuinely non-ASCII character — a box-drawing arrow far down the file.
 *
 * Hence two assertions, not one: the bytes must decode as UTF-8, AND must contain no NUL,
 * which is what actually catches a UTF-16 file masquerading as ASCII.
 */

const BINARY_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'bmp',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'zip', 'gz', 'tgz', 'br', 'pdf', 'mp4', 'webm', 'mp3', 'wav',
  'wasm', 'node', 'so', 'dylib', 'dll', 'exe',
]);

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

const trackedTextFiles = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean)
  .filter((f) => !BINARY_EXT.has(f.split('.').pop()?.toLowerCase() ?? ''));

describe('tracked files are UTF-8 text', () => {
  it('finds files to check', () => {
    expect(trackedTextFiles.length).toBeGreaterThan(10);
  });

  it.each(trackedTextFiles)('%s', (file) => {
    const buf = readFileSync(join(repoRoot, file));

    const nul = buf.indexOf(0);
    expect(
      nul,
      `${file} contains a NUL byte at offset ${nul}. That almost always means the file is ` +
        'UTF-16 or UTF-32 rather than UTF-8. Re-encode it as UTF-8.',
    ).toBe(-1);

    expect(() => new TextDecoder('utf-8', { fatal: true }).decode(buf), `${file} is not valid UTF-8`)
      .not.toThrow();

    expect(
      buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf,
      `${file} starts with a UTF-8 byte-order mark; strip it.`,
    ).toBe(false);
  });
});
