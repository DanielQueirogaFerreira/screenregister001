#!/usr/bin/env node
/**
 * Generates apps/api/.dev.vars with a random AUTH_SECRET if it does not exist.
 *
 * The Worker refuses to run without a signing key, and local development must not be the
 * reason someone reintroduces a hard-coded fallback. The file is gitignored and the key is
 * unique per machine, so it can never become a shared secret the way a checked-in default
 * would.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const target = join(dirname(fileURLToPath(import.meta.url)), '..', '.dev.vars');
if (existsSync(target)) process.exit(0);

writeFileSync(
  target,
  `# Local development only. Gitignored, generated per machine.\n` +
    `# Production uses: wrangler secret put AUTH_SECRET\n` +
    `AUTH_SECRET = "${randomBytes(32).toString('hex')}"\n`,
  { mode: 0o600 },
);
console.log('  Generated apps/api/.dev.vars with a fresh AUTH_SECRET.');
