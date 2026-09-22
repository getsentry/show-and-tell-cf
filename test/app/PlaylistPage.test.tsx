import '@testing-library/jest-dom/vitest';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {App} from '../../src/app/App';
import {PlaylistPage, SharePlaylist} from '../../src/app/PlaylistPage';
import {PlaylistOrder} from '../../src/app/PlaylistOrder';
import type {PlaylistResponse} from '../../src/shared/playlist';
import type {Submission} from '../../src/shared/events';
import type {SessionUser} from '../../src/shared/api';
import type {PlaybackResponse} from '../../src/shared/videos';

const viewer: SessionUser = {
  id: 'u',
  email: 'u@sentry.io',
  displayName: 'Viewer',
  role: 'member',
  actualRole: 'member',
  avatarUrl: null,
};
const playlist: PlaylistResponse = {
  event: {id: 'event', title: 'September Show & Tell', description: null},
  items: ['a', 'b'].map((id) => ({
    videoId: id,
    submissionId: id,
    title: `Demo ${id}`,
    creatorName: 'Team',
    description: null,
    durationSeconds: 60,
  })),
};
type TestBody =
  | PlaylistResponse
  | PlaybackResponse
  | {user: SessionUser}
  | {error?: {message: string}};
const play = vi.fn<() => Promise<void>>();
const response = (body: TestBody, status = 200) =>
  new Response(JSON.stringify(body), {status});
beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  play.mockReset().mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(play);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

describe('playlist page', () => {
  it('keeps shared playlist destinations through the Google sign-in link', async () => {
    window.history.replaceState(null, '', '/playlists/event');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, {status: 401})),
    );
    render(<App />);
    expect(
      await screen.findByRole('link', {name: 'Continue with Google'}),
    ).toHaveAttribute('href', '/api/auth/login?returnTo=%2Fplaylists%2Fevent');
  });
  it('loads a shared screening rather than the editor and starts on a user gesture', async () => {
    window.history.replaceState(null, '', '/playlists/event');
    const fetch = vi.fn(async (url: string) => {
      if (url === '/api/session') return response({user: viewer});
      if (url === '/api/events/event/playlist') return response(playlist);
      return response({source: {kind: 'mp4', url: '/content'}, expiresAt: null});
    });
    vi.stubGlobal('fetch', fetch);
    render(<App />);
    expect(
      await screen.findByRole('heading', {name: 'September Show & Tell', level: 1}),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('form', {name: 'Create submission'}),
    ).not.toBeInTheDocument();
    expect(play).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', {name: 'Play all'}));
    // Every clip is announced on a title card first; the countdown can be skipped.
    await waitFor(
      () => expect(screen.getByRole('button', {name: 'Start now'})).toBeEnabled(),
      {timeout: 3000},
    );
    expect(screen.getByText('Up next')).toBeInTheDocument();
    expect(screen.getByRole('heading', {name: 'Demo a'})).toBeInTheDocument();
    expect(play).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith(
      '/api/events/event/playlist/a/playback',
      undefined,
    );
    fireEvent.click(screen.getByRole('button', {name: 'Start now'}));
    await waitFor(
      () => expect(screen.getByRole('button', {name: 'Pause'})).toBeEnabled(),
      {timeout: 3000},
    );
    expect(play).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', {name: 'Next'}));
    await waitFor(
      () => expect(screen.getByRole('button', {name: 'Finish'})).toBeEnabled(),
      {timeout: 3000},
    );
    expect(screen.getByRole('heading', {name: 'Demo b'})).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', {name: 'Finish'}));
    expect(screen.getByText('That’s a wrap')).toBeInTheDocument();
    // The wrap card and the control bar both offer a replay.
    fireEvent.click(screen.getAllByRole('button', {name: 'Play again'})[0]);
    await waitFor(
      () => expect(screen.getByRole('button', {name: 'Start now'})).toBeEnabled(),
      {timeout: 3000},
    );
    expect(screen.getByRole('heading', {name: 'Demo a'})).toBeInTheDocument();
  });
  it('skips the countdown, mutes, and steps through clips with keyboard shortcuts', async () => {
    window.history.replaceState(null, '', '/playlists/event');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url === '/api/events/event/playlist'
          ? response(playlist)
          : response({source: {kind: 'mp4', url: '/content'}, expiresAt: null}),
      ),
    );
    render(<PlaylistPage eventId="event" user={viewer} />);
    fireEvent.click(await screen.findByRole('button', {name: 'Play all'}));
    await waitFor(
      () => expect(screen.getByRole('button', {name: 'Start now'})).toBeEnabled(),
      {timeout: 3000},
    );
    fireEvent.keyDown(window, {code: 'Space', key: ' '});
    await waitFor(
      () => expect(screen.getByRole('button', {name: 'Pause'})).toBeEnabled(),
      {timeout: 3000},
    );
    fireEvent.keyDown(window, {code: 'KeyM', key: 'm'});
    expect(screen.getByRole('button', {name: 'Unmute'})).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    fireEvent.keyDown(window, {code: 'ArrowRight', key: 'ArrowRight'});
    await waitFor(() =>
      expect(screen.getByRole('heading', {name: 'Demo b'})).toBeInTheDocument(),
    );
    fireEvent.keyDown(window, {code: 'ArrowLeft', key: 'ArrowLeft'});
    await waitFor(() =>
      expect(screen.getByRole('heading', {name: 'Demo a'})).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', {name: 'Unmute'})).toBeInTheDocument();
  });
  it('recovers from load failures and renders a stable empty playlist', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response({}, 500))
      .mockResolvedValueOnce(response({...playlist, items: []}));
    vi.stubGlobal('fetch', fetch);
    render(<PlaylistPage eventId="event" user={viewer} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('500');
    fireEvent.click(screen.getByRole('button', {name: 'Retry loading'}));
    expect(await screen.findByText(/No videos are ready/)).toBeInTheDocument();
    expect(screen.queryByRole('button', {name: 'Play all'})).not.toBeInTheDocument();
  });
  it('reports unavailable fullscreen and provides a clipboard fallback', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(playlist)),
    );
    render(<PlaylistPage eventId="event" user={viewer} />);
    fireEvent.click(await screen.findByRole('button', {name: 'Fullscreen'}));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Fullscreen is unavailable',
    );
    cleanup();
    render(<SharePlaylist eventId="event" />);
    fireEvent.click(screen.getByRole('button', {name: 'Copy playlist link'}));
    expect(await screen.findByRole('status')).toHaveTextContent('/playlists/event');
  });
});

describe('submission sharing', () => {
  it('copies a submission link and offers a fallback when clipboard access fails', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', {clipboard: {writeText}});
    render(<SharePlaylist eventId="event" kind="submission" />);
    fireEvent.click(screen.getByRole('button', {name: 'Copy submission link'}));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/events/event`),
    );
    expect(await screen.findByRole('status')).toHaveTextContent('Link copied');
    writeText.mockRejectedValue(new Error('denied'));
    fireEvent.click(screen.getByRole('button', {name: 'Copy submission link'}));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        `Copy this link: ${window.location.origin}/events/event`,
      ),
    );
  });
});

describe('admin ordering controls', () => {
  const submissions: Submission[] = ['a', 'b'].map((id) => ({
    id,
    eventId: 'event',
    creatorId: 'u',
    creatorName: 'User',
    creatorAvatarUrl: null,
    title: id,
    description: null,
    hidden: false,
    createdAt: '2026-01-01',
  }));
  it('sends a full expected order and serializes saves while refreshing', async () => {
    let resolve!: (r: Response) => void;
    const fetch = vi.fn(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    vi.stubGlobal('fetch', fetch);
    const refreshed = vi.fn(async () => {});
    render(
      <PlaylistOrder eventId="event" submissions={submissions} onOrdered={refreshed} />,
    );
    fireEvent.click(screen.getByText('Arrange playlist'));
    fireEvent.click(screen.getByRole('button', {name: 'Move a down'}));
    expect(screen.getByRole('button', {name: 'Move b up'})).toBeDisabled();
    expect(fetch.mock.calls[0]).toMatchObject([
      '/api/events/event/order',
      {method: 'PUT', body: JSON.stringify({ids: ['b', 'a'], expectedIds: ['a', 'b']})},
    ]);
    resolve(new Response(null, {status: 204}));
    await waitFor(() => expect(refreshed).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(screen.getByRole('button', {name: 'Move a down'})).toBeEnabled(),
    );
  });
  it('shows ordering conflicts and refreshes the snapshot', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response({error: {message: 'Playlist changed'}}, 409)),
    );
    const refreshed = vi.fn(async () => {});
    render(
      <PlaylistOrder eventId="event" submissions={submissions} onOrdered={refreshed} />,
    );
    fireEvent.click(screen.getByText('Arrange playlist'));
    fireEvent.click(screen.getByRole('button', {name: 'Move b up'}));
    expect(await screen.findByRole('alert')).toHaveTextContent('Playlist changed');
    expect(refreshed).toHaveBeenCalledOnce();
  });
});
