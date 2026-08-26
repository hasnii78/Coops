import { useEffect, useState } from 'react';

import { resolveUrl } from '../lib/closet';
import { IconHeart, IconPin } from './Icons';

const STATUS_COPY = {
  queued: 'Queued',
  generating: 'Creating your layer…',
  processing: 'Finishing up…',
  failed: 'Something went wrong',
};

export default function ItemTile({ item, onToggleLike, onTogglePin, onSelect, onRetry }) {
  const [url, setUrl] = useState(null);

  useEffect(() => {
    let active = true;
    // Prefer the finished layer; fall back to the original photo while the
    // pipeline is still running.
    resolveUrl(item.layerPath || item.photoPath)
      .then((next) => { if (active) setUrl(next); })
      .catch(() => {});
    return () => { active = false; };
  }, [item.layerPath, item.photoPath]);

  const busy = ['queued', 'generating', 'processing'].includes(item.status);

  return (
    <article className="item-tile">
      <button
        type="button"
        onClick={() => onSelect?.(item)}
        style={{ display: 'block', width: '100%', padding: 0, border: 'none', background: 'none' }}
      >
        {url ? <img src={url} alt={item.name} loading="lazy" /> : <div style={{ aspectRatio: '3 / 4', background: 'var(--c-50)' }} />}
      </button>

      {busy || item.status === 'failed' ? (
        <div className="tile-status">
          {busy ? <span className="spinner" aria-hidden="true" /> : null}
          <span>{STATUS_COPY[item.status]}</span>
          {item.status === 'failed' ? (
            <button type="button" className="chip" onClick={() => onRetry?.(item)}>
              Try again
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="meta">
        <strong>{item.name}</strong>
        <div className="row-between">
          <span>{item.wearCount ? `Worn ${item.wearCount}×` : 'Not worn yet'}</span>
          <span className="row" style={{ gap: 4 }}>
            <button
              type="button"
              aria-label={item.liked ? 'Unlike' : 'Like'}
              aria-pressed={Boolean(item.liked)}
              onClick={() => onToggleLike?.(item, !item.liked)}
              style={{ background: 'none', border: 'none', padding: 4, color: item.liked ? 'var(--c-400)' : 'var(--muted)' }}
            >
              <IconHeart filled={item.liked} width={18} height={18} />
            </button>
            <button
              type="button"
              aria-label={item.pinned ? 'Unpin' : 'Pin'}
              aria-pressed={Boolean(item.pinned)}
              onClick={() => onTogglePin?.(item, !item.pinned)}
              style={{ background: 'none', border: 'none', padding: 4, color: item.pinned ? 'var(--c-400)' : 'var(--muted)' }}
            >
              <IconPin filled={item.pinned} width={18} height={18} />
            </button>
          </span>
        </div>
      </div>
    </article>
  );
}
