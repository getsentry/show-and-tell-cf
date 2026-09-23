import {
  defaultEmailTemplate,
  validateEmailTemplate,
  type EmailTemplateResponse,
  templateFieldKeys,
} from '../../shared/email-template';

import {
  isJsonObject,
  isJsonString,
  type JsonInput,
  type JsonObject,
} from '../../shared/json';

// Read earlier draft revisions without bringing back the retired deadline copy.
// Stored revisions remain immutable; the next explicit save persists the new shape.
function upgradeSavedTemplate(input: JsonInput) {
  if (!isJsonObject(input) || input.deadlineHoursBefore === undefined) return input;
  const upgraded: JsonObject = Object.fromEntries(Object.entries(input));
  for (const key of templateFieldKeys) {
    const text = upgraded[key];
    if (isJsonString(text) && text.includes('{{deadline_times}}'))
      upgraded[key] = defaultEmailTemplate[key];
  }
  if (upgraded.headline === 'Less slide deck. More show & tell.')
    upgraded.headline = defaultEmailTemplate.headline;
  if (
    upgraded.preheader ===
    'Got five minutes of something good? Your next demo belongs here.'
  )
    upgraded.preheader = defaultEmailTemplate.preheader;
  if (upgraded.subject === 'Time to show. Time to tell. — {{title}}')
    upgraded.subject = defaultEmailTemplate.subject;
  if (
    upgraded.intro ===
    'Hi all!\n\nIt’s that time again. The time to show and the time to tell. {{title}} is coming up:\n{{show_times}}'
  )
    upgraded.intro = defaultEmailTemplate.intro;
  return upgraded;
}

export async function readEmailTemplate(db: D1Database): Promise<EmailTemplateResponse> {
  const row = await db
    .prepare(
      'SELECT revision, template_json FROM show_email_templates ORDER BY revision DESC LIMIT 1',
    )
    .first<{revision: number; template_json: string}>();
  return row
    ? {
        revision: row.revision,
        template: validateEmailTemplate(
          upgradeSavedTemplate(JSON.parse(row.template_json)),
        ),
      }
    : {revision: 0, template: {...defaultEmailTemplate}};
}
