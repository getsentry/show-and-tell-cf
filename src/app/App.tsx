import {useCallback, useEffect, useRef, useState, type FormEvent} from 'react';

import type {SessionUser} from '../shared/api';
import type {
  EventResponse,
  EventsResponse,
  ShowAndTellEvent,
  Submission,
} from '../shared/events';
import {isJsonObject, isJsonString, type JsonInput} from '../shared/json';
import {playlistPath, safeReturnTo} from '../shared/playlist';
import {api, json} from './api';
import {AppFrame} from './components/AppFrame';
import {Avatar} from './components/Avatar';
import {GoogleIcon} from './components/GoogleIcon';
import {Loader} from './components/Loader';
import {SentrySymbol} from './components/SentrySymbol';
import {ThemeToggle} from './components/ThemeToggle';
import {PlaylistOrder} from './PlaylistOrder';
import {PlaylistPage, SharePlaylist} from './PlaylistPage';
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
  const path = safeReturnTo(window.location.pathname);
  if (path !== '/')
    return <PlaylistPage eventId={path.slice('/playlists/'.length)} user={user} />;
  return <ShowAndTell user={user} />;
}

function ShowAndTell({user}: {user: SessionUser}) {
  const [events, setEvents] = useState<ShowAndTellEvent[]>([]);
  const [eventsLoaded, setEventsLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    new URLSearchParams(window.location.search).get('event'),
  );
  const [selected, setSelected] = useState<EventResponse | null>(null);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [failedSelection, setFailedSelection] = useState<string | null>(null);
  const selectedIdRef = useRef<string | null>(selectedId);
  const eventsRequest = useRef(0);
  const selectedRequests = useRef(new Map<string, number>());
  const [creatingEvent, setCreatingEvent] = useState(false);
  const [creatingSubmission, setCreatingSubmission] = useState(false);
  const eventPending = useRef(false);
  const submissionPending = useRef(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [createdSubmission, setCreatedSubmission] = useState<Submission | null>(null);
  const admin = user.role === 'admin';

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
      const result = await api<EventResponse>(`/events/${encodeURIComponent(eventId)}`);
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

  const errors = [eventsError, selectionError, mutationError].filter(Boolean);
  return (
    <AppFrame user={user} section="playlists">
      <main className="homePage">
        {errors.length ? (
          <div className="noticeBar" role="alert">
            <p>{errors.join(' · ')}</p>
            {eventsError ? (
              <button onClick={() => void loadEvents()}>Retry</button>
            ) : null}
          </div>
        ) : null}
        <section
          className={admin ? 'playlistsBar playlistsBar--admin' : 'playlistsBar'}
          aria-label="Playlists"
        >
          <div className="playlistStrip">
            <p className="kicker">Playlists</p>
            <div className="playlistPills">
              {events.map((event) => (
                <button
                  className={
                    event.id === selectedId ? 'playlistPill active' : 'playlistPill'
                  }
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
              {eventsLoaded && !events.length ? (
                <span className="playlistPill playlistPill--empty">
                  Nothing scheduled yet
                </span>
              ) : null}
            </div>
          </div>
          {admin ? (
            <form
              className="newPlaylist"
              aria-label="Create playlist"
              onSubmit={(event) => reportFailure(createEvent(event))}
            >
              <p className="kicker">New Show &amp; Tell</p>
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
                <textarea
                  name="description"
                  rows={2}
                  maxLength={1000}
                  disabled={creatingEvent}
                />
              </label>
              <button className="primaryAction" type="submit" disabled={creatingEvent}>
                {creatingEvent ? 'Creating…' : 'Create playlist'}
              </button>
            </form>
          ) : null}
        </section>
        {failedSelection === selectedId && selectedId ? (
          <section className="emptyState">
            <span>!</span>
            <h2>Could not load this playlist.</h2>
            <p>Something went wrong while fetching the submissions.</p>
            <button className="textAction" onClick={() => requestSelected(selectedId)}>
              Retry
            </button>
          </section>
        ) : visibleSelection ? (
          <>
            <header className="playlistHero pageHeader">
              <div className="playlistHeroCopy">
                <p className="kicker">Show &amp; Tell playlist</p>
                <h1>{visibleSelection.event.title}</h1>
                {visibleSelection.event.description ? (
                  <p>{visibleSelection.event.description}</p>
                ) : null}
              </div>
              <div className="playlistHeroActions">
                <a
                  className="primaryAction primaryAction--play"
                  href={playlistPath(visibleSelection.event.id)}
                >
                  Open the screening
                </a>
                <SharePlaylist
                  key={visibleSelection.event.id}
                  eventId={visibleSelection.event.id}
                />
              </div>
            </header>
            {admin && visibleSelection.submissions.length > 1 ? (
              <PlaylistOrder
                key={visibleSelection.event.id}
                eventId={visibleSelection.event.id}
                submissions={visibleSelection.submissions}
                onOrdered={() => requestSelected(visibleSelection.event.id)}
              />
            ) : null}
            <section className="compose" aria-labelledby="compose-heading">
              <div className="composeIntro">
                <p className="kicker">Add your video</p>
                <h2 id="compose-heading">What are you showing?</h2>
                <p className="formHint">
                  Save a title first, then upload the video on your card below. Your entry
                  stays put if the upload needs another try.
                </p>
              </div>
              <form
                className="submissionForm"
                key={visibleSelection.event.id}
                aria-label="Create submission"
                onSubmit={(event) => reportFailure(createSubmission(event))}
              >
                <label>
                  Title
                  <input
                    name="title"
                    maxLength={120}
                    placeholder="A short, punchy name for your demo"
                    disabled={creatingSubmission}
                    required
                  />
                </label>
                <label>
                  Description (optional)
                  <textarea
                    name="description"
                    rows={3}
                    maxLength={1000}
                    placeholder="One or two lines on what people will see"
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
            </section>
            <section className="lineup" aria-labelledby="lineup-heading">
              <header className="lineupHeader">
                <div>
                  <p className="kicker">Lineup</p>
                  <h2 id="lineup-heading">
                    {visibleSelection.submissions.length}{' '}
                    {visibleSelection.submissions.length === 1
                      ? 'submission'
                      : 'submissions'}
                  </h2>
                </div>
                <p>
                  Videos play in this order.
                  {admin ? ' Use Arrange playlist to change it.' : ''}
                </p>
              </header>
              <ol className="submissionList">
                {visibleSelection.submissions.map((submission, index) => {
                  const canManage = admin || submission.creatorId === user.id;
                  return (
                    <li key={submission.id}>
                      <article
                        className={
                          submission.hidden ? 'submissionCard hidden' : 'submissionCard'
                        }
                        id={`submission-${submission.id}`}
                        tabIndex={-1}
                        aria-label={submission.title}
                      >
                        <span className="position" aria-hidden="true">
                          {String(index + 1).padStart(2, '0')}
                        </span>
                        <div className="submissionBody">
                          <div className="submissionByline">
                            <Avatar
                              name={submission.creatorName}
                              className="submissionAvatar"
                            />
                            <span>{submission.creatorName}</span>
                            {submission.hidden ? (
                              <span className="tag tag--hidden">
                                Hidden from the show
                              </span>
                            ) : null}
                          </div>
                          <h2>{submission.title}</h2>
                          {submission.description ? (
                            <p className="submissionDescription">
                              {submission.description}
                            </p>
                          ) : null}
                          <VideoPanel submission={submission} canManage={canManage} />
                        </div>
                        {admin || canManage ? (
                          <div className="cardActions">
                            {admin ? (
                              <button
                                onClick={() =>
                                  reportFailure(
                                    setHidden(submission.id, !submission.hidden),
                                  )
                                }
                              >
                                {submission.hidden ? 'Show' : 'Hide'}
                              </button>
                            ) : null}
                            {canManage ? (
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
                        ) : null}
                      </article>
                    </li>
                  );
                })}
              </ol>
              {!visibleSelection.submissions.length ? (
                <section className="emptyState">
                  <span>00</span>
                  <h2>No videos yet</h2>
                  <p>Create a submission above, then upload your video.</p>
                </section>
              ) : null}
            </section>
          </>
        ) : eventsError && !eventsLoaded ? null : selectedId || !eventsLoaded ? (
          <div className="pageState pageState--loading" aria-busy="true">
            <Loader />
            <p>Loading playlist…</p>
          </div>
        ) : (
          <section className="emptyState">
            <span>00</span>
            <h2>No Show &amp; Tell playlists yet.</h2>
            <p>
              {admin
                ? 'Create the first playlist above and share it with the company.'
                : 'An admin creates the first playlist; check back soon.'}
            </p>
          </section>
        )}
      </main>
    </AppFrame>
  );
}

function Loading() {
  return (
    <main className="authShell authShell--loading">
      <section className="authState authState--loading" aria-busy="true">
        <Loader />
        <p className="kicker">Sentry internal</p>
        <h1>Loading Show &amp; Tell</h1>
        <p>Checking your session…</p>
      </section>
    </main>
  );
}

function SignIn({authError}: {authError: string | null}) {
  const returnTo = safeReturnTo(window.location.pathname);
  return (
    <main className="authShell">
      <ThemeToggle className="authThemeToggle" />
      <section className="authState">
        <span className="authMark" aria-hidden="true">
          <SentrySymbol />
        </span>
        <p className="kicker">Sentry internal</p>
        <h1>Show &amp; Tell</h1>
        <p>Sign in with your Sentry Google account to watch and share demo videos.</p>
        {authError ? (
          <p className="authError" role="alert">
            {authError}
          </p>
        ) : null}
        <a
          className="googleLogin"
          href={
            returnTo === '/'
              ? '/api/auth/login'
              : `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`
          }
        >
          <GoogleIcon />
          Continue with Google
        </a>
      </section>
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
