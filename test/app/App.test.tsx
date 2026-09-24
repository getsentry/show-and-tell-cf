import '@testing-library/jest-dom/vitest';
import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {App, defaultPlaylistTitle} from '../../src/app/App';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

describe('App', () => {
  it.each(['/', '/events/october'])(
    'edits title and description from %s without changing links',
    async (path) => {
      let saved = false;
      const updated = {
        ...october,
        title: 'Updated show',
        description: 'Updated description',
      };
      const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/api/session') return jsonResponse({user: admin});
        if (url === '/api/events')
          return Response.json({events: [saved ? updated : october]});
        if (url === '/api/events/october') {
          if (init?.method === 'PUT') {
            saved = true;
            return Response.json({event: updated});
          }
          return Response.json({event: saved ? updated : october, submissions: []});
        }
        throw new Error(url);
      });
      vi.stubGlobal('fetch', fetcher);
      window.history.replaceState(null, '', path);
      render(<App />);
      fireEvent.click(await screen.findByRole('button', {name: 'Edit playlist'}));
      expect(screen.getByRole('textbox', {name: 'Playlist title'})).toHaveValue(
        october.title,
      );
      fireEvent.change(screen.getByRole('textbox', {name: 'Playlist title'}), {
        target: {value: 'Discard me'},
      });
      fireEvent.click(screen.getByRole('button', {name: 'Cancel'}));
      expect(fetcher.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
      fireEvent.click(screen.getByRole('button', {name: 'Edit playlist'}));
      expect(screen.getByRole('textbox', {name: 'Playlist title'})).toHaveValue(
        october.title,
      );
      fireEvent.change(screen.getByRole('textbox', {name: 'Playlist title'}), {
        target: {value: 'Updated show'},
      });
      fireEvent.change(
        screen.getByRole('textbox', {name: 'Playlist description (optional)'}),
        {target: {value: 'Updated description'}},
      );
      fireEvent.click(screen.getByRole('button', {name: 'Save changes'}));
      await waitFor(() =>
        expect(
          screen.queryByRole('form', {name: 'Edit playlist'}),
        ).not.toBeInTheDocument(),
      );
      expect(screen.getByRole('heading', {name: 'Updated show'})).toBeInTheDocument();
      expect(screen.getByText('Updated description')).toBeInTheDocument();
      expect(window.location.pathname).toBe(path);
      expect(
        fetcher.mock.calls.find(([, init]) => init?.method === 'PUT')?.[1]?.body,
      ).toBe(JSON.stringify({title: 'Updated show', description: 'Updated description'}));
      expect(
        screen.getByRole('link', {
          name: path === '/' ? 'Watch playlist' : 'Open the screening',
        }),
      ).toHaveAttribute('href', '/playlists/october');
    },
  );

  it('confirms playlist trash, preserves the page on failure, and restores from the overview', async () => {
    let trashed = false;
    let fail = true;
    const pending = deferred<Response>();
    const fetcher = vi.fn(async (url: string) => {
      if (url === '/api/session') return jsonResponse({user: admin});
      if (url === '/api/events') return jsonResponse({events: trashed ? [] : [october]});
      if (url === '/api/events?trash=true')
        return jsonResponse({events: trashed ? [october] : []});
      if (url === '/api/events/october') return jsonResponse(detailFor(october));
      if (url === '/api/events/october/trash') {
        if (fail) return pending.promise;
        trashed = true;
        return new Response(null, {status: 204});
      }
      if (url === '/api/events/october/restore') {
        trashed = false;
        return new Response(null, {status: 204});
      }
      throw new Error(url);
    });
    vi.stubGlobal('fetch', fetcher);
    window.history.replaceState(null, '', '/events/october');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', {name: 'Edit playlist'}));
    fireEvent.click(screen.getByRole('button', {name: 'Move to trash'}));
    expect(screen.getByRole('dialog')).toHaveTextContent(
      'Submissions and videos are kept',
    );
    expect(screen.getByRole('button', {name: 'Keep playlist'})).toHaveFocus();
    fireEvent.click(screen.getByRole('button', {name: 'Keep playlist'}));
    expect(fetcher.mock.calls.some(([url]) => url.endsWith('/trash'))).toBe(false);
    fireEvent.click(screen.getByRole('button', {name: 'Move to trash'}));
    fireEvent.click(screen.getByRole('button', {name: 'Move playlist to trash'}));
    expect(screen.getByRole('button', {name: 'Moving…'})).toBeDisabled();
    expect(screen.getByRole('button', {name: 'Keep playlist'})).toBeDisabled();
    await act(async () =>
      pending.resolve(Response.json({error: {message: 'Try again'}}, {status: 503})),
    );
    expect(screen.getByRole('dialog')).toHaveTextContent('Try again');
    expect(window.location.pathname).toBe('/events/october');
    fail = false;
    fireEvent.click(screen.getByRole('button', {name: 'Move playlist to trash'}));
    await waitFor(() => expect(window.location.pathname).toBe('/'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('article', {name: october.title})).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', {name: 'View trash'}));
    fireEvent.click(await screen.findByRole('button', {name: 'Restore playlist'}));
    expect(await screen.findByText('Trash is empty.')).toBeInTheDocument();
    expect(await screen.findByRole('article', {name: october.title})).toBeInTheDocument();
  });

  it('does not expose playlist trash controls to members', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/session')
          return jsonResponse({user: {...admin, role: 'member', actualRole: 'member'}});
        if (url === '/api/events') return jsonResponse({events: [october]});
        if (url === '/api/events/october') return jsonResponse(detailFor(october));
        throw new Error(url);
      }),
    );
    render(<App />);
    fireEvent.click(await screen.findByRole('link', {name: 'Upload & submissions'}));
    await screen.findByRole('form', {name: 'Create submission'});
    expect(screen.queryByRole('button', {name: 'Move to trash'})).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('link', {name: '← All shows'}));
    expect(screen.queryByRole('button', {name: 'View trash'})).not.toBeInTheDocument();
    expect(screen.queryByRole('button', {name: 'Edit playlist'})).not.toBeInTheDocument();
  });
  it('shows only Loading while the session is pending, then clears it', async () => {
    const session = deferred<Response>();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => session.promise),
    );
    render(<App />);
    expect(screen.getByRole('status')).toHaveTextContent(/^Loading$/);
    expect(screen.getByRole('heading', {name: 'Loading'})).toBeInTheDocument();
    expect(
      screen.queryByText(/Loading Show & Tell|Checking your session/),
    ).not.toBeInTheDocument();
    await act(async () => session.resolve(new Response(null, {status: 401})));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByRole('link', {name: 'Continue with Google'})).toBeInTheDocument();
  });

  it('keeps deletion in a modal and locks retries until the request settles', async () => {
    const pending = deferred<Response>();
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/session') return jsonResponse({user: admin});
      if (url === '/api/events') return jsonResponse({events: [october]});
      if (url === '/api/events/october')
        return jsonResponse(detailFor(october, [submission]));
      if (url.endsWith('/video/upload')) return Response.json({upload: null});
      if (url.endsWith('/video')) return Response.json({video: null});
      if (init?.method === 'DELETE') return pending.promise;
      throw new Error(url);
    });
    vi.stubGlobal('fetch', fetcher);
    window.history.replaceState(null, '', '/events/october');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', {name: 'Delete'}));
    expect(screen.getByRole('dialog')).toHaveAccessibleName(
      'Delete this submission and its video?',
    );
    expect(screen.getByRole('button', {name: 'Keep submission'})).toHaveFocus();
    fireEvent.click(screen.getByRole('button', {name: 'Keep submission'}));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(fetcher.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
    fireEvent.click(screen.getByRole('button', {name: 'Delete'}));
    fireEvent.click(screen.getByRole('button', {name: 'Confirm delete'}));
    fireEvent.click(screen.getByRole('button', {name: 'Confirm delete'}));
    expect(screen.getByRole('button', {name: 'Keep submission'})).toBeDisabled();
    expect(
      fetcher.mock.calls.filter(([, init]) => init?.method === 'DELETE'),
    ).toHaveLength(1);
    await act(async () =>
      pending.resolve(Response.json({error: {message: 'Try again'}}, {status: 503})),
    );
    expect(screen.getByRole('dialog')).toContainElement(screen.getByRole('alert'));
    expect(screen.getByRole('alert')).toHaveTextContent('Try again');
    expect(screen.getByRole('button', {name: 'Confirm delete'})).toBeEnabled();
  });

  it('defaults new titles to the current local month and year', () => {
    expect(defaultPlaylistTitle(new Date(2026, 8, 22))).toBe(
      'Show & Tell September - 2026',
    );
    expect(defaultPlaylistTitle(new Date(2027, 0, 1))).toBe('Show & Tell January - 2027');
  });

  it('opens on the HTML overview, with watch and upload links and collapsed creation', async () => {
    const fetcher = mockOverview();
    render(<App />);
    expect(
      await screen.findByRole('article', {name: 'October 2026'}),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', {name: 'Show & Tell', level: 1}),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('link', {name: 'Watch playlist'})[0]).toHaveAttribute(
      'href',
      '/playlists/october',
    );
    expect(
      screen.getAllByRole('link', {name: 'Upload & submissions'})[0],
    ).toHaveAttribute('href', '/events/october');
    expect(screen.queryByText('Made at Sentry')).not.toBeInTheDocument();
    const credit = screen.getByRole('link', {name: 'made by Junior'});
    expect(credit).toHaveAttribute('href', 'https://junior.sentry.dev/');
    expect(credit.querySelector('img')).toHaveAttribute('src', '/junior-avatar.png');
    expect(screen.queryByRole('form')).not.toBeInTheDocument();
    expect(fetcher.mock.calls.map(([url]) => url)).not.toContain('/api/events/october');
    fireEvent.click(screen.getByRole('button', {name: 'New playlist'}));
    expect(screen.getByRole('textbox', {name: 'Title'})).toHaveValue(
      defaultPlaylistTitle(),
    );
    expect(screen.getByRole('button', {name: 'Cancel new playlist'})).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    fireEvent.click(screen.getByRole('button', {name: 'Cancel new playlist'}));
    expect(screen.queryByRole('form', {name: 'Create playlist'})).not.toBeInTheDocument();
  });

  it('navigates overview to submissions and supports browser back/forward without autoselection', async () => {
    mockOverview();
    render(<App />);
    fireEvent.click(
      (await screen.findAllByRole('link', {name: 'Upload & submissions'}))[1],
    );
    expect(
      await screen.findByRole('form', {name: 'Create submission'}),
    ).toBeInTheDocument();
    expect(window.location.pathname).toBe('/events/november');
    expect(screen.queryByRole('button', {name: 'New playlist'})).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('link', {name: '← All shows'}));
    expect(window.location.pathname).toBe('/');
    expect(
      screen.queryByRole('form', {name: 'Create submission'}),
    ).not.toBeInTheDocument();
    act(() => {
      window.history.replaceState(null, '', '/events/october');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(
      await screen.findByRole('heading', {name: 'October 2026', level: 1}),
    ).toBeInTheDocument();
    act(() => {
      window.history.replaceState(null, '', '/');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(
      await screen.findByRole('article', {name: 'October 2026'}),
    ).toBeInTheDocument();
  });

  it.each(['/events/october', '/?event=october'])(
    'preserves the submission destination through login: %s',
    async (path) => {
      window.history.replaceState(null, '', path);
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(new Response(null, {status: 401})),
      );
      render(<App />);
      expect(
        await screen.findByRole('link', {name: 'Continue with Google'}),
      ).toHaveAttribute('href', '/api/auth/login?returnTo=%2Fevents%2Foctober');
    },
  );

  it('switches effective role and clears admin data while retaining the current deep link', async () => {
    let memberView = false;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (url === '/api/session') return Promise.resolve(jsonResponse({user: admin}));
        if (url === '/api/session/view-mode') {
          memberView = init?.body === JSON.stringify({mode: 'member'});
          return Promise.resolve(
            jsonResponse({user: {...admin, role: memberView ? 'member' : 'admin'}}),
          );
        }
        if (url === '/api/events')
          return Promise.resolve(jsonResponse({events: [october]}));
        if (url === '/api/events/october')
          return Promise.resolve(
            jsonResponse(
              detailFor(october, memberView ? [] : [{...submission, hidden: true}]),
            ),
          );
        if (url.endsWith('/video/upload'))
          return Promise.resolve(new Response(JSON.stringify({upload: null})));
        if (url.endsWith('/video'))
          return Promise.resolve(new Response(JSON.stringify({video: null})));
        throw new Error(url);
      }),
    );
    window.history.replaceState(null, '', '/events/october');
    render(<App />);
    expect(
      await screen.findByRole('heading', {name: 'Project demo'}),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', {name: 'Switch to user view'}));
    expect(
      await screen.findByRole('button', {name: 'Back to admin'}),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', {name: 'Project demo'})).not.toBeInTheDocument();
    expect(window.location.pathname).toBe('/events/october');
    expect(
      await screen.findByRole('form', {name: 'Create submission'}),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', {name: 'Back to admin'}));
    expect(
      await screen.findByRole('heading', {name: 'Project demo'}),
    ).toBeInTheDocument();
  });

  it('does not navigate from a late event creation after switching views', async () => {
    const pending = deferred<Response>();
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (url === '/api/session') return Promise.resolve(jsonResponse({user: admin}));
        if (url === '/api/session/view-mode')
          return Promise.resolve(jsonResponse({user: {...admin, role: 'member'}}));
        if (url === '/api/events' && init?.method === 'POST') return pending.promise;
        if (url === '/api/events') return Promise.resolve(jsonResponse({events: []}));
        throw new Error(url);
      }),
    );
    render(<App />);
    fireEvent.click(await screen.findByRole('button', {name: 'New playlist'}));
    fireEvent.submit(screen.getByRole('form', {name: 'Create playlist'}));
    fireEvent.click(screen.getByRole('button', {name: 'Switch to user view'}));
    expect(
      await screen.findByRole('button', {name: 'Back to admin'}),
    ).toBeInTheDocument();
    await act(async () => pending.resolve(jsonResponse({event: october})));
    expect(window.location.pathname).toBe('/');
    expect(screen.queryByRole('form', {name: 'Create playlist'})).not.toBeInTheDocument();
  });

  it('keeps unsaved edits open when an earlier playlist create finishes', async () => {
    const pending = deferred<Response>();
    let created = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/api/session') return jsonResponse({user: admin});
        if (url === '/api/events') {
          if (init?.method === 'POST') return pending.promise;
          return jsonResponse({events: created ? [november, october] : [october]});
        }
        throw new Error(url);
      }),
    );
    render(<App />);
    fireEvent.click(await screen.findByRole('button', {name: 'New playlist'}));
    fireEvent.submit(screen.getByRole('form', {name: 'Create playlist'}));
    fireEvent.click(screen.getByRole('button', {name: 'Edit playlist'}));
    fireEvent.change(screen.getByRole('textbox', {name: 'Playlist title'}), {
      target: {value: 'Unsaved title'},
    });
    created = true;
    await act(async () => pending.resolve(jsonResponse({event: november})));
    expect(screen.getByRole('form', {name: 'Edit playlist'})).toBeInTheDocument();
    expect(screen.getByRole('textbox', {name: 'Playlist title'})).toHaveValue(
      'Unsaved title',
    );
    expect(window.location.pathname).toBe('/');
    fireEvent.click(screen.getByRole('button', {name: 'Cancel'}));
    expect(screen.getByRole('article', {name: november.title})).toBeInTheDocument();
    expect(screen.getByRole('article', {name: october.title})).toBeInTheDocument();
  });

  it('never exposes admin controls to a member on the overview', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        Promise.resolve(
          jsonResponse(
            url === '/api/session'
              ? {user: {...admin, role: 'member', actualRole: 'member'}}
              : {events: [october]},
          ),
        ),
      ),
    );
    render(<App />);
    expect(
      await screen.findByRole('article', {name: 'October 2026'}),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', {name: 'New playlist'})).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', {name: /admin|user view/i}),
    ).not.toBeInTheDocument();
  });

  it('shows view-switch failures without changing the view', async () => {
    mockOverview(true);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', {name: 'Switch to user view'}));
    expect(await screen.findByRole('alert')).toHaveTextContent('Request failed (500)');
    expect(screen.getByRole('button', {name: 'Switch to user view'})).toBeEnabled();
    expect(screen.getByRole('button', {name: 'New playlist'})).toBeInTheDocument();
  });

  it('shows Google avatars on submissions, with initials after an image failure', async () => {
    mockOverview();
    window.history.replaceState(null, '', '/events/october');
    render(<App />);
    const card = await screen.findByRole('article', {name: 'Project demo'});
    const image = card.querySelector('img')!;
    expect(image).toHaveAttribute('src', 'https://example.test/avatar.jpg');
    expect(image).toHaveAttribute('referrerpolicy', 'no-referrer');
    fireEvent.error(image);
    expect(card.querySelector('img')).toBeNull();
    expect(card.querySelector('.avatar')).toHaveTextContent('A');
    expect(
      screen.queryByText('Switching playlists pauses uploads.'),
    ).not.toBeInTheDocument();
  });
  it('introduces the Show & Tell application', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, {status: 401})));
    render(<App />);
    expect(await screen.findByRole('heading', {name: 'Show & Tell'})).toBeInTheDocument();
    expect(screen.queryByText('Sentry internal')).not.toBeInTheDocument();
    expect(
      screen.queryByText(
        'Sign in with your Sentry Google account to watch and share demo videos.',
      ),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('link', {name: 'Continue with Google'})).toHaveAttribute(
      'href',
      '/api/auth/login',
    );
  });

  it('explains forbidden Google accounts', async () => {
    window.history.replaceState(null, '', '/?auth_error=forbidden');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, {status: 401})));

    render(<App />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Use a Sentry Google account to sign in.',
    );
  });

  it('explains failed Google sign-in', async () => {
    window.history.replaceState(null, '', '/?auth_error=failed');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, {status: 401})));

    render(<App />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Google sign-in failed. Please try again.',
    );
  });

  it('shows load failures without a contradictory loading state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url.endsWith('/video/upload'))
          return Promise.resolve(new Response(JSON.stringify({upload: null})));
        if (url.endsWith('/video'))
          return Promise.resolve(new Response(JSON.stringify({video: null})));
        if (url === '/api/session') return Promise.resolve(jsonResponse({user: admin}));
        if (url === '/api/events')
          return Promise.resolve(new Response(null, {status: 500}));
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    render(<App />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Request failed (500)');
    expect(screen.queryByText('Loading playlist…')).not.toBeInTheDocument();
    expect(screen.getByRole('button', {name: 'Retry'})).toBeInTheDocument();
  });

  it('clears the error when a playlists retry returns an empty list', async () => {
    let attempts = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url.endsWith('/video/upload'))
          return Promise.resolve(new Response(JSON.stringify({upload: null})));
        if (url.endsWith('/video'))
          return Promise.resolve(new Response(JSON.stringify({video: null})));
        if (url === '/api/session') return Promise.resolve(jsonResponse({user: admin}));
        if (url === '/api/events') {
          attempts++;
          return Promise.resolve(
            attempts === 1
              ? new Response(null, {status: 500})
              : jsonResponse({events: []}),
          );
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    render(<App />);
    fireEvent.click(await screen.findByRole('button', {name: 'Retry'}));

    expect(await screen.findByText('No Show & Tell playlists yet.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', {name: 'Retry'})).not.toBeInTheDocument();
  });

  it('recovers when the latest event-list request fails after a stale success', async () => {
    const staleSuccess = deferred<Response>();
    const latestFailure = deferred<Response>();
    let eventLoads = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (url.endsWith('/video/upload'))
          return Promise.resolve(new Response(JSON.stringify({upload: null})));
        if (url.endsWith('/video'))
          return Promise.resolve(new Response(JSON.stringify({video: null})));
        if (url === '/api/session') return Promise.resolve(jsonResponse({user: admin}));
        if (url === '/api/events' && init?.method === 'POST')
          return Promise.resolve(jsonResponse({event: october}));
        if (url === '/api/events') {
          eventLoads++;
          if (eventLoads === 1) return staleSuccess.promise;
          if (eventLoads === 2) return latestFailure.promise;
          return Promise.resolve(jsonResponse({events: [october]}));
        }
        if (url === '/api/events/october')
          return Promise.resolve(jsonResponse(detailFor(october)));
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    render(<App />);
    fireEvent.click(await screen.findByRole('button', {name: 'New playlist'}));
    fireEvent.submit(
      (await screen.findByRole('button', {name: 'Create playlist'})).closest('form')!,
    );
    await act(async () => latestFailure.resolve(new Response(null, {status: 500})));
    await act(async () => staleSuccess.resolve(jsonResponse({events: [october]})));

    expect(await screen.findByRole('button', {name: 'Retry'})).toBeInTheDocument();
    expect(screen.queryByText('Loading playlist…')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', {name: 'Retry'}));

    expect(await screen.findByRole('button', {name: /October 2026/})).toBeInTheDocument();
  });

  it('reports mutation failures and preserves form input', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (url.endsWith('/video/upload'))
          return Promise.resolve(new Response(JSON.stringify({upload: null})));
        if (url.endsWith('/video'))
          return Promise.resolve(new Response(JSON.stringify({video: null})));
        if (url === '/api/session') return Promise.resolve(jsonResponse({user: admin}));
        if (url === '/api/events' && init?.method === 'POST')
          return Promise.resolve(new Response(null, {status: 500}));
        if (url === '/api/events') return Promise.resolve(jsonResponse({events: []}));
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    render(<App />);
    fireEvent.click(await screen.findByRole('button', {name: 'New playlist'}));
    const title = await screen.findByLabelText('Title');
    fireEvent.change(title, {target: {value: 'October 2026'}});
    fireEvent.submit(
      screen.getByRole('button', {name: 'Create playlist'}).closest('form')!,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('Request failed (500)');
    expect(title).toHaveValue('October 2026');
    expect(screen.getByText('No Show & Tell playlists yet.')).toBeInTheDocument();
  });

  it('shows a loading state while the selected playlist is loading', async () => {
    const detail = deferred<Response>();
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url.endsWith('/video/upload'))
          return Promise.resolve(new Response(JSON.stringify({upload: null})));
        if (url.endsWith('/video'))
          return Promise.resolve(new Response(JSON.stringify({video: null})));
        if (url === '/api/session') return Promise.resolve(jsonResponse({user: admin}));
        if (url === '/api/events')
          return Promise.resolve(jsonResponse({events: [october]}));
        if (url === '/api/events/october') return detail.promise;
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    window.history.replaceState(null, '', '/events/october');
    render(<App />);

    expect(await screen.findByRole('button', {name: /October 2026/})).toBeInTheDocument();
    expect(screen.getByText('Loading playlist…')).toBeInTheDocument();
    expect(screen.queryByText('No Show & Tell playlists yet.')).not.toBeInTheDocument();
  });

  it('keeps retry available when the failed playlist is reselected', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url.endsWith('/video/upload'))
          return Promise.resolve(new Response(JSON.stringify({upload: null})));
        if (url.endsWith('/video'))
          return Promise.resolve(new Response(JSON.stringify({video: null})));
        if (url === '/api/session') return Promise.resolve(jsonResponse({user: admin}));
        if (url === '/api/events')
          return Promise.resolve(jsonResponse({events: [october]}));
        if (url === '/api/events/october')
          return Promise.resolve(new Response(null, {status: 500}));
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    window.history.replaceState(null, '', '/events/october');
    render(<App />);

    expect(await screen.findByRole('button', {name: 'Retry'})).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', {name: /October 2026/}));

    expect(screen.getByRole('button', {name: 'Retry'})).toBeInTheDocument();
    expect(screen.queryByText('Loading playlist…')).not.toBeInTheDocument();
  });

  it('offers a retry when playlist loading fails', async () => {
    let attempts = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url.endsWith('/video/upload'))
          return Promise.resolve(new Response(JSON.stringify({upload: null})));
        if (url.endsWith('/video'))
          return Promise.resolve(new Response(JSON.stringify({video: null})));
        if (url === '/api/session') return Promise.resolve(jsonResponse({user: admin}));
        if (url === '/api/events')
          return Promise.resolve(jsonResponse({events: [october]}));
        if (url === '/api/events/october') {
          attempts++;
          return Promise.resolve(
            attempts === 1
              ? new Response(null, {status: 500})
              : jsonResponse(detailFor(october)),
          );
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    window.history.replaceState(null, '', '/events/october');
    render(<App />);

    expect(await screen.findByText('Could not load this playlist.')).toBeInTheDocument();
    expect(screen.queryByText('Loading playlist…')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', {name: 'Retry'}));

    expect(
      await screen.findByRole('heading', {name: 'October 2026'}),
    ).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('resets and refreshes the playlist form after creation', async () => {
    const created = deferred<Response>();
    let eventLoads = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (url.endsWith('/video/upload'))
          return Promise.resolve(new Response(JSON.stringify({upload: null})));
        if (url.endsWith('/video'))
          return Promise.resolve(new Response(JSON.stringify({video: null})));
        if (url === '/api/session') return Promise.resolve(jsonResponse({user: admin}));
        if (url === '/api/events' && init?.method === 'POST') return created.promise;
        if (url === '/api/events') {
          eventLoads++;
          return Promise.resolve(
            jsonResponse({events: eventLoads === 1 ? [] : [october]}),
          );
        }
        if (url === '/api/events/october')
          return Promise.resolve(jsonResponse(detailFor(october)));
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    render(<App />);
    fireEvent.click(await screen.findByRole('button', {name: 'New playlist'}));
    const title = await screen.findByLabelText('Title');
    fireEvent.change(title, {target: {value: 'October 2026'}});
    fireEvent.submit(
      screen.getByRole('button', {name: 'Create playlist'}).closest('form')!,
    );

    await act(async () => created.resolve(jsonResponse({event: october})));

    await waitFor(() => expect(title).not.toBeInTheDocument());
    expect(window.location.pathname).toBe('/events/october');
    expect(await screen.findByRole('button', {name: /October 2026/})).toBeInTheDocument();
  });

  it('resets and refreshes the submission form after creation', async () => {
    const created = deferred<Response>();
    let detailLoads = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (url.endsWith('/video/upload'))
          return Promise.resolve(new Response(JSON.stringify({upload: null})));
        if (url.endsWith('/video'))
          return Promise.resolve(new Response(JSON.stringify({video: null})));
        if (url === '/api/session') return Promise.resolve(jsonResponse({user: admin}));
        if (url === '/api/events')
          return Promise.resolve(jsonResponse({events: [october]}));
        if (url.endsWith('/submissions') && init?.method === 'POST')
          return created.promise;
        if (url === '/api/events/october') {
          detailLoads++;
          return Promise.resolve(
            jsonResponse(detailFor(october, detailLoads > 1 ? [submission] : [])),
          );
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    window.history.replaceState(null, '', '/events/october');
    render(<App />);
    await screen.findByRole('form', {name: 'Create submission'});
    expect(screen.queryByRole('textbox', {name: 'Project link'})).not.toBeInTheDocument();
    const title = screen.getByRole('textbox', {name: 'Title'});
    fireEvent.change(title, {target: {value: 'Project demo'}});
    fireEvent.submit(
      screen.getByRole('button', {name: 'Create submission'}).closest('form')!,
    );

    await act(async () => created.resolve(jsonResponse({submission})));

    await waitFor(() => expect(title).toHaveValue(''));
    expect(
      await screen.findByRole('heading', {name: 'Project demo'}),
    ).toBeInTheDocument();
    expect(screen.getByRole('article', {name: 'Project demo'})).toHaveFocus();
    expect(await screen.findByLabelText('Choose video')).toBeInTheDocument();
  });

  it('creates a title-only submission once while the request is pending', async () => {
    const pending = deferred<Response>();
    const fetcher = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/session')
        return Promise.resolve(jsonResponse({user: {...admin, role: 'member'}}));
      if (url === '/api/events')
        return Promise.resolve(jsonResponse({events: [october]}));
      if (url === '/api/events/october')
        return Promise.resolve(jsonResponse(detailFor(october)));
      if (url.endsWith('/submissions') && init?.method === 'POST') return pending.promise;
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetcher);
    window.history.replaceState(null, '', '/events/october');
    render(<App />);
    const form = await screen.findByRole('form', {name: 'Create submission'});
    fireEvent.change(screen.getByLabelText('Title'), {target: {value: 'Demo'}});
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(screen.getByRole('button', {name: 'Saving…'})).toBeDisabled();
    const posts = fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0][1]?.body).toBe(JSON.stringify({title: 'Demo', description: ''}));
    await act(async () => pending.resolve(jsonResponse({submission})));
    expect(screen.getByRole('button', {name: 'Create submission'})).toBeEnabled();
    expect(screen.queryByRole('form', {name: 'Create playlist'})).not.toBeInTheDocument();
  });

  it('keeps playlist content usable after an event-list refresh failure', async () => {
    let eventLoads = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (url.endsWith('/video/upload'))
          return Promise.resolve(new Response(JSON.stringify({upload: null})));
        if (url.endsWith('/video'))
          return Promise.resolve(new Response(JSON.stringify({video: null})));
        if (url === '/api/session') return Promise.resolve(jsonResponse({user: admin}));
        if (url === '/api/events') {
          eventLoads++;
          return Promise.resolve(
            eventLoads === 1
              ? jsonResponse({events: [october, november]})
              : new Response(null, {status: 502}),
          );
        }
        if (url.endsWith('/visibility') && init?.method === 'POST')
          return Promise.resolve(new Response(null, {status: 204}));
        if (url === '/api/events/october')
          return Promise.resolve(jsonResponse(detailFor(october, [submission])));
        if (url === '/api/events/november')
          return Promise.resolve(jsonResponse(detailFor(november)));
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    window.history.replaceState(null, '', '/events/october');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', {name: 'Hide'}));

    expect(await screen.findByRole('alert')).toHaveTextContent('Request failed (502)');
    expect(screen.getByRole('heading', {name: 'October 2026'})).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', {name: /November 2026/}));
    expect(
      await screen.findByRole('heading', {name: 'November 2026'}),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', {name: 'Retry'})).toBeInTheDocument();
  });

  it('reports concurrent post-mutation refresh failures deterministically', async () => {
    let initialEvents = true;
    let initialDetail = true;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (url.endsWith('/video/upload'))
          return Promise.resolve(new Response(JSON.stringify({upload: null})));
        if (url.endsWith('/video'))
          return Promise.resolve(new Response(JSON.stringify({video: null})));
        if (url === '/api/session') return Promise.resolve(jsonResponse({user: admin}));
        if (url === '/api/events') {
          if (initialEvents) {
            initialEvents = false;
            return Promise.resolve(jsonResponse({events: [october]}));
          }
          return Promise.resolve(new Response(null, {status: 502}));
        }
        if (url.endsWith('/visibility') && init?.method === 'POST')
          return Promise.resolve(new Response(null, {status: 204}));
        if (url === '/api/events/october') {
          if (initialDetail) {
            initialDetail = false;
            return Promise.resolve(jsonResponse(detailFor(october, [submission])));
          }
          return Promise.resolve(new Response(null, {status: 503}));
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    window.history.replaceState(null, '', '/events/october');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', {name: 'Hide'}));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Request failed (502) · Request failed (503)',
    );
    expect(screen.getAllByRole('button', {name: 'Retry'})).toHaveLength(2);
  });

  it('offers retry when a post-mutation refresh fails', async () => {
    let detailLoads = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (url.endsWith('/video/upload'))
          return Promise.resolve(new Response(JSON.stringify({upload: null})));
        if (url.endsWith('/video'))
          return Promise.resolve(new Response(JSON.stringify({video: null})));
        if (url === '/api/session') return Promise.resolve(jsonResponse({user: admin}));
        if (url === '/api/events')
          return Promise.resolve(jsonResponse({events: [october]}));
        if (url.endsWith('/visibility') && init?.method === 'POST')
          return Promise.resolve(new Response(null, {status: 204}));
        if (url === '/api/events/october') {
          detailLoads++;
          if (detailLoads === 2)
            return Promise.resolve(new Response(null, {status: 500}));
          return Promise.resolve(jsonResponse(detailFor(october, [submission])));
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    window.history.replaceState(null, '', '/events/october');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', {name: 'Hide'}));

    expect(await screen.findByRole('button', {name: 'Retry'})).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', {name: 'Retry'}));

    expect(await screen.findByRole('button', {name: 'Hide'})).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('ignores stale event-list refresh responses', async () => {
    const staleEvents = deferred<Response>();
    let eventLoads = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (url.endsWith('/video/upload'))
          return Promise.resolve(new Response(JSON.stringify({upload: null})));
        if (url.endsWith('/video'))
          return Promise.resolve(new Response(JSON.stringify({video: null})));
        if (url === '/api/session') return Promise.resolve(jsonResponse({user: admin}));
        if (url === '/api/events') {
          eventLoads++;
          if (eventLoads === 2) return staleEvents.promise;
          const count = eventLoads === 1 ? 1 : 3;
          return Promise.resolve(
            jsonResponse({events: [{...october, submissionCount: count}]}),
          );
        }
        if (url.endsWith('/visibility') && init?.method === 'POST')
          return Promise.resolve(new Response(null, {status: 204}));
        if (url === '/api/events/october')
          return Promise.resolve(jsonResponse(detailFor(october, [submission])));
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    window.history.replaceState(null, '', '/events/october');
    render(<App />);
    const hide = await screen.findByRole('button', {name: 'Hide'});
    fireEvent.click(hide);
    fireEvent.click(hide);

    expect(await screen.findByText('3 submissions')).toBeInTheDocument();
    await act(async () =>
      staleEvents.resolve(jsonResponse({events: [{...october, submissionCount: 2}]})),
    );
    expect(screen.getByText('3 submissions')).toBeInTheDocument();
  });

  it('keeps current selection errors when an old mutation refreshes', async () => {
    const mutation = deferred<Response>();
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (url.endsWith('/video/upload'))
          return Promise.resolve(new Response(JSON.stringify({upload: null})));
        if (url.endsWith('/video'))
          return Promise.resolve(new Response(JSON.stringify({video: null})));
        if (url === '/api/session') return Promise.resolve(jsonResponse({user: admin}));
        if (url === '/api/events')
          return Promise.resolve(jsonResponse({events: [october, november]}));
        if (url.endsWith('/visibility') && init?.method === 'POST')
          return mutation.promise;
        if (url === '/api/events/october')
          return Promise.resolve(jsonResponse(detailFor(october, [submission])));
        if (url === '/api/events/november')
          return Promise.resolve(new Response(null, {status: 500}));
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    window.history.replaceState(null, '', '/events/october');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', {name: 'Hide'}));
    fireEvent.click(screen.getByRole('button', {name: /November 2026/}));
    expect(await screen.findByRole('button', {name: 'Retry'})).toBeInTheDocument();

    await act(async () => mutation.resolve(new Response(null, {status: 204})));

    expect(screen.getByRole('button', {name: 'Retry'})).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Request failed (500)');
  });

  it('keeps the current playlist loading when an old mutation refreshes', async () => {
    const mutation = deferred<Response>();
    const novemberDetail = deferred<Response>();
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (url.endsWith('/video/upload'))
          return Promise.resolve(new Response(JSON.stringify({upload: null})));
        if (url.endsWith('/video'))
          return Promise.resolve(new Response(JSON.stringify({video: null})));
        if (url === '/api/session') return Promise.resolve(jsonResponse({user: admin}));
        if (url === '/api/events')
          return Promise.resolve(jsonResponse({events: [october, november]}));
        if (url.endsWith('/visibility') && init?.method === 'POST')
          return mutation.promise;
        if (url === '/api/events/october')
          return Promise.resolve(jsonResponse(detailFor(october, [submission])));
        if (url === '/api/events/november') return novemberDetail.promise;
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    window.history.replaceState(null, '', '/events/october');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', {name: 'Hide'}));
    fireEvent.click(screen.getByRole('button', {name: /November 2026/}));

    await act(async () => mutation.resolve(new Response(null, {status: 204})));
    await act(async () => novemberDetail.resolve(jsonResponse(detailFor(november))));

    expect(
      await screen.findByRole('heading', {name: 'November 2026'}),
    ).toBeInTheDocument();
  });

  it('ignores a stale detail failure after a newer refresh succeeds', async () => {
    const staleDetail = deferred<Response>();
    let detailLoads = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url.endsWith('/video/upload'))
          return Promise.resolve(new Response(JSON.stringify({upload: null})));
        if (url.endsWith('/video'))
          return Promise.resolve(new Response(JSON.stringify({video: null})));
        if (url === '/api/session') return Promise.resolve(jsonResponse({user: admin}));
        if (url === '/api/events')
          return Promise.resolve(jsonResponse({events: [october, november]}));
        if (url === '/api/events/october') {
          detailLoads++;
          if (detailLoads === 1) return staleDetail.promise;
          return Promise.resolve(jsonResponse(detailFor(october, [submission])));
        }
        if (url === '/api/events/november')
          return Promise.resolve(jsonResponse(detailFor(november)));
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    window.history.replaceState(null, '', '/events/october');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', {name: /November 2026/}));
    fireEvent.click(screen.getByRole('button', {name: /October 2026/}));
    expect(
      await screen.findByRole('heading', {name: 'Project demo'}),
    ).toBeInTheDocument();

    await act(async () => staleDetail.resolve(new Response(null, {status: 500})));

    expect(screen.getByRole('heading', {name: 'Project demo'})).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('ignores a stale playlist response after switching playlists', async () => {
    const octoberDetail = deferred<Response>();
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url.endsWith('/video/upload'))
          return Promise.resolve(new Response(JSON.stringify({upload: null})));
        if (url.endsWith('/video'))
          return Promise.resolve(new Response(JSON.stringify({video: null})));
        if (url === '/api/session') return Promise.resolve(jsonResponse({user: admin}));
        if (url === '/api/events')
          return Promise.resolve(jsonResponse({events: [october, november]}));
        if (url === '/api/events/october') return octoberDetail.promise;
        if (url === '/api/events/november')
          return Promise.resolve(jsonResponse(detailFor(november)));
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    window.history.replaceState(null, '', '/events/october');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', {name: /November 2026/}));
    expect(
      await screen.findByRole('heading', {name: 'November 2026'}),
    ).toBeInTheDocument();

    await act(async () => octoberDetail.resolve(jsonResponse(detailFor(october))));

    expect(screen.getByRole('heading', {name: 'November 2026'})).toBeInTheDocument();
    expect(screen.queryByRole('heading', {name: 'October 2026'})).not.toBeInTheDocument();
  });
});

const admin = {
  id: 'user-1',
  email: 'admin@sentry.io',
  displayName: 'Admin',
  avatarUrl: null,
  role: 'admin',
  actualRole: 'admin',
};
const october = {
  id: 'october',
  title: 'October 2026',
  description: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  submissionCount: 0,
};
const november = {...october, id: 'november', title: 'November 2026'};
const submission = {
  id: 'submission-1',
  eventId: october.id,
  creatorId: admin.id,
  creatorName: admin.displayName,
  creatorAvatarUrl: 'https://example.test/avatar.jpg',
  title: 'Project demo',
  description: null,
  hidden: false,
  createdAt: '2026-10-01T00:00:00.000Z',
};

function detailFor(event: typeof october, submissions: (typeof submission)[] = []) {
  return {event, submissions};
}
type TestResponseBody =
  | {user: typeof admin}
  | {events: (typeof october)[]}
  | {event: typeof october}
  | {submission: typeof submission}
  | ReturnType<typeof detailFor>;

function jsonResponse(body: TestResponseBody) {
  return new Response(JSON.stringify(body), {
    headers: {'Content-Type': 'application/json'},
  });
}
function mockOverview(failSwitch = false) {
  const fetcher = vi.fn((url: string) => {
    if (url === '/api/session') return Promise.resolve(jsonResponse({user: admin}));
    if (url === '/api/session/view-mode' && failSwitch)
      return Promise.resolve(new Response(null, {status: 500}));
    if (url === '/api/events')
      return Promise.resolve(jsonResponse({events: [october, november]}));
    if (url === '/api/events/october')
      return Promise.resolve(jsonResponse(detailFor(october, [submission])));
    if (url === '/api/events/november')
      return Promise.resolve(jsonResponse(detailFor(november)));
    if (url.endsWith('/video/upload'))
      return Promise.resolve(new Response(JSON.stringify({upload: null})));
    if (url.endsWith('/video'))
      return Promise.resolve(new Response(JSON.stringify({video: null})));
    throw new Error(url);
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return {promise, resolve};
}
