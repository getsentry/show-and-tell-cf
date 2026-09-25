import {useCallback, useEffect, useRef, useState, type FormEvent} from 'react';

import type {SessionUser} from '../shared/api';
import type {
  EventResponse,
  EventsResponse,
  ShowAndTellEvent,
  Submission,
} from '../shared/events';
import {isJsonObject, isJsonString, type JsonInput} from '../shared/json';
import {
  playlistPath,
  submissionPath,
  safeReturnTo,
  eventIdFromPath,
} from '../shared/playlist';
import {api, json} from './api';
import {AppFrame} from './components/AppFrame';
import {Avatar} from './components/Avatar';
import {ArrowIcon} from './components/ArrowIcon';
import {ConfirmDialog} from './components/ConfirmDialog';
import {GoogleIcon} from './components/GoogleIcon';
import {Loader} from './components/Loader';
import {SentrySymbol} from './components/SentrySymbol';
import {ThemeToggle} from './components/ThemeToggle';
import {PlaylistOrder} from './PlaylistOrder';
import {PlaylistTrash} from './PlaylistTrash';
import {PlaylistEditor} from './PlaylistEditor';
import {ReminderList} from './ReminderList';
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
  if (path.startsWith('/playlists/'))
    return (
      <PlaylistPage
        key={user.role}
        eventId={eventIdFromPath(path)!}
        user={user}
        onViewModeChange={setUser}
      />
    );
  // Discard cached admin-only data (and stop media/uploads) when changing views.
  return <ShowAndTell key={user.role} user={user} onViewModeChange={setUser} />;
}

function currentEventId() {
  const path = safeReturnTo(window.location.pathname);
  if (path.startsWith('/events/')) return eventIdFromPath(path);
  const legacy = new URLSearchParams(window.location.search).get('event');
  return legacy && /^[a-zA-Z0-9_-]{1,128}$/.test(legacy) ? legacy : null;
}

export function defaultPlaylistTitle(now = new Date()) {
  const month = now.toLocaleString('en-US', {month: 'long'});
  return `Show & Tell ${month} - ${now.getFullYear()}`;
}

function ShowAndTell({
  user,
  onViewModeChange,
}: {
  user: SessionUser;
  onViewModeChange: (user: SessionUser) => void;
}) {
  const [events, setEvents] = useState<ShowAndTellEvent[]>([]);
  const [eventsLoaded, setEventsLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(currentEventId);
  const [showCreate, setShowCreate] = useState(false);
  const [showReminders, setShowReminders] = useState(false);
  const [showTrash, setShowTrash] = useState(false);
  const [editing, setEditing] = useState<ShowAndTellEvent | null>(null);
  const [selected, setSelected] = useState<EventResponse | null>(null);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [failedSelection, setFailedSelection] = useState<string | null>(null);
  const selectedIdRef = useRef<string | null>(selectedId);
  const navigationRevision = useRef(0);
  const eventsRequest = useRef(0);
  const selectedRequests = useRef(new Map<string, number>());
  const [creatingEvent, setCreatingEvent] = useState(false);
  const [creatingSubmission, setCreatingSubmission] = useState(false);
  const [changingVisibility, setChangingVisibility] = useState(false);
  const eventPending = useRef(false);
  const submissionPending = useRef(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deletingSubmission, setDeletingSubmission] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const deletionPending = useRef(false);
  const [createdSubmission, setCreatedSubmission] = useState<Submission | null>(null);
  const admin = user.role === 'admin';
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const selectEvent = useCallback(
    (eventId: string | null, push = true, slug?: string) => {
      navigationRevision.current++;
      if (eventId !== selectedIdRef.current) {
        setFailedSelection(null);
        setSelectionError(null);
      }
      setDeleteId(null);
      setEditing(null);
      setMutationError(null);
      const destination = eventId ? submissionPath(eventId, slug) : '/';
      if (push && `${window.location.pathname}${window.location.search}` !== destination)
        window.history.pushState(null, '', destination);
      selectedIdRef.current = eventId;
      setSelectedId(eventId);
    },
    [],
  );
  const loadEvents = useCallback(async () => {
    if (!mounted.current) return;
    const request = ++eventsRequest.current;
    try {
      const result = await api<EventsResponse>('/events');
      if (request !== eventsRequest.current || !mounted.current) return;
      setEvents(result.events);
      setEventsLoaded(true);
      setEventsError(null);
    } catch (cause) {
      if (request !== eventsRequest.current || !mounted.current) return;
      setEventsError(cause instanceof Error ? cause.message : 'Request failed');
    }
  }, []);
  useEffect(() => {
    const onPopState = () => selectEvent(currentEventId(), false);
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
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
        eventId !== selectedIdRef.current ||
        !mounted.current
      )
        return;
      setSelected(result);
      window.history.replaceState(
        null,
        '',
        submissionPath(result.event.id, result.event.slug),
      );
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
    const previousNavigation = navigationRevision.current;
    try {
      const result = await api<{event: ShowAndTellEvent}>(
        '/events',
        json('POST', {
          title: data.get('title'),
          description: data.get('description'),
          slug: data.get('slug'),
          hidden: data.get('hidden') === 'on',
        }),
      );
      // A view switch unmounts this editor. A late create must not change the
      // replacement view's URL or trigger refreshes with the new session role.
      if (!mounted.current) return;
      form.reset();
      setShowCreate(false);
      // Keep the new playlist usable even if refreshing the list fails.
      setEvents((current) => [
        result.event,
        ...current.filter((entry) => entry.id !== result.event.id),
      ]);
      setEventsLoaded(true);
      if (navigationRevision.current === previousNavigation)
        selectEvent(result.event.id, true, result.event.slug);
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
    if (!selectedId || deletionPending.current) return;
    deletionPending.current = true;
    setDeletingSubmission(true);
    setDeleteError(null);
    try {
      await api(`/events/${selectedId}/submissions/${submissionId}`, {method: 'DELETE'});
      setDeleteId(null);
      await Promise.all([loadEvents(), requestSelected(selectedId)]);
    } catch (cause) {
      setDeleteError(
        cause instanceof Error ? cause.message : 'Could not delete submission.',
      );
    } finally {
      deletionPending.current = false;
      setDeletingSubmission(false);
    }
  }

  function editPlaylist(event: ShowAndTellEvent) {
    // Opening the editor is navigation even when the selected playlist stays the same.
    navigationRevision.current++;
    setEditing(event);
  }

  function playlistSaved(event: ShowAndTellEvent) {
    if (!mounted.current) return;
    setEditing((current) => (current?.id === event.id ? null : current));
    // Invalidate older detail reads so they cannot overwrite the saved title.
    selectedRequests.current.set(
      event.id,
      (selectedRequests.current.get(event.id) ?? 0) + 1,
    );
    setSelected((current) =>
      current?.event.id === event.id ? {...current, event} : current,
    );
    setEvents((current) =>
      current.map((entry) => (entry.id === event.id ? event : entry)),
    );
    void loadEvents();
  }

  function playlistTrashed(id: string) {
    if (!mounted.current) return;
    setEditing((current) => (current?.id === id ? null : current));
    setEvents((current) => current.filter((entry) => entry.id !== id));
    if (selectedIdRef.current === id) {
      selectEvent(null);
      setSelected(null);
    }
    void loadEvents();
  }

  async function setHidden(submissionId: string, hidden: boolean) {
    if (!selectedId) return;
    await api(
      `/events/${selectedId}/submissions/${submissionId}/visibility`,
      json('POST', {hidden}),
    );
    await Promise.all([loadEvents(), requestSelected(selectedId)]);
  }

  async function changeEventVisibility(event: ShowAndTellEvent) {
    setChangingVisibility(true);
    try {
      const result = await api<{event: ShowAndTellEvent}>(
        `/events/${event.id}/visibility`,
        json('POST', {hidden: !event.hidden}),
      );
      if (!mounted.current) return;
      setSelected((current) =>
        current?.event.id === result.event.id
          ? {...current, event: result.event}
          : current,
      );
      await loadEvents();
    } finally {
      setChangingVisibility(false);
    }
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
  if (admin && editing)
    return (
      <AppFrame user={user} section="playlists" onViewModeChange={onViewModeChange}>
        <main className="homePage">
          <PlaylistEditor
            key={editing.id}
            event={editing}
            onSaved={playlistSaved}
            onTrashed={playlistTrashed}
            onCancel={() => setEditing(null)}
          />
        </main>
      </AppFrame>
    );
  return (
    <AppFrame user={user} section="playlists" onViewModeChange={onViewModeChange}>
      <main className="homePage">
        {errors.length ? (
          <div className="noticeBar" role="alert">
            <p>{errors.join(' · ')}</p>
            {eventsError ? (
              <button onClick={() => void loadEvents()}>Retry</button>
            ) : null}
          </div>
        ) : null}
        {!selectedId ? (
          <>
            <header className="overviewHero">
              <h1>
                Show <span>&amp;</span> Tell
              </h1>
            </header>
            <section className="overviewSection" aria-label="Show & Tell playlists">
              <div className="overviewHeading">
                <h2>The shows</h2>
                {admin ? (
                  <div className="actionGroup" role="group" aria-label="Admin tools">
                    <button
                      className="secondaryAction"
                      aria-expanded={showReminders}
                      aria-controls="admin-reminders"
                      onClick={() => setShowReminders((value) => !value)}
                    >
                      {showReminders ? 'Close reminders' : 'View reminders'}
                    </button>
                    <button
                      className="secondaryAction"
                      aria-expanded={showTrash}
                      aria-controls="playlist-trash"
                      onClick={() => setShowTrash((value) => !value)}
                    >
                      {showTrash ? 'Close trash' : 'View trash'}
                    </button>
                    <button
                      className="primaryAction"
                      aria-expanded={showCreate}
                      aria-controls="new-playlist"
                      onClick={() => setShowCreate(!showCreate)}
                    >
                      {showCreate ? 'Cancel new playlist' : 'New playlist'}
                    </button>
                  </div>
                ) : null}
              </div>
              {admin ? (
                <>
                  <div id="admin-reminders">
                    {showReminders ? <ReminderList /> : null}
                  </div>
                  <div id="playlist-trash">
                    {showTrash ? <PlaylistTrash onRestored={loadEvents} /> : null}
                  </div>
                </>
              ) : null}
              {admin && showCreate ? (
                <form
                  id="new-playlist"
                  className="newPlaylist"
                  aria-label="Create playlist"
                  onSubmit={(event) => reportFailure(createEvent(event))}
                >
                  <label>
                    Title
                    <input
                      name="title"
                      maxLength={120}
                      defaultValue={defaultPlaylistTitle()}
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
                  <label>
                    URL label (optional)
                    <input
                      name="slug"
                      maxLength={120}
                      disabled={creatingEvent}
                      placeholder="october-show-and-tell"
                    />
                  </label>
                  <label className="checkboxLabel">
                    <input type="checkbox" name="hidden" disabled={creatingEvent} />
                    Hide from member overview
                  </label>
                  <p className="formHint">
                    Admins still see hidden playlists. Anyone with the link and a Sentry
                    login can open them.
                  </p>
                  <button
                    className="primaryAction"
                    type="submit"
                    disabled={creatingEvent}
                  >
                    {creatingEvent ? 'Creating…' : 'Create playlist'}
                  </button>
                </form>
              ) : null}
              <div className="eventGrid">
                {events.map((event) => (
                  <article className="eventCard" key={event.id} aria-label={event.title}>
                    <div className="eventCardHero">
                      <h3>{event.title}</h3>
                    </div>
                    <div className="eventCardBody">
                      {event.hidden ? (
                        <span className="tag tag--hidden">Hidden</span>
                      ) : null}
                      {event.description ? <p>{event.description}</p> : null}
                      <p className="eventCount">
                        {event.submissionCount}{' '}
                        {event.submissionCount === 1 ? 'submission' : 'submissions'}
                        {admin ? '' : ' from you'}
                      </p>
                      <a
                        className="primaryAction primaryAction--play"
                        href={playlistPath(event.id, event.slug)}
                      >
                        Open the screening
                      </a>
                      <div className="eventCardActions">
                        <a
                          className="submissionLink"
                          href={submissionPath(event.id, event.slug)}
                          onClick={(click) => {
                            if (
                              click.button !== 0 ||
                              click.metaKey ||
                              click.ctrlKey ||
                              click.shiftKey ||
                              click.altKey
                            )
                              return;
                            click.preventDefault();
                            selectEvent(event.id, true, event.slug);
                          }}
                        >
                          Upload &amp; submissions
                        </a>
                        {admin ? (
                          <button
                            className="secondaryAction"
                            onClick={() => editPlaylist(event)}
                          >
                            Edit playlist
                          </button>
                        ) : null}
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          </>
        ) : (
          <section className="playlistsBar" aria-label="Playlists">
            <a
              className="backLink"
              href="/"
              onClick={(click) => {
                if (
                  click.button !== 0 ||
                  click.metaKey ||
                  click.ctrlKey ||
                  click.shiftKey ||
                  click.altKey
                )
                  return;
                click.preventDefault();
                selectEvent(null);
              }}
            >
              <ArrowIcon direction="left" /> All shows
            </a>
            <div className="playlistPills" role="group" aria-label="Switch playlist">
              {events.map((event) => (
                <button
                  className={
                    event.id === selectedId ? 'playlistPill active' : 'playlistPill'
                  }
                  key={event.id}
                  aria-current={event.id === selectedId ? 'true' : undefined}
                  onClick={() => selectEvent(event.id, true, event.slug)}
                >
                  <strong>{event.title}</strong>
                  {event.hidden ? <span className="tag tag--hidden">Hidden</span> : null}
                  <span>
                    {event.submissionCount}{' '}
                    {event.submissionCount === 1 ? 'submission' : 'submissions'}
                    {admin ? '' : ' from you'}
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}
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
                {visibleSelection.event.cancelledAt ? (
                  <p className="formHint" role="status">
                    This show was canceled. Its submissions and links are still available.
                  </p>
                ) : visibleSelection.event.hidden ? (
                  <p className="formHint">
                    Hidden from the member overview. Admins can still see it, and this
                    link still works.
                  </p>
                ) : null}
              </div>
              <div className="playlistHeroActions">
                <a
                  className="primaryAction primaryAction--play"
                  href={playlistPath(
                    visibleSelection.event.id,
                    visibleSelection.event.slug,
                  )}
                >
                  Open the screening
                </a>
                <SharePlaylist
                  kind="submission"
                  key={visibleSelection.event.id}
                  eventId={visibleSelection.event.id}
                  slug={visibleSelection.event.slug}
                />
              </div>
            </header>
            {admin ? (
              <section className="adminToolbar" aria-label="Playlist administration">
                <p className="kicker">Admin controls</p>
                <div className="actionGroup">
                  <button onClick={() => editPlaylist(visibleSelection.event)}>
                    Edit playlist
                  </button>
                  {!visibleSelection.event.cancelledAt ? (
                    <button
                      disabled={changingVisibility}
                      onClick={() =>
                        reportFailure(changeEventVisibility(visibleSelection.event))
                      }
                    >
                      {visibleSelection.event.hidden
                        ? 'Show on member overview'
                        : 'Hide from member overview'}
                    </button>
                  ) : null}
                </div>
              </section>
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
                  <p className="kicker">{admin ? 'Lineup' : 'Your submissions'}</p>
                  <h2 id="lineup-heading">
                    {visibleSelection.submissions.length}{' '}
                    {visibleSelection.submissions.length === 1
                      ? 'submission'
                      : 'submissions'}
                  </h2>
                </div>
                <p>
                  {admin
                    ? 'Videos play in this order. Use Arrange playlist to change it.'
                    : 'Manage your uploads here. Open the screening to watch everyone’s videos.'}
                </p>
              </header>
              {admin && visibleSelection.submissions.length > 1 ? (
                <PlaylistOrder
                  key={visibleSelection.event.id}
                  eventId={visibleSelection.event.id}
                  submissions={visibleSelection.submissions}
                  onOrdered={() => requestSelected(visibleSelection.event.id)}
                />
              ) : null}
              <ol
                className={
                  admin ? 'submissionList' : 'submissionList submissionList--own'
                }
              >
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
                        {admin ? (
                          <span className="position" aria-hidden="true">
                            {String(index + 1).padStart(2, '0')}
                          </span>
                        ) : null}
                        <div className="submissionBody">
                          <div className="submissionByline">
                            <Avatar
                              name={submission.creatorName}
                              avatarUrl={submission.creatorAvatarUrl}
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
                              <>
                                <button
                                  className="dangerAction"
                                  onClick={() => {
                                    setDeleteError(null);
                                    setDeleteId(submission.id);
                                  }}
                                >
                                  Delete
                                </button>
                                {deleteId === submission.id ? (
                                  <ConfirmDialog
                                    title="Delete this submission and its video?"
                                    description={`“${submission.title}” will be removed from the show. This cannot be undone.`}
                                    confirmLabel="Confirm delete"
                                    cancelLabel="Keep submission"
                                    busy={deletingSubmission}
                                    error={deleteError}
                                    onConfirm={() => void removeSubmission(submission.id)}
                                    onCancel={() => setDeleteId(null)}
                                  />
                                ) : null}
                              </>
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
                  <h2>{admin ? 'No videos yet' : 'No submissions yet'}</h2>
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
        ) : events.length ? null : (
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
      <section className="authState authState--loading" role="status">
        <Loader />
        <h1>Loading</h1>
      </section>
    </main>
  );
}

function SignIn({authError}: {authError: string | null}) {
  const eventId = currentEventId();
  const returnTo =
    safeReturnTo(window.location.pathname) !== '/'
      ? safeReturnTo(window.location.pathname)
      : eventId
        ? submissionPath(eventId)
        : '/';
  return (
    <main className="authShell">
      <ThemeToggle className="authThemeToggle" />
      <section className="authState">
        <span className="authMark" aria-hidden="true">
          <SentrySymbol />
        </span>
        <h1>
          Show <span>&amp;</span> Tell
        </h1>
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
    (user.role !== 'member' && user.role !== 'admin') ||
    (user.actualRole !== 'member' && user.actualRole !== 'admin')
  )
    return null;
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    role: user.role,
    actualRole: user.actualRole,
  };
}
