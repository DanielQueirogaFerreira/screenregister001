/**
 * Turning a file into something worth looking at.
 *
 * A node on the graph is a file, and the question anyone asks next is what is in it. What
 * "in it" means depends entirely on the file: a page wants to be seen as a page, a diagram
 * as a diagram, a README as prose, and a module as code with line numbers. Showing every
 * one of them as a wall of monospace is the lazy answer and throws away most of what the
 * file is.
 *
 * Everything here returns TOKENS rather than HTML strings. Nothing this module produces is
 * ever handed to innerHTML, so a file in the repository — or a file someone adds later —
 * cannot inject markup into the page that displays it. The one exception is the HTML
 * preview, which is deliberately rendered as a document and is therefore sandboxed by the
 * caller; that is a decision about an iframe, not about string escaping.
 */

export type Viewer = 'html' | 'svg' | 'image' | 'markdown' | 'json' | 'code';

/** How a file wants to be shown. */
export function viewerFor(path: string): Viewer {
  const p = path.toLowerCase();
  if (/\.html?$/.test(p)) return 'html';
  if (/\.svg$/.test(p)) return 'svg';
  if (/\.(png|jpe?g|gif|webp|avif|ico|bmp)$/.test(p)) return 'image';
  if (/\.(md|markdown)$/.test(p)) return 'markdown';
  if (/\.json$/.test(p)) return 'json';
  return 'code';
}

/** True when the file has a second, non-code way of being seen that is worth offering. */
export const hasPreview = (v: Viewer): boolean =>
  v === 'html' || v === 'svg' || v === 'markdown' || v === 'image';

export type Lang = 'ts' | 'css' | 'sql' | 'yaml' | 'json' | 'shell' | 'md' | 'html' | 'plain';

export function langFor(path: string): Lang {
  const p = path.toLowerCase();
  if (/\.(tsx?|jsx?|mjs|cjs)$/.test(p)) return 'ts';
  if (/\.css$/.test(p)) return 'css';
  if (/\.sql$/.test(p)) return 'sql';
  if (/\.(ya?ml|toml)$/.test(p)) return 'yaml';
  if (/\.json$/.test(p)) return 'json';
  if (/(^|\/)(\.gitignore|dockerfile)$|\.(sh|bash|env|example)$/.test(p)) return 'shell';
  if (/\.(md|markdown)$/.test(p)) return 'md';
  if (/\.html?$/.test(p)) return 'html';
  return 'plain';
}

export type TokenKind = 'plain' | 'comment' | 'string' | 'number' | 'keyword' | 'tag';
export interface Token { text: string; kind: TokenKind }

const KEYWORDS: Record<Lang, string[]> = {
  ts: ['import', 'export', 'from', 'const', 'let', 'var', 'function', 'return', 'if', 'else',
    'for', 'while', 'class', 'extends', 'implements', 'interface', 'type', 'enum', 'new',
    'await', 'async', 'try', 'catch', 'finally', 'throw', 'typeof', 'instanceof', 'in', 'of',
    'this', 'super', 'null', 'undefined', 'true', 'false', 'void', 'as', 'default', 'static',
    'readonly', 'private', 'public', 'protected', 'switch', 'case', 'break', 'continue', 'do',
    'delete', 'yield', 'satisfies'],
  sql: ['select', 'insert', 'update', 'delete', 'from', 'where', 'create', 'table', 'index',
    'alter', 'drop', 'primary', 'key', 'foreign', 'references', 'not', 'null', 'default',
    'unique', 'and', 'or', 'join', 'left', 'inner', 'on', 'group', 'order', 'by', 'limit',
    'integer', 'text', 'real', 'blob', 'values', 'into', 'set', 'if', 'exists', 'begin',
    'commit', 'transaction', 'distinct', 'count', 'sum', 'coalesce', 'as'],
  css: [],
  yaml: [],
  json: ['true', 'false', 'null'],
  shell: [],
  md: [],
  html: [],
  plain: [],
};

/** Which comment syntaxes a language uses. */
const COMMENTS: Record<Lang, { line?: string; block?: [string, string] }> = {
  ts: { line: '//', block: ['/*', '*/'] },
  css: { block: ['/*', '*/'] },
  sql: { line: '--', block: ['/*', '*/'] },
  yaml: { line: '#' },
  shell: { line: '#' },
  json: {},
  md: {},
  html: { block: ['<!--', '-->'] },
  plain: {},
};

const isWord = (c: string) => /[A-Za-z0-9_$]/.test(c);

/**
 * A small, honest highlighter.
 *
 * It knows comments, strings, numbers and keywords, and nothing else. That is deliberate:
 * a real parser per language is not the job, and a highlighter that half-guesses at
 * structure produces confidently wrong colour, which is worse than none. These four
 * categories are the ones that carry meaning at a glance — where the prose is, where the
 * literals are — and they can be found without understanding the language.
 */
export function highlight(code: string, lang: Lang): Token[] {
  const cm = COMMENTS[lang];
  const keywords = new Set(KEYWORDS[lang]);
  const caseSensitive = lang !== 'sql';
  const out: Token[] = [];
  let plain = '';
  const flush = () => { if (plain) { out.push({ text: plain, kind: 'plain' }); plain = ''; } };
  const push = (text: string, kind: TokenKind) => { flush(); out.push({ text, kind }); };

  let i = 0;
  while (i < code.length) {
    const rest = code.slice(i);

    if (cm.block && rest.startsWith(cm.block[0])) {
      const end = code.indexOf(cm.block[1], i + cm.block[0].length);
      const stop = end === -1 ? code.length : end + cm.block[1].length;
      push(code.slice(i, stop), 'comment');
      i = stop;
      continue;
    }
    if (cm.line && rest.startsWith(cm.line)) {
      const nl = code.indexOf('\n', i);
      const stop = nl === -1 ? code.length : nl;
      push(code.slice(i, stop), 'comment');
      i = stop;
      continue;
    }

    const q = code[i]!;
    if (q === '"' || q === "'" || q === '`') {
      let j = i + 1;
      while (j < code.length) {
        if (code[j] === '\\') { j += 2; continue; }
        if (code[j] === q) { j++; break; }
        // An unterminated single-quoted string must not swallow the rest of the file:
        // apostrophes in comments and prose are common and would do exactly that.
        if (code[j] === '\n' && q !== '`') break;
        j++;
      }
      push(code.slice(i, j), 'string');
      i = j;
      continue;
    }

    if (/[0-9]/.test(q) && !isWord(code[i - 1] ?? ' ')) {
      let j = i;
      while (j < code.length && /[0-9a-fA-FxX._]/.test(code[j]!)) j++;
      push(code.slice(i, j), 'number');
      i = j;
      continue;
    }

    if (isWord(q)) {
      let j = i;
      while (j < code.length && isWord(code[j]!)) j++;
      const word = code.slice(i, j);
      const probe = caseSensitive ? word : word.toLowerCase();
      if (keywords.has(probe)) push(word, 'keyword');
      else plain += word;
      i = j;
      continue;
    }

    plain += q;
    i++;
  }
  flush();
  return out;
}

/** Split highlighted tokens into lines, so the view can number them. */
export function highlightLines(code: string, lang: Lang): Token[][] {
  const lines: Token[][] = [[]];
  for (const t of highlight(code, lang)) {
    const parts = t.text.split('\n');
    parts.forEach((part, k) => {
      if (k > 0) lines.push([]);
      if (part) lines[lines.length - 1]!.push({ text: part, kind: t.kind });
    });
  }
  return lines;
}

/** Pretty-print JSON, or hand back the original when it will not parse. */
export function prettyJson(text: string): { text: string; ok: boolean } {
  try {
    return { text: JSON.stringify(JSON.parse(text), null, 2), ok: true };
  } catch {
    // A JSON file that does not parse is a fact worth showing, not an error to swallow.
    return { text, ok: false };
  }
}

// --- markdown ---------------------------------------------------------------------------

export interface MdSpan {
  text: string;
  code?: boolean;
  strong?: boolean;
  em?: boolean;
  href?: string;
}

export type MdBlock =
  | { kind: 'heading'; level: number; spans: MdSpan[] }
  | { kind: 'para'; spans: MdSpan[] }
  | { kind: 'list'; ordered: boolean; items: MdSpan[][] }
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'quote'; spans: MdSpan[] }
  | { kind: 'rule' };

/**
 * Only links the page can safely follow.
 *
 * `javascript:` and `data:` in a markdown link are the oldest injection in the format, and
 * this renderer exists to show files from a repository — including whatever lands in it
 * next. Anything that is not plainly http, https, mailto or a relative path becomes plain
 * text rather than a link.
 */
export function safeHref(href: string): string | undefined {
  const h = href.trim();
  if (/^(https?:|mailto:)/i.test(h)) return h;
  if (/^[./#]/.test(h) && !/^\/\//.test(h)) return h;
  return undefined;
}

/** Inline markdown: code, bold, italic, links. Everything else stays literal. */
export function parseInline(src: string): MdSpan[] {
  const out: MdSpan[] = [];
  let plain = '';
  const flush = () => { if (plain) { out.push({ text: plain }); plain = ''; } };

  /**
   * Emphasis may not begin or end on a space.
   *
   * Without this, `2 * 3 * 4` becomes "2 <em> 3 </em> 4" — arithmetic silently rendered as
   * italics, which is how a naive renderer mangles the very content someone opened the file
   * to read. It is also the rule real markdown uses.
   */
  const emphasised = (inner: string) => inner.length > 0 && !/^\s|\s$/.test(inner);

  /**
   * Underscore emphasis only at a word boundary, so `some_var_name` stays an identifier.
   * Asterisks have no such rule because they do not appear inside names.
   */
  const atWordBoundary = (i: number) => i === 0 || !/[A-Za-z0-9_]/.test(src[i - 1]!);

  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i);

    const code = /^`([^`]+)`/.exec(rest);
    if (code) { flush(); out.push({ text: code[1]!, code: true }); i += code[0].length; continue; }

    // One level of nested parentheses, so `(1)` inside a URL does not end the match early
    // and leave a stray bracket behind in the text.
    const link = /^\[([^\]]*)\]\(([^()\s]*(?:\([^()]*\)[^()\s]*)*)\)/.exec(rest);
    if (link) {
      const href = safeHref(link[2]!);
      flush();
      // A refused scheme keeps its label and loses its link, rather than vanishing.
      out.push(href ? { text: link[1]!, href } : { text: link[1]! });
      i += link[0].length;
      continue;
    }

    const strongStar = /^\*\*([^*]+)\*\*/.exec(rest);
    if (strongStar && emphasised(strongStar[1]!)) {
      flush(); out.push({ text: strongStar[1]!, strong: true }); i += strongStar[0].length; continue;
    }
    const strongBar = /^__([^_]+)__/.exec(rest);
    if (strongBar && emphasised(strongBar[1]!) && atWordBoundary(i)) {
      flush(); out.push({ text: strongBar[1]!, strong: true }); i += strongBar[0].length; continue;
    }
    const emStar = /^\*([^*]+)\*/.exec(rest);
    if (emStar && emphasised(emStar[1]!)) {
      flush(); out.push({ text: emStar[1]!, em: true }); i += emStar[0].length; continue;
    }
    const emBar = /^_([^_]+)_/.exec(rest);
    if (emBar && emphasised(emBar[1]!) && atWordBoundary(i)) {
      flush(); out.push({ text: emBar[1]!, em: true }); i += emBar[0].length; continue;
    }

    plain += src[i];
    i++;
  }
  flush();
  return out;
}

/**
 * Enough markdown for a README.
 *
 * Headings, paragraphs, lists, fenced code, block quotes and rules. Not a full
 * implementation and not trying to be — tables, footnotes and nested lists are rare in the
 * files this shows, and every feature added here is another chance to render something
 * wrongly while looking authoritative.
 */
export function parseMarkdown(src: string): MdBlock[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: MdBlock[] = [];
  let para: string[] = [];

  const closePara = () => {
    if (para.length) {
      blocks.push({ kind: 'para', spans: parseInline(para.join(' ')) });
      para = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    const fence = /^\s*```(\S*)\s*$/.exec(line);
    if (fence) {
      closePara();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) { body.push(lines[i]!); i++; }
      blocks.push({ kind: 'code', lang: fence[1] ?? '', text: body.join('\n') });
      continue;
    }

    if (/^\s*$/.test(line)) { closePara(); continue; }
    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) { closePara(); blocks.push({ kind: 'rule' }); continue; }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      closePara();
      blocks.push({ kind: 'heading', level: heading[1]!.length, spans: parseInline(heading[2]!) });
      continue;
    }

    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) { closePara(); blocks.push({ kind: 'quote', spans: parseInline(quote[1]!) }); continue; }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      closePara();
      const ordered = !!numbered;
      const items: MdSpan[][] = [parseInline((bullet ?? numbered)![1]!)];
      // Consecutive items of the SAME sort join one list; a switch starts a new one, or a
      // numbered line after bullets would silently become a bullet.
      while (i + 1 < lines.length) {
        const nb = /^\s*[-*+]\s+(.*)$/.exec(lines[i + 1]!);
        const nn = /^\s*\d+[.)]\s+(.*)$/.exec(lines[i + 1]!);
        if (ordered ? !nn : !nb) break;
        items.push(parseInline((nb ?? nn)![1]!));
        i++;
      }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }

    para.push(line.trim());
  }
  closePara();
  return blocks;
}

/** Line and character counts, for the header of a viewer. */
export function measure(text: string): { lines: number; chars: number } {
  return { lines: text === '' ? 0 : text.split('\n').length, chars: text.length };
}
