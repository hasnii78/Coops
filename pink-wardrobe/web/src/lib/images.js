/**
 * Client-side image compression.
 *
 * Phone cameras produce 4-8MB JPEGs. Uploading those raw would multiply
 * Storage cost and slow every upload for no quality benefit — FASHN and rembg
 * both work from a long edge well under 2000px.
 */

const MAX_EDGE = 1600;
const QUALITY = 0.82;

export async function compressImage(file, { maxEdge = MAX_EDGE, quality = QUALITY } = {}) {
  if (!file.type.startsWith('image/')) {
    throw new Error('That file is not an image.');
  }

  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));

  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext('2d');
  context.imageSmoothingQuality = 'high';
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();

  const blob = await new Promise((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', quality),
  );

  if (!blob) throw new Error('Could not process that image.');

  // If compression somehow made it bigger, keep the original.
  return blob.size < file.size ? blob : file;
}

/** Quick client-side pre-check so obviously bad avatars fail before upload. */
export async function inspectImage(file) {
  const bitmap = await createImageBitmap(file);
  const { width, height } = bitmap;
  bitmap.close?.();

  return {
    width,
    height,
    tooSmall: Math.min(width, height) < 512,
    isPortrait: height >= width,
  };
}
