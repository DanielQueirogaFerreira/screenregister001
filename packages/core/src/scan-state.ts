/**
 * Did the reader find no text, or did it fail to read the text that was there?
 *
 * These are the same shape — zero words — and treating them as the same fact is the
 * mistake this module exists to prevent. A frame of a photograph genuinely has nothing to
 * index and is finished. A frame of a terminal that the reader could not resolve has
 * everything to index and has been looked at by nothing. Calling the second one "no text"
 * files it as clean, and it is the opposite of clean: it is the only frame on the system
 * that no detector has ever inspected.
 *
 * So the outcome is three-valued, and the third value is the one that carries work
 * forward: an inconclusive frame is stored, marked, and handed to the server for a second
 * look, and every consumer downstream is told that the text pass did not run on it.
 */

export type ScanState =
  /** Words were read. The transcript and the secret scan both ran on real input. */
  | 'text'
  /** The reader ran, found nothing, and the frame itself shows nothing to find. Finished. */
  | 'no_text'
  /** The reader could not say. Stored, marked, and queued for a second look. */
  | 'inconclusive';

export interface ScanOutcome {
  state: ScanState;
  /** Why, in words, for the audit trail and for the frame inspector. */
  reason: string;
}

export interface ClassifyInput {
  /** The engine threw, timed out, or never started. */
  engineFailed: boolean;
  /** How many words came back. */
  words: number;
  /** Mean confidence over those words, 0..1. */
  meanConfidence: number;
}

export interface ClassifyOptions {
  /**
   * Below this mean confidence, a read is a guess rather than a reading.
   *
   * Measured across seven synthetic screens: a page of code read back at 0.69 and two
   * large labels at 0.96, while nine-pixel grey annotations came back at 0.31 and a
   * genuinely BLANK desktop produced ten phantom words at 0.18. The two clusters do not
   * overlap, and the threshold sits between them.
   *
   * Calibrated on synthetic scenes, which is a real limit: seven screens I drew are not a
   * sample of what people look at. Revisit it against real captures before trusting it
   * far — and note that erring low is the safe direction, because it sends more frames for
   * a second look rather than filing them as clean.
   */
  readable: number;
}

export const DEFAULT_CLASSIFY: ClassifyOptions = {
  readable: 0.5,
};

/**
 * Decide what happened, from what the reader said and what the pixels say.
 *
 * The pixels are the tiebreaker, and they have to be, because the reader cannot report its
 * own blind spots. An engine that fails on light-on-dark text returns exactly what it
 * returns on an empty desktop; only the frame itself knows the difference.
 */
export function classifyScan(
  i: ClassifyInput, options: Partial<ClassifyOptions> = {},
): ScanOutcome {
  const o = { ...DEFAULT_CLASSIFY, ...options };

  if (i.engineFailed) {
    return {
      state: 'inconclusive',
      reason: 'the reader failed or timed out, so nothing was inspected',
    };
  }

  if (i.words === 0) {
    // The engine ran and found nothing it was even willing to guess at. Measured, this is
    // what a photograph, a video still and a wall of desktop icons all produce: exactly
    // zero words, never a low-confidence trickle. Nothing to read, and nothing to gain
    // from looking again.
    return { state: 'no_text', reason: 'the reader ran and found nothing to read' };
  }

  if (i.meanConfidence >= o.readable) {
    return {
      state: 'text',
      reason: `${i.words} word(s) read at ${i.meanConfidence.toFixed(2)} confidence`,
    };
  }

  // Words came back, and the engine does not believe them. This is the case that matters:
  // measured, nine-pixel grey text returned 108 words at 0.31, which is a screen full of
  // information that nothing has actually inspected. Filing it as "no text" would mark the
  // least examined frame on the system as clean.
  return {
    state: 'inconclusive',
    reason: `${i.words} word(s) but only ${i.meanConfidence.toFixed(2)} confidence — seen, not read`,
  };
}
