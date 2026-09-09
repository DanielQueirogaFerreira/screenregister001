/**
 * The colours the codebase-evolution graph draws with, and the labels that explain them.
 *
 * A separate module from the view for one reason: this is the thing the legend and the
 * canvas must agree about, and while they were two hardcoded lists inside the renderer
 * they drifted. The graph coloured config files amber and the legend listed only
 * added/modified/deleted, so the most eye-catching colour on the picture had no entry —
 * a reader who noticed it had nowhere to look it up. Here both are derived from one table
 * and the agreement is checked by tests instead of by reading.
 */

/**
 * What happened to a file — drawn as the expanding ring around it, and never as the dot.
 *
 * These are the application's existing status colours, which is why they are not free to
 * move: green/blue/red for added/modified/deleted is the diff convention, and it is worth
 * more than any palette tuning.
 *
 * Because they are fixed, the file-kind hues below have to stay out of their way, and the
 * ring is what buys the room. An earlier version mixed the action colour into the dot, so
 * hue meant "what kind of file" on a cold frame and "what just happened" on a warm one.
 * The validator put a number on the cost: the code blue and the modified blue were ΔE 7.0
 * apart to normal vision, less than half the 15 needed to tell a pair apart at all. Ring
 * and fill are different shapes, so the same hue in each is never the same claim.
 */
export const ACTION_COLOUR: Record<string, string> = {
  A: '#35c98b',   // added
  M: '#4da3ff',   // modified
  D: '#f0645c',   // deleted
};

export const ACTION_LABEL: Record<string, string> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
};

/**
 * What a file is, by extension — and the single source of both the dot colour and the
 * legend entry that explains it.
 *
 * One table, because the two used to be separate lists and they drifted, which is the only
 * way a legend ever goes wrong. The graph coloured config files amber and the legend
 * listed only added/modified/deleted, so the most eye-catching colour on the picture had
 * no entry at all. A reader who noticed it had nowhere to look it up. Deriving the legend
 * from the palette makes that particular bug unrepresentable rather than merely fixed.
 *
 * Four slots, not seven. The earlier set spent a hue on .tsx separately from .ts and
 * another on .css, then gave docs and unknown files two different greys — and the palette
 * validator put numbers on what that cost: those two greys were ΔE 9.7 apart to normal
 * vision, well under the 15 needed to tell a pair apart at all, and purple-vs-blue was 4.7
 * under deuteranopia. Rare kinds are folded in rather than each holding a hue nobody can
 * separate.
 *
 * Checked with the palette validator against this panel's own background (#131922, not a
 * generic dark), on every pair rather than only neighbours: worst CVD ΔE 10.0, worst
 * normal-vision 16.3, all four above 3:1 contrast.
 *
 * The one check it does not pass is the chroma floor, and that is the intent rather than a
 * concession: the grey is meant to read as grey. It is the fold-in slot, not a fourth
 * series. Two lighter greys were tried and both dropped the separation from the teal below
 * the floor — 14.0 and 13.2 — so darker is also the only thing that works. The grey is in that check rather than exempt from it — it was the pair
 * that failed. At #7b8798 it sat ΔE 4.6 from the teal under deuteranopia, so a migration
 * and a README were the same dot; darkening it to #5c6672 fixes that and suits the
 * fold-in slot better anyway, since reading as recessive is its job.
 *
 * Code is violet rather than blue on purpose. Blue belongs to "modified" in ACTION_COLOUR
 * above, and while the ring keeps the two apart, spending the bed's largest category on a
 * near-neighbour of a status colour is asking for the confusion back.
 */
export interface FileKind {
  id: string;
  label: string;
  colour: string;
  /** What it covers, for the legend. Kept short: this is a caption, not documentation. */
  hint: string;
  /**
   * Case-insensitive, and that is not hypothetical tidiness — a `Deploy.YML` or a `.SQL`
   * dump fell through to the grey "everything else" slot, so a config file was drawn as
   * a document. Found by a test that asked the question rather than by looking at a graph.
   */
  match: RegExp | null;
}

export const FILE_KINDS: FileKind[] = [
  {
    id: 'code', label: 'code', colour: '#9c6ade', hint: 'ts, tsx, js, css, html',
    match: /\.(tsx?|jsx?|mjs|cjs|css|html)$/i,
  },
  {
    id: 'config', label: 'config & CI', colour: '#c87820', hint: 'yml, json, toml',
    match: /\.(ya?ml|toml|json)$/i,
  },
  {
    id: 'schema', label: 'migrations', colour: '#1f9c78', hint: 'sql',
    match: /\.sql$/i,
  },
  // Last, and matches everything left. Grey on purpose: docs and odds and ends are the
  // backdrop the coloured work happens against.
  { id: 'other', label: 'docs & other', colour: '#5c6672', hint: 'md, txt, everything else', match: null },
];

const OTHER_KIND = FILE_KINDS[FILE_KINDS.length - 1]!;

/** Extension families, so a glance says "this was all config" without reading labels. */
export function fileKind(name: string): FileKind {
  for (const k of FILE_KINDS) if (k.match?.test(name)) return k;
  return OTHER_KIND;
}

export const fileColour = (name: string): string => fileKind(name).colour;
