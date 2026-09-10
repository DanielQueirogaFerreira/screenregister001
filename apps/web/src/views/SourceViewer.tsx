import { useEffect, useMemo, useRef, useState } from 'react';
import {
  hasPreview, highlightLines, langFor, measure, parseMarkdown, prettyJson, viewerFor,
  type MdBlock, type MdSpan, type Token, type Viewer,
} from '@sr/core';

/**
 * What is actually inside the file.
 *
 * A node on the graph is a file, and the question anyone asks after "what happened to it"
 * is "what is in it". The answer depends on the file: a page wants to be seen as a page, a
 * diagram as a diagram, a README as prose, a module as code with line numbers. Showing all
 * of them as monospace is the lazy answer and throws away most of what the file is.
 *
 * Where a file has two useful views they are shown side by side when there is room and
 * behind a toggle when there is not, because on a phone half a pane of each is neither.
 *
 * The parsing and highlighting all live in @sr/core, tested without a browser. Everything
 * it returns is a token list, so nothing here goes through innerHTML — a file in the
 * repository cannot inject markup into the page that displays it. The single exception is
 * the HTML preview, which is a document by definition and is sandboxed as one.
 */

/**
 * Below this the two panes are too narrow to be worth having; above it, offer both.
 *
 * 820 rather than 900 so a 1024px laptop still gets the side-by-side view. The number is
 * measured against the viewer's own element, not the window: it sits inside a panel, and
 * in fullscreen inside the stage, so the window's width is not the width it has.
 */
const SPLIT_AT = 820;

type Pane = 'preview' | 'code' | 'split';

export function SourceViewer({ path, onClose }: { path: string; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pane, setPane] = useState<Pane>('preview');
  const [wide, setWide] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  const viewer = viewerFor(path);
  const previewable = hasPreview(viewer);

  useEffect(() => {
    setText(null);
    setError(null);
    if (viewer === 'image') return;   // shown by URL, never read as text
    let cancelled = false;
    fetch(`/source/${path}`)
      .then((r) => {
        if (!r.ok) throw new Error(`the file answered ${r.status}`);
        return r.text();
      })
      .then((t) => { if (!cancelled) setText(t); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [path, viewer]);

  // Measured from the element rather than the window: this sits inside a panel, and in
  // fullscreen inside the stage, so the window's width is not the width it actually has.
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setWide(el.clientWidth >= SPLIT_AT));
    ro.observe(el);
    setWide(el.clientWidth >= SPLIT_AT);
    return () => ro.disconnect();
  }, []);

  // Escape closes, which is what every overlay on this page already does.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const effective: Pane = !previewable ? 'code' : wide && pane === 'split' ? 'split' : pane;
  const size = text === null ? null : measure(text);

  return (
    <div className="src-viewer" ref={box} role="dialog" aria-label={`Contents of ${path}`}>
      <div className="src-head">
        <div className="src-title">
          <b>{path.split('/').pop()}</b>
          <span title={path}>{path}</span>
        </div>
        <div className="src-tools">
          {size && (
            <span className="src-meta">
              {size.lines.toLocaleString()} lines · {(size.chars / 1024).toFixed(1)} KB
            </span>
          )}
          {previewable && (
            <div className="src-tabs" role="group" aria-label="How to show the file">
              <button className={effective === 'preview' ? 'on' : ''}
                onClick={() => setPane('preview')}>{previewLabel(viewer)}</button>
              <button className={effective === 'code' ? 'on' : ''}
                onClick={() => setPane('code')}>Code</button>
              {/* Offered only when there is room for it: half a pane of each is neither. */}
              {wide && (
                <button className={effective === 'split' ? 'on' : ''}
                  onClick={() => setPane('split')}>Both</button>
              )}
            </div>
          )}
          <a className="button-link src-raw" href={`/source/${path}`} target="_blank"
            rel="noreferrer">Raw</a>
          <button onClick={onClose} className="src-close" aria-label="Close">×</button>
        </div>
      </div>

      {error && <div className="banner bad" style={{ margin: 12 }}>Could not read it: {error}</div>}
      {!error && text === null && viewer !== 'image' && (
        <div className="empty" style={{ padding: 30 }}>Reading the file…</div>
      )}

      {!error && (viewer === 'image' || text !== null) && (
        <div className={`src-body ${effective}`}>
          {effective !== 'code' && (
            <div className="src-pane src-preview">
              <Preview viewer={viewer} path={path} text={text ?? ''} />
            </div>
          )}
          {effective !== 'preview' && (
            <div className="src-pane src-code">
              <Code text={viewer === 'json' ? prettyJson(text ?? '').text : text ?? ''}
                path={path} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const previewLabel = (v: Viewer) =>
  v === 'html' ? 'Page' : v === 'svg' ? 'Drawing' : v === 'image' ? 'Image' : 'Reading';

function Preview({ viewer, path, text }: { viewer: Viewer; path: string; text: string }) {
  if (viewer === 'image') {
    return <img className="src-img" src={`/source/${path}`} alt={path} />;
  }
  if (viewer === 'markdown') return <Markdown blocks={parseMarkdown(text)} />;
  if (viewer === 'html' || viewer === 'svg') {
    return (
      <div className="src-doc">
        {/*
          The note goes ABOVE the frame, not after it.
          After it, the full-height iframe pushed it out of sight — and a blank preview pane
          with its explanation unreachable is the one arrangement where the note was
          actually needed. A page assembled by script shows only its shell here, and
          without this line that reads as a broken viewer.
        */}
        {viewer === 'html' && (
          <p className="src-note">
            Scripts are blocked, so this is the file&rsquo;s own markup and styles — a page
            that builds itself with script shows only its shell.
          </p>
        )}
        {/*
          A document, so it is rendered as one — and sandboxed with nothing allowed.
          Blocking scripts is the deliberate choice for a viewer: what it should show is
          what the file says, not a simulation of the built application.
        */}
        <iframe className="src-frame" title={`Preview of ${path}`} sandbox="" srcDoc={text} />
      </div>
    );
  }
  return null;
}

/** Markdown as React nodes. No innerHTML anywhere — see the note at the top of this file. */
function Markdown({ blocks }: { blocks: MdBlock[] }) {
  if (blocks.length === 0) return <p className="src-note">This file is empty.</p>;
  return (
    <div className="src-md">
      {blocks.map((b, i) => {
        if (b.kind === 'rule') return <hr key={i} />;
        if (b.kind === 'code') {
          return <pre key={i} className="src-md-code"><code>{b.text}</code></pre>;
        }
        if (b.kind === 'heading') {
          const H = (`h${Math.min(6, b.level + 1)}`) as 'h2';
          return <H key={i}><Spans spans={b.spans} /></H>;
        }
        if (b.kind === 'quote') {
          return <blockquote key={i}><Spans spans={b.spans} /></blockquote>;
        }
        if (b.kind === 'list') {
          const L = b.ordered ? 'ol' : 'ul';
          return (
            <L key={i}>
              {b.items.map((item, k) => <li key={k}><Spans spans={item} /></li>)}
            </L>
          );
        }
        return <p key={i}><Spans spans={b.spans} /></p>;
      })}
    </div>
  );
}

function Spans({ spans }: { spans: MdSpan[] }) {
  return (
    <>
      {spans.map((s, i) => {
        let node: React.ReactNode = s.text;
        if (s.code) node = <code key={i}>{s.text}</code>;
        else if (s.strong) node = <b key={i}>{s.text}</b>;
        else if (s.em) node = <i key={i}>{s.text}</i>;
        // rel is not decoration: a preview renders files from a repository, and a link out
        // of it should not hand the opener a window reference.
        if (s.href) {
          return (
            <a key={i} href={s.href} target="_blank" rel="noreferrer noopener">{node}</a>
          );
        }
        return <span key={i}>{node}</span>;
      })}
    </>
  );
}

function Code({ text, path }: { text: string; path: string }) {
  const lines = useMemo(() => highlightLines(text, langFor(path)), [text, path]);
  const width = String(lines.length).length;
  return (
    <div className="src-lines">
      {lines.map((tokens, i) => (
        <div className="src-line" key={i}>
          <span className="src-ln" style={{ width: `${width}ch` }}>{i + 1}</span>
          <code>
            {tokens.length === 0 ? '​' : tokens.map((t: Token, k) => (
              <span key={k} className={`t-${t.kind}`}>{t.text}</span>
            ))}
          </code>
        </div>
      ))}
    </div>
  );
}
