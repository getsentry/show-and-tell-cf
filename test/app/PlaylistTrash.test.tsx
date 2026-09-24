import '@testing-library/jest-dom/vitest';
import {act, cleanup, fireEvent, render, screen} from '@testing-library/react';
import {afterEach, expect, it, vi} from 'vitest';
import {PlaylistTrash} from '../../src/app/PlaylistTrash';

const event = {id: 'show', title: 'Test show', submissionCount: 1};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('retries loading and preserves the restore control on failure', async () => {
  let failLoad = true;
  let failRestore = true;
  const restored = vi.fn(async () => {});
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/events?trash=true')
        return failLoad
          ? Response.json({error: {message: 'Load failed'}}, {status: 503})
          : Response.json({events: [event]});
      return failRestore
        ? Response.json({error: {message: 'Restore failed'}}, {status: 503})
        : new Response(null, {status: 204});
    }),
  );
  render(<PlaylistTrash onRestored={restored} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Load failed');
  failLoad = false;
  fireEvent.click(screen.getByRole('button', {name: 'Retry'}));
  fireEvent.click(await screen.findByRole('button', {name: 'Restore playlist'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('Restore failed');
  expect(restored).not.toHaveBeenCalled();
  failRestore = false;
  fireEvent.click(screen.getByRole('button', {name: 'Restore playlist'}));
  expect(await screen.findByText('Trash is empty.')).toBeInTheDocument();
  expect(restored).toHaveBeenCalledTimes(1);
});

it('locks duplicate restores and refreshes the overview even after closing trash', async () => {
  let finish: (response: Response) => void = () => {};
  const pending = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  const restored = vi.fn(async () => {});
  const fetcher = vi.fn(async (url: string) =>
    url === '/api/events?trash=true' ? Response.json({events: [event]}) : pending,
  );
  vi.stubGlobal('fetch', fetcher);
  const view = render(<PlaylistTrash onRestored={restored} />);
  const button = await screen.findByRole('button', {name: 'Restore playlist'});
  fireEvent.click(button);
  fireEvent.click(button);
  expect(button).toBeDisabled();
  expect(fetcher.mock.calls.filter(([url]) => url.endsWith('/restore'))).toHaveLength(1);
  view.unmount();
  await act(async () => finish(new Response(null, {status: 204})));
  expect(restored).toHaveBeenCalledTimes(1);
});
