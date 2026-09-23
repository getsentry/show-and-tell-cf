import {expect, it} from 'vitest';
import {
  defaultEmailTemplate,
  renderEmail,
  validateEmailTemplate,
} from '../../src/shared/email-template';

const show = {
  id: 'october',
  title: 'October Show & Tell',
  slug: 'october-show',
  starts_at: '2026-10-08T16:00:00.000Z',
  meeting_url: 'https://meet.google.com/abc-defg-hij',
};
it('renders branded HTML, a real submission card, help links and plain-text fallback', () => {
  const email = renderEmail(defaultEmailTemplate, show, 'https://showandtell.sentry.new');
  expect(email.html).toContain('SENTRY / SHOW &amp; TELL');
  expect(email.html).toContain(
    'href="https://showandtell.sentry.new/events/october/october-show"',
  );
  expect(email.html).toContain('Upload your demo →');
  expect(email.text).toContain(
    'https://showandtell.sentry.new/events/october/october-show',
  );
  expect(email.text).toContain('https://www.notion.so/sentry/Show-Tell-');
  expect(email.text).toContain('#discuss-show-n-tell');
  expect(email.text).toContain('@jr or @sergical');
  expect(email.text).toContain('https://meet.google.com/abc-defg-hij');
  expect(email.text).not.toContain('{{');
  expect(email.html).toContain(
    '<h1 style="margin:0;font-size:36px;line-height:1.15">October Show &amp; Tell</h1>',
  );
  expect(email.html).toContain('SHOW STARTS');
  expect(email.html).toContain('Thursday, October 8, 2026');
  expect(email.html).toContain(
    '>👋 Psst, new to Sentry? Learn more about Show &amp; Tell</a>',
  );
  expect(email.html.match(/>Upload your demo →<\/a>/g)).toHaveLength(1);
  for (const removed of [
    'TL;DR',
    'Small demos',
    'oh, nice',
    'Less slide deck',
    'deadline',
    'night before',
    'field guide',
  ]) {
    expect(email.html).not.toContain(removed);
    expect(email.text).not.toContain(removed);
  }
  expect(email.text).toContain('when the meeting starts');
});
it('uses DST-correct dates in all three cities without an upload deadline', () => {
  const summer = renderEmail(defaultEmailTemplate, show, 'https://example.test');
  expect(summer.text).toContain('9:00 AM PDT');
  expect(summer.text).toContain('12:00 PM EDT');
  expect(summer.text).toMatch(/18:00 (GMT\+2|CEST)/);
  expect(summer.text).not.toContain('6:00 AM PDT');
  const winter = renderEmail(
    {...defaultEmailTemplate, demoMinutes: 7},
    {...show, starts_at: '2026-12-10T17:00:00.000Z'},
    'https://example.test',
  );
  expect(winter.text).toContain('9:00 AM PST');
  expect(winter.text).toContain('12:00 PM EST');
  expect(winter.text).toMatch(/18:00 (GMT\+1|CET)/);

  expect(winter.text).toContain('below 7 mins');
  // Europe and the US change clocks on different weekends.
  const mismatch = renderEmail(
    defaultEmailTemplate,
    {...show, starts_at: '2026-10-29T16:00:00.000Z'},
    'https://example.test',
  );
  expect(mismatch.text).toContain('9:00 AM PDT');
  expect(mismatch.text).toMatch(/17:00 (GMT\+1|CET)/);
});
it('escapes editable HTML, treats title placeholders as data and strips header injection', () => {
  const email = renderEmail(
    {...defaultEmailTemplate, headline: '<img src=x onerror=alert(1)>'},
    {...show, title: '<script>alert(1)</script>\r\nBcc: test {{demo_minutes}}'},
    'https://example.test',
  );
  expect(email.html).not.toContain('<script>');
  expect(email.html).not.toContain('<img');
  expect(email.html).toContain('&lt;script&gt;');
  expect(email.html).toContain('&lt;img');
  expect(email.subject).not.toMatch(/[\r\n]/);
  expect(email.subject).toContain('{{demo_minutes}}');
  const unsafeMeeting = renderEmail(
    defaultEmailTemplate,
    {...show, meeting_url: 'javascript:alert(1)'},
    'https://example.test',
  );
  expect(unsafeMeeting.html).not.toContain('javascript:');
  expect(() => renderEmail(defaultEmailTemplate, show, 'http://example.test')).toThrow();
});
it('validates fields, placeholders, newlines, and numeric boundaries', () => {
  expect(validateEmailTemplate(defaultEmailTemplate)).toEqual(defaultEmailTemplate);
  for (const invalid of [
    null,
    [],
    {...defaultEmailTemplate, subject: 'a\r\nBcc: x'},
    {...defaultEmailTemplate, intro: '{{missing}}'},
    {...defaultEmailTemplate, headline: ''},
    {...defaultEmailTemplate, button: 'x'.repeat(81)},
    {...defaultEmailTemplate, demoMinutes: 0},
    {...defaultEmailTemplate, intro: '{{deadline_times}}'},
  ]) {
    expect(() => validateEmailTemplate(invalid)).toThrow();
  }
});

it('shows the local date when a city crosses midnight', () => {
  const email = renderEmail(
    defaultEmailTemplate,
    {...show, starts_at: '2026-10-09T01:00:00.000Z'},
    'https://example.test',
  );
  expect(email.text).toContain('Thursday, October 8, 2026');
  expect(email.text).toMatch(/Vienna: 03:00 (GMT\+2|CEST) — Friday, October 9, 2026/);
  expect(email.html).toContain('Friday, October 9, 2026');
});
