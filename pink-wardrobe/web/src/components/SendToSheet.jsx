import { useState } from 'react';

import { useAuth } from '../context/AuthContext';
import { findUserByUsername } from '../lib/usernameAuth';
import { openConversation, sendOutfit } from '../lib/chat';

/** Find another user by username and send them the current outfit. */
export default function SendToSheet({ outfitName, getBlob, onClose }) {
  const { uid } = useAuth();
  const [username, setUsername] = useState('');
  const [message, setMessage] = useState('');
  const [found, setFound] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  async function handleSearch(event) {
    event.preventDefault();
    setError(null);
    setFound(null);

    const match = await findUserByUsername(username);

    if (!match) { setError('No one by that username.'); return; }
    if (match.uid === uid) { setError("That's you."); return; }

    setFound(match);
  }

  async function handleSend() {
    setBusy(true);
    setError(null);

    try {
      const blob = await getBlob();
      if (!blob) throw new Error('Could not capture the outfit image.');

      const conversationId = await openConversation(uid, found.uid);
      await sendOutfit(conversationId, uid, { blob, outfitName, message });

      setSent(true);
      setTimeout(onClose, 1200);
    } catch (caught) {
      setError(caught.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Send outfit"
      style={{
        position: 'fixed', inset: 0, zIndex: 40,
        background: 'color-mix(in srgb, var(--c-900) 45%, transparent)',
        display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
      }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div
        className="stack"
        style={{
          width: '100%', maxWidth: 560, background: 'var(--surface)',
          borderTopLeftRadius: 'var(--radius-lg)', borderTopRightRadius: 'var(--radius-lg)',
          padding: 'var(--space-5)',
        }}
      >
        <div className="row-between">
          <h2 style={{ margin: 0, fontSize: 'var(--text-lg)' }}>Send to…</h2>
          <button type="button" className="btn-ghost" onClick={onClose}
            style={{ minHeight: 36, padding: '0 12px', borderRadius: 'var(--radius-pill)' }}>
            Close
          </button>
        </div>

        {sent ? (
          <p style={{ margin: 0 }}>Sent to {found.username}.</p>
        ) : (
          <>
            {error ? <div className="error-banner" role="alert">{error}</div> : null}

            <form className="row" onSubmit={handleSearch} style={{ gap: 'var(--space-2)' }}>
              <input
                className="input"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="their username"
                autoCapitalize="none"
                autoCorrect="off"
              />
              <button className="btn btn-secondary" type="submit">Find</button>
            </form>

            {found ? (
              <>
                <div className="card row-between">
                  <strong>@{found.username}</strong>
                </div>
                <input
                  className="input"
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  placeholder="Add a message (optional)"
                />
                <button className="btn" type="button" onClick={handleSend} disabled={busy}>
                  {busy ? <span className="spinner" aria-hidden="true" /> : null}
                  Send outfit
                </button>
              </>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
