import '@testing-library/jest-dom/vitest';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {afterEach, expect, it, vi} from 'vitest';
import {EmailTemplateEditor} from '../../src/app/EmailTemplateEditor';
import {defaultEmailTemplate} from '../../src/shared/email-template';
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('edits and previews a draft separately from saving, then refreshes reminders', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({revision: 0, template: defaultEmailTemplate}))
    .mockResolvedValueOnce(
      Response.json({
        subject: 'Example',
        text: 'Text fallback',
        html: '<html><head></head><body>Preview</body></html>',
      }),
    )
    .mockResolvedValueOnce(
      Response.json({
        revision: 1,
        template: {...defaultEmailTemplate, headline: 'Show your work'},
      }),
    );
  vi.stubGlobal('fetch', fetcher);
  const saved = vi.fn();
  render(
    <EmailTemplateEditor shows={[{id: 'show', title: 'October Show'}]} onSaved={saved} />,
  );
  await screen.findByLabelText('Headline');
  expect(screen.queryByLabelText(/Upload deadline/)).not.toBeInTheDocument();
  expect(screen.queryByLabelText(/Closing/)).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Headline'), {
    target: {value: 'Show your work'},
  });
  fireEvent.click(screen.getByRole('button', {name: 'Preview draft email'}));
  const frame = await screen.findByTitle('Rendered email preview');
  expect(frame).toHaveAttribute('sandbox', '');
  expect(frame.getAttribute('srcdoc')).toContain("default-src 'none'");
  expect(saved).not.toHaveBeenCalled();
  expect(fetcher.mock.calls[1][0]).toBe('/api/admin/email-template/preview');
  expect(JSON.parse(fetcher.mock.calls[1][1].body).template.headline).toBe(
    'Show your work',
  );
  fireEvent.click(screen.getByRole('button', {name: 'Save email template'}));
  await screen.findByText(/Saved for future email attempts/);
  expect(saved).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[2][1].method).toBe('PUT');
});
it('shows save conflicts, preserves the draft, and allows reloading', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({revision: 0, template: defaultEmailTemplate}))
    .mockResolvedValueOnce(
      Response.json(
        {error: {message: 'Another admin changed the template. Reload before saving.'}},
        {status: 409},
      ),
    )
    .mockResolvedValueOnce(
      Response.json({
        revision: 1,
        template: {...defaultEmailTemplate, headline: 'Updated elsewhere'},
      }),
    );
  vi.stubGlobal('fetch', fetcher);
  render(<EmailTemplateEditor shows={[]} onSaved={vi.fn()} />);
  fireEvent.change(await screen.findByLabelText('Headline'), {
    target: {value: 'My draft'},
  });
  expect(screen.getByRole('button', {name: 'Preview draft email'})).toBeDisabled();
  fireEvent.click(screen.getByRole('button', {name: 'Save email template'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('Another admin changed');
  expect(screen.getByLabelText('Headline')).toHaveValue('My draft');
  fireEvent.click(screen.getByRole('button', {name: 'Reload saved template'}));
  await waitFor(() =>
    expect(screen.getByLabelText('Headline')).toHaveValue('Updated elsewhere'),
  );
});
