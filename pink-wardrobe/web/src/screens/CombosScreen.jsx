import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import EmptyState from '../components/EmptyState';
import { IconHeart, IconPin } from '../components/Icons';
import { listCombos, patchCombo, wearCombo } from '../lib/closet';
import { signedUrl } from '../lib/storage';

export default function CombosScreen() {
  const navigate = useNavigate();
  const [combos, setCombos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    try {
      setCombos(await listCombos());
      setError(null);
    } catch (caught) {
      setError(caught.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const pinned = useMemo(() => combos.filter((combo) => combo.pinned), [combos]);
  const rest = useMemo(() => combos.filter((combo) => !combo.pinned), [combos]);

  /**
   * Remix opens the builder with this outfit already selected, so swapping a
   * piece reuses the existing layers. Nothing is regenerated and nothing is
   * charged.
   */
  function handleRemix(combo) {
    navigate('/me', { state: { preselectItemIds: combo.item_ids || [] } });
  }

  async function patch(combo, changes) {
    setCombos((prev) => prev.map((c) => (c.id === combo.id ? { ...c, ...changes } : c)));
    await patchCombo(combo.id, changes);
  }

  if (loading) {
    return (
      <>
        <header className="app-header"><h1>Combos</h1></header>
        <main className="app-main"><div className="empty-state"><span className="spinner" /></div></main>
      </>
    );
  }

  return (
    <>
      <header className="app-header"><h1>Combos</h1></header>
      <main className="app-main stack">
        {error ? <div className="error-banner" role="alert">{error}</div> : null}

        {combos.length === 0 ? (
          <EmptyState title="No saved outfits yet">
            Build something on the Me tab and save it. Saved outfits rebuild
            instantly and never cost anything to wear again.
          </EmptyState>
        ) : (
          <>
            {pinned.length ? (
              <section className="stack">
                <h2 className="section-title">Pinned</h2>
                {pinned.map((combo) => (
                  <ComboRow key={combo.id} combo={combo} onPatch={patch}
                    onWorn={refresh} onRemix={handleRemix} />
                ))}
              </section>
            ) : null}

            <section className="stack">
              <h2 className="section-title">All outfits</h2>
              {rest.map((combo) => (
                <ComboRow key={combo.id} combo={combo} onPatch={patch}
                  onWorn={refresh} onRemix={handleRemix} />
              ))}
            </section>
          </>
        )}
      </main>
    </>
  );
}

function ComboRow({ combo, onPatch, onWorn, onRemix }) {
  const [thumb, setThumb] = useState(null);

  useEffect(() => {
    if (combo.composite_path) signedUrl(combo.composite_path).then(setThumb).catch(() => {});
  }, [combo.composite_path]);

  return (
    <article className="card row" style={{ gap: 'var(--space-3)' }}>
      {thumb ? (
        <img src={thumb} alt="" width={54} height={72}
          style={{ objectFit: 'cover', borderRadius: 'var(--radius-sm)', background: 'var(--c-50)' }} />
      ) : (
        <div style={{ width: 54, height: 72, borderRadius: 'var(--radius-sm)', background: 'var(--c-50)' }} />
      )}

      <div style={{ flex: 1, minWidth: 0 }}>
        <strong style={{ display: 'block' }}>{combo.name}</strong>
        <span className="muted">
          {combo.wear_count ? `Worn ${combo.wear_count}×` : 'Not worn yet'}
          {combo.item_ids?.length ? ` · ${combo.item_ids.length} pieces` : ''}
        </span>
        {combo.notes ? <div className="muted" style={{ marginTop: 4 }}>{combo.notes}</div> : null}
      </div>

      <div className="row" style={{ gap: 2 }}>
        <button type="button" aria-label={combo.liked ? 'Unlike' : 'Like'}
          aria-pressed={Boolean(combo.liked)}
          onClick={() => onPatch(combo, { liked: !combo.liked })}
          style={{ background: 'none', border: 'none', padding: 6, color: combo.liked ? 'var(--c-400)' : 'var(--muted)' }}>
          <IconHeart filled={combo.liked} width={18} height={18} />
        </button>
        <button type="button" aria-label={combo.pinned ? 'Unpin' : 'Pin'}
          aria-pressed={Boolean(combo.pinned)}
          onClick={() => onPatch(combo, { pinned: !combo.pinned })}
          style={{ background: 'none', border: 'none', padding: 6, color: combo.pinned ? 'var(--c-400)' : 'var(--muted)' }}>
          <IconPin filled={combo.pinned} width={18} height={18} />
        </button>
        <button type="button" className="chip" onClick={() => wearCombo(combo).then(onWorn)}>
          Worn
        </button>
        <button type="button" className="chip" onClick={() => onRemix?.(combo)}>
          Remix
        </button>
      </div>
    </article>
  );
}
