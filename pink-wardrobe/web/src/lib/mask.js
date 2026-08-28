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

/**
 * Pull the mask in by `radius` pixels.
 *
 * MediaPipe returns a 256x256 mask that gets sampled up to the full render with
 * nearest-neighbour, so the boundary lands on a coarse grid and routinely sits
 * a pixel or two outside the true edge — keeping a rim of whatever was behind
 * the garment. Eroding first absorbs that slop.
 *
 * Separable: a square structuring element is the same as a horizontal pass
 * followed by a vertical one, at a fraction of the work.
 */
export function erodeMask(kept, width, height, radius) {
  const rows = new Uint8Array(kept.length);

  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      let on = 1;
      for (let d = -radius; d <= radius; d += 1) {
        const nx = x + d;
        if (nx < 0 || nx >= width || !kept[row + nx]) { on = 0; break; }
      }
      rows[row + x] = on;
    }
  }

  const out = new Uint8Array(kept.length);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let on = 1;
      for (let d = -radius; d <= radius; d += 1) {
        const ny = y + d;
        if (ny < 0 || ny >= height || !rows[ny * width + x]) { on = 0; break; }
      }
      out[y * width + x] = on;
    }
  }

  return out;
}

/** Pixels to pull the mask in by before feathering. */
export const ERODE_RADIUS = 1;

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

  for (let i = 0; i < count; i += 1) {
    data[i * 4 + 3] = kept[i] ? Math.round(coverage[i] * 255) : 0;
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

