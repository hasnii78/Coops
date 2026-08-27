import { useState } from 'react';

import { uploadAvatar } from '../lib/closet';
import { inspectImage } from '../lib/images';

/** Replace the master pose template from Settings. */
export default function ChangeAvatarSheet({ onClose, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState([]);
  const [error, setError] = useState(null);
  const [warning, setWarning] = useState(null);

  async function handleFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    setError(null);
    setProblems([]);
    setWarning(null);
    setBusy(true);

    try {
      const info = await inspectImage(file);
      if (info.tooSmall) {
        setProblems(['Photo is too small — use at least 512px on the short side.']);
        return;
      }

      const { baseColor, staleCount } = await uploadAvatar(file);

      // A patterned or unevenly lit base spreads the colour cluster, which
      // weakens every later subtraction. Worth saying now rather than after
      // twenty garments come out wrong.
      if (baseColor && !baseColor.plain) {
        setWarning(
          'What you are wearing looks patterned or unevenly lit. A plain, ' +
            'evenly lit garment separates clothes much more cleanly.',
        );
      }

      onChanged?.(staleCount);
      if (!baseColor || baseColor.plain) onClose();
    } catch (caught) {
      if (caught.problems) setProblems(caught.problems);
      else setError(caught.message);
    } finally {
      setBusy(false);
      event.target.value = '';
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Change your avatar"
      style={{
        position: 'fixed', inset: 0, zIndex: 45,
        background: 'color-mix(in srgb, var(--c-900) 50%, transparent)',
        display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
      }}
      onClick={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}
    >
      <div
        className="stack"
        style={{
          width: '100%', maxWidth: 560, background: 'var(--surface)',
          borderTopLeftRadius: 'var(--radius-lg)',
          borderTopRightRadius: 'var(--radius-lg)',
          padding: 'var(--space-5)', maxHeight: '88dvh', overflowY: 'auto',
        }}
      >
        <div className="row-between">
          <h2 style={{ margin: 0, fontSize: 'var(--text-lg)' }}>Change your avatar</h2>
          <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}
            style={{ minHeight: 36, padding: '0 12px', borderRadius: 'var(--radius-pill)' }}>
            Close
          </button>
        </div>

        <div className="card stack">
          <strong>Wear something plain and fitted</strong>
          <ul className="muted" style={{ margin: 0, paddingLeft: '1.1rem' }}>
            <li>One solid colour, no pattern or logo</li>
            <li>Close-fitting, so clothes sit correctly over it</li>
            <li>Green works best — furthest from skin tone</li>
            <li>Avoid black, white, grey, beige and denim: real clothes are those colours</li>
            <li>Full body, facing the camera, bright even light</li>
          </ul>
        </div>

        <div className="card stack">
          <span className="muted">
            Clothes already in your closet are fitted to your current photo.
            Changing it means they need updating — you will be asked what to do
            once the new photo is accepted.
          </span>
        </div>

        {problems.length ? (
          <div className="error-banner" role="alert">
            <strong>Let's try another photo:</strong>
            <ul style={{ margin: '6px 0 0', paddingLeft: '1.1rem' }}>
              {problems.map((problem) => <li key={problem}>{problem}</li>)}
            </ul>
          </div>
        ) : null}

        {warning ? <div className="error-banner" role="alert">{warning}</div> : null}
        {error ? <div className="error-banner" role="alert">{error}</div> : null}

        <label className="btn">
          {busy ? <span className="spinner" aria-hidden="true" /> : null}
          {busy ? 'Checking your photo…' : 'Choose a photo'}
          <input type="file" accept="image/*" onChange={handleFile} disabled={busy}
            className="sr-only" />
        </label>

        <label className="btn btn-secondary">
          Take one now
          <input type="file" accept="image/*" capture="user" onChange={handleFile}
            disabled={busy} className="sr-only" />
        </label>
      </div>
    </div>
  );
}
