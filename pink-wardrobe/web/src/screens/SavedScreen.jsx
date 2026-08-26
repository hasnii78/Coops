import { useEffect, useState } from 'react';

import EmptyState from '../components/EmptyState';
import ItemTile from '../components/ItemTile';
import { listCombos, listWishlist } from '../lib/closet';

/** Two tabs: saved looks, and a wishlist of items not yet owned. */
export default function SavedScreen() {
  const [tab, setTab] = useState('looks');
  const [combos, setCombos] = useState([]);
  const [wishlist, setWishlist] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    listCombos()
      .then((all) => setCombos(all.filter((combo) => combo.liked)))
      .catch((caught) => setError(caught.message));

    listWishlist().then(setWishlist).catch(() => {});
  }, []);

  return (
    <>
      <header className="app-header"><h1>Saved</h1></header>
      <main className="app-main stack">
        {error ? <div className="error-banner" role="alert">{error}</div> : null}

        <div className="chip-row" role="tablist">
          <button type="button" className="chip" role="tab"
            aria-selected={tab === 'looks'} aria-pressed={tab === 'looks'}
            onClick={() => setTab('looks')}>
            Saved looks
          </button>
          <button type="button" className="chip" role="tab"
            aria-selected={tab === 'wishlist'} aria-pressed={tab === 'wishlist'}
            onClick={() => setTab('wishlist')}>
            Wishlist
          </button>
        </div>

        {tab === 'looks' ? (
          combos.length ? (
            <div className="stack">
              {combos.map((combo) => (
                <article key={combo.id} className="card">
                  <strong>{combo.name}</strong>
                  <div className="muted">{combo.item_ids?.length || 0} pieces</div>
                </article>
              ))}
            </div>
          ) : (
            <EmptyState title="No saved looks yet">
              Like an outfit on the Combos tab and it will appear here.
            </EmptyState>
          )
        ) : wishlist.length ? (
          <div className="closet-grid">
            {wishlist.map((item) => <ItemTile key={item.id} item={item} />)}
          </div>
        ) : (
          <EmptyState title="Your wishlist is empty">
            Add something you don't own yet to see it on your avatar before you buy.
            It runs the same one-time generation as anything else.
          </EmptyState>
        )}
      </main>
    </>
  );
}
