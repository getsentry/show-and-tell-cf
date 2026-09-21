import '@testing-library/jest-dom/vitest';
import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {App} from '../../src/app/App';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

describe('App', () => {
  it('introduces the Show & Tell application', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, {status: 401})));
    render(<App />);
    expect(await screen.findByRole('heading', {name: 'Show & Tell'})).toBeInTheDocument();
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
        if (url === '/api/session') return Promise.resolve(jsonResponse({user: admin}));
        if (url === '/api/events')
          return Promise.resolve(new Response(null, {status: 500}));
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    render(<App />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Request failed (500)');
    expect(screen.queryByText('Loading playlist…')).not.toBeInTheDocument();
  });

  it('reports mutation failures and preserves form input', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (url === '/api/session') return Promise.resolve(jsonResponse({user: admin}));
        if (url === '/api/events' && init?.method === 'POST')
          return Promise.resolve(new Response(null, {status: 500}));
        if (url === '/api/events') return Promise.resolve(jsonResponse({events: []}));
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    render(<App />);
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
        if (url === '/api/session') return Promise.resolve(jsonResponse({user: admin}));
        if (url === '/api/events')
          return Promise.resolve(jsonResponse({events: [october]}));
        if (url === '/api/events/october') return detail.promise;
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    render(<App />);

    expect(await screen.findByRole('button', {name: /October 2026/})).toBeInTheDocument();
    expect(screen.getByText('Loading playlist…')).toBeInTheDocument();
    expect(screen.queryByText('No Show & Tell playlists yet.')).not.toBeInTheDocument();
  });

  it('offers a retry when playlist loading fails', async () => {
    let attempts = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
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
    const title = await screen.findByLabelText('Title');
    fireEvent.change(title, {target: {value: 'October 2026'}});
    fireEvent.submit(
      screen.getByRole('button', {name: 'Create playlist'}).closest('form')!,
    );

    await act(async () => created.resolve(jsonResponse({event: october})));

    await waitFor(() => expect(title).toHaveValue(''));
    expect(await screen.findByRole('button', {name: /October 2026/})).toBeInTheDocument();
  });

  it('resets and refreshes the submission form after creation', async () => {
    const created = deferred<Response>();
    let detailLoads = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
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

    render(<App />);
    const projectUrl = await screen.findByRole('textbox', {name: 'Project link'});
    const title = screen.getAllByRole('textbox', {name: 'Title'})[1];
    fireEvent.change(title, {target: {value: 'Project demo'}});
    fireEvent.change(projectUrl, {target: {value: 'https://example.com'}});
    fireEvent.submit(
      screen.getByRole('button', {name: 'Create submission'}).closest('form')!,
    );

    await act(async () => created.resolve(jsonResponse({submission})));

    await waitFor(() => expect(title).toHaveValue(''));
    expect(
      await screen.findByRole('heading', {name: 'Project demo'}),
    ).toBeInTheDocument();
  });

  it('keeps the current playlist loading when an old mutation refreshes', async () => {
    const mutation = deferred<Response>();
    const novemberDetail = deferred<Response>();
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
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

    render(<App />);
    fireEvent.click(await screen.findByRole('button', {name: 'Hide'}));
    fireEvent.click(screen.getByRole('button', {name: /November 2026/}));

    await act(async () => mutation.resolve(new Response(null, {status: 204})));
    await act(async () => novemberDetail.resolve(jsonResponse(detailFor(november))));

    expect(
      await screen.findByRole('heading', {name: 'November 2026'}),
    ).toBeInTheDocument();
  });

  it('ignores a stale playlist response after switching playlists', async () => {
    const octoberDetail = deferred<Response>();
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url === '/api/session') return Promise.resolve(jsonResponse({user: admin}));
        if (url === '/api/events')
          return Promise.resolve(jsonResponse({events: [october, november]}));
        if (url === '/api/events/october') return octoberDetail.promise;
        if (url === '/api/events/november')
          return Promise.resolve(jsonResponse(detailFor(november)));
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

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
  title: 'Project demo',
  description: null,
  projectUrl: 'https://example.com',
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
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return {promise, resolve};
}
