import type { Region } from './privacy.js';
import { findSecrets, type OcrWord, type SecretFinding } from './secrets.js';

/**
 * What one OCR pass over a frame yields, for both of the things it is for.
 *
 * The two payoffs come from the same read, and that is the whole argument for doing this
 * in the browser rather than on the server. Text makes the archive searchable — "when was
 * I looking at the pricing page" is otherwise unanswerable, because the timeline knows
 * *when* the screen changed and never *what* it showed. And the same words, with their
 * positions, are exactly what `findSecrets` needs to say which rectangles must be painted
 * over.
 *
 * The second only works BEFORE the frame is stored. A region to mask is worthless once the
 * unmasked image is in object storage: masking after the fact labels a leak rather than
 * preventing one. So this runs where the zones and the password-field detector already
 * run — in the capture worker, on the bitmap, before the diff and before anything is
 * encoded.
 */

export interface FrameText {
  /** The frame's words, in reading order, with the secrets removed. */
  text: string;
  /** Rectangles the caller must paint before encoding. */
  mask: Region[];
  /** What was found, for the audit trail. Never the matched text — that is the secret. */
  findings: SecretFinding[];
  /** Mean OCR confidence, 0..1. Low means the text is a guess and should be treated as one. */
  confidence: number;
}

export interface TranscriptOptions {
  /**
   * Words below this confidence are dropped from the text.
   *
   * Not from the masking, which is the asymmetry that matters: a word OCR is unsure about
   * is bad evidence and good warning. Searching on a misread wastes a query; failing to
   * mask a misread secret exposes it. So a doubtful word is too weak to index and strong
   * enough to redact.
   */
  minConfidence: number;
  /** Longer than this and the text is truncated. A frame is not a document. */
  maxChars: number;
}

export const DEFAULT_TRANSCRIPT: TranscriptOptions = {
  minConfidence: 0.55,
  maxChars: 4000,
};

/** A word as an OCR engine reports it, before it is trusted. */
export interface ScannedWord extends OcrWord {
  /** 0..1. Engines report 0..100; normalise at the boundary, not here. */
  confidence: number;
}

/**
 * Is this word covered by that rectangle?
 *
 * The word's CENTRE has to be inside it, not merely touch it — and the difference is not
 * hypothetical. A secret's mask is padded outwards on purpose, so the image redaction is
 * generous; measured here, that padding reached two pixels into the line below. Under a
 * "do they touch" test those two pixels removed two innocent words from the transcript.
 *
 * Generous is right for painting and wrong for filtering, so the two use different
 * questions of the same rectangle.
 */
const covers = (r: Region, w: { x: number; y: number; w: number; h: number }): boolean => {
  const cx = w.x + w.w / 2;
  const cy = w.y + w.h / 2;
  return cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h;
};

/**
 * Turn one frame's scanned words into text to store and rectangles to paint.
 *
 * The order is the point. Secrets are found first, the words they cover are removed, and
 * only what is left becomes the text. Storing the full transcript and masking the image
 * would hide a password in the picture while writing it into a database column that every
 * assistant can read — which is worse than not masking at all, because it looks handled.
 */
export function buildFrameText(
  words: ScannedWord[],
  existingMask: Region[] = [],
  options: Partial<TranscriptOptions> = {},
): FrameText {
  const o = { ...DEFAULT_TRANSCRIPT, ...options };

  // Secrets are looked for in EVERY word, including the ones too doubtful to index.
  const findings = findSecrets(words);
  const secretRegions = findings.map((f) => f.region);
  // Regions the caller already intends to paint count too: a word under a password field
  // or inside an excluded zone must not reach the text either, or the image is redacted
  // and the transcript is not.
  const covered = [...secretRegions, ...existingMask];

  const kept: ScannedWord[] = [];
  for (const w of words) {
    if (w.confidence < o.minConfidence) continue;
    if (covered.some((r) => covers(r, w))) continue;
    kept.push(w);
  }

  const confident = words.filter((w) => Number.isFinite(w.confidence));
  const confidence = confident.length > 0
    ? confident.reduce((n, w) => n + w.confidence, 0) / confident.length
    : 0;

  return {
    text: joinLines(kept).slice(0, o.maxChars),
    mask: secretRegions,
    findings,
    confidence: Math.max(0, Math.min(1, confidence)),
  };
}

/**
 * Words back into lines, in reading order.
 *
 * Line breaks are kept because they carry meaning on a screen — a menu, a table, a chat
 * are all lines — and a single run-on paragraph is markedly worse to search and to read
 * back. Within a line, words are ordered by x rather than by the order the engine reported
 * them, which is not always left to right.
 */
function joinLines(words: ScannedWord[]): string {
  const lines = new Map<number, ScannedWord[]>();
  for (const w of words) {
    const arr = lines.get(w.line);
    if (arr) arr.push(w); else lines.set(w.line, [w]);
  }
  return [...lines.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, ws]) => ws.sort((p, q) => p.x - q.x).map((w) => w.text).join(' ').trim())
    .filter((s) => s.length > 0)
    .join('\n');
}

/**
 * Does this frame's text answer the query?
 *
 * Deliberately not a ranking function. Somebody asking "when was I looking at the pricing
 * page" wants every moment that matches, in time order, not the best three — the timeline
 * is the ordering, and relevance is the wrong axis for a record of a week.
 *
 * All terms must appear, in any order, anywhere in the text. Case and accent insensitive,
 * because nobody types a query the way a screen rendered it.
 */
export function matchesQuery(text: string | null, query: string): boolean {
  if (!text) return false;
  const terms = normalise(query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return false;
  const hay = normalise(text);
  return terms.every((t) => hay.includes(t));
}

const normalise = (s: string): string =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/**
 * The stretch of text around a hit, for showing why a frame matched.
 *
 * A frame's transcript can be thousands of characters and almost none of it is the reason
 * it came back. Returning the whole thing would put a screen of text into an assistant's
 * context for every result, which is the cost this design exists to avoid.
 */
export function excerpt(text: string, query: string, radius = 60): string {
  const terms = normalise(query).split(/\s+/).filter(Boolean);
  const hay = normalise(text);
  let at = -1;
  for (const t of terms) {
    const i = hay.indexOf(t);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return text.slice(0, radius * 2).trim();
  const from = Math.max(0, at - radius);
  const to = Math.min(text.length, at + radius);
  // Collapsed to one line: an excerpt is a label, and a label that wraps over four lines
  // of a menu is not one.
  const body = text.slice(from, to).replace(/\s+/g, ' ').trim();
  return `${from > 0 ? '…' : ''}${body}${to < text.length ? '…' : ''}`;
}
