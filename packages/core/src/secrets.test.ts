import { describe, expect, it } from 'vitest';
import { entropyBits, findSecrets, type OcrWord } from './secrets.js';

/** Lay out a line of words the way an OCR engine would report it. */
function line(text: string, lineNo = 0, y = 100): OcrWord[] {
  let x = 10;
  return text.split(' ').map((t) => {
    const w = { text: t, x, y, w: t.length * 9, h: 16, line: lineNo };
    x += t.length * 9 + 9;
    return w;
  });
}

/**
 * Build a credential-shaped string at runtime rather than writing one down.
 *
 * Three reasons, in order of how much they matter. A literal in this file that matches a
 * vendor format is indistinguishable from a real leaked key to anything scanning the
 * repository, and GitHub's push protection duly refused this commit. Worse, the first
 * draft reached for strings that were lying around in the conversation — a fragment of a
 * live Cloudflare token and a pasted signing key — which is exactly the mistake this
 * module exists to prevent, made while writing the module. And a fixture assembled from
 * parts is obviously synthetic to a reader, which a random-looking literal is not.
 *
 * The filler is deliberately not random: it must satisfy the patterns under test, and a
 * test that sometimes generates a string its own regex rejects is worse than no test.
 */
const FILL = 'aB3cD4eF5gH6jK7mN8pQ9rS2tU';
const fake = (prefix: string, n: number) =>
  prefix + FILL.repeat(Math.ceil(n / FILL.length)).slice(0, n);
const fakeUpper = (prefix: string, n: number) =>
  prefix + FILL.toUpperCase().replace(/[^0-9A-Z]/g, 'X').repeat(4).slice(0, n);

const kinds = (words: OcrWord[]) => findSecrets(words).map((f) => f.rule).sort();
const covered = (words: OcrWord[], text: string) => {
  const target = words.find((w) => w.text === text)!;
  return findSecrets(words).some((f) =>
    f.region.x <= target.x && f.region.y <= target.y
    && f.region.x + f.region.w >= target.x + target.w
    && f.region.y + f.region.h >= target.y + target.h);
};

describe('tokens that announce themselves', () => {
  it('finds the vendor prefixes that exist to be recognised', () => {
    const cases: [string, string][] = [
      [fake('sk-proj-', 32), 'openai'],
      [fake('ghp_', 36), 'github'],
      [fake('github_pat_', 24), 'github-fine-grained'],
      [fakeUpper('AKIA', 16), 'aws-access-key'],
      [fake('AIza', 35), 'google'],
      [fake('xoxb-', 24), 'slack'],
      [fake('sk_live_', 24), 'stripe'],
      [fake('npm_', 24), 'npm'],
      [fake('sk-ant-', 24), 'anthropic'],
    ];
    for (const [token, rule] of cases) {
      expect(kinds(line(token)), token).toContain(rule);
    }
  });

  it('finds the Cloudflare token shape, which this project has seen leak once', () => {
    // A live token of this shape was pasted into a development conversation. That is
    // exactly what a screen recorder captures without anyone noticing, which is why the
    // rule exists — and why the fixture here is assembled rather than copied.
    expect(kinds(line(fake('cfut_', 32)))).toContain('cloudflare');
  });

  it('finds a JWT by its three-part shape', () => {
    const jwt = [fake('eyJ', 20), fake('eyJ', 20), fake('', 24)].join('.');
    expect(kinds(line(jwt))).toContain('jwt');
  });

  it('is anchored, so prose that merely contains a prefix is left alone', () => {
    // "sk-" inside a sentence, and a word that starts with AKIA but is not a key.
    expect(findSecrets(line('the sk-8 build and AKIAnotakey here'))).toEqual([]);
  });
});

describe('a label and the value it points at', () => {
  it('covers the value and leaves the label readable', () => {
    const words = line('password: hunter2correcthorse');
    expect(covered(words, 'hunter2correcthorse')).toBe(true);
    expect(covered(words, 'password:')).toBe(false);
  });

  it('speaks Portuguese as well, because this operator does', () => {
    const words = line('senha: umaSenhaMuitoSecreta');
    expect(covered(words, 'umaSenhaMuitoSecreta')).toBe(true);
  });

  it('handles the shapes labels actually take', () => {
    for (const label of ['API_KEY=', 'token:', 'Authorization:', 'client_secret', 'PIN:']) {
      const words = line(`${label} Zq8vN2pLx4Tk`);
      expect(covered(words, 'Zq8vN2pLx4Tk'), label).toBe(true);
    }
  });

  it('does not black out a sentence that merely discusses passwords', () => {
    // The failure that would make people turn this off: ordinary interface copy.
    expect(findSecrets(line('Your password is required to continue'))).toEqual([]);
    expect(findSecrets(line('Password Manager'))).toEqual([]);
    expect(findSecrets(line('Forgot password?'))).toEqual([]);
    expect(findSecrets(line('password reset email sent'))).toEqual([]);
  });
});

describe('strings that simply look generated', () => {
  it('covers long hex, which is a hash or a key either way', () => {
    // 64 hex characters with the variety a digest has. Generated here, not copied from
    // anywhere: the first draft of this test used a signing key that had been pasted into
    // the conversation, which is the very failure this module is meant to catch.
    const hex = '0123456789abcdef'.repeat(4);
    expect(kinds(line(hex))).toContain('entropy');
  });

  it('covers a long mixed-class token with no other explanation', () => {
    expect(kinds(line(fake('', 32)))).toContain('entropy');
  });

  it('leaves alone the long strings that fill a developer screen', () => {
    // Every one of these is long, and none is a secret. If they were masked the feature
    // would paint black boxes across an editor and be switched off within a day.
    const harmless = [
      'packages/core/src/secrets.test.ts',
      'https://screenregister001.workers.dev/v1/frames',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      '000000000000000000000000000000',
      'internationalization',
      'ERR_MODULE_NOT_FOUND',
    ];
    for (const s of harmless) expect(findSecrets(line(s)), s).toEqual([]);
  });
});

describe('PEM blocks', () => {
  it('covers the header line, which is where key material starts', () => {
    expect(kinds(line('-----BEGIN RSA PRIVATE KEY-----'))).toContain('pem-header');
  });
});

describe('what the findings carry', () => {
  it('never repeats the matched text, which is the secret itself', () => {
    const found = findSecrets(line('password: hunter2correcthorse'));
    expect(found).toHaveLength(1);
    expect(JSON.stringify(found)).not.toContain('hunter2');
  });

  it('pads the region so glyph edges cannot peek out from under the mask', () => {
    const words = line(fakeUpper('AKIA', 16));
    const [f] = findSecrets(words);
    expect(f!.region.x).toBeLessThan(words[0]!.x);
    expect(f!.region.w).toBeGreaterThan(words[0]!.w);
  });
});

describe('entropy', () => {
  it('scores a generated token above ordinary language', () => {
    expect(entropyBits(fake('', 24))).toBeGreaterThan(entropyBits('internationalization'));
    expect(entropyBits('aaaaaaaa')).toBe(0);
  });
});
