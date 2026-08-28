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

import {
  COVERAGE_THRESHOLD,
  ERODE_RADIUS,
  classCoverage,
  erodeMask,
  featherEdges,
  fillEnclosedHoles,
  isUncoveredBase,
  keepAnchoredComponents,
  rgbToLab,
  trustsBaseline,
} from './mask';

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

/**
 * Which classes count as "the garment" for each category.
 *
 * Shoes are the reason this is a table rather than a flag. The model does not
 * file footwear under clothing — it goes in the same catch-all class as
 * jewellery — so asking only for clothing returned nothing at all and saved an
 * empty layer. The band already confines a shoe cut to the ankles, so accepting
 * both classes there cannot pull in a shirt.
 */
const CATEGORY_CLASSES = {
  accessories: [CLASS_ACCESSORIES],
  shoes: [CLASS_CLOTHES, CLASS_ACCESSORIES],
};

const DEFAULT_CLASSES = [CLASS_CLOTHES];

/**
 * Pose landmark indices. Shoulders and hips are the most stable anchors.
 *
 * The head and wrist points are here only to aim the crop for a small
 * accessory: a watch has to be looked for at the actual wrist, and guessing one
 * from the hips is the kind of approximation that finds a hand sometimes.
 */
const ANCHORS = {
  nose: 0,
  leftEar: 7,
  rightEar: 8,
  leftShoulder: 11,
  rightShoulder: 12,
  leftWrist: 15,
  rightWrist: 16,
  leftHip: 23,
  rightHip: 24,
  leftKnee: 25,
  rightKnee: 26,
  leftAnkle: 27,
  rightAnkle: 28,
};

const TORSO_ANCHORS = ['leftShoulder', 'rightShoulder', 'leftHip', 'rightHip'];
const LEG_ANCHORS = ['leftKnee', 'rightKnee', 'leftAnkle', 'rightAnkle'];

/**
 * Which landmarks a category is aligned on.
 *
 * The transform is a similarity — translate, rotate, uniform scale — fitted to
 * these points, so error grows with distance from them. Anchoring everything on
 * four points clustered in the torso was fine for a shirt and visibly wrong for
 * jeans: by the ankles, a fraction of a degree of rotation is centimetres of
 * drift, and the avatar's own leg shows through beside the denim.
 *
 * Knees and ankles were left out originally on the grounds that they move with
 * hem length. They do not: the pose model reports joints, not hems. They are as
 * stable as the hips and they are where a leg garment needs to land. Anything
 * not visible in both images is dropped before fitting, so including them costs
 * nothing when the legs are out of frame.
 */
const ALIGNMENT_ANCHORS = {
  bottoms: [...TORSO_ANCHORS, ...LEG_ANCHORS],
  dresses: [...TORSO_ANCHORS, ...LEG_ANCHORS],
  shoes: LEG_ANCHORS,
};

const DEFAULT_ALIGNMENT_ANCHORS = TORSO_ANCHORS;

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
 * Vertical extent each category occupies, as fractions between named
 * landmarks. A garment is cut to its own band so it cannot carry another
 * garment along with it — a top that keeps every clothing pixel also keeps
 * whatever trousers the generator invented below it.
 *
 * `from` and `to` are [landmark, offset] where the offset is a fraction of
 * shoulder-to-hip distance, so the bands scale with the person.
 */
const BANDS = {
  tops:        { from: ['shoulder', -0.45], to: ['hip', 0.35] },
  gym_wear:    { from: ['shoulder', -0.45], to: ['hip', 0.35] },
  outerwear:   { from: ['shoulder', -0.55], to: ['knee', -0.25] },
  bottoms:     { from: ['hip', -0.30], to: ['ankle', 0.30] },
  dresses:     { from: ['shoulder', -0.45], to: ['ankle', 0.20] },
  swimwear:    { from: ['shoulder', -0.30], to: ['hip', 0.60] },
  shoes:       { from: ['ankle', -0.35], to: ['ankle', 2.0] },
  accessories: null,   // separated by class, not position
  undergarments: { from: ['shoulder', 0.2], to: ['hip', 0.5] },
};

function midpointY(points, a, b) {
  const pa = points[a];
  const pb = points[b];
  if (pa && pb) return (pa[1] + pb[1]) / 2;
  return (pa || pb)?.[1] ?? null;
}

/**
 * Turn a band definition into pixel bounds for this particular body.
 * Returns null when the landmarks needed are missing, in which case the caller
 * falls back to keeping the whole height rather than cutting blindly.
 */
function resolveBand(band, landmarks) {
  if (!band || !landmarks) return null;

  const p = landmarks.points;
  const shoulder = midpointY(p, 'leftShoulder', 'rightShoulder');
  const hip = midpointY(p, 'leftHip', 'rightHip');
  const knee = midpointY(p, 'leftKnee', 'rightKnee');
  const ankle = midpointY(p, 'leftAnkle', 'rightAnkle');

  if (shoulder == null || hip == null) return null;

  // Torso height is the natural scale for a body: it barely changes with
  // camera distance relative to the rest of the frame.
  const torso = Math.abs(hip - shoulder) || landmarks.height * 0.25;

  const anchors = {
    shoulder,
    hip,
    // Estimate anything MediaPipe could not see, rather than giving up.
    knee: knee ?? hip + torso * 1.1,
    ankle: ankle ?? hip + torso * 2.2,
  };

  const resolve = ([name, offset]) => anchors[name] + offset * torso;

  return {
    top: Math.max(0, resolve(band.from)),
    bottom: Math.min(landmarks.height, resolve(band.to)),
  };
}

/** How far this category's garment may extend. */
function bandBounds(category, landmarks) {
  return resolveBand(BANDS[category], landmarks);
}

/** Where this category's garment must actually sit on the body. */
function anchorBounds(category, landmarks) {
  return resolveBand(ANCHOR_BANDS[category], landmarks);
}

// Below this Lab distance a pixel is treated as the base layer rather than the
// garment. Generous enough to absorb shading and JPEG noise on the base
// garment, tight enough that a genuinely different colour survives.
const BASE_COLOUR_TOLERANCE = 22;

/**
 * Where each category attaches to the body.
 *
 * Tighter than BANDS, and answering a different question. BANDS says how far a
 * garment is allowed to extend; this says where its body must actually sit.
 *
 * The generator completes outfits: asked to fit a crop top, it will often
 * invent underwear, because a crop top alone is not an image it was trained on.
 * That invention lands as its own blob near the pelvis, nowhere near where a
 * top attaches, so comparing each blob against this band separates the real
 * garment from the imagined one.
 */
const ANCHOR_BANDS = {
  tops:          { from: ['shoulder', -0.25], to: ['hip', -0.05] },
  gym_wear:      { from: ['shoulder', -0.25], to: ['hip', -0.05] },
  outerwear:     { from: ['shoulder', -0.35], to: ['hip', 0.20] },
  bottoms:       { from: ['hip', -0.15], to: ['knee', 0.20] },
  dresses:       { from: ['shoulder', -0.25], to: ['knee', 0.00] },
  swimwear:      { from: ['shoulder', -0.10], to: ['hip', 0.40] },
  shoes:         { from: ['ankle', -0.25], to: ['ankle', 2.0] },
  accessories:   null,   // separated by class, not position
  undergarments: { from: ['shoulder', 0.25], to: ['hip', 0.45] },
};

/**
 * Where a placed accessory sits, as a box around a landmark.
 *
 * Sized in torso heights so it scales with the person rather than with the
 * photo. Generous enough to contain the whole object — a watch face plus its
 * strap, a necklace plus its pendant — because anything falling outside the
 * crop cannot be found at all.
 *
 * `points` are tried in order and the first pair both visible wins, so a
 * bracelet is still found when one hand is hidden.
 */
const PLACEMENT_CROPS = {
  neck:  { points: [['leftShoulder', 'rightShoulder']], dy: -0.12, size: 0.55 },
  wrist: { points: [['leftWrist'], ['rightWrist']], dy: 0, size: 0.42 },
  waist: { points: [['leftHip', 'rightHip']], dy: 0, size: 0.60 },
  ears:  { points: [['leftEar', 'rightEar'], ['nose']], dy: 0, size: 0.55 },
  head:  { points: [['nose'], ['leftEar', 'rightEar']], dy: -0.18, size: 0.85 },
};

/**
 * A cut this small is not a garment.
 *
 * Below it the layer is invisible on the avatar, so saving it produces an item
 * that looks finished and shows nothing — which is exactly how an empty watch
 * and an empty pair of trainers came to sit in the closet marked ready.
 */
const MIN_GARMENT_COVERAGE = 0.002;

/**
 * Lab distance below which a pixel counts as untouched by the generator.
 *
 * Much tighter than the base-colour tolerance, because this compares the same
 * point in two renders of the same scene rather than a colour to a swatch.
 * Anything looser and a white shirt over a cream base reads as unchanged.
 */
const UNCHANGED_TOLERANCE = 10;

/** Draw an image at the given size and hand back its pixels. */
async function sampleAligned(blob, width, height) {
  try {
    const bitmap = await toBitmap(blob);
    const canvas = canvasFor(width, height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(bitmap, 0, 0, width, height);
    return context.getImageData(0, 0, width, height).data;
  } catch {
    return null;
  }
}

/** Pixel box around a landmark, clamped to the frame. */
function placementBox(placement, landmarks) {
  const spec = PLACEMENT_CROPS[placement];
  if (!spec || !landmarks) return null;

  const p = landmarks.points;
  const shoulder = midpointY(p, 'leftShoulder', 'rightShoulder');
  const hip = midpointY(p, 'leftHip', 'rightHip');
  if (shoulder == null || hip == null) return null;

  const torso = Math.abs(hip - shoulder) || landmarks.height * 0.25;
  const half = (spec.size * torso) / 2;

  const centre = spec.points
    .map((names) => names.map((name) => p[name]))
    .find((found) => found.every(Boolean));

  if (!centre) return null;

  const cx = centre.reduce((sum, point) => sum + point[0], 0) / centre.length;
  const cy = centre.reduce((sum, point) => sum + point[1], 0) / centre.length
    + spec.dy * torso;

  return {
    left: Math.max(0, Math.round(cx - half)),
    top: Math.max(0, Math.round(cy - half)),
    right: Math.min(landmarks.width, Math.round(cx + half)),
    bottom: Math.min(landmarks.height, Math.round(cy + half)),
  };
}

/**
 * Run the segmenter on a crop, and return its mask in full-frame terms.
 *
 * The model resizes whatever it is given to 256x256. On a full-body photo a
 * watch is perhaps five pixels across by the time it gets there, which is why
 * nothing was ever found. Handing it a crop of the wrist spends the same 256
 * pixels on a hand instead of a whole person, and the watch becomes plainly
 * visible to it.
 */
async function segmentCrop(bitmap, box) {
  const width = box.right - box.left;
  const height = box.bottom - box.top;
  if (width < 16 || height < 16) return null;

  const canvas = canvasFor(width, height);
  canvas.getContext('2d').drawImage(
    bitmap, box.left, box.top, width, height, 0, 0, width, height,
  );

  const segmenter = await getSegmenter();
  const result = segmenter.segment(canvas);
  const mask = result.categoryMask;

  if (!mask) {
    result.close?.();
    return null;
  }

  const data = mask.getAsUint8Array().slice();
  const shape = { width: mask.width, height: mask.height };
  result.close?.();

  return { data, ...shape, box, cropWidth: width, cropHeight: height };
}

/**
 * Cut the garment out of a generated image.
 *
 * Three filters decide which pixels are garment, each removing something the
 * others cannot:
 *
 *   class    — the classes this category is filed under. Clothing for most,
 *              the catch-all class for accessories, and both for shoes, which
 *              the model does not consider clothing.
 *   band     — the vertical extent this category occupies, from real landmarks.
 *              A top cannot contain trousers.
 *   baseline — pixels matching the base layer worn in the avatar photo. What
 *              the generator left uncovered is not part of the garment.
 *
 * Then three shape passes clean up what the filters leave behind: blobs that
 * are not where the category attaches are dropped, small holes punched into the
 * interior are restored, and the boundary is pulled in off the mask's grid.
 *
 * A placed accessory takes a different route through the same machinery: the
 * mask comes from a crop around its landmark rather than the whole frame, and
 * the crop itself replaces the band.
 */
export async function segmentGarment(source, category, options = {}) {
  const {
    landmarks = null, baseColor = null, placement = null, avatarBlob = null,
  } = options;

  const bitmap = await toBitmap(source);

  const box = placement ? placementBox(placement, landmarks) : null;
  const cropped = box ? await segmentCrop(bitmap, box) : null;

  let result = null;
  let mask;
  let maskWidth;
  let maskHeight;

  if (cropped) {
    ({ width: maskWidth, height: maskHeight } = cropped);
    mask = cropped.data;
  } else {
    const segmenter = await getSegmenter();
    result = segmenter.segment(bitmap);

    if (!result.categoryMask) {
      result.close?.();
      throw new VisionError('Segmentation produced no mask.');
    }

    mask = result.categoryMask.getAsUint8Array();
    maskWidth = result.categoryMask.width;
    maskHeight = result.categoryMask.height;
  }

  const canvas = canvasFor(bitmap.width, bitmap.height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0);

  const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
  const pixels = image.data;

  const wanted = CATEGORY_CLASSES[category] || DEFAULT_CLASSES;

  // A crop is its own boundary, so the band would only fight it.
  const bounds = cropped ? null : bandBounds(category, landmarks);
  const top = bounds ? bounds.top : 0;
  const bottom = bounds ? bounds.bottom : bitmap.height;

  const baseLab = baseColor ? rgbToLab(baseColor.r, baseColor.g, baseColor.b) : null;

  // The bare avatar, drawn at the generation's size so the two line up pixel
  // for pixel. Where the generation still looks like the avatar, nothing was
  // added there.
  const before = avatarBlob
    ? await sampleAligned(avatarBlob, bitmap.width, bitmap.height)
    : null;

  // Image pixels map into mask space differently for a crop: only the cropped
  // region has any mask at all, and it fills the whole 256x256.
  const originX = cropped ? cropped.box.left : 0;
  const originY = cropped ? cropped.box.top : 0;
  const scaleX = maskWidth / (cropped ? cropped.cropWidth : bitmap.width);
  const scaleY = maskHeight / (cropped ? cropped.cropHeight : bitmap.height);

  const firstX = cropped ? cropped.box.left : 0;
  const lastX = cropped ? cropped.box.right : bitmap.width;
  const firstY = cropped ? cropped.box.top : 0;
  const lastY = cropped ? cropped.box.bottom : bitmap.height;

  // Built as two masks so the baseline filter can be judged and, if it is
  // clearly misfiring, thrown away rather than trusted.
  const inClass = new Uint8Array(bitmap.width * bitmap.height);
  const afterBaseline = new Uint8Array(bitmap.width * bitmap.height);

  let classCount = 0;
  let baselineCount = 0;

  for (let y = Math.max(firstY, Math.floor(top)); y < Math.min(lastY, Math.ceil(bottom)); y += 1) {
    const row = y * bitmap.width;
    const sy = (y + 0.5 - originY) * scaleY;

    for (let x = firstX; x < lastX; x += 1) {
      const coverage = classCoverage(
        mask, maskWidth, maskHeight, wanted, (x + 0.5 - originX) * scaleX, sy,
      );
      if (coverage < COVERAGE_THRESHOLD) continue;

      inClass[row + x] = 1;
      classCount += 1;

      const offset = (row + x) * 4;

      // Both tests have to agree before a pixel is discarded as base layer.
      //
      // Colour alone said a white shirt was the cream base and deleted it —
      // which by colour it very nearly is. Position alone is fooled by the
      // generator re-rendering the whole photo a shade differently. Together
      // they only agree where the pixel both looks like the base garment AND
      // looks like what was already there, which is what an uncovered patch of
      // base actually is.
      if (isUncoveredBase(
        [pixels[offset], pixels[offset + 1], pixels[offset + 2]],
        baseLab,
        before && [before[offset], before[offset + 1], before[offset + 2]],
        BASE_COLOUR_TOLERANCE,
        UNCHANGED_TOLERANCE,
      )) {
        continue;
      }

      afterBaseline[row + x] = 1;
      baselineCount += 1;
    }
  }

  result?.close?.();

  // The baseline filter removes the base garment where the new one does not
  // cover it — a midriff below a crop top, say, which is a large but sane share
  // of the band. Removing nearly everything means something else happened: the
  // garment is close in colour to the base and is being deleted as if it were
  // the base. A white shirt over a skin-toned base disappeared completely this
  // way. Colour cannot tell the two apart, so when the filter takes this much
  // the safer reading is that it is wrong, and it is dropped.
  const believable = trustsBaseline(classCount, baselineCount);

  let kept = believable ? afterBaseline : inClass;
  const covered = believable ? baselineCount : classCount;

  kept = keepAnchoredComponents(
    kept,
    bitmap.width,
    bitmap.height,
    cropped ? null : anchorBounds(category, landmarks),
  );
  kept = fillEnclosedHoles(kept, bitmap.width, bitmap.height);
  kept = erodeMask(kept, bitmap.width, bitmap.height, ERODE_RADIUS);

  // Counted after every pass, so a cut emptied by the shape filters is caught
  // as surely as one the model never found.
  let remaining = 0;
  for (let i = 0; i < kept.length; i += 1) remaining += kept[i];

  if (remaining < bitmap.width * bitmap.height * MIN_GARMENT_COVERAGE) {
    throw new VisionError(
      covered === 0
        ? 'Nothing recognisable as this kind of item was found in the generated image.'
        : 'Too little of the item survived cutting to make a usable layer.',
    );
  }

  context.putImageData(image, 0, 0);
  featherEdges(context, bitmap.width, bitmap.height, kept);

  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

/**
 * Measure the base layer worn in the avatar photo.
 *
 * Measured rather than assumed: it adapts to whatever was actually worn and to
 * the light it was shot in, which a hardcoded swatch cannot. Also reports how
 * plain the garment is, since a patterned base spreads the colour cluster and
 * weakens every subtraction that depends on it.
 */
export async function measureBaseColor(blob) {
  const bitmap = await createImageBitmap(blob);
  const segmenter = await getSegmenter();
  const result = segmenter.segment(bitmap);

  const mask = result.categoryMask;
  if (!mask) {
    result.close?.();
    return null;
  }

  const maskData = mask.getAsUint8Array();
  const canvas = canvasFor(bitmap.width, bitmap.height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0);
  const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);

  const scaleX = mask.width / bitmap.width;
  const scaleY = mask.height / bitmap.height;

  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  const lums = [];

  for (let y = 0; y < bitmap.height; y += 2) {
    const maskRow = Math.min(mask.height - 1, (y * scaleY) | 0) * mask.width;

    for (let x = 0; x < bitmap.width; x += 2) {
      if (maskData[maskRow + Math.min(mask.width - 1, (x * scaleX) | 0)] !== CLASS_CLOTHES) {
        continue;
      }
      const o = (y * bitmap.width + x) * 4;
      r += data[o];
      g += data[o + 1];
      b += data[o + 2];
      lums.push(0.2126 * data[o] + 0.7152 * data[o + 1] + 0.0722 * data[o + 2]);
      n += 1;
    }
  }

  result.close?.();

  if (n < 500) return null;   // too little clothing visible to characterise

  const mean = lums.reduce((sum, v) => sum + v, 0) / lums.length;
  const spread = Math.sqrt(
    lums.reduce((sum, v) => sum + (v - mean) ** 2, 0) / lums.length,
  );

  return {
    r: Math.round(r / n),
    g: Math.round(g / n),
    b: Math.round(b / n),
    // Above roughly 30 the garment is patterned or harshly lit, and colour
    // subtraction will be unreliable.
    spread: Math.round(spread),
    plain: spread < 30,
  };
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
export function computeTransform(source, target, category = null) {
  const wanted = ALIGNMENT_ANCHORS[category] || DEFAULT_ALIGNMENT_ANCHORS;

  const shared = wanted.filter(
    (name) => name in source.points && name in target.points,
  );

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
export async function alignToMaster({
  layerBlob, generationBlob, masterLandmarks, category = null,
}) {
  try {
    const generationLandmarks = await detectLandmarks(generationBlob);
    const transform = computeTransform(generationLandmarks, masterLandmarks, category);

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
