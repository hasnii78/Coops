import { useEffect, useMemo, useState } from 'react';
import { doc, updateDoc } from 'firebase/firestore';

import Logo from '../assets/Logo';
import { db } from '../firebase';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { THEMES, TEXT_SIZES } from '../lib/constants';
import { listItems, listRecycleBin, restoreItem } from '../lib/closet';
import { costPerWear, findGaps } from '../lib/suggestions';
import { signOut } from '../lib/usernameAuth';

export default function ProfileScreen() {
  const { uid, profile } = useAuth();
  const { theme, setTheme, textSize, setTextSize, darkMode, setDarkMode } = useTheme();

  const [items, setItems] = useState([]);
  const [bin, setBin] = useState([]);
  const [panel, setPanel] = useState(null);
  const [displayName, setDisplayName] = useState(profile?.displayName || '');

  useEffect(() => {
    if (!uid) return;
    listItems(uid).then(setItems);
    listRecycleBin(uid).then(setBin);
  }, [uid]);

  useEffect(() => { setDisplayName(profile?.displayName || ''); }, [profile?.displayName]);

  const stats = useMemo(() => {
    const active = items.filter((item) => !item.retired);
    const mostWorn = [...active].sort((a, b) => (b.wearCount || 0) - (a.wearCount || 0))[0];
    const neverWorn = active.filter((item) => !item.wearCount).length;

    const colorCounts = {};
    for (const item of active) {
      const name = item.color?.name;
      if (name) colorCounts[name] = (colorCounts[name] || 0) + 1;
    }
    const topColor = Object.entries(colorCounts).sort((a, b) => b[1] - a[1])[0]?.[0];

    return { mostWorn, neverWorn, topColor, total: active.length, gaps: findGaps(active) };
  }, [items]);

  return (
    <>
      <header className="app-header"><h1>Profile</h1></header>
      <main className="app-main stack">
        <div className="card row" style={{ gap: 'var(--space-4)' }}>
          <Logo size={56} />
          <div>
            <strong style={{ display: 'block', fontSize: 'var(--text-lg)' }}>
              {profile?.displayName || profile?.username}
            </strong>
            <span className="muted">@{profile?.username}</span>
          </div>
        </div>

        <section className="card stack">
          <h2 className="section-title">Closet stats</h2>
          <div className="row-between"><span>Pieces</span><strong>{stats.total}</strong></div>
          <div className="row-between">
            <span>Most worn</span>
            <strong>{stats.mostWorn?.name || '—'}</strong>
          </div>
          <div className="row-between">
            <span>Top colour</span><strong>{stats.topColor || '—'}</strong>
          </div>
          <div className="row-between">
            <span>Never worn</span><strong>{stats.neverWorn}</strong>
          </div>
          {stats.gaps.length ? (
            <div className="muted">
              Fill the gap: you have nothing in {stats.gaps.join(', ')}.
            </div>
          ) : null}
        </section>

        <section className="card stack">
          <h2 className="section-title">Cost per wear</h2>
          {items.filter((item) => item.price).length === 0 ? (
            <span className="muted">Add prices to your items to track this.</span>
          ) : (
            items
              .filter((item) => item.price)
              .sort((a, b) => (costPerWear(b) || 0) - (costPerWear(a) || 0))
              .slice(0, 8)
              .map((item) => (
                <div key={item.id} className="row-between">
                  <span>{item.name}</span>
                  <strong>
                    {costPerWear(item)?.toFixed(2)}
                    <span className="muted"> / wear</span>
                  </strong>
                </div>
              ))
          )}
        </section>

        <button type="button" className="card row-between"
          onClick={() => setPanel(panel === 'names' ? null : 'names')}
          aria-expanded={panel === 'names'} style={{ textAlign: 'left' }}>
          <strong>Names & text size</strong><span className="muted">›</span>
        </button>

        {panel === 'names' ? (
          <div className="card stack">
            <label className="stack" style={{ gap: 'var(--space-1)' }}>
              <span className="section-title">Display name</span>
              <input className="input" value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                onBlur={() => updateDoc(doc(db, 'users', uid), { displayName: displayName.trim() })} />
            </label>

            <span className="section-title">Text size</span>
            <div className="chip-row">
              {TEXT_SIZES.map(({ id, label, px }) => (
                <button key={id} type="button" className="chip"
                  aria-pressed={textSize === id} onClick={() => setTextSize(id)}>
                  {label} ({px}px)
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <button type="button" className="card row-between"
          onClick={() => setPanel(panel === 'settings' ? null : 'settings')}
          aria-expanded={panel === 'settings'} style={{ textAlign: 'left' }}>
          <strong>Settings</strong><span className="muted">›</span>
        </button>

        {panel === 'settings' ? (
          <div className="card stack">
            <span className="section-title">Colour theme</span>
            <div className="row" style={{ gap: 'var(--space-3)' }}>
              {THEMES.map(({ id, label, swatch }) => (
                <button key={id} type="button" onClick={() => setTheme(id)}
                  aria-label={label} aria-pressed={theme === id}
                  style={{
                    width: 44, height: 44, borderRadius: '50%', background: swatch,
                    border: theme === id ? '3px solid var(--ink)' : '1px solid var(--line)',
                  }} />
              ))}
            </div>

            <div className="row-between">
              <span>Dark mode</span>
              <button type="button" className="chip" aria-pressed={darkMode}
                onClick={() => setDarkMode(!darkMode)}>
                {darkMode ? 'On' : 'Off'}
              </button>
            </div>

            <span className="section-title">Recycle bin</span>
            {bin.length === 0 ? (
              <span className="muted">Nothing deleted. Items stay here 15 days.</span>
            ) : (
              bin.map((item) => (
                <div key={item.id} className="row-between">
                  <span>{item.name}</span>
                  <button type="button" className="chip"
                    onClick={() => restoreItem(uid, item.id).then(() =>
                      setBin((prev) => prev.filter((b) => b.id !== item.id)))}>
                    Restore
                  </button>
                </div>
              ))
            )}
          </div>
        ) : null}

        <button type="button" className="btn btn-ghost" onClick={signOut}>Log out</button>
      </main>
    </>
  );
}
