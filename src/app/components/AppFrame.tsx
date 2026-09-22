import {useState, type ReactNode} from 'react';

import type {SessionUser, SessionResponse} from '../../shared/api';
import {api, errorMessage, json} from '../api';
import {Avatar} from './Avatar';
import {SentrySymbol} from './SentrySymbol';
import {ThemeToggle} from './ThemeToggle';

export function AppFrame({
  user,
  section,
  children,
  onViewModeChange,
}: {
  user: SessionUser;
  section?: 'playlists' | 'screening';
  children: ReactNode;
  onViewModeChange?: (user: SessionUser) => void;
}) {
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function switchView() {
    if (switching) return;
    setSwitching(true);
    setError(null);
    try {
      const result = await api<SessionResponse>(
        '/session/view-mode',
        json('POST', {
          mode: user.role === 'admin' ? 'member' : 'admin',
        }),
      );
      onViewModeChange?.(result.user);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSwitching(false);
    }
  }
  return (
    <div className="appFrame">
      <header className="masthead">
        <a className="wordmark" href="/" aria-label="Sentry Show & Tell">
          <SentrySymbol />
          <strong>SHOW &amp; TELL</strong>
        </a>
        <nav aria-label="Primary navigation">
          <a href="/" className={section === 'playlists' ? 'active' : ''}>
            playlists
          </a>
          {section === 'screening' ? (
            <span className="active" aria-current="page">
              screening
            </span>
          ) : null}
        </nav>
        <div className="identityActions">
          <ThemeToggle />
          {user.actualRole === 'admin' && onViewModeChange ? (
            <div className="viewModeSwitch">
              <span>Viewing as {user.role === 'admin' ? 'admin' : 'user'}</span>
              <button
                className="textButton"
                disabled={switching}
                onClick={() => void switchView()}
              >
                {user.role === 'admin' ? 'Switch to user view' : 'Back to admin'}
              </button>
              {error ? <small role="alert">{error}</small> : null}
            </div>
          ) : null}
          <span
            className="identity"
            aria-label={`Signed in as ${user.displayName}, ${user.role}`}
          >
            <Avatar name={user.displayName} avatarUrl={user.avatarUrl} />
            <span className="identityCopy">
              <span>{user.displayName}</span>
              <small>{user.role}</small>
            </span>
          </span>
          <form method="post" action="/api/auth/logout">
            <button className="textButton" type="submit">
              Sign out
            </button>
          </form>
        </div>
      </header>
      {children}
      <footer className="siteFooter">
        <a className="footerWordmark" href="/">
          <SentrySymbol />
          <span>SHOW &amp; TELL</span>
        </a>
        <a className="juniorCredit" href="https://junior.sentry.dev/">
          <span>made by Junior</span>
          <img src="/junior-avatar.png" width={28} height={28} alt="" />
        </a>
      </footer>
    </div>
  );
}
