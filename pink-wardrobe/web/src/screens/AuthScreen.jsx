import { useState } from 'react';

import Logo from '../assets/Logo';
import { signIn, signUp, validateUsername } from '../lib/usernameAuth';

/**
 * Username + password only. There is deliberately no email field anywhere —
 * the synthetic address used by Firebase Auth is an implementation detail the
 * user never sees.
 */
export default function AuthScreen() {
  const [mode, setMode] = useState('signin');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const isSignUp = mode === 'signup';

  async function handleSubmit(event) {
    event.preventDefault();
    setError(null);

    if (isSignUp) {
      const problem = validateUsername(username);
      if (problem) { setError(problem); return; }
    }

    setBusy(true);
    try {
      if (isSignUp) await signUp({ username, password });
      else await signIn({ username, password });
    } catch (caught) {
      setError(caught.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="app-shell" style={{ justifyContent: 'center', padding: 'var(--space-5)' }}>
      <div className="stack" style={{ alignItems: 'center', marginBottom: 'var(--space-6)' }}>
        <Logo size={88} />
        <h1 style={{ margin: 0, color: 'var(--c-800)', fontSize: 'var(--text-2xl)' }}>Pink Wardrobe</h1>
        <p className="muted" style={{ margin: 0, textAlign: 'center' }}>
          Your closet, on you, before you get dressed.
        </p>
      </div>

      <form className="stack" onSubmit={handleSubmit}>
        {error ? <div className="error-banner" role="alert">{error}</div> : null}

        <label className="stack" style={{ gap: 'var(--space-1)' }}>
          <span className="section-title">Username</span>
          <input
            className="input"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck="false"
            placeholder="yourname"
            required
          />
        </label>

        <label className="stack" style={{ gap: 'var(--space-1)' }}>
          <span className="section-title">Password</span>
          <input
            className="input"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete={isSignUp ? 'new-password' : 'current-password'}
            placeholder="••••••••"
            required
          />
        </label>

        <button className="btn" type="submit" disabled={busy}>
          {busy ? <span className="spinner" aria-hidden="true" /> : null}
          {isSignUp ? 'Create account' : 'Sign in'}
        </button>

        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => { setMode(isSignUp ? 'signin' : 'signup'); setError(null); }}
        >
          {isSignUp ? 'I already have an account' : 'Create an account'}
        </button>
      </form>
    </main>
  );
}
