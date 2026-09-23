import '@testing-library/jest-dom/vitest';
import {cleanup, fireEvent, render, screen, within} from '@testing-library/react';
import {afterEach, expect, it, vi} from 'vitest';
import {App} from '../../src/app/App';
import {ReminderList} from '../../src/app/ReminderList';
import type {ShowRemindersResponse} from '../../src/shared/reminders';

const payload: ShowRemindersResponse = {
  enabled: false,
  nextOffset: null,
  reminders: [
    {
      eventId: 'show',
      eventTitle: 'October Show',
      channel: 'email',
      status: 'pending',
      scheduledAt: '2099-10-01T16:00:00.000Z',
      timezone: 'America/Los_Angeles',
      destination: 'team@sentry.io',
      blockedReasons: ['Automatic reminders are disabled.'],
      subject: 'Submit your demo: October Show',
      message: 'Add your demo: https://example.test/events/show/october',
      submissionUrl: 'https://example.test/events/show/october',
      attemptedAt: null,
      completedAt: null,
    },
  ],
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});
it('shows when, where, status, disabled state and message preview', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(payload)),
  );
  render(<ReminderList />);
  const card = await screen.findByRole('article', {name: 'October Show email reminder'});
  expect(within(card).getByText('Email · team@sentry.io')).toBeInTheDocument();
  expect(within(card).getByText('Pending')).toBeInTheDocument();
  expect(within(card).getByText(/2099-10-01T16:00:00.000Z/)).toBeInTheDocument();
  expect(screen.getByText(/Automatic reminders disabled/)).toBeInTheDocument();
  fireEvent.click(within(card).getByText('Message preview'));
  expect(
    within(card).getByText('Add your demo: https://example.test/events/show/october'),
  ).toBeVisible();
  expect(within(card).getByText('Submit your demo: October Show')).toBeVisible();
});
it('handles errors with refresh and paginates', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response('{}', {status: 500}))
    .mockResolvedValueOnce(Response.json({...payload, nextOffset: 50}))
    .mockResolvedValueOnce(Response.json({...payload, reminders: []}));
  vi.stubGlobal('fetch', fetcher);
  render(<ReminderList />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Request failed');
  fireEvent.click(screen.getByRole('button', {name: 'Refresh reminders'}));
  await screen.findByRole('article');
  fireEvent.click(screen.getByRole('button', {name: 'Next reminders'}));
  expect(await screen.findByText('No reminders on this page.')).toBeInTheDocument();
  expect(fetcher.mock.calls[2][0]).toBe('/api/admin/reminders?offset=50');
});
it('shows hidden badges to admins and removes all reminder data on member-view switch', async () => {
  let member = false;
  const user = () => ({
    id: 'admin',
    displayName: 'Admin',
    email: 'admin@sentry.io',
    avatarUrl: null,
    role: member ? 'member' : 'admin',
    actualRole: 'admin',
  });
  const fetcher = vi.fn(async (url: string) => {
    if (url === '/api/session') return Response.json({user: user()});
    if (url === '/api/session/view-mode') {
      member = true;
      return Response.json({user: user()});
    }
    if (url === '/api/events')
      return Response.json({
        events: member
          ? []
          : [{id: 'show', title: 'October Show', hidden: true, submissionCount: 0}],
      });
    if (url === '/api/admin/reminders?offset=0') return Response.json(payload);
    throw Error(url);
  });
  vi.stubGlobal('fetch', fetcher);
  render(<App />);
  const card = await screen.findByRole('article', {name: 'October Show'});
  expect(within(card).getByText('Hidden')).toBeInTheDocument();
  expect(fetcher.mock.calls.map((c) => c[0])).not.toContain(
    '/api/admin/reminders?offset=0',
  );
  fireEvent.click(screen.getByRole('button', {name: 'View reminders'}));
  await screen.findByRole('article', {name: 'October Show email reminder'});
  fireEvent.click(screen.getByRole('button', {name: 'Switch to user view'}));
  await screen.findByRole('button', {name: 'Back to admin'});
  expect(screen.queryByRole('button', {name: 'View reminders'})).not.toBeInTheDocument();
  expect(
    screen.queryByRole('region', {name: 'Scheduled reminders'}),
  ).not.toBeInTheDocument();
  expect(screen.queryByText('Hidden')).not.toBeInTheDocument();
  expect(screen.queryByText('Email · team@sentry.io')).not.toBeInTheDocument();
});
