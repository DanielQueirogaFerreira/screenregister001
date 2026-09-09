import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Every state-changing request the smoke test makes must carry an Origin header.
 *
 * requireAuth runs the CSRF guard before any route handler, and it refuses a
 * cookie-authenticated POST, PUT, PATCH or DELETE that arrives without one. A smoke
 * assertion that omits the header therefore never reaches the thing it is testing: it
 * receives 403 from a guard that runs earlier, and if it happens to be asserting a refusal
 * it passes for entirely the wrong reason.
 *
 * That is not hypothetical. Two checks that the operator surface is invisible to an
 * ordinary account were passing on a CSRF rejection rather than on the 404 they claimed to
 * prove — so they could not have failed if authorization had been broken. This asserts the
 * property over the file, because the next one would be just as quiet.
 */
function requests(): { line: number; method: string; text: string }[] {
  const lines = readFileSync('.github/workflows/smoke.yml', 'utf8').split('\n');
  const joined: { line: number; text: string }[] = [];
  let buf = '';
  let start = 0;
  lines.forEach((l, i) => {
    if (!buf) start = i + 1;
    buf += l.replace(/\\$/, '');
    if (/\\$/.test(l.trimEnd())) return;
    joined.push({ line: start, text: buf });
    buf = '';
  });
  return joined.flatMap(({ line, text }) => {
    if (!text.includes('curl')) return [];
    const m = /-X\s+'?"?(POST|PUT|PATCH|DELETE)/.exec(text);
    return m ? [{ line, method: m[1]!, text }] : [];
  });
}

describe('the production smoke test', () => {
  it('sends an Origin header on every state-changing request', () => {
    const missing = requests()
      // The one deliberate exception: the check that a foreign Origin is refused sends one
      // on purpose, and the CSRF rejection is the result it is asserting.
      .filter((r) => !r.text.includes('Origin:'))
      .map((r) => `line ${r.line}: ${r.method}`);

    expect(missing).toEqual([]);
  });

  it('finds requests at all, so an empty result is never a pass', () => {
    // Without this the parser could silently stop matching and the check above would
    // succeed over nothing, which is the failure mode it exists to prevent.
    expect(requests().length).toBeGreaterThan(8);
  });
});
