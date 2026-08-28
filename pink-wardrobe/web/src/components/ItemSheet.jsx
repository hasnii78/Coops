import { useEffect, useState } from 'react';

import { CATEGORY_LABELS, PLACEMENTS } from '../lib/constants';
import LayerThumb from './LayerThumb';
import { recutWithPlacement } from '../lib/closet';
import { signedUrl } from '../lib/storage';

/**
 * One item, up close, with the actions that only make sense for a single piece.
 *
 * Delete is the reason this exists. It is a soft delete into the recycle bin,
 * offered with an undo, because the layer behind an item cost a credit and is
 * the one thing in the app that money cannot immediately replace.
 */
export default function ItemSheet({ item, onClose, onDelete, onChanged }) {
  const [url, setUrl] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [placement, setPlacement] = useState(item.placement || 'neck');
  const [recutting, setRecutting] = useState(false);
  const [error, setError] = useState(null);

  const accessory = item.category === 'accessories';

  async function handleRecut() {
    setError(null);
    setRecutting(true);

    try {
      await recutWithPlacement(item, placement);
      onChanged?.();
      onClose();
    } catch (caught) {
      setError(caught.message);
    } finally {
      setRecutting(false);
    }
  }

  useEffect(() => {
    let active = true;
    signedUrl(item.layer_path || item.photo_path)
      .then((next) => { if (active) setUrl(next); })
      .catch(() => {});
    return () => { active = false; };
  }, [item.layer_path, item.photo_path]);

  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={item.name}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 50,
        background: 'color-mix(in srgb, var(--c-900) 55%, transparent)',
        display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
      }}
    >
      <div
        className="stack"
        style={{
          width: '100%', maxWidth: 560, background: 'var(--surface)',
          borderTopLeftRadius: 'var(--radius-lg)',
          borderTopRightRadius: 'var(--radius-lg)',
          padding: 'var(--space-5)', maxHeight: '88dvh', overflowY: 'auto',
        }}
      >
        <div className="row" style={{ gap: 'var(--space-4)', alignItems: 'flex-start' }}>
          <div style={{
            width: 92, height: 118, flex: '0 0 auto', borderRadius: 'var(--radius-md)',
            background: 'var(--c-50)', overflow: 'hidden',
          }}>
            <LayerThumb url={url} alt=""
              bounds={item.layer_path ? item.alignment?.content : null} />
          </div>

          <div className="stack" style={{ gap: 'var(--space-1)', minWidth: 0 }}>
            <h2 style={{ margin: 0, fontSize: 'var(--text-lg)' }}>{item.name}</h2>
            <span className="muted">{CATEGORY_LABELS[item.category]}</span>
            {item.color?.name ? <span className="muted">{item.color.name}</span> : null}
            {item.needs_regeneration ? (
              <span className="muted">Fitted to your previous avatar</span>
            ) : null}
          </div>
        </div>

        {accessory && !confirming ? (
          <label className="stack" style={{ gap: 'var(--space-1)' }}>
            <span className="section-title">Where it goes</span>
            <select className="input" value={placement}
              onChange={(event) => setPlacement(event.target.value)}>
              {PLACEMENTS.map(({ id, label }) => (
                <option key={id} value={id}>{label}</option>
              ))}
            </select>

            <button type="button" className="btn btn-secondary" onClick={handleRecut}
              disabled={recutting}>
              {recutting ? <span className="spinner" aria-hidden="true" /> : null}
              {recutting ? 'Looking again…' : 'Cut it again — free'}
            </button>

            <span className="muted" style={{ fontSize: 'var(--text-xs)' }}>
              Uses the image already generated for this item, so it costs nothing.
            </span>
          </label>
        ) : null}

        {error ? <div className="error-banner" role="alert">{error}</div> : null}

        {confirming ? (
          <>
            <p className="muted" style={{ margin: 0 }}>
              This moves {item.name} to the recycle bin. It stays there for 15 days,
              layer and all, so restoring it later costs nothing.
            </p>

            <div className="row" style={{ gap: 'var(--space-2)' }}>
              <button type="button" className="btn" style={{ flex: 1 }}
                onClick={() => onDelete(item)}>
                Delete
              </button>
              <button type="button" className="btn btn-secondary"
                onClick={() => setConfirming(false)}>
                Keep
              </button>
            </div>
          </>
        ) : (
          <div className="row" style={{ gap: 'var(--space-2)' }}>
            <button type="button" className="btn btn-secondary" style={{ flex: 1 }}
              onClick={onClose}>
              Close
            </button>
            <button type="button" className="btn btn-secondary"
              onClick={() => setConfirming(true)}>
              Delete
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
