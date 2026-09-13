import { describe, expect, it } from 'vitest';
import { classifyScan } from './scan-state.js';

/**
 * Every case below is a measured screen, not an invented one. The numbers come from seven
 * scenes rendered at 1920×1080, encoded at the shipped WebP quality and read back by
 * Tesseract in a browser — see docs/OCR-MEASUREMENTS.md for the table.
 */
const MEASURED = {
  denseText:   { engineFailed: false, words: 211, meanConfidence: 0.69 },
  sparseText:  { engineFailed: false, words: 3,   meanConfidence: 0.96 },
  tinyGreyText:{ engineFailed: false, words: 108, meanConfidence: 0.31 },
  photo:       { engineFailed: false, words: 0,   meanConfidence: 0 },
  videoStill:  { engineFailed: false, words: 0,   meanConfidence: 0 },
  desktopIcons:{ engineFailed: false, words: 0,   meanConfidence: 0 },
  blankDesktop:{ engineFailed: false, words: 10,  meanConfidence: 0.18 },
};

describe('reading a screen that has text', () => {
  it('accepts a page of code', () => {
    expect(classifyScan(MEASURED.denseText).state).toBe('text');
  });

  it('accepts two large labels — few words is not weak evidence', () => {
    // 3 words at 0.96. An earlier rule required a minimum word count and would have
    // discarded this; a settings screen is mostly whitespace and is still text.
    expect(classifyScan(MEASURED.sparseText).state).toBe('text');
  });
});

describe('frames with nothing to read', () => {
  it('finishes a photograph, a video still and a row of icons', () => {
    // Measured: all three return exactly zero words, never a low-confidence trickle. The
    // engine found nothing it was willing to guess at, so a second look gains nothing.
    for (const scene of [MEASURED.photo, MEASURED.videoStill, MEASURED.desktopIcons]) {
      expect(classifyScan(scene).state).toBe('no_text');
    }
  });
});

describe('the frames that must never be filed as clean', () => {
  it('marks nine-pixel grey text inconclusive, though 108 words came back', () => {
    // The case this whole three-way split exists for. A screen full of information that
    // nothing has actually inspected — calling it "no text" would mark the least examined
    // frame on the system as the safest.
    const out = classifyScan(MEASURED.tinyGreyText);
    expect(out.state).toBe('inconclusive');
    expect(out.reason).toContain('seen, not read');
  });

  it('marks a blank desktop inconclusive when the reader hallucinates on it', () => {
    // Measured: a flat desktop produced ten phantom words at 0.18. A frame that makes the
    // reader invent text is odd enough to deserve the second look, and the cost of being
    // wrong here is one wasted pass rather than an unexamined secret.
    expect(classifyScan(MEASURED.blankDesktop).state).toBe('inconclusive');
  });

  it('marks a failed or timed-out read inconclusive, never no_text', () => {
    const out = classifyScan({ engineFailed: true, words: 0, meanConfidence: 0 });
    expect(out.state).toBe('inconclusive');
    expect(out.reason).toContain('nothing was inspected');
  });

  it('keeps the two measured clusters apart with room on both sides', () => {
    // The threshold sits between 0.31 and 0.69. Pinned so that moving it has to be
    // deliberate, and so a future engine change that shifts confidence is noticed here.
    expect(classifyScan({ engineFailed: false, words: 50, meanConfidence: 0.49 }).state)
      .toBe('inconclusive');
    expect(classifyScan({ engineFailed: false, words: 50, meanConfidence: 0.51 }).state)
      .toBe('text');
  });
});

describe('erring in the safe direction', () => {
  it('never returns no_text for anything the reader reacted to', () => {
    // no_text is the only outcome that ends the pipeline. It must require the strongest
    // evidence — the reader running cleanly and seeing nothing at all.
    for (const conf of [0, 0.1, 0.3, 0.5, 0.9]) {
      for (const words of [1, 5, 200]) {
        expect(classifyScan({ engineFailed: false, words, meanConfidence: conf }).state)
          .not.toBe('no_text');
      }
    }
  });
});
