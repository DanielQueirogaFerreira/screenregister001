#!/usr/bin/env node
/**
 * Checks the things that only fail once you are talking to Cloudflare.
 *
 * `wrangler deploy --dry-run` validates the bundle but never looks at whether the
 * bindings point at real resources, so an unedited `database_id` sails through the dry
 * run and then fails against the API with a message that does not mention the config
 * file. This turns that into a clear failure before the network is involved.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const configPath = join(here, '..', 'wrangler.toml');
const config = readFileSync(configPath, 'utf8');

const problems = [];
const notes = [];

const dbId = /^\s*database_id\s*=\s*"([^"]*)"/m.exec(config)?.[1] ?? '';
if (!dbId || dbId.startsWith('REPLACE_WITH')) {
  problems.push(
    `database_id in apps/api/wrangler.toml is still the placeholder ("${dbId}").\n` +
      '     Create the database and paste the id it prints:\n' +
      '       npx wrangler d1 create screenregister',
  );
} else if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(dbId)) {
  problems.push(
    `database_id does not look like a Cloudflare database id: "${dbId}".\n` +
      '     Expected a UUID, as printed by `wrangler d1 create screenregister`.',
  );
}

const bucket = /^\s*bucket_name\s*=\s*"([^"]*)"/m.exec(config)?.[1] ?? '';
if (!bucket) problems.push('No R2 bucket_name is configured in apps/api/wrangler.toml.');
else notes.push(`R2 bucket "${bucket}" must exist: npx wrangler r2 bucket create ${bucket}`);

notes.push(
  'AUTH_SECRET must be set as a secret, not a build variable:\n' +
    '       openssl rand -hex 32 | npx wrangler secret put AUTH_SECRET\n' +
    '     Without it the Worker falls back to a well-known development key.',
);

if (problems.length > 0) {
  console.error('\n  Deploy preflight failed:\n');
  for (const p of problems) console.error(`   ✘ ${p}\n`);
  console.error('  Full deploy steps: apps/api/README.md\n');
  process.exit(1);
}

console.log('  Deploy preflight passed. Before this succeeds, confirm:');
for (const n of notes) console.log(`   · ${n}`);
console.log('');
