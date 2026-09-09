#!/usr/bin/env node
/**
 * Turn git history into the file the "Codebase Evolution" view animates.
 *
 * This exists instead of a Gource video, and the reason is storage and honesty rather than
 * taste. A Gource render of this repository is tens of megabytes of MP4 that has to live
 * somewhere: committed, and every daily regeneration adds another multi-megabyte blob to
 * git history permanently; or uploaded to R2, where it competes for the same free tier the
 * recordings need. This file is a few hundred kilobytes of text, it is rebuilt from scratch
 * on every deploy so it can never go stale, and nothing about it accumulates.
 *
 * It is also strictly more useful. A video can only be watched. This can be scrubbed,
 * paused on the commit you care about, and read — the renderer knows which file each dot
 * is, so hovering names it.
 *
 * The format is Gource's own model — (timestamp, author, action, path) — interned, because
 * the same few hundred paths and handful of authors repeat across every commit and writing
 * them out in full is most of the bytes.
 *
 * Usage: node scripts/evolution-log.mjs [--days 30] [--out apps/web/dist/evolution.json]
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const DAYS = Number(arg('days', '30'));
const OUT = arg('out', 'apps/web/dist/evolution.json');

/**
 * Paths whose churn says nothing about the shape of the codebase.
 *
 * A lockfile changes on every dependency bump and is thousands of lines nobody reads; the
 * generated log itself would appear as a file that changes on every single deploy, which
 * is both untrue of the source and the loudest node on the graph.
 */
const IGNORE = [
  /^pnpm-lock\.yaml$/,
  /^package-lock\.json$/,
  /(^|\/)dist\//,
  /(^|\/)node_modules\//,
  /^apps\/web\/public\/evolution\.json$/,
];

const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

/**
 * `%x00` field separators rather than a printable one. Commit subjects are written by
 * people and by me, and one containing a pipe or a tab would otherwise split a record into
 * the wrong number of fields — a parser that is correct for the messages written so far and
 * silently wrong for the next one.
 */
const FORMAT = '%H%x00%at%x00%an%x00%s';

function readCommits(days) {
  const raw = git(
    'log',
    `--since=${days} days ago`,
    '--no-merges',
    '--reverse',
    '--name-status',
    // Renames become a delete plus an add, which is what the animation should show: the
    // file leaves one directory and appears in another.
    '--no-renames',
    `--format=%x01${FORMAT}`,
  );

  const out = [];
  let current = null;
  for (const line of raw.split('\n')) {
    if (line.startsWith('\x01')) {
      if (current) out.push(current);
      const [sha, at, author, subject] = line.slice(1).split('\x00');
      current = { sha, at: Number(at), author, subject: subject ?? '', files: [] };
      continue;
    }
    if (!current || line === '') continue;
    // "A\tpath", "M\tpath", "D\tpath". Status letters can carry a score (R100); the first
    // character is the action.
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const action = line[0];
    const path = line.slice(tab + 1).trim();
    if (!path || IGNORE.some((re) => re.test(path))) continue;
    if (action !== 'A' && action !== 'M' && action !== 'D') continue;
    current.files.push([action, path]);
  }
  if (current) out.push(current);
  // A commit that only touched ignored paths carries no motion; keeping it would show a
  // beat where nothing happens and make the timeline look emptier than the work was.
  return out.filter((c) => c.files.length > 0);
}

const commits = readCommits(DAYS);

// Intern in first-seen order, so the arrays are stable between runs for the history that
// has not changed and a diff of this file shows only what is genuinely new.
const paths = [];
const pathIndex = new Map();
const authors = [];
const authorIndex = new Map();
const intern = (list, index, value) => {
  let i = index.get(value);
  if (i === undefined) {
    i = list.length;
    list.push(value);
    index.set(value, i);
  }
  return i;
};

/**
 * One person, one node on the graph.
 *
 * This history contains "Daniel Queiroga Ferreira" and "DanielQueirogaFerreira" — the same
 * human, committing from two machines with two git identities. Showing them as two
 * contributors would be wrong in the one place the view makes a factual claim. Merged on
 * the name with spacing and punctuation removed, which is the difference here; emails are
 * deliberately not used as the key, because this file is served publicly and a contributor
 * list is not a reason to publish anyone's address.
 */
const authorKey = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, '');
const canonical = new Map();
for (const c of commits) {
  const k = authorKey(c.author);
  const seen = canonical.get(k);
  // Prefer the spaced form: it is the one a person would write down.
  if (!seen || c.author.includes(' ') && !seen.includes(' ')) canonical.set(k, c.author);
}

const events = commits.map((c) => ({
  t: c.at,
  a: intern(authors, authorIndex, canonical.get(authorKey(c.author)) ?? c.author),
  s: c.sha.slice(0, 7),
  m: c.subject.slice(0, 120),
  f: c.files.map(([action, path]) => [intern(paths, pathIndex, path), action]),
}));

/**
 * Files that survive to HEAD, so the graph can show what is there now in full colour and
 * what has been deleted as a node that faded out. Taken from the tree rather than inferred
 * by replaying adds and deletes: a file created before the window opened has no A event in
 * this log and would otherwise be indistinguishable from one that never existed.
 */
const alive = new Set(
  git('ls-tree', '-r', '--name-only', 'HEAD')
    .split('\n')
    .map((s) => s.trim())
    .filter((p) => p && !IGNORE.some((re) => re.test(p))),
);

const head = commits[commits.length - 1] ?? null;

const doc = {
  generated_at: new Date().toISOString(),
  window_days: DAYS,
  /** Seconds, matching `t` on every event, so the client never mixes two time units. */
  since: events[0]?.t ?? null,
  until: events[events.length - 1]?.t ?? null,
  head: head ? { sha: head.sha.slice(0, 7), at: head.at, subject: head.subject } : null,
  authors,
  paths,
  /** 1 if the path exists at HEAD, 0 if it has since been deleted. Indexed like `paths`. */
  alive: paths.map((p) => (alive.has(p) ? 1 : 0)),
  events,
  totals: {
    commits: events.length,
    /** Files touched inside the window — not the size of the repository. */
    files_touched: paths.length,
    files_at_head: alive.size,
    authors: authors.length,
    edits: events.reduce((n, e) => n + e.f.length, 0),
  },
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(doc));
const kb = (JSON.stringify(doc).length / 1024).toFixed(1);
process.stderr.write(
  `evolution: ${doc.totals.commits} commits, ${doc.totals.files_touched} paths, ` +
  `${doc.totals.authors} authors, ${kb} KB -> ${OUT}\n`,
);
