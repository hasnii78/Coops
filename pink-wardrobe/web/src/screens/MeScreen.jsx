import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';

import EmptyState from '../components/EmptyState';
import { useAuth } from '../context/AuthContext';
import { CATEGORIES, CATEGORY_LABELS } from '../lib/constants';
import {
  findCachedComposite, listItems, saveCombo, saveComposite,
} from '../lib/closet';
import { signedUrl } from '../lib/storage';
import { canvasToBlob, comboHash, compositeToCanvas } from '../lib/compositor';

/**
 * The outfit builder — the primary screen.
 *
 * Selecting items paints an instant preview from saved layers. Generate runs
 * the same stack with seam blending and caches the result by item set, so
 * rebuilding a previously seen outfit is instant. Neither path costs a credit.
 */
export default function MeScreen() {
  const { profile } = useAuth();
  const location = useLocation();
  const canvasRef = useRef(null);

  const [items, setItems] = useState([]);
  const [avatarUrl, setAvatarUrl] = useState(null);
  const [selected, setSelected] = useState({});
  const [openCategory, setOpenCategory] = useState('tops');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listItems()
      .then((all) => {
        const ready = all.filter((item) => item.status === 'ready' && !item.retired);
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
      })
      .catch((caught) => setError(caught.message))
      .finally(() => setLoading(false));
  }, [location.state]);

  useEffect(() => {
    if (profile?.avatar_path) {
      signedUrl(profile.avatar_path).then(setAvatarUrl).catch(() => {});
    }
  }, [profile?.avatar_path]);

  const selectedItems = useMemo(() => Object.values(selected).filter(Boolean), [selected]);

  const paint = useCallback(
    async ({ blendSeams }) => {
      if (!avatarUrl || !canvasRef.current) return;

      const layers = await Promise.all(
        selectedItems.map(async (item) => ({
          category: item.category,
          url: await signedUrl(item.layer_path),
          nudge: item.nudge,
        })),
      );

      await compositeToCanvas(canvasRef.current, avatarUrl, layers, { blendSeams });
    },
    [avatarUrl, selectedItems],
  );

  // Instant, unblended preview on every selection change.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        if (!cancelled) await paint({ blendSeams: false });
      } catch (caught) {
        if (!cancelled) setError(caught.message);
      }
    })();

    return () => { cancelled = true; };
  }, [paint]);

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
    setBusy(true);

    try {
      const itemIds = selectedItems.map((item) => item.id);
      const hash = await comboHash(itemIds);

      const cached = await findCachedComposite(hash);
      if (cached) {
        const url = await signedUrl(cached);
        const image = await fetch(url).then((response) => response.blob());
        const bitmap = await createImageBitmap(image);
        const context = canvasRef.current.getContext('2d');
        canvasRef.current.width = bitmap.width;
        canvasRef.current.height = bitmap.height;
        context.drawImage(bitmap, 0, 0);
        return;
      }

      await paint({ blendSeams: true });

      const blob = await canvasToBlob(canvasRef.current);
      await saveComposite({ comboHash: hash, itemIds, blob });
    } catch (caught) {
      // The unblended preview is already on screen and accurate, so this is a
      // downgrade rather than a dead end.
      setError(caught.message || 'Could not refine the blend — the preview above is still accurate.');
    } finally {
      setBusy(false);
    }
  }

  async function handleSave() {
    const name = window.prompt('Name this outfit');
    if (!name) return;

    setError(null);

    try {
      const itemIds = selectedItems.map((item) => item.id);
      const hash = await comboHash(itemIds);

      let compositePath = await findCachedComposite(hash);

      if (!compositePath) {
        await paint({ blendSeams: true });
        const blob = await canvasToBlob(canvasRef.current);
        compositePath = await saveComposite({ comboHash: hash, itemIds, blob });
      }

      await saveCombo({ name, itemIds, compositePath });
    } catch (caught) {
      setError(caught.message);
    }
  }

  const byCategory = useMemo(() => {
    const map = {};
    for (const item of items) (map[item.category] ||= []).push(item);
    return map;
  }, [items]);

  if (loading) {
    return (
      <>
        <header className="app-header"><h1>Me</h1></header>
        <main className="app-main"><div className="empty-state"><span className="spinner" /></div></main>
      </>
    );
  }

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
      <header className="app-header"><h1>Me</h1></header>

      <main className="app-main stack">
        {error ? <div className="error-banner" role="alert">{error}</div> : null}

        <div className="builder-avatar">
          <canvas ref={canvasRef} aria-label="Outfit preview" />
        </div>

        {selectedItems.length ? (
          <div className="chip-row">
            {selectedItems.map((item) => (
              <button key={item.id} type="button" className="chip" aria-pressed="true"
                onClick={() => toggleItem(item)}>
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
          <button type="button" className="btn" style={{ flex: 1 }}
            onClick={handleGenerate} disabled={!selectedItems.length || busy}>
            {busy ? <span className="spinner" aria-hidden="true" /> : null}
            {busy ? 'Blending…' : 'Generate'}
          </button>
          <button type="button" className="btn btn-secondary"
            onClick={handleSave} disabled={!selectedItems.length || busy}>
            Save
          </button>
        </div>

        <div>
          {CATEGORIES.filter(({ id }) => byCategory[id]?.length).map(({ id, label }) => {
            const open = openCategory === id;
            const chosen = selected[id];

            return (
              <section className="accordion" key={id}>
                <button type="button" aria-expanded={open}
                  onClick={() => setOpenCategory(open ? null : id)}>
                  <span>{label}</span>
                  <span className="filled">
                    {chosen ? `✓ ${chosen.name}` : `${byCategory[id].length} items`}
                  </span>
                </button>

                {open ? (
                  <div className="accordion-body">
                    {byCategory[id].map((item) => (
                      <AccordionItem key={item.id} item={item}
                        selected={chosen?.id === item.id} onSelect={() => toggleItem(item)} />
                    ))}
                  </div>
                ) : null}
              </section>
            );
          })}
        </div>
      </main>
    </>
  );
}

function AccordionItem({ item, selected, onSelect }) {
  const [url, setUrl] = useState(null);

  useEffect(() => {
    signedUrl(item.layer_path || item.photo_path).then(setUrl).catch(() => {});
  }, [item.layer_path, item.photo_path]);

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
