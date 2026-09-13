import { describe, expect, it } from 'vitest';
import { findSecrets } from './secrets.js';
import { buildFrameText } from './transcript.js';

/**
 * What a real OCR pass really produces, kept as a fixture.
 *
 * These words are not invented. They are the exact output of Tesseract reading a WebP
 * frame encoded at the quality this project ships (0.5), from a 1920×1080 synthetic screen
 * containing a terminal line with a live-shaped Stripe key. Measured in a browser, not
 * imagined at a desk.
 *
 * The fixture exists because the measurement overturned an assumption. Every secret rule
 * that keys on a prefix assumes the underscores survive the read. They do not: a shell
 * export of a provider key came back with every underscore rendered as a space. Thin
 * baseline glyphs are the first thing lost to compression, and the shipped quality was
 * chosen for legibility of prose, not of punctuation.
 *
 * The prefix is assembled from parts here rather than written out, which is the same rule
 * the rest of this suite follows: a complete live-format credential does not go into the
 * repository even as a fixture, and GitHub's push protection is right to refuse one.
 */
const LIVE_PREFIX = ['sk', 'live'].join('_');
const KEY_BODY = '4eC39HqLyjWDarjtT1zdp7dc';

const REAL_OCR_WORDS = [
  ['$', 0.90], ['export', 0.96], ['STRIPE', 0.92], ['KEY=sk', 0.92], ['live', 0.92],
  [KEY_BODY, 0.39],
].map(([text, confidence], i) => ({
  text: text as string,
  confidence: confidence as number,
  x: 14 + i * 90, y: 688, w: (text as string).length * 9, h: 14, line: 3,
}));

describe('secret detection against output a real OCR engine produced', () => {
  it('records the underscore loss, so nobody re-assumes prefixes survive', () => {
    const read = REAL_OCR_WORDS.map((w) => w.text).join(' ');
    expect(read).toBe(`$ export STRIPE KEY=sk live ${KEY_BODY}`);
    // The characters of the key itself came through exactly. It is the separators that go.
    expect(read).toContain(KEY_BODY);
    expect(read).not.toContain(`${LIVE_PREFIX}_`);
  });

  it('still masks the key — through entropy, NOT through the prefix rule', () => {
    // This is the load-bearing fact. Under OCR the prefix rules are defeated and the
    // high-entropy fallback is what actually protects a secret on screen. Anything that
    // weakens that rule silently removes the only defence that is operating, and a test
    // that used clean synthetic text would never notice.
    const findings = findSecrets(REAL_OCR_WORDS);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.kind).toBe('high_entropy');
    expect(findings[0]!.rule).toBe('entropy');
  });

  it('covers the key where it actually sits on the frame', () => {
    const [f] = findSecrets(REAL_OCR_WORDS);
    const key = REAL_OCR_WORDS[5]!;
    expect(f!.region.x).toBeLessThanOrEqual(key.x);
    expect(f!.region.x + f!.region.w).toBeGreaterThanOrEqual(key.x + key.w);
    expect(f!.region.y).toBeLessThanOrEqual(key.y);
  });

  it('keeps the key out of the transcript while leaving the line readable', () => {
    const frame = buildFrameText(REAL_OCR_WORDS);
    expect(frame.text).not.toContain(KEY_BODY);
    // The surrounding words stay, so the moment is still findable by searching "stripe".
    expect(frame.text).toContain('STRIPE');
  });

  it('scans the key for secrets even though 0.39 is too low to index', () => {
    // The key came back at 0.39 confidence — below the 0.55 indexing threshold. If the
    // secret scan used the same threshold, the one word that had to be masked would have
    // been dropped before anyone looked at it.
    expect(REAL_OCR_WORDS[5]!.confidence).toBeLessThan(0.55);
    expect(findSecrets(REAL_OCR_WORDS)).toHaveLength(1);
  });
});
