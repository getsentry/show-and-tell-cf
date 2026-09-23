import {Hono, type Context} from 'hono';
import {bodyLimit} from 'hono/body-limit';
import {sendTestEmail} from '../services/test-email';
import type {WorkerEnv} from '../index';
import {requireRole} from '../middleware/user';
import {readEmailTemplate} from '../services/email-template';
import {
  renderEmail,
  InvalidMeetingUrlError,
  validateEmailTemplate,
  type EmailShow,
} from '../../shared/email-template';
import {reminderOrigin} from '../services/show-reminders';
import {isJsonObject, isJsonNumber, isJsonString} from '../../shared/json';

export const emailTemplateRoutes = new Hono<WorkerEnv>();
emailTemplateRoutes.use('*', requireRole('admin'), async (c, next) => {
  c.header('Cache-Control', 'private, no-store');
  await next();
});
emailTemplateRoutes.get('/', async (c) => c.json(await readEmailTemplate(c.env.DB)));
emailTemplateRoutes.put('/', async (c) => {
  const input: unknown = await c.req.json().catch(() => null);
  if (
    !isJsonObject(input) ||
    !Number.isSafeInteger(input.revision) ||
    !isJsonNumber(input.revision) ||
    input.revision < 0
  )
    return c.json({error: {message: 'Provide the current template revision.'}}, 400);
  let template;
  try {
    template = validateEmailTemplate(input.template);
  } catch (error) {
    return c.json(
      {error: {message: error instanceof Error ? error.message : 'Invalid template.'}},
      400,
    );
  }
  // Unique revision plus INSERT SELECT protects against concurrent editor overwrites.
  const result =
    await c.env.DB.prepare(`INSERT OR IGNORE INTO show_email_templates (revision, template_json, updated_by)
    SELECT ?, ?, ? WHERE COALESCE((SELECT MAX(revision) FROM show_email_templates), 0) = ?`)
      .bind(
        input.revision + 1,
        JSON.stringify(template),
        c.get('user').id,
        input.revision,
      )
      .run();
  if (result.meta.changes !== 1)
    return c.json(
      {error: {message: 'Another admin changed the template. Reload before saving.'}},
      409,
    );
  return c.json({template, revision: input.revision + 1});
});
emailTemplateRoutes.on(
  'POST',
  ['/preview', '/test'],
  bodyLimit({maxSize: 32768}),
  async (c: Context<WorkerEnv>) => {
    const test = c.req.path.endsWith('/test');
    const input: unknown = await c.req.json().catch(() => null);
    if (!isJsonObject(input) || !isJsonString(input.eventId))
      return c.json({error: {message: 'Select a planned show to preview.'}}, 400);
    if (
      test &&
      (!isJsonString(input.requestId) || !/^[a-f0-9-]{36}$/.test(input.requestId))
    )
      return c.json({error: {message: 'Provide a valid test request ID.'}}, 400);
    if (
      test &&
      Object.keys(input).some(
        (key) => !['eventId', 'template', 'requestId'].includes(key),
      )
    )
      return c.json(
        {
          error: {
            message:
              'Test mail can only go to your signed-in address; recipient overrides are not supported.',
          },
        },
        400,
      );
    const user = c.get('user');
    if (
      test &&
      (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@sentry\.io$/i.test(user.email) ||
        user.email.toLowerCase() === 'team@sentry.io')
    )
      return c.json(
        {error: {message: 'Use your individual Sentry account for test mail.'}},
        403,
      );
    if (test && (!c.env.SHOW_EMAIL || !c.env.SHOW_EMAIL_FROM))
      return c.json(
        {
          error: {
            message:
              'Email binding or sender is not configured. Test mail also requires the binding to allow your address.',
          },
        },
        503,
      );
    let template;
    try {
      template = validateEmailTemplate(input.template);
    } catch (error) {
      return c.json(
        {error: {message: error instanceof Error ? error.message : 'Invalid template.'}},
        400,
      );
    }
    const show = await c.env.DB.prepare(
      'SELECT id,title,slug,starts_at,meeting_url FROM show_and_tell_events WHERE id=? AND starts_at IS NOT NULL',
    )
      .bind(input.eventId)
      .first<EmailShow>();
    if (!show) return c.json({error: {message: 'Planned show not found.'}}, 404);
    let email;
    try {
      email = renderEmail(template, show, reminderOrigin(c.env.APP_ORIGIN));
    } catch (error) {
      return c.json(
        {
          error: {
            message:
              error instanceof InvalidMeetingUrlError
                ? error.message
                : 'Check the show date and HTTPS APP_ORIGIN before previewing.',
          },
        },
        400,
      );
    }
    if (!test) return c.json(email);
    // Validated above; check again to retain the narrowed type at the send boundary.
    if (!isJsonString(input.requestId))
      return c.json({error: {message: 'Missing request ID.'}}, 400);
    const result = await sendTestEmail(c.env, user, input.requestId, email);
    if (result.status === 'rate_limited') {
      c.header('Retry-After', '60');
      return c.json({error: {message: 'Wait one minute between test emails.'}}, 429);
    }
    return c.json(result);
  },
);
