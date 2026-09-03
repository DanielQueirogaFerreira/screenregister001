#!/usr/bin/env node
/**
 * Keeps apps/api/.dev.vars supplied with the values local development needs.
 *
 * The Worker refuses to run without a signing key, and local development must not be the
 * reason someone reintroduces a hard-coded fallback. The file is gitignored and its key is
 * unique per machine, so it can never become a shared secret the way a checked-in default
 * would.
 *
 * Additive rather than create-only: a machine that already has a .dev.vars from an earlier
 * version would otherwise silently miss keys added later.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const target = join(dirname(fileURLToPath(import.meta.url)), '..', '.dev.vars');
const existing = existsSync(target) ? readFileSync(target, 'utf8') : '';

const wanted = [
  ['AUTH_SECRET', () => randomBytes(32).toString('hex')],
  // Local development is the one place a cross-origin dev client is legitimate: vite on
  // one port talking to wrangler on another. Production leaves this unset.
  ['ALLOW_LOCALHOST_ORIGINS', () => 'true'],
];

const missing = wanted.filter(([key]) => !new RegExp(`^\\s*${key}\\s*=`, 'm').test(existing));
if (missing.length === 0) process.exit(0);

const header = existing
  ? ''
  : '# Local development only. Gitignored, generated per machine.\n' +
    '# Production: wrangler secret put AUTH_SECRET\n';

writeFileSync(
  target,
  existing + header + missing.map(([k, v]) => `${k} = "${v()}"`).join('\n') + '\n',
  { mode: 0o600 },
);
console.log(`  .dev.vars: added ${missing.map(([k]) => k).join(', ')}`);
