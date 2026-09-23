import {Hono} from 'hono';
import type {WorkerEnv} from '../index';
import {requireRole} from '../middleware/user';
import {readEmailTemplate} from '../services/email-template';
import {
  renderEmail,
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
emailTemplateRoutes.post('/preview', async (c) => {
  const input: unknown = await c.req.json().catch(() => null);
  if (!isJsonObject(input) || !isJsonString(input.eventId))
    return c.json({error: {message: 'Select a planned show to preview.'}}, 400);
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
  try {
    return c.json(renderEmail(template, show, reminderOrigin(c.env.APP_ORIGIN)));
  } catch {
    return c.json(
      {error: {message: 'Check the show date and HTTPS APP_ORIGIN before previewing.'}},
      400,
    );
  }
});
