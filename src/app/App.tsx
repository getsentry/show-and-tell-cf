import {useCallback, useEffect, useRef, useState, type FormEvent} from 'react';

import type {SessionUser} from '../shared/api';
import type {EventResponse, EventsResponse, ShowAndTellEvent} from '../shared/events';
import {isJsonObject, isJsonString, type JsonInput} from '../shared/json';

export function App() {
  const [user, setUser] = useState<SessionUser | null | undefined>();
  const authError = readAuthError();
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

  if (user === undefined) return <Loading />;
  if (user === null) return <SignIn authError={authError} />;
  return <ShowAndTell user={user} />;
}

function ShowAndTell({user}: {user: SessionUser}) {
  const [events, setEvents] = useState<ShowAndTellEvent[]>([]);
  const [eventsLoaded, setEventsLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<EventResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [eventsLoadFailed, setEventsLoadFailed] = useState(false);
  const [failedSelection, setFailedSelection] = useState<string | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  const eventsRequest = useRef(0);
  const eventsLoadFailedRef = useRef(false);
  const selectedRequests = useRef(new Map<string, number>());

  const selectEvent = useCallback((eventId: string | null) => {
    if (eventId !== selectedIdRef.current) {
      setFailedSelection(null);
      setError(null);
    }
    selectedIdRef.current = eventId;
    setSelectedId(eventId);
  }, []);
  const loadEvents = useCallback(async () => {
    const request = ++eventsRequest.current;
    try {
      const result = await api<EventsResponse>('/events');
      if (request !== eventsRequest.current) return;
      setEvents(result.events);
      if (!selectedIdRef.current) selectEvent(result.events[0]?.id ?? null);
      setEventsLoaded(true);
      setEventsLoadFailed(false);
      if (eventsLoadFailedRef.current) setError(null);
      eventsLoadFailedRef.current = false;
    } catch (cause) {
      if (request !== eventsRequest.current) return;
      eventsLoadFailedRef.current = true;
      setEventsLoadFailed(true);
      setError(cause instanceof Error ? cause.message : 'Request failed');
    }
  }, [selectEvent]);
  const loadSelected = useCallback(async (eventId: string) => {
    const request = (selectedRequests.current.get(eventId) ?? 0) + 1;
    selectedRequests.current.set(eventId, request);
    const result = await api<EventResponse>(`/events/${eventId}`);
    if (
      request === selectedRequests.current.get(eventId) &&
      eventId === selectedIdRef.current
    )
      setSelected(result);
  }, []);

  useEffect(() => {
    void loadEvents();
  }, [loadEvents]);
  const requestSelected = useCallback(
    async (eventId: string) => {
      if (eventId === selectedIdRef.current) {
        setFailedSelection(null);
        setError(null);
      }
      try {
        await loadSelected(eventId);
      } catch (cause) {
        if (eventId !== selectedIdRef.current) return;
        setFailedSelection(eventId);
        setError(cause instanceof Error ? cause.message : 'Request failed');
      }
    },
    [loadSelected],
  );
  useEffect(() => {
    if (!selectedId) {
      setSelected(null);
      return;
    }
    void requestSelected(selectedId);
  }, [requestSelected, selectedId]);

  function reportFailure(operation: Promise<void>) {
    setError(null);
    void operation.catch((cause: Error) => setError(cause.message));
  }

  async function createEvent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    await api(
      '/events',
      json('POST', {
        title: data.get('title'),
        description: data.get('description'),
      }),
    );
    form.reset();
    await loadEvents();
  }

  async function createSubmission(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedId) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    await api(
      `/events/${selectedId}/submissions`,
      json('POST', {
        title: data.get('title'),
        description: data.get('description'),
        projectUrl: data.get('projectUrl'),
      }),
    );
    form.reset();
    await Promise.all([loadEvents(), requestSelected(selectedId)]);
  }

  async function removeSubmission(submissionId: string) {
    if (!selectedId) return;
    await api(`/events/${selectedId}/submissions/${submissionId}`, {method: 'DELETE'});
    await Promise.all([loadEvents(), requestSelected(selectedId)]);
  }

  async function setHidden(submissionId: string, hidden: boolean) {
    if (!selectedId) return;
    await api(
      `/events/${selectedId}/submissions/${submissionId}/visibility`,
      json('POST', {hidden}),
    );
    await Promise.all([loadEvents(), requestSelected(selectedId)]);
  }

  const visibleSelection = selected?.event.id === selectedId ? selected : null;

  return (
    <main className="appShell">
      <header className="topbar">
        <a className="brand" href="/">
          Show &amp; Tell
        </a>
        <span>
          {user.displayName} · {user.role}
        </span>
        <form method="post" action="/api/auth/logout">
          <button type="submit">Sign out</button>
        </form>
      </header>
      {error ? (
        <p className="authError" role="alert">
          {error}
        </p>
      ) : null}
      <div className="workspace">
        <aside className="eventRail">
          <p className="eyebrow">Playlists</p>
          {events.map((event) => (
            <button
              className={event.id === selectedId ? 'eventButton active' : 'eventButton'}
              key={event.id}
              onClick={() => selectEvent(event.id)}
            >
              <strong>{event.title}</strong>
              <span>{event.submissionCount} submissions</span>
            </button>
          ))}
          {user.role === 'admin' ? (
            <form
              className="stackedForm"
              onSubmit={(event) => reportFailure(createEvent(event))}
            >
              <h2>New Show &amp; Tell</h2>
              <label>
                Title
                <input name="title" maxLength={120} required />
              </label>
              <label>
                Description
                <textarea name="description" maxLength={1000} />
              </label>
              <button className="primaryAction" type="submit">
                Create playlist
              </button>
            </form>
          ) : null}
        </aside>
        <section className="eventContent">
          {failedSelection === selectedId && selectedId ? (
            <div className="emptyState">
              <p>Could not load this playlist.</p>
              <button onClick={() => requestSelected(selectedId)}>Retry</button>
            </div>
          ) : visibleSelection ? (
            <>
              <header className="eventHeader">
                <p className="eyebrow">Company playlist</p>
                <h1>{visibleSelection.event.title}</h1>
                {visibleSelection.event.description ? (
                  <p>{visibleSelection.event.description}</p>
                ) : null}
              </header>
              <form
                className="submissionForm"
                onSubmit={(event) => reportFailure(createSubmission(event))}
              >
                <h2>Add your project</h2>
                <label>
                  Title
                  <input name="title" maxLength={120} required />
                </label>
                <label>
                  Project link
                  <input name="projectUrl" type="url" required />
                </label>
                <label>
                  Description
                  <textarea name="description" maxLength={1000} />
                </label>
                <button className="primaryAction" type="submit">
                  Create submission
                </button>
              </form>
              <div className="submissionList">
                {visibleSelection.submissions.map((submission, index) => (
                  <article
                    className={
                      submission.hidden ? 'submissionCard hidden' : 'submissionCard'
                    }
                    key={submission.id}
                  >
                    <span className="position">{String(index + 1).padStart(2, '0')}</span>
                    <div>
                      <p className="eyebrow">
                        {submission.creatorName}
                        {submission.hidden ? ' · hidden' : ''}
                      </p>
                      <h2>{submission.title}</h2>
                      {submission.description ? <p>{submission.description}</p> : null}
                      <a href={submission.projectUrl} target="_blank" rel="noreferrer">
                        Open project ↗
                      </a>
                    </div>
                    <div className="cardActions">
                      {user.role === 'admin' ? (
                        <button
                          onClick={() =>
                            reportFailure(setHidden(submission.id, !submission.hidden))
                          }
                        >
                          {submission.hidden ? 'Show' : 'Hide'}
                        </button>
                      ) : null}
                      {user.role === 'admin' || submission.creatorId === user.id ? (
                        <button
                          onClick={() => reportFailure(removeSubmission(submission.id))}
                        >
                          Delete
                        </button>
                      ) : null}
                    </div>
                  </article>
                ))}
                {!visibleSelection.submissions.length ? (
                  <p className="emptyState">No projects yet. Somebody has to go first.</p>
                ) : null}
              </div>
            </>
          ) : eventsLoadFailed && !eventsLoaded ? (
            <div className="emptyState">
              <p>Could not load playlists.</p>
              <button onClick={() => void loadEvents()}>Retry</button>
            </div>
          ) : selectedId || !eventsLoaded ? (
            <p className="emptyState">Loading playlist…</p>
          ) : (
            <p className="emptyState">No Show &amp; Tell playlists yet.</p>
          )}
        </section>
      </div>
    </main>
  );
}

interface JsonBody {
  [key: string]: FormDataEntryValue | boolean | null;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, init);
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  if (response.status === 204) {
    // SAFETY: callers of 204 endpoints do not consume a response value.
    return undefined as T;
  }
  // SAFETY: API responses are produced by the same-version Worker contract.
  return response.json() as Promise<T>;
}
function json(method: string, body: JsonBody): RequestInit {
  return {
    method,
    headers: {'Content-Type': 'application/json', Origin: window.location.origin},
    body: JSON.stringify(body),
  };
}
function Loading() {
  return (
    <main className="shell">
      <p className="eyebrow">Loading Show &amp; Tell…</p>
    </main>
  );
}
function SignIn({authError}: {authError: string | null}) {
  return (
    <main className="shell">
      <p className="eyebrow">Sentry internal</p>
      <h1>Show &amp; Tell</h1>
      <p className="lede">Sign in with your Sentry Google account to continue.</p>
      {authError ? (
        <p className="authError" role="alert">
          {authError}
        </p>
      ) : null}
      <a className="primaryAction" href="/api/auth/login">
        Continue with Google
      </a>
    </main>
  );
}
function readAuthError() {
  const reason = new URLSearchParams(window.location.search).get('auth_error');
  if (reason === 'forbidden') return 'Use a Sentry Google account to sign in.';
  if (reason === 'failed') return 'Google sign-in failed. Please try again.';
  return null;
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
  )
    return null;
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    role: user.role,
  };
}
