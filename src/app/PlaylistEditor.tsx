import {useEffect, useRef, useState, type FormEvent} from 'react';

import type {ShowAndTellEvent} from '../shared/events';
import {api, json} from './api';
import {ConfirmDialog} from './components/ConfirmDialog';

export function PlaylistEditor({
  event,
  onSaved,
  onTrashed,
  onCancel,
}: {
  event: ShowAndTellEvent;
  onSaved: (event: ShowAndTellEvent) => void;
  onTrashed: (id: string) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(event.title);
  const [description, setDescription] = useState(event.description ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmTrash, setConfirmTrash] = useState(false);
  const [trashError, setTrashError] = useState<string | null>(null);
  const pending = useRef(false);
  const mounted = useRef(true);
  const titleInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    mounted.current = true;
    titleInput.current?.focus();
    return () => {
      mounted.current = false;
    };
  }, []);

  async function save(submit: FormEvent<HTMLFormElement>) {
    submit.preventDefault();
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await api<{event: ShowAndTellEvent}>(
        `/events/${event.id}`,
        json('PUT', {title, description}),
      );
      onSaved(result.event);
    } catch (cause) {
      if (mounted.current)
        setError(cause instanceof Error ? cause.message : 'Could not save playlist.');
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function trash() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setTrashError(null);
    try {
      await api(`/events/${event.id}/trash`, {method: 'POST'});
      onTrashed(event.id);
    } catch (cause) {
      if (mounted.current)
        setTrashError(
          cause instanceof Error ? cause.message : 'Could not move playlist to trash.',
        );
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <section className="playlistEditor" aria-label="Edit playlist">
      <h2>Edit Playlist</h2>
      <form
        className="newPlaylist"
        aria-label="Edit playlist"
        onSubmit={(submit) => void save(submit)}
      >
        <label>
          Playlist title
          <input
            ref={titleInput}
            name="title"
            required
            maxLength={120}
            value={title}
            disabled={busy}
            onChange={(change) => setTitle(change.target.value)}
          />
        </label>
        <label>
          Playlist description (optional)
          <textarea
            name="description"
            rows={3}
            maxLength={1000}
            value={description}
            disabled={busy}
            onChange={(change) => setDescription(change.target.value)}
          />
        </label>
        <p className="formHint">
          Share links, videos, and the show schedule stay unchanged. Previously sent
          reminders are not updated or resent.
        </p>
        {error ? (
          <p role="alert" className="inlineError">
            {error}
          </p>
        ) : null}
        <div className="playlistEditorActions">
          <button
            className="primaryAction"
            type="submit"
            disabled={busy || !title.trim()}
          >
            {busy && !confirmTrash ? 'Saving…' : 'Save changes'}
          </button>
          <button type="button" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
      <div className="playlistEditorTrash">
        <h3>Trash Playlist</h3>
        <p className="formHint">
          Remove this playlist without deleting its submissions or videos. Admins can
          restore it from Trash.
        </p>
        <button
          className="dangerAction"
          disabled={busy}
          onClick={() => {
            setTrashError(null);
            setConfirmTrash(true);
          }}
        >
          Move to trash
        </button>
      </div>
      {confirmTrash ? (
        <ConfirmDialog
          title={`Move “${event.title}” to trash?`}
          description="This playlist will leave the overview, and its links and reminders will stop working. Submissions and videos are kept. Unsaved edits will be discarded. Admins can restore it from Trash."
          confirmLabel={busy ? 'Moving…' : 'Move playlist to trash'}
          cancelLabel="Keep playlist"
          busy={busy}
          error={trashError}
          onConfirm={() => void trash()}
          onCancel={() => setConfirmTrash(false)}
        />
      ) : null}
    </section>
  );
}
