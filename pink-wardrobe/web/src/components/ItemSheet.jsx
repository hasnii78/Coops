import { useEffect, useState } from 'react';

import { CATEGORY_LABELS } from '../lib/constants';
import { signedUrl } from '../lib/storage';

/**
 * One item, up close, with the actions that only make sense for a single piece.
 *
 * Delete is the reason this exists. It is a soft delete into the recycle bin,
 * offered with an undo, because the layer behind an item cost a credit and is
 * the one thing in the app that money cannot immediately replace.
 */
export default function ItemSheet({ item, onClose, onDelete }) {
  const [url, setUrl] = useState(null);
  const [confirming, setConfirming] = useState(false);

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
            {url ? (
              <img src={url} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
            ) : null}
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
