import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { uploadAvatar } from '../lib/closet';
import { inspectImage } from '../lib/images';
import ColourQuiz from '../components/ColourQuiz';

/**
 * First-run setup: the master avatar photo, then a short colour quiz.
 *
 * The avatar is permanent. Every garment layer this user ever generates is
 * aligned to this exact pose and framing, so the guidance here is blunt about
 * getting it right the first time.
 */
export default function OnboardingScreen() {
  const { hasAvatar, refreshProfile } = useAuth();

  // Somebody who already has an avatar is here for the questions, not for the
  // photo. Starting them on the photo step was how a stored avatar got
  // overwritten by an identical one, and with it every garment layer.
  const [step, setStep] = useState(hasAvatar ? 'colors' : 'avatar');
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState([]);
  const [error, setError] = useState(null);

  async function handleAvatar(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    setError(null);
    setProblems([]);
    setBusy(true);

    try {
      const info = await inspectImage(file);
      if (info.tooSmall) {
        setProblems(['Photo is too small — use at least 512px on the short side.']);
        return;
      }

      await uploadAvatar(file);
      setStep('colors');
    } catch (caught) {
      if (caught.problems) setProblems(caught.problems);
      else setError(caught.message);
    } finally {
      setBusy(false);
      event.target.value = '';
    }
  }

  if (step === 'avatar') {
    return (
      <main className="app-shell" style={{ padding: 'var(--space-5)' }}>
        <div className="stack">
          <h1 style={{ margin: 0, color: 'var(--c-800)' }}>Let's set up your avatar</h1>
          <p className="muted" style={{ margin: 0 }}>
            This one photo becomes the template every outfit is built on, so it's
            worth getting right. You can't change it later without redoing your closet.
          </p>

          <div className="card stack">
            <strong>For the best results</strong>
            <ul className="muted" style={{ margin: 0, paddingLeft: '1.1rem' }}>
              <li>Full body in frame, head to feet</li>
              <li>Face the camera straight on, arms slightly away from your sides</li>
              <li>Bright, even light — near a window works well</li>
              <li>Plain background, fitted clothes</li>
            </ul>
          </div>

          {problems.length ? (
            <div className="error-banner" role="alert">
              <strong>Let's try another photo:</strong>
              <ul style={{ margin: '6px 0 0', paddingLeft: '1.1rem' }}>
                {problems.map((problem) => <li key={problem}>{problem}</li>)}
              </ul>
            </div>
          ) : null}

          {error ? <div className="error-banner" role="alert">{error}</div> : null}

          <label className="btn" style={{ position: 'relative' }}>
            {busy ? <span className="spinner" aria-hidden="true" /> : null}
            {busy ? 'Checking your photo…' : 'Choose a photo'}
            <input
              type="file"
              accept="image/*"
              onChange={handleAvatar}
              disabled={busy}
              className="sr-only"
            />
          </label>

          <label className="btn btn-secondary">
            Take one now
            <input
              type="file"
              accept="image/*"
              capture="user"
              onChange={handleAvatar}
              disabled={busy}
              className="sr-only"
            />
          </label>
        </div>
      </main>
    );
  }

  return (
    <main className="app-shell" style={{ padding: 'var(--space-5)' }}>
      <div className="stack">
        <h1 style={{ margin: 0, color: 'var(--c-800)' }}>A few quick colour questions</h1>
        <p className="muted" style={{ margin: 0 }}>
          This is how outfit suggestions know what actually flatters you. Takes ten
          seconds, and you can change it later from Profile.
        </p>

        <ColourQuiz submitLabel="Start building my closet" onSkip onDone={refreshProfile} />
      </div>
    </main>
  );
}
