import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import EmptyState from '../components/EmptyState';
import SendToSheet from '../components/SendToSheet';
import { IconHeart, IconPin, IconSend } from '../components/Icons';
import { useAuth } from '../context/AuthContext';
import { listCombos, resolveUrl, wearCombo } from '../lib/closet';
import { doc, updateDoc } from 'firebase/firestore';
import { db } from '../firebase';

export default function CombosScreen() {
  const { uid } = useAuth();
  const navigate = useNavigate();
  const [combos, setCombos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(null);

  async function refresh() {
    if (!uid) return;
    setLoading(true);
    try { setCombos(await listCombos(uid)); } finally { setLoading(false); }
  }

  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [uid]);

  const pinned = useMemo(() => combos.filter((combo) => combo.pinned), [combos]);
  const rest = useMemo(() => combos.filter((combo) => !combo.pinned), [combos]);

  /**
   * Remix opens the builder with this outfit already selected, so swapping a
   * piece reuses the existing layers. Nothing is regenerated and nothing is
   * charged.
   */
  function handleRemix(combo) {
    navigate('/me', { state: { preselectItemIds: combo.itemIds || [] } });
  }

  async function patch(combo, changes) {
    await updateDoc(doc(db, 'users', uid, 'combos', combo.id), changes);
    setCombos((prev) => prev.map((c) => (c.id === combo.id ? { ...c, ...changes } : c)));
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
                  <ComboRow key={combo.id} combo={combo} onPatch={patch} uid={uid}
                    onWorn={refresh} onRemix={handleRemix} onSend={setSending} />
                ))}
              </section>
            ) : null}

            <section className="stack">
              <h2 className="section-title">All outfits</h2>
              {rest.map((combo) => (
                <ComboRow key={combo.id} combo={combo} onPatch={patch} uid={uid}
                  onWorn={refresh} onRemix={handleRemix} onSend={setSending} />
              ))}
            </section>
          </>
        )}
      </main>

      {sending ? (
        <SendToSheet
          outfitName={sending.name}
          getBlob={async () => {
            if (!sending.compositePath) return null;
            const url = await resolveUrl(sending.compositePath);
            return (await fetch(url)).blob();
          }}
          onClose={() => setSending(null)}
        />
      ) : null}
    </>
  );
}

function ComboRow({ combo, onPatch, uid, onWorn, onRemix, onSend }) {
  const [thumb, setThumb] = useState(null);

  useEffect(() => {
    if (combo.compositePath) resolveUrl(combo.compositePath).then(setThumb).catch(() => {});
  }, [combo.compositePath]);

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
          {combo.wearCount ? `Worn ${combo.wearCount}×` : 'Not worn yet'}
          {combo.itemIds?.length ? ` · ${combo.itemIds.length} pieces` : ''}
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
        <button type="button" className="chip"
          onClick={() => wearCombo(uid, combo).then(onWorn)}>
          Worn
        </button>
        <button type="button" className="chip" onClick={() => onRemix?.(combo)}>
          Remix
        </button>
        <button type="button" className="chip" aria-label={`Send ${combo.name} to someone`}
          disabled={!combo.compositePath} onClick={() => onSend?.(combo)}>
          <IconSend width={14} height={14} />
        </button>
      </div>
    </article>
  );
}
