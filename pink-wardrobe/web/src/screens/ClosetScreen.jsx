import { useCallback, useEffect, useMemo, useState } from 'react';

import EmptyState from '../components/EmptyState';
import ItemTile from '../components/ItemTile';
import AddItemSheet from '../components/AddItemSheet';
import ItemSheet from '../components/ItemSheet';
import { IconPlus, IconSearch } from '../components/Icons';
import { useAuth } from '../context/AuthContext';
import { CATEGORIES } from '../lib/constants';
import {
  listItems, restoreItem, retryItem, softDeleteItem, toggleLike, togglePin,
} from '../lib/closet';
import { staleItems, surpriseMe } from '../lib/suggestions';

export default function ClosetScreen() {
  const { profile } = useAuth();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [category, setCategory] = useState('all');
  const [search, setSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [surprise, setSurprise] = useState(null);
  const [error, setError] = useState(null);
  const [detail, setDetail] = useState(null);
  const [undo, setUndo] = useState(null);

  const refresh = useCallback(async () => {
    try {
      setItems(await listItems());
      setError(null);
    } catch (caught) {
      setError(caught.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();

    return items
      .filter((item) => !item.retired)
      .filter((item) => category === 'all' || item.category === category)
      .filter((item) => {
        if (!term) return true;
        return [item.name, item.color?.name, ...(item.tags || [])]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(term));
      });
  }, [items, category, search]);

  const stale = useMemo(() => staleItems(items), [items]);

  function handleSurprise() {
    setSurprise(surpriseMe(items, { colorProfile: profile?.color_profile }));
  }

  // The undo offer expires on its own, so a deletion the wearer meant to keep
  // does not leave a banner sitting there forever.
  useEffect(() => {
    if (!undo) return undefined;
    const timer = setTimeout(() => setUndo(null), 8000);
    return () => clearTimeout(timer);
  }, [undo]);

  async function handleDelete(item) {
    setDetail(null);
    setItems((prev) => prev.filter((current) => current.id !== item.id));

    try {
      await softDeleteItem(item.id);
      setUndo(item);
    } catch (caught) {
      setError(caught.message);
      await refresh();
    }
  }

  async function handleUndo() {
    const item = undo;
    setUndo(null);

    try {
      await restoreItem(item.id);
    } catch (caught) {
      setError(caught.message);
    } finally {
      await refresh();
    }
  }

  async function handleRetry(item) {
    try {
      await retryItem(item);
      await refresh();
    } catch (caught) {
      setError(caught.message);
    }
  }

  return (
    <>
      <header className="app-header">
        <h1>Closet</h1>
        <div className="row">
          <button
            type="button"
            className="btn-ghost"
            aria-label="Search closet"
            aria-expanded={searchOpen}
            onClick={() => setSearchOpen((open) => !open)}
            style={{ minHeight: 40, padding: '0 12px', borderRadius: 'var(--radius-pill)' }}
          >
            <IconSearch width={20} height={20} />
          </button>
          <button
            type="button"
            className="btn"
            style={{ minHeight: 40, padding: '0 16px' }}
            onClick={() => setAddOpen(true)}
          >
            <IconPlus width={18} height={18} /> Add
          </button>
        </div>
      </header>

      <main className="app-main stack">
        {error ? <div className="error-banner" role="alert">{error}</div> : null}

        {searchOpen ? (
          <input
            className="input"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by name, colour or tag"
            autoFocus
          />
        ) : null}

        <div className="chip-row" role="group" aria-label="Filter by category">
          <button type="button" className="chip" aria-pressed={category === 'all'}
            onClick={() => setCategory('all')}>
            All
          </button>
          {CATEGORIES.map(({ id, label }) => (
            <button key={id} type="button" className="chip" aria-pressed={category === id}
              onClick={() => setCategory(id)}>
              {label}
            </button>
          ))}
        </div>

        <div className="card row-between">
          <div>
            <strong>Surprise me</strong>
            <div className="muted">A whole outfit, picked for your colouring. Free.</div>
          </div>
          <button type="button" className="btn btn-secondary" onClick={handleSurprise}>
            Shuffle
          </button>
        </div>

        {surprise ? (
          <div className="card stack">
            <span className="section-title">Try this</span>
            <div>{surprise.items.map((item) => item.name).join(' + ')}</div>
            <div className="muted">Match score {Math.round(surprise.score * 100)}%</div>
          </div>
        ) : null}

        {stale.length ? (
          <div className="card stack">
            <span className="section-title">Haven't worn in a while</span>
            <div className="muted">
              {stale.slice(0, 3).map((item) => item.name).join(', ')}
              {stale.length > 3 ? ` and ${stale.length - 3} more` : ''}
            </div>
          </div>
        ) : null}

        {loading ? (
          <div className="empty-state"><span className="spinner" /></div>
        ) : visible.length === 0 ? (
          <EmptyState
            title={items.length ? 'Nothing matches' : 'Your closet is empty'}
            action={items.length ? null : (
              <button type="button" className="btn" onClick={() => setAddOpen(true)}>
                Add your first piece
              </button>
            )}
          >
            {items.length
              ? 'Try a different category or search term.'
              : 'Add a photo of something you own and it will be ready to wear on your avatar in about twenty seconds.'}
          </EmptyState>
        ) : (
          <div className="closet-grid">
            {visible.map((item) => (
              <ItemTile
                key={item.id}
                item={item}
                onToggleLike={async (target, liked) => {
                  setItems((prev) => prev.map((i) => (i.id === target.id ? { ...i, liked } : i)));
                  await toggleLike(target.id, liked);
                }}
                onTogglePin={async (target, pinned) => {
                  setItems((prev) => prev.map((i) => (i.id === target.id ? { ...i, pinned } : i)));
                  await togglePin(target.id, pinned);
                }}
                onRetry={handleRetry}
                onSelect={setDetail}
              />
            ))}
          </div>
        )}
      </main>

      {addOpen ? (
        <AddItemSheet onClose={() => setAddOpen(false)} onAdded={refresh} />
      ) : null}

      {detail ? (
        <ItemSheet item={detail} onClose={() => setDetail(null)} onDelete={handleDelete} />
      ) : null}

      {undo ? (
        <div className="undo-toast" role="status">
          <span>Moved {undo.name} to the recycle bin.</span>
          <button type="button" onClick={handleUndo}>Undo</button>
        </div>
      ) : null}
    </>
  );
}
