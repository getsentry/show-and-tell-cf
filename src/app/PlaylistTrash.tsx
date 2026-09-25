import {useEffect, useRef, useState} from 'react';

import type {EventsResponse, ShowAndTellEvent} from '../shared/events';
import {api} from './api';

export function PlaylistTrash({onRestored}: {onRestored: () => Promise<void>}) {
  const [events, setEvents] = useState<ShowAndTellEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const pending = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    let current = true;
    setError(null);
    api<EventsResponse>('/events?trash=true').then(
      (result) => {
        if (current) setEvents(result.events);
      },
      (cause: Error) => {
        if (current) setError(cause.message);
      },
    );
    return () => {
      current = false;
      mounted.current = false;
    };
  }, [attempt]);

  async function restore(event: ShowAndTellEvent) {
    if (pending.current) return;
    pending.current = true;
    setRestoringId(event.id);
    setError(null);
    setNotice(null);
    try {
      await api(`/events/${event.id}/restore`, {method: 'POST'});
      if (mounted.current) {
        setEvents((current) => current?.filter((entry) => entry.id !== event.id) ?? null);
        setNotice(
          `${event.title} restored.${event.cancelledAt ? ' This show is still canceled.' : ''}`,
        );
      }
      // Closing Trash must not leave the overview missing a restored playlist.
      await onRestored();
    } catch (cause) {
      if (mounted.current)
        setError(cause instanceof Error ? cause.message : 'Could not restore playlist.');
    } finally {
      pending.current = false;
      if (mounted.current) setRestoringId(null);
    }
  }

  return (
    <section className="adminPanel" aria-label="Playlist trash">
      <div className="overviewHeading">
        <h2>Trash</h2>
      </div>
      <p className="formHint">
        Submissions and videos are kept. Restore a playlist to make its links work again.
        Scheduled reminders resume if they are still due. Hidden and canceled shows keep
        their status.
      </p>
      {error ? (
        <div role="alert">
          <p>{error}</p>
          {events === null ? (
            <button onClick={() => setAttempt((value) => value + 1)}>Retry</button>
          ) : null}
        </div>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      {events === null ? (
        <p>Loading trash…</p>
      ) : events.length ? (
        <div className="trashList">
          {events.map((event) => (
            <article className="trashRow" key={event.id} aria-label={event.title}>
              <div className="trashCopy">
                <h3>{event.title}</h3>
                {event.cancelledAt ? (
                  <span className="tag">Canceled</span>
                ) : event.hidden ? (
                  <span className="tag tag--hidden">Hidden</span>
                ) : null}
                <p>
                  {event.submissionCount}{' '}
                  {event.submissionCount === 1 ? 'submission' : 'submissions'}
                </p>
              </div>
              <button
                className="secondaryAction"
                disabled={restoringId !== null}
                onClick={() => void restore(event)}
              >
                {restoringId === event.id ? 'Restoring…' : 'Restore playlist'}
              </button>
            </article>
          ))}
        </div>
      ) : (
        <p>Trash is empty.</p>
      )}
    </section>
  );
}
