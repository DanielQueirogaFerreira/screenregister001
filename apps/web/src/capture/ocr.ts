import { PSM } from 'tesseract.js';
import type { ScannedWord } from '@sr/core';

/**
 * Reading the text off a frame, in the browser, before the frame is stored.
 *
 * The placement is the design. OCR here serves two jobs from one pass — it makes the week
 * searchable, and it tells `findSecrets` which rectangles to paint — and the second only
 * works before storage. A mask computed after upload labels a leak; a mask computed here
 * prevents one.
 *
 * Everything below is set by measurement rather than by default, and the numbers are in
 * docs/OCR-MEASUREMENTS.md so a future change can be argued against them.
 */

/** What the worker needs, loaded once and then reused for the life of the session. */
interface Engine {
  recognize(
    image: Blob,
    opts: Record<string, unknown>,
    output: Record<string, boolean>,
  ): Promise<{ data: { blocks?: OcrBlock[] } }>;
  setParameters(p: { tessedit_pageseg_mode: PSM }): Promise<unknown>;
  terminate(): Promise<unknown>;
}

interface OcrBlock { paragraphs?: { lines?: { words?: OcrRaw[] }[] }[] }
interface OcrRaw {
  text: string;
  confidence: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

/**
 * Page segmentation mode 4: "a single column of text of variable sizes".
 *
 * Measured against 3 (the default), 1, 11 and 12 on a synthetic screen with a code editor,
 * a terminal and a chat panel side by side. The default reads a multi-pane screen as one
 * document and splices lines across panes — an editor line and an unrelated chat line come
 * back as one string, and the chat text degraded to 0.37 recall. Mode 4 scored 1.0 on the
 * editor, 1.0 on the chat panel and 1.0 on the URL bar, at the highest confidence of the
 * five and the second-fastest time. A screen is columns of panels, so this is not a detail.
 */
const PAGE_SEG_MODE = PSM.SINGLE_COLUMN;

/**
 * How long one frame may take before it is given up on.
 *
 * Measured at ~880ms for a 1920×1080 frame at the shipped WebP quality. Three seconds is
 * room for a slower machine and a busier screen without letting one pathological frame
 * stall the capture queue behind it.
 */
const FRAME_TIMEOUT_MS = 3000;

let engine: Promise<Engine> | null = null;

/**
 * Start the engine, once.
 *
 * Deliberately lazy: the model is about fourteen megabytes, and somebody who never turns
 * text capture on should never pay for it. The first frame after enabling waits for this;
 * every frame after it does not.
 */
async function getEngine(assetBase: string): Promise<Engine> {
  if (!engine) {
    engine = (async () => {
      const { createWorker } = await import('tesseract.js');
      const w = await createWorker('eng', 1, {
        workerPath: `${assetBase}/worker.min.js`,
        corePath: `${assetBase}/tesseract-core-simd-lstm.js`,
        // Self-hosted, not a CDN. A privacy tool that phones a third party the moment it
        // starts reading your screen has given the game away before it reads anything.
        langPath: assetBase,
        gzip: true,
        workerBlobURL: false,
      });
      await w.setParameters({ tessedit_pageseg_mode: PAGE_SEG_MODE });
      return w as unknown as Engine;
    })();
    engine.catch(() => { engine = null; });   // a failed start must not poison every retry
  }
  return engine;
}

export interface ScanResult {
  words: ScannedWord[];
  /** Milliseconds the read took, for the stats panel. */
  ms: number;
  /** Set when the engine failed or timed out. The caller decides what that means. */
  failed: boolean;
}

/**
 * Read one frame.
 *
 * Never throws. A frame that could not be read comes back as `failed` with no words, and
 * the caller decides the policy — which matters, because "no words" and "no secrets" are
 * the same shape and must not be the same conclusion.
 */
export async function scanFrame(image: Blob, assetBase: string): Promise<ScanResult> {
  const t0 = performance.now();
  try {
    const w = await getEngine(assetBase);
    const result = await Promise.race([
      w.recognize(image, {}, { blocks: true, text: false }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('ocr timeout')), FRAME_TIMEOUT_MS)),
    ]);
    return { words: flatten(result.data.blocks ?? []), ms: Math.round(performance.now() - t0), failed: false };
  } catch {
    return { words: [], ms: Math.round(performance.now() - t0), failed: true };
  }
}

/**
 * The engine's nested blocks, flattened into words with a line index.
 *
 * The line index comes from the engine's own line grouping rather than from the y
 * coordinate, because two panes side by side sit at the same y and are not the same line —
 * which is the whole reason the segmentation mode above had to be chosen carefully.
 */
function flatten(blocks: OcrBlock[]): ScannedWord[] {
  const out: ScannedWord[] = [];
  let line = 0;
  for (const b of blocks) {
    for (const p of b.paragraphs ?? []) {
      for (const l of p.lines ?? []) {
        for (const w of l.words ?? []) {
          const text = w.text?.trim();
          if (!text) continue;
          out.push({
            text,
            // Engines report 0..100; the rest of the system works in 0..1 and the
            // conversion belongs at the boundary, once.
            confidence: Math.max(0, Math.min(1, w.confidence / 100)),
            x: w.bbox.x0,
            y: w.bbox.y0,
            w: w.bbox.x1 - w.bbox.x0,
            h: w.bbox.y1 - w.bbox.y0,
            line,
          });
        }
        line++;
      }
    }
  }
  return out;
}

/** Release the engine and its memory. Called when recording stops. */
export async function releaseOcr(): Promise<void> {
  const e = engine;
  engine = null;
  if (e) await e.then((w) => w.terminate()).catch(() => undefined);
}
