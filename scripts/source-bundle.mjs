#!/usr/bin/env node
/**
 * Copy the repository's own tracked files into the build, so the codebase viewer can show
 * what is inside a node instead of only what has happened to it.
 *
 * One asset per file rather than one bundle of all of them. A single JSON keyed by path
 * would mean downloading a megabyte to read one file; this way opening `App.tsx` fetches
 * `App.tsx` and nothing else. Requests to static assets are free and unlimited on
 * Cloudflare, and wrangler uploads by content hash, so a deploy re-uploads only what
 * actually changed.
 *
 * This publishes the source at the Worker's origin, which is safe here for one specific
 * reason and it is worth writing down: the repository is public and already served
 * unauthenticated by raw.githubusercontent.com, so nothing new is exposed. **If this
 * repository is ever made private, this step must be removed or moved behind the auth
 * gate** — /evolution is deliberately outside it.
 *
 * Usage: node scripts/source-bundle.mjs [--out apps/web/dist/source]
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, copyFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const OUT = arg('out', 'apps/web/dist/source');

/**
 * Left out on purpose.
 *
 * Lockfiles are thousands of generated lines nobody reads and would be a third of the
 * bundle on their own; `.dev.vars` is where local secrets live and must never be published
 * even by accident, so it is refused here as well as being gitignored. The same list keeps
 * these paths off the evolution graph — see scripts/evolution-log.mjs.
 */
const SKIP = [
  /^pnpm-lock\.yaml$/,
  /^package-lock\.json$/,
  /(^|\/)dist\//,
  /(^|\/)node_modules\//,
  /(^|\/)\.dev\.vars$/,
  /(^|\/)\.env$/,
];

/** Anything bigger than this is not something a viewer should try to paint. */
const MAX_BYTES = 512 * 1024;

const files = execFileSync('git', ['ls-tree', '-r', '--name-only', 'HEAD'], {
  encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
})
  .split('\n')
  .map((s) => s.trim())
  .filter((p) => p && !SKIP.some((re) => re.test(p)));

const manifest = {};
let copied = 0;
let bytes = 0;
let skipped = 0;

for (const path of files) {
  let size;
  try {
    size = statSync(path).size;
  } catch {
    // In the tree but not on disk. A submodule, or a checkout that did not include it.
    continue;
  }
  if (size > MAX_BYTES) { skipped++; continue; }
  const dest = join(OUT, path);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(path, dest);
  manifest[path] = size;
  copied++;
  bytes += size;
}

// The manifest exists so the viewer knows a file is there, and how big, before fetching
// it — a "view content" button that leads to a 404 is worse than no button.
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest));

process.stderr.write(
  `source: ${copied} files, ${(bytes / 1024).toFixed(1)} KB -> ${OUT}` +
  `${skipped ? ` (${skipped} over ${MAX_BYTES / 1024} KB skipped)` : ''}\n`,
);
