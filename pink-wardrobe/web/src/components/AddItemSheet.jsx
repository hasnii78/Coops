import { useState } from 'react';

import { addItem, addItemsBulk } from '../lib/closet';
import { CATEGORIES, GENERATION_BLOCKED, PLACEMENTS } from '../lib/constants';

/**
 * Add one or many garments.
 *
 * Both camera capture and gallery upload are offered, per the brief. Bulk
 * upload runs items through the pipeline one at a time — each costs a credit,
 * so progress is reported item by item and failures don't abort the batch.
 */
export default function AddItemSheet({ onClose, onAdded }) {
  const [files, setFiles] = useState([]);
  const [name, setName] = useState('');
  const [category, setCategory] = useState('tops');
  const [price, setPrice] = useState('');
  const [placement, setPlacement] = useState('neck');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState(null);

  const isBulk = files.length > 1;
  const catalogueOnly = GENERATION_BLOCKED.includes(category);

  // Small accessories are invisible to the segmenter at full-body scale, so it
  // is pointed at the right body part instead. Which part cannot be read off a
  // product photo — a chain could be a necklace, a bracelet or an anklet — so
  // it is asked once, here.
  const needsPlacement = category === 'accessories';

  async function handleSubmit(event) {
    event.preventDefault();
    if (!files.length) { setError('Choose at least one photo.'); return; }

    setError(null);
    setBusy(true);

    try {
      if (isBulk) {
        const entries = files.map((file, index) => ({
          file,
          name: `${name.trim() || 'Item'} ${index + 1}`,
          category,
          price,
          placement: needsPlacement ? placement : null,
          generate: false,
        }));

        const results = await addItemsBulk(entries, (done, total) =>
          setProgress({ done, total }));

        const failed = results.filter((result) => !result.ok);
        if (failed.length) {
          setError(`${failed.length} of ${results.length} items couldn't be processed. They're saved — try again from the closet.`);
          onAdded?.();
          return;
        }
      } else {
        await addItem({
          file: files[0], name, category, price,
          placement: needsPlacement ? placement : null,
          generate: false,
        });
      }

      onAdded?.();
      onClose();
    } catch (caught) {
      setError(caught.message);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Add a clothing item"
      style={{
        position: 'fixed', inset: 0, zIndex: 40,
        background: 'color-mix(in srgb, var(--c-900) 45%, transparent)',
        display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
      }}
      onClick={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}
    >
      <form
        className="stack"
        onSubmit={handleSubmit}
        style={{
          width: '100%', maxWidth: 560,
          background: 'var(--surface)',
          borderTopLeftRadius: 'var(--radius-lg)',
          borderTopRightRadius: 'var(--radius-lg)',
          padding: 'var(--space-5)',
          maxHeight: '88dvh', overflowY: 'auto',
        }}
      >
        <div className="row-between">
          <h2 style={{ margin: 0, fontSize: 'var(--text-lg)' }}>Add to your closet</h2>
          <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}
            style={{ minHeight: 36, padding: '0 12px', borderRadius: 'var(--radius-pill)' }}>
            Close
          </button>
        </div>

        {error ? <div className="error-banner" role="alert">{error}</div> : null}

        <div className="row" style={{ gap: 'var(--space-2)' }}>
          <label className="btn btn-secondary" style={{ flex: 1 }}>
            Take a photo
            <input type="file" accept="image/*" capture="environment" className="sr-only"
              onChange={(event) => setFiles(Array.from(event.target.files || []))} />
          </label>
          <label className="btn btn-secondary" style={{ flex: 1 }}>
            From gallery
            <input type="file" accept="image/*" multiple className="sr-only"
              onChange={(event) => setFiles(Array.from(event.target.files || []))} />
          </label>
        </div>

        {files.length ? (
          <div className="muted">
            {files.length === 1 ? files[0].name : `${files.length} photos selected`}
          </div>
        ) : null}

        <label className="stack" style={{ gap: 'var(--space-1)' }}>
          <span className="section-title">{isBulk ? 'Name prefix' : 'Name'}</span>
          <input className="input" value={name} onChange={(event) => setName(event.target.value)}
            placeholder={isBulk ? 'Summer top' : 'Black linen shirt'} />
        </label>

        <label className="stack" style={{ gap: 'var(--space-1)' }}>
          <span className="section-title">Category</span>
          <select className="input" value={category}
            onChange={(event) => setCategory(event.target.value)}>
            {CATEGORIES.map(({ id, label }) => (
              <option key={id} value={id}>{label}</option>
            ))}
          </select>
        </label>

        {catalogueOnly ? (
          <div className="muted">
            Undergarments are saved to your closet for tracking, but aren't
            generated onto your avatar.
          </div>
        ) : null}

        {needsPlacement ? (
          <label className="stack" style={{ gap: 'var(--space-1)' }}>
            <span className="section-title">Where does it go?</span>
            <select className="input" value={placement}
              onChange={(event) => setPlacement(event.target.value)}>
              {PLACEMENTS.map(({ id, label }) => (
                <option key={id} value={id}>{label}</option>
              ))}
            </select>
            <span className="muted" style={{ fontSize: 'var(--text-xs)' }}>
              Something this small is only a few pixels on a full-body photo.
              Knowing where it sits lets the app look at just that part of you,
              close up, which is the difference between finding it and not.
            </span>
          </label>
        ) : null}

        <label className="stack" style={{ gap: 'var(--space-1)' }}>
          <span className="section-title">Price (optional)</span>
          <input className="input" type="number" inputMode="decimal" min="0" value={price}
            onChange={(event) => setPrice(event.target.value)} placeholder="For cost-per-wear" />
        </label>

        <button className="btn" type="submit" disabled={busy || !files.length}>
          {busy ? <span className="spinner" aria-hidden="true" /> : null}
          {busy
            ? progress
              ? `Processing ${progress.done} of ${progress.total}…`
              : 'Creating your layer…'
            : `Add ${files.length > 1 ? `${files.length} items` : 'item'}`}
        </button>

        {busy && !catalogueOnly ? (
          <p className="muted" style={{ margin: 0, textAlign: 'center' }}>
            This takes 10–25 seconds per item. It only ever happens once —
            after this, wearing it costs nothing.
          </p>
        ) : null}
      </form>
    </div>
  );
}
