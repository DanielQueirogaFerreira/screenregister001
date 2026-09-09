import { chromium } from 'playwright';
import { createWorker } from 'tesseract.js';
import sharp from 'sharp';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';

const DIR = process.argv[2];

/**
 * The four text sizes a screen recorder has to survive, and where they sit on screen.
 * Reported separately because they do not degrade together: 15px prose on white stays
 * readable long after 11px chrome on dark has turned to mush, and an average over the
 * whole frame hides exactly that.
 */
const SCREENS = {
  'screen.html': [
    { id: 'chrome',   label: '11px UI chrome, dark',   sel: '#chrome' },
    { id: 'code',     label: '13px code, dark',        sel: '#code' },
    { id: 'doc',      label: '15px prose, light',      sel: '#doc' },
    { id: 'terminal', label: '12px terminal, black',   sel: '#term' },
  ],
  'screen2.html': [
    { id: 'chrome',   label: '11px UI chrome, dark',   sel: '#chrome' },
    { id: 'table',    label: '11px dense table, light', sel: 'table' },
    { id: 'side',     label: '12px prose, white',      sel: '#side' },
    { id: 'caption',  label: '13px over a photo',      sel: '.cap' },
  ],
};
const REGIONS = SCREENS[process.env.SCREEN ?? 'screen.html'];

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
await page.goto(`file://${process.cwd()}/${process.env.SCREEN ?? 'screen.html'}`);
await page.waitForTimeout(300);

for (const r of REGIONS) {
  r.box = await page.$eval(r.sel, (el) => {
    const b = el.getBoundingClientRect();
    return { left: Math.round(b.x), top: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) };
  });
  r.truth = await page.$eval(r.sel, (el) => el.innerText);
}
await browser.close();

const norm = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** Character-level similarity, 0..1. Levenshtein over the normalised strings. */
function similarity(a, b) {
  a = norm(a); b = norm(b);
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}

// Language data from the local npm copy: the CDN tesseract.js reaches for by default is
// blocked by this sandbox's egress policy, and the data is the same file either way.
const worker = await createWorker('eng', undefined, { langPath: '/tmp/claude-0/-home-user-screenregister001/962978fb-9ff4-541b-a3d9-6757af3735d6/scratchpad/bench/langdata', gzip: true });
const files = ['reference.png', ...readdirSync(DIR).filter((f) => f.endsWith('.webp')).sort().reverse()];
const sizes = JSON.parse(readFileSync(`${DIR}/sizes.json`, 'utf8'));
const results = [];

for (const file of files) {
  const buf = readFileSync(`${DIR}/${file}`);
  const row = { file, bytes: buf.length, regions: {} };
  for (const r of REGIONS) {
    const crop = await sharp(buf).extract(r.box).png().toBuffer();
    const { data } = await worker.recognize(crop);
    row.regions[r.id] = { text: data.text, vsTruth: similarity(data.text, r.truth) };
  }
  results.push(row);
  console.error(`ocr ${file} done`);
}
await worker.terminate();

// Relative to what a lossless capture itself scores, because tesseract is imperfect on
// code and symbols even with perfect pixels. The absolute number answers "how readable",
// the relative one answers "how much did compression cost".
const ref = results[0];
for (const row of results) {
  for (const r of REGIONS) {
    const refText = ref.regions[r.id].text;
    row.regions[r.id].vsReference = similarity(row.regions[r.id].text, refText);
  }
}
writeFileSync(`${DIR}/legibility.json`, JSON.stringify({ sizes, results }, null, 2));

const pct = (n) => `${(n * 100).toFixed(1)}%`;
console.log('\nfile          KB     ' + REGIONS.map((r) => r.id.padEnd(9)).join(''));
console.log('                     (character accuracy vs the lossless reference)');
for (const row of results) {
  console.log(
    row.file.padEnd(14) +
    (row.bytes / 1024).toFixed(1).padStart(5) + '  ' +
    REGIONS.map((r) => pct(row.regions[r.id].vsReference).padEnd(9)).join(''),
  );
}
console.log('\nabsolute accuracy against the known on-screen text:');
for (const row of results) {
  console.log(
    row.file.padEnd(14) + '       ' +
    REGIONS.map((r) => pct(row.regions[r.id].vsTruth).padEnd(9)).join(''),
  );
}
