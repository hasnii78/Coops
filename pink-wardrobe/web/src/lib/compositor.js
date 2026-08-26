/**
 * Client-side layer compositing on Canvas.
 *
 * This is the zero-cost, sub-second path the brief requires: stack the saved
 * layers over the avatar in z-order and paint. It carries no seam blending —
 * `build_outfit` on the server does that and returns a refined image, which
 * the UI swaps in when it arrives.
 *
 * The split exists because a round trip per preview would blow the 2-second
 * target, while blending in the browser is not practical.
 */

import { Z_ORDER } from './constants';

function zIndex(category) {
  const index = Z_ORDER.indexOf(category);
  return index === -1 ? Z_ORDER.length : index;
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Could not load layer: ${url}`));
    image.src = url;
  });
}

/**
 * Paint the avatar plus its layers onto a canvas.
 *
 * `layers` is [{ category, url, nudge }]. `nudge` is the optional manual
 * offset from the item detail view, used when automatic pose alignment was
 * not confident enough.
 */
export async function compositeToCanvas(canvas, avatarUrl, layers) {
  const avatar = await loadImage(avatarUrl);

  canvas.width = avatar.naturalWidth;
  canvas.height = avatar.naturalHeight;

  const context = canvas.getContext('2d');
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(avatar, 0, 0);

  const ordered = [...layers].sort((a, b) => zIndex(a.category) - zIndex(b.category));

  // Load in parallel, paint in order — otherwise a slow layer reorders the stack.
  const loaded = await Promise.all(
    ordered.map(async (layer) => ({ ...layer, image: await loadImage(layer.url) })),
  );

  for (const layer of loaded) {
    const { offsetX = 0, offsetY = 0, scale = 1 } = layer.nudge || {};

    if (scale === 1 && offsetX === 0 && offsetY === 0) {
      context.drawImage(layer.image, 0, 0, canvas.width, canvas.height);
      continue;
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

  return canvas;
}

/** Export the current composite as a shareable PNG blob. */
export function canvasToBlob(canvas) {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}
