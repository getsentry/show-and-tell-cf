import '@testing-library/jest-dom/vitest';
import {act, cleanup, fireEvent, render, screen} from '@testing-library/react';
import {afterEach, expect, it, vi} from 'vitest';
import {PlaylistEditor} from '../../src/app/PlaylistEditor';

const event = {
  id: 'show',
  title: 'Original title',
  description: 'Original description',
  createdAt: '2026-01-01',
  submissionCount: 2,
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('keeps failed edits, locks save/trash while saving, and retries without duplicate writes', async () => {
  let resolve: (response: Response) => void = () => {};
  const pending = new Promise<Response>((done) => {
    resolve = done;
  });
  const fetcher = vi.fn(() => pending);
  vi.stubGlobal('fetch', fetcher);
  const saved = vi.fn();
  render(
    <PlaylistEditor
      event={event}
      onSaved={saved}
      onTrashed={vi.fn()}
      onCancel={vi.fn()}
    />,
  );
  expect(screen.getByRole('textbox', {name: 'Playlist title'})).toHaveFocus();
  fireEvent.change(screen.getByRole('textbox', {name: 'Playlist title'}), {
    target: {value: 'Edited title'},
  });
  fireEvent.submit(screen.getByRole('form'));
  fireEvent.submit(screen.getByRole('form'));
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', {name: 'Move to trash'})).toBeDisabled();
  expect(screen.getByRole('button', {name: 'Cancel'})).toBeDisabled();
  await act(async () =>
    resolve(Response.json({error: {message: 'Try again'}}, {status: 503})),
  );
  expect(screen.getByRole('alert')).toHaveTextContent('Try again');
  expect(screen.getByRole('textbox', {name: 'Playlist title'})).toHaveValue(
    'Edited title',
  );
  expect(saved).not.toHaveBeenCalled();
  fetcher.mockResolvedValue(Response.json({event: {...event, title: 'Edited title'}}));
  fireEvent.click(screen.getByRole('button', {name: 'Save changes'}));
  await act(async () => {});
  expect(saved).toHaveBeenCalledWith({...event, title: 'Edited title'});
});

it('trashes the saved playlist without submitting unsaved edits', async () => {
  const fetcher = vi.fn(async () => new Response(null, {status: 204}));
  vi.stubGlobal('fetch', fetcher);
  const trashed = vi.fn();
  const saved = vi.fn();
  render(
    <PlaylistEditor
      event={event}
      onSaved={saved}
      onTrashed={trashed}
      onCancel={vi.fn()}
    />,
  );
  fireEvent.change(screen.getByRole('textbox', {name: 'Playlist title'}), {
    target: {value: 'Unsaved'},
  });
  fireEvent.click(screen.getByRole('button', {name: 'Move to trash'}));
  expect(screen.getByRole('dialog')).toHaveAccessibleName(
    'Move “Original title” to trash?',
  );
  expect(screen.getByRole('dialog')).toHaveTextContent('Unsaved edits will be discarded');
  fireEvent.click(screen.getByRole('button', {name: 'Move playlist to trash'}));
  await act(async () => {});
  expect(fetcher).toHaveBeenCalledWith('/api/events/show/trash', {method: 'POST'});
  expect(saved).not.toHaveBeenCalled();
  expect(trashed).toHaveBeenCalledWith('show');
});
