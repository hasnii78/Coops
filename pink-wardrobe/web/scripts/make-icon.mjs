/**
 * Rasterises the Pink Wardrobe logo into the 1024x1024 PNG that
 * @capacitor/assets expands into every Android density.
 *
 * The logo is an SVG of simple bold shapes rather than a detailed image,
 * because the home-screen icon renders at roughly 48dp — fine detail turns to
 * mush at that size, while a strong silhouette survives.
 *
 * Run with: node scripts/make-icon.mjs
 */

import { chromium } from 'playwright';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SIZE = 1024;

// A dedicated icon, not the web logo: the web mark is circle-clipped, and an
// icon has to survive being masked and shrunk to roughly 48dp.
const svg = await readFile(join(here, '..', 'resources', 'icon.svg'), 'utf8');

// This environment ships its own Chromium; the npm package's expected build
// is not downloaded here. PW_CHROMIUM_PATH lets CI override it.
const executablePath =
  process.env.PW_CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const browser = await chromium.launch(
  existsSync(executablePath) ? { executablePath } : {},
);
const page = await browser.newPage({
  viewport: { width: SIZE, height: SIZE },
  deviceScaleFactor: 1,
});

await page.setContent(
  `<!doctype html>
   <style>
     html, body { margin: 0; padding: 0; background: #F4C0D1; }
     svg { display: block; width: ${SIZE}px; height: ${SIZE}px; }
   </style>
   ${svg}`,
  { waitUntil: 'load' },
);

await mkdir(join(here, '..', 'resources'), { recursive: true });

const png = await page.screenshot({ omitBackground: false });
await writeFile(join(here, '..', 'resources', 'icon.png'), png);

// Splash uses the same artwork on a wider field of the same pink, so the
// launch screen and the icon read as one thing.
await page.setViewportSize({ width: 2732, height: 2732 });
await page.setContent(
  `<!doctype html>
   <style>
     html, body { margin: 0; padding: 0; height: 100%;
       background: #FBEAF0; display: grid; place-items: center; }
     svg { display: block; width: 900px; height: 900px; border-radius: 80px; }
   </style>
   ${svg}`,
  { waitUntil: 'load' },
);

await writeFile(join(here, '..', 'resources', 'splash.png'), await page.screenshot());

await browser.close();
console.log(`Wrote resources/icon.png (${SIZE}x${SIZE}) and resources/splash.png (2732x2732)`);
