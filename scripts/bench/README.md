# Legibility bench

Answers one question: **how far can WebP quality fall before a stored frame stops being
readable?** Storage is the reason to ask, and the constraint is that a frame has to remain
useful to a person reading it and to OCR later.

It measures legibility directly, with OCR, rather than by proxy. An earlier version scored
PSNR, which weighs every pixel equally — including a gradient nobody reads — and is close
to useless for the thing that actually degrades first, which is text.

## Method

- Two screens, in `screen.html` and `screen2.html`. The second is dense and photographic:
  a gradient with film grain, a 22-row numeric table at 11px, prose, and dark UI chrome.
  It encodes to **114 KB at q0.70**, against a **103 KB** measured average for real stored
  frames, so it is a fair stand-in. The first screen is flat, clean UI and encodes to only
  50 KB — useful for legibility, misleading for size, which is why both exist.
- Encoding runs in **Chromium's own canvas**, through the same
  `OffscreenCanvas.convertToBlob({ type: 'image/webp', quality })` call the capture worker
  uses. Not an approximation of the shipped encoder: the shipped encoder.
- The reference is a **lossless PNG** of the same render, so ground truth is exact.
- Each text region is cropped and OCR'd separately. Sizes do not degrade together, and an
  average over the whole frame hides the region that fails first.
- Two scores per region: against the known on-screen text, and against the lossless
  reference's own OCR. The second is the one to read — tesseract is imperfect on dense
  numerals even with perfect pixels, and the question is what compression costs, not what
  tesseract costs.

## Running it

Dependencies are installed on demand rather than carried in the repo, since this is a
tool for making a decision and not part of any build:

```sh
npm install --no-save playwright sharp tesseract.js @tesseract.js-data/eng
cd scripts/bench
node capture.mjs out                      # sizes at each quality
SCREEN=screen2.html node capture.mjs out2 # the realistic screen
SCREEN=screen2.html node legibility.mjs out2
```

`capture.mjs` points at the sandbox's preinstalled Chromium. On a machine with a matching
Playwright install, drop `executablePath`.

## What it found

Relative character accuracy against the lossless reference, on the realistic screen:

| quality | KB | of q0.70 | 11px chrome (dark) | 11px table (light) | 12px prose |
| --- | --- | --- | --- | --- | --- |
| 0.70 | 114.3 | 100% | 98.0% | 83.0% | 98.9% |
| 0.60 | 99.3 | 87% | 97.0% | 81.8% | 98.6% |
| **0.50** | **86.9** | **76%** | **98.0%** | **83.0%** | **98.6%** |
| 0.40 | 75.5 | 66% | 97.0% | 81.5% | 98.9% |
| 0.30 | 62.2 | 54% | 96.0% | 80.1% | 98.9% |
| 0.20 | 50.9 | 45% | 97.0% | 77.0% | 98.6% |

Two things decided the default, and neither is visible in the OCR column alone.

**OCR barely moves until q0.30.** The spread between adjacent qualities is the same size as
the spread between the reference and q0.90, so anything down to about q0.40 is
indistinguishable from measurement scatter. Read alone, this table argues for q0.20, which
is wrong.

**The eye disagrees, and only in dark regions.** Magnified 3x, dark text on a light ground
is indistinguishable from lossless at every quality down to q0.30 — the dense table above
included. Light text on dark backgrounds is not: mottling appears in the background around
glyphs at q0.30 and edges visibly break up at q0.20. Dark-mode editors, terminals and title
bars are what set the floor here, not small type.

So **q0.50** is the default: 24% fewer bytes than q0.70, no measurable legibility cost and
no visible artefact in the region that fails first. q0.40 is a defensible choice for 34%
if a slightly softer dark-mode UI is acceptable. Below q0.35 frames start looking degraded
before they start being unreadable, which is the wrong trade for a record someone is meant
to trust.
