# OCR on captured frames — what was measured

**2026-09-13 · Tesseract.js 7.0.0, SIMD-LSTM core, eng 4.0.0 · Chromium, headless.**

Every constant in `apps/web/src/capture/ocr.ts` comes from here. Re-measure before changing
one, and update this file with what you find rather than editing the constant alone.

## How

A synthetic 1920×1080 screen drawn to a canvas, then encoded to WebP exactly the way the
pipeline does, then read back. Synthetic rather than a real capture **because ground truth
matters more than realism**: the numbers below are recall against strings I control, which
is not something a screenshot of real work can give.

The screen is built to contain the cases that behave differently:

| Region | Why it is there |
|---|---|
| Code editor, light monospace on near-black | The dominant case, and the one WebP degrades first |
| Terminal, green on black, with a live-shaped API key | The secret-detection path |
| Chat panel, dark text on white | The "easy" case, for contrast |
| Browser URL bar | Short text at small size |

## Page segmentation mode — the largest single effect

| PSM | ms | conf | editor | terminal | chat | url |
|---|---|---|---|---|---|---|
| 3 (default) | 1143 | 0.85 | 1.00 | 0.94 | 0.79 | 1.00 |
| 1 | 884 | 0.85 | 1.00 | 0.94 | 0.79 | 1.00 |
| **4 (single column)** | **883** | **0.87** | **1.00** | **0.94** | **1.00** | **1.00** |
| 11 (sparse) | 882 | 0.81 | 0.95 | 0.88 | 0.84 | 1.00 |
| 12 (sparse + OSD) | 861 | 0.81 | 0.95 | 0.88 | 0.84 | 1.00 |

**Mode 4, and it is not a tuning detail.** On the default, a multi-pane screen is read as
one document and lines are spliced *across* panes — an editor line and an unrelated chat
line come back as a single string:

```
1 export function buildFrameText (words, existingMask) { Storagalcosts 01015! par GBLmontR
```

That is the editor's line 1 and the chat panel's first line, joined, with the chat half
degraded to nonsense at confidence 0. A screen is columns of panels; telling the engine so
costs nothing and fixes it.

## Quality and scale

| Setting | ms | size | conf | recall (all) |
|---|---|---|---|---|
| q0.5, full res — **what ships** | 1025 | 22 KB | 0.80 | 0.77 |
| q1.0, full res | 891 | 638 KB | 0.84 | 0.88 |
| q0.35, full res | 844 | 19 KB | 0.79 | 0.83 |
| q0.5, 75% scale | 711 | 14 KB | 0.72 | 0.74 |
| q0.5, **50% scale** | 44 | 8 KB | 0.54 | **0.00** |

Two things to take from this.

**Downscaling is not a speed lever.** At half scale the read finishes in 44ms and returns
nothing usable — recall zero, not merely degraded. Screen text at 1920 wide is already near
the engine's floor; halving it puts it under. The 29× speedup is the engine giving up
quickly, which is the most misleading kind of fast.

**Quality 0.5 costs about a tenth of the recall of lossless, for 3% of the bytes.** That is
the trade the project already made for storage, and it holds for reading too. Note the
recall figures above were taken at the default PSM; with mode 4 the same frame reads
materially better.

## Timing, and what it means for capture

- **Engine start: ~1.7s**, once per session, plus a ~14 MB asset load on first use.
- **Per frame: ~880ms** at 1920×1080, mode 4.

The rate that matters is stored frames, not sampled ones — the change detector discards
most of what it sees. At the shipped defaults (1 fps sampling, 3s minimum gap) a busy
screen stores on the order of 5–20 frames a minute, so OCR asks for roughly 5–18 seconds of
CPU per minute of recording, on one core, in a worker.

**It sits in the critical path by necessity.** The mask has to be computed before the frame
is encoded, so the frame waits for the read. A three-second timeout bounds the damage from
one pathological frame; what to do when the timeout fires is a policy decision, not a
technical one — see below.

## The finding that changed the design

The planted line was a shell export of a Stripe-shaped live key — the label, the
`sk` + `live` prefix joined by underscores, and 24 random characters. OCR read it back as:

```
$ export STRIPE KEY=sk live <the 24 characters, exactly right>
```

(The literal is not reproduced here. GitHub's push protection refused an earlier draft of
this file that contained it, which was the correct call: a complete live-format credential
does not belong in a repository, not even as documentation of a test. The rest of this
project's secret fixtures are generated at runtime for the same reason.)

**The characters of the key came through exactly. The underscores did not.** Thin baseline
glyphs are among the first things lost, and the shipped WebP quality was chosen for
legibility of prose, not of punctuation.

This defeats every secret rule that keys on a prefix — `sk_live_`, `ghp_`, `AKIA`. Those
rules are written, tested, and on a real frame they do not fire.

**What caught it was the high-entropy fallback**, at confidence 0.39 on the token itself.
So under OCR conditions the entropy rule is the defence that is actually operating, and
anything that weakens it removes protection that prefix rules appear to be providing and
are not. This is pinned by `packages/core/src/ocr-reality.test.ts`, which uses the real
words rather than clean synthetic ones — a test written from imagination would never have
noticed.

A second consequence, already built into `buildFrameText`: the key scored **0.39, below the
0.55 confidence threshold for indexing**. If the secret scan had used the same threshold as
the transcript, the one word that had to be masked would have been dropped before anything
looked at it. Doubtful words are too weak to index and strong enough to redact.

## Telling "no text" from "could not read it" — and a heuristic that failed

Decided: **frames are always stored**, with field and zone masking, and a read that could
not resolve the frame marks it `inconclusive` rather than discarding it. It is then owed a
second look on the server. The cost of that choice is explicit — an inconclusive frame is
stored **without text-secret masking**, because there was no text to scan — so every
consumer is told how many such frames exist.

That requires separating two outcomes that look identical: a frame with genuinely nothing
to read, and a frame whose text the reader could not resolve.

**The obvious heuristic does not work, and it is worth recording why.** The idea was to
measure fine structure in the frame — text being the highest-frequency thing a screen
normally contains — and use it to break the tie. Seven scenes, each rendered at 1920×1080
and read at the shipped quality:

| scene | detail | words | conf |
|---|---|---|---|
| dense text (editor + terminal) | 0.0452 | 211 | 0.69 |
| sparse text (two labels) | 0.0008 | 3 | 0.96 |
| tiny low-contrast text | **0.0000** | 108 | 0.31 |
| photo-like gradient | **0.0325** | 0 | 0 |
| video still | 0.0035 | 0 | 0 |
| blank desktop | 0.0000 | **10** | 0.18 |
| desktop with icons | 0.0011 | 0 | 0 |

Three failures, each fatal on its own:

1. **The photograph scores 0.0325 — above any floor that admits sparse text at 0.0008.**
   A picture with no text would be queued for a second look forever.
2. **Nine-pixel grey text scores exactly zero.** The measure runs on the 640px-wide
   grayscale buffer the privacy scan already builds, and that downscale averages small type
   out of existence. The tiebreaker was blind to precisely the case it existed for.
3. **A blank desktop produced ten words.** So `words > 0` does not mean text either.

Tuning the floor against these seven points would have been fitting noise. The measure was
removed.

**Confidence separates them cleanly, and detail does not.** Real reads came back at 0.69
and 0.96; struggling and hallucinating came back at 0.31 and 0.18. Two clusters, no
overlap. So:

| reader said | verdict |
|---|---|
| failed or timed out | `inconclusive` |
| zero words | `no_text` — finished |
| words, mean confidence ≥ 0.5 | `text` |
| words, mean confidence < 0.5 | `inconclusive` — seen, not read |

`no_text` is the only outcome that ends the pipeline, so it requires the strongest
evidence: the reader running cleanly and reacting to nothing at all. Everything the reader
reacted to and could not vouch for goes forward. A test asserts that nothing the reader
reacted to can ever be classified `no_text`.

**The honest limit:** 0.5 is calibrated on seven screens I drew, which is not a sample of
what people look at. Erring low is the safe direction — it sends more frames for a second
look rather than filing them as clean — and this should be revisited against real
captures.

## Reproducing

The harness renders the screen, encodes, reads it back, and scores recall against the
ground truth in the page. It is not in the build — it is a measuring instrument, not a
feature — and lives in the scratch directory referenced by this document's commit.
