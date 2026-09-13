import { useEffect, useState } from 'react';
import { PaletteProvider, Section } from '../lib/sections.js';

/**
 * How a person hands their own recordings to their own assistant.
 *
 * Everything this page describes already worked. What did not exist was any way to find
 * out: the MCP server has been live for weeks, the OAuth flow with it, and the only place
 * either was mentioned in the running app was a token table three screens deep in
 * Settings. A capability nobody can discover is not a capability.
 *
 * The whole gesture is one URL. Both Claude and Gemini now take an MCP server address,
 * register themselves, and run a consent screen — so there is no token to copy, no file to
 * edit, and nothing for the user to keep secret. The page is built around making that one
 * address impossible to miss, and everything else is there for when it does not work.
 */

/** The address to paste. Read from the page rather than written down, so it is never stale. */
const mcpUrl = (): string =>
  `${typeof location === 'undefined' ? 'https://example.invalid' : location.origin}/mcp`;

function CopyField({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);

  return (
    <div className="row connect-url">
      {/* Readonly rather than a <code> block: selecting text by hand on a phone is the
          step people give up on, and an input makes the whole value one tap. */}
      <input value={value} readOnly onFocus={(e) => e.currentTarget.select()} aria-label="MCP server address" />
      <button
        className="primary"
        onClick={() => {
          // Falls back to selecting the field: clipboard access is refused outright in
          // some browsers, and a button that silently does nothing is worse than one that
          // hands you the text to copy yourself.
          void navigator.clipboard?.writeText(value)
            .then(() => setCopied(true))
            .catch(() => {
              const el = document.querySelector<HTMLInputElement>('.connect-url input');
              el?.select();
            });
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

type CheckState = 'checking' | 'ok' | 'bad';

interface Check {
  label: string;
  state: CheckState;
  detail: string;
}

/**
 * Does this deployment actually answer the questions an assistant is about to ask?
 *
 * When a connector fails, the vendor's error says "could not connect" and nothing more —
 * the useful half of the failure happens on our side and is never shown to anybody. These
 * three requests are the first three an assistant makes, run from the page, so the answer
 * to "is it them or us" exists before anyone has to guess.
 */
function useSelfCheck(): Check[] {
  const [checks, setChecks] = useState<Check[]>([
    { label: 'Resource metadata', state: 'checking', detail: 'asking…' },
    { label: 'Authorisation server', state: 'checking', detail: 'asking…' },
    { label: 'Something to read', state: 'checking', detail: 'asking…' },
  ]);

  useEffect(() => {
    let cancelled = false;
    const set = (i: number, c: Check) =>
      setChecks((prev) => (cancelled ? prev : prev.map((old, j) => (j === i ? c : old))));

    const doc = async (i: number, label: string, path: string, key: string) => {
      try {
        const r = await fetch(path, { credentials: 'omit' });
        if (!r.ok) throw new Error(`the server answered ${r.status}`);
        const body = await r.json() as Record<string, unknown>;
        if (typeof body[key] !== 'string' && !Array.isArray(body[key])) {
          throw new Error(`the document is missing ${key}`);
        }
        set(i, { label, state: 'ok', detail: 'answered, and says what it should' });
      } catch (e) {
        set(i, { label, state: 'bad', detail: e instanceof Error ? e.message : String(e) });
      }
    };

    void doc(0, 'Resource metadata', '/.well-known/oauth-protected-resource', 'resource');
    void doc(1, 'Authorisation server', '/.well-known/oauth-authorization-server', 'issuer');

    void (async () => {
      try {
        const r = await fetch('/v1/usage', { credentials: 'include' });
        if (!r.ok) throw new Error(`the server answered ${r.status}`);
        const u = await r.json() as { frames?: number };
        const n = u.frames ?? 0;
        set(2, {
          label: 'Something to read',
          state: n > 0 ? 'ok' : 'bad',
          detail: n > 0
            ? `${n.toLocaleString()} frame(s) stored`
            : 'nothing recorded yet — connect anyway, but an assistant will find an empty archive',
        });
      } catch (e) {
        set(2, {
          label: 'Something to read', state: 'bad',
          detail: e instanceof Error ? e.message : String(e),
        });
      }
    })();

    return () => { cancelled = true; };
  }, []);

  return checks;
}

export function ConnectView() {
  const url = mcpUrl();
  const checks = useSelfCheck();

  return (
    <PaletteProvider>
      <Section n={0} title="The address">
        <div className="hint">
          One address, and that is the whole setup. Paste it into your assistant, approve
          the screen it shows you, and it can read your recordings. There is no token to
          copy and nothing to keep secret — the approval happens here, signed in as you,
          and you can withdraw it at any time.
        </div>
        <CopyField value={url} />
      </Section>

      <Section n={1} title="Claude">
        <ol className="connect-steps">
          <li>Open <b>Settings › Connectors</b> at claude.ai.</li>
          <li>Choose <b>Add custom connector</b>.</li>
          <li>Paste the address above. Leave the advanced fields empty.</li>
          <li>Claude sends you back here to approve it. Press <b>Allow</b>.</li>
        </ol>
        <div className="hint">
          Works on the free plan as well as the paid ones. Claude Code and Claude Desktop
          take the same address from the command line instead — see the{' '}
          <a className="linkish" href="/source/docs/CONNECT-AN-ASSISTANT.md">connecting guide</a>.
        </div>
      </Section>

      <Section n={2} title="Gemini">
        {/*
          Stated before the steps rather than after them. These are Google's restrictions,
          not ours, and someone who does not meet them will otherwise follow four steps,
          fail at the end, and reasonably conclude that this app is broken.
        */}
        <div className="banner info">
          Gemini accepts custom apps only on a <b>personal</b> Google account — not a work
          or school one — for people <b>18 or over</b> in the <b>United States</b>. Those
          are Google's conditions for the feature, and none of them are visible until it
          refuses.
        </div>
        <ol className="connect-steps">
          <li>Open the Gemini <b>web</b> app and go to <b>Connected Apps</b>.</li>
          <li>Add a custom app and paste the address above.</li>
          <li>Approve the screen it sends you to.</li>
        </ol>
        <div className="hint">
          Connect it on the web once and it is available to Gemini on your phone as well.
        </div>
      </Section>

      <Section n={3} title="What a connected assistant can do">
        {/*
          These four lines are the consent screen's own words, deliberately. The approval
          page is served by the Worker and this page is the app; two surfaces describing
          one permission in two sets of words is how they come to describe two different
          permissions, and the one people actually read is the one shown at the moment of
          approval.
        */}
        <ul className="connect-list">
          <li>
            It can <b>read</b>: when you were recording, what the periods contained, and
            the image of any moment it asks for.
          </li>
          <li>It cannot record, delete, change anything, or create further access.</li>
          <li>
            You can revoke this at any time in <b>Settings › Account &amp; security</b>,
            where the connection appears beside your own tokens.
          </li>
        </ul>
        <div className="banner warn">
          Screen recordings contain whatever was on the screen. Password fields and areas
          you have blacked out are removed before storage; text secrets are not. Only
          connect an app you would show your screen to.
        </div>
        <div className="hint">
          Right now an assistant reads your history by looking at the screenshots
          themselves, and by asking when the screen changed. Searching by the <i>words</i>
          {' '}that were on screen is not yet switched on in the recorder, so a text search
          returns nothing — and says so, rather than implying the moment never happened.
        </div>
      </Section>

      <Section n={4} title="If it asks for a token instead">
        <div className="hint">
          Some tools want a header rather than an address — Claude Code, Gemini CLI,
          scripts of your own. Create a <b>read-only</b> token under{' '}
          <b>Settings › Account &amp; security › API tokens</b> and send it as{' '}
          <code>Authorization: Bearer …</code> to the same address. A read token can look
          at your history but cannot record or delete, which is the one to hand an
          assistant. It is shown once, at creation.
        </div>
      </Section>

      <Section n={5} title="Is this deployment answering?">
        <div className="hint">
          The first three questions an assistant asks, asked from this page. If a connector
          fails while these are green, the problem is at the other end — which is worth
          knowing before spending an evening on it.
        </div>
        <ul className="connect-checks">
          {checks.map((c) => (
            <li key={c.label}>
              {/* Its own marker rather than the recorder's .dot, which is red and pulsing
                  because that means "recording" — a red light against a check that has
                  simply not finished yet would report a failure that has not happened. */}
              <span className={`chk chk-${c.state}`} aria-hidden="true" />
              <b>{c.label}</b>
              <span style={{ color: c.state === 'bad' ? 'var(--warn)' : 'var(--dim)' }}>
                {c.detail}
              </span>
            </li>
          ))}
        </ul>
      </Section>
    </PaletteProvider>
  );
}
