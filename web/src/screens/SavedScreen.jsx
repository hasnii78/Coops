import { useEffect, useState } from 'react';

import EmptyState from '../components/EmptyState';
import ItemTile from '../components/ItemTile';
import { useAuth } from '../context/AuthContext';
import { listCombos, listItems } from '../lib/closet';

/** Two tabs: saved looks, and a wishlist of items not yet owned. */
export default function SavedScreen() {
  const { uid } = useAuth();
  const [tab, setTab] = useState('looks');
  const [combos, setCombos] = useState([]);
  const [wishlist, setWishlist] = useState([]);

  useEffect(() => {
    if (!uid) return;
    listCombos(uid).then((next) => setCombos(next.filter((combo) => combo.liked)));
    listItems(uid).then((next) => setWishlist(next.filter((item) => item.wishlist)));
  }, [uid]);

  return (
    <>
      <header className="app-header"><h1>Saved</h1></header>
      <main className="app-main stack">
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
                  <div className="muted">{combo.itemIds?.length || 0} pieces</div>
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
