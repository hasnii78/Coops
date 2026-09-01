import { Component } from 'react';

/**
 * Renders a readable failure instead of a blank page.
 *
 * A React error during render unmounts the whole tree, leaving white. On a
 * phone there is no console to check, so a crash without a visible message is
 * indistinguishable from the app being broken beyond repair.
 */
export function ConfigScreen({ title, message, hint, actionLabel, onAction }) {
  return (
    <main
      className="app-shell"
      style={{ justifyContent: 'center', padding: 'var(--space-5)' }}
    >
      <div className="stack" style={{ textAlign: 'center' }}>
        <h1 style={{ margin: 0, color: 'var(--c-800)', fontSize: 'var(--text-xl)' }}>
          {title}
        </h1>

        <div className="error-banner" role="alert" style={{ textAlign: 'left' }}>
          <span style={{ wordBreak: 'break-word' }}>{message}</span>
        </div>

        {hint ? (
          <p className="muted" style={{ margin: 0, fontSize: 'var(--text-sm)' }}>
            {hint}
          </p>
        ) : null}

        <button type="button" className="btn" onClick={onAction ?? (() => window.location.reload())}>
          {actionLabel || 'Try again'}
        </button>
      </div>
    </main>
  );
}

export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Kept for anyone who does have a console open.
    console.error('Unhandled error:', error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <ConfigScreen
        title="Something went wrong"
        message={this.state.error.message || String(this.state.error)}
        hint="If this keeps happening, send this message on and it can be fixed."
      />
    );
  }
}
