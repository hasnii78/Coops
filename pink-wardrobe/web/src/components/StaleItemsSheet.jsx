import { useState } from 'react';

import { discardStaleItems, regenerateStaleItems } from '../lib/closet';

/**
 * Offered after the avatar changes, and reachable again from Settings if the
 * choice was deferred.
 *
 * Every layer is warped to one specific pose, so replacing the avatar leaves
 * them all misfitted. Doing nothing silently is the one option not on offer:
 * an outfit that stacks wrongly with no explanation is worse than being asked.
 */
export default function StaleItemsSheet({ count, onClose, onDone }) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);

  async function handleRegenerate() {
    setError(null);
    setBusy(true);

    try {
      const outcome = await regenerateStaleItems(setProgress);
      setResults(outcome);
      onDone?.();
    } catch (caught) {
      setError(caught.message);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  async function handleDiscard() {
    setError(null);
    setBusy(true);

    try {
      await discardStaleItems();
      onDone?.();
      onClose();
    } catch (caught) {
      setError(caught.message);
    } finally {
      setBusy(false);
    }
  }

  const failed = results?.filter((r) => !r.ok) ?? [];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Your clothes need updating"
      style={{
        position: 'fixed', inset: 0, zIndex: 50,
        background: 'color-mix(in srgb, var(--c-900) 55%, transparent)',
        display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
      }}
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
        <h2 style={{ margin: 0, fontSize: 'var(--text-lg)' }}>
          Your avatar changed
        </h2>

        <p className="muted" style={{ margin: 0 }}>
          {count === 1
            ? 'One piece was fitted to your old photo'
            : `${count} pieces were fitted to your old photo`}
          , so they will not sit correctly on the new one. What would you like to do?
        </p>

        {error ? <div className="error-banner" role="alert">{error}</div> : null}

        {results ? (
          <>
            <div className="card stack">
              <strong>
                {results.length - failed.length} of {results.length} updated
              </strong>
              {failed.length ? (
                <span className="muted">
                  Could not update: {failed.map((f) => f.name).join(', ')}. Try
                  again from Settings.
                </span>
              ) : (
                <span className="muted">Everything fits the new avatar now.</span>
              )}
            </div>
            <button type="button" className="btn" onClick={onClose}>Done</button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="btn"
              onClick={handleRegenerate}
              disabled={busy}
            >
              {busy && progress ? (
                <>
                  <span className="spinner" aria-hidden="true" />
                  {`Updating ${progress.done + 1} of ${progress.total}…`}
                </>
              ) : (
                'Regenerate all clothes'
              )}
            </button>

            {/* Stated plainly and before the tap, because it is the only
                choice here that spends money. */}
            <p className="muted" style={{ margin: 0, textAlign: 'center', fontSize: 'var(--text-xs)' }}>
              Uses {count} generation {count === 1 ? 'credit' : 'credits'} — one per piece.
              Takes about {Math.ceil((count * 20) / 60)} minute
              {Math.ceil((count * 20) / 60) === 1 ? '' : 's'}.
            </p>

            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleDiscard}
              disabled={busy}
            >
              Delete all clothes
            </button>
            <p className="muted" style={{ margin: 0, textAlign: 'center', fontSize: 'var(--text-xs)' }}>
              Moved to the recycle bin — restorable for 15 days.
            </p>

            <button
              type="button"
              className="btn btn-ghost"
              onClick={onClose}
              disabled={busy}
            >
              I'll do this later
            </button>
            <p className="muted" style={{ margin: 0, textAlign: 'center', fontSize: 'var(--text-xs)' }}>
              Your clothes stay, marked as needing an update. You can come back
              to this from Settings whenever you like.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
