import { useEffect, useMemo, useState } from 'react';

import { supabase } from '../supabase';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { THEMES, TEXT_SIZES } from '../lib/constants';
import { listItems, listRecycleBin, listStaleItems, restoreItem } from '../lib/closet';
import ChangeAvatarSheet from '../components/ChangeAvatarSheet';
import ColourQuiz from '../components/ColourQuiz';
import StaleItemsSheet from '../components/StaleItemsSheet';
import { signedUrl } from '../lib/storage';
import { costPerWear, findGaps } from '../lib/suggestions';
import { signOut } from '../lib/auth';

export default function ProfileScreen() {
  const { uid, profile, refreshProfile } = useAuth();
  const { theme, setTheme, textSize, setTextSize, darkMode, setDarkMode } = useTheme();

  const [items, setItems] = useState([]);
  const [bin, setBin] = useState([]);
  const [panel, setPanel] = useState(null);
  const [quizOpen, setQuizOpen] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState(null);
  const [avatarUrl, setAvatarUrl] = useState(null);
  const [changingAvatar, setChangingAvatar] = useState(false);
  const [staleCount, setStaleCount] = useState(0);
  const [showStale, setShowStale] = useState(false);

  const refreshStale = () => {
    listStaleItems().then((stale) => setStaleCount(stale.length)).catch(() => {});
  };

  useEffect(() => {
    listItems().then(setItems).catch((caught) => setError(caught.message));
    listRecycleBin().then(setBin).catch(() => {});
    refreshStale();
  }, []);

  useEffect(() => { setDisplayName(profile?.display_name || ''); }, [profile?.display_name]);

  useEffect(() => {
    if (profile?.avatar_path) {
      signedUrl(profile.avatar_path).then(setAvatarUrl).catch(() => {});
    }
  }, [profile?.avatar_path]);

  const stats = useMemo(() => {
    const active = items.filter((item) => !item.retired);
    const mostWorn = [...active].sort((a, b) => (b.wear_count || 0) - (a.wear_count || 0))[0];
    const neverWorn = active.filter((item) => !item.wear_count).length;

    const colorCounts = {};
    for (const item of active) {
      const name = item.color?.name;
      if (name) colorCounts[name] = (colorCounts[name] || 0) + 1;
    }
    const topColor = Object.entries(colorCounts).sort((a, b) => b[1] - a[1])[0]?.[0];

    return { mostWorn, neverWorn, topColor, total: active.length, gaps: findGaps(active) };
  }, [items]);

  async function saveDisplayName() {
    await supabase.from('profiles').update({ display_name: displayName.trim() }).eq('id', uid);
    await refreshProfile();
  }

  return (
    <>
      <header className="app-header"><h1>Profile</h1></header>
      <main className="app-main stack">
        {error ? <div className="error-banner" role="alert">{error}</div> : null}

        {staleCount > 0 ? (
          <div className="error-banner stack" role="status">
            <strong>
              {staleCount === 1
                ? '1 piece needs updating'
                : `${staleCount} pieces need updating`}
            </strong>
            <span style={{ fontSize: 'var(--text-sm)' }}>
              They were fitted to your previous avatar, so they will not stack
              correctly until they are regenerated.
            </span>
            <button type="button" className="btn" style={{ marginTop: 'var(--space-2)' }}
              onClick={() => setShowStale(true)}>
              Sort this out
            </button>
          </div>
        ) : null}

        <div className="card row" style={{ gap: 'var(--space-4)' }}>
          {avatarUrl ? (
            <img
              src={avatarUrl}
              alt="Your avatar"
              width={56}
              height={72}
              style={{
                objectFit: 'cover',
                borderRadius: 'var(--radius-md)',
                background: 'var(--c-50)',
              }}
            />
          ) : (
            <div
              style={{
                width: 56, height: 72,
                borderRadius: 'var(--radius-md)',
                background: 'var(--c-50)',
              }}
            />
          )}
          <div>
            <strong style={{ display: 'block', fontSize: 'var(--text-lg)' }}>
              {profile?.display_name || profile?.username}
            </strong>
            <span className="muted">@{profile?.username}</span>
          </div>
        </div>

        <section className="card stack">
          <h2 className="section-title">Closet stats</h2>
          <div className="row-between"><span>Pieces</span><strong>{stats.total}</strong></div>
          <div className="row-between"><span>Most worn</span><strong>{stats.mostWorn?.name || '—'}</strong></div>
          <div className="row-between"><span>Top colour</span><strong>{stats.topColor || '—'}</strong></div>
          <div className="row-between"><span>Never worn</span><strong>{stats.neverWorn}</strong></div>
          {stats.gaps.length ? (
            <div className="muted">Fill the gap: you have nothing in {stats.gaps.join(', ')}.</div>
          ) : null}
        </section>

        <section className="card stack">
          <h2 className="section-title">Cost per wear</h2>
          {items.filter((item) => Number(item.price)).length === 0 ? (
            <span className="muted">Add prices to your items to track this.</span>
          ) : (
            items
              .filter((item) => Number(item.price))
              .sort((a, b) => (costPerWear(b) || 0) - (costPerWear(a) || 0))
              .slice(0, 8)
              .map((item) => (
                <div key={item.id} className="row-between">
                  <span>{item.name}</span>
                  <strong>
                    {costPerWear(item)?.toFixed(2)}<span className="muted"> / wear</span>
                  </strong>
                </div>
              ))
          )}
        </section>

        <button type="button" className="card row-between"
          onClick={() => setChangingAvatar(true)} style={{ textAlign: 'left' }}>
          <strong>Change avatar</strong><span className="muted">›</span>
        </button>

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
                onBlur={saveDisplayName} />
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
            <span className="section-title">Colour profile</span>
            {quizOpen ? (
              <ColourQuiz
                initial={profile?.color_profile}
                submitLabel="Save my colours"
                onDone={() => setQuizOpen(false)}
              />
            ) : (
              <div className="row-between">
                <span className="muted">
                  {profile?.color_profile?.undertone
                    ? `${profile.color_profile.undertone} undertone`
                    : 'Not set — outfit suggestions are guessing'}
                </span>
                <button type="button" className="chip" onClick={() => setQuizOpen(true)}>
                  {profile?.color_profile?.undertone ? 'Change' : 'Answer'}
                </button>
              </div>
            )}

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
                    onClick={() => restoreItem(item.id).then(() =>
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

      {changingAvatar ? (
        <ChangeAvatarSheet
          onClose={() => setChangingAvatar(false)}
          onChanged={(count) => {
            setChangingAvatar(false);
            refreshProfile();
            if (count > 0) {
              setStaleCount(count);
              setShowStale(true);
            }
          }}
        />
      ) : null}

      {showStale && staleCount > 0 ? (
        <StaleItemsSheet
          count={staleCount}
          onClose={() => setShowStale(false)}
          onDone={() => {
            refreshStale();
            listItems().then(setItems).catch(() => {});
          }}
        />
      ) : null}
    </>
  );
}
