import { useCallback, useEffect, useRef, useState } from 'react';

const MIN_SCALE = 1;
const MAX_SCALE = 4;

/**
 * Pinch-zoom, drag-pan and a fullscreen view for the outfit preview.
 *
 * Strictly a lens. It applies a CSS transform to whatever it wraps and touches
 * nothing else, so the canvas it contains keeps its full-body pixels at full
 * resolution no matter how far in the view is zoomed. Saving reads that canvas
 * directly, which means it is not possible to zoom into a collar and
 * accidentally save the crop — the picture that gets written is always the
 * whole render.
 */
export default function AvatarViewer({ children, expandable = true }) {
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [full, setFull] = useState(false);

  const gesture = useRef(null);
  const frame = useRef(null);

  const reset = useCallback(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  // Leaving fullscreen returns to the whole outfit rather than to wherever the
  // last gesture happened to leave the view.
  useEffect(() => { reset(); }, [full, reset]);

  useEffect(() => {
    if (!full) return undefined;

    const onKey = (event) => { if (event.key === 'Escape') setFull(false); };
    window.addEventListener('keydown', onKey);

    // The page behind must not scroll while a fullscreen view is open.
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [full]);

  const clampOffset = useCallback((next, atScale) => {
    const element = frame.current;
    if (!element) return next;

    // Panning is bounded by how much of the content the zoom actually pushed
    // outside the frame, so the subject can never be dragged off screen.
    const limitX = (element.clientWidth * (atScale - 1)) / 2;
    const limitY = (element.clientHeight * (atScale - 1)) / 2;

    return {
      x: Math.max(-limitX, Math.min(limitX, next.x)),
      y: Math.max(-limitY, Math.min(limitY, next.y)),
    };
  }, []);

  function distance(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.hypot(dx, dy);
  }

  function onTouchStart(event) {
    if (event.touches.length === 2) {
      gesture.current = {
        kind: 'pinch',
        start: distance(event.touches),
        scale,
      };
    } else if (event.touches.length === 1 && scale > 1) {
      gesture.current = {
        kind: 'pan',
        x: event.touches[0].clientX,
        y: event.touches[0].clientY,
        offset,
      };
    }
  }

  function onTouchMove(event) {
    const active = gesture.current;
    if (!active) return;

    if (active.kind === 'pinch' && event.touches.length === 2) {
      event.preventDefault();
      const ratio = distance(event.touches) / active.start;
      const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, active.scale * ratio));
      setScale(next);
      setOffset((current) => clampOffset(current, next));
      return;
    }

    if (active.kind === 'pan' && event.touches.length === 1) {
      event.preventDefault();
      setOffset(clampOffset({
        x: active.offset.x + (event.touches[0].clientX - active.x),
        y: active.offset.y + (event.touches[0].clientY - active.y),
      }, scale));
    }
  }

  function onTouchEnd() {
    gesture.current = null;
    if (scale <= MIN_SCALE) reset();
  }

  const stage = (
    <div
      ref={frame}
      className={full ? 'viewer-stage viewer-stage-full' : 'viewer-stage'}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onDoubleClick={reset}
    >
      <div
        className="viewer-content"
        style={{
          transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
        }}
      >
        {children}
      </div>
    </div>
  );

  if (full) {
    return (
      <div className="viewer-overlay" role="dialog" aria-modal="true" aria-label="Outfit, full screen">
        {stage}
        <div className="viewer-controls">
          <button type="button" className="chip" onClick={reset} disabled={scale === 1}>
            Reset
          </button>
          <button type="button" className="chip" onClick={() => setFull(false)}>
            Done
          </button>
        </div>
        <p className="viewer-hint">Pinch to zoom · drag to move · double-tap to reset</p>
      </div>
    );
  }

  return (
    <div className="viewer">
      {stage}
      {expandable ? (
        <button type="button" className="viewer-expand" onClick={() => setFull(true)}
          aria-label="View full screen">
          ⤢
        </button>
      ) : null}
    </div>
  );
}
