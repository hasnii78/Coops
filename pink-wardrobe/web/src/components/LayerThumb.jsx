/**
 * A layer, framed on the garment rather than on the body it was cut from.
 *
 * Layers are whole-body-sized so they stack correctly, which leaves a pair of
 * shoes as a small object at the bottom of a tall transparent picture. Shown
 * whole, the tile reads as empty — both pairs of shoes looked like failures
 * when the layers were fine. This zooms to the part that has something in it.
 *
 * `bounds` comes from the cut and is in fractions of the frame. Without it the
 * image is shown as-is, which is the old behaviour and always safe.
 */
export default function LayerThumb({ url, alt, bounds, fallbackFit = 'contain' }) {
  if (!url) return null;

  if (!bounds?.width || !bounds?.height) {
    return <img src={url} alt={alt} loading="lazy" style={{ objectFit: fallbackFit }} />;
  }

  // A little air around the garment, so it does not touch the tile edges.
  const zoom = 1 / Math.min(1, Math.max(bounds.width, bounds.height) * 1.12);

  const centreX = bounds.left + bounds.width / 2;
  const centreY = bounds.top + bounds.height / 2;

  return (
    <img
      src={url}
      alt={alt}
      loading="lazy"
      style={{
        objectFit: 'contain',
        // Translate first (in the element's own space) to bring the garment's
        // centre to the middle, then zoom about that middle.
        transform: `scale(${zoom}) translate(${(0.5 - centreX) * 100}%, ${(0.5 - centreY) * 100}%)`,
      }}
    />
  );
}
