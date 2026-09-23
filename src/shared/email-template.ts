import {eventSlug, submissionPath} from './playlist';

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
function showSchedule(date: Date) {
  const dateIn = (timeZone: string) =>
    new Intl.DateTimeFormat('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
      timeZone,
    }).format(date);
  const day = dateIn('America/Los_Angeles');
  const rows = [
    ['America/Los_Angeles', 'San Francisco'],
    ['America/New_York', 'New York'],
    ['Europe/Vienna', 'Vienna'],
  ].map(([timeZone, city]) => {
    const time = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
      timeZone,
      hour12: city !== 'Vienna',
    }).format(date);
    const localDay = dateIn(timeZone);
    return {city, time, differentDay: localDay !== day ? localDay : null};
  });
  return {
    text: `${day}\n${rows.map((row) => `${row.city}: ${row.time}${row.differentDay ? ` (${row.differentDay})` : ''}`).join('\n')}`,
    html: `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:24px 0;background:#f4f1fa;border-radius:8px"><tr><td colspan="2" style="padding:20px 20px 12px"><p style="margin:0 0 6px;color:#65527b;font-size:12px">🗓️ SHOW STARTS</p><p style="margin:0;font-weight:bold;font-size:20px">${escape(day)}</p></td></tr>${rows.map((row) => `<tr><td style="padding:8px 12px 12px 20px;color:#65527b">${escape(row.city)}</td><td style="padding:8px 20px 12px 0;font-weight:bold">${escape(row.time)}${row.differentDay ? `<br><span style="font-size:12px;font-weight:normal">${escape(row.differentDay)}</span>` : ''}</td></tr>`).join('')}</table>`,
  };
}

// Fixed diagnostic only: never expose the stored URL in an error response.
export class InvalidMeetingUrlError extends Error {
  constructor() {
    super('The show meeting URL is invalid. Use a valid Google Meet URL.');
  }
}

/** Static email used by scheduled delivery, previews and personal test sends. */
export function renderEmail(show: EmailShow, origin: string): EmailPreview {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.username || url.password)
    throw new Error('Configure an HTTPS APP_ORIGIN.');
  const submissionUrl = new URL(
    submissionPath(show.id, show.slug || eventSlug(show.title)),
    url.origin,
  ).href;
  const start = new Date(show.starts_at);
  const schedule = showSchedule(start);
  const content = {
    subject: `🎬 ${show.title}: submissions are open`,
    preheader: 'Upload your video for the next Show & Tell.',
    headline: show.title,
    intro: 'Hi all! 👋\n\nIt’s that time again. The time to show and the time to tell.',
    participation:
      '👉 Upload your video using the link below. We’ll show the videos that are there when the meeting starts. Please keep demos below 5 mins.',
    button: 'Upload your demo →',
    help: '👋 Psst, new to Sentry? Learn more about Show & Tell',
    questions:
      '💬 Questions?\nJump into Slack #discuss-show-n-tell.\n\n🙋 Need a hand?\nAsk @jr or @sergical. We’ll help!',
  };
  const subject = Array.from(content.subject)
    .map((char) => (isControl(char) ? ' ' : char))
    .join('')
    .slice(0, 250);
  let meetingUrl: string | null = null;
  if (show.meeting_url) {
    if (!URL.canParse(show.meeting_url)) throw new InvalidMeetingUrlError();
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
  const text = `${content.headline}\n\n${content.intro}\n\n🗓️ Show starts\n${schedule.text}\n\n${content.participation}\n\n${content.button}\n${submissionUrl}\nSentry login required.\n\nInfo & help\n\n${help}\n${learnUrl}\n\n${questions}${meetingUrl ? `\n\n📹 Join the show: ${meetingUrl}` : ''}`;
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
<tr><td style="background:#241537;color:#ffffff;padding:32px"><p style="margin:0 0 20px;letter-spacing:3px;font-size:12px;font-weight:bold;color:#c4b4ff">SENTRY / SHOW &amp; TELL</p><h1 style="margin:0;font-size:36px;line-height:1.15">${escape(content.headline)}</h1></td></tr>
<tr><td style="padding:32px">${paragraphs(content.intro)}
${schedule.html}
${paragraphs(content.participation)}
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #c9baec;border-radius:12px"><tr><td style="padding:24px;text-align:center"><p style="margin:0 0 8px;font-size:12px;letter-spacing:2px;color:#65527b">🎬 SUBMISSIONS</p><h2 style="margin:0 0 16px;font-size:24px">${escape(show.title)}</h2>${button}<p style="margin:14px 0 0;font-size:12px;color:#65527b">Sentry login required · Under 5 minutes</p><p style="margin:10px 0 0;font-size:12px;overflow-wrap:anywhere;word-break:break-all"><a href="${escape(submissionUrl)}" style="color:#6341cc">${escape(submissionUrl)}</a></p></td></tr></table>
<div style="margin-top:28px;border-top:1px solid #ddd5eb;padding-top:24px"><h2 style="margin:0 0 18px;font-size:18px">Info &amp; help</h2><p style="margin:0 0 20px;line-height:1.65"><a href="${learnUrl}" style="color:#6341cc">${escape(help)}</a></p>${questions
    .split(/\n\n+/)
    .map((part) => {
      const [label, ...lines] = part.split('\n');
      return `<p style="margin:0 0 20px;line-height:1.65"><strong>${escape(label)}</strong>${lines.length ? `<br>${lines.map(escape).join('<br>')}` : ''}</p>`;
    })
    .join(
      '',
    )}${meetingUrl ? `<p style="margin:0;line-height:1.65"><a href="${escape(meetingUrl)}" style="color:#6341cc">📹 Join the show on Google Meet →</a></p>` : ''}</div>
</td></tr></table></td></tr></table></body></html>`;
  return {subject, text, html};
}
