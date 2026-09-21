import {useEffect, useState} from 'react';
import type {SessionUser} from '../shared/api';
import {isJsonObject, isJsonString, type JsonInput} from '../shared/json';

export function App() {
  const [user, setUser] = useState<SessionUser | null | undefined>();
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/session', {signal: controller.signal})
      .then(async (response) => {
        if (!response.ok) return setUser(null);
        setUser(parseSession(await response.json()));
      })
      .catch((error) => {
        if (!(error instanceof DOMException && error.name === 'AbortError'))
          setUser(null);
      });
    return () => controller.abort();
  }, []);

  if (user === undefined)
    return (
      <main className="shell">
        <p className="eyebrow">Loading Show &amp; Tell…</p>
      </main>
    );
  if (user === null)
    return (
      <main className="shell">
        <p className="eyebrow">Sentry internal</p>
        <h1>Show &amp; Tell</h1>
        <p className="lede">Sign in with your Sentry Google account to continue.</p>
        <a className="primaryAction" href="/api/auth/login">
          Continue with Google
        </a>
      </main>
    );
  return (
    <main className="shell">
      <p className="eyebrow">Sentry internal · {user.role}</p>
      <h1>Show &amp; Tell</h1>
      <p className="lede">
        Welcome, {user.displayName}. The next company playlist is getting ready.
      </p>
      <form method="post" action="/api/auth/logout">
        <button className="primaryAction" type="submit">
          Sign out
        </button>
      </form>
    </main>
  );
}

function parseSession(value: JsonInput): SessionUser | null {
  if (!isJsonObject(value) || !isJsonObject(value.user)) return null;
  const user = value.user;
  if (
    !isJsonString(user.id) ||
    !isJsonString(user.email) ||
    !isJsonString(user.displayName) ||
    (user.avatarUrl !== null && !isJsonString(user.avatarUrl)) ||
    (user.role !== 'member' && user.role !== 'admin')
  ) {
    return null;
  }
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    role: user.role,
  };
}
