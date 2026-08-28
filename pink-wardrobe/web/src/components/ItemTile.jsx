import { useEffect, useState } from 'react';

import LayerThumb from './LayerThumb';
import { signedUrl } from '../lib/storage';
import { IconHeart, IconPin } from './Icons';

const STATUS_COPY = {
  queued: 'Queued',
  generating: 'Creating your layer…',
  processing: 'Finishing up…',
  failed: 'Something went wrong',
};

export default function ItemTile({ item, onToggleLike, onTogglePin, onSelect, onRetry, onResume }) {
  const [url, setUrl] = useState(null);

  useEffect(() => {
    let active = true;
    // Prefer the finished layer; fall back to the original photo while the
    // pipeline is still running.
    signedUrl(item.layer_path || item.photo_path)
      .then((next) => { if (active) setUrl(next); })
      .catch(() => {});
    return () => { active = false; };
  }, [item.layer_path, item.photo_path]);

  const busy = ['queued', 'generating', 'processing'].includes(item.status);

  // 'processing' means the paid step finished and the device never cut the
  // layer. Nothing is running, so an unqualified spinner is a lie — the item is
  // waiting for someone to pick it back up, which costs nothing.
  const stranded = item.status === 'processing' && Boolean(item.generation_path);

  return (
    <article className="item-tile">
      <button
        type="button"
        onClick={() => onSelect?.(item)}
        style={{ display: 'block', width: '100%', padding: 0, border: 'none', background: 'none' }}
      >
        {url ? (
          <LayerThumb url={url} alt={item.name}
            bounds={item.layer_path ? item.alignment?.content : null} />
        ) : (
          <div style={{ aspectRatio: '3 / 4', background: 'var(--c-50)' }} />
        )}
      </button>

      {item.needs_regeneration && !busy ? (
        <div className="tile-status" style={{ background: 'color-mix(in srgb, var(--c-900) 55%, transparent)' }}>
          <span>Needs updating<br />for your new avatar</span>
        </div>
      ) : null}

      {busy || item.status === 'failed' ? (
        <div className="tile-status">
          {busy && !stranded ? <span className="spinner" aria-hidden="true" /> : null}

          <span>
            {stranded ? 'Paused — nothing was lost' : STATUS_COPY[item.status]}
          </span>

          {item.status === 'failed' && item.error ? (
            <span style={{ fontSize: '0.72rem', opacity: 0.85 }}>{item.error}</span>
          ) : null}

          {stranded ? (
            <button type="button" className="chip" onClick={() => onResume?.(item)}>
              Resume — free
            </button>
          ) : null}

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
          <span>{item.wear_count ? `Worn ${item.wear_count}×` : 'Not worn yet'}</span>
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
