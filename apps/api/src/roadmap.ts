/**
 * What is built, what is being built, and what is next.
 *
 * Kept in the repository rather than a tracker so it moves in the same commit as the work
 * it describes — a roadmap that can drift from the code is worse than none, because it
 * gets believed. The status page renders this directly, so "next tasks" on the dashboard
 * is whatever the last person to ship actually wrote down.
 */

export type PhaseStatus = 'done' | 'in_progress' | 'planned';

export interface Phase {
  id: number;
  title: string;
  status: PhaseStatus;
  summary: string;
  items: { text: string; done: boolean }[];
}

export const ROADMAP: Phase[] = [
  {
    id: 1,
    title: 'Capture and change detection',
    status: 'done',
    summary: 'Browser screen capture that stores only what changed.',
    items: [
      { text: 'getDisplayMedia capture at 1–30 FPS', done: true },
      { text: '160×90 luma plane, 16×9 grid difference', done: true },
      { text: 'Preroll buffer: transient suppression, settle selection, burst capping', done: true },
      { text: 'hold_ms, so a motionless hour is one row', done: true },
      { text: 'WebP encoding in a worker thread', done: true },
    ],
  },
  {
    id: 2,
    title: 'Cloudflare as the system of record',
    status: 'done',
    summary: 'R2 holds the frames, D1 holds the timeline. The browser holds nothing durable.',
    items: [
      { text: 'Worker ingest over R2 and D1', done: true },
      { text: 'Server-enforced 7-day retention sweep', done: true },
      { text: 'Bounded in-memory upload queue with retry', done: true },
      { text: 'Capture pauses when uploads cannot drain', done: true },
      { text: 'One origin serves UI, API and MCP', done: true },
    ],
  },
  {
    id: 3,
    title: 'LLM access',
    status: 'done',
    summary: 'An assistant can read the last seven days over MCP or plain REST.',
    items: [
      { text: 'MCP over Streamable HTTP, five read tools', done: true },
      { text: 'Mirrored REST plus an OpenAPI document', done: true },
      { text: 'Scenes and timeline share one query layer', done: true },
    ],
  },
  {
    id: 4,
    title: 'Accounts and the security layer',
    status: 'done',
    summary: 'Email and password, with the access controls a screen archive needs.',
    items: [
      { text: 'PBKDF2-SHA256 at 600,000 iterations', done: true },
      { text: 'HttpOnly SameSite=Strict sessions, stored only as hashes', done: true },
      { text: 'CSRF origin checks on every cookie-authenticated write', done: true },
      { text: 'Per-IP and per-address rate limiting, plus lockout', done: true },
      { text: 'Scoped, revocable API tokens for MCP clients', done: true },
      { text: 'Audit log of sign-ins, failures and changes', done: true },
      { text: 'Second factor (TOTP)', done: false },
      { text: 'Transactional email provider wired up', done: false },
    ],
  },
  {
    id: 5,
    title: 'Operational visibility',
    status: 'in_progress',
    summary: 'Know what the platform is doing without reading a deploy log.',
    items: [
      { text: 'Service probes recorded from inside the Worker', done: true },
      { text: 'Deployment history written by CI', done: true },
      { text: 'Public status page with health over time', done: true },
      { text: 'Alerting when a service stays down', done: false },
    ],
  },
  {
    id: 6,
    title: 'Frame identity',
    status: 'done',
    summary: 'Every frame says when it was taken, on what device, and for whom — in one short code.',
    items: [
      { text: 'device_id on every frame, written by the server from the session', done: true },
      { text: 'Frame stamp: millisecond time, device and account in ~29 characters', done: true },
      { text: 'Capture time decodes from the code offline, with no lookup', done: true },
      { text: 'Identities carried as one-way fingerprints, never in the clear', done: true },
      { text: 'Stamp shown live beside the frame it identifies', done: true },
      { text: 'Inspector that resolves a stamp to the full record', done: true },
    ],
  },
  {
    id: 7,
    title: 'Enrichment',
    status: 'planned',
    summary: 'Turn "download 400 screenshots" into "search text, fetch three images".',
    items: [
      { text: 'OCR over stored frames', done: false },
      { text: 'Captions and embeddings', done: false },
      { text: 'Text search across the timeline', done: false },
      // The prerequisite for any credible redaction: the browser hands over pixels and
      // nothing else, so a password field cannot be located until the text is read.
      { text: 'Redact sensitive regions, once OCR can find them', done: false },
    ],
  },
  {
    id: 8,
    title: 'Native mobile capture',
    status: 'planned',
    summary: 'iOS and Android, posting to the same ingest contract.',
    items: [
      { text: 'iOS ReplayKit client', done: false },
      { text: 'Android MediaProjection client', done: false },
    ],
  },
];

/** Progress as a fraction of checklist items, which is coarse but not gameable. */
export function roadmapProgress(): { done: number; total: number; phase: Phase | null } {
  const items = ROADMAP.flatMap((p) => p.items);
  return {
    done: items.filter((i) => i.done).length,
    total: items.length,
    phase: ROADMAP.find((p) => p.status === 'in_progress') ?? null,
  };
}
