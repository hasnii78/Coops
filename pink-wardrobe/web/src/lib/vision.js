/**
 * On-device computer vision: segmentation and pose alignment.
 *
 * These are pipeline steps 4-6. They ran as Python (rembg + MediaPipe) under
 * the old Firebase Cloud Functions; Supabase Edge Functions run Deno, which
 * cannot host those libraries. They now run here, in MediaPipe's WASM build.
 *
 * The steps, their order and their semantics are unchanged. What changed is
 * only where they execute — and running locally means the garment photo never
 * leaves the device for these stages.
 *
 * Everything here is free. The only paid step lives in the process-garment
 * Edge Function.
 */

import {
  FilesetResolver,
  ImageSegmenter,
  PoseLandmarker,
} from '@mediapipe/tasks-vision';

// Models are served from the app itself so the APK works offline. See
// scripts/fetch-models.mjs, which downloads them at build time.
const WASM_PATH = '/mediapipe/wasm';
const SEGMENTER_MODEL = '/mediapipe/selfie_multiclass_256x256.tflite';
const POSE_MODEL = '/mediapipe/pose_landmarker_lite.task';

/**
 * selfie_multiclass segmentation classes. Index 4 is clothing, which is
 * exactly what a garment layer needs — a meaningful upgrade over rembg, which
 * could only separate person from background and then had to guess at the
 * garment by cropping body bands.
 */
const CLASS_CLOTHES = 4;
const CLASS_ACCESSORIES = 5;

/** Pose landmark indices. Shoulders and hips are the most stable anchors. */
const ANCHORS = {
  leftShoulder: 11,
  rightShoulder: 12,
  leftHip: 23,
  rightHip: 24,
};

const MIN_VISIBILITY = 0.5;

let segmenterPromise = null;
let posePromise = null;

async function getSegmenter() {
  if (!segmenterPromise) {
    segmenterPromise = (async () => {
      const fileset = await FilesetResolver.forVisionTasks(WASM_PATH);
      return ImageSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: SEGMENTER_MODEL, delegate: 'GPU' },
        runningMode: 'IMAGE',
        outputCategoryMask: true,
        outputConfidenceMasks: false,
      });
    })();
  }
  return segmenterPromise;
}

async function getPoseLandmarker() {
  if (!posePromise) {
    posePromise = (async () => {
      const fileset = await FilesetResolver.forVisionTasks(WASM_PATH);
      return PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: POSE_MODEL, delegate: 'GPU' },
        runningMode: 'IMAGE',
        numPoses: 1,
        minPoseDetectionConfidence: 0.5,
      });
    })();
  }
  return posePromise;
}

export class VisionError extends Error {}

async function toBitmap(source) {
  if (source instanceof ImageBitmap) return source;
  if (source instanceof Blob) return createImageBitmap(source);
  throw new VisionError('Unsupported image source.');
}

function canvasFor(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

// ------------------------------------------------------------- landmarks

export async function detectLandmarks(source) {
  const bitmap = await toBitmap(source);
  const landmarker = await getPoseLandmarker();
  const result = landmarker.detect(bitmap);

  if (!result.landmarks?.length) {
    throw new VisionError('No person detected in the image.');
  }

  const raw = result.landmarks[0];
  const points = {};

  for (const [name, index] of Object.entries(ANCHORS)) {
    const landmark = raw[index];
    // `visibility` is absent on some builds; treat missing as visible.
    if (landmark.visibility !== undefined && landmark.visibility < MIN_VISIBILITY) {
      continue;
    }
    points[name] = [landmark.x * bitmap.width, landmark.y * bitmap.height];
  }

  return { points, width: bitmap.width, height: bitmap.height };
}

/**
 * Quality-gate a candidate avatar before it becomes the permanent master
 * template. Every layer this user ever generates is aligned to it, so a bad
 * avatar can only be undone by regenerating the whole closet.
 */
export async function checkAvatarQuality(blob) {
  const problems = [];
  const bitmap = await createImageBitmap(blob);
  const { width, height } = bitmap;

  if (Math.min(width, height) < 512) {
    problems.push('Photo is too small — use at least 512px on the short side.');
  }

  const canvas = canvasFor(width, height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0);
  const { data } = context.getImageData(0, 0, width, height);

  // Luminance mean and standard deviation, sampled every 16th pixel.
  let sum = 0;
  let sumSquares = 0;
  let count = 0;

  for (let i = 0; i < data.length; i += 64) {
    const luma = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    sum += luma;
    sumSquares += luma * luma;
    count += 1;
  }

  const mean = sum / count;
  const contrast = Math.sqrt(Math.max(0, sumSquares / count - mean * mean));

  if (mean < 55) {
    problems.push('Photo is too dark — try again near a window or in brighter light.');
  } else if (mean > 215) {
    problems.push('Photo is overexposed — move out of direct light.');
  }

  if (contrast < 25) {
    problems.push('Lighting is very flat — stand against a simpler, contrasting background.');
  }

  let landmarks;
  try {
    landmarks = await detectLandmarks(bitmap);
  } catch {
    problems.push(
      'No clear full-body person detected — stand back so your whole body is in frame.',
    );
    return { ok: false, problems, landmarks: null };
  }

  const found = Object.keys(landmarks.points);
  if (found.length < 3) {
    problems.push("Body isn't fully visible — make sure shoulders and hips are both in frame.");
    return { ok: false, problems, landmarks: null };
  }

  const { leftShoulder, rightShoulder } = landmarks.points;
  if (leftShoulder && rightShoulder) {
    const span = Math.abs(leftShoulder[0] - rightShoulder[0]);
    // A near-zero span means the subject is side-on, which try-on models
    // handle poorly.
    if (span < width * 0.08) {
      problems.push("You're turned side-on — face the camera straight for the best results.");
    }
  }

  return { ok: problems.length === 0, problems, landmarks };
}

// ---------------------------------------------------------- segmentation

/**
 * Cut the garment out of a generated image.
 *
 * Returns a transparent PNG containing only clothing pixels. Accessories are
 * included for the accessory category and excluded otherwise, so a necklace
 * does not ride along with every shirt.
 */
export async function segmentGarment(source, category) {
  const bitmap = await toBitmap(source);
  const segmenter = await getSegmenter();
  const result = segmenter.segment(bitmap);

  const mask = result.categoryMask;
  if (!mask) {
    result.close?.();
    throw new VisionError('Segmentation produced no mask.');
  }

  const maskData = mask.getAsUint8Array();
  const maskWidth = mask.width;
  const maskHeight = mask.height;

  const canvas = canvasFor(bitmap.width, bitmap.height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0);

  const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
  const pixels = image.data;

  const keepAccessories = category === 'accessories';
  const scaleX = maskWidth / bitmap.width;
  const scaleY = maskHeight / bitmap.height;

  for (let y = 0; y < bitmap.height; y += 1) {
    const maskRow = Math.min(maskHeight - 1, (y * scaleY) | 0) * maskWidth;

    for (let x = 0; x < bitmap.width; x += 1) {
      const klass = maskData[maskRow + Math.min(maskWidth - 1, (x * scaleX) | 0)];

      const keep =
        klass === CLASS_CLOTHES || (keepAccessories && klass === CLASS_ACCESSORIES);

      if (!keep) {
        pixels[(y * bitmap.width + x) * 4 + 3] = 0;
      }
    }
  }

  context.putImageData(image, 0, 0);
  result.close?.();

  featherEdges(context, bitmap.width, bitmap.height);

  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

/**
 * Soften the alpha boundary.
 *
 * The category mask is hard-edged at 256x256 and upscales into visible
 * stair-stepping. A short blur applied to alpha alone removes it without
 * touching colour.
 */
function featherEdges(context, width, height) {
  const image = context.getImageData(0, 0, width, height);
  const source = image.data;
  const alpha = new Uint8ClampedArray(width * height);

  for (let i = 0; i < width * height; i += 1) {
    alpha[i] = source[i * 4 + 3];
  }

  const radius = 2;
  const blurred = new Uint8ClampedArray(width * height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let total = 0;
      let samples = 0;

      for (let dy = -radius; dy <= radius; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;

        for (let dx = -radius; dx <= radius; dx += 1) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;

          total += alpha[ny * width + nx];
          samples += 1;
        }
      }

      blurred[y * width + x] = total / samples;
    }
  }

  for (let i = 0; i < width * height; i += 1) {
    source[i * 4 + 3] = blurred[i];
  }

  context.putImageData(image, 0, 0);
}

// -------------------------------------------------------------- alignment

/**
 * Least-squares similarity transform mapping source points onto target points.
 *
 * Translation, rotation and uniform scale only — deliberately not a full
 * affine. A full affine would let a garment shear or stretch to force a
 * landmark match, distorting the clothing itself. We only want to slide,
 * rotate and scale the layer into place.
 */
export function computeTransform(source, target) {
  const shared = Object.keys(source.points).filter((name) => name in target.points);

  if (shared.length < 2) {
    throw new VisionError(
      `Only ${shared.length} shared landmark(s); need at least 2 to align.`,
    );
  }

  const from = shared.map((name) => source.points[name]);
  const to = shared.map((name) => target.points[name]);
  const n = from.length;

  const centroid = (points) => [
    points.reduce((sum, p) => sum + p[0], 0) / n,
    points.reduce((sum, p) => sum + p[1], 0) / n,
  ];

  const [fcx, fcy] = centroid(from);
  const [tcx, tcy] = centroid(to);

  let sumDot = 0;
  let sumCross = 0;
  let sumSquares = 0;

  for (let i = 0; i < n; i += 1) {
    const fx = from[i][0] - fcx;
    const fy = from[i][1] - fcy;
    const tx = to[i][0] - tcx;
    const ty = to[i][1] - tcy;

    sumDot += fx * tx + fy * ty;
    sumCross += fx * ty - fy * tx;
    sumSquares += fx * fx + fy * fy;
  }

  if (sumSquares < 1e-6) {
    throw new VisionError('Landmarks are degenerate; cannot derive a transform.');
  }

  const a = sumDot / sumSquares;      // scale * cos(theta)
  const b = sumCross / sumSquares;    // scale * sin(theta)

  return {
    a,
    b,
    tx: tcx - (a * fcx - b * fcy),
    ty: tcy - (b * fcx + a * fcy),
    scale: Math.sqrt(a * a + b * b),
    rotationDeg: (Math.atan2(b, a) * 180) / Math.PI,
    matched: shared,
  };
}

/** Apply a similarity transform to a transparent layer. */
export async function warpLayer(layerBlob, transform, width, height) {
  const bitmap = await createImageBitmap(layerBlob);
  const canvas = canvasFor(width, height);
  const context = canvas.getContext('2d');

  context.imageSmoothingQuality = 'high';
  // Canvas setTransform takes (a, b, c, d, e, f) column-major; for a
  // similarity transform c = -b and d = a.
  context.setTransform(transform.a, transform.b, -transform.b, transform.a, transform.tx, transform.ty);
  context.drawImage(bitmap, 0, 0);

  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

/**
 * Align a segmented layer to the user's master template.
 *
 * Pose is detected on the full generated image, not on the cutout — a cropped
 * garment has no detectable body.
 *
 * Alignment failing is not fatal. An unaligned layer is still usable for
 * single-garment outfits and can be nudged by hand; losing a paid generation
 * over a landmark miss would be far worse.
 */
export async function alignToMaster({ layerBlob, generationBlob, masterLandmarks }) {
  try {
    const generationLandmarks = await detectLandmarks(generationBlob);
    const transform = computeTransform(generationLandmarks, masterLandmarks);

    const aligned = await warpLayer(
      layerBlob,
      transform,
      masterLandmarks.width,
      masterLandmarks.height,
    );

    return {
      blob: aligned,
      meta: {
        aligned: true,
        offsetX: transform.tx,
        offsetY: transform.ty,
        scale: transform.scale,
        rotationDeg: transform.rotationDeg,
        landmarksMatched: transform.matched,
      },
    };
  } catch (error) {
    return {
      blob: layerBlob,
      meta: {
        aligned: false,
        reason: error.message,
        offsetX: 0,
        offsetY: 0,
        scale: 1,
        rotationDeg: 0,
      },
    };
  }
}

// ----------------------------------------------------------- dominant colour

/** Extract a garment's dominant colour for the suggestion engine. */
export async function dominantColor(blob) {
  const bitmap = await createImageBitmap(blob);

  // Downscale hard — colour distribution is stable and this keeps it instant.
  const size = 64;
  const canvas = canvasFor(size, size);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0, size, size);

  const { data } = context.getImageData(0, 0, size, size);
  const buckets = new Map();

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 200) continue;   // ignore transparent surround

    // Quantise to 32-level bins so near-identical shades group together.
    const key =
      ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);

    const bucket = buckets.get(key) || { r: 0, g: 0, b: 0, n: 0 };
    bucket.r += data[i];
    bucket.g += data[i + 1];
    bucket.b += data[i + 2];
    bucket.n += 1;
    buckets.set(key, bucket);
  }

  if (buckets.size === 0) {
    return { hex: '#CCCCCC', hue: 0, saturation: 0, lightness: 80, name: 'unknown' };
  }

  let best = null;
  for (const bucket of buckets.values()) {
    if (!best || bucket.n > best.n) best = bucket;
  }

  const r = Math.round(best.r / best.n);
  const g = Math.round(best.g / best.n);
  const b = Math.round(best.b / best.n);

  const { h, s, l } = rgbToHsl(r, g, b);

  return {
    hex: `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()}`,
    hue: Math.round(h),
    saturation: Math.round(s),
    lightness: Math.round(l),
    name: colorName(h, s, l),
  };
}

function rgbToHsl(r, g, b) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;

  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;

  const l = (max + min) / 2;
  let h = 0;
  let s = 0;

  if (delta !== 0) {
    s = delta / (1 - Math.abs(2 * l - 1));

    if (max === rn) h = ((gn - bn) / delta) % 6;
    else if (max === gn) h = (bn - rn) / delta + 2;
    else h = (rn - gn) / delta + 4;

    h *= 60;
    if (h < 0) h += 360;
  }

  return { h, s: s * 100, l: l * 100 };
}

export function colorName(hue, saturation, lightness) {
  if (lightness < 12) return 'black';
  if (lightness > 90 && saturation < 12) return 'white';
  if (saturation < 12) return 'grey';
  if (saturation < 30 && hue > 20 && hue < 50) return 'beige';

  const bands = [
    [15, 'red'], [45, 'orange'], [65, 'yellow'], [160, 'green'],
    [200, 'teal'], [250, 'blue'], [290, 'purple'], [335, 'pink'], [360, 'red'],
  ];

  for (const [ceiling, name] of bands) {
    if (hue < ceiling) return name;
  }
  return 'red';
}
