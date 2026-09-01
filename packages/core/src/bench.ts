/**
 * Tuning bench. Run: `npx vite-node packages/core/src/bench.ts`
 *
 * Prints how each scenario survives the timeline processor. This is the tool for
 * adjusting thresholds — change a default, re-run, compare the compression column.
 */
import { DEFAULT_SETTINGS, type CaptureSettings } from '@sr/schema';
import { TimelineProcessor } from './timeline.js';
import { desktop, scrolled, withRect, blend, noisy } from './fixtures.js';

function run(lumas: Uint8Array[], s: CaptureSettings) {
  const p = new TimelineProcessor<number>(s);
  const step = 1000 / s.captureFps;
  const out: { seq: number; reason: string }[] = [];
  lumas.forEach((luma, i) => {
    const tMs = Math.round(i * step);
    p.push({ seq: i, tMs, luma, payload: i });
    out.push(...p.drain(tMs).map((d) => ({ seq: d.frame.seq, reason: d.reason })));
  });
  out.push(...p.flush().map((d) => ({ seq: d.frame.seq, reason: d.reason })));
  return { out, stats: p.stats, durationS: (lumas.length * step) / 1000 };
}

const base = desktop();
const scenarios: { name: string; fps: number; lumas: Uint8Array[] }[] = [
  { name: 'idle 10 min', fps: 1, lumas: Array.from({ length: 601 }, () => base) },
  { name: 'idle 10 min + noise', fps: 1, lumas: Array.from({ length: 601 }, (_, i) => noisy(base, 2 + (i % 2))) },
  {
    name: 'tooltip flicker x10',
    fps: 30,
    lumas: Array.from({ length: 600 }, (_, i) =>
      // offset so frame 0 is NOT mid-tooltip; otherwise the reference captures the
      // tooltip and its disappearance reads as a real change.
      i % 60 >= 30 && i % 60 < 36 ? withRect(base, 60, 40, 30, 25, 240) : base,
    ),
  },
  {
    name: 'window switch',
    fps: 30,
    lumas: [
      ...Array(60).fill(base),
      ...Array.from({ length: 9 }, (_, i) => blend(base, desktop(3), (i + 1) / 10)),
      ...Array(231).fill(desktop(3)),
    ],
  },
  { name: 'continuous scroll 10s', fps: 30, lumas: Array.from({ length: 300 }, (_, i) => scrolled(base, i * 3)) },
  { name: 'typing (change every 4f)', fps: 30, lumas: Array.from({ length: 300 }, (_, i) => desktop(Math.floor(i / 4))) },
];

const KB_PER_FRAME = 110; // 1080p WebP q70, measured mid-range
console.log(
  'scenario'.padEnd(26) + 'fps'.padStart(4) + 'sampled'.padStart(9) + 'stored'.padStart(8) +
    'kept'.padStart(8) + 'reasons'.padStart(10) + '   est. size',
);
console.log('-'.repeat(92));
for (const sc of scenarios) {
  const { out, stats, durationS } = run(sc.lumas, { ...DEFAULT_SETTINGS, captureFps: sc.fps });
  const kept = ((stats.stored / stats.sampled) * 100).toFixed(1) + '%';
  const counts = out.reduce<Record<string, number>>((a, d) => ((a[d.reason] = (a[d.reason] ?? 0) + 1), a), {});
  const size = ((stats.stored * KB_PER_FRAME) / 1024).toFixed(1) + ' MB';
  const raw = ((stats.sampled * KB_PER_FRAME) / 1024).toFixed(0) + ' MB raw';
  console.log(
    sc.name.padEnd(26) + String(sc.fps).padStart(4) + String(stats.sampled).padStart(9) +
      String(stats.stored).padStart(8) + kept.padStart(8) + '  ' +
      Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(' ').padEnd(34) +
      `${size} vs ${raw}  (${durationS}s)`,
  );
}
