import { describe, expect, it } from 'vitest';
import {
  buildFrameText, excerpt, matchesQuery, type ScannedWord,
} from './transcript.js';

/** Lay out a line of words the way an OCR engine reports them. */
function line(n: number, text: string, at = { x: 0, y: n * 20 }, confidence = 0.9): ScannedWord[] {
  let x = at.x;
  return text.split(' ').map((t) => {
    const w = { text: t, x, y: at.y, w: t.length * 8, h: 14, line: n, confidence };
    x += t.length * 8 + 8;
    return w;
  });
}

describe('what reaches the searchable text', () => {
  it('keeps the lines a screen actually showed', () => {
    const words = [...line(0, 'Cloudflare R2 pricing'), ...line(1, 'storage 0.015 per GB')];
    expect(buildFrameText(words).text).toBe('Cloudflare R2 pricing\nstorage 0.015 per GB');
  });

  it('orders a line left to right, not the order the engine reported', () => {
    // Engines do not always report in reading order, and a transcript that reads
    // backwards is worse than none.
    const words = [
      { text: 'second', x: 100, y: 0, w: 40, h: 14, line: 0, confidence: 0.9 },
      { text: 'first', x: 10, y: 0, w: 40, h: 14, line: 0, confidence: 0.9 },
    ];
    expect(buildFrameText(words).text).toBe('first second');
  });

  it('drops words the engine was unsure of', () => {
    const words = [...line(0, 'certain words here'), ...line(1, 'garbled nonsense', undefined, 0.2)];
    expect(buildFrameText(words).text).toBe('certain words here');
  });

  it('truncates rather than storing a document per frame', () => {
    const words = Array.from({ length: 400 }, (_, i) => line(i, 'padding text here')).flat();
    expect(buildFrameText(words, [], { maxChars: 100 }).text.length).toBe(100);
  });
});

describe('secrets never reach the text, which is the whole point', () => {
  it('masks a detected secret AND keeps it out of the transcript', () => {
    // The failure this prevents: the image is redacted and the database column is not, so
    // the password is hidden in the picture and searchable in D1. That is worse than not
    // masking at all, because it looks handled.
    const words = [...line(0, 'password: hunter2correcthorse'), ...line(1, 'ordinary screen text')];
    const out = buildFrameText(words);
    expect(out.findings.length).toBeGreaterThan(0);
    expect(out.mask.length).toBeGreaterThan(0);
    expect(out.text).not.toContain('hunter2correcthorse');
    expect(out.text).toContain('ordinary screen text');
  });

  it('looks for secrets in words too doubtful to index', () => {
    // The asymmetry that matters. A word OCR is unsure about is bad evidence and good
    // warning: too weak to search on, strong enough to redact.
    const words = line(0, 'password: hunter2correcthorse', undefined, 0.3);
    const out = buildFrameText(words);
    expect(out.mask.length).toBeGreaterThan(0);
    expect(out.text).toBe('');
  });

  it('keeps words out of the text when the caller is already painting over them', () => {
    // A word under a password field or inside an excluded zone must not reach the
    // transcript either, or the image is redacted and the text is not.
    const words = [...line(0, 'secret field contents'), ...line(1, 'safe text')];
    const out = buildFrameText(words, [{ x: 0, y: 0, w: 400, h: 16 }]);
    expect(out.text).toBe('safe text');
  });

  it('does not eat the line below because the mask was padded', () => {
    // Measured, not imagined: the secret mask is padded outwards so the image redaction is
    // generous, and that padding reached two pixels into the next line. A "do the
    // rectangles touch" test removed two innocent words. The word's centre has to be
    // inside the mask, not merely clipped by it.
    const words = [...line(0, 'password: hunter2correcthorse'), ...line(1, 'ordinary screen text')];
    const out = buildFrameText(words);
    expect(out.mask[0]!.y + out.mask[0]!.h).toBeGreaterThan(20);  // it really does bleed
    expect(out.text).toContain('ordinary screen text');           // and it costs nothing
  });

  it('reports confidence over every word, including the dropped ones', () => {
    const out = buildFrameText([...line(0, 'aa bb', undefined, 1), ...line(1, 'cc dd', undefined, 0)]);
    expect(out.confidence).toBeCloseTo(0.5, 5);
  });

  it('says nothing rather than guessing when the frame has no words', () => {
    const out = buildFrameText([]);
    expect(out).toMatchObject({ text: '', mask: [], findings: [], confidence: 0 });
  });
});

describe('finding a moment by what was on screen', () => {
  const text = 'Cloudflare R2 pricing\nStorage $0.015 per GB-month\nClass A operations';

  it('requires every term, in any order', () => {
    expect(matchesQuery(text, 'pricing cloudflare')).toBe(true);
    expect(matchesQuery(text, 'cloudflare kubernetes')).toBe(false);
  });

  it('ignores case and accents, because nobody types what a screen rendered', () => {
    expect(matchesQuery('Preço do armazenamento', 'preco')).toBe(true);
    expect(matchesQuery('CLOUDFLARE', 'cloudflare')).toBe(true);
  });

  it('matches inside a word, so a partial term still finds the moment', () => {
    expect(matchesQuery(text, 'oper')).toBe(true);
  });

  it('never matches a frame with no text, or an empty query', () => {
    expect(matchesQuery(null, 'anything')).toBe(false);
    expect(matchesQuery(text, '   ')).toBe(false);
  });
});

describe('why a frame matched', () => {
  it('returns the stretch around the hit, on one line', () => {
    const long = `${'filler '.repeat(40)}the pricing page${' more '.repeat(40)}`;
    const out = excerpt(long, 'pricing');
    expect(out).toContain('pricing');
    expect(out).not.toContain('\n');
    expect(out.length).toBeLessThan(160);
  });

  it('marks where it cut', () => {
    const long = `${'x '.repeat(200)}target${' y'.repeat(200)}`;
    expect(excerpt(long, 'target').startsWith('…')).toBe(true);
    expect(excerpt(long, 'target').endsWith('…')).toBe(true);
  });

  it('falls back to the opening when the term is not there', () => {
    expect(excerpt('short text', 'absent')).toBe('short text');
  });
});
