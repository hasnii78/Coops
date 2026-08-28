import { useState } from 'react';

import { useAuth } from '../context/AuthContext';
import { supabase } from '../supabase';

const UNDERTONES = [
  { id: 'warm', label: 'Warm', hint: 'Veins look green; gold suits you' },
  { id: 'cool', label: 'Cool', hint: 'Veins look blue; silver suits you' },
  { id: 'neutral', label: 'Neutral', hint: 'A bit of both' },
];

/**
 * The colour questions behind outfit suggestions.
 *
 * Shared between first-run setup and Profile, because answering it must be
 * possible later. It used to be reachable only during onboarding, and since
 * onboarding began by asking for the avatar photo again, the only route back to
 * it was re-uploading an avatar that already existed — which invalidated every
 * garment layer and asked for money to rebuild them.
 */
export default function ColourQuiz({ initial, submitLabel, onDone, onSkip }) {
  const { uid, refreshProfile } = useAuth();

  const [quiz, setQuiz] = useState({
    undertone: initial?.undertone || '',
    hairColor: initial?.hairColor || '',
    eyeColor: initial?.eyeColor || '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function save(colorProfile) {
    setError(null);
    setBusy(true);

    try {
      const { error: failed } = await supabase
        .from('profiles')
        .update({ color_profile: colorProfile, onboarded: true })
        .eq('id', uid);

      // Checked rather than assumed. Unchecked, a failure here left `onboarded`
      // false while the screen moved on, and the app bounced straight back to
      // setup on the next launch — every launch.
      if (failed) throw failed;

      await refreshProfile();
      onDone?.();
    } catch (caught) {
      setError(caught.message || 'Could not save your answers.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <div className="stack">
        <span className="section-title">Skin undertone</span>
        {UNDERTONES.map(({ id, label, hint }) => (
          <button
            key={id}
            type="button"
            className="card row-between"
            aria-pressed={quiz.undertone === id}
            onClick={() => setQuiz((prev) => ({ ...prev, undertone: id }))}
            style={{
              textAlign: 'left',
              borderColor: quiz.undertone === id ? 'var(--c-400)' : 'var(--line)',
            }}
          >
            <span><strong>{label}</strong><br /><span className="muted">{hint}</span></span>
          </button>
        ))}
      </div>

      <label className="stack" style={{ gap: 'var(--space-1)' }}>
        <span className="section-title">Hair colour</span>
        <input
          className="input"
          value={quiz.hairColor}
          onChange={(event) => setQuiz((prev) => ({ ...prev, hairColor: event.target.value }))}
          placeholder="blonde, brown, black…"
        />
      </label>

      <label className="stack" style={{ gap: 'var(--space-1)' }}>
        <span className="section-title">Eye colour</span>
        <input
          className="input"
          value={quiz.eyeColor}
          onChange={(event) => setQuiz((prev) => ({ ...prev, eyeColor: event.target.value }))}
          placeholder="brown, blue, green…"
        />
      </label>

      {error ? <div className="error-banner" role="alert">{error}</div> : null}

      <button className="btn" type="button" disabled={!quiz.undertone || busy}
        onClick={() => save(quiz)}>
        {busy ? <span className="spinner" aria-hidden="true" /> : null}
        {submitLabel || 'Save'}
      </button>

      {onSkip ? (
        <button className="btn btn-secondary" type="button" disabled={busy}
          onClick={() => save(null)}>
          Skip for now
        </button>
      ) : null}
    </div>
  );
}
