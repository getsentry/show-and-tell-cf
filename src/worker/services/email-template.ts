import {
  defaultEmailTemplate,
  validateEmailTemplate,
  type EmailTemplateResponse,
} from '../../shared/email-template';

export async function readEmailTemplate(db: D1Database): Promise<EmailTemplateResponse> {
  const row = await db
    .prepare(
      'SELECT revision, template_json FROM show_email_templates ORDER BY revision DESC LIMIT 1',
    )
    .first<{revision: number; template_json: string}>();
  return row
    ? {
        revision: row.revision,
        template: validateEmailTemplate(JSON.parse(row.template_json)),
      }
    : {revision: 0, template: {...defaultEmailTemplate}};
}
