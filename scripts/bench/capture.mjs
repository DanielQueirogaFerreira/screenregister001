import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';

const OUT = process.argv[2];
mkdirSync(OUT, { recursive: true });

// The qualities worth deciding between. 0.7 is what ships today.
const QUALITIES = [0.9, 0.8, 0.7, 0.6, 0.5, 0.45, 0.4, 0.35, 0.3, 0.25, 0.2];

const browser = await chromium.launch({
  // The sandbox ships a Chromium older than this Playwright expects, and downloading a
  // second one is both blocked and unnecessary: the encoder is what matters here.
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
await page.goto(`file://${process.cwd()}/${process.env.SCREEN ?? 'screen.html'}`);
await page.waitForTimeout(300);

// Lossless reference. Every measurement below is against this, not against another
// lossy encode — the earlier bench could only compare re-encodes of already-lossy frames.
const png = await page.screenshot({ type: 'png' });
writeFileSync(`${OUT}/reference.png`, png);

// Encode in the page, with the browser's own WebP encoder. This is not an approximation
// of what the recorder produces — OffscreenCanvas.convertToBlob is the exact call in
// apps/web/src/capture/worker.ts, running in the same engine.
const encoded = await page.evaluate(async ({ b64, qualities }) => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  canvas.getContext('2d').drawImage(bmp, 0, 0);

  const out = [];
  for (const quality of qualities) {
    const blob = await canvas.convertToBlob({ type: 'image/webp', quality });
    const buf = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (const b of buf) s += String.fromCharCode(b);
    out.push({ quality, bytes: buf.length, b64: btoa(s) });
  }
  return out;
}, { b64: png.toString('base64'), qualities: QUALITIES });

for (const e of encoded) {
  writeFileSync(`${OUT}/q${String(Math.round(e.quality * 100)).padStart(2, '0')}.webp`,
                Buffer.from(e.b64, 'base64'));
}
writeFileSync(`${OUT}/sizes.json`, JSON.stringify(
  { reference_png: png.length, encoded: encoded.map(({ quality, bytes }) => ({ quality, bytes })) },
  null, 2));

console.log(`reference PNG ${(png.length / 1024).toFixed(1)} KB`);
for (const e of encoded) {
  console.log(`  q${e.quality.toFixed(2)}  ${(e.bytes / 1024).toFixed(1).padStart(7)} KB`);
}
await browser.close();
