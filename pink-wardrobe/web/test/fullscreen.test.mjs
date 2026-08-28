/**
 * How much of the screen the avatar actually fills, full screen.
 *
 * The stage used to be pinned to 3:4 inside min(100%, 78vh). An avatar
 * photograph is much taller than 3:4, so it was fitted inside a box that was
 * already narrower than the screen — letterboxed twice, and small in the middle
 * of all that black. This measures the result rather than trusting the rules.
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.log('fullscreen: skipped (playwright not installed)');
  process.exit(0);
}

const css = fs.readFileSync(
  path.join(import.meta.dirname, '..', 'src', 'styles', 'global.css'), 'utf8',
);

// A tall avatar photo, like the real one: 3:5 rather than 3:4.
const PHOTO = { w: 900, h: 1500 };

const page = `<!doctype html><meta charset="utf-8">
<style>${css}
html,body{margin:0;height:100%}
</style>
<div class="viewer-overlay">
  <div class="viewer-stage viewer-stage-full">
    <div class="viewer-content"><img id="a" src="data:image/svg+xml,${encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${PHOTO.w}" height="${PHOTO.h}"><rect width="100%" height="100%" fill="#cbb"/></svg>`,
    )}"></div>
  </div>
  <div class="viewer-controls"><button class="chip">Reset</button><button class="chip">Done</button></div>
  <p class="viewer-hint">Pinch to zoom</p>
</div>`;

let browser;
try {
  browser = await chromium.launch(
    process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {},
  );
} catch (error) {
  console.log('fullscreen: skipped (no chromium) —', error.message.split('\n')[0]);
  process.exit(0);
}

// A typical tall phone.
const view = { width: 412, height: 915 };
const tab = await browser.newPage({ viewport: view });
await tab.setContent(page);

const box = await tab.locator('#a').boundingBox();

// object-fit: contain, so the drawn photo is letterboxed inside the element.
const drawn = await tab.evaluate(() => {
  const img = document.getElementById('a');
  const scale = Math.min(
    img.clientWidth / img.naturalWidth,
    img.clientHeight / img.naturalHeight,
  );
  return { w: img.naturalWidth * scale, h: img.naturalHeight * scale };
});

const share = (drawn.w * drawn.h) / (view.width * view.height);

console.log(`viewport      ${view.width}x${view.height}`);
console.log(`element       ${Math.round(box.width)}x${Math.round(box.height)}`);
console.log(`photo drawn   ${Math.round(drawn.w)}x${Math.round(drawn.h)}`);
console.log(`covers        ${(share * 100).toFixed(0)}% of the screen`);

// The old rule pinned the stage to 3:4 inside min(100%, 78vh), which on this
// phone drew the photo at about a third of the screen.
assert.ok(share > 0.55, `the avatar should fill most of the screen (got ${(share * 100).toFixed(0)}%)`);
assert.ok(drawn.h > view.height * 0.7, 'and be nearly as tall as the screen');
assert.ok(drawn.w <= view.width + 1 && drawn.h <= view.height + 1, 'without overflowing it');

console.log('\nfullscreen avatar verified');
await browser.close();
