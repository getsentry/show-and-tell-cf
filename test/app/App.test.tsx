import '@testing-library/jest-dom/vitest';
import {cleanup, render, screen} from '@testing-library/react';
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
});
