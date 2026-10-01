// If a page hits a bug while drawing, show a way out instead of a blank screen.
// Nothing is lost: everything is saved on the server as soon as it's entered.

import React from 'react';

class Boundary extends (React as any).Component {
  state: { error: Error | null } = { error: null };
  props!: { children: any; resetKey?: string };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: any) {
    console.error('Page error:', error, info?.componentStack);
  }
  componentDidUpdate(prev: { resetKey?: string }) {
    // moving to another page clears the error
    if (prev.resetKey !== this.props.resetKey && this.state.error) (this as any).setState({ error: null });
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="center-screen">
        <div className="error-box" role="alert">
          <p>
            <strong>This page ran into a problem and couldn't be shown.</strong>
          </p>
          <p className="muted">Your saved work is safe. Reloading usually fixes it; if it keeps happening, note what you clicked and tell Christin.</p>
          <p className="muted">
            <code>{String(this.state.error.message).slice(0, 200)}</code>
          </p>
          <button className="btn btn-primary" onClick={() => location.reload()}>
            Reload the page
          </button>
        </div>
      </div>
    );
  }
}

/** Typed wrapper (the class above is untyped because React's type package isn't available here). */
export const ErrorBoundary = Boundary as unknown as (props: { children: any; resetKey?: string }) => any;
