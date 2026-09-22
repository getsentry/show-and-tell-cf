import type {ReactNode} from 'react';

import type {SessionUser} from '../../shared/api';
import {Avatar} from './Avatar';
import {SentrySymbol} from './SentrySymbol';
import {ThemeToggle} from './ThemeToggle';

export function AppFrame({
  user,
  section,
  children,
}: {
  user: SessionUser;
  section?: 'playlists' | 'screening';
  children: ReactNode;
}) {
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
        <span>made at Sentry</span>
      </footer>
    </div>
  );
}
