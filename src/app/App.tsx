import {useCallback, useEffect, useRef, useState, type FormEvent} from 'react';

import type {SessionUser} from '../shared/api';
import type {
  EventResponse,
  EventsResponse,
  ShowAndTellEvent,
  Submission,
} from '../shared/events';
import {isJsonObject, isJsonString, type JsonInput} from '../shared/json';
import {api, json} from './api';
import {VideoPanel} from './VideoPanel';

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
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [failedSelection, setFailedSelection] = useState<string | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  const eventsRequest = useRef(0);
  const selectedRequests = useRef(new Map<string, number>());
  const [creatingEvent, setCreatingEvent] = useState(false);
  const [creatingSubmission, setCreatingSubmission] = useState(false);
  const eventPending = useRef(false);
  const submissionPending = useRef(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [createdSubmission, setCreatedSubmission] = useState<Submission | null>(null);

  const selectEvent = useCallback((eventId: string | null) => {
    if (eventId !== selectedIdRef.current) {
      setFailedSelection(null);
      setSelectionError(null);
    }
    setDeleteId(null);
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
      setEventsError(null);
    } catch (cause) {
      if (request !== eventsRequest.current) return;
      setEventsError(cause instanceof Error ? cause.message : 'Request failed');
    }
  }, [selectEvent]);
  useEffect(() => {
    void loadEvents();
  }, [loadEvents]);
  const requestSelected = useCallback(async (eventId: string) => {
    const request = (selectedRequests.current.get(eventId) ?? 0) + 1;
    selectedRequests.current.set(eventId, request);
    if (eventId === selectedIdRef.current) {
      setFailedSelection(null);
      setSelectionError(null);
    }
    try {
      const result = await api<EventResponse>(`/events/${eventId}`);
      if (
        request !== selectedRequests.current.get(eventId) ||
        eventId !== selectedIdRef.current
      )
        return;
      setSelected(result);
    } catch (cause) {
      if (
        request !== selectedRequests.current.get(eventId) ||
        eventId !== selectedIdRef.current
      )
        return;
      setFailedSelection(eventId);
      setSelectionError(cause instanceof Error ? cause.message : 'Request failed');
    }
  }, []);
  useEffect(() => {
    if (!selectedId) {
      setSelected(null);
      return;
    }
    void requestSelected(selectedId);
  }, [requestSelected, selectedId]);

  function reportFailure(operation: Promise<void>) {
    setMutationError(null);
    void operation.catch((cause: Error) => setMutationError(cause.message));
  }

  async function createEvent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    if (eventPending.current) return;
    eventPending.current = true;
    setCreatingEvent(true);
    const previousSelection = selectedIdRef.current;
    try {
      const result = await api<{event: ShowAndTellEvent}>(
        '/events',
        json('POST', {
          title: data.get('title'),
          description: data.get('description'),
        }),
      );
      form.reset();
      // Keep the new playlist usable even if refreshing the list fails.
      setEvents((current) => [
        result.event,
        ...current.filter((entry) => entry.id !== result.event.id),
      ]);
      setEventsLoaded(true);
      if (selectedIdRef.current === previousSelection) selectEvent(result.event.id);
      await loadEvents();
    } finally {
      eventPending.current = false;
      setCreatingEvent(false);
    }
  }

  async function createSubmission(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedId || submissionPending.current) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    submissionPending.current = true;
    setCreatingSubmission(true);
    try {
      const {submission} = await api<{submission: Submission}>(
        `/events/${selectedId}/submissions`,
        json('POST', {
          title: data.get('title'),
          description: data.get('description'),
        }),
      );
      form.reset();
      setCreatedSubmission(submission);
      await Promise.all([loadEvents(), requestSelected(selectedId)]);
    } finally {
      submissionPending.current = false;
      setCreatingSubmission(false);
    }
  }

  async function removeSubmission(submissionId: string) {
    if (!selectedId) return;
    await api(`/events/${selectedId}/submissions/${submissionId}`, {method: 'DELETE'});
    setDeleteId(null);
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
  useEffect(() => {
    if (!createdSubmission) return;
    if (createdSubmission.eventId !== selectedId) {
      setCreatedSubmission(null);
      return;
    }
    const card = document.getElementById(`submission-${createdSubmission.id}`);
    if (card) {
      card.focus();
      setCreatedSubmission(null);
    }
  }, [createdSubmission, selectedId, visibleSelection]);

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
      {eventsError || selectionError || mutationError ? (
        <div className="authError" role="alert">
          <p>
            {[eventsError, selectionError, mutationError].filter(Boolean).join(' · ')}
          </p>
          {eventsError ? <button onClick={() => void loadEvents()}>Retry</button> : null}
        </div>
      ) : null}
      <div className="workspace">
        <aside className="eventRail">
          <p className="eyebrow">Playlists</p>
          {events.map((event) => (
            <button
              className={event.id === selectedId ? 'eventButton active' : 'eventButton'}
              key={event.id}
              aria-current={event.id === selectedId ? 'true' : undefined}
              onClick={() => selectEvent(event.id)}
            >
              <strong>{event.title}</strong>
              <span>
                {event.submissionCount}{' '}
                {event.submissionCount === 1 ? 'submission' : 'submissions'}
              </span>
            </button>
          ))}
          {user.role === 'admin' ? (
            <form
              className="stackedForm"
              aria-label="Create playlist"
              onSubmit={(event) => reportFailure(createEvent(event))}
            >
              <h2>New Show &amp; Tell</h2>
              <label>
                Title
                <input
                  name="title"
                  maxLength={120}
                  placeholder="Show & Tell — October 2026"
                  disabled={creatingEvent}
                  required
                />
              </label>
              <label>
                Description (optional)
                <textarea name="description" maxLength={1000} disabled={creatingEvent} />
              </label>
              <button className="primaryAction" type="submit" disabled={creatingEvent}>
                {creatingEvent ? 'Creating…' : 'Create playlist'}
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
                key={visibleSelection.event.id}
                aria-label="Create submission"
                onSubmit={(event) => reportFailure(createSubmission(event))}
              >
                <h2>Add your video</h2>
                <p className="formHint">
                  Start with a title. Save your submission first, then upload a video —
                  your entry stays safe if the upload needs a retry.
                </p>
                <label>
                  Title
                  <input
                    name="title"
                    maxLength={120}
                    placeholder="What are you showing?"
                    disabled={creatingSubmission}
                    required
                  />
                </label>
                <label>
                  Description (optional)
                  <textarea
                    name="description"
                    maxLength={1000}
                    disabled={creatingSubmission}
                  />
                </label>
                <button
                  className="primaryAction"
                  type="submit"
                  disabled={creatingSubmission}
                >
                  {creatingSubmission ? 'Saving…' : 'Create submission'}
                </button>
              </form>
              <div className="submissionList">
                {visibleSelection.submissions.map((submission, index) => (
                  <article
                    className={
                      submission.hidden ? 'submissionCard hidden' : 'submissionCard'
                    }
                    key={submission.id}
                    id={`submission-${submission.id}`}
                    tabIndex={-1}
                    aria-label={submission.title}
                  >
                    <span className="position">{String(index + 1).padStart(2, '0')}</span>
                    <div className="submissionBody">
                      <p className="eyebrow">
                        {submission.creatorName}
                        {submission.hidden ? ' · hidden' : ''}
                      </p>
                      <h2>{submission.title}</h2>
                      {submission.description ? <p>{submission.description}</p> : null}
                      <VideoPanel
                        submission={submission}
                        canManage={
                          user.role === 'admin' || submission.creatorId === user.id
                        }
                      />
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
                        deleteId === submission.id ? (
                          <div className="confirmAction">
                            <p>Delete this submission and its video?</p>
                            <button
                              onClick={() =>
                                reportFailure(removeSubmission(submission.id))
                              }
                            >
                              Confirm delete
                            </button>
                            <button onClick={() => setDeleteId(null)}>
                              Keep submission
                            </button>
                          </div>
                        ) : (
                          <button onClick={() => setDeleteId(submission.id)}>
                            Delete
                          </button>
                        )
                      ) : null}
                    </div>
                  </article>
                ))}
                {!visibleSelection.submissions.length ? (
                  <p className="emptyState">
                    No videos yet. Create a submission above, then upload your video.
                  </p>
                ) : null}
              </div>
            </>
          ) : eventsError && !eventsLoaded ? null : selectedId || !eventsLoaded ? (
            <p className="emptyState">Loading playlist…</p>
          ) : (
            <p className="emptyState">No Show &amp; Tell playlists yet.</p>
          )}
        </section>
      </div>
    </main>
  );
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
