/**
 * Mask shaping: the pixel work that turns a raw segmentation into a layer.
 *
 * Kept apart from vision.js deliberately. Nothing here touches MediaPipe, the
 * DOM or the network — it is arrays in, arrays out — so it can be reasoned
 * about on its own and tested without a browser. vision.js owns the models;
 * this owns what happens to their output.
 *
 * Throughout a "mask" is a Uint8Array holding 0 or 1 per pixel, row-major.
 */

/**
 * A blob smaller than this share of the largest anchored blob is discarded.
 *
 * Real garments do come in pieces — two shoes, the cups of a bikini — and those
 * pieces are comparable in size. Speckle from a noisy mask is not, and it is
 * orders of magnitude smaller, so the threshold only has to clear noise. It was
 * 8% to begin with, which was enough to silently delete a strip of a trouser leg
 * that the coarse mask had pinched off from the rest.
 */
export const MIN_COMPONENT_SHARE = 0.01;

/**
 * A hole larger than this share of the garment is left alone.
 *
 * Small enclosed gaps are almost always the base garment showing through where
 * subtraction was too eager, and filling them back in is right. A large
 * enclosed region is more likely to be genuine — the gap between two trouser
 * legs, say — and filling it would be worse than the hole.
 */
export const MAX_HOLE_SHARE = 0.15;

/**
 * How much of a pixel is covered by one of the wanted classes.
 *
 * The model returns a 256x256 map of class ids. Reading it with the nearest
 * texel snaps every boundary to that coarse grid, which on a full-size render
 * is a visible staircase along the edge of a garment. Class ids cannot be
 * interpolated — the average of "clothes" and "hair" is meaningless — but
 * membership can: each of the four surrounding texels either is a wanted class
 * or is not, and the bilinear weights give the fraction of this pixel that the
 * garment covers. Thresholding that fraction puts the boundary along a smooth
 * contour between texel centres rather than along texel walls.
 */
export function classCoverage(mask, width, height, wanted, sx, sy) {
  // Texel centres sit at +0.5, so the sample point is shifted before flooring.
  const x = sx - 0.5;
  const y = sy - 0.5;

  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;

  const clampX = (value) => (value < 0 ? 0 : value > width - 1 ? width - 1 : value);
  const clampY = (value) => (value < 0 ? 0 : value > height - 1 ? height - 1 : value);

  let covered = 0;

  for (let j = 0; j < 2; j += 1) {
    const row = clampY(y0 + j) * width;
    const wy = j ? fy : 1 - fy;

    for (let i = 0; i < 2; i += 1) {
      const klass = mask[row + clampX(x0 + i)];
      if (!wanted.includes(klass)) continue;
      covered += (i ? fx : 1 - fx) * wy;
    }
  }

  return covered;
}

/**
 * How much of the garment must survive the baseline filter for it to be
 * believed.
 *
 * A crop top leaves most of its band showing the base garment underneath and
 * still clears this comfortably. A garment being mistaken wholesale for the
 * base does not.
 */
export const MIN_BASELINE_SURVIVAL = 0.25;

/**
 * Whether subtracting the base garment's colour produced a sane result.
 *
 * The filter exists to remove the base layer where the new garment does not
 * cover it. Colour is all it has to go on, so a garment close in colour to the
 * base is indistinguishable from the base — and a white shirt over a
 * skin-toned base was deleted in its entirety. There is no way to tell the two
 * apart from colour, but there is a way to notice: when the filter claims
 * almost the whole garment, the likelier explanation is that it is wrong.
 */
export function trustsBaseline(classCount, baselineCount) {
  if (!classCount) return true;
  return baselineCount / classCount >= MIN_BASELINE_SURVIVAL;
}

/** Half coverage is the boundary — the contour a smooth edge follows. */
export const COVERAGE_THRESHOLD = 0.5;

/**
 * Label 4-connected runs of kept pixels.
 *
 * 4-connectivity rather than 8: two regions touching at a single diagonal
 * corner are neighbours by coincidence, not one garment.
 */
export function labelComponents(kept, width, height) {
  const count = width * height;
  const labels = new Int32Array(count);
  const stack = new Int32Array(count);
  const areas = [0];
  const sumY = [0];

  let next = 0;

  for (let start = 0; start < count; start += 1) {
    if (!kept[start] || labels[start]) continue;

    next += 1;
    labels[start] = next;

    let area = 0;
    let total = 0;
    let top = 0;
    stack[top] = start;
    top += 1;

    while (top > 0) {
      top -= 1;
      const index = stack[top];
      const y = (index / width) | 0;
      const x = index - y * width;

      area += 1;
      total += y;

      if (x > 0 && kept[index - 1] && !labels[index - 1]) {
        labels[index - 1] = next;
        stack[top] = index - 1;
        top += 1;
      }
      if (x < width - 1 && kept[index + 1] && !labels[index + 1]) {
        labels[index + 1] = next;
        stack[top] = index + 1;
        top += 1;
      }
      if (y > 0 && kept[index - width] && !labels[index - width]) {
        labels[index - width] = next;
        stack[top] = index - width;
        top += 1;
      }
      if (y < height - 1 && kept[index + width] && !labels[index + width]) {
        labels[index + width] = next;
        stack[top] = index + width;
        top += 1;
      }
    }

    areas.push(area);
    sumY.push(total);
  }

  return { labels, count: next, areas, sumY };
}

/**
 * Drop blobs that are not where this category attaches to the body.
 *
 * Fails open in every uncertain case: one blob, no anchor band, or nothing
 * inside the band all return the mask untouched. Losing a hallucinated garment
 * is worth having; erasing a real one because a landmark was off is not.
 */
export function keepAnchoredComponents(kept, width, height, bounds) {
  if (!bounds) return kept;

  const { labels, count, areas, sumY } = labelComponents(kept, width, height);
  if (count <= 1) return kept;

  const anchored = (id) => {
    const centroid = sumY[id] / areas[id];
    return centroid >= bounds.top && centroid <= bounds.bottom;
  };

  let largest = 0;
  for (let id = 1; id <= count; id += 1) {
    if (anchored(id) && areas[id] > largest) largest = areas[id];
  }

  if (largest === 0) return kept;

  const minArea = largest * MIN_COMPONENT_SHARE;
  const survives = new Uint8Array(count + 1);
  for (let id = 1; id <= count; id += 1) {
    survives[id] = anchored(id) && areas[id] >= minArea ? 1 : 0;
  }

  const out = new Uint8Array(kept.length);
  for (let i = 0; i < kept.length; i += 1) out[i] = survives[labels[i]];
  return out;
}

/**
 * Keep only the biggest connected blob.
 *
 * For something found by comparing two photographs rather than by asking a
 * model, this is the whole of the cleanup. The generator re-renders the entire
 * picture, so an arm comes back a shade different and a hand a pixel or two
 * over; all of that registers as "changed". The watch is one solid object and
 * that drift is thin slivers around it, so the largest blob is the watch and
 * everything else is the re-render.
 */
export function keepLargestComponent(kept, width, height) {
  const { labels, count, areas } = labelComponents(kept, width, height);
  if (count <= 1) return kept;

  let best = 0;
  let bestArea = 0;

  for (let id = 1; id <= count; id += 1) {
    if (areas[id] > bestArea) {
      bestArea = areas[id];
      best = id;
    }
  }

  const out = new Uint8Array(kept.length);
  for (let i = 0; i < kept.length; i += 1) out[i] = labels[i] === best ? 1 : 0;
  return out;
}

/**
 * Restore small pockets the filters punched out of the middle of a garment.
 *
 * With a skin-toned base layer, colour subtraction can bite into a beige or
 * cream garment. Anything it removed from the interior — unreachable from the
 * edge of the frame — was surrounded by garment on all sides, so it was
 * garment.
 */
export function fillEnclosedHoles(kept, width, height) {
  const count = width * height;
  const outside = new Uint8Array(count);
  const stack = new Int32Array(count);
  let top = 0;

  const seed = (index) => {
    if (kept[index] || outside[index]) return;
    outside[index] = 1;
    stack[top] = index;
    top += 1;
  };

  for (let x = 0; x < width; x += 1) {
    seed(x);
    seed((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    seed(y * width);
    seed(y * width + width - 1);
  }

  while (top > 0) {
    top -= 1;
    const index = stack[top];
    const y = (index / width) | 0;
    const x = index - y * width;

    if (x > 0) seed(index - 1);
    if (x < width - 1) seed(index + 1);
    if (y > 0) seed(index - width);
    if (y < height - 1) seed(index + width);
  }

  const enclosed = new Uint8Array(count);
  let garment = 0;

  for (let i = 0; i < count; i += 1) {
    if (kept[i]) garment += 1;
    else if (!outside[i]) enclosed[i] = 1;
  }

  if (!garment) return kept;

  const pockets = labelComponents(enclosed, width, height);
  const maxArea = garment * MAX_HOLE_SHARE;
  const fills = new Uint8Array(pockets.count + 1);
  for (let id = 1; id <= pockets.count; id += 1) {
    fills[id] = pockets.areas[id] <= maxArea ? 1 : 0;
  }

  const out = new Uint8Array(kept.length);
  for (let i = 0; i < count; i += 1) {
    out[i] = kept[i] || fills[pockets.labels[i]] ? 1 : 0;
  }
  return out;
}

/** Half-width of the feather. Two pixels is a soft edge, not a gradient. */
export const FEATHER_RADIUS = 2;

/**
 * Alpha below which an edge pixel is left as it is.
 *
 * Un-mixing divides by alpha, so at the faint end it turns rounding error into
 * a bright halo. Those pixels are nearly invisible anyway.
 */
export const MIN_DECONTAMINATION_ALPHA = 24;

/**
 * Soften the boundary of the mask just built, and un-mix the colours along it.
 *
 * The feather is deliberately one-directional. A symmetric blur of the alpha
 * channel spreads coverage OUTWARD past the cut as readily as inward, and those
 * pixels still hold the colour of whatever was behind the garment — skin,
 * usually. The layer then carries a translucent skin-coloured rim that reads as
 * a fake outline against the avatar, and worse, it quietly resurrects pixels
 * the colour filter had already deleted. Clamping to the mask means a pixel can
 * only ever become more transparent, never less.
 */
export function featherEdges(context, width, height, kept) {
  const count = width * height;
  const image = context.getImageData(0, 0, width, height);
  const data = image.data;

  const rows = new Float32Array(count);
  const coverage = new Float32Array(count);

  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      let total = 0;
      let samples = 0;
      for (let d = -FEATHER_RADIUS; d <= FEATHER_RADIUS; d += 1) {
        const nx = x + d;
        if (nx < 0 || nx >= width) continue;
        total += kept[row + nx];
        samples += 1;
      }
      rows[row + x] = total / samples;
    }
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let total = 0;
      let samples = 0;
      for (let d = -FEATHER_RADIUS; d <= FEATHER_RADIUS; d += 1) {
        const ny = y + d;
        if (ny < 0 || ny >= height) continue;
        total += rows[ny * width + x];
        samples += 1;
      }
      coverage[y * width + x] = total / samples;
    }
  }

  // Refined against the photograph itself before it becomes alpha, so the edge
  // follows the garment rather than the model's idea of where it is.
  const guide = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    const offset = i * 4;
    // Perceived brightness: a collar against skin is an edge here even when the
    // raw channel values are close.
    guide[i] = (0.299 * data[offset] + 0.587 * data[offset + 1]
      + 0.114 * data[offset + 2]) / 255;
  }

  const refined = guidedFilterAlpha(
    coverage, guide, width, height, GUIDE_RADIUS, GUIDE_EPSILON,
  );

  for (let i = 0; i < count; i += 1) {
    // Bounded by the mask, not by the feather. Bounding it by the feather made
    // refinement one-directional — it could only ever take alpha away — and a
    // filter that can only subtract is just another way of shrinking every
    // garment, which is the bug that put a bare toe under a shoe.
    data[i * 4 + 3] = kept[i] ? Math.round(refined[i] * 255) : 0;
  }

  decontaminate(data, kept, width, height);

  context.putImageData(image, 0, 0);
}

/**
 * Remove the background's contribution from partly transparent edge pixels.
 *
 * A pixel on the boundary is a mix: C = aF + (1-a)B, where F is the garment's
 * true colour and B is whatever was behind it. Painting C at alpha a therefore
 * lays a trace of B over the avatar, which is why a garment cut from a body
 * carries a faint outline of that body.
 *
 * Matting normally has to guess at B. Here it can be measured directly — the
 * neighbouring rejected pixels ARE the background, in this image, under this
 * light — so F follows by rearranging, and the trace goes away.
 */
export function decontaminate(data, kept, width, height) {
  const source = new Uint8ClampedArray(data);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const alpha = data[index * 4 + 3];

      // Below the floor there is too little garment in the mix to recover: the
      // division amplifies noise into a bright fringe, which is worse than the
      // faint one it replaces.
      if (alpha < MIN_DECONTAMINATION_ALPHA || alpha === 255) continue;

      let r = 0;
      let g = 0;
      let b = 0;
      let samples = 0;

      for (let dy = -FEATHER_RADIUS; dy <= FEATHER_RADIUS; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;

        for (let dx = -FEATHER_RADIUS; dx <= FEATHER_RADIUS; dx += 1) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;

          const neighbour = ny * width + nx;
          if (kept[neighbour]) continue;

          r += source[neighbour * 4];
          g += source[neighbour * 4 + 1];
          b += source[neighbour * 4 + 2];
          samples += 1;
        }
      }

      // Too few background samples to average is a corner case, not a boundary.
      if (samples < 3) continue;

      const a = alpha / 255;
      const inv = (1 - a) / samples;
      const offset = index * 4;

      // Writing into a Uint8ClampedArray clamps the out-of-gamut results that
      // un-mixing can produce.
      data[offset] = (source[offset] - inv * r) / a;
      data[offset + 1] = (source[offset + 1] - inv * g) / a;
      data[offset + 2] = (source[offset + 2] - inv * b) / a;
    }
  }
}


/** Squared distance in Lab, for comparing a pixel to the base colour. */
export function labDistanceSq(lab, r, g, b) {
  const p = rgbToLab(r, g, b);
  const dl = p[0] - lab[0];
  const da = p[1] - lab[1];
  const db = p[2] - lab[2];
  return dl * dl + da * da + db * db;
}

export function rgbToLab(r, g, b) {
  const lin = (c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const R = lin(r);
  const G = lin(g);
  const B = lin(b);

  let X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  let Y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  let Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;

  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  X = f(X); Y = f(Y); Z = f(Z);

  return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)];
}


/**
 * Whether a garment-class pixel is really uncovered base layer.
 *
 * Two independent signals, and both must agree.
 *
 * Colour alone compares the pixel to the base garment's measured colour. It
 * deleted a white shirt in its entirety, because against a cream base a white
 * shirt genuinely is that colour, near enough.
 *
 * Position alone compares the pixel to the same point in the bare avatar photo:
 * where nothing was added, nothing changed. On its own it is fooled by the
 * generator re-rendering the whole photo a shade warmer or cooler.
 *
 * Together they agree only where the pixel both looks like the base garment and
 * looks like what was already there — which is what a patch of uncovered base
 * actually is. A white shirt fails the second test: the chest used to be cream
 * and now is white.
 */
/** Squared distance between two Lab colours, ignoring lightness. */
export function chromaDistanceSq(a, b) {
  const da = a[1] - b[1];
  const db = a[2] - b[2];
  return da * da + db * db;
}

export function isUncoveredBase(pixel, base, avatarPixel, baseTolerance, unchangedTolerance) {
  if (!base) return false;

  const lab = rgbToLab(pixel[0], pixel[1], pixel[2]);

  // Both comparisons ignore lightness and use colour alone.
  //
  // A garment thrown over the base does not only cover it, it shades it: the
  // bodysuit under an open jacket goes much darker without changing colour at
  // all. Measured on all three channels, that shading reads both as "not the
  // base colour any more" and as "something was added here" — and a patch of
  // shaded bodysuit duly survived into the jacket's layer as a tan blob.
  //
  // Cream in shadow is still cream. A white shirt over cream is a different
  // colour whether it is lit or shaded, so nothing is lost by looking away from
  // brightness, and the shading stops lying.
  if (chromaDistanceSq(lab, base) >= baseTolerance * baseTolerance) return false;
  if (!avatarPixel) return true;

  const avatarLab = rgbToLab(avatarPixel[0], avatarPixel[1], avatarPixel[2]);
  return chromaDistanceSq(lab, avatarLab) < unchangedTolerance * unchangedTolerance;
}

/**
 * Pull the alpha edge onto the real edge of the garment.
 *
 * The mask comes from a model that works at 256x256 and knows roughly where a
 * garment is; the photograph knows exactly. A guided filter reconciles the two:
 * within a small window it fits alpha as a straight line against the image's
 * own brightness, so alpha is forced to change where the picture changes and to
 * stay flat where the picture is flat. The boundary snaps onto the collar, the
 * hem, the sole — instead of sitting a pixel or two off it in a soft haze.
 *
 * `epsilon` decides how much variation in the image counts as an edge rather
 * than as texture. Small values follow every thread; large values ignore the
 * garment's own weave and follow only its outline, which is what is wanted.
 */
export function guidedFilterAlpha(alpha, guide, width, height, radius, epsilon) {
  const count = width * height;

  const meanGuide = boxBlur(guide, width, height, radius);
  const meanAlpha = boxBlur(alpha, width, height, radius);

  const guideSquared = new Float32Array(count);
  const product = new Float32Array(count);

  for (let i = 0; i < count; i += 1) {
    guideSquared[i] = guide[i] * guide[i];
    product[i] = guide[i] * alpha[i];
  }

  const meanGuideSquared = boxBlur(guideSquared, width, height, radius);
  const meanProduct = boxBlur(product, width, height, radius);

  const slope = new Float32Array(count);
  const offset = new Float32Array(count);

  for (let i = 0; i < count; i += 1) {
    const variance = meanGuideSquared[i] - meanGuide[i] * meanGuide[i];
    const covariance = meanProduct[i] - meanGuide[i] * meanAlpha[i];

    slope[i] = covariance / (variance + epsilon);
    offset[i] = meanAlpha[i] - slope[i] * meanGuide[i];
  }

  const meanSlope = boxBlur(slope, width, height, radius);
  const meanOffset = boxBlur(offset, width, height, radius);

  const out = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    const value = meanSlope[i] * guide[i] + meanOffset[i];
    out[i] = value < 0 ? 0 : value > 1 ? 1 : value;
  }

  return out;
}

/** Separable box blur over a float plane. */
function boxBlur(source, width, height, radius) {
  const rows = new Float32Array(width * height);
  const out = new Float32Array(width * height);

  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    let total = 0;
    let samples = 0;

    // A running sum: each step adds one column and drops one, so the cost does
    // not grow with the radius.
    for (let x = 0; x <= radius && x < width; x += 1) {
      total += source[row + x];
      samples += 1;
    }

    for (let x = 0; x < width; x += 1) {
      rows[row + x] = total / samples;

      const leaving = x - radius;
      const entering = x + radius + 1;

      if (leaving >= 0) { total -= source[row + leaving]; samples -= 1; }
      if (entering < width) { total += source[row + entering]; samples += 1; }
    }
  }

  for (let x = 0; x < width; x += 1) {
    let total = 0;
    let samples = 0;

    for (let y = 0; y <= radius && y < height; y += 1) {
      total += rows[y * width + x];
      samples += 1;
    }

    for (let y = 0; y < height; y += 1) {
      out[y * width + x] = total / samples;

      const leaving = y - radius;
      const entering = y + radius + 1;

      if (leaving >= 0) { total -= rows[leaving * width + x]; samples -= 1; }
      if (entering < height) { total += rows[entering * width + x]; samples += 1; }
    }
  }

  return out;
}

/**
 * Radius and edge sensitivity for the alpha refinement.
 *
 * Radius chosen by measurement, not by taste. Against a mask whose edge sat a
 * pixel off the garment's real one, every radius from 1 to 4 moved it onto the
 * right column — but 2, 3 and 4 also widened the transition from nine pixels to
 * eleven, thirteen and fifteen. A wider transition is a hazier garment
 * boundary, which is the opposite of the point. Radius 1 repositions the edge
 * and leaves its sharpness alone. Epsilon made no difference to either.
 */
export const GUIDE_RADIUS = 1;
export const GUIDE_EPSILON = 1e-3;
