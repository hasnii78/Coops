/**
 * Downloads the MediaPipe models and WASM runtime into public/mediapipe/.
 *
 * They are fetched at build time rather than committed, because they are tens
 * of megabytes of binary that would bloat the repository. They are served from
 * the app itself rather than a CDN so the APK works offline and so no third
 * party sees a request every time someone adds a garment.
 *
 * Run automatically by `npm run build`. Safe to re-run: existing files are
 * skipped.
 */

import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'public', 'mediapipe');

// The WASM runtime ships inside the npm package, so it is copied rather than
// downloaded — version-locked to the installed @mediapipe/tasks-vision, and it
// works with no network at all.
const WASM_SOURCE = join(here, '..', 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');

// Only the models are genuinely remote.
const FILES = [
  {
    url: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite',
    path: 'selfie_multiclass_256x256.tflite',
  },
  {
    url: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task',
    path: 'pose_landmarker_lite.task',
  },
];

async function exists(path) {
  try {
    const info = await stat(path);
    return info.size > 0;
  } catch {
    return false;
  }
}

async function fetchTo(url, destination) {
  await mkdir(dirname(destination), { recursive: true });

  if (await exists(destination)) {
    console.log(`  skip  ${destination.replace(outDir, 'public/mediapipe')}`);
    return;
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${response.status} fetching ${url}`);
  }

  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
  console.log(`  got   ${destination.replace(outDir, 'public/mediapipe')}`);
}

async function copyWasmRuntime() {
  const destination = join(outDir, 'wasm');
  await mkdir(destination, { recursive: true });

  let entries;
  try {
    entries = await readdir(WASM_SOURCE);
  } catch {
    throw new Error(
      'node_modules/@mediapipe/tasks-vision not found — run npm install first.',
    );
  }

  for (const entry of entries) {
    const target = join(destination, entry);
    if (await exists(target)) {
      console.log(`  skip  public/mediapipe/wasm/${entry}`);
      continue;
    }
    await copyFile(join(WASM_SOURCE, entry), target);
    console.log(`  copy  public/mediapipe/wasm/${entry}`);
  }
}

console.log('Preparing MediaPipe assets…');

let failed = false;

for (const file of FILES) {
  try {
    await fetchTo(file.url, join(outDir, file.path));
  } catch (error) {
    failed = true;
    console.error(`  FAIL  ${file.path}: ${error.message}`);
  }
}

try {
  await copyWasmRuntime();
} catch (error) {
  failed = true;
  console.error(`  FAIL  wasm runtime: ${error.message}`);
}

if (failed) {
  console.error(
    '\nSome assets are missing. On-device segmentation and pose alignment will\n' +
    'not work until they are present in web/public/mediapipe/.',
  );
  process.exit(1);
}

console.log('Done.');
