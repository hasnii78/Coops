import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';

import AvatarViewer from '../components/AvatarViewer';
import EmptyState from '../components/EmptyState';
import { useAuth } from '../context/AuthContext';
import { CATEGORIES, CATEGORY_LABELS } from '../lib/constants';
import {
  findCachedComposite, listItems, saveCombo, saveComposite,
} from '../lib/closet';
import { signedUrl } from '../lib/storage';
import { canvasToBlob, comboHash, compositeToCanvas } from '../lib/compositor';

const PINS_KEY = 'pw.accessory-pins';

/**
 * Whether each accessory sits over or under the clothes.
 *
 * Kept in browser storage rather than the database: it is a preference about
 * how an outfit is viewed, not a fact about the garment, and it needs no
 * migration to add. A device that cannot read it just gets the default.
 */
function readPins() {
  try {
    return JSON.parse(localStorage.getItem(PINS_KEY)) || {};
  } catch {
    return {};
  }
}

function writePins(pins) {
  try {
    localStorage.setItem(PINS_KEY, JSON.stringify(pins));
  } catch {
    // A full or blocked store costs the preference, not the outfit.
  }
}

/** Over the clothes unless told otherwise — the common case for jewellery. */
function pinFor(pins, id) {
  return pins[id] === 'under' ? 'under' : 'top';
}

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
  // A callback ref rather than useRef, so that the canvas arriving is a state
  // change the paint effect can depend on. With a plain ref, an avatar that
  // resolved while the loading spinner was still up would paint into nothing:
  // the effect had already run, and with no item selected nothing else would
  // ever change to run it again. The avatar then appeared only once a garment
  // was tapped, which is exactly how the bug showed up.
  const [canvas, setCanvas] = useState(null);

  const [items, setItems] = useState([]);
  const [avatarUrl, setAvatarUrl] = useState(null);

  // An ordered list, not a map by category: the order pieces were picked in is
  // the order they stack. Picking a swimsuit then jeans tucks the swimsuit in;
  // picking jeans then a shirt leaves the shirt out. Same two garments, and
  // only the sequence says which one the wearer meant.
  const [picked, setPicked] = useState([]);
  const [pins, setPins] = useState(readPins);
  const [openCategory, setOpenCategory] = useState('tops');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [staleCount, setStaleCount] = useState(0);

  useEffect(() => {
    listItems()
      .then((all) => {
        // A stale layer is fitted to a pose that no longer exists, so it
        // would stack visibly wrong. Excluded rather than shown misaligned.
        const usable = all.filter(
          (item) => item.status === 'ready' && !item.retired && !item.needs_regeneration,
        );
        setStaleCount(all.filter((item) => item.needs_regeneration && !item.retired).length);
        setItems(usable);

        // Arriving from Remix: preselect the outfit so swapping one piece
        // reuses the existing layers rather than rebuilding anything.
        const preselect = location.state?.preselectItemIds;
        if (preselect?.length) {
          // Saved outfits keep their stacking order, so a remixed outfit looks
          // the way it did when it was saved.
          setPicked(
            preselect
              .map((id) => usable.find((item) => item.id === id))
              .filter(Boolean),
          );
        }
      })
      .catch((caught) => setError(caught.message))
      .finally(() => setLoading(false));
  }, [location.state]);

  useEffect(() => {
    if (profile?.avatar_path) {
      signedUrl(profile.avatar_path)
        .then(setAvatarUrl)
        .catch(() => setError('Could not load your avatar. Check your connection and reopen this tab.'));
    }
  }, [profile?.avatar_path]);

  const selectedItems = picked;

  const chosenByCategory = useMemo(() => {
    const map = {};
    for (const item of picked) map[item.category] = item;
    return map;
  }, [picked]);

  const paint = useCallback(
    async ({ blendSeams }) => {
      if (!avatarUrl || !canvas) return;

      const layers = await Promise.all(
        selectedItems.map(async (item, index) => ({
          category: item.category,
          url: await signedUrl(item.layer_path),
          nudge: item.nudge,
          order: index,
          pin: item.category === 'accessories' ? pinFor(pins, item.id) : null,
        })),
      );

      await compositeToCanvas(canvas, avatarUrl, layers, { blendSeams });
    },
    [avatarUrl, selectedItems, canvas, pins],
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
    setPicked((prev) => {
      const same = prev.findIndex((chosen) => chosen.id === item.id);
      if (same !== -1) return prev.filter((_, index) => index !== same);

      // One item per category. A replacement takes the slot the old one held
      // rather than jumping to the end, so swapping a top does not silently
      // renumber the rest of the outfit.
      const slot = prev.findIndex((chosen) => chosen.category === item.category);
      if (slot !== -1) return prev.map((chosen, index) => (index === slot ? item : chosen));

      return [...prev, item];
    });
  }

  function togglePin(item) {
    setPins((prev) => {
      const next = { ...prev, [item.id]: pinFor(prev, item.id) === 'top' ? 'under' : 'top' };
      writePins(next);
      return next;
    });
  }

  async function handleGenerate() {
    if (!selectedItems.length) return;

    setError(null);
    setBusy(true);

    try {
      const itemIds = selectedItems.map((item) => item.id);
      const hash = await comboHash(itemIds, pins);

      const cached = await findCachedComposite(hash);
      if (cached) {
        const url = await signedUrl(cached);
        const image = await fetch(url).then((response) => response.blob());
        const bitmap = await createImageBitmap(image);
        const context = canvas.getContext('2d');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        context.drawImage(bitmap, 0, 0);
        return;
      }

      await paint({ blendSeams: true });

      const blob = await canvasToBlob(canvas);
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
      const hash = await comboHash(itemIds, pins);

      let compositePath = await findCachedComposite(hash);

      if (!compositePath) {
        await paint({ blendSeams: true });
        const blob = await canvasToBlob(canvas);
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

  // With no finished layers there is nothing to stack, but the avatar is still
  // worth showing: it is the master template every garment aligns to, and
  // seeing it is the only confirmation that the upload and pose lock worked.
  if (!items.length) {
    return (
      <>
        <header className="app-header"><h1>Me</h1></header>
        <main className="app-main stack">
          {error ? <div className="error-banner" role="alert">{error}</div> : null}

          {staleCount > 0 ? (
          <div className="error-banner" role="status">
            {staleCount === 1
              ? '1 piece is hidden because it was fitted to your previous avatar.'
              : `${staleCount} pieces are hidden because they were fitted to your previous avatar.`}
            {' '}Update them from Profile → Settings.
          </div>
        ) : null}

        {avatarUrl ? (
            <AvatarViewer>
              <img src={avatarUrl} alt="Your avatar" />
            </AvatarViewer>
          ) : (
            <div className="builder-avatar">
              <div className="empty-state"><span className="spinner" /></div>
            </div>
          )}

          <p className="muted" style={{ textAlign: 'center', margin: 0 }}>
            This is your avatar — every piece you add gets fitted to this exact pose.
          </p>

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

        {staleCount > 0 ? (
          <div className="error-banner" role="status">
            {staleCount === 1
              ? '1 piece is hidden because it was fitted to your previous avatar.'
              : `${staleCount} pieces are hidden because they were fitted to your previous avatar.`}
            {' '}Update them from Profile → Settings.
          </div>
        ) : null}

        <AvatarViewer>
          <canvas ref={setCanvas} aria-label="Outfit preview" />
        </AvatarViewer>

        {selectedItems.length ? (
          <div className="chip-row">
            {selectedItems.map((item, index) => {
              const accessory = item.category === 'accessories';

              return (
                <span className="chip-group" key={item.id}>
                  <button type="button" className="chip" aria-pressed="true"
                    onClick={() => toggleItem(item)}>
                    {accessory ? null : (
                      <span className="chip-badge" aria-label={`layer ${index + 1}`}>
                        {index + 1}
                      </span>
                    )}
                    {item.name} ×
                  </button>

                  {accessory ? (
                    <button type="button" className="chip chip-pin"
                      aria-label={`${item.name} sits ${pinFor(pins, item.id) === 'top' ? 'over' : 'under'} the clothes`}
                      onClick={() => togglePin(item)}>
                      {pinFor(pins, item.id) === 'top' ? 'over' : 'under'}
                    </button>
                  ) : null}
                </span>
              );
            })}
          </div>
        ) : (
          <p className="muted" style={{ textAlign: 'center', margin: 0 }}>
            Pick a piece from any category below to start building.
          </p>
        )}

        {selectedItems.length > 1 ? (
          <p className="muted" style={{ textAlign: 'center', margin: 0, fontSize: '0.85rem' }}>
            Numbers are the stacking order — 2 sits over 1. Tap a piece to remove it
            and pick it again to move it to the top.
          </p>
        ) : null}

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
            const chosen = chosenByCategory[id];

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
