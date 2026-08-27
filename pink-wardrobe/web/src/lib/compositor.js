/**
 * Layer compositing and seam blending — free, on-device, unlimited.
 *
 * Stacks saved layers over the avatar in strict z-order and softens the seams
 * where they meet, so a collar or waistband does not read as pasted on.
 *
 * The Python version used OpenCV's Poisson `seamlessClone`. There is no
 * equivalent in the browser, so seams are blended by gradient-weighted alpha
 * feathering across the boundary band instead. The visual goal and the band
 * geometry are the same; only the solver differs. For garment seams — narrow
 * bands where two opaque textures meet — the difference is slight, and it
 * costs milliseconds rather than a server round-trip.
 */

const SEAM_BAND_PX = 12;

/**
 * Which group a layer stacks in: pinned under everything, ordered with the
 * rest, or pinned over everything.
 *
 * Accessories are the reason this exists. A necklace or a belt has no sensible
 * place in a sequence of garments — it is simply on top of them or beneath
 * them — so it is pinned rather than numbered.
 */
function pinRank(layer) {
  if (layer.pin === 'under') return -1;
  if (layer.pin === 'top') return 1;
  return 0;
}

/**
 * Stable identifier for an outfit — the same items in the same arrangement.
 *
 * Used as the composite cache key, so reopening a previously built outfit
 * serves the saved render instead of recomputing it.
 *
 * Deliberately NOT order-independent. It used to be, back when a fixed table
 * decided the stacking and the same items could only ever produce one image.
 * Now that the wearer's picking order sets the stack, a shirt over jeans and a
 * shirt tucked into them are the same two items and two different pictures, so
 * both the sequence and the accessory pins have to be in the key.
 */
export async function comboHash(itemIds, pins = {}) {
  const joined = itemIds.map((id) => `${id}:${pins[id] || ''}`).join('|');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(joined));

  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not load a layer image.'));
    image.src = url;
  });
}

/**
 * Paint the avatar plus its layers onto a canvas.
 *
 * `layers` is [{ category, url, nudge, order, pin }], painted in ascending
 * `order` — the sequence the wearer picked them in. Picking a swimsuit and then
 * jeans puts the jeans over the swimsuit's hip, which reads as tucked in;
 * picking the jeans first and a shirt second leaves the shirt out over them.
 * A fixed table of categories cannot express that difference, because it is a
 * choice about the outfit rather than a fact about the garments.
 *
 * `pin` overrides `order` for accessories: 'under' below everything, 'top'
 * above everything.
 */
export async function compositeToCanvas(canvas, avatarUrl, layers, { blendSeams = true } = {}) {
  const avatar = await loadImage(avatarUrl);

  canvas.width = avatar.naturalWidth;
  canvas.height = avatar.naturalHeight;

  const context = canvas.getContext('2d', { willReadFrequently: blendSeams });
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(avatar, 0, 0);

  const ordered = [...layers].sort(
    (a, b) => pinRank(a) - pinRank(b) || (a.order ?? 0) - (b.order ?? 0),
  );

  // Load in parallel, paint in order — otherwise a slow layer reorders the stack.
  const loaded = await Promise.all(
    ordered.map(async (layer) => ({ ...layer, image: await loadImage(layer.url) })),
  );

  for (const layer of loaded) {
    const before = blendSeams
      ? context.getImageData(0, 0, canvas.width, canvas.height)
      : null;

    drawLayer(context, canvas, layer);

    if (blendSeams && before) {
      blendSeam(context, canvas, before);
    }
  }

  return canvas;
}

function drawLayer(context, canvas, layer) {
  const { offsetX = 0, offsetY = 0, scale = 1 } = layer.nudge || {};

  if (scale === 1 && offsetX === 0 && offsetY === 0) {
    context.drawImage(layer.image, 0, 0, canvas.width, canvas.height);
    return;
  }

  const width = canvas.width * scale;
  const height = canvas.height * scale;

  context.drawImage(
    layer.image,
    offsetX + (canvas.width - width) / 2,
    offsetY + (canvas.height - height) / 2,
    width,
    height,
  );
}

/**
 * Soften the boundary introduced by the layer just painted.
 *
 * Finds pixels that changed, takes the band around that region's edge, and
 * cross-fades between the pre- and post-stack images across it. Only the band
 * is touched — blending a whole garment would wash its colour toward whatever
 * sits underneath.
 */
function blendSeam(context, canvas, before) {
  const { width, height } = canvas;
  const after = context.getImageData(0, 0, width, height);

  const beforeData = before.data;
  const afterData = after.data;

  // Mark where this layer actually landed.
  const changed = new Uint8Array(width * height);
  let any = false;

  for (let i = 0; i < width * height; i += 1) {
    const p = i * 4;
    if (
      beforeData[p] !== afterData[p] ||
      beforeData[p + 1] !== afterData[p + 1] ||
      beforeData[p + 2] !== afterData[p + 2] ||
      beforeData[p + 3] !== afterData[p + 3]
    ) {
      changed[i] = 1;
      any = true;
    }
  }

  if (!any) return;

  // Distance-to-edge within the changed region, approximated by a two-pass
  // chamfer sweep. Cheap, and accurate enough for a 12px band.
  const distance = new Float32Array(width * height);
  const FAR = 1e6;

  for (let i = 0; i < distance.length; i += 1) {
    distance[i] = changed[i] ? FAR : 0;
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      if (!changed[i]) continue;

      let best = distance[i];
      if (x > 0) best = Math.min(best, distance[i - 1] + 1);
      if (y > 0) best = Math.min(best, distance[i - width] + 1);
      distance[i] = best;
    }
  }

  for (let y = height - 1; y >= 0; y -= 1) {
    for (let x = width - 1; x >= 0; x -= 1) {
      const i = y * width + x;
      if (!changed[i]) continue;

      let best = distance[i];
      if (x < width - 1) best = Math.min(best, distance[i + 1] + 1);
      if (y < height - 1) best = Math.min(best, distance[i + width] + 1);
      distance[i] = best;
    }
  }

  // Cross-fade across the band: fully "before" at the edge, fully "after" once
  // SEAM_BAND_PX inside. smoothstep avoids a visible linear ramp.
  for (let i = 0; i < width * height; i += 1) {
    if (!changed[i]) continue;

    const d = distance[i];
    if (d >= SEAM_BAND_PX) continue;

    const t = d / SEAM_BAND_PX;
    const weight = t * t * (3 - 2 * t);
    const p = i * 4;

    for (let c = 0; c < 4; c += 1) {
      afterData[p + c] =
        afterData[p + c] * weight + beforeData[p + c] * (1 - weight);
    }
  }

  context.putImageData(after, 0, 0);
}

export function canvasToBlob(canvas) {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}
