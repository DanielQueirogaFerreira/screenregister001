/**
 * Finding secrets in text read off a frame.
 *
 * This is the other half of the privacy layer, and it exists because the first half
 * cannot do this job. `findMaskedFields` recognises a password field by its shape — a run
 * of identical bullets — which is the only thing a masked field reliably looks like. An
 * API key in a terminal has no shape that distinguishes it from any other word on the
 * screen. The only way to find one is to read the screen, so this operates on text that
 * OCR has already produced, together with where each word sat.
 *
 * The split is deliberate. Everything here is a pure function of words and boxes, so the
 * rules can be tested exhaustively without an OCR engine, a canvas, or a browser — and
 * the rules are the part that has to be right.
 *
 * **The error that matters is the opposite one from findMaskedFields.** There, a false
 * positive destroys the untouched copy of a frame, so it is tuned to say nothing rather
 * than something. Here a false positive paints a black rectangle over a word that was not
 * a secret, which costs a small piece of one frame; a false negative writes a live
 * credential into a seven-day archive. So this leans towards masking, and where a rule is
 * a judgement call it is resolved in favour of covering it up.
 *
 * What it will still miss, stated plainly because a privacy control that is trusted and
 * wrong is worse than none: a secret OCR misread, a secret in an image or a video, a
 * password that looks like an ordinary word, anything in a font or at a size the reader
 * cannot resolve. It reduces exposure. It does not guarantee its absence.
 */

import type { Region } from './privacy.js';

/** One word as an OCR engine reports it: the text, and where it sat in the frame. */
export interface OcrWord {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Words sharing a line index are on the same visual line, left to right. */
  line: number;
}

export type SecretKind =
  | 'api_key'        // a token whose own prefix identifies it
  | 'private_key'    // PEM block
  | 'jwt'
  | 'labelled'       // a value sitting after "password:", "token=", and friends
  | 'high_entropy';  // a long random-looking string with no other explanation

export interface SecretFinding {
  region: Region;
  kind: SecretKind;
  /** Which rule fired, for the audit trail. Never the matched text — that is the secret. */
  rule: string;
}

/**
 * Tokens that announce themselves.
 *
 * Every one of these is a vendor prefix that exists precisely so a credential can be
 * recognised, which makes them the highest-confidence signal available and worth matching
 * first. The patterns are deliberately anchored at the start of a word: a line of prose
 * containing "sk-" mid-sentence is not a key.
 *
 * They are matched case-sensitively where the vendor is, because "AKIA" is an AWS access
 * key and "akia" is not.
 */
const PREFIXED: { rule: string; re: RegExp }[] = [
  // Before the openai rule: sk-ant- also starts with sk-, and whichever matches first
  // names the finding. Both are masked either way, but an audit line that says the wrong
  // vendor is a small lie in the one record meant to be trustworthy.
  { rule: 'anthropic', re: /^sk-ant-[A-Za-z0-9_-]{20,}$/ },
  { rule: 'openai', re: /^sk-(proj-)?[A-Za-z0-9_-]{16,}$/ },
  { rule: 'github', re: /^gh[pousr]_[A-Za-z0-9]{20,}$/ },
  { rule: 'github-fine-grained', re: /^github_pat_[A-Za-z0-9_]{20,}$/ },
  { rule: 'aws-access-key', re: /^(AKIA|ASIA)[0-9A-Z]{12,}$/ },
  { rule: 'google', re: /^AIza[A-Za-z0-9_-]{30,}$/ },
  { rule: 'slack', re: /^xox[baprs]-[A-Za-z0-9-]{10,}$/ },
  { rule: 'stripe', re: /^(sk|pk|rk)_(live|test)_[A-Za-z0-9]{16,}$/ },
  { rule: 'sendgrid', re: /^SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}$/ },
  { rule: 'npm', re: /^npm_[A-Za-z0-9]{20,}$/ },
  { rule: 'cloudflare', re: /^cfut_[A-Za-z0-9_-]{20,}$/ },
  { rule: 'jwt', re: /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/ },
];

/**
 * Words that introduce a secret rather than being one.
 *
 * Matching the label and covering what follows catches the enormous class of secrets with
 * no recognisable shape of their own — a database password, a one-off token, a PIN. The
 * label itself is left visible: "password:" tells a reader what was hidden and hides
 * nothing, and blacking it out would make the record harder to understand for no gain.
 *
 * Portuguese alongside English because this deployment's operator works in both, and a
 * detector that only speaks one language is a detector with a hole in it.
 */
const LABELS =
  /^(password|passwd|pwd|passphrase|senha|secret|segredo|token|apikey|api[_-]?key|access[_-]?key|secret[_-]?key|private[_-]?key|client[_-]?secret|auth|authorization|bearer|credential|chave|pin|otp|mfa|seed|mnemonic)s?\s*[:=]?$/i;

/** A value that a label points at, but which is obviously not a secret. */
const NOT_A_VALUE = /^(is|are|the|a|an|to|for|your|my|here|required|invalid|incorrect|correct|empty|null|none|undefined|error|field|manager|reset|change|forgot|show|hide|new|old|confirm|enter|please)$/i;

/** How many words after a label to cover. Enough for a passphrase, not a paragraph. */
const LABEL_SPAN = 3;

export interface SecretOptions {
  /** Shortest run of random-looking characters that counts on entropy alone. */
  minEntropyLength: number;
  /** Shannon entropy per character, above which a long token looks generated. */
  minEntropyBits: number;
  /** Grow every mask by this fraction of the word's height, so glyph edges do not peek out. */
  padFrac: number;
}

export const DEFAULT_SECRETS: SecretOptions = {
  // 24 rather than 16: shorter runs are full of ordinary things — commit ids in a git
  // log, css hashes in a bundle filename, a UUID in a URL. None of those are secret, and
  // covering a screen in black boxes teaches people to switch the feature off.
  minEntropyLength: 24,
  // Around 3.2 bits/char separates generated tokens from English words and identifiers,
  // which sit lower because letters repeat and follow each other predictably.
  minEntropyBits: 3.2,
  padFrac: 0.25,
};

/** Shannon entropy per character, in bits. */
export function entropyBits(s: string): number {
  if (!s) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** Strip the punctuation a word may carry from its surroundings, not from its value. */
function core(text: string): string {
  return text.replace(/^["'`(\[{<,;]+/, '').replace(/["'`)\]}>,;.]+$/, '');
}

/**
 * A long string with no vowel structure and a mix of character classes.
 *
 * Entropy alone is not enough — a long hex hash scores lower than English by this measure
 * yet is exactly the kind of thing worth hiding — so length, class mixing and entropy are
 * combined. A pure lowercase word never qualifies however long it is.
 */
function looksGenerated(s: string, o: SecretOptions): boolean {
  if (s.length < o.minEntropyLength) return false;
  if (!/^[A-Za-z0-9_\-+/=.]+$/.test(s)) return false;      // not a token shape at all
  if (/^[0-9]+$/.test(s)) return false;                     // a long number is a number
  if (/^\/|^https?:/i.test(s)) return false;                // a path or URL, not a key

  const classes =
    Number(/[a-z]/.test(s)) + Number(/[A-Z]/.test(s)) +
    Number(/[0-9]/.test(s)) + Number(/[_\-+/=]/.test(s));

  // Long hex is the one case worth taking on length alone: a 32, 40 or 64 character hex
  // run is a hash or a key, and neither belongs in an archive that outlives the session.
  //
  // But 'a' is a hex digit, so a row of thirty-four a's satisfied this and got masked —
  // found by the test that asks what a developer's screen is full of. A hash uses most of
  // its alphabet; a run of one character uses one. Requiring variety costs nothing real,
  // since no digest of any length looks like that.
  if (/^[0-9a-f]{32,}$/i.test(s)) return new Set(s.toLowerCase()).size >= 8;

  return classes >= 3 && entropyBits(s) >= o.minEntropyBits;
}

const PEM = /-{3,}\s*BEGIN[A-Z ]*PRIVATE KEY/i;

function box(words: OcrWord[], o: SecretOptions): Region {
  const x0 = Math.min(...words.map((w) => w.x));
  const y0 = Math.min(...words.map((w) => w.y));
  const x1 = Math.max(...words.map((w) => w.x + w.w));
  const y1 = Math.max(...words.map((w) => w.y + w.h));
  const pad = Math.round(Math.max(...words.map((w) => w.h)) * o.padFrac);
  return {
    x: Math.max(0, Math.round(x0 - pad)),
    y: Math.max(0, Math.round(y0 - pad)),
    w: Math.round(x1 - x0 + pad * 2),
    h: Math.round(y1 - y0 + pad * 2),
  };
}

/**
 * Every secret the rules can see in one frame's text.
 *
 * Order matters only in that a word covered by one rule is not re-examined by another;
 * the regions are merged by the caller, so overlaps are harmless.
 */
export function findSecrets(
  words: OcrWord[], options: Partial<SecretOptions> = {},
): SecretFinding[] {
  const o = { ...DEFAULT_SECRETS, ...options };
  const out: SecretFinding[] = [];
  const claimed = new Set<number>();

  const lines = new Map<number, number[]>();
  words.forEach((w, i) => {
    const arr = lines.get(w.line);
    if (arr) arr.push(i); else lines.set(w.line, [i]);
  });

  // A PEM header means the whole line, and every line after it, is key material. The
  // header alone is not the secret — what follows it is — so the caller is handed the
  // header's line and the reader is left in no doubt about what was covered.
  for (const [, idx] of lines) {
    const text = idx.map((i) => words[i]!.text).join(' ');
    if (PEM.test(text)) {
      idx.forEach((i) => claimed.add(i));
      out.push({ region: box(idx.map((i) => words[i]!), o), kind: 'private_key', rule: 'pem-header' });
    }
  }

  // Self-identifying tokens.
  words.forEach((w, i) => {
    if (claimed.has(i)) return;
    const t = core(w.text);
    for (const p of PREFIXED) {
      if (p.re.test(t)) {
        claimed.add(i);
        out.push({
          region: box([w], o),
          kind: p.rule === 'jwt' ? 'jwt' : 'api_key',
          rule: p.rule,
        });
        return;
      }
    }
  });

  // A label, then whatever it points at.
  for (const [, idx] of lines) {
    for (let k = 0; k < idx.length; k++) {
      const here = words[idx[k]!]!;
      if (!LABELS.test(core(here.text))) continue;

      const following: OcrWord[] = [];
      for (let j = k + 1; j < idx.length && following.length < LABEL_SPAN; j++) {
        const cand = words[idx[j]!]!;
        const t = core(cand.text);
        // A label followed by prose is a sentence about passwords, not a password.
        if (!t || NOT_A_VALUE.test(t)) break;
        if (claimed.has(idx[j]!)) break;
        following.push(cand);
        claimed.add(idx[j]!);
        // One value is the usual case; keep going only while the words look like part of
        // the same opaque run rather than the start of a sentence.
        if (!/^[A-Za-z0-9_\-+/=.@!#$%^&*]+$/.test(t)) break;
      }
      if (following.length > 0) {
        out.push({ region: box(following, o), kind: 'labelled', rule: 'label-value' });
      }
    }
  }

  // Anything left that simply looks generated.
  words.forEach((w, i) => {
    if (claimed.has(i)) return;
    const t = core(w.text);
    if (looksGenerated(t, o)) {
      claimed.add(i);
      out.push({ region: box([w], o), kind: 'high_entropy', rule: 'entropy' });
    }
  });

  return out;
}
