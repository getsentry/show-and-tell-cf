import '@testing-library/jest-dom/vitest';
import {render, screen, cleanup, fireEvent} from '@testing-library/react';
import {afterEach, expect, it, vi} from 'vitest';
import {App} from '../../src/app/App';
import {
  eventSlug,
  eventIdFromPath,
  safeReturnTo,
  submissionPath,
} from '../../src/shared/playlist';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});
it('normalizes slug labels and keeps identity independent of the label', () => {
  expect(eventSlug('Über / October & Friends!')).toBe('uber-october-friends');
  expect(eventSlug('🎉')).toBe('show-and-tell');
  expect(submissionPath('id', 'October!')).toBe('/events/id/october');
  expect(eventIdFromPath('/events/id/old-label')).toBe('id');
  for (const path of [
    '//evil.test',
    '/events/id/../../evil',
    '/events/id/%2f',
    '/events/id/slug?next=evil',
    '/events/id/slug/extra',
  ])
    expect(safeReturnTo(path)).toBe('/');
});
it('preserves a nice submission URL through sign-in', async () => {
  window.history.replaceState(null, '', '/events/id/october-special');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', {status: 401})),
  );
  render(<App />);
  expect(await screen.findByRole('link', {name: 'Continue with Google'})).toHaveAttribute(
    'href',
    '/api/auth/login?returnTo=%2Fevents%2Fid%2Foctober-special',
  );
});
it.each([null, '2030-09-01T00:00:00Z'])(
  'opens and shares an unlisted show with cancellation %s and appropriate visibility controls',
  async (cancelledAt) => {
    window.history.replaceState(null, '', '/events/id/old-label');
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', {clipboard: {writeText}});
    const fetcher = vi.fn(async (url: string) => {
      if (url === '/api/session')
        return Response.json({
          user: {
            id: 'admin',
            email: 'admin@sentry.io',
            displayName: 'Admin',
            role: 'admin',
            actualRole: 'admin',
            avatarUrl: null,
          },
        });
      if (url === '/api/events') return Response.json({events: []});
      if (url === '/api/events/id')
        return Response.json({
          event: {
            id: 'id',
            title: 'Special Show',
            slug: 'october-special',
            hidden: true,
            cancelledAt,
            submissionCount: 0,
          },
          submissions: [],
        });
      throw new Error(`Unexpected URL ${url}`);
    });
    vi.stubGlobal('fetch', fetcher);
    render(<App />);
    expect(
      await screen.findByRole('heading', {name: 'Special Show'}),
    ).toBeInTheDocument();
    expect(window.location.pathname).toBe('/events/id/october-special');
    if (cancelledAt) {
      expect(
        screen.queryByRole('button', {name: 'Show on overview'}),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', {name: 'Hide from overview'}),
      ).not.toBeInTheDocument();
      expect(
        screen.getByText(
          'This show was canceled. Its submissions and links are still available.',
        ),
      ).toBeInTheDocument();
      expect(
        screen.queryByText('Hidden from overview. This link still works.'),
      ).not.toBeInTheDocument();
    } else {
      expect(screen.getByRole('button', {name: 'Show on overview'})).toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole('button', {name: 'Copy submission link'}));
    expect(writeText).toHaveBeenCalledWith(
      `${window.location.origin}/events/id/october-special`,
    );
    expect(screen.getByRole('link', {name: 'Open the screening'})).toHaveAttribute(
      'href',
      '/playlists/id/october-special',
    );
  },
);
