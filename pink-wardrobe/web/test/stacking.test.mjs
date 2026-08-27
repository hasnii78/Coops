/**
 * Stacking order, checked in a real browser.
 *
 * The order layers paint in is the whole of the outfit feature, and it depends
 * on canvas compositing rather than on anything that can be asserted from the
 * sort alone — so this reads the pixels back rather than trusting the
 * comparator. Skipped, not failed, where Playwright is unavailable: it is a
 * developer check, not a build gate.
 */
let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.log('stacking: skipped (playwright not installed)');
  process.exit(0);
}
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const ROOT = path.join(import.meta.dirname, '..', 'src');

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end('<!doctype html><meta charset="utf-8"><title>harness</title>');
  }
  const file = path.join(ROOT, url);
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': 'text/javascript' });
  res.end(fs.readFileSync(file));
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

// PLAYWRIGHT_CHROMIUM lets a preinstalled browser be used instead of a
// downloaded one, which is how the sandbox this was written in is set up.
let browser;
try {
  browser = await chromium.launch(
    process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {},
  );
} catch (error) {
  console.log('stacking: skipped (no chromium available) —', error.message.split('\n')[0]);
  server.close();
  process.exit(0);
}
const page = await browser.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.error('PAGE', m.text()); });
await page.goto(base);

const result = await page.evaluate(async (base) => {
  const { compositeToCanvas, comboHash } = await import(base + '/lib/compositor.js');

  // Each "layer" is a solid square of one colour covering the whole frame, so
  // whichever ends up on top is simply the colour that survives at the centre.
  function swatch(rgb) {
    const c = document.createElement('canvas');
    c.width = 40; c.height = 40;
    const x = c.getContext('2d');
    x.fillStyle = rgb;
    x.fillRect(0, 0, 40, 40);
    return c.toDataURL();
  }

  const AVATAR = swatch('rgb(10,10,10)');
  const SWIM = swatch('rgb(255,0,0)');
  const JEANS = swatch('rgb(0,255,0)');
  const CHAIN = swatch('rgb(0,0,255)');

  const canvas = document.createElement('canvas');

  async function topColour(layers) {
    await compositeToCanvas(canvas, AVATAR, layers, { blendSeams: false });
    const d = canvas.getContext('2d').getImageData(20, 20, 1, 1).data;
    return `${d[0]},${d[1]},${d[2]}`;
  }

  const out = {};

  // Swimsuit picked first, jeans second: jeans land on top — tucked in.
  out.swimThenJeans = await topColour([
    { category: 'swimwear', url: SWIM, order: 0 },
    { category: 'bottoms', url: JEANS, order: 1 },
  ]);

  // Jeans first, top second: the top is worn out over them.
  out.jeansThenTop = await topColour([
    { category: 'bottoms', url: JEANS, order: 0 },
    { category: 'tops', url: SWIM, order: 1 },
  ]);

  // Array order must not matter — only `order` does.
  out.shuffled = await topColour([
    { category: 'bottoms', url: JEANS, order: 1 },
    { category: 'swimwear', url: SWIM, order: 0 },
  ]);

  // An accessory pinned over wins regardless of its number.
  out.pinTop = await topColour([
    { category: 'accessories', url: CHAIN, order: 0, pin: 'top' },
    { category: 'bottoms', url: JEANS, order: 9 },
  ]);

  // Pinned under loses regardless of its number.
  out.pinUnder = await topColour([
    { category: 'accessories', url: CHAIN, order: 9, pin: 'under' },
    { category: 'bottoms', url: JEANS, order: 0 },
  ]);

  // Two pinned-top accessories must not produce a NaN comparator.
  out.twoPinned = await topColour([
    { category: 'accessories', url: CHAIN, order: 0, pin: 'top' },
    { category: 'accessories', url: SWIM, order: 1, pin: 'top' },
  ]);

  // The cache key has to separate outfits that differ only in arrangement.
  const a = await comboHash(['x', 'y']);
  const b = await comboHash(['y', 'x']);
  const c = await comboHash(['x', 'y'], { x: 'under' });
  out.hashOrderDiffers = a !== b;
  out.hashPinDiffers = a !== c;
  out.hashStable = a === await comboHash(['x', 'y']);

  return out;
}, base);

assert.equal(result.swimThenJeans, '0,255,0', 'jeans over swimsuit when picked second');
assert.equal(result.jeansThenTop, '255,0,0', 'top over jeans when picked second');
assert.equal(result.shuffled, '0,255,0', 'array order is irrelevant, only order is');
assert.equal(result.pinTop, '0,0,255', 'pinned-top accessory beats a higher number');
assert.equal(result.pinUnder, '0,255,0', 'pinned-under accessory loses to a lower number');
assert.equal(result.twoPinned, '255,0,0', 'two pinned accessories still sort deterministically');
assert.ok(result.hashOrderDiffers, 'reordering an outfit changes its cache key');
assert.ok(result.hashPinDiffers, 'repinning an accessory changes its cache key');
assert.ok(result.hashStable, 'the same outfit hashes the same way twice');

console.log('stacking verified in chromium:');
for (const [k, v] of Object.entries(result)) console.log(`  ${k}: ${v}`);

await browser.close();
server.close();
