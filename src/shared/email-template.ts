import {eventSlug, submissionPath} from './playlist';
import {isJsonObject, isJsonString, isJsonNumber, type JsonInput} from './json';

export const templateFields = {
  subject: {label: 'Subject', max: 200},
  preheader: {label: 'Inbox preview', max: 300},
  headline: {label: 'Headline', max: 200},
  intro: {label: 'Introduction', max: 2000},
  participation: {label: 'Submission instructions', max: 2000},
  closing: {label: 'Closing / TL;DR', max: 1000},
  button: {label: 'Submission button', max: 80},
  help: {label: 'Newcomer welcome', max: 1000},
  questions: {label: 'Help and contacts', max: 1000},
} as const;
export type TemplateField = keyof typeof templateFields;
export const templateFieldKeys = [
  'subject',
  'preheader',
  'headline',
  'intro',
  'participation',
  'closing',
  'button',
  'help',
  'questions',
] as const satisfies readonly TemplateField[];
export type EmailTemplate = Record<TemplateField, string> & {
  deadlineHoursBefore: number;
  demoMinutes: number;
};
export interface EmailTemplateResponse {
  template: EmailTemplate;
  revision: number;
}
export interface EmailPreview {
  subject: string;
  text: string;
  html: string;
}
export interface EmailShow {
  id: string;
  title: string;
  slug: string;
  starts_at: string;
  meeting_url: string | null;
}
export const defaultEmailTemplate: EmailTemplate = {
  subject: 'Time to show. Time to tell. — {{title}}',
  preheader: 'Got five minutes of something good? Your next demo belongs here.',
  headline: 'Less slide deck. More show & tell.',
  intro:
    'Hi all!\n\nIt’s that time again. The time to show and the time to tell. {{title}} is coming up:\n{{show_times}}',
  participation:
    '👉 If you’re participating, submit your video by {{deadline_times}}.\n\nYep, it’s early on the west coast. Consider uploading the night before. Please keep demos below {{demo_minutes}} mins.',
  closing:
    'TL;DR — {{title}}: {{show_times}}. Bring something worth sharing. Upload your video below!',
  button: 'Upload your demo →',
  help: '👋 Psst, new to Sentry? Learn more about Show & Tell',
  questions:
    'Questions? Jump into Slack #discuss-show-n-tell. More questions? Ask @jr or @sergical — we’ll help!',
  deadlineHoursBefore: 3,
  demoMinutes: 5,
};
export const templateTokens = [
  'title',
  'show_times',
  'deadline_times',
  'demo_minutes',
] as const;

export function validateEmailTemplate(input: JsonInput): EmailTemplate {
  if (!isJsonObject(input)) throw new Error('Provide an email template.');
  const result = {...defaultEmailTemplate};
  for (const field of templateFieldKeys) {
    const text = input[field];
    if (!isJsonString(text) || !text.trim() || text.length > templateFields[field].max)
      throw new Error(
        `${templateFields[field].label} is required (maximum ${templateFields[field].max} characters).`,
      );
    if (
      Array.from(text).some(
        (char) => isControl(char) && !['\t', '\r', '\n'].includes(char),
      ) ||
      (field === 'subject' && /[\r\n]/.test(text))
    )
      throw new Error('Template contains unsupported control characters.');
    const remainder = text.replace(
      /\{\{(title|show_times|deadline_times|demo_minutes)\}\}/g,
      '',
    );
    if (remainder.includes('{{') || remainder.includes('}}'))
      throw new Error(
        'Unknown placeholder. Use title, show_times, deadline_times or demo_minutes.',
      );
    result[field] = text.trim();
  }
  for (const [field, min, max] of [
    ['deadlineHoursBefore', 0, 168],
    ['demoMinutes', 1, 60],
  ] as const) {
    const number = input[field];
    if (
      !isJsonNumber(number) ||
      !Number.isInteger(number) ||
      number < min ||
      number > max
    )
      throw new Error(`${field} must be a whole number from ${min} to ${max}.`);
    result[field] = number;
  }
  return result;
}

const learnUrl =
  'https://www.notion.so/sentry/Show-Tell-c607fc1d95064cbfbd3acc7f98689d38';
function isControl(char: string) {
  return char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127;
}
function escape(value: string) {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[char]!,
  );
}
function times(date: Date) {
  const day = (timeZone: string) =>
    new Intl.DateTimeFormat('en-CA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      timeZone,
    }).format(date);
  const pacificDay = day('America/Los_Angeles');
  return [
    ['America/Los_Angeles', 'San Francisco'],
    ['America/New_York', 'New York'],
    ['Europe/Vienna', 'Vienna'],
  ]
    .map(([timeZone, city], index) => {
      const options: Intl.DateTimeFormatOptions = {
        hour: 'numeric',
        minute: '2-digit',
        timeZoneName: 'short',
        timeZone,
      };
      if (index === 0 || day(timeZone) !== pacificDay) {
        options.weekday = 'short';
        options.month = 'short';
        options.day = 'numeric';
        options.year = 'numeric';
      }
      return `${new Intl.DateTimeFormat('en-US', options).format(date)} (${city})`;
    })
    .join(' / ');
}

/** One renderer for delivery and admin previews. Editable copy is plain text, never HTML. */
export function renderEmail(
  template: EmailTemplate,
  show: EmailShow,
  origin: string,
): EmailPreview {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.username || url.password)
    throw new Error('Configure an HTTPS APP_ORIGIN.');
  const submissionUrl = new URL(
    submissionPath(show.id, show.slug || eventSlug(show.title)),
    url.origin,
  ).href;
  const start = new Date(show.starts_at);
  const tokens = {
    title: show.title,
    show_times: times(start),
    deadline_times: times(
      new Date(start.getTime() - template.deadlineHoursBefore * 3600000),
    ),
    demo_minutes: String(template.demoMinutes),
  };
  // Single pass: event titles cannot introduce additional template expressions.
  const replace = (text: string) =>
    text.replace(
      /\{\{(title|show_times|deadline_times|demo_minutes)\}\}/g,
      (_, token: keyof typeof tokens) => tokens[token],
    );
  const content = {...template};
  for (const key of templateFieldKeys) content[key] = replace(template[key]);
  const subject = Array.from(content.subject)
    .map((char) => (isControl(char) ? ' ' : char))
    .join('')
    .slice(0, 250);
  let meetingUrl: string | null = null;
  if (show.meeting_url) {
    const meeting = new URL(show.meeting_url);
    if (
      meeting.protocol === 'https:' &&
      meeting.hostname === 'meet.google.com' &&
      !meeting.username &&
      !meeting.password
    )
      meetingUrl = meeting.href;
  }
  const {help, questions} = content;
  const text = `${content.headline}\n\n${content.intro}\n\n${content.participation}\n\n${content.button}\n${submissionUrl}\nSentry login required.\n\n${help}\n${learnUrl}\n\n${questions}${meetingUrl ? `\n\nJoin the show: ${meetingUrl}` : ''}\n\n${content.closing}\n${submissionUrl}`;
  const paragraphs = (value: string) =>
    value
      .split(/\n\n+/)
      .map(
        (part) =>
          `<p style="margin:0 0 18px;line-height:1.65">${escape(part).replace(/\n/g, '<br>')}</p>`,
      )
      .join('');
  const button = `<a href="${escape(submissionUrl)}" style="display:inline-block;background:#7553ff;color:#ffffff;text-decoration:none;font-weight:bold;border-radius:8px;padding:16px 24px">${escape(content.button)}</a>`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(subject)}</title></head><body style="margin:0;background:#f4f1fa;color:#241537;font-family:Arial,Helvetica,sans-serif">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all">${escape(content.preheader)}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellspacing="0" cellpadding="0" style="width:100%;max-width:600px;background:#ffffff;border:1px solid #ddd5eb;border-radius:16px;overflow:hidden">
<tr><td style="background:#241537;color:#ffffff;padding:32px"><p style="margin:0 0 20px;letter-spacing:3px;font-size:12px;font-weight:bold;color:#c4b4ff">SENTRY / SHOW &amp; TELL</p><h1 style="margin:0;font-size:36px;line-height:1.15">${escape(content.headline)}</h1><p style="margin:20px 0 0;color:#e4dcf4">Small demos. Big “oh, nice.” energy.</p></td></tr>
<tr><td style="padding:32px">${paragraphs(content.intro)}
<div style="background:#f4f1fa;border-left:4px solid #7553ff;padding:20px;margin:24px 0">${paragraphs(content.participation)}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #c9baec;border-radius:12px"><tr><td style="padding:24px;text-align:center"><p style="margin:0 0 8px;font-size:12px;letter-spacing:2px;color:#65527b">YOUR NEXT DEMO GOES HERE</p><h2 style="margin:0 0 16px;font-size:24px">${escape(show.title)}</h2>${button}<p style="margin:14px 0 0;font-size:12px;color:#65527b">Sentry login required · Under ${template.demoMinutes} minutes</p><p style="margin:10px 0 0;font-size:12px;overflow-wrap:anywhere;word-break:break-all"><a href="${escape(submissionUrl)}" style="color:#6341cc">${escape(submissionUrl)}</a></p></td></tr></table>
<div style="margin-top:28px">${paragraphs(help)}<p><a href="${learnUrl}" style="color:#6341cc">The Show &amp; Tell field guide →</a></p>${paragraphs(questions)}${meetingUrl ? `<p><a href="${escape(meetingUrl)}" style="color:#6341cc">Join the show on Google Meet →</a></p>` : ''}</div>
<div style="border-top:2px dashed #ddd5eb;margin-top:28px;padding-top:24px">${paragraphs(content.closing)}${button}</div>
</td></tr></table><p style="font-size:12px;color:#65527b">Made for the things you can’t wait to show someone.</p></td></tr></table></body></html>`;
  return {subject, text, html};
}
