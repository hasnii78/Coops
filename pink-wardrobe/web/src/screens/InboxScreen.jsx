import { useEffect, useRef, useState } from 'react';

import EmptyState from '../components/EmptyState';
import { IconSend } from '../components/Icons';
import { useAuth } from '../context/AuthContext';
import { findUserByUsername } from '../lib/usernameAuth';
import {
  openConversation, resolveSharedImage, sendText, subscribeToMessages,
} from '../lib/chat';

/** Real two-way chat, with outfits appearing inline as cards. */
export default function InboxScreen() {
  const { uid, profile } = useAuth();
  const [peer, setPeer] = useState(null);
  const [conversationId, setConversationId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [lookup, setLookup] = useState('');
  const [error, setError] = useState(null);
  const bottomRef = useRef(null);

  useEffect(() => {
    if (!conversationId) return undefined;
    return subscribeToMessages(conversationId, setMessages);
  }, [conversationId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  async function handleFind(event) {
    event.preventDefault();
    setError(null);

    const match = await findUserByUsername(lookup);
    if (!match) { setError('No one by that username.'); return; }
    if (match.uid === uid) { setError("That's you."); return; }

    setPeer(match);
    setConversationId(await openConversation(uid, match.uid));
  }

  async function handleSend(event) {
    event.preventDefault();
    if (!draft.trim() || !conversationId) return;

    const text = draft;
    setDraft('');
    await sendText(conversationId, uid, text);
  }

  if (!conversationId) {
    return (
      <>
        <header className="app-header"><h1>Inbox</h1></header>
        <main className="app-main stack">
          <form className="row" onSubmit={handleFind} style={{ gap: 'var(--space-2)' }}>
            <input
              className="input"
              value={lookup}
              onChange={(event) => setLookup(event.target.value)}
              placeholder="Find someone by username"
              autoCapitalize="none"
              autoCorrect="off"
            />
            <button className="btn" type="submit">Find</button>
          </form>

          {error ? <div className="error-banner" role="alert">{error}</div> : null}

          <EmptyState title="No conversation open">
            Search a username to start chatting. You can send outfits straight
            from the Me and Combos tabs.
          </EmptyState>
        </main>
      </>
    );
  }

  return (
    <>
      <header className="app-header">
        <h1>@{peer.username}</h1>
        <button type="button" className="btn-ghost"
          onClick={() => { setConversationId(null); setPeer(null); setMessages([]); }}
          style={{ minHeight: 36, padding: '0 12px', borderRadius: 'var(--radius-pill)' }}>
          Back
        </button>
      </header>

      <main className="app-main">
        <div className="chat-thread">
          {messages.map((message) => (
            <Bubble
              key={message.id}
              message={message}
              mine={message.senderId === uid}
              myName={profile?.displayName || profile?.username}
              theirName={peer.username}
            />
          ))}
          <div ref={bottomRef} />
        </div>

        <form className="chat-composer" onSubmit={handleSend}>
          <input
            className="input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Message"
            aria-label="Message"
          />
          <button className="btn" type="submit" aria-label="Send" disabled={!draft.trim()}
            style={{ padding: '0 18px' }}>
            <IconSend width={18} height={18} />
          </button>
        </form>
      </main>
    </>
  );
}

function Bubble({ message, mine, myName, theirName }) {
  const [image, setImage] = useState(null);

  useEffect(() => {
    if (message.type === 'outfit' && message.imagePath) {
      resolveSharedImage(message.imagePath).then(setImage).catch(() => {});
    }
  }, [message.type, message.imagePath]);

  return (
    <div className={`bubble ${mine ? 'mine' : 'theirs'}`}>
      <span className="sender">{mine ? myName : theirName}</span>

      {message.type === 'outfit' ? (
        <div className="stack" style={{ gap: 'var(--space-2)' }}>
          {image ? (
            <img src={image} alt={message.outfitName}
              style={{ width: '100%', borderRadius: 'var(--radius-md)', display: 'block' }} />
          ) : (
            <div style={{ aspectRatio: '3 / 4', borderRadius: 'var(--radius-md)', background: 'var(--c-50)' }} />
          )}
          <strong>{message.outfitName}</strong>
          {message.text ? <span>{message.text}</span> : null}
        </div>
      ) : (
        <span>{message.text}</span>
      )}
    </div>
  );
}
