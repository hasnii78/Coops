import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';

import EmptyState from '../components/EmptyState';
import SendToSheet from '../components/SendToSheet';
import { IconSend } from '../components/Icons';
import { useAuth } from '../context/AuthContext';
import { CATEGORIES, CATEGORY_LABELS } from '../lib/constants';
import { listItems, requestBlendedComposite, resolveUrl, saveCombo } from '../lib/closet';
import { compositeToCanvas, canvasToBlob } from '../lib/compositor';

/**
 * The outfit builder — the primary screen.
 *
 * Selecting items paints an instant Canvas preview from saved layers (free,
 * sub-second). Pressing Generate additionally requests the server-blended
 * version, which swaps in when ready. Neither path costs an AI credit.
 */
export default function MeScreen() {
  const { uid, profile } = useAuth();
  const location = useLocation();
  const canvasRef = useRef(null);

  const [items, setItems] = useState([]);
  const [avatarUrl, setAvatarUrl] = useState(null);
  const [selected, setSelected] = useState({});
  const [openCategory, setOpenCategory] = useState('tops');
  const [blending, setBlending] = useState(false);
  const [blendedUrl, setBlendedUrl] = useState(null);
  const [error, setError] = useState(null);
  const [sendOpen, setSendOpen] = useState(false);

  useEffect(() => {
    if (!uid) return;
    listItems(uid).then((next) => {
      const ready = next.filter((item) => item.status === 'ready' && !item.retired);
      setItems(ready);

      // Arriving from Remix: preselect the outfit so swapping one piece
      // reuses the existing layers rather than rebuilding anything.
      const preselect = location.state?.preselectItemIds;
      if (preselect?.length) {
        const chosen = {};
        for (const item of ready) {
          if (preselect.includes(item.id)) chosen[item.category] = item;
        }
        setSelected(chosen);
      }
    });
  }, [uid, location.state]);

  useEffect(() => {
    if (profile?.avatar?.storagePath) {
      resolveUrl(profile.avatar.storagePath).then(setAvatarUrl).catch(() => {});
    }
  }, [profile?.avatar?.storagePath]);

  const selectedItems = useMemo(
    () => Object.values(selected).filter(Boolean),
    [selected],
  );

  // Repaint the instant preview whenever the selection changes.
  useEffect(() => {
    if (!avatarUrl || !canvasRef.current) return;

    // A new selection invalidates any previously blended render.
    setBlendedUrl(null);

    let cancelled = false;

    (async () => {
      const layers = await Promise.all(
        selectedItems.map(async (item) => ({
          category: item.category,
          url: await resolveUrl(item.layerPath),
          nudge: item.nudge,
        })),
      );

      if (cancelled) return;

      try {
        await compositeToCanvas(canvasRef.current, avatarUrl, layers);
      } catch (caught) {
        if (!cancelled) setError(caught.message);
      }
    })();

    return () => { cancelled = true; };
  }, [avatarUrl, selectedItems]);

  function toggleItem(item) {
    setSelected((prev) => {
      const next = { ...prev };
      // One item per category — picking a second top replaces the first.
      if (next[item.category]?.id === item.id) delete next[item.category];
      else next[item.category] = item;
      return next;
    });
  }

  async function handleGenerate() {
    if (!selectedItems.length) return;

    setError(null);
    setBlending(true);

    try {
      const { compositePath } = await requestBlendedComposite(
        selectedItems.map((item) => item.id),
      );
      setBlendedUrl(await resolveUrl(compositePath));
    } catch (caught) {
      // The Canvas preview is already on screen and perfectly usable, so a
      // blending failure is a downgrade, not a dead end.
      setError(caught.message || 'Could not refine the blend — the preview above is still accurate.');
    } finally {
      setBlending(false);
    }
  }

  async function handleSave() {
    const name = window.prompt('Name this outfit');
    if (!name) return;

    await saveCombo(uid, {
      name,
      itemIds: selectedItems.map((item) => item.id),
      compositePath: null,
    });
  }

  const byCategory = useMemo(() => {
    const map = {};
    for (const item of items) {
      (map[item.category] ||= []).push(item);
    }
    return map;
  }, [items]);

  if (!items.length) {
    return (
      <>
        <header className="app-header"><h1>Me</h1></header>
        <main className="app-main">
          <EmptyState title="Nothing to try on yet">
            Add a few pieces to your closet first. Once each one has its layer,
            you can mix them here as many times as you like for free.
          </EmptyState>
        </main>
      </>
    );
  }

  return (
    <>
      <header className="app-header">
        <h1>Me</h1>
        <button
          type="button"
          className="btn-ghost"
          onClick={() => setSendOpen(true)}
          disabled={!selectedItems.length}
          aria-label="Send this outfit to someone"
          style={{ minHeight: 40, padding: '0 12px', borderRadius: 'var(--radius-pill)' }}
        >
          <IconSend width={20} height={20} />
        </button>
      </header>

      <main className="app-main stack">
        {error ? <div className="error-banner" role="alert">{error}</div> : null}

        <div className="builder-avatar">
          {blendedUrl ? (
            <img src={blendedUrl} alt="Your outfit, blended" />
          ) : (
            <canvas ref={canvasRef} aria-label="Outfit preview" />
          )}
        </div>

        {selectedItems.length ? (
          <div className="chip-row">
            {selectedItems.map((item) => (
              <button
                key={item.id}
                type="button"
                className="chip"
                aria-pressed="true"
                onClick={() => toggleItem(item)}
              >
                {item.name} ×
              </button>
            ))}
          </div>
        ) : (
          <p className="muted" style={{ textAlign: 'center', margin: 0 }}>
            Pick a piece from any category below to start building.
          </p>
        )}

        <div className="row" style={{ gap: 'var(--space-2)' }}>
          <button
            type="button"
            className="btn"
            style={{ flex: 1 }}
            onClick={handleGenerate}
            disabled={!selectedItems.length || blending}
          >
            {blending ? <span className="spinner" aria-hidden="true" /> : null}
            {blending ? 'Blending…' : 'Generate'}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={handleSave}
            disabled={!selectedItems.length}
          >
            Save
          </button>
        </div>

        <div>
          {CATEGORIES.filter(({ id }) => byCategory[id]?.length).map(({ id, label }) => {
            const open = openCategory === id;
            const chosen = selected[id];

            return (
              <section className="accordion" key={id}>
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => setOpenCategory(open ? null : id)}
                >
                  <span>{label}</span>
                  <span className="filled">
                    {chosen ? `✓ ${chosen.name}` : `${byCategory[id].length} items`}
                  </span>
                </button>

                {open ? (
                  <div className="accordion-body">
                    {byCategory[id].map((item) => (
                      <AccordionItem
                        key={item.id}
                        item={item}
                        selected={chosen?.id === item.id}
                        onSelect={() => toggleItem(item)}
                      />
                    ))}
                  </div>
                ) : null}
              </section>
            );
          })}
        </div>
      </main>

      {sendOpen ? (
        <SendToSheet
          outfitName={selectedItems.map((item) => item.name).join(' + ')}
          getBlob={async () => (canvasRef.current ? canvasToBlob(canvasRef.current) : null)}
          onClose={() => setSendOpen(false)}
        />
      ) : null}
    </>
  );
}

function AccordionItem({ item, selected, onSelect }) {
  const [url, setUrl] = useState(null);

  useEffect(() => {
    resolveUrl(item.layerPath || item.photoPath).then(setUrl).catch(() => {});
  }, [item.layerPath, item.photoPath]);

  return (
    <button type="button" aria-pressed={selected} onClick={onSelect}>
      {url ? <img src={url} alt="" loading="lazy" /> : <div style={{ width: 36, height: 46 }} />}
      <span>{item.name}</span>
      <span className="muted" style={{ marginLeft: 'auto' }}>
        {CATEGORY_LABELS[item.category]}
      </span>
    </button>
  );
}
