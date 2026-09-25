import {useRef, useState} from 'react';
import type {Submission} from '../shared/events';
import {api, errorMessage} from './api';
import {ArrowIcon} from './components/ArrowIcon';

export function PlaylistOrder({
  eventId,
  submissions,
  onOrdered,
}: {
  eventId: string;
  submissions: Submission[];
  onOrdered: () => Promise<void>;
}) {
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function move(index: number, offset: number) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    const expectedIds = submissions.map((entry) => entry.id);
    const ids = [...expectedIds];
    [ids[index], ids[index + offset]] = [ids[index + offset], ids[index]];
    try {
      await api(`/events/${encodeURIComponent(eventId)}/order`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ids, expectedIds}),
      });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      // Refresh on conflict too, keeping the stale write fence server-side.
      await onOrdered();
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <details className="playlistOrder">
      <summary>Arrange playlist</summary>
      <p className="formHint">
        Changes save immediately. Hidden and unfinished submissions keep their place but
        do not play.
      </p>
      {error ? (
        <p className="inlineError" role="alert">
          {error}
        </p>
      ) : null}
      <ol>
        {submissions.map((entry, index) => (
          <li key={entry.id}>
            <span>
              {entry.title}
              {entry.hidden ? ' · hidden' : ''}
            </span>
            <button
              disabled={busy || index === 0}
              aria-label={`Move ${entry.title} up`}
              onClick={() => void move(index, -1)}
            >
              <ArrowIcon direction="up" />
            </button>
            <button
              disabled={busy || index === submissions.length - 1}
              aria-label={`Move ${entry.title} down`}
              onClick={() => void move(index, 1)}
            >
              <ArrowIcon direction="down" />
            </button>
          </li>
        ))}
      </ol>
      {busy ? (
        <p className="formHint" role="status">
          Saving order…
        </p>
      ) : null}
    </details>
  );
}
